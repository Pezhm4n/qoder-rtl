"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const CHUNK = 8 * 1024 * 1024;
const BLOCK_SIZE = 4 * 1024 * 1024; /* Electron's asar integrity block size */

function tmpRoot(tag) {
  const dir = path.join(os.tmpdir(), `qoder-rtl-${tag}-${crypto.randomBytes(6).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/*
 * Electron asar layout (nested Chromium Pickles, all little-endian).
 * The two framing fields are *payload sizes*, so the header is three levels:
 *
 *   0  u32 4                      sizePickle payload size
 *   4  u32 H                      sizePickle payload = length of the header pickle
 *   8  u32 (H - 4)                headerPickle payload size
 *   12 u32 jsonLen                JSON length, unpadded
 *   16 JSON, NUL padded to 4 bytes
 *
 * baseOffset = 8 + H, and file offsets in the JSON are relative to baseOffset,
 * so growing the header costs nothing: the body is copied verbatim and stays
 * addressed correctly.
 */
function readHeader(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const lead = Buffer.alloc(16);
    fs.readSync(fd, lead, 0, 16, 0);
    if (lead.readUInt32LE(0) !== 4) throw new Error("Not an Electron asar archive (bad pickle header)");
    const jsonLen = lead.readUInt32LE(12);
    if (jsonLen < 2 || jsonLen > 256 * 1024 * 1024) throw new Error(`Implausible asar header length: ${jsonLen}`);
    const body = Buffer.alloc(jsonLen);
    fs.readSync(fd, body, 0, jsonLen, 16);
    return { header: JSON.parse(body.toString("utf8")), baseOffset: 8 + lead.readUInt32LE(4), jsonLen };
  } finally {
    fs.closeSync(fd);
  }
}

/* Encodes the whole archive prefix (sizePickle + headerPickle), mirroring what
   @electron/asar's createFilesystemWriteStream puts on disk. */
function encodeHeader(header) {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4);
  json.copy(padded);

  const headerPayload = Buffer.alloc(4 + padded.length);
  headerPayload.writeUInt32LE(json.length, 0);
  padded.copy(headerPayload, 4);

  const out = Buffer.alloc(8 + 4 + headerPayload.length);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(headerPayload.length + 4, 4);
  out.writeUInt32LE(headerPayload.length, 8);
  headerPayload.copy(out, 12);
  return out;
}

function walk(node, prefix, out = []) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child, rel, out);
    else out.push({ rel, size: Number(child.size) || 0, unpacked: !!child.unpacked, offset: child.offset });
  }
  return out;
}

function integrityOf(data) {
  const blocks = [];
  for (let off = 0; off < data.length; off += BLOCK_SIZE) {
    blocks.push(crypto.createHash("SHA256").update(data.subarray(off, Math.min(off + BLOCK_SIZE, data.length))).digest("hex"));
  }
  if (!blocks.length) blocks.push(crypto.createHash("SHA256").update(data).digest("hex"));
  return { algorithm: "SHA256", hash: crypto.createHash("SHA256").update(data).digest("hex"), blockSize: BLOCK_SIZE, blocks };
}

function ensureDir(root, segments) {
  let node = root;
  for (const s of segments) {
    node.files = node.files || {};
    if (!node.files[s]) node.files[s] = { files: {} };
    if (!node.files[s].files) node.files[s] = { files: {} };
    node = node.files[s];
  }
  return node;
}

function dropNode(root, rel) {
  const parts = rel.split("/");
  const name = parts.pop();
  const parent = parts.reduce((n, s) => n && n.files && n.files[s], root);
  if (parent && parent.files && parent.files[name]) {
    delete parent.files[name];
    return true;
  }
  return false;
}

/*
 * Rewrites app.asar surgically: new header, byte-for-byte copy of the original
 * body, then the payload files appended. Nothing is expanded, so native modules
 * and the archive's pruned (unpacked-but-absent) entries are carried over as-is.
 */
function patchArchive(asarPath, outFile, additions) {
  const { header, baseOffset } = readHeader(asarPath);
  const stat = fs.statSync(asarPath);
  const bodySize = stat.size - baseOffset;
  if (bodySize <= 0) throw new Error("Corrupt archive: data section is empty");
  /* encodeHeader must agree byte-for-byte with the framing this reader parsed;
     a mismatch would silently misalign every offset in the rewritten archive. */
  if (encodeHeader(header).length !== baseOffset) {
    throw new Error("asar header framing changed since this patcher was written — refusing to rewrite the archive");
  }

  const out = fs.openSync(outFile, "w");
  const pass = (expectHeaderBytes) => {
    /* Offsets depend only on sizes, so the second pass must reproduce the
       exact header length the first pass reserved. */
    const rebuilt = structuredClone(header);
    let cursor = bodySize;
    const nodes = additions.map((a) => {
      const node = { size: a.data.length, offset: String(cursor), integrity: integrityOf(a.data) };
      cursor += a.data.length;
      return node;
    });
    additions.forEach((a, i) => {
      const parts = a.rel.split("/");
      const name = parts.pop();
      dropNode(rebuilt, a.rel);
      ensureDir(rebuilt, parts).files[name] = nodes[i];
    });

    const prefix = encodeHeader(rebuilt);
    if (expectHeaderBytes !== null && prefix.length !== expectHeaderBytes) {
      throw new Error(`asar header did not converge (${prefix.length} vs ${expectHeaderBytes})`);
    }

    fs.ftruncateSync(out, 0);
    let pos = fs.writeSync(out, prefix, 0, prefix.length, 0);
    const src = fs.openSync(asarPath, "r");
    try {
      const buf = Buffer.alloc(CHUNK);
      let left = bodySize;
      let from = baseOffset;
      while (left > 0) {
        const read = fs.readSync(src, buf, 0, Math.min(CHUNK, left), from);
        if (!read) throw new Error("Unexpected end of archive body");
        fs.writeSync(out, buf, 0, read, pos);
        pos += read;
        from += read;
        left -= read;
      }
    } finally {
      fs.closeSync(src);
    }
    for (const a of additions) {
      fs.writeSync(out, a.data, 0, a.data.length, pos);
      pos += a.data.length;
    }
    return prefix.length;
  };

  try {
    const bytes = pass(null);
    pass(bytes);
    return { headerBytes: bytes, bodySize, added: additions.map((a) => ({ rel: a.rel, size: a.data.length })), originalSize: stat.size };
  } finally {
    fs.closeSync(out);
  }
}

/* A system install lives in Program Files, so the final write may need UAC.
   Try the fast in-directory rename first; escalate only on a permission error. */
function swapInto(srcFile, targetFile) {
  const staging = targetFile + ".qoder-rtl-new";
  const denied = ["EACCES", "EPERM", "EBUSY"];
  try {
    fs.copyFileSync(srcFile, staging);
    fs.renameSync(staging, targetFile);
    return { elevated: false };
  } catch (e) {
    fs.rmSync(staging, { force: true });
    if (process.platform !== "win32" || !denied.includes(e.code)) throw e;
  }

  if (/['"]/.test(srcFile + targetFile)) {
    throw new Error(`Cannot elevate safely for paths containing quotes:\n  ${srcFile}\n  ${targetFile}\nRun again from an Administrator terminal.`);
  }
  const script = path.join(os.tmpdir(), `qoder-rtl-swap-${process.pid}.ps1`);
  fs.writeFileSync(script, `$ErrorActionPreference = "Stop"\nCopy-Item -LiteralPath '${srcFile}' -Destination '${targetFile}' -Force\n`, "utf8");
  try {
    const r = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        `Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${script}'`
      ],
      { stdio: "inherit", windowsHide: true }
    );
    if (r.status !== 0) throw new Error(`Elevated swap was cancelled or failed (exit ${r.status}). Run again from an Administrator terminal.`);
    if (fs.statSync(targetFile).size !== fs.statSync(srcFile).size) {
      throw new Error("Elevated swap reported success but the sizes differ — Qoder may still be running. Check the tray icon and retry.");
    }
    return { elevated: true };
  } finally {
    fs.rmSync(script, { force: true });
  }
}

module.exports = { readHeader, encodeHeader, walk, integrityOf, patchArchive, swapInto, tmpRoot, CHUNK };
