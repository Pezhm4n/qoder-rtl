"use strict";

/* Minimal Chrome DevTools Protocol client: one browser WebSocket connection,
   flat (multiplexed) sessions, no dependencies beyond Node's built-in
   WebSocket (Node >= 22), fetch, net and child_process. */

const net = require("node:net");
const { execSync } = require("node:child_process");

class Connection {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.onclosed = null;
  }

  static async open(url) {
    if (!globalThis.WebSocket) throw new Error(`No global WebSocket in ${process.version} (need Node 22+)`);
    const conn = new Connection(url);
    await conn._connect();
    return conn;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const ws = new globalThis.WebSocket(this.url);
      let settled = false;
      const timer = setTimeout(() => fail(new Error("CDP WebSocket handshake timed out")), 8000);

      function fail(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch (e) {}
        reject(err);
      }

      ws.addEventListener("open", () => {
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.addEventListener("error", () => fail(new Error("CDP WebSocket connection failed")));
      ws.addEventListener("close", () => {
        for (const { reject: r } of this.pending.values()) r(new Error("CDP connection closed"));
        this.pending.clear();
        if (!settled) fail(new Error("CDP connection closed before opening"));
        else if (this.onclosed) this.onclosed();
      });
      ws.addEventListener("message", (evt) => this._receive(evt.data));
    });
  }

  _receive(data) {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch (e) {
      return;
    }
    if (msg.id != null) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
      else entry.resolve(msg.result);
      return;
    }
    for (const l of [...this.listeners]) {
      try {
        if (l.test(msg)) l.handler(msg);
      } catch (e) {
        /* one bad listener must never take down the socket */
      }
    }
  }

  send(method, params = {}, sessionId, timeoutMs = 20000) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error("CDP connection is not open"));
    const id = this.nextId++;
    const payload = { id, method };
    if (params && Object.keys(params).length) payload.params = params;
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      /* A target that never answers (hidden window, unrendered document) must not
         wedge the whole injector, so every call is bounded. */
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  /* on("Target.targetCreated", fn) or on(msg => ..., fn); returns an unsubscribe. */
  on(match, handler) {
    const test = typeof match === "function" ? match : (msg) => msg.method === match;
    const entry = { test, handler };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  close() {
    try {
      this.ws && this.ws.close();
    } catch (e) {}
    this.ws = null;
  }
}

function httpJson(port, path, timeout = 4000) {
  return fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeout) }).then(async (res) => {
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return res.json();
  });
}

async function browserEndpoint(port) {
  const info = await httpJson(port, "/json/version");
  if (!info.webSocketDebuggerUrl) throw new Error("/json/version returned no webSocketDebuggerUrl");
  return info.webSocketDebuggerUrl;
}

function portIsOpen(port) {
  return browserEndpoint(port).then(() => true, () => false);
}

/* ---------- what a port actually is doing ---------- */

/* "Nothing answered the port" has three causes that need three different answers: the
   port is free (launch), a running process holds it (pick another port or close that
   app), or the process that held it has already exited and its socket is still LISTENING
   (only a full quit or a reboot clears it). A failed connect cannot tell them apart, and
   one run that guessed produced a false diagnosis in the README, so ask the OS. */

function tryBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (err) => {
      srv.close();
      resolve({ ok: false, code: String(err.code || err.message) });
    });
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve({ ok: true }));
    });
  });
}

/* Netstat's table is stable enough to parse by columns; a line we cannot read is
   skipped rather than guessed at, and the caller reports owner=unknown. */
function parseNetstatListeners(text, port) {
  const owners = [];
  for (const line of String(text).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || f[0].toUpperCase() !== "TCP") continue;
    if (!f[1].endsWith(`:${port}`)) continue;
    if (f[3].toUpperCase() !== "LISTENING") continue;
    const pid = Number(f[4]);
    if (Number.isInteger(pid)) owners.push({ local: f[1], pid });
  }
  return owners;
}

function queryText(cmd) {
  try {
    return { text: execSync(cmd, { encoding: "utf8", timeout: 8000, windowsHide: true }) };
  } catch (e) {
    return { error: e.message.split("\n")[0] };
  }
}

function portOwners(port) {
  /* The port reaches a command line below, so it must be a plain number by here. */
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { error: `not a port number: ${port}` };
  if (process.platform === "win32") {
    const q = queryText("netstat -ano -p tcp");
    if (q.error) return { error: q.error };
    return { owners: parseNetstatListeners(q.text, p) };
  }
  const q = queryText(`lsof -nP -iTCP:${p} -sTCP:LISTEN -t`);
  if (q.error) return { error: q.error };
  return {
    owners: q.text
      .split(/\r?\n/)
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
      .map((pid) => ({ local: `127.0.0.1:${p}`, pid }))
  };
}

/* Returns { alive, name } — never a bare false, because "tasklist is missing" must not
   read as "the process is gone". */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: null, error: `not a pid: ${pid}` };
  if (process.platform === "win32") {
    const q = queryText(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`);
    if (q.error) return { alive: null, error: q.error };
    const line = q.text.split(/\r?\n/).find((l) => l.includes(`,"${pid}",`));
    if (!line) return { alive: false };
    return { alive: true, name: (line.match(/^"([^"]*)"/) || [, ""])[1] };
  }
  try {
    process.kill(pid, 0);
    return { alive: true };
  } catch (e) {
    if (e.code === "ESRCH") return { alive: false };
    if (e.code === "EPERM") return { alive: true };
    return { alive: null, error: e.message.split("\n")[0] };
  }
}

async function portState(port) {
  try {
    return { port, state: "serving", endpoint: await browserEndpoint(port) };
  } catch (e) {
    /* not a DevTools endpoint — now find out why */
  }
  const bind = await tryBind(port);
  if (bind.ok) return { port, state: "free" };
  if (bind.code !== "EADDRINUSE") return { port, state: "blocked", reason: bind.code };

  const owners = portOwners(port);
  if (owners.error) return { port, state: "occupied", owner: "unknown", probeError: owners.error };
  const first = owners.owners[0];
  if (!first) return { port, state: "occupied", owner: "unknown", note: "no LISTENING row for this port" };
  const who = processAlive(first.pid);
  return {
    port,
    state: "occupied",
    owner: who.alive === false ? "exited" : who.alive === true ? "running" : "unknown",
    ownerPid: first.pid,
    ownerName: who.name || null,
    ownerCount: owners.owners.length,
    ...(who.error ? { probeError: who.error } : {})
  };
}

/* One line of plain observation per state, shared by live.js and `status` so the two
   can never drift into describing the same port differently. ASCII only: this reaches
   the console, and cmd's codepage mangles anything else. */
function describePort(s) {
  switch (s.state) {
    case "serving":
      return `serving DevTools on ${s.port}`;
    case "free":
      return `nothing is listening on ${s.port}, it is free to bind`;
    case "blocked":
      return `${s.port} cannot be bound by this process (${s.reason})`;
    case "occupied":
      if (s.owner === "exited")
        return `${s.port} is still held by PID ${s.ownerPid}, which has exited - an orphan socket, so no new Qoder can bind it`;
      if (s.owner === "running")
        return `${s.port} is held by PID ${s.ownerPid}${s.ownerName ? ` (${s.ownerName})` : ""}, which is running`;
      return `${s.port} is in use${s.ownerPid ? ` (PID ${s.ownerPid})` : ""} - the owner could not be identified${s.probeError ? `: ${s.probeError}` : ""}`;
    default:
      return `${s.port}: unrecognised probe result ${JSON.stringify(s)}`;
  }
}

/* What the observations allow us to say, and what they do not. Never "this build ignores
   the flag": that sentence was printed once against a machine where the real cause was an
   orphan socket, and it made a working route look impossible. */
function adviceFor(s) {
  if (s.state === "serving") return `${s.port} is answering DevTools already - run a check, nothing to fix.`;
  if (s.owner === "exited")
    return `Quit Qoder completely (every window and its tray icon) - that releases the socket. If every Qoder process is already gone, only a reboot clears an orphan listener. Another port works right now: --port 9333.`;
  if (s.owner === "running")
    return `PID ${s.ownerPid}${s.ownerName ? ` (${s.ownerName})` : ""} is holding ${s.port}. Close it, or use another port: --port 9333.`;
  if (s.state === "free")
    return "Nothing holds the port, so the copy this command started never opened it. The usual cause is Qoder's single-instance lock: a fresh start hands off to an already-running copy that has no debug port. Quit Qoder completely and run this again.";
  if (s.state === "blocked") return `This process may not bind ${s.port} (${s.reason}). Try a port above 1024: --port 9333.`;
  return `Who owns ${s.port} could not be identified${s.probeError ? ` (${s.probeError})` : ""}, so no cause is claimed here.`;
}

/* The one precedence for the debug port: an explicit flag wins, then QODER_RTL_PORT,
   then 9222. Both cli.js and live.js take their default from here. */
function defaultPort() {
  const n = Number(process.env.QODER_RTL_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 9222;
}

module.exports = {
  Connection,
  browserEndpoint,
  httpJson,
  portIsOpen,
  portState,
  describePort,
  adviceFor,
  processAlive,
  defaultPort,
  parseNetstatListeners
};
