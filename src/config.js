import fs from "fs";
import path from "path";
import os from "os";

const DEFAULT_CONFIG = {
  // "openai" (any OpenAI-compatible server), "ollama", or "codex"
  // (OpenAI Codex via ChatGPT-plan OAuth — sign in with `gac auth login`).
  provider: "openai",
  baseUrl: "http://localhost:4891",
  ollamaBaseUrl: "http://localhost:11434",
  codexBaseUrl: "https://chatgpt.com/backend-api/codex",
  apiKey: "",
  model: "gpt4all",
  // Model used only when provider is "codex"; kept separate from `model` so
  // switching providers back and forth never breaks either setup. `gac models`
  // reads the live per-account catalog, so this is only a starting default.
  codexModel: "gpt-5.6-sol",
  // Optional override for the Codex CLI version claimed when listing models
  // (see CODEX_CLIENT_VERSION). null means use gac's always-ahead default so new
  // model generations surface automatically; set a real "x.y.z" only if needed.
  codexClientVersion: null,
  temperature: 0.7,
  // "auto" takes the response cap from the selected model's definition
  // (re-detected when the model changes) and falls back to 2048 when the
  // backend reports none. A positive number pins the cap; 0 or less removes
  // it so the model can answer as long as necessary.
  maxTokens: "auto",
  // "auto" probes the backend for the model's context length (Ollama
  // /api/show, or context metadata in /v1/models); a number pins it manually.
  contextWindow: "auto",
  stream: true,
  requestTimeoutMs: 300000,
  defaultAction: "suggest",
  renderMarkdown: true,
  debugRender: false,
  detailedSuggest: false,
  detailedContext: false,
  showThinking: true,
  markdownStyles: {
    headerStyles: ["bold"],
    headerStylesByLevel: {
      1: ["bold", "brightWhite"],
      2: ["bold"],
      3: ["bold"],
      4: ["dim"],
      5: ["dim"],
      6: ["dim"],
    },
    headerUnderline: true,
    headerUnderlineLevels: [1],
    headerUnderlineStyle: ["dim"],
    headerUnderlineChar: "─",
    codeStyles: ["cyan"],
    codeBackground: ["bgBlack"],
    codeBorder: true,
    codeBorderStyle: ["dim"],
    codeGutter: "│ ",
    codeBorderChars: {
      topLeft: "┌",
      top: "─",
      topRight: "┐",
      bottomLeft: "└",
      bottom: "─",
      bottomRight: "┘",
    },
    syntaxHighlight: true,
    syntaxStyles: {
      keyword: ["brightWhite", "bold"],
      string: ["brightGreen"],
      comment: ["dim"],
      number: ["brightYellow"],
    },
    tableBorderStyle: ["dim"],
    tableHeaderStyles: ["bold"],
  },
};

const HOME_CONFIG_DIR = path.join(os.homedir(), ".gac");
const FALLBACK_CONFIG_DIR = path.join(process.cwd(), ".gac");
let resolvedConfigDir = null;

// The config file can hold an API key, so it is kept private: 0700 on the
// directory, 0600 on the file. These are honored on POSIX and silently ignored
// where unsupported (e.g. Windows).
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Config keys whose values must never be printed in plaintext. Matched against
// the final dotted segment so nested lookups (e.g. "apiKey") are covered too.
const SECRET_CONFIG_KEYS = new Set(["apiKey"]);
const REDACTED_PRESENT = "[configured]";
const REDACTED_ABSENT = "[not configured]";

// Best-effort chmod: correcting permissions must never crash GAC on a
// filesystem or platform that does not support it.
function chmodSafe(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    // Windows / unsupported filesystems: ignore.
  }
}

function makeConfigDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  // mkdir only applies `mode` on creation (and it is masked by umask), so
  // tighten an existing/created directory back to 0700 where supported.
  chmodSafe(dir, DIR_MODE);
}

function resolveConfigDir() {
  if (resolvedConfigDir) return resolvedConfigDir;

  try {
    makeConfigDir(HOME_CONFIG_DIR);
    resolvedConfigDir = HOME_CONFIG_DIR;
    return resolvedConfigDir;
  } catch (err) {
    // Fall back to local config if home is not writable.
  }

  try {
    makeConfigDir(FALLBACK_CONFIG_DIR);
    resolvedConfigDir = FALLBACK_CONFIG_DIR;
    return resolvedConfigDir;
  } catch (err) {
    resolvedConfigDir = HOME_CONFIG_DIR;
    return resolvedConfigDir;
  }
}

// True when a config key holds a secret that must not be printed.
export function isSecretConfigKey(key) {
  const parts = String(key).split(".");
  return SECRET_CONFIG_KEYS.has(parts[parts.length - 1]);
}

// Reduce a secret to a safe presence indicator. Never returns the value.
export function redactApiKey(value) {
  return value ? REDACTED_PRESENT : REDACTED_ABSENT;
}

// Return a shallow copy of the config with every secret replaced by a safe
// presence indicator. All non-secret values are preserved untouched. This is
// the single source of truth for masking; callers must never hand-roll it.
export function redactConfig(config) {
  const redacted = { ...config };
  for (const key of Object.keys(redacted)) {
    if (isSecretConfigKey(key)) redacted[key] = redactApiKey(redacted[key]);
  }
  return redacted;
}

export function getConfigPath() {
  return path.join(resolveConfigDir(), "config.json");
}

export function loadConfig() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (err) {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config) {
  const normalized = { ...DEFAULT_CONFIG, ...config };
  const configPath = getConfigPath();
  const body = JSON.stringify(normalized, null, 2);

  // Write to a sibling temp file (same directory, so rename is atomic) with a
  // private mode, then move it into place. This avoids ever exposing a
  // world-readable window and leaves no half-written config behind on crash.
  const tmpPath = `${configPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, body, { mode: FILE_MODE });
    chmodSafe(tmpPath, FILE_MODE);
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    // Rename can fail on some filesystems (e.g. cross-device); fall back to a
    // direct write so config still persists.
    try {
      fs.unlinkSync(tmpPath);
    } catch (cleanupErr) {
      // Nothing to clean up.
    }
    fs.writeFileSync(configPath, body, { mode: FILE_MODE });
  }

  // Correct permissions on the final file even when it already existed (an
  // existing file keeps its old mode through writeFileSync). Best-effort.
  chmodSafe(configPath, FILE_MODE);
}

export function coerceValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      // Fall through to string handling.
    }
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (!Number.isNaN(Number(trimmed)) && trimmed !== "") return Number(trimmed);
  return value;
}

export function getConfigValue(key) {
  const config = loadConfig();
  const parts = key.split(".");
  let cursor = config;
  for (const part of parts) {
    if (cursor && typeof cursor === "object" && part in cursor) {
      cursor = cursor[part];
    } else {
      return undefined;
    }
  }
  return cursor;
}

export function setConfigValue(key, value) {
  const config = loadConfig();
  const normalizedValue = coerceValue(value);
  const parts = key.split(".");
  let cursor = config;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (typeof cursor[part] !== "object" || cursor[part] === null) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = normalizedValue;
  saveConfig(config);
  return config;
}
