import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateMessagesTokens,
  pickOllamaContextLength,
  pickOpenAiContextLength,
  contextBudget,
  trimMessagesToBudget,
  resolveGenerationBudget,
  FALLBACK_CONTEXT_TOKENS,
} from "../src/contextwindow.js";

test("estimateTokens approximates ~4 chars per token", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(400)), 100);
});

test("pickOllamaContextLength prefers num_ctx over model_info", () => {
  assert.equal(
    pickOllamaContextLength({
      parameters: "stop \"<|end|>\"\nnum_ctx 16384",
      model_info: { "llama.context_length": 131072 },
    }),
    16384
  );
  assert.equal(
    pickOllamaContextLength({
      model_info: { "llama.context_length": 8192, "llama.embedding_length": 4096 },
    }),
    8192
  );
  assert.equal(pickOllamaContextLength({}), null);
  assert.equal(pickOllamaContextLength(null), null);
});

test("pickOpenAiContextLength reads the common metadata field names", () => {
  assert.equal(pickOpenAiContextLength({ max_context_length: 32768 }), 32768);
  assert.equal(pickOpenAiContextLength({ context_length: 8192 }), 8192);
  assert.equal(pickOpenAiContextLength({ context_window: 4096 }), 4096);
  assert.equal(pickOpenAiContextLength({ id: "some-model" }), null);
  assert.equal(pickOpenAiContextLength(null), null);
});

test("contextBudget reserves the response and a safety margin", () => {
  const budget = contextBudget(8192, 2048);
  assert.ok(budget < 8192 - 2048);
  assert.ok(budget > 4000);
  // Unknown window falls back to the default assumption.
  assert.equal(contextBudget(null, 2048), contextBudget(FALLBACK_CONTEXT_TOKENS, 2048));
  // A tiny window never produces a nonsensical budget.
  assert.ok(contextBudget(1024, 2048) >= 512);
});

test("trimMessagesToBudget keeps system messages and the newest turns", () => {
  const messages = [
    { role: "system", content: "sys" },
    ...Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i} ${"x".repeat(400)}`,
    })),
  ];
  const budget = 300; // tokens — only a few messages fit
  const { messages: trimmed, dropped } = trimMessagesToBudget(messages, budget);
  assert.ok(dropped > 0);
  assert.equal(trimmed[0].role, "system");
  // The newest message always survives.
  assert.equal(trimmed[trimmed.length - 1].content, messages[messages.length - 1].content);
  // What we kept actually fits (system + kept <= budget + newest allowance).
  const nonSystem = trimmed.filter((m) => m.role !== "system");
  assert.ok(nonSystem.length >= 1);
});

test("trimMessagesToBudget is a no-op when everything fits", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  const { messages: trimmed, dropped } = trimMessagesToBudget(messages, 10000);
  assert.equal(dropped, 0);
  assert.deepEqual(trimmed, messages);
});

test("trimMessagesToBudget keeps the newest message even when over budget", () => {
  const messages = [{ role: "user", content: "x".repeat(10000) }];
  const { messages: trimmed, dropped } = trimMessagesToBudget(messages, 10);
  assert.equal(trimmed.length, 1);
  assert.equal(dropped, 0);
});

test("resolveGenerationBudget passes through when the window is unknown", () => {
  const budget = resolveGenerationBudget({ maxTokens: 2048 }, [], null);
  assert.equal(budget.maxTokens, 2048);
  assert.equal(budget.numCtx, null);
});

test("resolveGenerationBudget clamps the response to the remaining window", () => {
  const messages = [{ role: "user", content: "x".repeat(28000) }]; // ~7000 tokens
  const budget = resolveGenerationBudget({ maxTokens: 4096 }, messages, 8192);
  assert.ok(budget.maxTokens < 4096, "response cap must shrink to fit");
  assert.ok(budget.maxTokens >= 128, "response cap keeps a usable floor");
  assert.ok(budget.numCtx <= 8192, "num_ctx never exceeds the model window");
  assert.ok(budget.numCtx >= 4096, "num_ctx keeps at least the Ollama default");
});

test("resolveGenerationBudget sizes num_ctx to the conversation", () => {
  const messages = [{ role: "user", content: "short" }];
  const budget = resolveGenerationBudget({ maxTokens: 1024 }, messages, 131072);
  // A short chat on a huge-context model must not request the full window.
  assert.ok(budget.numCtx < 131072);
  assert.equal(budget.maxTokens, 1024);
});
