// `withKithReadTransaction`: the read shape section 4.2 of the web and MCP
// surface plan adds, proven against a real server rather than by reading the
// `BEGIN`.
//
// The property that matters is not that the helper avoids writing. It is that
// the *server* refuses a write inside it, so a read path cannot acquire write
// access by mistake, by a later edit, or by calling a service function that
// turned out to touch a row. SQLSTATE 25006 is that refusal, and it has to come
// back from Postgres, which is why this suite needs a database.

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyKithSchema,
  createKithPool,
  newKithId,
  withKithReadTransaction,
  withKithTransaction,
} from "../dist/index.js";
import { connect, skip, throwawayDatabase } from "./helpers/pgDatabase.mjs";

/** A migrated throwaway database and a pool on it, both closed by the test. */
async function migratedPool(t) {
  const database = await throwawayDatabase(t);
  const client = await connect(database);
  await applyKithSchema(client);
  const pool = createKithPool(database.url);
  // The throwaway database is dropped `WITH (FORCE)`, which terminates whatever
  // this pool still holds. A terminated idle client re-emits on the pool, and
  // with no listener that is an uncaught exception rather than a tidy teardown.
  pool.on("error", () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
  });
  return pool;
}

test("a read transaction is read only at the server", { skip }, async (t) => {
  const pool = await migratedPool(t);

  const modes = await withKithReadTransaction(pool, async (client) => {
    const settings = await client.query(
      `SELECT current_setting('transaction_isolation') AS isolation,
              current_setting('transaction_read_only') AS read_only,
              current_setting('search_path') AS search_path`,
    );
    return settings.rows[0];
  });
  assert.equal(modes.isolation, "repeatable read");
  assert.equal(modes.read_only, "on");
  // Still pinned to `kith` alone, exactly as the write transaction pins it.
  assert.equal(modes.search_path, "kith");

  // The write is refused by Postgres, with the code that says why, and the
  // transaction does not commit half of anything.
  const refused = await withKithReadTransaction(pool, async (client) => {
    try {
      await client.query(
        "INSERT INTO kith.users (id) VALUES ($1)",
        [newKithId()],
      );
      return null;
    } catch (error) {
      return error;
    }
  }).catch((error) => error);
  assert.equal(refused.code, "25006");

  // And the same statement is accepted by the write helper, so the refusal
  // above is the transaction mode and not a broken statement.
  const userId = newKithId();
  await withKithTransaction(pool, (client) =>
    client.query("INSERT INTO kith.users (id) VALUES ($1)", [userId]),
  );
  const present = await withKithReadTransaction(pool, (client) =>
    client.query("SELECT id FROM kith.users WHERE id = $1", [userId]),
  );
  assert.equal(present.rows.length, 1);
});

test(
  "a read transaction does not retry, and surfaces its own failure",
  { skip },
  async (t) => {
    const pool = await migratedPool(t);
    let attempts = 0;
    const failure = await withKithReadTransaction(pool, async () => {
      attempts += 1;
      throw new Error("read_failed");
    }).catch((error) => error.message);
    // One attempt: a read that writes nothing has no serialization failure to
    // retry, so the caller sees its own error rather than paying for a loop.
    assert.equal(attempts, 1);
    assert.equal(failure, "read_failed");
  },
);
