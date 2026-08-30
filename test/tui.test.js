import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractLastCodeBlock,
  isCanceledInput,
  withCancelableKeyBindings,
} from "../src/tui.js";

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

test("cancelable input maps both Esc and Ctrl+C to cancel", () => {
  const options = withCancelableKeyBindings({ default: "n" });
  assert.equal(options.cancelable, true);
  assert.equal(options.default, "n");
  assert.equal(options.keyBindings.ESCAPE, "cancel");
  assert.equal(options.keyBindings.CTRL_C, "cancel");
});

test("canceled terminal input is distinct from an empty answer", () => {
  assert.equal(isCanceledInput(new Error("cancel"), ""), true);
  assert.equal(isCanceledInput(null, undefined), true);
  assert.equal(isCanceledInput(null, null), true);
  assert.equal(isCanceledInput(null, ""), false);
});
