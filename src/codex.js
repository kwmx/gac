import { randomUUID } from "crypto";
import terminalKit from "terminal-kit";
import { createMarkdownRenderer } from "./markdown.js";
import { getCodexCredentials } from "./codexauth.js";

const { terminal: term } = terminalKit;

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";

// Codex CLI version claimed to the backend when listing models. The `/models`
// endpoint hides any model whose `minimal_client_version` is higher than this,
// so a fixed real version would stop surfacing the next model generation the
// moment OpenAI ships it. We instead claim an always-ahead sentinel so every
// model the account's plan is entitled to shows up automatically — no code bump
// needed as OpenAI rotates models. Override with `gac config set
// codexClientVersion <x.y.z>` on the rare chance the backend ever wants a real
// version.
export const CODEX_CLIENT_VERSION = "9999.0.0";

export function resolveCodexClientVersion(config) {
  const version =
    typeof config?.codexClientVersion === "string" ? config.codexClientVersion.trim() : "";
  return version || CODEX_CLIENT_VERSION;
}

// Static fallback used only when the live `/models` endpoint (see
// fetchCodexModels) can't be reached. OpenAI rotates which models a ChatGPT
// plan may use, retiring old ids with a 400 ("...not supported when using Codex
// with a ChatGPT account"), so this list will drift over time — the live
// endpoint is authoritative. Any Responses-capable id can still be set manually
// via `gac config set codexModel <id>`.
export const CODEX_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
];

// One id per process: reused as session/prompt-cache key across requests so
// multi-turn chats hit the backend's prompt cache.
const sessionId = randomUUID();

export function normalizeCodexBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/$/, "");
  return trimmed || DEFAULT_CODEX_BASE_URL;
}

// Codex keeps its own model key so flipping `provider` back and forth never
// clobbers the openai/ollama model (and vice versa).
export function resolveCodexModel(config) {
  const model = typeof config?.codexModel === "string" ? config.codexModel.trim() : "";
  return model || DEFAULT_CODEX_MODEL;
}

export function listCodexModels() {
  return [...CODEX_MODELS];
}

// Live model list for the signed-in ChatGPT account. The backend exposes an
// authoritative, plan-filtered catalog at `/models` — unlike the static
// CODEX_MODELS fallback it reflects exactly what the account can use right now,
// so gac never offers a model the plan has since retired. Returns slugs of the
// user-selectable ("list") models, most-preferred first. Throws on
// auth/network/backend failure; callers fall back to listCodexModels().
export async function fetchCodexModels(config) {
  const base = normalizeCodexBaseUrl(config?.codexBaseUrl);
  const clientVersion = resolveCodexClientVersion(config);
  const url = `${base}/models?client_version=${encodeURIComponent(clientVersion)}`;
  const { accessToken, accountId } = await getCodexCredentials();
  const configTimeout = Number(config?.requestTimeoutMs);
  const timeoutMs =
    Number.isFinite(configTimeout) && configTimeout > 0
      ? Math.min(configTimeout, 30000)
      : 30000;
  const timeout = createTimeoutController(timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        originator: "codex_cli_rs",
      },
      signal: timeout ? timeout.controller.signal : undefined,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Codex model list request timed out after ${timeoutMs}ms.`);
    }
    throw new Error(`Failed to reach ${url}. (${err.message})`);
  } finally {
    if (timeout) clearTimeout(timeout.timeoutId);
  }
  if (!response.ok) {
    throw await codexHttpError(response, await response.text());
  }
  let data;
  try {
    data = JSON.parse(await response.text());
  } catch (err) {
    throw new Error("Codex model list returned a non-JSON response.");
  }
  return selectCodexModelSlugs(data);
}

// Pull the user-selectable model slugs out of a `/models` response: keep only
// the ones the backend marks visibility "list" (hiding internal models like
// codex-auto-review), ordered most-preferred first by `priority` (lower wins).
export function selectCodexModelSlugs(data) {
  const models = Array.isArray(data?.models) ? data.models : [];
  return models
    .filter((model) => model && typeof model.slug === "string" && model.visibility === "list")
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .map((model) => model.slug);
}

// Chat-completions messages -> Responses API shape: system messages become
// `instructions`, the rest become typed input items.
export function convertMessagesToCodexInput(messages) {
  const instructions = [];
  const input = [];
  for (const message of messages || []) {
    if (!message || typeof message.content !== "string" || !message.content) continue;
    if (message.role === "system") {
      instructions.push(message.content);
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    input.push({
      type: "message",
      role,
      content: [
        {
          type: role === "assistant" ? "output_text" : "input_text",
          text: message.content,
        },
      ],
    });
  }
  return { instructions: instructions.join("\n\n") || null, input };
}

export function getCodexTextDelta(event) {
  if (!event || typeof event !== "object") return "";
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
    return event.delta;
  }
  return "";
}

export function getCodexReasoningDelta(event) {
  if (!event || typeof event !== "object") return "";
  if (
    (event.type === "response.reasoning_summary_text.delta" ||
      event.type === "response.reasoning_text.delta") &&
    typeof event.delta === "string"
  ) {
    return event.delta;
  }
  return "";
}

export function extractCodexFinalText(response) {
  if (!response || !Array.isArray(response.output)) return "";
  return response.output
    .filter((item) => item && item.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part && part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

// Error payloads vary: Responses events carry response.error.message, the
// ChatGPT backend's HTTP errors use `detail`, plain OpenAI errors use
// error.message.
export function extractCodexErrorMessage(body) {
  if (!body) return "";
  if (typeof body === "string") {
    try {
      return extractCodexErrorMessage(JSON.parse(body)) || body;
    } catch (err) {
      return body;
    }
  }
  if (typeof body !== "object") return "";
  if (typeof body.detail === "string") return body.detail;
  if (body.error && typeof body.error.message === "string") return body.error.message;
  if (typeof body.message === "string") return body.message;
  if (body.response) return extractCodexErrorMessage(body.response);
  return "";
}

function notify(message) {
  if (process.stdout.isTTY) {
    term(message);
  } else {
    process.stderr.write(message);
  }
}

function createTimeoutController(timeoutMs) {
  if (!timeoutMs || Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeoutId };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The Codex backend only answers streamed Responses requests, so the SSE
// stream is parsed even when config.stream is false — `display` controls
// whether tokens/thinking are shown live or only returned.
async function parseCodexStream(response, config, { display }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  let lineBuffer = "";
  let thinkingActive = false;
  const showThinking = display && config?.showThinking !== false;
  const renderer =
    display && config.renderMarkdown
      ? createMarkdownRenderer(config.markdownStyles)
      : null;
  const onToken = display ? (chunk) => term(chunk) : () => {};

  const flushLineBuffer = () => {
    if (!renderer) return;
    if (lineBuffer) {
      const rendered = renderer.renderLine(lineBuffer);
      if (rendered !== null) onToken(rendered);
      lineBuffer = "";
    }
    const pending = renderer.flush();
    if (pending) onToken(pending);
  };

  // Same contract as the other providers' streams: never leave a saved cursor
  // and a stale "thinking..." line behind, even on truncated streams.
  const finishThinkingDisplay = () => {
    if (!thinkingActive) return;
    term.restoreCursor();
    term.eraseDisplayBelow();
    thinkingActive = false;
  };

  const onContent = (chunk) => {
    finishThinkingDisplay();
    fullText += chunk;
    if (!renderer) {
      onToken(chunk);
      return;
    }
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() || "";
    for (const line of lines) {
      const rendered = renderer.renderLine(line);
      // null means the renderer buffered the line (e.g. a table row).
      if (rendered !== null) onToken(`${rendered}\n`);
    }
  };

  const onThinking = (chunk) => {
    if (!showThinking) return;
    if (!thinkingActive) {
      term.saveCursor();
      term.dim("thinking...\n");
      thinkingActive = true;
    }
    term.dim(chunk);
  };

  let finished = false;
  const finish = () => {
    finishThinkingDisplay();
    flushLineBuffer();
    finished = true;
  };

  const handleEvent = (event) => {
    const delta = getCodexTextDelta(event);
    if (delta) {
      onContent(delta);
      return;
    }
    const reasoning = getCodexReasoningDelta(event);
    if (reasoning) {
      onThinking(reasoning);
      return;
    }
    if (event.type === "response.failed" || event.type === "error") {
      const message = extractCodexErrorMessage(event) || "response failed";
      finishThinkingDisplay();
      throw new Error(`Codex error: ${message}`);
    }
    if (event.type === "response.completed") {
      // Deltas normally cover everything; the final response object is the
      // fallback when a server answers without incremental output events.
      if (!fullText) {
        const finalText = extractCodexFinalText(event.response);
        if (finalText) onContent(finalText);
      }
      finish();
    }
  };

  const handlePayload = (payload) => {
    if (payload === "[DONE]") {
      finish();
      return;
    }
    let event;
    try {
      event = JSON.parse(payload);
    } catch (err) {
      return; // Ignore non-JSON payloads
    }
    // Outside the try: a real failure while handling a parsed event (renderer,
    // terminal write) must propagate, not be misread as a non-JSON payload.
    handleEvent(event);
  };

  while (!finished) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      handlePayload(trimmed.replace(/^data:\s*/, ""));
      if (finished) return fullText;
    }
  }

  // A final event without a trailing newline would otherwise be dropped.
  if (!finished) {
    const remaining = buffer.trim();
    if (remaining.startsWith("data:")) {
      handlePayload(remaining.replace(/^data:\s*/, ""));
    }
  }

  if (!finished) finish();
  return fullText;
}

function buildCodexHeaders(credentials) {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${credentials.accessToken}`,
    "chatgpt-account-id": credentials.accountId,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    session_id: sessionId,
  };
}

// Optional params the backend may reject depending on model/revision. When a
// 400 names one, it is dropped, remembered for the rest of the process, and
// the request retried — so a stricter backend costs one extra round trip
// per process instead of failing outright.
const OPTIONAL_PARAMS = ["max_output_tokens", "reasoning"];
const rejectedParams = new Set();

function buildCodexPayload(model, instructions, input, budget) {
  const payload = {
    model,
    ...(instructions ? { instructions } : {}),
    input,
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { summary: "auto" },
    store: false,
    stream: true,
    include: [],
    prompt_cache_key: sessionId,
  };
  // Honor the response cap every other provider applies (config.maxTokens,
  // clamped by the caller). A null cap (maxTokens <= 0 in config, meaning
  // unlimited) leaves max_output_tokens unset so the backend imposes no
  // limit. Note: `temperature` is intentionally not sent — the Codex backend
  // manages sampling and rejects overrides.
  if (Number(budget?.maxTokens) > 0) {
    payload.max_output_tokens = Math.floor(Number(budget.maxTokens));
  }
  for (const param of rejectedParams) {
    delete payload[param];
  }
  return payload;
}

async function fetchCodex(url, payload, headers, timeoutMs) {
  const timeout = createTimeoutController(timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: timeout ? timeout.controller.signal : undefined,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(
        `Codex request timed out after ${timeoutMs}ms. Increase requestTimeoutMs in config if needed.`
      );
    }
    throw new Error(`Failed to connect to ${url}. (${err.message})`);
  } finally {
    if (timeout) clearTimeout(timeout.timeoutId);
  }
}

async function codexHttpError(response, text) {
  const message = extractCodexErrorMessage(text) || text || "unknown error";
  if (response.status === 401) {
    return new Error(
      `Codex error 401: ${message}. Your ChatGPT session may have expired — run \`gac auth login\`.`
    );
  }
  if (response.status === 429) {
    return new Error(
      `Codex error 429: ${message}. This usually means your ChatGPT plan's usage limit was hit — it resets on its own.`
    );
  }
  return new Error(`Codex error ${response.status}: ${message}`);
}

// OpenAI periodically retires models for ChatGPT-plan accounts; a request for a
// retired id returns a 400 like "The '<model>' model is not supported when using
// Codex with a ChatGPT account." Turn that into an actionable error listing the
// models the plan currently supports and the exact command to switch.
async function codexModelUnavailableError(config, model, text) {
  const detail =
    extractCodexErrorMessage(text) ||
    `The '${model}' model is not supported for your ChatGPT plan.`;
  let available = [];
  try {
    available = await fetchCodexModels(config);
  } catch (err) {
    // Best-effort: without a live list we still give a clear next step.
  }
  if (!available.length) {
    return new Error(
      `Codex error 400: ${detail} Run \`gac models\` to pick one your plan currently supports.`
    );
  }
  return new Error(
    `Codex error 400: ${detail}\n` +
      `Your ChatGPT plan currently supports: ${available.join(", ")}.\n` +
      `Switch with \`gac config set codexModel ${available[0]}\` or run \`gac models\` to choose interactively.`
  );
}

export async function codexChatCompletion(config, messages, budget) {
  let credentials = await getCodexCredentials();
  const model = resolveCodexModel(config);
  const url = `${normalizeCodexBaseUrl(config.codexBaseUrl)}/responses`;
  const timeoutMs = Number(config.requestTimeoutMs);
  const { instructions, input } = convertMessagesToCodexInput(messages);

  let payload = buildCodexPayload(model, instructions, input, budget);
  let headers = buildCodexHeaders(credentials);

  const maxRetries = 5;
  const retryDelayMs = 3000;
  let refreshed = false;
  let response;
  let lastErrorText = "";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    response = await fetchCodex(url, payload, headers, timeoutMs);
    if (response.ok) break;

    const text = await response.text();
    lastErrorText = text;

    // Expired access token: refresh once and retry immediately.
    if (response.status === 401 && !refreshed) {
      refreshed = true;
      credentials = await getCodexCredentials({ forceRefresh: true });
      headers = buildCodexHeaders(credentials);
      continue;
    }

    if (response.status === 400) {
      // A 400 naming an optional param means this backend/model rejects it:
      // drop it for the rest of the process and retry without.
      const rejected = OPTIONAL_PARAMS.find(
        (param) => param in payload && text.includes(param)
      );
      if (rejected) {
        rejectedParams.add(rejected);
        delete payload[rejected];
        continue;
      }

      // Some backend revisions only accept their own instructions block; retry
      // once carrying the system prompt as a regular input message instead.
      if (payload.instructions && /instruction/i.test(text)) {
        const merged = [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: `[System instructions]\n${payload.instructions}` },
            ],
          },
          ...input,
        ];
        payload = buildCodexPayload(model, null, merged, budget);
        continue;
      }

      // The configured model was retired for this ChatGPT plan: surface the
      // current model list and how to switch instead of a cryptic 400.
      if (/\bnot supported\b/i.test(text) && /model/i.test(text)) {
        throw await codexModelUnavailableError(config, model, text);
      }
    }

    if (response.status >= 500 && attempt < maxRetries) {
      notify(
        `Codex unavailable (${response.status}), retrying in ${retryDelayMs / 1000}s... (${attempt + 1}/${maxRetries})\n`
      );
      await sleep(retryDelayMs);
      continue;
    }

    throw await codexHttpError(response, text);
  }

  if (!response.ok) {
    // The body was already consumed during the retry loop.
    throw await codexHttpError(response, lastErrorText);
  }

  return parseCodexStream(response, config, { display: Boolean(config.stream) });
}
