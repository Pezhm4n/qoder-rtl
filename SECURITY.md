# Security Policy

## What this tool does to your machine

`qoder-rtl` runs **one** command that changes anything, and by default it changes
nothing on disk:

| Action | Default route (`npx qoder-rtl`) |
|---|---|
| Write into the Qoder installation | **Never** |
| Modify a signed binary | **Never** |
| Rewrite `app.asar` | Only with `qoder-rtl patch --yes`, which refuses on Qoder 0.3.3 and explains why |
| Write files | Its own log in `%LOCALAPPDATA%\qoder-persian-rtl\`, plus `Qoder-RTL.cmd` **only if** you ask for the launcher |
| Kill or restart a running Qoder | **Never** |
| Network access | Loopback only (`127.0.0.1`) |

The patch lives in the running renderer's memory. Closing the injector or Qoder removes it,
which is also why it has to be re-applied after every Qoder start.

## The debug port is the real risk

To inject, Qoder must run with `--remote-debugging-port`. That opens a DevTools endpoint on
loopback that **any process running as your user can drive** — read the app's DOM, evaluate
JavaScript in it, and read whatever that window can see (your prompts, file paths, and any
token the app holds in memory).

Practical consequences:

- **Do not leave it running on a shared or untrusted machine.** Close Qoder when you are done;
  the port dies with it.
- **Do not expose it.** It binds loopback; do not port-forward, proxy or firewall-open 9222.
- **Prefer a non-default port** if other local developer tools might bind 9222 first:
  `--port 9333` or `QODER_RTL_PORT=9333`. `qoder-rtl status` tells you who owns a port before
  anything is launched.
- The tool **refuses to launch Qoder onto a port something already holds**, and distinguishes a
  live owner from an orphaned socket rather than guessing.

## Scope of the injected code

The payload is one self-contained script with no `eval`, no `new Function`, no network calls
and no storage beyond the tool's own `localStorage` keys (`qoder-rtl.*`) and the injected
`<style>` nodes. It reads and restyles the chat DOM; it does not read your files, your
prompts' contents beyond what it must measure, or anything outside the renderer it is injected
into.

## Known limitations worth knowing about

- A second Qoder window whose document never paints is reported as `NOT PATCHED` rather than
  patched — it is never touched during a run.
- The right-hand `.md` preview belongs to a renderer that answers no CDP command on this
  build, so this tool cannot style it. That is a limitation, not a silent failure: see
  `docs/REPORT.md`.

## Reporting a vulnerability

Open a [GitHub issue](https://github.com/Pezhm4n/qoder-rtl/issues) for anything
non-exploitable (a wrong alignment, a crash, a bad diagnosis). For a security issue you would
rather disclose privately, use [Report a vulnerability](https://github.com/Pezhm4n/qoder-rtl/security/advisories/new)
— GitHub's private advisory form — and include the output of `qoder-rtl status`, which prints
both version numbers.

Expect a first reply within a few days. Fixes ship as a patch version with a `CHANGELOG.md`
entry that says what was exploitable, not just what changed.
