// Coarse error classification for telemetry.
//
// These functions take an error (or status) and return ONLY a coarse category
// string plus an HTTP status class. They are called at the instrumentation
// boundary; the caller passes only the resulting scalars to telemetry and then
// rethrows the original application error unchanged. No error message, stack, or
// URL is ever returned or stored.

import { httpStatusClass } from "./buckets.js";

// Map a numeric HTTP status to a coarse error category.
export function httpErrorCategory(status) {
  const n = Number(status);
  if (!Number.isFinite(n)) return "unknown";
  if (n === 429) return "rate_limited";
  if (n === 401) return "authentication";
  if (n === 403) return "authorization";
  if (n >= 400 && n < 500) return "provider_4xx";
  if (n >= 500 && n < 600) return "provider_5xx";
  if (n >= 200 && n < 300) return "unknown"; // success is not an error
  return "unknown";
}

// Classify an error thrown by the model-request layer (src/gpt4all.js /
// src/codex.js) into a coarse telemetry category and HTTP status class, derived
// from the error's shape only. Returns { errorCategory, httpStatusClass }.
//
// The request layer throws Error objects whose messages already encode the
// failure kind ("... request timed out ...", "Failed to connect to ...",
// "<Provider> error <status>: ..."). We read that shape but never keep the text.
export function classifyModelError(err) {
  if (!err) {
    return { errorCategory: "unknown", httpStatusClass: "none" };
  }

  const name = String(err.name || "");
  const message = String(err.message || "");

  // Abort / timeout.
  if (name === "AbortError" || /timed out/i.test(message)) {
    return { errorCategory: "timeout", httpStatusClass: "none" };
  }

  // A status carried explicitly (preferred when available).
  if (Number.isFinite(err.status)) {
    return {
      errorCategory: httpErrorCategory(err.status),
      httpStatusClass: httpStatusClass(err.status),
    };
  }

  // "<Provider> error <status>: <body>" — parse the status only.
  const statusMatch = /\berror\s+(\d{3})\b/.exec(message);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return {
      errorCategory: httpErrorCategory(status),
      httpStatusClass: httpStatusClass(status),
    };
  }

  // Connection-level failures.
  if (/failed to connect/i.test(message) || /fetch failed/i.test(message)) {
    return { errorCategory: "network", httpStatusClass: "none" };
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return { errorCategory: "network", httpStatusClass: "none" };
  }
  if (/ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT/i.test(message)) {
    return { errorCategory: "network", httpStatusClass: "none" };
  }

  return { errorCategory: "unknown", httpStatusClass: "none" };
}

// Classify a transport failure while SENDING telemetry (used to persist a coarse
// lastFailureCategory). Never surfaced to the user during normal commands.
export function classifyTransportError(err) {
  if (!err) return "unknown";
  const name = String(err.name || "");
  const message = String(err.message || "");
  if (name === "AbortError" || /aborted|timed out/i.test(message)) return "timeout";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return "network";
  if (/ECONNREFUSED|ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT/i.test(message)) return "network";
  if (/tls|ssl|certificate|self.signed/i.test(message)) return "network";
  if (/fetch failed|network/i.test(message)) return "network";
  return "unknown";
}
