// Coarse bucketing helpers. Every raw count/size/duration is reduced to a fixed
// enum before it can enter an event, so exact sizes and counts never leave the
// machine. All helpers are pure and total (no throws) — they coerce junk to the
// most conservative bucket.
//
// See src/telemetry/contract.js for the canonical enum lists.

import { MAX_DURATION_MS } from "./contract.js";

function toFiniteNumber(value) {
  // null/undefined/"" are "no value" — NOT 0 (Number(null) === 0 would collapse
  // "no exit code" into exit code zero).
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// Text/byte size → size bucket. `null`/junk → "none".
export function sizeBucket(value) {
  const n = toFiniteNumber(value);
  if (n === null || n <= 0) return "none";
  if (n <= 100) return "1_100";
  if (n <= 500) return "101_500";
  if (n <= 2000) return "501_2000";
  if (n <= 10000) return "2001_10000";
  if (n <= 50000) return "10001_50000";
  return "50001_plus";
}

// Count → count bucket. `null`/junk/≤0 → "0".
export function countBucket(value) {
  const n = toFiniteNumber(value);
  if (n === null || n <= 0) return "0";
  if (n === 1) return "1";
  if (n <= 5) return "2_5";
  if (n <= 10) return "6_10";
  if (n <= 25) return "11_25";
  return "26_plus";
}

// Context window size (tokens) → bucket. `null`/junk → "unknown".
export function contextWindowBucket(value) {
  const n = toFiniteNumber(value);
  if (n === null || n <= 0) return "unknown";
  if (n <= 8192) return "up_to_8k";
  if (n <= 32768) return "8k_to_32k";
  if (n <= 131072) return "32k_to_128k";
  return "128k_plus";
}

// Number of attempts → bucket. `null`/junk/≤1 → "1".
export function attemptCountBucket(value) {
  const n = toFiniteNumber(value);
  if (n === null || n <= 1) return "1";
  if (n === 2) return "2";
  if (n <= 5) return "3_5";
  return "6_plus";
}

// HTTP status code → coarse class. `null`/junk → "none". 429 gets its own class.
export function httpStatusClass(value) {
  const n = toFiniteNumber(value);
  if (n === null) return "none";
  if (n === 429) return "429";
  if (n >= 200 && n < 300) return "2xx";
  if (n >= 400 && n < 500) return "4xx";
  if (n >= 500 && n < 600) return "5xx";
  return "none";
}

// Process exit code → coarse class. `null`/junk → "unknown".
export function exitCodeClass(value) {
  const n = toFiniteNumber(value);
  if (n === null) return "unknown";
  if (n === 0) return "zero";
  if (n === 1) return "one";
  if (n === 2) return "two";
  if (n >= 3 && n <= 10) return "three_to_10";
  if (n >= 11 && n <= 127) return "11_to_127";
  if (n >= 128) return "128_plus";
  return "unknown";
}

// Which kinds of input a command received. Pass booleans (or truthy scalars);
// never pass the input itself.
export function inputMode({ hasArguments = false, hasStdin = false, hasFiles = false } = {}) {
  if (hasStdin && hasFiles) return "stdin_and_files";
  if (hasFiles) return "files";
  if (hasStdin) return "stdin";
  if (hasArguments) return "arguments";
  return "none";
}

// Clamp a raw integer count into [0, max] (default 100) for the runbook
// counters. Junk → 0.
export function clampCount(value, max = 100) {
  const n = toFiniteNumber(value);
  if (n === null) return 0;
  const i = Math.trunc(n);
  if (i < 0) return 0;
  if (i > max) return max;
  return i;
}

// Normalize a duration measured in ms to a nonnegative integer clamped to 24h.
// `null`/junk → null (duration_ms is allowed to be null).
export function normalizeDuration(value) {
  const n = toFiniteNumber(value);
  if (n === null || n < 0) return null;
  return Math.min(Math.round(n), MAX_DURATION_MS);
}

// Map a config provider value to the telemetry provider category. Never the URL,
// model, or key — only the coarse category.
export function providerCategory(provider) {
  if (provider === "ollama") return "ollama";
  if (provider === "codex") return "codex";
  if (provider === "openai") return "openai_compatible";
  return "unknown";
}

// Map process.platform / process.arch to their event enums.
export function platformCategory(platform) {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "win32";
  if (platform === "freebsd") return "freebsd";
  return "other";
}

export function archCategory(arch) {
  if (arch === "x64") return "x64";
  if (arch === "arm64") return "arm64";
  if (arch === "arm") return "arm";
  if (arch === "ia32") return "ia32";
  return "other";
}

// Node.js major version from a "vX.Y.Z" string. Junk → 0.
export function nodeMajor(versionString) {
  const match = /^v?(\d+)\./.exec(String(versionString || ""));
  return match ? Number(match[1]) : 0;
}
