import terminalKit from 'terminal-kit';
import { createMarkdownRenderer } from './markdown.js';

const { terminal: term } = terminalKit;

function getContentDelta(chunk) {
  if (!chunk || !chunk.choices || !chunk.choices[0]) return '';
  const choice = chunk.choices[0];
  if (choice.delta && choice.delta.content) return choice.delta.content;
  if (choice.message && choice.message.content) return choice.message.content;
  if (choice.text) return choice.text;
  return '';
}

async function parseStream(response, onToken, renderer) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullText = '';
  let lineBuffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const payload = trimmed.replace(/^data:\s*/, '');
      if (payload === '[DONE]') {
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
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() || '';
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

function normalizeBaseUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/$/, '');
  if (trimmed.endsWith('/v1')) return trimmed;
  return `${trimmed}/v1`;
}

async function fetchJson(url, payload) {
  try {
    const response = await fetch(url, payload);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GPT4All error ${response.status}: ${text}`);
    }
    return await response.json();
  } catch (err) {
    if (err.message && err.message.startsWith('GPT4All error')) {
      throw err;
    }
    throw new Error(`Failed to connect to ${url}. Is GPT4All running and reachable? (${err.message})`);
  }
}

export async function listModels(baseUrl) {
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  const json = await fetchJson(url, { method: 'GET' });
  if (!json || !Array.isArray(json.data)) return [];
  return json.data.map((model) => model.id).filter(Boolean);
}

async function fetchCompletion(url, payload) {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    throw new Error(`Failed to connect to ${url}. Is GPT4All running and reachable? (${err.message})`);
  }
}

async function handleError(response) {
  const text = await response.text();
  throw new Error(`GPT4All error ${response.status}: ${text}`);
}

export async function chatCompletion(
  { baseUrl, model, temperature, maxTokens, stream, renderMarkdown, markdownStyles },
  messages
) {
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const payload = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: Boolean(stream)
  };

  let response = await fetchCompletion(url, payload);

  const renderer = renderMarkdown ? createMarkdownRenderer(markdownStyles) : null;

  if (!response.ok) {
    const text = await response.text();
    if (stream && response.status === 400 && text.includes('stream') && text.includes('not supported')) {
      const retryPayload = { ...payload, stream: false };
      response = await fetchCompletion(url, retryPayload);
      if (!response.ok) {
        await handleError(response);
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

    throw new Error(`GPT4All error ${response.status}: ${text}`);
  }

  if (stream) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      return parseStream(response, (chunk) => term(chunk), renderer);
    }
  }

  const json = await response.json();
  const content = getContentDelta(json);
  if (stream) {
    if (renderer) {
      term(renderer.renderText(content));
    } else {
      term(content);
    }
  }
  return content;
}
