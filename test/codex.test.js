import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convertMessagesToCodexInput,
  getCodexTextDelta,
  getCodexReasoningDelta,
  extractCodexFinalText,
  extractCodexErrorMessage,
  normalizeCodexBaseUrl,
  resolveCodexModel,
  listCodexModels,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_BASE_URL,
} from "../src/codex.js";

test("convertMessagesToCodexInput maps roles to Responses API items", () => {
  const { instructions, input } = convertMessagesToCodexInput([
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "bye" },
  ]);
  assert.equal(instructions, "be terse");
  assert.deepEqual(input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "bye" }] },
  ]);
});

test("convertMessagesToCodexInput joins multiple system prompts and skips empties", () => {
  const { instructions, input } = convertMessagesToCodexInput([
    { role: "system", content: "one" },
    { role: "system", content: "two" },
    { role: "user", content: "" },
    null,
  ]);
  assert.equal(instructions, "one\n\ntwo");
  assert.deepEqual(input, []);
});

test("convertMessagesToCodexInput returns null instructions when no system prompt", () => {
  const { instructions } = convertMessagesToCodexInput([{ role: "user", content: "hi" }]);
  assert.equal(instructions, null);
});

test("getCodexTextDelta reads output_text deltas only", () => {
  assert.equal(getCodexTextDelta({ type: "response.output_text.delta", delta: "hi" }), "hi");
  assert.equal(getCodexTextDelta({ type: "response.reasoning_summary_text.delta", delta: "x" }), "");
  assert.equal(getCodexTextDelta({}), "");
  assert.equal(getCodexTextDelta(null), "");
});

test("getCodexReasoningDelta reads reasoning summary and raw reasoning deltas", () => {
  assert.equal(
    getCodexReasoningDelta({ type: "response.reasoning_summary_text.delta", delta: "th" }),
    "th"
  );
  assert.equal(
    getCodexReasoningDelta({ type: "response.reasoning_text.delta", delta: "ink" }),
    "ink"
  );
  assert.equal(getCodexReasoningDelta({ type: "response.output_text.delta", delta: "x" }), "");
});

test("extractCodexFinalText collects output_text parts from message items", () => {
  const response = {
    output: [
      { type: "reasoning", summary: [] },
      {
        type: "message",
        content: [
          { type: "output_text", text: "Hello " },
          { type: "output_text", text: "world" },
        ],
      },
    ],
  };
  assert.equal(extractCodexFinalText(response), "Hello world");
  assert.equal(extractCodexFinalText({}), "");
  assert.equal(extractCodexFinalText(null), "");
});

test("extractCodexErrorMessage handles detail, error.message, nested response, and raw text", () => {
  assert.equal(extractCodexErrorMessage('{"detail":"Rate limited"}'), "Rate limited");
  assert.equal(
    extractCodexErrorMessage({ error: { message: "bad model" } }),
    "bad model"
  );
  assert.equal(
    extractCodexErrorMessage({
      type: "response.failed",
      response: { error: { message: "boom" } },
    }),
    "boom"
  );
  assert.equal(extractCodexErrorMessage("plain text"), "plain text");
  assert.equal(extractCodexErrorMessage(null), "");
});

test("normalizeCodexBaseUrl trims slashes and falls back to the default", () => {
  assert.equal(
    normalizeCodexBaseUrl("https://chatgpt.com/backend-api/codex/"),
    "https://chatgpt.com/backend-api/codex"
  );
  assert.equal(normalizeCodexBaseUrl(""), DEFAULT_CODEX_BASE_URL);
  assert.equal(normalizeCodexBaseUrl(undefined), DEFAULT_CODEX_BASE_URL);
});

test("resolveCodexModel prefers codexModel and defaults otherwise", () => {
  assert.equal(resolveCodexModel({ codexModel: "gpt-5.1-codex-mini" }), "gpt-5.1-codex-mini");
  assert.equal(resolveCodexModel({ codexModel: "  " }), DEFAULT_CODEX_MODEL);
  assert.equal(resolveCodexModel({ model: "Llama 3 8B" }), DEFAULT_CODEX_MODEL);
  assert.equal(resolveCodexModel({}), DEFAULT_CODEX_MODEL);
});

test("listCodexModels returns a fresh copy including the default", () => {
  const models = listCodexModels();
  assert.ok(models.includes(DEFAULT_CODEX_MODEL));
  models.push("mutated");
  assert.ok(!listCodexModels().includes("mutated"));
});
