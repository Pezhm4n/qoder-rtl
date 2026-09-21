"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/* Only the archive route reads app.asar. Requiring @electron/asar at the top of this
   file made every install pull 6.8 MB of node_modules for a path the CDP route — the one
   that works on this build — never takes, so `npx` had to download it before printing a
   single line. Load it on demand instead and name the fix when it is missing. */
function asarModule() {
  try {
    return require("@electron/asar");
  } catch (e) {
    throw new Error(
      'The archive route needs "@electron/asar", which is not installed: npm install @electron/asar\n' +
      "  (the CDP route — `npx qoder-persian-rtl start` — does not need it, and is the one that works on Qoder 0.3.3)"
    );
  }
}

/* @electron/asar 4.x splits lookups on the native separator, so these must be
   built with path.join() — an "a/b/c" string silently misses on Windows. */
const RENDERER_LAYOUTS = [path.join("out", "renderer", "index.html"), path.join("out", "out", "renderer", "index.html")];

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return null;
  }
}

function isQoderResourcesDir(dir) {
  const product = readJsonSafe(path.join(dir, "product.json"));
  if (!product) return false;
  if (product.productId !== "qoder" && !String(product.appId || "").startsWith("com.qoder")) return false;
  return fs.existsSync(path.join(dir, "app.asar")) || fs.existsSync(path.join(dir, "app"));
}

function resourcesCandidates() {
  const home = os.homedir();
  const env = process.env;
  const roots = [];

  if (process.platform === "win32") {
    roots.push(
      path.join(env.PROGRAMFILES || "C:\\Program Files", "Qoder"),
      path.join(env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Qoder"),
      path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs", "Qoder"),
      path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Qoder")
    );
  } else if (process.platform === "darwin") {
    roots.push("/Applications/Qoder.app/Contents/Resources", path.join(home, "Applications/Qoder.app/Contents/Resources"));
  } else {
    roots.push("/opt/Qoder/resources", "/usr/lib/qoder/resources", path.join(home, ".local/share/Qoder/resources"));
  }

  return roots.filter((r) => r && fs.existsSync(r));
}

/* A system install lives in Program Files; writing there needs elevation. */
function isPrivileged(target) {
  if (process.platform !== "win32") return !target.startsWith(path.join(os.homedir()));
  const writableRoots = [process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean);
  return !writableRoots.some((root) => target.toLowerCase().startsWith(String(root).toLowerCase()));
}

/* A resources dir either holds app.asar directly or is the app root itself. */
function resolveResourcesDir(dir) {
  const candidates = [dir, path.join(dir, "resources")];
  return candidates.find(isQoderResourcesDir) || null;
}

function findInstall(explicitAsar) {
  if (explicitAsar) {
    const p = path.resolve(explicitAsar);
    if (!fs.existsSync(p)) throw new Error(`Path not found: ${p}`);
    const asarPath = fs.statSync(p).isDirectory() ? path.join(p, "app.asar") : p;
    const resourcesDir = path.dirname(asarPath);
    const manifest = readJsonSafe(path.join(resourcesDir, "build-manifest.json")) || readJsonSafe(path.join(path.dirname(resourcesDir), "build-manifest.json"));
    return {
      resourcesDir,
      asarPath,
      appDir: fs.existsSync(path.join(resourcesDir, "app", "out")) ? path.join(resourcesDir, "app") : null,
      version: (manifest || {}).productVersion || "unknown",
      privileged: isPrivileged(resourcesDir),
      detected: false
    };
  }

  const found = [];
  const seen = new Set();
  for (const root of resourcesCandidates()) {
    const dir = resolveResourcesDir(root);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    found.push({
      resourcesDir: dir,
      asarPath: path.join(dir, "app.asar"),
      appDir: fs.existsSync(path.join(dir, "app", "out")) ? path.join(dir, "app") : null,
      version: (readJsonSafe(path.join(dir, "build-manifest.json")) || {}).productVersion || "unknown",
      privileged: isPrivileged(dir),
      detected: true
    });
  }

  if (found.length === 0) {
    throw new Error(
      "Qoder installation not found. Checked:\n  " +
        resourcesCandidates().join("\n  ") +
        "\nPass the path explicitly with --asar <path-to-app.asar>"
    );
  }
  if (found.length > 1) {
    const err = new Error("Multiple Qoder installations found. Pick one with --asar:\n  " + found.map((f) => f.asarPath).join("\n  "));
    err.candidates = found;
    throw err;
  }
  return found[0];
}

function findRendererAsarPath(asarPath) {
  const asar = asarModule();
  for (const p of RENDERER_LAYOUTS) {
    try {
      const buf = asar.extractFile(asarPath, p);
      if (buf.length && /<head>/i.test(buf.toString("utf8"))) return p;
    } catch (e) {}
  }
  return null;
}

/* Same lookup once the archive has been expanded to a directory tree. */
function findRendererHtmlInTree(treeRoot) {
  for (const rel of RENDERER_LAYOUTS) {
    const p = path.join(treeRoot, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = {
  findInstall,
  findRendererHtmlInTree,
  findRendererAsarPath,
  asarModule,
  RENDERER_LAYOUTS,
  RENDERER_HTML: RENDERER_LAYOUTS[0],
  isPrivileged,
  readJsonSafe
};
