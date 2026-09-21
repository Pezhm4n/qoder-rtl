"use strict";

/*
 * Integration test for the CDP side-loader against a real Chromium, so the
 * protocol plumbing and the payload can be proven without touching Qoder:
 *
 *   node test/browser.js [--port 9333]
 *
 * It starts a headless Edge/Chrome on a throwaway profile with a fixture page
 * that imitates Qoder's chat DOM, runs `node live.js --check` against it, and
 * asserts the verdict. Only the browser this test spawns is ever killed.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { Connection, browserEndpoint, portIsOpen } = require("../lib/cdp");

const ROOT = path.join(__dirname, "..");
const argvPort = process.argv.indexOf("--port");
const PORT = argvPort === -1 ? 9333 : Number(process.argv[argvPort + 1]) || 9333;
const PROFILE = path.join(os.tmpdir(), `qrt-browser-profile-${process.pid}`);
const FIXTURE = path.join(__dirname, "fixtures", "chat.html");

let failures = 0;
function check(name, cond, extra) {
  if (cond === true) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
}

function findChromium() {
  const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
  const pf86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  return [
    path.join(local, "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
    path.join(pf, "Google\\Chrome\\Application\\chrome.exe"),
    path.join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium"
  ].find((p) => p && fs.existsSync(p));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startBrowser(exe) {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const child = spawn(
    exe,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--disable-gpu",
      "--no-first-run",
      "--window-size=900,700",
      `file:///${FIXTURE.replace(/\\/g, "/")}`
    ],
    { detached: process.platform === "win32", stdio: "ignore" }
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await portIsOpen(PORT)) return child;
    await sleep(500);
  }
  /* Kill it before giving up. This process is what holds the port, so a run that
     leaves it behind makes every later run fail on an occupied port — and report it as
     "nothing listened", which points at the opposite problem. */
  killBrowser(child.pid);
  return null;
}

/* Real input events, not a source grep: the panel used to open by itself when the
   mouse only passed the corner, so the honest proof that this is gone is moving a
   pointer there and reading the state back — then opening and dismissing it by click. */
async function interactionTest() {
  const STATE = `(function () {
    var w = document.querySelector(".qrt-widget"), t = document.querySelector(".qrt-trigger"), p = document.querySelector(".qrt-panel");
    if (!w || !t || !p) return JSON.stringify({ missing: true });
    var r = t.getBoundingClientRect();
    return JSON.stringify({
      open: w.classList.contains("qrt-open"),
      aria: t.getAttribute("aria-expanded"),
      inert: !!p.inert,
      onTrigger: document.activeElement === t,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2)
    });
  })()`;
  let conn;
  try {
    conn = await Connection.open(await browserEndpoint(PORT));
    const target = (await conn.send("Target.getTargets")).targetInfos.find((t) => t.type === "page" && /chat\.html$/.test(t.url));
    if (!target) return check("settings button interaction test", false, "fixture target not found");
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    await conn.send("Runtime.enable", {}, sessionId);
    const evalJson = async (expression) => JSON.parse((await conn.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value);
    const read = () => evalJson(STATE);
    const move = (x, y) => conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" }, sessionId);
    const click = async (x, y) => {
      await conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, sessionId);
      await conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, sessionId);
    };
    const pressEscape = async () => {
      const key = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
      await conn.send("Input.dispatchKeyEvent", { type: "keyDown", ...key }, sessionId);
      await conn.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, sessionId);
    };

    const start = await read();
    check("settings button and panel are present", !start.missing && start.x > 0);
    await move(20, 20);
    await move(start.x, start.y);
    const hovered = await read();
    check("hovering the button does not open the panel", hovered.open === false && hovered.aria === "false", JSON.stringify(hovered));
    await click(start.x, start.y);
    const opened = await read();
    check("clicking the button opens the panel", opened.open === true && opened.aria === "true" && opened.inert === false, JSON.stringify(opened));
    /* A real key event, because a keyboard user has no mouse to move away with. */
    await pressEscape();
    const escaped = await read();
    check("Escape closes the panel and focus goes back to the button", escaped.open === false && escaped.inert === true && escaped.onTrigger === true, JSON.stringify(escaped));
    await click(start.x, start.y);
    await click(200, 200);
    const dismissed = await read();
    check("clicking outside closes the panel again", dismissed.open === false && dismissed.inert === true, JSON.stringify(dismissed));
    /* Hiding the widget while its panel is open used to leave the shell carrying the
       open class, so Alt+Shift+R brought the panel back already expanded. */
    await click(start.x, start.y);
    const beforeHide = await read();
    const hidden = await evalJson(`(function () {
      var api = window.__QODER_RTL__, prev = api.config.panel;
      api.apply({ panel: false });
      var out = { openClass: !!document.querySelector(".qrt-widget.qrt-open"), widgets: document.querySelectorAll(".qrt-widget").length };
      api.apply({ panel: prev });
      out.backAgain = document.querySelectorAll(".qrt-widget").length;
      return JSON.stringify(out);
    })()`);
    check(
      "hiding the panel while it is open closes it",
      beforeHide.open === true && hidden.openClass === false && hidden.widgets === 0 && hidden.backAgain === 1,
      JSON.stringify({ beforeHide, hidden })
    );

  } catch (e) {
    check("settings button interaction test", false, e && e.message);
  } finally {
    if (conn) conn.close();
  }
}

/* The two settings that edit prose metrics, measured on the fixture — which copies
   Qoder's own `line-height:24px !important` pin — with the direction switch turned
   off. Gating typography on that switch made the slider work on some elements and
   silently stop on others, which no source-level grep would notice. */
async function settingsTest() {
  const SRC = `(function () {
    var api = window.__QODER_RTL__;
    var pick = function (sel) { return document.querySelector("[data-chat-message-text] " + sel); };
    var p = pick("p"), li = pick("li");
    var liEn = document.querySelectorAll("[data-chat-message-text] li")[1];
    var bq = pick("blockquote"), enOl = pick("ol"), mixedUl = pick("ul");
    var byId = function (id) { return document.getElementById(id); };
    var codeHeavy = byId("t-code-heavy"), codeOnly = byId("t-code-only"), bomLine = byId("t-bom");
    var userFa = byId("t-user-fa"), userEn = byId("t-user-en");
    if (!p || !li || !liEn || !bq || !enOl || !mixedUl || !codeHeavy || !codeOnly || !bomLine || !userFa || !userEn) {
      return JSON.stringify({ error: "fixture prose is missing" });
    }
    var restore = { rtl: api.config.rtl, mode: api.config.mode, lineHeight: api.config.lineHeight, codeSize: api.config.codeSize };
    /* An inline <code> in that paragraph, measured as a box: the fixture pins code to
       12px with !important the way the live window does, so the only way this width can
       move is by *scaling* whatever size the app chose — which is what the code-size
       slider is for. */
    var code = codeHeavy.querySelector("code");
    if (!code) return JSON.stringify({ error: "fixture has no inline code" });
    var codeBox = function () {
      var b = code.getBoundingClientRect();
      return { w: Math.round(b.width * 100) / 100, h: Math.round(b.height * 100) / 100, size: Math.round(parseFloat(getComputedStyle(code).fontSize) * 100) / 100 };
    };
    var ratio = function (el) {
      var s = getComputedStyle(el);
      return {
        lead: Math.round(parseFloat(s.lineHeight) * 100) / 100,
        size: parseFloat(s.fontSize),
        dir: s.direction,
        align: s.textAlign === "start" ? (s.direction === "rtl" ? "right" : "left") : s.textAlign,
        cls: el.className.replace(/text-sm|leading-6|text-text|my-0/g, "").trim()
      };
    };
    api.apply({ lineHeight: 2.3, rtl: true, mode: "smart" });
    var smart = {
      p: ratio(p),
      faLi: ratio(li),
      enLi: ratio(liEn),
      bq: ratio(bq),
      codeHeavy: ratio(codeHeavy),
      codeOnly: ratio(codeOnly),
      bomLine: ratio(bomLine),
      fa: document.querySelectorAll(".qrt-fa").length,
      en: document.querySelectorAll(".qrt-en").length,
      /* The human turn: same hook, different shape (the text hangs on the container, so no
         descendant rule reaches it and the classifier never saw it). Measured the same way as
         any other block, plus whether the inline leading stamp landed on it. */
      userFa: ratio(userFa),
      userEn: ratio(userEn),
      userStamp: { fa: userFa.hasAttribute("data-qrt-lead"), en: userEn.hasAttribute("data-qrt-lead") },
      userMarkdown: !!(userFa.querySelector("p") || userEn.querySelector("p")),
      mixedUl: getComputedStyle(mixedUl).direction,
      enOl: getComputedStyle(enOl).direction
    };
    api.apply({ mode: "off" });
    var off = {
      p: ratio(p),
      li: ratio(li),
      bq: ratio(bq),
      userFa: ratio(userFa),
      marks: document.querySelectorAll(".qrt-fa,.qrt-en").length,
      root: document.documentElement.getAttribute("data-qrt-mode")
    };
    api.apply(restore);
    /* Back at the user's own codeSize, then deliberately larger: the box has to grow. */
    var codeAt0 = codeBox();
    api.apply({ codeSize: 6 });
    var codeAt6 = codeBox();
    api.apply(restore);
    return JSON.stringify({
      smart: smart,
      off: off,
      codeAt0: codeAt0,
      codeAt6: codeAt6,
      restored: { lineHeight: api.config.lineHeight, mode: api.config.mode, codeSize: api.config.codeSize, marks: document.querySelectorAll(".qrt-fa,.qrt-en").length },
      wanted: restore
    });
  })()`;
  let conn;
  try {
    conn = await Connection.open(await browserEndpoint(PORT));
    const target = (await conn.send("Target.getTargets")).targetInfos.find((t) => t.type === "page" && /chat\.html$/.test(t.url));
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const evalJson = async (expression) => JSON.parse((await conn.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value);
    const val = await evalJson(SRC);
    if (val.error) return check("runtime settings probe", false, val.error);
    const holds = (r, want) => r && Math.abs(r.lead / r.size - want) <= 0.06;
    check("configured leading reaches paragraph and list item", holds(val.smart.p, 2.3) && holds(val.smart.faLi, 2.3), JSON.stringify(val.smart.p));
    /* Smart mode has to mark both kinds of block: a Latin block that was never
       Persian used to get no class at all, which left it under the base RTL rule —
       right-aligned English, the one thing the mode exists to prevent. */
    check(
      "smart mode reads each block's own language",
      val.smart.p.dir === "rtl" &&
        val.smart.faLi.dir === "rtl" &&
        val.smart.faLi.align === "right" &&
        val.smart.enLi.dir === "ltr" &&
        val.smart.enLi.align === "left" &&
        val.smart.bq.dir === "rtl" &&
        /* Exact counts, because a classifier that silently stops seeing a block type is
           the failure mode here: the fixture's figcaption pair, its <summary> and the
           paragraph inside <details> raised these from 4/5 to 6/7 (the caption and the
           table cells are deliberately not classified — the tables switch owns those),
           and Qoder's own human turn — two bubbles, one per language — raised them to 7/8. */
        val.smart.fa === 7 &&
        val.smart.en === 8,
      JSON.stringify(val.smart)
    );
    /* The defect the owner reported: «چرا دیگه روی پیام‌های ورودی کاربر اعمال نمیشه؟».
       It survived 52 browser checks because the fixture had no human turn at all, so
       nothing existed for these rules to apply to. */
    check(
      "your own Persian message is right-aligned like a reply",
      val.smart.userFa.dir === "rtl" && val.smart.userFa.align === "right" && /qrt-fa/.test(val.smart.userFa.cls),
      JSON.stringify(val.smart.userFa)
    );
    check(
      "your own English message stays left-aligned",
      val.smart.userEn.dir === "ltr" && val.smart.userEn.align === "left" && /qrt-en/.test(val.smart.userEn.cls),
      JSON.stringify(val.smart.userEn)
    );
    /* The CSS list and the classifier's list have to gain the bubble together: pinning it
       RTL without letting it be classified would have moved the bug from "Persian reads
       LTR" to "English reads RTL". */
    check(
      "the leading stamp reaches the bubble the way it reaches prose",
      val.smart.userStamp.fa === true && val.smart.userStamp.en === true && holds(val.smart.userFa, 2.3) && holds(val.smart.userEn, 2.3),
      JSON.stringify({ stamp: val.smart.userStamp, fa: val.smart.userFa, en: val.smart.userEn })
    );
    check("turning direction off returns your own message to LTR", val.off.userFa.dir === "ltr" && val.off.userFa.align === "left", JSON.stringify(val.off.userFa));
    /* Not a behaviour check but the fixture's premise: Qoder puts the human turn's text on
       the container instead of rendering markdown for it. If that ever stops being true,
       the bubble rows above would be proving nothing and this is what says so. */
    check("the fixture still renders the human turn as text on the container", val.smart.userMarkdown === false, JSON.stringify(val.smart.userMarkdown));
    /* These three are what the classifier used to get wrong: identifier text is
       pinned LTR by the stylesheet and zero-width format characters carry no language
       at all, so neither may decide which way the sentence around them runs. */
    check(
      "prose keeps its direction when it names code identifiers",
      val.smart.codeHeavy.dir === "rtl" && val.smart.codeHeavy.align === "right" && /qrt-fa/.test(val.smart.codeHeavy.cls),
      JSON.stringify(val.smart.codeHeavy)
    );
    check(
      "a block that is only code stays LTR",
      val.smart.codeOnly.dir === "ltr" && val.smart.codeOnly.align === "left" && /qrt-en/.test(val.smart.codeOnly.cls),
      JSON.stringify(val.smart.codeOnly)
    );
    check(
      "invisible format characters cannot outvote Latin text",
      val.smart.bomLine.dir === "ltr" && val.smart.bomLine.align === "left" && /qrt-en/.test(val.smart.bomLine.cls),
      JSON.stringify(val.smart.bomLine)
    );
    /* Only a list whose items are *all* Latin flips: a mixed list keeps its RTL
       markers and lets each item carry its own direction. */
    check(
      "an all-Latin list flips, a mixed one keeps RTL markers",
      val.smart.enOl === "ltr" && val.smart.mixedUl === "rtl",
      JSON.stringify({ enOl: val.smart.enOl, mixedUl: val.smart.mixedUl })
    );
    check("leading survives turning the direction switch off", holds(val.off.p, 2.3) && holds(val.off.li, 2.3) && val.off.root === "off", JSON.stringify(val.off));
    check("turning the switch off also drops the RTL furniture", val.off.bq.dir === "ltr" && val.off.bq.align === "left", JSON.stringify(val.off.bq));
    check("per-block direction marks are cleared while direction is off", val.smart.fa + val.smart.en > 1 && val.off.marks === 0, JSON.stringify({ smart: val.smart.fa + val.smart.en, off: val.off.marks }));
    check("the probe leaves the user's own settings behind", val.restored.lineHeight === val.wanted.lineHeight && val.restored.mode === val.wanted.mode && val.restored.codeSize === val.wanted.codeSize, JSON.stringify(val));
    /* The slider that used to do nothing on the live app. The fixture reproduces the
       measured live condition — an inline <code> pinned to 12px by an app rule with
       !important, inside a 13px paragraph — so this check fails for the payload that
       *declared* a code size (its declaration loses the cascade, exactly like the
       `font-size: calc(1em * …)` did) and passes for the one that scales the box. */
    check(
      "the code-size slider changes rendered inline code",
      val.codeAt0.size === 12 && val.codeAt6.w >= val.codeAt0.w * 1.3 && val.codeAt6.h >= val.codeAt0.h * 1.3,
      JSON.stringify({ at0: val.codeAt0, at6: val.codeAt6 })
    );

    /* A storage event only fires in the *other* same-origin document, which one file://
       page cannot produce, so the event is synthesized; the listener, the reload of the
       config and the re-apply are the real ones. */
    const sync = await evalJson(`(function () {
      var api = window.__QODER_RTL__, KEY = "qoder_persian_rtl_config_v1";
      var raw = localStorage.getItem(KEY) || "{}";
      var next = JSON.parse(raw);
      next.lineHeight = 2.22;
      localStorage.setItem(KEY, JSON.stringify(next));
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: JSON.stringify(next) }));
      var p = document.querySelector("[data-chat-message-text] p");
      var seen = { lineHeight: api.config.lineHeight, ratio: parseFloat(getComputedStyle(p).lineHeight) / parseFloat(getComputedStyle(p).fontSize) };
      window.dispatchEvent(new StorageEvent("storage", { key: "somebody_elses_key", newValue: '{"lineHeight":9}' }));
      var ignored = api.config.lineHeight;
      localStorage.setItem(KEY, raw);
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: raw }));
      return JSON.stringify({ seen: seen, ignoredOtherKey: ignored, back: api.config.lineHeight });
    })()`);
    check(
      "a config write from another window re-applies itself here",
      sync.seen.lineHeight === 2.22 && Math.abs(sync.seen.ratio - 2.22) <= 0.06 && sync.ignoredOtherKey === 2.22 && sync.back === val.wanted.lineHeight,
      JSON.stringify(sync)
    );
  } catch (e) {
    check("runtime settings probe", false, e && e.message);
  } finally {
    if (conn) conn.close();
  }
}

/* The direction switch and the mode dropdown write two fields that mean the same
   thing, and the two handlers used to disagree in both directions: switching the
   master switch off then on left the page LTR with the switch reading ON, and
   Alt+R from that state needed two presses. Driven through the panel's own controls
   (and a real keydown), because the disagreement was in the handlers, not the CSS. */
async function controlTest() {
  const SRC = `(function () {
    var api = window.__QODER_RTL__;
    var restore = { rtl: api.config.rtl, mode: api.config.mode };
    function control(label) {
      var rows = document.querySelectorAll(".qrt-row");
      for (var i = 0; i < rows.length; i++) {
        var l = rows[i].querySelector(".qrt-label");
        if (l && l.textContent === label) return rows[i].querySelector("input, select");
      }
      return null;
    }
    var sw = control("راست‌چین فعال"), dd = control("حالت جهت");
    if (!sw || !dd) return JSON.stringify({ error: "panel controls not found (switch=" + !!sw + ", select=" + !!dd + ")" });
    /* The change event is dispatched rather than clicked: the handler that writes the
       two fields is what regressed, and a click would only re-test the browser. */
    var fire = function (node, value) {
      if (node.type === "checkbox") node.checked = value;
      else node.value = value;
      node.dispatchEvent(new Event("change", { bubbles: true }));
    };
    var altR = function () {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", code: "KeyR", altKey: true, bubbles: true }));
    };
    var state = function () {
      var p = document.querySelector("[data-chat-message-text] p");
      return {
        root: document.documentElement.getAttribute("data-qrt-mode"),
        rtl: !!api.config.rtl,
        mode: api.config.mode,
        checked: !!sw.checked,
        shown: dd.value,
        dir: getComputedStyle(p).direction,
        marks: document.querySelectorAll(".qrt-fa,.qrt-en").length
      };
    };
    var out = { begin: null, off: null, backOn: null, viaDropdown: null, switchAfterDropdownOff: null, alt1: null, alt2: null };
    api.apply({ rtl: true, mode: "smart" });
    out.begin = state();
    fire(sw, false);
    out.off = state();
    fire(sw, true);
    out.backOn = state();
    fire(dd, "off");
    out.switchAfterDropdownOff = state();
    fire(sw, true);
    out.viaDropdown = state();
    api.apply({ rtl: true, mode: "smart" });
    altR();
    out.alt1 = state();
    altR();
    out.alt2 = state();
    api.apply(restore);
    out.restored = state();
    return JSON.stringify(out);
  })()`;
  let conn;
  try {
    conn = await Connection.open(await browserEndpoint(PORT));
    const target = (await conn.send("Target.getTargets")).targetInfos.find((t) => t.type === "page" && /chat\.html$/.test(t.url));
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const evalJson = async (expression) => JSON.parse((await conn.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value);
    const r = await evalJson(SRC);
    if (r.error) return check("direction control probe", false, r.error);
    check("switch off turns the page LTR", r.off.root === "off" && r.off.dir === "ltr" && r.off.checked === false && r.off.marks === 0, JSON.stringify(r.off));
    check("switch back on restores the prose, not just the checkbox", r.backOn.root === "smart" && r.backOn.dir === "rtl" && r.backOn.checked === true && r.backOn.marks > 1, JSON.stringify(r.backOn));
    check("picking خاموش in the dropdown also unchecks the switch", r.switchAfterDropdownOff.mode === "off" && r.switchAfterDropdownOff.checked === false && r.switchAfterDropdownOff.root === "off", JSON.stringify(r.switchAfterDropdownOff));
    check("the switch over an off dropdown picks a real mode", r.viaDropdown.mode === "smart" && r.viaDropdown.shown === "smart" && r.viaDropdown.dir === "rtl", JSON.stringify(r.viaDropdown));
    check("one Alt+R press flips what is on screen", r.alt1.root === "off" && r.alt2.root === "smart" && r.alt2.dir === "rtl", JSON.stringify({ alt1: r.alt1, alt2: r.alt2 }));
    check("the probe leaves the user's direction settings behind", r.restored.rtl === true && ["smart", "force", "off"].includes(r.restored.mode), JSON.stringify(r.restored));
  } catch (e) {
    check("direction control probe", false, e && e.message);
  } finally {
    if (conn) conn.close();
  }
}

/* Three things the older payload got wrong and no prose test could see: the
   reverse-columns toggle moved no column at all, the composer's placeholder overlay was
   carried by none of the composer rules, and an injected <style> that disappeared took
   the patch down with it forever. All three are measured here rather than read out of
   the CSS, and measuring is what narrowed the first one down: the rule also pinned table
   cells to ltr, which turned out to change nothing visible, because
   `unicode-bidi: plaintext` takes its base direction from the content. */
async function geometryTest() {
  const SRC = `(function () {
    var api = window.__QODER_RTL__;
    var byId = function (id) { return document.getElementById(id); };
    var colA = byId("t-col-a"), colB = byId("t-col-b"), cell = byId("t-cell-b");
    var caption = byId("t-caption"), figFa = byId("t-fig-fa"), figEn = byId("t-fig-en"), sumEn = byId("t-sum-en");
    var editor = document.querySelector("[data-chat-composer] [contenteditable=\\"true\\"]");
    var ghost = document.querySelector("[data-chat-composer-placeholder]");
    if (!colA || !colB || !cell || !editor || !ghost || !caption || !figFa || !figEn || !sumEn) return JSON.stringify({ error: "fixture geometry is missing" });
    var restore = { rtl: api.config.rtl, mode: api.config.mode, tables: api.config.tables, reverseColumns: api.config.reverseColumns, lineHeight: api.config.lineHeight };
    var read = function () {
      var align = function (s) {
        if (s.textAlign !== "start" && s.textAlign !== "end") return s.textAlign;
        var r = s.direction === "rtl" ? "right" : "left";
        return s.textAlign === "start" ? r : r === "left" ? "right" : "left";
      };
      var metrics = function (el) {
        var s = getComputedStyle(el);
        var b = el.getBoundingClientRect();
        return { x: Math.round(b.left), lead: Math.round(parseFloat(s.lineHeight) * 100) / 100, size: parseFloat(s.fontSize), dir: s.direction, align: align(s), face: s.fontFamily.slice(0, 16), cls: el.getAttribute("class") || "", stamp: el.hasAttribute("data-qrt-lead") };
      };
      return {
        firstColumn: colA.getBoundingClientRect().left < colB.getBoundingClientRect().left ? "left" : "right",
        cell: metrics(cell),
        caption: metrics(caption),
        figFa: metrics(figFa),
        figEn: metrics(figEn),
        sumEn: metrics(sumEn),
        editor: metrics(editor),
        ghost: metrics(ghost)
      };
    };
    api.apply({ rtl: true, mode: "smart", tables: true, reverseColumns: false, lineHeight: 2.1 });
    var plain = read();
    api.apply({ reverseColumns: true });
    var reversed = read();
    /* Tables back on and the switch off: this is the state the «RTL جدول‌ها» row is
       supposed to produce, and the one the patch used to leave half-finished — the
       columns returned to LTR while every cell stayed right-aligned. */
    api.apply({ reverseColumns: false, tables: false });
    var tablesOff = read();
    api.apply(restore);
    return JSON.stringify({ plain: plain, reversed: reversed, tablesOff: tablesOff, restored: { tables: api.config.tables, reverseColumns: api.config.reverseColumns, lineHeight: api.config.lineHeight }, wanted: restore });
  })()`;
  const REMOVE = `(function () {
    var removed = [];
    var ids = ["qoder-rtl-vars", "qoder-rtl-panel-style"];
    for (var i = 0; i < ids.length; i++) {
      var n = document.getElementById(ids[i]);
      if (n) { n.remove(); removed.push(ids[i]); }
    }
    var sheet = document.querySelector("style[data-qoder-rtl]");
    if (sheet) { sheet.remove(); removed.push("style[data-qoder-rtl]"); }
    /* The root flags stay correct through this on purpose: that is the failure being
       tested — every drift check that only looks at <html> calls this state healthy. */
    return JSON.stringify({ removed: removed, root: document.documentElement.getAttribute("data-qrt-mode") });
  })()`;
  const HEALED = `(function () {
    var p = document.querySelector("[data-chat-message-text] p");
    var s = getComputedStyle(p);
    var w = document.querySelector(".qrt-widget");
    return JSON.stringify({
      vars: !!document.getElementById("qoder-rtl-vars"),
      panelStyle: !!document.getElementById("qoder-rtl-panel-style"),
      sheetNodes: document.querySelectorAll("style[data-qoder-rtl]").length,
      face: s.fontFamily.slice(0, 16),
      widgetVisible: !!w && getComputedStyle(w).display !== "none"
    });
  })()`;
  let conn;
  try {
    conn = await Connection.open(await browserEndpoint(PORT));
    const target = (await conn.send("Target.getTargets")).targetInfos.find((t) => t.type === "page" && /chat\.html$/.test(t.url));
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const evalJson = async (expression) => JSON.parse((await conn.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value);
    const val = await evalJson(SRC);
    if (val.error) return check("geometry probe", false, val.error);
    const ratio = (m) => (m ? m.lead / m.size : 0);
    check(
      "reverse-columns actually moves the first column to the other side",
      val.plain.firstColumn === "right" && val.reversed.firstColumn === "left",
      JSON.stringify({ plain: val.plain.firstColumn, reversed: val.reversed.firstColumn })
    );
    check(
      "a Persian cell keeps rtl direction and right alignment when columns reverse",
      val.reversed.cell.dir === "rtl" && val.reversed.cell.align === "right" && val.plain.cell.dir === val.reversed.cell.dir,
      JSON.stringify({ plain: val.plain.cell, reversed: val.reversed.cell })
    );
    check(
      "the composer placeholder matches the editor it stands over",
      /Vazirmatn/.test(val.plain.ghost.face) &&
        val.plain.ghost.dir === "rtl" &&
        Math.abs(ratio(val.plain.ghost) - 2.1) <= 0.06 &&
        val.plain.ghost.dir === val.plain.editor.dir &&
        Math.abs(ratio(val.plain.ghost) - ratio(val.plain.editor)) <= 0.06,
      JSON.stringify({ ghost: val.plain.ghost, editor: val.plain.editor })
    );

    check(
      "turning the tables switch off returns the whole table to LTR",
      val.plain.cell.dir === "rtl" && val.plain.cell.align === "right" && val.tablesOff.cell.dir === "ltr" && val.tablesOff.cell.align === "left" && val.tablesOff.firstColumn === "left",
      JSON.stringify({ on: val.plain.cell, off: val.tablesOff.cell, offColumns: val.tablesOff.firstColumn })
    );
    check(
      "smart mode classifies captions and summaries like any prose",
      /qrt-fa/.test(val.plain.figFa.cls) && val.plain.figFa.dir === "rtl" && val.plain.figFa.align === "right" && /qrt-en/.test(val.plain.figEn.cls) && val.plain.figEn.dir === "ltr" && val.plain.figEn.align === "left" && /qrt-en/.test(val.plain.sumEn.cls) && val.plain.sumEn.dir === "ltr",
      JSON.stringify({ fa: val.plain.figFa, en: val.plain.figEn, sum: val.plain.sumEn })
    );
    /* Every element the CSS gives `line-height: var(--qrt-leading) !important` has to be
       in the runtime's stamp list too, or Qoder's own !important keeps that one element
       on 24px while the rest of the message follows the slider. */
    check(
      "the leading stamp covers caption, figcaption and summary",
      [val.plain.caption, val.plain.figFa, val.plain.figEn, val.plain.sumEn].every((m) => m.stamp && Math.abs(ratio(m) - 2.1) <= 0.06),
      JSON.stringify({ cap: val.plain.caption, figFa: val.plain.figFa, figEn: val.plain.figEn, sum: val.plain.sumEn })
    );

    const gone = await evalJson(REMOVE);
    await sleep(400);
    const back = await evalJson(HEALED);
    check(
      "removing the injected style nodes is repaired on its own",
      gone.removed.length === 3 && back.vars && back.panelStyle && back.sheetNodes === 1 && /Vazirmatn/.test(back.face) && back.widgetVisible,
      JSON.stringify({ gone, back })
    );

    /* Losing only the main sheet is a different repair from losing all three: the vars
       node survives near the top of <head>, and the installer appends its replacement at
       the end — after it. rtl.css declares the same custom properties on :root with their
       defaults, so whichever sheet sits last wins, and a repair that reorders them drops
       the user's own numbers while every value still looks present. */
    const ONLY_SHEET = `(function () {
      var api = window.__QODER_RTL__;
      var restore = { chatSize: api.config.chatSize, faFont: api.config.faFont };
      api.apply({ chatSize: 4, faFont: "QRT Order Probe" });
      var sheet = document.querySelector("style[data-qoder-rtl]");
      var removed = !!sheet;
      if (sheet) sheet.remove();
      return JSON.stringify({ removed: removed, restore: restore });
    })()`;
    const AFTER_REPAIR = `(function () {
      var host = document.querySelector("[data-chat-message-text]");
      var p = document.querySelector("[data-chat-message-text] p");
      return JSON.stringify({
        zoom: host ? getComputedStyle(host).zoom : null,
        face: p ? getComputedStyle(p).fontFamily.slice(0, 24) : null,
        sheets: [].map.call(document.head.querySelectorAll("style"), function (s) {
          return s.id || (s.getAttribute("data-qoder-rtl") ? "sheet" : "?");
        }).join(",")
      });
    })()`;
    const only = await evalJson(ONLY_SHEET);
    await sleep(400);
    const repaired = await evalJson(AFTER_REPAIR);
    check(
      "a repair that only replaces the sheet keeps the user's own numbers",
      only.removed && Math.abs(parseFloat(repaired.zoom) - 1.25) < 0.01 && /QRT Order Probe/.test(repaired.face),
      JSON.stringify({ only, repaired })
    );
    await conn.send("Runtime.evaluate", { expression: `window.__QODER_RTL__.apply(${JSON.stringify(only.restore)})` }, sessionId);
    check("the probe leaves the table and leading settings behind", val.restored.lineHeight === val.wanted.lineHeight && val.restored.reverseColumns === val.wanted.reverseColumns, JSON.stringify({ restored: val.restored, wanted: val.wanted }));
  } catch (e) {
    check("geometry probe", false, e && e.message);
  } finally {
    if (conn) conn.close();
  }
}

async function main() {
  const exe = findChromium();
  if (!exe) {
    console.log("  skip  no local Chromium (Edge/Chrome) found — cannot run the browser integration test");
    return;
  }
  console.log(`browser: ${exe}`);
  console.log(`fixture: ${FIXTURE}`);

  /* A port already serving DevTools means a browser outlived an earlier run, and
     spawning into it produces a launch that never answers. This script only kills the
     browser it started, so name the occupant and stop rather than killing it. */
  if (await portIsOpen(PORT)) {
    check("devtools port is free before launch", false, `something already serves DevTools on ${PORT} — close that leftover browser or pass --port <n>`);
    process.exitCode = 1;
    return;
  }

  const child = await startBrowser(exe);
  if (!child) {
    check("headless browser exposes a DevTools port", false, `nothing listened on ${PORT} within 20s (the half-started browser was killed so it cannot squat on the port)`);
    return finish(PROFILE);
  }
  check("headless browser exposes a DevTools port", true);

  const run = spawnSync(process.execPath, [path.join(ROOT, "live.js"), "--port", String(PORT), "--check"], { encoding: "utf8" });
  const out = (run.stdout || "") + (run.stderr || "");
  console.log(out.replace(/^/gm, "    "));
  check("live.js attached to the page target", /page targets visible over CDP \(1 target/.test(out) || /page targets visible over CDP \((\d+) target/.test(out));
  check("payload injected into the page", /PASS\s+payload injected/.test(out), "no __QODER_RTL__");
  check("inline stylesheet installed", /PASS\s+stylesheet installed inline/.test(out));
  check("chat DOM hooks reachable", /PASS\s+chat DOM hooks reachable/.test(out));
  check("injected script threw no exception", !/injected script threw/.test(out));
  check("font registered from inlined bytes", /PASS\s+Vazirmatn registered from inlined bytes/.test(out));
  check("font resolves for page text", /PASS\s+Vazirmatn resolves for page text/.test(out), "document.fonts.check() never turned true");
  check("chat prose computes to Vazirmatn", /PASS\s+chat prose computes to the Vazirmatn stack/.test(out));
  /* Qoder's own utilities (text-sm / leading-6) and its .markdown-body font sit on
     the prose itself, so the fixture copies them: matching the configured ratio here
     means the patch out-specifies them rather than only setting a container default. */
  check("configured line-height reaches the prose", /PASS\s+line-height slider value reaches the prose/.test(out));
  check("line-height and text-size sliders change measured prose", /PASS\s+panel sliders change the prose when applied/.test(out), "controls probe saw no change");
  check("patch applied on the document root", /PASS\s+patch active on the document root/.test(out));
  /* The audit row that would have caught the reported defect live: it scores the human
     bubble, and reads UNSURE rather than PASS when a conversation has none to measure. */
  check("the verdict measures the user's own message", /PASS\s+your own messages follow the patch/.test(out), (out.match(/(PASS|FAIL|UNSURE)\s+your own messages[^\n]*/) || ["row not printed"])[0]);
  /* The fixture rewrites <html class="…"> every 500 ms, so empty classes here prove
     the mode survives on data-qrt-* attributes rather than on classes. */
  check("root state survives the page wiping html classes", /patch active on the document root \(data-qrt-mode=smart[^)]*classes=""/.test(out));
  check("settings panel mounted, visible and bottom-right", /PASS\s+settings panel mounted, visible and bottom-right/.test(out));
  check("live.js exited cleanly", run.status === 0, `exit ${run.status}`);

  console.log("  pointer interaction with the settings button:");
  await interactionTest();
  console.log("  driving the runtime settings the way the panel does:");
  await settingsTest();
  console.log("  the direction switch, the mode dropdown and Alt+R:");
  await controlTest();
  console.log("  table column order, composer placeholder and style-node repair:");
  await geometryTest();

  /* Injecting a second time into the same live document is the upgrade path the
     user hits by re-running the injector without reloading Qoder. An older sheet
     left in place would keep winning the properties the new payload changed. */
  const again = spawnSync(process.execPath, [path.join(ROOT, "live.js"), "--port", String(PORT), "--check"], { encoding: "utf8" });
  const out2 = (again.stdout || "") + (again.stderr || "");
  console.log("  second injection into the same document:");
  console.log(out2.replace(/^/gm, "    "));
  check("re-injection leaves exactly one inline sheet", /PASS\s+stylesheet installed inline and current \(nodes=1 bytes=\d+/.test(out2), (out2.match(/stylesheet installed inline and current \([^)]*\)/) || ["not reported"])[0]);
  check("re-injection keeps every verdict line green", again.status === 0 && !/FAIL\s/.test(out2), `exit ${again.status}`);
  const fontLine = out.match(/(PASS|FAIL)\s+Vazirmatn resolves for page text \(([^)]*)\)/);
  console.log(`  note  font: ${fontLine ? fontLine[1] + " " + fontLine[2] : "not reported"}`);

  /* «پنهان کردن پنل» is a state the user chooses. The verdict has to say that instead
     of FAILing a patch that is working, so the row is re-run with the widget hidden. */
  console.log("  verdict with the panel hidden on purpose:");
  const hideOut = await withPanelHidden(() =>
    spawnSync(process.execPath, [path.join(ROOT, "live.js"), "--port", String(PORT), "--check"], { encoding: "utf8" })
  );
  check("a deliberately hidden panel passes as hidden, not as broken", /PASS\s+settings panel hidden on purpose/.test(hideOut), (hideOut.match(/(PASS|FAIL|UNSURE)\s+settings panel[^\n]*/) || ["row not printed"])[0]);
  check("hiding the panel keeps every other verdict green", !/FAIL\s/.test(hideOut), (hideOut.match(/FAIL[^\n]*/g) || []).join(" / "));

  finish(PROFILE, child.pid);
}

/* Flip config.panel off, run `fn` (expected to be a --check spawn), then restore it, so
   a temporary state never leaks into the profile or the next stage. */
async function withPanelHidden(fn) {
  const set = async (value) => {
    const conn = await Connection.open(await browserEndpoint(PORT));
    try {
      const target = (await conn.send("Target.getTargets")).targetInfos.find((t) => t.type === "page" && /chat\.html$/.test(t.url));
      const { sessionId } = await conn.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      await conn.send(
        "Runtime.evaluate",
        { expression: `(function(){ window.__QODER_RTL__.apply({ panel: ${value ? "true" : "false"} }); return 1; })()`, returnByValue: true },
        sessionId
      );
    } finally {
      conn.close();
    }
  };
  await set(false);
  let res;
  try {
    res = fn();
  } finally {
    await set(true);
  }
  return (res.stdout || "") + (res.stderr || "");
}

function removeProfile(profileDir) {
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
      if (!fs.existsSync(profileDir)) return;
    } catch (e) {
      /* Edge can hold the profile for a moment after the process dies */
    }
    spawnSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 700"]);
  }
  console.log(`  note  left-over profile dir: ${profileDir}`);
}

/* Only ever called with the pid this script spawned: a leftover browser from an
   earlier run belongs to whoever started it, and killing a foreign process to make a
   test pass is not this harness's business. */
function killBrowser(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (e) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (e2) {}
  }
  spawnSync("sleep", ["1"]);
}

function finish(profileDir, pid) {
  killBrowser(pid);
  removeProfile(profileDir);
  console.log(failures ? `\n${failures} check(s) failed` : "\nCDP side-loader works end to end against a real Chromium");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("test/browser.js failed:", e.stack || e.message);
  removeProfile(PROFILE);
  process.exit(1);
});
