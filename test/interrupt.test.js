import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  registerChild,
  registerAbort,
  onInterrupt,
  killAllChildren,
  isInterrupted,
  interruptSignal,
  resetInterruptState,
  INTERRUPT_EXIT_CODE,
} from "../src/interrupt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "gac.js");

function waitForExit(child) {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run a snippet against the real src/interrupt.js in its own process, so the
// process.exit() and signal handling under test are the genuine article.
function runScript(body, { args = [], env = {} } = {}) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "gac-interrupt-")),
    "script.mjs"
  );
  fs.writeFileSync(file, body);
  const result = spawnSync(process.execPath, [file, ...args], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, ...env },
  });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  return result;
}

test.afterEach(() => resetInterruptState());

test("killAllChildren terminates a registered child", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  registerChild(child);
  assert.equal(killAllChildren("SIGKILL"), 1);
  const { signal } = await waitForExit(child);
  assert.equal(signal, "SIGKILL");
});

test("killAllChildren skips children that already exited", async () => {
  const child = spawn(process.execPath, ["-e", ""]);
  registerChild(child);
  await waitForExit(child);
  assert.equal(killAllChildren("SIGTERM"), 0);
});

test("unregistering a child takes it out of the kill set", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"]);
  const unregister = registerChild(child);
  unregister();
  assert.equal(killAllChildren("SIGKILL"), 0);
  child.kill("SIGKILL");
  await waitForExit(child);
});

test("registering does not abort on its own — only a real interrupt does", () => {
  // The abort itself happens on the shutdown path, which exits the process;
  // that half is covered by the SIGINT test below.
  const controller = new AbortController();
  registerAbort(controller);
  assert.equal(controller.signal.aborted, false);
});

test("isInterrupted is false and interruptSignal unaborted before any interrupt", () => {
  assert.equal(isInterrupted(), false);
  assert.equal(interruptSignal().aborted, false);
});

test("onInterrupt returns a working unregister function", () => {
  let calls = 0;
  const off = onInterrupt(() => {
    calls += 1;
  });
  off();
  assert.equal(calls, 0);
});

test("registerChild and registerAbort ignore junk without throwing", () => {
  assert.equal(typeof registerChild(null), "function");
  assert.equal(typeof registerChild({}), "function");
  assert.equal(typeof registerAbort(null), "function");
  assert.equal(typeof onInterrupt("not a function"), "function");
});

// ── Full shutdown, in a real process ───────────────────────────────────────

test("SIGINT aborts in-flight requests, runs cleanups, and exits 130", () => {
  const result = runScript(`
    import {
      installInterruptHandlers,
      registerAbort,
      onInterrupt,
      isInterrupted,
      interruptSignal,
    } from ${JSON.stringify(path.join(REPO_ROOT, "src", "interrupt.js"))};

    installInterruptHandlers();
    const controller = new AbortController();
    registerAbort(controller);
    interruptSignal().addEventListener("abort", () => console.log("master-aborted"));
    controller.signal.addEventListener("abort", () => console.log("request-aborted"));
    onInterrupt(() => console.log("cleanup-ran:" + isInterrupted()));

    // Keep the loop alive so the signal has something to interrupt.
    setInterval(() => {}, 1000);
    process.kill(process.pid, "SIGINT");
  `);

  assert.equal(result.status, INTERRUPT_EXIT_CODE);
  assert.match(result.stdout, /master-aborted/);
  assert.match(result.stdout, /request-aborted/);
  assert.match(result.stdout, /cleanup-ran:true/);
  assert.match(result.stderr, /Interrupted\./);
});

test("SIGTERM shuts down the same way, naming the signal", () => {
  const result = runScript(`
    import { installInterruptHandlers } from ${JSON.stringify(
      path.join(REPO_ROOT, "src", "interrupt.js")
    )};
    installInterruptHandlers();
    setInterval(() => {}, 1000);
    process.kill(process.pid, "SIGTERM");
  `);
  assert.equal(result.status, INTERRUPT_EXIT_CODE);
  assert.match(result.stderr, /Terminated \(SIGTERM\)/);
});

test("SIGINT kills a registered child's whole process group", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process groups only");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gac-interrupt-group-"));
  const beat = path.join(dir, "beat");

  // A grandchild that keeps touching a file. Signalling only the shell would
  // leave it running, so a heartbeat that stops is the proof the whole group
  // went down. (Checking pids is not enough: a killed grandchild lingers as an
  // unreaped zombie, which still answers kill(pid, 0).)
  const result = runScript(`
    import { spawn } from "child_process";
    import { installInterruptHandlers, registerChild } from ${JSON.stringify(
      path.join(REPO_ROOT, "src", "interrupt.js")
    )};

    installInterruptHandlers();
    const child = spawn(
      "sh",
      ["-c", 'while :; do echo tick >> ${beat}; sleep 0.05; done & wait'],
      { stdio: "ignore", detached: true }
    );
    registerChild(child, { group: true });

    setInterval(() => {}, 1000);
    setTimeout(() => process.kill(process.pid, "SIGINT"), 1000);
  `);

  assert.equal(result.status, INTERRUPT_EXIT_CODE);
  assert.ok(fs.statSync(beat).size > 0, "grandchild should have been running");

  // If anything in the group survived, the file keeps growing.
  await delay(600);
  const settled = fs.statSync(beat).size;
  await delay(600);
  assert.equal(fs.statSync(beat).size, settled, "the process group is still running");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a second interrupt exits immediately instead of waiting on cleanup", () => {
  const result = runScript(`
    import { installInterruptHandlers, onInterrupt } from ${JSON.stringify(
      path.join(REPO_ROOT, "src", "interrupt.js")
    )};
    installInterruptHandlers();
    onInterrupt(() => {
      // A cleanup that re-signals: the second interrupt must not deadlock or
      // re-run the shutdown, it must exit.
      process.kill(process.pid, "SIGINT");
    });
    setInterval(() => {}, 1000);
    process.kill(process.pid, "SIGINT");
  `);
  assert.equal(result.status, INTERRUPT_EXIT_CODE);
});

// ── The original bug: a prompt must not leave stdin grabbed ────────────────

test("no module calls term.inputField or term.singleColumnMenu directly", () => {
  // terminal-kit's inputField()/singleColumnMenu() grab stdin when nothing
  // else has and never release it, which leaves the process alive with a raw,
  // resumed stdin — hung, and deaf to Ctrl+C. src/tui.js wraps both so the
  // grab is always undone; every other module must go through the wrappers.
  const offenders = [];
  for (const file of fs.readdirSync(path.join(REPO_ROOT, "src"))) {
    if (!file.endsWith(".js") || file === "tui.js") continue;
    const source = fs.readFileSync(path.join(REPO_ROOT, "src", file), "utf8");
    if (/\bterm\.(inputField|singleColumnMenu)\s*\(/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test("the CLI exits instead of hanging when a command fails after a prompt", async () => {
  // Regression test for the reported hang: answering the telemetry consent
  // prompt left stdin grabbed, so gac stayed resident forever after printing
  // the connection error. Without a tty there is no prompt, but the same exit
  // path is what must not hang.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gac-home-"));
  const child = spawn(process.execPath, [BIN, "ask", "hello"], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GAC_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.resume();
  const { code, signal } = await waitForExit(child);
  clearTimeout(timer);
  fs.rmSync(home, { recursive: true, force: true });

  assert.notEqual(signal, "SIGKILL", `gac did not exit on its own: ${stderr}`);
  assert.equal(code, 1);
});
