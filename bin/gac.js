#!/usr/bin/env node
import terminalKit from "terminal-kit";
import { runCli } from "../src/cli.js";

const { terminal: term } = terminalKit;

// Exit quietly when the downstream reader closes the pipe early
// (e.g. `gac --help | head`, or quitting `less` mid-stream).
const exitOnEpipe = (err) => {
  // Preserve any failure code already set by an error path.
  if (err && err.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw err;
};
process.stdout.on("error", exitOnEpipe);
process.stderr.on("error", exitOnEpipe);

runCli(process.argv).catch((err) => {
  term(`Error: ${err.message}\n`);
  process.exitCode = 1;
});
