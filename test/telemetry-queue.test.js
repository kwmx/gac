import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readQueue,
  writeQueue,
  enqueue,
  removeByIds,
  clearQueue,
  queueStats,
} from "../src/telemetry/queue.js";
import { MAX_QUEUE_EVENTS } from "../src/telemetry/contract.js";

function tmpIo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gac-queue-"));
  return {
    fs,
    dir,
    statePath: path.join(dir, "telemetry.json"),
    queuePath: path.join(dir, "telemetry-queue.ndjson"),
  };
}

function ev(id, extra = {}) {
  return { event_id: id, event_name: "command_completed", action: "ask", ...extra };
}

test("readQueue on a missing file returns empty", () => {
  const io = tmpIo();
  assert.deepEqual(readQueue(io).events, []);
  assert.equal(fs.existsSync(io.queuePath), false);
});

test("enqueue appends and readQueue reads them back in order", () => {
  const io = tmpIo();
  enqueue(io, ev("00000000-0000-4000-8000-000000000001"));
  enqueue(io, ev("00000000-0000-4000-8000-000000000002"));
  const { events } = readQueue(io);
  assert.deepEqual(
    events.map((e) => e.event_id),
    ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]
  );
});

test("readQueue deduplicates by event_id (first wins)", () => {
  const io = tmpIo();
  enqueue(io, ev("dup", { action: "ask" }));
  enqueue(io, ev("dup", { action: "chat" }));
  const { events } = readQueue(io);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "ask");
});

test("readQueue recovers from a partially written / corrupt final line", () => {
  const io = tmpIo();
  enqueue(io, ev("good-1"));
  // Simulate a torn write: a valid line, then a partial JSON fragment.
  fs.appendFileSync(io.queuePath, '{"event_id":"good-2","event_name":"command_comple');
  const { events, invalidCount } = readQueue(io);
  assert.deepEqual(
    events.map((e) => e.event_id),
    ["good-1"]
  );
  assert.equal(invalidCount, 1);
});

test("writeQueue rewrites atomically (temp file is not left behind)", () => {
  const io = tmpIo();
  writeQueue(io, [ev("a"), ev("b")]);
  const { events } = readQueue(io);
  assert.equal(events.length, 2);
  const leftovers = fs.readdirSync(io.dir).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("removeByIds removes only the named events", () => {
  const io = tmpIo();
  writeQueue(io, [ev("a"), ev("b"), ev("c")]);
  removeByIds(io, ["a", "c"]);
  assert.deepEqual(
    readQueue(io).events.map((e) => e.event_id),
    ["b"]
  );
});

test("enqueue drops the oldest events past the count limit", () => {
  const io = tmpIo();
  // Write a queue already at the cap, then enqueue more.
  const initial = [];
  for (let i = 0; i < MAX_QUEUE_EVENTS; i += 1) initial.push(ev(`id-${i}`));
  writeQueue(io, initial);
  // Push enough new events to trigger the count-based trim (which reads/compacts
  // when the file is non-trivial).
  for (let i = 0; i < 20; i += 1) enqueue(io, ev(`new-${i}`));
  const { events } = readQueue(io);
  assert.ok(events.length <= MAX_QUEUE_EVENTS, `count=${events.length}`);
  // The newest event survived, an old one was evicted.
  const ids = new Set(events.map((e) => e.event_id));
  assert.ok(ids.has("new-19"));
  assert.ok(!ids.has("id-0"));
});

test("clearQueue deletes the file", () => {
  const io = tmpIo();
  enqueue(io, ev("a"));
  assert.ok(fs.existsSync(io.queuePath));
  clearQueue(io);
  assert.equal(fs.existsSync(io.queuePath), false);
});

test("queueStats reports deduped count and file size", () => {
  const io = tmpIo();
  enqueue(io, ev("a"));
  enqueue(io, ev("a")); // dup
  enqueue(io, ev("b"));
  const stats = queueStats(io);
  assert.equal(stats.count, 2);
  assert.ok(stats.bytes > 0);
});

test("enqueue on a read-only filesystem returns false (never throws)", () => {
  const roFs = {
    mkdirSync() {},
    appendFileSync() {
      const e = new Error("EROFS");
      e.code = "EROFS";
      throw e;
    },
    chmodSync() {},
    existsSync: () => false,
    statSync: () => ({ size: 0 }),
  };
  const io = { fs: roFs, dir: "/nope", queuePath: "/nope/q.ndjson" };
  assert.equal(enqueue(io, ev("a")), false);
});
