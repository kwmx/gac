// On-disk telemetry queue: ~/.gac/telemetry-queue.ndjson (one event per line).
//
// Only fully sanitized, schema-validated events are ever passed in (the caller
// validates first). All functions take an injected `io` adapter and never throw:
// queue corruption must never affect GAC. Invalid or partially written lines are
// discarded; valid lines are preserved. Rewrites are atomic (temp + rename).

import {
  MAX_QUEUE_EVENTS,
  MAX_QUEUE_BYTES,
} from "./contract.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

let tmpCounter = 0;

function ensureDir(io) {
  try {
    io.fs.mkdirSync(io.dir, { recursive: true, mode: DIR_MODE });
  } catch (err) {
    // Surfaced by the subsequent write if it truly matters.
  }
}

// Parse the queue file. Returns { events, invalidCount, bytes }. `events` is
// deduplicated by event_id (first occurrence wins), in file order. A corrupt or
// partially written final line is simply skipped. Never throws.
export function readQueue(io) {
  let raw = "";
  let bytes = 0;
  try {
    if (!io.fs.existsSync(io.queuePath)) return { events: [], invalidCount: 0, bytes: 0 };
    raw = io.fs.readFileSync(io.queuePath, "utf8");
    bytes = Buffer.byteLength(raw, "utf8");
  } catch (err) {
    return { events: [], invalidCount: 0, bytes: 0 };
  }

  const events = [];
  const seen = new Set();
  let invalidCount = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      // Corrupt or partially written line — discard it, keep the rest.
      invalidCount += 1;
      continue;
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.event_id !== "string") {
      invalidCount += 1;
      continue;
    }
    if (seen.has(parsed.event_id)) continue; // dedup
    seen.add(parsed.event_id);
    events.push(parsed);
  }
  return { events, invalidCount, bytes };
}

function serialize(events) {
  return events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
}

// Atomically replace the queue with exactly `events`. Returns true on success.
// An empty queue removes the file entirely, so a fully drained queue leaves no
// stray 0-byte file behind.
export function writeQueue(io, events) {
  try {
    if (!events.length) return clearQueue(io);
    ensureDir(io);
    tmpCounter += 1;
    const tmp = `${io.queuePath}.tmp-${tmpCounter}`;
    const body = serialize(events);
    io.fs.writeFileSync(tmp, body, { mode: FILE_MODE });
    try {
      io.fs.chmodSync(tmp, FILE_MODE);
    } catch (err) {
      // best-effort
    }
    io.fs.renameSync(tmp, io.queuePath);
    return true;
  } catch (err) {
    return false;
  }
}

// Drop oldest events until within the count and byte limits.
function trimToLimits(events) {
  const trimmed = [...events];
  while (trimmed.length > MAX_QUEUE_EVENTS) trimmed.shift();
  while (
    trimmed.length > 0 &&
    Buffer.byteLength(serialize(trimmed), "utf8") > MAX_QUEUE_BYTES
  ) {
    trimmed.shift();
  }
  return trimmed;
}

// Append one validated event and enforce queue limits. Returns true on success.
// Never throws.
export function enqueue(io, event) {
  try {
    ensureDir(io);
    const line = JSON.stringify(event) + "\n";
    try {
      io.fs.appendFileSync(io.queuePath, line, { mode: FILE_MODE });
      try {
        io.fs.chmodSync(io.queuePath, FILE_MODE);
      } catch (err) {
        // best-effort
      }
    } catch (err) {
      return false;
    }

    // Enforce limits (and compact away any duplicate/invalid lines) only when
    // the file might have grown past a bound — cheap for the common case.
    let bytes = 0;
    try {
      bytes = io.fs.statSync(io.queuePath).size;
    } catch (err) {
      bytes = Buffer.byteLength(line, "utf8");
    }
    if (bytes > MAX_QUEUE_BYTES) {
      const { events } = readQueue(io);
      writeQueue(io, trimToLimits(events));
      return true;
    }
    // Count check requires a parse; do it opportunistically when the file is
    // non-trivial.
    if (bytes > 4096) {
      const { events } = readQueue(io);
      if (events.length > MAX_QUEUE_EVENTS) {
        writeQueue(io, trimToLimits(events));
      }
    }
    return true;
  } catch (err) {
    return false;
  }
}

// Remove events whose event_id is in `ids` (a Set or array). Rewrites atomically.
export function removeByIds(io, ids) {
  try {
    const idSet = ids instanceof Set ? ids : new Set(ids || []);
    if (idSet.size === 0) return true;
    const { events } = readQueue(io);
    const remaining = events.filter((e) => !idSet.has(e.event_id));
    return writeQueue(io, remaining);
  } catch (err) {
    return false;
  }
}

// Delete the queue file entirely. Never throws.
export function clearQueue(io) {
  try {
    if (io.fs.existsSync(io.queuePath)) io.fs.unlinkSync(io.queuePath);
    return true;
  } catch (err) {
    return false;
  }
}

// { count, bytes } for status display. count is deduped valid events; bytes is
// the on-disk file size (approximate queue size).
export function queueStats(io) {
  const { events } = readQueue(io);
  let bytes = 0;
  try {
    if (io.fs.existsSync(io.queuePath)) bytes = io.fs.statSync(io.queuePath).size;
  } catch (err) {
    bytes = 0;
  }
  return { count: events.length, bytes };
}
