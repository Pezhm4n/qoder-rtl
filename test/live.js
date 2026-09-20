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

const { runtimeSource, probeSource, controlsProbeSource, diagnoseSource, inlineStylesheet, fontBase64, FONT_FAMILY } = require("../lib/payload");
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
  const diagnose = diagnoseSource();

  console.log(`payload: stylesheet ${css.length} B, font ${fontBase64().length} B base64, full source ${src.length} B`);

  check("no file-based @font-face survives inlining", !css.includes(FONT_NAME) && !/@font-face/.test(css));
  check("no relative file references left", !/url\(\s*["']?\.\//.test(css), (css.match(/url\(\s*["']?\.[^)]*/) || []).join(" "));
  check("stylesheet still declares the font family", css.includes(`"${FONT_FAMILY}"`));
  check("stylesheet keeps the chat anchors", css.includes("[data-chat-turn]") && css.includes(".markdown-body"));
  check("root state is keyed on data-qrt-* attributes, not classes", !/html\.qrt-/.test(css) && css.includes('html[data-qrt-mode="smart"]') && css.includes("html[data-qrt-tables]"));

  /* Qoder's own utilities sit on the prose elements, so container-level rules are
     not enough: these three must be repeated where the text actually is. */
  const rtljs = fs.readFileSync(path.join(__dirname, "..", "patches", "rtl.js"), "utf8");
  check("prose restates the font stack with !important", /\[data-chat-message-text\] :is\(p[^{]*\{\s*font-family: var\(--qrt-stack\) !important;/.test(css));
  check("prose restates the line-height with !important", /\[data-chat-message-text\] :is\(p[^{]*\{\s*line-height: var\(--qrt-leading\) !important;/.test(css));
  check("text size scales the subtree instead of the font-size", css.includes("zoom: var(--qrt-zoom)") && rtljs.includes('"--qrt-zoom:"') && !css.includes("--qrt-chat-size") && !rtljs.includes("--qrt-chat-size"));
  check("settings widget is anchored bottom-right", rtljs.includes("bottom:14px;right:52px") && rtljs.includes("column-reverse") && !rtljs.includes("top:46px"));
  /* Qoder's help button is a 28px fixed circle 18px from the same corner; the trigger
     has to start past it or it swallows the click (our z-index is maximal). */
  check("trigger clears Qoder's corner help button", (() => {
    const m = /\.qrt-widget\{[^}]*right:(\d+)px/.exec(rtljs);
    return !!m && Number(m[1]) >= 46;
  })());
  /* Qoder's chat font-size rule pins prose line-height with !important and a longer
     selector than any injected sheet can justify, so the runtime stamps it inline. */
  check('leading is stamped inline with !important', rtljs.includes('el.style.setProperty("line-height", want, "important")'));

  /* The panel used to open on widget mouseenter, so merely passing the corner popped
     it. Click is the only opening gesture; outside-click dismisses it, and a closed
     panel must leave the tab order through inert rather than opacity alone. */
  check("no hover gesture opens the panel", !rtljs.includes('"mouseenter"') && !rtljs.includes('"mouseover"'));
  check("trigger is an inline SVG icon, not a glyph", rtljs.includes('createElementNS(NS, "svg")') && rtljs.includes('el("button", "qrt-trigger")') && !rtljs.includes('"qrt-trigger", "ا"'));
  check("open state is exposed to assistive tech", /triggerEl.setAttribute\("aria-expanded"/.test(rtljs) && rtljs.includes("panelEl.inert = !v"));
  check("outside click closes and is disposed", /addEventListener\("pointerdown", onDocDown, true\)/.test(rtljs) && /removeEventListener\("pointerdown", onDocDown, true\)/.test(rtljs));
  check("trigger grows to 34px with a focus-visible ring", rtljs.includes(".qrt-trigger{width:34px;height:34px") && rtljs.includes(".qrt-trigger:focus-visible"));
  check("dispose removes every inline leading stamp", /function clearLeading\([\s\S]*?\}\s*function applyConfig/.test(rtljs) && /function dispose\([\s\S]*clearLeading\(\)/.test(rtljs));

  check("font is registered through the FontFace API", src.includes("new FontFace(") && src.includes("document.fonts.add("));
  /* Re-running the injector on a live window must upgrade the sheet it already
     carries — skipping because "a marked style exists" keeps the old rules winning. */
  check("re-injection rewrites the inline sheet instead of skipping it", src.includes("if (existing.textContent !== CSS) existing.textContent = CSS;"));
  check("font bytes ride along exactly once", src.split(fontBase64()).length === 2);
  check("font fallback builds its data: URI at runtime", src.includes("data-qoder-rtl-font") && src.includes("base64,' + B64 + '"));

  for (const [name, code] of [
    ["runtime source", src],
    ["probe source", probe],
    ["controls source", controlsProbeSource()],
    ["diagnose source", diagnose]
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
     start the payload may only touch documentElement and register listeners.
     Deliberately no FontFace/atob here: it proves the CSS fallback path works. */
  const sandbox = {
    document: {
      readyState: "loading",
      documentElement: {
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        attributes: [],
        setAttribute() {},
        getAttribute: () => null,
        hasAttribute: () => false,
        removeAttribute() {},
        appendChild() {}
      },
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
  check(
    "font prelude falls back to a runtime @font-face without FontFace",
    sandbox.window.__QRT_FONT__ && sandbox.window.__QRT_FONT__.status === "css-fallback",
    JSON.stringify(sandbox.window.__QRT_FONT__ || null)
  );
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
