import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMarkdownRenderer,
  highlightCodeLine,
  isTableRow,
  isTableSeparator,
} from "../src/markdown.js";

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

// ── Tables ──────────────────────────────────────────────────────

test("isTableRow / isTableSeparator detect GFM table lines", () => {
  assert.ok(isTableRow("| a | b |"));
  assert.ok(isTableRow("  | a | b |  "));
  assert.ok(!isTableRow("not a table"));
  assert.ok(!isTableRow("| unclosed"));
  assert.ok(isTableSeparator("| --- | ---: |"));
  assert.ok(isTableSeparator("|:---|:---:|"));
  assert.ok(!isTableSeparator("| a | b |"));
});

test("renderLine buffers table rows (null) and flushes on a non-table line", () => {
  const r = createMarkdownRenderer();
  assert.equal(r.renderLine("| a | b |"), null);
  assert.equal(r.renderLine("| --- | --- |"), null);
  assert.equal(r.renderLine("| 1 | 2 |"), null);
  const out = r.renderLine("done");
  assert.notEqual(out, null);
  const text = plain(out);
  assert.ok(text.includes("┼"), "flushed table has a separator line");
  assert.ok(text.includes("a"), "table content present");
  assert.ok(text.endsWith("done"), "current line follows the table");
});

test("renderText renders a table with alignment and padded columns", () => {
  const r = createMarkdownRenderer();
  const out = plain(
    r.renderText("| Name | Qty |\n| --- | ---: |\n| apples | 10 |\n| pears | 2 |")
  );
  assert.ok(out.includes("│"), "column separators");
  assert.ok(out.includes("┼"), "header separator");
  assert.match(out, /Name\s+│/, "first column padded to width");
  assert.match(out, /apples │\s+10/, "numeric column right-aligned");
  assert.ok(!out.includes("|"), "raw pipes replaced");
});

test("pipe lines that are not a real table fall back to plain rendering", () => {
  const r = createMarkdownRenderer();
  assert.equal(r.renderLine("| just a pipe line |"), null);
  const out = plain(r.renderLine("next"));
  assert.ok(out.includes("| just a pipe line |"), "buffered line replayed as-is");
  assert.ok(out.endsWith("next"));
});

test("flush emits a table cut off by the end of the stream", () => {
  const r = createMarkdownRenderer();
  r.renderLine("| a | b |");
  r.renderLine("| --- | --- |");
  r.renderLine("| 1 | 2 |");
  const pending = plain(r.flush());
  assert.ok(pending.includes("┼"));
  assert.equal(r.flush(), "", "flush is idempotent");
});

test("renderText flushes a trailing table", () => {
  const r = createMarkdownRenderer();
  const out = plain(r.renderText("intro\n| a | b |\n| --- | --- |\n| 1 | 2 |"));
  assert.ok(out.startsWith("intro"));
  assert.ok(out.includes("┼"));
});

// ── Syntax highlighting ─────────────────────────────────────────

function typesOf(fragments) {
  return fragments.map((f) => `${f.type}:${f.text}`);
}

test("highlightCodeLine tags keywords, strings, numbers, and comments", () => {
  const fragments = highlightCodeLine('const n = 42; // answer', "js");
  const tagged = typesOf(fragments);
  assert.ok(tagged.includes("keyword:const"), tagged.join(", "));
  assert.ok(tagged.includes("number:42"));
  assert.ok(tagged.includes("comment:// answer"));

  const py = typesOf(highlightCodeLine('print("hi")  # greet', "python"));
  assert.ok(py.includes('string:"hi"'));
  assert.ok(py.includes("comment:# greet"));
});

test("highlightCodeLine does not treat URLs as comments", () => {
  const fragments = highlightCodeLine("curl http://example.com/path", "bash");
  assert.ok(!fragments.some((f) => f.type === "comment"));
});

test("highlightCodeLine reassembles the exact input text", () => {
  const line = 'if (x === "a // b") { return 0x1F; } // done';
  const fragments = highlightCodeLine(line, "javascript");
  assert.equal(fragments.map((f) => f.text).join(""), line);
  // The // inside the string must not become a comment.
  const comment = fragments.find((f) => f.type === "comment");
  assert.equal(comment.text, "// done");
});

test("unknown languages still highlight strings and numbers only", () => {
  const fragments = highlightCodeLine('foo "bar" 12 # nope', "brainfuck");
  const tagged = typesOf(fragments);
  assert.ok(tagged.includes('string:"bar"'));
  assert.ok(tagged.includes("number:12"));
  assert.ok(!fragments.some((f) => f.type === "comment"));
  assert.ok(!fragments.some((f) => f.type === "keyword"));
});

test("fenced code with a language renders without corrupting text", () => {
  const r = createMarkdownRenderer();
  const out = plain(r.renderText('```js\nconst x = "hello"; // hi\n```\n'));
  assert.ok(out.includes('const x = "hello"; // hi'));
});

test("syntaxHighlight false keeps the legacy single-style code path", () => {
  const r = createMarkdownRenderer({ syntaxHighlight: false });
  const out = plain(r.renderText("```js\nconst x = 1\n```\n"));
  assert.ok(out.includes("const x = 1"));
});
