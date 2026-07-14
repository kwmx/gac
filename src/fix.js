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
import { promptKeyAction, copyToClipboard } from "./tui.js";

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

async function requestFix(command, errorOutput, config) {
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
    { contextWindow }
  );
  return extractCommandFix(extractJsonPayload(reply));
}

function runFixedCommand(command) {
  // stdio: inherit streams output directly and lets interactive commands
  // (prompts, pagers) work; the shell resolves pipes/globs like a terminal.
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: "inherit" });
    child.on("error", (err) => {
      term.red(`Failed to start command: ${err.message}\n`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
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
    CTRL_C: "quit",
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
  return new Promise((resolve) => {
    term.inputField({ cancelable: true, default: String(current) }, (error, input) => {
      term("\n");
      if (error || input === undefined || input === null || !input.trim()) {
        resolve(current);
        return;
      }
      resolve(input.trim());
    });
  });
}

export async function runFix(promptArgs, config, opts = {}) {
  const explicit = (promptArgs || []).join(" ").trim();
  const command = explicit || readLastShellCommand();
  if (!command) {
    term(
      "Couldn't determine the last command from shell history. Pass it explicitly: gac fix <command>\n"
    );
    process.exitCode = 1;
    return;
  }

  if (!explicit) {
    term.dim(`Fixing last command: ${command}\n`);
  }
  if (process.stdout.isTTY) {
    term.dim("Asking the model for a fix...\n");
  } else {
    process.stderr.write("Asking the model for a fix...\n");
  }

  const fix = await requestFix(command, opts.piped || "", config);
  if (!fix) {
    term("No usable fix was returned. Try again with more context, e.g. pipe the error output:\n");
    term.dim("  mycommand 2>&1 | gac fix mycommand\n");
    process.exitCode = 1;
    return;
  }

  if (!opts.interactive) {
    // Piped/scripted use: the corrected command is the payload, the
    // explanation is commentary.
    if (fix.explanation) process.stderr.write(`${fix.explanation}\n`);
    term(`${fix.command}\n`);
    return;
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
    const action = await promptFixAction(Boolean(blocked));
    if (action === "quit") {
      term("Nothing was run.\n");
      return;
    }
    if (action === "copy") {
      copyToClipboard(current);
      term.dim("Copied to clipboard.\n");
      continue;
    }
    if (action === "edit") {
      current = await editFixedCommand(current);
      continue;
    }
    // run
    term(`\n$ ${current}\n`);
    const code = await runFixedCommand(current);
    if (code === 0) {
      term.dim("Command succeeded.\n");
    } else {
      term.red(`Command exited with code ${code}.\n`);
      process.exitCode = code;
    }
    return;
  }
}
