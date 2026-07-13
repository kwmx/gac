import terminalKit from "terminal-kit";
import { createMarkdownRenderer } from "./markdown.js";
import { resolveContextWindow, resolveGenerationBudget } from "./contextwindow.js";
import { codexChatCompletion, listCodexModels, resolveCodexModel } from "./codex.js";

const { terminal: term } = terminalKit;

export function getContentDelta(chunk) {
  if (!chunk || !chunk.choices || !chunk.choices[0]) return "";
  const choice = chunk.choices[0];
  if (choice.delta && choice.delta.content) return choice.delta.content;
  if (choice.message && choice.message.content) return choice.message.content;
  if (choice.text) return choice.text;
  return "";
}

export function getOllamaContentDelta(chunk) {
  if (!chunk) return "";
  if (chunk.message && chunk.message.content) return chunk.message.content;
  if (chunk.response) return chunk.response;
  return "";
}

export function normalizeOpenAiBaseUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

export function normalizeOllamaBaseUrl(baseUrl) {
  return baseUrl.replace(/\/$/, "");
}

function getProvider(config) {
  if (config.provider === "ollama") return "ollama";
  if (config.provider === "codex") return "codex";
  return "openai";
}

// The model actually used for a request: codex has its own model key so
// switching providers never invalidates the openai/ollama model (or vice
// versa).
export function getActiveModel(config) {
  return getProvider(config) === "codex" ? resolveCodexModel(config) : config.model;
}

// The config key model selections should be written to for the active
// provider — the write-side counterpart of getActiveModel.
export function getActiveModelKey(config) {
  return getProvider(config) === "codex" ? "codexModel" : "model";
}

export function buildOpenAiHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

// Progress/status notices go to stderr when stdout is piped, so they never
// pollute machine-readable output (`gac ask ... | jq`).
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

export function createThinkingParser({ onContent, onThinking, onThinkingEnd }) {
  let state = "normal"; // 'normal' | 'maybe_open' | 'in_think' | 'maybe_close'
  let tagBuf = "";

  function push(text) {
    for (const ch of text) {
      if (state === "normal") {
        if (ch === "<") {
          tagBuf = "<";
          state = "maybe_open";
        } else {
          onContent(ch);
        }
      } else if (state === "maybe_open") {
        tagBuf += ch;
        if ("<think>".startsWith(tagBuf)) {
          if (tagBuf === "<think>") {
            state = "in_think";
            tagBuf = "";
          }
        } else {
          onContent(tagBuf);
          tagBuf = "";
          state = "normal";
        }
      } else if (state === "in_think") {
        if (ch === "<") {
          tagBuf = "<";
          state = "maybe_close";
        } else {
          onThinking(ch);
        }
      } else if (state === "maybe_close") {
        tagBuf += ch;
        if ("</think>".startsWith(tagBuf)) {
          if (tagBuf === "</think>") {
            state = "normal";
            tagBuf = "";
            onThinkingEnd();
          }
        } else {
          onThinking(tagBuf);
          tagBuf = "";
          state = "in_think";
        }
      }
    }
  }

  function flush() {
    if (tagBuf) {
      if (state === "in_think" || state === "maybe_close") {
        onThinking(tagBuf);
      } else {
        onContent(tagBuf);
      }
      tagBuf = "";
    }
    state = "normal";
  }

  return { push, flush };
}

export function stripThinkingBlocks(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export function extract503Message(text) {
  try {
    const body = JSON.parse(text);
    if (body?.error?.message) return body.error.message;
  } catch (_) {}
  return "Server unavailable";
}

async function parseStream(response, onToken, renderer, config) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  let lineBuffer = "";
  let thinkingActive = false;
  const showThinking = config?.showThinking !== false;

  const flushLineBuffer = () => {
    if (!renderer) return;
    if (lineBuffer) {
      const rendered = renderer.renderLine(lineBuffer);
      if (rendered !== null) onToken(rendered);
      lineBuffer = "";
    }
    // Emit anything the renderer is still buffering (a table cut off by the
    // end of the stream).
    const pending = renderer.flush();
    if (pending) onToken(pending);
  };

  // Restore the terminal to the pre-"thinking..." state. Used both when a
  // </think> tag arrives and when the stream ends while still inside a think
  // block (no closing tag / no [DONE]), so a truncated stream never leaves a
  // saved cursor and a stale "thinking..." line behind.
  const finishThinkingDisplay = () => {
    if (!thinkingActive) return;
    term.restoreCursor();
    term.eraseDisplayBelow();
    thinkingActive = false;
  };

  const thinkingParser = createThinkingParser({
    onContent(chunk) {
      fullText += chunk;
      if (!renderer) {
        onToken(chunk);
      } else {
        lineBuffer += chunk;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() || "";
        for (const line of lines) {
          const rendered = renderer.renderLine(line);
          // null means the renderer buffered the line (e.g. a table row).
          if (rendered !== null) onToken(`${rendered}\n`);
        }
      }
    },
    onThinking(chunk) {
      if (!showThinking) return;
      if (!thinkingActive) {
        term.saveCursor();
        term.dim("thinking...\n");
        thinkingActive = true;
      }
      term.dim(chunk);
    },
    onThinkingEnd() {
      finishThinkingDisplay();
    },
  });

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const payload = trimmed.replace(/^data:\s*/, "");
      if (payload === "[DONE]") {
        thinkingParser.flush();
        finishThinkingDisplay();
        flushLineBuffer();
        return fullText;
      }

      try {
        const json = JSON.parse(payload);
        const delta = getContentDelta(json);
        if (delta) {
          thinkingParser.push(delta);
        }
      } catch (err) {
        // Ignore non-JSON payloads
      }
    }
  }

  // A final event without a trailing newline would otherwise be dropped.
  const remaining = buffer.trim();
  if (remaining.startsWith("data:")) {
    const payload = remaining.replace(/^data:\s*/, "");
    if (payload !== "[DONE]") {
      try {
        const delta = getContentDelta(JSON.parse(payload));
        if (delta) thinkingParser.push(delta);
      } catch (err) {
        // Ignore non-JSON payloads
      }
    }
  }

  thinkingParser.flush();
  finishThinkingDisplay();
  flushLineBuffer();

  return fullText;
}

async function parseOllamaStream(response, onToken, renderer, config) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  let lineBuffer = "";
  let thinkingActive = false;
  const showThinking = config?.showThinking !== false;

  const flushLineBuffer = () => {
    if (!renderer) return;
    if (lineBuffer) {
      const rendered = renderer.renderLine(lineBuffer);
      if (rendered !== null) onToken(rendered);
      lineBuffer = "";
    }
    // Emit anything the renderer is still buffering (a table cut off by the
    // end of the stream).
    const pending = renderer.flush();
    if (pending) onToken(pending);
  };

  // Restore the terminal to the pre-"thinking..." state. Used both when a
  // </think> tag arrives and when the stream ends while still inside a think
  // block, so a truncated stream never leaves a saved cursor and a stale
  // "thinking..." line behind.
  const finishThinkingDisplay = () => {
    if (!thinkingActive) return;
    term.restoreCursor();
    term.eraseDisplayBelow();
    thinkingActive = false;
  };

  const thinkingParser = createThinkingParser({
    onContent(chunk) {
      fullText += chunk;
      if (!renderer) {
        onToken(chunk);
      } else {
        lineBuffer += chunk;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() || "";
        for (const line of lines) {
          const rendered = renderer.renderLine(line);
          // null means the renderer buffered the line (e.g. a table row).
          if (rendered !== null) onToken(`${rendered}\n`);
        }
      }
    },
    onThinking(chunk) {
      if (!showThinking) return;
      if (!thinkingActive) {
        term.saveCursor();
        term.dim("thinking...\n");
        thinkingActive = true;
      }
      term.dim(chunk);
    },
    onThinkingEnd() {
      finishThinkingDisplay();
    },
  });

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const json = JSON.parse(trimmed);
        // Extract content before honoring done: the final chunk may carry
        // both (e.g. servers that answer a streamed request with one object).
        const delta = getOllamaContentDelta(json);
        if (delta) {
          thinkingParser.push(delta);
        }
        if (json.done) {
          thinkingParser.flush();
          finishThinkingDisplay();
          flushLineBuffer();
          return fullText;
        }
      } catch (err) {
        // Ignore non-JSON payloads
      }
    }
  }

  // A final chunk without a trailing newline would otherwise be dropped.
  const remaining = buffer.trim();
  if (remaining) {
    try {
      const delta = getOllamaContentDelta(JSON.parse(remaining));
      if (delta) thinkingParser.push(delta);
    } catch (err) {
      // Ignore non-JSON payloads
    }
  }

  thinkingParser.flush();
  finishThinkingDisplay();
  flushLineBuffer();

  return fullText;
}

async function fetchJson(url, payload, errorLabel, timeoutMs) {
  const maxRetries = 30;
  const retryDelayMs = 3000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const timeout = createTimeoutController(timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        ...payload,
        signal: timeout ? timeout.controller.signal : undefined,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(
          `${errorLabel} request timed out after ${timeoutMs}ms. Increase requestTimeoutMs in config if needed.`
        );
      }
      throw new Error(`Failed to connect to ${url}. (${err.message})`);
    } finally {
      if (timeout) clearTimeout(timeout.timeoutId);
    }

    if (response.ok) {
      return await response.json();
    }

    const text = await response.text();
    if (response.status === 503 && attempt < maxRetries) {
      const msg = extract503Message(text);
      notify(`${msg}, retrying in ${retryDelayMs / 1000}s... (${attempt + 1}/${maxRetries})\n`);
      await sleep(retryDelayMs);
      continue;
    }

    throw new Error(`${errorLabel} error ${response.status}: ${text}`);
  }
}

async function fetchCompletion(url, payload, headers, errorLabel, timeoutMs) {
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
        `${errorLabel} request timed out after ${timeoutMs}ms. Increase requestTimeoutMs in config if needed.`
      );
    }
    throw new Error(`Failed to connect to ${url}. (${err.message})`);
  } finally {
    if (timeout) {
      clearTimeout(timeout.timeoutId);
    }
  }
}

async function handleError(response, errorLabel) {
  const text = await response.text();
  throw new Error(`${errorLabel} error ${response.status}: ${text}`);
}

export async function listModels(config) {
  const provider = getProvider(config);
  const timeoutMs = Number(config.requestTimeoutMs);
  if (provider === "codex") {
    return listCodexModels();
  }
  if (provider === "ollama") {
    const baseUrl = normalizeOllamaBaseUrl(config.ollamaBaseUrl);
    const url = `${baseUrl}/api/tags`;
    const json = await fetchJson(url, { method: "GET" }, "Ollama", timeoutMs);
    if (!json || !Array.isArray(json.models)) return [];
    return json.models.map((model) => model.name).filter(Boolean);
  }

  const url = `${normalizeOpenAiBaseUrl(config.baseUrl)}/models`;
  const headers = buildOpenAiHeaders(config.apiKey);
  const json = await fetchJson(url, { method: "GET", headers }, "OpenAI", timeoutMs);
  if (!json || !Array.isArray(json.data)) return [];
  return json.data.map((model) => model.id).filter(Boolean);
}

async function openAiChatCompletion(config, messages, budget) {
  const url = `${normalizeOpenAiBaseUrl(config.baseUrl)}/chat/completions`;
  const timeoutMs = Number(config.requestTimeoutMs);
  const payload = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: budget.maxTokens,
    stream: Boolean(config.stream),
  };

  const headers = buildOpenAiHeaders(config.apiKey);

  const renderer = config.renderMarkdown
    ? createMarkdownRenderer(config.markdownStyles)
    : null;

  const maxRetries = 30;
  const retryDelayMs = 3000;
  let response;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    response = await fetchCompletion(url, payload, headers, "OpenAI", timeoutMs);
    if (response.status !== 503) break;

    const text = await response.text();
    if (attempt >= maxRetries) {
      throw new Error(`OpenAI error ${response.status}: ${text}`);
    }
    const msg = extract503Message(text);
    notify(`${msg}, retrying in ${retryDelayMs / 1000}s... (${attempt + 1}/${maxRetries})\n`);
    await sleep(retryDelayMs);
  }

  if (!response.ok) {
    const text = await response.text();
    if (
      config.stream &&
      response.status === 400 &&
      text.includes("stream") &&
      text.includes("not supported")
    ) {
      const retryPayload = { ...payload, stream: false };
      response = await fetchCompletion(url, retryPayload, headers, "OpenAI", timeoutMs);
      if (!response.ok) {
        await handleError(response, "OpenAI");
      }
      const json = await response.json();
      const content = stripThinkingBlocks(getContentDelta(json));
      if (renderer) {
        term(renderer.renderText(content));
      } else {
        term(content);
      }
      return content;
    }

    throw new Error(`OpenAI error ${response.status}: ${text}`);
  }

  if (config.stream) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      return parseStream(response, (chunk) => term(chunk), renderer, config);
    }
  }

  const json = await response.json();
  const content = stripThinkingBlocks(getContentDelta(json));
  if (config.stream) {
    if (renderer) {
      term(renderer.renderText(content));
    } else {
      term(content);
    }
  }
  return content;
}

async function ollamaChatCompletion(config, messages, budget) {
  const baseUrl = normalizeOllamaBaseUrl(config.ollamaBaseUrl);
  const url = `${baseUrl}/api/chat`;
  const timeoutMs = Number(config.requestTimeoutMs);
  const payload = {
    model: config.model,
    messages,
    stream: Boolean(config.stream),
    options: {
      temperature: config.temperature,
      num_predict: budget.maxTokens,
      // Size the runtime context to the conversation (instead of Ollama's
      // 4096 default) so long chats aren't silently truncated by the server.
      ...(budget.numCtx ? { num_ctx: budget.numCtx } : {}),
    },
  };

  const renderer = config.renderMarkdown
    ? createMarkdownRenderer(config.markdownStyles)
    : null;

  const maxRetries = 30;
  const retryDelayMs = 3000;
  let response;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    response = await fetchCompletion(
      url,
      payload,
      { "Content-Type": "application/json" },
      "Ollama",
      timeoutMs
    );
    if (response.status !== 503) break;

    const text = await response.text();
    if (attempt >= maxRetries) {
      throw new Error(`Ollama error ${response.status}: ${text}`);
    }
    const msg = extract503Message(text);
    notify(`${msg}, retrying in ${retryDelayMs / 1000}s... (${attempt + 1}/${maxRetries})\n`);
    await sleep(retryDelayMs);
  }

  if (!response.ok) {
    await handleError(response, "Ollama");
  }

  if (config.stream) {
    return parseOllamaStream(response, (chunk) => term(chunk), renderer, config);
  }

  const json = await response.json();
  const content = stripThinkingBlocks(getOllamaContentDelta(json));
  return content;
}

export async function chatCompletion(config, messages, options = {}) {
  const provider = getProvider(config);
  // Callers that already resolved the context window pass it in (including
  // null for "unknown"); otherwise resolve it here — detection results are
  // cached per provider/model, so this is a one-time probe per process.
  const contextWindow =
    options.contextWindow !== undefined
      ? options.contextWindow
      : await resolveContextWindow(config);
  const budget = resolveGenerationBudget(config, messages, contextWindow);
  if (provider === "codex") {
    return codexChatCompletion(config, messages, budget);
  }
  if (provider === "ollama") {
    return ollamaChatCompletion(config, messages, budget);
  }
  return openAiChatCompletion(config, messages, budget);
}
