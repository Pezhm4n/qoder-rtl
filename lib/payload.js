"use strict";

/* Builds the single JavaScript source that is handed to CDP. The archive route
   ships rtl.css as a <link> and the font as a file; over CDP nothing can be
   written to disk, so the stylesheet becomes an inline <style>.

   The font goes further: instead of a data: URL inside that stylesheet it is
   registered through the FontFace API from inlined bytes. A registered face
   needs no fetch, so no font-src policy can refuse it; the data: URL survives
   only as a fallback for engines without the API. */

const fs = require("node:fs");
const path = require("node:path");
const { FONT_NAME } = require("./inject");

const ROOT = path.join(__dirname, "..");
const FAMILY = "Vazirmatn QRT";

function fontBase64() {
  return fs.readFileSync(path.join(ROOT, "assets", "vazirmatn-variable.woff2")).toString("base64");
}

/* The archive-route @font-face is dropped: its url() points at a file that the
   CDP route never writes, and the face is registered by fontPrelude() instead. */
function inlineStylesheet() {
  const css = fs.readFileSync(path.join(ROOT, "patches", "rtl.css"), "utf8");
  const fontFace = /@font-face\s*\{[^}]*\}/g;
  const out = css.replace(fontFace, (block) => (block.includes(FONT_NAME) ? "" : block));
  if (out.includes(FONT_NAME)) throw new Error(`Could not strip the file-based @font-face: ${FONT_NAME} is still referenced`);
  if (/url\(\s*["']?\.\//.test(out)) throw new Error("Inline stylesheet still references a relative file URL");
  if (!out.includes(FAMILY)) throw new Error(`Inline stylesheet no longer mentions the ${FAMILY} family`);
  return out;
}

function fontPrelude() {
  const b64 = fontBase64();
  return `(function () {
  var FAMILY = ${JSON.stringify(FAMILY)};
  var B64 = ${JSON.stringify(b64)};
  if (window.__QRT_FONT__) return;
  window.__QRT_FONT__ = { status: "pending", route: "fontface", message: "" };

  function report(status, route, message) {
    window.__QRT_FONT__ = { status: status, route: route, message: String(message || ""), at: new Date().toISOString() };
  }

  function bytes() {
    var bin = atob(B64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* Only used if the FontFace route is unavailable: still one copy of the bytes,
     because the rule is assembled here rather than carried in the stylesheet. */
  function cssFallback() {
    if (document.querySelector("style[data-qoder-rtl-font]")) return;
    var host = document.head || document.documentElement;
    if (!host) return;
    var el = document.createElement("style");
    el.setAttribute("data-qoder-rtl-font", "1");
    el.textContent = '@font-face{font-family:"' + FAMILY + '";src:url(data:font/woff2;base64,' + B64 + ') format("woff2");font-weight:100 900;font-style:normal;font-display:swap;}';
    host.appendChild(el);
  }

  try {
    if (typeof FontFace !== "function" || !document.fonts || typeof document.fonts.add !== "function") {
      throw new Error("no FontFace API");
    }
    var face = new FontFace(FAMILY, bytes(), { weight: "100 900", style: "normal", display: "swap" });
    document.fonts.add(face);
    report("added", "fontface", "");
    var loading = face.load && face.load();
    if (loading && typeof loading.then === "function") {
      loading.then(
        function () {
          report("loaded", "fontface", face.status);
        },
        function (e) {
          cssFallback();
          report("css-fallback", "css", e && e.message);
        }
      );
    }
  } catch (e) {
    cssFallback();
    report("css-fallback", "css", e && e.message);
  }
})();`;
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
  return `${fontPrelude()}\n;${cssPrelude()}\n;${body}\n`;
}

/* Self-reporting probe: run inside the page to prove the payload landed and
   that Qoder's real DOM hooks are visible to it. */
function probeSource() {
  return `(function () {
  var count = function (sel) { try { return document.querySelectorAll(sel).length; } catch (e) { return -1; } };
  var rtl = window.__QODER_RTL__ || null;
  var fontStatus = window.__QRT_FONT__ || null;
  var fontCheck = null;
  try { fontCheck = document.fonts ? document.fonts.check('16px "Vazirmatn QRT"') : null; } catch (e) { fontCheck = String(e && e.message); }
  var widget = null;
  try {
    var w = document.querySelector(".qrt-widget");
    if (w) { var b = w.getBoundingClientRect(); widget = { display: getComputedStyle(w).display, w: Math.round(b.width), h: Math.round(b.height) }; }
  } catch (e) {}
  /* Does the CSS chain actually reach the prose, or does Qoder's own rule win? */
  var textFont = null;
  try {
    var prose = document.querySelector("[data-chat-message-text] p, [data-chat-message-text] li, [data-chat-message-text] h1, [data-chat-composer]");
    if (prose) textFont = String(getComputedStyle(prose).fontFamily).slice(0, 60);
  } catch (e) {}
  return JSON.stringify({
    url: String(location.href).slice(0, 160),
    rtlVersion: rtl ? rtl.version : null,
    config: rtl && rtl.config ? Object.keys(rtl.config).length : 0,
    styleTag: !!document.querySelector("style[data-qoder-rtl]"),
    font: {
      registered: fontStatus ? fontStatus.status : null,
      route: fontStatus ? fontStatus.route : null,
      message: fontStatus ? fontStatus.message : null,
      usableByCss: fontCheck
    },
    hooks: {
      turn: count("[data-chat-turn]"),
      messageText: count("[data-chat-message-text]"),
      composer: count("[data-chat-composer]"),
      region: count("[data-chat-session-region]"),
      viewport: count("[data-chat-session-conversation-viewport]"),
      markdown: count(".markdown-body")
    },
    applied: {
      mode: document.documentElement.getAttribute("data-qrt-mode"),
      htmlClasses: (document.documentElement.className || "").split(/\\s+/).filter(function (c) { return /^qrt-/.test(c); }).join(" "),
      faBlocks: count(".qrt-fa"),
      enBlocks: count(".qrt-en"),
      vars: count("style#qoder-rtl-vars"),
      textFont: textFont,
      panel: count(".qrt-widget"),
      panelVisible: widget ? widget.display !== "none" && widget.w > 0 : false,
      panelRect: widget ? widget.w + "x" + widget.h : null
    }
  });
})()`;
}

/* Read-only inspection of a live window: answers "did the payload land, and why
   isn't the visible result what the CSS promises" without changing anything. */
function diagnoseSource() {
  return `(function () {
  var q = function (sel, root) { try { return (root || document).querySelector(sel) || null; } catch (e) { return null; } };
  var n = function (sel) { try { return document.querySelectorAll(sel).length; } catch (e) { return -1; } };
  var cs = function (el, props) {
    if (!el) return null;
    var s = getComputedStyle(el), out = {};
    for (var i = 0; i < props.length; i++) out[props[i]] = s[props[i]];
    return out;
  };
  var FONT = ["fontFamily", "fontSize", "direction", "unicodeBidi", "textAlign"];
  var container = q("[data-chat-message-text]");
  var para = q("[data-chat-message-text] p") || q("[data-chat-message-text] *");
  var composer = q("[data-chat-composer]");
  var widget = q(".qrt-widget");
  var faces = [];
  try {
    document.fonts.forEach(function (f) {
      if (/Vazirmatn|QRT/i.test(f.family || "")) faces.push({ family: String(f.family), status: f.status, weight: String(f.weight) });
    });
  } catch (e) { faces.push({ error: String(e && e.message) }); }
  /* force the face to be requested so check() below is meaningful */
  try { document.fonts.load('16px "Vazirmatn QRT"', "نمونه فارسی"); } catch (e) {}
  var styleTags = [];
  try {
    var list = document.querySelectorAll("style");
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t.textContent.indexOf("qrt") !== -1 || t.id.indexOf("qoder-rtl") !== -1 || t.getAttribute("data-qoder-rtl"))
        styleTags.push({ id: t.id, attr: t.getAttribute("data-qoder-rtl"), fontAttr: t.getAttribute("data-qoder-rtl-font"), bytes: t.textContent.length });
    }
  } catch (e) {}
  var chain = [];
  try {
    var el = widget;
    while (el && el !== document.documentElement) {
      var st = getComputedStyle(el);
      var odd = [];
      if (st.transform && st.transform !== "none") odd.push("transform:" + st.transform.slice(0, 30));
      if (st.filter && st.filter !== "none") odd.push("filter:" + st.filter.slice(0, 30));
      if (st.position === "fixed" && el !== widget) odd.push("position:fixed");
      if (odd.length) chain.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), why: odd.join(" ") });
      el = el.parentElement;
    }
  } catch (e) {}
  var r = null;
  try { if (widget) { var b = widget.getBoundingClientRect(); r = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; } } catch (e) {}
  return JSON.stringify({
    url: String(location.href).slice(0, 160),
    isTop: window.top === window,
    iframes: (function () {
      var out = [], f = document.querySelectorAll("iframe,webview");
      for (var i = 0; i < f.length && i < 8; i++) {
        var src = f[i].getAttribute("src") || "";
        out.push({ tag: f[i].tagName, src: src.slice(0, 90), accessible: (function () { try { return !!f[i].contentDocument; } catch (e) { return false; } })() });
      }
      return out;
    })(),
    csp: (function () {
      var out = [];
      try {
        var metas = document.querySelectorAll("meta[http-equiv]");
        for (var i = 0; i < metas.length; i++) {
          if (String(metas[i].getAttribute("http-equiv")).toLowerCase().indexOf("content-security") === 0)
            out.push(String(metas[i].getAttribute("content")).slice(0, 400));
        }
      } catch (e) {}
      return out;
    })(),
    counts: { messageText: n("[data-chat-message-text]"), composer: n("[data-chat-composer]"), turn: n("[data-chat-turn]"), markdown: n(".markdown-body"), fa: n(".qrt-fa"), en: n(".qrt-en") },
    rtl: {
      version: (window.__QODER_RTL__ || {}).version || null,
      config: (window.__QODER_RTL__ || {}).config || null,
      htmlClass: document.documentElement.getAttribute("class"),
      rootAttrs: (function () {
        var out = {};
        try {
          var a = document.documentElement.attributes;
          for (var i = 0; i < a.length; i++) if (a[i].name.indexOf("data-qrt") === 0) out[a[i].name] = a[i].value;
        } catch (e) {}
        return out;
      })()
    },
    font: {
      prelude: window.__QRT_FONT__ || null,
      faces: faces,
      check16: (function () { try { return document.fonts.check('16px "Vazirmatn QRT"'); } catch (e) { return String(e.message); } })()
    },
    styles: styleTags,
    computed: {
      container: cs(container, FONT),
      paragraph: cs(para, FONT),
      paragraphTag: para ? para.tagName + "." + String(para.className).slice(0, 50) : null,
      composer: cs(composer, FONT)
    },
    widget: widget
      ? {
          display: cs(widget, ["display", "position", "zIndex", "opacity", "visibility"]).display,
          position: cs(widget, ["position"]).position,
          zIndex: cs(widget, ["zIndex"]).zIndex,
          rect: r,
          children: { trigger: n(".qrt-trigger"), panel: n(".qrt-panel") },
          openClass: !!q(".qrt-widget.qrt-open"),
          stackingAncestors: chain
        }
      : null,
    body: {
      childCount: document.body ? document.body.children.length : -1,
      lastChild: document.body && document.body.lastElementChild ? document.body.lastElementChild.tagName + "." + String(document.body.lastElementChild.className).slice(0, 40) : null
    }
  });
})()`;
}

module.exports = {
  runtimeSource,
  probeSource,
  diagnoseSource,
  inlineStylesheet,
  fontBase64,
  FONT_FAMILY: FAMILY
};
