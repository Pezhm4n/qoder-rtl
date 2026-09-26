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
    var root = document.head || document.documentElement;
    if (!root) return;
    var existing = document.querySelector("style[" + MARK + "]");
    if (existing) {
      /* Re-injection into a live document has to upgrade the sheet in place: an
         older payload's CSS would otherwise keep winning the rest of the session. */
      if (existing.textContent !== CSS) existing.textContent = CSS;
      return;
    }
    var el = document.createElement("style");
    el.setAttribute(MARK, "1");
    el.textContent = CSS;
    root.appendChild(el);
  }
  install();
  document.addEventListener("DOMContentLoaded", install, { once: true });
  /* The runtime's drift check re-runs this if the app ever drops the node: it is the
     only holder of the CSS text, so the payload itself stays free of a second copy. */
  window.__QRT_CSS__ = install;
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
  /* Qoder keeps its own floating buttons in the same bottom-right corner (a 28px
     help circle 18px from the edges). Our trigger has the maximal z-index, so an
     overlap would silently eat their clicks — measure the intersection instead of
     trusting an offset constant. */
  var cornerClash = function () {
    try {
      var t = document.querySelector(".qrt-widget .qrt-trigger");
      if (!t) return { n: -1 };
      var a = t.getBoundingClientRect();
      var seen = [];
      var nodes = document.querySelectorAll("body *");
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.closest(".qrt-widget")) continue;
        var cs = getComputedStyle(n);
        if (cs.position !== "fixed" && cs.position !== "sticky") continue;
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
        var b = n.getBoundingClientRect();
        if (b.width < 8 || b.height < 8) continue;
        if (b.right < a.left || b.left > a.right || b.bottom < a.top || b.top > a.bottom) continue;
        seen.push(String(n.className || "").trim().split(/\\s+/).slice(0, 4).join("."));
      }
      return { n: seen.length, what: seen.slice(0, 2).join(" | ") };
    } catch (e) { return { n: -1 }; }
  };
  /* Does the CSS chain actually reach the prose, or does Qoder's own utility
     class (text-sm / leading-6 on the <p> itself) win? Sample a real Persian
     block when one exists and compare its computed size and leading against the
     config the panel edits. */
  var prose = null;
  try {
    prose =
      document.querySelector("[data-chat-message-text] .qrt-fa") ||
      document.querySelector("[data-chat-message-text] p, [data-chat-message-text] li, [data-chat-message-text] h1, [data-chat-composer]");
  } catch (e) {}
  var text = null;
  if (prose) {
    try {
      var s = getComputedStyle(prose);
      var host = prose.closest("[data-chat-message-text]") || prose.closest("[data-chat-composer]");
      var hs = host ? getComputedStyle(host) : null;
      var px = function (v) { var n = parseFloat(v); return isFinite(n) ? n : null; };
      var size = px(s.fontSize), lead = px(s.lineHeight);
      text = {
        tag: String(prose.tagName).toLowerCase() + (prose.className ? "." + String(prose.className).trim().split(/\\s+/).slice(0, 4).join(".") : ""),
        fontFamily: String(s.fontFamily).slice(0, 60),
        fontSize: s.fontSize,
        lineHeight: s.lineHeight,
        ratio: size && lead ? Math.round((lead / size) * 1000) / 1000 : null,
        zoom: hs ? String(hs.zoom) : null
      };
    } catch (e) {}
  }
  /* The human turn hangs the same data-chat-message-text hook on the container that holds
     the text — Qoder gives your own message no <p> — so every assistant-side descendant
     rule misses it. null means this conversation has no user bubble rendered, which is a
     fact about the chat, not a verdict on the patch. */
  var userBubble = null;
  try {
    var ub = document.querySelector("[data-user-bubble] [data-chat-message-text]");
    if (ub) {
      var us = getComputedStyle(ub);
      var mark = /qrt-(?:fa|en)/.exec(String(ub.className || ""));
      /* Logical alignment resolved against this element's own direction: a "start" means
         right in an RTL box and left in an LTR one, and a verdict that reads the raw value
         cannot tell an intended side from a bug. */
      var align = String(us.textAlign);
      if (align === "start" || align === "end") {
        var startIsRight = us.direction === "rtl";
        align = (align === "start") === startIsRight ? "right" : "left";
      }
      userBubble = {
        direction: us.direction,
        textAlign: align,
        fontFamily: String(us.fontFamily).slice(0, 60),
        ratio: (function () {
          var sz = parseFloat(us.fontSize), lh = parseFloat(us.lineHeight);
          return sz && isFinite(lh) ? Math.round((lh / sz) * 1000) / 1000 : null;
        })(),
        stamp: ub.getAttribute("data-qrt-lead"),
        cls: mark ? mark[0] : null,
        /* If a future Qoder starts rendering bubbles as markdown, the premise of the
           bubble-only rules changes and this row's meaning changes with it. */
        hasParagraph: !!ub.querySelector("p")
      };
    }
  } catch (e) {}
  /* One reader for "does this surface follow the patch", so a new surface does not need a
     new copy of the alignment logic: logical alignment is resolved against the element's own
     direction, because a raw "start" means right in an RTL box and left in an LTR one. */
  function readSurface(el) {
    if (!el) return null;
    var s = getComputedStyle(el);
    var align = String(s.textAlign);
    if (align === "start" || align === "end") {
      var startIsRight = s.direction === "rtl";
      align = (align === "start") === startIsRight ? "right" : "left";
    }
    var mark = /qrt-(?:fa|en)/.exec(String(el.className || ""));
    var sz = parseFloat(s.fontSize), lh = parseFloat(s.lineHeight);
    return {
      direction: s.direction,
      textAlign: align,
      bidi: s.unicodeBidi,
      ratio: sz && isFinite(lh) ? Math.round((lh / sz) * 1000) / 1000 : null,
      stamp: el.getAttribute("data-qrt-lead"),
      cls: mark ? mark[0] : null,
      persian: /[؀-ۿ]/.test(String(el.textContent || ""))
    };
  }
  /* The two surfaces behind «RTL حین صحبت بهم ریخته است»: the agent's task-monitor panel,
     which lives outside every chat hook and is filled only while a run goes on, and the
     composer's ghost placeholder, which the stylesheet RTL-pins but nothing classified — so
     the Latin «Continue this task…» sat right-aligned with its ellipsis on the wrong side. */
  var monitor = readSurface(document.querySelector("[data-task-monitor-fixed-panel] :is(p, li, h1, h2, h3, blockquote)"));
  var ghost = readSurface(document.querySelector("[data-chat-composer] [data-chat-composer-placeholder]"));
  var editor = readSurface(document.querySelector("[data-chat-composer] [contenteditable]"));
  var codeIsland = null;
  try {
    var c = document.querySelector("[data-chat-message-text] :not(pre) > code");
    if (c) {
      var cb = c.getBoundingClientRect();
      var cs = getComputedStyle(c);
      codeIsland = { w: Math.round(cb.width * 100) / 100, h: Math.round(cb.height * 100) / 100, size: cs.fontSize, family: String(cs.fontFamily).slice(0, 40) };
    }
  } catch (e) {}
  return JSON.stringify({
    url: String(location.href).slice(0, 160),
    rtlVersion: rtl ? rtl.version : null,
    config: rtl && rtl.config ? Object.keys(rtl.config).length : 0,
    settings: rtl && rtl.config ? { lineHeight: rtl.config.lineHeight, chatSize: rtl.config.chatSize, codeSize: rtl.config.codeSize } : null,
    styleTag: !!document.querySelector("style[data-qoder-rtl]"),
    styleCount: count("style[data-qoder-rtl]"),
    styleBytes: (function () {
      try {
        var st = document.querySelector("style[data-qoder-rtl]");
        return st ? st.textContent.length : 0;
      } catch (e) { return 0; }
    })(),
    font: {
      registered: fontStatus ? fontStatus.status : null,
      route: fontStatus ? fontStatus.route : null,
      message: fontStatus ? fontStatus.message : null,
      usableByCss: fontCheck
    },
    hooks: {
      turn: count("[data-chat-turn]"),
      messageText: count("[data-chat-message-text]"),
      userBubble: count("[data-user-bubble] [data-chat-message-text]"),
      composer: count("[data-chat-composer]"),
      region: count("[data-chat-session-region]"),
      viewport: count("[data-chat-session-conversation-viewport]"),
      markdown: count(".markdown-body"),
      taskMonitor: count("[data-task-monitor-fixed-panel]")
    },
    applied: {
      mode: document.documentElement.getAttribute("data-qrt-mode"),
      htmlClasses: (document.documentElement.className || "").split(/\\s+/).filter(function (c) { return /^qrt-/.test(c); }).join(" "),
      faBlocks: count(".qrt-fa"),
      enBlocks: count(".qrt-en"),
      vars: count("style#qoder-rtl-vars"),
      textFont: text ? text.fontFamily : null,
      text: text,
      /* The human turn, measured rather than assumed: it is the one prose block Qoder
         does not render as markdown, and it used to be invisible to this probe. */
      userText: userBubble,
      userFa: count("[data-user-bubble] [data-chat-message-text].qrt-fa"),
      userEn: count("[data-user-bubble] [data-chat-message-text].qrt-en"),
      /* Surfaces outside the message list: the agent's task-monitor panel (null when that
         panel is closed, which is a fact about the window, not the patch) and the composer's
         two text layers. */
      monitorText: monitor,
      monitorFa: count("[data-task-monitor-fixed-panel] .qrt-fa"),
      monitorEn: count("[data-task-monitor-fixed-panel] .qrt-en"),
      composerGhost: ghost,
      composerEditor: editor,
      /* What the «اندازهٔ فونت کد» slider acts on: null means this conversation renders
         no inline code, which says nothing about whether the patch works. */
      code: codeIsland,
      panel: count(".qrt-widget"),
      /* Whether the widget is missing because the user hid it on purpose or because it
         never mounted: without the setting the verdict can only call every hidden
         panel a failure. */
      panelSetting: rtl && rtl.config ? rtl.config.panel !== false : null,
      panelVisible: widget ? widget.display !== "none" && widget.w > 0 : false,
      panelRect: widget ? widget.w + "x" + widget.h : null,
      panelAnchors: (function () {
        try {
          var w = document.querySelector(".qrt-widget");
          if (!w) return null;
          var b = w.getBoundingClientRect();
          /* Computed top/bottom would be the used values, so distance from the real
             window edges is what proves where the widget ended up. The measuring box is
             clientWidth/clientHeight, not innerWidth/innerHeight: a classic scrollbar sits
             *inside* innerWidth but outside the containing block of a position:fixed element,
             so on any page that scrolls this read the trigger as 15px further from the edge
             than it is (measured: rightGap 67 for a 52px inset). */
          var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
          return {
            flexDirection: getComputedStyle(w).flexDirection,
            bottomGap: Math.round(vh - b.bottom),
            rightGap: Math.round(vw - b.right),
            topGap: Math.round(b.top),
            cornerClash: cornerClash()
          };
        } catch (e) { return null; }
      })()
    }
  });
})()`;
}

/* Functional check of the three panel sliders that edit prose metrics: it drives
   the runtime through a temporary setting, measures the computed result on a real
   message, and puts the user's own config back — the same code path the panel
   uses, so "the slider does nothing" cannot pass here. */
function controlsProbeSource() {
  return `(function () {
  var api = window.__QODER_RTL__;
  if (!api || typeof api.apply !== "function") return JSON.stringify({ error: "no runtime" });
  var el = document.querySelector("[data-chat-message-text] .qrt-fa") ||
    document.querySelector("[data-chat-message-text] p, [data-chat-message-text] li, [data-chat-composer]");
  if (!el) return JSON.stringify({ error: "no prose element" });
  var host = el.closest("[data-chat-message-text]") || el.closest("[data-chat-composer]");
  /* The code-size slider acts on inline code only, so its own box is measured
     separately: a window with no inline code in it says nothing about that slider. */
  var code = document.querySelector("[data-chat-message-text] :not(pre) > code");
  var nums = function () {
    var s = getComputedStyle(el);
    var h = host ? getComputedStyle(host) : null;
    var f = function (v) { var n = parseFloat(v); return isFinite(n) ? n : 0; };
    var out = { fontSize: f(s.fontSize), lineHeightPx: f(s.lineHeight), zoom: h ? f(h.zoom) : 0 };
    if (code) {
      var b = code.getBoundingClientRect();
      out.code = { w: Math.round(b.width * 100) / 100, h: Math.round(b.height * 100) / 100, size: f(getComputedStyle(code).fontSize) };
    }
    return out;
  };
  var restore = { lineHeight: api.config.lineHeight, chatSize: api.config.chatSize, codeSize: api.config.codeSize };
  var before = nums();
  try {
    api.apply({ lineHeight: 2.15, chatSize: 6 });
    var after = nums();
    /* Drive the code slider from the user's own values, not on top of the chat-size
       probe above: chatSize scales the whole subtree through zoom, inline code
       included, so a code box measured there would grow even with a dead codeSize. */
    api.apply(restore);
    var codeBefore = nums();
    api.apply({ codeSize: 6 });
    var codeAfter = nums();
    api.apply(restore);
    return JSON.stringify({
      before: before,
      after: after,
      codeBefore: codeBefore,
      codeAfter: codeAfter,
      settled: nums(),
      probe: { lineHeight: 2.15, chatSize: 6, codeSize: 6 }
    });
  } catch (e) {
    try { api.apply(restore); } catch (e2) {}
    return JSON.stringify({ error: String((e && e.message) || e) });
  }
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
  var FONT = ["fontFamily", "fontSize", "lineHeight", "zoom", "direction", "unicodeBidi", "textAlign"];
  var container = q("[data-chat-message-text]");
  var para = q("[data-chat-message-text] .qrt-fa") || q("[data-chat-message-text] p") || q("[data-chat-message-text] *");
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
      /* Qoder pins prose leading with its own !important rule, so the runtime leaves
         an inline one behind; this is the stamp's visible trace. */
      paragraphLead: para
        ? {
            attr: para.getAttribute ? para.getAttribute("data-qrt-lead") : null,
            inline: para.style ? para.style.getPropertyValue("line-height") + (para.style.getPropertyPriority("line-height") === "important" ? " !important" : "") : null
          }
        : null,
      composer: cs(composer, FONT)
    },
    widget: widget
      ? {
          display: cs(widget, ["display", "position", "zIndex", "opacity", "visibility"]).display,
          position: cs(widget, ["position"]).position,
          zIndex: cs(widget, ["zIndex"]).zIndex,
          anchors: cs(widget, ["top", "bottom", "right", "flexDirection"]),
          viewport: { w: innerWidth, h: innerHeight },
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
  controlsProbeSource,
  diagnoseSource,
  inlineStylesheet,
  fontBase64,
  FONT_FAMILY: FAMILY
};
