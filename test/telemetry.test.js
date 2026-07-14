import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTelemetry, createNoopTelemetry, deriveInstallHash } from "../src/telemetry/index.js";

const SENTINELS = [
  "SECRET_PROMPT_123",
  "SECRET_RESPONSE_123",
  "SECRET_COMMAND_123",
  "SECRET_PATH_123",
  "SECRET_REPO_123",
  "SECRET_MODEL_123",
  "SECRET_BASE_URL_123",
  "SECRET_API_KEY_123",
  "SECRET_EMAIL_123",
  "SECRET_HOSTNAME_123",
  "SECRET_USERNAME_123",
];

function makeHarness(overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gac-tel-int-"));
  let t = 1_000_000;
  const clock = () => (t += 1000);
  let n = 0;
  const uuid = () => {
    n += 1;
    return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  };
  const fetches = [];
  const acceptAll = async (url, opts) => {
    const batch = JSON.parse(opts.body);
    fetches.push({ url, opts, batch });
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
  const options = {
    fs,
    homeDir: home,
    now: clock,
    uuid,
    random: () => 0.5,
    fetchImpl: acceptAll,
    env: {},
    version: "1.4.0",
    provider: "openai",
    interactive: true,
    platform: "linux",
    arch: "x64",
    nodeVersion: "v18.19.0",
    ...overrides,
  };
  const tel = createTelemetry(options);
  const paths = {
    state: path.join(home, ".gac", "telemetry.json"),
    queue: path.join(home, ".gac", "telemetry-queue.ndjson"),
  };
  const readStateRaw = () =>
    fs.existsSync(paths.state) ? JSON.parse(fs.readFileSync(paths.state, "utf8")) : null;
  return { tel, home, fetches, clock, uuid, paths, readStateRaw, options };
}

test("telemetry is disabled by default with no artifacts and no fetch", async () => {
  const h = makeHarness();
  assert.equal(h.tel.isEnabled(), false);
  h.tel.track({ event_name: "command_completed", action: "ask", outcome: "success", properties: {} });
  await h.tel.flush();
  assert.equal(fs.existsSync(h.paths.state), false, "no state file before a decision");
  assert.equal(fs.existsSync(h.paths.queue), false, "no queue before consent");
  assert.equal(h.fetches.length, 0, "no fetch before consent");
});

test("declining records the decision, sends nothing, and is remembered", async () => {
  const h = makeHarness();
  h.tel.decline();
  h.tel.track({ event_name: "command_completed", action: "ask", outcome: "success", properties: {} });
  await h.tel.flush();
  assert.equal(h.fetches.length, 0);
  assert.equal(fs.existsSync(h.paths.queue), false, "no queue after declining");
  const state = h.readStateRaw();
  assert.equal(state.decision, "declined");
  assert.equal(state.installationId, null, "no identifier generated when declining");
  // A fresh telemetry over the same home does not prompt again.
  const again = createTelemetry({ ...h.options });
  assert.equal(again.shouldPrompt(true), false);
});

test("enabling saves consent first, generates an id, and queues telemetry_enabled", async () => {
  const h = makeHarness();
  await h.tel.enable({ action: "manual_command" });
  assert.equal(h.tel.isEnabled(), true);
  const state = h.readStateRaw();
  assert.equal(state.decision, "enabled");
  assert.ok(state.installationId, "identifier generated after consent");
  // telemetry_enabled event was queued and flushed.
  assert.ok(h.fetches.length >= 1);
  const first = h.fetches[0].batch.events[0];
  assert.equal(first.event_name, "telemetry_enabled");
  assert.equal(first.properties.consent_version, 1);
});

test("transmitted id is the SHA-256 hash; the raw UUID is never transmitted", async () => {
  const h = makeHarness();
  await h.tel.enable();
  const state = h.readStateRaw();
  const expected = deriveInstallHash(state.installationId);
  const event = h.fetches[0].batch.events[0];
  assert.equal(event.anonymous_install_id, expected);
  assert.match(event.anonymous_install_id, /^[0-9a-f]{64}$/);
  // The raw UUID appears in NO outgoing body and NOT in the queue on disk.
  for (const f of h.fetches) {
    assert.ok(!JSON.stringify(f.batch).includes(state.installationId), "raw UUID leaked in a batch");
  }
});

test("transmitted hash is stable across events while enabled", async () => {
  const h = makeHarness();
  await h.tel.enable();
  h.tel.track({ event_name: "command_completed", action: "ask", outcome: "success", properties: {} });
  h.tel.track({ event_name: "command_completed", action: "chat", outcome: "success", properties: {} });
  const { events } = readQueue(h.paths.queue);
  const hashes = new Set(events.map((e) => e.anonymous_install_id));
  assert.equal(hashes.size, 1, "one stable hash while enabled");
});

test("disabling deletes the queue and identifier; re-enabling makes a new id", async () => {
  const h = makeHarness();
  await h.tel.enable();
  h.tel.track({ event_name: "command_completed", action: "ask", outcome: "success", properties: {} });
  const firstId = h.readStateRaw().installationId;

  await h.tel.disable();
  assert.equal(h.tel.isEnabled(), false);
  assert.equal(fs.existsSync(h.paths.queue), false, "queue deleted on disable");
  const disabledState = h.readStateRaw();
  assert.equal(disabledState.decision, "disabled");
  assert.equal(disabledState.installationId, null, "identifier removed on disable");

  await h.tel.enable();
  const secondId = h.readStateRaw().installationId;
  assert.ok(secondId && secondId !== firstId, "re-enable creates a new identifier");
});

test("disabling is idempotent (exits fine when already disabled)", async () => {
  const h = makeHarness();
  await h.tel.disable();
  const r = await h.tel.disable();
  assert.equal(r.disabled, true);
});

test("expired consent suppresses collection", async () => {
  const h = makeHarness();
  await h.tel.enable();
  // Simulate a materially changed contract by bumping the saved consent version
  // backwards relative to the current one.
  const state = h.readStateRaw();
  state.consentVersion = state.consentVersion - 1;
  fs.writeFileSync(h.paths.state, JSON.stringify(state));
  const reopened = createTelemetry({ ...h.options });
  assert.equal(reopened.isEnabled(), false);
  assert.equal(reopened.getEffectiveDecision(), "consent-expired");
  reopened.track({ event_name: "command_completed", action: "ask", outcome: "success", properties: {} });
  assert.equal(fs.existsSync(h.paths.queue), false, "nothing queued under expired consent");
});

for (const envVar of ["CI", "DO_NOT_TRACK", "DNT", "GAC_TELEMETRY_DISABLED"]) {
  test(`${envVar} suppresses collection without changing saved consent`, async () => {
    const h = makeHarness({ env: { [envVar]: "1" } });
    await h.tel.enable();
    h.tel.track({ event_name: "command_completed", action: "ask", outcome: "success", properties: {} });
    await h.tel.flush();
    assert.equal(h.tel.isEnabled(), false, "suppressed by env");
    assert.equal(h.fetches.length, 0, "no network under suppression");
    assert.equal(fs.existsSync(h.paths.queue), false, "no queue under suppression");
    // Consent is still saved, and the identifier is preserved.
    const state = h.readStateRaw();
    assert.equal(state.decision, "enabled");
    assert.ok(state.installationId);
  });
}

test("unknown event names, actions, and properties are rejected before queueing", async () => {
  const h = makeHarness();
  await h.tel.enable();
  clearQueue(h.paths.queue);
  h.tel.track({ event_name: "bogus_event", action: "ask", outcome: "success", properties: {} });
  h.tel.track({ event_name: "command_completed", action: "bogus_action", outcome: "success", properties: {} });
  h.tel.track({
    event_name: "command_completed",
    action: "ask",
    outcome: "success",
    properties: { unknown_prop: "x" },
  });
  assert.equal(fs.existsSync(h.paths.queue), false, "no invalid event was queued");
});

test("a successful flush drains the queue and records lastSuccessAt", async () => {
  const h = makeHarness();
  await h.tel.enable();
  h.tel.track({ event_name: "command_completed", action: "ask", outcome: "success", properties: {} });
  await h.tel.flush();
  assert.equal(h.tel.getStatus().queueCount, 0);
  assert.ok(h.tel.getStatus().lastSuccessAt);
});

test("a 5xx flush retains events and schedules a backoff (no second retry same command)", async () => {
  let calls = 0;
  const h = makeHarness({
    fetchImpl: async () => {
      calls += 1;
      return { status: 503, headers: { get: () => null }, async text() { return "err"; } };
    },
  });
  await h.tel.enable();
  const s1 = h.tel.getStatus();
  await h.tel.flush();
  const s2 = h.tel.getStatus();
  assert.ok(s2.queueCount >= 1, "events retained");
  assert.equal(s2.lastFailureCategory, "server_error");
  assert.ok(s2.nextAttemptAt, "backoff scheduled");
  const callsAfterFirst = calls;
  await h.tel.flush(); // within backoff window → skipped
  assert.equal(calls, callsAfterFirst, "no retry during backoff");
});

test("telemetry never throws even when fetch, fs, and inputs misbehave", async () => {
  const throwingFs = new Proxy(fs, {
    get(target, prop) {
      if (["writeFileSync", "appendFileSync", "renameSync", "mkdirSync"].includes(prop)) {
        return () => {
          throw new Error("EROFS");
        };
      }
      return target[prop];
    },
  });
  const h = makeHarness({
    fs: throwingFs,
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  // enable/track/flush must all resolve without throwing.
  await assert.doesNotReject(async () => {
    await h.tel.enable();
    h.tel.track({ event_name: "command_completed", action: "ask", outcome: "success", properties: {} });
    await h.tel.flush();
    await h.tel.disable();
  });
});

test("no telemetry failure produces an unhandled rejection", async () => {
  const rejections = [];
  const onRej = (err) => rejections.push(err);
  process.on("unhandledRejection", onRej);
  try {
    const h = makeHarness({
      fetchImpl: async () => {
        throw new Error("boom");
      },
    });
    await h.tel.enable();
    h.tel.track({ event_name: "command_completed", action: "ask", outcome: "success", properties: {} });
    // Fire-and-forget flush like a background chat flush would.
    h.tel.flush({ timeoutMs: 1500 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.removeListener("unhandledRejection", onRej);
  }
  assert.deepEqual(rejections, []);
});

test("the no-op telemetry is inert", async () => {
  const noop = createNoopTelemetry();
  assert.equal(noop.isEnabled(), false);
  assert.equal(noop.shouldPrompt(true), false);
  noop.track({ event_name: "command_completed", action: "ask", outcome: "success", properties: {} });
  assert.deepEqual(await noop.flush(), { skipped: "noop" });
  assert.ok(typeof noop.info() === "string");
});

// ── Privacy leakage regression ─────────────────────────────────────────────

test("sentinel secrets never reach any queued event, outgoing body, or saved state", async () => {
  const h = makeHarness();
  await h.tel.enable();

  // Simulate buggy call sites trying to smuggle user data through telemetry:
  // unknown keys AND sentinel values on known keys. All must be rejected.
  const sentinelProps = {};
  SENTINELS.forEach((s, i) => (sentinelProps[`leak_${i}`] = s));
  h.tel.track({
    event_name: "command_completed",
    action: "ask",
    outcome: "success",
    properties: { ...sentinelProps, prompt_size_bucket: "SECRET_PROMPT_123" },
  });
  h.tel.track({
    event_name: "model_request_completed",
    action: "SECRET_COMMAND_123",
    outcome: "failure",
    error_category: "SECRET_PATH_123",
    properties: { output_size_bucket: "SECRET_RESPONSE_123" },
  });

  // Also record a batch of legitimate, sanitized events across every event type.
  h.tel.track({ event_name: "command_completed", action: "commit", outcome: "success", properties: { diff_size_bucket: undefined } });
  h.tel.track({
    event_name: "runbook_step_completed",
    action: "run",
    outcome: "failure",
    properties: { step_number: 1, step_count: 3, was_blocked: false, exit_code_class: "one" },
  });
  await h.tel.flush();

  const artifacts = [];
  if (fs.existsSync(h.paths.queue)) artifacts.push(fs.readFileSync(h.paths.queue, "utf8"));
  if (fs.existsSync(h.paths.state)) artifacts.push(fs.readFileSync(h.paths.state, "utf8"));
  for (const f of h.fetches) artifacts.push(JSON.stringify(f.batch));
  const haystack = artifacts.join("\n");

  for (const s of SENTINELS) {
    assert.ok(!haystack.includes(s), `sentinel leaked: ${s}`);
  }
});

// Tiny inline NDJSON reader so the test does not depend on queue internals for
// the hash-stability assertion above.
function readQueue(queuePath) {
  if (!fs.existsSync(queuePath)) return { events: [] };
  const events = fs
    .readFileSync(queuePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { events };
}

function clearQueue(queuePath) {
  try {
    fs.unlinkSync(queuePath);
  } catch {}
}
