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
  /* Smart mode has to classify both ways: the old code only ever added .qrt-fa, so a
     Latin block that had never held Persian got no class and stayed under the base RTL
     rule — right-aligned English. Proven by the browser test, guarded here. */
  check("every block gets a direction class, both ways", /classList\.toggle\("qrt-fa", want\)/.test(rtljs) && /classList\.toggle\("qrt-en", !want\)/.test(rtljs) && !/classList\.add\("qrt-fa"\)/.test(rtljs));
  check("only an all-Latin list flips to LTR", css.includes(":is(ul, ol):has(> .qrt-en):not(:has(> .qrt-fa))"));
  check("list and quote furniture is scoped to the RTL modes", !/^\[data-chat-message-text\] :is\(ul, ol\) \{/m.test(css) && !/^\[data-chat-message-text\] blockquote \{/m.test(css) && /html\[data-qrt-mode="smart"\] \[data-chat-message-text\] :is\(ul, ol\)/.test(css));
  check("off mode covers every RTL element type", /html\[data-qrt-mode="off"\] \[data-chat-message-text\] :is\([^)]*figcaption, caption, summary[^)]*\)/.test(css));

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
  check("panel is labelled as a dialog for assistive tech", /panel.setAttribute\("role", "dialog"\)/.test(rtljs) && /trigger.setAttribute\("aria-haspopup", "dialog"\)/.test(rtljs));
  /* Escape is the one dismissal gesture a keyboard user reaches for; closing has to hand
     focus back to the button, or the tab order restarts at the top of the app. */
  check("Escape closes the panel and refocuses the button", /ev\.key === "Escape" && open/.test(rtljs) && /triggerEl\.focus\(\)/.test(rtljs));
  /* Measured on the live app: with the direction switch off, Qoder's own
     line-height:24px !important won the paragraphs while our var kept the list items,
     so the leading slider worked in half the message. Typography stays ungated. */
  const leadBody = (/function applyLeading\(\)\s*\{([\s\S]*?)\n  \}/.exec(rtljs) || [, ""])[1];
  check("leading control is not gated on the direction switches", leadBody.includes('String(Number(cfg.lineHeight)') && !/cfg\.rtl|cfg\.mode/.test(leadBody), leadBody.trim().slice(0, 90));
  /* reset() rebound cfg to a fresh object, which left window.__QODER_RTL__.config — and
     the verdict rows that read settings through it — reporting the pre-reset values. */
  const resetBody = (/function reset\(\)\s*\{([\s\S]*?)\n  \}/.exec(rtljs) || [, ""])[1];
  check("reset mutates the shared config object instead of replacing it", resetBody.includes("cfg[k] = defaults[k]") && !/cfg\s*=\s*Object\.assign/.test(resetBody), resetBody.trim().slice(0, 90));
  check("config edits in another window are picked up", /addEventListener\("storage", onStorage\)/.test(rtljs) && /removeEventListener\("storage", onStorage\)/.test(rtljs));
  check("hiding the panel closes it before removing it", (/function mount\(\)\s*\{[\s\S]*?if \(!cfg\.panel\)\s*\{[\s\S]*?setOpen\(false\);/.test(rtljs)));
  check("stale direction marks are cleared when the switch is off", /function clearMarks\(\)/.test(rtljs) && /if \(cfg\.mode !== "smart" && cfg\.mode !== "force"\)\s*\{\s*clearMarks\(\);/.test(rtljs));
  /* rtl=true + mode="off" and rtl=false + mode="smart" both mean "off", and the panel
     used to write the two fields from separate handlers: clearing the switch set mode
     off, switching it back on did not, so the main toggle read ON over an LTR page. */
  check("every direction path goes through one setter", /function setDirection\(on\)/.test(rtljs) && /if \(key === "rtl"\) setDirection\(i\.checked\)/.test(rtljs) && /if \(key === "mode"\) setDirection\(s\.value !== "off"\)/.test(rtljs) && !/if \(key === "rtl" && !i\.checked\)/.test(rtljs));
  check("the direction switch reports the effective state", /node\.checked = key === "rtl" \? !!cfg\.rtl && cfg\.mode !== "off" : !!cfg\[key\]/.test(rtljs));
  check("Alt+R toggles what the page shows, not the stored flag", /setDirection\(!\(cfg\.rtl && cfg\.mode !== "off"\)\)/.test(rtljs));
  /* The stylesheet pins inline <code> LTR, so its identifiers must not outvote the
     Persian sentence around them — naming three of them used to left-align the block. */
  check("inline code cannot decide a block's direction", /LTR_ONLY_TAGS\.test\(c\.tagName\)/.test(rtljs) && /return buf \|\| \(onlyIsolated \? "" : el\.textContent \|\| ""\)/.test(rtljs) && /var t = text\.replace\(FORMAT_RE, " "\)/.test(rtljs));
  const fmtLine = (/var FORMAT_RE = .*/.exec(rtljs) || [""])[0];
  check("format-class is escapes, not raw invisible characters", fmtLine.includes("\\u200b") && !/\u00ad|\u200b|\u200f|\ufeff/.test(fmtLine), JSON.stringify(fmtLine.slice(0, 46)));
  /* The app can detach the widget's subtree mid-stream; only the 4s tick noticed, so the
     button disappeared for seconds in the middle of an answer. Scoped to the observer
     body because the safety tick has always carried the same expression. */
  const obsBody = (/new MutationObserver\(function \(\) \{([\s\S]*?)\n    \}\)/.exec(rtljs) || [, ""])[1];
  check("a detached widget is re-mounted on the next mutation", /if \(cfg\.panel && \(!shell \|\| !document\.body\.contains\(shell\)\)\) mount\(\);/.test(obsBody), obsBody.trim().slice(0, 80));
  /* Losing an injected <style> is silent and permanent: the root flags keep reading
     correct while the font, zoom and leading collapse with the node. The drift check
     that only looks at <html> cannot see it, so repair() watches the nodes too — and
     has to run from both watchers, not just the one someone edits first. */
  const nodesBody = (/function nodesDrifted\(\)\s*\{([\s\S]*?)\n  \}/.exec(rtljs) || [, ""])[1];
  const repairBody = (/function repair\(\)\s*\{([\s\S]*?)\n  \}/.exec(rtljs) || [, ""])[1];
  check("drift check covers the injected style nodes, not only root attributes", nodesBody.includes('getElementById("qoder-rtl-vars")') && nodesBody.includes("qoder-rtl-panel-style") && nodesBody.includes("style[data-qoder-rtl]"), nodesBody.trim());
  check("repair re-runs the sheet installer and the config together", /nodesDrifted\(\)/.test(repairBody) && /window\.__QRT_CSS__\(\)/.test(repairBody) && /ensurePanelStyle\(\);/.test(repairBody) && /applyConfig\(\);/.test(repairBody), repairBody.trim());
  const tickBody = (/var tick = setInterval\(function \(\)\s*\{([\s\S]*?)\n    \}, 4000\)/.exec(rtljs) || [, ""])[1];
  check("both watchers call repair", /^repair\(\);/.test(obsBody.trim()) && /^repair\(\);/.test(tickBody.trim()), JSON.stringify({ obs: obsBody.trim().slice(0, 40), tick: tickBody.trim().slice(0, 40) }));
  /* The payload holds the CSS text once; the runtime reaches it through this hook
     instead of carrying a second copy that could drift. */
  const payloadjs = fs.readFileSync(path.join(__dirname, "..", "lib", "payload.js"), "utf8");
  check("the sheet prelude publishes its installer for the drift check", /window\.__QRT_CSS__ = install;/.test(payloadjs));
  /* Column order is decided by the direction on the table element: the old reverse rule
     re-asserted rtl on an already-rtl table (measured: no column moved) and pinned the
     cells ltr, which plaintext made inert. The whole toggle was a no-op. */
  const reverseRule = (/html\[data-qrt-reverse\] \[data-chat-message-text\] table \{\s*([^}]*?)\s*\}/.exec(css) || [, ""])[1];
  check("reverse-columns hands the table back to ltr", reverseRule.includes("direction: ltr"), JSON.stringify(reverseRule));
  check("reverse-columns does not pin the cells", !/html\[data-qrt-reverse\][^{]*:is\(th, td\)/.test(css) && (css.match(/html\[data-qrt-reverse\]/g) || []).length === 1);
  /* Qoder's composer placeholder is a sibling overlay with the app font and its own
     24px ltr box, so it needs each composer rule rather than only the first one. */
  const ghostLists = (css.match(/\[data-chat-composer\] :is\([^)]*\)/g) || []).filter((s) => /\[data-chat-composer-placeholder\]/.test(s));
  check("the placeholder overlay is carried by every composer rule", ghostLists.length >= 5, `${ghostLists.length} of ${(css.match(/\[data-chat-composer\] :is\([^)]*\)/g) || []).length} selector lists`);
  /* Qoder keeps an undrawn second page target, and auto-attach runs on its own clock, so
     the first report used to probe a window that was still being attached: 20s of dead
     timeouts, and "Runtime.evaluate timed out after 10s" printed where a version number
     goes — which reads as a failed patch on a window that was merely slow. */
  const liveSrc = fs.readFileSync(path.join(__dirname, "..", "live.js"), "utf8");
  const reportBody = (/async report\(options = \{\}\) \{([\s\S]*?)\n  \}/.exec(liveSrc) || [, ""])[1];
  check("a session still being attached is reported busy instead of probed", /if \(meta\.busy\) \{/.test(reportBody) && /injection still running/.test(reportBody), reportBody.trim().slice(0, 60) || "report() body not found");
  check("the attach pass owns the busy flag from entry to exit", /patchError: null, busy: true/.test(liveSrc) && /meta\.busy = false;/.test(liveSrc));
  check("a busy window is explained as itself in the report", /if \(r\.busy\) \{[\s\S]{0,240}?still being attached when this report ran/.test(liveSrc));
  /* A target whose Page domain never answered used to be deleted from the session map,
     so it vanished from the report *and* from the "page targets visible over CDP" count:
     a run that patched one of two windows looked like a run that saw one window. */
  check("a window that never answers is kept on record instead of forgotten", /this\.skipped\.set\(sessionId/.test(liveSrc) && /of this\.skipped\)/.test(reportBody));
  check("an unanswered window is named as unpatched in the report", /NOT PATCHED — its document never answered/.test(liveSrc) && /window\(s\) listed above were never patched/.test(liveSrc));
  check("a watching injector retries the unanswered windows", /async retrySkipped\(\)/.test(liveSrc) && /\.retrySkipped\(\)/.test(liveSrc) && /Page\.enable.*sessionId, 8000/.test((/async retrySkipped\(\)\s*\{([\s\S]*?)\n  \}/.exec(liveSrc) || [, ""])[1]));
  /* The trigger stopped being a lone «ا» glyph in the top-right corner two batches ago;
     the tool's own console output still said so, which is a log that describes a UI
     nobody can find. */
  const indexjs = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  check("no user-facing text still describes the old «ا» corner button", !/«ا»/.test(liveSrc + indexjs) && !/top-right/.test(liveSrc + indexjs));

  /* ---- batch 4: one switch has to own the whole table, and every RTL-pinned tag has to
       be classifiable. Both defects were invisible to a grep: the rules existed, they
       just governed different halves of the same element. ---- */
  const tagList = (src2, re) => ((re.exec(src2) || [, ""])[1]).split(",").map((s) => s.trim()).filter(Boolean);
  const proseTags = tagList(css, /^\[data-chat-message-text\] :is\(([^)]*)\)[^{]*\{\s*unicode-bidi: plaintext;/m);
  const tableTags = tagList(css, /html\[data-qrt-tables\] \[data-chat-message-text\] :is\(([^)]*)\) \{/);
  const smartEnTags = tagList(css, /html\[data-qrt-mode="smart"\] \[data-chat-message-text\] :is\(([^)]*)\)\.qrt-en/);
  const blockTags = ((/var BLOCK_SELECTOR = \[([\s\S]*?)\]\.join/.exec(rtljs) || [, ""])[1])
    .split("\n")
    .map((line) => /^"[^"]* ([a-z0-9]+)",?$/.exec(line.trim()))
    .filter(Boolean)
    .map((m) => m[1]);
  check("the base prose rule leaves table furniture to the tables switch", proseTags.length > 0 && !proseTags.some((t) => ["td", "th", "caption"].includes(t)), JSON.stringify(proseTags));
  check("the tables switch owns column order *and* cell alignment", /html\[data-qrt-tables\] \[data-chat-message-text\] table \{\s*direction: rtl;/.test(css) && tableTags.length === 3 && tableTags.every((t) => ["th", "td", "caption"].includes(t)), JSON.stringify(tableTags));
  check("every RTL-pinned prose tag can be classified, in both places",
    proseTags.every((t) => (smartEnTags.includes(t) && blockTags.includes(t))),
    JSON.stringify({ smartEnMissing: proseTags.filter((t) => !smartEnTags.includes(t)), selectorMissing: proseTags.filter((t) => !blockTags.includes(t)) }));
  /* The inline stamp is what beats Qoder's own `!important`, so any element the CSS
     promises leading to has to be in the runtime's list too — otherwise one tag keeps
     the app's 24px while its neighbours follow the slider, which reads as a random
     slider failure. */
  const leadTags = tagList(css, /^\[data-chat-message-text\] :is\(([^)]*)\)[^{]*\{\s*line-height: var\(--qrt-leading\) !important;/m);
  const leadBlock = (/var LEAD_SELECTOR = \[([\s\S]*?)\]\.join/.exec(rtljs) || [, ""])[1];
  check("the runtime stamps every element the CSS promises leading to",
    leadTags.length > 0 && !leadTags.some((t) => !leadBlock.includes(`"[data-chat-message-text] ${t}"`)),
    JSON.stringify(leadTags.filter((t) => !leadBlock.includes(`"[data-chat-message-text] ${t}"`))));
  check("the stamp list covers the composer overlay too", leadBlock.includes('"[data-chat-composer] [data-chat-composer-placeholder]"') && leadBlock.includes('"[data-chat-composer] textarea"'));
  /* `[data-chat-composer][contenteditable]` matched nothing on the live DOM: the composer
     root is not the editable, so the selector was dead weight next to the real one. */
  check("no leading selector claims the composer root is the editor", !leadBlock.includes("[data-chat-composer][contenteditable]"), leadBlock.replace(/\s+/g, " ").slice(0, 120));
  /* The browser harness owns a Chromium it spawns, so it also has to clean it up: a launch
     whose port never answered used to leave that browser alive holding 9333, and every
     later run then failed with "nothing listened" — the opposite of what had happened.
     A port owned by someone else's process is reported, never taken over. */
  const browserjs = fs.readFileSync(path.join(__dirname, "browser.js"), "utf8");
  const startBody = (/async function startBrowser\(exe\) \{([\s\S]*?)\n\}/.exec(browserjs) || [, ""])[1];
  check("a failed browser launch is killed before giving up", /killBrowser\(child\.pid\);\s*return null;/.test(startBody), startBody.trim().slice(-80));
  check("an occupied devtools port aborts the run instead of spawning into it", /if \(await portIsOpen\(PORT\)\) \{[\s\S]{0,300}?process\.exitCode = 1;\s*return;\s*\}/.test(browserjs) && /function killBrowser\(pid\)/.test(browserjs));
  /* A family name typed into the panel goes into a CSS string; a trailing backslash
     escaped the closing quote and dropped the whole font stack declaration. */
  check("typed font names cannot break out of the CSS string", rtljs.includes('replace(/["\\\\\\r\\n]/g, "")'), (/function quoted[\s\S]{0,160}/.exec(rtljs) || [""])[0]);
  /* ---- batch 5: two cascade-order defects, both found by measuring a live window and
       both invisible to a grep over the rules — the declarations were correct, their
       *position* in the cascade was not. ---- */
  /* rtl.css declares the same custom properties on :root with their defaults, so the
     runtime's vars sheet only wins while it sits later in <head>; the self-heal path
     re-appends the other sheet last, and zoom and the typed font silently reset. */
  const varsBody = (/style\.textContent =\s*([\s\S]*?)"\}";/.exec(rtljs) || [, ""])[1];
  const varsDecls = (varsBody.match(/--qrt-[a-z-]+:/g) || []).length;
  check("the runtime's vars sheet outranks the stylesheet's defaults by weight, not by order",
    varsDecls >= 5 && (varsBody.match(/" !important;"/g) || []).length === varsDecls && /:root\{/.test(varsBody),
    JSON.stringify({ decls: varsDecls, important: (varsBody.match(/" !important;"/g) || []).length }));
  /* Qoder pins inline code with `font-size: 12px !important` (measured: 12px inside a
     13px paragraph), so a plain declaration of our own never reached it and the slider
     moved nothing. Scaling the element is the only thing that beats that rule. */
  check("the code-size var is applied by scaling, not by declaring a size",
    /zoom: var\(--qrt-code-scale\)/.test(css) && !/font-size:[^;]*--qrt-code-scale/.test(css),
    (css.match(/[^}]*--qrt-code-scale[^}]*}/g) || []).join(" ~ ").slice(0, 160));
  const codeScaleRule = (/(\[[^\]]*\][^{]*?)\{[^}]*zoom: var\(--qrt-code-scale\)/.exec(css) || [, ""])[1];
  check("only the code-ish islands are scaled, not the editors",
    /code/.test(codeScaleRule) && !/monaco-editor|cm-editor|xterm/.test(codeScaleRule), codeScaleRule.replace(/\s+/g, " ").slice(0, 140));
  /* The verdict has to keep measuring what the fix changed: a row that reads the old
     shape would report the dead slider as working again. */
  const controls = controlsProbeSource();
  check("the controls probe measures the code box on its own drive",
    controls.includes('querySelector("[data-chat-message-text] :not(pre) > code")') &&
      /api\.apply\(\{ codeSize: probeCode \}\)/.test(controls) &&
      /api\.apply\(restore\);\s*var codeBefore = nums\(\);/.test(controls) &&
      controls.includes("codeAfter"),
    (controls.match(/var code = [^\n]*/) || [""])[0]);
  check("the read-only probe reports the code island and the code size setting", probe.includes("codeIsland") && /settings: rtl[\s\S]{0,160}codeSize: rtl\.config\.codeSize/.test(probe));
  /* A panel the user hid with «پنهان کردن پنل» is a supported state, not a failure. */
  const livejs = fs.readFileSync(path.join(__dirname, "..", "live.js"), "utf8");
  check("hidden-by-choice panel is reported as a choice, not a failure", probe.includes("panelSetting") && livejs.includes("panelHidden"));
  /* The batch-5 row must not turn into a free PASS: with no inline code rendered it is
     UNSURE, and the name itself says why. */
  check("the code-size row refuses to pass on a window it could not measure",
    /codeShots\.length\s*\?[\s\S]{0,900}:\s*null/.test(livejs) && livejs.includes("no inline code rendered to measure"),
    (/const codeShots = [^\n]*/.exec(livejs) || [""])[0]);

  /* ---- batch 8: the human turn. Qoder renders your own message as one div with the text
       hanging directly on it — no `.markdown-body`, no `<p>` — so every rule that descended
       from `[data-chat-message-text]` walked past it and the classifier never saw it. The
       six groups below are one feature: pin the bubble RTL, let it be classified, stamp its
       leading, and measure it in the verdict. Half of them is how the 1.4.0 bug happened. ---- */
  const BUBBLE = "[data-user-bubble] [data-chat-message-text]";
  const bubbleGroups = {
    leading: /\[data-user-bubble\] \[data-chat-message-text\],[^{]*\{\s*line-height: var\(--qrt-leading\) !important;/,
    direction: /\[data-user-bubble\] \[data-chat-message-text\],[^{]*\{\s*unicode-bidi: plaintext;/,
    smartEn: /\[data-user-bubble\] \[data-chat-message-text\]\.qrt-en\s*\{\s*direction: ltr;/,
    smartFa: /\[data-user-bubble\] \[data-chat-message-text\]\.qrt-fa\s*\{\s*direction: rtl;/,
    force: /\[data-user-bubble\] \[data-chat-message-text\],[^{]*\{\s*direction: rtl !important;/,
    off: /\[data-user-bubble\] \[data-chat-message-text\],[^{]*\{\s*direction: ltr !important;/
  };
  const missingGroups = Object.keys(bubbleGroups).filter((k) => !bubbleGroups[k].test(css));
  check("the human bubble is carried by all six prose rule groups",
    missingGroups.length === 0,
    JSON.stringify({ missing: missingGroups, mentions: (css.match(/data-user-bubble/g) || []).length }));
  const blockList = (/var BLOCK_SELECTOR = \[([\s\S]*?)\]\.join/.exec(rtljs) || [, ""])[1];
  const leadList = (/var LEAD_SELECTOR = \[([\s\S]*?)\]\.join/.exec(rtljs) || [, ""])[1];
  check("the bubble is both classifiable and stamped, in the runtime's own lists",
    blockList.includes(BUBBLE) && leadList.includes(BUBBLE),
    JSON.stringify({ block: blockList.includes(BUBBLE), lead: leadList.includes(BUBBLE) }));
  check("the verdict measures the bubble instead of assuming it",
    /userBubble: count\("\[data-user-bubble\] \[data-chat-message-text\]"\)/.test(probe) && probe.includes("userText: userBubble") && /var userBubble = null/.test(probe),
    (probe.match(/var userBubble = null;[\s\S]{0,120}/) || [""])[0].replace(/\s+/g, " "));
  /* Same honesty rule as the code-size row: no user message on screen is not a pass. */
  check("the bubble row refuses to pass on a conversation with no user message",
    /bubbleShots\.length\s*\?[\s\S]{0,1200}:\s*null/.test(livejs) && livejs.includes("no user message rendered to measure"),
    (/const bubbleShots = [^\n]*/.exec(livejs) || [""])[0]);

  /* ---- batch 9: two surfaces outside the message list. The agent's task-monitor panel
       ([data-task-monitor-fixed-panel]) renders Persian prose with no chat hook above it, and
       the composer's ghost placeholder was RTL-pinned by the stylesheet with nothing to
       classify it. Both only appear while a run is going on, which is why the owner read it
       as "RTL breaks while streaming". Same six-group + both-lists invariant as batch 8. ---- */
  const MON = "[data-task-monitor-fixed-panel]";
  /* Escaped for the regexes: interpolating the raw selector would turn its brackets into a
     character class and the hyphens into ranges. */
  const MON_RE = "\\[data-task-monitor-fixed-panel\\]";
  const monGroups = {
    leading: new RegExp(`${MON_RE} :is\\([^)]*\\),[^{]*\\{\\s*line-height: var\\(--qrt-leading\\) !important;`),
    direction: new RegExp(`${MON_RE} :is\\([^)]*\\),[^{]*\\{\\s*unicode-bidi: plaintext;`),
    smartEn: new RegExp(`${MON_RE} :is\\([^)]*\\)\\.qrt-en,[^{]*\\{\\s*direction: ltr;`),
    smartFa: new RegExp(`${MON_RE} :is\\([^)]*\\)\\.qrt-fa,[^{]*\\{\\s*direction: rtl;`),
    force: new RegExp(`${MON_RE} :is\\([^)]*\\),[^{]*\\{\\s*direction: rtl !important;`),
    off: new RegExp(`${MON_RE} :is\\([^)]*\\),[^{]*\\{\\s*direction: ltr !important;`)
  };
  const monMissing = Object.keys(monGroups).filter((k) => !monGroups[k].test(css));
  check("the task-monitor panel is carried by all six prose rule groups",
    monMissing.length === 0, JSON.stringify({ missing: monMissing, mentions: (css.match(/data-task-monitor-fixed-panel/g) || []).length }));
  /* Derive the tag list from the rule that actually pins direction, so this check cannot
     drift into agreeing with itself, and refuse to pass on an empty match. */
  const basePinned = new RegExp(`${MON_RE} :is\\(([^)]*)\\),[^{]*\\{\\s*unicode-bidi: plaintext;`).exec(css);
  const baseTags = basePinned ? basePinned[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
  const monUnclassified = baseTags.filter((t) => !blockList.includes(`"${MON} ${t}"`));
  check("every panel tag the base RTL rule pins can also be classified",
    baseTags.length >= 10 && monUnclassified.length === 0,
    JSON.stringify({ pinned: baseTags.length, missing: monUnclassified }));
  check("the panel's prose is stamped for leading, not only given a direction",
    baseTags.filter((t) => /p|li|dd|dt|blockquote|figcaption|summary/.test(t)).every((t) => leadList.includes(`"${MON} ${t}"`)),
    leadList.includes(`"${MON} p"`) ? "panel p in LEAD_SELECTOR" : "panel p missing from LEAD_SELECTOR");
  /* The composer's ghost placeholder is one string, so it gets one verdict — measured on the
     live window as the Latin «Continue this task…» sitting right-aligned with its ellipsis on
     the wrong side. The *editor* is deliberately not classified: it holds several hard lines,
     and a block-level verdict flipped the whole input to LTR over one Latin letter. The base
     rule keeps it `rtl` + `unicode-bidi: plaintext`, which decides per line instead. */
  check("the composer placeholder gets a verdict and the editor keeps per-line plaintext",
    blockList.includes('"[data-chat-composer] [data-chat-composer-placeholder]"') &&
      !blockList.includes('"[data-chat-composer] [contenteditable]"') &&
      /html\[data-qrt-mode="smart"\] \[data-chat-composer\] \[data-chat-composer-placeholder\]\.qrt-en/.test(css) &&
      /html\[data-qrt-mode="smart"\] \[data-chat-composer\] \[data-chat-composer-placeholder\]\.qrt-fa/.test(css) &&
      !/html\[data-qrt-mode="smart"\] \[data-chat-composer\] :is\(\[contenteditable="true"\], \[data-chat-composer-placeholder\]\)\.qrt-en/.test(css) &&
      /\[data-chat-composer\] :is\(textarea, \[contenteditable="true"\], \[data-chat-composer-placeholder\]\) \{\s*unicode-bidi: plaintext;/.test(css),
    JSON.stringify({ editorInBlockList: blockList.includes('"[data-chat-composer] [contenteditable]"'), smartGhost: /\[data-chat-composer\] \[data-chat-composer-placeholder\]\.qrt-en/.test(css) }));
  check("the verdict measures the panel and the placeholder instead of assuming them",
    probe.includes("monitorText: monitor") && /var monitor = readSurface\(/.test(probe) &&
      probe.includes('taskMonitor: count("[data-task-monitor-fixed-panel]")') && /var ghost = readSurface\(/.test(probe),
    (probe.match(/var monitor = readSurface\([^\n]*/) || [""])[0]);
  check("the new row refuses to pass on a window that rendered neither surface",
    /surfaceShots\.length\s*\?[\s\S]{0,1800}:\s*null/.test(livejs) && livejs.includes("not rendered to measure"),
    (/const surfaceShots = [^\n]*/.exec(livejs) || [""])[0]);
  /* The row must not ask the editor for a class — that demand is what made a single Latin
     letter flip the whole input. It asks for an RTL box with per-line plaintext instead. */
  check("the row scores the editor on per-line plaintext rather than on a verdict",
    /editorOk\(a\.composerEditor\)/.test(livejs) && /bidi === "plaintext"/.test(livejs) &&
      !/one\(a\.composerEditor\)/.test(livejs) && probe.includes("bidi: s.unicodeBidi"),
    JSON.stringify({ editorOk: /editorOk\(a\.composerEditor\)/.test(livejs), bidiInProbe: probe.includes("bidi: s.unicodeBidi") }));
  /* And the fixture has to keep containing the surfaces, or these rows quietly degrade to
     "never measured" forever — the exact blind spot that hid the batch-8 defect. */
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures", "chat.html"), "utf8");
  check("the fixture carries the panel and a Latin placeholder",
    fixture.includes("data-task-monitor-fixed-panel") && /id="t-mon-fa"/.test(fixture) && /id="t-mon-en"/.test(fixture) &&
      /data-chat-composer-placeholder[^>]*>[\s\S]{0,80}Continue this task/.test(fixture),
    JSON.stringify({ panel: fixture.includes("data-task-monitor-fixed-panel"), ghost: /Continue this task/.test(fixture) }));

  /* A slider probe that drives a control to the value it already holds moves nothing, and the
     audit line then blames the patch. Seen live on 0.4.2: the user's own leading was exactly
     the probe's constant, so the line failed while the feature worked. */
  check("the slider probe picks targets away from the user's own values",
    /var apart = function \(current, preferred, step, lo, hi\)/.test(controls) &&
      /var probeLead = apart\(api\.config\.lineHeight, 2\.15, 0\.4, 1\.2, 2\.4\)/.test(controls) &&
      /api\.apply\(\{ lineHeight: probeLead, chatSize: probeChat \}\)/.test(controls) &&
      /api\.apply\(\{ codeSize: probeCode \}\)/.test(controls) &&
      !/api\.apply\(\{ lineHeight: 2\.15/.test(controls) && !/codeSize: 6 \}\)/.test(controls),
    (controls.match(/var probe\w+ = apart\([^\n]*/) || ["no computed probe targets"]).join(" ; "));

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
