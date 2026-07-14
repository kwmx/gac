import fs from "fs";
import path from "path";
import {
  normalizeOpenAiBaseUrl,
  normalizeOllamaBaseUrl,
  buildOpenAiHeaders,
} from "./gpt4all.js";
import { getConfigPath } from "./config.js";

// Used when the backend does not report a context length and the user has not
// configured one. Most current local models handle at least 8k tokens.
export const FALLBACK_CONTEXT_TOKENS = 8192;
// The Codex backend has no metadata endpoint; the GPT-5 family it serves
// accepts ~272k input tokens. A numeric `contextWindow` config still wins.
export const CODEX_CONTEXT_TOKENS = 272000;
// Tokens reserved as slack between the estimated prompt size and the real one.
export const TRIM_MARGIN_TOKENS = 256;
const RESPONSE_MARGIN_TOKENS = 64;
const MIN_RESPONSE_TOKENS = 128;
const DETECT_TIMEOUT_MS = 2500;
const OLLAMA_DEFAULT_NUM_CTX = 4096;
// Detection results are persisted so one-shot CLI invocations don't re-probe
// the backend every time. Failures get a short TTL so a backend that comes up
// later is retried soon.
const DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DISK_CACHE_FAILURE_TTL_MS = 10 * 60 * 1000;

// Rough heuristic (~4 chars per token). Estimates only steer trimming and
// num_ctx sizing, so being slightly conservative is fine.
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

export function estimateMessageTokens(message) {
  if (!message) return 0;
  // Small fixed overhead per message for role markers / chat template tokens.
  return estimateTokens(message.content) + 4;
}

export function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

// Ollama `/api/show` reports the model's maximum context both as an explicit
// `num_ctx` modelfile parameter (when set) and as `<arch>.context_length`
// inside model_info. An explicit num_ctx wins because that is what the model
// actually runs with by default.
export function pickOllamaContextLength(showJson) {
  if (!showJson || typeof showJson !== "object") return null;
  const params = typeof showJson.parameters === "string" ? showJson.parameters : "";
  const numCtxMatch = params.match(/(?:^|\n)\s*num_ctx\s+"?(\d+)"?/);
  if (numCtxMatch) {
    const value = Number(numCtxMatch[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const info = showJson.model_info;
  if (info && typeof info === "object") {
    for (const [key, value] of Object.entries(info)) {
      if (key.endsWith(".context_length")) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) return numeric;
      }
    }
  }
  return null;
}

// Several OpenAI-compatible servers expose the context size in /v1/models
// under different names: LM Studio uses max_context_length, OpenRouter uses
// context_length, others use context_window.
export function pickOpenAiContextLength(modelEntry) {
  if (!modelEntry || typeof modelEntry !== "object") return null;
  const candidates = [
    modelEntry.max_context_length,
    modelEntry.context_length,
    modelEntry.context_window,
    modelEntry.max_context_window,
    modelEntry.loaded_context_length,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return null;
}

const detectionCache = new Map();

function detectionKey(config) {
  const provider = config.provider === "ollama" ? "ollama" : "openai";
  const base = provider === "ollama" ? config.ollamaBaseUrl : config.baseUrl;
  return `${provider}|${base}|${config.model}`;
}

function diskCachePath() {
  return path.join(path.dirname(getConfigPath()), "context-cache.json");
}

function readDiskCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(diskCachePath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    return {};
  }
}

function readDiskCacheEntry(key) {
  const entry = readDiskCache()[key];
  if (!entry || typeof entry !== "object") return undefined;
  const age = Date.now() - Number(entry.ts || 0);
  const ttl = entry.value === null ? DISK_CACHE_FAILURE_TTL_MS : DISK_CACHE_TTL_MS;
  if (!(age >= 0 && age < ttl)) return undefined;
  return entry.value;
}

function writeDiskCacheEntry(key, value) {
  try {
    const cache = readDiskCache();
    cache[key] = { value, ts: Date.now() };
    fs.writeFileSync(diskCachePath(), JSON.stringify(cache, null, 2));
  } catch (err) {
    // Best-effort: a read-only config dir just means we re-probe next run.
  }
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Ask the backend how large the model's context window is. Best-effort: any
// failure (endpoint missing, timeout, unexpected shape) resolves to null.
// Results are cached in-process and on disk (gac is a one-shot CLI, so the
// disk cache is what actually prevents a probe per invocation).
export async function detectContextWindow(config) {
  if (config.provider === "codex") {
    return CODEX_CONTEXT_TOKENS;
  }
  const key = detectionKey(config);
  if (detectionCache.has(key)) return detectionCache.get(key);

  const cached = readDiskCacheEntry(key);
  if (cached !== undefined) {
    detectionCache.set(key, cached);
    return cached;
  }

  let detected = null;
  try {
    if (config.provider === "ollama") {
      const baseUrl = normalizeOllamaBaseUrl(config.ollamaBaseUrl);
      const response = await fetchWithTimeout(`${baseUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Older Ollama versions expect "name", newer ones "model".
        body: JSON.stringify({ model: config.model, name: config.model }),
      });
      if (response.ok) {
        detected = pickOllamaContextLength(await response.json());
      }
    } else {
      const url = `${normalizeOpenAiBaseUrl(config.baseUrl)}/models`;
      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: buildOpenAiHeaders(config.apiKey),
      });
      if (response.ok) {
        const json = await response.json();
        const entries = Array.isArray(json?.data) ? json.data : [];
        const entry = entries.find((item) => item && item.id === config.model);
        detected = pickOpenAiContextLength(entry);
      }
    }
  } catch (err) {
    detected = null;
  }

  detectionCache.set(key, detected);
  writeDiskCacheEntry(key, detected);
  return detected;
}

// Resolve the context window to plan around: an explicit numeric config value
// wins (numeric strings from hand-edited configs are coerced); "auto" (the
// default) probes the backend; anything else falls back to auto-detection so
// a typo degrades gracefully instead of silently disabling the feature.
export async function resolveContextWindow(config) {
  const configured = config?.contextWindow;
  if (configured !== "auto" && configured !== undefined && configured !== null) {
    const numeric = Number(configured);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
  }
  return detectContextWindow(config);
}

// Tokens available for the prompt once the response reservation is taken out.
// An uncapped maxTokens (<= 0, meaning "answer as long as necessary") still
// reserves the 2048-token default so prompt trimming leaves the response a
// sane amount of room.
export function contextBudget(contextWindow, maxTokens) {
  const window = contextWindow || FALLBACK_CONTEXT_TOKENS;
  const reserve = Number(maxTokens) > 0 ? Number(maxTokens) : 2048;
  return Math.max(512, window - reserve - TRIM_MARGIN_TOKENS);
}

// Drop the oldest non-system messages until the estimated prompt fits the
// budget. System messages always survive, and so does the newest message even
// if it alone exceeds the budget (there is nothing useful to send otherwise).
export function trimMessagesToBudget(messages, budgetTokens) {
  if (!Array.isArray(messages)) return { messages: [], dropped: 0 };
  const system = messages.filter((m) => m && m.role === "system");
  const rest = messages.filter((m) => m && m.role !== "system");

  let used = estimateMessagesTokens(system);
  const kept = [];
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const cost = estimateMessageTokens(rest[i]);
    if (kept.length > 0 && used + cost > budgetTokens) break;
    used += cost;
    kept.unshift(rest[i]);
  }

  return { messages: [...system, ...kept], dropped: rest.length - kept.length };
}

// Compute the per-request generation limits: the response token cap (clamped
// so prompt + response fit the window) and, for Ollama, a num_ctx sized to the
// conversation instead of the model maximum, so large-context models don't
// balloon memory for short chats.
export function resolveGenerationBudget(config, messages, contextWindow) {
  const raw = Number(config?.maxTokens);
  // A maxTokens explicitly configured at 0 or below means "no response cap":
  // the model may answer as long as it needs, bounded only by its context
  // window. maxTokens is null so providers omit the cap from the request; the
  // full window goes to num_ctx because the reply may legitimately fill
  // whatever the prompt leaves.
  if (config?.maxTokens != null && Number.isFinite(raw) && raw <= 0) {
    return { maxTokens: null, numCtx: contextWindow || null };
  }
  const configured = raw > 0 ? Math.floor(raw) : 2048;
  if (!contextWindow) {
    return { maxTokens: configured, numCtx: null };
  }
  const promptTokens = estimateMessagesTokens(messages);
  const available = contextWindow - promptTokens - RESPONSE_MARGIN_TOKENS;
  // The floor never raises a deliberately small configured cap (e.g. the
  // 12-token budget used for chat title generation).
  const floor = Math.min(configured, MIN_RESPONSE_TOKENS);
  const maxTokens = Math.max(floor, Math.min(configured, available));
  // Quantize num_ctx to power-of-two steps: Ollama reloads the model whenever
  // num_ctx changes, so tracking the exact prompt size would force a reload
  // on every chat turn. Doubling steps keep it stable for long stretches.
  const needed = Math.max(
    OLLAMA_DEFAULT_NUM_CTX,
    promptTokens + maxTokens + TRIM_MARGIN_TOKENS
  );
  let quantized = OLLAMA_DEFAULT_NUM_CTX;
  while (quantized < needed) quantized *= 2;
  const numCtx = Math.min(contextWindow, quantized);
  return { maxTokens, numCtx };
}
