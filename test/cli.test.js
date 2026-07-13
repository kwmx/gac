import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOsRelease } from "../src/sysinfo.js";
import { normalizeDefaultAction } from "../src/prompts.js";
import { parseArgs } from "../src/flags.js";

test("parseOsRelease parses key=value, strips quotes, skips comments", () => {
  const parsed = parseOsRelease(
    ['# a comment', 'NAME="Ubuntu"', "ID=ubuntu", "", "VERSION_ID=\"22.04\""].join("\n")
  );
  assert.equal(parsed.NAME, "Ubuntu");
  assert.equal(parsed.ID, "ubuntu");
  assert.equal(parsed.VERSION_ID, "22.04");
});

test("normalizeDefaultAction accepts known actions and defaults the rest", () => {
  assert.equal(normalizeDefaultAction("ask"), "ask");
  assert.equal(normalizeDefaultAction("SUGGEST"), "suggest");
  assert.equal(normalizeDefaultAction(" explain "), "explain");
  assert.equal(normalizeDefaultAction("nonsense"), "suggest");
  assert.equal(normalizeDefaultAction(""), "suggest");
  assert.equal(normalizeDefaultAction(undefined), "suggest");
});

function parse(...args) {
  return parseArgs(["node", "gac", ...args]);
}

test("parseArgs extracts boolean flags anywhere in the arg list", () => {
  const { flags, positional, errors } = parse("suggest", "-d", "how do I x", "--no-render");
  assert.equal(flags.detailedSuggest, true);
  assert.equal(flags.noRender, true);
  assert.deepEqual(positional, ["suggest", "how do I x"]);
  assert.deepEqual(errors, []);
});

test("parseArgs handles valued flags in both forms", () => {
  const spaced = parse("runbook", "--export", "setup.sh", "install docker");
  assert.equal(spaced.flags.exportPath, "setup.sh");
  assert.deepEqual(spaced.positional, ["runbook", "install docker"]);

  const equals = parse("runbook", "--export=setup.sh", "install docker");
  assert.equal(equals.flags.exportPath, "setup.sh");
});

test("parseArgs collects repeated file flags", () => {
  const { flags } = parse("explain", "-f", "a.js", "--file", "b.js", "what is this");
  assert.deepEqual(flags.files, ["a.js", "b.js"]);
});

test("parseArgs reports missing values and unknown double-dash flags", () => {
  const missing = parse("runbook", "--export");
  assert.equal(missing.errors.length, 1);
  assert.match(missing.errors[0], /requires a value/);

  const unknown = parse("ask", "--bogus", "hello");
  assert.equal(unknown.errors.length, 1);
  assert.match(unknown.errors[0], /--bogus/);
});

test("parseArgs keeps unknown single-dash tokens as prompt text", () => {
  const { positional, errors } = parse("ask", "what", "does", "-x", "mean");
  assert.deepEqual(positional, ["ask", "what", "does", "-x", "mean"]);
  assert.deepEqual(errors, []);
});

test("parseArgs recognizes help and version", () => {
  assert.equal(parse("--help").flags.help, true);
  assert.equal(parse("-h").flags.help, true);
  assert.equal(parse("--version").flags.version, true);
  assert.equal(parse("-V").flags.version, true);
});
