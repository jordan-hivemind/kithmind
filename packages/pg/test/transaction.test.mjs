// The statements the shared transaction helper issues, against a fake client.
//
// No database: what matters here is the exact sequence, because the finance
// archive's whole publication mechanism rests on it and P2-39a moved the code
// out from under that archive. A plain call must still issue exactly `BEGIN` and
// the `search_path` pin, in that order, and nothing else.

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPgSchemaName,
  inSchemaTransaction,
  pinSchema,
  pinnedSchemaOf,
  readerRoleName,
  withSchemaTransaction,
} from "../dist/index.js";

function fakeClient(failOn) {
  const issued = [];
  return {
    issued,
    async query(sql) {
      issued.push(sql);
      if (sql === failOn) throw new Error(`refused: ${sql}`);
      return { rows: [] };
    },
  };
}

test("a plain transaction is BEGIN, the schema pin, and COMMIT", async () => {
  const client = fakeClient();
  assert.equal(
    await withSchemaTransaction(client, "finance", async () => "done"),
    "done",
  );
  assert.deepEqual(client.issued, [
    "BEGIN",
    "SET LOCAL search_path TO finance",
    "COMMIT",
  ]);
});

test("isolation and timeouts are added only when asked for", async () => {
  const client = fakeClient();
  await withSchemaTransaction(client, "kith", async () => null, {
    isolation: "SERIALIZABLE",
    statementTimeoutMs: 5_000,
    lockTimeoutMs: 2_000,
    idleInTransactionTimeoutMs: 5_000,
  });
  assert.deepEqual(client.issued, [
    "BEGIN ISOLATION LEVEL SERIALIZABLE",
    "SET LOCAL search_path TO kith",
    "SET LOCAL statement_timeout = '5000ms'",
    "SET LOCAL lock_timeout = '2000ms'",
    "SET LOCAL idle_in_transaction_session_timeout = '5000ms'",
    "COMMIT",
  ]);
  for (const options of [
    { statementTimeoutMs: 0 },
    { lockTimeoutMs: -1 },
    { idleInTransactionTimeoutMs: 1.5 },
  ]) {
    await assert.rejects(
      withSchemaTransaction(fakeClient(), "kith", async () => null, options),
      /positive whole number of milliseconds/,
    );
  }
});

test("an inner call joins the open transaction rather than opening a second", async () => {
  const client = fakeClient();
  await withSchemaTransaction(client, "finance", async (outer) => {
    assert.equal(inSchemaTransaction(outer), true);
    await withSchemaTransaction(outer, "finance", async () => {
      await outer.query("SELECT 1");
    });
  });
  assert.deepEqual(client.issued, [
    "BEGIN",
    "SET LOCAL search_path TO finance",
    "SELECT 1",
    "COMMIT",
  ]);
  assert.equal(inSchemaTransaction(client), false);
});

test("a failure rolls back, rethrows, and leaves the client usable", async () => {
  const client = fakeClient("boom");
  await assert.rejects(
    withSchemaTransaction(client, "finance", (inner) => inner.query("boom")),
    /refused: boom/,
  );
  assert.deepEqual(client.issued, [
    "BEGIN",
    "SET LOCAL search_path TO finance",
    "boom",
    "ROLLBACK",
  ]);
  // The open-transaction mark is released on the failure path, or every later
  // transaction on this client would silently join a transaction that is gone.
  assert.equal(inSchemaTransaction(client), false);
  await withSchemaTransaction(client, "finance", async () => null);
  assert.deepEqual(client.issued.slice(4), [
    "BEGIN",
    "SET LOCAL search_path TO finance",
    "COMMIT",
  ]);
});

test("a schema name is a validated identifier, never an escaped string", () => {
  assert.equal(assertPgSchemaName("kith"), "kith");
  assert.equal(
    assertPgSchemaName("finance_archive_test_9f"),
    "finance_archive_test_9f",
  );
  for (const name of [
    "",
    "Finance",
    "finance-archive",
    "finance; DROP SCHEMA kith",
    "public.finance",
    `"finance"`,
    "a".repeat(64),
  ]) {
    assert.throws(
      () => assertPgSchemaName(name, "archive"),
      /is not a usable archive schema name/,
    );
  }
  const client = fakeClient();
  assert.equal(pinnedSchemaOf(client), undefined);
  assert.equal(pinSchema(client, "kith"), "kith");
  assert.equal(pinnedSchemaOf(client), "kith");
});

test("a reader role is derived from its schema", () => {
  assert.equal(readerRoleName("finance"), "finance_reader");
  assert.equal(readerRoleName("kith"), "kith_reader");
  assert.throws(() => readerRoleName("a".repeat(60)), /reader role name/);
});
