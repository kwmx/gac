import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnBackgroundFlush } from "../src/telemetry/background.js";

function fakeSpawn() {
  const calls = [];
  let unrefed = 0;
  const spawn = (execPath, args, opts) => {
    calls.push({ execPath, args, opts });
    return {
      unref() {
        unrefed += 1;
      },
    };
  };
  return { spawn, calls, unrefCount: () => unrefed };
}

test("spawnBackgroundFlush launches a detached, unref'd worker with ignored stdio", () => {
  const f = fakeSpawn();
  const ok = spawnBackgroundFlush({
    spawn: f.spawn,
    execPath: "/usr/bin/node",
    workerPath: "/app/flush-worker.js",
  });
  assert.equal(ok, true);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.execPath, "/usr/bin/node");
  assert.deepEqual(call.args, ["/app/flush-worker.js"]);
  assert.equal(call.opts.detached, true, "must be detached to outlive the parent");
  assert.equal(call.opts.stdio, "ignore", "must not inherit stdio");
  assert.equal(f.unrefCount(), 1, "must unref so the parent can exit immediately");
});

test("spawnBackgroundFlush swallows spawn failures and returns false", () => {
  const throwingSpawn = () => {
    throw new Error("ENOENT");
  };
  const ok = spawnBackgroundFlush({ spawn: throwingSpawn });
  assert.equal(ok, false);
});
