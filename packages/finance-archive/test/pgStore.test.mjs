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
//
// F1-52: `createArchivePool` used to put `search_path` in the connection's
// startup packet, which the archive's production endpoint (PgBouncer,
// transaction mode) rejects outright -- "unsupported startup parameter in
// options: search_path" -- so every pooled connection failed before a query
// ever ran. The pool-config test below needs no database; the
// `withArchiveTransaction` test does and skips cleanly without one, the same
// way pgSchema.test.mjs does.

import assert from "node:assert/strict";
import test from "node:test";

import {
  closeArchiveClient,
  createArchivePool,
  withArchiveTransaction,
} from "../dist/index.js";

import { archive, count, skip } from "./helpers/pgArchive.mjs";

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

test("createArchivePool sends no `options` startup parameter, so a transaction-pooled endpoint accepts the connection", async () => {
  const pool = createArchivePool("postgresql://user:pass@example.invalid/db", "finance");
  try {
    assert.ok(
      !("options" in pool.options) || pool.options.options === undefined,
      "the pool's connection config must not set `options`, which PgBouncer's " +
        "transaction pooling rejects as an unsupported startup parameter",
    );
  } finally {
    await pool.end();
  }
});

test(
  "withArchiveTransaction resolves the archive schema even when the connection's own search_path was reset to public",
  { skip },
  async (t) => {
    const client = await archive(t);
    // Simulates exactly what a pooler can hand back: a connection whose
    // ambient search_path is not the archive's. `SET` here (not `SET LOCAL`)
    // is deliberate -- it is session-level and outlives this statement,
    // which is the failure mode `withArchiveTransaction`'s own `SET LOCAL`
    // has to survive.
    await client.query("SET search_path TO public");
    const institutionCount = await withArchiveTransaction(client, (tx) =>
      count(tx, "institutions"),
    );
    assert.equal(
      institutionCount,
      0,
      "querying the unqualified table name must resolve inside the archive " +
        "schema, not fail with 'relation does not exist' against public",
    );
  },
);
