import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Guards the "files" allowlist in package.json: the published tarball must
// carry every runtime file and none of the tests, docs, or dev tooling.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

test("npm pack --dry-run includes runtime files and excludes dev-only paths", () => {
  const result = spawnSync(npmCmd, ["pack", "--dry-run", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const files = JSON.parse(result.stdout)[0].files.map((f) => f.path);

  // Every file the CLI actually needs at runtime.
  const required = [
    "package.json",
    "bin/gac.js",
    "src/cli.js",
    "src/config.js",
    "src/configtui.js",
    "src/runbook.js",
    "src/telemetry/index.js",
    "blocked_commands.json",
    "README.md",
    "LICENSE",
  ];
  for (const file of required) {
    assert.ok(files.includes(file), `expected ${file} in the published package`);
  }

  // Dev-only trees must never be shipped.
  const forbiddenPrefixes = ["test/", "docs/", ".github/", ".claude/"];
  for (const file of files) {
    for (const prefix of forbiddenPrefixes) {
      assert.ok(!file.startsWith(prefix), `unexpected ${file} in the package`);
    }
  }

  // No test file should leak in from anywhere.
  assert.ok(
    !files.some((f) => f.endsWith(".test.js")),
    "test files must not be packed"
  );
});
