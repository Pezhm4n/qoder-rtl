/* qoder-persian-rtl :: runtime payload (same-origin classic script, CSP script-src 'self') */
(function () {
  "use strict";

  var VERSION = "1.1.0";
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
  var CODE_ANCHOR = "pre,code,kbd,samp,var,textarea,input,.monaco-editor,.cm-editor,.xterm,[data-code-editor]";
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
    "[data-chat-message-text] dt"
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
    cfg = Object.assign({}, defaults);
  }

  function quoted(name) {
    return '"' + String(name).replace(/"/g, "").trim() + '"';
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
    var fa = (text.match(FA_RE) || []).length;
    if (!fa) return false;
    var en = (text.match(LATIN_RE) || []).length;
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

  function setFlag(root, name, on) {
    if (on) {
      if (!root.hasAttribute(name)) root.setAttribute(name, "1");
    } else if (root.hasAttribute(name)) {
      root.removeAttribute(name);
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
    var codeFont = cfg.codeFont
      ? quoted(cfg.codeFont) + ',ui-monospace,"Cascadia Mono",Consolas,monospace'
      : 'ui-monospace,"Cascadia Mono",Consolas,monospace';

    style.textContent =
      ":root{" +
      "--qrt-code:" + codeFont + ";" +
      "--qrt-chat-size:" + (Number(cfg.chatSize) || 0) + "px;" +
      "--qrt-code-scale:" + (1 + (Number(cfg.codeSize) || 0) / 16).toFixed(3) + ";" +
      "--qrt-leading:" + (Number(cfg.lineHeight) || 1.75) + ";" +
      "--qrt-stack:" + fontStack('"Segoe UI",Tahoma,"Iranian Sans",sans-serif') + ";" +
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

  /* ---------------------------------------------------------------- bidi walk */

  var pending = false;

  function ownText(el) {
    var buf = "";
    for (var c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) buf += c.data;
      else if (c.nodeType === 1 && !/^(P|UL|OL|TABLE|PRE|DIV|SECTION)$/.test(c.tagName)) buf += c.textContent || "";
    }
    return buf || el.textContent || "";
  }

  function markBlocks() {
    if (!document.body || (cfg.mode !== "smart" && cfg.mode !== "force")) return;
    var nodes = document.body.querySelectorAll(BLOCK_SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.closest && el.closest(CODE_ANCHOR)) continue;
      var own = ownText(el);
      var want = cfg.mode === "force" ? true : isFa(own);
      if (want && !el.classList.contains("qrt-fa")) {
        el.classList.add("qrt-fa");
        el.classList.remove("qrt-en");
      } else if (!want && el.classList.contains("qrt-fa")) {
        el.classList.remove("qrt-fa");
        el.classList.add("qrt-en");
      }
    }
  }

  function scheduleMark() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      try {
        markBlocks();
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
    if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.code !== "KeyR") return;
    var t = ev.target;
    if (t && t.closest && t.closest(".qrt-widget")) return;
    ev.preventDefault();
    /* Alt+Shift+R brings the widget back after "پنهان کردن پنل", which otherwise
       is only stored in localStorage and unreachable from the UI. */
    if (ev.shiftKey) {
      cfg.panel = !cfg.panel;
    } else {
      cfg.rtl = !cfg.rtl;
      if (cfg.rtl && cfg.mode === "off") cfg.mode = "smart";
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

  /* ------------------------------------------------------------- settings UI */

  var els = {};
  var shell = null;
  var open = false;
  var hoverLock = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function setOpen(v) {
    open = v;
    if (shell) shell.classList.toggle("qrt-open", v);
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
      cfg[key] = i.checked;
      if (key === "rtl" && !i.checked) cfg.mode = "off";
      save();
      applyConfig();
      markBlocks();
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
      if (key === "mode" && s.value !== "off") cfg.rtl = true;
      save();
      applyConfig();
      markBlocks();
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
      if (node.type === "checkbox") node.checked = !!cfg[key];
      else if (node.type === "range") {
        node.value = cfg[key];
        if (els[key + "_out"]) els[key + "_out"].textContent = cfg[key];
      } else if (node.tagName === "SELECT" || node.type === "text") node.value = cfg[key];
    }
  }

  function buildPanel() {
    var trigger = el("button", "qrt-trigger", "ا");
    trigger.type = "button";
    trigger.title = "تنظیمات فارسی / RTL — Alt+R برای جهت، Alt+Shift+R برای نمایش/پنهان‌کردن این پنل";
    trigger.addEventListener("click", function () {
      setOpen(!open);
    });

    var panel = el("div", "qrt-panel");
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

    var widget = el("div", "qrt-widget");
    widget.appendChild(trigger);
    widget.appendChild(panel);
    widget.addEventListener("mouseenter", function () {
      clearTimeout(hoverLock);
      hoverLock = setTimeout(function () {
        setOpen(true);
      }, 90);
    });
    widget.addEventListener("mouseleave", function () {
      clearTimeout(hoverLock);
      hoverLock = setTimeout(function () {
        setOpen(false);
      }, 260);
    });
    return widget;
  }

  function mount() {
    if (!document.body) return;
    if (!cfg.panel) {
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
    ".qrt-widget{position:fixed;top:46px;right:14px;z-index:2147483600;display:flex;flex-direction:column;",
    "align-items:flex-end;font-family:var(--qrt-stack);direction:rtl;}",
    ".qrt-trigger{width:26px;height:26px;border-radius:8px;border:1px solid rgba(127,127,127,.28);",
    "background:rgba(127,127,127,.12);color:inherit;font:600 13px/1 var(--qrt-stack);cursor:pointer;",
    "transition:background .16s ease;}",
    ".qrt-trigger:hover{background:rgba(127,127,127,.24);}",
    ".qrt-panel{width:268px;max-height:68vh;overflow:auto;margin-top:6px;padding:12px;border-radius:12px;",
    "border:1px solid rgba(127,127,127,.26);background:Canvas;color:CanvasText;box-shadow:0 14px 38px rgba(0,0,0,.32);",
    "opacity:0;transform:scale(.95) translateY(-6px);transform-origin:top right;pointer-events:none;",
    "transition:opacity .18s ease,transform .18s cubic-bezier(.16,1,.3,1);}",
    ".qrt-panel::before{content:'';position:absolute;top:-10px;left:0;right:0;height:10px;}",
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
    ".qrt-footbtn:hover{background:rgba(127,127,127,.16);}"
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
      if (rootStateDrifted()) applyConfig();
      if (cfg.panel && !shell) mount();
      scheduleMark();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    addDisposable(function () {
      observer.disconnect();
    });

    var tick = setInterval(function () {
      if (rootStateDrifted()) applyConfig();
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
      syncInputs();
    },
    dispose: dispose
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
