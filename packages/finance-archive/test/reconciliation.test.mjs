import assert from "node:assert/strict";
import test from "node:test";

import {
  importBatch,
  runReconciliationGate,
  subtractDecimal,
} from "../dist/index.js";

import { all, archive, count, one, skip } from "./helpers/pgArchive.mjs";

// Synthetic institution and accounts. No real institution, account, balance
// or file path appears anywhere in this suite.
const INSTITUTION = {
  id: "inst_pinehollow",
  name: "Pinehollow Federal",
  slug: "pinehollow",
};

async function seedInstitution(client) {
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, $2, $3)",
    [INSTITUTION.id, INSTITUTION.name, INSTITUTION.slug],
  );
}

async function seedAccount(client, id, last4, accountType = "checking") {
  await client.query(
    `INSERT INTO accounts (id, institution_id, acct_last4, display_name, account_type, base_currency)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, INSTITUTION.id, last4, "Synthetic account", accountType, "USD"],
  );
}

async function insertBalance(
  client,
  { id, accountId, asOf, cash, totalValue = null, currency = "USD" },
) {
  await client.query(
    `INSERT INTO balances (id, account_id, as_of, total_value, cash, currency)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, accountId, asOf, totalValue, cash, currency],
  );
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

test(
  "a period whose transactions do not explain the stated cash change fails and is queryable as not passed",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedInstitution(client);
    await seedAccount(client, "acct_gamma", "0301");
    await insertBalance(client, {
      id: "bal_1",
      accountId: "acct_gamma",
      asOf: "2026-03-01",
      cash: "1000",
    });
    await insertBalance(client, {
      id: "bal_2",
      accountId: "acct_gamma",
      asOf: "2026-03-31",
      cash: "1500",
    });

    // Injected discrepancy: the statement says cash rose by $500.00, but only
    // $400.00 of transactions were captured.
    await importBatch(
      client,
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

    const summary = await runReconciliationGate(client);
    assert.equal(summary.periodsChecked, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.passed, 0);
    const [outcome] = summary.outcomes;
    assert.equal(outcome.status, "fail");
    assert.equal(outcome.expectedChange, "500");
    assert.equal(outcome.computedChange, "400");
    assert.equal(outcome.delta, "-100");

    const stored = await one(
      client,
      "SELECT status, expected_change, computed_change, delta, tolerance FROM reconciliations WHERE account_id = 'acct_gamma'",
    );
    assert.equal(stored.status, "fail");

    // Failing periods are queryable as not-passed, the surface get_coverage and
    // any consumer uses to find what still needs attention.
    const unresolved = await count(
      client,
      "reconciliations",
      "WHERE status != 'pass'",
    );
    assert.equal(unresolved, 1);
  },
);

test(
  "a period whose transactions exactly explain the stated cash change passes with the tolerance recorded",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedInstitution(client);
    await seedAccount(client, "acct_delta", "0302");
    await insertBalance(client, {
      id: "bal_1",
      accountId: "acct_delta",
      asOf: "2026-03-01",
      cash: "1000",
    });
    await insertBalance(client, {
      id: "bal_2",
      accountId: "acct_delta",
      asOf: "2026-03-31",
      cash: "1500",
    });

    await importBatch(
      client,
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

    const summary = await runReconciliationGate(client);
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 0);
    const [outcome] = summary.outcomes;
    assert.equal(outcome.status, "pass");
    assert.equal(outcome.delta, "0");

    const stored = await one(
      client,
      "SELECT status, tolerance FROM reconciliations WHERE account_id = 'acct_delta'",
    );
    assert.equal(stored.status, "pass");
    // Exact zero, and recorded even on a passing period so a later policy
    // change never silently reinterprets an old pass.
    assert.equal(stored.tolerance, "0");
  },
);

test(
  "a future-dated transaction opens a review item but is not excluded from the period and does not block the gate",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedInstitution(client);
    await seedAccount(client, "acct_zeta", "0303");
    await insertBalance(client, {
      id: "bal_1",
      accountId: "acct_zeta",
      asOf: "2026-03-01",
      cash: "1000",
    });
    await insertBalance(client, {
      id: "bal_2",
      accountId: "acct_zeta",
      asOf: "2026-03-31",
      cash: "1300",
    });

    // A scheduled transfer dated after NOW (2026-03-10): the importer's
    // future-date rule opens a review item but still inserts the row, per the
    // plan's "what must not become a hard failure."
    const importSummary = await importBatch(
      client,
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
      (await one(client, "SELECT kind FROM review_items")).kind,
      "future_date",
    );

    const summary = await runReconciliationGate(
      client,
      importSummary.importRunId,
    );
    assert.equal(summary.passed, 1);
    assert.equal(summary.outcomes[0].status, "pass");

    const run = await one(
      client,
      "SELECT reconciliations_passed, reconciliations_failed, notes FROM import_runs WHERE id = $1",
      [importSummary.importRunId],
    );
    assert.equal(Number(run.reconciliations_passed), 1);
    assert.equal(Number(run.reconciliations_failed), 0);
    assert.equal(run.notes, null);
  },
);

test(
  "an investment account reconciles on cash, not total value: market movement with no missing transactions still passes",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedInstitution(client);
    await seedAccount(client, "acct_theta", "0304", "brokerage");
    // Cash rose only by a $50 dividend. Total value rose by $550: the same $50
    // in cash plus $500 of unrealized appreciation on held positions that no
    // transaction represents.
    await insertBalance(client, {
      id: "bal_1",
      accountId: "acct_theta",
      asOf: "2026-06-01",
      cash: "1000",
      totalValue: "5000",
    });
    await insertBalance(client, {
      id: "bal_2",
      accountId: "acct_theta",
      asOf: "2026-06-30",
      cash: "1050",
      totalValue: "5550",
    });

    await importBatch(
      client,
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
    const totals = await all(
      client,
      "SELECT total_value FROM balances WHERE account_id = 'acct_theta' ORDER BY as_of",
    );
    assert.notEqual(
      subtractDecimal(totals[1].total_value, totals[0].total_value),
      "50", // the $50.00 cash change
    );

    const summary = await runReconciliationGate(client);
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.outcomes[0].expectedChange, "50");
    assert.equal(summary.outcomes[0].computedChange, "50");
  },
);

test(
  "a snapshot with no stated cash balance is unverified, not guessed",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedInstitution(client);
    await seedAccount(client, "acct_eta", "0305");
    await insertBalance(client, {
      id: "bal_1",
      accountId: "acct_eta",
      asOf: "2026-03-01",
      cash: null,
    });
    await insertBalance(client, {
      id: "bal_2",
      accountId: "acct_eta",
      asOf: "2026-03-31",
      cash: "1000",
    });

    const summary = await runReconciliationGate(client);
    assert.equal(summary.unverified, 1);
    assert.equal(summary.passed, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.outcomes[0].status, "unverified");
    assert.equal(summary.outcomes[0].expectedChange, null);

    const stored = await one(
      client,
      "SELECT status, expected_change FROM reconciliations WHERE account_id = 'acct_eta'",
    );
    assert.equal(stored.status, "unverified");
    assert.equal(stored.expected_change, null);
  },
);

test(
  "a currency change between snapshots is unverified rather than diffed across currencies",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedInstitution(client);
    await seedAccount(client, "acct_iota", "0306");
    await insertBalance(client, {
      id: "bal_1",
      accountId: "acct_iota",
      asOf: "2026-03-01",
      cash: "1000",
      currency: "USD",
    });
    await insertBalance(client, {
      id: "bal_2",
      accountId: "acct_iota",
      asOf: "2026-03-31",
      cash: "1000",
      currency: "EUR",
    });

    const summary = await runReconciliationGate(client);
    assert.equal(summary.unverified, 1);
    assert.match(summary.outcomes[0].notes, /currency changed/);
  },
);

test(
  "re-running the gate is idempotent: a corrected import replaces the prior verdict, it does not add to it",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedInstitution(client);
    await seedAccount(client, "acct_kappa", "0307");
    await insertBalance(client, {
      id: "bal_1",
      accountId: "acct_kappa",
      asOf: "2026-03-01",
      cash: "1000",
    });
    await insertBalance(client, {
      id: "bal_2",
      accountId: "acct_kappa",
      asOf: "2026-03-31",
      cash: "1500",
    });

    await importBatch(
      client,
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

    const first = await runReconciliationGate(client);
    assert.equal(first.outcomes[0].status, "fail");

    // A missing transaction is found and imported after the fact.
    await importBatch(
      client,
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

    const second = await runReconciliationGate(client);
    assert.equal(second.outcomes[0].status, "pass");
    assert.equal(
      await count(client, "reconciliations", "WHERE account_id = 'acct_kappa'"),
      1,
    );
  },
);

test(
  "an account with fewer than two balances snapshots has no periods to check",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedInstitution(client);
    await seedAccount(client, "acct_lambda", "0308");
    await insertBalance(client, {
      id: "bal_1",
      accountId: "acct_lambda",
      asOf: "2026-03-01",
      cash: "1000",
    });

    const summary = await runReconciliationGate(client);
    assert.equal(summary.periodsChecked, 0);
  },
);

// --- F1-8: which rows land in a period's window -------------------------
//
// The three cases below are the ones the hosted archive's failing periods
// actually cluster on. Every account, date and amount here is synthetic.

/** A later `now` than the suite's NOW, so April and May rows are not future. */
const LATER = new Date("2026-06-01T00:00:00.000Z");

test(
  "the activity of period_start belongs to the period that ended there, not the one starting there",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedInstitution(client);
    await seedAccount(client, "acct_boundary", "0401");
    await insertBalance(client, {
      id: "bal_1",
      accountId: "acct_boundary",
      asOf: "2026-03-01",
      cash: "1000",
    });
    await insertBalance(client, {
      id: "bal_2",
      accountId: "acct_boundary",
      asOf: "2026-03-31",
      cash: "1500",
    });

    await importBatch(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("c".repeat(64), "acct_boundary", [
            // Already inside the $1000 stated on 2026-03-01.
            row("acct_boundary", {
              providerTxnId: "ptx-1",
              processDate: "2026-03-01",
              amountText: "300.00",
            }),
            row("acct_boundary", {
              providerTxnId: "ptx-2",
              processDate: "2026-03-15",
              amountText: "500.00",
            }),
          ]),
        ],
      },
      NOW,
    );

    const summary = await runReconciliationGate(client);
    assert.equal(summary.periodsChecked, 1);
    const [outcome] = summary.outcomes;
    assert.equal(outcome.status, "pass");
    assert.equal(outcome.expectedChange, "500");
    // 500, not 800: counting the boundary day again charged it twice.
    assert.equal(outcome.computedChange, "500");
  },
);

test(
  "a row is placed by the later of its process and settle dates, not by either alone",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedInstitution(client);
    await seedAccount(client, "acct_settle", "0402");
    for (const [id, asOf, cash] of [
      ["bal_1", "2026-03-31", "1000"],
      ["bal_2", "2026-04-03", "1000"],
      ["bal_3", "2026-04-30", "1100"],
    ]) {
      await insertBalance(client, {
        id,
        accountId: "acct_settle",
        asOf,
        cash,
      });
    }

    await importBatch(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("d".repeat(64), "acct_settle", [
            // Settles before it posts: the money is not in the account until
            // it posts, so this belongs to the April period, not the one
            // ending 2026-04-03.
            row("acct_settle", {
              providerTxnId: "ptx-1",
              processDate: "2026-04-05",
              settleDate: "2026-04-01",
              amountText: "100.00",
            }),
          ]),
        ],
      },
      LATER,
    );

    const summary = await runReconciliationGate(client);
    assert.equal(summary.periodsChecked, 2);
    assert.equal(summary.passed, 2);
    assert.equal(summary.failed, 0);
  },
);

test(
  "a trade that posts inside a period but settles after it counts in the period its cash lands in",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedInstitution(client);
    await seedAccount(client, "acct_carry", "0403");
    await insertBalance(client, {
      id: "bal_1",
      accountId: "acct_carry",
      asOf: "2026-03-31",
      cash: "1000",
    });
    await insertBalance(client, {
      id: "bal_2",
      accountId: "acct_carry",
      asOf: "2026-04-30",
      cash: "1200",
    });

    await importBatch(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("e".repeat(64), "acct_carry", [
            row("acct_carry", {
              providerTxnId: "ptx-1",
              processDate: "2026-03-30",
              settleDate: "2026-04-02",
              amountText: "200.00",
            }),
          ]),
        ],
      },
      LATER,
    );

    const summary = await runReconciliationGate(client);
    assert.equal(summary.periodsChecked, 1);
    const [outcome] = summary.outcomes;
    assert.equal(outcome.status, "pass");
    assert.equal(outcome.computedChange, "200");
  },
);

test(
  "two stated cash balances disagreeing at one date leave both neighbouring periods unverified",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedInstitution(client);
    await seedAccount(client, "acct_conflict", "0404");
    for (const [id, asOf, cash] of [
      ["bal_1", "2026-03-31", "1000"],
      ["bal_2", "2026-04-30", "1500"],
      ["bal_3", "2026-04-30", "1600"],
      ["bal_4", "2026-05-31", "2000"],
    ]) {
      await insertBalance(client, {
        id,
        accountId: "acct_conflict",
        asOf,
        cash,
      });
    }

    const summary = await runReconciliationGate(client);
    // Two periods, not three: the two rows at 2026-04-30 are one snapshot,
    // so there is no zero-length period between them.
    assert.equal(summary.periodsChecked, 2);
    assert.equal(summary.unverified, 2);
    assert.equal(summary.failed, 0);
    for (const outcome of summary.outcomes) {
      assert.match(outcome.notes, /more than one stated cash balance/);
      assert.equal(outcome.delta, null);
    }
    assert.equal(
      await count(client, "reconciliations", "WHERE period_start = period_end"),
      0,
    );
  },
);

test(
  "two stated cash balances agreeing at one date collapse to one snapshot and still reconcile",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedInstitution(client);
    await seedAccount(client, "acct_dup", "0405");
    for (const [id, asOf, cash] of [
      ["bal_1", "2026-03-31", "1000"],
      ["bal_2", "2026-04-30", "1500"],
      ["bal_3", "2026-04-30", "1500"],
    ]) {
      await insertBalance(client, { id, accountId: "acct_dup", asOf, cash });
    }

    await importBatch(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("f".repeat(64), "acct_dup", [
            row("acct_dup", {
              providerTxnId: "ptx-1",
              processDate: "2026-04-15",
              amountText: "500.00",
            }),
          ]),
        ],
      },
      LATER,
    );

    const summary = await runReconciliationGate(client);
    assert.equal(summary.periodsChecked, 1);
    assert.equal(summary.passed, 1);
  },
);

// --- F1-72: a stale verdict outside the evaluated window set is deleted ----
//
// The archive measured this on the owner's data: after a document collapse
// changed which windows exist, `reconciliations` still held rows for
// periods the gate no longer evaluates at all, inflating every reader's
// failure count. A whole-archive pass must delete anything outside the
// windows it just evaluated; an incremental pass must do the same, but only
// inside the accounts its own scope touched.

test(
  "a whole-archive pass deletes a stale verdict for a window that no longer exists, and keeps the one it evaluated",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedInstitution(client);
    await seedAccount(client, "acct_vanish", "0406");
    await insertBalance(client, {
      id: "bal_1",
      accountId: "acct_vanish",
      asOf: "2026-01-31",
      cash: "1000",
    });
    await insertBalance(client, {
      id: "bal_2",
      accountId: "acct_vanish",
      asOf: "2026-02-28",
      cash: "1000",
    });

    // A row for a period this account's current balances can no longer
    // pair -- exactly what a document collapse or an account re-attribution
    // leaves behind, reproduced directly rather than through either flow.
    await client.query(
      `INSERT INTO reconciliations
         (id, account_id, period_start, period_end, currency, tolerance, status)
       VALUES ('v_vanished', 'acct_vanish', '2025-11-30', '2025-12-31', 'USD', 0, 'fail')`,
    );

    const summary = await runReconciliationGate(client);
    assert.equal(summary.periodsChecked, 1);
    assert.equal(summary.passed, 1);

    assert.equal(
      await count(client, "reconciliations", "WHERE id = $1", ["v_vanished"]),
      0,
      "a period outside the evaluated set is deleted",
    );
    assert.equal(
      await count(
        client,
        "reconciliations",
        "WHERE account_id = $1 AND period_start = $2 AND period_end = $3",
        ["acct_vanish", "2026-01-31", "2026-02-28"],
      ),
      1,
      "the period the gate actually evaluated is kept",
    );
  },
);

test(
  "an incremental pass scoped to one account deletes its own stale verdict and leaves another account's alone",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seedInstitution(client);
    await seedAccount(client, "acct_a", "0407");
    await seedAccount(client, "acct_b", "0408");
    for (const accountId of ["acct_a", "acct_b"]) {
      await insertBalance(client, {
        id: `bal_${accountId}_1`,
        accountId,
        asOf: "2026-01-31",
        cash: "1000",
      });
      await insertBalance(client, {
        id: `bal_${accountId}_2`,
        accountId,
        asOf: "2026-02-28",
        cash: "1000",
      });
      // Each account gets a row for a period neither currently pairs --
      // account A's is in scope this run, account B's is not.
      await client.query(
        `INSERT INTO reconciliations
           (id, account_id, period_start, period_end, currency, tolerance, status)
         VALUES ($1, $2, '2025-11-30', '2025-12-31', 'USD', 0, 'fail')`,
        [`v_vanished_${accountId}`, accountId],
      );
    }

    // Only A's Feb snapshot is in this run's scope, as an importer scoping a
    // per-document gate to the account it just touched would report it.
    await runReconciliationGate(client, undefined, {
      snapshots: [{ accountId: "acct_a", date: "2026-02-28" }],
      activity: [],
    });

    assert.equal(
      await count(client, "reconciliations", "WHERE id = $1", [
        "v_vanished_acct_a",
      ]),
      0,
      "A's own stale row is gone: A was in this run's scope",
    );
    assert.equal(
      await count(client, "reconciliations", "WHERE id = $1", [
        "v_vanished_acct_b",
      ]),
      1,
      "B's stale row survives: B was never in this run's scope",
    );
  },
);
