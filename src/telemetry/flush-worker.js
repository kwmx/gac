// Detached background flush worker.
//
// The CLI spawns this as its own short-lived process (see background.js) so that
// transmitting telemetry never delays a command's exit. It reads the same
// ~/.gac state and queue, flushes once with a generous timeout (the process is
// already detached, so the timeout only bounds this worker, not the user's
// shell), and exits. It never assembles new events — it only sends what the
// foreground process already enqueued — so its telemetry context is irrelevant.
//
// This process is fully decoupled from the parent: every error is swallowed and
// the exit code is always 0, because nothing observes it.

import { createTelemetry } from "./index.js";
import { getVersion } from "../flags.js";

async function main() {
  try {
    const telemetry = createTelemetry({ version: getVersion() });
    // Generous timeout: a cold TLS handshake to the ingest endpoint can take
    // most of a second, and blocking here costs the user nothing.
    await telemetry.flush({ timeoutMs: 5000 });
  } catch (err) {
    // Best-effort background work; there is no one to report to.
  }
}

main().finally(() => {
  try {
    process.exit(0);
  } catch (err) {
    // Ignore.
  }
});
