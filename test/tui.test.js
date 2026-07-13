import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLastCodeBlock } from "../src/tui.js";

test("extractLastCodeBlock returns the last fenced block", () => {
  const text = [
    "First:",
    "```js",
    "const a = 1;",
    "```",
    "Then:",
    "```bash",
    "echo hi",
    "```",
  ].join("\n");
  assert.equal(extractLastCodeBlock(text), "echo hi");
});

test("extractLastCodeBlock handles multi-line blocks and no-lang fences", () => {
  const text = "```\nline one\nline two\n```";
  assert.equal(extractLastCodeBlock(text), "line one\nline two");
});

test("extractLastCodeBlock returns null when there is no block", () => {
  assert.equal(extractLastCodeBlock("just prose"), null);
  assert.equal(extractLastCodeBlock(""), null);
  assert.equal(extractLastCodeBlock(null), null);
});
