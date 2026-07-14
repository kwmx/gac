// Telemetry transport: build a batch envelope and POST it, classifying the
// server's response into a plan the orchestrator applies to the queue and state.
//
// Nothing here throws into application code — sendBatch catches every transport
// error and returns a normalized result. Bodies are read defensively.

import {
  SCHEMA_VERSION,
  INGEST_ENDPOINT,
  MAX_EVENTS_PER_BATCH,
  MAX_BATCH_BYTES,
} from "./contract.js";
import { classifyTransportError } from "./errors.js";

function toIso(ms) {
  try {
    return new Date(ms).toISOString();
  } catch (err) {
    return new Date(0).toISOString();
  }
}

// Pick the oldest events that fit within the event-count and byte limits,
// accounting for the envelope overhead. Always returns at least one event when
// any are available.
export function selectBatchEvents(events, { maxEvents = MAX_EVENTS_PER_BATCH, maxBytes = MAX_BATCH_BYTES } = {}) {
  const selected = [];
  for (const event of events) {
    if (selected.length >= maxEvents) break;
    const candidate = [...selected, event];
    const size = Buffer.byteLength(
      JSON.stringify(buildBatch(candidate, { batchId: "0".repeat(36), sentAtMs: 0 })),
      "utf8"
    );
    if (size > maxBytes && selected.length > 0) break;
    selected.push(event);
    if (size > maxBytes) break; // a single oversized event is sent alone
  }
  return selected;
}

// Assemble the batch envelope. `uuid`/`now` are injected; `batchId`/`sentAtMs`
// allow deterministic sizing in selectBatchEvents.
export function buildBatch(events, { uuid, now, batchId, sentAtMs } = {}) {
  const id = batchId !== undefined ? batchId : uuid ? uuid() : "00000000-0000-4000-8000-000000000000";
  const ms = sentAtMs !== undefined ? sentAtMs : now ? now() : 0;
  return {
    batch_id: id,
    schema_version: SCHEMA_VERSION,
    sent_at: toIso(ms),
    events,
  };
}

// Parse a Retry-After header (delta-seconds or HTTP-date) into ms. Returns null
// when absent/invalid.
export function parseRetryAfter(headerValue, nowMs) {
  if (!headerValue) return null;
  const raw = String(headerValue).trim();
  if (/^\d+$/.test(raw)) {
    return Math.max(0, Number(raw) * 1000);
  }
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - nowMs);
  }
  return null;
}

async function readJsonSafely(response) {
  try {
    const text = await response.text();
    if (!text || !text.trim()) return { ok: false, body: null };
    return { ok: true, body: JSON.parse(text) };
  } catch (err) {
    return { ok: false, body: null };
  }
}

function idsInBatch(batch) {
  return (batch.events || []).map((e) => e.event_id);
}

// Send one batch. Returns a normalized plan:
// {
//   status, success, removeIds, retainAll, shrink, applyBackoff,
//   retryAfterMs, failureCategory
// }
// Never throws.
export async function sendBatch(batch, options = {}) {
  const {
    fetchImpl,
    endpoint = INGEST_ENDPOINT,
    version = "unknown",
    signal,
    nowMs = 0,
  } = options;

  const retain = (failureCategory, extra = {}) => ({
    status: null,
    success: false,
    removeIds: [],
    retainAll: true,
    shrink: false,
    applyBackoff: true,
    retryAfterMs: null,
    failureCategory,
    ...extra,
  });

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": `gac/${version}`,
        "X-GAC-Telemetry-Schema": String(SCHEMA_VERSION),
      },
      body: JSON.stringify(batch),
      signal,
    });
  } catch (err) {
    return retain(classifyTransportError(err));
  }

  const status = Number(response.status);

  // Success: only remove events the server explicitly accounts for, and only
  // when the success body is well formed. A 2xx with an empty/malformed body is
  // retained and backed off.
  if (status === 202 || status === 200) {
    const { ok, body } = await readJsonSafely(response);
    if (!ok || !body || !Array.isArray(body.accepted_event_ids)) {
      return { ...retain("parse"), status };
    }
    const accepted = body.accepted_event_ids.filter((x) => typeof x === "string");
    const duplicates = Array.isArray(body.duplicate_event_ids)
      ? body.duplicate_event_ids.filter((x) => typeof x === "string")
      : [];
    const rejected = Array.isArray(body.rejected)
      ? body.rejected
          .map((r) => (r && typeof r.event_id === "string" ? r.event_id : null))
          .filter(Boolean)
      : [];
    return {
      status,
      success: true,
      removeIds: [...new Set([...accepted, ...duplicates, ...rejected])],
      retainAll: false,
      shrink: false,
      applyBackoff: false,
      retryAfterMs: null,
      failureCategory: null,
    };
  }

  // Permanent client errors: discard only events identified as invalid; if none
  // are identified, drop the whole attempted batch so we never loop forever.
  if (status === 400 || status === 415 || status === 422) {
    const { body } = await readJsonSafely(response);
    const identified =
      body && Array.isArray(body.rejected)
        ? body.rejected
            .map((r) => (r && typeof r.event_id === "string" ? r.event_id : null))
            .filter(Boolean)
        : [];
    const removeIds = identified.length > 0 ? identified : idsInBatch(batch);
    return {
      status,
      success: false,
      removeIds,
      retainAll: false,
      shrink: false,
      applyBackoff: true,
      retryAfterMs: null,
      failureCategory: "invalid",
    };
  }

  // Payload too large: keep everything, shrink future batches.
  if (status === 413) {
    return { ...retain("payload_too_large"), status, shrink: true };
  }

  // Rate limited: keep everything, honor Retry-After.
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers?.get?.("retry-after"), nowMs);
    return { ...retain("rate_limited"), status, retryAfterMs };
  }

  // Server errors: keep everything and back off.
  if (status >= 500 && status < 600) {
    return { ...retain("server_error"), status };
  }

  // Anything else unexpected: keep everything and back off.
  return { ...retain("unknown"), status };
}
