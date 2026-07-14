# GAC CLI (gac)

Terminal client for OpenAI-compatible APIs (including GPT4All), Ollama, and OpenAI Codex (sign in with your ChatGPT plan — no API key needed). Supports streaming responses, interactive chat with saved sessions, piped input, AI-generated commit messages, step-by-step runbooks with approval gates, and configurable markdown rendering (tables and syntax highlighting included) using `terminal-kit`.

## Installation

Requirements: Node.js 18+ and a running OpenAI-compatible server (like GPT4All) or Ollama.

```bash
npm install -g @alhisan/gac
```

Or if you don't want to install globally

```bash
npm install
node bin/gac.js --help
```

Test if it works:

```bash
gac --help
```

## Usage

Single prompt:

```bash
gac -a "Hello gpt4all, how are you doing today?"
gac "How do I push to GitHub?"
gac suggest "How do I connect to ssh server on a custom port 5322?"
gac explain "How do I use rsync?"
gac suggest -d "Give me step-by-step instructions to set up an SSH server on port 5322"
gac runbook "Set up a new Node.js project with eslint"
```

### Piped input

Anything piped into gac is attached to the prompt as input — or used as the prompt itself when no prompt is given:

```bash
cat error.log | gac explain "why is this failing?"
git diff | gac ask "summarize these changes"
dmesg | tail -50 | gac "anything wrong here?"
echo "how do I list open ports" | gac
```

When gac's output is piped or redirected, it automatically switches to plain text (no colors, no markdown styling), so it composes with `less`, `grep`, files, and scripts.

Note: piped input is read until the producer closes the pipe, so don't pipe endless streams (`tail -f ... | gac` will wait forever — use `tail -n 50` instead).

### File context

Include files as context with `-f`/`--file` (repeatable):

```bash
gac explain -f src/app.js "what does this file do?"
gac ask -f package.json -f src/cli.js "why might the build fail?"
```

Oversized input (piped or file) is automatically truncated head-and-tail to fit the model's context window.

### Commit messages

Generate a commit message from your staged changes:

```bash
git add -p
gac commit            # propose, then [Enter] commit / [e] edit / [r] regenerate / [q] quit
gac commit --dry-run  # print the message only, never commit
```

`[e]` opens the message in `$EDITOR`. In a non-interactive shell `gac commit` prints the message and exits without committing.

### Fixing a failed command

```bash
gac fix                          # fix the last command from shell history
gac fix "tar -xvf archive"       # fix an explicit command
mycmd 2>&1 | gac fix mycmd       # include the error output as context
```

gac proposes a corrected command with a one-line explanation, then `[Enter] run / [e] edit / [c] copy / [q] quit`. `[c]` copies via OSC 52 (works over SSH). Corrections matching the blocklist can't be run, only edited or copied. History lookup supports bash, zsh, and fish (note: bash only writes history on shell exit unless you use `history -a` in `PROMPT_COMMAND`).

### Runbooks

`gac runbook` asks the model for a step-by-step command plan, then walks through it with per-step approval:

```text
Step 1 of 3:
Install dependencies
Command: npm install
[Enter] run  [e] edit  [s] skip  [q] quit:
```

- `[e]` lets you edit the command before running it (fix paths, ports, placeholders).
- `[s]` skips a step, `[q]` stops and prints the remaining plan.
- Commands matching the blocklist (`blocked_commands.json`) cannot be run — only edited or skipped.
- When a step fails, gac offers `[r] ask the model for a fix` — the error output is sent back to the model and the corrected command re-enters the normal approval gate — alongside `[s] skip` and `[q] stop`.
- Steps run in a persistent shell everywhere: your login shell on Linux/macOS, PowerShell on Windows — `cd` and environment variables persist across steps on both.

Preview or export instead of executing:

```bash
gac runbook --dry-run "Install docker"           # print the plan, run nothing
gac runbook --export setup.sh "Install docker"   # write an executable script (also .ps1 / .bat)
```

Exported scripts comment out blocked commands with the reason.

List models and set a default:

```bash
gac models
```

This opens an interactive selector. Use arrow keys + Enter to choose a model, or Ctrl+C/Esc to cancel. In a non-interactive shell it just prints the list.

Interactive mode:

```bash
gac chat
```

Exit chat with `exit`, `quit`, or Ctrl+C. Start a line with `"""` to enter multi-line input (finish with `"""` on its own line) — handy for pasting code. See `/help` inside chat for all commands (`/new`, `/sessions`, `/rename`, `/system`, `/model`, `/copy`, `/clear`, `/retry`, `/export`): `/model` switches models for the current session, and `/copy` copies the last code block (or the whole last reply) to your clipboard via OSC 52 — which works over SSH in most modern terminals.

Long conversations are automatically trimmed to fit the model's context window — the full history stays saved in the session; only the request to the model drops the oldest turns (a notice is shown when that happens).

Flags (place them before the prompt — once the prompt starts, tokens like `-f` are treated as prompt text, so `gac ask what does -f mean in tar` works):

- `-f, --file <path>` include a file as context (repeatable).
- `-d, --detailed-suggest` enable more detailed, step-by-step suggestions in `suggest` mode (can also be set via config key `detailedSuggest`).
- `--detailed-context` include current directory context in `suggest`/`explain` prompts (can also be set via config key `detailedContext`).
- `--dry-run` runbook/commit: show the result, execute nothing.
- `--export <path>` runbook: write the plan to a script instead of running it.
- `--no-render` disables markdown styling for that run.
- `--debug-render` prints the raw model output after the rendered response.
- `-V, --version` show version.
- `-h, --help` show help.

### Shell completions

```bash
# bash
gac completions bash > ~/.local/share/bash-completion/completions/gac
# (or add to ~/.bashrc:  eval "$(gac completions bash)")

# zsh — with fpath+=(~/.zfunc) before compinit in ~/.zshrc
gac completions zsh > ~/.zfunc/_gac

# fish
gac completions fish > ~/.config/fish/completions/gac.fish
```

Completes commands, flags, `config get/set/tui`, and file paths for `-f`/`--export`.

## OpenAI Codex (ChatGPT plan)

gac can talk to OpenAI's Codex backend using the same ChatGPT OAuth sign-in the official Codex CLI uses, so usage is billed to your ChatGPT plan (Plus/Pro/Team) instead of an API key:

```bash
gac auth login                     # opens the browser; sign in with your ChatGPT account
gac config set provider codex      # or pick it in `gac config tui`
gac ask "how do I list open ports?"
```

- `gac auth status` shows who is signed in (and the plan); `gac auth logout` removes the stored credentials.
- If you already use the Codex CLI, gac reuses your existing `~/.codex/auth.json` login automatically — no second sign-in needed.
- Tokens are stored in `~/.gac/codex-auth.json` and refreshed automatically when they expire.
- The Codex provider has its own model setting (`codexModel`, default `gpt-5.6-sol`), so you can switch between `openai`, `ollama`, and `codex` freely without breaking either setup. `gac models` and `/model` in chat edit the right one for the active provider.
- `gac models` lists the models your ChatGPT plan can actually use right now — gac reads OpenAI's live catalog for your account, so the list stays correct as OpenAI rotates models. If a saved `codexModel` has been retired you'll get a clear error naming the current models and how to switch.
- On a remote/SSH machine, forward the OAuth callback port before `gac auth login`: `ssh -L 1455:localhost:1455 <host>`.
- The Codex backend only streams; with `stream: false` gac simply buffers the stream and prints the finished reply.
- `maxTokens` is honored (sent as `max_output_tokens`; on reasoning models it includes reasoning tokens, so very small caps can cut answers short). `temperature` is not sent — the Codex backend manages sampling.
- Usage counts against your ChatGPT plan's limits; when a limit is hit the API returns an error and gac reports when it resets.

## Telemetry

GAC can send **optional, opt-in, privacy-preserving usage telemetry**. It is
**OFF by default** and creates nothing on disk or the network until you
explicitly consent.

```bash
gac telemetry status    # show the saved + effective state (no network request)
gac telemetry info      # full consent statement, event catalog, and file paths
gac telemetry enable    # interactive consent (default No); --yes for scripts
gac telemetry disable   # turn off, delete the queue and local identifier
```

The first time you run an interactive, telemetry-eligible command (`ask`,
`suggest`, `explain`, a direct prompt, `chat`, `runbook`, `commit`, `fix`) you
are shown a one-time notice and asked once. The default answer is **No**, and
declining is remembered so you are not asked again. The prompt never appears for
`--help`, `--version`, `config`, `auth`, `models`, `completions`, the
`telemetry` commands, or any non-interactive / piped / redirected / CI run.

### What is collected

A stable, **random installation identifier** generated by GAC (a UUID hashed to
`SHA-256("gac-telemetry-v1:" + uuid)`, sent as 64 hex characters — the raw UUID
never leaves your machine), plus: GAC version, OS family, CPU architecture,
Node.js major version, provider category (OpenAI-compatible / Ollama / Codex /
unknown), action names, success/failure/cancel/no-op outcomes, operation
timings, and coarse size/count buckets. Feature events add aggregate counts such
as runbook steps run/skipped/edited/blocked/failed/repaired, chat message and
retry activity, the commit generation→commit funnel, and the fix
generation→run funnel. The full, machine-readable contract lives in
[`docs/telemetry-contract-v1.json`](docs/telemetry-contract-v1.json) (also served
at `https://api.getgac.dev/v1/telemetry-contract`).

Because the identifier links events from one installation over time, the metric
is **active installations, not people** — it is pseudonymous, not a proof of a
unique person.

### What is never collected

Prompts, model replies, chat/system prompts, commands, command output, files,
paths, repository details, commit content, model names, server URLs,
configuration values, credentials, account details, environment variables,
hostnames, usernames, and device identifiers. No geography, no prompt/topic
analysis. See `gac telemetry info` for the exhaustive list.

### Source IP

The telemetry service necessarily receives your source IP while processing the
HTTPS request, but is designed **not** to store it in its telemetry database or
application logs.

### Endpoints, files, and behavior

- Endpoint: `POST https://api.getgac.dev/v1/events/batch`
- Public contract: `https://api.getgac.dev/v1/telemetry-contract`
- Docs: <https://getgac.dev/telemetry> · Privacy: <https://getgac.dev/privacy>
- Local files: `~/.gac/telemetry.json` (state) and
  `~/.gac/telemetry-queue.ndjson` (queue), created only after consent, mode
  `0600` where supported.
- Queue: up to 1,000 events / 1 MiB; oldest dropped first; deduped by event id;
  batched (≤ 50 events / 64 KiB).
- Outages are invisible during normal commands. Failed sends are retried with
  backoff (1m → 5m → 30m → 2h → 8h → max 24h) and never print warnings; only
  `gac telemetry status` surfaces the coarse saved failure state.
- Suppression: set `CI`, `DO_NOT_TRACK`, `DNT`, or `GAC_TELEMETRY_DISABLED` to a
  truthy value (`1`, `true`, `yes`, `on`) to suppress telemetry without changing
  your saved consent.
- `gac telemetry disable` removes queued events and the local identifier;
  re-enabling generates a **new** identifier. Disabling cannot retroactively
  remove aggregate data already accepted by the backend.
- If the notice text or collected field set changes materially, the consent
  version is incremented and older consent becomes ineffective — nothing is
  collected until you consent again.

> Developed by alhisan >|

## Configuration

Config file is created on first run:

- Primary: `~/.gac/config.json`
- Fallback: `.gac/config.json` (when home is not writable)

View and edit:

```bash
gac config
gac config tui
gac config get baseUrl
gac config set baseUrl http://localhost:4891
gac config set model "Llama 3 8B Instruct"
gac config set markdownStyles.codeStyles '["#8be9fd"]'
gac config set detailedSuggest true
gac config set detailedContext true
```

### Core settings

- `provider` (string): `openai` (default), `ollama`, or `codex` (ChatGPT plan OAuth — see above)
- `baseUrl` (string): GPT4All server base, e.g. `http://localhost:4891`
- `ollamaBaseUrl` (string): Ollama base, e.g. `http://localhost:11434`
- `codexBaseUrl` (string): Codex backend base (default `https://chatgpt.com/backend-api/codex`)
- `apiKey` (string): API key for OpenAI-compatible services (empty for local servers; not used by `codex`)
- `model` (string): model ID from `/v1/models` (used by `openai` and `ollama`)
- `codexModel` (string): model used when `provider` is `codex` (default `gpt-5.6-sol`; run `gac models` for the current list your plan supports)
- `codexClientVersion` (`null` or string): Codex CLI version gac reports when fetching the model catalog. `null` (default) claims an always-ahead version so new model generations surface automatically; set a real `"x.y.z"` only if the backend ever needs one
- `temperature` (number)
- `maxTokens` (`"auto"` or number): response token cap. `"auto"` (the default) uses the output limit reported by the selected model's definition — re-detected whenever you switch models — and falls back to `2048` when the backend doesn't report one. A positive number pins the cap manually; `0` (or any value ≤ 0) removes it entirely so the model can answer as long as necessary, bounded only by its context window. Either way it is automatically reduced per request when the prompt leaves less room in the context window.
- `contextWindow` (`"auto"` or number): size of the model's context window in tokens. `"auto"` (default) asks the backend — Ollama via `/api/show`, OpenAI-compatible servers via context metadata in `/v1/models` (LM Studio, OpenRouter, and others expose it); the `codex` provider uses the GPT-5 family's known ~272k window. Set a number to pin it manually; detection failures fall back to a conservative 8192. This drives chat-history trimming, input truncation, and Ollama's `num_ctx` (sized to the conversation, so large-context models don't waste memory on short chats).
- `stream` (boolean)
- `requestTimeoutMs` (number): request timeout in milliseconds (0 to disable). Useful for larger models or slower servers.
- `defaultAction` (string): default mode for direct prompts (`suggest`, `ask`, or `explain`).
- `detailedSuggest` (boolean): when `true`, `suggest` mode returns more detailed, step-by-step suggestions.
- `detailedContext` (boolean): when `true`, `suggest`/`explain` prompts include the current directory and `ls` output.
- `renderMarkdown` (boolean)
- `showThinking` (boolean, default `true`): stream the model's `<think>` reasoning as dim text while it thinks, then erase it and show only the answer. Automatically disabled when output is piped.

### Markdown styling

All markdown options live under `markdownStyles`:

- `headerStyles` (array of styles)
- `headerStylesByLevel` (object, keys `1`–`6` → array of styles)
- `headerUnderline` (boolean)
- `headerUnderlineLevels` (array of levels to underline)
- `headerUnderlineStyle` (array of styles)
- `headerUnderlineChar` (string, single character)
- `codeStyles` (array of styles)
- `codeBackground` (array of styles)
- `codeBorder` (boolean)
- `codeBorderStyle` (array of styles)
- `codeGutter` (string)
- `codeBorderChars` (object: `topLeft`, `top`, `topRight`, `bottomLeft`, `bottom`, `bottomRight`)
- `syntaxHighlight` (boolean, default `true`): per-token highlighting inside fenced code blocks (JavaScript/TypeScript, Python, Bash, Go, Rust, C/C++, Java, SQL, Ruby, PHP, JSON, YAML)
- `syntaxStyles` (object: `keyword`, `string`, `comment`, `number` → array of styles)
- `tableBorderStyle` (array of styles): markdown tables render as aligned columns with box-drawing separators
- `tableHeaderStyles` (array of styles)

Style values can be:

- Terminal-kit style names like `bold`, `underline`, `dim`, `brightWhite`
- Foreground hex colors: `"#ffcc00"`
- Background hex colors: `"bg:#202020"` or `"bg#202020"`
- Default/transparent: `"default"` (fg) or `"bg:default"`

Example:

```json
{
  "markdownStyles": {
    "headerStylesByLevel": {
      "1": ["bold", "brightWhite"],
      "2": ["bold"],
      "3": ["bold"],
      "4": ["dim"],
      "5": ["dim"],
      "6": ["dim"]
    },
    "headerUnderline": true,
    "headerUnderlineLevels": [1],
    "codeStyles": ["#8be9fd"],
    "codeBackground": ["bg:default"],
    "codeBorderStyle": ["#444444"],
    "syntaxStyles": {
      "keyword": ["#ff79c6"],
      "string": ["#f1fa8c"],
      "comment": ["dim"],
      "number": ["#bd93f9"]
    }
  }
}
```

## Troubleshooting

If you see connection errors, verify the server is reachable:

```bash
curl http://[SERVER_ADDRESS]:[SERVER_PORT]/v1/models
```

For Ollama:

```bash
curl http://[SERVER_ADDRESS]:[SERVER_PORT]/api/tags
```

## License

GNU General Public License v3.0. See `LICENSE`.

## Disclaimer

This was mostly vibe coded and I'm treating it as a fun side project / tool that is likely to remain improved and updated by agentic models.
Some notes on `runbook`: commands come from a language model, so review every step before approving it. Guard rails exist — a blocklist of destructive patterns (`blocked_commands.json`), per-step `[Enter] run / [e] edit / [s] skip / [q] quit` gates, and `--dry-run`/`--export` for previewing without executing — but you are the final check. Blocked commands can't be run from the prompt, only edited or skipped.
