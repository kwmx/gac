import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sizeBucket,
  countBucket,
  contextWindowBucket,
  attemptCountBucket,
  httpStatusClass,
  exitCodeClass,
  inputMode,
  clampCount,
  normalizeDuration,
  providerCategory,
  platformCategory,
  archCategory,
  nodeMajor,
} from "../src/telemetry/buckets.js";
import { classifyModelError, httpErrorCategory } from "../src/telemetry/errors.js";

test("sizeBucket maps sizes to the fixed enum", () => {
  assert.equal(sizeBucket(0), "none");
  assert.equal(sizeBucket(1), "1_100");
  assert.equal(sizeBucket(100), "1_100");
  assert.equal(sizeBucket(101), "101_500");
  assert.equal(sizeBucket(500), "101_500");
  assert.equal(sizeBucket(2000), "501_2000");
  assert.equal(sizeBucket(10000), "2001_10000");
  assert.equal(sizeBucket(50000), "10001_50000");
  assert.equal(sizeBucket(50001), "50001_plus");
  assert.equal(sizeBucket(NaN), "none");
  assert.equal(sizeBucket(null), "none");
});

test("countBucket maps counts to the fixed enum", () => {
  assert.equal(countBucket(0), "0");
  assert.equal(countBucket(1), "1");
  assert.equal(countBucket(5), "2_5");
  assert.equal(countBucket(10), "6_10");
  assert.equal(countBucket(25), "11_25");
  assert.equal(countBucket(26), "26_plus");
  assert.equal(countBucket(-3), "0");
});

test("contextWindowBucket buckets token windows", () => {
  assert.equal(contextWindowBucket(null), "unknown");
  assert.equal(contextWindowBucket(8192), "up_to_8k");
  assert.equal(contextWindowBucket(32768), "8k_to_32k");
  assert.equal(contextWindowBucket(131072), "32k_to_128k");
  assert.equal(contextWindowBucket(200000), "128k_plus");
});

test("attemptCountBucket buckets attempts", () => {
  assert.equal(attemptCountBucket(1), "1");
  assert.equal(attemptCountBucket(2), "2");
  assert.equal(attemptCountBucket(5), "3_5");
  assert.equal(attemptCountBucket(6), "6_plus");
  assert.equal(attemptCountBucket(0), "1");
});

test("httpStatusClass keeps 429 separate", () => {
  assert.equal(httpStatusClass(null), "none");
  assert.equal(httpStatusClass(200), "2xx");
  assert.equal(httpStatusClass(404), "4xx");
  assert.equal(httpStatusClass(429), "429");
  assert.equal(httpStatusClass(503), "5xx");
});

test("exitCodeClass buckets exit codes", () => {
  assert.equal(exitCodeClass(0), "zero");
  assert.equal(exitCodeClass(1), "one");
  assert.equal(exitCodeClass(2), "two");
  assert.equal(exitCodeClass(7), "three_to_10");
  assert.equal(exitCodeClass(100), "11_to_127");
  assert.equal(exitCodeClass(137), "128_plus");
  assert.equal(exitCodeClass(null), "unknown");
});

test("inputMode reflects which inputs were present", () => {
  assert.equal(inputMode({}), "none");
  assert.equal(inputMode({ hasArguments: true }), "arguments");
  assert.equal(inputMode({ hasStdin: true }), "stdin");
  assert.equal(inputMode({ hasFiles: true }), "files");
  assert.equal(inputMode({ hasStdin: true, hasFiles: true }), "stdin_and_files");
});

test("clampCount clamps to [0,100]", () => {
  assert.equal(clampCount(-1), 0);
  assert.equal(clampCount(50), 50);
  assert.equal(clampCount(1000), 100);
  assert.equal(clampCount(3.9), 3);
  assert.equal(clampCount(NaN), 0);
});

test("normalizeDuration clamps to 24h and rejects negatives", () => {
  assert.equal(normalizeDuration(null), null);
  assert.equal(normalizeDuration(-5), null);
  assert.equal(normalizeDuration(1234), 1234);
  assert.equal(normalizeDuration(999999999), 86400000);
});

test("provider/platform/arch categories map to enums", () => {
  assert.equal(providerCategory("openai"), "openai_compatible");
  assert.equal(providerCategory("ollama"), "ollama");
  assert.equal(providerCategory("codex"), "codex");
  assert.equal(providerCategory("weird"), "unknown");
  assert.equal(platformCategory("linux"), "linux");
  assert.equal(platformCategory("sunos"), "other");
  assert.equal(archCategory("arm64"), "arm64");
  assert.equal(archCategory("mips"), "other");
  assert.equal(nodeMajor("v18.20.1"), 18);
  assert.equal(nodeMajor("garbage"), 0);
});

test("classifyModelError derives coarse category and status class", () => {
  assert.deepEqual(classifyModelError(new Error("OpenAI error 429: slow down")), {
    errorCategory: "rate_limited",
    httpStatusClass: "429",
  });
  assert.deepEqual(classifyModelError(new Error("Ollama error 500: boom")), {
    errorCategory: "provider_5xx",
    httpStatusClass: "5xx",
  });
  assert.deepEqual(classifyModelError(new Error("OpenAI error 401: nope")), {
    errorCategory: "authentication",
    httpStatusClass: "4xx",
  });
  assert.deepEqual(classifyModelError(new Error("request timed out after 1000ms")), {
    errorCategory: "timeout",
    httpStatusClass: "none",
  });
  assert.deepEqual(classifyModelError(new Error("Failed to connect to http://x (ECONNREFUSED)")), {
    errorCategory: "network",
    httpStatusClass: "none",
  });
});

test("httpErrorCategory maps status ranges", () => {
  assert.equal(httpErrorCategory(403), "authorization");
  assert.equal(httpErrorCategory(422), "provider_4xx");
  assert.equal(httpErrorCategory(502), "provider_5xx");
});
