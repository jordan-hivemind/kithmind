import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  ARCHIVE_SCHEMA_VERSION,
  fromMinorUnits,
  MIGRATIONS,
  migrate,
  openArchive,
  rowHash,
  schemaVersion,
  sumMinorUnits,
  toMinorUnits,
} from "../dist/index.js";

// Synthetic institutions and accounts. No real institution, account or balance
// appears anywhere in this suite.
const INSTITUTION = {
  id: "inst_blue_harbor",
  name: "Blue Harbor Trust",
  slug: "blue-harbor",
};
const USD_ACCOUNT = { id: "acct_usd", last4: "0417", currency: "USD" };
const JPY_ACCOUNT = { id: "acct_jpy", last4: "8802", currency: "JPY" };

/** Opens a throwaway archive in a temp dir and removes it when the test ends. */
function archive(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-"));
  const db = openArchive(join(directory, "archive.db"));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

function seed(db) {
  db.prepare("INSERT INTO institutions (id, name, slug) VALUES (?, ?, ?)").run(
    INSTITUTION.id,
    INSTITUTION.name,
    INSTITUTION.slug,
  );
  for (const account of [USD_ACCOUNT, JPY_ACCOUNT]) {
    db.prepare(
      `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      account.id,
      INSTITUTION.id,
      account.last4,
      "Synthetic account",
      account.currency,
    );
  }
}

function insertTransaction(db, row) {
  db.prepare(
    `INSERT INTO transactions
       (id, account_id, process_date, activity_type, description,
        quantity, price, amount, currency, row_hash, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.accountId,
    row.processDate,
    row.activityType,
    row.description,
    row.quantity ?? null,
    row.price ?? null,
    row.amount,
    row.currency,
    row.rowHash ??
      rowHash({
        accountId: row.accountId,
        processDate: row.processDate,
        activityType: row.activityType,
        description: row.description,
        quantity: row.quantity ?? null,
        amount: row.amount,
        currency: row.currency,
        occurrence: row.occurrence ?? 1,
      }),
    "2026-01-01T00:00:00.000Z",
  );
}

test("migrations create the schema and record the applied version", (t) => {
  const db = archive(t);
  assert.equal(schemaVersion(db), ARCHIVE_SCHEMA_VERSION);
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"));
  assert.deepEqual(tables, [
    "accounts",
    "balances",
    "commitments",
    "documents",
    "import_runs",
    "institutions",
    "instruments",
    "liabilities",
    "position_reconciliations",
    "positions",
    "reconciliations",
    "review_items",
    "transactions",
  ]);
});

test("running migrations again is a no-op", (t) => {
  const db = archive(t);
  seed(db);
  const before = db
    .prepare("SELECT sql FROM sqlite_master ORDER BY name")
    .all();
  assert.equal(migrate(db), ARCHIVE_SCHEMA_VERSION);
  assert.equal(migrate(db), ARCHIVE_SCHEMA_VERSION);
  assert.deepEqual(
    db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all(),
    before,
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM institutions").get().n, 1);
});

test("a USD row and a JPY row round-trip with no loss", (t) => {
  const db = archive(t);
  seed(db);
  insertTransaction(db, {
    id: "txn_usd",
    accountId: USD_ACCOUNT.id,
    processDate: "2026-02-17",
    activityType: "buy",
    description: "Purchase of synthetic fund units",
    quantity: "12.5",
    price: "104.375",
    amount: toMinorUnits("-1304.69", "USD"),
    currency: "USD",
  });
  insertTransaction(db, {
    id: "txn_jpy",
    accountId: JPY_ACCOUNT.id,
    processDate: "2026-02-17",
    activityType: "dividend",
    description: "Synthetic dividend",
    quantity: null,
    price: null,
    amount: toMinorUnits("1250", "JPY"),
    currency: "JPY",
  });

  const statement = db.prepare(
    "SELECT amount, currency, quantity, price FROM transactions WHERE id = ?",
  );
  statement.setReadBigInts(true);

  const usd = statement.get("txn_usd");
  assert.equal(fromMinorUnits(usd.amount, usd.currency), "-1304.69");
  assert.equal(usd.quantity, "12.5");
  assert.equal(usd.price, "104.375");

  // Exponent 0 is where a hardcoded 2 turns 1250 yen into 12.50 yen.
  const jpy = statement.get("txn_jpy");
  assert.equal(jpy.amount, 1250n);
  assert.equal(fromMinorUnits(jpy.amount, jpy.currency), "1250");
});

test("a total above 2 to the 53 minor units survives the round trip", (t) => {
  const db = archive(t);
  seed(db);
  const amounts = [9007199254740993n, 7n];
  amounts.forEach((amount, index) => {
    insertTransaction(db, {
      id: `txn_big_${index}`,
      accountId: USD_ACCOUNT.id,
      processDate: "2026-03-0" + (index + 1),
      activityType: "transfer",
      description: `Synthetic transfer ${index}`,
      amount,
      currency: "USD",
    });
  });
  const statement = db.prepare(
    "SELECT sum(amount) AS total FROM transactions WHERE account_id = ?",
  );
  statement.setReadBigInts(true);
  assert.equal(statement.get(USD_ACCOUNT.id).total, 9007199254741000n);
});

test("a total never silently crosses currencies", (t) => {
  const db = archive(t);
  seed(db);
  insertTransaction(db, {
    id: "txn_mix_usd",
    accountId: USD_ACCOUNT.id,
    processDate: "2026-04-01",
    activityType: "fee",
    description: "Synthetic fee",
    amount: -1500n,
    currency: "USD",
  });
  insertTransaction(db, {
    id: "txn_mix_jpy",
    accountId: JPY_ACCOUNT.id,
    processDate: "2026-04-01",
    activityType: "fee",
    description: "Synthetic fee",
    amount: -800n,
    currency: "JPY",
  });
  const statement = db.prepare(
    "SELECT amount, currency FROM transactions ORDER BY id",
  );
  statement.setReadBigInts(true);
  const rows = statement.all();
  assert.throws(() => sumMinorUnits(rows), /group by currency/);

  const grouped = db
    .prepare(
      "SELECT currency, sum(amount) AS total FROM transactions GROUP BY currency ORDER BY currency",
    )
    .all()
    .map((group) => ({ currency: group.currency, total: group.total }));
  assert.deepEqual(grouped, [
    { currency: "JPY", total: -800 },
    { currency: "USD", total: -1500 },
  ]);
});

test("only the last four digits of an account number can be stored", (t) => {
  const db = archive(t);
  seed(db);
  const insert = db.prepare(
    "INSERT INTO accounts (id, institution_id, acct_last4, base_currency) VALUES (?, ?, ?, 'USD')",
  );
  for (const rejected of ["123456789", "041", "04a7", ""]) {
    assert.throws(() =>
      insert.run(`acct_${rejected || "empty"}`, INSTITUTION.id, rejected),
    );
  }
  insert.run("acct_ok", INSTITUTION.id, "0417");
  insert.run("acct_unknown", INSTITUTION.id, null);
});

test("a binary float cannot be written into a money column", (t) => {
  const db = archive(t);
  seed(db);
  assert.throws(
    () =>
      insertTransaction(db, {
        id: "txn_real",
        accountId: USD_ACCOUNT.id,
        processDate: "2026-05-01",
        activityType: "fee",
        description: "Synthetic fee",
        amount: 13.04,
        currency: "USD",
      }),
    /CHECK/,
  );
});

test("row_hash is unique and is stable across harmless spelling differences", (t) => {
  const db = archive(t);
  seed(db);
  const row = {
    accountId: USD_ACCOUNT.id,
    processDate: "2026-06-15",
    activityType: "buy",
    description: "Purchase of synthetic fund units",
    quantity: "12.5",
    amount: -130469n,
    currency: "USD",
    occurrence: 1,
  };
  const noisy = {
    ...row,
    activityType: " BUY ",
    description: "Purchase  of\nsynthetic   fund units",
    quantity: "+12.500",
  };
  assert.equal(rowHash(row), rowHash(noisy));
  assert.notEqual(rowHash(row), rowHash({ ...row, amount: -130468n }));
  assert.notEqual(rowHash(row), rowHash({ ...row, currency: "JPY" }));
  assert.notEqual(rowHash(row), rowHash({ ...row, quantity: null }));
  assert.notEqual(rowHash(row), rowHash({ ...row, occurrence: 2 }));

  insertTransaction(db, { id: "txn_first", ...row, price: "104.375" });
  assert.throws(
    () =>
      insertTransaction(db, { id: "txn_second", ...noisy, price: "104.375" }),
    /UNIQUE/,
  );
});

test("row_hash rejects a missing or invalid occurrence instead of hashing it into its own namespace", () => {
  const row = {
    accountId: "acct_x",
    processDate: "2026-06-15",
    activityType: "buy",
    description: "Synthetic purchase",
    quantity: null,
    amount: -100n,
    currency: "USD",
  };
  // Omitted entirely: this is the exact bug F1-3 was sent back to fix,
  // reintroduced through a caller that forgets the field.
  assert.throws(() => rowHash(row), /occurrence/);
  assert.throws(() => rowHash({ ...row, occurrence: 0 }), /occurrence/);
  assert.throws(() => rowHash({ ...row, occurrence: -1 }), /occurrence/);
  assert.throws(() => rowHash({ ...row, occurrence: 1.5 }), /occurrence/);
  assert.throws(() => rowHash({ ...row, occurrence: null }), /occurrence/);
  assert.throws(() => rowHash({ ...row, occurrence: "1" }), /occurrence/);
  // A valid occurrence still works.
  assert.match(rowHash({ ...row, occurrence: 1 }), /^[0-9a-f]{64}$/);
});

test("the extensibility columns exist and accept values", (t) => {
  const db = archive(t);
  seed(db);
  db.prepare(
    `INSERT INTO positions
       (id, account_id, as_of, quantity, price, market_value, cost_basis, unrealized,
        currency, valuation_basis, valuation_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "pos_1",
    USD_ACCOUNT.id,
    "2026-06-30",
    "12.5",
    "104.375",
    130469n,
    120000n,
    10469n,
    "USD",
    "reported_nav",
    "Synthetic quarterly statement value",
  );
  db.prepare(
    `INSERT INTO commitments
       (id, account_id, committed, called, outstanding, distributed, currency,
        committed_original, currency_original, fx_rate, status, as_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "cmt_1",
    USD_ACCOUNT.id,
    500000000n,
    150000000n,
    350000000n,
    20000000n,
    "USD",
    460000000n,
    "EUR",
    "1.0869565",
    "active",
    "2026-06-30",
  );
  db.prepare(
    `INSERT INTO reconciliations
       (id, account_id, period_start, period_end, expected_change, computed_change,
        delta, currency, tolerance, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "rec_1",
    USD_ACCOUNT.id,
    "2026-06-01",
    "2026-06-30",
    1000n,
    1000n,
    0n,
    "USD",
    0n,
    "pass",
  );

  assert.equal(
    db.prepare("SELECT valuation_basis FROM positions WHERE id = 'pos_1'").get()
      .valuation_basis,
    "reported_nav",
  );
  assert.equal(
    db.prepare("SELECT fx_rate FROM commitments WHERE id = 'cmt_1'").get()
      .fx_rate,
    "1.0869565",
  );
  assert.throws(() =>
    db
      .prepare("UPDATE reconciliations SET status = 'maybe' WHERE id = 'rec_1'")
      .run(),
  );
});

// The rest of this file is the F1-17 migration test, moved here from
// positionReconciliation.test.mjs: it proves the SQLite migration path in
// schema.ts, not the Postgres position gate, so it belongs with the other
// SQLite schema tests rather than with the Postgres-backed suite.

function tempDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Synthetic institution and instruments distinct from this file's own
// INSTITUTION/accounts, used only by the migration test below.
const LEGACY_INSTITUTION = {
  id: "inst_pinehollow",
  name: "Pinehollow Federal",
  slug: "pinehollow",
};
const LEGACY_INSTRUMENT = { id: "instr_alpha", symbol: "ALFA" };
const LEGACY_OTHER_INSTRUMENT = { id: "instr_beta", symbol: "BETA" };

function seedLegacyInstitutionAndInstruments(db) {
  db.prepare("INSERT INTO institutions (id, name, slug) VALUES (?, ?, ?)").run(
    LEGACY_INSTITUTION.id,
    LEGACY_INSTITUTION.name,
    LEGACY_INSTITUTION.slug,
  );
  for (const instrument of [LEGACY_INSTRUMENT, LEGACY_OTHER_INSTRUMENT]) {
    db.prepare("INSERT INTO instruments (id, symbol) VALUES (?, ?)").run(
      instrument.id,
      instrument.symbol,
    );
  }
}

function seedLegacyAccount(db, id, openedDate = "2015-04-02") {
  db.prepare(
    `INSERT INTO accounts (id, institution_id, acct_last4, display_name, account_type,
                           base_currency, opened_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    LEGACY_INSTITUTION.id,
    "4321",
    "Synthetic account",
    "brokerage",
    "USD",
    openedDate,
  );
}

let legacyPositionSeq = 0;
function insertLegacyPosition(
  db,
  {
    accountId,
    asOf,
    quantity,
    instrumentId = LEGACY_INSTRUMENT.id,
    costBasis = null,
  },
) {
  legacyPositionSeq += 1;
  db.prepare(
    `INSERT INTO positions (id, account_id, as_of, instrument_id, quantity, cost_basis, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `pos_${legacyPositionSeq}`,
    accountId,
    asOf,
    instrumentId,
    quantity,
    costBasis,
    "USD",
  );
}

let legacyTxnSeq = 0;
function insertLegacyTransaction(
  db,
  { accountId, processDate, quantity, instrumentId = LEGACY_INSTRUMENT.id },
) {
  legacyTxnSeq += 1;
  db.prepare(
    `INSERT INTO transactions
       (id, account_id, process_date, activity_type, description, instrument_id,
        quantity, currency, row_hash, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `txn_${legacyTxnSeq}`,
    accountId,
    processDate,
    "trade",
    "Synthetic trade",
    instrumentId,
    quantity,
    "USD",
    `hash_${legacyTxnSeq}`,
    "2026-04-01T00:00:00.000Z",
  );
}

test("migration 3 upgrades a populated database without losing rows", (t) => {
  const path = join(tempDirectory(t), "legacy.db");

  // Build a file at the pre-F1-17 schema version and put rows in it.
  const legacy = new DatabaseSync(path);
  legacy.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    if (migration.version > 2) continue;
    legacy.exec(migration.sql);
    legacy.exec(`PRAGMA user_version = ${migration.version}`);
  }
  assert.equal(schemaVersion(legacy), 2);
  seedLegacyInstitutionAndInstruments(legacy);
  seedLegacyAccount(legacy, "acct_legacy");
  insertLegacyPosition(legacy, {
    accountId: "acct_legacy",
    asOf: "2026-01-31",
    quantity: "100",
  });
  insertLegacyPosition(legacy, {
    accountId: "acct_legacy",
    asOf: "2026-02-28",
    quantity: "112",
  });
  insertLegacyTransaction(legacy, {
    accountId: "acct_legacy",
    processDate: "2026-01-06",
    quantity: "1",
  });
  insertLegacyTransaction(legacy, {
    accountId: "acct_legacy",
    processDate: "2026-02-06",
    quantity: "12",
  });
  legacy
    .prepare(
      `INSERT INTO reconciliations
       (id, account_id, period_start, period_end, expected_change, computed_change,
        delta, currency, tolerance, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "rec_legacy",
      "acct_legacy",
      "2026-01-31",
      "2026-02-28",
      500,
      500,
      0,
      "USD",
      0,
      "pass",
    );
  legacy.close();

  const db = openArchive(path);
  t.after(() => db.close());

  assert.equal(schemaVersion(db), ARCHIVE_SCHEMA_VERSION);
  // Every pre-existing row survived the upgrade.
  assert.equal(db.prepare("SELECT count(*) AS n FROM positions").get().n, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM transactions").get().n, 2);
  assert.equal(
    db
      .prepare("SELECT status FROM reconciliations WHERE id = ?")
      .get("rec_legacy").status,
    "pass",
  );
  // The upgrade added position_reconciliations, empty until the Postgres
  // gate (which no longer runs against a SQLite file) writes to it.
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'position_reconciliations'",
      )
      .get().n,
    1,
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM position_reconciliations").get().n,
    0,
  );
});
