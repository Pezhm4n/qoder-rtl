/* qoder-persian-rtl :: runtime payload (same-origin classic script, CSP script-src 'self') */
(function () {
  "use strict";

  var VERSION = "1.8.8";
  /* Kept equal to package.json "repository" by a test in test/live.js; the payload has
     no require(), so the link the panel's star button opens lives here as a literal. */
  var REPO_URL = "https://github.com/Pezhm4n/qoder-rtl";
  var STORE_KEY = "qoder_persian_rtl_config_v1";
  if (typeof window === "undefined" || typeof document === "undefined") return;
  var previous = window.__QODER_RTL__;
  if (previous && previous.version === VERSION) return;
  /* A newer payload replacing an older one in a live document has to undo it
     first, or the panel and the keyboard handlers would be doubled. */
  if (previous && typeof previous.dispose === "function") {
    try {
      previous.dispose();
    } catch (e) {}
  }

  var teardown = [];
  function addDisposable(fn) {
    teardown.push(fn);
  }

  var FA_RE = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g;
  var LATIN_RE = /[A-Za-zÀ-ɏ]/g;
  /* Zero-width and bidi-format code points carry no language, but U+FEFF falls
     inside FA_RE (the Arabic presentation-forms ranges run up to it), so a couple
     of BOMs left by copy-pasted markdown used to outvote a Latin sentence. */
  var FORMAT_RE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
  var CODE_ANCHOR = "pre,code,kbd,samp,var,textarea,input,.monaco-editor,.cm-editor,.xterm,[data-code-editor]";
  /* The stylesheet forces these LTR and bidi-isolated, so their contents must not
     decide the direction of the prose around them. */
  var LTR_ONLY_TAGS = /^(CODE|KBD|SAMP|VAR|PRE)$/;
  var NESTED_BLOCK_TAGS = /^(P|UL|OL|TABLE|DIV|SECTION)$/;
  var BLOCK_SELECTOR = [
    "[data-chat-message-text] p",
    "[data-chat-message-text] li",
    "[data-chat-message-text] blockquote",
    "[data-chat-message-text] h1",
    "[data-chat-message-text] h2",
    "[data-chat-message-text] h3",
    "[data-chat-message-text] h4",
    "[data-chat-message-text] h5",
    "[data-chat-message-text] h6",
    "[data-chat-message-text] dd",
    "[data-chat-message-text] dt",
    /* A tag the base RTL rule pins has to be classifiable, or an English caption/summary
       sits right-aligned with no .qrt-en to hand it back — the tables cells are exempt
       because the tables switch, not the classifier, owns them. */
    "[data-chat-message-text] figcaption",
    "[data-chat-message-text] summary",
    /* The human turn is one `whitespace-pre-wrap` div with the text directly in it — no
       `<p>` for the descendant selectors above to find — so without this line your own
       message never got a verdict and sat under the app's LTR defaults while every reply
       was RTL. The base CSS rule pins that container too, and an RTL-pinned block that
       cannot be classified is exactly the 1.4.0 bug. */
    "[data-user-bubble] [data-chat-message-text]" /* the human turn: text on the container */,
    /* The composer's ghost placeholder is one string, so it gets one verdict like any other
       block: measured on the live window, the Latin «Continue this task…» sat right-aligned
       with its ellipsis on the wrong side. The *editor* is here too, and was not always: the
       first reason to exclude it — a block verdict flipping a Persian input over one Latin
       letter — is a property of the old first-letter rule, not of the ratio rule. Measured
       against the current classifier, "سلام x" stays RTL, a lone "a" stays LTR, and a pasted
       terminal log stays LTR. What a box verdict genuinely cannot do is give two lines of one
       input two different directions; wrapping each line in its own span was tried for that
       (payload 1.8.7) and broke Enter and the caret inside Qoder's live editor, so the box
       verdict is the shipped behaviour and the mixed-language draft aligns by majority.
       `textarea` is absent for a different reason: it is in CODE_ANCHOR, so markBlocks()
       skips it, and its text is `.value`. */
    "[data-chat-composer] [contenteditable]",
    "[data-chat-composer] [data-chat-composer-placeholder]",
    /* The agent's task-monitor / recap panel: Persian prose that lives outside every chat
       hook, is filled while a run is going on and collapses when it ends. */
    "[data-task-monitor-fixed-panel] p",
    "[data-task-monitor-fixed-panel] li",
    "[data-task-monitor-fixed-panel] blockquote",
    "[data-task-monitor-fixed-panel] h1",
    "[data-task-monitor-fixed-panel] h2",
    "[data-task-monitor-fixed-panel] h3",
    "[data-task-monitor-fixed-panel] h4",
    "[data-task-monitor-fixed-panel] h5",
    "[data-task-monitor-fixed-panel] h6",
    "[data-task-monitor-fixed-panel] dd",
    "[data-task-monitor-fixed-panel] dt",
    "[data-task-monitor-fixed-panel] figcaption",
    "[data-task-monitor-fixed-panel] summary"
  ].join(",");

  /* Body prose whose leading the panel controls. This list is the inline-stamping half of
     the CSS rule that ends in `line-height: var(--qrt-leading) !important` — the stamp is
     what beats Qoder's own `!important` pin, so any tag carried by that rule has to appear
     here too or it keeps the app's value while the rest of the message follows the slider.
     (Headings keep their own rhythm and are in neither list.) */
  var LEAD_SELECTOR = [
    "[data-chat-message-text] p",
    "[data-chat-message-text] li",
    "[data-chat-message-text] dd",
    "[data-chat-message-text] dt",
    "[data-chat-message-text] blockquote",
    "[data-chat-message-text] td",
    "[data-chat-message-text] th",
    "[data-chat-message-text] caption",
    "[data-chat-message-text] figcaption",
    "[data-chat-message-text] summary",
    "[data-user-bubble] [data-chat-message-text]",
    "[data-task-monitor-fixed-panel] p",
    "[data-task-monitor-fixed-panel] li",
    "[data-task-monitor-fixed-panel] dd",
    "[data-task-monitor-fixed-panel] dt",
    "[data-task-monitor-fixed-panel] blockquote",
    "[data-task-monitor-fixed-panel] figcaption",
    "[data-task-monitor-fixed-panel] summary",
    "[data-chat-composer] [contenteditable]",
    "[data-chat-composer] textarea",
    "[data-chat-composer] [data-chat-composer-placeholder]"
  ].join(",");

  var defaults = {
    rtl: true,
    mode: "smart", /* smart | force | off */
    tables: true,
    reverseColumns: false,
    fixAtSign: true,
    faFont: "Vazirmatn QRT",
    latinFont: "",
    codeFont: "",
    chatSize: 0,
    codeSize: 0,
    lineHeight: 1.75,
    panel: true
  };

  var cfg = load();

  function load() {
    var out = {};
    for (var k in defaults) out[k] = defaults[k];
    try {
      var raw = window.localStorage && window.localStorage.getItem(STORE_KEY);
      if (raw) {
        var saved = JSON.parse(raw) || {};
        for (var key in defaults) {
          if (Object.prototype.hasOwnProperty.call(saved, key) && typeof saved[key] === typeof defaults[key]) {
            out[key] = saved[key];
          }
        }
      }
    } catch (e) {}
    return out;
  }

  function save() {
    try {
      if (window.localStorage) window.localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
    } catch (e) {}
  }

  function reset() {
    /* Mutate in place instead of rebinding: window.__QODER_RTL__.config holds a
       reference to this object, so a rebind leaves the exported handle — and every
       probe that reads it — reporting the pre-reset values forever. */
    for (var k in defaults) cfg[k] = defaults[k];
  }

  function quoted(name) {
    /* A typed family name goes straight into a CSS string. Without the backslash,
       "Arial\" closes the declaration early and silently kills the whole stack. */
    return '"' + String(name).replace(/["\\\r\n]/g, "").trim() + '"';
  }

  function fontStack(base) {
    var parts = [];
    if (cfg.faFont) parts.push(quoted(cfg.faFont));
    if (cfg.latinFont) parts.push(quoted(cfg.latinFont));
    parts.push(base);
    return parts.join(",");
  }

  function isFa(text) {
    if (!text) return false;
    var t = text.replace(FORMAT_RE, " ");
    var fa = (t.match(FA_RE) || []).length;
    if (!fa) return false;
    var en = (t.match(LATIN_RE) || []).length;
    return fa >= 2 && fa > en * 0.5;
  }

  /* ------------------------------------------------------------------ apply */

  function rootFlags() {
    var on = !!cfg.rtl && cfg.mode !== "off";
    return {
      mode: on ? (cfg.mode === "force" ? "force" : "smart") : "off",
      tables: on && !!cfg.tables,
      reverse: on && !!cfg.reverseColumns
    };
  }

  /* rtl and mode==="off" describe the same fact twice, and the two UI paths that write
     them used to disagree: clearing the switch set mode to off, but switching it back
     on left mode off — so the main toggle read ON while nothing was right-aligned.
     Every path that turns direction on or off goes through here instead. */
  function setDirection(on) {
    cfg.rtl = on;
    if (!on) cfg.mode = "off";
    else if (cfg.mode === "off") cfg.mode = "smart";
  }

  function setFlag(root, name, on) {
    if (on) {
      if (!root.hasAttribute(name)) root.setAttribute(name, "1");
    } else if (root.hasAttribute(name)) {
      root.removeAttribute(name);
    }
  }

  /* Qoder's own chat font-size feature writes, per prose element,
     html[data-font-size="small"] [data-chat-session-conversation-viewport]
     [data-part-type="text"] .markdown-body p { line-height: 24px !important }
     — that outranks our rule and lands later in the cascade, so the only reliable
     way to make the leading setting stick is an inline !important declaration.
     Specificity would be an arms race with the next Qoder release; inline wins. */
  function applyLeading() {
    if (!document.body) return;
    /* Deliberately not gated on the direction switches: leading is typography, and the
       text size beside it already applies in every mode. Measured on the live app,
       gating it made the slider stop half-way through the prose — Qoder's 24px pin took
       the paragraphs back while list items kept ours, so one message showed two rhythms. */
    var want = String(Number(cfg.lineHeight) || 1.75);
    var nodes = document.body.querySelectorAll(LEAD_SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.getAttribute("data-qrt-lead") !== want) {
        el.style.setProperty("line-height", want, "important");
        el.setAttribute("data-qrt-lead", want);
      }
    }
  }

  function clearLeading() {
    var nodes = document.querySelectorAll("[data-qrt-lead]");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].style.removeProperty("line-height");
      nodes[i].removeAttribute("data-qrt-lead");
    }
  }

  function applyConfig() {
    var root = document.documentElement;
    var style = document.getElementById("qoder-rtl-vars");
    if (!style) {
      style = document.createElement("style");
      style.id = "qoder-rtl-vars";
      (document.head || root).appendChild(style);
    }
    /* "Vazirmatn QRT" goes last in both branches: a code font the user types has no
       Persian glyphs either, and a code block that mixes Latin and فارسی should fall
       through to the bundled face instead of the engine's random per-glyph fallback. */
    var codeFont = cfg.codeFont
      ? quoted(cfg.codeFont) + ',ui-monospace,"Cascadia Mono",Consolas,"Vazirmatn QRT",monospace'
      : 'ui-monospace,"Cascadia Mono",Consolas,"Vazirmatn QRT",monospace';

    /* Every declaration here is !important on purpose, and not for the usual reason.
       rtl.css also declares these properties on :root, with their defaults, so whichever
       of the two sheets sits later in <head> wins. That order is not stable: when the app
       drops only style[data-qoder-rtl], the repair re-appends it at the end of <head> —
       behind this node — and the defaults silently take over: the text-size zoom returns
       to 1 and a typed font family disappears, permanently, for the rest of the session.
       Measured on the fixture: {zoom:"1", face:"Vazirmatn QRT, Segoe …"} after one repair. */
    style.textContent =
      ":root{" +
      "--qrt-code:" + codeFont + " !important;" +
      "--qrt-zoom:" + (1 + (Number(cfg.chatSize) || 0) / 16).toFixed(4) + " !important;" +
      "--qrt-code-scale:" + (1 + (Number(cfg.codeSize) || 0) / 16).toFixed(3) + " !important;" +
      "--qrt-leading:" + (Number(cfg.lineHeight) || 1.75) + " !important;" +
      "--qrt-stack:" + fontStack('"Segoe UI",Tahoma,"Iranian Sans",sans-serif') + " !important;" +
      "}";

    var f = rootFlags();
    /* Attributes are the source of truth for the CSS; Qoder's renderer rewrites
       <html class="…">, so the mirrored classes below are debug output only. */
    if (root.getAttribute("data-qrt-mode") !== f.mode) root.setAttribute("data-qrt-mode", f.mode);
    setFlag(root, "data-qrt-tables", f.tables);
    setFlag(root, "data-qrt-reverse", f.reverse);
    root.classList.toggle("qrt-off", f.mode === "off");
    root.classList.toggle("qrt-smart", f.mode === "smart");
    root.classList.toggle("qrt-force", f.mode === "force");
    root.classList.toggle("qrt-tables", f.tables);
    root.classList.toggle("qrt-reverse", f.reverse);
    applyLeading();
  }

  /* Cheap drift check for the MutationObserver / safety-net interval. */
  function rootStateDrifted() {
    var root = document.documentElement;
    var f = rootFlags();
    return (
      root.getAttribute("data-qrt-mode") !== f.mode ||
      root.hasAttribute("data-qrt-tables") !== f.tables ||
      root.hasAttribute("data-qrt-reverse") !== f.reverse
    );
  }

  /* Root attributes are not the only thing the styles live on. If any injected <style>
     goes away — the app re-rendering <head>, an extension, anything — the CSS custom
     properties collapse with it: the font falls back to system-ui, zoom returns to 1 and
     the leading drops, while every root flag still reads correct. That failure is silent
     and permanent, because applyConfig() only ever ran when the root drifted.
     The main sheet is checked only when the prelude published its installer (the CDP
     route); the asar route loads it from a file and has no such node to lose. */
  function nodesDrifted() {
    if (!document.getElementById("qoder-rtl-vars") || !document.getElementById("qoder-rtl-panel-style")) return true;
    return typeof window.__QRT_CSS__ === "function" && !document.querySelector("style[data-qoder-rtl]");
  }

  function repair() {
    if (!rootStateDrifted() && !nodesDrifted()) return;
    if (typeof window.__QRT_CSS__ === "function" && !document.querySelector("style[data-qoder-rtl]")) window.__QRT_CSS__();
    ensurePanelStyle();
    applyConfig();
  }

  /* ---------------------------------------------------------------- bidi walk */

  var pending = false;

  function ownText(el) {
    var buf = "";
    var onlyIsolated = false;
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) buf += c.data;
      else if (c.nodeType !== 1) continue;
      else if (LTR_ONLY_TAGS.test(c.tagName)) onlyIsolated = true;
      else if (!NESTED_BLOCK_TAGS.test(c.tagName)) buf += c.textContent || "";
    }
    /* Inline code is pinned LTR by the stylesheet, so naming three identifiers used to
       outvote the Persian sentence around them and left-align it. When nothing is left
       to judge, an empty string means "not Persian" — which is right for a code-only
       block, and the textContent fallback keeps covering the odd wrapper element. */
    return buf || (onlyIsolated ? "" : el.textContent || "");
  }

  function markBlocks() {
    if (!document.body) return;
    /* Nothing reads .qrt-fa/.qrt-en while direction is off, so leaving the marks from
       the last active mode on the prose makes the debug mirror (and any probe that
       counts them) claim an RTL state the page does not show. */
    if (cfg.mode !== "smart" && cfg.mode !== "force") {
      clearMarks();
      return;
    }
    var nodes = document.body.querySelectorAll(BLOCK_SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.closest && el.closest(CODE_ANCHOR)) continue;
      var own = ownText(el);
      var want = cfg.mode === "force" ? true : isFa(own);
      /* Both classes are stamped every pass. Only adding qrt-fa meant a Latin block
         that had never been Persian carried no class at all, so it fell back to the
         base RTL rule and showed right-aligned English — measured in the browser test.
         classList.toggle with an explicit force does not touch an already-correct
         element, so re-running this on every frame costs nothing. */
      el.classList.toggle("qrt-fa", want);
      el.classList.toggle("qrt-en", !want);
    }
  }

  function clearMarks() {
    var nodes = document.querySelectorAll(".qrt-fa, .qrt-en");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.remove("qrt-fa");
      nodes[i].classList.remove("qrt-en");
    }
  }

  function scheduleMark() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      try {
        markBlocks();
        applyLeading();
      } catch (e) {}
    });
  }

  /* -------------------------------------------------------------- @ sign fix */

  function insertText(field, ch) {
    try {
      var start = field.selectionStart;
      var end = field.selectionEnd;
      if (typeof start === "number" && typeof field.setRangeText === "function") {
        field.setRangeText(ch, start, end, "end");
        field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
        return;
      }
    } catch (e) {}
    try {
      document.execCommand("insertText", false, ch);
    } catch (e) {}
  }

  function installAtFix() {
    var handler = function (ev) {
      if (!cfg.fixAtSign || ev.key !== "٬") return;
      var t = ev.target;
      if (!t || !t.closest || !t.closest("[data-chat-composer]")) return;
      ev.preventDefault();
      ev.stopPropagation();
      insertText(t, "@");
    };
    document.addEventListener("keydown", handler, true);
    addDisposable(function () {
      document.removeEventListener("keydown", handler, true);
    });
  }

  /* --------------------------------------------------------------- shortcuts */

  var onGlobalKey = function (ev) {
    /* Escape closes the panel the way every other popup in the app does, and hands
       focus back to the button it was opened from. It does not cancel the key: the
       app may own Escape too, and a popover disappearing is not a reason to swallow
       whatever the page wanted to do with it. */
    if (ev.key === "Escape" && open) {
      setOpen(false);
      if (triggerEl) triggerEl.focus();
      return;
    }
    if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.code !== "KeyR") return;
    var t = ev.target;
    if (t && t.closest && t.closest(".qrt-widget")) return;
    ev.preventDefault();
    /* Alt+Shift+R brings the widget back after "پنهان کردن پنل", which otherwise
       is only stored in localStorage and unreachable from the UI. */
    if (ev.shiftKey) {
      cfg.panel = !cfg.panel;
    } else {
      /* Toggle what the page actually shows, not the stored flag: with mode==="off"
         the patch is off whatever rtl says, and Alt+R had to be pressed twice. */
      setDirection(!(cfg.rtl && cfg.mode !== "off"));
      markBlocks();
    }
    save();
    applyConfig();
    mount();
    syncInputs();
  };
  document.addEventListener("keydown", onGlobalKey);
  addDisposable(function () {
    document.removeEventListener("keydown", onGlobalKey);
  });

  /* Qoder can keep more than one rendered window on the same origin, and localStorage
     is shared while each document keeps its own copy of cfg. Without this, moving a
     slider in one window left the other showing — and applying — the old settings. */
  var onStorage = function (ev) {
    if (ev && ev.key && ev.key !== STORE_KEY) return;
    var next = load();
    for (var k in next) cfg[k] = next[k];
    applyConfig();
    markBlocks();
    mount();
    syncInputs();
  };
  window.addEventListener("storage", onStorage);
  addDisposable(function () {
    window.removeEventListener("storage", onStorage);
  });

  /* ------------------------------------------------------------- settings UI */

  var els = {};
  var shell = null;
  var open = false;
  var triggerEl = null;
  var panelEl = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function setOpen(v) {
    open = v;
    if (shell) shell.classList.toggle("qrt-open", v);
    if (triggerEl) triggerEl.setAttribute("aria-expanded", v ? "true" : "false");
    /* opacity alone only hides the panel from the eye: its sliders would stay in the
       tab order and the a11y tree. inert takes them out until it is opened. */
    if (panelEl) panelEl.inert = !v;
  }

  function row(labelText, control) {
    var r = el("div", "qrt-row");
    r.appendChild(el("span", "qrt-label", labelText));
    var wrap = el("span", "qrt-ctrl");
    wrap.appendChild(control);
    r.appendChild(wrap);
    return r;
  }

  function toggle(key) {
    var i = document.createElement("input");
    i.type = "checkbox";
    i.className = "qrt-toggle";
    i.addEventListener("change", function () {
      if (key === "rtl") setDirection(i.checked);
      else cfg[key] = i.checked;
      save();
      applyConfig();
      markBlocks();
      /* setDirection can move `mode`, and the mode dropdown has to show that. */
      syncInputs();
    });
    els[key] = i;
    return i;
  }

  function slider(key, min, max, step) {
    var box = el("span", "qrt-slidebox");
    var out = el("span", "qrt-out", String(cfg[key]));
    var s = document.createElement("input");
    s.type = "range";
    s.className = "qrt-slider";
    s.min = min;
    s.max = max;
    s.step = step;
    s.addEventListener("input", function () {
      cfg[key] = Number(s.value);
      out.textContent = s.value;
      save();
      applyConfig();
    });
    box.appendChild(out);
    box.appendChild(s);
    els[key] = s;
    els[key + "_out"] = out;
    return box;
  }

  function select(key, options) {
    var s = document.createElement("select");
    s.className = "qrt-input";
    options.forEach(function (o) {
      var op = document.createElement("option");
      op.value = o[0];
      op.textContent = o[1];
      s.appendChild(op);
    });
    s.addEventListener("change", function () {
      cfg[key] = s.value;
      /* The switch and the dropdown are two names for one decision, so both are
         written together: picking خاموش clears the master switch too, otherwise the
         next click on it would resurrect a mode the user had just turned off. */
      if (key === "mode") setDirection(s.value !== "off");
      save();
      applyConfig();
      markBlocks();
      syncInputs();
    });
    els[key] = s;
    return s;
  }

  function textInput(key, placeholder) {
    var i = document.createElement("input");
    i.type = "text";
    i.className = "qrt-input";
    i.placeholder = placeholder;
    i.addEventListener("change", function () {
      cfg[key] = i.value.trim();
      save();
      applyConfig();
    });
    els[key] = i;
    return i;
  }

  function syncInputs() {
    for (var key in els) {
      var node = els[key];
      if (!node) continue;
      if (node.type === "checkbox") {
        /* The direction switch reports the effective state: rtl can still be true while
           the mode dropdown says off, and a switch reading ON over a page that is not
           right-aligned is the bug this hides. */
        node.checked = key === "rtl" ? !!cfg.rtl && cfg.mode !== "off" : !!cfg[key];
      } else if (node.type === "range") {
        node.value = cfg[key];
        if (els[key + "_out"]) els[key + "_out"].textContent = cfg[key];
      } else if (node.tagName === "SELECT" || node.type === "text") node.value = cfg[key];
    }
  }

  /* A right-aligned paragraph with a left-pointing arrow: the button controls text
     direction and typography, so it says that. Built with createElementNS because the
     payload creates every node through the DOM API and never parses markup. */
  var ICON_PATHS = ["M20 5H13", "M20 9.5H5", "M20 14h-8", "M20 19H7", "M10.5 16.5 7 19l3.5 2.5"];

  function triggerIcon() {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.9");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (var i = 0; i < ICON_PATHS.length; i++) {
      var path = document.createElementNS(NS, "path");
      path.setAttribute("d", ICON_PATHS[i]);
      svg.appendChild(path);
    }
    return svg;
  }

  /* Octicons' mark-glyph, inlined so the star row needs no network and no font. */
  var GITHUB_MARK =
    "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49" +
    "-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82" +
    ".72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59" +
    ".82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27" +
    "c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95" +
    ".29.25.54.73.51 1.36 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z";

  function githubMark() {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(NS, "path");
    path.setAttribute("fill-rule", "evenodd");
    path.setAttribute("d", GITHUB_MARK);
    svg.appendChild(path);
    return svg;
  }

  function buildPanel() {
    var trigger = el("button", "qrt-trigger");
    trigger.type = "button";
    trigger.appendChild(triggerIcon());
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-controls", "qoder-rtl-panel");
    trigger.title = "تنظیمات فارسی / RTL — Alt+R برای جهت، Alt+Shift+R برای نمایش/پنهان‌کردن این پنل";
    trigger.addEventListener("click", function () {
      setOpen(!open);
    });

    var panel = el("div", "qrt-panel");
    panel.id = "qoder-rtl-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "تنظیمات متن فارسی");
    panel.inert = true;
    panel.appendChild(el("div", "qrt-title", "تنظیمات متن فارسی"));
    panel.appendChild(row("راست‌چین فعال", toggle("rtl")));
    panel.appendChild(
      row(
        "حالت جهت",
        select("mode", [
          ["smart", "هوشمند (هر پاراگراف)"],
          ["force", "همیشه راست"],
          ["off", "خاموش"]
        ])
      )
    );
    panel.appendChild(row("RTL جدول‌ها", toggle("tables")));
    panel.appendChild(row("برعکس‌کردن ستون‌ها", toggle("reverseColumns")));
    panel.appendChild(row("اصلاح @ کیبورد فارسی", toggle("fixAtSign")));
    panel.appendChild(row("فونت فارسی", textInput("faFont", "وزیرمتن")));
    panel.appendChild(row("فونت لاتین", textInput("latinFont", "خالی = پیش‌فرض")));
    panel.appendChild(row("فونت کد", textInput("codeFont", "خالی = پیش‌فرض")));
    panel.appendChild(row("اندازهٔ متن چت", slider("chatSize", -2, 8, 1)));
    panel.appendChild(row("اندازهٔ فونت کد", slider("codeSize", -4, 8, 1)));
    panel.appendChild(row("فاصلهٔ خطوط", slider("lineHeight", 1.2, 2.4, 0.05)));

    var foot = el("div", "qrt-footer");
    var allReset = el("button", "qrt-footbtn", "بازگردانی همه");
    allReset.type = "button";
    allReset.addEventListener("click", function () {
      reset();
      save();
      applyConfig();
      syncInputs();
      markBlocks();
    });
    var hide = el("button", "qrt-footbtn", "پنهان کردن پنل");
    hide.type = "button";
    hide.addEventListener("click", function () {
      cfg.panel = false;
      save();
      applyConfig();
      mount();
    });
    foot.appendChild(allReset);
    foot.appendChild(hide);
    panel.appendChild(foot);

    /* A real anchor, not a click handler: keyboard focus, middle-click and the app's
       own external-link routing all come with it for free. */
    var star = document.createElement("a");
    star.className = "qrt-star";
    star.href = REPO_URL;
    star.target = "_blank";
    star.rel = "noopener noreferrer";
    star.appendChild(githubMark());
    star.appendChild(el("span", "qrt-starlabel", "Star on GitHub"));
    star.appendChild(el("span", "qrt-staricon", "★"));
    panel.appendChild(star);

    var widget = el("div", "qrt-widget");
    widget.appendChild(trigger);
    widget.appendChild(panel);
    triggerEl = trigger;
    panelEl = panel;
    /* Hover used to open this panel, which made it jump out at the cursor every time
       the mouse passed the corner without any click. Click is the only gesture now;
       dismissing by clicking anywhere else is what replaces moving the mouse away. */
    function onDocDown(ev) {
      if (!open) return;
      var t = ev.target;
      if (t && t.closest && t.closest(".qrt-widget")) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onDocDown, true);
    addDisposable(function () {
      document.removeEventListener("pointerdown", onDocDown, true);
    });
    return widget;
  }

  function mount() {
    if (!document.body) return;
    if (!cfg.panel) {
      /* The shell object survives hiding, so an open panel would otherwise come back
         already expanded — with its sliders live in the tab order — on the next show. */
      setOpen(false);
      if (shell && shell.parentNode) shell.parentNode.removeChild(shell);
      return;
    }
    if (!shell) shell = buildPanel();
    /* contains() rather than parentNode: the widget can sit in a subtree that the
       app detached from the document, where parentNode is still set. */
    if (!document.body.contains(shell)) document.body.appendChild(shell);
    syncInputs();
  }

  var panelCss = [
    /* Bottom-right, next to the composer, so the trigger is under the thumb and the
       panel grows upward instead of covering the answer being read. The widget stays
       direction:ltr on purpose: that makes align-items:flex-end mean the physical
       right edge; the RTL setting belongs to the panel's own text.
       right:52px clears Qoder's own help button — it is fixed at bottom-4.5/right-4.5
       and measures 28px, so it owns the last 46px of that corner; sitting on top of it
       (our z-index is maximal) would swallow its clicks.
       pointer-events:none on the widget itself is the same lesson one level up: the
       closed panel keeps its layout box (opacity hides, it does not remove), so the
       flex column spans the whole invisible panel, and a container that accepts
       pointer events would eat every click in that rectangle — the app behind it
       becomes unclickable while nothing is visibly there. Only the two real controls
       opt back in: the trigger always, the panel only while open. */
    ".qrt-widget{position:fixed;bottom:14px;right:52px;z-index:2147483600;display:flex;",
    "flex-direction:column-reverse;align-items:flex-end;font-family:var(--qrt-stack);pointer-events:none;}",
    ".qrt-trigger{width:34px;height:34px;border-radius:11px;display:flex;align-items:center;",
    "justify-content:center;padding:0;border:1px solid rgba(127,127,127,.3);background:Canvas;",
    "color:CanvasText;cursor:pointer;pointer-events:auto;box-shadow:0 4px 14px rgba(0,0,0,.26);",
    "transition:transform .14s ease,background-color .16s ease,color .16s ease,border-color .16s ease;}",
    /* A 1px lift, not a bounce: the animation has to match a 34px target. */
    ".qrt-trigger:hover{border-color:Highlight;color:Highlight;transform:translateY(-1px);}",
    ".qrt-trigger:active{transform:translateY(0);}",
    ".qrt-trigger[aria-expanded=true]{background:Highlight;border-color:Highlight;color:HighlightText;}",
    ".qrt-trigger:focus-visible{outline:2px solid Highlight;outline-offset:2px;}",
    ".qrt-trigger svg{display:block;width:20px;height:20px;}",
    ".qrt-panel{direction:rtl;width:268px;max-height:62vh;overflow:auto;margin-bottom:6px;padding:12px;",
    "border-radius:12px;border:1px solid rgba(127,127,127,.26);background:Canvas;color:CanvasText;",
    "box-shadow:0 -14px 38px rgba(0,0,0,.32);",
    "opacity:0;transform:scale(.95) translateY(6px);transform-origin:bottom right;pointer-events:none;",
    "transition:opacity .18s ease,transform .18s cubic-bezier(.16,1,.3,1);}",
    ".qrt-widget.qrt-open .qrt-panel{opacity:1;transform:none;pointer-events:auto;}",
    ".qrt-title{font-size:13px;font-weight:700;padding-bottom:8px;margin-bottom:6px;",
    "border-bottom:1px solid rgba(127,127,127,.22);}",
    ".qrt-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:7px 0;font-size:12px;}",
    ".qrt-label{flex:1 1 auto;opacity:.9;}",
    ".qrt-ctrl{display:flex;align-items:center;gap:6px;flex:0 0 auto;}",
    ".qrt-input{width:118px;font:500 11px/1.4 var(--qrt-stack);padding:3px 6px;border-radius:6px;",
    "border:1px solid rgba(127,127,127,.3);background:Field;color:FieldText;outline:none;}",
    ".qrt-input:focus{border-color:Highlight;}",
    ".qrt-slidebox{display:flex;align-items:center;gap:6px;}",
    ".qrt-slider{width:84px;accent-color:Highlight;}",
    ".qrt-out{min-width:26px;text-align:center;font-variant-numeric:tabular-nums;opacity:.7;}",
    ".qrt-toggle{appearance:none;width:34px;height:18px;border-radius:9px;background:rgba(127,127,127,.35);",
    "position:relative;cursor:pointer;outline:none;transition:background .18s ease;margin:0;}",
    ".qrt-toggle:checked{background:Highlight;}",
    ".qrt-toggle::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;",
    "background:Canvas;transition:transform .18s ease;}",
    ".qrt-toggle:checked::after{transform:translateX(16px);}",
    ".qrt-footer{display:flex;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid rgba(127,127,127,.22);}",
    ".qrt-footbtn{flex:1 1 auto;border:1px solid rgba(127,127,127,.26);background:rgba(127,127,127,.08);color:inherit;",
    "font:500 11px/1 var(--qrt-stack);padding:6px 8px;border-radius:8px;cursor:pointer;}",
    ".qrt-footbtn:hover{background:rgba(127,127,127,.16);}",
    /* The star row is the one deliberately branded pixel in the panel: an amber star on
       a warm tint, LTR so "Star on GitHub" reads as written inside the RTL panel.
       Sticky at the bottom of the scrollport because it is the last row: on a short
       window the panel scrolls and an ordinary last row sits below the fold, unseen
       and unclickable. The background is a tint layered over Canvas, not a translucent
       tint alone, so scrolled rows cannot show through the pinned row. */
    ".qrt-star{display:flex;align-items:center;justify-content:center;gap:7px;margin-top:10px;",
    "padding:7px 8px;border:1px solid rgba(227,160,8,.5);border-radius:9px;",
    "background:linear-gradient(rgba(227,160,8,.12),rgba(227,160,8,.12)) Canvas;",
    "color:inherit;text-decoration:none;direction:ltr;",
    "position:sticky;bottom:0;font:600 11px/1 var(--qrt-stack);",
    "transition:background-color .16s ease,border-color .16s ease,transform .14s ease;}",
    ".qrt-star:hover{background:linear-gradient(rgba(227,160,8,.24),rgba(227,160,8,.24)) Canvas;",
    "border-color:rgba(227,160,8,.8);transform:translateY(-1px);}",
    ".qrt-star:active{transform:translateY(0);}",
    ".qrt-star:focus-visible{outline:2px solid Highlight;outline-offset:2px;}",
    ".qrt-star svg{width:14px;height:14px;flex:0 0 auto;fill:currentColor;opacity:.8;}",
    ".qrt-staricon{color:#e3a008;font-size:13px;line-height:1;}"
  ].join("");

  /* --------------------------------------------------------------------- boot */

  function ensurePanelStyle() {
    if (document.getElementById("qoder-rtl-panel-style")) return;
    var st = document.createElement("style");
    st.id = "qoder-rtl-panel-style";
    st.textContent = panelCss;
    (document.head || document.documentElement).appendChild(st);
  }

  function boot() {
    ensurePanelStyle();
    applyConfig();
    installAtFix();
    mount();
    markBlocks();

    var observer = new MutationObserver(function () {
      repair();
      /* Same containment test the safety tick uses: the app can detach the subtree the
         widget hangs from while it re-renders a streaming reply, and waiting for the
         4s tick left the button gone for seconds in the middle of an answer. */
      if (cfg.panel && (!shell || !document.body.contains(shell))) mount();
      scheduleMark();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    addDisposable(function () {
      observer.disconnect();
    });

    var tick = setInterval(function () {
      repair();
      if (cfg.panel && (!shell || !document.body.contains(shell))) mount();
      scheduleMark();
    }, 4000);
    addDisposable(function () {
      clearInterval(tick);
    });
  }

  var disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (var i = 0; i < teardown.length; i++) {
      try {
        teardown[i]();
      } catch (e) {}
    }
    teardown.length = 0;
    if (shell && shell.parentNode) shell.parentNode.removeChild(shell);
    shell = null;
    try {
      clearLeading();
    } catch (e) {}
    var transient = ["qoder-rtl-vars", "qoder-rtl-panel-style"];
    for (var j = 0; j < transient.length; j++) {
      var node = document.getElementById(transient[j]);
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
  }

  window.__QODER_RTL__ = {
    version: VERSION,
    config: cfg,
    apply: function (patch) {
      for (var k in patch) cfg[k] = patch[k];
      save();
      applyConfig();
      markBlocks();
      /* mount(): panel is a setting like the others, and driving the runtime through
         apply() has to show or hide the widget the way the shortcut key does. */
      mount();
      syncInputs();
    },
    dispose: dispose
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
