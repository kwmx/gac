// Spawn a detached process to flush telemetry so the foreground command exits
// immediately instead of waiting on the network.
//
// The worker is fully detached (its own process group), inherits no stdio, and
// is unref'd, so the parent's event loop can drain and the shell prompt returns
// right away while the send completes in the background. Best-effort: any
// failure is swallowed and the queue simply flushes on a later run.

import { spawn as defaultSpawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const WORKER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "flush-worker.js"
);

// Returns true if a background worker was spawned, false otherwise. Never
// throws. `spawn`/`execPath`/`workerPath`/`env` are injectable for testing.
export function spawnBackgroundFlush(options = {}) {
  const spawnImpl = options.spawn || defaultSpawn;
  const execPath = options.execPath || process.execPath;
  const workerPath = options.workerPath || WORKER_PATH;
  try {
    const child = spawnImpl(execPath, [workerPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: options.env || process.env,
    });
    // Let the parent exit without waiting on the child.
    if (child && typeof child.unref === "function") child.unref();
    return true;
  } catch (err) {
    return false;
  }
}
