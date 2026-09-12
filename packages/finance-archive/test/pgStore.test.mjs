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
  archiveSchemaOf,
  closeArchiveClient,
  createArchiveClient,
  createArchivePool,
  createReconnectBudget,
  isConnectionLostError,
  withArchiveTransaction,
  withReconnect,
} from "../dist/index.js";

import { archive, count, skip } from "./helpers/pgArchive.mjs";

const url = process.env.FINANCE_ARCHIVE_DATABASE_URL;

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

// --- F1-69: withReconnect ----------------------------------------------
//
// A connection the server (or the network) drops mid-run must not crash the
// whole process (see createArchiveClient's own doc comment for the 'error'
// listener that prevents that) and must not retry forever either. These two
// tests exercise withReconnect's actual reconnect step against a real,
// throwaway Postgres -- `attempt` itself is a fake that always reports the
// connection as lost, so the reconnect count is exact and nothing races a
// live subprocess.

test("isConnectionLostError recognizes 57P01/57P02, class-08, and the two Node socket codes, and nothing else", () => {
  for (const code of ["57P01", "57P02", "08000", "08003", "08006", "08001", "ECONNRESET", "EPIPE"]) {
    assert.equal(
      isConnectionLostError({ code }),
      true,
      `${code} must be treated as a connection-lost error`,
    );
  }
  for (const code of ["23505", "42501", "22003", undefined]) {
    assert.equal(
      isConnectionLostError({ code }),
      false,
      `${code} must not be treated as a connection-lost error`,
    );
  }
  assert.equal(isConnectionLostError(new Error("plain error, no code")), false);
  assert.equal(isConnectionLostError("not even an object"), false);
});

/**
 * A client `withReconnect` is free to end and replace, on the schema
 * `archive(t)` already provisioned -- never `archive(t)`'s own client. That
 * one is closed by `t.after` from inside `archive()` itself (and its
 * `DROP SCHEMA` runs through it too), so a test that let `withReconnect` end
 * it out from under that hook would leave the hook running `DROP SCHEMA`/
 * `.end()` against an already-dead connection.
 */
async function reconnectableClient(t) {
  const owner = await archive(t);
  const client = createArchiveClient(url, archiveSchemaOf(owner));
  await client.connect();
  return client;
}

test(
  "withReconnect reconnects on a fresh client and retries after a connection-lost failure",
  { skip },
  async (t) => {
    let current = await reconnectableClient(t);
    const opened = [current];
    t.after(async () => {
      for (const client of opened) await client.end().catch(() => {});
    });
    const budget = createReconnectBudget(3);
    let attempts = 0;
    const result = await withReconnect(
      budget,
      () => current,
      (client) => {
        current = client;
        opened.push(client);
      },
      async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("terminating connection due to administrator command");
          error.code = "57P01";
          throw error;
        }
        // The retry runs against whatever `current` now is -- proof that a
        // caller reading the client through the same closure `setClient`
        // updates picks up the fresh connection automatically.
        return count(current, "institutions");
      },
    );
    assert.equal(result, 0, "the retried attempt actually ran (and against a live connection)");
    assert.equal(attempts, 2, "exactly one retry for exactly one failure");
    assert.equal(budget.remaining, 2, "exactly one reconnect spent from the budget");
    assert.notEqual(current, opened[0], "the client in use changed to a new one");
  },
);

test(
  "withReconnect stops after its reconnect budget is spent, with a clear message, rather than retrying forever",
  { skip },
  async (t) => {
    let current = await reconnectableClient(t);
    const opened = [current];
    t.after(async () => {
      for (const client of opened) await client.end().catch(() => {});
    });
    const budget = createReconnectBudget(2);
    let attempts = 0;
    const alwaysConnectionLost = async () => {
      attempts += 1;
      const error = new Error("terminating connection due to administrator command");
      error.code = "57P01";
      throw error;
    };
    await assert.rejects(
      () =>
        withReconnect(
          budget,
          () => current,
          (client) => {
            current = client;
            opened.push(client);
          },
          alwaysConnectionLost,
        ),
      (error) => {
        assert.match(
          String(error.message),
          /archive connection lost and the reconnect budget \(2 per run\) is already spent/,
        );
        return true;
      },
    );
    // The first attempt, plus one retry per reconnect the budget allowed.
    assert.equal(attempts, 3);
    assert.equal(budget.remaining, 0);
    // Giving up leaves the caller with a live connection, not a dead one --
    // the last reconnect succeeded, only the wrapped `attempt` kept failing.
    await current.query("SELECT 1");
  },
);
