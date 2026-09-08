import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { importBatch, openArchive, runReconciliationGate } from "../dist/index.js";

// Synthetic institution and accounts. No real institution, account, balance
// or file path appears anywhere in this suite.
const INSTITUTION = {
  id: "inst_pinehollow",
  name: "Pinehollow Federal",
  slug: "pinehollow",
};

/** Opens a throwaway archive in a temp dir and removes it when the test ends. */
function archive(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-reconcile-"));
  const db = openArchive(join(directory, "archive.db"));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

function seedInstitution(db) {
  db.prepare("INSERT INTO institutions (id, name, slug) VALUES (?, ?, ?)").run(
    INSTITUTION.id,
    INSTITUTION.name,
    INSTITUTION.slug,
  );
}

function seedAccount(db, id, last4, accountType = "checking") {
  db.prepare(
    `INSERT INTO accounts (id, institution_id, acct_last4, display_name, account_type, base_currency)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, INSTITUTION.id, last4, "Synthetic account", accountType, "USD");
}

function insertBalance(db, { id, accountId, asOf, cash, totalValue = null, currency = "USD" }) {
  db.prepare(
    `INSERT INTO balances (id, account_id, as_of, total_value, cash, currency)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, accountId, asOf, totalValue, cash, currency);
}

/** A minimal, valid transaction row. Tests override only what they care about. */
function row(accountId, overrides = {}) {
  return {
    accountId,
    tradeDate: null,
    processDate: "2026-03-15",
    settleDate: null,
    datePrecision: "day",
    activityType: "credit",
    description: "Synthetic activity",
    instrumentId: null,
    quantity: null,
    price: null,
    amountText: "0",
    currency: "USD",
    runningBalance: null,
    sourceLocator: "row:1",
    providerTxnId: null,
    ...overrides,
  };
}

function document(sha256, accountId, rows, overrides = {}) {
  return {
    sha256,
    filePath: `synthetic/${sha256}.json`,
    institutionId: INSTITUTION.id,
    accountId,
    docType: "activity_pull",
    docDate: "2026-03-31",
    providerReportedCount: rows.length,
    rows,
    ...overrides,
  };
}

const NOW = new Date("2026-03-10T00:00:00.000Z");

test("a period whose transactions do not explain the stated cash change fails and is queryable as not passed", (t) => {
  const db = archive(t);
  seedInstitution(db);
  seedAccount(db, "acct_gamma", "0301");
  insertBalance(db, { id: "bal_1", accountId: "acct_gamma", asOf: "2026-03-01", cash: 100000n });
  insertBalance(db, { id: "bal_2", accountId: "acct_gamma", asOf: "2026-03-31", cash: 150000n });

  // Injected discrepancy: the statement says cash rose by $500.00, but only
  // $400.00 of transactions were captured.
  importBatch(
    db,
    {
      source: "synthetic-pull",
      documents: [
        document("a".repeat(64), "acct_gamma", [
          row("acct_gamma", { providerTxnId: "ptx-1", amountText: "400.00" }),
        ]),
      ],
    },
    NOW,
  );

  const summary = runReconciliationGate(db);
  assert.equal(summary.periodsChecked, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.passed, 0);
  const [outcome] = summary.outcomes;
  assert.equal(outcome.status, "fail");
  assert.equal(outcome.expectedChange, "500");
  assert.equal(outcome.computedChange, "400");
  assert.equal(outcome.delta, "-100");

  const stored = db
    .prepare(
      "SELECT status, expected_change, computed_change, delta, tolerance FROM reconciliations WHERE account_id = 'acct_gamma'",
    )
    .get();
  assert.equal(stored.status, "fail");

  // Failing periods are queryable as not-passed, the surface get_coverage and
  // any consumer uses to find what still needs attention.
  const unresolved = db
    .prepare("SELECT COUNT(*) AS n FROM reconciliations WHERE status != 'pass'")
    .get();
  assert.equal(unresolved.n, 1);
});

test("a period whose transactions exactly explain the stated cash change passes with the tolerance recorded", (t) => {
  const db = archive(t);
  seedInstitution(db);
  seedAccount(db, "acct_delta", "0302");
  insertBalance(db, { id: "bal_1", accountId: "acct_delta", asOf: "2026-03-01", cash: 100000n });
  insertBalance(db, { id: "bal_2", accountId: "acct_delta", asOf: "2026-03-31", cash: 150000n });

  importBatch(
    db,
    {
      source: "synthetic-pull",
      documents: [
        document("b".repeat(64), "acct_delta", [
          row("acct_delta", { providerTxnId: "ptx-1", amountText: "500.00" }),
        ]),
      ],
    },
    NOW,
  );

  const summary = runReconciliationGate(db);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 0);
  const [outcome] = summary.outcomes;
  assert.equal(outcome.status, "pass");
  assert.equal(outcome.delta, "0");

  const statement = db.prepare(
    "SELECT status, tolerance FROM reconciliations WHERE account_id = 'acct_delta'",
  );
  statement.setReadBigInts(true);
  const stored = statement.get();
  assert.equal(stored.status, "pass");
  // Exact zero, and recorded even on a passing period so a later policy
  // change never silently reinterprets an old pass.
  assert.equal(stored.tolerance, 0n);
});

test("a future-dated transaction opens a review item but is not excluded from the period and does not block the gate", (t) => {
  const db = archive(t);
  seedInstitution(db);
  seedAccount(db, "acct_zeta", "0303");
  insertBalance(db, { id: "bal_1", accountId: "acct_zeta", asOf: "2026-03-01", cash: 100000n });
  insertBalance(db, { id: "bal_2", accountId: "acct_zeta", asOf: "2026-03-31", cash: 130000n });

  // A scheduled transfer dated after NOW (2026-03-10): the importer's
  // future-date rule opens a review item but still inserts the row, per the
  // plan's "what must not become a hard failure."
  const importSummary = importBatch(
    db,
    {
      source: "synthetic-pull",
      documents: [
        document("c".repeat(64), "acct_zeta", [
          row("acct_zeta", {
            providerTxnId: "ptx-1",
            processDate: "2026-03-05",
            amountText: "100.00",
          }),
          row("acct_zeta", {
            providerTxnId: "ptx-2",
            sourceLocator: "row:2",
            processDate: "2026-03-20",
            amountText: "200.00",
          }),
        ]),
      ],
    },
    NOW,
  );
  assert.equal(importSummary.reviewItemsOpened, 1);
  assert.equal(
    db.prepare("SELECT kind FROM review_items").get().kind,
    "future_date",
  );

  const summary = runReconciliationGate(db, importSummary.importRunId);
  assert.equal(summary.passed, 1);
  assert.equal(summary.outcomes[0].status, "pass");

  const run = db
    .prepare(
      "SELECT reconciliations_passed, reconciliations_failed, notes FROM import_runs WHERE id = ?",
    )
    .get(importSummary.importRunId);
  assert.equal(run.reconciliations_passed, 1);
  assert.equal(run.reconciliations_failed, 0);
  assert.equal(run.notes, null);
});

test("an investment account reconciles on cash, not total value: market movement with no missing transactions still passes", (t) => {
  const db = archive(t);
  seedInstitution(db);
  seedAccount(db, "acct_theta", "0304", "brokerage");
  // Cash rose only by a $50 dividend. Total value rose by $550: the same $50
  // in cash plus $500 of unrealized appreciation on held positions that no
  // transaction represents.
  insertBalance(db, {
    id: "bal_1",
    accountId: "acct_theta",
    asOf: "2026-06-01",
    cash: 100000n,
    totalValue: 500000n,
  });
  insertBalance(db, {
    id: "bal_2",
    accountId: "acct_theta",
    asOf: "2026-06-30",
    cash: 105000n,
    totalValue: 555000n,
  });

  importBatch(
    db,
    {
      source: "synthetic-pull",
      documents: [
        document("d".repeat(64), "acct_theta", [
          row("acct_theta", {
            providerTxnId: "ptx-1",
            activityType: "dividend",
            description: "Synthetic dividend",
            processDate: "2026-06-15",
            amountText: "50.00",
          }),
        ]),
      ],
    },
    NOW,
  );

  // Sanity check on the fixture itself: total value moved by more than cash
  // did, so a total-value reconciliation would wrongly fail this period.
  const totals = db
    .prepare(
      "SELECT total_value FROM balances WHERE account_id = 'acct_theta' ORDER BY as_of",
    )
    .all();
  assert.notEqual(
    Number(totals[1].total_value) - Number(totals[0].total_value),
    5000, // the $50.00 cash change, in cents
  );

  const summary = runReconciliationGate(db);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.outcomes[0].expectedChange, "50");
  assert.equal(summary.outcomes[0].computedChange, "50");
});

test("a snapshot with no stated cash balance is unverified, not guessed", (t) => {
  const db = archive(t);
  seedInstitution(db);
  seedAccount(db, "acct_eta", "0305");
  insertBalance(db, { id: "bal_1", accountId: "acct_eta", asOf: "2026-03-01", cash: null });
  insertBalance(db, { id: "bal_2", accountId: "acct_eta", asOf: "2026-03-31", cash: 100000n });

  const summary = runReconciliationGate(db);
  assert.equal(summary.unverified, 1);
  assert.equal(summary.passed, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.outcomes[0].status, "unverified");
  assert.equal(summary.outcomes[0].expectedChange, null);

  const stored = db
    .prepare("SELECT status, expected_change FROM reconciliations WHERE account_id = 'acct_eta'")
    .get();
  assert.equal(stored.status, "unverified");
  assert.equal(stored.expected_change, null);
});

test("a currency change between snapshots is unverified rather than diffed across currencies", (t) => {
  const db = archive(t);
  seedInstitution(db);
  seedAccount(db, "acct_iota", "0306");
  insertBalance(db, {
    id: "bal_1",
    accountId: "acct_iota",
    asOf: "2026-03-01",
    cash: 100000n,
    currency: "USD",
  });
  insertBalance(db, {
    id: "bal_2",
    accountId: "acct_iota",
    asOf: "2026-03-31",
    cash: 100000n,
    currency: "EUR",
  });

  const summary = runReconciliationGate(db);
  assert.equal(summary.unverified, 1);
  assert.match(summary.outcomes[0].notes, /currency changed/);
});

test("re-running the gate is idempotent: a corrected import replaces the prior verdict, it does not add to it", (t) => {
  const db = archive(t);
  seedInstitution(db);
  seedAccount(db, "acct_kappa", "0307");
  insertBalance(db, { id: "bal_1", accountId: "acct_kappa", asOf: "2026-03-01", cash: 100000n });
  insertBalance(db, { id: "bal_2", accountId: "acct_kappa", asOf: "2026-03-31", cash: 150000n });

  importBatch(
    db,
    {
      source: "synthetic-pull",
      documents: [
        document("e".repeat(64), "acct_kappa", [
          row("acct_kappa", { providerTxnId: "ptx-1", amountText: "400.00" }),
        ]),
      ],
    },
    NOW,
  );

  const first = runReconciliationGate(db);
  assert.equal(first.outcomes[0].status, "fail");

  // A missing transaction is found and imported after the fact.
  importBatch(
    db,
    {
      source: "synthetic-pull",
      documents: [
        document("f".repeat(64), "acct_kappa", [
          row("acct_kappa", {
            providerTxnId: "ptx-2",
            sourceLocator: "row:2",
            amountText: "100.00",
          }),
        ]),
      ],
    },
    NOW,
  );

  const second = runReconciliationGate(db);
  assert.equal(second.outcomes[0].status, "pass");
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM reconciliations WHERE account_id = 'acct_kappa'",
      )
      .get().n,
    1,
  );
});

test("an account with fewer than two balances snapshots has no periods to check", (t) => {
  const db = archive(t);
  seedInstitution(db);
  seedAccount(db, "acct_lambda", "0308");
  insertBalance(db, { id: "bal_1", accountId: "acct_lambda", asOf: "2026-03-01", cash: 100000n });

  const summary = runReconciliationGate(db);
  assert.equal(summary.periodsChecked, 0);
});
