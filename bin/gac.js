#!/usr/bin/env node
import terminalKit from "terminal-kit";
import { runCli } from "../src/cli.js";

const { terminal: term } = terminalKit;

runCli(process.argv).catch((err) => {
  term(`Error: ${err.message}\n`);
  process.exitCode = 1;
});
