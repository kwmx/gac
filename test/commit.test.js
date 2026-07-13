import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCommitMessage } from "../src/commit.js";

test("cleanCommitMessage strips code fences", () => {
  assert.equal(cleanCommitMessage("```\nfeat: add thing\n```"), "feat: add thing");
  assert.equal(cleanCommitMessage("```text\nfix: bug\n```"), "fix: bug");
});

test("cleanCommitMessage strips labels and quotes", () => {
  assert.equal(cleanCommitMessage('Commit message: "feat: add thing"'), "feat: add thing");
  assert.equal(cleanCommitMessage("'fix: bug'"), "fix: bug");
});

test("cleanCommitMessage keeps subject and body structure", () => {
  const message = "feat: add thing\n\nThis explains why the thing was added.";
  assert.equal(cleanCommitMessage(message), message);
});

test("cleanCommitMessage collapses excessive blank lines and CRLF", () => {
  assert.equal(
    cleanCommitMessage("subject\r\n\r\n\r\n\r\nbody"),
    "subject\n\nbody"
  );
});

test("cleanCommitMessage handles empty input", () => {
  assert.equal(cleanCommitMessage(""), "");
  assert.equal(cleanCommitMessage(null), "");
});
