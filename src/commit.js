import terminalKit from "terminal-kit";
import { execFile, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import process from "process";
import { promisify } from "util";
import { chatCompletion } from "./gpt4all.js";
import { buildSystemPrompt } from "./prompts.js";
import { fenceFor, truncateForContext } from "./input.js";
import { promptKeyAction } from "./tui.js";
import {
  resolveContextWindow,
  resolveMaxTokens,
  contextBudget,
} from "./contextwindow.js";
import { sizeBucket, countBucket } from "./telemetry/buckets.js";

const { terminal: term } = terminalKit;
const execFileAsync = promisify(execFile);

// Coarse count of staged files from `git diff --staged --stat` (the last line is
// the "N files changed" summary). Used only for a count bucket — never a name.
export function countStagedFiles(stat) {
  const lines = String(stat || "").trim().split("\n").filter(Boolean);
  return lines.length > 0 ? Math.max(0, lines.length - 1) : 0;
}

// Strip the wrappers small models like to add around the actual message:
// code fences, "Commit message:" labels, and surrounding quotes.
export function cleanCommitMessage(raw) {
  let text = String(raw || "").replace(/\r\n/g, "\n").trim();
  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fenced) {
    text = fenced[1].trim();
  }
  text = text.replace(/^(?:commit message|message|subject)\s*:\s*/i, "");
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1).trim();
  }
  // Collapse runs of blank lines so the body stays tidy.
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

async function git(args, options = {}) {
  const { stdout } = await execFileAsync("git", args, {
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  return stdout;
}

function buildCommitUserPrompt({ stat, diff, recentLog }, maxDiffChars) {
  const { text: truncatedDiff, truncated } = truncateForContext(diff, maxDiffChars);
  const fence = fenceFor(truncatedDiff);
  const parts = [];
  if (recentLog) {
    parts.push(`Recent commit subjects for style reference:\n${recentLog}`);
  }
  parts.push(`Staged changes summary:\n${stat.trim()}`);
  parts.push(
    `Staged diff${truncated ? " (truncated)" : ""}:\n${fence}\n${truncatedDiff}\n${fence}`
  );
  return parts.join("\n\n");
}

async function generateCommitMessage(config, promptText, contextWindow, telemetry, action = "commit_generate") {
  const messages = [
    { role: "system", content: buildSystemPrompt("commit", config) },
    { role: "user", content: promptText },
  ];
  const commitConfig = {
    ...config,
    stream: false,
    renderMarkdown: false,
    debugRender: false,
  };
  const reply = await chatCompletion(commitConfig, messages, {
    contextWindow,
    telemetry,
    telemetryAction: action,
  });
  return cleanCommitMessage(reply);
}

function printMessageBlock(message) {
  term("\nProposed commit message:\n");
  term.dim("┌" + "─".repeat(60) + "\n");
  for (const line of message.split("\n")) {
    term.dim("│ ");
    term(`${line}\n`);
  }
  term.dim("└" + "─".repeat(60) + "\n");
}

function promptCommitAction() {
  return promptKeyAction("[Enter] commit  [e] edit  [r] regenerate  [q] quit: ", {
    ENTER: "commit",
    e: "edit",
    E: "edit",
    r: "regenerate",
    R: "regenerate",
    q: "quit",
    Q: "quit",
    ESCAPE: "quit",
    CTRL_C: "quit",
  });
}

function editInEditor(message) {
  const editor =
    process.env.GIT_EDITOR ||
    process.env.VISUAL ||
    process.env.EDITOR ||
    (os.platform() === "win32" ? "notepad" : "vi");
  const tmpFile = path.join(
    os.tmpdir(),
    `gac-commit-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
  );
  fs.writeFileSync(tmpFile, message);
  try {
    // Editors need the real terminal; run synchronously with inherited stdio.
    // The command-string form (with a quoted path) lets $EDITOR carry its own
    // arguments ("code --wait") while surviving tmpdir paths with spaces.
    const result = spawnSync(`${editor} "${tmpFile}"`, {
      stdio: "inherit",
      shell: true,
    });
    if (result.error) {
      term.red(`Could not launch editor "${editor}": ${result.error.message}\n`);
      return message;
    }
    // The human's text is intentional — normalize whitespace only, never run
    // the model-output sanitizer over it.
    const edited = fs.readFileSync(tmpFile, "utf8").replace(/\r\n/g, "\n").trim();
    return edited || message;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch (err) {}
  }
}

async function commitWithMessage(message) {
  const tmpFile = path.join(
    os.tmpdir(),
    `gac-commit-msg-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
  );
  fs.writeFileSync(tmpFile, `${message}\n`);
  try {
    const stdout = await git(["commit", "-F", tmpFile]);
    term(stdout);
    return true;
  } catch (err) {
    term.red(`git commit failed: ${err.stderr || err.message}\n`);
    return false;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch (err) {}
  }
}

export async function runCommit(config, opts = {}) {
  const telemetry = opts.telemetry;
  try {
    await git(["rev-parse", "--is-inside-work-tree"]);
  } catch (err) {
    term("Not a git repository.\n");
    process.exitCode = 1;
    return { outcome: "failure", props: {} };
  }

  let diff;
  let stat;
  let recentLog;
  try {
    [diff, stat, recentLog] = await Promise.all([
      git(["diff", "--staged"]),
      git(["diff", "--staged", "--stat"]),
      // A brand-new repo has no history; style context is optional.
      git(["log", "--oneline", "--no-decorate", "-5"]).catch(() => ""),
    ]);
  } catch (err) {
    term.red(`Failed to read staged changes: ${err.message}\n`);
    process.exitCode = 1;
    return { outcome: "failure", props: {} };
  }
  recentLog = recentLog.trim();

  if (!diff.trim()) {
    term("No staged changes. Stage files with `git add` first.\n");
    return { outcome: "no_op", props: {} };
  }

  // Coarse, sanitized properties shared by every commit_action_completed event.
  // No diff, message, filename, branch, or repository identity ever leaves here.
  const commitProps = {
    dry_run: Boolean(opts.dryRun),
    staged_file_count_bucket: countBucket(countStagedFiles(stat)),
    diff_size_bucket: sizeBucket(diff.length),
    had_recent_history: Boolean(recentLog),
  };
  const trackCommit = (action, outcome, errorCategory = null) => {
    if (!telemetry) return;
    telemetry.track({
      event_name: "commit_action_completed",
      action,
      outcome,
      duration_ms: null,
      error_category: errorCategory,
      properties: commitProps,
    });
  };

  const contextWindow = await resolveContextWindow(config);
  const maxTokens = await resolveMaxTokens(config);
  // Reserve room for the system prompt, stat block, and response; the diff
  // gets whatever is left (~4 chars per token).
  const maxDiffChars = Math.max(
    4000,
    (contextBudget(contextWindow, maxTokens) - 1000) * 4
  );
  const promptText = buildCommitUserPrompt({ stat, diff, recentLog }, maxDiffChars);

  // Progress goes to stderr when stdout is piped so `gac commit > msg.txt`
  // captures only the message itself.
  if (process.stdout.isTTY) {
    term.dim("Generating commit message...\n");
  } else {
    process.stderr.write("Generating commit message...\n");
  }
  let message = await generateCommitMessage(config, promptText, contextWindow, telemetry);
  if (!message) {
    term("The model returned an empty commit message. Try again.\n");
    process.exitCode = 1;
    trackCommit("generate", "failure", "empty_response");
    return { outcome: "failure", props: {} };
  }
  trackCommit("generate", "success");

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive || opts.dryRun) {
    // Print-only mode: usable as `gac commit --dry-run` or in pipelines like
    // `git commit -eF <(gac commit)`.
    term(`${message}\n`);
    if (opts.dryRun && interactive) {
      term.dim("Dry run: nothing was committed.\n");
    }
    trackCommit("print", "success");
    return { outcome: "success", props: {} };
  }

  while (true) {
    printMessageBlock(message);
    const action = await promptCommitAction();
    if (action === "quit") {
      term("Canceled. Nothing was committed.\n");
      trackCommit("cancel", "cancelled");
      return { outcome: "cancelled", props: {} };
    }
    if (action === "edit") {
      message = editInEditor(message);
      trackCommit("edit", "success");
      continue;
    }
    if (action === "regenerate") {
      term.dim("Regenerating...\n");
      const regenerated = await generateCommitMessage(
        config,
        promptText,
        contextWindow,
        telemetry,
        "commit_regenerate"
      );
      if (regenerated) {
        message = regenerated;
        trackCommit("regenerate", "success");
      } else {
        term.dim("Regeneration returned nothing; keeping the current message.\n");
        trackCommit("regenerate", "no_op");
      }
      continue;
    }
    // commit
    const ok = await commitWithMessage(message);
    if (ok) {
      term("Committed.\n");
      trackCommit("commit", "success");
      return { outcome: "success", props: {} };
    }
    process.exitCode = 1;
    trackCommit("commit", "failure", "git");
    return { outcome: "failure", props: {} };
  }
}
