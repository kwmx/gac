import process from "process";

// Kept in sync with flags.js and the runCli dispatch. Descriptions are used
// by the zsh and fish scripts.
const COMMANDS = [
  ["ask", "Answer a question"],
  ["suggest", "Suggest commands for a task"],
  ["explain", "Explain a topic with examples"],
  ["runbook", "Step-by-step commands with approval gates"],
  ["commit", "Generate a commit message from staged changes"],
  ["fix", "Fix the last failed shell command"],
  ["chat", "Interactive chat mode"],
  ["models", "List models and set default"],
  ["config", "View or edit configuration"],
  ["auth", "Sign in/out of ChatGPT (Codex provider)"],
  ["completions", "Print a shell completion script"],
];

const FLAGS = [
  { short: "-f", long: "--file", desc: "Include a file as context", takesFile: true },
  { short: "-d", long: "--detailed-suggest", desc: "More detailed suggestions" },
  { long: "--detailed-context", desc: "Include current directory context" },
  { long: "--dry-run", desc: "Show the plan, run nothing" },
  { long: "--export", desc: "Write runbook commands to a script", takesFile: true },
  { long: "--no-render", desc: "Disable markdown rendering" },
  { long: "--debug-render", desc: "Show rendered and raw output" },
  { short: "-V", long: "--version", desc: "Show version" },
  { short: "-h", long: "--help", desc: "Show help" },
];

const CONFIG_SUBCOMMANDS = ["get", "set", "tui"];
const AUTH_SUBCOMMANDS = ["login", "logout", "status"];
const SHELLS = ["bash", "zsh", "fish"];

function allFlagTokens() {
  return FLAGS.flatMap((flag) => [flag.short, flag.long].filter(Boolean));
}

function fileFlagTokens() {
  return FLAGS.filter((flag) => flag.takesFile).flatMap((flag) =>
    [flag.short, flag.long].filter(Boolean)
  );
}

export function buildBashCompletion() {
  const commands = COMMANDS.map(([name]) => name).join(" ");
  const flags = allFlagTokens().join(" ");
  const fileFlags = fileFlagTokens()
    .map((token) => `"$prev" = "${token}"`)
    .join(" ] || [ ");
  return [
    "# bash completion for gac",
    "# Install: gac completions bash > ~/.local/share/bash-completion/completions/gac",
    '#      or: eval "$(gac completions bash)" in ~/.bashrc',
    "_gac_completions() {",
    "  local cur prev",
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    `  local commands="${commands}"`,
    `  local flags="${flags}"`,
    `  if [ ${fileFlags} ]; then`,
    '    COMPREPLY=($(compgen -f -- "$cur")); return',
    "  fi",
    '  if [ "$prev" = "config" ]; then',
    `    COMPREPLY=($(compgen -W "${CONFIG_SUBCOMMANDS.join(" ")}" -- "$cur")); return`,
    "  fi",
    '  if [ "$prev" = "auth" ]; then',
    `    COMPREPLY=($(compgen -W "${AUTH_SUBCOMMANDS.join(" ")}" -- "$cur")); return`,
    "  fi",
    '  if [ "$prev" = "completions" ]; then',
    `    COMPREPLY=($(compgen -W "${SHELLS.join(" ")}" -- "$cur")); return`,
    "  fi",
    '  if [ "$COMP_CWORD" -eq 1 ]; then',
    '    COMPREPLY=($(compgen -W "$commands $flags" -- "$cur")); return',
    "  fi",
    '  case "$cur" in',
    '    -*) COMPREPLY=($(compgen -W "$flags" -- "$cur")) ;;',
    "  esac",
    "}",
    "complete -F _gac_completions gac",
    "",
  ].join("\n");
}

export function buildZshCompletion() {
  const commandSpecs = COMMANDS.map(([name, desc]) => `    '${name}:${desc}'`).join("\n");
  const flagSpecs = FLAGS.map((flag) => {
    const fileSpec = flag.takesFile ? ":file:_files" : "";
    if (flag.short) {
      return `    '(${flag.short} ${flag.long})'{${flag.short},${flag.long}}'[${flag.desc}]${fileSpec}' \\`;
    }
    return `    '${flag.long}[${flag.desc}]${fileSpec}' \\`;
  }).join("\n");
  return [
    "#compdef gac",
    "# zsh completion for gac",
    "# Install: gac completions zsh > ~/.zfunc/_gac  (with fpath+=(~/.zfunc) before compinit)",
    "_gac() {",
    "  local -a _gac_commands",
    "  _gac_commands=(",
    commandSpecs,
    "  )",
    "  _arguments -C \\",
    flagSpecs,
    "    '1:command:->cmds' \\",
    "    '*::arg:->args'",
    "  case $state in",
    "    cmds) _describe 'command' _gac_commands ;;",
    "    args)",
    "      case $words[1] in",
    `        config) _values 'config' ${CONFIG_SUBCOMMANDS.join(" ")} ;;`,
    `        auth) _values 'auth' ${AUTH_SUBCOMMANDS.join(" ")} ;;`,
    `        completions) _values 'shell' ${SHELLS.join(" ")} ;;`,
    "      esac ;;",
    "  esac",
    "}",
    '_gac "$@"',
    "",
  ].join("\n");
}

export function buildFishCompletion() {
  const lines = [
    "# fish completion for gac",
    "# Install: gac completions fish > ~/.config/fish/completions/gac.fish",
    "complete -c gac -f",
  ];
  for (const [name, desc] of COMMANDS) {
    lines.push(`complete -c gac -n "__fish_use_subcommand" -a "${name}" -d "${desc}"`);
  }
  for (const sub of CONFIG_SUBCOMMANDS) {
    lines.push(`complete -c gac -n "__fish_seen_subcommand_from config" -a "${sub}"`);
  }
  for (const sub of AUTH_SUBCOMMANDS) {
    lines.push(`complete -c gac -n "__fish_seen_subcommand_from auth" -a "${sub}"`);
  }
  for (const shell of SHELLS) {
    lines.push(`complete -c gac -n "__fish_seen_subcommand_from completions" -a "${shell}"`);
  }
  for (const flag of FLAGS) {
    const parts = ["complete -c gac"];
    if (flag.short) parts.push(`-s ${flag.short.replace(/^-/, "")}`);
    parts.push(`-l ${flag.long.replace(/^--/, "")}`);
    parts.push(`-d "${flag.desc}"`);
    if (flag.takesFile) parts.push("-r -F");
    lines.push(parts.join(" "));
  }
  lines.push("");
  return lines.join("\n");
}

export function runCompletions(shell) {
  const normalized = String(shell || "").trim().toLowerCase();
  if (normalized === "bash") {
    process.stdout.write(buildBashCompletion());
    return true;
  }
  if (normalized === "zsh") {
    process.stdout.write(buildZshCompletion());
    return true;
  }
  if (normalized === "fish") {
    process.stdout.write(buildFishCompletion());
    return true;
  }
  process.stderr.write(
    `Unknown shell "${shell || ""}". Usage: gac completions <bash|zsh|fish>\n`
  );
  process.exitCode = 1;
  return false;
}
