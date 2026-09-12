// F1-59. Both reconciliation gates used to run over the whole archive after
// every document, at about four round trips per period. On the owner's
// hosted archive (63 ms round trip, 3,749 positions, ~2,700 consecutive
// pairs) that was roughly ten minutes of waiting per statement, and the
// operator loop commits one document at a time.
//
// Two things had to become true, and these are the tests for both:
//
//   1. Equivalence. A per-document incremental pass must leave exactly the
//      rows a single whole-archive pass would have left -- same verdicts,
//      same expected and computed changes, same notes -- including when
//      documents arrive out of date order and when a backdated transaction
//      moves an account's acquired history behind a period that document
//      never otherwise touched.
//   2. Latency. A per-document gate must be bounded by what the document
//      changed, not by the archive, and must batch what it does do. The
//      second test puts a 30 ms delay in front of every query (a hosted
//      round trip, near enough) over 3,000 positions across 20 accounts and
//      reports the query counts on both sides of the change.

import assert from "node:assert/strict";
import test from "node:test";

import {
  importBatch,
  publishImport,
  runPositionReconciliationGate,
  runReconciliationGate,
} from "../dist/index.js";

import { archive, skip } from "./helpers/pgArchive.mjs";

const NOW = new Date("2026-05-01T00:00:00.000Z");
const INSTITUTION = { id: "inst_bench", name: "Bench Trust", slug: "bench" };

/** Everything the gates' foreign keys need, and nothing else. */
async function seed(client, { accounts, instruments }) {
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, $2, $3)",
    [INSTITUTION.id, INSTITUTION.name, INSTITUTION.slug],
  );
  for (const [index, id] of accounts.entries()) {
    await client.query(
      `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
       VALUES ($1, $2, $3, $4, 'USD')`,
      [id, INSTITUTION.id, String(1000 + index).slice(-4), "Synthetic account"],
    );
  }
  for (const id of instruments) {
    await client.query(
      "INSERT INTO instruments (id, symbol, instrument_kind) VALUES ($1, $2, 'equity')",
      [id, id.toUpperCase()],
    );
  }
}

function txn({
  accountId,
  processDate,
  amount,
  quantity,
  instrumentId,
  locator,
}) {
  return {
    accountId,
    tradeDate: null,
    processDate,
    settleDate: null,
    datePrecision: "day",
    activityType: "trade",
    description: "Synthetic activity",
    instrumentId: instrumentId ?? null,
    quantity: quantity ?? null,
    price: null,
    amountText: amount,
    amountNote: null,
    currency: "USD",
    runningBalance: null,
    sourceLocator: locator,
    providerTxnId: locator,
  };
}

function position({ accountId, instrumentId, asOf, quantity, locator }) {
  return {
    accountId,
    asOf,
    instrumentId,
    quantity,
    price: "10",
    marketValueText: null,
    marketValueNote: "Synthetic fixture states no market value.",
    costBasis: null,
    unrealized: null,
    currency: "USD",
    valuationBasis: "market_price",
    valuationNote: "Synthetic fixture.",
    sourceLocator: locator,
  };
}

function balance({ accountId, asOf, cash, locator }) {
  return {
    accountId,
    asOf,
    totalValueText: null,
    totalValueNote: "Synthetic fixture states no total value.",
    cash,
    currency: "USD",
    periodStartValue: null,
    periodEndValue: null,
    sourceLocator: locator,
  };
}

function document(sha256, { rows = [], positions = [], balances = [] } = {}) {
  return {
    sha256,
    filePath: `synthetic/${sha256}.json`,
    institutionId: INSTITUTION.id,
    accountId: null,
    docType: "pdf_statement",
    docDate: "2026-03-31",
    providerReportedCount: rows.length,
    rows,
    positions,
    balances,
  };
}

const A = "acct_one";
const B = "acct_two";
const X = "inst_x";
const Y = "inst_y";

/**
 * Six documents chosen for the cases that separate an incremental pass from
 * a whole-archive one, not for realism:
 *
 *   - `jan`/`feb`/`mar` are ordinary in-order statements.
 *   - `backdated` adds activity *before* every stated snapshot. It changes
 *     no period's window, so only the account's earliest acquired
 *     transaction moves -- which turns the position gate's coverage-gap
 *     `unverified` verdicts into real ones for periods this document never
 *     touched.
 *   - `midFeb` arrives after `mar` and dates between two existing snapshots,
 *     so it ends a period that already has a verdict and opens two new ones.
 *   - `failing` breaks a period on purpose, so the equivalence being
 *     asserted covers a `fail` and its note, not only passes.
 */
function documentSequence() {
  const jan = document("a".repeat(64), {
    positions: [
      position({
        accountId: A,
        instrumentId: X,
        asOf: "2026-01-31",
        quantity: "10",
        locator: "h:1",
      }),
      position({
        accountId: B,
        instrumentId: Y,
        asOf: "2026-01-31",
        quantity: "5",
        locator: "h:2",
      }),
    ],
    balances: [
      balance({
        accountId: A,
        asOf: "2026-01-31",
        cash: "1000",
        locator: "b:1",
      }),
      balance({
        accountId: B,
        asOf: "2026-01-31",
        cash: "500",
        locator: "b:2",
      }),
    ],
  });

  const feb = document("b".repeat(64), {
    rows: [
      txn({
        accountId: A,
        processDate: "2026-02-10",
        amount: "100",
        quantity: "2",
        instrumentId: X,
        locator: "t:feb-1",
      }),
    ],
    positions: [
      position({
        accountId: A,
        instrumentId: X,
        asOf: "2026-02-28",
        quantity: "12",
        locator: "h:3",
      }),
    ],
    balances: [
      balance({
        accountId: A,
        asOf: "2026-02-28",
        cash: "1100",
        locator: "b:3",
      }),
    ],
  });

  const mar = document("c".repeat(64), {
    rows: [
      txn({
        accountId: A,
        processDate: "2026-03-05",
        amount: "-50",
        locator: "t:mar-1",
      }),
      txn({
        accountId: B,
        processDate: "2026-03-07",
        amount: "25",
        quantity: "1",
        instrumentId: Y,
        locator: "t:mar-2",
      }),
    ],
    positions: [
      position({
        accountId: A,
        instrumentId: X,
        asOf: "2026-03-31",
        quantity: "12",
        locator: "h:4",
      }),
      position({
        accountId: B,
        instrumentId: Y,
        asOf: "2026-03-31",
        quantity: "6",
        locator: "h:5",
      }),
    ],
    balances: [
      balance({
        accountId: A,
        asOf: "2026-03-31",
        cash: "1050",
        locator: "b:4",
      }),
      balance({
        accountId: B,
        asOf: "2026-03-31",
        cash: "525",
        locator: "b:5",
      }),
    ],
  });

  const backdated = document("d".repeat(64), {
    rows: [
      txn({
        accountId: A,
        processDate: "2026-01-10",
        amount: "0",
        quantity: "0",
        instrumentId: X,
        locator: "t:jan-1",
      }),
      txn({
        accountId: B,
        processDate: "2026-01-09",
        amount: "0",
        quantity: "0",
        instrumentId: Y,
        locator: "t:jan-2",
      }),
    ],
  });

  // Splits B's one Jan..Mar period in two, after that period already has a
  // verdict of its own.
  const midFeb = document("e".repeat(64), {
    positions: [
      position({
        accountId: B,
        instrumentId: Y,
        asOf: "2026-02-14",
        quantity: "5",
        locator: "h:6",
      }),
    ],
    balances: [
      balance({
        accountId: B,
        asOf: "2026-02-14",
        cash: "500",
        locator: "b:6",
      }),
    ],
  });

  // April's stated change is explained by nothing at all: one fail per gate.
  const failing = document("f".repeat(64), {
    positions: [
      position({
        accountId: A,
        instrumentId: X,
        asOf: "2026-04-30",
        quantity: "99",
        locator: "h:7",
      }),
    ],
    balances: [
      balance({
        accountId: A,
        asOf: "2026-04-30",
        cash: "9999",
        locator: "b:7",
      }),
    ],
  });

  return [jan, feb, mar, backdated, midFeb, failing];
}

const CASH_VERDICTS = `SELECT account_id, period_start, period_end,
    expected_change::text AS expected_change, computed_change::text AS computed_change,
    delta::text AS delta, currency, tolerance::text AS tolerance, status, notes
  FROM reconciliations ORDER BY account_id, period_start, period_end`;

const POSITION_VERDICTS = `SELECT account_id, instrument_id, period_start, period_end,
    expected_change::text AS expected_change, computed_change::text AS computed_change,
    delta::text AS delta, tolerance::text AS tolerance, status, notes
  FROM position_reconciliations
  ORDER BY account_id, instrument_id, period_start, period_end`;

test(
  "gating each document as it lands leaves exactly what one whole-archive pass leaves",
  { skip },
  async (t) => {
    const incremental = await archive(t);
    const whole = await archive(t);
    const fixture = { accounts: [A, B], instruments: [X, Y] };
    await seed(incremental, fixture);
    await seed(whole, fixture);

    const documents = documentSequence();

    // The operator loop: one document, one publication, gates included.
    for (const doc of documents) {
      await publishImport(
        incremental,
        { source: "bench", documents: [doc] },
        NOW,
      );
    }

    // The same documents, same order, same import path -- but gated once, at
    // the end, over everything.
    for (const doc of documents) {
      await importBatch(whole, { source: "bench", documents: [doc] }, NOW);
    }
    await runReconciliationGate(whole);
    await runPositionReconciliationGate(whole);

    const cashIncremental = (await incremental.query(CASH_VERDICTS)).rows;
    const cashWhole = (await whole.query(CASH_VERDICTS)).rows;
    assert.deepEqual(cashIncremental, cashWhole);

    const positionsIncremental = (await incremental.query(POSITION_VERDICTS))
      .rows;
    const positionsWhole = (await whole.query(POSITION_VERDICTS)).rows;
    assert.deepEqual(positionsIncremental, positionsWhole);

    // Guard the fixture itself: an equivalence test over two empty tables,
    // or over nothing but passes, would prove nothing.
    assert.ok(cashWhole.length >= 5, `only ${cashWhole.length} cash periods`);
    assert.ok(
      positionsWhole.length >= 4,
      `only ${positionsWhole.length} position periods`,
    );
    const statuses = new Set([
      ...cashWhole.map((r) => r.status),
      ...positionsWhole.map((r) => r.status),
    ]);
    assert.ok(statuses.has("pass"), "no period passed");
    assert.ok(statuses.has("fail"), "no period failed");

    // The backdated document's whole point: it touches no period's window,
    // and both forms still agree that A's Jan..Feb position period is a real
    // verdict rather than an unchecked coverage gap.
    const janFeb = positionsIncremental.find(
      (r) =>
        r.account_id === A &&
        r.period_start === "2026-01-31" &&
        r.period_end === "2026-02-28",
    );
    assert.equal(janFeb.status, "pass");

    // And the out-of-order document's: the period it split no longer exists
    // in either archive.
    assert.equal(
      positionsIncremental.filter(
        (r) =>
          r.account_id === B &&
          r.period_start === "2026-01-31" &&
          r.period_end === "2026-03-31",
      ).length,
      0,
    );
  },
);

// --- latency ---------------------------------------------------------------

/** 3,000 positions across 20 accounts, inserted without going near a gate. */
const LATENCY_ACCOUNTS = 20;
const LATENCY_INSTRUMENTS = 5;
const LATENCY_PERIODS = 30;
const LATENCY_POSITIONS =
  LATENCY_ACCOUNTS * LATENCY_INSTRUMENTS * LATENCY_PERIODS;

function asOfFor(period) {
  const month = String((period % 12) + 1).padStart(2, "0");
  const year = 2020 + Math.floor(period / 12);
  return `${year}-${month}-28`;
}

async function seedLatencyArchive(client) {
  const accounts = Array.from(
    { length: LATENCY_ACCOUNTS },
    (_, i) => `acct_${i}`,
  );
  const instruments = Array.from(
    { length: LATENCY_INSTRUMENTS },
    (_, i) => `inst_${i}`,
  );
  await seed(client, { accounts, instruments });

  const ids = [];
  const accountIds = [];
  const instrumentIds = [];
  const asOfs = [];
  const hashes = [];
  for (const account of accounts) {
    for (const instrument of instruments) {
      for (let period = 0; period < LATENCY_PERIODS; period += 1) {
        const key = `${account}/${instrument}/${period}`;
        ids.push(key);
        accountIds.push(account);
        instrumentIds.push(instrument);
        asOfs.push(asOfFor(period));
        hashes.push(`hash:${key}`);
      }
    }
  }
  await client.query(
    `INSERT INTO positions (id, account_id, as_of, instrument_id, quantity, currency, row_hash)
     SELECT * FROM unnest($1::text[], $2::text[], $3::date[], $4::text[],
                          $5::numeric[], $6::text[], $7::text[])`,
    [
      ids,
      accountIds,
      asOfs,
      instrumentIds,
      ids.map(() => "100"),
      ids.map(() => "USD"),
      hashes,
    ],
  );
  // One zero-quantity transaction per account, before every stated snapshot.
  // It makes the archive a *settled* one -- acquired history reaches back far
  // enough that no period is a coverage gap, and every period's stated
  // quantity change of zero is explained -- which is the archive an
  // incremental pass is supposed to be cheap against. (Against an archive
  // where nothing passes, an incremental pass rechecks that account's
  // outstanding not-passed periods too, by design: see `scopedPairs`.)
  await client.query(
    `INSERT INTO transactions
       (id, account_id, process_date, date_precision, activity_type, description,
        instrument_id, quantity, currency, row_hash, imported_at)
     SELECT 'seed_' || a.account_id, a.account_id, DATE '2019-01-01', 'day', 'trade',
            'Synthetic opening activity', $2, 0, 'USD', 'hash:seed:' || a.account_id, now()
     FROM unnest($1::text[]) AS a(account_id)`,
    [accounts, instruments[0]],
  );
  return { accounts, instruments };
}

/**
 * Makes every query on this client wait `delayMs` and counts them, then
 * `stop()` puts the client back. Patched in place rather than wrapped: the
 * schema a connection resolves archive objects in is pinned per connection
 * *object* (pgStore.ts), so a wrapper would be a different object with a
 * different -- wrong -- schema.
 */
function delayQueries(client, delayMs) {
  const original = client.query.bind(client);
  const state = {
    queries: 0,
    stop() {
      delete client.query;
    },
  };
  client.query = async (...args) => {
    state.queries += 1;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return original(...args);
  };
  return state;
}

test(
  "a per-document gate costs what the document changed, not what the archive holds",
  { skip },
  async (t) => {
    const client = await archive(t);
    const { accounts, instruments } = await seedLatencyArchive(client);
    assert.equal(
      Number(
        (await client.query("SELECT count(*)::int AS n FROM positions")).rows[0]
          .n,
      ),
      LATENCY_POSITIONS,
    );

    const pairs = LATENCY_POSITIONS - accounts.length * instruments.length;

    // A hosted round trip, near enough. The gate's own cost is messages, so
    // this is the only dimension that matters; the rows are local either way.
    const ROUND_TRIP_MS = 30;

    // The whole-archive pass, as `--gates full` and the reparse's end run it.
    const full = delayQueries(client, ROUND_TRIP_MS);
    const fullStarted = Date.now();
    let fullSummary;
    try {
      fullSummary = await runPositionReconciliationGate(client);
    } finally {
      full.stop();
    }
    const fullMs = Date.now() - fullStarted;
    assert.equal(fullSummary.periodsChecked, pairs);
    assert.equal(fullSummary.passed, pairs);

    // One document's worth of change: one account, one instrument, one new
    // stated snapshot and the activity behind it.
    const scope = {
      snapshots: [
        {
          accountId: accounts[0],
          instrumentId: instruments[0],
          date: "2026-06-30",
        },
      ],
      activity: [
        {
          accountId: accounts[0],
          instrumentId: instruments[0],
          date: "2026-06-15",
        },
      ],
    };
    await client.query(
      `INSERT INTO positions (id, account_id, as_of, instrument_id, quantity, currency, row_hash)
       VALUES ('p_new', $1, '2026-06-30', $2, '100', 'USD', 'hash:new')`,
      [accounts[0], instruments[0]],
    );

    const incremental = delayQueries(client, ROUND_TRIP_MS);
    const incrementalStarted = Date.now();
    let incrementalSummary;
    try {
      incrementalSummary = await runPositionReconciliationGate(
        client,
        undefined,
        scope,
      );
    } finally {
      incremental.stop();
    }
    const incrementalMs = Date.now() - incrementalStarted;

    // The cost model this task exists to change, printed rather than only
    // asserted: before, a per-document gate was a whole-archive pass at
    // about four round trips per period.
    const before = pairs * 4 + accounts.length;
    console.log(
      `positions=${LATENCY_POSITIONS} accounts=${accounts.length} pairs=${pairs} ` +
        `round trip=${ROUND_TRIP_MS}ms`,
    );
    console.log(
      `  before (whole archive, one query per period): ~${before} queries, ` +
        `~${Math.round((before * ROUND_TRIP_MS) / 1000)}s per document`,
    );
    console.log(
      `  after (whole archive, batched): ${full.queries} queries, ${fullMs}ms`,
    );
    console.log(
      `  after (incremental, one document): ${incremental.queries} queries, ` +
        `${incrementalMs}ms, ${incrementalSummary.periodsChecked} period(s) checked`,
    );

    // The requirement: a per-document gate under two seconds at a hosted
    // round trip, and bounded by the document rather than the archive.
    assert.ok(
      incrementalMs < 2000,
      `an incremental gate took ${incrementalMs}ms at ${ROUND_TRIP_MS}ms per query`,
    );
    assert.ok(
      incremental.queries <= 20,
      `an incremental gate issued ${incremental.queries} queries`,
    );
    assert.ok(
      incrementalSummary.periodsChecked < 10,
      `an incremental gate checked ${incrementalSummary.periodsChecked} periods`,
    );
    // Even the whole-archive form is now a fixed handful of round trips.
    assert.ok(
      full.queries <= 20,
      `a whole-archive pass issued ${full.queries} queries for ${pairs} periods`,
    );
  },
);
