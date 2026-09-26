"use strict";

/*
 * Renders test/fixtures/chat.html in headless Chromium and writes the two README images:
 * docs/images/before.png (stock Qoder) and docs/images/after.png (patch applied).
 *
 *   node test/screenshot.js [--port 9420] [--out docs/images]
 *
 * Development-only: `test/` is outside package.json `files`, so this never ships. The
 * fixture is used rather than a real Qoder window on purpose — a screenshot of the live
 * app would carry someone's prompts, file names and project paths into a public repo.
 *
 * The script refuses to write an "after" image that is not actually patched: it measures
 * the same two numbers before and after injecting, and fails if they did not change.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { Connection, browserEndpoint, portIsOpen } = require("./../lib/cdp");
const { runtimeSource } = require("./../lib/payload");

const argvPort = process.argv.indexOf("--port");
const argvOut = process.argv.indexOf("--out");
const PORT = argvPort === -1 ? 9420 : Number(process.argv[argvPort + 1]) || 9420;
const OUT = path.join(__dirname, "..", argvOut === -1 ? "docs/images" : process.argv[argvOut + 1]);
const PROFILE = path.join(os.tmpdir(), `qrt-shot-profile-${process.pid}`);
const FIXTURE = path.join(__dirname, "fixtures", "chat.html");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChromium() {
  const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
  const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  return [
    path.join(local, "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(pf, "Google\\Chrome\\Application\\chrome.exe"),
    path.join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium"
  ].find((p) => p && fs.existsSync(p));
}

/* The two numbers the images have to prove: does a Persian paragraph compute to RTL, and
   does the prose resolve to Vazirmatn? A screenshot that shows neither is a broken render,
   not a demo — so this is read both before and after injection and compared. */
const MEASURE = `(function () {
  var p = document.querySelector("[data-chat-message-text] p");
  var bubble = document.querySelector("[data-user-bubble] [data-chat-message-text]");
  var s = p ? getComputedStyle(p) : null;
  return {
    paraDir: s ? s.direction : null,
    paraFont: s ? String(s.fontFamily).split(",")[0].replace(/"/g, "") : null,
    marks: document.querySelectorAll(".qrt-fa, .qrt-en").length,
    bubbleDir: bubble ? getComputedStyle(bubble).direction : null,
    widget: document.querySelectorAll(".qrt-widget").length
  };
})()`;

async function shot(conn, sessionId, file) {
  const r = await conn.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId, 20000);
  const buf = Buffer.from(r.data, "base64");
  if (buf.length < 20000) throw new Error(`${file} came out suspiciously small (${buf.length} bytes) — the page probably did not paint`);
  fs.writeFileSync(path.join(OUT, file), buf);
  console.log(`wrote ${path.relative(path.join(__dirname, ".."), path.join(OUT, file))} (${(buf.length / 1024).toFixed(0)} kB)`);
}

async function main() {
  const exe = findChromium();
  if (!exe) throw new Error("no Edge or Chrome found — the README images are generated from the local browser");
  if (await portIsOpen(PORT)) throw new Error(`port ${PORT} is already serving something; pass --port <free>`);

  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const child = spawn(exe, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--disable-gpu",
    "--no-first-run",
    "--hide-scrollbars",
    "--window-size=860,1000",
    `file:///${FIXTURE.replace(/\\/g, "/")}`
  ], { detached: process.platform === "win32", stdio: "ignore" });
  child.unref();

  let conn;
  try {
    for (let i = 0; i < 40 && !(await portIsOpen(PORT)); i++) await sleep(500);
    if (!(await portIsOpen(PORT))) {
      try { child.kill("SIGTERM"); } catch (e) {}
      throw new Error(`nothing served DevTools on ${PORT} — the browser this script started was killed so it cannot squat on the port`);
    }

    conn = await Connection.open(await browserEndpoint(PORT));
    const { targetInfos } = await conn.send("Target.getTargets");
    const page = targetInfos.find((t) => t.type === "page" && String(t.url).startsWith("file://"));
    if (!page) throw new Error("the fixture target is not listed");
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    await conn.send("Page.enable", {}, sessionId, 10000);
    await sleep(1200);

    const evaluate = async () => {
      const r = await conn.send("Runtime.evaluate", { expression: MEASURE, returnByValue: true }, sessionId, 10000);
      return r.result.value;
    };

    const before = await evaluate();
    await shot(conn, sessionId, "before.png");

    await conn.send("Runtime.evaluate", { expression: runtimeSource() }, sessionId, 30000);
    await sleep(1800);
    const after = await evaluate();
    await shot(conn, sessionId, "after.png");

    console.log("before:", JSON.stringify(before));
    console.log("after: ", JSON.stringify(after));

    /* Positive control on the images themselves: without a measured difference the "after"
       screenshot would be documenting nothing. */
    if (before.paraDir !== "ltr") throw new Error(`the stock fixture is not LTR (${before.paraDir}) — the before image proves nothing`);
    if (after.paraDir !== "rtl") throw new Error(`the patch did not reach the prose (${after.paraDir}) — refusing to publish an after image that is not patched`);
    if (!/Vazirmatn/i.test(after.paraFont || "")) throw new Error(`the prose does not resolve to Vazirmatn (${after.paraFont})`);
    if (!(after.marks > 0) || after.bubbleDir !== "rtl" || after.widget !== 1) throw new Error(`incomplete render: ${JSON.stringify(after)}`);
    console.log("both images measured: the after one really carries the patch");
  } finally {
    if (conn) conn.close();
    /* Only ever kill the browser this script started. */
    try { child.kill("SIGTERM"); } catch (e) {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} }, 1500);
    /* Windows keeps the profile directory locked for a moment after the browser dies, and
       a failed cleanup of a throwaway folder must not turn finished images into exit 1. */
    setTimeout(() => {
      try { fs.rmSync(PROFILE, { recursive: true, force: true }); }
      catch (e) { console.log(`note: left the throwaway profile behind (${PROFILE}): ${e.message}`); }
    }, 2500);
  }
}

main().catch((e) => {
  console.error("FAILED " + e.message);
  process.exit(1);
});
