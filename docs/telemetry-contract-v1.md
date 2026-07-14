# GAC Telemetry Contract v1 (human-readable)

The authoritative machine-readable contract is
[`telemetry-contract-v1.json`](./telemetry-contract-v1.json), generated from
`src/telemetry/contract.js` and served at
`GET https://api.getgac.dev/v1/telemetry-contract`. This page mirrors it in prose.

> Developed by alhisan >|

- **Ingest:** `POST https://api.getgac.dev/v1/events/batch`
- **Contract:** `GET https://api.getgac.dev/v1/telemetry-contract`
- **Docs:** <https://getgac.dev/telemetry> · **Privacy:** <https://getgac.dev/privacy>
- `schema_version` = 1 · `consent_version` = 1 · `notice_version` = 1

## Identifier

`anonymous_install_id = SHA-256("gac-telemetry-v1:" + installationId)`, sent as
64 lowercase hexadecimal characters. `installationId` is a locally generated
random UUID. It is **not** derived from any user, account, network, hardware,
hostname, or filesystem attribute. The raw UUID is never transmitted. It changes
when telemetry is disabled and re-enabled. It links events from one installation
over time — it counts **active installations, not people**, and is not claimed to
be mathematically anonymous.

## Source IP

The service necessarily receives the source IP while processing the HTTPS
request, but is designed **not** to persist it in its telemetry database or
application logs.

## Transport

`POST https://api.getgac.dev/v1/events/batch`

Headers:

```
Content-Type: application/json
Accept: application/json
User-Agent: gac/<version>
X-GAC-Telemetry-Schema: 1
```

Limits: ≤ 50 events/request, ≤ 64 KiB serialized body, no compression in v1, one
concurrent batch. Backoff schedule (ms): `60000, 300000, 1800000, 7200000,
28800000, 86400000` (1m → 5m → 30m → 2h → 8h → max 24h), with jitter.

## Envelope

```json
{
  "batch_id": "<UUID v4>",
  "schema_version": 1,
  "sent_at": "<UTC ISO-8601>",
  "events": [ /* 1..50 events */ ]
}
```

## Common event fields

| Field | Type |
| --- | --- |
| `event_id` | UUID v4 |
| `event_name` | strict enum (see Events) |
| `occurred_at` | UTC ISO-8601 |
| `anonymous_install_id` | 64 lowercase hex |
| `invocation_id` | UUID v4 (per process) |
| `app_version` | GAC semver |
| `platform` | `linux \| darwin \| win32 \| freebsd \| other` |
| `arch` | `x64 \| arm64 \| arm \| ia32 \| other` |
| `node_major` | integer |
| `provider` | `openai_compatible \| ollama \| codex \| unknown` |
| `interactive` | boolean |
| `action` | event-specific enum |
| `outcome` | `success \| failure \| cancelled \| no_op` |
| `duration_ms` | `null` or integer ≥ 0 (clamped ≤ 86,400,000) |
| `error_category` | `null` or coarse enum |
| `properties` | event-specific object, `additionalProperties: false` |

Validation notes: `duration_ms` is null or a nonnegative integer and is clamped
to 86,400,000 ms. Unknown fields, exact HTTP status codes, raw exit codes, exact
text sizes, and error messages are never sent.

## Enums

- **outcomes:** `success, failure, cancelled, no_op`
- **error_categories:** `validation, configuration, authentication,
  authorization, network, timeout, rate_limited, provider_4xx, provider_5xx,
  parse, filesystem, git, shell, blocked, empty_response, unknown`
- **size_buckets:** `none, 1_100, 101_500, 501_2000, 2001_10000, 10001_50000,
  50001_plus`
- **count_buckets:** `0, 1, 2_5, 6_10, 11_25, 26_plus`
- **context_window_buckets:** `unknown, up_to_8k, 8k_to_32k, 32k_to_128k,
  128k_plus`
- **attempt_count_buckets:** `1, 2, 3_5, 6_plus`
- **http_status_classes:** `none, 2xx, 4xx, 429, 5xx`
- **exit_code_classes:** `zero, one, two, three_to_10, 11_to_127, 128_plus,
  unknown`
- **input_modes:** `none, arguments, stdin, files, stdin_and_files`

## Events

### `telemetry_enabled`

Emitted only after consent is saved. Never emitted for declining or disabling.

- **actions:** `first_run_prompt, manual_command`
- **properties:** `consent_version` (integer ≥ 1)

### `command_completed`

One event per completed top-level command; telemetry control commands are
excluded.

- **actions:** `help, version, ask, suggest, explain, prompt, runbook, chat,
  models, config, auth, commit, fix, completions, unknown`
- **properties (all optional):** `subcommand`
  (`view|get|set|tui|login|logout|status|bash|zsh|fish|unknown|null`),
  `input_mode`, `prompt_size_bucket`, `file_count_bucket`, `response_size_bucket`,
  `streaming`, `render_markdown`, `show_thinking`, `detailed_context`,
  `detailed_suggest`
- **outcomes:** `success` (intended action completed), `failure` (failed or
  nonzero exit), `cancelled` (user quit), `no_op` (valid but nothing to do)

### `model_request_completed`

One event per provider generation request, measured around the request. Failures
are classified for telemetry, then the original application error is preserved
and rethrown unchanged.

- **actions:** `direct_prompt, chat_message, chat_retry, chat_title,
  runbook_plan, runbook_self_heal, commit_generate, commit_regenerate,
  fix_generate`
- **properties:** `streaming`, `render_markdown`, `show_thinking`,
  `attempt_count_bucket`, `input_size_bucket`, `output_size_bucket`,
  `message_count_bucket`, `trimmed_message_count_bucket`, `context_window_bucket`,
  `http_status_class`

### `chat_action_completed`

- **actions:** `session_new, session_resume, session_exit, message, retry, help,
  sessions, new, rename, system_view, system_set, system_reset, model_switch,
  copy, clear, export, delete`
- **properties:** `session_kind` (`new|resumed|null`), `multiline`,
  `history_size_bucket`, `trimmed_message_count_bucket`, `copy_kind`
  (`code_block|whole_reply|none|null`)
- **never:** chat id, chat name, model name, system prompt, message content,
  export path

### `runbook_plan_completed`

`preview` = non-interactive plan-only behavior.

- **actions:** `execute, dry_run, export, preview`
- **properties:** `step_count` (0–100), `notes_present`, `blocked_step_count`
  (0–100), `input_mode`, `file_count_bucket`, `prompt_size_bucket`
- **never:** command text, descriptions, notes, filenames, export paths

### `runbook_step_completed`

- **actions:** `edit, skip, quit, run, self_heal_request, self_heal_result`
- **properties:** `step_number` (1–100), `step_count` (1–100), `was_blocked`,
  `exit_code_class`
- **never:** command text, output, blocklist patterns, generated repairs

### `runbook_completed`

- **actions:** `execute, dry_run, export, preview`
- **properties (all 0–100):** `steps_total, steps_run, steps_succeeded,
  steps_failed, steps_skipped, steps_edited, blocked_encounters,
  self_heal_requests`
- **outcomes:** `success` (executed/dry-run/export/preview ok), `cancelled`
  (cancelled before/during), `failure` (planning/export/execution failure),
  `no_op` (no runnable commands)

### `commit_action_completed`

- **actions:** `generate, print, edit, regenerate, commit, cancel`
- **properties:** `dry_run`, `staged_file_count_bucket`, `diff_size_bucket`,
  `had_recent_history`
- **never:** repository identity, branch, diff, stat text, git log, generated or
  edited message, git error output

### `fix_action_completed`

- **actions:** `generate, print, edit, copy, run, cancel`
- **properties:** `source` (`explicit|shell_history`), `piped_error_context`,
  `was_blocked`, `exit_code_class`
- **never:** failed command, shell-history entry, piped error output, generated
  fix, explanation, edited command

## Never collected

The contract's `never_collected` array enumerates the full list. Highlights:
prompts, model replies, chat/system prompts, commands, command output, files,
paths, repository details, commit content, model names, server URLs,
configuration values, credentials, account details, environment variables,
hostnames, usernames, and device identifiers. No geography, no prompt/topic
analysis, no model names, no exact endpoint information, no user identities, no
account information, no content collection.

## Success response

```json
{
  "request_id": "<UUID>",
  "accepted_event_ids": ["<UUID>"],
  "duplicate_event_ids": [],
  "rejected": [
    { "event_id": "<UUID or null>", "code": "invalid_event", "message": "non-sensitive validation summary" }
  ],
  "server_time": "<UTC ISO-8601>"
}
```

Server responses: `202` removes accepted + duplicate + permanently-rejected ids;
`400/415/422` discards only permanently-invalid events; `413` retains and shrinks
future batches; `429` retains and honors `Retry-After`; `5xx` and
network/timeout/malformed responses retain and back off.
