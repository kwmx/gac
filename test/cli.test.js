import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseOsRelease,
  normalizeDefaultAction,
  extractJsonPayload,
  normalizeRunbookCommands,
  findBlockedCommand,
  loadBlockedCommands,
} from "../src/cli.js";

test("parseOsRelease parses key=value, strips quotes, skips comments", () => {
  const parsed = parseOsRelease(
    ['# a comment', 'NAME="Ubuntu"', "ID=ubuntu", "", "VERSION_ID=\"22.04\""].join("\n")
  );
  assert.equal(parsed.NAME, "Ubuntu");
  assert.equal(parsed.ID, "ubuntu");
  assert.equal(parsed.VERSION_ID, "22.04");
});

test("normalizeDefaultAction accepts known actions and defaults the rest", () => {
  assert.equal(normalizeDefaultAction("ask"), "ask");
  assert.equal(normalizeDefaultAction("SUGGEST"), "suggest");
  assert.equal(normalizeDefaultAction(" explain "), "explain");
  assert.equal(normalizeDefaultAction("nonsense"), "suggest");
  assert.equal(normalizeDefaultAction(""), "suggest");
  assert.equal(normalizeDefaultAction(undefined), "suggest");
});

test("extractJsonPayload handles fenced, raw, and embedded JSON", () => {
  assert.deepEqual(extractJsonPayload('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonPayload('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonPayload('prefix {"a":1} suffix'), { a: 1 });
  assert.equal(extractJsonPayload("no json at all"), null);
  assert.equal(extractJsonPayload(""), null);
});

test("normalizeRunbookCommands normalizes objects, strings, and notes", () => {
  const { commands, notes } = normalizeRunbookCommands({
    commands: [
      { description: "list", command: "ls -la" },
      "pwd",
      { title: "cmd alias", cmd: "whoami" },
      { description: "empty", command: "" },
      null,
    ],
    notes: ["be careful", ""],
  });
  assert.deepEqual(commands, [
    { description: "list", command: "ls -la" },
    { description: "", command: "pwd" },
    { description: "cmd alias", command: "whoami" },
  ]);
  assert.deepEqual(notes, ["be careful"]);
});

test("normalizeRunbookCommands is safe on malformed payloads", () => {
  assert.deepEqual(normalizeRunbookCommands(null), { commands: [], notes: [] });
  assert.deepEqual(normalizeRunbookCommands({}), { commands: [], notes: [] });
});

test("findBlockedCommand matches regex patterns and falls back to substrings", () => {
  const list = [
    { pattern: "\\brm\\s+-rf\\s+/(\\s|$)", reason: "destructive" },
    { pattern: "mkfs", reason: "formats disks" },
  ];
  assert.ok(findBlockedCommand("sudo rm -rf /", list));
  assert.ok(findBlockedCommand("mkfs.ext4 /dev/sda1", list));
  assert.equal(findBlockedCommand("ls -la", list), undefined);
});

test("the shipped blocklist catches known destructive commands", () => {
  const blocked = loadBlockedCommands();
  assert.ok(Array.isArray(blocked) && blocked.length > 0, "blocklist should load");
  assert.ok(findBlockedCommand("rm -rf /", blocked), "rm -rf / must be blocked");
  assert.ok(findBlockedCommand("rm -rf ~", blocked), "rm -rf ~ must be blocked");
  assert.equal(findBlockedCommand("echo hello", blocked), undefined);
});
