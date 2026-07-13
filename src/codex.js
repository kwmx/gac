import { randomUUID } from "crypto";
import terminalKit from "terminal-kit";
import { createMarkdownRenderer } from "./markdown.js";
import { getCodexCredentials } from "./codexauth.js";

const { terminal: term } = terminalKit;

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const DEFAULT_CODEX_MODEL = "gpt-5.1-codex";

// The Codex backend has no model-listing endpoint; this is the model family
// it serves for ChatGPT-plan accounts. Any Responses-capable model id can
// still be set manually via `gac config set codexModel <id>`.
export const CODEX_MODELS = [
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1",
  "gpt-5-codex",
  "gpt-5",
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

  const finish = () => {
    finishThinkingDisplay();
    flushLineBuffer();
    return fullText;
  };

  const handleEvent = (event) => {
    const delta = getCodexTextDelta(event);
    if (delta) {
      onContent(delta);
      return null;
    }
    const reasoning = getCodexReasoningDelta(event);
    if (reasoning) {
      onThinking(reasoning);
      return null;
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
      return finish();
    }
    return null;
  };

  const handlePayload = (payload) => {
    if (payload === "[DONE]") return finish();
    try {
      return handleEvent(JSON.parse(payload));
    } catch (err) {
      if (err.message && err.message.startsWith("Codex error:")) throw err;
      return null; // Ignore non-JSON payloads
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const result = handlePayload(trimmed.replace(/^data:\s*/, ""));
      if (result !== null && result !== undefined) return result;
    }
  }

  // A final event without a trailing newline would otherwise be dropped.
  const remaining = buffer.trim();
  if (remaining.startsWith("data:")) {
    const result = handlePayload(remaining.replace(/^data:\s*/, ""));
    if (result !== null && result !== undefined) return result;
  }

  return finish();
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

function buildCodexPayload(model, instructions, input) {
  return {
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

export async function codexChatCompletion(config, messages) {
  let credentials = await getCodexCredentials();
  const model = resolveCodexModel(config);
  const url = `${normalizeCodexBaseUrl(config.codexBaseUrl)}/responses`;
  const timeoutMs = Number(config.requestTimeoutMs);
  const { instructions, input } = convertMessagesToCodexInput(messages);

  let payload = buildCodexPayload(model, instructions, input);
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

    // Some backend revisions only accept their own instructions block; retry
    // once carrying the system prompt as a regular input message instead.
    if (response.status === 400 && payload.instructions && /instruction/i.test(text)) {
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
      payload = buildCodexPayload(model, null, merged);
      continue;
    }

    if ((response.status === 503 || response.status >= 500) && attempt < maxRetries) {
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
