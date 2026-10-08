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

test("cancelable input preserves submission and terminal-kit editing bindings", () => {
  const { keyBindings } = withCancelableKeyBindings();
  assert.deepEqual(keyBindings, {
    ENTER: "submit", KP_ENTER: "submit", ESCAPE: "cancel", CTRL_C: "cancel",
    BACKSPACE: "backDelete", DELETE: "delete", LEFT: "backward", RIGHT: "forward",
    UP: "historyPrevious", DOWN: "historyNext", HOME: "startOfInput", END: "endOfInput",
    TAB: "autoComplete", CTRL_R: "autoCompleteUsingHistory", CTRL_LEFT: "previousWord",
    CTRL_RIGHT: "nextWord", ALT_D: "deleteNextWord", CTRL_W: "deletePreviousWord",
    CTRL_U: "deleteAllBefore", CTRL_K: "deleteAllAfter",
  });
});

test("custom bindings are retained without mutating options or disabling cancellation", () => {
  const options = { keyBindings: { TAB: "submit", ESCAPE: "submit", CTRL_C: "submit" } };
  const result = withCancelableKeyBindings(options);
  assert.equal(result.keyBindings.TAB, "submit");
  assert.equal(result.keyBindings.ENTER, "submit");
  assert.equal(result.keyBindings.ESCAPE, "cancel");
  assert.equal(result.keyBindings.CTRL_C, "cancel");
  assert.equal(options.keyBindings.ESCAPE, "submit");
  result.keyBindings.ENTER = "cancel";
  assert.equal(withCancelableKeyBindings().keyBindings.ENTER, "submit");
});

test("canceled terminal input is distinct from an empty answer", () => {
  assert.equal(isCanceledInput(new Error("cancel"), ""), true);
  assert.equal(isCanceledInput(null, undefined), true);
  assert.equal(isCanceledInput(null, null), true);
  assert.equal(isCanceledInput(null, ""), false);
});
