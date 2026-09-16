// withKithTransaction's retry backoff, against a fake pool -- no database
// needed, so this runs in every clone including one with no Postgres
// configured.
//
// The failure this proves fixed: under the full parallel suite, two
// concurrent upserts each retried three attempts with no delay between them
// and collided on every one. A fake pool whose client fails with `40001` a
// fixed number of times stands in for that collision without needing two
// real transactions to actually race.

import assert from "node:assert/strict";
import test from "node:test";

import {
  KITH_SERIALIZATION_ATTEMPTS,
  KITH_SERIALIZATION_BACKOFF_BASE_MS,
  KITH_SERIALIZATION_BACKOFF_MAX_MS,
  kithSerializationBackoffDelayMs,
  setKithSerializationSleep,
  withKithQueueTransaction,
  withKithTransaction,
} from "../dist/index.js";

function serializationFailure() {
  const error = new Error(
    "could not serialize access due to read/write dependencies among transactions",
  );
  error.code = "40001";
  return error;
}

/**
 * A pool whose `connect()` hands out a fresh fake client per attempt. The
 * client's one meaningful query, `"WORK"`, fails with a serialization error
 * on the first `failures` attempts and succeeds after; `BEGIN`, `SET LOCAL`,
 * `COMMIT` and `ROLLBACK` always succeed, which is all `withSchemaTransaction`
 * needs to drive the transaction around it.
 */
function fakeSerializationPool(failures, makeFailure = serializationFailure) {
  let connectCount = 0;
  const pool = {
    connectCount: 0,
    statements: [],
    async connect() {
      connectCount += 1;
      pool.connectCount = connectCount;
      const attempt = connectCount;
      return {
        released: false,
        async query(sql) {
          pool.statements.push(typeof sql === "string" ? sql : sql.text);
          if (sql === "WORK") {
            if (attempt <= failures) throw makeFailure();
            return { rows: [{ attempt }] };
          }
          // BEGIN [ISOLATION LEVEL ...], SET LOCAL ..., COMMIT, ROLLBACK.
          return { rows: [] };
        },
        release() {
          this.released = true;
        },
      };
    },
  };
  return pool;
}

const work = (client) => client.query("WORK");

test("kithSerializationBackoffDelayMs doubles per attempt with full jitter, capped", () => {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const cap = Math.min(
      KITH_SERIALIZATION_BACKOFF_MAX_MS,
      KITH_SERIALIZATION_BACKOFF_BASE_MS * 2 ** (attempt - 1),
    );
    for (let sample = 0; sample < 20; sample += 1) {
      const delay = kithSerializationBackoffDelayMs(attempt);
      assert.ok(
        delay >= 0,
        `delay ${delay} for attempt ${attempt} is negative`,
      );
      assert.ok(
        delay <= cap,
        `delay ${delay} for attempt ${attempt} exceeds cap ${cap}`,
      );
    }
  }
  // Full jitter, not a fixed doubled value: repeated draws for the same
  // attempt are not all identical.
  const draws = Array.from({ length: 20 }, () =>
    kithSerializationBackoffDelayMs(3),
  );
  assert.ok(new Set(draws).size > 1, "expected varied delays, got a constant");
});

test("withKithTransaction backs off between retries and succeeds once the collision clears", async (t) => {
  const delays = [];
  const restore = setKithSerializationSleep(async (ms) => {
    delays.push(ms);
  });
  t.after(restore);

  const pool = fakeSerializationPool(2);
  const result = await withKithTransaction(pool, work);

  assert.equal(result.rows[0].attempt, 3);
  assert.equal(pool.connectCount, 3);
  // A delay after attempt 1's failure and after attempt 2's failure; none
  // after attempt 3, which succeeded.
  assert.equal(delays.length, 2);
  for (const delay of delays) {
    assert.ok(delay >= 0 && delay <= KITH_SERIALIZATION_BACKOFF_MAX_MS);
  }
});

test("withKithTransaction skips the backoff on the final, unretried attempt", async (t) => {
  const delays = [];
  const restore = setKithSerializationSleep(async (ms) => {
    delays.push(ms);
  });
  t.after(restore);

  const pool = fakeSerializationPool(KITH_SERIALIZATION_ATTEMPTS);
  await assert.rejects(
    withKithTransaction(pool, work),
    (error) => error.code === "40001",
  );

  assert.equal(pool.connectCount, KITH_SERIALIZATION_ATTEMPTS);
  // One fewer delay than attempts: nothing sleeps after the last attempt,
  // since there is no retry left to wait for.
  assert.equal(delays.length, KITH_SERIALIZATION_ATTEMPTS - 1);
});

test("withKithTransaction does not retry a non-serialization error", async (t) => {
  const delays = [];
  const restore = setKithSerializationSleep(async (ms) => {
    delays.push(ms);
  });
  t.after(restore);

  const pool = fakeSerializationPool(0);
  const boom = new Error('syntax error at or near "WORK"');
  boom.code = "42601";

  await assert.rejects(
    withKithTransaction(pool, async (client) => {
      await client.query("WORK");
      throw boom;
    }),
    (error) => error === boom,
  );

  assert.equal(pool.connectCount, 1, "must not open a second attempt");
  assert.equal(delays.length, 0, "must not sleep for a non-40001 error");
});

function deadlock() {
  const error = new Error("deadlock detected");
  error.code = "40P01";
  return error;
}

test("withKithTransaction retries a deadlock (40P01) under the same budget", async (t) => {
  const delays = [];
  const restore = setKithSerializationSleep(async (ms) => {
    delays.push(ms);
  });
  t.after(restore);

  const pool = fakeSerializationPool(1, deadlock);
  const result = await withKithTransaction(pool, work);
  assert.equal(result.rows[0].attempt, 2);
  assert.equal(pool.connectCount, 2);
  assert.equal(delays.length, 1);
});

test("withKithQueueTransaction opens READ COMMITTED and keeps the retry loop", async (t) => {
  const restore = setKithSerializationSleep(async () => {});
  t.after(restore);

  const pool = fakeSerializationPool(1, deadlock);
  const result = await withKithQueueTransaction(pool, work);
  assert.equal(result.rows[0].attempt, 2);

  const begins = pool.statements.filter((sql) => /^BEGIN/.test(sql));
  assert.equal(begins.length, 2);
  for (const begin of begins) {
    assert.match(begin, /READ COMMITTED/);
    assert.doesNotMatch(begin, /SERIALIZABLE|READ ONLY/);
  }
  // And the ordinary write wrapper still asks for SERIALIZABLE, so the two
  // are not one function with two names.
  const serializable = fakeSerializationPool(0);
  await withKithTransaction(serializable, work);
  assert.match(
    serializable.statements.find((sql) => /^BEGIN/.test(sql)),
    /SERIALIZABLE/,
  );
});
