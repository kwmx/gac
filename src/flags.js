import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import terminalKit from "terminal-kit";

const { terminal: term } = terminalKit;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getVersion() {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8");
    const pkg = JSON.parse(raw);
    return pkg.version || "unknown";
  } catch (err) {
    return "unknown";
  }
}

const BOOLEAN_FLAGS = {
  "--no-render": "noRender",
  "--debug-render": "debugRender",
  "-d": "detailedSuggest",
  "--detailed-suggest": "detailedSuggest",
  "--detailed-context": "detailedContext",
  "--dry-run": "dryRun",
  "-h": "help",
  "--help": "help",
  "-V": "version",
  "--version": "version",
};

const VALUED_FLAGS = {
  "--export": "exportPath",
  "-f": "files",
  "--file": "files",
};

// Flags that collect every occurrence into an array instead of keeping the last value.
const REPEATABLE = new Set(["files"]);

export function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {
    noRender: false,
    debugRender: false,
    detailedSuggest: false,
    detailedContext: false,
    dryRun: false,
    help: false,
    version: false,
    exportPath: null,
    files: [],
  };
  const positional = [];
  const errors = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (BOOLEAN_FLAGS[arg]) {
      flags[BOOLEAN_FLAGS[arg]] = true;
      continue;
    }

    // Valued flags: --export path, --export=path, -f path, --file=path
    const eqIndex = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flagName = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
    if (VALUED_FLAGS[flagName]) {
      let value;
      if (eqIndex !== -1) {
        value = arg.slice(eqIndex + 1);
      } else {
        value = args[i + 1];
        i += 1;
      }
      if (value === undefined || value === "") {
        errors.push(`Flag ${flagName} requires a value.`);
        continue;
      }
      const key = VALUED_FLAGS[flagName];
      if (REPEATABLE.has(key)) {
        flags[key].push(value);
      } else {
        flags[key] = value;
      }
      continue;
    }

    if (arg.startsWith("--")) {
      errors.push(`Unknown flag: ${arg}`);
      continue;
    }

    // Single-dash tokens that are not known flags are kept as prompt text so
    // things like `gac ask what does -v mean` keep working.
    positional.push(arg);
  }

  return { flags, positional, errors };
}

export function printHelp() {
  term(`gac ${getVersion()} - OpenAI-compatible & Ollama CLI\n\n`);
  term(`Commands:\n`);
  term(`  ask <prompt>      Answer a question (alias: -a <prompt>)\n`);
  term(`  suggest <prompt>  Suggest commands for a task\n`);
  term(`  explain <prompt>  Explain a topic with examples\n`);
  term(`  runbook <prompt>  Step-by-step commands with approval gates\n`);
  term(`  commit            Generate a commit message from staged changes\n`);
  term(`  chat              Interactive chat mode\n`);
  term(`  models            List models and set default\n`);
  term(`  config            View configuration\n`);
  term(`  config tui        Open interactive config editor\n`);
  term(`  config get <key>  Print one config value\n`);
  term(`  config set <key> <value>  Update one config value\n`);
  term(`\n`);
  term(`Flags:\n`);
  term(`  -f, --file <path>       Include a file as context (repeatable)\n`);
  term(`  -d, --detailed-suggest  More detailed, step-by-step suggestions\n`);
  term(`  --detailed-context      Include current directory listing as context\n`);
  term(`  --dry-run               Runbook/commit: show the plan, run nothing\n`);
  term(`  --export <path>         Runbook: write commands to a script instead of running\n`);
  term(`  --no-render             Disable markdown rendering\n`);
  term(`  --debug-render          Show both rendered and raw output\n`);
  term(`  -V, --version           Show version\n`);
  term(`  -h, --help              Show this help message\n`);
  term(`\n`);
  term(`Piped input is used as context (or as the prompt itself):\n`);
  term(`  cat error.log | gac explain "why is this failing?"\n`);
  term(`  git diff | gac ask "summarize these changes"\n`);
  term(`  echo "how do I list open ports" | gac\n`);
  term(`\n`);
  term(`Examples:\n`);
  term(`  gac suggest "How do I connect to ssh server on port 5322"\n`);
  term(`  gac explain -f src/app.js "what does this file do?"\n`);
  term(`  gac runbook --dry-run "Set up a new Node.js project with eslint"\n`);
  term(`  gac runbook --export setup.sh "Install docker"\n`);
  term(`  gac commit\n`);
  term(`\n`);
}
