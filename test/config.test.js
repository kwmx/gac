import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate config to a throwaway HOME so tests never read or clobber the real
// ~/.gac/config.json. os.homedir() reads HOME (POSIX) / USERPROFILE (Windows),
// and config.js resolves its directory at import time, so this must run first.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gac-config-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { loadConfig, getConfigValue, setConfigValue, coerceValue } = await import(
  "../src/config.js"
);

test("coerceValue converts JSON-ish strings to native types", () => {
  assert.equal(coerceValue("true"), true);
  assert.equal(coerceValue("false"), false);
  assert.equal(coerceValue("null"), null);
  assert.equal(coerceValue("42"), 42);
  assert.equal(coerceValue("3.14"), 3.14);
  assert.deepEqual(coerceValue('{"a":1}'), { a: 1 });
  assert.deepEqual(coerceValue("[1, 2, 3]"), [1, 2, 3]);
});

test("coerceValue leaves plain strings alone", () => {
  assert.equal(coerceValue("gpt-4"), "gpt-4");
  assert.equal(coerceValue("http://localhost:4891"), "http://localhost:4891");
  // Malformed JSON falls back to the raw string rather than throwing.
  assert.equal(coerceValue("{not json}"), "{not json}");
});

test("loadConfig returns defaults on a fresh home", () => {
  const config = loadConfig();
  assert.equal(config.provider, "openai");
  assert.equal(config.model, "gpt4all");
  assert.equal(config.stream, true);
  assert.ok(config.markdownStyles && typeof config.markdownStyles === "object");
});

test("set/get round-trips a top-level key", () => {
  setConfigValue("model", "llama3");
  assert.equal(getConfigValue("model"), "llama3");
});

test("set/get round-trips a nested dot-notation key", () => {
  setConfigValue("markdownStyles.codeStyles", '["green", "bold"]');
  assert.deepEqual(getConfigValue("markdownStyles.codeStyles"), ["green", "bold"]);
});

test("getConfigValue returns undefined for unknown or unreachable keys", () => {
  assert.equal(getConfigValue("doesNotExist"), undefined);
  // Descending into a non-object value must not throw.
  assert.equal(getConfigValue("model.nope"), undefined);
});
