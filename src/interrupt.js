// Central Ctrl+C / termination handling.
//
// Ctrl+C reaches a terminal program by two completely different routes, and
// gac needs both:
//
//   1. Cooked mode — the tty turns ^C into SIGINT. Handled by the signal
//      handlers below.
//   2. Raw mode — while terminal-kit is grabbing input (`inputField`,
//      `singleColumnMenu`, `promptKeyAction`), the tty stops generating
//      SIGINT and delivers the raw 0x03 byte instead. terminal-kit turns it
//      into a `key` event named CTRL_C, so a permanent listener on the
//      terminal is the only thing that can see it.
//
// Whichever route fires, the shutdown is the same and unconditional: abort
// in-flight requests, kill every child process gac started, put the terminal
// back the way we found it, and exit 130. Nothing gets a veto — a hung
// request or a wedged cleanup callback cannot stop the exit, because a
// watchdog timer exits regardless, and a second Ctrl+C exits immediately.

import terminalKit from "terminal-kit";
import process from "process";

const { terminal: term } = terminalKit;

// Standard shell convention for "killed by SIGINT" (128 + SIGINT).
export const INTERRUPT_EXIT_CODE = 130;

// How long a child gets to die from SIGTERM before it is SIGKILLed, and the
// hard deadline after which the process exits no matter what.
const KILL_GRACE_MS = 200;
const SHUTDOWN_DEADLINE_MS = 1500;

const children = new Set();
const aborters = new Set();
const cleanups = new Set();

let interrupted = false;
let shuttingDown = false;
let installed = false;
let masterAbort = null;

// Aborted as soon as an interrupt arrives. Long-running work can attach this
// to a fetch, or poll `isInterrupted()` between steps.
export function interruptSignal() {
  if (!masterAbort) masterAbort = new AbortController();
  return masterAbort.signal;
}

// True once Ctrl+C (or SIGTERM/SIGHUP) has been seen. Loops that would
// otherwise keep scheduling work — retry backoffs, runbook steps — check this
// so nothing new starts while the process is on its way out.
export function isInterrupted() {
  return interrupted;
}

// Track a child process so an interrupt can kill it. `group: true` means the
// child was spawned detached (its own process group) and the whole group
// should be signalled, which is how a runbook's shell takes its grandchildren
// down with it. Returns an unregister function.
export function registerChild(child, { group = false } = {}) {
  if (!child || typeof child.kill !== "function") return () => {};
  const entry = { child, group };
  children.add(entry);
  const done = () => children.delete(entry);
  child.once("exit", done);
  child.once("error", done);
  return done;
}

// Track an AbortController (an in-flight HTTP request) so an interrupt can
// cancel it instead of waiting out its timeout. Returns an unregister
// function; callers must call it in a `finally` so completed requests do not
// pile up.
export function registerAbort(controller) {
  if (!controller || typeof controller.abort !== "function") return () => {};
  aborters.add(controller);
  return () => aborters.delete(controller);
}

// Register a synchronous, best-effort cleanup to run on interrupt (closing a
// shell session, restoring a screen). Must not throw and must not block.
export function onInterrupt(fn) {
  if (typeof fn !== "function") return () => {};
  cleanups.add(fn);
  return () => cleanups.delete(fn);
}

function signalChild(entry, signal) {
  const { child, group } = entry;
  const pid = child.pid;
  try {
    // Signalling the negated pid hits the whole process group, so a command
    // the shell itself launched dies too. Not a thing on Windows, and it
    // fails if the child was not spawned detached — fall through either way.
    if (group && pid && process.platform !== "win32") {
      process.kill(-pid, signal);
      return;
    }
  } catch (err) {
    // ESRCH (already gone) or EPERM — fall back to the direct kill below.
  }
  try {
    child.kill(signal);
  } catch (err) {
    // Already dead; nothing to do.
  }
}

// Signal every tracked child. Returns how many were still alive.
export function killAllChildren(signal = "SIGTERM") {
  let count = 0;
  for (const entry of [...children]) {
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
      children.delete(entry);
      continue;
    }
    signalChild(entry, signal);
    count += 1;
  }
  return count;
}

function abortAll() {
  if (masterAbort) {
    try {
      masterAbort.abort();
    } catch (err) {}
  }
  for (const controller of [...aborters]) {
    try {
      controller.abort();
    } catch (err) {}
    aborters.delete(controller);
  }
}

function runCleanups() {
  for (const fn of [...cleanups]) {
    cleanups.delete(fn);
    try {
      fn();
    } catch (err) {
      // A cleanup must never hold up the exit.
    }
  }
}

// Undo everything that makes the terminal unusable for the next shell prompt:
// raw mode, the mouse-reporting escape sequences, a hidden cursor, a
// half-applied style. Safe to call more than once and safe when there is no
// tty at all.
export function releaseTerminal() {
  try {
    term.grabInput(false);
  } catch (err) {}
  try {
    term.hideCursor(false);
    term.styleReset();
  } catch (err) {}
  // grabInput() covers this for a normal tty, but stdin can be left raw by a
  // child that died mid-prompt, and a raw resumed stdin is exactly what keeps
  // the event loop alive forever.
  try {
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
  } catch (err) {}
  try {
    process.stdin.pause();
  } catch (err) {}
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function performShutdown(exitCode, message) {
  // A second Ctrl+C while the first is still winding down means "now".
  if (shuttingDown) {
    releaseTerminal();
    process.exit(exitCode);
  }
  shuttingDown = true;
  interrupted = true;

  // Nothing below is allowed to outlive this. If a kill or a cleanup wedges,
  // the process still goes away.
  const deadline = setTimeout(() => {
    releaseTerminal();
    process.exit(exitCode);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref?.();

  abortAll();
  runCleanups();
  const alive = killAllChildren("SIGTERM");
  releaseTerminal();

  if (message) {
    try {
      process.stderr.write(message);
    } catch (err) {}
  }

  // Anything that ignored SIGTERM does not get to become an orphan.
  if (alive) {
    await delay(KILL_GRACE_MS);
    killAllChildren("SIGKILL");
  }

  clearTimeout(deadline);
  process.exit(exitCode);
}

// The single entry point for "stop everything now". Exported so commands can
// trigger the same teardown as Ctrl+C.
export function requestInterrupt(reason = "SIGINT") {
  interrupted = true;
  const message = reason === "SIGINT" ? "\nInterrupted.\n" : `\nTerminated (${reason}).\n`;
  performShutdown(INTERRUPT_EXIT_CODE, message).catch(() => {
    releaseTerminal();
    process.exit(INTERRUPT_EXIT_CODE);
  });
}

// Wire up both Ctrl+C routes plus SIGTERM/SIGHUP. Idempotent, so tests and
// repeated CLI runs in one process are safe.
export function installInterruptHandlers() {
  if (installed) return;
  installed = true;

  process.on("SIGINT", () => requestInterrupt("SIGINT"));
  process.on("SIGTERM", () => requestInterrupt("SIGTERM"));
  // Windows has no SIGHUP; guard so listening for it is never fatal.
  try {
    process.on("SIGHUP", () => requestInterrupt("SIGHUP"));
  } catch (err) {}

  // The raw-mode route. This listener is never removed, so it survives every
  // prompt that adds and drops its own `key` handler.
  term.on("key", (name) => {
    if (name === "CTRL_C") requestInterrupt("SIGINT");
  });
  // Prompts add their own short-lived `key` listeners on top of this permanent
  // one, which is enough to trip the default warning threshold.
  try {
    term.setMaxListeners?.(Infinity);
  } catch (err) {}

  // Last line of defense: whatever the exit reason, hand the terminal back.
  process.on("exit", () => releaseTerminal());
}

// Test seam: drop all registrations and interrupt state. Deliberately leaves
// the installed process/terminal handlers in place — re-registering them would
// stack duplicate listeners on the singletons they attach to.
export function resetInterruptState() {
  children.clear();
  aborters.clear();
  cleanups.clear();
  interrupted = false;
  shuttingDown = false;
  masterAbort = null;
}
