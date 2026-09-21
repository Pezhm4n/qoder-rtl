#!/usr/bin/env node
"use strict";

/*
 * qoder-rtl — the package's entry point.
 *
 * Every default command here drives the CDP route (live.js): it attaches to a running
 * Qoder over the DevTools protocol, writes nothing to the install, and stops when the
 * app closes. The archive route that rewrites app.asar is still reachable, but only as
 * an explicit `patch --yes`, because on Qoder 0.3.3 it makes the app refuse to start.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { findInstall } = require("./lib/detect");
const { portState, describePort, adviceFor, defaultPort } = require("./lib/cdp");
const { launcherPaths } = require("./lib/launcher");

const LIVE = path.join(__dirname, "live.js");
const ARCHIVE = path.join(__dirname, "index.js");
const pkg = require("./package.json");

const CLI = "qoder-rtl";

const HELP = `${pkg.name} ${pkg.version} — Persian/Arabic RTL and Vazirmatn for the Qoder desktop app

  npx ${pkg.name}              start the patch now (same as "${CLI} start")
  ${CLI} start             open Qoder with its debug port and keep the patch applied
  ${CLI} check             inject, probe every window, print the verdict lines
  ${CLI} diagnose          read-only: what the live window actually computed
  ${CLI} list              page targets CDP can see
  ${CLI} status            what this tool found on this machine
  ${CLI} launcher          write Qoder-RTL.cmd (starts Qoder patched on double-click)
  ${CLI} remove-launcher   delete those .cmd files
  ${CLI} patch --yes       the archive route: rewrites app.asar  ⚠ breaks Qoder 0.3.3
  ${CLI} restore           undo the archive route from the stored backup

Flags after a command are passed through, e.g. "${CLI} check --port 9333".
If 9222 is taken, export QODER_RTL_PORT=9333 once and every command uses it.
Nothing here touches Qoder's installed files: the patch lives in the running app only,
so closing Qoder removes it and re-running the command puts it back.
`;

/* The engines are complete programs with their own argument parsers, so the bin delegates
   to them as a child process rather than re-implementing a second CLI in front of them. */
const COMMANDS = {
  start: { engine: LIVE, args: ["--start"] },
  check: { engine: LIVE, args: ["--check"] },
  diagnose: { engine: LIVE, args: ["--diagnose"] },
  list: { engine: LIVE, args: ["--list"] },
  launcher: { engine: LIVE, args: ["--launcher"] },
  "remove-launcher": { engine: LIVE, args: ["--remove-launcher"] },
  restore: { engine: ARCHIVE, args: ["--restore"] },
  patch: { engine: ARCHIVE, args: [], gated: true }
};

function delegate(command, rest) {
  const child = spawn(process.execPath, [command.engine, ...command.args, ...rest], { stdio: "inherit" });
  child.on("error", (e) => {
    process.stderr.write(`Could not start ${path.basename(command.engine)}: ${e.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code === null ? 1 : code));
}

const PATCH_WARNING = `You asked for the archive route: it rewrites app.asar inside the Qoder install.

On Qoder 0.3.3 that makes the app refuse to start, because the build turns on
EnableEmbeddedAsarIntegrityValidation and Qoder.exe pins the archive's hash. The route is
kept for builds that accept it, and it does back up the original archive first
(${CLI} restore rolls it back).

Use the CDP route instead — it is what this project verifies:  ${CLI} start
Re-run with --yes if you want the archive route anyway.`;

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
}

const LABEL_W = 14;

function row(label, value) {
  const lines = String(value).split("\n");
  process.stdout.write(`${label.padEnd(LABEL_W)}${lines.join("\n" + " ".repeat(LABEL_W))}\n`);
}

/* What this machine looks like to the tool — no injection, no writes. */
async function status(rest) {
  const port = Number(flagValue(rest, "--port") || flagValue(rest, "-p") || defaultPort());
  const payloadVersion = (/var VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(__dirname, "patches", "rtl.js"), "utf8")) || [, "?"])[1];

  row("tool", `${pkg.name} ${pkg.version} (node ${process.version})`);
  row("payload", `runtime ${payloadVersion} — injected into the running app, not installed`);

  let install = null;
  try {
    install = findInstall(flagValue(rest, "--asar"));
    row("Qoder", `${install.version} at ${install.asarPath}`);
  } catch (e) {
    row("Qoder", e.message.split("\n")[0]);
  }

  const ps = await portState(port);
  row("debug port", describePort(ps));
  if (ps.state === "serving") row("", `audit with: ${CLI} check`);
  else row("", adviceFor(ps));

  const written = launcherPaths(__dirname).filter((f) => fs.existsSync(f));
  row("launcher", written.length ? written.join("\n") : `not installed — "${CLI} launcher" adds it`);

  let asarReady = false;
  try {
    require.resolve("@electron/asar");
    asarReady = true;
  } catch (e) {
    asarReady = false;
  }
  row("archive route", asarReady ? "available (optional dependency installed)" : "not installed — npm i @electron/asar (only needed for patch/restore)");
  if (install && install.privileged) row("", "Program Files install: the archive route would need administrator approval; the CDP route does not");
}

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (!name) return delegate(COMMANDS.start, rest);
  if (name === "help" || name === "--help" || name === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (name === "status") return status(rest);
  const command = COMMANDS[name];
  if (!command) {
    process.stderr.write(`Unknown command: ${name}\n\n${HELP}`);
    process.exit(2);
  }
  if (command.gated && !rest.includes("--yes")) {
    process.stderr.write(PATCH_WARNING + "\n");
    process.exit(2);
  }
  return delegate(command, rest);
}

main().catch((e) => {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
});
