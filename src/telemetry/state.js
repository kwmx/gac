// Telemetry state persistence: ~/.gac/telemetry.json.
//
// All functions take an injected `io` adapter ({ fs, dir, statePath }) so tests
// can drive a throwaway home and a read-only filesystem. Reads never throw and
// never create files. Writes are best-effort and atomic; a failed write (e.g.
// read-only home) simply returns false and is ignored by callers.

import { TELEMETRY_CONSENT_VERSION, TELEMETRY_NOTICE_VERSION } from "./contract.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export const DECISIONS = ["enabled", "declined", "disabled"];

// A fresh, enabled state with a brand-new installation identifier.
export function newEnabledState({ installationId, decidedAt }) {
  return {
    noticeVersion: TELEMETRY_NOTICE_VERSION,
    consentVersion: TELEMETRY_CONSENT_VERSION,
    decision: "enabled",
    enabled: true,
    installationId,
    decidedAt,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCategory: null,
    consecutiveFailures: 0,
    nextAttemptAt: null,
  };
}

// A record that the user declined. No installation identifier is created.
export function declinedState({ decidedAt }) {
  return {
    noticeVersion: TELEMETRY_NOTICE_VERSION,
    consentVersion: TELEMETRY_CONSENT_VERSION,
    decision: "declined",
    enabled: false,
    installationId: null,
    decidedAt,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCategory: null,
    consecutiveFailures: 0,
    nextAttemptAt: null,
  };
}

// A record that the user intentionally disabled telemetry. The identifier is
// dropped so re-enabling produces a new one.
export function disabledState({ decidedAt }) {
  return {
    noticeVersion: TELEMETRY_NOTICE_VERSION,
    consentVersion: TELEMETRY_CONSENT_VERSION,
    decision: "disabled",
    enabled: false,
    installationId: null,
    decidedAt,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCategory: null,
    consecutiveFailures: 0,
    nextAttemptAt: null,
  };
}

// Read the saved state, or null if none exists / is unreadable / is corrupt.
// Never throws, never creates a file.
export function readState(io) {
  try {
    if (!io.fs.existsSync(io.statePath)) return null;
    const raw = io.fs.readFileSync(io.statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

function ensureDir(io) {
  try {
    io.fs.mkdirSync(io.dir, { recursive: true, mode: DIR_MODE });
    return true;
  } catch (err) {
    // Directory may already exist; a real failure surfaces on the write below.
    return false;
  }
}

// Write state atomically (temp file + rename) with mode 0600. Returns true on
// success, false on any failure (never throws).
export function writeState(io, state) {
  try {
    ensureDir(io);
    const tmp = `${io.statePath}.tmp-${state.installationId || "x"}-${
      state.decidedAt || "0"
    }`.replace(/[^\w./:@+-]/g, "_");
    const body = JSON.stringify(state, null, 2);
    io.fs.writeFileSync(tmp, body, { mode: FILE_MODE });
    try {
      io.fs.chmodSync(tmp, FILE_MODE);
    } catch (err) {
      // chmod is best-effort (e.g. Windows); ignore.
    }
    io.fs.renameSync(tmp, io.statePath);
    return true;
  } catch (err) {
    return false;
  }
}

// Delete the state file. Never throws.
export function deleteState(io) {
  try {
    if (io.fs.existsSync(io.statePath)) io.fs.unlinkSync(io.statePath);
    return true;
  } catch (err) {
    return false;
  }
}
