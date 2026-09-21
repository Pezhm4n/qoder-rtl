"use strict";

/* One list, two readers: live.js writes the launcher to these paths and cli.js both
   reports and removes them. Duplicated path lists are how an uninstall ends up deleting
   a file it never wrote — or, worse, leaving the one it did write behind. */

const path = require("node:path");
const { stateRoot } = require("./backup");

const LAUNCHER_NAME = "Qoder-RTL.cmd";

/* AppData is hidden in Explorer, so a copy also lands next to the scripts. Pass the
   directory that counts as "next to the tool" — the caller knows it, this module does not. */
function launcherPaths(toolDir) {
  return [path.join(stateRoot(), LAUNCHER_NAME), path.join(toolDir, LAUNCHER_NAME)];
}

module.exports = { launcherPaths, LAUNCHER_NAME };
