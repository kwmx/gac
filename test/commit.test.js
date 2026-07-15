import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCommitMessage, classifyNoStaged, appendGuidance } from "../src/commit.js";

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

test("classifyNoStaged flags unstaged tracked edits", () => {
  // " M file" — modified in the worktree, not staged (leading space = index clean).
  assert.equal(classifyNoStaged(" M src/app.js"), "unstaged");
  // Deleted-but-not-staged, and mixed with a staged entry elsewhere.
  assert.equal(classifyNoStaged(" D gone.txt\nMM both.js"), "unstaged");
});

test("classifyNoStaged reports untracked-only when nothing tracked changed", () => {
  assert.equal(classifyNoStaged("?? newfile.txt"), "untracked");
  assert.equal(classifyNoStaged("?? a.txt\n?? b.txt"), "untracked");
});

test("classifyNoStaged reports clean for empty status", () => {
  assert.equal(classifyNoStaged(""), "clean");
  assert.equal(classifyNoStaged(null), "clean");
  assert.equal(classifyNoStaged("\n"), "clean");
});

test("classifyNoStaged prefers unstaged over untracked when both exist", () => {
  assert.equal(classifyNoStaged(" M tracked.js\n?? new.txt"), "unstaged");
});

test("appendGuidance returns the prompt unchanged when guidance is empty", () => {
  const prompt = "Staged diff:\n```\n+x\n```";
  assert.equal(appendGuidance(prompt, ""), prompt);
  assert.equal(appendGuidance(prompt, "   "), prompt);
  assert.equal(appendGuidance(prompt, null), prompt);
  assert.equal(appendGuidance(prompt, undefined), prompt);
});

test("appendGuidance appends a trimmed instruction after the prompt", () => {
  const prompt = "Staged diff:\n```\n+x\n```";
  const out = appendGuidance(prompt, "  elaborate on new features  ");
  assert.ok(out.startsWith(prompt), "original prompt is preserved at the start");
  assert.ok(out.includes("elaborate on new features"), "instruction is included");
  assert.ok(!out.includes("  elaborate"), "instruction is trimmed");
  assert.ok(/formatting rules/i.test(out), "reminds the model to keep the format");
});
