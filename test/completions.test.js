import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBashCompletion,
  buildZshCompletion,
  buildFishCompletion,
} from "../src/completions.js";

const ALL_COMMANDS = [
  "ask",
  "suggest",
  "explain",
  "runbook",
  "commit",
  "fix",
  "chat",
  "models",
  "config",
  "auth",
  "completions",
];

test("bash completion covers commands, flags, and registers the function", () => {
  const script = buildBashCompletion();
  for (const command of ALL_COMMANDS) {
    assert.ok(script.includes(command), `bash script lists ${command}`);
  }
  assert.ok(script.includes("--file"));
  assert.ok(script.includes("--dry-run"));
  assert.ok(script.includes("get set tui"));
  assert.ok(script.includes("complete -F _gac_completions gac"));
});

test("zsh completion is a compdef with file-arg specs", () => {
  const script = buildZshCompletion();
  assert.ok(script.startsWith("#compdef gac"));
  for (const command of ALL_COMMANDS) {
    assert.ok(script.includes(`'${command}:`), `zsh script describes ${command}`);
  }
  assert.ok(script.includes(":file:_files"), "file flags complete paths");
  assert.ok(script.includes("_describe 'command'"));
});

test("fish completion registers subcommands and flags", () => {
  const script = buildFishCompletion();
  assert.ok(script.includes("complete -c gac -f"));
  for (const command of ALL_COMMANDS) {
    assert.ok(
      script.includes(`-a "${command}"`),
      `fish script registers ${command}`
    );
  }
  assert.ok(script.includes("-l file"));
  assert.ok(script.includes("__fish_seen_subcommand_from config"));
});
