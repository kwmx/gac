import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const srcDir = path.join(root, "src");

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

const offenders = [];

for (const file of walk(srcDir)) {
  const rel = path.relative(root, file);
  const source = fs.readFileSync(file, "utf8");
  const usesInputField = source.includes(".inputField(");
  const usesMenu = source.includes(".singleColumnMenu(");
  if (!usesInputField && !usesMenu) continue;

  const isSharedTuiModule = rel === path.join("src", "tui.js");
  const usesSharedCancelableInput =
    source.includes("promptInputLine") ||
    source.includes("promptYesNo") ||
    source.includes("withCancelableKeyBindings");
  const hasHardCtrlCHandler =
    source.includes("forceExitFromCtrlC") ||
    source.includes("installCtrlCExit") ||
    (source.includes('name === "CTRL_C"') &&
      (source.includes(".processExit(") || source.includes("process.exitCode = 130")));

  if (usesInputField && !isSharedTuiModule) {
    offenders.push(`${rel}: raw inputField outside shared TUI helpers`);
  }
  if (usesInputField && isSharedTuiModule && (!usesSharedCancelableInput || !hasHardCtrlCHandler)) {
    offenders.push(`${rel}: inputField without shared cancel helper or hard Ctrl+C handler`);
  }
  if (usesMenu && !hasHardCtrlCHandler) {
    offenders.push(`${rel}: menu without hard Ctrl+C handler`);
  }
}

assert.deepEqual(offenders, []);
console.log("ctrl-c coverage verification passed");
