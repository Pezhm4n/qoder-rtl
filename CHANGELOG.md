# Changelog

All notable changes to **qoder-rtl** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the package version follows
[Semantic Versioning](https://semver.org/).

Two version numbers exist and they are **not** the same thing:

- **package** — `package.json`, what `npx` downloads.
- **payload** — the code injected into Qoder's renderer (`patches/rtl.js`). It is bumped
  deliberately, because the runtime refuses to re-inject when the version already in the
  document matches.

Package 1.4.0 – 1.7.0 were never released: payloads 1.4.0–1.8.0 all shipped together in
package 1.8.0.

## [1.11.4] - 2026-09-27

Payload **1.8.5**.

### Fixed
- **A Persian paragraph that opens with a Latin name now reads right-to-left.** Reported on
  a live reply: the Persian body of an answer was right-aligned but its words still ran
  left-to-right, so the sentence opened with `Qoder Persian RTL` and ended with the verb.
  The classifier had been right all along — the block got `.qrt-fa`, `direction: rtl` and
  `text-align: right` — but the base rule left `unicode-bidi: plaintext` on it, and under
  UAX #9 rule P2 plaintext takes the paragraph's base level from its **first strong
  character** and ignores `direction` for that decision. A Latin first word therefore set the
  whole paragraph LTR, whatever the verdict said. Both smart-mode classes now carry
  `unicode-bidi: isolate`, which hands the paragraph level back to `direction`; force mode
  gets the same treatment for prose (its composer is left on per-line plaintext on purpose).
  The composer's editor is unchanged: it holds several hard lines and has no verdict of its
  own. This is the case the README has promised since 1.0 and never measured.
- **Why 52 browser checks missed it:** every one of them read `getComputedStyle`, and
  `direction` really was `rtl`. The new checks measure geometry instead — the rectangle of a
  block's leading word against its trailing word — which is the only probe that can tell a
  right-aligned LTR paragraph from an RTL one. Two fixture paragraphs were added for it, one
  short and one long with inline code in the opening position.

## [1.11.3] - 2026-09-27

Payload **1.8.4**.

### Fixed
- **The closed settings panel no longer eats clicks in its own area.** The widget is a
  fixed flex column that keeps the invisible (`opacity: 0`) panel in layout, so the
  container rectangle spanned the whole hidden panel and swallowed every click inside
  it — the app behind that corner was unclickable while nothing was on screen. The
  widget now refuses pointer events; the trigger opts back in always, the panel only
  while open. Proven by hit-testing (`elementFromPoint`) in the browser suite: closed,
  the panel's centre resolves to the app; open, to the panel.

### Added
- **Colour in the terminal log.** The start banner, the watch hints and the
  PASS/FAIL/UNSURE verdicts are painted with the usual console meanings (green =
  worked, red = did not, yellow = unjudged, cyan = values, gray = hints, bold =
  section names) by a new zero-dependency `lib/term.js`. A pipe, `NO_COLOR=1` or a
  redirected file get the plain string; `FORCE_COLOR=1` forces colour. Log files
  (`cdp-test.log`, `cdp-diagnose.log`) are always written plain.
- **A "Star on GitHub" row at the bottom of the settings panel** — a real anchor to
  the repository named in `package.json`, opened with `target="_blank"`. It is pinned to the
  panel's bottom edge (`position: sticky`) because the panel scrolls: as the last row it sat
  below the fold on a short window (measured: content 443 px in a 401 px scrollport).

### Documentation
- **The Qoder logo now heads both READMEs**, so it is obvious which app the tool is for.
- **Every nav anchor in `README.md` was wrapped in backticks**, so GitHub printed the literal
  text `<a id="install"></a>` and none of the nav links jumped anywhere. Four checks now guard
  both READMEs: no fenced anchors, every `(#anchor)` resolves, and every referenced picture
  exists and ships.
- **The README pictures ship inside the npm tarball** (`docs/images` was absent from
  `package.json` `files`, so the npm page rendered broken images): 175.8 kB → 280.0 kB, 22 files.

## [1.11.2] - 2026-09-26

Payload unchanged (1.8.3). This is a fix to the audit itself.

### Fixed
- `check` no longer reports a false FAIL on **panel sliders change the prose when applied**.
  The controls probe drove `lineHeight` to a hard-coded 2.15, so a user whose own leading
  already *is* 2.15 got a zero-delta measurement — seen live on Qoder 0.4.2, where the line
  failed while the slider worked. The probe now picks a target at least 0.25 away from the
  user's value, inside the panel's real bounds, and reports the values it used.

### Verified
- First live run against **Qoder 0.4.2** (the app auto-updated from 0.3.3): **15/15 PASS**,
  with the DOM anchors intact (`turn`, `messageText`, `userBubble`, `composer`,
  `data-task-monitor-fixed-panel` all reachable), the human bubble at `qrt-fa rtl/right`,
  the placeholder at `qrt-en ltr/left`, and the composer box reading `editor=rtl/per-line`.

## [1.11.1] - 2026-09-26

Payload **1.8.3**.

### Fixed
- **The chat input no longer flips to LTR over one Latin letter.** 1.11.0 gave the composer's
  editor a block-level language verdict; measured on the fixture, typing a single `p` turned
  the whole box `ltr/left`, and a Persian-English-Persian input right-aligned the English line
  too. The editor now carries **no** verdict: it keeps `direction: rtl` with
  `unicode-bidi: plaintext`, which gives **each hard line** its own base direction — the English
  line lays out and aligns left while the Persian lines stay right (asserted from per-line
  geometry, not from a computed style).
- The ghost placeholder keeps its own verdict — that half of 1.11.0 was correct and stays.

### Changed
- The npm package is named **`qoder-rtl`**, matching the repository
  (`github.com/Pezhm4n/qoder-rtl`) and the shorter `npx qoder-rtl`. The `qoder-persian-rtl` bin
  still works after install, and the tool's data folder keeps its existing name
  (`%LOCALAPPDATA%\qoder-persian-rtl`), so logs and settings do not move.
- The fifteenth audit line scores the editor on `rtl` + per-line plaintext instead of on a
  direction class, and prints `editor=rtl/per-line`.

## [1.11.0] - 2026-09-26

Payload **1.8.2**.

### Added
- The agent's **task-monitor panel** (`[data-task-monitor-fixed-panel]`) is now patched: it
  carried Persian prose at `direction: ltr` because it sits outside every chat anchor.
- The composer's editor and its ghost placeholder each get their **own language verdict**, so
  an English placeholder is no longer right-aligned.
- A fifteenth `--check` line scoring those surfaces, reporting `UNSURE` when the panel is
  closed and no composer is rendered.

### Fixed
- `status` no longer prints launch-failure advice for a launch it never performed. The
  read-only form now says the port is free, that `check` only connects to an already-running
  Qoder, and points at `start`; the engine's post-launch failure path keeps the old wording,
  because there the sentence is true.
- Panel anchoring is measured against `clientWidth/clientHeight` instead of
  `innerWidth/innerHeight`: a `position: fixed` element is laid out against the
  scrollbar-free box, so any scrolling page reported the 52 px inset as 67 px.
- The reported symptom «RTL is a mess while the agent is talking» — root-caused to the two
  surfaces above, **not** to streaming. Streaming prose was measured clean (131 growing
  `<p>` samples, all RTL, zero verdict flips).

### Not changed
- Sidebar conversation titles and the header title stay LTR (app chrome, by design).
- The `.md` preview pane is unreachable over CDP on this build; measured and documented
  rather than claimed as fixed.

## [1.10.0] - 2026-09-21

Payload **1.8.1**.

### Added
- **Your own messages follow the patch.** Qoder renders the human turn as one
  `whitespace-pre-wrap` div with no `<p>` inside, so every descendant-only rule and the
  classifier passed it by. The bubble selector now sits in all six CSS rule groups plus
  `BLOCK_SELECTOR` and `LEAD_SELECTOR`.
- A fourteenth `--check` line that measures the bubble's computed direction, alignment,
  class and leading stamp — and says `UNSURE` when a conversation holds no user message.
- Two user bubbles in the browser fixture (one Persian, one English) plus a check that pins
  the fixture's own premise, so the harness cannot silently stop proving anything.

## [1.9.0] - 2026-09-21

Payload unchanged (1.8.0). This release is about how the tool is reached and how honest its
failure output is.

### Added
- A `qoder-rtl` bin and `cli.js` wrapping the engine, so `npx qoder-rtl` is one
  command: `start`, `check`, `diagnose`, `list`, `status`, `launcher`, `remove-launcher`.
- **Zero dependencies on the CDP path** — `@electron/asar` moved to `devDependencies`, so
  what is downloaded is the package, not 6.8 MB of `node_modules`.
- `portState()` asks Windows what the debug port really reports: serving / free / held by a
  running PID / held by an already-exited PID (an orphan socket), and a failed launch now
  prints the port state, the process count and Qoder's own `DevToolsActivePort` timestamp.
- A single `defaultPort()` (`--port`, then `QODER_RTL_PORT`, then 9222) shared by `status`
  and the engine.

### Changed
- The `.cmd` launcher became **opt-in** (`qoder-rtl launcher`), and `remove-launcher` deletes
  only what this tool wrote.
- `patch` refuses to touch the install without `--yes` and prints why.
- `require()`ing the package no longer boots an injector (`main` points at `live.js`, which
  used to self-run on load).

### Removed
- The sentence "this build ignores `--remote-debugging-port`" from `start`'s output — a
  verdict that measurement had already disproven.

## [1.8.0] - 2026-09-21

Payloads **1.4.0 → 1.8.0** in one release (five audit batches). Highlights:

### Added
- Per-block direction marks both ways (`.qrt-fa` **and** `.qrt-en`), so a Latin block can no
  longer sit under the base RTL rule as right-aligned English.
- `figcaption` / `summary` classification, and the tables switch now owns **all** table
  furniture — the old split left cell text right-aligned while columns went back to LTR.
- A self-heal for the injected `<style>` nodes: if the renderer rebuilds `<head>`, the custom
  properties come back instead of silently dropping the font, the zoom and the leading.
- The code-size slider works by **scaling** (`zoom`) instead of declaring a font size, which
  Qoder's own `12px !important` always out-weighted.
- Windows that never answer are counted and reported as `NOT PATCHED`, and a watching
  injector retries them.

### Fixed
- Every declaration in the runtime's vars sheet became `!important`, so winning no longer
  depends on which injected sheet happens to be later in `<head>` — the repair path used to
  replace the user's own text size and typed font with defaults.
- The composer's ghost-text overlay is styled with the editor under it.
- Reversing table columns really reverses them (the old rule re-declared `direction: rtl` on
  an already-RTL table and moved nothing).

## [1.3.0] - 2026-09-21

### Changed
- The settings panel opens on **click only**; hovering the corner used to pop it open.
  Outside-click and `Escape` close it, a closed panel is `inert`, and the trigger became a
  34 px inline SVG icon instead of a lone «ا» glyph.
- Direction state is carried on `data-qrt-*` attributes rather than classes, because Qoder's
  renderer owns `<html class>`.

## [1.2.2] - 2026-09-20

### Fixed
- The panel sliders reach the prose: Qoder puts Tailwind-style utilities on the text elements
  themselves and pins `line-height: 24px !important`, so the winning declarations are repeated
  on those elements and the leading is stamped inline.
- The trigger moved to `52px` from the right edge, clear of Qoder's own 28 px corner button.

## [1.1.0] - 2026-09-20

### Fixed
- Vazirmatn reaches the prose (it was registered but never applied), and the settings panel
  survives the live app. Verified on real Qoder 0.3.3: 12/12 audit lines.

## 1.0.0 - 2026-09-20

### Added
- CDP live injection as the working route (`live.js`), after the `app.asar` route proved
  unstartable on this build. The archive patcher is kept behind an explicit command, with
  backup and `--restore`.
