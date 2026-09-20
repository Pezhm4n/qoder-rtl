"use strict";

/*
 * End-to-end check of the archive rewrite, against the real installation and
 * with nothing written to it: runs `index.js --verify` (which stages a patched
 * archive in the temp folder), then audits that staged archive.
 *
 *   node test/archive.js
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const asar = require("@electron/asar");

const { findInstall, findRendererAsarPath } = require("../lib/detect");
const { readHeader, walk } = require("../lib/asar");
const rtl = require("../lib/inject");

const ROOT = path.join(__dirname, "..");
let failures = 0;
function check(name, cond, extra) {
  if (cond === true) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
}
const read = (archive, rel) => asar.extractFile(archive, rel.split("/").join(path.sep));

function main() {
  const install = findInstall(null);
  const entry = findRendererAsarPath(install.asarPath);
  console.log(`archive: ${install.asarPath} (Qoder ${install.version})`);
  console.log("staging a patched copy with --verify (install not touched)...");

  const run = spawnSync(process.execPath, [path.join(ROOT, "index.js"), "--verify"], { encoding: "utf8" });
  const out = (run.stdout || "") + (run.stderr || "");
  check("index.js --verify exits cleanly", run.status === 0, `exit ${run.status}\n${out}`);
  if (run.status !== 0) {
    console.log(out);
    process.exit(1);
  }

  const staged = (out.match(/kept at (.+?app\.asar)/) || [])[1];
  if (!staged || !fs.existsSync(staged)) {
    console.log(`  FAIL  staged archive path not found in output\n${out}`);
    process.exit(1);
  }

  try {
    const html = read(staged, entry).toString("utf8");
    check("staged archive parses as an asar", true);
    check("marker present in staged index.html", rtl.isPatched(html));
    check("CSP left intact in staged archive", /default-src 'self'/.test(html) && !/trusted-types/i.test(html));

    const rendererDir = entry.split(path.sep).join("/").replace(/\/index\.html$/, "");
    const payloads = new Map();
    for (const p of rtl.PAYLOADS) {
      const src = fs.readFileSync(path.join(ROOT, p.from));
      const relPath = `${rendererDir}/${p.in}`;
      let buf;
      try {
        buf = read(staged, relPath);
      } catch (e) {
        check(`${relPath} readable from staged archive`, false, e.message);
        continue;
      }
      payloads.set(p.in, relPath);
      check(`${relPath} matches ${p.from} on disk (${buf.length} B)`, buf.equals(src));
    }

    /* Every reference must resolve where the browser will look for it — this is
       what catches a stylesheet pointing one folder off. */
    const refs = [...html.matchAll(/<(?:link|script)[^>]*data-qoder-rtl="1"[^>]*>/g)]
      .map((m) => (m[0].match(/(?:href|src)="\.\/([^"]+)"/) || [])[1])
      .filter(Boolean);
    const cssRefs = [...read(staged, `${rendererDir}/${rtl.CSS_NAME}`).toString("utf8").matchAll(/url\("\.\/([^"]+)"\)/g)].map((m) => m[1]);
    const resolved = new Set([...refs, ...cssRefs]);
    check("all references resolve inside the archive", [...resolved].every((r) => payloads.has(r)), [...resolved].join(", "));
    check(
      "every payload is reachable from the HTML or the stylesheet",
      rtl.PAYLOADS.every((p) => resolved.has(p.in)),
      rtl.PAYLOADS.filter((p) => !resolved.has(p.in)).map((p) => p.in).join(", ")
    );

    const before = new Map(walk(readHeader(install.asarPath).header).map((f) => [f.rel, f]));
    const after = new Map(walk(readHeader(staged).header).map((f) => [f.rel, f]));
    const addedNames = [...after.keys()].filter((k) => !before.has(k)).map((k) => path.basename(k));
    check("only the payloads were added to the header", addedNames.length === rtl.PAYLOADS.length, addedNames.join(", "));
    check("no archive entry was dropped", after.size >= before.size, `${after.size} vs ${before.size}`);

    const packed = [...before.values()].filter((f) => !f.unpacked && f.size > 0 && !f.rel.endsWith("index.html"));
    check(
      "every pre-existing file keeps its size and offset",
      packed.every((f) => {
        const g = after.get(f.rel);
        return g && g.size === f.size && g.offset === f.offset;
      })
    );
    const spot = [packed[0], packed[Math.floor(packed.length / 2)], packed[packed.length - 1]].filter(Boolean);
    check(
      "sampled file bytes are unchanged",
      spot.every((f) => read(install.asarPath, f.rel).equals(read(staged, f.rel))),
      spot.map((f) => f.rel).join(", ")
    );
  } finally {
    fs.rmSync(path.dirname(staged), { recursive: true, force: true });
    console.log(`  ok    staged copy removed from the temp folder`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main();
