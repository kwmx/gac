import { test } from "node:test";
import assert from "node:assert/strict";
import { createMarkdownRenderer } from "../src/markdown.js";

// Strip SGR color/style escape sequences so assertions look at plain text.
function plain(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("renderText resets state between documents (unbalanced fence does not leak)", () => {
  const r = createMarkdownRenderer();
  // A message that opens a code fence but never closes it.
  r.renderText("intro\n```js\nconsole.log(1)");
  assert.equal(r.state.inCodeBlock, true);

  // The next document must render as prose, not as a continued code block.
  const out = r.renderText("A normal paragraph.");
  assert.equal(r.state.inCodeBlock, false);
  assert.ok(!out.includes("│"), "should not carry the code gutter into the next document");
  assert.equal(plain(out), "A normal paragraph.");
});

test("renders a level-1 header with an underline", () => {
  const r = createMarkdownRenderer();
  const out = plain(r.renderText("# Title\n"));
  assert.ok(out.includes("Title"));
  assert.ok(out.includes("─"), "level-1 header should be underlined");
});

test("fenced code blocks get a border and gutter", () => {
  const r = createMarkdownRenderer();
  const out = plain(r.renderText("```js\nx = 1\n```\n"));
  assert.ok(out.includes("┌"), "opening border");
  assert.ok(out.includes("└"), "closing border");
  assert.ok(out.includes("│"), "code gutter");
  assert.ok(out.includes("x = 1"));
});

test("inline markdown is unwrapped in output text", () => {
  const r = createMarkdownRenderer();
  const out = plain(r.renderText("This is **bold** and `code` and _em_."));
  // The markers are consumed; the inner text remains.
  assert.ok(out.includes("bold"));
  assert.ok(out.includes("code"));
  assert.ok(out.includes("em"));
  assert.ok(!out.includes("**"));
  assert.ok(!out.includes("`"));
});

test("links render as label followed by the url", () => {
  const r = createMarkdownRenderer();
  const out = plain(r.renderText("See [docs](https://example.com)."));
  assert.ok(out.includes("docs"));
  assert.ok(out.includes("(https://example.com)"));
});
