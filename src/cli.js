import terminalKit from "terminal-kit";
import process from "process";
import { randomUUID } from "crypto";
import { chatCompletion, listModels, getActiveModel, getActiveModelKey } from "./gpt4all.js";
import {
  getConfigPath,
  loadConfig,
  setConfigValue,
  getConfigValue,
  redactConfig,
  redactApiKey,
  isSecretConfigKey,
} from "./config.js";
import { loginCodex, logoutCodex, codexAuthStatus } from "./codexauth.js";
import { maskApiKey } from "./configtui.js";
import { createMarkdownRenderer } from "./markdown.js";
import { runChat } from "./chat.js";
import { parseArgs, printHelp, getVersion } from "./flags.js";
import { buildSystemPrompt, normalizeDefaultAction } from "./prompts.js";
import { buildDirectoryContext } from "./sysinfo.js";
import {
  readPipedStdin,
  readFileContexts,
  formatFileContexts,
  attachInputToPrompt,
  truncateForContext,
} from "./input.js";
import {
  resolveContextWindow,
  resolveMaxTokens,
  contextBudget,
  estimateTokens,
} from "./contextwindow.js";
import { runRunbook } from "./runbook.js";
import { runCommit } from "./commit.js";
import { runFix } from "./fix.js";
import { runCompletions } from "./completions.js";
import { runConfigTui } from "./configtui.js";
import { createTelemetry } from "./telemetry/index.js";
import { CONSENT_STATEMENT } from "./telemetry/consent.js";
import { runTelemetryCommand } from "./telemetrycli.js";
import { sizeBucket, countBucket, inputMode } from "./telemetry/buckets.js";

const { terminal: term } = terminalKit;

const PROMPT_MODES = new Set(["ask", "suggest", "explain"]);

// Top-level commands whose first interactive use may trigger the one-time
// telemetry consent notice.
export const PROMPT_ELIGIBLE_ACTIONS = new Set([
  "ask",
  "suggest",
  "explain",
  "prompt",
  "chat",
  "runbook",
  "commit",
  "fix",
]);

async function runSinglePrompt(mode, prompt, config, extras = {}) {
  const piped = extras.piped || null;
  const files = extras.files || [];
  const telemetry = extras.telemetry;
  const contextWindow = await resolveContextWindow(config);
  const maxTokens = await resolveMaxTokens(config);
  const system = buildSystemPrompt(mode, config);

  // Character budget for attached context (piped input and files), sized so
  // the whole prompt still fits the model's context window.
  const budgetTokens = contextBudget(contextWindow, maxTokens);
  const budgetChars = Math.max(
    4000,
    (budgetTokens - estimateTokens(system) - estimateTokens(prompt) - 500) * 4
  );

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  if (
    (mode === "suggest" || mode === "explain") &&
    config.detailedContext === true
  ) {
    messages.push({
      role: "system",
      content: `Relevant context:\n${buildDirectoryContext()}`,
    });
  }
  if (files.length) {
    const perFileChars = Math.floor(budgetChars / 2 / files.length);
    messages.push({
      role: "system",
      content: `Relevant context:\n${formatFileContexts(files, perFileChars)}`,
    });
  }

  let userPrompt = prompt;
  if (piped) {
    const pipedMax = files.length ? Math.floor(budgetChars / 2) : budgetChars;
    const { text } = truncateForContext(piped, pipedMax);
    userPrompt = attachInputToPrompt(prompt, text);
  }
  messages.push({ role: "user", content: userPrompt });

  const reply = await chatCompletion(config, messages, {
    contextWindow,
    telemetry,
    telemetryAction: "direct_prompt",
  });
  if (!config.stream) {
    if (config.renderMarkdown) {
      const renderer = createMarkdownRenderer(config.markdownStyles);
      term(`${renderer.renderText(reply)}\n`);
    } else {
      term(`${reply}\n`);
    }
  }
  if (!reply || !reply.trim()) {
    term(
      "No response from the model. The request may have timed out or returned empty content. Consider increasing requestTimeoutMs in the config or enabling streaming.\n"
    );
  }
  if (config.debugRender) {
    term(`\n--- RAW ---\n${reply}\n`);
  }
  term(`\n`);

  // Sanitized command_completed telemetry — coarse buckets only.
  const props = {
    input_mode: inputMode({
      hasArguments: Boolean(prompt && prompt.trim()),
      hasStdin: Boolean(piped),
      hasFiles: files.length > 0,
    }),
    prompt_size_bucket: sizeBucket((prompt || "").length),
    file_count_bucket: countBucket(files.length),
    response_size_bucket: sizeBucket(reply ? reply.length : 0),
    streaming: Boolean(config.stream),
    render_markdown: Boolean(config.renderMarkdown),
    show_thinking: config.showThinking !== false,
  };
  if (mode === "suggest") props.detailed_suggest = Boolean(config.detailedSuggest);
  if (mode === "suggest" || mode === "explain") {
    props.detailed_context = Boolean(config.detailedContext);
  }
  return { outcome: reply && reply.trim() ? "success" : "no_op", props };
}

async function runModels(config, interactive) {
  let models;
  try {
    models = await listModels(config);
  } catch (err) {
    term(`Error: ${err.message}\n`);
    process.exitCode = 1;
    return { outcome: "failure", props: {} };
  }

  if (!models.length) {
    term("No models found from the configured provider.\n");
    return { outcome: "no_op", props: {} };
  }

  term("Available models:\n");
  models.forEach((model) => term(`- ${model}\n`));

  if (!interactive) return { outcome: "success", props: {} };

  // Prepend selection-only option for the menu (after printing the real list)
  const menuModels = ["Keep current default", ...models];
  term("\nSelect a default model (use arrows + Enter, Esc to cancel):\n");

  // Codex keeps its default in `codexModel` so provider switches stay free.
  const modelKey = getActiveModelKey(config);
  const activeModel = getActiveModel(config);
  const currentIndex = Math.max(menuModels.indexOf(activeModel), 0);
  term.grabInput({ mouse: "button" });
  const cleanup = () => {
    term.grabInput(false);
    term.removeListener("key", onKey);
  };
  const onKey = (name) => {
    if (name === "CTRL_C") {
      cleanup();
      term("\nCanceled.\n");
      term.processExit(0);
    }
  };
  term.on("key", onKey);

  await new Promise((resolve) => {
    term.singleColumnMenu(
      menuModels,
      { cancelable: true, selectedIndex: currentIndex },
      (error, response) => {
        term("\n");
        cleanup();
        if (error || !response || response.canceled) {
          term("Selection canceled.\n");
          resolve();
          return;
        }
        const selected = menuModels[response.selectedIndex];
        if (selected === "Keep current default") {
          term(`Default model unchanged ("${activeModel}").\n`);
          resolve();
          return;
        }
        setConfigValue(modelKey, selected);
        config[modelKey] = selected;
        term(`Default model set to "${selected}".\n`);
        resolve();
      }
    );
  });
  return { outcome: "success", props: {} };
}

function printAuthStatus(config) {
  const status = codexAuthStatus();
  term(`Provider: ${config.provider}\n`);
  if (config.provider !== "codex") {
    term(`API key: ${maskApiKey(config.apiKey)}\n`);
  }
  if (!status.signedIn) {
    term("ChatGPT (Codex): not signed in. Run `gac auth login`.\n");
    return;
  }
  term("ChatGPT (Codex): signed in");
  if (status.email) term(` as ${status.email}`);
  if (status.planType) term(` (${status.planType} plan)`);
  term("\n");
  term(`Credentials: ${status.source}\n`);
  if (status.lastRefresh) term(`Last refreshed: ${status.lastRefresh}\n`);
  if (config.provider !== "codex") {
    term('Tip: switch to it with `gac config set provider codex`.\n');
  }
}

async function runAuthCommand(args, config) {
  const sub = args[0] || "status";

  if (sub === "login") {
    try {
      const status = await loginCodex({ notify: (message) => term(message) });
      term("\nSigned in");
      if (status.email) term(` as ${status.email}`);
      if (status.planType) term(` (${status.planType} plan)`);
      term(".\n");
      if (config.provider !== "codex") {
        term(
          'To use it, switch the provider: `gac config set provider codex` (or via `gac config tui`).\n'
        );
      }
    } catch (err) {
      term(`Error: ${err.message}\n`);
      process.exitCode = 1;
      return { outcome: "failure", props: { subcommand: "login" } };
    }
    return { outcome: "success", props: { subcommand: "login" } };
  }

  if (sub === "logout") {
    let result;
    try {
      result = logoutCodex();
    } catch (err) {
      term(`Error: ${err.message}\n`);
      process.exitCode = 1;
      return { outcome: "failure", props: { subcommand: "logout" } };
    }
    term(result.removed ? "Signed out of ChatGPT.\n" : "No gac ChatGPT credentials were stored.\n");
    if (result.codexCliAuthPresent) {
      term(
        "Note: a Codex CLI login (~/.codex/auth.json) is still present and will be reused. Run `codex logout` to remove it too.\n"
      );
    }
    return { outcome: "success", props: { subcommand: "logout" } };
  }

  if (sub === "status") {
    printAuthStatus(config);
    return { outcome: "success", props: { subcommand: "status" } };
  }

  term(`Unknown auth subcommand "${sub}". Usage: gac auth <login|logout|status>\n`);
  process.exitCode = 1;
  return { outcome: "failure", props: { subcommand: "unknown" } };
}

async function runConfigCommand(args, config, interactive) {
  if (args[0] === "tui") {
    if (!interactive) {
      term("The config editor requires an interactive terminal.\n");
      process.exitCode = 1;
      return { outcome: "failure", props: { subcommand: "tui" } };
    }
    await runConfigTui(config);
    return { outcome: "success", props: { subcommand: "tui" } };
  }
  if (args[0] === "get" && args[1]) {
    const key = args[1];
    const value = getConfigValue(key);
    if (value === undefined) {
      term(`Key "${key}" is not set.\n`);
      return { outcome: "no_op", props: { subcommand: "get" } };
    }
    // Secrets never leave the process in plaintext — only presence is reported.
    if (isSecretConfigKey(key)) {
      term(`${redactApiKey(value)}\n`);
      return { outcome: "success", props: { subcommand: "get" } };
    }
    if (value !== null && typeof value === "object") {
      term(`${JSON.stringify(value, null, 2)}\n`);
    } else {
      term(`${value}\n`);
    }
    return { outcome: "success", props: { subcommand: "get" } };
  }
  if (args[0] === "set" && args[1] && args[2] !== undefined) {
    setConfigValue(args[1], args.slice(2).join(" "));
    // Print only a confirmation — never echo the value or dump the whole
    // config, which would leak an existing apiKey.
    term(`Updated ${args[1]} in ${getConfigPath()}\n`);
    return { outcome: "success", props: { subcommand: "set" } };
  }

  term(`Config file: ${getConfigPath()}\n`);
  term(`${JSON.stringify(redactConfig(config), null, 2)}\n`);
  return { outcome: "success", props: { subcommand: "view" } };
}

// A yes/No prompt (default No). Only used interactively.
function readYesNo(question) {
  return new Promise((resolve) => {
    term(question);
    term.inputField({ cancelable: true }, (error, input) => {
      term("\n");
      const value = String(input || "").trim().toLowerCase();
      resolve(value === "y" || value === "yes");
    });
  });
}

// The one-time automatic consent notice, shown before the first interactive
// telemetry-eligible action. Declining is recorded so it is not repeated.
async function runAutoConsentPrompt(telemetry) {
  term(`${CONSENT_STATEMENT}\n\n`);
  const yes = await readYesNo("Enable telemetry? [y/N] ");
  if (yes) {
    await telemetry.enable({ action: "first_run_prompt" });
  } else {
    telemetry.decline();
  }
  term("\n");
}

// Best-effort mapping of the raw command token to a command_completed action.
// Authoritative action is returned by the dispatcher; this is used for the
// pre-dispatch eligibility check and the error path.
export function resolveCommandAction(command, inTty) {
  if (command === undefined) return inTty ? "help" : "prompt";
  if (command === "-a") return "ask";
  if (PROMPT_MODES.has(command)) return command;
  if (
    command === "runbook" ||
    command === "chat" ||
    command === "models" ||
    command === "config" ||
    command === "auth" ||
    command === "commit" ||
    command === "fix" ||
    command === "completions" ||
    command === "telemetry"
  ) {
    return command;
  }
  if (!command.startsWith("-")) return "prompt";
  return "unknown";
}

// Emit the single top-level command_completed event and drain the queue within
// the foreground time budget. Never throws.
async function emitCommandCompleted(telemetry, action, outcome, props, durationMs) {
  telemetry.track({
    event_name: "command_completed",
    action,
    outcome,
    duration_ms: durationMs,
    error_category: null,
    properties: props || {},
  });
  await telemetry.flush({ timeoutMs: 300 });
}

export async function runCli(argv, cliDeps = {}) {
  const { flags, positional, errors } = parseArgs(argv);

  if (errors.length) {
    errors.forEach((message) => term(`Error: ${message}\n`));
    term(`Run "gac --help" for usage.\n`);
    process.exitCode = 1;
    return;
  }

  const inTty = Boolean(process.stdin.isTTY);
  const outTty = Boolean(process.stdout.isTTY);
  const interactive = inTty && outTty;
  const version = getVersion();
  const invocationId = cliDeps.invocationId || randomUUID();

  const makeTelemetry = (config) =>
    cliDeps.telemetry ||
    createTelemetry({
      version,
      provider: config ? config.provider : undefined,
      interactive,
      invocationId,
      endpoint: cliDeps.telemetryEndpoint,
      fetchImpl: cliDeps.telemetryFetch,
      fs: cliDeps.fs,
      homeDir: cliDeps.homeDir,
      now: cliDeps.now,
      uuid: cliDeps.uuid,
      env: cliDeps.env,
    });

  if (flags.version) {
    term(`gac ${version}\n`);
    const telemetry = makeTelemetry(null);
    await emitCommandCompleted(telemetry, "version", "success", {}, null);
    return;
  }
  if (flags.help) {
    printHelp();
    const telemetry = makeTelemetry(null);
    await emitCommandCompleted(telemetry, "help", "success", {}, null);
    return;
  }

  const config = loadConfig();
  if (flags.noRender) config.renderMarkdown = false;
  if (flags.debugRender) config.debugRender = true;
  if (flags.detailedSuggest) config.detailedSuggest = true;
  if (flags.detailedContext) config.detailedContext = true;

  if (!outTty) {
    // Piped/redirected output gets plain text: no markdown styling and no
    // "thinking..." cursor animations.
    config.renderMarkdown = false;
    config.showThinking = false;
  }

  let fileContexts = [];
  if (flags.files.length) {
    const { files, errors: fileErrors } = readFileContexts(flags.files);
    if (fileErrors.length) {
      fileErrors.forEach((message) => term(`Error: ${message}\n`));
      process.exitCode = 1;
      return;
    }
    fileContexts = files;
  }

  const [command, ...rest] = positional;

  // Telemetry control commands are never instrumented and never auto-prompt.
  if (command === "telemetry") {
    const telemetry = makeTelemetry(config);
    const code = await runTelemetryCommand(rest, telemetry, {
      write: (s) => term(s),
      confirm: (question) => readYesNo(question),
      interactive,
    });
    if (code) process.exitCode = code;
    return;
  }

  const telemetry = makeTelemetry(config);

  // One-time consent notice before the first interactive eligible action.
  const plannedAction = resolveCommandAction(command, inTty);
  if (
    interactive &&
    PROMPT_ELIGIBLE_ACTIONS.has(plannedAction) &&
    telemetry.shouldPrompt(interactive)
  ) {
    await runAutoConsentPrompt(telemetry);
  }

  const commandStart = Date.now();
  let result;
  try {
    result = await dispatchCommand(command, rest, positional, config, {
      flags,
      interactive,
      inTty,
      telemetry,
      fileContexts,
    });
  } catch (err) {
    // A thrown command still records a failure (bounded flush), then the error
    // propagates unchanged so bin/gac.js can report it.
    await emitCommandCompleted(
      telemetry,
      plannedAction,
      "failure",
      {},
      Date.now() - commandStart
    );
    throw err;
  }

  if (result && result.skipTelemetry) return;
  const action = (result && result.action) || plannedAction;
  const outcome = (result && result.outcome) || (process.exitCode ? "failure" : "success");
  const props = (result && result.props) || {};
  await emitCommandCompleted(telemetry, action, outcome, props, Date.now() - commandStart);
}

// Runs the resolved command and returns { action, outcome, props }. Preserves
// all existing output and exit behavior.
async function dispatchCommand(command, rest, positional, config, ctx) {
  const { flags, interactive, inTty, telemetry, fileContexts } = ctx;

  if (!command) {
    // `producer | gac` with no arguments: treat the piped text as the prompt.
    if (!inTty) {
      const piped = await readPipedStdin();
      if (piped) {
        const defaultAction = normalizeDefaultAction(config.defaultAction);
        const r = await runSinglePrompt(defaultAction, "", config, {
          piped,
          files: fileContexts,
          telemetry,
        });
        return { action: "prompt", outcome: r.outcome, props: r.props };
      }
    }
    printHelp();
    return { action: "help", outcome: "success", props: {} };
  }

  if (command === "config") {
    const r = await runConfigCommand(rest, config, interactive);
    return { action: "config", outcome: r.outcome, props: r.props };
  }

  if (command === "auth") {
    const r = await runAuthCommand(rest, config);
    return { action: "auth", outcome: r.outcome, props: r.props };
  }

  if (command === "chat") {
    if (!interactive) {
      term(
        'Chat requires an interactive terminal. For piped input, use: some-command | gac ask "..."\n'
      );
      process.exitCode = 1;
      return { action: "chat", outcome: "failure", props: {} };
    }
    const systemPrompt = buildSystemPrompt("chat", config);
    const r = await runChat(config, systemPrompt, { telemetry });
    return { action: "chat", outcome: (r && r.outcome) || "success", props: {} };
  }

  if (command === "models") {
    const r = await runModels(config, interactive);
    return { action: "models", outcome: r.outcome, props: r.props };
  }

  if (command === "commit") {
    const r = await runCommit(config, { dryRun: flags.dryRun, telemetry });
    return { action: "commit", outcome: (r && r.outcome) || "success", props: (r && r.props) || {} };
  }

  if (command === "completions") {
    const ok = runCompletions(rest[0]);
    const shell = String(rest[0] || "").trim().toLowerCase();
    const sub = ["bash", "zsh", "fish"].includes(shell) ? shell : "unknown";
    return {
      action: "completions",
      outcome: ok ? "success" : "failure",
      props: { subcommand: sub },
    };
  }

  if (command === "fix") {
    const piped = !inTty ? await readPipedStdin() : null;
    const r = await runFix(rest, config, { piped, interactive, telemetry });
    return { action: "fix", outcome: (r && r.outcome) || "success", props: (r && r.props) || {} };
  }

  const isPromptMode = PROMPT_MODES.has(command) || command === "-a";
  if (isPromptMode || command === "runbook") {
    const mode = command === "-a" ? "ask" : command;
    const prompt = rest.join(" ").trim();
    const piped = !inTty ? await readPipedStdin() : null;
    if (!prompt && !piped) {
      term(`Error: missing prompt after ${command}.\n`);
      process.exitCode = 1;
      return { action: mode === "runbook" ? "runbook" : mode, outcome: "failure", props: {} };
    }
    if (command === "runbook") {
      const r = await runRunbook(prompt || piped, config, {
        dryRun: flags.dryRun,
        exportPath: flags.exportPath,
        piped: prompt ? piped : null,
        files: fileContexts,
        interactive,
        telemetry,
      });
      return { action: "runbook", outcome: (r && r.outcome) || "success", props: (r && r.props) || {} };
    }
    const r = await runSinglePrompt(mode, prompt, config, {
      piped,
      files: fileContexts,
      telemetry,
    });
    return { action: mode, outcome: r.outcome, props: r.props };
  }

  if (!command.startsWith("-")) {
    const prompt = positional.join(" ").trim();
    const piped = !inTty ? await readPipedStdin() : null;
    const defaultAction = normalizeDefaultAction(config.defaultAction);
    const r = await runSinglePrompt(defaultAction, prompt, config, {
      piped,
      files: fileContexts,
      telemetry,
    });
    return { action: "prompt", outcome: r.outcome, props: r.props };
  }

  term(`Unknown option: ${command}\n\n`);
  printHelp();
  process.exitCode = 1;
  return { action: "unknown", outcome: "failure", props: {} };
}
