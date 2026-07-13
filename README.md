# GAC CLI (gac)

Terminal client for OpenAI-compatible APIs (including GPT4All) and Ollama. Supports streaming responses, interactive chat with saved sessions, piped input, AI-generated commit messages, step-by-step runbooks with approval gates, and configurable markdown rendering (tables and syntax highlighting included) using `terminal-kit`.

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
- Steps run in a persistent shell on Linux/macOS (`cd` and environment persist). On Windows, steps run through `cmd.exe` with the working directory tracked across steps (`cd` works; `set` variables don't persist between steps).

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

Exit chat with `exit`, `quit`, or Ctrl+C. Start a line with `"""` to enter multi-line input (finish with `"""` on its own line) — handy for pasting code. See `/help` inside chat for all commands (`/new`, `/sessions`, `/rename`, `/system`, `/clear`, `/retry`, `/export`).

Long conversations are automatically trimmed to fit the model's context window — the full history stays saved in the session; only the request to the model drops the oldest turns (a notice is shown when that happens).

Flags:

- `-f, --file <path>` include a file as context (repeatable).
- `-d, --detailed-suggest` enable more detailed, step-by-step suggestions in `suggest` mode (can also be set via config key `detailedSuggest`).
- `--detailed-context` include current directory context in `suggest`/`explain` prompts (can also be set via config key `detailedContext`).
- `--dry-run` runbook/commit: show the result, execute nothing.
- `--export <path>` runbook: write the plan to a script instead of running it.
- `--no-render` disables markdown styling for that run.
- `--debug-render` prints the raw model output after the rendered response.
- `-V, --version` show version.
- `-h, --help` show help.

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

- `provider` (string): `openai` (default) or `ollama`
- `baseUrl` (string): GPT4All server base, e.g. `http://localhost:4891`
- `ollamaBaseUrl` (string): Ollama base, e.g. `http://localhost:11434`
- `apiKey` (string): API key for OpenAI-compatible services (empty for local servers)
- `model` (string): model ID from `/v1/models`
- `temperature` (number)
- `maxTokens` (number): response token cap (default `2048`). Automatically reduced per request when the prompt leaves less room in the context window.
- `contextWindow` (`"auto"` or number): size of the model's context window in tokens. `"auto"` (default) asks the backend — Ollama via `/api/show`, OpenAI-compatible servers via context metadata in `/v1/models` (LM Studio, OpenRouter, and others expose it). Set a number to pin it manually; detection failures fall back to a conservative 8192. This drives chat-history trimming, input truncation, and Ollama's `num_ctx` (sized to the conversation, so large-context models don't waste memory on short chats).
- `stream` (boolean)
- `requestTimeoutMs` (number): request timeout in milliseconds (0 to disable). Useful for larger models or slower servers.
- `defaultAction` (string): default mode for direct prompts (`suggest`, `ask`, or `explain`).
- `detailedSuggest` (boolean): when `true`, `suggest` mode returns more detailed, step-by-step suggestions.
- `detailedContext` (boolean): when `true`, `suggest`/`explain` prompts include the current directory and `ls` output.
- `renderMarkdown` (boolean)

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
