// Synthetic-fixture unit tests for `withSerializationRetry`: no database, a
// fake `work` function that throws plain objects shaped like `pg`'s
// `DatabaseError` (`{ code: "40001" }` / `{ code: "40P01" }`).

import assert from "node:assert/strict";
import test from "node:test";

import { isSerializationFailure, withSerializationRetry } from "../dist/retry.js";

function serializationFailure(code = "40001") {
  const error = new Error("could not serialize access due to read/write dependencies among transactions");
  error.code = code;
  return error;
}

test("isSerializationFailure recognizes 40001 and 40P01 only", () => {
  assert.equal(isSerializationFailure(serializationFailure("40001")), true);
  assert.equal(isSerializationFailure(serializationFailure("40P01")), true);
  assert.equal(isSerializationFailure(serializationFailure("23505")), false);
  assert.equal(isSerializationFailure(new Error("plain error")), false);
  assert.equal(isSerializationFailure(null), false);
  assert.equal(isSerializationFailure("a string"), false);
});

test("withSerializationRetry succeeds on the third attempt after two 40001 failures", async () => {
  let calls = 0;
  const sleeps = [];
  const retries = [];
  const result = await withSerializationRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw serializationFailure("40001");
      return "ok";
    },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onRetry: (attempt) => retries.push(attempt),
    },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3, "expected exactly three attempts");
  assert.equal(sleeps.length, 2, "expected a backoff wait before each retry");
  assert.deepEqual(retries, [1, 2]);
});

test("withSerializationRetry also retries a 40P01 deadlock", async () => {
  let calls = 0;
  const result = await withSerializationRetry(
    async () => {
      calls += 1;
      if (calls < 2) throw serializationFailure("40P01");
      return "ok";
    },
    { sleep: async () => {} },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("withSerializationRetry gives up after the attempt budget and rethrows the last error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withSerializationRetry(
        async () => {
          calls += 1;
          throw serializationFailure("40001");
        },
        { attempts: 3, sleep: async () => {} },
      ),
    (error) => {
      assert.equal(isSerializationFailure(error), true);
      return true;
    },
  );
  assert.equal(calls, 3, "expected exactly three attempts, not a fourth");
});

test("withSerializationRetry never retries a non-serialization error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withSerializationRetry(
        async () => {
          calls += 1;
          throw new Error("unique constraint violated");
        },
        { sleep: async () => {} },
      ),
    /unique constraint violated/,
  );
  assert.equal(calls, 1, "a non-serialization error must not be retried");
});

test("withSerializationRetry defaults to three total attempts", async () => {
  let calls = 0;
  await assert.rejects(() =>
    withSerializationRetry(
      async () => {
        calls += 1;
        throw serializationFailure();
      },
      { sleep: async () => {} },
    ),
  );
  assert.equal(calls, 3);
});
