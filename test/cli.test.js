import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOsRelease } from "../src/sysinfo.js";
import { normalizeDefaultAction, defaultPromptForFiles } from "../src/prompts.js";
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

test("defaultPromptForFiles generates a mode-appropriate prompt from files", () => {
  const one = [{ path: "server/src/index.ts", content: "" }];
  assert.equal(
    defaultPromptForFiles("explain", one),
    "Explain what `server/src/index.ts` does and how it works."
  );
  assert.equal(
    defaultPromptForFiles("suggest", one),
    "Review `server/src/index.ts` and suggest improvements."
  );
  assert.equal(defaultPromptForFiles("ask", one), "What does `server/src/index.ts` do?");

  // Unknown/empty modes normalize to the default action (suggest).
  assert.equal(
    defaultPromptForFiles("", one),
    "Review `server/src/index.ts` and suggest improvements."
  );
});

test("defaultPromptForFiles handles multiple files and empty input", () => {
  const many = [
    { path: "a.js", content: "" },
    { path: "b.js", content: "" },
  ];
  assert.equal(
    defaultPromptForFiles("explain", many),
    "Explain what these files (a.js, b.js) do and how they work."
  );
  assert.equal(
    defaultPromptForFiles("suggest", many),
    "Review these files (a.js, b.js) and suggest improvements."
  );
  assert.equal(defaultPromptForFiles("ask", many), "What do these files (a.js, b.js) do?");

  // No files → empty string so callers fall through to missing-prompt handling.
  assert.equal(defaultPromptForFiles("explain", []), "");
  assert.equal(defaultPromptForFiles("explain", undefined), "");
});

function parse(...args) {
  return parseArgs(["node", "gac", ...args]);
}

test("parseArgs extracts flags before the prompt", () => {
  const { flags, positional, errors } = parse("suggest", "-d", "--no-render", "how do I x");
  assert.equal(flags.detailedSuggest, true);
  assert.equal(flags.noRender, true);
  assert.deepEqual(positional, ["suggest", "how do I x"]);
  assert.deepEqual(errors, []);
});

test("parseArgs leaves flag-like tokens inside the prompt untouched", () => {
  // Once the prompt has started, nothing is treated as a flag anymore.
  const fileLike = parse("ask", "what", "does", "-f", "mean", "in", "tar");
  assert.deepEqual(fileLike.flags.files, []);
  assert.deepEqual(fileLike.positional, ["ask", "what", "does", "-f", "mean", "in", "tar"]);
  assert.deepEqual(fileLike.errors, []);

  const versionLike = parse("ask", "is", "-V", "a", "common", "flag");
  assert.equal(versionLike.flags.version, false);

  const doubleDash = parse("ask", "what", "does", "--verbose", "mean");
  assert.deepEqual(doubleDash.errors, []);
  assert.ok(doubleDash.positional.includes("--verbose"));
});

test("parseArgs keeps the legacy --detailed-cont alias working", () => {
  assert.equal(parse("--detailed-cont", "suggest", "install nginx").flags.detailedContext, true);
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
