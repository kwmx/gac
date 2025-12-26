# GPT4All CLI (gac)

Terminal client for GPT4All running on localhost. Supports streaming responses, interactive chat, and configurable markdown rendering using `terminal-kit`.

## Installation

Requirements: Node.js 18+ and a running GPT4All OpenAI-compatible server.

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
gac suggest "How do I connect to ssh server on a custom port 5322?"
gac explain "How do I use rsync?"
gac suggest -d "Give me step-by-step instructions to set up an SSH server on port 5322"
```

List models and set a default:

```bash
gac models
```

This opens an interactive selector. Use arrow keys + Enter to choose a model, or Ctrl+C/Esc to cancel.

Interactive mode:

```bash
gac chat
```

Exit chat with `exit`, `quit`, or Ctrl+C.

Flags:

- `--no-render` disables markdown styling for that run.
- `--debug-render` prints the raw model output after the rendered response.

- `-d, --detailed-suggest` enable more detailed, step-by-step suggestions in `suggest` mode (can also be set via config key `detailedSuggest`).

## Configuration

Config file is created on first run:

- Primary: `~/.gac/config.json`
- Fallback: `.gac/config.json` (when home is not writable)

View and edit:

```bash
gac config
gac config get baseUrl
gac config set baseUrl http://localhost:4891
gac config set model "Llama 3 8B Instruct"
gac config set markdownStyles.codeStyles '["#8be9fd"]'
gac config set detailedSuggest true
```

### Core settings

- `baseUrl` (string): GPT4All server base, e.g. `http://localhost:4891`
- `model` (string): model ID from `/v1/models`
- `temperature` (number)
- `maxTokens` (number)
- `stream` (boolean)
- `detailedSuggest` (boolean): when `true`, `suggest` mode returns more detailed, step-by-step suggestions.
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
    "codeBorderStyle": ["#444444"]
  }
}
```

## Troubleshooting

If you see connection errors, verify the server is reachable:

```bash
curl http://localhost:4891/v1/models
```

## License

GNU General Public License v3.0. See `LICENSE`.
