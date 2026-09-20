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
const { runtimeSource, probeSource, controlsProbeSource, diagnoseSource } = require("./lib/payload");
const { findInstall } = require("./lib/detect");
const { stateRoot } = require("./lib/backup");

const DEFAULT_PORT = 9222;
const DEFAULT_WAIT = 30;
const HELP = `node live.js [--port 9222] [--wait 30] [--check] [--diagnose] [--start] [--launcher] [--list] [-v]

  --check      inject, probe every window, append the result to
               %LOCALAPPDATA%\\qoder-persian-rtl\\cdp-test.log, then exit
  --diagnose   read-only: report what the live window actually computed (fonts,
               computed font-family, panel state), no injection, cdp-diagnose.log
  --start      start Qoder with --remote-debugging-port (quit it first: single instance)
  --launcher   write Qoder-RTL.cmd next to live.js and in %LOCALAPPDATA%\\qoder-persian-rtl
               (that .cmd starts Qoder with the port and runs this injector after it)
  --wait <s>   seconds to wait for the DevTools port to appear (default ${DEFAULT_WAIT})
  --list       show the page targets CDP can see`;

function parseArgs(argv) {
  const flags = { port: DEFAULT_PORT, wait: DEFAULT_WAIT, check: false, diagnose: false, start: false, launcher: false, list: false, verbose: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") flags.port = Number(argv[++i]) || flags.port;
    else if (a === "--wait") flags.wait = Number(argv[++i]);
    else if (a === "--check") flags.check = true;
    else if (a === "--diagnose") flags.diagnose = true;
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
    const pages = targetInfos.filter((t) => t.type === "page" && t.subtype !== "devtools");
    /* One unresponsive window (hidden splash, unrendered document) must not stall
       the others, so the per-target work runs concurrently. */
    await Promise.all(
      pages.map(async (info) => {
        try {
          const { sessionId } = await this.conn.send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
          await this.onAttach(sessionId, info);
        } catch (e) {
          say(this.flags, `  could not attach to ${info.targetId}: ${e.message}`);
        }
      })
    );
  }

  async onAttach(sessionId, info) {
    if (!info || info.type !== "page" || this.sessions.has(sessionId)) return;
    const meta = { targetId: info.targetId, url: info.url, patchedAt: null, patchError: null };
    this.sessions.set(sessionId, meta);
    say(this.flags, `  page: ${info.title || "(untitled)"} — ${String(info.url).slice(0, 90)}`);
    try {
      await this.conn.send("Page.enable", {}, sessionId, 8000);
    } catch (e) {
      this.sessions.delete(sessionId);
      say(this.flags, `  skipped (no Page domain): ${e.message}`);
      return;
    }
    /* Runs on every later document before the page's own scripts, and CSP does not apply to it. */
    try {
      await this.conn.send("Page.addScriptToEvaluateOnNewDocument", { source: this.source }, sessionId, 8000);
    } catch (e) {
      meta.patchError = `addScriptToEvaluateOnNewDocument: ${e.message}`;
      say(this.flags, `  ${meta.patchError}`);
    }
    meta.patchedAt = await this.patchNow(sessionId).catch((e) => {
      meta.patchError = e.message;
      return null;
    });
  }

  async patchNow(sessionId) {
    /* The payload carries ~150 KB of base64 font, so this call gets a longer budget. */
    const res = await this.conn.send("Runtime.evaluate", { expression: this.source }, sessionId, 30000);
    const ex = res && res.exceptionDetails;
    if (ex) console.log(`  ! injected script threw: ${ex.exception?.description?.split("\n")[0] || ex.text}`);
    return ex ? null : new Date().toISOString();
  }

  async probe(sessionId) {
    const res = await this.conn.send("Runtime.evaluate", { expression: probeSource(), returnByValue: true }, sessionId, 10000);
    if (res.exceptionDetails || typeof res.result?.value !== "string") {
      return { error: res.exceptionDetails?.text || (res.result && res.result.subtype) || "no probe result" };
    }
    try {
      return JSON.parse(res.result.value);
    } catch (e) {
      return { error: "unparsable probe result" };
    }
  }

  async controls(sessionId) {
    const res = await this.conn.send("Runtime.evaluate", { expression: controlsProbeSource(), returnByValue: true }, sessionId, 10000);
    if (res.exceptionDetails || typeof res.result?.value !== "string") {
      return { error: res.exceptionDetails?.text || "no controls result" };
    }
    try {
      return JSON.parse(res.result.value);
    } catch (e) {
      return { error: "unparsable controls result" };
    }
  }

  async diagnose(sessionId) {
    const res = await this.conn.send("Runtime.evaluate", { expression: diagnoseSource(), returnByValue: true }, sessionId, 15000);
    if (typeof res.result?.value !== "string") return { error: res.exceptionDetails?.text || "no diagnose result" };
    try {
      return JSON.parse(res.result.value);
    } catch (e) {
      return { error: "unparsable diagnose result" };
    }
  }

  async report(options = {}) {
    const out = [];
    for (const [sessionId, meta] of this.sessions) {
      const p = await this.probe(sessionId).catch((e) => ({ error: e.message }));
      /* The controls probe briefly drives the runtime through other values, so it
         runs only when somebody asked for a verdict, not on every watch tick. */
      const controls = options.withControls ? await this.controls(sessionId).catch((e) => ({ error: e.message })) : null;
      out.push({
        targetId: meta.targetId,
        url: meta.url,
        patchedAt: meta.patchedAt,
        patchError: meta.patchError,
        ...(controls ? { controls } : null),
        ...p
      });
    }
    return out;
  }
}

/* ---------- verdict ---------- */

/* A probe that could not run (window destroyed, socket dropped) is unknown, not a failure. */
function verdictRows(reports) {
  const answered = reports.filter((r) => !r.error);
  const ok = (fn) => answered.some(fn);
  /* Rows about the chat itself must be judged on a window that has chat: Qoder keeps a
     second, empty target where the widget still mounts and nothing ever clashes, so
     scoring the panel there would green a real corner overlap. */
  const withChat = answered.filter((r) => r.hooks && r.hooks.messageText > 0);
  const okChat = (fn) => (withChat.length ? withChat : answered).some(fn);
  const unknown = answered.length === 0 && reports.length > 0;
  const row = (name, pass, detail) => ({ name, pass: unknown ? null : pass, detail });
  return [
    { name: "page targets visible over CDP", pass: reports.length > 0, detail: `${reports.length} target(s)` },
    { name: "probes answered", pass: !unknown && reports.length > 0, detail: unknown ? reports.map((r) => r.error).filter(Boolean).join(" / ") || "—" : `${answered.length}/${reports.length}` },
    {
      name: "payload injected (window.__QODER_RTL__)",
      /* patchedAt comes from the injector itself, so it survives a lost probe. */
      pass: ok((r) => !!r.rtlVersion) || reports.some((r) => r.patchedAt),
      detail: reports.map((r) => r.rtlVersion || r.patchError || r.error || (r.patchedAt ? "injected, probe lost" : "—")).join(", ")
    },
    row(
      "stylesheet installed inline and current",
      ok((r) => r.styleTag === true && r.styleCount === 1),
      /* More than one node means an older payload's sheet is still in the document
         and can keep winning properties the new one changed. */
      answered.map((r) => `nodes=${r.styleCount} bytes=${r.styleBytes}${r.styleCount > 1 ? " (stale sheet present)" : ""}`).join(" | ") || "—"
    ),
    row(
      "Vazirmatn registered from inlined bytes",
      ok((r) => /loaded|added|css-fallback|pending/.test(String(r.font && r.font.registered))),
      answered.map((r) => `${(r.font && r.font.registered) || "never"} via ${(r.font && r.font.route) || "-"}${r.font && r.font.message ? ` (${r.font.message})` : ""}`).join(" | ") || "—"
    ),
    row(
      "Vazirmatn resolves for page text",
      ok((r) => r.font && r.font.usableByCss === true),
      answered.map((r) => `check=${r.font ? r.font.usableByCss : "?"}`).join(" ") || "—"
    ),
    row(
      "chat prose computes to the Vazirmatn stack",
      ok((r) => r.applied && /^["']?Vazirmatn QRT/.test(r.applied.textFont || "")),
      answered
        .map((r) => {
          const t = r.applied && r.applied.text;
          return t ? `${t.tag} → ${t.fontFamily}` : "no prose element";
        })
        .join(" | ") || "—"
    ),
    row(
      "line-height slider value reaches the prose",
      ok((r) => {
        const t = r.applied && r.applied.text;
        const want = Number(r.settings && r.settings.lineHeight);
        return t && t.ratio != null && want && Math.abs(t.ratio - want) <= 0.02;
      }),
      answered
        .map((r) => {
          const t = r.applied && r.applied.text;
          return t ? `${t.lineHeight} on ${t.fontSize} = ${t.ratio} (config ${r.settings ? r.settings.lineHeight : "?"})` : "no prose element";
        })
        .join(" | ") || "—"
    ),
    row(
      "panel sliders change the prose when applied",
      ok((r) => {
        const c = r.controls;
        return !!c && !c.error && Math.abs(c.after.lineHeightPx - c.before.lineHeightPx) >= 0.5 && Math.abs(c.after.zoom - c.before.zoom) >= 0.02;
      }),
      answered
        .map((r) => {
          const c = r.controls;
          if (!c) return "not probed";
          if (c.error) return `probe: ${c.error}`;
          return `leading ${c.before.lineHeightPx}→${c.after.lineHeightPx}px, zoom ${c.before.zoom}→${c.after.zoom}${same(c.settled, c.before) ? "" : " (config NOT restored)"}`;
        })
        .join(" | ") || "—"
    ),
    row(
      "chat DOM hooks reachable",
      ok((r) => r.hooks && Object.values(r.hooks).some((n) => n > 0)),
      answered.map((r) => JSON.stringify(r.hooks || {})).join(" | ") || "—"
    ),
    row(
      "patch active on the document root",
      ok((r) => r.applied && /smart|force/.test(r.applied.mode || "") && r.applied.vars > 0),
      answered.map((r) => `data-qrt-mode=${(r.applied && r.applied.mode) || "—"} vars=${r.applied ? r.applied.vars : "?"} fa=${r.applied ? r.applied.faBlocks : "?"} classes="${(r.applied && r.applied.htmlClasses) || ""}"`).join(" | ") || "—"
    ),
    row(
      "settings panel mounted, visible and bottom-right",
      okChat((r) => {
        const a = r.applied && r.applied.panelAnchors;
        return (
          !!r.applied &&
          r.applied.panel > 0 &&
          r.applied.panelVisible &&
          !!a &&
          a.bottomGap >= 0 &&
          a.bottomGap <= 64 &&
          a.rightGap >= 0 &&
          a.rightGap <= 64 &&
          a.topGap > a.bottomGap &&
          /* Measured, not assumed: the trigger must not sit on any of the app's own
             fixed corner UI, whose clicks it would swallow. */
          !!a.cornerClash &&
          a.cornerClash.n === 0
        );
      }),
      (withChat.length ? withChat : answered)
        .map((r) => {
          const p = r.applied || {};
          const a = p.panelAnchors;
          const clash = a && a.cornerClash ? (a.cornerClash.n === 0 ? "clear" : `over ${a.cornerClash.n}: ${a.cornerClash.what || "?"}`) : "trigger?";
          return `nodes=${p.panel} size=${p.panelRect || "none"}${a ? ` ${a.bottomGap}px from the bottom, ${a.rightGap}px from the right (${a.flexDirection}, corner ${clash})` : " not mounted"}`;
        })
        .join(" | ") || "—"
    )
  ];
}

/* The controls probe must leave the user's own config exactly as it found it. */
function same(a, b) {
  return !!a && !!b && Math.abs(a.lineHeightPx - b.lineHeightPx) < 0.05 && Math.abs(a.zoom - b.zoom) < 0.001;
}

function hintsFor(rows) {
  const hints = [];
  const failed = rows.filter((r) => r.pass === false).map((r) => r.name);
  if (failed.includes("chat DOM hooks reachable") && !failed.includes("payload injected (window.__QODER_RTL__)")) {
    hints.push("hooks=0 with the payload injected normally means that window has no conversation rendered — open a chat and re-run.");
  }
  if (failed.includes("patch active on the document root")) {
    hints.push("no data-qrt-mode on <html> means the config is switched off: press Alt+R inside Qoder, or clear the qoder_persian_rtl_config_v1 key.");
  }
  if (failed.includes("Vazirmatn resolves for page text")) {
    hints.push("the face never became usable — run node live.js --diagnose and compare font.prelude with font.faces; a 'never' prelude status means the payload's first half did not execute.");
  }
  if (failed.includes("chat prose computes to the Vazirmatn stack") && !failed.includes("Vazirmatn resolves for page text")) {
    hints.push("the font is loaded but Qoder's own font-family rule wins on the prose elements — node live.js --diagnose prints the computed stack per element, which selector needs !important.");
  }
  if (failed.includes("stylesheet installed inline and current")) {
    hints.push("nodes>1 → an older payload's <style data-qoder-rtl> is still in the document and can out-rule the new sheet; the prelude rewrites it in place, so re-running the injector fixes it.");
  }
  if (failed.includes("line-height slider value reaches the prose")) {
    hints.push("the prose leading is not the configured ratio — Qoder stamps line-height !important on its own prose rules (its chat font-size setting), so the runtime has to leave an inline !important on the element; run --diagnose and check that the sampled paragraph carries data-qrt-lead.");
  }
  if (failed.includes("panel sliders change the prose when applied")) {
    hints.push("the probe drives lineHeight/chatSize through the runtime and re-measures: no change means the var never reaches the text, 'probe: no runtime' means the payload is not the current version (restart the injector).");
  }
  if (failed.includes("settings panel mounted, visible and bottom-right")) {
    hints.push("nodes=0 → the widget was never mounted (check rtl.config.panel, or press Alt+Shift+R); nodes>0 with size=0x0 → something in the page hides or re-parents .qrt-widget; a large bottom-gap number → the widget is not anchored to the window edge, i.e. an older payload is still running; re-run the injector; a right-gap under 46 → the trigger overlaps Qoder's own corner help button and steals its clicks (the row prints 'over N: <classes>' for whatever it collides with).");
  }
  if (rows.some((r) => r.pass === null)) {
    hints.push("UNKNOWN rows are windows whose probe never answered (hidden/destroyed target); the patch itself may still be applied.");
  }
  return hints;
}

function formatReport(reports, rows, port) {
  const mark = (p) => (p === null ? "UNSURE" : p ? "PASS" : "FAIL");
  const lines = [`# port ${port} — ${new Date().toISOString()}`];
  if (!reports.length) lines.push("(no page targets attached)");
  for (const r of reports) {
    lines.push(
      `- ${r.targetId}\n    url     ${r.url}\n    patched ${r.patchedAt || "n/a"}${r.patchError ? " (error: " + r.patchError + ")" : ""}\n    version ${r.rtlVersion || r.error || "absent"}`,
      `    css     style=${r.styleTag} nodes=${r.styleCount} bytes=${r.styleBytes} font=${JSON.stringify(r.font || null)}`,
      `    hooks   ${JSON.stringify(r.hooks || {})}`,
      `    prose   ${JSON.stringify((r.applied && r.applied.text) || {})} settings ${JSON.stringify(r.settings || {})}`,
      `    applied ${JSON.stringify(r.applied || {})}`,
      ...(r.controls ? [`    controls ${JSON.stringify(r.controls)}`] : [])
    );
  }
  for (const row of rows) lines.push(`${mark(row.pass)}  ${row.name} (${row.detail})`);
  for (const hint of hintsFor(rows)) lines.push(`note  ${hint}`);
  return lines.join("\n");
}

function writeVerdict(text, name = "cdp-test.log") {
  const dir = stateRoot();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.appendFileSync(file, text + "\n\n", "utf8");
  return file;
}

/* Read-only pass over every page target, for answering "why does it look wrong". */
async function runDiagnose(conn, flags) {
  const injector = new Injector(conn, flags);
  const { targetInfos } = await conn.send("Target.getTargets");
  const rows = [];
  for (const info of targetInfos.filter((t) => t.type === "page" && t.subtype !== "devtools")) {
    const row = { targetId: info.targetId, title: info.title, url: info.url };
    try {
      const { sessionId } = await conn.send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
      Object.assign(row, await injector.diagnose(sessionId));
      await conn.send("Target.detachFromTarget", { sessionId }, undefined, 5000).catch(() => {});
    } catch (e) {
      row.error = e.message;
    }
    rows.push(row);
  }
  return rows;
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

  if (flags.diagnose) {
    const rows = await runDiagnose(conn, flags);
    const text = `# diagnose port ${flags.port} — ${new Date().toISOString()}\n${JSON.stringify(rows, null, 2)}`;
    console.log(text);
    console.log("\nReport appended to " + writeVerdict(text, "cdp-diagnose.log"));
    conn.close();
    return;
  }

  const injector = new Injector(conn, flags);
  await injector.start();
  console.log(`Injected into ${injector.sessions.size} window(s).`);

  if (!flags.check) {
    console.log("Watching for new windows — leave this running (Ctrl+C to stop).");
    console.log("The «ا» button at the top-right of the chat opens the settings panel; Alt+R toggles RTL, Alt+Shift+R shows or hides that button.");
    console.log("Something looks off?  node live.js --diagnose   (read-only)");
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
  const reports = await injector.report({ withControls: true });
  const rows = verdictRows(reports);
  const text = formatReport(reports, rows, flags.port);
  console.log(text);
  console.log("Verdict appended to " + writeVerdict(text));
  const failed = rows.filter((r) => r.pass === false);
  const unsure = rows.filter((r) => r.pass === null);
  if (failed.length) console.log(`\nIncomplete: ${failed.map((f) => f.name).join(", ")}`);
  else if (unsure.length) console.log(`\nPartly unverified: ${unsure.map((f) => f.name).join(", ")} — the rest passed.`);
  else console.log("\nCDP route works: the debug port is honored and the patch reaches the chat DOM.");
  conn.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("live.js failed:", e.message);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
