import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTelemetry } from "../src/telemetry/index.js";
import { runTelemetryCommand } from "../src/telemetrycli.js";

function harness(overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gac-telcli-"));
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;
  let t = 1000;
  let fetchCalls = 0;
  const fetchImpl = async (url, opts) => {
    fetchCalls += 1;
    const batch = JSON.parse(opts.body);
    return {
      status: 202,
      headers: { get: () => null },
      async text() {
        return JSON.stringify({
          request_id: "r",
          accepted_event_ids: batch.events.map((e) => e.event_id),
          duplicate_event_ids: [],
          rejected: [],
          server_time: "2026-07-14T00:00:00.000Z",
        });
      },
    };
  };
  const tel = createTelemetry({
    fs,
    homeDir: home,
    uuid,
    now: () => (t += 1000),
    random: () => 0,
    fetchImpl,
    env: {},
    version: "1.4.0",
    provider: "openai",
    interactive: true,
    ...overrides,
  });
  const out = [];
  const deps = {
    write: (s) => out.push(s),
    confirm: async () => false,
    interactive: true,
  };
  return { tel, out, deps, getFetchCalls: () => fetchCalls, home };
}

test("`telemetry status` makes no network request", async () => {
  const h = harness();
  const code = await runTelemetryCommand(["status"], h.tel, h.deps);
  assert.equal(code, 0);
  assert.equal(h.getFetchCalls(), 0);
  const text = h.out.join("");
  assert.ok(text.includes("GAC telemetry status"));
  assert.ok(text.includes("https://api.getgac.dev/v1/events/batch"));
  // Must not reveal a raw UUID or hash.
  assert.ok(!/[0-9a-f]{64}/.test(text), "no transmitted hash in status");
});

test("no-arg telemetry behaves like status", async () => {
  const h = harness();
  await runTelemetryCommand([], h.tel, h.deps);
  assert.ok(h.out.join("").includes("GAC telemetry status"));
  assert.equal(h.getFetchCalls(), 0);
});

test("`telemetry info` makes no request and shows the attribution", async () => {
  const h = harness();
  const code = await runTelemetryCommand(["info"], h.tel, h.deps);
  assert.equal(code, 0);
  assert.equal(h.getFetchCalls(), 0);
  const text = h.out.join("");
  assert.ok(text.includes("Developed by alhisan >|"));
  assert.ok(text.includes("Never collected"));
  assert.ok(text.includes("Event catalog"));
});

test("`telemetry disable` makes no request and exits successfully", async () => {
  const h = harness();
  const code = await runTelemetryCommand(["disable"], h.tel, h.deps);
  assert.equal(code, 0);
  assert.equal(h.getFetchCalls(), 0);
  assert.equal(h.tel.getEffectiveDecision(), "disabled");
});

test("non-interactive enable refuses without --yes and exits nonzero", async () => {
  const h = harness();
  const code = await runTelemetryCommand(["enable"], h.tel, {
    ...h.deps,
    interactive: false,
  });
  assert.equal(code, 1);
  assert.ok(h.out.join("").includes("--yes"));
  assert.equal(h.tel.isEnabled(), false, "not enabled");
});

test("non-interactive enable --yes prints the statement and enables", async () => {
  const h = harness();
  const code = await runTelemetryCommand(["enable", "--yes"], h.tel, {
    ...h.deps,
    interactive: false,
  });
  assert.equal(code, 0);
  const text = h.out.join("");
  assert.ok(text.includes("Optional telemetry"), "statement printed");
  assert.equal(h.tel.isEnabled(), true);
});

test("interactive enable defaults to No and does not enable on decline", async () => {
  const h = harness();
  const code = await runTelemetryCommand(["enable"], h.tel, {
    ...h.deps,
    confirm: async () => false, // user pressed Enter → No
    interactive: true,
  });
  assert.equal(code, 0);
  assert.equal(h.tel.isEnabled(), false);
  assert.ok(h.out.join("").includes("Telemetry not enabled."));
});

test("interactive enable cancellation exits without saving a decision", async () => {
  const h = harness();
  const code = await runTelemetryCommand(["enable"], h.tel, {
    ...h.deps,
    confirm: async () => null,
    interactive: true,
  });
  assert.equal(code, 130);
  assert.equal(h.tel.getEffectiveDecision(), "undecided");
  assert.ok(h.out.join("").includes("Canceled."));
});

test("interactive enable enables on an affirmative confirmation", async () => {
  const h = harness();
  const code = await runTelemetryCommand(["enable"], h.tel, {
    ...h.deps,
    confirm: async () => true,
    interactive: true,
  });
  assert.equal(code, 0);
  assert.equal(h.tel.isEnabled(), true);
});
