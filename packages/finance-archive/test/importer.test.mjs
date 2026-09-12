import assert from "node:assert/strict";
import test from "node:test";

import { importBatch, rowHashV2 } from "../dist/index.js";

import { all, archive, count, one, skip } from "./helpers/pgArchive.mjs";

// Synthetic institution and accounts. No real institution, account, balance
// or file path appears anywhere in this suite.
const INSTITUTION = {
  id: "inst_river_bend",
  name: "River Bend Trust",
  slug: "river-bend",
};
const ACCOUNT = { id: "acct_alpha", last4: "0199", currency: "USD" };
const OTHER_ACCOUNT = { id: "acct_beta", last4: "0288", currency: "USD" };

async function seed(client) {
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, $2, $3)",
    [INSTITUTION.id, INSTITUTION.name, INSTITUTION.slug],
  );
  for (const account of [ACCOUNT, OTHER_ACCOUNT]) {
    await client.query(
      `INSERT INTO accounts (id, institution_id, acct_last4, display_name, base_currency)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        account.id,
        INSTITUTION.id,
        account.last4,
        "Synthetic account",
        account.currency,
      ],
    );
  }
}

/** A minimal, valid row. Tests override only the fields they care about. */
function row(overrides = {}) {
  return {
    accountId: ACCOUNT.id,
    tradeDate: null,
    processDate: "2026-03-15",
    settleDate: null,
    datePrecision: "day",
    activityType: "debit",
    description: "Synthetic grocery purchase",
    instrumentId: null,
    quantity: null,
    price: null,
    amountText: "-42.10",
    amountNote: null,
    currency: "USD",
    runningBalance: null,
    sourceLocator: "row:1",
    providerTxnId: null,
    ...overrides,
  };
}

/** A document wrapping the given rows, with a matching providerReportedCount. */
function document(sha256, rows, overrides = {}) {
  return {
    sha256,
    filePath: `synthetic/${sha256}.json`,
    institutionId: INSTITUTION.id,
    accountId: ACCOUNT.id,
    docType: "activity_pull",
    docDate: "2026-03-31",
    providerReportedCount: rows.length,
    rows,
    ...overrides,
  };
}

const NOW = new Date("2026-04-01T00:00:00.000Z");

test(
  "repeated import of the same raw tree inserts nothing new",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const rows = [
      row({ sourceLocator: "row:1", providerTxnId: "ptx-1" }),
      row({
        sourceLocator: "row:2",
        providerTxnId: "ptx-2",
        description: "Synthetic transit fare",
        amountText: "-3.25",
      }),
    ];
    const batch = {
      source: "synthetic-pull",
      documents: [document("a".repeat(64), rows)],
    };

    const first = await importBatch(client, batch, NOW);
    assert.equal(first.rowsInserted, 2);
    assert.equal(first.rowsSkipped, 0);

    const second = await importBatch(client, batch, NOW);
    assert.equal(second.rowsInserted, 0);
    assert.equal(second.rowsSkipped, 2);

    assert.equal(await count(client, "transactions"), 2);
  },
);

test(
  "overlapping paginated pages deduplicate via the stable provider id",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const shared = row({
      sourceLocator: "page:1,row:9",
      providerTxnId: "ptx-shared",
      description: "Synthetic subscription charge",
      amountText: "-9.99",
    });
    const page1 = document("b".repeat(64), [
      row({
        sourceLocator: "page:1,row:1",
        providerTxnId: "ptx-a",
        amountText: "-10.00",
      }),
      shared,
    ]);
    // Page 2 overlaps page 1 by one row, as a paginated activity API normally
    // does: the same transaction, same provider id, different locator.
    const page2 = document("c".repeat(64), [
      { ...shared, sourceLocator: "page:2,row:1" },
      row({
        sourceLocator: "page:2,row:2",
        providerTxnId: "ptx-b",
        amountText: "-20.00",
      }),
    ]);

    const summary = await importBatch(
      client,
      { source: "synthetic-pull", documents: [page1, page2] },
      NOW,
    );

    assert.equal(summary.rowsInserted, 3);
    assert.equal(summary.rowsSkipped, 1);
    assert.equal(await count(client, "transactions"), 3);
    assert.equal(
      await count(client, "transactions", "WHERE provider_txn_id = $1", [
        "ptx-shared",
      ]),
      1,
    );
  },
);

test(
  "a provider-reported total that does not match the pull fails loudly",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const rows = [
      row({ providerTxnId: "ptx-1" }),
      row({ providerTxnId: "ptx-2", sourceLocator: "row:2" }),
    ];
    const batch = {
      source: "synthetic-pull",
      documents: [document("d".repeat(64), rows, { providerReportedCount: 3 })],
    };

    await assert.rejects(importBatch(client, batch, NOW), /reported 3 rows/);
    // The whole run rolled back: nothing was absorbed silently.
    assert.equal(await count(client, "transactions"), 0);
    assert.equal(await count(client, "import_runs"), 0);
  },
);

test(
  "an amount an adapter could not read at all enters the review queue with its note, not silently null",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const rows = [
      row({
        providerTxnId: "ptx-garbled",
        amountText: null,
        amountNote: 'statement text has an unparseable amount: "1,2O3.45"',
      }),
    ];
    const summary = await importBatch(
      client,
      {
        source: "synthetic-pull",
        documents: [document("b1".padEnd(64, "0"), rows)],
      },
      NOW,
    );

    assert.equal(summary.rowsInserted, 1);
    assert.equal(summary.reviewItemsOpened, 1);

    const stored = await one(
      client,
      "SELECT amount, status FROM transactions WHERE provider_txn_id = 'ptx-garbled'",
    );
    assert.equal(stored.amount, null);
    assert.equal(stored.status, "review");

    const review = await one(
      client,
      "SELECT kind, reason, status FROM review_items",
    );
    assert.equal(review.kind, "ambiguous_amount");
    assert.equal(review.reason, rows[0].amountNote);
    assert.equal(review.status, "open");
  },
);

test(
  "a row with genuinely no amount (a non-monetary event) opens no review item",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const rows = [
      row({
        providerTxnId: "ptx-nonmonetary",
        activityType: "info",
        amountText: null,
        amountNote: null,
      }),
    ];
    const summary = await importBatch(
      client,
      {
        source: "synthetic-pull",
        documents: [document("b2".padEnd(64, "0"), rows)],
      },
      NOW,
    );

    assert.equal(summary.rowsInserted, 1);
    assert.equal(summary.reviewItemsOpened, 0);
    const stored = await one(
      client,
      "SELECT amount, status FROM transactions WHERE provider_txn_id = 'ptx-nonmonetary'",
    );
    assert.equal(stored.amount, null);
    assert.equal(stored.status, "imported");
  },
);

test(
  "an amount too precise for its currency enters the review queue, never a rounded guess",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const rows = [row({ providerTxnId: "ptx-1", amountText: "12.345" })];
    const summary = await importBatch(
      client,
      { source: "synthetic-pull", documents: [document("e".repeat(64), rows)] },
      NOW,
    );

    assert.equal(summary.rowsInserted, 1);
    assert.equal(summary.reviewItemsOpened, 1);

    const stored = await one(
      client,
      "SELECT amount, status FROM transactions WHERE provider_txn_id = 'ptx-1'",
    );
    assert.equal(stored.amount, null);
    assert.equal(stored.status, "review");

    const review = await one(
      client,
      "SELECT kind, raw_value, status FROM review_items",
    );
    assert.equal(review.kind, "ambiguous_amount");
    assert.equal(review.raw_value, "12.345");
    assert.equal(review.status, "open");
  },
);

test(
  "a future date and an implausible date open a review item without blocking the transaction",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const rows = [
      row({ providerTxnId: "ptx-future", processDate: "2099-01-01" }),
      row({
        providerTxnId: "ptx-old",
        sourceLocator: "row:2",
        processDate: "1850-01-01",
      }),
    ];
    const summary = await importBatch(
      client,
      { source: "synthetic-pull", documents: [document("f".repeat(64), rows)] },
      NOW,
    );

    assert.equal(summary.rowsInserted, 2);
    assert.equal(summary.reviewItemsOpened, 2);
    const kinds = (
      await all(client, "SELECT kind FROM review_items ORDER BY kind")
    ).map((r) => r.kind);
    assert.deepEqual(kinds, ["future_date", "implausible_date"]);
  },
);

test(
  "a row with no parseable process date opens a review item and is not inserted",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const rows = [row({ providerTxnId: "ptx-1", processDate: "not-a-date" })];
    const summary = await importBatch(
      client,
      { source: "synthetic-pull", documents: [document("0".repeat(64), rows)] },
      NOW,
    );

    assert.equal(summary.rowsInserted, 0);
    assert.equal(summary.rowsSkipped, 1);
    assert.equal(summary.reviewItemsOpened, 1);
    assert.equal(
      (await one(client, "SELECT kind FROM review_items")).kind,
      "unparseable_process_date",
    );
  },
);

test(
  "equal date, amount and description is not proof of duplication: distinct provider ids are both kept",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const rows = [
      row({
        providerTxnId: "ptx-coffee-1",
        sourceLocator: "row:1",
        description: "Synthetic coffee shop",
        amountText: "-4.50",
      }),
      row({
        providerTxnId: "ptx-coffee-2",
        sourceLocator: "row:2",
        description: "Synthetic coffee shop",
        amountText: "-4.50",
      }),
    ];
    const summary = await importBatch(
      client,
      { source: "synthetic-pull", documents: [document("1".repeat(64), rows)] },
      NOW,
    );

    assert.equal(summary.rowsInserted, 2);
    const stored = await all(
      client,
      "SELECT row_hash, provider_txn_id FROM transactions ORDER BY provider_txn_id",
    );
    assert.equal(stored.length, 2);
    // Both rows share the same content, but they are the first and second
    // occurrence of that content within this one document, so the occurrence
    // ordinal hashed into row_hash differs and so do the stored values. Each
    // is a plain sha256 hex digest; nothing is appended after the fact.
    assert.notEqual(stored[0].row_hash, stored[1].row_hash);
    for (const s of stored) assert.match(s.row_hash, /^[0-9a-f]{64}$/);
  },
);

test(
  "equal date, amount and description without a provider id: both distinct rows are preserved, not merged",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    // No provider id at all, as from a hand-transcribed PDF statement: two
    // genuinely separate $12 tolls on the same day, worded identically. A
    // hash-only dedupe would silently destroy one of these.
    const rows = [
      row({
        sourceLocator: "page:1,row:4",
        description: "Synthetic toll charge",
        amountText: "-12.00",
      }),
      row({
        sourceLocator: "page:1,row:9",
        description: "Synthetic toll charge",
        amountText: "-12.00",
      }),
    ];
    const summary = await importBatch(
      client,
      { source: "synthetic-pdf", documents: [document("2".repeat(64), rows)] },
      NOW,
    );

    assert.equal(summary.rowsInserted, 2);
    assert.equal(await count(client, "transactions"), 2);
    const hashes = (
      await all(client, "SELECT row_hash FROM transactions ORDER BY row_hash")
    ).map((r) => r.row_hash);
    assert.notEqual(hashes[0], hashes[1]);
  },
);

test(
  "overlapping paginated pages deduplicate with no provider id at all (regression)",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    // One logical dividend, no providerTxnId, appearing on two overlapping
    // pages of one pull, as from a tabular export or PDF-derived activity
    // table. A naive import must not double the amount.
    const dividend = row({
      description: "Synthetic dividend",
      amountText: "12.34",
    });
    const page1 = document("5".repeat(64), [
      { ...dividend, sourceLocator: "page:1,row:1" },
    ]);
    const page2 = document("6".repeat(64), [
      { ...dividend, sourceLocator: "page:2,row:1" },
    ]);

    const summary = await importBatch(
      client,
      { source: "synthetic-pull", documents: [page1, page2] },
      NOW,
    );

    assert.equal(summary.rowsInserted, 1);
    assert.equal(summary.rowsSkipped, 1);
    assert.equal(await count(client, "transactions"), 1);
    const stored = await one(client, "SELECT amount FROM transactions");
    assert.equal(stored.amount, "12.34");

    // The collapse rests on content evidence across two documents, not a
    // stable id, so it is visible in the review queue, not silent.
    const review = await one(client, "SELECT kind, reason FROM review_items");
    assert.equal(review.kind, "cross_document_duplicate");
    assert.match(review.reason, /page:1,row:1/);
  },
);

test(
  "one copy on page 1 and two copies on page 2 resolves on its own: the first dedupes, the second inserts",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const toll = row({
      description: "Synthetic toll charge",
      amountText: "-5.00",
    });
    const page1 = document("7".repeat(64), [
      { ...toll, sourceLocator: "page:1,row:1" },
    ]);
    const page2 = document("8".repeat(64), [
      { ...toll, sourceLocator: "page:2,row:1" },
      { ...toll, sourceLocator: "page:2,row:2" },
    ]);

    const summary = await importBatch(
      client,
      { source: "synthetic-pull", documents: [page1, page2] },
      NOW,
    );

    assert.equal(summary.rowsInserted, 2);
    assert.equal(summary.rowsSkipped, 1);
    assert.equal(await count(client, "transactions"), 2);
  },
);

// This test needs no database: rowHashV2 is pure logic, so it runs
// unconditionally (see test/pgMoney.test.mjs for the same convention). It
// now exercises rowHashV2 directly with a decimal-text amount, asserting the
// occurrence ordinal's two properties: two different ordinals over the same
// content hash differently ("hashed, not appended"), and a missing or
// non-positive-integer ordinal is a RangeError rather than something
// silently hashed into its own namespace.
test("row_hash's occurrence field is required and hashed, not appended", () => {
  const content = {
    accountId: ACCOUNT.id,
    processDate: "2026-03-15",
    activityType: "debit",
    description: "Synthetic dup",
    quantity: null,
    amount: "-1.00",
    currency: "USD",
  };
  assert.notEqual(
    rowHashV2({ ...content, occurrence: 1 }),
    rowHashV2({ ...content, occurrence: 2 }),
  );
  for (const occurrence of [0, -1, 1.5, undefined, null]) {
    assert.throws(() => rowHashV2({ ...content, occurrence }), RangeError);
  }
});

test(
  "a malformed trade date opens a review item instead of aborting the batch",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const rows = [
      row({ providerTxnId: "ptx-1", tradeDate: "not-a-date" }),
      row({ providerTxnId: "ptx-2", sourceLocator: "row:2" }),
    ];
    const summary = await importBatch(
      client,
      {
        source: "synthetic-pull",
        documents: [document("a1".padEnd(64, "0"), rows)],
      },
      NOW,
    );

    assert.equal(summary.rowsInserted, 2);
    assert.equal(summary.reviewItemsOpened, 1);
    const stored = await one(
      client,
      "SELECT trade_date, status FROM transactions WHERE provider_txn_id = 'ptx-1'",
    );
    assert.equal(stored.trade_date, null);
    assert.equal(stored.status, "review");
    assert.equal(
      (await one(client, "SELECT kind FROM review_items")).kind,
      "unparseable_trade_date",
    );
  },
);

test(
  "every run asserts that every transaction resolves to an account",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const rows = [
      row({ accountId: "acct_does_not_exist", providerTxnId: "ptx-1" }),
    ];
    await assert.rejects(
      importBatch(
        client,
        {
          source: "synthetic-pull",
          documents: [document("3".repeat(64), rows)],
        },
        NOW,
      ),
      /FOREIGN KEY|foreign key/i,
    );
    assert.equal(await count(client, "transactions"), 0);
  },
);

test(
  "the import summary never carries row content, only counts",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const rows = [row({ providerTxnId: "ptx-1" })];
    const summary = await importBatch(
      client,
      { source: "synthetic-pull", documents: [document("4".repeat(64), rows)] },
      NOW,
    );
    assert.deepEqual(Object.keys(summary).sort(), [
      "filesSeen",
      "importRunId",
      "reconciliationsFailed",
      "reconciliationsPassed",
      "reviewItemsOpened",
      "rowsDeduplicated",
      "rowsInserted",
      "rowsRefused",
      "rowsSkipped",
    ]);
    const runRow = await one(
      client,
      "SELECT files_seen, rows_inserted, rows_skipped FROM import_runs",
    );
    assert.equal(Number(runRow.files_seen), 1);
    assert.equal(Number(runRow.rows_inserted), 1);
    assert.equal(Number(runRow.rows_skipped), 0);
  },
);

// --- F1-16: holdings (positions, balances, liabilities) --------------------
//
// This section hand-builds ImportPosition/ImportBalance/ImportLiability
// literals directly, the same way `row()`/`document()` above hand-build
// ImportRow/ImportDocument: importBatch's own contract, not routed through
// an adapter (that end-to-end path is test/adapterImport.test.mjs).

/** A minimal, valid position. Tests override only the fields they care about. */
function position(overrides = {}) {
  return {
    asOf: "2026-03-31",
    instrumentId: null,
    quantity: "10",
    price: "50",
    marketValueText: "500",
    marketValueNote: null,
    costBasis: "400",
    unrealized: "100",
    currency: "USD",
    valuationBasis: "market_price",
    valuationNote: "Synthetic delayed market feed.",
    sourceLocator: "holdings:1",
    ...overrides,
  };
}

test(
  "a position imports with valuation_basis populated and full provenance",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const summary = await importBatch(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("10".padEnd(64, "0"), [], { positions: [position()] }),
        ],
      },
      NOW,
    );
    assert.equal(summary.rowsInserted, 1);
    assert.equal(summary.reviewItemsOpened, 0);

    const stored = await one(
      client,
      "SELECT account_id, valuation_basis, valuation_note, source_document_id, source_locator, market_value, cost_basis, unrealized FROM positions",
    );
    assert.equal(stored.account_id, ACCOUNT.id);
    assert.equal(stored.valuation_basis, "market_price");
    assert.equal(stored.valuation_note, "Synthetic delayed market feed.");
    assert.ok(stored.source_document_id);
    assert.equal(stored.source_locator, "holdings:1");
    assert.equal(stored.market_value, "500");
    assert.equal(stored.cost_basis, "400");
    assert.equal(stored.unrealized, "100");
  },
);

test(
  "a null valuation basis is never silent: it opens a review item, matching the plan's warning about mixed totals",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const summary = await importBatch(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("11".padEnd(64, "0"), [], {
            positions: [
              position({
                valuationBasis: null,
                valuationNote:
                  "Statement does not state a valuation basis for this line.",
              }),
            ],
          }),
        ],
      },
      NOW,
    );
    assert.equal(summary.rowsInserted, 1);
    assert.equal(summary.reviewItemsOpened, 1);
    const review = await one(
      client,
      "SELECT kind, reason FROM review_items WHERE kind = 'ambiguous_valuation_basis'",
    );
    assert.match(review.reason, /does not state a valuation basis/);
    const stored = await one(client, "SELECT valuation_basis FROM positions");
    assert.equal(stored.valuation_basis, null);
  },
);

test(
  "a valuation basis outside the known four is not trusted onto the row: null, with a review item",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await importBatch(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("12".padEnd(64, "0"), [], {
            positions: [
              position({ valuationBasis: "guessed", valuationNote: "n/a" }),
            ],
          }),
        ],
      },
      NOW,
    );
    const stored = await one(client, "SELECT valuation_basis FROM positions");
    assert.equal(stored.valuation_basis, null);
    const review = await one(
      client,
      "SELECT reason FROM review_items WHERE kind = 'ambiguous_valuation_basis'",
    );
    assert.match(review.reason, /"guessed" is not one of/);
  },
);

test(
  "an ambiguous market value is null with a review item, never guessed, and never blocks the row",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const summary = await importBatch(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("13".padEnd(64, "0"), [], {
            positions: [
              position({
                marketValueText: null,
                marketValueNote:
                  'statement text has an unparseable market value: "1,2O3.45"',
              }),
            ],
          }),
        ],
      },
      NOW,
    );
    assert.equal(summary.rowsInserted, 1);
    const stored = await one(client, "SELECT market_value FROM positions");
    assert.equal(stored.market_value, null);
    const review = await one(
      client,
      "SELECT reason FROM review_items WHERE kind = 'ambiguous_market_value'",
    );
    assert.match(review.reason, /unparseable market value/);
  },
);

test(
  "a position with an unparseable as_of opens a review item and is not inserted, like process_date",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const summary = await importBatch(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("14".padEnd(64, "0"), [], {
            positions: [position({ asOf: "not-a-date" })],
          }),
        ],
      },
      NOW,
    );
    assert.equal(summary.rowsInserted, 0);
    assert.equal(summary.rowsSkipped, 1);
    assert.equal(await count(client, "positions"), 0);
    assert.equal(
      (await one(client, "SELECT kind FROM review_items")).kind,
      "unparseable_as_of",
    );
  },
);

test(
  "re-importing the same document does not duplicate positions, balances or liabilities",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const balance = {
      asOf: "2026-03-31",
      totalValueText: "10000",
      totalValueNote: null,
      cash: "500",
      currency: "USD",
      periodStartValue: "9500",
      periodEndValue: "10000",
      sourceLocator: "holdings:balance",
    };
    const liability = {
      kind: "margin_loan",
      displayName: "Synthetic margin balance",
      balanceText: "2000",
      balanceNote: null,
      currency: "USD",
      rate: "4.5",
      asOf: "2026-03-31",
      collateralNote: "Synthetic collateral note.",
      sourceLocator: "holdings:liability",
    };
    const doc = document("15".padEnd(64, "0"), [], {
      positions: [position()],
      balances: [balance],
      liabilities: [liability],
    });

    const first = await importBatch(
      client,
      { source: "synthetic-pull", documents: [doc] },
      NOW,
    );
    assert.equal(first.rowsInserted, 3);
    assert.equal(await count(client, "positions"), 1);
    assert.equal(await count(client, "balances"), 1);
    assert.equal(await count(client, "liabilities"), 1);

    const second = await importBatch(
      client,
      { source: "synthetic-pull", documents: [doc] },
      NOW,
    );
    assert.equal(second.rowsInserted, 0);
    assert.equal(second.rowsSkipped, 3);
    assert.equal(await count(client, "positions"), 1);
    assert.equal(await count(client, "balances"), 1);
    assert.equal(await count(client, "liabilities"), 1);
  },
);

// F1-49. A parse-noted document is never eligible for the whole-document
// skip (see the parsed_ok test above and importBatch's parseNote branch), so
// every rerun reprocesses it in full -- which, before row_hash existed on
// these three tables, blindly re-inserted every holding it had already
// stored. positions.row_hash/balances.row_hash/liabilities.row_hash (pgSchema.ts
// version 5) are what make that rerun a no-op instead.
test(
  "a parse-noted document never duplicates its own holdings on rerun, even though it is reprocessed every time",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const balance = {
      asOf: "2026-03-31",
      totalValueText: "10000",
      totalValueNote: null,
      cash: "500",
      currency: "USD",
      periodStartValue: "9500",
      periodEndValue: "10000",
      sourceLocator: "holdings:balance",
    };
    const liability = {
      kind: "margin_loan",
      displayName: "Synthetic margin balance",
      balanceText: "2000",
      balanceNote: null,
      currency: "USD",
      rate: "4.5",
      asOf: "2026-03-31",
      collateralNote: "Synthetic collateral note.",
      sourceLocator: "holdings:liability",
    };
    const doc = document(
      "17".padEnd(64, "0"),
      [row({ sourceLocator: "row:1", providerTxnId: "ptx-parsenote" })],
      {
        parseNote: "extractor found no text for the remainder of this statement",
        positions: [position()],
        balances: [balance],
        liabilities: [liability],
      },
    );

    const first = await importBatch(
      client,
      { source: "synthetic-pull", documents: [doc] },
      NOW,
    );
    // The one row, plus one position, one balance and one liability.
    assert.equal(first.rowsInserted, 4);
    assert.equal(await count(client, "positions"), 1);
    assert.equal(await count(client, "balances"), 1);
    assert.equal(await count(client, "liabilities"), 1);

    const afterFirst = await one(
      client,
      "SELECT parsed_ok FROM documents WHERE sha256 = $1",
      [doc.sha256],
    );
    assert.equal(
      afterFirst.parsed_ok,
      false,
      "a parse note keeps the document unparsed no matter what else landed",
    );

    const second = await importBatch(
      client,
      { source: "synthetic-pull", documents: [doc] },
      NOW,
    );
    assert.equal(second.rowsInserted, 0);
    assert.equal(second.rowsDeduplicated, 4);
    assert.equal(await count(client, "transactions"), 1);
    assert.equal(await count(client, "positions"), 1);
    assert.equal(await count(client, "balances"), 1);
    assert.equal(await count(client, "liabilities"), 1);

    const afterSecond = await one(
      client,
      "SELECT parsed_ok FROM documents WHERE sha256 = $1",
      [doc.sha256],
    );
    assert.equal(afterSecond.parsed_ok, false);
  },
);

test(
  "a document declaring a position or balance with no account_id fails loudly rather than writing an orphaned row",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const doc = document("16".padEnd(64, "0"), [], {
      accountId: null,
      positions: [position()],
    });
    await assert.rejects(
      importBatch(client, { source: "synthetic-pull", documents: [doc] }, NOW),
      /positions\.account_id/,
    );
    assert.equal(await count(client, "positions"), 0);
  },
);

test(
  "two consecutive stated position snapshots for the same account and instrument support a quantity-change query (shape F1-17 needs)",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await client.query(
      "INSERT INTO instruments (id, symbol) VALUES ('inst_1', 'FKE')",
    );
    const doc1 = document("17".padEnd(64, "0"), [], {
      positions: [
        position({
          asOf: "2026-01-31",
          instrumentId: "inst_1",
          quantity: "10",
          sourceLocator: "jan",
        }),
      ],
    });
    const doc2 = document("18".padEnd(64, "0"), [], {
      positions: [
        position({
          asOf: "2026-02-28",
          instrumentId: "inst_1",
          quantity: "16",
          sourceLocator: "feb",
        }),
      ],
    });
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [doc1, doc2] },
      NOW,
    );

    // The comparison a quantity-reconciliation gate needs: two consecutive
    // stated snapshots for one account and instrument, ordered by as_of, each
    // anchored on the prior stated position rather than derived from zero.
    const snapshots = await all(
      client,
      `SELECT as_of, quantity,
            LAG(as_of) OVER (PARTITION BY account_id, instrument_id ORDER BY as_of) AS prev_as_of,
            LAG(quantity) OVER (PARTITION BY account_id, instrument_id ORDER BY as_of) AS prev_quantity
     FROM positions
     WHERE account_id = $1 AND instrument_id = $2
     ORDER BY as_of`,
      [ACCOUNT.id, "inst_1"],
    );
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].prev_as_of, null);
    assert.equal(snapshots[1].prev_as_of, "2026-01-31");
    assert.equal(snapshots[1].prev_quantity, "10");
    assert.equal(snapshots[1].quantity, "16");
  },
);

// F1-36. Before this fix, every row that did not insert -- a genuine
// duplicate and a row this importer refused alike -- was folded into one
// "skipped" count, which is what let 1602 rows an unparseable date sent to
// review get reported as 1602 *deduplicated* rows. `rowsDeduplicated` and
// `rowsRefused` split that back apart; `rowsSkipped` stays their sum for
// whatever already reads it.
test(
  "rowsDeduplicated and rowsRefused are counted separately, not folded into one honest-sounding but wrong number",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const rows = [
      row({ sourceLocator: "row:1", providerTxnId: "ptx-1" }),
      row({
        sourceLocator: "row:2",
        providerTxnId: "ptx-2",
        description: "Synthetic transit fare",
        amountText: "-3.25",
      }),
      row({ sourceLocator: "row:3", processDate: "not-a-date" }),
      row({ sourceLocator: "row:4", processDate: "also-not-a-date" }),
    ];
    const batch = {
      source: "synthetic-pull",
      documents: [document("b1".padEnd(64, "0"), rows)],
    };

    const first = await importBatch(client, batch, NOW);
    assert.equal(first.rowsInserted, 2);
    assert.equal(first.rowsDeduplicated, 0);
    assert.equal(first.rowsRefused, 2);
    assert.equal(first.rowsSkipped, 2);

    // F1-49: two rows landed, so the document is parsed_ok true even though
    // two others were sent to review -- and a second pass over the identical
    // batch is therefore the ordinary whole-document skip, not a reprocess.
    // Every row that document carried, refused ones included, counts as
    // deduplicated by that skip; the two bad rows are not refused a second
    // time because they are never looked at again.
    const second = await importBatch(client, batch, NOW);
    assert.equal(second.rowsInserted, 0);
    assert.equal(second.rowsDeduplicated, 4);
    assert.equal(second.rowsRefused, 0);
    assert.equal(second.rowsSkipped, 4);
  },
);

// F1-49. `parsed_ok` no longer means "nothing in this document was ever
// refused" -- it means something in it landed. A document that inserts some
// rows and sends others to review is exactly the case F1-36 kept
// permanently reprocessing; that reprocessing is what made rerunning a
// document with already-successful holdings unsafe, and row_hash on
// positions/balances/liabilities (below) is what makes it safe again, so
// this policy can go back to answering its own question.
test(
  "a document with one inserted row and one reviewed row is recorded as parsed (F1-49)",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const sha = "b2".padEnd(64, "0");
    const rows = [
      row({ sourceLocator: "row:1", providerTxnId: "ptx-1" }),
      row({ sourceLocator: "row:2", processDate: "not-a-date" }),
    ];

    const summary = await importBatch(
      client,
      { source: "synthetic-pull", documents: [document(sha, rows)] },
      NOW,
    );
    assert.equal(summary.rowsInserted, 1);
    assert.equal(summary.rowsRefused, 1);

    const stored = await one(
      client,
      "SELECT parsed_ok FROM documents WHERE sha256 = $1",
      [sha],
    );
    assert.equal(
      stored.parsed_ok,
      true,
      "one inserted row is enough to record the document as parsed, even " +
        "though another row in the same document was sent to review",
    );
  },
);

// F1-36. The reported bug: a document every one of whose rows was refused
// (an unparseable date format) got recorded as fully imported anyway, so a
// rerun after fixing the parser skipped the whole document -- via the
// documents.sha256/parsed_ok fast path -- and inserted nothing, forever.
// The raw bytes (and therefore sha256) never change when only the parser
// does, so nothing short of fixing parsed_ok itself could ever let this
// document back in.
test(
  "a document whose rows were all refused is not recorded as imported, and re-parsing it inserts rows once the refusal is fixed",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const sha = "c2".padEnd(64, "0");
    const badRows = [
      row({ sourceLocator: "row:1", processDate: "not-a-date" }),
      row({ sourceLocator: "row:2", processDate: "also-not-a-date" }),
    ];

    const first = await importBatch(
      client,
      { source: "synthetic-pull", documents: [document(sha, badRows)] },
      NOW,
    );
    assert.equal(first.rowsInserted, 0);
    assert.equal(first.rowsRefused, 2);

    const stored = await one(
      client,
      "SELECT parsed_ok FROM documents WHERE sha256 = $1",
      [sha],
    );
    assert.equal(
      stored.parsed_ok,
      false,
      "a document that inserted nothing must not be recorded as successfully imported",
    );

    // Same raw bytes (same sha256, exactly what an unchanged file on disk
    // produces), but the parser is now fixed: the rows it produces this time
    // have valid dates. Before this fix, the whole-document skip above would
    // have short-circuited this and inserted nothing at all.
    const fixedRows = [
      row({ sourceLocator: "row:1", providerTxnId: "ptx-1" }),
      row({
        sourceLocator: "row:2",
        providerTxnId: "ptx-2",
        description: "Synthetic transit fare",
        amountText: "-3.25",
      }),
    ];
    const second = await importBatch(
      client,
      { source: "synthetic-pull", documents: [document(sha, fixedRows)] },
      NOW,
    );
    assert.equal(second.rowsInserted, 2);
    assert.equal(await count(client, "transactions"), 2);

    const stillOneDocument = await count(
      client,
      "documents",
      "WHERE sha256 = $1",
      [sha],
    );
    assert.equal(
      stillOneDocument,
      1,
      "the retry reuses the existing document row rather than minting a second one",
    );
    const reparsed = await one(
      client,
      "SELECT parsed_ok FROM documents WHERE sha256 = $1",
      [sha],
    );
    assert.equal(reparsed.parsed_ok, true);

    // Now that every row imported cleanly, a third pass is the ordinary
    // whole-document dedup fast path again.
    const third = await importBatch(
      client,
      { source: "synthetic-pull", documents: [document(sha, fixedRows)] },
      NOW,
    );
    assert.equal(third.rowsInserted, 0);
    assert.equal(third.rowsDeduplicated, 2);
    assert.equal(await count(client, "transactions"), 2);
  },
);
