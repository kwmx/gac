import { test } from "node:test";
import assert from "node:assert/strict";
import {
  truncateForContext,
  fenceFor,
  attachInputToPrompt,
  formatFileContexts,
} from "../src/input.js";

test("truncateForContext keeps short text untouched", () => {
  const { text, truncated } = truncateForContext("hello", 100);
  assert.equal(text, "hello");
  assert.equal(truncated, false);
});

test("truncateForContext keeps head and tail with a marker", () => {
  const input = "A".repeat(500) + "B".repeat(500);
  const { text, truncated } = truncateForContext(input, 100);
  assert.equal(truncated, true);
  assert.ok(text.startsWith("A"), "head is preserved");
  assert.ok(text.endsWith("B"), "tail is preserved");
  assert.match(text, /characters truncated/);
  assert.ok(text.length < input.length);
});

test("fenceFor outgrows backtick runs in the content", () => {
  assert.equal(fenceFor("plain text"), "```");
  assert.equal(fenceFor("has ``` fence"), "````");
  assert.equal(fenceFor("has ````` five"), "``````");
});

test("attachInputToPrompt combines prompt and piped input", () => {
  assert.equal(attachInputToPrompt("explain this", ""), "explain this");
  assert.equal(attachInputToPrompt("", "raw piped"), "raw piped");
  const combined = attachInputToPrompt("explain this", "some log line");
  assert.ok(combined.startsWith("explain this"));
  assert.match(combined, /Input:\n```\nsome log line\n```/);
});

test("formatFileContexts renders fenced blocks with truncation notice", () => {
  const files = [
    { path: "a.txt", content: "short" },
    { path: "b.txt", content: "y".repeat(1000) },
  ];
  const output = formatFileContexts(files, 100);
  assert.match(output, /File: a\.txt\n```\nshort\n```/);
  assert.match(output, /File: b\.txt \(truncated\)/);
});
