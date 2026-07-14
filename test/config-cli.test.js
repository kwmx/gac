import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// End-to-end guard: run the real CLI binary and assert a seeded API key never
// appears in any config command's output.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const GAC_BIN = path.join(REPO_ROOT, "bin", "gac.js");
const SENTINEL = "SUPER_SECRET_API_KEY_DO_NOT_PRINT";

// A throwaway HOME seeded with a config that already holds the secret key.
function seededHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gac-cli-"));
  fs.mkdirSync(path.join(home, ".gac"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".gac", "config.json"),
    JSON.stringify({ provider: "openai", apiKey: SENTINEL, model: "gpt4all" }, null, 2)
  );
  return home;
}

function runGac(args, home) {
  return spawnSync(process.execPath, [GAC_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      // Keep the run hermetic — never touch the network for telemetry.
      GAC_TELEMETRY_DISABLED: "1",
    },
  });
}

test("`gac config` never prints the seeded API key", () => {
  const { stdout, stderr, status } = runGac(["config"], seededHome());
  assert.equal(status, 0, stderr);
  assert.ok(!stdout.includes(SENTINEL), "config view leaked the API key");
  assert.match(stdout, /"apiKey": "\[configured\]"/);
});

test("`gac config get apiKey` prints only presence, never the seeded key", () => {
  const { stdout, status } = runGac(["config", "get", "apiKey"], seededHome());
  assert.equal(status, 0);
  assert.ok(!stdout.includes(SENTINEL));
  assert.equal(stdout.trim(), "[configured]");
});

test("`gac config set` confirms only — no full config, no existing key", () => {
  const home = seededHome();
  const { stdout, status } = runGac(["config", "set", "model", "test-model"], home);
  assert.equal(status, 0);
  assert.ok(!stdout.includes(SENTINEL), "set leaked the existing API key");
  assert.match(stdout, /Updated model in /);
  // A full-config dump would carry these other keys; they must be absent.
  assert.ok(!stdout.includes('"provider"'), "set must not dump the whole config");
  assert.ok(!stdout.includes('"baseUrl"'));

  // The key is preserved on disk; only its display is redacted.
  const saved = JSON.parse(
    fs.readFileSync(path.join(home, ".gac", "config.json"), "utf8")
  );
  assert.equal(saved.apiKey, SENTINEL);
  assert.equal(saved.model, "test-model");
});

test("`gac config get apiKey` reports not configured when the key is empty", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gac-cli-"));
  const { stdout, status } = runGac(["config", "get", "apiKey"], home);
  assert.equal(status, 0);
  assert.ok(!stdout.includes(SENTINEL));
  assert.equal(stdout.trim(), "[not configured]");
});
