// Read-only enforcement for run_query. This is the security-critical part of
// F1-6: it gets a tier 2 review before the server is pointed at real data, so
// every attack the plan names is exercised here individually, against the
// same runReadOnlyQuery the MCP tool calls.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openArchive, toMinorUnits } from "../dist/index.js";
import {
  MAX_QUERY_MS,
  MAX_QUERY_ROWS,
  openReadOnlyQueryConnection,
  runReadOnlyQuery,
} from "../dist/mcp/queryGuard.js";

const INSTITUTION = {
  id: "inst_river_oak",
  name: "River Oak Bank",
  slug: "river-oak",
};
const ACCOUNT = { id: "acct_checking", last4: "1200", currency: "USD" };

/**
 * Opens a throwaway archive, seeds an institution/account/transactions
 * through a normal writable connection, then returns both that writable
 * connection (for setup only) and a guarded read-only connection over the
 * same file -- the one under test.
 */
function fixture(t, rowCount = 3) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-guard-"));
  const dbPath = join(directory, "archive.db");
  const writable = openArchive(dbPath);
  writable
    .prepare("INSERT INTO institutions (id, name, slug) VALUES (?, ?, ?)")
    .run(INSTITUTION.id, INSTITUTION.name, INSTITUTION.slug);
  writable
    .prepare(
      "INSERT INTO accounts (id, institution_id, acct_last4, base_currency) VALUES (?, ?, ?, ?)",
    )
    .run(ACCOUNT.id, INSTITUTION.id, ACCOUNT.last4, ACCOUNT.currency);
  for (let i = 0; i < rowCount; i += 1) {
    writable
      .prepare(
        `INSERT INTO transactions
           (id, account_id, process_date, activity_type, description, amount, currency, row_hash, imported_at)
         VALUES (?, ?, ?, 'fee', 'Synthetic fee', ?, 'USD', ?, '2026-01-01T00:00:00.000Z')`,
      )
      .run(
        `txn_${i}`,
        ACCOUNT.id,
        "2026-01-0" + (i + 1),
        toMinorUnits("-5.00", "USD"),
        `hash_${i}`,
      );
  }
  const guarded = openReadOnlyQueryConnection(dbPath);
  t.after(() => {
    guarded.close();
    writable.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return guarded;
}

test("a plain read-only SELECT works", (t) => {
  const db = fixture(t);
  const result = runReadOnlyQuery(db, "SELECT count(*) AS n FROM transactions");
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].n, 3n);
  assert.equal(result.truncated, false);
});

test("every write statement is denied", (t) => {
  const db = fixture(t);
  const writes = [
    "INSERT INTO transactions (id, account_id, process_date, activity_type, amount, currency, row_hash, imported_at) VALUES ('x','acct_checking','2026-01-01','fee',-1,'USD','h','now')",
    "UPDATE transactions SET amount = 0",
    "DELETE FROM transactions",
    "DROP TABLE transactions",
    "ALTER TABLE transactions ADD COLUMN evil TEXT",
    "CREATE TABLE evil (id INTEGER)",
    "REPLACE INTO transactions (id, account_id, process_date, activity_type, amount, currency, row_hash, imported_at) VALUES ('txn_0','acct_checking','2026-01-01','fee',0,'USD','hash_0','now')",
    "TRUNCATE TABLE transactions",
  ];
  for (const sql of writes) {
    assert.throws(() => runReadOnlyQuery(db, sql), undefined, sql);
  }
});

test("ATTACH and DETACH are denied", (t) => {
  const db = fixture(t);
  assert.throws(() =>
    runReadOnlyQuery(db, "ATTACH DATABASE ':memory:' AS other"),
  );
  assert.throws(() => runReadOnlyQuery(db, "DETACH DATABASE other"));
});

test("mutating and reading PRAGMAs are both denied", (t) => {
  const db = fixture(t);
  assert.throws(() => runReadOnlyQuery(db, "PRAGMA journal_mode = DELETE"));
  assert.throws(() => runReadOnlyQuery(db, "PRAGMA foreign_keys = OFF"));
  // run_query has no legitimate use for schema introspection pragmas either;
  // describe_schema is the dedicated surface for that.
  assert.throws(() => runReadOnlyQuery(db, "PRAGMA table_info(transactions)"));
});

test("file-access functions are denied even though none are loaded by default", (t) => {
  const db = fixture(t);
  assert.throws(() => runReadOnlyQuery(db, "SELECT readfile('/etc/hosts')"));
  assert.throws(() =>
    runReadOnlyQuery(db, "SELECT writefile('/tmp/kith-evil', 'x')"),
  );
  assert.throws(() =>
    runReadOnlyQuery(db, "SELECT load_extension('anything')"),
  );
});

test("a second statement smuggled after a semicolon is denied", (t) => {
  const db = fixture(t);
  assert.throws(
    () => runReadOnlyQuery(db, "SELECT 1; DROP TABLE transactions"),
    /single SQL statement/,
  );
});

test("a second statement smuggled inside a trailing comment is denied", (t) => {
  const db = fixture(t);
  assert.throws(
    () => runReadOnlyQuery(db, "SELECT 1; -- DROP TABLE transactions"),
    /single SQL statement/,
  );
});

test("a WITH-prefixed statement hiding a write is denied", (t) => {
  const db = fixture(t);
  assert.throws(() =>
    runReadOnlyQuery(
      db,
      "WITH doomed AS (SELECT id FROM transactions) DELETE FROM transactions WHERE id IN (SELECT id FROM doomed)",
    ),
  );
});

test("a parenthesised statement hiding a write does not parse", (t) => {
  const db = fixture(t);
  assert.throws(() => runReadOnlyQuery(db, "(DELETE FROM transactions)"));
});

test("a legitimate recursive CTE (a read) is allowed", (t) => {
  const db = fixture(t);
  const result = runReadOnlyQuery(
    db,
    "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 5) SELECT x FROM cnt",
  );
  assert.equal(result.rowCount, 5);
  assert.equal(result.truncated, false);
});

test("a result over the row bound is truncated, never silently short", (t) => {
  const db = fixture(t, 5);
  const result = runReadOnlyQuery(
    db,
    "SELECT id FROM transactions ORDER BY id",
    [],
    {
      maxRows: 3,
    },
  );
  assert.equal(result.rows.length, 3);
  assert.equal(result.rowCount, 3);
  assert.equal(result.truncated, true);
});

test("a result exactly at the row bound is not marked truncated", (t) => {
  const db = fixture(t, 3);
  const result = runReadOnlyQuery(
    db,
    "SELECT id FROM transactions ORDER BY id",
    [],
    {
      maxRows: 3,
    },
  );
  assert.equal(result.rows.length, 3);
  assert.equal(result.truncated, false);
});

test("a result over the time bound is truncated and marked timed out", (t) => {
  const db = fixture(t, 3);
  // timeoutMs: -1 makes the very first elapsed-time check trip deterministically,
  // instead of depending on a query that happens to be slow enough in CI.
  const result = runReadOnlyQuery(
    db,
    "SELECT id FROM transactions ORDER BY id",
    [],
    {
      timeoutMs: -1,
    },
  );
  assert.equal(result.truncated, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.rows.length, 0);
});

test("params bind, they are never string-interpolated", (t) => {
  const db = fixture(t);
  const result = runReadOnlyQuery(
    db,
    "SELECT id FROM transactions WHERE process_date = ?",
    ["2026-01-01"],
  );
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].id, "txn_0");
});

test("SUM over a money column returns an exact BigInt, never a float", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-guard-"));
  const dbPath = join(directory, "archive.db");
  const writable = openArchive(dbPath);
  writable
    .prepare("INSERT INTO institutions (id, name, slug) VALUES (?, ?, ?)")
    .run(INSTITUTION.id, INSTITUTION.name, INSTITUTION.slug);
  writable
    .prepare(
      "INSERT INTO accounts (id, institution_id, acct_last4, base_currency) VALUES (?, ?, ?, ?)",
    )
    .run(ACCOUNT.id, INSTITUTION.id, ACCOUNT.last4, ACCOUNT.currency);
  // Two amounts whose sum crosses 2^53, the point at which a JS number
  // silently loses precision.
  const amounts = [9007199254740993n, 7n];
  amounts.forEach((amount, index) => {
    writable
      .prepare(
        `INSERT INTO transactions
           (id, account_id, process_date, activity_type, amount, currency, row_hash, imported_at)
         VALUES (?, ?, ?, 'transfer', ?, 'USD', ?, '2026-01-01T00:00:00.000Z')`,
      )
      .run(
        `txn_big_${index}`,
        ACCOUNT.id,
        "2026-03-0" + (index + 1),
        amount,
        `hash_big_${index}`,
      );
  });
  writable.close();
  const guarded = openReadOnlyQueryConnection(dbPath);
  t.after(() => {
    guarded.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const result = runReadOnlyQuery(
    guarded,
    "SELECT sum(amount) AS total FROM transactions",
  );
  assert.equal(typeof result.rows[0].total, "bigint");
  assert.equal(result.rows[0].total, 9007199254741000n);
});

test("the default bounds are sane and exported for callers to reason about", () => {
  assert.ok(MAX_QUERY_ROWS > 0);
  assert.ok(MAX_QUERY_MS > 0);
});
