import os from "os";
import { getOsGuidance } from "./sysinfo.js";

export function normalizeDefaultAction(action) {
  const normalized = String(action || "").trim().toLowerCase();
  if (normalized === "ask" || normalized === "suggest" || normalized === "explain") {
    return normalized;
  }
  return "suggest";
}

// When files are attached with `-f` but no text prompt is given, synthesize a
// sensible default prompt from the file(s) so the command still runs instead of
// failing with "missing prompt". Returns "" when there are no files, so callers
// can fall through to their normal missing-prompt handling.
export function defaultPromptForFiles(mode, files) {
  const list = files || [];
  if (!list.length) return "";
  const names = list.map((f) => f.path);
  const many = names.length > 1;
  const label = many
    ? `these files (${names.join(", ")})`
    : `\`${names[0]}\``;
  const normalized = normalizeDefaultAction(mode);
  if (normalized === "explain") {
    return many
      ? `Explain what ${label} do and how they work.`
      : `Explain what ${label} does and how it works.`;
  }
  if (normalized === "suggest") {
    return `Review ${label} and suggest improvements.`;
  }
  // ask (and any fallback)
  return many ? `What do ${label} do?` : `What does ${label} do?`;
}

export function buildSystemPrompt(mode, config) {
  const osGuidance = getOsGuidance();

  if (mode === "suggest") {
    if (config.detailedSuggest === true) {
      return `You are an expert technical assistant. ${osGuidance} When providing suggestions, give detailed, step-by-step instructions that the user can follow to achieve their goals. For each step, include the relevant command, code snippet, or configuration change and briefly explain what it does. Place all commands and code on their own line for easy copying.`;
    } else {
      return `You are an expert technical assistant. ${osGuidance} Provide concise and practical suggestions to help the user accomplish their tasks efficiently. Focus on clarity and brevity, ensuring that your suggestions are easy to understand and implement. Tailor your suggestions to be relevant to the user's operating system and environment. Avoid lengthy explanations or unnecessary details. Prefer single-line commands or code snippets; if you must include explanations, keep them brief and place commands and code on their own line for easy copying.`;
    }
  }
  if (mode === "ask") {
    return `You are a helpful and knowledgeable assistant. ${osGuidance} Answer the user's question accurately and concisely. Place any commands or code on their own line for easy copying.`;
  }
  if (mode === "explain") {
    return `You are an expert technical assistant. ${osGuidance} Explain the topic clearly, step-by-step. Include a short, practical example that illustrates the concept. Place all commands and code on their own line for easy copying.`;
  }
  if (mode === "chat") {
    return `You are a helpful assistant. ${osGuidance} Engage in natural conversation, answer questions accurately, and assist with technical and general topics. Place any commands or code on their own line for easy copying.`;
  }
  if (mode === "runbook") {
    const shellGuidance =
      os.platform() === "win32"
        ? "Commands run on Windows in a persistent PowerShell session; use PowerShell-compatible commands (no bash-only syntax)."
        : "Commands run in a persistent POSIX shell.";
    return `You are an expert terminal assistant. ${osGuidance} ${shellGuidance} Respond with JSON only — no markdown, no extra text — in this exact shape:
{
  "commands": [
    { "description": "short description", "command": "shell command" }
  ],
  "notes": ["optional manual steps or caveats"]
}
Rules:
- Include only safe, non-destructive commands.
- Never include commands that delete, format, or irreversibly modify files or the filesystem.
- Prefer idempotent commands that can be run more than once without causing harm.
- Each command must be runnable as-is with no placeholders or manual substitution required.`;
  }
  if (mode === "fix") {
    const shellGuidance =
      os.platform() === "win32"
        ? "Commands run on Windows; use Windows-compatible commands."
        : "Commands run in a POSIX shell.";
    return `You are an expert terminal assistant. ${osGuidance} ${shellGuidance} The user gives you a shell command that failed, along with its error output when available. Respond with JSON only — no markdown, no extra text — in this exact shape:
{ "command": "the corrected command", "explanation": "one short sentence explaining what was wrong" }
Rules:
- The corrected command must be safe and non-destructive.
- It must be runnable as-is with no placeholders or manual substitution.
- If the original approach cannot work, return a different command that achieves the same goal.`;
  }
  if (mode === "commit") {
    return `You write git commit messages. Given a staged diff, respond with ONLY the commit message text — no markdown fences, no commentary, no surrounding quotes.
Format:
- Subject line: imperative mood, at most 72 characters, no trailing period. Use a conventional commit prefix (feat:, fix:, docs:, refactor:, test:, chore:) when it fits the change.
- Optionally, after one blank line, a short body (wrapped at 72 characters) explaining what changed and why.
Describe only what the diff actually changes.`;
  }
  return null;
}
