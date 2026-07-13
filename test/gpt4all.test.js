import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getContentDelta,
  getOllamaContentDelta,
  normalizeOpenAiBaseUrl,
  normalizeOllamaBaseUrl,
  stripThinkingBlocks,
  extract503Message,
  createThinkingParser,
} from "../src/gpt4all.js";

test("normalizeOpenAiBaseUrl appends /v1 and trims trailing slash", () => {
  assert.equal(normalizeOpenAiBaseUrl("http://localhost:4891"), "http://localhost:4891/v1");
  assert.equal(normalizeOpenAiBaseUrl("http://localhost:4891/"), "http://localhost:4891/v1");
  // Already versioned URLs are left as-is.
  assert.equal(normalizeOpenAiBaseUrl("http://localhost:4891/v1"), "http://localhost:4891/v1");
});

test("normalizeOllamaBaseUrl only trims a trailing slash", () => {
  assert.equal(normalizeOllamaBaseUrl("http://localhost:11434/"), "http://localhost:11434");
  assert.equal(normalizeOllamaBaseUrl("http://localhost:11434"), "http://localhost:11434");
});

test("getContentDelta reads the various OpenAI shapes", () => {
  assert.equal(getContentDelta({ choices: [{ delta: { content: "hi" } }] }), "hi");
  assert.equal(getContentDelta({ choices: [{ message: { content: "yo" } }] }), "yo");
  assert.equal(getContentDelta({ choices: [{ text: "raw" }] }), "raw");
  assert.equal(getContentDelta({}), "");
  assert.equal(getContentDelta(null), "");
});

test("getOllamaContentDelta reads chat and generate shapes", () => {
  assert.equal(getOllamaContentDelta({ message: { content: "hi" } }), "hi");
  assert.equal(getOllamaContentDelta({ response: "gen" }), "gen");
  assert.equal(getOllamaContentDelta({}), "");
});

test("stripThinkingBlocks removes think blocks and trims", () => {
  assert.equal(stripThinkingBlocks("<think>reasoning</think>answer"), "answer");
  assert.equal(stripThinkingBlocks("before <think>x</think> after"), "before  after");
  assert.equal(stripThinkingBlocks("no tags here"), "no tags here");
});

test("extract503Message pulls the error message or falls back", () => {
  assert.equal(
    extract503Message(JSON.stringify({ error: { message: "model loading" } })),
    "model loading"
  );
  assert.equal(extract503Message("not json"), "Server unavailable");
});

// Drive the streaming <think> splitter one character at a time (as the real
// stream does) and confirm content and thinking are separated correctly, even
// when the tags are split across chunks.
function runThinkingParser(chunks) {
  let content = "";
  let thinking = "";
  const parser = createThinkingParser({
    onContent: (c) => (content += c),
    onThinking: (c) => (thinking += c),
    onThinkingEnd: () => {},
  });
  for (const chunk of chunks) parser.push(chunk);
  parser.flush();
  return { content, thinking };
}

test("thinking parser separates content from a complete think block", () => {
  const { content, thinking } = runThinkingParser(["Hello <think>secret</think>World"]);
  assert.equal(content, "Hello World");
  assert.equal(thinking, "secret");
});

test("thinking parser handles tags split across chunks", () => {
  const { content, thinking } = runThinkingParser([
    "Hi ",
    "<thi",
    "nk>rea",
    "son</thi",
    "nk>done",
  ]);
  assert.equal(content, "Hi done");
  assert.equal(thinking, "reason");
});

test("thinking parser treats a lone '<' as content", () => {
  const { content, thinking } = runThinkingParser(["a < b and c"]);
  assert.equal(content, "a < b and c");
  assert.equal(thinking, "");
});

test("thinking parser flushes an unterminated think block as thinking", () => {
  // Stream cut off mid-thought: no </think>, no completion.
  const { content, thinking } = runThinkingParser(["visible <think>cut off"]);
  assert.equal(content, "visible ");
  assert.equal(thinking, "cut off");
});
