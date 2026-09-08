import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  ARCHIVE_SCHEMA_VERSION,
  MIGRATIONS,
  openArchive,
  runPositionReconciliationGate,
  schemaVersion,
} from "../dist/index.js";

// Synthetic institution, accounts and instruments. No real institution,
// account, holding or file path appears anywhere in this suite.
const INSTITUTION = {
  id: "inst_pinehollow",
  name: "Pinehollow Federal",
  slug: "pinehollow",
};
const INSTRUMENT = { id: "instr_alpha", symbol: "ALFA" };
const OTHER_INSTRUMENT = { id: "instr_beta", symbol: "BETA" };

function tempDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-positions-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Opens a throwaway archive in a temp dir and removes it when the test ends. */
function archive(t) {
  const db = openArchive(join(tempDirectory(t), "archive.db"));
  t.after(() => db.close());
  seed(db);
  return db;
}

function seed(db) {
  db.prepare("INSERT INTO institutions (id, name, slug) VALUES (?, ?, ?)").run(
    INSTITUTION.id,
    INSTITUTION.name,
    INSTITUTION.slug,
  );
  for (const instrument of [INSTRUMENT, OTHER_INSTRUMENT]) {
    db.prepare("INSERT INTO instruments (id, symbol) VALUES (?, ?)").run(
      instrument.id,
      instrument.symbol,
    );
  }
}

function seedAccount(db, id, openedDate = "2015-04-02") {
  db.prepare(
    `INSERT INTO accounts (id, institution_id, acct_last4, display_name, account_type,
                           base_currency, opened_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, INSTITUTION.id, "4321", "Synthetic account", "brokerage", "USD", openedDate);
}

let positionSeq = 0;
function insertPosition(
  db,
  { accountId, asOf, quantity, instrumentId = INSTRUMENT.id, costBasis = null },
) {
  positionSeq += 1;
  db.prepare(
    `INSERT INTO positions (id, account_id, as_of, instrument_id, quantity, cost_basis, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `pos_${positionSeq}`,
    accountId,
    asOf,
    instrumentId,
    quantity,
    costBasis,
    "USD",
  );
}

let txnSeq = 0;
function insertTransaction(
  db,
  { accountId, processDate, quantity, instrumentId = INSTRUMENT.id },
) {
  txnSeq += 1;
  db.prepare(
    `INSERT INTO transactions
       (id, account_id, process_date, activity_type, description, instrument_id,
        quantity, currency, row_hash, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `txn_${txnSeq}`,
    accountId,
    processDate,
    "trade",
    "Synthetic trade",
    instrumentId,
    quantity,
    "USD",
    `hash_${txnSeq}`,
    "2026-04-01T00:00:00.000Z",
  );
}

function periodRows(db, accountId) {
  return db
    .prepare(
      `SELECT instrument_id, period_start, period_end, expected_change,
              computed_change, delta, tolerance, status, notes
       FROM position_reconciliations WHERE account_id = ?
       ORDER BY instrument_id, period_start`,
    )
    .all(accountId);
}

test("a period whose transactions explain the stated quantity change passes", (t) => {
  const db = archive(t);
  seedAccount(db, "acct_pass");
  insertPosition(db, { accountId: "acct_pass", asOf: "2026-01-31", quantity: "400" });
  insertPosition(db, { accountId: "acct_pass", asOf: "2026-02-28", quantity: "425.5" });
  insertTransaction(db, {
    accountId: "acct_pass",
    processDate: "2026-01-05",
    quantity: "10",
  });
  insertTransaction(db, {
    accountId: "acct_pass",
    processDate: "2026-02-10",
    quantity: "30.5",
  });
  insertTransaction(db, {
    accountId: "acct_pass",
    processDate: "2026-02-20",
    quantity: "-5",
  });

  const summary = runPositionReconciliationGate(db);

  assert.equal(summary.periodsChecked, 1);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.unverified, 0);
  assert.equal(summary.accountsChecked, 1);
  assert.equal(summary.instrumentsChecked, 1);
  assert.deepEqual(summary.coverageGaps, []);

  const rows = periodRows(db, "acct_pass");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "pass");
  assert.equal(rows[0].expected_change, "25.5");
  assert.equal(rows[0].computed_change, "25.5");
  assert.equal(rows[0].delta, "0");
  // The tolerance is recorded on the passing row, so a later loosening
  // cannot silently reinterpret this pass.
  assert.equal(rows[0].tolerance, "0");
  assert.equal(rows[0].notes, null);
});

test("the gate anchors on the prior stated position, not on zero", (t) => {
  const db = archive(t);
  // The account opened over a decade before any acquired history. A gate
  // anchored on zero would need 425.5 shares of transactions and would fail
  // this period forever.
  seedAccount(db, "acct_anchor", "2011-06-01");
  insertPosition(db, { accountId: "acct_anchor", asOf: "2026-01-31", quantity: "400" });
  insertPosition(db, { accountId: "acct_anchor", asOf: "2026-02-28", quantity: "425.5" });
  insertTransaction(db, {
    accountId: "acct_anchor",
    processDate: "2026-01-20",
    quantity: "1",
  });
  insertTransaction(db, {
    accountId: "acct_anchor",
    processDate: "2026-02-14",
    quantity: "25.5",
  });

  const summary = runPositionReconciliationGate(db);

  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 0);
  const rows = periodRows(db, "acct_anchor");
  assert.equal(rows[0].status, "pass");
  // Anchored on 400, not on 0.
  assert.equal(rows[0].expected_change, "25.5");
});

test("a missing transaction fails the period and leaves it unverified", (t) => {
  const db = archive(t);
  seedAccount(db, "acct_missing");
  insertPosition(db, { accountId: "acct_missing", asOf: "2026-01-31", quantity: "100" });
  insertPosition(db, { accountId: "acct_missing", asOf: "2026-02-28", quantity: "140" });
  insertTransaction(db, {
    accountId: "acct_missing",
    processDate: "2026-01-02",
    quantity: "1",
  });
  // Only 25 of the stated 40 share increase is in the ledger.
  insertTransaction(db, {
    accountId: "acct_missing",
    processDate: "2026-02-09",
    quantity: "25",
  });

  const summary = runPositionReconciliationGate(db);

  assert.equal(summary.failed, 1);
  assert.equal(summary.passed, 0);
  const rows = periodRows(db, "acct_missing");
  assert.equal(rows[0].status, "fail");
  assert.equal(rows[0].delta, "-15");
  assert.match(rows[0].notes, /does not match the stated position change/);
  // A failing period is not verified.
  assert.equal(
    db
      .prepare(
        `SELECT count(*) AS n FROM position_reconciliations
         WHERE account_id = ? AND status = 'pass'`,
      )
      .get("acct_missing").n,
    0,
  );
});

test("a period containing a sale reconciles when the stated position goes down", (t) => {
  const db = archive(t);
  seedAccount(db, "acct_sale");
  insertPosition(db, { accountId: "acct_sale", asOf: "2026-01-31", quantity: "100" });
  // The holding shrinks, so the derived change must be negative too. A
  // disposal recorded with an unsigned quantity would read as an
  // acquisition and put this period 60 shares out.
  insertPosition(db, { accountId: "acct_sale", asOf: "2026-02-28", quantity: "70" });
  insertTransaction(db, {
    accountId: "acct_sale",
    processDate: "2026-01-11",
    quantity: "1",
  });
  insertTransaction(db, {
    accountId: "acct_sale",
    processDate: "2026-02-06",
    quantity: "-30",
  });

  const summary = runPositionReconciliationGate(db);

  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 0);
  const rows = periodRows(db, "acct_sale");
  assert.equal(rows[0].status, "pass");
  assert.equal(rows[0].expected_change, "-30");
  assert.equal(rows[0].computed_change, "-30");
  assert.equal(rows[0].delta, "0");
});

test("a sale and a purchase in one period net exactly", (t) => {
  const db = archive(t);
  seedAccount(db, "acct_netting");
  insertPosition(db, { accountId: "acct_netting", asOf: "2026-01-31", quantity: "100" });
  insertPosition(db, { accountId: "acct_netting", asOf: "2026-02-28", quantity: "95.5" });
  insertTransaction(db, {
    accountId: "acct_netting",
    processDate: "2026-01-11",
    quantity: "1",
  });
  for (const [processDate, quantity] of [
    ["2026-02-04", "-40"],
    ["2026-02-14", "35.5"],
  ]) {
    insertTransaction(db, { accountId: "acct_netting", processDate, quantity });
  }

  const summary = runPositionReconciliationGate(db);

  assert.equal(summary.passed, 1);
  assert.equal(periodRows(db, "acct_netting")[0].delta, "0");
});

test("a duplicated transaction fails the period", (t) => {
  const db = archive(t);
  seedAccount(db, "acct_dupe");
  insertPosition(db, { accountId: "acct_dupe", asOf: "2026-01-31", quantity: "100" });
  insertPosition(db, { accountId: "acct_dupe", asOf: "2026-02-28", quantity: "120" });
  insertTransaction(db, {
    accountId: "acct_dupe",
    processDate: "2026-01-02",
    quantity: "1",
  });
  insertTransaction(db, {
    accountId: "acct_dupe",
    processDate: "2026-02-09",
    quantity: "20",
  });
  // The same movement imported twice under a different row hash.
  insertTransaction(db, {
    accountId: "acct_dupe",
    processDate: "2026-02-09",
    quantity: "20",
  });

  const summary = runPositionReconciliationGate(db);

  assert.equal(summary.failed, 1);
  const rows = periodRows(db, "acct_dupe");
  assert.equal(rows[0].status, "fail");
  assert.equal(rows[0].delta, "20");
});

test("a period with no acquired history behind it is unverified, not failed", (t) => {
  const db = archive(t);
  seedAccount(db, "acct_gap");
  insertPosition(db, { accountId: "acct_gap", asOf: "2026-01-31", quantity: "100" });
  insertPosition(db, { accountId: "acct_gap", asOf: "2026-02-28", quantity: "130" });
  insertPosition(db, { accountId: "acct_gap", asOf: "2026-03-31", quantity: "140" });
  // Transaction history begins inside the first period, so that period can
  // never be checked; the second is fully covered.
  insertTransaction(db, {
    accountId: "acct_gap",
    processDate: "2026-02-10",
    quantity: "30",
  });
  insertTransaction(db, {
    accountId: "acct_gap",
    processDate: "2026-03-05",
    quantity: "10",
  });

  const summary = runPositionReconciliationGate(db);

  assert.equal(summary.periodsChecked, 2);
  assert.equal(summary.unverified, 1);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.coverageGaps, [
    {
      accountId: "acct_gap",
      firstStatedPositionAsOf: "2026-01-31",
      transactionHistoryStartsAt: "2026-02-10",
      periodsUnverified: 1,
    },
  ]);

  const rows = periodRows(db, "acct_gap");
  assert.equal(rows[0].status, "unverified");
  assert.equal(rows[0].delta, null);
  assert.match(rows[0].notes, /transaction history begins 2026-02-10/);
  assert.equal(rows[1].status, "pass");
});

test("an account with stated positions and no transactions at all is unverified", (t) => {
  const db = archive(t);
  seedAccount(db, "acct_nohistory");
  insertPosition(db, { accountId: "acct_nohistory", asOf: "2026-01-31", quantity: "10" });
  insertPosition(db, { accountId: "acct_nohistory", asOf: "2026-02-28", quantity: "10" });

  const summary = runPositionReconciliationGate(db);

  assert.equal(summary.unverified, 1);
  assert.equal(summary.failed, 0);
  const rows = periodRows(db, "acct_nohistory");
  assert.equal(rows[0].status, "unverified");
  assert.match(rows[0].notes, /no transaction history has been acquired/);
  assert.equal(summary.coverageGaps[0].transactionHistoryStartsAt, null);
});

test("a snapshot with no stated quantity is unverified, not counted as zero", (t) => {
  const db = archive(t);
  seedAccount(db, "acct_null");
  insertPosition(db, { accountId: "acct_null", asOf: "2026-01-31", quantity: "100" });
  insertPosition(db, { accountId: "acct_null", asOf: "2026-02-28", quantity: null });
  insertTransaction(db, {
    accountId: "acct_null",
    processDate: "2026-01-04",
    quantity: "1",
  });

  const summary = runPositionReconciliationGate(db);

  assert.equal(summary.unverified, 1);
  const rows = periodRows(db, "acct_null");
  assert.equal(rows[0].status, "unverified");
  assert.equal(rows[0].expected_change, null);
  assert.match(rows[0].notes, /has no quantity/);
});

test("a single stated snapshot yields no period at all", (t) => {
  const db = archive(t);
  seedAccount(db, "acct_single");
  insertPosition(db, { accountId: "acct_single", asOf: "2026-01-31", quantity: "100" });

  const summary = runPositionReconciliationGate(db);

  assert.equal(summary.periodsChecked, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.unverified, 0);
  assert.equal(periodRows(db, "acct_single").length, 0);
});

test("cost basis divergence does not fail a period", (t) => {
  const db = archive(t);
  seedAccount(db, "acct_basis");
  // Quantity reconciles exactly while the stated cost basis moves by an
  // amount no transaction explains: a provider adjustment, a wash sale, a
  // return of capital. Tax-lot matching is deferred and the gate is quantity
  // only, so this must still pass.
  insertPosition(db, {
    accountId: "acct_basis",
    asOf: "2026-01-31",
    quantity: "100",
    costBasis: 1000000,
  });
  insertPosition(db, {
    accountId: "acct_basis",
    asOf: "2026-02-28",
    quantity: "110",
    costBasis: 9999999,
  });
  insertTransaction(db, {
    accountId: "acct_basis",
    processDate: "2026-01-03",
    quantity: "1",
  });
  insertTransaction(db, {
    accountId: "acct_basis",
    processDate: "2026-02-11",
    quantity: "10",
  });

  const summary = runPositionReconciliationGate(db);

  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 0);
  assert.equal(periodRows(db, "acct_basis")[0].status, "pass");
});

test("a corporate action with no transaction behind it fails rather than being absorbed", (t) => {
  const db = archive(t);
  seedAccount(db, "acct_split");
  insertPosition(db, { accountId: "acct_split", asOf: "2026-01-31", quantity: "100" });
  // A two for one split. Nothing in the ledger explains it, and the gate
  // must surface the modelling gap rather than guess at it.
  insertPosition(db, { accountId: "acct_split", asOf: "2026-02-28", quantity: "200" });
  insertTransaction(db, {
    accountId: "acct_split",
    processDate: "2026-01-06",
    quantity: "1",
  });

  const summary = runPositionReconciliationGate(db);

  assert.equal(summary.failed, 1);
  assert.equal(periodRows(db, "acct_split")[0].delta, "-100");
});

test("quantities never round through a float", (t) => {
  const db = archive(t);
  seedAccount(db, "acct_precision");
  // Three fractional lots whose exact sum is 0.3. Added as IEEE doubles they
  // come to 0.30000000000000004 and this period would fail.
  insertPosition(db, {
    accountId: "acct_precision",
    asOf: "2026-01-31",
    quantity: "0.1",
  });
  insertPosition(db, {
    accountId: "acct_precision",
    asOf: "2026-02-28",
    quantity: "0.4",
  });
  insertTransaction(db, {
    accountId: "acct_precision",
    processDate: "2026-01-09",
    quantity: "0.05",
  });
  for (const processDate of ["2026-02-02", "2026-02-12", "2026-02-22"]) {
    insertTransaction(db, {
      accountId: "acct_precision",
      processDate,
      quantity: "0.1",
    });
  }

  const summary = runPositionReconciliationGate(db);

  assert.equal(summary.passed, 1);
  const rows = periodRows(db, "acct_precision");
  assert.equal(rows[0].computed_change, "0.3");
  assert.equal(rows[0].delta, "0");
  // Stored as TEXT, so a REAL can never reach these columns.
  for (const column of ["expected_change", "computed_change", "delta", "tolerance"]) {
    assert.equal(
      db
        .prepare(
          `SELECT typeof(${column}) AS t FROM position_reconciliations WHERE account_id = ?`,
        )
        .get("acct_precision").t,
      "text",
    );
  }
});

test("instruments and accounts are reconciled independently and never crossed", (t) => {
  const db = archive(t);
  seedAccount(db, "acct_one");
  seedAccount(db, "acct_two");
  for (const accountId of ["acct_one", "acct_two"]) {
    for (const instrumentId of [INSTRUMENT.id, OTHER_INSTRUMENT.id]) {
      insertPosition(db, { accountId, asOf: "2026-01-31", quantity: "50", instrumentId });
      insertPosition(db, { accountId, asOf: "2026-02-28", quantity: "60", instrumentId });
      insertTransaction(db, {
        accountId,
        processDate: "2026-01-07",
        quantity: "1",
        instrumentId,
      });
      insertTransaction(db, {
        accountId,
        processDate: "2026-02-07",
        quantity: "10",
        instrumentId,
      });
    }
  }
  // A movement in one account's other instrument must not be borrowed by
  // any other pair.
  insertTransaction(db, {
    accountId: "acct_one",
    processDate: "2026-02-15",
    quantity: "500",
    instrumentId: "instr_beta",
  });

  const summary = runPositionReconciliationGate(db);

  assert.equal(summary.periodsChecked, 4);
  assert.equal(summary.accountsChecked, 2);
  assert.equal(summary.instrumentsChecked, 2);
  assert.equal(summary.passed, 3);
  assert.equal(summary.failed, 1);
  const failing = db
    .prepare(
      "SELECT account_id, instrument_id FROM position_reconciliations WHERE status = 'fail'",
    )
    .all()
    .map((row) => `${row.account_id}/${row.instrument_id}`);
  assert.deepEqual(failing, ["acct_one/instr_beta"]);
});

test("a position with no instrument is skipped rather than pooled", (t) => {
  const db = archive(t);
  seedAccount(db, "acct_noinstr");
  for (const asOf of ["2026-01-31", "2026-02-28"]) {
    positionSeq += 1;
    db.prepare(
      `INSERT INTO positions (id, account_id, as_of, instrument_id, quantity, currency)
       VALUES (?, ?, ?, NULL, ?, 'USD')`,
    ).run(`pos_${positionSeq}`, "acct_noinstr", asOf, "10");
  }

  const summary = runPositionReconciliationGate(db);

  assert.equal(summary.periodsChecked, 0);
  assert.equal(periodRows(db, "acct_noinstr").length, 0);
});

test("re-running the gate replaces prior rows rather than adding to them", (t) => {
  const db = archive(t);
  seedAccount(db, "acct_idem");
  insertPosition(db, { accountId: "acct_idem", asOf: "2026-01-31", quantity: "100" });
  insertPosition(db, { accountId: "acct_idem", asOf: "2026-02-28", quantity: "130" });
  insertTransaction(db, {
    accountId: "acct_idem",
    processDate: "2026-01-08",
    quantity: "1",
  });
  insertTransaction(db, {
    accountId: "acct_idem",
    processDate: "2026-02-08",
    quantity: "20",
  });

  assert.equal(runPositionReconciliationGate(db).failed, 1);
  // The missing movement is imported by a corrected run.
  insertTransaction(db, {
    accountId: "acct_idem",
    processDate: "2026-02-18",
    quantity: "10",
  });
  const second = runPositionReconciliationGate(db);

  assert.equal(second.periodsChecked, 1);
  assert.equal(second.passed, 1);
  assert.equal(periodRows(db, "acct_idem").length, 1);
  assert.equal(periodRows(db, "acct_idem")[0].status, "pass");
});

test("an import run's counters and note record both gates", (t) => {
  const db = archive(t);
  seedAccount(db, "acct_run");
  insertPosition(db, { accountId: "acct_run", asOf: "2026-01-31", quantity: "100" });
  insertPosition(db, { accountId: "acct_run", asOf: "2026-02-28", quantity: "150" });
  insertTransaction(db, {
    accountId: "acct_run",
    processDate: "2026-01-08",
    quantity: "1",
  });
  db.prepare(
    "INSERT INTO import_runs (id, started_at, source, notes) VALUES (?, ?, ?, ?)",
  ).run("run_1", "2026-04-01T00:00:00.000Z", "test", "cash gate note");

  runPositionReconciliationGate(db, "run_1");

  const run = db
    .prepare(
      "SELECT reconciliations_passed, reconciliations_failed, notes FROM import_runs WHERE id = ?",
    )
    .get("run_1");
  assert.equal(run.reconciliations_passed, 0);
  assert.equal(run.reconciliations_failed, 1);
  // The cash gate's note survives; the position note is appended to it.
  assert.match(run.notes, /^cash gate note \| position reconciliation: /);
  assert.match(run.notes, /1 of 1 period\(s\)/);
});

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
  seed(legacy);
  seedAccount(legacy, "acct_legacy");
  insertPosition(legacy, {
    accountId: "acct_legacy",
    asOf: "2026-01-31",
    quantity: "100",
  });
  insertPosition(legacy, {
    accountId: "acct_legacy",
    asOf: "2026-02-28",
    quantity: "112",
  });
  insertTransaction(legacy, {
    accountId: "acct_legacy",
    processDate: "2026-01-06",
    quantity: "1",
  });
  insertTransaction(legacy, {
    accountId: "acct_legacy",
    processDate: "2026-02-06",
    quantity: "12",
  });
  legacy.prepare(
    `INSERT INTO reconciliations
       (id, account_id, period_start, period_end, expected_change, computed_change,
        delta, currency, tolerance, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("rec_legacy", "acct_legacy", "2026-01-31", "2026-02-28", 500, 500, 0, "USD", 0, "pass");
  legacy.close();

  const db = openArchive(path);
  t.after(() => db.close());

  assert.equal(schemaVersion(db), ARCHIVE_SCHEMA_VERSION);
  // Every pre-existing row survived the upgrade.
  assert.equal(db.prepare("SELECT count(*) AS n FROM positions").get().n, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM transactions").get().n, 2);
  assert.equal(
    db.prepare("SELECT status FROM reconciliations WHERE id = ?").get("rec_legacy").status,
    "pass",
  );
  // And the new gate runs against the upgraded file.
  const summary = runPositionReconciliationGate(db);
  assert.equal(summary.passed, 1);
  assert.equal(periodRows(db, "acct_legacy")[0].status, "pass");
});
