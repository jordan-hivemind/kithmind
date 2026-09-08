import assert from "node:assert/strict";
import test from "node:test";

import { runPositionReconciliationGate } from "../dist/index.js";

import { all, archive, count, one, skip } from "./helpers/pgArchive.mjs";

// Synthetic institution, accounts and instruments. No real institution,
// account, holding or file path appears anywhere in this suite.
const INSTITUTION = {
  id: "inst_pinehollow",
  name: "Pinehollow Federal",
  slug: "pinehollow",
};
const INSTRUMENT = { id: "instr_alpha", symbol: "ALFA" };
const OTHER_INSTRUMENT = { id: "instr_beta", symbol: "BETA" };

async function seed(client) {
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, $2, $3)",
    [INSTITUTION.id, INSTITUTION.name, INSTITUTION.slug],
  );
  for (const instrument of [INSTRUMENT, OTHER_INSTRUMENT]) {
    await client.query("INSERT INTO instruments (id, symbol) VALUES ($1, $2)", [
      instrument.id,
      instrument.symbol,
    ]);
  }
}

async function seedAccount(client, id, openedDate = "2015-04-02") {
  await client.query(
    `INSERT INTO accounts (id, institution_id, acct_last4, display_name, account_type,
                           base_currency, opened_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      INSTITUTION.id,
      "4321",
      "Synthetic account",
      "brokerage",
      "USD",
      openedDate,
    ],
  );
}

let positionSeq = 0;
async function insertPosition(
  client,
  { accountId, asOf, quantity, instrumentId = INSTRUMENT.id, costBasis = null },
) {
  positionSeq += 1;
  await client.query(
    `INSERT INTO positions (id, account_id, as_of, instrument_id, quantity, cost_basis, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      `pos_${positionSeq}`,
      accountId,
      asOf,
      instrumentId,
      quantity,
      costBasis,
      "USD",
    ],
  );
}

let txnSeq = 0;
async function insertTransaction(
  client,
  { accountId, processDate, quantity, instrumentId = INSTRUMENT.id },
) {
  txnSeq += 1;
  await client.query(
    `INSERT INTO transactions
       (id, account_id, process_date, activity_type, description, instrument_id,
        quantity, currency, row_hash, imported_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
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
    ],
  );
}

async function periodRows(client, accountId) {
  return all(
    client,
    `SELECT instrument_id, period_start, period_end, expected_change,
            computed_change, delta, tolerance, status, notes
     FROM position_reconciliations WHERE account_id = $1
     ORDER BY instrument_id, period_start`,
    [accountId],
  );
}

test(
  "a period whose transactions explain the stated quantity change passes",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await seedAccount(client, "acct_pass");
    await insertPosition(client, {
      accountId: "acct_pass",
      asOf: "2026-01-31",
      quantity: "400",
    });
    await insertPosition(client, {
      accountId: "acct_pass",
      asOf: "2026-02-28",
      quantity: "425.5",
    });
    await insertTransaction(client, {
      accountId: "acct_pass",
      processDate: "2026-01-05",
      quantity: "10",
    });
    await insertTransaction(client, {
      accountId: "acct_pass",
      processDate: "2026-02-10",
      quantity: "30.5",
    });
    await insertTransaction(client, {
      accountId: "acct_pass",
      processDate: "2026-02-20",
      quantity: "-5",
    });

    const summary = await runPositionReconciliationGate(client);

    assert.equal(summary.periodsChecked, 1);
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.unverified, 0);
    assert.equal(summary.accountsChecked, 1);
    assert.equal(summary.instrumentsChecked, 1);
    assert.deepEqual(summary.coverageGaps, []);

    const rows = await periodRows(client, "acct_pass");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pass");
    assert.equal(rows[0].expected_change, "25.5");
    assert.equal(rows[0].computed_change, "25.5");
    assert.equal(rows[0].delta, "0");
    // The tolerance is recorded on the passing row, so a later loosening
    // cannot silently reinterpret this pass.
    assert.equal(rows[0].tolerance, "0");
    assert.equal(rows[0].notes, null);
  },
);

test(
  "the gate anchors on the prior stated position, not on zero",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    // The account opened over a decade before any acquired history. A gate
    // anchored on zero would need 425.5 shares of transactions and would fail
    // this period forever.
    await seedAccount(client, "acct_anchor", "2011-06-01");
    await insertPosition(client, {
      accountId: "acct_anchor",
      asOf: "2026-01-31",
      quantity: "400",
    });
    await insertPosition(client, {
      accountId: "acct_anchor",
      asOf: "2026-02-28",
      quantity: "425.5",
    });
    await insertTransaction(client, {
      accountId: "acct_anchor",
      processDate: "2026-01-20",
      quantity: "1",
    });
    await insertTransaction(client, {
      accountId: "acct_anchor",
      processDate: "2026-02-14",
      quantity: "25.5",
    });

    const summary = await runPositionReconciliationGate(client);

    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 0);
    const rows = await periodRows(client, "acct_anchor");
    assert.equal(rows[0].status, "pass");
    // Anchored on 400, not on 0.
    assert.equal(rows[0].expected_change, "25.5");
  },
);

test(
  "a missing transaction fails the period and leaves it unverified",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await seedAccount(client, "acct_missing");
    await insertPosition(client, {
      accountId: "acct_missing",
      asOf: "2026-01-31",
      quantity: "100",
    });
    await insertPosition(client, {
      accountId: "acct_missing",
      asOf: "2026-02-28",
      quantity: "140",
    });
    await insertTransaction(client, {
      accountId: "acct_missing",
      processDate: "2026-01-02",
      quantity: "1",
    });
    // Only 25 of the stated 40 share increase is in the ledger.
    await insertTransaction(client, {
      accountId: "acct_missing",
      processDate: "2026-02-09",
      quantity: "25",
    });

    const summary = await runPositionReconciliationGate(client);

    assert.equal(summary.failed, 1);
    assert.equal(summary.passed, 0);
    const rows = await periodRows(client, "acct_missing");
    assert.equal(rows[0].status, "fail");
    assert.equal(rows[0].delta, "-15");
    assert.match(rows[0].notes, /does not match the stated position change/);
    // A failing period is not verified.
    assert.equal(
      await count(
        client,
        "position_reconciliations",
        "WHERE account_id = $1 AND status = 'pass'",
        ["acct_missing"],
      ),
      0,
    );
  },
);

test(
  "a period containing a sale reconciles when the stated position goes down",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await seedAccount(client, "acct_sale");
    await insertPosition(client, {
      accountId: "acct_sale",
      asOf: "2026-01-31",
      quantity: "100",
    });
    // The holding shrinks, so the derived change must be negative too. A
    // disposal recorded with an unsigned quantity would read as an
    // acquisition and put this period 60 shares out.
    await insertPosition(client, {
      accountId: "acct_sale",
      asOf: "2026-02-28",
      quantity: "70",
    });
    await insertTransaction(client, {
      accountId: "acct_sale",
      processDate: "2026-01-11",
      quantity: "1",
    });
    await insertTransaction(client, {
      accountId: "acct_sale",
      processDate: "2026-02-06",
      quantity: "-30",
    });

    const summary = await runPositionReconciliationGate(client);

    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 0);
    const rows = await periodRows(client, "acct_sale");
    assert.equal(rows[0].status, "pass");
    assert.equal(rows[0].expected_change, "-30");
    assert.equal(rows[0].computed_change, "-30");
    assert.equal(rows[0].delta, "0");
  },
);

test("a sale and a purchase in one period net exactly", { skip }, async (t) => {
  const client = await archive(t);
  await seed(client);
  await seedAccount(client, "acct_netting");
  await insertPosition(client, {
    accountId: "acct_netting",
    asOf: "2026-01-31",
    quantity: "100",
  });
  await insertPosition(client, {
    accountId: "acct_netting",
    asOf: "2026-02-28",
    quantity: "95.5",
  });
  await insertTransaction(client, {
    accountId: "acct_netting",
    processDate: "2026-01-11",
    quantity: "1",
  });
  for (const [processDate, quantity] of [
    ["2026-02-04", "-40"],
    ["2026-02-14", "35.5"],
  ]) {
    await insertTransaction(client, {
      accountId: "acct_netting",
      processDate,
      quantity,
    });
  }

  const summary = await runPositionReconciliationGate(client);

  assert.equal(summary.passed, 1);
  assert.equal((await periodRows(client, "acct_netting"))[0].delta, "0");
});

test("a duplicated transaction fails the period", { skip }, async (t) => {
  const client = await archive(t);
  await seed(client);
  await seedAccount(client, "acct_dupe");
  await insertPosition(client, {
    accountId: "acct_dupe",
    asOf: "2026-01-31",
    quantity: "100",
  });
  await insertPosition(client, {
    accountId: "acct_dupe",
    asOf: "2026-02-28",
    quantity: "120",
  });
  await insertTransaction(client, {
    accountId: "acct_dupe",
    processDate: "2026-01-02",
    quantity: "1",
  });
  await insertTransaction(client, {
    accountId: "acct_dupe",
    processDate: "2026-02-09",
    quantity: "20",
  });
  // The same movement imported twice under a different row hash.
  await insertTransaction(client, {
    accountId: "acct_dupe",
    processDate: "2026-02-09",
    quantity: "20",
  });

  const summary = await runPositionReconciliationGate(client);

  assert.equal(summary.failed, 1);
  const rows = await periodRows(client, "acct_dupe");
  assert.equal(rows[0].status, "fail");
  assert.equal(rows[0].delta, "20");
});

test(
  "a period with no acquired history behind it is unverified, not failed",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await seedAccount(client, "acct_gap");
    await insertPosition(client, {
      accountId: "acct_gap",
      asOf: "2026-01-31",
      quantity: "100",
    });
    await insertPosition(client, {
      accountId: "acct_gap",
      asOf: "2026-02-28",
      quantity: "130",
    });
    await insertPosition(client, {
      accountId: "acct_gap",
      asOf: "2026-03-31",
      quantity: "140",
    });
    // Transaction history begins inside the first period, so that period can
    // never be checked; the second is fully covered.
    await insertTransaction(client, {
      accountId: "acct_gap",
      processDate: "2026-02-10",
      quantity: "30",
    });
    await insertTransaction(client, {
      accountId: "acct_gap",
      processDate: "2026-03-05",
      quantity: "10",
    });

    const summary = await runPositionReconciliationGate(client);

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

    const rows = await periodRows(client, "acct_gap");
    assert.equal(rows[0].status, "unverified");
    assert.equal(rows[0].delta, null);
    assert.match(rows[0].notes, /transaction history begins 2026-02-10/);
    assert.equal(rows[1].status, "pass");
  },
);

test(
  "an account with stated positions and no transactions at all is unverified",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await seedAccount(client, "acct_nohistory");
    await insertPosition(client, {
      accountId: "acct_nohistory",
      asOf: "2026-01-31",
      quantity: "10",
    });
    await insertPosition(client, {
      accountId: "acct_nohistory",
      asOf: "2026-02-28",
      quantity: "10",
    });

    const summary = await runPositionReconciliationGate(client);

    assert.equal(summary.unverified, 1);
    assert.equal(summary.failed, 0);
    const rows = await periodRows(client, "acct_nohistory");
    assert.equal(rows[0].status, "unverified");
    assert.match(rows[0].notes, /no transaction history has been acquired/);
    assert.equal(summary.coverageGaps[0].transactionHistoryStartsAt, null);
  },
);

test(
  "a snapshot with no stated quantity is unverified, not counted as zero",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await seedAccount(client, "acct_null");
    await insertPosition(client, {
      accountId: "acct_null",
      asOf: "2026-01-31",
      quantity: "100",
    });
    await insertPosition(client, {
      accountId: "acct_null",
      asOf: "2026-02-28",
      quantity: null,
    });
    await insertTransaction(client, {
      accountId: "acct_null",
      processDate: "2026-01-04",
      quantity: "1",
    });

    const summary = await runPositionReconciliationGate(client);

    assert.equal(summary.unverified, 1);
    const rows = await periodRows(client, "acct_null");
    assert.equal(rows[0].status, "unverified");
    assert.equal(rows[0].expected_change, null);
    assert.match(rows[0].notes, /has no quantity/);
  },
);

test(
  "a single stated snapshot yields no period at all",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await seedAccount(client, "acct_single");
    await insertPosition(client, {
      accountId: "acct_single",
      asOf: "2026-01-31",
      quantity: "100",
    });

    const summary = await runPositionReconciliationGate(client);

    assert.equal(summary.periodsChecked, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.unverified, 0);
    assert.equal((await periodRows(client, "acct_single")).length, 0);
  },
);

test("cost basis divergence does not fail a period", { skip }, async (t) => {
  const client = await archive(t);
  await seed(client);
  await seedAccount(client, "acct_basis");
  // Quantity reconciles exactly while the stated cost basis moves by an
  // amount no transaction explains: a provider adjustment, a wash sale, a
  // return of capital. Tax-lot matching is deferred and the gate is quantity
  // only, so this must still pass.
  await insertPosition(client, {
    accountId: "acct_basis",
    asOf: "2026-01-31",
    quantity: "100",
    costBasis: "1000000",
  });
  await insertPosition(client, {
    accountId: "acct_basis",
    asOf: "2026-02-28",
    quantity: "110",
    costBasis: "9999999",
  });
  await insertTransaction(client, {
    accountId: "acct_basis",
    processDate: "2026-01-03",
    quantity: "1",
  });
  await insertTransaction(client, {
    accountId: "acct_basis",
    processDate: "2026-02-11",
    quantity: "10",
  });

  const summary = await runPositionReconciliationGate(client);

  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 0);
  assert.equal((await periodRows(client, "acct_basis"))[0].status, "pass");
});

test(
  "a corporate action with no transaction behind it fails rather than being absorbed",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await seedAccount(client, "acct_split");
    await insertPosition(client, {
      accountId: "acct_split",
      asOf: "2026-01-31",
      quantity: "100",
    });
    // A two for one split. Nothing in the ledger explains it, and the gate
    // must surface the modelling gap rather than guess at it.
    await insertPosition(client, {
      accountId: "acct_split",
      asOf: "2026-02-28",
      quantity: "200",
    });
    await insertTransaction(client, {
      accountId: "acct_split",
      processDate: "2026-01-06",
      quantity: "1",
    });

    const summary = await runPositionReconciliationGate(client);

    assert.equal(summary.failed, 1);
    assert.equal((await periodRows(client, "acct_split"))[0].delta, "-100");
  },
);

test("quantities never round through a float", { skip }, async (t) => {
  const client = await archive(t);
  await seed(client);
  await seedAccount(client, "acct_precision");
  // Three fractional lots whose exact sum is 0.3. Added as IEEE doubles they
  // come to 0.30000000000000004 and this period would fail.
  await insertPosition(client, {
    accountId: "acct_precision",
    asOf: "2026-01-31",
    quantity: "0.1",
  });
  await insertPosition(client, {
    accountId: "acct_precision",
    asOf: "2026-02-28",
    quantity: "0.4",
  });
  await insertTransaction(client, {
    accountId: "acct_precision",
    processDate: "2026-01-09",
    quantity: "0.05",
  });
  for (const processDate of ["2026-02-02", "2026-02-12", "2026-02-22"]) {
    await insertTransaction(client, {
      accountId: "acct_precision",
      processDate,
      quantity: "0.1",
    });
  }

  const summary = await runPositionReconciliationGate(client);

  assert.equal(summary.passed, 1);
  const rows = await periodRows(client, "acct_precision");
  assert.equal(rows[0].computed_change, "0.3");
  assert.equal(rows[0].delta, "0");
  // The driver's pinned NUMERIC decoder hands every one of these back as
  // decimal text, so a REAL can never reach the caller.
  for (const column of [
    "expected_change",
    "computed_change",
    "delta",
    "tolerance",
  ]) {
    assert.equal(
      typeof (
        await one(
          client,
          `SELECT ${column} AS v FROM position_reconciliations WHERE account_id = $1`,
          ["acct_precision"],
        )
      ).v,
      "string",
    );
  }
});

test(
  "instruments and accounts are reconciled independently and never crossed",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await seedAccount(client, "acct_one");
    await seedAccount(client, "acct_two");
    for (const accountId of ["acct_one", "acct_two"]) {
      for (const instrumentId of [INSTRUMENT.id, OTHER_INSTRUMENT.id]) {
        await insertPosition(client, {
          accountId,
          asOf: "2026-01-31",
          quantity: "50",
          instrumentId,
        });
        await insertPosition(client, {
          accountId,
          asOf: "2026-02-28",
          quantity: "60",
          instrumentId,
        });
        await insertTransaction(client, {
          accountId,
          processDate: "2026-01-07",
          quantity: "1",
          instrumentId,
        });
        await insertTransaction(client, {
          accountId,
          processDate: "2026-02-07",
          quantity: "10",
          instrumentId,
        });
      }
    }
    // A movement in one account's other instrument must not be borrowed by
    // any other pair.
    await insertTransaction(client, {
      accountId: "acct_one",
      processDate: "2026-02-15",
      quantity: "500",
      instrumentId: "instr_beta",
    });

    const summary = await runPositionReconciliationGate(client);

    assert.equal(summary.periodsChecked, 4);
    assert.equal(summary.accountsChecked, 2);
    assert.equal(summary.instrumentsChecked, 2);
    assert.equal(summary.passed, 3);
    assert.equal(summary.failed, 1);
    const failing = (
      await all(
        client,
        "SELECT account_id, instrument_id FROM position_reconciliations WHERE status = 'fail'",
      )
    ).map((row) => `${row.account_id}/${row.instrument_id}`);
    assert.deepEqual(failing, ["acct_one/instr_beta"]);
  },
);

test(
  "a position with no instrument is skipped rather than pooled",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await seedAccount(client, "acct_noinstr");
    for (const asOf of ["2026-01-31", "2026-02-28"]) {
      positionSeq += 1;
      await client.query(
        `INSERT INTO positions (id, account_id, as_of, instrument_id, quantity, currency)
       VALUES ($1, $2, $3, NULL, $4, 'USD')`,
        [`pos_${positionSeq}`, "acct_noinstr", asOf, "10"],
      );
    }

    const summary = await runPositionReconciliationGate(client);

    assert.equal(summary.periodsChecked, 0);
    assert.equal((await periodRows(client, "acct_noinstr")).length, 0);
  },
);

test(
  "re-running the gate replaces prior rows rather than adding to them",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await seedAccount(client, "acct_idem");
    await insertPosition(client, {
      accountId: "acct_idem",
      asOf: "2026-01-31",
      quantity: "100",
    });
    await insertPosition(client, {
      accountId: "acct_idem",
      asOf: "2026-02-28",
      quantity: "130",
    });
    await insertTransaction(client, {
      accountId: "acct_idem",
      processDate: "2026-01-08",
      quantity: "1",
    });
    await insertTransaction(client, {
      accountId: "acct_idem",
      processDate: "2026-02-08",
      quantity: "20",
    });

    assert.equal((await runPositionReconciliationGate(client)).failed, 1);
    // The missing movement is imported by a corrected run.
    await insertTransaction(client, {
      accountId: "acct_idem",
      processDate: "2026-02-18",
      quantity: "10",
    });
    const second = await runPositionReconciliationGate(client);

    assert.equal(second.periodsChecked, 1);
    assert.equal(second.passed, 1);
    const rows = await periodRows(client, "acct_idem");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pass");
  },
);

test(
  "an import run's counters and note record both gates",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await seedAccount(client, "acct_run");
    await insertPosition(client, {
      accountId: "acct_run",
      asOf: "2026-01-31",
      quantity: "100",
    });
    await insertPosition(client, {
      accountId: "acct_run",
      asOf: "2026-02-28",
      quantity: "150",
    });
    await insertTransaction(client, {
      accountId: "acct_run",
      processDate: "2026-01-08",
      quantity: "1",
    });
    await client.query(
      "INSERT INTO import_runs (id, started_at, source, notes) VALUES ($1, $2, $3, $4)",
      ["run_1", "2026-04-01T00:00:00.000Z", "test", "cash gate note"],
    );

    await runPositionReconciliationGate(client, "run_1");

    const run = await one(
      client,
      "SELECT reconciliations_passed, reconciliations_failed, notes FROM import_runs WHERE id = $1",
      ["run_1"],
    );
    // Counts, not money or quantity: BIGINT crosses the driver as pinned text,
    // same as count(*), so Number() here is the sanctioned reading, not a
    // decimal shortcut.
    assert.equal(Number(run.reconciliations_passed), 0);
    assert.equal(Number(run.reconciliations_failed), 1);
    // The cash gate's note survives; the position note is appended to it.
    assert.match(run.notes, /^cash gate note \| position reconciliation: /);
    assert.match(run.notes, /1 of 1 period\(s\)/);
  },
);
