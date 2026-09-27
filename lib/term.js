"use strict";

/* Terminal colour, with no dependency: the CDP route ships with zero runtime
   dependencies and a hand-rolled painter keeps it that way.

   Two rules keep this honest:
   - colour is presentation only. Anything written to a log file, and anything a
     test asserts on, is built plain and painted at the console.log call site.
   - a pipe is not a terminal. Without isTTY the painter is the identity function,
     so `qoder-rtl check > out.txt` and every spawned-child assertion stay clean.
     NO_COLOR turns it off everywhere; FORCE_COLOR=1 turns it on for a demo run.

   The palette is the usual console convention, one meaning per colour:
   green = it worked, red = it did not, yellow = it could not be judged or needs
   the owner's attention, cyan = a value (endpoint, path, version), gray = a hint,
   bold = the word that names the section.

   ESC and NL come from fromCharCode so this file carries no escape sequences of
   its own to survive editors, shells and archives on the way to disk. */

var CODES = {
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  cyan: 36,
  gray: 90
};

var ESC = String.fromCharCode(27);
var NL = String.fromCharCode(10);

function enabled() {
  if (process.env.NO_COLOR) return false;
  var force = process.env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force !== "false";
  return Boolean(process.stdout && process.stdout.isTTY);
}

var on = enabled();

function wrap(code, text) {
  return on ? ESC + "[" + code + "m" + text + ESC + "[0m" : text;
}

/* A verdict sheet is built plain (it is what lands in cdp-test.log), and painted
   line by line only when it goes to the console. */
function report(text) {
  if (!on) return text;
  return text
    .split(NL)
    .map(function (line) {
      if (line.indexOf("PASS") === 0) return wrap(CODES.green, line);
      if (line.indexOf("FAIL") === 0) return wrap(CODES.red, line);
      if (line.indexOf("UNSURE") === 0) return wrap(CODES.yellow, line);
      if (line.indexOf("note") === 0) return wrap(CODES.gray, line);
      if (line.indexOf("#") === 0) return wrap(CODES.bold, wrap(CODES.gray, line));
      if (line.indexOf("NOT PATCHED") !== -1) {
        return line.replace("NOT PATCHED", wrap(CODES.red, "NOT PATCHED"));
      }
      if (line.indexOf("still being attached") !== -1) {
        return line.replace("still being attached", wrap(CODES.yellow, "still being attached"));
      }
      return line;
    })
    .join(NL);
}

module.exports = {
  ok: function (t) {
    return wrap(CODES.green, t);
  },
  bad: function (t) {
    return wrap(CODES.red, t);
  },
  warn: function (t) {
    return wrap(CODES.yellow, t);
  },
  info: function (t) {
    return wrap(CODES.cyan, t);
  },
  key: function (t) {
    return wrap(CODES.bold, t);
  },
  dim: function (t) {
    return wrap(CODES.gray, t);
  },
  report: report,
  isColor: function () {
    return on;
  }
};
