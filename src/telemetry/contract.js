// Telemetry contract — the single source of truth in code.
//
// This module defines every enum, every event, and every property that GAC's
// optional telemetry may ever send, plus a strict validator. It also builds the
// machine-readable contract document that is mirrored to
// docs/telemetry-contract-v1.json and served at the public contract endpoint.
//
// Importing this module performs NO network or filesystem access. It is pure
// data and pure functions.

// ── Versions and endpoints ─────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;
// Bump when the notice text or the collected field set changes materially.
// Older saved consent then becomes ineffective (consent-expired).
export const TELEMETRY_CONSENT_VERSION = 1;
export const TELEMETRY_NOTICE_VERSION = 1;

export const INGEST_ENDPOINT = "https://api.getgac.dev/v1/events/batch";
export const CONTRACT_ENDPOINT = "https://api.getgac.dev/v1/telemetry-contract";
export const TELEMETRY_DOCS_URL = "https://getgac.dev/telemetry";
export const PRIVACY_URL = "https://getgac.dev/privacy";

// The transmitted identifier is SHA-256(INSTALL_ID_HASH_PREFIX + installationId).
export const INSTALL_ID_HASH_PREFIX = "gac-telemetry-v1:";

export const ATTRIBUTION = "Developed by alhisan >|";

// ── Transport limits ───────────────────────────────────────────────────────

export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_BATCH_BYTES = 64 * 1024; // 64 KiB serialized body
export const MAX_QUEUE_EVENTS = 1000;
export const MAX_QUEUE_BYTES = 1024 * 1024; // 1 MiB
export const MAX_DURATION_MS = 86_400_000; // clamp durations to 24h

// Backoff schedule (ms): 1m, 5m, 30m, 2h, 8h, max 24h.
export const BACKOFF_SCHEDULE_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  8 * 60 * 60_000,
  24 * 60 * 60_000,
];

// ── Enums ──────────────────────────────────────────────────────────────────

export const OUTCOMES = ["success", "failure", "cancelled", "no_op"];

export const ERROR_CATEGORIES = [
  "validation",
  "configuration",
  "authentication",
  "authorization",
  "network",
  "timeout",
  "rate_limited",
  "provider_4xx",
  "provider_5xx",
  "parse",
  "filesystem",
  "git",
  "shell",
  "blocked",
  "empty_response",
  "unknown",
];

export const PLATFORMS = ["linux", "darwin", "win32", "freebsd", "other"];
export const ARCHES = ["x64", "arm64", "arm", "ia32", "other"];
export const PROVIDERS = ["openai_compatible", "ollama", "codex", "unknown"];

export const SIZE_BUCKETS = [
  "none",
  "1_100",
  "101_500",
  "501_2000",
  "2001_10000",
  "10001_50000",
  "50001_plus",
];

export const COUNT_BUCKETS = ["0", "1", "2_5", "6_10", "11_25", "26_plus"];

export const CONTEXT_WINDOW_BUCKETS = [
  "unknown",
  "up_to_8k",
  "8k_to_32k",
  "32k_to_128k",
  "128k_plus",
];

export const ATTEMPT_COUNT_BUCKETS = ["1", "2", "3_5", "6_plus"];

export const HTTP_STATUS_CLASSES = ["none", "2xx", "4xx", "429", "5xx"];

export const EXIT_CODE_CLASSES = [
  "zero",
  "one",
  "two",
  "three_to_10",
  "11_to_127",
  "128_plus",
  "unknown",
];

export const INPUT_MODES = ["none", "arguments", "stdin", "files", "stdin_and_files"];

// ── Reusable JSON-schema fragments ─────────────────────────────────────────

const bool = () => ({ type: "boolean" });
const enumOf = (values) => ({ enum: [...values] });
const nullableEnum = (values) => ({ enum: [...values, null] });
const intRange = (min, max) => ({ type: "integer", minimum: min, maximum: max });

// ── Event catalog ──────────────────────────────────────────────────────────
//
// Each entry lists the allowed `action` values and a strict JSON-schema for the
// event's `properties` object (additionalProperties:false). Only these keys and
// value shapes may ever be queued or transmitted.

export const EVENTS = {
  telemetry_enabled: {
    description:
      "Emitted only after consent is saved (first-run prompt or manual enable).",
    actions: ["first_run_prompt", "manual_command"],
    properties: {
      // Bounds mirror the backend contract (api: telemetry_enabled.consent_version).
      consent_version: { type: "integer", minimum: 0, maximum: 1000 },
    },
  },

  command_completed: {
    description: "One event per completed top-level command (excludes telemetry commands).",
    actions: [
      "help",
      "version",
      "ask",
      "suggest",
      "explain",
      "prompt",
      "runbook",
      "chat",
      "models",
      "config",
      "auth",
      "commit",
      "fix",
      "completions",
      "unknown",
    ],
    properties: {
      subcommand: nullableEnum([
        "view",
        "get",
        "set",
        "tui",
        "login",
        "logout",
        "status",
        "bash",
        "zsh",
        "fish",
        "unknown",
      ]),
      input_mode: enumOf(INPUT_MODES),
      prompt_size_bucket: enumOf(SIZE_BUCKETS),
      file_count_bucket: enumOf(COUNT_BUCKETS),
      response_size_bucket: enumOf(SIZE_BUCKETS),
      streaming: bool(),
      render_markdown: bool(),
      show_thinking: bool(),
      detailed_context: bool(),
      detailed_suggest: bool(),
    },
  },

  model_request_completed: {
    description: "One event per provider generation request, measured around the request.",
    actions: [
      "direct_prompt",
      "chat_message",
      "chat_retry",
      "chat_title",
      "runbook_plan",
      "runbook_self_heal",
      "commit_generate",
      "commit_regenerate",
      "fix_generate",
    ],
    properties: {
      streaming: bool(),
      render_markdown: bool(),
      show_thinking: bool(),
      attempt_count_bucket: enumOf(ATTEMPT_COUNT_BUCKETS),
      input_size_bucket: enumOf(SIZE_BUCKETS),
      output_size_bucket: enumOf(SIZE_BUCKETS),
      message_count_bucket: enumOf(COUNT_BUCKETS),
      trimmed_message_count_bucket: enumOf(COUNT_BUCKETS),
      context_window_bucket: enumOf(CONTEXT_WINDOW_BUCKETS),
      http_status_class: enumOf(HTTP_STATUS_CLASSES),
    },
  },

  chat_action_completed: {
    description: "One event per chat action. No chat id/name/content/model.",
    actions: [
      "session_new",
      "session_resume",
      "session_exit",
      "message",
      "retry",
      "help",
      "sessions",
      "new",
      "rename",
      "system_view",
      "system_set",
      "system_reset",
      "model_switch",
      "copy",
      "clear",
      "export",
      "delete",
    ],
    properties: {
      session_kind: nullableEnum(["new", "resumed"]),
      multiline: bool(),
      history_size_bucket: enumOf(COUNT_BUCKETS),
      trimmed_message_count_bucket: enumOf(COUNT_BUCKETS),
      copy_kind: nullableEnum(["code_block", "whole_reply", "none"]),
    },
  },

  runbook_plan_completed: {
    description: "Planning outcome. `preview` means non-interactive plan-only.",
    actions: ["execute", "dry_run", "export", "preview"],
    properties: {
      step_count: intRange(0, 100),
      notes_present: bool(),
      blocked_step_count: intRange(0, 100),
      input_mode: enumOf(INPUT_MODES),
      file_count_bucket: enumOf(COUNT_BUCKETS),
      prompt_size_bucket: enumOf(SIZE_BUCKETS),
    },
  },

  runbook_step_completed: {
    description: "Per-step action. No command text, output, or repairs.",
    actions: ["edit", "skip", "quit", "run", "self_heal_request", "self_heal_result"],
    properties: {
      // step_number/step_count are 1-based on the wire; bounds mirror the backend
      // contract (api: runbook_step_completed → int(1,100)).
      step_number: intRange(1, 100),
      step_count: intRange(1, 100),
      was_blocked: bool(),
      exit_code_class: enumOf(EXIT_CODE_CLASSES),
    },
  },

  runbook_completed: {
    description: "Per-run aggregate counters (all clamped 0–100).",
    actions: ["execute", "dry_run", "export", "preview"],
    properties: {
      steps_total: intRange(0, 100),
      steps_run: intRange(0, 100),
      steps_succeeded: intRange(0, 100),
      steps_failed: intRange(0, 100),
      steps_skipped: intRange(0, 100),
      steps_edited: intRange(0, 100),
      blocked_encounters: intRange(0, 100),
      self_heal_requests: intRange(0, 100),
    },
  },

  commit_action_completed: {
    description: "Commit funnel. No diff, message, branch, or repository identity.",
    actions: ["generate", "print", "edit", "regenerate", "commit", "cancel"],
    properties: {
      dry_run: bool(),
      staged_file_count_bucket: enumOf(COUNT_BUCKETS),
      diff_size_bucket: enumOf(SIZE_BUCKETS),
      had_recent_history: bool(),
    },
  },

  fix_action_completed: {
    description: "Fix funnel. No command, error output, or generated fix.",
    actions: ["generate", "print", "edit", "copy", "run", "cancel"],
    properties: {
      source: enumOf(["explicit", "shell_history"]),
      piped_error_context: bool(),
      was_blocked: bool(),
      exit_code_class: enumOf(EXIT_CODE_CLASSES),
    },
  },
};

export const EVENT_NAMES = Object.keys(EVENTS);

// ── Categories never collected (documentation + contract) ──────────────────

export const NEVER_COLLECTED = [
  "user prompts",
  "model responses",
  "chat messages",
  "system prompts",
  "shell commands",
  "shell history",
  "standard output",
  "standard error",
  "error text",
  "exception messages",
  "exception stacks",
  "runbook command text",
  "runbook descriptions",
  "runbook notes",
  "fixed command suggestions",
  "fix explanations",
  "commit messages",
  "staged diffs",
  "git log contents",
  "git repository names",
  "git organization names",
  "git remote URLs",
  "git branches",
  "git commit hashes",
  "file names",
  "file paths",
  "directory paths",
  "file contents",
  "current working directory",
  "model names",
  "model IDs",
  "API base URLs",
  "Ollama URLs",
  "Codex URLs",
  "arbitrary configuration values",
  "API keys",
  "OAuth tokens",
  "cookies",
  "authorization headers",
  "ChatGPT account details",
  "ChatGPT email addresses",
  "ChatGPT subscription or plan details",
  "environment variables",
  "hostname",
  "username",
  "home-directory path",
  "machine ID",
  "MAC address",
  "hardware serial numbers",
  "IP address in an event",
  "locale",
  "timezone",
  "country",
  "city",
  "derived geography",
  "arbitrary user-controlled strings",
];

// ── Minimal JSON-schema validation ─────────────────────────────────────────
//
// Supports exactly the fragments used above: type (boolean/integer/string),
// enum (including null), minimum/maximum. Deliberately tiny — no dependency.

function validateScalar(schema, value, keyPath, errors) {
  if (schema.enum) {
    if (!schema.enum.includes(value)) {
      errors.push(`${keyPath}: value not in allowed set`);
    }
    return;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") errors.push(`${keyPath}: expected boolean`);
    return;
  }
  if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      errors.push(`${keyPath}: expected integer`);
      return;
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${keyPath}: below minimum`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${keyPath}: above maximum`);
    }
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") errors.push(`${keyPath}: expected string`);
  }
}

function validateProperties(propSchemas, properties, errors) {
  if (properties === undefined || properties === null) return;
  if (typeof properties !== "object" || Array.isArray(properties)) {
    errors.push("properties: expected object");
    return;
  }
  for (const key of Object.keys(properties)) {
    const schema = propSchemas[key];
    if (!schema) {
      // Strict allowlist: unknown property names are rejected.
      errors.push(`properties.${key}: unknown property`);
      continue;
    }
    validateScalar(schema, properties[key], `properties.${key}`, errors);
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// Validate a fully-assembled event (common fields + properties). Returns
// { ok, errors }. Never throws.
export function validateEvent(event) {
  const errors = [];
  if (!event || typeof event !== "object") {
    return { ok: false, errors: ["event is not an object"] };
  }

  const spec = EVENTS[event.event_name];
  if (!spec) {
    return { ok: false, errors: [`unknown event_name: ${String(event.event_name)}`] };
  }
  if (!spec.actions.includes(event.action)) {
    errors.push(`unknown action for ${event.event_name}: ${String(event.action)}`);
  }

  // Common envelope fields.
  if (!UUID_RE.test(String(event.event_id))) errors.push("event_id: not a UUID");
  if (!UUID_RE.test(String(event.invocation_id))) errors.push("invocation_id: not a UUID");
  if (!HEX64_RE.test(String(event.anonymous_install_id))) {
    errors.push("anonymous_install_id: not 64 lowercase hex");
  }
  if (!ISO_RE.test(String(event.occurred_at))) errors.push("occurred_at: not UTC ISO-8601");
  if (typeof event.app_version !== "string" || !event.app_version) {
    errors.push("app_version: expected non-empty string");
  }
  if (!PLATFORMS.includes(event.platform)) errors.push("platform: not in enum");
  if (!ARCHES.includes(event.arch)) errors.push("arch: not in enum");
  if (typeof event.node_major !== "number" || !Number.isInteger(event.node_major)) {
    errors.push("node_major: expected integer");
  }
  if (!PROVIDERS.includes(event.provider)) errors.push("provider: not in enum");
  if (typeof event.interactive !== "boolean") errors.push("interactive: expected boolean");
  if (!OUTCOMES.includes(event.outcome)) errors.push("outcome: not in enum");

  if (event.duration_ms !== null) {
    if (
      typeof event.duration_ms !== "number" ||
      !Number.isInteger(event.duration_ms) ||
      event.duration_ms < 0
    ) {
      errors.push("duration_ms: expected null or nonnegative integer");
    }
  }
  if (event.error_category !== null && !ERROR_CATEGORIES.includes(event.error_category)) {
    errors.push("error_category: not null and not in enum");
  }

  validateProperties(spec.properties, event.properties, errors);

  return { ok: errors.length === 0, errors };
}

// ── Machine-readable contract document ─────────────────────────────────────
//
// This object is mirrored verbatim to docs/telemetry-contract-v1.json and is
// what the backend consumes / the public contract endpoint serves. A unit test
// asserts the file matches this builder so client and contract cannot drift.

function jsonSchemaForEvent(name) {
  const spec = EVENTS[name];
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "event_id",
      "event_name",
      "occurred_at",
      "anonymous_install_id",
      "invocation_id",
      "app_version",
      "platform",
      "arch",
      "node_major",
      "provider",
      "interactive",
      "action",
      "outcome",
      "duration_ms",
      "error_category",
      "properties",
    ],
    properties: {
      event_id: { type: "string", format: "uuid" },
      event_name: { const: name },
      occurred_at: { type: "string", format: "date-time" },
      anonymous_install_id: { type: "string", pattern: "^[0-9a-f]{64}$" },
      invocation_id: { type: "string", format: "uuid" },
      app_version: { type: "string" },
      platform: enumOf(PLATFORMS),
      arch: enumOf(ARCHES),
      node_major: { type: "integer", minimum: 0 },
      provider: enumOf(PROVIDERS),
      interactive: { type: "boolean" },
      action: enumOf(spec.actions),
      outcome: enumOf(OUTCOMES),
      duration_ms: {
        type: ["integer", "null"],
        minimum: 0,
        maximum: MAX_DURATION_MS,
      },
      error_category: nullableEnum(ERROR_CATEGORIES),
      properties: {
        type: "object",
        additionalProperties: false,
        properties: spec.properties,
      },
    },
  };
}

export function buildContract() {
  const eventSchemas = {};
  for (const name of EVENT_NAMES) {
    eventSchemas[name] = {
      description: EVENTS[name].description,
      actions: [...EVENTS[name].actions],
      schema: jsonSchemaForEvent(name),
    };
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "GAC telemetry contract",
    contract_version: 1,
    schema_version: SCHEMA_VERSION,
    consent_version: TELEMETRY_CONSENT_VERSION,
    notice_version: TELEMETRY_NOTICE_VERSION,
    description:
      "Pseudonymous installation telemetry for GAC. Off by default; explicitly " +
      "opt-in. The identifier links events from one installation over time and is " +
      "not a count of unique people.",
    attribution: ATTRIBUTION,
    endpoints: {
      ingest: INGEST_ENDPOINT,
      contract: CONTRACT_ENDPOINT,
      docs: TELEMETRY_DOCS_URL,
      privacy: PRIVACY_URL,
    },
    identifier: {
      kind: "pseudonymous installation id",
      derivation: 'SHA-256("gac-telemetry-v1:" + installationId)',
      format: "64 lowercase hexadecimal characters",
      notes:
        "installationId is a locally generated random UUID. It is not derived from " +
        "any user, account, network, hardware, hostname, or filesystem attribute. " +
        "The raw UUID is never transmitted. It changes when telemetry is disabled " +
        "and re-enabled.",
    },
    ip_handling:
      "The service necessarily receives the source IP while processing the HTTPS " +
      "request, but is designed not to persist it in its telemetry database or " +
      "application logs.",
    transport: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "gac/<version>",
        "X-GAC-Telemetry-Schema": String(SCHEMA_VERSION),
      },
      limits: {
        max_events_per_request: MAX_EVENTS_PER_BATCH,
        max_body_bytes: MAX_BATCH_BYTES,
        compression: "none",
        max_concurrent_batches: 1,
      },
      backoff_schedule_ms: [...BACKOFF_SCHEDULE_MS],
    },
    enums: {
      outcomes: OUTCOMES,
      error_categories: ERROR_CATEGORIES,
      platforms: PLATFORMS,
      arches: ARCHES,
      providers: PROVIDERS,
      size_buckets: SIZE_BUCKETS,
      count_buckets: COUNT_BUCKETS,
      context_window_buckets: CONTEXT_WINDOW_BUCKETS,
      attempt_count_buckets: ATTEMPT_COUNT_BUCKETS,
      http_status_classes: HTTP_STATUS_CLASSES,
      exit_code_classes: EXIT_CODE_CLASSES,
      input_modes: INPUT_MODES,
    },
    envelope_schema: {
      type: "object",
      additionalProperties: false,
      required: ["batch_id", "schema_version", "sent_at", "events"],
      properties: {
        batch_id: { type: "string", format: "uuid" },
        schema_version: { const: SCHEMA_VERSION },
        sent_at: { type: "string", format: "date-time" },
        events: {
          type: "array",
          minItems: 1,
          maxItems: MAX_EVENTS_PER_BATCH,
          items: { oneOf: EVENT_NAMES.map((n) => ({ $ref: `#/events/${n}/schema` })) },
        },
      },
    },
    success_response_schema: {
      type: "object",
      additionalProperties: true,
      required: ["request_id", "accepted_event_ids", "server_time"],
      properties: {
        request_id: { type: "string" },
        accepted_event_ids: { type: "array", items: { type: "string" } },
        duplicate_event_ids: { type: "array", items: { type: "string" } },
        rejected: {
          type: "array",
          items: {
            type: "object",
            properties: {
              event_id: { type: ["string", "null"] },
              code: { type: "string" },
              message: { type: "string" },
            },
          },
        },
        server_time: { type: "string", format: "date-time" },
      },
    },
    events: eventSchemas,
    never_collected: [...NEVER_COLLECTED],
  };
}
