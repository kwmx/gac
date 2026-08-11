#!/usr/bin/env node
import terminalKit from "terminal-kit";
import { runCli } from "../src/cli.js";
import {
  installInterruptHandlers,
  isInterrupted,
  releaseTerminal,
  INTERRUPT_EXIT_CODE,
} from "../src/interrupt.js";

const { terminal: term } = terminalKit;

// Ctrl+C must work from the very first tick, before any prompt or request has
// had a chance to grab the terminal or start a child process.
installInterruptHandlers();

// Exit quietly when the downstream reader closes the pipe early
// (e.g. `gac --help | head`, or quitting `less` mid-stream).
const exitOnEpipe = (err) => {
  // Preserve any failure code already set by an error path.
  if (err && err.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw err;
};
process.stdout.on("error", exitOnEpipe);
process.stderr.on("error", exitOnEpipe);

runCli(process.argv)
  .catch((err) => {
    // A command aborted by Ctrl+C reports the abort as an error; the interrupt
    // handler is already exiting, so don't print over it.
    if (isInterrupted()) return;
    term(`Error: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    // Whatever happened — success, error, or abort — the terminal goes back to
    // the state the shell handed us. A prompt that grabbed stdin and a failed
    // request that never got to clean up would otherwise leave the process
    // alive with a raw, resumed stdin and no way out.
    releaseTerminal();
    if (isInterrupted() && !process.exitCode) process.exitCode = INTERRUPT_EXIT_CODE;
  });
