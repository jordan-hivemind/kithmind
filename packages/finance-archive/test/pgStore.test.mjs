// closeArchiveClient (pgStore.ts), pure logic against fake clients -- no
// database required, so this runs in every clone regardless of
// FINANCE_ARCHIVE_DATABASE_URL, the same way money.test.mjs and
// pgMoney.test.mjs's validation tests do.
//
// F1-36: `run.ts`'s `finally` block used to call `pgClient.end()` directly.
// node-postgres' own `end()` waits for the connection's `end` event, and a
// connection already torn down (by the server, or by an earlier query
// error) does not reliably fire another one -- so a real run sat idle for
// 26 minutes with its actual transaction error never printed, because the
// `finally` awaiting `end()` blocks everything after it, including the
// `catch` that would have printed it. `closeArchiveClient` races `end()`
// against a short timeout instead of trusting it to always settle.

import assert from "node:assert/strict";
import test from "node:test";

import { closeArchiveClient } from "../dist/index.js";

test("closeArchiveClient does not hang on a client whose end() never resolves", async () => {
  const fakeClient = {
    end() {
      return new Promise(() => {
        // Never settles -- the exact failure mode a torn-down connection
        // produced in the real run this defect is named for.
      });
    },
  };
  const start = Date.now();
  await closeArchiveClient(fakeClient, 50);
  const elapsed = Date.now() - start;
  assert.ok(
    elapsed < 2_000,
    `closeArchiveClient should return near its timeout, not hang; took ${elapsed}ms`,
  );
});

test("closeArchiveClient resolves as soon as a well-behaved end() does, without waiting for the timeout", async () => {
  let ended = false;
  const fakeClient = {
    async end() {
      ended = true;
    },
  };
  const start = Date.now();
  await closeArchiveClient(fakeClient, 5_000);
  const elapsed = Date.now() - start;
  assert.equal(ended, true);
  assert.ok(
    elapsed < 1_000,
    `should not wait out the full timeout when end() already resolved; took ${elapsed}ms`,
  );
});

test("closeArchiveClient never rejects, even when end() itself throws", async () => {
  const fakeClient = {
    end() {
      return Promise.reject(new Error("connection already destroyed"));
    },
  };
  await assert.doesNotReject(() => closeArchiveClient(fakeClient, 50));
});
