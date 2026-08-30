import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFieldInputOptions,
  resolveApiKeyEdit,
  maskApiKey,
  telemetryMenuLabel,
  telemetryToggleAction,
} from "../src/configtui.js";

const SENTINEL = "SUPER_SECRET_API_KEY_DO_NOT_PRINT";

test("buildFieldInputOptions never seeds the raw key as a visible default", () => {
  const options = buildFieldInputOptions({ key: "apiKey", mask: true }, SENTINEL);
  // The current key must not become an editable default in the input field.
  assert.ok(!("default" in options), "secret field must not carry a default value");
  assert.equal(options.echoChar, "•", "secret input must be masked while typing");
  assert.equal(options.keyBindings.CTRL_C, "cancel");
  assert.ok(!JSON.stringify(options).includes(SENTINEL));
});

test("buildFieldInputOptions keeps the current value editable for normal fields", () => {
  const options = buildFieldInputOptions({ key: "model" }, "gpt4all");
  assert.equal(options.default, "gpt4all");
  assert.equal(options.keyBindings.CTRL_C, "cancel");
  assert.equal(options.echoChar, undefined);
});

test("resolveApiKeyEdit keeps the existing key on empty or canceled input", () => {
  assert.deepEqual(resolveApiKeyEdit("", SENTINEL), { action: "keep" });
  assert.deepEqual(resolveApiKeyEdit("   ", SENTINEL), { action: "keep" });
  assert.deepEqual(resolveApiKeyEdit(null, SENTINEL), { action: "keep" });
  assert.deepEqual(resolveApiKeyEdit(undefined, SENTINEL), { action: "keep" });
});

test("resolveApiKeyEdit removes the key only on an explicit 'clear'", () => {
  assert.deepEqual(resolveApiKeyEdit("clear", SENTINEL), { action: "clear", value: "" });
  assert.deepEqual(resolveApiKeyEdit("CLEAR", SENTINEL), { action: "clear", value: "" });
  assert.deepEqual(resolveApiKeyEdit(" Clear ", SENTINEL), { action: "clear", value: "" });
});

test("resolveApiKeyEdit sets any other non-empty value as the new key", () => {
  assert.deepEqual(resolveApiKeyEdit("sk-new-key-123", SENTINEL), {
    action: "set",
    value: "sk-new-key-123",
  });
});

test("maskApiKey never returns the full key", () => {
  assert.ok(!maskApiKey(SENTINEL).includes(SENTINEL));
  assert.equal(maskApiKey(""), "(empty)");
});

test("telemetryMenuLabel reflects state and notes env suppression", () => {
  assert.equal(
    telemetryMenuLabel({ effectiveState: "enabled", suppression: { suppressed: false, reasons: [] } }),
    "Telemetry: enabled"
  );
  assert.equal(
    telemetryMenuLabel({ effectiveState: "disabled", suppression: { suppressed: false, reasons: [] } }),
    "Telemetry: disabled"
  );
  assert.equal(
    telemetryMenuLabel({ effectiveState: "disabled", suppression: { suppressed: true, reasons: ["CI"] } }),
    "Telemetry: disabled (suppressed by CI)"
  );
  assert.equal(telemetryMenuLabel(null), "Telemetry: (unknown)");
});

test("telemetryToggleAction disables only when currently enabled", () => {
  assert.equal(telemetryToggleAction("enabled"), "disable");
  assert.equal(telemetryToggleAction("disabled"), "enable");
  assert.equal(telemetryToggleAction("declined"), "enable");
  assert.equal(telemetryToggleAction("undecided"), "enable");
});
