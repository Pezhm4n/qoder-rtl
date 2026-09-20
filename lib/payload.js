"use strict";

/* Builds the single JavaScript source that is handed to CDP. The archive route
   ships rtl.css as a <link> and the font as a file; over CDP nothing can be
   written to disk, so the stylesheet becomes an inline <style> and the font is
   inlined as a data: URI (the app's CSP allows font-src 'self' data:). */

const fs = require("node:fs");
const path = require("node:path");
const { FONT_NAME } = require("./inject");

const ROOT = path.join(__dirname, "..");

function fontDataUri() {
  const buf = fs.readFileSync(path.join(ROOT, "assets", "vazirmatn-variable.woff2"));
  return `data:font/woff2;base64,${buf.toString("base64")}`;
}

/* Rewrites every ./<font> reference in the stylesheet, wherever the patcher
   happens to place the file on disk, so one CSS source serves both routes. */
function inlineStylesheet() {
  const css = fs.readFileSync(path.join(ROOT, "patches", "rtl.css"), "utf8");
  const uri = fontDataUri();
  const pattern = new RegExp(`url\\(\\s*["']?[^"']*?${FONT_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*\\)`, "g");
  const out = css.replace(pattern, `url("${uri}")`);
  if (!out.includes("data:font/woff2")) throw new Error(`Could not inline the font: no url() to ${FONT_NAME} found in patches/rtl.css`);
  return out;
}

function cssPrelude() {
  const css = inlineStylesheet();
  return `(function () {
  var MARK = "data-qoder-rtl";
  var CSS = ${JSON.stringify(css)};
  function install() {
    if (document.querySelector("style[" + MARK + "]")) return;
    var root = document.head || document.documentElement;
    if (!root) return;
    var el = document.createElement("style");
    el.setAttribute(MARK, "1");
    el.textContent = CSS;
    root.appendChild(el);
  }
  install();
  document.addEventListener("DOMContentLoaded", install, { once: true });
})();`;
}

function runtimeSource() {
  const body = fs.readFileSync(path.join(ROOT, "patches", "rtl.js"), "utf8");
  return `${cssPrelude()}\n;${body}\n`;
}

/* Self-reporting probe: run inside the page to prove the payload landed and
   that Qoder's real DOM hooks are visible to it. */
function probeSource() {
  return `(function () {
  var count = function (sel) { try { return document.querySelectorAll(sel).length; } catch (e) { return -1; } };
  var rtl = window.__QODER_RTL__ || null;
  var fontReady = null;
  try { fontReady = document.fonts ? document.fonts.check('16px "Vazirmatn QRT"') : null; } catch (e) {}
  return JSON.stringify({
    url: String(location.href).slice(0, 160),
    rtlVersion: rtl ? rtl.version : null,
    config: rtl && rtl.config ? Object.keys(rtl.config).length : 0,
    styleTag: !!document.querySelector("style[data-qoder-rtl]"),
    font: fontReady,
    hooks: {
      turn: count("[data-chat-turn]"),
      messageText: count("[data-chat-message-text]"),
      composer: count("[data-chat-composer]"),
      region: count("[data-chat-session-region]"),
      viewport: count("[data-chat-session-conversation-viewport]"),
      markdown: count(".markdown-body")
    },
    applied: {
      htmlClasses: (document.documentElement.className || "").split(/\\s+/).filter(function (c) { return /^qrt-/.test(c); }).join(" "),
      faBlocks: count(".qrt-fa"),
      enBlocks: count(".qrt-en"),
      vars: count("style#qoder-rtl-vars"),
      panel: count(".qrt-panel,.qrt-trigger")
    }
  });
})()`;
}

module.exports = { runtimeSource, probeSource, inlineStylesheet, fontDataUri };
