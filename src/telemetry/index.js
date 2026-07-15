// Telemetry orchestrator — the public, no-throw interface used by the CLI.
//
// Guarantees:
// - Importing this module performs NO network or filesystem access.
// - track() never throws. flush() always resolves and never rejects.
// - Nothing is created on disk or the network before explicit consent.
// - Call sites pass only precomputed sanitized scalar values.
//
// Everything the subsystem needs (fs, clock, uuid, fetch, timers, home dir,
// randomness, env) is injectable so tests can drive it deterministically.

import fsDefault from "fs";
import os from "os";
import path from "path";
import { createHash, randomUUID } from "crypto";

import {
  INGEST_ENDPOINT,
  CONTRACT_ENDPOINT,
  TELEMETRY_DOCS_URL,
  PRIVACY_URL,
  ATTRIBUTION,
  INSTALL_ID_HASH_PREFIX,
  TELEMETRY_CONSENT_VERSION,
  TELEMETRY_NOTICE_VERSION,
  SCHEMA_VERSION,
  BACKOFF_SCHEDULE_MS,
  MAX_BATCH_BYTES,
  MAX_EVENTS_PER_BATCH,
  MAX_QUEUE_EVENTS,
  MAX_QUEUE_BYTES,
  EVENTS,
  EVENT_NAMES,
  NEVER_COLLECTED,
  validateEvent,
} from "./contract.js";
import {
  providerCategory,
  platformCategory,
  archCategory,
  nodeMajor,
  normalizeDuration,
} from "./buckets.js";
import {
  readState,
  writeState,
  deleteState,
  newEnabledState,
  declinedState,
  disabledState,
} from "./state.js";
import {
  readQueue,
  enqueue,
  removeByIds,
  clearQueue,
  queueStats,
} from "./queue.js";
import {
  buildBatch,
  selectBatchEvents,
  sendBatch,
} from "./client.js";
import {
  CONSENT_STATEMENT,
  effectiveDecision,
  isEffectivelyEnabled,
  envSuppression,
  shouldAutoPrompt,
  ENV_SUPPRESSION_VARS,
} from "./consent.js";

export { CONSENT_STATEMENT } from "./consent.js";
export { ATTRIBUTION } from "./contract.js";

function toIso(ms) {
  try {
    return new Date(ms).toISOString();
  } catch (err) {
    return new Date(0).toISOString();
  }
}

// The transmitted identifier: SHA-256("gac-telemetry-v1:" + installationId),
// 64 lowercase hex. The raw installationId is never transmitted.
export function deriveInstallHash(installationId) {
  return createHash("sha256")
    .update(INSTALL_ID_HASH_PREFIX + String(installationId))
    .digest("hex");
}

function backoffDelayMs(failureCount, random) {
  const idx = Math.min(Math.max(failureCount, 1) - 1, BACKOFF_SCHEDULE_MS.length - 1);
  const base = BACKOFF_SCHEDULE_MS[idx];
  const jitter = base * 0.5 * (typeof random === "function" ? random() : 0);
  return Math.round(base + jitter);
}

// ── No-op implementation ───────────────────────────────────────────────────

export function createNoopTelemetry() {
  return {
    isNoop: true,
    enabled: false,
    track() {},
    async flush() {
      return { skipped: "noop" };
    },
    getStatus() {
      return {
        savedDecision: "undecided",
        effectiveState: "disabled",
        consentVersion: TELEMETRY_CONSENT_VERSION,
        noticeVersion: TELEMETRY_NOTICE_VERSION,
        savedConsentVersion: null,
        ingestEndpoint: INGEST_ENDPOINT,
        contractEndpoint: CONTRACT_ENDPOINT,
        queueCount: 0,
        queueBytes: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureCategory: null,
        nextAttemptAt: null,
        consecutiveFailures: 0,
        suppression: { suppressed: false, reasons: [] },
      };
    },
    async enable() {
      return { enabled: false };
    },
    async disable() {
      return { disabled: true };
    },
    decline() {
      return { declined: false };
    },
    info() {
      return CONSENT_STATEMENT;
    },
    isEnabled() {
      return false;
    },
    isDueForFlush() {
      return false;
    },
    shouldPrompt() {
      return false;
    },
    getEffectiveDecision() {
      return "undecided";
    },
  };
}

// ── Real implementation ────────────────────────────────────────────────────

export function createTelemetry(options = {}) {
  const fs = options.fs || fsDefault;
  const homeDir = options.homeDir || os.homedir();
  const now = options.now || (() => Date.now());
  const uuid = options.uuid || (() => randomUUID());
  const random = options.random || Math.random;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const env = options.env || process.env;
  const version = options.version || "unknown";
  const endpoint = options.endpoint || INGEST_ENDPOINT;
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;

  const dir = path.join(homeDir, ".gac");
  const io = {
    fs,
    dir,
    statePath: path.join(dir, "telemetry.json"),
    queuePath: path.join(dir, "telemetry-queue.ndjson"),
  };

  const context = {
    app_version: version,
    platform: platformCategory(options.platform || process.platform),
    arch: archCategory(options.arch || process.arch),
    node_major: nodeMajor(options.nodeVersion || process.version),
    provider: providerCategory(options.provider),
    interactive: Boolean(options.interactive),
    invocation_id: options.invocationId || uuid(),
  };

  let state = readState(io);
  let installHash = state && state.installationId ? deriveInstallHash(state.installationId) : null;
  let flushing = false;
  let currentMaxBytes = MAX_BATCH_BYTES;

  function refreshInstallHash() {
    installHash = state && state.installationId ? deriveInstallHash(state.installationId) : null;
  }

  function persistState(next) {
    state = next;
    refreshInstallHash();
    writeState(io, next);
  }

  function assembleEvent(event) {
    return {
      event_id: uuid(),
      event_name: event.event_name,
      occurred_at: toIso(now()),
      anonymous_install_id: installHash,
      invocation_id: context.invocation_id,
      app_version: context.app_version,
      platform: context.platform,
      arch: context.arch,
      node_major: context.node_major,
      provider: context.provider,
      interactive: context.interactive,
      action: event.action,
      outcome: event.outcome,
      duration_ms: normalizeDuration(event.duration_ms ?? null),
      error_category: event.error_category ?? null,
      properties: sanitizeProperties(event.event_name, event.properties),
    };
  }

  // Drop undefined-valued keys so "only include applicable properties" holds,
  // then let validateEvent enforce the strict allowlist.
  function sanitizeProperties(eventName, properties) {
    const out = {};
    if (!properties || typeof properties !== "object") return out;
    for (const key of Object.keys(properties)) {
      const value = properties[key];
      if (value === undefined) continue;
      out[key] = value;
    }
    return out;
  }

  function track(event) {
    try {
      if (!isEffectivelyEnabled(state, env)) return;
      if (!installHash) return; // no identifier → nothing can be attributed
      if (!event || !EVENTS[event.event_name]) return;
      const full = assembleEvent(event);
      const { ok } = validateEvent(full);
      if (!ok) return;
      enqueue(io, full);
    } catch (err) {
      // track() must never throw.
    }
  }

  function applyPlan(plan, nowMs) {
    try {
      if (plan.removeIds && plan.removeIds.length) {
        removeByIds(io, plan.removeIds);
      }
      const next = { ...state };
      if (plan.success) {
        next.lastSuccessAt = toIso(nowMs);
        next.consecutiveFailures = 0;
        next.nextAttemptAt = null;
        next.lastFailureCategory = null;
      } else {
        next.lastFailureAt = toIso(nowMs);
        next.lastFailureCategory = plan.failureCategory || "unknown";
        if (plan.applyBackoff) {
          next.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
          const delay =
            plan.retryAfterMs != null
              ? plan.retryAfterMs
              : backoffDelayMs(next.consecutiveFailures, random);
          next.nextAttemptAt = toIso(nowMs + delay);
        }
      }
      if (plan.shrink) {
        currentMaxBytes = Math.max(2048, Math.floor(currentMaxBytes / 2));
      }
      persistState(next);
    } catch (err) {
      // Never throw from flush.
    }
  }

  async function flush(opts = {}) {
    const timeoutMs = opts.timeoutMs || 300;
    let acquired = false;
    try {
      if (!isEffectivelyEnabled(state, env)) return { skipped: "disabled" };
      if (flushing) return { skipped: "busy" };
      const nowMs = now();
      if (state.nextAttemptAt) {
        const next = Date.parse(state.nextAttemptAt);
        if (Number.isFinite(next) && next > nowMs) return { skipped: "backoff" };
      }
      const { events } = readQueue(io);
      if (!events.length) return { skipped: "empty" };

      flushing = true;
      acquired = true;

      const batchEvents = selectBatchEvents(events, { maxBytes: currentMaxBytes });
      const batch = buildBatch(batchEvents, { uuid, now });

      const controller = new AbortController();
      const timer = setTimeoutImpl(() => {
        try {
          controller.abort();
        } catch (err) {}
      }, timeoutMs);
      try {
        timer.unref?.();
      } catch (err) {}

      let plan;
      try {
        plan = await sendBatch(batch, {
          fetchImpl,
          endpoint,
          version,
          signal: controller.signal,
          nowMs,
        });
      } finally {
        clearTimeoutImpl(timer);
      }

      applyPlan(plan, nowMs);
      return { sent: batchEvents.length, plan };
    } catch (err) {
      return { skipped: "error" };
    } finally {
      if (acquired) flushing = false;
    }
  }

  async function enable(opts = {}) {
    const action = opts.action === "first_run_prompt" ? "first_run_prompt" : "manual_command";
    try {
      // A new installation id must not share a queue with a previous one: the
      // backend rejects any batch that mixes install ids (install_id_mismatch).
      // Drop any events left over from an earlier (now-superseded) identity.
      clearQueue(io);
      const installationId = uuid();
      const decidedAt = toIso(now());
      const next = newEnabledState({ installationId, decidedAt });
      const persisted = writeState(io, next); // save consent FIRST
      state = next;
      refreshInstallHash();
      currentMaxBytes = MAX_BATCH_BYTES;

      // Queue one telemetry_enabled event (suppressed silently by env overrides).
      track({
        event_name: "telemetry_enabled",
        action,
        outcome: "success",
        duration_ms: null,
        error_category: null,
        properties: { consent_version: TELEMETRY_CONSENT_VERSION },
      });

      // Enabling is a deliberate one-off, so use a generous timeout: it lets the
      // consent event land on a cold connection instead of timing out and
      // arming a spurious backoff. A failure must never undo consent.
      await flush({ timeoutMs: opts.flushTimeoutMs || 3000 });
      return { enabled: true, persisted };
    } catch (err) {
      return { enabled: false };
    }
  }

  function decline() {
    try {
      const state2 = declinedState({ decidedAt: toIso(now()) });
      const persisted = writeState(io, state2);
      state = state2;
      refreshInstallHash();
      return { declined: true, persisted };
    } catch (err) {
      return { declined: false };
    }
  }

  async function disable() {
    try {
      clearQueue(io); // delete queued events
      const state2 = disabledState({ decidedAt: toIso(now()) }); // drops installationId
      const persisted = writeState(io, state2);
      state = state2;
      installHash = null; // drop cached transmitted hash
      currentMaxBytes = MAX_BATCH_BYTES;
      return { disabled: true, persisted };
    } catch (err) {
      return { disabled: false };
    }
  }

  function getStatus() {
    const suppression = envSuppression(env);
    const saved = effectiveDecision(state);
    const stats = queueStats(io);
    let effectiveState;
    if (suppression.suppressed) {
      effectiveState = "disabled";
    } else if (saved === "enabled") {
      effectiveState = "enabled";
    } else {
      effectiveState = saved; // declined | disabled | undecided
    }
    return {
      savedDecision: saved,
      effectiveState,
      consentVersion: TELEMETRY_CONSENT_VERSION,
      noticeVersion: TELEMETRY_NOTICE_VERSION,
      savedConsentVersion: state ? state.consentVersion ?? null : null,
      ingestEndpoint: endpoint,
      contractEndpoint: CONTRACT_ENDPOINT,
      queueCount: stats.count,
      queueBytes: stats.bytes,
      lastSuccessAt: state ? state.lastSuccessAt ?? null : null,
      lastFailureAt: state ? state.lastFailureAt ?? null : null,
      lastFailureCategory: state ? state.lastFailureCategory ?? null : null,
      nextAttemptAt: state ? state.nextAttemptAt ?? null : null,
      consecutiveFailures: state ? state.consecutiveFailures ?? 0 : 0,
      suppression,
      statePath: io.statePath,
      queuePath: io.queuePath,
    };
  }

  function info() {
    return buildInfoText(io);
  }

  function isEnabled() {
    return isEffectivelyEnabled(state, env);
  }

  // Cheap, in-memory check (no file/network I/O): is telemetry enabled and past
  // any active backoff window? Used by the CLI to decide whether spawning a
  // background flush is worthwhile without touching the queue file.
  function isDueForFlush() {
    if (!isEffectivelyEnabled(state, env)) return false;
    if (state && state.nextAttemptAt) {
      const next = Date.parse(state.nextAttemptAt);
      if (Number.isFinite(next) && next > now()) return false;
    }
    return true;
  }

  function shouldPrompt(interactive) {
    return shouldAutoPrompt(state, env, { interactive });
  }

  function getEffectiveDecision() {
    return effectiveDecision(state);
  }

  return {
    isNoop: false,
    track,
    flush,
    enable,
    disable,
    decline,
    getStatus,
    info,
    isEnabled,
    isDueForFlush,
    shouldPrompt,
    getEffectiveDecision,
    // Exposed for the telemetry CLI / tests; never printed as raw UUID.
    _io: io,
    _context: context,
  };
}

// ── Info text (no network) ─────────────────────────────────────────────────

function buildInfoText(io) {
  const lines = [];
  lines.push(CONSENT_STATEMENT);
  lines.push("");
  lines.push("Installations vs. people");
  lines.push(
    "  Telemetry counts active GAC installations, not people. The identifier links"
  );
  lines.push(
    "  events from one installation over time; it is pseudonymous, not a proof of a"
  );
  lines.push("  unique person.");
  lines.push("");
  lines.push("Identifier");
  lines.push('  anonymous_install_id = SHA-256("gac-telemetry-v1:" + random UUID), sent as');
  lines.push("  64 lowercase hex. The raw UUID never leaves your machine. Disabling and");
  lines.push("  re-enabling creates a new identifier.");
  lines.push("");
  lines.push("Source IP");
  lines.push(
    "  The service necessarily receives your source IP while processing the HTTPS"
  );
  lines.push(
    "  request, but is designed not to store it in its telemetry database or logs."
  );
  lines.push("");
  lines.push("Event catalog");
  for (const name of EVENT_NAMES) {
    const spec = EVENTS[name];
    lines.push(`  - ${name}: ${spec.description}`);
    lines.push(`      actions: ${spec.actions.join(", ")}`);
    const props = Object.keys(spec.properties);
    lines.push(`      properties: ${props.length ? props.join(", ") : "(none)"}`);
  }
  lines.push("");
  lines.push("Collected fields (common envelope)");
  lines.push(
    "  event_id, event_name, occurred_at, anonymous_install_id, invocation_id,"
  );
  lines.push(
    "  app_version, platform, arch, node_major, provider, interactive, action,"
  );
  lines.push("  outcome, duration_ms, error_category, properties");
  lines.push("");
  lines.push("Never collected");
  lines.push(`  ${NEVER_COLLECTED.join(", ")}.`);
  lines.push("");
  lines.push("Local files");
  lines.push(`  state: ${io.statePath}`);
  lines.push(`  queue: ${io.queuePath}`);
  lines.push("");
  lines.push("Queue behavior");
  lines.push(
    `  Up to ${MAX_QUEUE_EVENTS} events / ${MAX_QUEUE_BYTES / 1024} KiB; oldest dropped first;`
  );
  lines.push(
    `  deduped by event_id; batches of up to ${MAX_EVENTS_PER_BATCH} events / ${
      MAX_BATCH_BYTES / 1024
    } KiB; schema ${SCHEMA_VERSION}.`
  );
  lines.push("");
  lines.push("Retry behavior");
  lines.push(
    `  Backoff with jitter: ${BACKOFF_SCHEDULE_MS.map((ms) => `${Math.round(ms / 60000)}m`).join(
      " → "
    )} (max 24h). A telemetry`
  );
  lines.push("  outage is invisible during normal commands. CI, DO_NOT_TRACK, DNT, and");
  lines.push("  GAC_TELEMETRY_DISABLED suppress telemetry without changing saved consent.");
  lines.push("");
  lines.push(`Telemetry details: ${TELEMETRY_DOCS_URL}`);
  lines.push(`Privacy policy:   ${PRIVACY_URL}`);
  lines.push("");
  lines.push(ATTRIBUTION);
  return lines.join("\n");
}
