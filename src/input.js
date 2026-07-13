import fs from "fs";
import path from "path";
import process from "process";

// Hard ceiling on how much piped data we keep in memory. Anything beyond this
// is dropped before the context-window truncation even runs.
const MAX_STDIN_CHARS = 8_000_000;

export async function readPipedStdin() {
  if (process.stdin.isTTY) return null;
  let data = "";
  process.stdin.setEncoding("utf8");
  try {
    for await (const chunk of process.stdin) {
      data += chunk;
      if (data.length >= MAX_STDIN_CHARS) break;
    }
  } catch (err) {
    // A broken pipe mid-read still leaves us with usable input.
  }
  const text = data.replace(/\r\n/g, "\n");
  return text.trim() ? text : null;
}

// Keep the head and tail of oversized input; the middle is the least useful
// part of logs and diffs.
export function truncateForContext(text, maxChars) {
  const value = String(text ?? "");
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  const marker = (dropped) => `\n[... ${dropped} characters truncated ...]\n`;
  const headLength = Math.floor(maxChars * 0.66);
  const tailLength = Math.max(0, maxChars - headLength);
  const dropped = value.length - headLength - tailLength;
  const head = value.slice(0, headLength);
  const tail = tailLength > 0 ? value.slice(-tailLength) : "";
  return { text: `${head}${marker(dropped)}${tail}`, truncated: true };
}

// A fence longer than any backtick run in the content, so embedded ``` blocks
// cannot break out of the wrapper.
export function fenceFor(content) {
  const runs = String(content).match(/`+/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

export function attachInputToPrompt(prompt, pipedText) {
  const cleanPrompt = String(prompt || "").trim();
  const piped = String(pipedText || "").trim();
  if (!piped) return cleanPrompt;
  if (!cleanPrompt) return piped;
  const fence = fenceFor(piped);
  return `${cleanPrompt}\n\nInput:\n${fence}\n${piped}\n${fence}`;
}

// Only this much of an oversized file is ever read into memory; truncation
// would discard the middle anyway.
const MAX_FILE_READ_BYTES = 8_000_000;

function readFileHeadTail(resolved, size) {
  const headBytes = Math.floor(MAX_FILE_READ_BYTES * 0.75);
  const tailBytes = MAX_FILE_READ_BYTES - headBytes;
  const fd = fs.openSync(resolved, "r");
  try {
    const head = Buffer.alloc(headBytes);
    fs.readSync(fd, head, 0, headBytes, 0);
    const tail = Buffer.alloc(tailBytes);
    fs.readSync(fd, tail, 0, tailBytes, size - tailBytes);
    const dropped = size - headBytes - tailBytes;
    return `${head.toString("utf8")}\n[... ${dropped} bytes truncated ...]\n${tail.toString("utf8")}`;
  } finally {
    fs.closeSync(fd);
  }
}

// Read -f/--file paths. Missing/unreadable files come back as errors so the
// CLI can refuse to silently send a prompt missing half its context.
export function readFileContexts(paths) {
  const files = [];
  const errors = [];
  for (const filePath of paths || []) {
    const resolved = path.resolve(process.cwd(), filePath);
    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        errors.push(`--file ${filePath}: is a directory`);
        continue;
      }
      const content =
        stat.size > MAX_FILE_READ_BYTES
          ? readFileHeadTail(resolved, stat.size)
          : fs.readFileSync(resolved, "utf8");
      files.push({ path: filePath, content });
    } catch (err) {
      errors.push(`--file ${filePath}: ${err.message}`);
    }
  }
  return { files, errors };
}

export function formatFileContexts(files, maxCharsEach) {
  return (files || [])
    .map(({ path: filePath, content }) => {
      const { text, truncated } = truncateForContext(content, maxCharsEach);
      const fence = fenceFor(text);
      const suffix = truncated ? " (truncated)" : "";
      return `File: ${filePath}${suffix}\n${fence}\n${text}\n${fence}`;
    })
    .join("\n\n");
}
