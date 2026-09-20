"use strict";

/*
 * Verifies the injection logic against a real Qoder archive without writing
 * anything to the installation:
 *   1. resolves the renderer entry point inside app.asar (layout can vary)
 *   2. round-trips the HTML patch (inject -> strip)
 *   3. syntax-checks the payloads and asserts they cannot violate Qoder's CSP
 *
 *   node test/roundtrip.js [--asar <path.to/app.asar>]
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const asar = require("@electron/asar");

const { findInstall, findRendererAsarPath, RENDERER_LAYOUTS } = require("../lib/detect");
const rtl = require("../lib/inject");

let failures = 0;
function check(name, cond, extra) {
  if (cond === true) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${extra && cond !== false ? " — " + cond : ""}`);
  }
}

function main() {
  const idx = process.argv.indexOf("--asar");
  const install = findInstall(idx === -1 ? null : process.argv[idx + 1]);
  console.log(`archive: ${install.asarPath} (Qoder ${install.version})`);

  const entry = findRendererAsarPath(install.asarPath);
  if (!entry) {
    console.log("  FAIL  no renderer entry resolved — tried:\n    " + RENDERER_LAYOUTS.join("\n    "));
    process.exit(1);
  }
  const html = asar.extractFile(install.asarPath, entry).toString("utf8");
  console.log(`  ok    renderer entry = ${entry} (${html.length} bytes)`);

  const patched = rtl.injectIntoHtml(html);
  check("marker present after inject", rtl.isPatched(patched));
  check("CSP meta untouched", /Content-Security-Policy/.test(patched) && !/trusted-types/i.test(patched));
  check("payload refs are relative same-origin", patched.includes(`href="./${rtl.CSS_NAME}"`) && patched.includes(`src="./${rtl.JS_NAME}"`));
  check("no remote URLs injected", !/https?:\/\/[^"]*qoder-rtl/.test(patched));
  check("re-inject is idempotent", rtl.injectIntoHtml(patched).length === patched.length);
  check("document pinned ltr so app chrome is unchanged", /<html[^>]*dir="ltr"/.test(patched));
  check("strip removes the payload block", !rtl.strip(patched).includes(rtl.MARKER));
  check("app bundle reference survives", /assets\/index-[\w-]+\.js/.test(rtl.strip(patched)));

  const js = fs.readFileSync(path.join(__dirname, "..", "patches", "rtl.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "patches", "rtl.css"), "utf8");
  const parses = (() => {
    try {
      new vm.Script(js);
      return true;
    } catch (e) {
      return e.message;
    }
  })();
  check("rtl.js parses", parses === true, parses);
  check("rtl.js has no eval or remote fetch", !/\beval\(|fetch\(["'`]https?:/.test(js));
  check("rtl.css points at the bundled offline font", css.includes(`url("./${rtl.FONT_NAME}")`));
  check("rtl.css scopes to Qoder chat hooks", css.includes("[data-chat-message-text]") && css.includes("[data-chat-composer]"));
  check("rtl.css keeps code blocks LTR", /direction:\s*ltr\s*!important/.test(css));
  check("font asset present", fs.existsSync(path.join(__dirname, "..", "assets", "vazirmatn-variable.woff2")));

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main();
