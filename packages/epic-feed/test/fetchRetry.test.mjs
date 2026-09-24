// `fetchWithRetry`'s backoff behavior for 429 and 5xx, with an injected
// clock so no test actually waits.

import assert from "node:assert/strict";
import test from "node:test";

import { fetchWithRetry } from "../dist/index.js";

function response(status, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

function fakeSleep() {
  const waits = [];
  return { waits, sleep: async (ms) => waits.push(ms) };
}

test("fetchWithRetry returns immediately on a non-retryable status", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response(404);
  };
  const result = await fetchWithRetry("https://example/x", {}, fetchImpl);
  assert.equal(result.status, 404);
  assert.equal(calls, 1);
});

test("fetchWithRetry retries 429 with exponential backoff and then succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls < 3 ? response(429) : response(200);
  };
  const { sleep, waits } = fakeSleep();
  const result = await fetchWithRetry("https://example/x", {}, fetchImpl, {
    baseDelayMs: 100,
    sleep,
  });
  assert.equal(result.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [100, 200]);
});

test("fetchWithRetry honors Retry-After over its own backoff", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1 ? response(429, { "retry-after": "5" }) : response(200);
  };
  const { sleep, waits } = fakeSleep();
  await fetchWithRetry("https://example/x", {}, fetchImpl, { sleep });
  assert.deepEqual(waits, [5000]);
});

test("fetchWithRetry retries a 5xx and gives up after maxAttempts", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response(503);
  };
  const { sleep } = fakeSleep();
  const result = await fetchWithRetry("https://example/x", {}, fetchImpl, {
    maxAttempts: 3,
    baseDelayMs: 10,
    sleep,
  });
  assert.equal(result.status, 503);
  assert.equal(calls, 3);
});
