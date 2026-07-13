import terminalKit from "terminal-kit";
import process from "process";

const { terminal: term } = terminalKit;

// Shared single-keystroke action prompt used by runbook steps, commit, and
// fix. keyMap maps terminal-kit key names to action strings; unmapped keys
// are ignored so a stray keystroke can't trigger anything.
export function promptKeyAction(label, keyMap) {
  term.dim(label);
  return new Promise((resolve) => {
    term.grabInput({ mouse: "button" });
    const finish = (action) => {
      term.grabInput(false);
      term.removeListener("key", onKey);
      term("\n");
      resolve(action);
    };
    const onKey = (name) => {
      const action = keyMap[name];
      if (action) finish(action);
    };
    term.on("key", onKey);
  });
}

// Copy text to the system clipboard via the OSC 52 escape sequence. Works in
// most modern terminals, including over SSH, with no external dependencies.
// Terminals without OSC 52 support simply ignore it.
export function copyToClipboard(text) {
  const b64 = Buffer.from(String(text), "utf8").toString("base64");
  process.stdout.write(`\x1b]52;c;${b64}\x07`);
}

// Last fenced code block in a message, or null when there is none.
export function extractLastCodeBlock(text) {
  const blocks = [...String(text ?? "").matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(
    (match) => match[1]
  );
  if (!blocks.length) return null;
  return blocks[blocks.length - 1].replace(/\n$/, "");
}
