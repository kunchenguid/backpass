import test from "node:test";
import assert from "node:assert/strict";

import { ANSI16, INKS, hexToRgb, makeTheme } from "../src/tui/theme.js";
import { backgroundFromColorFgBg, backgroundFromOscResponse, colorDepth, tuiEligible } from "../src/tui/term.js";

test("hexToRgb parses the house inks", () => {
  assert.deepEqual(hexToRgb("#4fe3c1"), [79, 227, 193]);
  assert.deepEqual(hexToRgb("#0a8a72"), [10, 138, 114]);
});

test("truecolor theme emits exact hex inks", () => {
  const theme = makeTheme({ depth: 24, background: "dark" });
  assert.equal(theme.paint("ok", "mint"), "\x1b[38;2;79;227;193mok\x1b[0m");
  assert.equal(theme.paint("hot", "red", { bold: true }), "\x1b[1;38;2;255;93;115mhot\x1b[0m");
});

test("light background swaps to the descent-light ink set", () => {
  const theme = makeTheme({ depth: 24, background: "light" });
  const [r, g, b] = hexToRgb(INKS.light.mint);
  assert.equal(theme.paint("ok", "mint"), `\x1b[38;2;${r};${g};${b}mok\x1b[0m`);
});

test("ANSI-16 fallback maps each ink to its nearest classic color", () => {
  const theme = makeTheme({ depth: 4, background: "dark" });
  assert.equal(theme.paint("ok", "mint"), `\x1b[${ANSI16.mint}mok\x1b[0m`);
  assert.equal(theme.paint("dim", "faint"), `\x1b[${ANSI16.faint}mdim\x1b[0m`);
  // "text" is the terminal's own default foreground - no escape at all.
  assert.equal(theme.paint("plain", "text"), "plain");
  assert.equal(theme.paint("plain", "text", { bold: true }), "\x1b[1mplain\x1b[0m");
});

test("depth 0 renders plain text - the layout-test mode", () => {
  const theme = makeTheme({ depth: 0 });
  assert.equal(theme.paint("plain", "mint", { bold: true }), "plain");
  assert.equal(theme.gradient("▰▰▰"), "▰▰▰");
});

test("gradient interpolates mint to blue per character in truecolor", () => {
  const theme = makeTheme({ depth: 24, background: "dark" });
  const painted = theme.gradient("ab");
  const [mr, mg, mb] = hexToRgb(INKS.dark.mint);
  const [br, bg, bb] = hexToRgb(INKS.dark.blue);
  assert.ok(painted.startsWith(`\x1b[38;2;${mr};${mg};${mb}ma`));
  assert.ok(painted.includes(`\x1b[38;2;${br};${bg};${bb}mb`));
  assert.ok(painted.endsWith("\x1b[0m"));
});

test("gradient collapses to solid mint below truecolor", () => {
  const theme = makeTheme({ depth: 4, background: "dark" });
  assert.equal(theme.gradient("▰▰"), `\x1b[${ANSI16.mint}m▰▰\x1b[0m`);
});

test("colorDepth follows COLORTERM and NO_COLOR", () => {
  const tty = { isTTY: true };
  assert.equal(colorDepth({ env: { COLORTERM: "truecolor" }, stderr: tty }), 24);
  assert.equal(colorDepth({ env: { COLORTERM: "24bit" }, stderr: tty }), 24);
  assert.equal(colorDepth({ env: {}, stderr: tty }), 4);
  assert.equal(colorDepth({ env: { NO_COLOR: "1", COLORTERM: "truecolor" }, stderr: tty }), 0);
  assert.equal(colorDepth({ env: { COLORTERM: "truecolor" }, stderr: { isTTY: false } }), 0);
});

test("tuiEligible gates on TTY, CI, NO_COLOR, quiet, json, and width", () => {
  const wide = { isTTY: true, columns: 120 };
  assert.equal(tuiEligible({ env: {}, stderr: wide }), true);
  assert.equal(tuiEligible({ env: {}, stderr: { isTTY: false, columns: 120 } }), false);
  assert.equal(tuiEligible({ env: { CI: "1" }, stderr: wide }), false);
  assert.equal(tuiEligible({ env: { NO_COLOR: "" }, stderr: wide }), false);
  assert.equal(tuiEligible({ env: { TERM: "dumb" }, stderr: wide }), false);
  assert.equal(tuiEligible({ env: {}, stderr: wide, quiet: true }), false);
  assert.equal(tuiEligible({ env: {}, stderr: wide, json: true }), false);
  assert.equal(tuiEligible({ env: {}, stderr: { isTTY: true, columns: 50 } }), false);
});

test("COLORFGBG classifies dark and light backgrounds", () => {
  assert.equal(backgroundFromColorFgBg("15;0"), "dark");
  assert.equal(backgroundFromColorFgBg("0;15"), "light");
  assert.equal(backgroundFromColorFgBg("12;8"), "dark");
  assert.equal(backgroundFromColorFgBg("0;default;7"), "light");
  assert.equal(backgroundFromColorFgBg(""), null);
  assert.equal(backgroundFromColorFgBg("nonsense"), null);
});

test("OSC 11 responses classify by luminance", () => {
  assert.equal(backgroundFromOscResponse("\x1b]11;rgb:0b0b/0e0e/1414\x07"), "dark");
  assert.equal(backgroundFromOscResponse("\x1b]11;rgb:f7f7/f9f9/fcfc\x07"), "light");
  assert.equal(backgroundFromOscResponse("\x1b]11;rgb:ff/ff/ff\x1b\\"), "light");
  assert.equal(backgroundFromOscResponse("garbage"), null);
});
