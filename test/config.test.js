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

const {
  loadConfig,
  getConfigValue,
  setConfigValue,
  coerceValue,
  saveConfig,
  getConfigPath,
  redactConfig,
  redactApiKey,
  isSecretConfigKey,
} = await import("../src/config.js");

const SENTINEL = "SUPER_SECRET_API_KEY_DO_NOT_PRINT";

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

test("redactApiKey reports presence, never the raw value", () => {
  assert.equal(redactApiKey(SENTINEL), "[configured]");
  assert.equal(redactApiKey(""), "[not configured]");
  assert.equal(redactApiKey(undefined), "[not configured]");
  assert.equal(redactApiKey(null), "[not configured]");
});

test("isSecretConfigKey flags apiKey, including dotted paths", () => {
  assert.equal(isSecretConfigKey("apiKey"), true);
  assert.equal(isSecretConfigKey("nested.apiKey"), true);
  assert.equal(isSecretConfigKey("model"), false);
  assert.equal(isSecretConfigKey("baseUrl"), false);
});

test("redactConfig redacts the key but preserves every non-secret value", () => {
  const config = {
    provider: "openai",
    baseUrl: "http://localhost:4891",
    apiKey: SENTINEL,
    model: "gpt4all",
    temperature: 0.7,
    markdownStyles: { codeStyles: ["cyan"] },
  };
  const redacted = redactConfig(config);

  // The secret is gone from the serialized output entirely.
  assert.ok(!JSON.stringify(redacted).includes(SENTINEL));
  assert.equal(redacted.apiKey, "[configured]");

  // Non-secret values survive untouched.
  assert.equal(redacted.provider, "openai");
  assert.equal(redacted.baseUrl, "http://localhost:4891");
  assert.equal(redacted.model, "gpt4all");
  assert.equal(redacted.temperature, 0.7);
  assert.deepEqual(redacted.markdownStyles, { codeStyles: ["cyan"] });

  // The original config object is not mutated by redaction.
  assert.equal(config.apiKey, SENTINEL);
});

test("redactConfig marks an empty key as not configured", () => {
  assert.equal(redactConfig({ apiKey: "" }).apiKey, "[not configured]");
});

// File-permission hardening is POSIX-only; chmod is a no-op on Windows.
test(
  "saveConfig writes config.json as 0600 inside a 0700 directory",
  { skip: process.platform === "win32" },
  () => {
    saveConfig({ apiKey: SENTINEL, model: "gpt4all" });
    const configPath = getConfigPath();
    const fileMode = fs.statSync(configPath).mode & 0o777;
    const dirMode = fs.statSync(path.dirname(configPath)).mode & 0o777;
    assert.equal(fileMode, 0o600, `expected 0600, got ${fileMode.toString(8)}`);
    assert.equal(dirMode, 0o700, `expected 0700, got ${dirMode.toString(8)}`);
  }
);

test(
  "saveConfig corrects a pre-existing loose-mode config file back to 0600",
  { skip: process.platform === "win32" },
  () => {
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, "{}", { mode: 0o644 });
    fs.chmodSync(configPath, 0o644); // umask can loosen the mode above.
    saveConfig({ model: "gpt4all" });
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  }
);
