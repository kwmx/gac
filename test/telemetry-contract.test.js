import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildContract,
  validateEvent,
  EVENTS,
  EVENT_NAMES,
  OUTCOMES,
  INGEST_ENDPOINT,
  CONTRACT_ENDPOINT,
  TELEMETRY_DOCS_URL,
  PRIVACY_URL,
  ATTRIBUTION,
} from "../src/telemetry/contract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function baseEvent(overrides = {}) {
  return {
    event_id: "00000000-0000-4000-8000-000000000001",
    event_name: "command_completed",
    occurred_at: "2026-07-14T00:00:00.000Z",
    anonymous_install_id: "a".repeat(64),
    invocation_id: "00000000-0000-4000-8000-000000000002",
    app_version: "1.4.0",
    platform: "linux",
    arch: "x64",
    node_major: 18,
    provider: "openai_compatible",
    interactive: true,
    action: "ask",
    outcome: "success",
    duration_ms: null,
    error_category: null,
    properties: {},
    ...overrides,
  };
}

test("endpoints and attribution are exactly as specified", () => {
  assert.equal(INGEST_ENDPOINT, "https://api.getgac.dev/v1/events/batch");
  assert.equal(CONTRACT_ENDPOINT, "https://api.getgac.dev/v1/telemetry-contract");
  assert.equal(TELEMETRY_DOCS_URL, "https://getgac.dev/telemetry");
  assert.equal(PRIVACY_URL, "https://getgac.dev/privacy");
  assert.equal(ATTRIBUTION, "Developed by alhisan >|");
});

test("docs/telemetry-contract-v1.json is in sync with buildContract()", () => {
  const jsonPath = path.resolve(__dirname, "../docs/telemetry-contract-v1.json");
  const onDisk = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.deepEqual(onDisk, buildContract());
});

test("contract uses strict schemas (additionalProperties:false) for every event", () => {
  const contract = buildContract();
  for (const name of EVENT_NAMES) {
    const schema = contract.events[name].schema;
    assert.equal(schema.additionalProperties, false, `${name} envelope strict`);
    assert.equal(schema.properties.properties.additionalProperties, false, `${name} props strict`);
  }
  assert.equal(contract.envelope_schema.additionalProperties, false);
});

test("validateEvent accepts a well-formed event", () => {
  assert.ok(validateEvent(baseEvent()).ok);
});

test("validateEvent rejects unknown event names", () => {
  const r = validateEvent(baseEvent({ event_name: "not_a_real_event" }));
  assert.ok(!r.ok);
});

test("validateEvent rejects unknown action names", () => {
  const r = validateEvent(baseEvent({ action: "not_a_real_action" }));
  assert.ok(!r.ok);
});

test("validateEvent rejects unknown property names", () => {
  const r = validateEvent(baseEvent({ properties: { totally_unknown: 1 } }));
  assert.ok(!r.ok);
});

test("validateEvent rejects wrong property types and out-of-range enums", () => {
  assert.ok(!validateEvent(baseEvent({ properties: { streaming: "yes" } })).ok);
  assert.ok(!validateEvent(baseEvent({ properties: { prompt_size_bucket: "huge" } })).ok);
});

test("validateEvent enforces duration_ms is null or a nonnegative integer", () => {
  assert.ok(validateEvent(baseEvent({ duration_ms: 0 })).ok);
  assert.ok(validateEvent(baseEvent({ duration_ms: 1234 })).ok);
  assert.ok(!validateEvent(baseEvent({ duration_ms: -1 })).ok);
  assert.ok(!validateEvent(baseEvent({ duration_ms: 1.5 })).ok);
});

test("validateEvent enforces the anonymous_install_id hex format", () => {
  assert.ok(!validateEvent(baseEvent({ anonymous_install_id: "not-hex" })).ok);
  assert.ok(!validateEvent(baseEvent({ anonymous_install_id: "A".repeat(64) })).ok, "uppercase rejected");
});

test("validateEvent enforces error_category is null or a known category", () => {
  assert.ok(validateEvent(baseEvent({ error_category: "network" })).ok);
  assert.ok(!validateEvent(baseEvent({ error_category: "made_up" })).ok);
});

// Coverage: every (event_name, action) pair in the catalog must validate with an
// otherwise-empty properties object — proving the enums are internally wired.
test("every catalog event/action pair validates", () => {
  for (const name of EVENT_NAMES) {
    for (const action of EVENTS[name].actions) {
      const props = name === "telemetry_enabled" ? { consent_version: 1 } : {};
      const r = validateEvent(baseEvent({ event_name: name, action, properties: props }));
      assert.ok(r.ok, `${name}/${action} should validate: ${r.errors.join("; ")}`);
    }
  }
});

test("outcomes enum matches the spec", () => {
  assert.deepEqual(OUTCOMES, ["success", "failure", "cancelled", "no_op"]);
});

// These bounds must mirror the ingestion backend (web-gac/api src/contract/events.ts).
// The backend rejects out-of-range values, so the client schema must match to
// avoid queueing events that would be rejected server-side.
test("integer property bounds mirror the backend contract", () => {
  const step = EVENTS.runbook_step_completed.properties;
  assert.deepEqual(step.step_number, { type: "integer", minimum: 1, maximum: 100 });
  assert.deepEqual(step.step_count, { type: "integer", minimum: 1, maximum: 100 });

  const enabled = EVENTS.telemetry_enabled.properties;
  assert.deepEqual(enabled.consent_version, { type: "integer", minimum: 0, maximum: 1000 });

  // runbook_plan_completed step counts are 0-based (a plan may have 0 steps).
  const plan = EVENTS.runbook_plan_completed.properties;
  assert.deepEqual(plan.step_count, { type: "integer", minimum: 0, maximum: 100 });
});

test("runbook_step_completed rejects step_number/step_count below 1", () => {
  const evt = baseEvent({
    event_name: "runbook_step_completed",
    action: "run",
    properties: { step_number: 0, step_count: 0, was_blocked: false },
  });
  assert.ok(!validateEvent(evt).ok, "0 must be rejected (backend requires >= 1)");
  evt.properties = { step_number: 1, step_count: 4, was_blocked: false };
  assert.ok(validateEvent(evt).ok);
});
