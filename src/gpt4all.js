import terminalKit from "terminal-kit";
import { createMarkdownRenderer } from "./markdown.js";

const { terminal: term } = terminalKit;

function getContentDelta(chunk) {
  if (!chunk || !chunk.choices || !chunk.choices[0]) return "";
  const choice = chunk.choices[0];
  if (choice.delta && choice.delta.content) return choice.delta.content;
  if (choice.message && choice.message.content) return choice.message.content;
  if (choice.text) return choice.text;
  return "";
}

function getOllamaContentDelta(chunk) {
  if (!chunk) return "";
  if (chunk.message && chunk.message.content) return chunk.message.content;
  if (chunk.response) return chunk.response;
  return "";
}

function normalizeOpenAiBaseUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

function normalizeOllamaBaseUrl(baseUrl) {
  return baseUrl.replace(/\/$/, "");
}

function getProvider(config) {
  return config.provider === "ollama" ? "ollama" : "openai";
}

function buildOpenAiHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
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

function extract503Message(text) {
  try {
    const body = JSON.parse(text);
    if (body?.error?.message) return body.error.message;
  } catch (_) {}
  return "Server unavailable";
}

async function parseStream(response, onToken, renderer) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  let lineBuffer = "";
  const flushLineBuffer = () => {
    if (renderer && lineBuffer) {
      onToken(renderer.renderLine(lineBuffer));
      lineBuffer = "";
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
      const payload = trimmed.replace(/^data:\s*/, "");
      if (payload === "[DONE]") {
        flushLineBuffer();
        return fullText;
      }

      try {
        const json = JSON.parse(payload);
        const delta = getContentDelta(json);
        if (delta) {
          fullText += delta;
          if (!renderer) {
            onToken(delta);
          } else {
            lineBuffer += delta;
            const lines = lineBuffer.split("\n");
            lineBuffer = lines.pop() || "";
            for (const line of lines) {
              onToken(`${renderer.renderLine(line)}\n`);
            }
          }
        }
      } catch (err) {
        // Ignore non-JSON payloads
      }
    }
  }

  if (renderer && lineBuffer) {
    onToken(renderer.renderLine(lineBuffer));
  }

  return fullText;
}

async function parseOllamaStream(response, onToken, renderer) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  let lineBuffer = "";
  const flushLineBuffer = () => {
    if (renderer && lineBuffer) {
      onToken(renderer.renderLine(lineBuffer));
      lineBuffer = "";
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
      if (!trimmed) continue;
      try {
        const json = JSON.parse(trimmed);
        if (json.done) {
          flushLineBuffer();
          return fullText;
        }
        const delta = getOllamaContentDelta(json);
        if (delta) {
          fullText += delta;
          if (!renderer) {
            onToken(delta);
          } else {
            lineBuffer += delta;
            const lines = lineBuffer.split("\n");
            lineBuffer = lines.pop() || "";
            for (const line of lines) {
              onToken(`${renderer.renderLine(line)}\n`);
            }
          }
        }
      } catch (err) {
        // Ignore non-JSON payloads
      }
    }
  }

  if (renderer && lineBuffer) {
    onToken(renderer.renderLine(lineBuffer));
  }

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
      term(`${msg}, retrying in ${retryDelayMs / 1000}s... (${attempt + 1}/${maxRetries})\n`);
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

async function openAiChatCompletion(config, messages) {
  const url = `${normalizeOpenAiBaseUrl(config.baseUrl)}/chat/completions`;
  const timeoutMs = Number(config.requestTimeoutMs);
  const payload = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
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
    term(`${msg}, retrying in ${retryDelayMs / 1000}s... (${attempt + 1}/${maxRetries})\n`);
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
      const content = getContentDelta(json);
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
      return parseStream(response, (chunk) => term(chunk), renderer);
    }
  }

  const json = await response.json();
  const content = getContentDelta(json);
  if (config.stream) {
    if (renderer) {
      term(renderer.renderText(content));
    } else {
      term(content);
    }
  }
  return content;
}

async function ollamaChatCompletion(config, messages) {
  const baseUrl = normalizeOllamaBaseUrl(config.ollamaBaseUrl);
  const url = `${baseUrl}/api/chat`;
  const timeoutMs = Number(config.requestTimeoutMs);
  const payload = {
    model: config.model,
    messages,
    stream: Boolean(config.stream),
    options: {
      temperature: config.temperature,
      num_predict: config.maxTokens,
    },
  };

  const renderer = config.renderMarkdown
    ? createMarkdownRenderer(config.markdownStyles)
    : null;
  const response = await fetchCompletion(
    url,
    payload,
    { "Content-Type": "application/json" },
    "Ollama",
    timeoutMs
  );

  if (!response.ok) {
    await handleError(response, "Ollama");
  }

  if (config.stream) {
    return parseOllamaStream(response, (chunk) => term(chunk), renderer);
  }

  const json = await response.json();
  const content = getOllamaContentDelta(json);
  return content;
}

export async function chatCompletion(config, messages) {
  const provider = getProvider(config);
  if (provider === "ollama") {
    return ollamaChatCompletion(config, messages);
  }
  return openAiChatCompletion(config, messages);
}
