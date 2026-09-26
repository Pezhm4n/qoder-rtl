"use strict";

/*
 * Checks for the published command line: what `npx qoder-persian-rtl` actually runs,
 * whether the CDP path really needs no dependencies, and whether the route that writes
 * into the Qoder install stays behind an explicit --yes.
 *
 *   node test/cli.js
 */

const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const pkg = require(path.join(ROOT, "package.json"));

let failures = 0;
function check(name, cond, extra) {
  if (cond === true) console.log(`  ok    ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 60000, ...opts });
}

/* Run `node` with @electron/asar made unresolvable, so anything that still needs it throws
   instead of quietly passing. `--require` of an inline module is not possible, so the hook
   is prepended to the script itself; with -e, argv[1] is the first extra argument. */
const BLOCK = `
const Module = require("node:module");
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@electron/asar") throw new Error("blocked: the zero-dependency path must not load @electron/asar");
  return realLoad.call(this, request, ...rest);
};
`;

async function main() {
  console.log(`package: ${pkg.name} ${pkg.version}, bins ${Object.keys(pkg.bin || {}).join(", ")}`);

  /* ---------- the shape of the published package ---------- */
  const bins = Object.entries(pkg.bin || {});
  check("every bin points at cli.js", bins.length >= 1 && bins.every(([, target]) => target === "cli.js"), JSON.stringify(bins));
  check("cli.js is shipped and executable-looking", pkg.files.includes("cli.js") && read("cli.js").startsWith("#!/usr/bin/env node"));
  check("the package declares no runtime dependencies", !pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies || {}));
  check("@electron/asar is a dev dependency only", !pkg.dependencies?.["@electron/asar"] && !!pkg.devDependencies?.["@electron/asar"]);
  check("tests are not published", !pkg.files.some((f) => /test/.test(f)) && pkg.files.every((f) => fs.existsSync(path.join(ROOT, f))), JSON.stringify(pkg.files));
  check("main is the CDP engine, not the archive patcher", pkg.main === "live.js", String(pkg.main));
  /* "main" is also the require() entry, so a plain require must not open a CDP connection.
     If the engine still self-boots, the child never exits and the timeout kills it. */
  const bootProbe = runCli(["-e", `require(process.argv[1]); console.log("loaded");`, path.join(ROOT, "live.js")], { timeout: 15000 });
  check("requiring the CDP engine does not start it", bootProbe.status === 0 && /loaded/.test(bootProbe.stdout), `status=${bootProbe.status} ${(bootProbe.stdout || "").trim().slice(0, 60)}${(bootProbe.stderr || "").slice(0, 120)}`);

  /* ---------- nothing on the CDP path may load the archive library ---------- */
  const cdpFiles = ["cli.js", "live.js", "lib/cdp.js", "lib/payload.js", "lib/detect.js", "lib/backup.js", "lib/asar.js", "lib/inject.js", "lib/launcher.js"];
  const topLevel = cdpFiles.filter((f) => /^\s*(?:const|let|var)\s+\w+\s*=\s*require\(["']@electron\/asar["']\)/m.test(read(f)));
  check("no CDP-path file requires @electron/asar at load time", topLevel.length === 0, topLevel.join(", "));
  check("the archive library is loaded through one lazy getter", /function asarModule\(\)/.test(read("lib/detect.js")) && /function needAsar\(\)/.test(read("index.js")));

  /* A source grep cannot prove the require chain is clean, so run it with the module
     actually missing. */
  const probe = runCli([
    "-e",
    `${BLOCK}
const root = process.argv[1];
const { findInstall } = require(root + "/lib/detect");
const { runtimeSource } = require(root + "/lib/payload");
const src = runtimeSource();
let version = "no Qoder install found";
try { version = findInstall().version; } catch (e) {}
console.log(JSON.stringify({ bytes: src.length, hasFont: src.includes("Vazirmatn QRT"), version }));
`,
    ROOT
  ]);
  let probeOut = null;
  try {
    probeOut = JSON.parse(probe.stdout.trim().split("\n").pop());
  } catch (e) {}
  check("the CDP payload builds with @electron/asar missing", probe.status === 0 && !!probeOut, `status=${probe.status} ${(probe.stderr || "").slice(0, 160)}`);
  /* Positive control: a probe that prints an empty payload would also exit 0. */
  check("that probe really built the payload", !!probeOut && probeOut.bytes > 100000 && probeOut.hasFont === true, JSON.stringify(probeOut));
  check("the probe can see a real install when one exists", !probeOut || /^\d/.test(String(probeOut.version)) || probeOut.version === "no Qoder install found", JSON.stringify(probeOut));

  /* ---------- the bin itself, as a user runs it ---------- */
  const help = runCli(["cli.js", "help"]);
  check("help exits 0 and lists the safe route first", help.status === 0 && /npx qoder-persian-rtl/.test(help.stdout) && /start/.test(help.stdout) && help.stdout.indexOf("start") < help.stdout.indexOf("patch --yes"), `status=${help.status}`);
  check("help names the archive route as the dangerous one", /patch --yes/.test(help.stdout) && /breaks Qoder/.test(help.stdout));

  const bogus = runCli(["cli.js", "bogus-command"]);
  check("an unknown command is refused with usage", bogus.status === 2 && /Unknown command: bogus-command/.test(bogus.stderr) && /qoder-rtl start/.test(bogus.stderr), `status=${bogus.status}`);

  const gated = runCli(["cli.js", "patch"]);
  const gatedOut = (gated.stderr || "") + (gated.stdout || "");
  check("the archive route needs an explicit --yes", gated.status === 2 && !gatedOut.includes("Rewriting archive"), `status=${gated.status}`);
  check("the refusal says why the archive route is not the default", /EnableEmbeddedAsarIntegrityValidation|refuse to start/.test(gatedOut) && /restore/.test(gatedOut), gatedOut.slice(0, 120));

  const statusRun = runCli(["-e", `${BLOCK}
const root = process.argv[1];
process.argv = [process.argv[0], "cli.js", ...process.argv.slice(2)];
require(root + "/cli.js");
`, ROOT, "status"]);
  check("status runs with @electron/asar missing", statusRun.status === 0, `status=${statusRun.status} ${(statusRun.stderr || "").slice(0, 200)}`);
  check("status reports tool, payload and port separately", /tool\s+qoder-persian-rtl/.test(statusRun.stdout) && /payload\s+runtime \d+\.\d+\.\d+/.test(statusRun.stdout) && /debug port/.test(statusRun.stdout), JSON.stringify((statusRun.stdout || "").slice(0, 160)));
  check("status says what it could not find instead of failing", !/undefined|NaN|\[object/.test(statusRun.stdout), JSON.stringify(statusRun.stdout.slice(-200)));
  /* Continuation lines (a value that spans rows, or a hint under a label) must line up with
     the value column — an off-by-one there glued "archive routeavailable" once. */
  const misaligned = (statusRun.stdout || "").split(/\r?\n/).filter((l) => /^ +\S/.test(l) && !/^ {14}\S/.test(l));
  check("multi-line status rows stay aligned with the value column", misaligned.length === 0, JSON.stringify(misaligned[0] || ""));

  /* ---------- the launcher: one path list, writer and remover agree ---------- */
  const livejs = read("live.js");
  const launcherLib = read("lib/launcher.js");
  check("both --launcher and --remove-launcher exist", livejs.includes('a === "--launcher"') && livejs.includes('a === "--remove-launcher"'));
  /* The invariant is that nobody else *builds* the path; prose in --help may of course
     name the file. */
  check("the launcher file name is defined once and never rebuilt", /const LAUNCHER_NAME = "Qoder-RTL\.cmd";/.test(launcherLib) && (launcherLib.match(/Qoder-RTL\.cmd/g) || []).length === 1 && !/path\.join\([^)]*Qoder-RTL\.cmd/.test(livejs), JSON.stringify({ inLive: (livejs.match(/path\.join\([^)]*Qoder-RTL\.cmd/g) || []).length }));
  /* Not executed: it would delete a launcher the user may deliberately have installed, so
     the agreement between writer and remover is checked structurally instead. */
  const writerBody = (/function writeLauncher\([\s\S]*?\n\}/.exec(livejs) || [""])[0];
  const removerBody = (/function removeLauncher\(\)\s*\{[\s\S]*?\n\}/.exec(livejs) || [""])[0];
  check("writer and remover share one source of paths", /launcherPaths\(\)/.test(writerBody) && /launcherPaths\(\)/.test(removerBody) && !/path\.join\([^)]*cmd/i.test(removerBody), JSON.stringify({ writer: /launcherPaths\(\)/.test(writerBody), remover: /launcherPaths\(\)/.test(removerBody) }));
  check("the remover reports what it looked for, not just what it deleted", /Not present/.test(livejs) && /only deletes the \.cmd files this tool wrote/.test(livejs));

  /* ---------- the entry point must not be the destructive one ---------- */
  const cli = read("cli.js");
  check("no arguments means the CDP route", /if \(!name\) return delegate\(COMMANDS\.start/.test(cli));
  check("only the archive patch is gated", (cli.match(/gated: true/g) || []).length === 1 && /patch: \{ engine: ARCHIVE[^}]*gated: true/.test(cli));
  check("the CLI never kills a running Qoder", !/taskkill|process\.kill|\.kill\(/.test(cli) && /Nothing is killed here on purpose/.test(livejs));
  check("the archive route is no longer advertised as the npx default", !/npx qoder-persian-rtl\s+patch/.test(read("index.js") + cli));

  /* ---------- the port probe: what a failed `start` now reports ---------- */
  await portProbeChecks();

  console.log(failures ? `\n${failures} check(s) failed` : "\nall command-line packaging checks passed");
  process.exit(failures ? 1 : 0);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/* The probes above deliberately connect to these servers and undici keeps those sockets
   in its pool, so a plain server.close() would wait for connections that only the fetch
   layer owns. Drop what we can, and do not let the rest hang the suite. */
function close(server) {
  return new Promise((resolve) => {
    if (server.closeAllConnections) server.closeAllConnections();
    const timer = setTimeout(resolve, 2000);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/* Every assertion here drives the probe against a socket that really exists on this
   machine, because a grep of lib/cdp.js cannot tell "recognises an orphan listener" from
   "recognises nothing at all" — the first version of this feature printed a confident
   cause for a port it had never actually queried. */
async function portProbeChecks() {
  const { portState, describePort, adviceFor, processAlive, parseNetstatListeners } = require(path.join(ROOT, "lib/cdp"));
  const { parseTasklist } = require(path.join(ROOT, "live.js"));

  const free = await listen(net.createServer());
  const freePort = free.address().port;
  await close(free);

  const busy = await listen(net.createServer());
  const busyPort = busy.address().port;

  const fake = await listen(
    http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ Browser: "HeadlessChrome/140.0.0.0", webSocketDebuggerUrl: `ws://127.0.0.1:${fake.address().port}/devtools/browser/deadbeef` }));
    })
  );
  const fakePort = fake.address().port;

  const [isFree, isBusy, isServing] = await Promise.all([portState(freePort), portState(busyPort), portState(fakePort)]);
  check("a port nobody holds reports as bindable", isFree.state === "free" && isFree.owner === undefined, JSON.stringify(isFree));
  check("a port that is held reports as held", isBusy.state === "occupied" && isBusy.owner === "running", JSON.stringify(isBusy));
  check("a held port names the holding PID, not just the fact", isBusy.ownerPid === process.pid, JSON.stringify({ got: isBusy.ownerPid, want: process.pid }));
  check("the holder's process name comes from the OS", /node/i.test(String(isBusy.ownerName || "")), JSON.stringify(isBusy.ownerName));
  check("a port answering /json/version reports as serving", isServing.state === "serving" && /devtools\/browser/.test(isServing.endpoint), JSON.stringify(isServing));
  /* Positive control: an HTTP server that is not CDP must not read as "serving". */
  const plain = await listen(http.createServer((req, res) => res.end("{}")));
  const isPlain = await portState(plain.address().port);
  await close(plain);
  check("a plain HTTP listener is not mistaken for a DevTools endpoint", isPlain.state === "occupied", JSON.stringify(isPlain));

  await close(busy);
  await close(fake);

  /* The orphan case — the one that broke `start` on this machine — is a held port whose
     PID has exited. A live process cannot be made to exit-and-keep-listening without
     administrative rights, so each half is proven separately and the composition below. */
  const gone = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise((r) => gone.on("exit", r));
  const dead = processAlive(gone.pid);
  const alive = processAlive(process.pid);
  check("a PID that has exited is reported as exited", dead.alive === false, JSON.stringify(dead));
  check("a PID that is running is reported as running, with its name", alive.alive === true && /node/i.test(String(alive.name || "")), JSON.stringify(alive));
  check("an impossible PID is an unknown, not a claim of exit", processAlive(0).alive === null && processAlive(-1).alive === null, JSON.stringify([processAlive(0), processAlive(-1)]));
  const orphan = { port: 9222, state: "occupied", owner: "exited", ownerPid: gone.pid, ownerName: null };
  check("an orphan listener is named as one, and says the port will not free itself", /PID \d+, which has exited/.test(describePort(orphan)) && /orphan/.test(describePort(orphan)), describePort(orphan));
  check("the orphan advice offers a working port instead of a dead end", /--port \d+/.test(adviceFor(orphan)) && /[Qu]uit/.test(adviceFor(orphan)), adviceFor(orphan));
  /* The free-port advice has two readers with different knowledge: the engine has just
     launched a Qoder and can name it, while `status` has launched nothing and must not.
     One sentence cannot be true for both — status used to say "the copy this command
     started never opened it" about a command that starts no copy. */
  check("read-only advice does not claim a launch it did not perform",
    /launched nothing/.test(adviceFor({ port: 9222, state: "free" })) &&
      !/this command started/.test(adviceFor({ port: 9222, state: "free" })) &&
      /\bstart\b/.test(adviceFor({ port: 9222, state: "free" })),
    adviceFor({ port: 9222, state: "free" }));
  check("the launch-failure advice still names the copy that command started",
    /this command started/.test(adviceFor({ port: 9222, state: "free" }, true)),
    adviceFor({ port: 9222, state: "free" }, true));
  /* Functional, on a port this run controls: if it is not free the check says so rather than
     passing because the sentence never had a chance to appear. */
  {
    const probePort = 9399;
    const st = runCli(["cli.js", "status", "--port", String(probePort)]);
    const out = (st.stdout || "") + (st.stderr || "");
    const flat = out.replace(/\r?\n/g, " | ");
    check("status prints the read-only advice on a free port",
      !out ? false : /free to bind/.test(out) ? !/this command started/.test(out) && /launched nothing/.test(out) : false,
      !out ? `the CLI produced no output (status=${st.status}): ${String(st.error && st.error.message).slice(0, 80)}`
        : /free to bind/.test(out) ? flat.slice(0, 200)
        : `port ${probePort} was not free, so the branch never ran: ${flat.slice(0, 160)}`);
  }
  check("an advice line is produced for every state, none of them blank", ["serving", "free", "blocked", "occupied"].every((st) => {
    const s = { port: 9222, state: st, owner: st === "occupied" ? "unknown" : undefined, reason: "EACCES" };
    return describePort(s).length > 20 && adviceFor(s).length > 20;
  }), JSON.stringify(["serving", "free", "blocked", "occupied"].map((st) => describePort({ port: 9, state: st, reason: "EACCES" }))));

  /* Real netstat output from this machine, including the row that started the diagnosis. */
  const NETSTAT = [
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1080",
    "  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       9104",
    "  TCP    127.0.0.1:9222         127.0.0.1:51234        ESTABLISHED     9104",
    "  TCP    127.0.0.1:51234        127.0.0.1:9222         ESTABLISHED     4400",
    "  TCP    [::]:135               [::]:0                 LISTENING       1080"
  ].join("\r\n");
  const owners = parseNetstatListeners(NETSTAT, 9222);
  check("the listener row for the port is found", owners.length === 1 && owners[0].pid === 9104, JSON.stringify(owners));
  check("established rows are not read as listeners", parseNetstatListeners(NETSTAT, 51234).length === 0, JSON.stringify(parseNetstatListeners(NETSTAT, 51234)));
  check("a listener on a different port is not reported", parseNetstatListeners(NETSTAT, 41000).length === 0, JSON.stringify(parseNetstatListeners(NETSTAT, 41000)));

  /* tasklist's three shapes must stay three different answers. */
  const ROWS = '"Qoder.exe","15120","Console","1","1,234 K"\r\n"Qoder.exe","15121","Console","1","234 K"\r\n';
  check("tasklist rows become PIDs", JSON.stringify(parseTasklist(ROWS)) === JSON.stringify({ pids: ["15120", "15121"] }), JSON.stringify(parseTasklist(ROWS)));
  check("tasklist's own \"no tasks\" is a real zero", JSON.stringify(parseTasklist("INFO: No tasks are running which match the specified criteria.")) === JSON.stringify({ pids: [] }), JSON.stringify(parseTasklist("INFO: No tasks are running which match the specified criteria.")));
  check("unparsable tasklist output is an error, not a zero", parseTasklist("command not found").error !== undefined && parseTasklist("").error !== undefined, JSON.stringify([parseTasklist("command not found"), parseTasklist("")]));
  const live = require(path.join(ROOT, "live.js")).qoderProcesses();
  check("the running process probe answers with one of the two, never both", Array.isArray(live.pids) && (live.error ? live.pids.length === 0 : true), JSON.stringify(live));

  /* The false verdict must be gone from both the code and the prose. */
  const sources = ["live.js", "lib/cdp.js", "cli.js", "README.md"].map(read).join("\n");
  check("the disproven \"this build ignores the flag\" verdict is gone", !/[Bb]uild ignores --remote-debugging-port|[Bb]uild ignores the flag/.test(sources));
  const livejs = read("live.js");
  check("the failure report carries the port observation and the advice", /portObservations\(after/.test(livejs) && /what to do:  \$\{adviceFor\(after, true\)\}/.test(livejs), "");
  /* Red-first guard on ordering: launching must come after both guards, not instead of them. */
  const launchAt = livejs.indexOf("spawn(exe");
  check("start refuses before launching when the process probe failed", /if \(qoder\.error\)/.test(livejs) && livejs.indexOf("if (qoder.error)") < launchAt, `guards=${livejs.indexOf("if (qoder.error)")} launch=${launchAt}`);
  check("start refuses before launching when something holds the port", /state\.state !== "free"/.test(livejs) && livejs.indexOf('state.state !== "free"') < launchAt, `refusal=${livejs.indexOf('state.state !== "free"')} launch=${launchAt}`);

  /* ---------- one port precedence, shared by the reporter and the engines ---------- */
  const envRuns = {
    fromEnv: runCli(["cli.js", "status"], { env: { ...process.env, QODER_RTL_PORT: "9444" } }),
    flagWins: runCli(["cli.js", "status", "--port", "9555"], { env: { ...process.env, QODER_RTL_PORT: "9444" } }),
    junkEnv: runCli(["cli.js", "status"], { env: { ...process.env, QODER_RTL_PORT: "not-a-port" } })
  };
  const portRow = (out) => (/debug port(.*)/.exec(out) || [, ""])[1];
  check("status follows QODER_RTL_PORT", /9444/.test(portRow(envRuns.fromEnv.stdout)), JSON.stringify(portRow(envRuns.fromEnv.stdout)));
  check("--port still beats the environment", /9555/.test(portRow(envRuns.flagWins.stdout)), JSON.stringify(portRow(envRuns.flagWins.stdout)));
  check("a junk QODER_RTL_PORT falls back to the default, not to NaN", /9222/.test(portRow(envRuns.junkEnv.stdout)) && !/NaN/.test(envRuns.junkEnv.stdout), JSON.stringify(portRow(envRuns.junkEnv.stdout)));
  /* The same value has to reach the engine, or `status` would report a port that
     `check`/`start` never use. */
  const enginePort = (env) => {
    const r = runCli([
      "-e",
      `const root = process.argv[1];
process.env.QODER_RTL_PORT = process.argv[2];
console.log(require(root + "/live.js").parseArgs([]).port);
`,
      ROOT,
      env
    ]);
    return r.stdout.trim();
  };
  check("the CDP engine reads the same environment default", enginePort("9444") === "9444", enginePort("9444"));
  check("the engine ignores a port it cannot use", enginePort("nonsense") === "9222", enginePort("nonsense"));
  /* The precedence lives in one function: a second reader of the env var, or a second
     9222 literal, is how a status line and an engine end up on different ports. */
  const cliSrc = read("cli.js");
  check("the port default is defined once and only read from lib/cdp", cliSrc.includes("defaultPort()") && /const DEFAULT_PORT = defaultPort\(\);/.test(livejs) && !/process\.env\.QODER_RTL_PORT/.test(cliSrc + livejs) && !/const DEFAULT_PORT = 9222/.test(livejs), JSON.stringify({ cliEnv: /process\.env\.QODER_RTL_PORT/.test(cliSrc), liveEnv: /process\.env\.QODER_RTL_PORT/.test(livejs) }));
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
