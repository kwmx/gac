import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readState,
  writeState,
  deleteState,
  newEnabledState,
  declinedState,
  disabledState,
} from "../src/telemetry/state.js";

function tmpIo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gac-state-"));
  return { fs, dir, statePath: path.join(dir, "telemetry.json"), queuePath: path.join(dir, "q.ndjson") };
}

test("readState returns null when no file exists and never creates one", () => {
  const io = tmpIo();
  assert.equal(readState(io), null);
  assert.equal(fs.existsSync(io.statePath), false);
});

test("writeState persists and readState round-trips", () => {
  const io = tmpIo();
  const state = newEnabledState({ installationId: "id-1", decidedAt: "2026-07-14T00:00:00.000Z" });
  assert.equal(writeState(io, state), true);
  assert.deepEqual(readState(io), state);
});

test("writeState uses mode 0600 where supported", () => {
  const io = tmpIo();
  writeState(io, declinedState({ decidedAt: "2026-07-14T00:00:00.000Z" }));
  if (process.platform !== "win32") {
    const mode = fs.statSync(io.statePath).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test("readState returns null on corrupt JSON (never throws)", () => {
  const io = tmpIo();
  fs.writeFileSync(io.statePath, "{ this is not json");
  assert.equal(readState(io), null);
});

test("deleteState removes the file and is safe when absent", () => {
  const io = tmpIo();
  writeState(io, disabledState({ decidedAt: "2026-07-14T00:00:00.000Z" }));
  assert.ok(fs.existsSync(io.statePath));
  assert.equal(deleteState(io), true);
  assert.equal(fs.existsSync(io.statePath), false);
  assert.equal(deleteState(io), true); // idempotent
});

test("state builders shape decisions correctly", () => {
  const enabled = newEnabledState({ installationId: "x", decidedAt: "t" });
  assert.equal(enabled.decision, "enabled");
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.installationId, "x");

  const declined = declinedState({ decidedAt: "t" });
  assert.equal(declined.decision, "declined");
  assert.equal(declined.installationId, null);

  const disabled = disabledState({ decidedAt: "t" });
  assert.equal(disabled.decision, "disabled");
  assert.equal(disabled.installationId, null);
});

test("writeState returns false on a read-only filesystem (never throws)", () => {
  const roFs = {
    mkdirSync() {},
    writeFileSync() {
      const e = new Error("EROFS: read-only file system");
      e.code = "EROFS";
      throw e;
    },
    chmodSync() {},
    renameSync() {},
    existsSync: fs.existsSync,
  };
  const io = { fs: roFs, dir: "/nope", statePath: "/nope/telemetry.json", queuePath: "/nope/q" };
  assert.equal(writeState(io, declinedState({ decidedAt: "t" })), false);
});
