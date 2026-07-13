import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBashHistory,
  parseZshHistory,
  parseFishHistory,
  pickLastCommand,
  historyFileFor,
} from "../src/fix.js";

test("parseBashHistory returns trimmed non-empty lines", () => {
  const commands = parseBashHistory("ls -la\n\n  git status  \n");
  assert.deepEqual(commands, ["ls -la", "git status"]);
});

test("parseZshHistory strips extended-history prefixes", () => {
  const commands = parseZshHistory(
    ": 1736784000:0;git push origin main\nplain command\n: 1736784100:2;npm test\n"
  );
  assert.deepEqual(commands, ["git push origin main", "plain command", "npm test"]);
});

test("parseFishHistory extracts cmd entries and ignores metadata", () => {
  const content = [
    "- cmd: git status",
    "  when: 1736784000",
    "- cmd: npm run build",
    "  when: 1736784100",
    "  paths:",
    "    - package.json",
  ].join("\n");
  assert.deepEqual(parseFishHistory(content), ["git status", "npm run build"]);
});

test("pickLastCommand takes the newest entry, skipping gac itself", () => {
  assert.equal(pickLastCommand(["ls", "git push", "gac fix"]), "git push");
  assert.equal(pickLastCommand(["ls", "gac ask hi", "gac"]), "ls");
  assert.equal(pickLastCommand(["gac fix"]), null);
  assert.equal(pickLastCommand([]), null);
  // "gacetl" is not a gac invocation and must not be skipped.
  assert.equal(pickLastCommand(["gacetl run"]), "gacetl run");
});

test("historyFileFor maps shells to their history files and parsers", () => {
  const zsh = historyFileFor("/usr/bin/zsh", "/home/u");
  assert.equal(zsh.file, "/home/u/.zsh_history");
  assert.equal(zsh.parse, parseZshHistory);

  const fish = historyFileFor("/usr/bin/fish", "/home/u");
  assert.ok(fish.file.endsWith("fish_history"));
  assert.equal(fish.parse, parseFishHistory);

  const bash = historyFileFor("/bin/bash", "/home/u");
  assert.equal(bash.file, "/home/u/.bash_history");
  assert.equal(bash.parse, parseBashHistory);

  // Unknown shells fall back to bash-style history.
  assert.equal(historyFileFor(undefined, "/home/u").parse, parseBashHistory);
});
