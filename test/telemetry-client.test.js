import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBatch,
  selectBatchEvents,
  parseRetryAfter,
  sendBatch,
} from "../src/telemetry/client.js";

function ev(id) {
  return {
    event_id: id,
    event_name: "command_completed",
    action: "ask",
    occurred_at: "2026-07-14T00:00:00.000Z",
    properties: {},
  };
}

function fakeResponse(status, { body, headers } = {}) {
  return {
    status,
    headers: { get: (name) => (headers ? headers[name.toLowerCase()] ?? null : null) },
    async text() {
      return body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

const batchOf = (ids) => buildBatch(ids.map(ev), { batchId: "b".repeat(36), sentAtMs: 0 });

test("buildBatch produces a v1 envelope", () => {
  const batch = buildBatch([ev("a")], { batchId: "id", sentAtMs: 0 });
  assert.equal(batch.schema_version, 1);
  assert.equal(batch.batch_id, "id");
  assert.equal(batch.sent_at, "1970-01-01T00:00:00.000Z");
  assert.equal(batch.events.length, 1);
});

test("selectBatchEvents caps at the event count", () => {
  const many = Array.from({ length: 80 }, (_, i) => ev(`id-${i}`));
  assert.equal(selectBatchEvents(many).length, 50);
});

test("parseRetryAfter handles seconds and dates", () => {
  assert.equal(parseRetryAfter("120", 0), 120000);
  assert.equal(parseRetryAfter(null, 0), null);
  assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:00:10 GMT", 0), 10000);
});

test("202 with a well-formed body removes accepted+duplicate+rejected ids", async () => {
  const batch = batchOf(["a", "b", "c"]);
  const plan = await sendBatch(batch, {
    fetchImpl: async () =>
      fakeResponse(202, {
        body: {
          request_id: "r",
          accepted_event_ids: ["a"],
          duplicate_event_ids: ["b"],
          rejected: [{ event_id: "c", code: "invalid_event", message: "bad" }],
          server_time: "2026-07-14T00:00:00.000Z",
        },
      }),
  });
  assert.equal(plan.success, true);
  assert.deepEqual([...plan.removeIds].sort(), ["a", "b", "c"]);
  assert.equal(plan.applyBackoff, false);
});

test("202 with an empty/malformed body retains and backs off", async () => {
  const batch = batchOf(["a"]);
  const plan = await sendBatch(batch, { fetchImpl: async () => fakeResponse(202, { body: "" }) });
  assert.equal(plan.success, false);
  assert.equal(plan.retainAll, true);
  assert.equal(plan.failureCategory, "parse");
});

test("400/415/422 discards only identified invalid events, else the whole batch", async () => {
  const identified = await sendBatch(batchOf(["a", "b"]), {
    fetchImpl: async () =>
      fakeResponse(422, { body: { rejected: [{ event_id: "a", code: "x" }] } }),
  });
  assert.deepEqual(identified.removeIds, ["a"]);
  assert.equal(identified.success, false);

  const blanket = await sendBatch(batchOf(["a", "b"]), {
    fetchImpl: async () => fakeResponse(400, { body: {} }),
  });
  assert.deepEqual(blanket.removeIds.sort(), ["a", "b"]); // avoids infinite retry
});

test("413 retains events and requests a shrink", async () => {
  const plan = await sendBatch(batchOf(["a"]), { fetchImpl: async () => fakeResponse(413) });
  assert.equal(plan.retainAll, true);
  assert.equal(plan.shrink, true);
});

test("429 retains and honors Retry-After", async () => {
  const plan = await sendBatch(batchOf(["a"]), {
    nowMs: 0,
    fetchImpl: async () => fakeResponse(429, { headers: { "retry-after": "30" } }),
  });
  assert.equal(plan.retainAll, true);
  assert.equal(plan.failureCategory, "rate_limited");
  assert.equal(plan.retryAfterMs, 30000);
});

test("5xx retains and backs off", async () => {
  const plan = await sendBatch(batchOf(["a"]), { fetchImpl: async () => fakeResponse(503) });
  assert.equal(plan.retainAll, true);
  assert.equal(plan.failureCategory, "server_error");
  assert.equal(plan.applyBackoff, true);
});

for (const [label, err] of [
  ["DNS failure", Object.assign(new Error("getaddrinfo ENOTFOUND api.getgac.dev"), {})],
  ["connection refused", Object.assign(new Error("connect ECONNREFUSED"), {})],
  ["TLS failure", new Error("self signed certificate in certificate chain")],
  ["timeout/abort", Object.assign(new Error("aborted"), { name: "AbortError" })],
]) {
  test(`transport failure retains and never throws: ${label}`, async () => {
    const plan = await sendBatch(batchOf(["a"]), {
      fetchImpl: async () => {
        throw err;
      },
    });
    assert.equal(plan.retainAll, true);
    assert.equal(plan.success, false);
    assert.equal(plan.applyBackoff, true);
  });
}

test("invalid JSON on a 200 retains", async () => {
  const plan = await sendBatch(batchOf(["a"]), {
    fetchImpl: async () => fakeResponse(200, { body: "<html>not json</html>" }),
  });
  assert.equal(plan.retainAll, true);
  assert.equal(plan.failureCategory, "parse");
});
