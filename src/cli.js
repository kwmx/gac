import terminalKit from "terminal-kit";
import process from "process";
import { chatCompletion, listModels, getActiveModel } from "./gpt4all.js";
import { getConfigPath, loadConfig, setConfigValue, getConfigValue } from "./config.js";
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
  contextBudget,
  estimateTokens,
} from "./contextwindow.js";
import { runRunbook } from "./runbook.js";
import { runCommit } from "./commit.js";
import { runFix } from "./fix.js";
import { runCompletions } from "./completions.js";
import { runConfigTui } from "./configtui.js";

const { terminal: term } = terminalKit;

const PROMPT_MODES = new Set(["ask", "suggest", "explain"]);

async function runSinglePrompt(mode, prompt, config, extras = {}) {
  const piped = extras.piped || null;
  const files = extras.files || [];
  const contextWindow = await resolveContextWindow(config);
  const system = buildSystemPrompt(mode, config);

  // Character budget for attached context (piped input and files), sized so
  // the whole prompt still fits the model's context window.
  const budgetTokens = contextBudget(contextWindow, config.maxTokens);
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

  const reply = await chatCompletion(config, messages, { contextWindow });
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
}

async function runModels(config, interactive) {
  let models;
  try {
    models = await listModels(config);
  } catch (err) {
    term(`Error: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (!models.length) {
    term("No models found from the configured provider.\n");
    return;
  }

  term("Available models:\n");
  models.forEach((model) => term(`- ${model}\n`));

  if (!interactive) return;

  // Prepend selection-only option for the menu (after printing the real list)
  const menuModels = ["Keep current default", ...models];
  term("\nSelect a default model (use arrows + Enter, Esc to cancel):\n");

  // Codex keeps its default in `codexModel` so provider switches stay free.
  const modelKey = config.provider === "codex" ? "codexModel" : "model";
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
    }
    return;
  }

  if (sub === "logout") {
    const { removed, codexCliAuthPresent } = logoutCodex();
    term(removed ? "Signed out of ChatGPT.\n" : "No gac ChatGPT credentials were stored.\n");
    if (codexCliAuthPresent) {
      term(
        "Note: a Codex CLI login (~/.codex/auth.json) is still present and will be reused. Run `codex logout` to remove it too.\n"
      );
    }
    return;
  }

  if (sub === "status") {
    printAuthStatus(config);
    return;
  }

  term(`Unknown auth subcommand "${sub}". Usage: gac auth <login|logout|status>\n`);
  process.exitCode = 1;
}

async function runConfigCommand(args, config, interactive) {
  if (args[0] === "tui") {
    if (!interactive) {
      term("The config editor requires an interactive terminal.\n");
      process.exitCode = 1;
      return;
    }
    await runConfigTui(config);
    return;
  }
  if (args[0] === "get" && args[1]) {
    const key = args[1];
    const value = getConfigValue(key);
    if (value === undefined) {
      term(`Key "${key}" is not set.\n`);
      return;
    }
    if (value !== null && typeof value === "object") {
      term(`${JSON.stringify(value, null, 2)}\n`);
    } else {
      term(`${value}\n`);
    }
    return;
  }
  if (args[0] === "set" && args[1] && args[2] !== undefined) {
    const updated = setConfigValue(args[1], args.slice(2).join(" "));
    term(`Updated ${args[1]} in ${getConfigPath()}\n`);
    term(`${JSON.stringify(updated, null, 2)}\n`);
    return;
  }

  term(`Config file: ${getConfigPath()}\n`);
  term(`${JSON.stringify(config, null, 2)}\n`);
}

export async function runCli(argv) {
  const { flags, positional, errors } = parseArgs(argv);

  if (errors.length) {
    errors.forEach((message) => term(`Error: ${message}\n`));
    term(`Run "gac --help" for usage.\n`);
    process.exitCode = 1;
    return;
  }
  if (flags.version) {
    term(`gac ${getVersion()}\n`);
    return;
  }
  if (flags.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  if (flags.noRender) config.renderMarkdown = false;
  if (flags.debugRender) config.debugRender = true;
  if (flags.detailedSuggest) config.detailedSuggest = true;
  if (flags.detailedContext) config.detailedContext = true;

  const inTty = Boolean(process.stdin.isTTY);
  const outTty = Boolean(process.stdout.isTTY);
  const interactive = inTty && outTty;
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

  if (!command) {
    // `producer | gac` with no arguments: treat the piped text as the prompt.
    if (!inTty) {
      const piped = await readPipedStdin();
      if (piped) {
        const defaultAction = normalizeDefaultAction(config.defaultAction);
        await runSinglePrompt(defaultAction, "", config, {
          piped,
          files: fileContexts,
        });
        return;
      }
    }
    printHelp();
    return;
  }

  if (command === "config") {
    await runConfigCommand(rest, config, interactive);
    return;
  }

  if (command === "auth") {
    await runAuthCommand(rest, config);
    return;
  }

  if (command === "chat") {
    if (!interactive) {
      term(
        'Chat requires an interactive terminal. For piped input, use: some-command | gac ask "..."\n'
      );
      process.exitCode = 1;
      return;
    }
    const systemPrompt = buildSystemPrompt("chat", config);
    await runChat(config, systemPrompt);
    return;
  }

  if (command === "models") {
    await runModels(config, interactive);
    return;
  }

  if (command === "commit") {
    await runCommit(config, { dryRun: flags.dryRun });
    return;
  }

  if (command === "completions") {
    runCompletions(rest[0]);
    return;
  }

  if (command === "fix") {
    const piped = !inTty ? await readPipedStdin() : null;
    await runFix(rest, config, { piped, interactive });
    return;
  }

  const isPromptMode = PROMPT_MODES.has(command) || command === "-a";
  if (isPromptMode || command === "runbook") {
    const mode = command === "-a" ? "ask" : command;
    const prompt = rest.join(" ").trim();
    const piped = !inTty ? await readPipedStdin() : null;
    if (!prompt && !piped) {
      term(`Error: missing prompt after ${command}.\n`);
      process.exitCode = 1;
      return;
    }
    if (command === "runbook") {
      await runRunbook(prompt || piped, config, {
        dryRun: flags.dryRun,
        exportPath: flags.exportPath,
        piped: prompt ? piped : null,
        files: fileContexts,
        interactive,
      });
      return;
    }
    await runSinglePrompt(mode, prompt, config, { piped, files: fileContexts });
    return;
  }

  if (!command.startsWith("-")) {
    const prompt = positional.join(" ").trim();
    const piped = !inTty ? await readPipedStdin() : null;
    const defaultAction = normalizeDefaultAction(config.defaultAction);
    await runSinglePrompt(defaultAction, prompt, config, {
      piped,
      files: fileContexts,
    });
    return;
  }

  term(`Unknown option: ${command}\n\n`);
  printHelp();
  process.exitCode = 1;
}
