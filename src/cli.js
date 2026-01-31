import terminalKit from "terminal-kit";
import { chatCompletion, listModels } from "./gpt4all.js";
import { getConfigPath, loadConfig, setConfigValue } from "./config.js";
import { createMarkdownRenderer } from "./markdown.js";
import fs from "fs";
import os from "os";
import process from "process";
const { terminal: term } = terminalKit;

function printHelp() {
  term(`gac - OpenAI-compatible & Ollama CLI\n\n`);
  term(`Options:\n`);
  term(`  -a                Single prompt mode (alias for ask)\n`);
  term(`  suggest           Suggestion mode\n`);
  term(`  explain           Explanation mode\n`);
  term(`  ask               Ask mode\n`);
  term(`  chat              Interactive chat mode\n`);
  term(`  models            List models and set default\n`);
  term(`  config            View or edit configuration\n`);
  term(`  config tui        Open interactive config editor\n`);
  term(`  --no-render      Disable markdown rendering\n`);
  term(`  --debug-render   Show both rendered and raw output\n`);
  term(
    `  -d, --detailed-suggest  Provide more detailed suggestions (only in suggest mode)\n`
  );
  term(
    `  --detailed-context     Include current directory context in explain/suggest prompts\n`
  );
  term(`  -h, --help        Show this help message\n`);
  term(`\n`);
  term(`Usage:\n`);
  term(`  gac -a "Hello gpt4all"\n`);
  term(`  gac suggest "How do I connect to ssh server on port 5322"\n`);
  term(`  gac explain "How do I use rsync?"\n`);
  term(`  gac ask "What is the best way to learn JavaScript?"\n`);
  term(`  gac chat\n`);
  term(`  gac models\n`);
  term(`  gac config\n`);
  term(`  gac config tui\n`);
  term(`  gac config get <key>\n`);
  term(`  gac config set <key> <value>\n`);
  term(`  gac --no-render -a "Raw markdown output"\n`);
  term(`  gac --debug-render -a "Show rendered and raw output"\n`);
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
function buildSystemPrompt(mode, config) {
  const osInfo = getOSVersion();
  const osGuidance = `The user is using a system with the following OS: ${osInfo}. When providing commands or package install steps, use the native tooling for that OS (e.g., dnf for Fedora, apt for Debian/Ubuntu). Avoid giving instructions for other distros unless explicitly requested.`;

  if (mode === "suggest") {
    if (config.detailedSuggest === true) {
      return `You are an expert technical assistant. ${osGuidance} When providing suggestions, give detailed, step-by-step instructions that the user can follow to achieve their goals. Include relevant commands, code snippets, or configurations as needed. Avoid unnecessary explanations or background information. Tailor your suggestions to be relevant to the user's operating system and environment.
Attempt to make it a single line response where possible. Prefer commands and code snippets over lengthy explanations. Always leave commands and codes in their own line for easy copying.`;
    } else {
      return `You are an expert technical assistant. ${osGuidance} Provide concise and practical suggestions to help the user accomplish their tasks efficiently. Focus on clarity and brevity, ensuring that your suggestions are easy to understand and implement. Tailor your suggestions to be relevant to the user's operating system and environment. Avoid lengthy explanations or unnecessary details prefer single line commands or codes if you must include explainations make sure the commands and codes are in their own line for easy copying.`;
    }
  }
  if (mode === "ask") {
    return `Provide a helpful and accurate response to the user's question. ${osGuidance}`;
  }
  if (mode === "explain") {
    return `Explain step-by-step with a short example if helpful. ${osGuidance}`;
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
  term('Interactive chat. Type "exit" to quit.\n\n');
  const messages = [];
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
    messages.push({ role: "assistant", content: reply });
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

  term("Available models:\n");
  // Append option to keep current default at the top
  models.unshift("Keep current default");
  models.forEach((model) => term(`- ${model}\n`));
  term("\nSelect a default model (use arrows + Enter, Esc to cancel):\n");

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
    if (detailedSuggestIndex !== -1) {
      args.splice(detailedSuggestIndex, 1);
    }
    if (shortDetailedSuggestIndex !== -1) {
      args.splice(shortDetailedSuggestIndex, 1);
    }
  }
  const detailedContextIndex = args.indexOf("--detailed-context");
  const detailedContextAliasIndex = args.indexOf("--detailed-cont");
  if (detailedContextIndex !== -1 || detailedContextAliasIndex !== -1) {
    config.detailedContext = true;
    if (detailedContextIndex !== -1) {
      args.splice(detailedContextIndex, 1);
    }
    if (detailedContextAliasIndex !== -1) {
      args.splice(detailedContextAliasIndex, 1);
    }
  }

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
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
      term(`${config[key]}\n`);
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
    const prompt = args.slice(1).join(" ").trim();
    if (!prompt) {
      term("Error: missing prompt after -a.\n");
      term.processExit(1);
    }
    await runSinglePrompt("ask", prompt, config);
    return;
  }

  if (args[0] === "suggest" || args[0] === "explain" || args[0] === "ask") {
    const prompt = args.slice(1).join(" ").trim();
    if (!prompt) {
      term(`Error: missing prompt after ${args[0]}.\n`);
      term.processExit(1);
    }
    await runSinglePrompt(args[0], prompt, config);
    return;
  }

  if (!args[0].startsWith("-")) {
    const prompt = args.join(" ").trim();
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
