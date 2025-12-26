import fs from "fs";
import path from "path";
import os from "os";

const DEFAULT_CONFIG = {
  baseUrl: "http://localhost:4891",
  model: "gpt4all",
  temperature: 0.7,
  maxTokens: 512,
  stream: true,
  renderMarkdown: true,
  debugRender: false,
  detailedSuggest: false,
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
  },
};

const HOME_CONFIG_DIR = path.join(os.homedir(), ".gac");
const FALLBACK_CONFIG_DIR = path.join(process.cwd(), ".gac");
let resolvedConfigDir = null;

function resolveConfigDir() {
  if (resolvedConfigDir) return resolvedConfigDir;

  try {
    fs.mkdirSync(HOME_CONFIG_DIR, { recursive: true });
    resolvedConfigDir = HOME_CONFIG_DIR;
    return resolvedConfigDir;
  } catch (err) {
    // Fall back to local config if home is not writable.
  }

  try {
    fs.mkdirSync(FALLBACK_CONFIG_DIR, { recursive: true });
    resolvedConfigDir = FALLBACK_CONFIG_DIR;
    return resolvedConfigDir;
  } catch (err) {
    resolvedConfigDir = HOME_CONFIG_DIR;
    return resolvedConfigDir;
  }
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
  fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2));
}

function coerceValue(value) {
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
