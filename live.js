#!/usr/bin/env node
"use strict";

/* qoder-persian-rtl :: CDP side-loader
 *
 * Why this exists: Qoder ships with Electron's asar-integrity fuse enabled and a
 * SHA256 pin for the app.asar header embedded in Qoder.exe, so any byte change
 * inside the archive stops the app from launching. Injecting over the DevTools
 * protocol touches no install file: the patch lives only in the running process,
 * evaporates on quit, and survives auto-updates without re-patching.
 *
 *   node live.js            attach to Qoder on --port, patch every window, stay resident
 *   node live.js --check    attach, patch, probe, append a verdict to cdp-test.log, exit
 *   node live.js --start    launch Qoder with --remote-debugging-port, then attach
 *   node live.js --launcher write a Qoder-RTL.cmd you can pin to the taskbar
 *   node live.js --list     print the page targets CDP can see
 *
 * The archive route (index.js) remains for installs without that fuse. */

const fs = require("node:fs");
const path = require("node:path");
const { spawn, execSync } = require("node:child_process");
const { Connection, browserEndpoint, portIsOpen, httpJson } = require("./lib/cdp");
const { runtimeSource, probeSource } = require("./lib/payload");
const { findInstall } = require("./lib/detect");
const { stateRoot } = require("./lib/backup");

const DEFAULT_PORT = 9222;
const DEFAULT_WAIT = 30;
const HELP = `node live.js [--port 9222] [--wait 30] [--check] [--start] [--launcher] [--list] [-v]

  --check     inject, probe every window, append the result to
              %LOCALAPPDATA%\\qoder-persian-rtl\\cdp-test.log, then exit
  --start     start Qoder with --remote-debugging-port (quit it first: single instance)
  --launcher  write Qoder-RTL.cmd next to live.js and in %LOCALAPPDATA%\\qoder-persian-rtl
              (that .cmd starts Qoder with the port and runs this injector after it)
  --wait <s>  seconds to wait for the DevTools port to appear (default ${DEFAULT_WAIT})
  --list      show the page targets CDP can see`;

function parseArgs(argv) {
  const flags = { port: DEFAULT_PORT, wait: DEFAULT_WAIT, check: false, start: false, launcher: false, list: false, verbose: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") flags.port = Number(argv[++i]) || flags.port;
    else if (a === "--wait") flags.wait = Number(argv[++i]);
    else if (a === "--check") flags.check = true;
    else if (a === "--start") flags.start = true;
    else if (a === "--launcher") flags.launcher = true;
    else if (a === "--list") flags.list = true;
    else if (a === "--verbose" || a === "-v") flags.verbose = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else {
      console.error(`Unknown option: ${a}\n\n${HELP}`);
      process.exit(2);
    }
  }
  return flags;
}

function say(flags, ...args) {
  if (flags.verbose) console.log(...args);
}

/* ---------- install discovery / launcher ---------- */

function exePath() {
  const install = findInstall();
  const dir = path.dirname(install.resourcesDir);
  const candidates =
    process.platform === "win32"
      ? [path.join(dir, "Qoder.exe")]
      : [path.join(dir, "Qoder"), path.join(dir, "MacOS", "Qoder"), path.join(dir, "bin", "qoder")];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`Qoder executable not found near ${install.resourcesDir}\nchecked:\n  ${candidates.join("\n  ")}`);
  return found;
}

function runningQoderPids() {
  if (process.platform !== "win32") {
    try {
      return execSync("pgrep -x Qoder", { encoding: "utf8" }).split("\n").filter(Boolean);
    } catch (e) {
      return [];
    }
  }
  try {
    return execSync('tasklist /FI "IMAGENAME eq Qoder.exe" /NH /FO CSV', { encoding: "utf8" })
      .split("\n")
      .map((l) => (l.split('","')[1] || "").replace(/"/g, ""))
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

/* AppData is hidden in Explorer, so the launcher also lands next to live.js. */
function writeLauncher(port, wait) {
  const exe = exePath();
  const node = process.execPath;
  const script = path.join(__dirname, "live.js");
  /* cmd.exe reads its file in the OEM codepage, so only ASCII paths are safe here. */
  for (const p of [exe, node, script]) {
    // eslint-disable-next-line no-control-regex
    if (/[^\x20-\x7e]/.test(p)) throw new Error(`Cannot write a .cmd for a non-ASCII path:\n  ${p}\nRun "node live.js" manually instead.`);
  }
  const body =
    "@echo off\r\n" +
    "rem Starts Qoder with the DevTools port open, then runs the RTL injector next to it.\r\n" +
    "rem Nothing is written to the Qoder install; closing Qoder removes the patch completely.\r\n" +
    "rem Quit every Qoder window first: the app has a single-instance lock and hands off to the\r\n" +
    "rem running copy, which has no debug port.\r\n" +
    `start "" "${exe}" --remote-debugging-port=${port}\r\n` +
    `start "Qoder RTL injector" "${node}" "${script}" --port ${port} --wait ${wait}\r\n`;
  const appData = stateRoot();
  fs.mkdirSync(appData, { recursive: true });
  return [path.join(appData, "Qoder-RTL.cmd"), path.join(__dirname, "Qoder-RTL.cmd")].map((file) => {
    fs.writeFileSync(file, body, "ascii");
    return file;
  });
}

async function waitForPort(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await portIsOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/* ---------- the injector ---------- */

class Injector {
  constructor(conn, flags) {
    this.conn = conn;
    this.flags = flags;
    this.source = runtimeSource();
    this.sessions = new Map(); /* sessionId -> { targetId, url, patchedAt } */
  }

  async start() {
    await this.conn.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    this.conn.on("Target.attachedToTarget", (msg) => {
      this.onAttach(msg.params.sessionId, msg.params.targetInfo).catch((e) => say(this.flags, "  attach failed:", e.message));
    });
    this.conn.on("Target.targetDestroyed", (msg) => {
      for (const [sessionId, meta] of this.sessions) {
        if (meta.targetId === msg.params.targetId) this.sessions.delete(sessionId);
      }
    });
    const { targetInfos } = await this.conn.send("Target.getTargets");
    for (const info of targetInfos.filter((t) => t.type === "page" && t.subtype !== "devtools")) {
      try {
        const { sessionId } = await this.conn.send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
        await this.onAttach(sessionId, info);
      } catch (e) {
        say(this.flags, `  could not attach to ${info.targetId}: ${e.message}`);
      }
    }
  }

  async onAttach(sessionId, info) {
    if (!info || info.type !== "page" || this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, { targetId: info.targetId, url: info.url, patchedAt: null });
    say(this.flags, `  page: ${info.title || "(untitled)"} — ${String(info.url).slice(0, 90)}`);
    try {
      await this.conn.send("Page.enable", {}, sessionId);
    } catch (e) {
      this.sessions.delete(sessionId);
      say(this.flags, `  skipped (no Page domain): ${e.message}`);
      return;
    }
    /* Runs on every later document before the page's own scripts, and CSP does not apply to it. */
    await this.conn.send("Page.addScriptToEvaluateOnNewDocument", { source: this.source }, sessionId);
    this.sessions.get(sessionId).patchedAt = await this.patchNow(sessionId);
  }

  async patchNow(sessionId) {
    const res = await this.conn.send("Runtime.evaluate", { expression: this.source }, sessionId);
    const ex = res && res.exceptionDetails;
    if (ex) console.log(`  ! injected script threw: ${ex.exception?.description?.split("\n")[0] || ex.text}`);
    return ex ? null : new Date().toISOString();
  }

  async probe(sessionId) {
    const res = await this.conn.send("Runtime.evaluate", { expression: probeSource(), returnByValue: true }, sessionId);
    if (res.exceptionDetails || typeof res.result?.value !== "string") {
      return { error: res.exceptionDetails?.text || (res.result && res.result.subtype) || "no probe result" };
    }
    try {
      return JSON.parse(res.result.value);
    } catch (e) {
      return { error: "unparsable probe result" };
    }
  }

  async report() {
    const out = [];
    for (const [sessionId, meta] of this.sessions) {
      const p = await this.probe(sessionId).catch((e) => ({ error: e.message }));
      out.push({ targetId: meta.targetId, url: meta.url, patchedAt: meta.patchedAt, ...p });
    }
    return out;
  }
}

/* ---------- verdict ---------- */

function verdictRows(reports) {
  const ok = (fn) => reports.some(fn);
  return [
    { name: "page targets visible over CDP", pass: reports.length > 0, detail: `${reports.length} target(s)` },
    {
      name: "payload injected (window.__QODER_RTL__)",
      pass: ok((r) => !!r.rtlVersion),
      detail: reports.map((r) => r.rtlVersion || r.error || "—").join(", ")
    },
    { name: "stylesheet installed inline", pass: ok((r) => r.styleTag === true), detail: reports.map((r) => (r.styleTag ? "✓" : "✗")).join(" ") },
    { name: "Vazirmatn data-URI font loads", pass: ok((r) => r.font === true), detail: reports.map((r) => String(r.font)).join(" ") },
    {
      name: "chat DOM hooks reachable",
      pass: ok((r) => r.hooks && Object.values(r.hooks).some((n) => n > 0)),
      detail: reports.map((r) => JSON.stringify(r.hooks || {})).join(" | ")
    },
    {
      name: "patch active on the document root",
      pass: ok((r) => r.applied && /qrt-smart|qrt-force/.test(r.applied.htmlClasses || "") && r.applied.vars > 0),
      detail: reports.map((r) => `${(r.applied && r.applied.htmlClasses) || "—"} vars=${r.applied ? r.applied.vars : "?"} fa=${r.applied ? r.applied.faBlocks : "?"}`).join(" | ")
    }
  ];
}

function hintsFor(rows) {
  const hints = [];
  const failed = rows.filter((r) => !r.pass).map((r) => r.name);
  if (failed.includes("chat DOM hooks reachable") && !failed.includes("payload injected (window.__QODER_RTL__)")) {
    hints.push("hooks=0 with the payload injected normally means that window has no conversation rendered — open a chat and re-run.");
  }
  if (failed.includes("patch active on the document root")) {
    hints.push("if the root classes are missing, the config may be switched off: press Alt+R inside Qoder, or clear the qoder_persian_rtl_config_v1 key.");
  }
  return hints;
}

function formatReport(reports, rows, port) {
  const lines = [`# port ${port} — ${new Date().toISOString()}`];
  if (!reports.length) lines.push("(no page targets attached)");
  for (const r of reports) {
    lines.push(
      `- ${r.targetId}\n    url     ${r.url}\n    patched ${r.patchedAt || "n/a"}\n    version ${r.rtlVersion || r.error || "absent"}`,
      `    css     style=${r.styleTag} font=${r.font}`,
      `    hooks   ${JSON.stringify(r.hooks || {})}`,
      `    applied ${JSON.stringify(r.applied || {})}`
    );
  }
  for (const row of rows) lines.push(`${row.pass ? "PASS" : "FAIL"}  ${row.name} (${row.detail})`);
  for (const hint of hintsFor(rows)) lines.push(`note  ${hint}`);
  return lines.join("\n");
}

function writeVerdict(text) {
  const dir = stateRoot();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "cdp-test.log");
  fs.appendFileSync(file, text + "\n\n", "utf8");
  return file;
}

/* ---------- main ---------- */

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    return;
  }
  if (flags.launcher) {
    for (const file of writeLauncher(flags.port, flags.wait)) console.log("Wrote launcher: " + file);
    console.log("Quit Qoder completely, then double-click that .cmd — it opens Qoder with the debug port and injects the patch.");
    console.log("To audit a running session instead: node live.js --check");
    return;
  }

  let open = await portIsOpen(flags.port);
  let launched = false;

  if (!open && flags.start) {
    const pids = runningQoderPids();
    if (pids.length) {
      console.log(`Qoder is already running (${pids.length} processes) and enforces one instance per machine,`);
      console.log("so a fresh launch hands off to it and the --remote-debugging-port flag is dropped.");
      console.log("Fully quit Qoder first — this agent runs inside it, so I cannot do that for you.");
      process.exit(2);
    }
    const exe = exePath();
    console.log(`Launching ${exe} --remote-debugging-port=${flags.port}`);
    const child = spawn(exe, [`--remote-debugging-port=${flags.port}`], { detached: true, stdio: "ignore" });
    child.unref();
    launched = true;
  }

  if (!open && (launched || flags.wait > 0)) {
    const seconds = launched ? 60 : flags.wait;
    console.log(`Waiting up to ${seconds}s for the DevTools endpoint on 127.0.0.1:${flags.port}…`);
    open = await waitForPort(flags.port, seconds * 1000);
  }

  if (!open) {
    if (launched) {
      const text = `# port ${flags.port} — ${new Date().toISOString()}\nFAIL  nothing listened on 127.0.0.1:${flags.port} after launching Qoder.\n` +
        "      This build ignores --remote-debugging-port, so the CDP route is unavailable.";
      console.log(text);
      console.log("Verdict appended to " + writeVerdict(text));
      process.exit(1);
    }
    console.log(`Qoder's DevTools port ${flags.port} is not open.`);
    console.log("Either:  node live.js --launcher   →  quit Qoder  →  run Qoder-RTL.cmd");
    console.log("or in one step (needs Qoder already quit):  node live.js --start --check");
    process.exit(2);
  }

  const endpoint = await browserEndpoint(flags.port);
  console.log(`Connected: ${endpoint}`);

  if (flags.list) {
    const targets = await httpJson(flags.port, "/json/list");
    for (const t of targets) console.log(`${t.type}\t${t.title}\t${String(t.url).slice(0, 90)}`);
    return;
  }

  const conn = await Connection.open(endpoint);
  const injector = new Injector(conn, flags);
  await injector.start();
  console.log(`Injected into ${injector.sessions.size} window(s).`);

  if (!flags.check) {
    console.log("Watching for new windows — leave this running (Ctrl+C to stop).");
    console.log("Alt+R opens the Persian text panel once a chat is on screen.");
    const tick = setInterval(() => {
      injector.report().then((r) => say(flags, `  ${new Date().toLocaleTimeString()} ${r.length} live window(s)`), () => {});
    }, 15000);
    conn.onclosed = () => {
      clearInterval(tick);
      console.log("Qoder closed its DevTools endpoint; detaching.");
      process.exit(0);
    };
    process.on("SIGINT", () => {
      clearInterval(tick);
      conn.close();
      console.log("\nDetached. Qoder keeps running; the injected styles go away with the page.");
      process.exit(0);
    });
    return;
  }

  await new Promise((r) => setTimeout(r, 4000));
  const reports = await injector.report();
  const rows = verdictRows(reports);
  const text = formatReport(reports, rows, flags.port);
  console.log(text);
  console.log("Verdict appended to " + writeVerdict(text));
  const failed = rows.filter((r) => !r.pass);
  console.log(failed.length ? `\nIncomplete: ${failed.map((f) => f.name).join(", ")}` : "\nCDP route works: the debug port is honored and the patch reaches the chat DOM.");
  conn.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("live.js failed:", e.message);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
