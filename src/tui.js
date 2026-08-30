import terminalKit from "terminal-kit";
import process from "process";

const { terminal: term } = terminalKit;
let ctrlCExitInProgress = false;

export function withCancelableKeyBindings(options = {}) {
  return {
    ...options,
    cancelable: true,
    keyBindings: {
      ...(options.keyBindings || {}),
      ESCAPE: "cancel",
      CTRL_C: "cancel",
    },
  };
}

export function isCanceledInput(error, input) {
  return Boolean(error) || input === undefined || input === null;
}

export function forceExitFromCtrlC(message = "Canceled.", code = 130) {
  if (ctrlCExitInProgress) return;
  ctrlCExitInProgress = true;
  term.grabInput(false);
  term("\n");
  if (message) term(`${message}\n`);
  term.processExit(code);
}

export function installCtrlCExit(message = "Canceled.", code = 130) {
  const onKey = (name) => {
    if (name === "CTRL_C") {
      forceExitFromCtrlC(message, code);
    }
  };
  term.on("key", onKey);
  return () => term.removeListener("key", onKey);
}

export function promptInputLine(label, options = {}, promptOptions = {}) {
  const { cancelValue = "", trim = true } = promptOptions;
  return new Promise((resolve) => {
    const removeCtrlCExit = installCtrlCExit();
    term(label);
    term.inputField(withCancelableKeyBindings(options), (error, input) => {
      removeCtrlCExit();
      if (ctrlCExitInProgress) return;
      term.grabInput(false);
      term("\n");
      if (isCanceledInput(error, input)) {
        resolve(cancelValue);
        return;
      }
      const value = String(input);
      resolve(trim ? value.trim() : value);
    });
  });
}

// A yes/No prompt (default No). Returns null when the user cancels with Esc or
// Ctrl+C, so callers can distinguish cancellation from an intentional No.
export function promptYesNo(label) {
  return new Promise((resolve) => {
    const removeCtrlCExit = installCtrlCExit();
    term(label);
    term.inputField(withCancelableKeyBindings(), (error, input) => {
      removeCtrlCExit();
      if (ctrlCExitInProgress) return;
      term.grabInput(false);
      term("\n");
      if (isCanceledInput(error, input)) {
        resolve(null);
        return;
      }
      const value = String(input || "").trim().toLowerCase();
      resolve(value === "y" || value === "yes");
    });
  });
}

// Shared single-keystroke action prompt used by runbook steps, commit, and
// fix. keyMap maps terminal-kit key names to action strings; unmapped keys
// are ignored so a stray keystroke can't trigger anything.
export function promptKeyAction(label, keyMap) {
  term.dim(label);
  return new Promise((resolve) => {
    term.grabInput({ mouse: "button" });
    const finish = (action) => {
      if (ctrlCExitInProgress) return;
      term.grabInput(false);
      term.removeListener("key", onKey);
      term("\n");
      resolve(action);
    };
    const onKey = (name) => {
      if (name === "CTRL_C") {
        forceExitFromCtrlC();
        return;
      }
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
