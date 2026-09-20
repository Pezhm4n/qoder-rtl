"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { swapInto } = require("./asar");

const KEEP = 2;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function stateRoot() {
  const env = process.env;
  if (process.platform === "win32") return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "qoder-persian-rtl");
  if (process.platform === "darwin") return path.join(env.HOME || os.homedir(), "Library", "Application Support", "qoder-persian-rtl");
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "qoder-persian-rtl");
}

/* Each archive gets its own folder, and it lives outside the install because
   Program Files is not writable until the elevated swap happens. */
function backupsDir(asarPath) {
  const key = crypto.createHash("sha1").update(path.resolve(asarPath).toLowerCase()).digest("hex").slice(0, 12);
  return path.join(stateRoot(), "backups", key);
}

function listBackups(asarPath) {
  const dir = backupsDir(asarPath);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^app-\d{8}-\d{6}\.asar$/.test(f))
    .map((f) => {
      const file = path.join(dir, f);
      return { name: f, file, mtime: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function snapshot(asarPath) {
  const dir = backupsDir(asarPath);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `app-${stamp()}.asar`);
  fs.copyFileSync(asarPath, target);
  for (const stale of listBackups(asarPath).slice(KEEP)) fs.rmSync(stale.file, { force: true });
  return target;
}

/* Refuse to touch an archive the running app has mapped into memory. */
function assertNotRunning() {
  if (process.platform === "win32") {
    const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq Qoder.exe", "/NH"], { encoding: "utf8" });
    if (r.status === 0 && /Qoder\.exe/i.test(r.stdout || "")) {
      throw new Error("Qoder is running. Close it completely (check the tray icon), then run this again.");
    }
  } else if (process.platform === "darwin") {
    const r = spawnSync("pgrep", ["-x", "Qoder"], { encoding: "utf8" });
    if (r.status === 0) throw new Error("Qoder is running. Quit it (Cmd+Q), then run this again.");
  }
}

/* Newest backup wins: after an auto-update the pristine archive of that version
   is snapshotted before re-patching, so rollbacks land on the current version. */
function restore(asarPath, { pick } = {}) {
  const backups = listBackups(asarPath);
  if (!backups.length) throw new Error(`No backups in ${backupsDir(asarPath)}. Nothing to restore.`);
  const chosen = pick ? backups.find((b) => b.name.includes(pick)) : backups[0];
  if (!chosen) {
    throw new Error(`Backup matching ${pick} not found. Available:\n  ` + backups.map((b) => b.name).join("\n  "));
  }
  swapInto(chosen.file, asarPath);
  return { restored: chosen.file, backups: backups.length };
}

module.exports = { snapshot, restore, listBackups, assertNotRunning, backupsDir, stateRoot, stamp };
