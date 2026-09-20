"use strict";

/* Minimal Chrome DevTools Protocol client: one browser WebSocket connection,
   flat (multiplexed) sessions, no dependencies beyond Node's built-in
   WebSocket (Node >= 22) and fetch. */

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

module.exports = { Connection, browserEndpoint, httpJson, portIsOpen };
