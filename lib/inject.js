"use strict";

const MARKER = "QODER_PERSIAN_RTL_V1";

/* Names inside the archive. Browser URLs are always slash-separated, but
   archive lookups go through path.sep, because @electron/asar 4.x splits on the
   native separator and an "a/b/c" string silently misses on Windows. */
const JS_NAME = "qoder-rtl.js";
const CSS_NAME = "qoder-rtl.css";
const FONT_NAME = "qoder-rtl-vazirmatn.woff2";

/* What goes where: archive path relative to the renderer folder -> file in this
   repo. All three land next to index.html, so the stylesheet's url("./font")
   resolves in its own directory and never collides with the app's hashed
   assets/ folder. */
const PAYLOADS = [
  { in: JS_NAME, from: "patches/rtl.js" },
  { in: CSS_NAME, from: "patches/rtl.css" },
  { in: FONT_NAME, from: "assets/vazirmatn-variable.woff2" }
];

/* Qoder's CSP is  script-src 'self'  /  style-src 'self' 'unsafe-inline',
   so both files must be same-origin <link>/<script src> tags, never inline. */
function block() {
  return [
    `    <!-- ${MARKER} : Persian/Arabic RTL + Vazirmatn, added by qoder-persian-rtl -->`,
    `    <link rel="stylesheet" href="./${CSS_NAME}" data-qoder-rtl="1" />`,
    `    <script src="./${JS_NAME}" defer data-qoder-rtl="1"></script>`,
    `    <!-- /${MARKER} -->`
  ].join("\n");
}

function strip(html) {
  return html.replace(new RegExp(`[ \\t]*<!--[ \\t]*${MARKER}[\\s\\S]*?<!--[ \\t]*/${MARKER}[ \\t]*-->[ \\t]*\\r?\\n?`, "g"), "");
}

/* Pinning the document to ltr keeps the app chrome exactly as shipped — the
   payload only mirrors content inside the chat surface. */
function injectIntoHtml(html) {
  const cleaned = strip(html);
  if (!/<html[^>]*>/.test(cleaned)) throw new Error("Malformed renderer index.html: no <html> tag");
  let out = cleaned.replace(/<html([^>]*)>/, (m, attrs) => {
    if (/\bdir\s*=/.test(attrs)) return m.replace(/\bdir\s*=\s*("[^"]*"|'[^']*')/, 'dir="ltr"');
    return `<html${attrs} dir="ltr">`;
  });

  const headClose = out.lastIndexOf("</head>");
  if (headClose === -1) throw new Error("Malformed renderer index.html: no </head>");
  out = out.slice(0, headClose) + block() + "\n  " + out.slice(headClose);
  return out;
}

function isPatched(html) {
  return html.includes(MARKER);
}

module.exports = { MARKER, JS_NAME, CSS_NAME, FONT_NAME, PAYLOADS, injectIntoHtml, strip, isPatched, block };
