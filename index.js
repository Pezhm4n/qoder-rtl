#!/usr/bin/env node
"use strict";

/*
 * qoder-persian-rtl
 * Adds Persian/Arabic RTL, bidi isolation for code, and an offline Vazirmatn
 * font to the Qoder desktop app's chat surface, then restores it on demand.
 *
 *   npx qoder-persian-rtl              patch (auto-detect install)
 *   npx qoder-persian-rtl --status     report patch state and version
 *   npx qoder-persian-rtl --restore    roll back to the pre-patch archive
 */

const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const { findInstall, findRendererAsarPath, RENDERER_LAYOUTS } = require("./lib/detect");
const rtl = require("./lib/inject");
const backup = require("./lib/backup");
const { swapInto, tmpRoot, readHeader, walk, patchArchive } = require("./lib/asar");

const ROOT = __dirname;
const argv = process.argv.slice(2);

const flags = {
  restore: argv.includes("--restore") || argv.includes("--uninstall"),
  status: argv.includes("--status"),
  verify: argv.includes("--verify"),
  noFont: argv.includes("--no-font"),
  asar: value("--asar"),
  out: value("--out"),
  backup: value("--backup")
};

function value(name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
}

function log(msg) {
  process.stdout.write(msg + "\n");
}
function ok(msg) {
  log(`\x1b[32m✔\x1b[0m ${msg}`);
}
function warn(msg) {
  log(`\x1b[33m!\x1b[0m ${msg}`);
}
function fail(msg) {
  log(`\x1b[31m✖\x1b[0m ${msg}`);
  process.exit(1);
}

/* Picks untouched archive members, evenly spread through the header, so the
   rewrite is proven to have preserved the body and not just the payloads. */
function sampleEntries(asarPath, count) {
  const candidates = walk(readHeader(asarPath).header).filter(
    (f) => !f.unpacked && f.size > 0 && f.size <= 64 * 1024 && !/index\.html$/.test(f.rel)
  );
  if (!candidates.length) throw new Error("No archive members available to sample");
  const step = Math.max(1, Math.floor(candidates.length / count));
  const picked = [];
  for (let i = 0; i < candidates.length && picked.length < count; i += step) picked.push(candidates[i].rel);
  return picked;
}

/* Resolves the renderer entry straight out of the archive — no 220 MB extraction. */
function statusOf(install) {
  const entry = findRendererAsarPath(install.asarPath);
  if (!entry) {
    return {
      patched: null,
      error:
        `Renderer entry not found in ${install.asarPath}. Tried:\n  ` +
        RENDERER_LAYOUTS.join("\n  ") +
        "\n  Qoder's bundle layout changed — report: npx @electron/asar list <app.asar> | findstr index.html"
    };
  }
  let html = "";
  try {
    html = asar.extractFile(install.asarPath, entry).toString("utf8");
  } catch (e) {
    return { patched: null, error: `Cannot read ${entry} from archive: ${e.message}` };
  }
  return { patched: rtl.isPatched(html), html, entry };
}

function writeOut(install, tempAsar) {
  const dest = flags.out ? path.resolve(flags.out) : install.asarPath;
  if (flags.out) {
    fs.copyFileSync(tempAsar, dest);
    ok(`Wrote patched archive to ${dest}`);
    return;
  }
  const { elevated } = swapInto(tempAsar, dest);
  ok(`Patched ${dest}${elevated ? " (via administrator approval)" : ""}`);
}

async function patch(install) {
  const before = statusOf(install);
  if (before.error) fail(before.error);

  const work = tmpRoot("patch");
  const staged = path.join(work, "app.asar");
  const t0 = Date.now();

  try {
    log(`Qoder ${install.version} → ${install.asarPath}`);

    const entry = before.entry.split(path.sep).join("/");
    const rendererDir = entry.replace(/\/index\.html$/, "");
    let html = before.html;
    if (before.patched) ok("Already patched — payload refreshed, no duplicate injected");
    html = rtl.injectIntoHtml(html);

    const additions = [{ rel: entry, data: Buffer.from(html, "utf8") }];
    for (const p of rtl.PAYLOADS) {
      if (flags.noFont && p.in === rtl.FONT_NAME) continue;
      additions.push({ rel: `${rendererDir}/${p.in}`, data: fs.readFileSync(path.join(ROOT, p.from)) });
    }
    if (flags.noFont) warn("Skipping Vazirmatn (--no-font): RTL applies with the system font");

    log(`Rewriting archive (streams ${Math.round(fs.statSync(install.asarPath).size / 1048576)} MB)...`);
    const res = patchArchive(install.asarPath, staged, additions);
    ok(`Header ${res.headerBytes} B + body ${res.bodySize} B + ${additions.length} payloads → ${fs.statSync(staged).size} B`);

    if (!rtl.isPatched(asar.extractFile(staged, before.entry).toString("utf8"))) {
      throw new Error("Verification failed: marker missing in the rewritten archive");
    }
    for (const a of additions) {
      const got = asar.extractFile(staged, a.rel.split("/").join(path.sep));
      if (!got.equals(a.data)) throw new Error(`Verification failed: ${a.rel} does not read back byte-identical`);
    }
    ok(`Payloads read back byte-identical (${additions.map((a) => path.basename(a.rel)).join(", ")})`);

    const untouched = sampleEntries(install.asarPath, 6);
    for (const rel of untouched) {
      const src = asar.extractFile(install.asarPath, rel.split("/").join(path.sep));
      const dst = asar.extractFile(staged, rel.split("/").join(path.sep));
      if (!src.equals(dst)) throw new Error(`Verification failed: unrelated file ${rel} changed`);
    }
    ok(`Unrelated files intact (${untouched.length} sampled against the original)`);
    ok(`Archive rewritten and verified in ${(Date.now() - t0) / 1000}s`);

    if (flags.verify) {
      ok(`--verify only: nothing written. Staged archive kept at ${staged}`);
      return;
    }

    if (install.privileged) warn("System install: Windows will ask for administrator approval once.");
    backup.assertNotRunning();
    if (before.patched) {
      log("Backup: skipped — this archive is already patched, so the stored pristine copy stays current");
    } else {
      log(`Backing up the original archive to ${backup.backupsDir(install.asarPath)} ...`);
      ok(`Backup: ${path.basename(backup.snapshot(install.asarPath))}`);
    }

    writeOut(install, staged);

    log("");
    ok("Done. Start Qoder and open a chat.");
    log("  • Alt+R toggles RTL on/off");
    log("  • The «ا» button at the top-right of the chat opens the settings panel");
    log("  • Qoder's auto-update overwrites app.asar — re-run this command afterwards");
    log(`  • Roll back anytime:  node ${path.relative(process.cwd(), path.join(ROOT, "index.js"))} --restore`);
  } catch (e) {
    fail(`${e.message}\n  Original archive untouched; nothing was swapped in.`);
  } finally {
    if (!flags.verify) fs.rmSync(work, { recursive: true, force: true });
  }
}

function restoreCommand(install) {
  try {
    backup.assertNotRunning();
    const r = backup.restore(install.asarPath, { pick: flags.backup });
    ok(`Restored ${install.asarPath} from ${path.basename(r.restored)} (${r.backups} backup(s) kept)`);
    log("Restart Qoder to load the original files.");
  } catch (e) {
    fail(e.message);
  }
}

function main() {
  let install;
  try {
    install = findInstall(flags.asar);
  } catch (e) {
    fail(e.message);
  }

  if (flags.status) {
    const s = statusOf(install);
    log(`Install   : ${install.asarPath}`);
    log(`Version   : ${install.version}`);
    log(`Elevation : ${install.privileged ? "administrator required to write" : "writable by your user"}`);
    log(`Patch     : ${s.error ? "unknown — " + s.error : s.patched ? "applied" : "not applied"}`);
    log(`Backups   : ${backup.listBackups(install.asarPath).length} in ${backup.backupsDir(install.asarPath)}`);
    return;
  }

  if (flags.restore) return restoreCommand(install);
  return patch(install);
}

if (require.main === module) main();
module.exports = { main, flags };
