# GAC Telemetry Plan (v1)

This document is the design record for GAC's optional, explicitly opt-in
telemetry. It is written **before** any instrumentation and is the source of
intent for `src/telemetry/*`, the machine-readable contract
(`docs/telemetry-contract-v1.json`), and the human contract
(`docs/telemetry-contract-v1.md`).

> Developed by alhisan >|

## 0. One-paragraph summary

GAC can send **pseudonymous installation telemetry**: sanitized, bucketed usage
events tied to a locally generated random installation identifier. It is **OFF
by default**, created **nothing** on disk or the network until the user
explicitly consents, and can be fully reversed. The metric it enables is
**active installations** — not people. The identifier links events from one
installation over time; it is not, and is never described as, a mathematically
anonymous or unique-person identifier.

- Ingestion endpoint: `POST https://api.getgac.dev/v1/events/batch`
- Public contract: `GET https://api.getgac.dev/v1/telemetry-contract`
- Docs: <https://getgac.dev/telemetry> · Privacy: <https://getgac.dev/privacy>

## 1. Every field that is collected, and its statistical value

All events carry a common envelope plus an event-specific `properties` object.
Every field is either a fixed enum, a coarse bucket, a small clamped integer, a
boolean, a random identifier, or a duration. **No free-text and no
user-controlled string is ever collected.**

### 1.1 Common event fields

| Field | Type | Why it has statistical value |
| --- | --- | --- |
| `event_id` | UUID v4 | Idempotent server-side dedup; client queue dedup. |
| `event_name` | strict enum | Which feature/flow produced the event. |
| `occurred_at` | UTC ISO-8601 | Time-bucketing for DAU/WAU/MAU and percentiles. |
| `anonymous_install_id` | 64 hex (SHA-256 of a random UUID) | Counts **active installations** over time and returning vs. new. Not derived from any user/device attribute. |
| `invocation_id` | UUID v4 (per process) | Groups events from a single GAC run; dedup of duplicated top-level events. |
| `app_version` | GAC semver | Version adoption and old-version activity. |
| `platform` | `linux\|darwin\|win32\|freebsd\|other` | OS distribution of the active base. |
| `arch` | `x64\|arm64\|arm\|ia32\|other` | Architecture distribution. |
| `node_major` | integer | Node.js major distribution (support matrix). |
| `provider` | `openai_compatible\|ollama\|codex\|unknown` | Provider-category usage and reliability. Never the URL, model, or key. |
| `interactive` | boolean | Separates interactive from piped/scripted usage. |
| `action` | event-specific enum | The specific sub-action within the event. |
| `outcome` | `success\|failure\|cancelled\|no_op` | Success/failure/cancel/no-op rates. |
| `duration_ms` | null or int ≥ 0 (clamped ≤ 86,400,000) | Duration percentiles for requests and actions. |
| `error_category` | null or coarse enum | Coarse reliability signal; never an error message. |
| `properties` | event-specific, `additionalProperties:false` | Bucketed, feature-specific counters described below. |

### 1.2 Event catalog and property value

See `docs/telemetry-contract-v1.md` §Events for the exhaustive per-event
property list. Summary of the value each event enables:

- `telemetry_enabled` — consent lifecycle (only emitted **after** consent is
  saved). Enables no opt-in-rate computation (declines are never sent).
- `command_completed` — one event per top-level command: commands per active
  installation, feature-usage frequency, and success/failure/cancel/no-op
  rates. Properties are coarse (input mode, size/count buckets, render flags).
- `model_request_completed` — one event per provider generation request: model
  request success rate, duration percentiles, provider-category reliability,
  coarse HTTP status class, coarse input/output/message buckets, context-window
  bucket, and attempt-count bucket.
- `chat_action_completed` — chat activity: message/retry counts, session
  new/resume/exit, and coarse history buckets. No chat id/name/content.
- `runbook_plan_completed` / `runbook_step_completed` / `runbook_completed` —
  the runbook planning→execution funnel, edit/skip/blocked/self-heal rates, and
  per-run aggregate counters (all clamped 0–100). No command text.
- `commit_action_completed` — commit generation→commit funnel and coarse diff
  buckets. No diff, message, branch, or repository identity.
- `fix_action_completed` — fix generation→copy/edit/run→success funnel, coarse
  exit-code class, and whether the source was explicit or shell history. No
  command, error output, or generated fix.

## 2. Categories that will NEVER be collected

The complete never-collected list is enforced by design (call sites pass only
precomputed scalars; every event is validated against a strict allowlist before
queueing) and enumerated in `docs/telemetry-contract-v1.md` §Never collected and
in the JSON contract's `never_collected` array. It includes, non-exhaustively:
user prompts, model responses, chat/system prompts, shell commands and history,
stdout/stderr, error text and stacks, runbook command/description/notes, fix
suggestions/explanations, commit messages, diffs, git log/repo/org/remote/branch/
hash, file names/paths/contents, current working directory, model names/IDs,
API/base/Ollama/Codex URLs, arbitrary config values, API keys, OAuth tokens,
cookies, authorization headers, ChatGPT account/email/plan, environment
variables, hostname, username, home path, machine id, MAC address, hardware
serials, IP address in an event, locale, timezone, country/city/geography, and
any arbitrary user-controlled string.

## 3. Consent behavior

- Telemetry is **OFF by default**. No event, identifier, queue file, or network
  request exists before explicit consent.
- The one-time consent notice appears **only** before the first *interactive*
  telemetry-eligible action (`ask`, `suggest`, `explain`, default/direct
  prompt, `chat`, `runbook`, `commit`, `fix`) and only when: stdin+stdout are a
  TTY, telemetry is not suppressed by env, and the decision is currently
  `undecided` at the active consent version.
- The prompt never appears for `--help`, `--version`, telemetry commands,
  `config`, `auth`, `models`, `completions`, unknown-command errors, or any
  non-interactive / piped / redirected / CI / test run.
- Declining is stored (`decision: "declined"`) so the prompt is not repeated. A
  user who declined can later enable manually.
- Consent is versioned by `TELEMETRY_CONSENT_VERSION`. If the notice text or the
  collected field set changes materially, the version is incremented and older
  consent becomes ineffective (`consent-expired`): nothing is collected or
  transmitted until the user consents again. Old consent is **not** silently
  migrated to a materially different data contract.
- Manual control: `gac telemetry enable [--yes]`, `gac telemetry disable`,
  `gac telemetry status`, `gac telemetry info`.

## 4. Local state and queue files

- State: `~/.gac/telemetry.json` (mode `0600` where supported).
- Queue: `~/.gac/telemetry-queue.ndjson` (mode `0600` where supported), one
  JSON event per line.
- State shape (see `src/telemetry/state.js`):

  ```json
  {
    "noticeVersion": 1,
    "consentVersion": 1,
    "decision": "enabled|declined|disabled",
    "enabled": true,
    "installationId": "<locally generated UUID>",
    "decidedAt": "<UTC ISO timestamp>",
    "lastSuccessAt": "<UTC ISO timestamp or null>",
    "lastFailureAt": "<UTC ISO timestamp or null>",
    "lastFailureCategory": "<coarse category or null>",
    "consecutiveFailures": 0,
    "nextAttemptAt": "<UTC ISO timestamp or null>"
  }
  ```

- The raw `installationId` UUID is **never transmitted**. The transmitted
  identifier is `SHA-256("gac-telemetry-v1:" + installationId)` as 64 lowercase
  hex characters.
- Falls back to `.gac/` in the working directory when `$HOME/.gac` is not
  writable (mirrors `config.js`).

## 5. Event-generation points in the existing code

| Event | Where it is emitted |
| --- | --- |
| `telemetry_enabled` | `src/telemetry` after consent is saved (first-run prompt or `gac telemetry enable`). |
| `command_completed` | `src/cli.js` `runCli`, once per top-level command (never for telemetry control commands). |
| `model_request_completed` | `src/gpt4all.js` `chatCompletion`, around the provider request, keyed by an explicit `telemetryAction` option. |
| `chat_action_completed` | `src/chat.js` at each chat action. |
| `runbook_plan_completed`, `runbook_step_completed`, `runbook_completed` | `src/runbook.js`. |
| `commit_action_completed` | `src/commit.js`. |
| `fix_action_completed` | `src/fix.js`. |

The request layer is told its telemetry purpose explicitly (an option), never by
inspecting message content.

## 6. Queue and delivery behavior

- Only fully sanitized, schema-validated events are stored.
- Queue limits: ≤ 1,000 events and ≤ 1 MiB; oldest events are dropped first;
  duplicates are removed by `event_id`.
- Rewrites after a successful send are atomic (temp file + rename). A partially
  written final NDJSON line is recovered by discarding only that invalid line.
  Invalid lines are dropped, valid ones preserved. Queue corruption never
  affects GAC behavior.
- Flush opportunities: after telemetry is enabled, after a normal eligible
  command completes, periodically during long chat sessions, and when a prior
  queue exists while telemetry remains enabled.
- Timing: a normal command waits at most **300 ms** for telemetry; a background
  chat flush uses **1,500 ms**. A timeout leaves events queued. At most one
  batch per foreground command; one concurrent batch maximum. Transport does not
  keep the process alive (bounded `AbortController`, cleared timers).
- Transport limits: ≤ 50 events/request, ≤ 64 KiB serialized body, no
  compression in v1.

## 7. Server-outage and error handling

A telemetry outage is invisible during normal commands. Nothing telemetry-related
prints to stdout/stderr, changes the exit code, or alters a command result. HTTP
handling:

- `202`: remove accepted + duplicate + permanently-rejected event ids; rewrite
  queue atomically; record success.
- `400/415/422`: discard only events identified as permanently invalid; do not
  loop forever.
- `413`: retain events; shrink subsequent batches.
- `429`: retain events; honor a valid `Retry-After`.
- `5xx`: retain events; apply backoff.
- Network / DNS / TLS / abort / timeout / invalid JSON / empty or malformed
  success response: retain events; apply backoff.

Backoff schedule with jitter: 1 min → 5 min → 30 min → 2 h → 8 h → max 24 h.
`consecutiveFailures`, `nextAttemptAt`, and a coarse `lastFailureCategory` are
persisted; the client does not repeatedly retry within a single foreground
command. Only `gac telemetry status` surfaces the saved coarse failure state.

## 8. Retention expectations communicated to users

- The service is designed **not** to persist the source IP in its telemetry
  database or application logs. HTTPS necessarily exposes the source IP to the
  server while the request is processed.
- Events are aggregate/pseudonymous; disabling deletes the local queue and the
  local identifier and stops all collection, but cannot retroactively remove
  aggregate data already accepted by the backend.
- Material contract changes require renewed consent (see §3).

## 9. Client/backend schema synchronization

- `src/telemetry/contract.js` is the **single source of truth** in code. It
  exports the full contract document object and the validators used by the
  client.
- `docs/telemetry-contract-v1.json` is generated from that object and is the
  artifact the backend consumes; the same content is served at
  `GET https://api.getgac.dev/v1/telemetry-contract`.
- A unit test asserts `docs/telemetry-contract-v1.json` deep-equals
  `buildContract()` from `contract.js`, so client and published contract cannot
  drift. The envelope carries `schema_version` and the `X-GAC-Telemetry-Schema`
  header so the backend can reject mismatched schema versions.

## 10. Privacy guarantees enforced in code

- Importing telemetry code performs no network or filesystem writes.
- `track()` never throws; `flush()` always resolves and never rejects into
  application code; a no-op implementation is provided.
- Call sites pass only precomputed sanitized scalar values — never prompts,
  messages, command text, output, errors, config, request, or environment
  objects.
- Unknown event names, unknown action names, and unknown property names are
  rejected locally before queueing.
- A regression test seeds sentinel secrets into every sensitive input and
  asserts none appear in any queued event, outgoing body, or saved state.
