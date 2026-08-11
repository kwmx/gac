import terminalKit from "terminal-kit";
import process from "process";

const { terminal: term } = terminalKit;

// Restore whatever input-grabbing state was in effect before a prompt. Leaving
// stdin grabbed means raw mode stays on and stdin stays resumed, which both
// keeps the event loop alive forever and stops the tty from turning Ctrl+C
// into SIGINT — the two halves of a terminal that looks hung.
function restoreGrab(wasGrabbing) {
  if (wasGrabbing) return;
  releaseTerminalInput();
}

// Give stdin back: leave raw mode and stop the flow of input events.
export function releaseTerminalInput() {
  try {
    term.grabInput(false);
  } catch (err) {
    // Not a tty; nothing was grabbed in the first place.
  }
}

// Shared single-keystroke action prompt used by runbook steps, commit, and
// fix. keyMap maps terminal-kit key names to action strings; unmapped keys
// are ignored so a stray keystroke can't trigger anything.
export function promptKeyAction(label, keyMap) {
  const wasGrabbing = Boolean(term.grabbing);
  term.dim(label);
  return new Promise((resolve) => {
    term.grabInput({ mouse: "button" });
    const finish = (action) => {
      term.removeListener("key", onKey);
      restoreGrab(wasGrabbing);
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

// terminal-kit's inputField() grabs stdin when nothing else has, but never
// releases it — the grab outlives the prompt and wedges the process. Every
// call site goes through this wrapper instead, so the grab is always undone
// (and a caller that was already grabbing, like the chat loop, keeps its own).
//
// Resolves with the entered string, or undefined when the field was canceled
// or errored.
export function promptInput(options = {}) {
  const wasGrabbing = Boolean(term.grabbing);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      restoreGrab(wasGrabbing);
      resolve(value);
    };
    try {
      term.inputField(options, (error, input) => {
        finish(error ? undefined : input);
      });
    } catch (err) {
      finish(undefined);
    }
  });
}

// Same treatment for singleColumnMenu, which grabs input the same way and
// leaks it the same way. Resolves with the selected index, or null when the
// menu was canceled.
export function promptMenu(items, options = {}) {
  const wasGrabbing = Boolean(term.grabbing);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      restoreGrab(wasGrabbing);
      resolve(value);
    };
    try {
      term.singleColumnMenu(items, options, (error, response) => {
        finish(error || !response || response.canceled ? null : response.selectedIndex);
      });
    } catch (err) {
      finish(null);
    }
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
