# Contributing

Thanks for looking under the hood. This project is small, but it has a few rules that came
out of real bugs — reading them first will save you a round-trip.

## Layout

```
cli.js            the qoder-rtl command surface (start/check/diagnose/status/list/launcher)
live.js           the CDP engine: attach, inject, probe, watch
lib/cdp.js        connection + the truth about the debug port (portState, describePort)
lib/payload.js    builds the injectable source and the read-only probes
patches/rtl.css   the runtime stylesheet (the rules that must win)
patches/rtl.js    the runtime: classifier, settings panel, shortcuts, self-heal
index.js          the legacy app.asar route (gated behind `patch --yes`)
test/             offline checks + a headless end-to-end suite
docs/REPORT.md    the audit history: what was measured, what was disproven, what is unverified
```

## Running the tests

```bash
npm test                 # 176 offline checks — no browser, no Qoder needed
npm run test:browser     # 74 end-to-end checks against headless Chromium
node cli.js check        # 16 lines against a real Qoder window (needs the debug port)
node cli.js diagnose     # read-only: what each block actually computed
```

`test:browser` picks a DevTools port and refuses to run on one that is already serving
DevTools — it only ever kills browsers it started itself. Pass your own if 9333 is taken:

```bash
node test/browser.js --port 9411
```

## The rules that came from bugs

### 1. A check that passes on broken code is not a check

Every new assertion must be run against the **previous** version and go red there.

- If the previous state is committed (`HEAD` is exactly the tree you replaced), use a throwaway
  worktree: `git worktree add ../qrt-base HEAD`, copy the *new* tests into it, run them, remove
  it.
- If the baseline you replaced is uncommitted, a worktree builds from an older tree and proves
  nothing — copy the working tree instead (minus `node_modules`) and run it with `NODE_PATH`
  pointed at the real `node_modules`.
- Mutate the *behaviour*, not just delete code, and prefer a functional control over a grep.
- Windows: `git worktree remove --force` can fail on a directory lock after a browser you
  killed still holds it; git de-registers the worktree first, so deleting the folder is safe.

### 2. One element, one owner; one list, two consumers

Any block the stylesheet pins RTL must **also** be classifiable (`BLOCK_SELECTOR`) and stamped
for leading (`LEAD_SELECTOR`). Half of it is a real bug class we have hit three times: an
RTL-pinned block nobody ever judged showed right-aligned English. `test/live.js` compares the
two lists element by element — checking each list on its own stays green.

### 3. Patch the element, not only its descendants

For any hook Qoder puts on prose, ask whether the text can live **on** that node. The human
turn does exactly that (one `whitespace-pre-wrap` div, no `<p>`), which is why every
descendant-only rule walked past it.

### 4. Measure geometry, don't infer it

`unicode-bidi: plaintext` takes a block's base direction from its content, so a `direction`
override can move nothing; `text-align: start` on an RTL element already means right. Claims
about *where something appears* need rendered rects (`getBoundingClientRect`, per-character
`Range` rects), not computed style — and never from a screenshot alone.

### 5. Report "could not measure", never "works"

An audit line whose probe found no matching DOM returns `UNSURE` (`pass: null`), not PASS. A
failed probe is never read as a real zero, and an unreadable system command is an error, not
"nothing is running".

### 6. `zoom` confounds everything inside its subtree

"Chat text size" scales the whole message, so a probe that drives it together with the code
size slider can green a dead slider. The code-size line drives `codeSize` **alone**.

### 7. Bump the payload version when a change must reach a live document

The runtime no-ops when the version already in the page matches. `package.json` and
`CHANGELOG.md` move with it, and remember they are two different numbers.

## Scope: what we deliberately do not patch

- **App chrome** — menus, sidebar conversation titles, the window header. They stay LTR so the
  app still looks like the app.
- **The `.md` preview pane** — measured unreachable over CDP on this build; see `docs/REPORT.md`.
- **The Qoder installation** — no file writes, no signed binaries, no killing a running app.

A change that reaches a new surface needs, in one commit: the six CSS rule groups it belongs
to, both runtime lists, a probe that measures it, an audit line that refuses to pass
unmeasured, and fixture markup that contains it (a fixture cannot catch what it does not
hold).

## Commit style

[Conventional Commits](https://www.conventionalcommits.org/), subject in plain language about
what the user sees fixed, and a body that lists the changes with `-`. Say what was **not**
verified in the same commit as what was — several bugs here were reported by the owner before
the harness could see them, and that belongs in the history too.

## Before opening a PR

```bash
npm test && npm run test:browser
```

Both green, plus the red-first evidence for anything new (paste the red output into the PR
description). If a change touches the payload, note the payload version in the PR title.
