import terminalKit from "terminal-kit";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import process from "process";
import { chatCompletion } from "./gpt4all.js";
import { buildSystemPrompt } from "./prompts.js";
import { buildDirectoryContext } from "./sysinfo.js";
import { fenceFor, truncateForContext } from "./input.js";
import {
  resolveContextWindow,
  resolveMaxTokens,
  contextBudget,
} from "./contextwindow.js";
import {
  extractJsonPayload,
  extractCommandFix,
  loadBlockedCommands,
  findBlockedCommand,
} from "./runbook.js";
import { promptKeyAction, copyToClipboard, promptInput } from "./tui.js";
import { registerChild } from "./interrupt.js";
import { exitCodeClass } from "./telemetry/buckets.js";

const { terminal: term } = terminalKit;

// ─────────────────────────────────────────────────────────────────
// Shell-history parsing (used when no command is passed explicitly)
// ─────────────────────────────────────────────────────────────────

export function parseBashHistory(content) {
  return String(content || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// zsh extended history lines look like ": 1736784000:0;the command".
export function parseZshHistory(content) {
  return String(content || "")
    .split("\n")
    .map((line) => line.replace(/^:\s*\d+:\d+;/, "").trim())
    .filter(Boolean);
}

// fish history is YAML-ish: "- cmd: the command" followed by metadata lines.
export function parseFishHistory(content) {
  const commands = [];
  for (const line of String(content || "").split("\n")) {
    const match = line.match(/^-\s*cmd:\s*(.+)$/);
    if (match) commands.push(match[1].trim());
  }
  return commands;
}

// The most recent entry that isn't a gac invocation itself.
export function pickLastCommand(commands, skipPattern = /^\s*gac(\s|$)/) {
  for (let i = (commands || []).length - 1; i >= 0; i -= 1) {
    const command = commands[i];
    if (command && !skipPattern.test(command)) return command;
  }
  return null;
}

export function historyFileFor(shell, home) {
  const name = path.basename(String(shell || ""));
  if (name.includes("zsh")) {
    return { file: path.join(home, ".zsh_history"), parse: parseZshHistory };
  }
  if (name.includes("fish")) {
    return {
      file: path.join(home, ".local", "share", "fish", "fish_history"),
      parse: parseFishHistory,
    };
  }
  // bash and unknown shells: bash-style history.
  return { file: path.join(home, ".bash_history"), parse: parseBashHistory };
}

function readLastShellCommand() {
  try {
    const { file, parse } = historyFileFor(process.env.SHELL, os.homedir());
    const content = fs.readFileSync(file, "utf8");
    return pickLastCommand(parse(content));
  } catch (err) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Fix flow
// ─────────────────────────────────────────────────────────────────

async function requestFix(command, errorOutput, config, telemetry) {
  const contextWindow = await resolveContextWindow(config);
  const maxTokens = await resolveMaxTokens(config);
  const system = buildSystemPrompt("fix", config);
  const parts = [
    "This command failed:",
    "```",
    command,
    "```",
  ];
  if (errorOutput) {
    const budgetChars = Math.max(
      2000,
      Math.floor((contextBudget(contextWindow, maxTokens) * 4) / 2)
    );
    const { text } = truncateForContext(errorOutput, budgetChars);
    const fence = fenceFor(text);
    parts.push(`Error output:\n${fence}\n${text}\n${fence}`);
  }
  parts.push("Provide the corrected command.");

  const fixConfig = {
    ...config,
    stream: false,
    renderMarkdown: false,
    debugRender: false,
  };
  const reply = await chatCompletion(
    fixConfig,
    [
      { role: "system", content: system },
      { role: "system", content: `Relevant context:\n${buildDirectoryContext()}` },
      { role: "user", content: parts.join("\n") },
    ],
    { contextWindow, telemetry, telemetryAction: "fix_generate" }
  );
  return extractCommandFix(extractJsonPayload(reply));
}

function runFixedCommand(command) {
  // stdio: inherit streams output directly and lets interactive commands
  // (prompts, pagers) work; the shell resolves pipes/globs like a terminal.
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: "inherit" });
    // The child shares our terminal, so the tty already sends it SIGINT on
    // Ctrl+C — registering it means an interrupt that arrives any other way
    // (SIGTERM, a raw ^C read while a prompt held the terminal) kills it too.
    const unregister = registerChild(child);
    child.on("error", (err) => {
      unregister();
      term.red(`Failed to start command: ${err.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => {
      unregister();
      resolve(code ?? 1);
    });
  });
}

function promptFixAction(isBlocked) {
  const keys = {
    e: "edit",
    E: "edit",
    c: "copy",
    C: "copy",
    q: "quit",
    Q: "quit",
    ESCAPE: "quit",
  };
  if (isBlocked) {
    return promptKeyAction("[e] edit  [c] copy  [q] quit: ", keys);
  }
  return promptKeyAction("[Enter] run  [e] edit  [c] copy  [q] quit: ", {
    ENTER: "run",
    ...keys,
  });
}

async function editFixedCommand(current) {
  term("Edit command:\n> ");
  const input = await promptInput({ cancelable: true, default: String(current) });
  term("\n");
  if (input === undefined || input === null || !input.trim()) return current;
  return input.trim();
}

export async function runFix(promptArgs, config, opts = {}) {
  const telemetry = opts.telemetry;
  const explicit = (promptArgs || []).join(" ").trim();
  const command = explicit || readLastShellCommand();
  const source = explicit ? "explicit" : "shell_history";
  const pipedContext = Boolean(opts.piped);

  // Sanitized fix_action_completed telemetry. Never the command, error output,
  // generated fix, explanation, or edited command — only coarse categories.
  const trackFix = (action, outcome, extra = {}) => {
    if (!telemetry) return;
    const properties = { source, piped_error_context: pipedContext };
    if (extra.was_blocked !== undefined) properties.was_blocked = extra.was_blocked;
    if (extra.exit_code_class !== undefined) properties.exit_code_class = extra.exit_code_class;
    telemetry.track({
      event_name: "fix_action_completed",
      action,
      outcome,
      duration_ms: null,
      error_category: extra.error_category ?? null,
      properties,
    });
  };

  if (!command) {
    term(
      "Couldn't determine the last command from shell history. Pass it explicitly: gac fix <command>\n"
    );
    process.exitCode = 1;
    return { outcome: "failure", props: {} };
  }

  if (!explicit) {
    term.dim(`Fixing last command: ${command}\n`);
  }
  if (process.stdout.isTTY) {
    term.dim("Asking the model for a fix...\n");
  } else {
    process.stderr.write("Asking the model for a fix...\n");
  }

  const fix = await requestFix(command, opts.piped || "", config, telemetry);
  if (!fix) {
    term("No usable fix was returned. Try again with more context, e.g. pipe the error output:\n");
    term.dim("  mycommand 2>&1 | gac fix mycommand\n");
    process.exitCode = 1;
    trackFix("generate", "failure", { error_category: "empty_response" });
    return { outcome: "failure", props: {} };
  }
  trackFix("generate", "success");

  if (!opts.interactive) {
    // Piped/scripted use: the corrected command is the payload, the
    // explanation is commentary.
    if (fix.explanation) process.stderr.write(`${fix.explanation}\n`);
    term(`${fix.command}\n`);
    trackFix("print", "success");
    return { outcome: "success", props: {} };
  }

  if (fix.explanation) {
    term.dim(`${fix.explanation}\n`);
  }

  const blockedList = loadBlockedCommands();
  let current = fix.command;
  while (true) {
    term(`Fix: ${current}\n`);
    const blocked = findBlockedCommand(current, blockedList);
    if (blocked) {
      term.red(
        `Blocked: ${blocked.reason || "matches a guarded destructive pattern"}\n`
      );
    }
    const wasBlocked = Boolean(blocked);
    const action = await promptFixAction(wasBlocked);
    if (action === "quit") {
      term("Nothing was run.\n");
      trackFix("cancel", "cancelled", { was_blocked: wasBlocked });
      return { outcome: "cancelled", props: {} };
    }
    if (action === "copy") {
      copyToClipboard(current);
      term.dim("Copied to clipboard.\n");
      trackFix("copy", "success", { was_blocked: wasBlocked });
      continue;
    }
    if (action === "edit") {
      current = await editFixedCommand(current);
      trackFix("edit", "success", { was_blocked: wasBlocked });
      continue;
    }
    // run
    term(`\n$ ${current}\n`);
    const code = await runFixedCommand(current);
    if (code === 0) {
      term.dim("Command succeeded.\n");
      trackFix("run", "success", { was_blocked: wasBlocked, exit_code_class: exitCodeClass(code) });
      return { outcome: "success", props: {} };
    }
    term.red(`Command exited with code ${code}.\n`);
    process.exitCode = code;
    trackFix("run", "failure", {
      was_blocked: wasBlocked,
      exit_code_class: exitCodeClass(code),
      error_category: "shell",
    });
    return { outcome: "failure", props: {} };
  }
}
