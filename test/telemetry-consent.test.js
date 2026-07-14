import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONSENT_STATEMENT,
  isAffirmative,
  envSuppression,
  effectiveDecision,
  isEffectivelyEnabled,
  shouldAutoPrompt,
} from "../src/telemetry/consent.js";
import { TELEMETRY_CONSENT_VERSION } from "../src/telemetry/contract.js";

const enabledState = (overrides = {}) => ({
  decision: "enabled",
  enabled: true,
  consentVersion: TELEMETRY_CONSENT_VERSION,
  installationId: "id-123",
  ...overrides,
});

test("consent statement contains the exact required text and attribution", () => {
  assert.ok(CONSENT_STATEMENT.startsWith("Optional telemetry"));
  assert.ok(CONSENT_STATEMENT.includes("Telemetry is OFF by default."));
  assert.ok(CONSENT_STATEMENT.includes("api.getgac.dev"));
  assert.ok(CONSENT_STATEMENT.includes("https://getgac.dev/telemetry"));
  assert.ok(CONSENT_STATEMENT.includes("https://getgac.dev/privacy"));
  assert.ok(CONSENT_STATEMENT.includes("Developed by alhisan >|"));
  assert.ok(CONSENT_STATEMENT.includes("source IP"));
});

test("isAffirmative treats 1/true/yes/on (case-insensitive) as affirmative", () => {
  for (const v of ["1", "true", "TRUE", "Yes", "on", "ON"]) {
    assert.equal(isAffirmative(v), true, v);
  }
  for (const v of ["0", "false", "no", "off", "", undefined, null, "2"]) {
    assert.equal(isAffirmative(v), false, String(v));
  }
});

test("envSuppression reports each active suppression variable", () => {
  assert.deepEqual(envSuppression({}), { suppressed: false, reasons: [] });
  assert.deepEqual(envSuppression({ CI: "true" }), { suppressed: true, reasons: ["CI"] });
  assert.deepEqual(envSuppression({ DO_NOT_TRACK: "1" }).reasons, ["DO_NOT_TRACK"]);
  assert.deepEqual(envSuppression({ DNT: "yes" }).reasons, ["DNT"]);
  assert.deepEqual(envSuppression({ GAC_TELEMETRY_DISABLED: "on" }).reasons, [
    "GAC_TELEMETRY_DISABLED",
  ]);
  // Non-affirmative values do not suppress.
  assert.equal(envSuppression({ CI: "false" }).suppressed, false);
});

test("effectiveDecision reflects saved state and consent versioning", () => {
  assert.equal(effectiveDecision(null), "undecided");
  assert.equal(effectiveDecision(enabledState()), "enabled");
  assert.equal(effectiveDecision({ decision: "declined" }), "declined");
  assert.equal(effectiveDecision({ decision: "disabled" }), "disabled");
  // An old consent version becomes ineffective.
  assert.equal(
    effectiveDecision(enabledState({ consentVersion: TELEMETRY_CONSENT_VERSION - 1 })),
    "consent-expired"
  );
});

test("isEffectivelyEnabled requires current consent AND no env override", () => {
  assert.equal(isEffectivelyEnabled(enabledState(), {}), true);
  assert.equal(isEffectivelyEnabled(enabledState(), { CI: "1" }), false);
  assert.equal(
    isEffectivelyEnabled(enabledState({ consentVersion: 0 }), {}),
    false,
    "expired consent is not enabled"
  );
  assert.equal(isEffectivelyEnabled({ decision: "declined" }, {}), false);
});

test("shouldAutoPrompt only for undecided + interactive + not suppressed", () => {
  assert.equal(shouldAutoPrompt(null, {}, { interactive: true }), true);
  // never non-interactive
  assert.equal(shouldAutoPrompt(null, {}, { interactive: false }), false);
  // never under env suppression
  assert.equal(shouldAutoPrompt(null, { CI: "1" }, { interactive: true }), false);
  assert.equal(shouldAutoPrompt(null, { DO_NOT_TRACK: "1" }, { interactive: true }), false);
  // never after a decision was recorded
  assert.equal(shouldAutoPrompt({ decision: "declined" }, {}, { interactive: true }), false);
  assert.equal(shouldAutoPrompt({ decision: "disabled" }, {}, { interactive: true }), false);
  assert.equal(shouldAutoPrompt(enabledState(), {}, { interactive: true }), false);
});
