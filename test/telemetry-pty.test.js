import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// These integration tests exercise terminal-kit's real decoder and inputField,
// not a mock term emitting key events. Python supplies only the POSIX terminal.
const driver = fileURLToPath(new URL("./fixtures/telemetry-pty.py", import.meta.url));
const cliUrl = new URL("../src/cli.js", import.meta.url).href;
const skip = process.platform === "win32"
  ? "POSIX PTYs are unavailable on Windows"
  : false;
// python3 is required on POSIX (preinstalled on Ubuntu CI); a missing driver
// must fail loudly instead of silently losing this regression coverage.

const childSource = (argv) => `
  // No model server, telemetry service, or detached sender can be contacted.
  globalThis.fetch = async (url) => {
    if (String(url) !== 'http://pty-model.invalid/v1/chat/completions') {
      throw new Error('Unexpected network request: ' + url);
    }
    process.stdout.write('PTY_MODEL_CALLED\\n');
    return new Response(JSON.stringify({choices:[{message:{content:'PTY_MODEL_OK'}}]}), {
      status: 200, headers: {'content-type':'application/json'}
    });
  };
  const { runCli } = await import(${JSON.stringify(cliUrl)});
  await runCli(${JSON.stringify(['node', 'gac', ...argv])}, {
    telemetryFetch: async () => { throw new Error('Telemetry network disabled in PTY test'); },
    spawnBackgroundFlush: () => { process.stdout.write('PTY_BACKGROUND_STUB\\n'); }
  });
`;

function isolatedHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gac-telemetry-pty-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".gac"));
  fs.writeFileSync(path.join(home, ".gac/config.json"), JSON.stringify({
    provider: "openai", baseUrl: "http://pty-model.invalid", model: "pty-test",
    stream: false, showThinking: false, renderMarkdown: false,
    contextWindow: 4096, maxTokens: 128,
  }));
  return home;
}

function session(home, keys, argv = ["ask", "PTY regression prompt"]) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, TERM: "xterm-256color" };
  // CI must still exercise the first-run prompt rather than its suppression gate.
  for (const name of ["CI", "DO_NOT_TRACK", "DNT", "GAC_TELEMETRY_DISABLED"]) delete env[name];
  const child = spawnSync("python3", [driver], {
    input: JSON.stringify({ node: process.execPath,
      argv: [process.execPath, "--input-type=module", "--eval", childSource(argv)],
      cwd: home, env, keys: [...Buffer.from(keys)], timeout: 8 }),
    encoding: "utf8", timeout: 12000, maxBuffer: 1024 * 1024,
  });
  assert.equal(child.error, undefined, `PTY driver failed: ${child.error}`);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.timedOut, false, `CLI froze after PTY input ${JSON.stringify(keys)}:\n${result.output}`);
  return result;
}

function readState(home) {
  const filename = path.join(home, ".gac/telemetry.json");
  return fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : null;
}

for (const [name, keys, decision] of [
  ["yes + Enter", "yes\r", "enabled"],
  ["y + Enter", "y\r", "enabled"],
  ["uppercase YES", "YES\r", "enabled"],
  ["keypad Enter", "y\x1bOM", "enabled"],
  ["invalid answer", "maybe\r", "declined"],
  ["n + Enter", "n\r", "declined"],
  ["default Enter", "\r", "declined"],
  ["Backspace correction", "n\x7fy\r", "enabled"],
  ["Left/Right cursor correction", "ys\x1b[De\x1b[C\x7fs\r", "enabled"],
]) {
  test(`real PTY: telemetry ${name} resumes the command and persists ${decision}`, { skip }, (t) => {
    const home = isolatedHome(t);
    const first = session(home, keys);
    assert.equal(first.exitCode, 0, first.output);
    assert.equal(first.sent, true);
    assert.ok(first.cursorResponses > 0, "real terminal cursor query was answered");
    assert.match(first.output, /Optional telemetry/);
    assert.match(first.output, /PTY_MODEL_OK/);
    const saved = readState(home);
    assert.equal(saved.decision, decision);
    assert.equal(saved.enabled, decision === "enabled");
    if (decision === "enabled") assert.ok(saved.installationId);
    else assert.equal(saved.installationId, null);

    const next = session(home, "");
    assert.equal(next.exitCode, 0, next.output);
    assert.equal(next.sent, false);
    assert.doesNotMatch(next.output, /Optional telemetry|Enable telemetry\?/);
    assert.match(next.output, /PTY_MODEL_OK/);
    assert.deepEqual(readState(home), saved, "saved decision is unchanged on repeat invocation");
  });
}

for (const [name, keys] of [["Escape", "\x1b"], ["Ctrl+C", "\x03"]]) {
  test(`real PTY: telemetry ${name} exits without saving; restart asks again`, { skip }, (t) => {
    const home = isolatedHome(t);
    const canceled = session(home, keys);
    assert.equal(canceled.exitCode, 130, canceled.output);
    assert.equal(canceled.sent, true);
    assert.match(canceled.output, /Canceled\./);
    assert.doesNotMatch(canceled.output, /PTY_MODEL_CALLED|PTY_MODEL_OK|PTY_BACKGROUND_STUB/);
    assert.equal(readState(home), null, "interruption must not save a consent choice");
    assert.equal(fs.existsSync(path.join(home, ".gac/telemetry-queue.ndjson")), false);

    const restarted = session(home, "n\r");
    assert.equal(restarted.exitCode, 0, restarted.output);
    assert.match(restarted.output, /Optional telemetry/);
    assert.match(restarted.output, /PTY_MODEL_OK/);
    assert.equal(readState(home).decision, "declined");
  });
}

for (const [name, keys, expectedCode, expectedDecision, message] of [
  ["accept", "y\r", 0, "enabled", /Telemetry enabled\./],
  ["decline", "n\r", 0, null, /Telemetry not enabled\./],
  ["default No", "\r", 0, null, /Telemetry not enabled\./],
  ["Escape", "\x1b", 130, null, /Canceled\./],
  ["Ctrl+C", "\x03", 130, null, /Canceled\./],
]) {
  test(`real PTY: manual telemetry enable ${name}`, { skip }, (t) => {
    const home = isolatedHome(t);
    const result = session(home, keys, ["telemetry", "enable"]);
    assert.equal(result.exitCode, expectedCode, result.output);
    assert.equal(result.sent, true);
    assert.match(result.output, message);
    assert.doesNotMatch(result.output, /PTY_MODEL_CALLED|PTY_BACKGROUND_STUB/);
    assert.equal(readState(home)?.decision ?? null, expectedDecision);
  });
}
