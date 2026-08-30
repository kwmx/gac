import terminalKit from "terminal-kit";
import { setConfigValue } from "./config.js";
import { CONSENT_STATEMENT } from "./telemetry/consent.js";
import {
  forceExitFromCtrlC,
  promptInputLine,
  promptYesNo,
  withCancelableKeyBindings,
} from "./tui.js";

const { terminal: term } = terminalKit;

// The menu label for the telemetry toggle, reflecting the current effective
// state and any environment suppression. Pure and exported for testing.
export function telemetryMenuLabel(status) {
  if (!status) return "Telemetry: (unknown)";
  let label = `Telemetry: ${status.effectiveState}`;
  if (status.suppression && status.suppression.suppressed) {
    label += ` (suppressed by ${status.suppression.reasons.join(", ")})`;
  }
  return label;
}

// Selecting the telemetry row toggles it: an enabled installation is disabled,
// anything else (disabled/declined/undecided) is enabled after showing consent.
// Pure and exported for testing.
export function telemetryToggleAction(decision) {
  return decision === "enabled" ? "disable" : "enable";
}

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

// Build the terminal-kit inputField options for a field. Secret fields
// (field.mask) are never pre-filled with the current value and mask keystrokes
// with an echo character; normal fields keep the current value as an editable
// default. Kept pure and exported so the no-raw-key-default rule is testable.
export function buildFieldInputOptions(field, currentValue) {
  if (field && field.mask) {
    return withCancelableKeyBindings({ echoChar: "•" });
  }
  return withCancelableKeyBindings({ default: String(currentValue ?? "") });
}

// Decide what an API-key edit means. Empty input keeps the existing key;
// "clear" (case-insensitive) removes it; anything else sets the new key.
// Returning null (canceled) also keeps the key. Pure and exported for testing.
export function resolveApiKeyEdit(input, currentValue) {
  if (input === null || input === undefined) return { action: "keep" };
  const trimmed = String(input).trim();
  if (trimmed === "") return { action: "keep" };
  if (trimmed.toLowerCase() === "clear") return { action: "clear", value: "" };
  return { action: "set", value: trimmed };
}

async function promptFieldValue(field, currentValue) {
  // Secret fields show only their prompt — the current value is never rendered.
  const suffix = field.mask ? "" : ` [${formatConfigValue(currentValue)}]`;
  return promptInputLine(`${field.prompt}${suffix}: `, buildFieldInputOptions(field, currentValue), {
    cancelValue: null,
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
    prompt: "New API key",
    mask: true,
    note: 'API Key — leave empty to keep the current key, type "clear" to remove it.',
  },
  { key: "model", label: "Model", prompt: "Model" },
  {
    key: "codexModel",
    label: "Codex Model",
    prompt: "Codex model (used only when provider is codex)",
  },
  { key: "temperature", label: "Temperature", prompt: "Temperature" },
  {
    key: "maxTokens",
    label: "Max Tokens",
    prompt: 'Max Tokens ("auto" = model\'s own limit, a number pins it, 0 or less = no limit)',
  },
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

export async function runConfigTui(config, deps = {}) {
  const telemetry = deps.telemetry || null;
  const hasTelemetry = Boolean(telemetry);
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
      forceExitFromCtrlC();
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

  // Telemetry sits between the config fields and "Save and exit" when a
  // telemetry handle is available. Its index shifts everything after it by one.
  const telemetryIndex = hasTelemetry ? FIELDS.length : -1;
  const saveIndex = FIELDS.length + (hasTelemetry ? 1 : 0);

  const toggleTelemetry = async () => {
    const decision = telemetry.getEffectiveDecision();
    if (telemetryToggleAction(decision) === "disable") {
      await telemetry.disable();
      term(
        "Telemetry disabled. Queued events and the local installation identifier were removed.\n"
      );
      return;
    }
    term(`\n${CONSENT_STATEMENT}\n\n`);
    const ok = await promptYesNo("Enable telemetry? [y/N] ");
    if (ok === null) {
      term("Canceled.\n");
      return;
    }
    if (!ok) {
      term("Telemetry not enabled.\n");
      return;
    }
    await telemetry.enable({ action: "manual_command" });
    term(
      "Telemetry enabled. Thank you — this helps prioritize features and improve reliability.\n" +
        "It stays on across updates until you disable it here or with `gac telemetry disable`.\n"
    );
  };

  const menuLoop = async () => {
    const menuItems = [
      ...FIELDS.map(fieldLabel),
      ...(hasTelemetry ? [telemetryMenuLabel(telemetry.getStatus())] : []),
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

    if (selection === saveIndex) {
      cleanup();
      term("Configuration saved.\n");
      break;
    }

    if (hasTelemetry && selection === telemetryIndex) {
      await toggleTelemetry();
      continue;
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

    if (field.mask) {
      // Secret field: input is masked and never seeded with the current key.
      const input = await promptFieldValue(field, updatedConfig[field.key]);
      const edit = resolveApiKeyEdit(input, updatedConfig[field.key]);
      if (edit.action === "keep") continue;
      setConfigValue(field.key, edit.value);
      updatedConfig[field.key] = edit.value;
      continue;
    }

    const value = await promptFieldValue(field, updatedConfig[field.key]);
    if (value !== null) {
      setConfigValue(field.key, value);
      updatedConfig[field.key] = value;
    }
  }
}
