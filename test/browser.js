"use strict";

/*
 * Integration test for the CDP side-loader against a real Chromium, so the
 * protocol plumbing and the payload can be proven without touching Qoder:
 *
 *   node test/browser.js [--port 9333]
 *
 * It starts a headless Edge/Chrome on a throwaway profile with a fixture page
 * that imitates Qoder's chat DOM, runs `node live.js --check` against it, and
 * asserts the verdict. Only the browser this test spawns is ever killed.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { portIsOpen } = require("../lib/cdp");

const ROOT = path.join(__dirname, "..");
const argvPort = process.argv.indexOf("--port");
const PORT = argvPort === -1 ? 9333 : Number(process.argv[argvPort + 1]) || 9333;
const PROFILE = path.join(os.tmpdir(), `qrt-browser-profile-${process.pid}`);
const FIXTURE = path.join(__dirname, "fixtures", "chat.html");

let failures = 0;
function check(name, cond, extra) {
  if (cond === true) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startBrowser(exe) {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const child = spawn(
    exe,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--disable-gpu",
      "--no-first-run",
      "--window-size=900,700",
      `file:///${FIXTURE.replace(/\\/g, "/")}`
    ],
    { detached: process.platform === "win32", stdio: "ignore" }
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await portIsOpen(PORT)) return child;
    await sleep(500);
  }
  return null;
}

async function main() {
  const exe = findChromium();
  if (!exe) {
    console.log("  skip  no local Chromium (Edge/Chrome) found — cannot run the browser integration test");
    return;
  }
  console.log(`browser: ${exe}`);
  console.log(`fixture: ${FIXTURE}`);

  const child = await startBrowser(exe);
  if (!child) {
    check("headless browser exposes a DevTools port", false, `nothing listened on ${PORT}`);
    return finish(PROFILE);
  }
  check("headless browser exposes a DevTools port", true);

  const run = spawnSync(process.execPath, [path.join(ROOT, "live.js"), "--port", String(PORT), "--check"], { encoding: "utf8" });
  const out = (run.stdout || "") + (run.stderr || "");
  console.log(out.replace(/^/gm, "    "));

  check("live.js attached to the page target", /page targets visible over CDP \(1 target/.test(out) || /page targets visible over CDP \((\d+) target/.test(out));
  check("payload injected into the page", /PASS\s+payload injected/.test(out), "no __QODER_RTL__");
  check("inline stylesheet installed", /PASS\s+stylesheet installed inline/.test(out));
  check("chat DOM hooks reachable", /PASS\s+chat DOM hooks reachable/.test(out));
  check("injected script threw no exception", !/injected script threw/.test(out));
  check("font registered from inlined bytes", /PASS\s+Vazirmatn registered from inlined bytes/.test(out));
  check("font resolves for page text", /PASS\s+Vazirmatn resolves for page text/.test(out), "document.fonts.check() never turned true");
  check("chat prose computes to Vazirmatn", /PASS\s+chat prose computes to the Vazirmatn stack/.test(out));
  check("patch applied on the document root", /PASS\s+patch active on the document root/.test(out));
  /* The fixture rewrites <html class="…"> every 500 ms, so empty classes here prove
     the mode survives on data-qrt-* attributes rather than on classes. */
  check("root state survives the page wiping html classes", /patch active on the document root \(data-qrt-mode=smart[^)]*classes=""/.test(out));
  check("settings panel mounted and visible", /PASS\s+settings panel mounted and visible/.test(out));
  check("live.js exited cleanly", run.status === 0, `exit ${run.status}`);
  const fontLine = out.match(/(PASS|FAIL)\s+Vazirmatn resolves for page text \(([^)]*)\)/);
  console.log(`  note  font: ${fontLine ? fontLine[1] + " " + fontLine[2] : "not reported"}`);

  finish(PROFILE, child.pid);
}

function removeProfile(profileDir) {
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
      if (!fs.existsSync(profileDir)) return;
    } catch (e) {
      /* Edge can hold the profile for a moment after the process dies */
    }
    spawnSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 700"]);
  }
  console.log(`  note  left-over profile dir: ${profileDir}`);
}

function finish(profileDir, pid) {
  if (pid && process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else if (pid) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (e) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (e2) {}
    }
    spawnSync("sleep", ["1"]);
  }
  removeProfile(profileDir);
  console.log(failures ? `\n${failures} check(s) failed` : "\nCDP side-loader works end to end against a real Chromium");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("test/browser.js failed:", e.stack || e.message);
  removeProfile(PROFILE);
  process.exit(1);
});
