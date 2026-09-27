<div align="center">

<img src="./docs/images/qoder.webp" alt="Qoder logo" width="88" height="88">

# Qoder Persian RTL

**Read and write Persian and Arabic in the Qoder desktop chat — without touching a single installed file, without breaking auto-updates, and with Vazirmatn bundled offline.**

[![npm](https://img.shields.io/npm/v/qoder-rtl?style=flat-square&label=npm&labelColor=1f2328&color=0d7a5f)](https://www.npmjs.com/package/qoder-rtl)
[![downloads](https://img.shields.io/npm/dm/qoder-rtl?style=flat-square&label=downloads&labelColor=1f2328&color=2f6feb)](https://www.npmjs.com/package/qoder-rtl)
![node](https://img.shields.io/badge/node-%E2%89%A5%2022-339933?style=flat-square&labelColor=1f2328&logo=node.js&logoColor=white)
[![license](https://img.shields.io/badge/license-MIT-red?style=flat-square&labelColor=1f2328)](./LICENSE)
![tested](https://img.shields.io/badge/tested%20on-Qoder%200.4.2%20%C2%B7%20Windows%2010-6f42c1?style=flat-square&labelColor=1f2328)

[Install](#install) · [Features](#features) · [Troubleshooting](#troubleshooting) · [What stays LTR](#scope) · [فارسی](./README.md) · [Technical report](./docs/REPORT.md)

</div>

| Before: Persian left-aligned, system font, code and prose fighting | After: right-aligned, Vazirmatn, code still left-to-right |
| :---: | :---: |
| ![Before the patch](./docs/images/before.png) | ![After the patch](./docs/images/after.png) |

The patched Qoder window with the settings panel open

![The patched Qoder window with the settings panel open](./docs/images/sample-photo.jpg)

Qoder — like most Electron apps — takes text direction from the **interface language**, not from the language you are typing in. So Persian lands left-aligned in the chat, parentheses and punctuation jump sides, and `Persian next to code` scrambles. This tool fixes exactly that, **in the chat and the composer only**; the rest of the app keeps its original look.

<a id="features"></a>
## Features

- **Per-block direction, decided by the text itself.** A Persian sentence that happens to start with a Latin identifier stays right-aligned. Force-RTL and off modes are both available.
- **Inside the composer, every line keeps its own direction.** One English word in a Persian message does not left-align the whole input — that line goes left, the rest stays right. Measured from per-line geometry, not from a computed style.
- **Code, terminals and file paths stay left-to-right** — even inside a fully Persian message, in the app's own monospace font.
- **Vazirmatn ships inside the tool** and is registered from inlined bytes: no download, no font installed on your system, works offline. The font is registered through the `FontFace` API, so a strict `font-src` policy cannot block it.
- **Your own messages follow the patch too**, not only the assistant's replies — the human turn is rendered differently by Qoder and needed its own rules.
- **A floating settings panel** at the bottom-right of the window, plus `Alt+R` (direction) and `Alt+Shift+R` (show/hide the panel): chat text size, code font size, line height, RTL tables and reversed columns, and separate fonts for Persian / Latin / code — plus a "Star on GitHub" row pinned to the panel's bottom. With the panel closed it swallows nothing: clicks in its area reach Qoder itself.
- **Nothing is written into the Qoder install.** The patch is injected into the running renderer over the DevTools protocol, so an automatic Qoder update cannot wipe it and no signed file is touched.

<a id="scope"></a>
## What is **not** patched (and why)

- **App chrome** — menus, the sidebar's conversation titles, the window header, buttons. Left LTR on purpose, so the app still looks like the app.
- **The `.md` file preview in the right-hand panel.** Measured, not assumed: that pane is not in the chat document, the only other DevTools target answers none of `Page`, `Runtime` or `DOM`, and Qoder exposes no custom-CSS setting for it. No CSS rule of ours can reach it.
- **Nothing on disk.** Unlike `app.asar` patchers, no file is rewritten, backed up or re-signed.

---

<a id="install"></a>
## Install

**Prerequisite:** [Node.js](https://nodejs.org/) 22 or newer. No clone, no `npm install`.

### 1) Quit Qoder completely

Qoder enforces a single instance: if it is already running, a fresh launch hands off to that copy and the debug-port flag is **dropped** — so the patch never lands. Quit it from the tray as well. This tool never kills a running Qoder.

### 2) One command

```powershell
npx qoder-rtl
```

Qoder starts and the patch is injected into every window. Keep the terminal open: while it runs, new windows are patched automatically. `Ctrl+C` (or closing it) hands the window back to stock Qoder.

> If `npx` returns a 404, no version has been published to npm yet: clone this repository, run `npm install`, and use `node cli.js` instead.

### 3) Confirm it actually landed

```powershell
npx qoder-rtl check
```

Fifteen `PASS/FAIL` lines, most of them **measurements of rendered output** (the computed font of a real paragraph, its line height, whether reversing columns moved a column, how far the panel sits from the window edge) rather than "does a file exist". A line that reports `UNSURE` means that feature had nothing on screen to measure — not that it works.

<a id="rerun"></a>
> **Re-run it after every Qoder start.** That is inherent to live injection: nothing is written to disk, so nothing survives a restart. Want a double-click instead? `npx qoder-rtl launcher` writes one `Qoder-RTL.cmd` (`remove-launcher` deletes it).

---

<a id="commands"></a>
## Commands

| Command | What it does |
|---|---|
| `qoder-rtl` (no argument) | Connect or launch, inject, and keep the patch alive until `Ctrl+C` |
| `qoder-rtl check` | Inject + the sixteen-line audit + a log file in `%LOCALAPPDATA%\qoder-persian-rtl\cdp-test.log` |
| `qoder-rtl diagnose` | Read-only: what every text block actually **computed** to — the answer to "why is this line not RTL?" |
| `qoder-rtl status` | Tool and payload version, Qoder version, and what the debug port really reports |
| `qoder-rtl list` | The windows and targets DevTools can see |
| `qoder-rtl launcher` / `remove-launcher` | Create or delete `Qoder-RTL.cmd` — the only file this tool ever writes outside its log folder |
| `qoder-rtl patch --yes` | ⚠️ The legacy `app.asar` route. **Does not work on Qoder 0.3.3** and refuses to run without `--yes` |

<a id="shortcuts"></a>
## Shortcuts and the panel

| Key | Action |
|---|---|
| `Alt+R` | Toggle direction (every Qoder window stays in sync) |
| `Alt+Shift+R` | Show or hide the settings button |
| `Escape` | Close the panel and return focus to the button |

The panel opens on **click** (hovering the corner does nothing), sits at the bottom-right so it never covers the answer you are reading, and syncs its settings across windows.

---

<a id="troubleshooting"></a>
## Troubleshooting

Run `qoder-rtl status` first — it asks Windows directly which of these four states you are in:

| What you see | Meaning | Fix |
|---|---|---|
| `serving DevTools` | Ready | If the patch is missing anyway, run `check` and read the `FAIL` lines |
| `free` | Qoder is running without the debug flag | Quit Qoder completely, then run the tool again |
| `held by PID … (running)` | Another program owns the port | Use another port: `--port 9333` or `QODER_RTL_PORT=9333` |
| `held by PID … (exited)` | Orphan socket — the owner is gone but the socket stayed | Quit Qoder fully (tray included) or reboot. Nothing is killed for you |

**Text is not RTL but `check` is green?** The window had no conversation rendered at that moment (`hooks=0`). Open a chat and run `check` again. **Second window never patched?** If its line says `still being attached`, that window has not painted yet; re-run a few seconds later. **After a Qoder update?** Nothing to redo — the patch was never on disk for the updater to replace; just run the command again.

<a id="security"></a>
## Security note

This route opens a loopback DevTools port (`127.0.0.1:9222`) that **any local process can drive**. It closes with the app; do not leave it running on a shared machine. Details in [SECURITY.md](./SECURITY.md).

---

<a id="why-not-asar"></a>
## Why the `app.asar` route is not the default

Because on Qoder 0.3.3 it bricked the app: `EnableEmbeddedAsarIntegrityValidation` is on and `Qoder.exe` carries an `ELECTRONASAR` resource pinning the archive's SHA256, so any rewritten archive means "the app refuses to start". The only way past that is modifying a signed binary, which we did not do and do not recommend. Live injection exists for precisely this reason. The full history of that decision — and every measurement behind each claim — is in [docs/REPORT.md](./docs/REPORT.md).

<a id="verification"></a>
## Verification

- `npm test` → **202** offline checks (payload shape, CLI behaviour and gates, README guards, staged-archive audit)
- `npm run test:browser` → **74** end-to-end checks against headless Chromium, including real mouse and keyboard events, rendered-geometry measurements and a hit-test of the closed panel
- `node cli.js check` → **16** lines on a real Qoder window

Every new assertion is proven **red against the previous version** before it is trusted: a check that passes on broken code is not a check.

<a id="contributing"></a>
## Contributing

Test commands, the red-first rule and the scope boundaries (what we deliberately do not patch) are written down in [CONTRIBUTING.md](./CONTRIBUTING.md). Bug reports are welcome — if the report says "this place is not right-aligned", a screenshot of that moment is worth more than a description.

## License

- The tool: MIT — see [LICENSE](./LICENSE)
- The bundled Vazirmatn font: SIL Open Font License 1.1 — see [`assets/OFL.txt`](./assets/OFL.txt) and the [Vazirmatn project](https://github.com/rastikerdar/vazirmatn)

<div align="center">

[← نسخهٔ فارسی](./README.md)

<br>

<img alt="built in Iran" src="https://img.shields.io/badge/built_in-Iran-2f7d3b?style=flat-square&labelColor=1f2328">

</div>
