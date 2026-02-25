import terminalKit from "terminal-kit";
import { chatCompletion, listModels } from "./gpt4all.js";
import { getConfigPath, loadConfig, setConfigValue } from "./config.js";
import { createMarkdownRenderer } from "./markdown.js";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import process from "process";
import { fileURLToPath } from "url";
const { terminal: term } = terminalKit;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOCKED_COMMANDS_PATH = path.resolve(__dirname, "../blocked_commands.json");

function printHelp() {
  term(`gac - OpenAI-compatible & Ollama CLI\n\n`);
  term(`Modes:\n`);
  term(`  ask               Answer a question\n`);
  term(`  suggest           Concise command/code suggestion\n`);
  term(`  explain           Step-by-step explanation with example\n`);
  term(`  runbook           Generate shell commands with run/skip/cancel gates and AI diagnosis on failure\n`);
  term(`  chat              Interactive multi-turn conversation\n`);
  term(`  models            List available models and set the default\n`);
  term(`  config            View or edit configuration\n`);
  term(`  config tui        Open the interactive config editor\n`);
  term(`\n`);
  term(`Flags:\n`);
  term(`  -a                        Shorthand for ask mode\n`);
  term(`  -m, --model <name>        Override the model for this invocation\n`);
  term(`  -t, --temperature <val>   Override the temperature for this invocation\n`);
  term(`  -d, --detailed-suggest    Detailed step-by-step suggestions (suggest mode)\n`);
  term(`  --detailed-context        Include current directory listing in prompt\n`);
  term(`  --no-render               Disable markdown rendering\n`);
  term(`  --debug-render            Show rendered output followed by raw response\n`);
  term(`  -h, --help                Show this help message\n`);
  term(`\n`);
  term(`Usage:\n`);
  term(`  gac ask "What is the best way to learn JavaScript?"\n`);
  term(`  gac suggest "How do I connect to SSH on port 5322"\n`);
  term(`  gac explain "How do I use rsync?"\n`);
  term(`  gac runbook "Set up a new Node.js project with eslint"\n`);
  term(`  gac -m llama3 suggest "fastest way to sort a list in Python"\n`);
  term(`  gac chat\n`);
  term(`  gac models\n`);
  term(`  gac config\n`);
  term(`  gac config tui\n`);
  term(`  gac config get markdownStyles.codeStyles\n`);
  term(`  gac config set model phi4\n`);
  term(`\n`);
  term(`Pipe / stdin support:\n`);
  term(`  cat error.log | gac ask "what does this mean?"\n`);
  term(`  cat script.sh | gac explain\n`);
  term(`  git diff | gac suggest "how should I fix this?"\n`);
  term(`\n`);
  term(`Chat commands (inside chat mode):\n`);
  term(`  /clear    Reset conversation history\n`);
  term(`  /model    Show the current model\n`);
  term(`  /help     List available chat commands\n`);
  term(`  exit      Quit the chat\n`);
  term(`\n`);
}
function parseOsRelease(contents) {
  const result = {};
  const lines = contents.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    let value = rest.join("=").trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (value) {
      result[key] = value;
    }
  }
  return result;
}

function readLinuxOsRelease() {
  try {
    const contents = fs.readFileSync("/etc/os-release", "utf8");
    return parseOsRelease(contents);
  } catch (err) {
    return null;
  }
}

function getOSVersion() {
  const platform = os.platform();
  if (platform === "win32") {
    // Which version of Windows?
    if (process.env.OS_VERSION) {
      return `${platform}: ${process.env.OS_VERSION}`;
    } else if (process.env.OS_RELEASE) {
      return `${platform}: ${process.env.OS_RELEASE}`;
    } else if (process.env.OS) {
      return `${platform}: ${process.env.OS}`;
    } else {
      return "Windows";
    }
  } else if (platform === "darwin") {
    if (process.env.OS_VERSION) {
      return `${platform}: ${process.env.OS_VERSION}`;
    }
    if (process.env.OS_RELEASE) {
      return `${platform}: ${process.env.OS_RELEASE}`;
    }
    if (process.env.OS) {
      return `${platform}: ${process.env.OS}`;
    }
    return "macOS";
  }
  if (platform === "linux") {
    const osRelease = readLinuxOsRelease();
    if (osRelease && (osRelease.PRETTY_NAME || osRelease.NAME)) {
      const pretty = osRelease.PRETTY_NAME || osRelease.NAME;
      const id = osRelease.ID ? `; id=${osRelease.ID}` : "";
      const idLike = osRelease.ID_LIKE ? `; id_like=${osRelease.ID_LIKE}` : "";
      return `Linux (${pretty}${id}${idLike})`;
    }
    // Find which distro (fallbacks)
    if (process.env.OS_RELEASE) {
      return `${platform}: ${process.env.OS_RELEASE}`;
    } else if (process.env.OS) {
      return `${platform}: ${process.env.OS}`;
    } else if (process.env.LINUX_DISTRO) {
      return `${platform}: ${process.env.LINUX_DISTRO}`;
    }
    return `Linux`;
  }
  if (platform === "freebsd") {
    return "FreeBSD";
  }
  if (platform === "sunos") {
    return "SunOS";
  }
  if (platform === "aix") {
    return "AIX";
  }
  return "Unknown OS";
}
function getOsGuidance() {
  const osInfo = getOSVersion();
  return `The user is using a system with the following OS: ${osInfo}. When providing commands or package install steps, use the native tooling for that OS (e.g., dnf for Fedora, apt for Debian/Ubuntu). Avoid giving instructions for other distros unless explicitly requested.`;
}

function buildSystemPrompt(mode, config) {
  const osGuidance = getOsGuidance();

  if (mode === "suggest") {
    if (config.detailedSuggest === true) {
      return `You are an expert technical assistant. ${osGuidance} When providing suggestions, give detailed, step-by-step instructions that the user can follow to achieve their goals. For each step, include the relevant command, code snippet, or configuration change and briefly explain what it does. Place all commands and code on their own line for easy copying.`;
    } else {
      return `You are an expert technical assistant. ${osGuidance} Provide concise and practical suggestions to help the user accomplish their tasks efficiently. Focus on clarity and brevity, ensuring that your suggestions are easy to understand and implement. Tailor your suggestions to be relevant to the user's operating system and environment. Avoid lengthy explanations or unnecessary details. Prefer single-line commands or code snippets; if you must include explanations, keep them brief and place commands and code on their own line for easy copying.`;
    }
  }
  if (mode === "ask") {
    return `You are a helpful and knowledgeable assistant. ${osGuidance} Answer the user's question accurately and concisely. Place any commands or code on their own line for easy copying.`;
  }
  if (mode === "explain") {
    return `You are an expert technical assistant. ${osGuidance} Explain the topic clearly, step-by-step. Include a short, practical example that illustrates the concept. Place all commands and code on their own line for easy copying.`;
  }
  if (mode === "chat") {
    return `You are a helpful assistant. ${osGuidance} Engage in natural conversation, answer questions accurately, and assist with technical and general topics. Place any commands or code on their own line for easy copying.`;
  }
  if (mode === "runbook") {
    return `You are an expert terminal assistant. ${osGuidance} Respond with JSON only — no markdown, no extra text — in this exact shape:
{
  "commands": [
    { "description": "short description", "command": "shell command" }
  ],
  "notes": ["optional manual steps or caveats"]
}
Rules:
- Include only safe, non-destructive commands.
- Never include commands that delete, format, or irreversibly modify files or the filesystem.
- Prefer idempotent commands that can be run more than once without causing harm.
- Each command must be runnable as-is with no placeholders or manual substitution required.`;
  }
  return null;
}

function formatDirectoryListing(entries) {
  if (!entries.length) return "(empty)";
  return entries
    .map((entry) => {
      if (entry.isDirectory()) return `${entry.name}/`;
      if (entry.isSymbolicLink()) return `${entry.name}@`;
      return entry.name;
    })
    .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))
    .join("\n");
}

function buildDirectoryContext() {
  const cwd = process.cwd();
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    const listing = formatDirectoryListing(entries);
    return `Current directory: ${cwd}\nls:\n${listing}`;
  } catch (err) {
    return `Current directory: ${cwd}\nls: (unavailable: ${err.message})`;
  }
}

function buildRunbookContext() {
  const shell = process.env.SHELL || process.env.ComSpec || "unknown";
  const user = os.userInfo().username;
  return [
    buildDirectoryContext(),
    `Shell: ${shell}`,
    `Node.js: ${process.version}`,
    `User: ${user}`,
  ].join("\n");
}

function normalizeCommandText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function loadBlockedCommands() {
  try {
    const raw = fs.readFileSync(BLOCKED_COMMANDS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.blocked)) return parsed.blocked;
    return [];
  } catch (err) {
    return [];
  }
}

function findBlockedCommand(command, blockedList) {
  const raw = String(command || "");
  const normalized = normalizeCommandText(raw);
  return blockedList.find((entry) => {
    const patternText = String(entry.pattern || entry || "").trim();
    if (!patternText) return false;
    try {
      const regex = new RegExp(patternText, "i");
      if (regex.test(raw)) return true;
    } catch (err) {
      // Fall back to substring check if regex parsing fails.
    }
    const normalizedPattern = normalizeCommandText(patternText);
    return normalizedPattern && normalized.includes(normalizedPattern);
  });
}

function extractJsonPayload(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) return null;
  const jsonText = candidate.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(jsonText);
  } catch (err) {
    return null;
  }
}

function normalizeRunbookCommands(payload) {
  if (!payload || !Array.isArray(payload.commands)) {
    return { commands: [], notes: [] };
  }
  const commands = payload.commands
    .map((item) => {
      if (typeof item === "string") {
        return { description: "", command: item };
      }
      if (!item || typeof item !== "object") return null;
      return {
        description: String(item.description || item.title || "").trim(),
        command: String(item.command || item.cmd || "").trim(),
      };
    })
    .filter((item) => item && item.command);
  const notes = Array.isArray(payload.notes)
    ? payload.notes.map((note) => String(note)).filter(Boolean)
    : [];
  return { commands, notes };
}

function printRunbookCommands(commands) {
  commands.forEach((entry, index) => {
    term(`${index + 1}. `);
    if (entry.description) {
      term(`${entry.description}\n   `);
    }
    term(`${entry.command}\n`);
  });
}

function printRemainingCommands(commands, startIndex) {
  if (startIndex >= commands.length) return;
  term("\nPlanned next commands:\n");
  commands.slice(startIndex).forEach((entry, offset) => {
    term(`${startIndex + offset + 1}. `);
    if (entry.description) {
      term(`${entry.description}\n   `);
    }
    term(`${entry.command}\n`);
  });
}

function createRunbookShell() {
  const shell = process.env.SHELL || "bash";
  const child = spawn(shell, ["-l"], { stdio: "pipe" });
  const session = {
    child,
    pending: null,
    closed: false,
  };

  const finalizePending = (result) => {
    if (!session.pending) return;
    const pending = session.pending;
    session.pending = null;
    pending.resolve(result);
  };

  const handleStdout = (data) => {
    const text = data.toString();
    const pending = session.pending;
    if (!pending) {
      term(text);
      return;
    }
    pending.buffer += text;
    let output = "";
    while (true) {
      const markerIndex = pending.buffer.indexOf(pending.marker);
      if (markerIndex === -1) {
        output += pending.buffer;
        pending.buffer = "";
        break;
      }
      output += pending.buffer.slice(0, markerIndex);
      const afterMarker = pending.buffer.slice(markerIndex + pending.marker.length);
      const endIndex = afterMarker.indexOf("__");
      if (endIndex === -1) {
        pending.buffer = pending.buffer.slice(markerIndex);
        break;
      }
      const exitCode = Number.parseInt(afterMarker.slice(0, endIndex), 10);
      pending.exitCode = Number.isNaN(exitCode) ? 1 : exitCode;
      pending.buffer = afterMarker.slice(endIndex + 2);
      pending.done = true;
    }
    if (output) {
      pending.stdout += output;
      term(output);
    }
    if (pending.done) {
      finalizePending({
        code: pending.exitCode ?? 0,
        stdout: pending.stdout,
        stderr: pending.stderr,
      });
    }
  };

  const handleStderr = (data) => {
    const text = data.toString();
    const pending = session.pending;
    if (pending) {
      pending.stderr += text;
    }
    term(text);
  };

  child.stdout.on("data", handleStdout);
  child.stderr.on("data", handleStderr);
  child.on("error", (err) => {
    const message = `Failed to start command: ${err.message}\n`;
    if (session.pending) {
      session.pending.stderr += message;
      finalizePending({ code: 1, stdout: session.pending.stdout, stderr: session.pending.stderr });
    }
    term(message);
    session.closed = true;
  });
  child.on("close", (code) => {
    session.closed = true;
    if (session.pending) {
      const message = `Shell session ended unexpectedly (exit code ${code ?? "unknown"}).\n`;
      session.pending.stderr += message;
      finalizePending({ code: code ?? 1, stdout: session.pending.stdout, stderr: session.pending.stderr });
      term(message);
    }
  });

  child.stdin.write("set -o pipefail\n");
  return session;
}

function closeRunbookShell(session) {
  if (!session || session.closed) return;
  session.child.stdin.end("exit\n");
}

function runShellCommand(session, command) {
  if (!session || session.closed) {
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "Shell session is not available.\n",
    });
  }
  return new Promise((resolve) => {
    const token = `gac_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const marker = `__GAC_EXIT__${token}__:`;
    session.pending = {
      resolve,
      stdout: "",
      stderr: "",
      buffer: "",
      marker,
      done: false,
      exitCode: null,
    };
    session.child.stdin.write(`${command}\n`);
    session.child.stdin.write(`__gac_status=$?\n`);
    session.child.stdin.write(
      `printf "__GAC_EXIT__${token}__:%s__\\n" "$__gac_status"\n`
    );
  });
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", () => resolve(""));
  });
}

function buildCombinedPrompt(argPrompt, stdinContent) {
  if (argPrompt && stdinContent) return `${argPrompt}\n\n${stdinContent}`;
  return argPrompt || stdinContent;
}

function normalizeDefaultAction(action) {
  const normalized = String(action || "").trim().toLowerCase();
  if (normalized === "ask" || normalized === "suggest" || normalized === "explain") {
    return normalized;
  }
  return "suggest";
}

async function runSinglePrompt(mode, prompt, config) {
  const system = buildSystemPrompt(mode, config);
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
  messages.push({ role: "user", content: prompt });

  const reply = await chatCompletion(config, messages);
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

async function runRunbook(prompt, config) {
  const system = buildSystemPrompt("runbook", config);
  const messages = [
    { role: "system", content: system },
    { role: "system", content: `Relevant context:\n${buildRunbookContext()}` },
    { role: "user", content: prompt },
  ];
  const runbookConfig = {
    ...config,
    stream: false,
    renderMarkdown: false,
    debugRender: false,
  };

  const reply = await chatCompletion(runbookConfig, messages);
  const payload = extractJsonPayload(reply);
  let { commands, notes } = normalizeRunbookCommands(payload);

  if (!commands.length) {
    // Retry once with an explicit correction message — LLMs sometimes wrap
    // the JSON in markdown fences or add prose despite being told not to.
    const correctionMessages = [
      ...messages,
      { role: "assistant", content: reply },
      {
        role: "user",
        content:
          "Your response was not valid JSON. Please reply with valid JSON only, exactly matching the required shape. Do not include markdown, code fences, or any other text.",
      },
    ];
    const retryReply = await chatCompletion(runbookConfig, correctionMessages);
    const retryPayload = extractJsonPayload(retryReply);
    ({ commands, notes } = normalizeRunbookCommands(retryPayload));
  }

  if (!commands.length) {
    term("No runnable commands were returned. Try rephrasing your request.\n");
    return;
  }

  term("Planned commands:\n");
  printRunbookCommands(commands);
  if (notes.length) {
    term("\nNotes:\n");
    notes.forEach((note) => term(`- ${note}\n`));
  }
  term("\n");

  const ready = await confirmRunbookStep(
    "Press Enter to start running the runbook (any other key to cancel): "
  );
  if (!ready) {
    term("Runbook execution canceled.\n");
    return;
  }

  const blockedList = loadBlockedCommands();
  const shellSession = createRunbookShell();
  for (let i = 0; i < commands.length; i += 1) {
    const entry = commands[i];
    const blocked = findBlockedCommand(entry.command, blockedList);
    if (blocked) {
      term(
        `Blocked command detected in step ${i + 1}: "${entry.command}".\nReason: ${
          blocked.reason || "This command matches a guarded destructive pattern."
        }\n`
      );
      term("No command was run due to safety guards.\n");
      printRemainingCommands(commands, i);
      closeRunbookShell(shellSession);
      return;
    }

    term(`Step ${i + 1}:\n`);
    if (entry.description) {
      term(`${entry.description}\n`);
    }
    term(`Command: ${entry.command}\n`);
    const stepChoice = await confirmRunbookCommand();
    if (stepChoice === "cancel") {
      term(`Canceled at command ${i + 1}. Stopping.\n`);
      printRemainingCommands(commands, i);
      closeRunbookShell(shellSession);
      return;
    }
    if (stepChoice === "skip") {
      term(`Skipped step ${i + 1}.\n\n`);
      continue;
    }

    term(`\n$ ${entry.command}\n`);
    const result = await runShellCommand(shellSession, entry.command);
    if (result.code !== 0) {
      term(
        `\nCommand failed (step ${i + 1}) with exit code ${result.code}. Stopping.\n`
      );
      if (result.stderr.trim()) {
        term(`Stderr:\n${result.stderr}\n`);
      }
      const shouldDiagnose = await confirmRunbookStep(
        "Press Enter to ask the AI for a fix suggestion (any other key to skip): "
      );
      if (shouldDiagnose) {
        const diagMessages = [
          { role: "system", content: buildSystemPrompt("suggest", config) },
          {
            role: "user",
            content: `The following shell command failed with exit code ${result.code}:\n\n${entry.command}\n\nStdout:\n${result.stdout.trim() || "(empty)"}\n\nStderr:\n${result.stderr.trim() || "(empty)"}\n\nSuggest how to diagnose or fix this.`,
          },
        ];
        term("\nAI diagnosis:\n");
        const renderer = config.renderMarkdown
          ? createMarkdownRenderer(config.markdownStyles)
          : null;
        const diagReply = await chatCompletion(config, diagMessages);
        if (!config.stream) {
          term(renderer ? renderer.renderText(diagReply) : diagReply);
        }
        term("\n");
      }
      printRemainingCommands(commands, i + 1);
      closeRunbookShell(shellSession);
      return;
    }
    term("\n");
  }

  closeRunbookShell(shellSession);
  term("All commands completed successfully.\n");
}

async function confirmRunbookStep(label) {
  term(label);
  return new Promise((resolve) => {
    term.grabInput({ mouse: "button" });
    const onKey = (name) => {
      term.grabInput(false);
      term.removeListener("key", onKey);
      term("\n");
      resolve(name === "ENTER");
    };
    term.on("key", onKey);
  });
}

async function confirmRunbookCommand() {
  term("Press Enter to run, s to skip, or any other key to cancel: ");
  return new Promise((resolve) => {
    term.grabInput({ mouse: "button" });
    const onKey = (name) => {
      term.grabInput(false);
      term.removeListener("key", onKey);
      term("\n");
      if (name === "ENTER") resolve("run");
      else if (name === "s" || name === "S") resolve("skip");
      else resolve("cancel");
    };
    term.on("key", onKey);
  });
}

async function inputLine(label) {
  term(label);
  return new Promise((resolve) => {
    term.inputField({ cancelable: true }, (error, input) => {
      term("\n");
      if (error || input === undefined || input === null) {
        resolve("");
        return;
      }
      resolve(input.trim());
    });
  });
}

function formatConfigValue(value) {
  if (typeof value === "string") {
    if (!value) return "(empty)";
    if (value.length > 48) return `${value.slice(0, 45)}...`;
    return value;
  }
  return JSON.stringify(value);
}

function maskApiKey(apiKey) {
  if (!apiKey) return "(empty)";
  if (apiKey.length <= 6) return "***";
  return `${apiKey.slice(0, 3)}...${apiKey.slice(-3)}`;
}

async function promptConfigValue(label, currentValue) {
  term(`${label} [${formatConfigValue(currentValue)}]: `);
  return new Promise((resolve) => {
    term.inputField({ cancelable: true, default: String(currentValue ?? "") }, (error, input) => {
      term("\n");
      if (error || input === undefined || input === null) {
        resolve(null);
        return;
      }
      resolve(input.trim());
    });
  });
}

async function selectConfigProvider(config) {
  const options = [
    "OpenAI-compatible (includes GPT4All)",
    "Ollama",
  ];
  const currentIndex = config.provider === "ollama" ? 1 : 0;
  term("\nSelect provider:\n");
  return new Promise((resolve) => {
    term.singleColumnMenu(
      options,
      { cancelable: true, selectedIndex: currentIndex },
      (error, response) => {
        term("\n");
        if (error || !response || response.canceled) {
          resolve(null);
          return;
        }
        resolve(response.selectedIndex === 1 ? "ollama" : "openai");
      }
    );
  });
}

async function runConfigTui(config) {
  term("Config editor (Esc to exit)\n\n");
  let updatedConfig = { ...config };
  term.grabInput({ mouse: "button" });
  const cleanup = () => {
    term.grabInput(false);
    term.removeListener("key", onKey);
    term.hideCursor(false);
  };
  const onKey = (name) => {
    if (name === "CTRL_C") {
      cleanup();
      term("\nCanceled.\n");
      term.processExit(0);
    }
  };
  term.on("key", onKey);
  const menuLoop = async () => {
    const menuItems = [
      `Provider: ${updatedConfig.provider === "ollama" ? "Ollama" : "OpenAI-compatible"}`,
      `Base URL (OpenAI): ${formatConfigValue(updatedConfig.baseUrl)}`,
      `Base URL (Ollama): ${formatConfigValue(updatedConfig.ollamaBaseUrl)}`,
      `API Key: ${maskApiKey(updatedConfig.apiKey)}`,
      `Model: ${formatConfigValue(updatedConfig.model)}`,
      `Temperature: ${formatConfigValue(updatedConfig.temperature)}`,
      `Max Tokens: ${formatConfigValue(updatedConfig.maxTokens)}`,
      `Stream: ${formatConfigValue(updatedConfig.stream)}`,
      `Request Timeout (ms): ${formatConfigValue(updatedConfig.requestTimeoutMs)}`,
      `Default Action: ${formatConfigValue(updatedConfig.defaultAction)}`,
      `Render Markdown: ${formatConfigValue(updatedConfig.renderMarkdown)}`,
      `Debug Render: ${formatConfigValue(updatedConfig.debugRender)}`,
      `Detailed Suggest: ${formatConfigValue(updatedConfig.detailedSuggest)}`,
      `Detailed Context (explain/suggest): ${formatConfigValue(updatedConfig.detailedContext)}`,
      "Save and exit",
    ];

    return new Promise((resolve) => {
      term.singleColumnMenu(menuItems, { cancelable: true }, (error, response) => {
        term("\n");
        if (error || !response || response.canceled) {
          resolve(false);
          return;
        }
        resolve(response.selectedIndex);
      });
    });
  };

  while (true) {
    const selection = await menuLoop();
    if (selection === false) {
      cleanup();
      term("Config editor closed.\n");
      break;
    }

    if (selection === 0) {
      const provider = await selectConfigProvider(updatedConfig);
      if (provider) {
        setConfigValue("provider", provider);
        updatedConfig.provider = provider;
      }
      continue;
    }

    if (selection === 1) {
      const value = await promptConfigValue("OpenAI base URL", updatedConfig.baseUrl);
      if (value !== null) {
        setConfigValue("baseUrl", value);
        updatedConfig.baseUrl = value;
      }
      continue;
    }

    if (selection === 2) {
      const value = await promptConfigValue("Ollama base URL", updatedConfig.ollamaBaseUrl);
      if (value !== null) {
        setConfigValue("ollamaBaseUrl", value);
        updatedConfig.ollamaBaseUrl = value;
      }
      continue;
    }

    if (selection === 3) {
      term("API Key (leave empty to clear)\n");
      const value = await promptConfigValue("API key", updatedConfig.apiKey);
      if (value !== null) {
        setConfigValue("apiKey", value);
        updatedConfig.apiKey = value;
      }
      continue;
    }

    if (selection === 4) {
      const value = await promptConfigValue("Model", updatedConfig.model);
      if (value !== null) {
        setConfigValue("model", value);
        updatedConfig.model = value;
      }
      continue;
    }

    if (selection === 5) {
      const value = await promptConfigValue("Temperature", updatedConfig.temperature);
      if (value !== null) {
        setConfigValue("temperature", value);
        updatedConfig.temperature = value;
      }
      continue;
    }

    if (selection === 6) {
      const value = await promptConfigValue("Max Tokens", updatedConfig.maxTokens);
      if (value !== null) {
        setConfigValue("maxTokens", value);
        updatedConfig.maxTokens = value;
      }
      continue;
    }

    if (selection === 7) {
      const value = await promptConfigValue("Stream (true/false)", updatedConfig.stream);
      if (value !== null) {
        setConfigValue("stream", value);
        updatedConfig.stream = value;
      }
      continue;
    }

    if (selection === 8) {
      const value = await promptConfigValue(
        "Request timeout in ms (0 to disable)",
        updatedConfig.requestTimeoutMs
      );
      if (value !== null) {
        setConfigValue("requestTimeoutMs", value);
        updatedConfig.requestTimeoutMs = value;
      }
      continue;
    }

    if (selection === 9) {
      const value = await promptConfigValue(
        "Default action (suggest/ask/explain)",
        updatedConfig.defaultAction
      );
      if (value !== null) {
        setConfigValue("defaultAction", value);
        updatedConfig.defaultAction = value;
      }
      continue;
    }

    if (selection === 10) {
      const value = await promptConfigValue(
        "Render Markdown (true/false)",
        updatedConfig.renderMarkdown
      );
      if (value !== null) {
        setConfigValue("renderMarkdown", value);
        updatedConfig.renderMarkdown = value;
      }
      continue;
    }

    if (selection === 11) {
      const value = await promptConfigValue("Debug Render (true/false)", updatedConfig.debugRender);
      if (value !== null) {
        setConfigValue("debugRender", value);
        updatedConfig.debugRender = value;
      }
      continue;
    }

    if (selection === 12) {
      const value = await promptConfigValue(
        "Detailed Suggest (true/false)",
        updatedConfig.detailedSuggest
      );
      if (value !== null) {
        setConfigValue("detailedSuggest", value);
        updatedConfig.detailedSuggest = value;
      }
      continue;
    }

    if (selection === 13) {
      const value = await promptConfigValue(
        "Detailed Context (true/false)",
        updatedConfig.detailedContext
      );
      if (value !== null) {
        setConfigValue("detailedContext", value);
        updatedConfig.detailedContext = value;
      }
      continue;
    }

    if (selection === 14) {
      cleanup();
      term("Configuration saved.\n");
      break;
    }
  }
}

async function runChat(config) {
  term(`Interactive chat (${config.model}). Type /help for commands, exit to quit.\n\n`);
  const systemPrompt = buildSystemPrompt("chat", config);
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  term.grabInput({ mouse: "button" });
  const cleanupChatInput = () => {
    term.grabInput(false);
    term.removeListener("key", onKey);
  };
  const onKey = (name) => {
    if (name === "CTRL_C") {
      cleanupChatInput();
      term("\nBye.\n");
      term.processExit(0);
    }
  };
  term.on("key", onKey);

  while (true) {
    const prompt = await inputLine("You> ");
    if (!prompt) continue;
    if (prompt.toLowerCase() === "exit" || prompt.toLowerCase() === "quit") {
      cleanupChatInput();
      term("Bye.\n");
      break;
    }
    if (prompt.startsWith("/")) {
      if (prompt === "/clear") {
        messages.length = 0;
        if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
        term("Conversation cleared.\n\n");
      } else if (prompt === "/model") {
        term(`Model: ${config.model}\n\n`);
      } else if (prompt === "/help") {
        term("Commands: /clear (reset history), /model (show current model), exit or quit\n\n");
      } else {
        term(`Unknown command: ${prompt}. Type /help for available commands.\n\n`);
      }
      continue;
    }

    messages.push({ role: "user", content: prompt });
    term("A.I> ");
    const reply = await chatCompletion(config, messages);
    if (!config.stream) {
      if (config.renderMarkdown) {
        const renderer = createMarkdownRenderer(config.markdownStyles);
        term(renderer.renderText(reply));
      } else {
        term(reply);
      }
    }
    if (config.debugRender) {
      term(`\n--- RAW ---\n${reply}\n`);
    }
    if (!reply || !reply.trim()) {
      term(
        "\nNo response from the model. The request may have timed out or returned empty content. Consider increasing requestTimeoutMs in the config or enabling streaming."
      );
    }
    term("\n\n");
    if (reply && reply.trim()) {
      messages.push({ role: "assistant", content: reply });
    }
  }
}

async function runModels(config) {
  let models;
  try {
    models = await listModels(config);
  } catch (err) {
    term(`Error: ${err.message}\n`);
    term.processExit(1);
  }

  if (!models.length) {
    term("No models found from the configured provider.\n");
    term.processExit(0);
  }

  // Append option to keep current default at the top
  models.unshift("Keep current default");
  term("Select a default model (use arrows + Enter, Esc to cancel):\n");

  const currentIndex = Math.max(models.indexOf(config.model), 0);
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
      models,
      { cancelable: true, selectedIndex: currentIndex },
      (error, response) => {
        term("\n");
        if (error || !response || response.canceled) {
          cleanup();
          term("Selection canceled.\n");
          term.processExit(0);
        }
        let selected = models[response.selectedIndex];
        if (selected === "Keep current default") {
          cleanup();
          term(`Default model unchanged ("${config.model}").\n`);
          term.processExit(0);
        }
        setConfigValue("model", selected);
        config.model = selected;
        cleanup();
        term(`Default model set to "${selected}".\n`);
        term.processExit(0);
      }
    );
  });
}

export async function runCli(argv) {
  const args = argv.slice(2);
  const config = loadConfig();
  const stdinContent = await readStdin();
  const noRenderIndex = args.indexOf("--no-render");
  if (noRenderIndex !== -1) {
    config.renderMarkdown = false;
    args.splice(noRenderIndex, 1);
  }
  const debugRenderIndex = args.indexOf("--debug-render");
  if (debugRenderIndex !== -1) {
    config.debugRender = true;
    args.splice(debugRenderIndex, 1);
  }
  const detailedSuggestIndex = args.indexOf("--detailed-suggest");
  const shortDetailedSuggestIndex = args.indexOf("-d");

  if (detailedSuggestIndex !== -1 || shortDetailedSuggestIndex !== -1) {
    config.detailedSuggest = true;
    [detailedSuggestIndex, shortDetailedSuggestIndex]
      .filter((i) => i !== -1)
      .sort((a, b) => b - a)
      .forEach((i) => args.splice(i, 1));
  }
  const detailedContextIndex = args.indexOf("--detailed-context");
  const detailedContextAliasIndex = args.indexOf("--detailed-cont");
  if (detailedContextIndex !== -1 || detailedContextAliasIndex !== -1) {
    config.detailedContext = true;
    [detailedContextIndex, detailedContextAliasIndex]
      .filter((i) => i !== -1)
      .sort((a, b) => b - a)
      .forEach((i) => args.splice(i, 1));
  }

  const modelFlagIndex = args.indexOf("--model") !== -1
    ? args.indexOf("--model")
    : args.indexOf("-m");
  if (modelFlagIndex !== -1) {
    if (args[modelFlagIndex + 1] === undefined) {
      term("Error: --model/-m requires a model name argument.\n");
      term.processExit(1);
    }
    config.model = args[modelFlagIndex + 1];
    args.splice(modelFlagIndex, 2);
  }

  const tempFlagIndex = args.indexOf("--temperature") !== -1
    ? args.indexOf("--temperature")
    : args.indexOf("-t");
  if (tempFlagIndex !== -1) {
    if (args[tempFlagIndex + 1] === undefined) {
      term("Error: --temperature/-t requires a numeric value.\n");
      term.processExit(1);
    }
    const parsed = parseFloat(args[tempFlagIndex + 1]);
    if (Number.isNaN(parsed)) {
      term(`Error: --temperature/-t value must be a number, got "${args[tempFlagIndex + 1]}".\n`);
      term.processExit(1);
    }
    config.temperature = parsed;
    args.splice(tempFlagIndex, 2);
  }

  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return;
  }

  if (args.length === 0) {
    if (stdinContent) {
      const defaultAction = normalizeDefaultAction(config.defaultAction);
      await runSinglePrompt(defaultAction, stdinContent, config);
      return;
    }
    printHelp();
    return;
  }

  if (args[0] === "config") {
    if (args[1] === "tui") {
      await runConfigTui(config);
      return;
    }
    if (args[1] === "get" && args[2]) {
      const key = args[2];
      const parts = key.split(".");
      let value = config;
      for (const part of parts) {
        if (value === null || typeof value !== "object") { value = undefined; break; }
        value = value[part];
      }
      term(`${value === undefined ? "(not found)" : JSON.stringify(value, null, 2)}\n`);
      return;
    }
    if (args[1] === "set" && args[2] && args[3] !== undefined) {
      const updated = setConfigValue(args[2], args.slice(3).join(" "));
      term(`Updated ${args[2]} in ${getConfigPath()}\n`);
      term(`${JSON.stringify(updated, null, 2)}\n`);
      return;
    }

    term(`Config file: ${getConfigPath()}\n`);
    term(`${JSON.stringify(config, null, 2)}\n`);
    return;
  }

  if (args[0] === "chat") {
    await runChat(config);
    return;
  }

  if (args[0] === "models") {
    await runModels(config);
    return;
  }

  if (args[0] === "-a") {
    const prompt = buildCombinedPrompt(args.slice(1).join(" ").trim(), stdinContent);
    if (!prompt) {
      term("Error: missing prompt after -a.\n");
      term.processExit(1);
    }
    await runSinglePrompt("ask", prompt, config);
    return;
  }

  if (args[0] === "suggest" || args[0] === "explain" || args[0] === "ask") {
    const prompt = buildCombinedPrompt(args.slice(1).join(" ").trim(), stdinContent);
    if (!prompt) {
      term(`Error: missing prompt after ${args[0]}.\n`);
      term.processExit(1);
    }
    await runSinglePrompt(args[0], prompt, config);
    return;
  }

  if (args[0] === "runbook") {
    const prompt = buildCombinedPrompt(args.slice(1).join(" ").trim(), stdinContent);
    if (!prompt) {
      term("Error: missing prompt after runbook.\n");
      term.processExit(1);
    }
    await runRunbook(prompt, config);
    return;
  }

  if (!args[0].startsWith("-")) {
    const prompt = buildCombinedPrompt(args.join(" ").trim(), stdinContent);
    if (!prompt) {
      term("Error: missing prompt.\n");
      term.processExit(1);
    }
    const defaultAction = normalizeDefaultAction(config.defaultAction);
    await runSinglePrompt(defaultAction, prompt, config);
    return;
  }

  term("Unknown command.\n\n");
  printHelp();
}
