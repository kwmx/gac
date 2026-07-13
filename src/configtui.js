import terminalKit from "terminal-kit";
import { setConfigValue } from "./config.js";

const { terminal: term } = terminalKit;

export function formatConfigValue(value) {
  if (typeof value === "string") {
    if (!value) return "(empty)";
    if (value.length > 48) return `${value.slice(0, 45)}...`;
    return value;
  }
  return JSON.stringify(value);
}

export function maskApiKey(apiKey) {
  if (!apiKey) return "(empty)";
  if (apiKey.length <= 6) return "***";
  return `${apiKey.slice(0, 3)}...${apiKey.slice(-3)}`;
}

async function promptConfigValue(label, currentValue) {
  term(`${label} [${formatConfigValue(currentValue)}]: `);
  return new Promise((resolve) => {
    term.inputField(
      { cancelable: true, default: String(currentValue ?? "") },
      (error, input) => {
        term("\n");
        if (error || input === undefined || input === null) {
          resolve(null);
          return;
        }
        resolve(input.trim());
      }
    );
  });
}

const PROVIDERS = [
  { value: "openai", label: "OpenAI-compatible (includes GPT4All)" },
  { value: "ollama", label: "Ollama" },
  { value: "codex", label: "OpenAI Codex (ChatGPT plan, via gac auth login)" },
];

export function providerLabel(provider) {
  const entry = PROVIDERS.find((item) => item.value === provider);
  return entry ? entry.label : PROVIDERS[0].label;
}

async function selectConfigProvider(config) {
  const options = PROVIDERS.map((item) => item.label);
  const currentIndex = Math.max(
    PROVIDERS.findIndex((item) => item.value === config.provider),
    0
  );
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
        resolve(PROVIDERS[response.selectedIndex].value);
      }
    );
  });
}

const FIELDS = [
  { key: "provider", label: "Provider", kind: "provider" },
  { key: "baseUrl", label: "Base URL (OpenAI)", prompt: "OpenAI base URL" },
  { key: "ollamaBaseUrl", label: "Base URL (Ollama)", prompt: "Ollama base URL" },
  {
    key: "apiKey",
    label: "API Key",
    prompt: "API key",
    mask: true,
    note: "API Key (leave empty to clear)",
  },
  { key: "model", label: "Model", prompt: "Model" },
  {
    key: "codexModel",
    label: "Codex Model",
    prompt: "Codex model (used only when provider is codex)",
  },
  { key: "temperature", label: "Temperature", prompt: "Temperature" },
  { key: "maxTokens", label: "Max Tokens", prompt: "Max Tokens" },
  {
    key: "contextWindow",
    label: "Context Window",
    prompt: 'Context window ("auto" or a number of tokens)',
  },
  { key: "stream", label: "Stream", prompt: "Stream (true/false)" },
  {
    key: "requestTimeoutMs",
    label: "Request Timeout (ms)",
    prompt: "Request timeout in ms (0 to disable)",
  },
  {
    key: "defaultAction",
    label: "Default Action",
    prompt: "Default action (suggest/ask/explain)",
  },
  {
    key: "renderMarkdown",
    label: "Render Markdown",
    prompt: "Render Markdown (true/false)",
  },
  { key: "debugRender", label: "Debug Render", prompt: "Debug Render (true/false)" },
  {
    key: "showThinking",
    label: "Show Thinking",
    prompt: "Show model thinking while streaming (true/false)",
  },
  {
    key: "detailedSuggest",
    label: "Detailed Suggest",
    prompt: "Detailed Suggest (true/false)",
  },
  {
    key: "detailedContext",
    label: "Detailed Context (explain/suggest)",
    prompt: "Detailed Context (true/false)",
  },
];

export async function runConfigTui(config) {
  term("Config editor (Esc to exit)\n\n");
  const updatedConfig = { ...config };
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

  const fieldLabel = (field) => {
    if (field.kind === "provider") {
      return `Provider: ${providerLabel(updatedConfig.provider)}`;
    }
    const value = field.mask
      ? maskApiKey(updatedConfig[field.key])
      : formatConfigValue(updatedConfig[field.key]);
    return `${field.label}: ${value}`;
  };

  const menuLoop = async () => {
    const menuItems = [...FIELDS.map(fieldLabel), "Save and exit"];
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

    if (selection === FIELDS.length) {
      cleanup();
      term("Configuration saved.\n");
      break;
    }

    const field = FIELDS[selection];
    if (field.kind === "provider") {
      const provider = await selectConfigProvider(updatedConfig);
      if (provider) {
        setConfigValue("provider", provider);
        updatedConfig.provider = provider;
      }
      continue;
    }

    if (field.note) term(`${field.note}\n`);
    const value = await promptConfigValue(field.prompt, updatedConfig[field.key]);
    if (value !== null) {
      setConfigValue(field.key, value);
      updatedConfig[field.key] = value;
    }
  }
}
