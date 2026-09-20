"use strict";

/*
 * Offline checks for the CDP side-loader: the injectable source must be valid
 * JavaScript, self-contained (no file URLs, since nothing is written to disk),
 * and CSP-safe (no eval/new Function, because the page forbids them).
 *
 *   node test/live.js
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { runtimeSource, probeSource, inlineStylesheet, fontDataUri } = require("../lib/payload");
const { FONT_NAME } = require("../lib/inject");

let failures = 0;
function check(name, cond, extra) {
  if (cond === true) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
}

function main() {
  const css = inlineStylesheet();
  const src = runtimeSource();
  const probe = probeSource();

  console.log(`payload: stylesheet ${css.length} B, full source ${src.length} B`);

  check("font inlined as a data: URI", css.includes("data:font/woff2;base64,") && css.includes(fontDataUri().slice(0, 40)));
  check("no relative file references left", !/url\(\s*["']?\.\//.test(css), (css.match(/url\(\s*["']?\.[^)]*/) || []).join(" "));
  check("original font name is gone from the CSS", !css.includes(FONT_NAME));
  check("stylesheet still declares the font family", css.includes('font-family: "Vazirmatn QRT"'));
  check("stylesheet keeps the chat anchors", css.includes("[data-chat-turn]") && css.includes(".markdown-body"));

  for (const [name, code] of [
    ["runtime source", src],
    ["probe source", probe]
  ]) {
    let parses = true;
    let err = "";
    try {
      new vm.Script(code);
    } catch (e) {
      parses = false;
      err = e.message;
    }
    check(`${name} parses as a script`, parses, err);
  }

  check(
    "source is CSP-safe (no eval / new Function)",
    !/\beval\s*\(/.test(src) && !/new\s+Function\s*\(/.test(src) && !/\bimport\s*\(/.test(src)
  );
  check("source carries the stylesheet prelude and the runtime", src.includes("data-qoder-rtl") && src.includes("__QODER_RTL__"));
  check("runtime body is the same file the archive route ships", src.includes(fs.readFileSync(path.join(__dirname, "..", "patches", "rtl.js"), "utf8").trim().slice(0, 200)));

  /* addScriptToEvaluateOnNewDocument runs before <body> exists, so at document
     start the payload may only touch documentElement and register listeners. */
  const sandbox = {
    document: {
      readyState: "loading",
      documentElement: { classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, appendChild() {} },
      head: null,
      body: null,
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      addEventListener() {},
      createElement: () => ({ setAttribute() {}, appendChild() {}, classList: { add() {}, toggle() {} }, style: {}, textContent: "" })
    },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }) },
    location: { href: "file:///qoder/index.html" },
    navigator: { clipboard: {} },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    }
  };
  sandbox.globalThis = sandbox;
  let ran = true;
  let ranTwice = true;
  try {
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
  } catch (e) {
    ran = false;
    ranTwice = false;
    console.log(`        (document-start run threw: ${e.message})`);
  }
  if (ran) {
    try {
      vm.runInContext(src, sandbox); /* a reload/new document must not throw either */
    } catch (e) {
      ranTwice = false;
      console.log(`        (second run threw: ${e.message})`);
    }
  }
  check("source is safe to run at document start", ran);
  check("source tolerates a second injection in the same document", ranTwice);

  console.log(failures ? `\n${failures} check(s) failed` : "\nall CDP payload checks passed");
  process.exit(failures ? 1 : 0);
}

main();
