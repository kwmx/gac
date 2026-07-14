import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateMessagesTokens,
  pickOllamaContextLength,
  pickOpenAiContextLength,
  pickOllamaMaxTokens,
  pickOpenAiMaxTokens,
  contextBudget,
  trimMessagesToBudget,
  resolveGenerationBudget,
  resolveMaxTokens,
  detectModelLimits,
  FALLBACK_CONTEXT_TOKENS,
  CODEX_CONTEXT_TOKENS,
  CODEX_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_TOKENS,
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

test("pickOllamaMaxTokens reads a positive num_predict from the modelfile", () => {
  assert.equal(pickOllamaMaxTokens({ parameters: "num_predict 4096" }), 4096);
  assert.equal(
    pickOllamaMaxTokens({ parameters: 'stop "<|end|>"\nnum_predict "1024"' }),
    1024
  );
  // -1/-2 are Ollama's "unlimited"/"fill context", not usable caps.
  assert.equal(pickOllamaMaxTokens({ parameters: "num_predict -1" }), null);
  assert.equal(pickOllamaMaxTokens({}), null);
  assert.equal(pickOllamaMaxTokens(null), null);
});

test("pickOpenAiMaxTokens reads the common output-limit field names", () => {
  assert.equal(pickOpenAiMaxTokens({ max_output_tokens: 8192 }), 8192);
  assert.equal(pickOpenAiMaxTokens({ max_completion_tokens: 4096 }), 4096);
  assert.equal(
    pickOpenAiMaxTokens({ top_provider: { max_completion_tokens: 16384 } }),
    16384
  );
  assert.equal(pickOpenAiMaxTokens({ id: "some-model" }), null);
  assert.equal(pickOpenAiMaxTokens(null), null);
});

test("resolveMaxTokens: explicit config wins, auto uses the model definition", async () => {
  // Explicit numbers pass straight through, including <= 0 (no cap).
  assert.equal(await resolveMaxTokens({ provider: "codex", maxTokens: 4096 }), 4096);
  assert.equal(await resolveMaxTokens({ provider: "codex", maxTokens: 0 }), 0);
  assert.equal(await resolveMaxTokens({ provider: "codex", maxTokens: -1 }), -1);
  // "auto" (the default) takes the limit from the model definition.
  assert.equal(
    await resolveMaxTokens({ provider: "codex", maxTokens: "auto" }),
    CODEX_MAX_OUTPUT_TOKENS
  );
});

test("detectModelLimits reports the Codex family limits without probing", async () => {
  const limits = await detectModelLimits({ provider: "codex" });
  assert.equal(limits.contextWindow, CODEX_CONTEXT_TOKENS);
  assert.equal(limits.maxTokens, CODEX_MAX_OUTPUT_TOKENS);
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

test("resolveGenerationBudget never raises a deliberately small maxTokens", () => {
  // Chat title generation uses maxTokens: 12; the response floor must not
  // silently turn that into 128.
  const budget = resolveGenerationBudget(
    { maxTokens: 12 },
    [{ role: "user", content: "hi" }],
    8192
  );
  assert.equal(budget.maxTokens, 12);
});

test("resolveGenerationBudget lifts the cap when maxTokens is 0 or less", () => {
  // maxTokens <= 0 means "answer as long as necessary": no response cap, and
  // Ollama gets the full model window since the reply may fill it.
  const uncapped = resolveGenerationBudget(
    { maxTokens: 0 },
    [{ role: "user", content: "hi" }],
    8192
  );
  assert.equal(uncapped.maxTokens, null);
  assert.equal(uncapped.numCtx, 8192);

  const negative = resolveGenerationBudget({ maxTokens: -1 }, [], null);
  assert.equal(negative.maxTokens, null);
  assert.equal(negative.numCtx, null);

  // A missing maxTokens still falls back to the 2048 default, not unlimited.
  const missing = resolveGenerationBudget({}, [], null);
  assert.equal(missing.maxTokens, 2048);
});

test("contextBudget keeps the default response reserve when the cap is lifted", () => {
  assert.equal(contextBudget(8192, 0), contextBudget(8192, 2048));
  assert.equal(contextBudget(8192, -5), contextBudget(8192, 2048));
});

test("resolveGenerationBudget quantizes num_ctx so it stays stable across turns", () => {
  // Ollama reloads the model when num_ctx changes; growing prompts must land
  // on the same power-of-two step, not a new value every message.
  const turnA = resolveGenerationBudget(
    { maxTokens: 2048 },
    [{ role: "user", content: "x".repeat(17000) }],
    32768
  );
  const turnB = resolveGenerationBudget(
    { maxTokens: 2048 },
    [{ role: "user", content: "x".repeat(18000) }],
    32768
  );
  assert.equal(turnA.numCtx, turnB.numCtx);
  assert.equal(turnA.numCtx % 4096, 0, "num_ctx sits on a quantized step");
});
