import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Isolate config to a throwaway HOME so runCli's loadConfig() never touches the
// real ~/.gac. config.js resolves its dir lazily, so setting this before the
// first runCli call is sufficient.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gac-cli-tel-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

import { runCli, resolveCommandAction, PROMPT_ELIGIBLE_ACTIONS } from "../src/cli.js";
import { shouldAutoPrompt } from "../src/telemetry/consent.js";
import { EVENTS, EVENT_NAMES, ATTRIBUTION } from "../src/telemetry/contract.js";
import {
  buildBashCompletion,
  buildZshCompletion,
  buildFishCompletion,
} from "../src/completions.js";
import { printHelp } from "../src/flags.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, "../src");

// Mirror the runCli gate: the one-time notice fires only for interactive,
// prompt-eligible actions when the decision is undecided and nothing suppresses.
function wouldPrompt(command, { interactive = true, state = null, env = {} } = {}) {
  const action = resolveCommandAction(command, interactive);
  return (
    interactive &&
    PROMPT_ELIGIBLE_ACTIONS.has(action) &&
    shouldAutoPrompt(state, env, { interactive })
  );
}

test("the automatic prompt fires for eligible interactive commands", () => {
  for (const command of ["ask", "suggest", "explain", "runbook", "chat", "commit", "fix"]) {
    assert.equal(wouldPrompt(command), true, command);
  }
  // A direct prompt (no known command) is also eligible.
  assert.equal(wouldPrompt("how do I list ports"), true);
});

test("the automatic prompt never fires for excluded commands", () => {
  for (const command of ["config", "auth", "models", "completions", "telemetry"]) {
    assert.equal(wouldPrompt(command), false, command);
  }
  // Interactive with no command shows help — not eligible.
  assert.equal(wouldPrompt(undefined), false);
});

test("the automatic prompt never fires non-interactively or under CI", () => {
  assert.equal(wouldPrompt("ask", { interactive: false }), false);
  assert.equal(wouldPrompt("ask", { env: { CI: "1" } }), false);
  assert.equal(wouldPrompt("ask", { env: { DO_NOT_TRACK: "1" } }), false);
});

test("the automatic prompt does not repeat after a decision", () => {
  assert.equal(wouldPrompt("ask", { state: { decision: "declined" } }), false);
  assert.equal(wouldPrompt("ask", { state: { decision: "disabled" } }), false);
});

test("shell completions include the telemetry command and subcommands", () => {
  for (const build of [buildBashCompletion, buildZshCompletion, buildFishCompletion]) {
    const out = build();
    assert.ok(out.includes("telemetry"), "command listed");
    for (const sub of ["status", "info", "enable", "disable"]) {
      assert.ok(out.includes(sub), `subcommand ${sub}`);
    }
  }
});

test("gac --help ends with the exact attribution string", () => {
  const chunks = [];
  const origWrite = process.stdout.write;
  // printHelp uses terminal-kit's term(), which writes to stdout; capture it.
  process.stdout.write = (s) => {
    chunks.push(String(s));
    return true;
  };
  try {
    printHelp();
  } finally {
    process.stdout.write = origWrite;
  }
  const text = chunks.join("");
  assert.ok(text.includes("Developed by alhisan >|"), "attribution in help");
  assert.ok(text.includes("telemetry"), "telemetry command in help");
});

test("exact attribution string is preserved verbatim", () => {
  assert.equal(ATTRIBUTION, "Developed by alhisan >|");
});

// Instrumentation coverage: every action in the catalog must be referenced as a
// quoted string literal somewhere in the source (proving each is wired to a
// call site), and every model_request action must be reachable via an explicit
// telemetryAction.
function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

test("every event/action enum is referenced in source instrumentation", () => {
  const source = collectJsFiles(srcDir)
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n");

  const missing = [];
  for (const name of EVENT_NAMES) {
    if (!source.includes(`"${name}"`)) missing.push(`event:${name}`);
    for (const action of EVENTS[name].actions) {
      if (!source.includes(`"${action}"`)) missing.push(`${name}/${action}`);
    }
  }
  assert.deepEqual(missing, [], `un-instrumented enums: ${missing.join(", ")}`);
});

// Drive runCli with a spy telemetry object for commands that need no model
// server, and assert exactly one command_completed is emitted per invocation.
function spyTelemetry() {
  const tracked = [];
  return {
    tracked,
    track: (e) => tracked.push(e),
    flush: async () => ({}),
    shouldPrompt: () => false,
    isEnabled: () => true,
    getEffectiveDecision: () => "enabled",
    info: () => "info",
    getStatus: () => ({
      savedDecision: "enabled",
      effectiveState: "enabled",
      consentVersion: 1,
      noticeVersion: 1,
      ingestEndpoint: "https://api.getgac.dev/v1/events/batch",
      contractEndpoint: "https://api.getgac.dev/v1/telemetry-contract",
      queueCount: 0,
      queueBytes: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureCategory: null,
      nextAttemptAt: null,
      suppression: { suppressed: false, reasons: [] },
    }),
  };
}

async function withSuppressedStdout(fn) {
  const orig = process.stdout.write;
  process.stdout.write = () => true;
  try {
    return await fn();
  } finally {
    process.stdout.write = orig;
  }
}

test("runCli emits one command_completed for `completions bash`", async () => {
  const tel = spyTelemetry();
  await withSuppressedStdout(() =>
    runCli(["node", "gac", "completions", "bash"], { telemetry: tel })
  );
  const done = tel.tracked.filter((e) => e.event_name === "command_completed");
  assert.equal(done.length, 1);
  assert.equal(done[0].action, "completions");
  assert.equal(done[0].properties.subcommand, "bash");
});

test("runCli emits command_completed for `--version` without prompting", async () => {
  const tel = spyTelemetry();
  await withSuppressedStdout(() => runCli(["node", "gac", "--version"], { telemetry: tel }));
  const done = tel.tracked.filter((e) => e.event_name === "command_completed");
  assert.equal(done.length, 1);
  assert.equal(done[0].action, "version");
});

test("telemetry transmission is handed to the background and never blocks a command", async () => {
  const os = await import("node:os");
  const { newEnabledState, writeState } = await import("../src/telemetry/state.js");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gac-cli-outage-"));
  const dir = path.join(home, ".gac");
  fs.mkdirSync(dir, { recursive: true });
  const io = { fs, dir, statePath: path.join(dir, "telemetry.json"), queuePath: path.join(dir, "telemetry-queue.ndjson") };
  writeState(io, newEnabledState({ installationId: "seed-id", decidedAt: "2026-07-14T00:00:00.000Z" }));

  // Inject the background-flush spawn so the test never launches a real process
  // or touches the network; the foreground command must not perform the flush.
  let backgroundSpawns = 0;
  const priorExitCode = process.exitCode;
  process.exitCode = 0;
  await withSuppressedStdout(() =>
    runCli(["node", "gac", "completions", "bash"], {
      fs,
      homeDir: home,
      env: {},
      spawnBackgroundFlush: () => {
        backgroundSpawns += 1;
        return true;
      },
    })
  );

  // The command completed normally, and transmission was deferred to the
  // background rather than performed inline.
  assert.equal(process.exitCode, 0, "exit code unaffected by telemetry");
  process.exitCode = priorExitCode;
  assert.equal(backgroundSpawns, 1, "exactly one background flush was scheduled");
  // The event is enqueued for the background worker to send — no inline flush,
  // so it is still present in the queue when the foreground command returns.
  const queued = fs.readFileSync(io.queuePath, "utf8").split("\n").filter(Boolean);
  assert.ok(queued.length >= 1, "command_completed enqueued for the background flush");
});

test("runCli never emits command_completed for the telemetry control command", async () => {
  const tel = spyTelemetry();
  await withSuppressedStdout(() =>
    runCli(["node", "gac", "telemetry", "status"], { telemetry: tel })
  );
  assert.equal(
    tel.tracked.filter((e) => e.event_name === "command_completed").length,
    0
  );
});

test("the model-request layer passes an explicit telemetry purpose", () => {
  const gpt4all = fs.readFileSync(path.join(srcDir, "gpt4all.js"), "utf8");
  assert.ok(gpt4all.includes("telemetryAction"), "explicit purpose option");
  assert.ok(gpt4all.includes("model_request_completed"));
  // The original error is preserved and rethrown after classification.
  assert.ok(gpt4all.includes("throw err"));
});
