import assert from "node:assert/strict";
import test from "node:test";

import { importBatch, positionHash, rowHashV2 } from "../dist/index.js";

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
  "F1-71: different bytes carrying a provider document id already on file import as a new capture, not a second document",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    const first = document("a".repeat(64), [row()], {
      providerDocumentId: "MS-000123",
    });
    await importBatch(client, { source: "test", documents: [first] }, NOW);

    // The same statement, downloaded again and rendered afresh: every byte
    // different, so `sha256` matches nothing. Its bytes and its capture are
    // already retained in the raw tree by the time this runs (ground rule 1);
    // what the database does about it is the question here.
    const rerendered = document("b".repeat(64), [row()], {
      providerDocumentId: "MS-000123",
    });
    const summary = await importBatch(
      client,
      { source: "test", documents: [rerendered] },
      NOW,
    );

    assert.equal(summary.filesSeen, 1, "the second pull is still a file seen");
    assert.equal(summary.rowsInserted, 0);
    const documents = await all(
      client,
      "SELECT sha256, provider_document_id FROM documents",
    );
    assert.deepEqual(documents, [
      { sha256: "a".repeat(64), provider_document_id: "MS-000123" },
    ]);
    assert.equal(
      await count(client, "transactions"),
      1,
      "the rows it restates are already imported under the row the archive has",
    );

    // A different provider document is still a different document, however
    // similar its metadata.
    await importBatch(
      client,
      {
        source: "test",
        documents: [
          document("c".repeat(64), [row({ sourceLocator: "row:2" })], {
            providerDocumentId: "MS-000999",
          }),
        ],
      },
      NOW,
    );
    assert.equal(await count(client, "documents"), 2);
  },
);

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
      "changed",
      "filesSeen",
      "importRunId",
      "instrumentMatches",
      "reconciliationsFailed",
      "reconciliationsPassed",
      "reviewItemsOpened",
      "reviewItemsResolved",
      "reviewItemsUpdated",
      "rowsDeduplicated",
      "rowsInserted",
      "rowsRefused",
      "rowsSkipped",
    ]);
    // F1-76 phase 3. `instrumentMatches` is counts too: how many symbol-only
    // matches the same-institution symbol rule accepted, resolved, withdrew or
    // refused, and by which condition. No descriptor, no symbol, no id.
    assert.deepEqual(summary.instrumentMatches, {
      accepted: 0,
      resolvedByRule: 0,
      invalidated: 0,
      refused: {
        symbol_matches_several_instruments: 0,
        instrument_has_no_strong_identifier: 0,
        instrument_has_no_institution_evidence: 0,
        instrument_vouched_by_another_institution: 0,
        instrument_referenced_by_several_institutions: 0,
      },
    });
    // F1-59. `changed` is what the gates need to check only the periods this
    // import moved, and it is still not row content: opaque ids and dates
    // the summary's own verdict lines already print, never a description, an
    // amount, a locator or a hash.
    assert.deepEqual(summary.changed.cash, {
      snapshots: [],
      activity: [{ accountId: ACCOUNT.id, date: "2026-03-15" }],
    });
    // The row names no instrument, so it moves no position series at all.
    assert.deepEqual(summary.changed.positions, {
      snapshots: [],
      activity: [],
    });
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

function positionScope(overrides = {}) {
  return {
    accountId: ACCOUNT.id,
    asOf: "2026-03-31",
    proofVersion: "position_scope_v1",
    status: "complete",
    emittedPositionCount: 1,
    gapCodes: [],
    evidence: {
      account: { source: "synthetic_statement", index: 1 },
      tables: [
        {
          headers: [{ source: "synthetic_statement", index: 2 }],
          end: { source: "synthetic_statement", index: 4 },
        },
      ],
      scopeEnd: { source: "synthetic_statement", index: 5 },
    },
    ...overrides,
  };
}

function retainedHoldingDocument(sha256, overrides = {}) {
  return document(sha256, [], {
    retainedSha256: sha256,
    retainedByteLength: 512,
    mediaType: "application/pdf",
    captureId: `capture-${sha256.slice(0, 8)}`,
    ...overrides,
  });
}

test(
  "position scope proofs persist exact source semantics, replay immutably, and may reference a foreign-owned canonical row",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await client.query(
      "INSERT INTO instruments (id, symbol, name) VALUES ('scope-instrument', 'SCOP', 'Synthetic Scope Fund')",
    );
    const firstSha = "91".padEnd(64, "0");
    const secondSha = "92".padEnd(64, "0");
    const firstPosition = position({
      instrumentId: "scope-instrument",
      valuationNote: "Market Value column of the BONDS holdings table",
      sourceLocator: '{"row":{"source":"first","index":3}}',
    });
    const secondPosition = position({
      instrumentId: "scope-instrument",
      valuationNote:
        "Market Value column of the GOVERNMENT/SECURITIES holdings table",
      sourceLocator: '{"row":{"source":"second","index":7}}',
    });

    await importBatch(
      client,
      {
        source: "synthetic-scope",
        documents: [
          retainedHoldingDocument(firstSha, {
            positions: [firstPosition],
            positionScopes: [positionScope()],
          }),
        ],
      },
      NOW,
    );
    await importBatch(
      client,
      {
        source: "synthetic-scope",
        documents: [
          retainedHoldingDocument(secondSha, {
            positions: [secondPosition],
            positionScopes: [
              positionScope({
                evidence: {
                  account: { source: "synthetic_statement", index: 6 },
                  tables: [
                    {
                      headers: [{ source: "synthetic_statement", index: 7 }],
                      end: { source: "synthetic_statement", index: 9 },
                    },
                  ],
                  scopeEnd: { source: "synthetic_statement", index: 10 },
                },
              }),
            ],
          }),
        ],
      },
      NOW,
    );

    assert.equal(await count(client, "positions"), 1);
    assert.equal(await count(client, "position_scope_observations"), 2);
    assert.equal(await count(client, "position_scope_memberships"), 2);
    const canonical = await one(
      client,
      `SELECT d.sha256, p.source_locator
         FROM positions p JOIN documents d ON d.id = p.source_document_id`,
    );
    assert.equal(canonical.sha256, firstSha);
    assert.equal(canonical.source_locator, firstPosition.sourceLocator);
    assert.equal(
      (
        await one(
          client,
          "SELECT valuation_note FROM positions WHERE source_document_id = (SELECT id FROM documents WHERE sha256 = $1)",
          [firstSha],
        )
      ).valuation_note,
      firstPosition.valuationNote,
    );
    const foreignWitness = await one(
      client,
      `SELECT m.price::text AS price, m.unrealized::text AS unrealized,
              m.valuation_note, m.source_locator, o.retained_sha256,
              o.emitted_position_count::text AS emitted_position_count
         FROM position_scope_memberships m
         JOIN position_scope_observations o ON o.id = m.scope_id
         JOIN documents d ON d.id = o.source_document_id
        WHERE d.sha256 = $1`,
      [secondSha],
    );
    assert.deepEqual(foreignWitness, {
      price: "50",
      unrealized: "100",
      valuation_note: secondPosition.valuationNote,
      source_locator: secondPosition.sourceLocator,
      retained_sha256: secondSha,
      emitted_position_count: "1",
    });

    // The already-parsed replay path must compare the immutable proof and
    // leave exactly one observation/member for this document.
    await importBatch(
      client,
      {
        source: "synthetic-scope",
        documents: [
          retainedHoldingDocument(secondSha, {
            positions: [secondPosition],
            positionScopes: [
              positionScope({
                evidence: {
                  account: { source: "synthetic_statement", index: 6 },
                  tables: [
                    {
                      headers: [{ source: "synthetic_statement", index: 7 }],
                      end: { source: "synthetic_statement", index: 9 },
                    },
                  ],
                  scopeEnd: { source: "synthetic_statement", index: 10 },
                },
              }),
            ],
          }),
        ],
      },
      NOW,
    );
    assert.equal(await count(client, "position_scope_observations"), 2);

    await assert.rejects(
      importBatch(
        client,
        {
          source: "synthetic-scope",
          documents: [
            retainedHoldingDocument(secondSha, {
              positions: [secondPosition],
              positionScopes: [
                positionScope({
                  evidence: {
                    tables: [
                      {
                        headers: [
                          { source: "synthetic_statement", index: 700 },
                        ],
                        end: {
                          source: "synthetic_statement",
                          index: 701,
                        },
                      },
                    ],
                    scopeEnd: {
                      source: "synthetic_statement",
                      index: 702,
                    },
                  },
                }),
              ],
            }),
          ],
        },
        NOW,
      ),
      /changed an immutable proof payload/,
    );
    assert.equal(await count(client, "position_scope_observations"), 2);
  },
);

test(
  "complete position scope conflicts open a per-account review and exact replay resolves it without erasing audit",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await client.query(
      `INSERT INTO instruments (id, symbol, name) VALUES
         ('scope-conflict-main', 'SCM', 'Synthetic Scope Main'),
         ('scope-conflict-extra', 'SCE', 'Synthetic Scope Extra')`,
    );
    const ownerSha = "96".padEnd(64, "0");
    const witnessSha = "97".padEnd(64, "0");
    const main = position({
      instrumentId: "scope-conflict-main",
      sourceLocator: '{"row":{"source":"shared","index":3}}',
    });
    const extra = position({
      instrumentId: "scope-conflict-extra",
      sourceLocator: '{"row":{"source":"owner","index":4}}',
    });
    await importBatch(
      client,
      {
        source: "synthetic-scope-conflict",
        documents: [
          retainedHoldingDocument(ownerSha, { positions: [main, extra] }),
        ],
      },
      NOW,
    );
    const witness = retainedHoldingDocument(witnessSha, {
      positions: [main],
      positionScopes: [positionScope()],
    });
    await importBatch(
      client,
      { source: "synthetic-scope-conflict", documents: [witness] },
      NOW,
    );
    let review = await one(
      client,
      `SELECT status, account_id, resolved_at, resolution_note
         FROM review_items
        WHERE kind = 'position_scope_mismatch'
          AND raw_value = $1`,
      [`${ACCOUNT.id}:2026-03-31:position_scope_v1`],
    );
    assert.deepEqual(review, {
      status: "open",
      account_id: ACCOUNT.id,
      resolved_at: null,
      resolution_note: null,
    });

    await client.query(
      `DELETE FROM positions
        WHERE instrument_id = 'scope-conflict-extra'`,
    );
    const resolved = await importBatch(
      client,
      { source: "synthetic-scope-conflict", documents: [witness] },
      new Date("2026-09-21T12:01:00.000Z"),
    );
    assert.equal(resolved.reviewItemsResolved, 1);
    review = await one(
      client,
      `SELECT status, resolved_at IS NOT NULL AS was_resolved,
              resolution_note LIKE
                'resolved on reimport: every declared position scope validated and persisted exactly%'
                AS system_resolution
         FROM review_items
        WHERE kind = 'position_scope_mismatch'
          AND raw_value = $1`,
      [`${ACCOUNT.id}:2026-03-31:position_scope_v1`],
    );
    assert.deepEqual(review, {
      status: "resolved",
      was_resolved: true,
      system_resolution: true,
    });

    const ownerDocument = await one(
      client,
      "SELECT id FROM documents WHERE sha256 = $1",
      [ownerSha],
    );
    const extraHash = positionHash({
      accountId: ACCOUNT.id,
      instrumentId: extra.instrumentId,
      asOf: extra.asOf,
      quantity: extra.quantity,
      marketValue: extra.marketValueText,
      costBasis: extra.costBasis,
      valuationBasis: extra.valuationBasis,
      sourceLocator: extra.sourceLocator,
    });
    await client.query(
      `INSERT INTO positions
         (id, account_id, as_of, instrument_id, quantity, price, market_value,
          cost_basis, unrealized, currency, valuation_basis, valuation_note,
          source_document_id, source_locator, row_hash)
       VALUES ('scope-conflict-extra-reopened', $1, $2::date, $3, $4, $5,
               $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        ACCOUNT.id,
        extra.asOf,
        extra.instrumentId,
        extra.quantity,
        extra.price,
        extra.marketValueText,
        extra.costBasis,
        extra.unrealized,
        extra.currency,
        extra.valuationBasis,
        extra.valuationNote,
        ownerDocument.id,
        extra.sourceLocator,
        extraHash,
      ],
    );
    const reopened = await importBatch(
      client,
      { source: "synthetic-scope-conflict", documents: [witness] },
      new Date("2026-09-21T12:02:00.000Z"),
    );
    assert.equal(reopened.reviewItemsUpdated, 1);
    assert.deepEqual(
      await one(
        client,
        `SELECT status, resolved_at IS NOT NULL AS kept_resolved_at,
                resolution_note LIKE
                  'resolved on reimport: every declared position scope validated and persisted exactly%'
                  AS kept_resolution
           FROM review_items
          WHERE kind = 'position_scope_mismatch'
            AND raw_value = $1`,
        [`${ACCOUNT.id}:2026-03-31:position_scope_v1`],
      ),
      {
        status: "open",
        kept_resolved_at: true,
        kept_resolution: true,
      },
    );
  },
);

test(
  "position scope mismatch is reviewed while explicit complete zero is retained as a positive observation",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const mismatchSha = "93".padEnd(64, "0");
    const unprovedZeroSha = "95".padEnd(64, "0");
    const zeroSha = "94".padEnd(64, "0");
    const bothPositions = [
      position(),
      position({
        accountId: OTHER_ACCOUNT.id,
        sourceLocator: "holdings:other:1",
      }),
    ];
    const otherScope = (overrides = {}) =>
      positionScope({
        accountId: OTHER_ACCOUNT.id,
        evidence: {
          account: { source: "synthetic_statement", index: 20 },
          tables: [
            {
              headers: [{ source: "synthetic_statement", index: 21 }],
              end: { source: "synthetic_statement", index: 23 },
            },
          ],
          scopeEnd: { source: "synthetic_statement", index: 24 },
        },
        ...overrides,
      });

    const mismatch = await importBatch(
      client,
      {
        source: "synthetic-scope",
        documents: [
          retainedHoldingDocument(mismatchSha, {
            positions: bothPositions,
            positionScopes: [
              positionScope(),
              otherScope({ emittedPositionCount: 2 }),
            ],
          }),
        ],
      },
      NOW,
    );
    assert.equal(mismatch.reviewItemsOpened, 1);
    let mismatchReview = await one(
      client,
      `SELECT kind, account_id, raw_value, status
         FROM review_items WHERE kind = 'position_scope_mismatch'`,
    );
    assert.deepEqual(mismatchReview, {
      kind: "position_scope_mismatch",
      account_id: OTHER_ACCOUNT.id,
      raw_value: `${OTHER_ACCOUNT.id}:2026-03-31:position_scope_v1`,
      status: "open",
    });

    // Replaying only the already-valid account cannot clear or hide the
    // omitted account's mismatch on the same document/date/proof version.
    const omittedOther = await importBatch(
      client,
      {
        source: "synthetic-scope",
        documents: [
          retainedHoldingDocument(mismatchSha, {
            positions: bothPositions,
            positionScopes: [positionScope()],
          }),
        ],
      },
      NOW,
    );
    assert.equal(omittedOther.reviewItemsResolved, 0);
    assert.equal(
      (
        await one(
          client,
          `SELECT status FROM review_items
            WHERE kind = 'position_scope_mismatch'`,
        )
      ).status,
      "open",
    );

    const corrected = await importBatch(
      client,
      {
        source: "synthetic-scope",
        documents: [
          retainedHoldingDocument(mismatchSha, {
            positions: bothPositions,
            positionScopes: [positionScope(), otherScope()],
          }),
        ],
      },
      NOW,
    );
    assert.equal(corrected.reviewItemsResolved, 1);
    mismatchReview = await one(
      client,
      `SELECT status, resolution_note
         FROM review_items WHERE kind = 'position_scope_mismatch'`,
    );
    assert.equal(mismatchReview.status, "resolved");
    assert.match(
      mismatchReview.resolution_note,
      /^resolved on reimport: every declared position scope validated and persisted exactly /,
    );
    assert.equal(await count(client, "position_scope_observations"), 2);

    const regressed = await importBatch(
      client,
      {
        source: "synthetic-scope",
        documents: [
          retainedHoldingDocument(mismatchSha, {
            positions: bothPositions,
            positionScopes: [
              positionScope(),
              otherScope({ emittedPositionCount: 2 }),
            ],
          }),
        ],
      },
      NOW,
    );
    assert.equal(regressed.reviewItemsOpened, 0);
    assert.equal(regressed.reviewItemsUpdated, 1);
    mismatchReview = await one(
      client,
      `SELECT status, resolved_at IS NOT NULL AS was_resolved,
              resolution_note LIKE
                'resolved on reimport: every declared position scope validated and persisted exactly%'
                AS has_system_resolution
         FROM review_items WHERE kind = 'position_scope_mismatch'`,
    );
    assert.deepEqual(mismatchReview, {
      status: "open",
      was_resolved: true,
      has_system_resolution: true,
    });
    assert.equal(
      await count(
        client,
        "review_items",
        "WHERE kind = 'position_scope_mismatch'",
      ),
      1,
    );

    await client.query(
      `UPDATE review_items
          SET status = 'dismissed', resolved_at = now(),
              resolution_note = 'reviewer accepted the synthetic discrepancy'
        WHERE kind = 'position_scope_mismatch'`,
    );
    const dismissedReplay = await importBatch(
      client,
      {
        source: "synthetic-scope",
        documents: [
          retainedHoldingDocument(mismatchSha, {
            positions: bothPositions,
            positionScopes: [
              positionScope(),
              otherScope({ emittedPositionCount: 2 }),
            ],
          }),
        ],
      },
      NOW,
    );
    assert.equal(dismissedReplay.reviewItemsOpened, 0);
    assert.equal(dismissedReplay.reviewItemsUpdated, 0);
    assert.equal(
      (
        await one(
          client,
          `SELECT status FROM review_items
            WHERE kind = 'position_scope_mismatch'`,
        )
      ).status,
      "dismissed",
    );

    await client.query(
      `UPDATE review_items
          SET status = 'resolved', resolution_note = 'manual resolution'
        WHERE kind = 'position_scope_mismatch'`,
    );
    const manuallyResolvedReplay = await importBatch(
      client,
      {
        source: "synthetic-scope",
        documents: [
          retainedHoldingDocument(mismatchSha, {
            positions: bothPositions,
            positionScopes: [
              positionScope(),
              otherScope({ emittedPositionCount: 2 }),
            ],
          }),
        ],
      },
      NOW,
    );
    assert.equal(manuallyResolvedReplay.reviewItemsOpened, 0);
    assert.equal(manuallyResolvedReplay.reviewItemsUpdated, 0);
    assert.deepEqual(
      await one(
        client,
        `SELECT status, resolution_note FROM review_items
          WHERE kind = 'position_scope_mismatch'`,
      ),
      { status: "resolved", resolution_note: "manual resolution" },
    );

    const unprovedZero = await importBatch(
      client,
      {
        source: "synthetic-scope",
        documents: [
          retainedHoldingDocument(unprovedZeroSha, {
            positions: [],
            positionScopes: [
              positionScope({
                emittedPositionCount: 0,
                zeroBasis: "source_stated_none",
                evidence: { tables: [] },
              }),
            ],
          }),
        ],
      },
      NOW,
    );
    assert.equal(unprovedZero.reviewItemsOpened, 1);
    assert.equal(await count(client, "position_scope_observations"), 2);

    await importBatch(
      client,
      {
        source: "synthetic-scope",
        documents: [
          retainedHoldingDocument(zeroSha, {
            positions: [],
            positionScopes: [
              positionScope({
                status: "complete",
                emittedPositionCount: 0,
                zeroBasis: "source_stated_none",
                evidence: {
                  tables: [],
                  explicitNone: {
                    source: "synthetic_statement",
                    index: 11,
                  },
                  scopeEnd: { source: "synthetic_statement", index: 12 },
                },
              }),
            ],
          }),
        ],
      },
      NOW,
    );
    const zero = await one(
      client,
      `SELECT o.status, o.emitted_position_count::text AS emitted_position_count,
              o.zero_basis, d.parsed_ok
         FROM position_scope_observations o
         JOIN documents d ON d.id = o.source_document_id
        WHERE d.sha256 = $1`,
      [zeroSha],
    );
    assert.deepEqual(zero, {
      status: "complete",
      emitted_position_count: "0",
      zero_basis: "source_stated_none",
      parsed_ok: false,
    });
    assert.equal(
      Number(
        (
          await one(
            client,
            `SELECT count(*)::text AS n
               FROM position_scope_memberships m
               JOIN position_scope_observations o ON o.id = m.scope_id
               JOIN documents d ON d.id = o.source_document_id
              WHERE d.sha256 = $1`,
            [zeroSha],
          )
        ).n,
      ),
      0,
    );
  },
);

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

async function authoritativeReparse(client, doc) {
  return importBatch(
    client,
    { source: "synthetic-reparse", documents: [doc] },
    NOW,
    { authoritativeReparse: true },
  );
}

test(
  "authoritative reparse preserves an old position when its value changes or it disappears",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const original = document("a5".padEnd(64, "0"), [], {
      positions: [position({ marketValueText: "100" })],
    });
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [original] },
      NOW,
    );

    for (const positions of [[position({ marketValueText: "120" })], []]) {
      await authoritativeReparse(client, { ...original, positions });
      const rows = await all(client, "SELECT market_value FROM positions");
      assert.deepEqual(
        rows,
        [{ market_value: "100" }],
        "never publishes 100 + 120",
      );
      assert.equal(
        (
          await one(
            client,
            "SELECT parsed_ok FROM documents WHERE sha256 = $1",
            [original.sha256],
          )
        ).parsed_ok,
        false,
      );
      assert.equal(
        await count(
          client,
          "review_items",
          "WHERE kind = 'reparse_projection_mismatch'",
        ),
        1,
      );
    }
  },
);

test(
  "projection mismatches use the affected holding account and date instead of the document fallback",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const original = document("a51".padEnd(64, "0"), [], {
      positions: [
        position({ accountId: ACCOUNT.id, sourceLocator: "alpha" }),
        position({
          accountId: OTHER_ACCOUNT.id,
          asOf: "2026-02-28",
          sourceLocator: "beta",
          marketValueText: "200",
        }),
      ],
    });
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [original] },
      NOW,
    );
    const sourceDocumentId = (
      await one(client, "SELECT id FROM documents WHERE sha256 = $1", [
        original.sha256,
      ])
    ).id;
    await client.query(
      `INSERT INTO review_items
         (id, kind, account_id, source_document_id, raw_value, reason, status)
       VALUES
         ('legacy-system-holding-mismatch', 'reparse_projection_mismatch', $1,
          $2, 'positions', $3, 'open'),
         ('human-holding-mismatch', 'reparse_projection_mismatch', $1,
          $2, 'manual', 'human-authored projection concern', 'open')`,
      [
        ACCOUNT.id,
        sourceDocumentId,
        "authoritative reparse did not exactly restate this document's stored " +
          "positions projection, or matched a row owned by another document; " +
          "old rows and evidence were preserved, no reparsed holdings were " +
          "published, and the document remains partial pending a reviewed replacement",
      ],
    );

    await authoritativeReparse(client, {
      ...original,
      positions: [
        position({ accountId: ACCOUNT.id, sourceLocator: "alpha" }),
        position({
          accountId: OTHER_ACCOUNT.id,
          asOf: "2026-01-31",
          sourceLocator: "beta-changed",
          marketValueText: "220",
        }),
      ],
    });

    assert.deepEqual(
      await all(
        client,
        `SELECT account_id, projection_scope_kind,
                projection_scope_as_of::text AS projection_scope_as_of
          FROM review_items
          WHERE kind = 'reparse_projection_mismatch'
            AND projection_scope_kind IS NOT NULL
          ORDER BY projection_scope_as_of`,
      ),
      [
        {
          account_id: OTHER_ACCOUNT.id,
          projection_scope_kind: "positions",
          projection_scope_as_of: "2026-01-31",
        },
        {
          account_id: OTHER_ACCOUNT.id,
          projection_scope_kind: "positions",
          projection_scope_as_of: "2026-02-28",
        },
      ],
    );
    assert.deepEqual(
      await all(
        client,
        `SELECT id, status FROM review_items
          WHERE id IN ('legacy-system-holding-mismatch', 'human-holding-mismatch')
          ORDER BY id`,
      ),
      [
        { id: "human-holding-mismatch", status: "open" },
        { id: "legacy-system-holding-mismatch", status: "resolved" },
      ],
    );
  },
);

test(
  "activity mismatches retain their actual account and process date",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const original = document("a52".padEnd(64, "0"), [
      row({
        accountId: ACCOUNT.id,
        providerTxnId: "alpha",
        sourceLocator: "a",
      }),
      row({
        accountId: OTHER_ACCOUNT.id,
        processDate: "2026-02-20",
        providerTxnId: "beta",
        sourceLocator: "b",
        amountText: "-20",
      }),
    ]);
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [original] },
      NOW,
    );

    await authoritativeReparse(client, {
      ...original,
      rows: [
        row({
          accountId: ACCOUNT.id,
          providerTxnId: "alpha",
          sourceLocator: "a-replayed",
        }),
        row({
          accountId: OTHER_ACCOUNT.id,
          processDate: "2026-02-20",
          providerTxnId: "beta",
          sourceLocator: "b-changed",
          amountText: "-25",
        }),
      ],
    });

    assert.deepEqual(
      await all(
        client,
        `SELECT account_id, projection_scope_kind,
                projection_scope_as_of::text AS projection_scope_as_of
           FROM review_items
          WHERE kind = 'reparse_activity_projection_mismatch'`,
      ),
      [
        {
          account_id: OTHER_ACCOUNT.id,
          projection_scope_kind: "activity",
          projection_scope_as_of: "2026-02-20",
        },
      ],
    );
  },
);

test(
  "an un-attributable institution liability mismatch remains document-wide",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const liability = {
      kind: "line_of_credit",
      displayName: "Synthetic institution facility",
      balanceText: "100",
      balanceNote: null,
      currency: "USD",
      rate: null,
      asOf: "2026-03-31",
      collateralNote: null,
      sourceLocator: "liability:institution",
    };
    const original = document("a53".padEnd(64, "0"), [], {
      accountId: null,
      liabilities: [liability],
    });
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [original] },
      NOW,
    );
    await authoritativeReparse(client, {
      ...original,
      liabilities: [{ ...liability, balanceText: "120" }],
    });

    assert.deepEqual(
      await all(
        client,
        `SELECT account_id, projection_scope_kind, projection_scope_as_of
           FROM review_items
          WHERE kind = 'reparse_projection_mismatch'`,
      ),
      [
        {
          account_id: null,
          projection_scope_kind: null,
          projection_scope_as_of: null,
        },
      ],
    );
  },
);

test(
  "an importer generic mismatch reopens when a later replay loses scoped attribution",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const originalLiability = {
      accountId: OTHER_ACCOUNT.id,
      kind: "line_of_credit",
      displayName: "Synthetic attributed facility",
      balanceText: "100",
      balanceNote: null,
      currency: "USD",
      rate: null,
      asOf: "2026-02-28",
      collateralNote: null,
      sourceLocator: "liability:attributed",
    };
    const original = document("a54".padEnd(64, "0"), [], {
      accountId: null,
      positions: [
        position({
          accountId: OTHER_ACCOUNT.id,
          asOf: "2026-02-28",
          marketValueText: "200",
        }),
      ],
      liabilities: [originalLiability],
    });
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [original] },
      NOW,
    );
    const sourceDocumentId = (
      await one(client, "SELECT id FROM documents WHERE sha256 = $1", [
        original.sha256,
      ])
    ).id;
    const systemReason =
      "authoritative reparse did not exactly restate this document's stored " +
      "positions,liabilities projection, or matched a row owned by another " +
      "document; old rows and evidence were preserved, no reparsed holdings " +
      "were published, and the document remains partial pending a reviewed replacement";
    await client.query(
      `INSERT INTO review_items
         (id, kind, account_id, source_document_id, raw_value, reason, status)
       VALUES ('generic-transition', 'reparse_projection_mismatch', $1, $2,
               'positions,liabilities', $3, 'open')`,
      [ACCOUNT.id, sourceDocumentId, systemReason],
    );

    await authoritativeReparse(client, {
      ...original,
      positions: [
        position({
          accountId: OTHER_ACCOUNT.id,
          asOf: "2026-02-28",
          marketValueText: "220",
        }),
      ],
      liabilities: [{ ...originalLiability, balanceText: "120" }],
    });
    assert.equal(
      (
        await one(
          client,
          "SELECT status FROM review_items WHERE id = 'generic-transition'",
        )
      ).status,
      "resolved",
    );
    assert.equal(
      await count(
        client,
        "review_items",
        "WHERE projection_scope_kind IS NOT NULL AND status = 'open'",
      ),
      2,
    );

    await authoritativeReparse(client, {
      ...original,
      positions: [
        position({
          accountId: OTHER_ACCOUNT.id,
          asOf: "2026-02-28",
          marketValueText: "230",
        }),
      ],
      liabilities: [
        {
          ...originalLiability,
          accountId: null,
          balanceText: "130",
        },
      ],
    });
    assert.deepEqual(
      await all(
        client,
        `SELECT account_id, status, projection_scope_kind
           FROM review_items
          WHERE kind = 'reparse_projection_mismatch'
          ORDER BY projection_scope_kind NULLS FIRST`,
      ),
      [
        {
          account_id: null,
          status: "open",
          projection_scope_kind: null,
        },
        {
          account_id: OTHER_ACCOUNT.id,
          status: "resolved",
          projection_scope_kind: "liabilities",
        },
        {
          account_id: OTHER_ACCOUNT.id,
          status: "resolved",
          projection_scope_kind: "positions",
        },
      ],
    );
  },
);

test(
  "authoritative reparse rejects non-hash corrections without moving old evidence",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await client.query(
      "INSERT INTO instruments (id, symbol) VALUES ('inst_guard', 'GRD')",
    );
    const original = document("a6".padEnd(64, "0"), [], {
      positions: [
        position({
          instrumentId: "inst_guard",
          sourceLocator: "old",
          price: "10",
        }),
      ],
    });
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [original] },
      NOW,
    );
    await authoritativeReparse(client, {
      ...original,
      positions: [
        position({
          instrumentId: "inst_guard",
          sourceLocator: "new",
          price: "11",
          unrealized: "101",
          valuationNote: "Corrected synthetic note.",
        }),
      ],
    });
    assert.deepEqual(
      await all(
        client,
        "SELECT price, unrealized, valuation_note, source_locator FROM positions",
      ),
      [
        {
          price: "10",
          unrealized: "100",
          valuation_note: "Synthetic delayed market feed.",
          source_locator: "old",
        },
      ],
    );
  },
);

test(
  "an already-parsed document becomes partial from persisted outcome despite closed triage",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const original = document("aa".padEnd(64, "0"), [], {
      positions: [position()],
    });
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [original] },
      NOW,
    );
    const { id } = await one(
      client,
      "SELECT id FROM documents WHERE sha256 = $1",
      [original.sha256],
    );
    await client.query(
      `INSERT INTO review_items
         (id, kind, account_id, source_document_id, reason, status)
       VALUES ('review_closed', 'document_unparsed', $1, $2, 'old parser note', 'dismissed')`,
      [ACCOUNT.id, id],
    );

    await authoritativeReparse(client, {
      ...original,
      positions: [],
      parseNote: "synthetic parser now reports an incomplete holdings table",
      reviewItems: [
        {
          kind: "synthetic_parser_gap",
          accountId: ACCOUNT.id,
          rawValue: null,
          reason: "synthetic general review from the new parse",
        },
      ],
    });

    assert.equal(
      (await one(client, "SELECT parsed_ok FROM documents WHERE id = $1", [id]))
        .parsed_ok,
      false,
    );
    assert.equal(await count(client, "positions"), 1);
    assert.equal(
      await count(
        client,
        "review_items",
        "WHERE source_document_id = $1 AND kind = 'synthetic_parser_gap'",
        [id],
      ),
      1,
    );
    assert.equal(
      await count(
        client,
        "review_items",
        "WHERE source_document_id = $1 AND kind = 'reparse_projection_mismatch' AND status = 'open'",
        [id],
      ),
      1,
    );
  },
);

test(
  "authoritative exact replay refreshes same-source evidence and permits grounded additions",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await client.query(
      "INSERT INTO instruments (id, symbol) VALUES ('inst_repeat', 'RPT'), ('inst_new', 'NEW')",
    );
    const original = document("a7".padEnd(64, "0"), [], {
      positions: [
        position({ instrumentId: "inst_repeat", sourceLocator: "old" }),
      ],
    });
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [original] },
      NOW,
    );
    const summary = await authoritativeReparse(client, {
      ...original,
      positions: [
        position({ instrumentId: "inst_repeat", sourceLocator: "fresh" }),
        position({
          instrumentId: "inst_new",
          sourceLocator: "added",
          quantity: "2",
          marketValueText: "40",
          costBasis: "30",
          unrealized: "10",
        }),
      ],
    });
    assert.equal(summary.rowsInserted, 1);
    assert.deepEqual(
      await all(
        client,
        "SELECT instrument_id, source_locator FROM positions ORDER BY instrument_id",
      ),
      [
        { instrument_id: "inst_new", source_locator: "added" },
        { instrument_id: "inst_repeat", source_locator: "fresh" },
      ],
    );
    assert.equal(
      (
        await one(client, "SELECT parsed_ok FROM documents WHERE sha256 = $1", [
          original.sha256,
        ])
      ).parsed_ok,
      true,
    );
  },
);

test(
  "a later safe projection closes only the open mismatch and remains stable",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await client.query(
      "INSERT INTO instruments (id, symbol) VALUES ('inst_original', 'ORG'), ('inst_recovered', 'RCV')",
    );
    const original = document("ab".padEnd(64, "0"), [], {
      positions: [
        position({ instrumentId: "inst_original", marketValueText: "100" }),
      ],
    });
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [original] },
      NOW,
    );
    await authoritativeReparse(client, {
      ...original,
      positions: [
        position({ instrumentId: "inst_original", marketValueText: "120" }),
      ],
    });

    const recovered = {
      ...original,
      positions: [
        position({
          instrumentId: "inst_original",
          marketValueText: "100",
          sourceLocator: "verified",
        }),
        position({
          instrumentId: "inst_recovered",
          quantity: "2",
          marketValueText: "40",
          costBasis: "30",
          unrealized: "10",
          sourceLocator: "grounded-addition",
        }),
      ],
    };
    const first = await authoritativeReparse(client, recovered);
    assert.equal(first.rowsInserted, 1);
    assert.equal(first.reviewItemsResolved, 1);
    assert.equal(
      (
        await one(client, "SELECT parsed_ok FROM documents WHERE sha256 = $1", [
          original.sha256,
        ])
      ).parsed_ok,
      true,
    );
    assert.equal(
      await count(
        client,
        "review_items",
        "WHERE kind = 'reparse_projection_mismatch' AND status = 'open'",
      ),
      0,
    );
    assert.equal(
      await count(
        client,
        "review_items",
        "WHERE kind = 'reparse_projection_mismatch' AND status = 'resolved'",
      ),
      1,
    );

    const repeat = await authoritativeReparse(client, recovered);
    assert.equal(repeat.rowsInserted, 0);
    assert.equal(repeat.reviewItemsResolved, 0);
    assert.equal(await count(client, "positions"), 2);

    const regressed = await authoritativeReparse(client, {
      ...original,
      positions: [
        position({ instrumentId: "inst_original", marketValueText: "120" }),
      ],
    });
    assert.equal(
      regressed.reviewItemsUpdated,
      1,
      "system-resolved finding reopens",
    );
    const [reopened] = await all(
      client,
      `SELECT status, resolved_at, resolution_note FROM review_items
        WHERE kind = 'reparse_projection_mismatch'`,
    );
    assert.equal(reopened.status, "open");
    assert.ok(
      reopened.resolved_at,
      "prior recovery timestamp remains auditable",
    );
    assert.match(
      reopened.resolution_note,
      /this exact system projection mismatch no longer applies/,
    );
    const repeatedRegression = await authoritativeReparse(client, {
      ...original,
      positions: [
        position({ instrumentId: "inst_original", marketValueText: "120" }),
      ],
    });
    assert.equal(repeatedRegression.reviewItemsUpdated, 0);
    assert.equal(
      await count(
        client,
        "review_items",
        "WHERE kind = 'reparse_projection_mismatch'",
      ),
      1,
    );
  },
);

test(
  "authoritative reparse imports recovered activity before claiming completeness",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const first = row({
      description: "Synthetic first activity",
      sourceLocator: "row:1",
    });
    const recovered = row({
      description: "Synthetic recovered activity",
      amountText: "-7.25",
      sourceLocator: "row:2",
    });
    const partial = document("ae".padEnd(64, "0"), [first], {
      parseNote: "synthetic activity table was truncated",
    });
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [partial] },
      NOW,
    );

    const summary = await authoritativeReparse(client, {
      ...partial,
      rows: [first, recovered],
      providerReportedCount: 2,
      parseNote: null,
    });
    assert.equal(summary.rowsInserted, 1);
    assert.equal(await count(client, "transactions"), 2);
    assert.equal(
      (
        await one(client, "SELECT parsed_ok FROM documents WHERE sha256 = $1", [
          partial.sha256,
        ])
      ).parsed_ok,
      true,
    );
    assert.equal(
      await count(
        client,
        "review_items",
        "WHERE kind = 'document_unparsed' AND status = 'open'",
      ),
      0,
    );
  },
);

test(
  "a new provider identity cannot borrow another document's globally unique activity hash",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const shared = row({ sourceLocator: "document-a" });
    const first = document("b0".padEnd(64, "0"), [shared]);
    const second = document("b1".padEnd(64, "0"), [], {
      positions: [position()],
    });
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [first, second] },
      NOW,
    );

    await authoritativeReparse(client, {
      ...second,
      rows: [
        {
          ...shared,
          sourceLocator: "document-b",
          providerTxnId: "new-provider-identity",
        },
      ],
      providerReportedCount: 1,
    });

    assert.equal(await count(client, "transactions"), 1);
    assert.equal(
      (
        await one(client, "SELECT parsed_ok FROM documents WHERE sha256 = $1", [
          second.sha256,
        ])
      ).parsed_ok,
      false,
    );
    assert.equal(
      await count(
        client,
        "review_items",
        "WHERE kind = 'reparse_activity_projection_mismatch' AND status = 'open'",
      ),
      1,
    );
  },
);

test(
  "authoritative activity is not replayed after a holdings mismatch makes parsed_ok false",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const original = document(
      "ac".padEnd(64, "0"),
      [row({ sourceLocator: "original" })],
      {
        positions: [position({ marketValueText: "100" })],
      },
    );
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [original] },
      NOW,
    );

    const bad = {
      ...original,
      rows: [row({ sourceLocator: "reparsed" })],
      positions: [position({ marketValueText: "120" })],
    };
    await authoritativeReparse(client, bad);
    await authoritativeReparse(client, bad);
    await authoritativeReparse(client, {
      ...original,
      rows: [row({ sourceLocator: "restored" })],
    });

    assert.equal(await count(client, "transactions"), 1);
    assert.deepEqual(
      await all(client, "SELECT source_locator FROM transactions"),
      [{ source_locator: "original" }],
    );
  },
);

test(
  "authoritative projection comparison canonicalizes equivalent stored decimals",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const original = document("ad".padEnd(64, "0"), [], {
      positions: [position({ price: "10" })],
    });
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [original] },
      NOW,
    );
    await client.query("UPDATE positions SET price = '10.00'");

    const summary = await authoritativeReparse(client, original);
    assert.equal(summary.rowsInserted, 0);
    assert.equal(
      (
        await one(client, "SELECT parsed_ok FROM documents WHERE sha256 = $1", [
          original.sha256,
        ])
      ).parsed_ok,
      true,
    );
    assert.equal(
      await count(
        client,
        "review_items",
        "WHERE kind = 'reparse_projection_mismatch'",
      ),
      0,
    );
  },
);

test(
  "same holding identity with conflicting non-hash semantics fails every table closed",
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
    const originalPosition = position();
    const original = document("af".padEnd(64, "0"), [], {
      positions: [originalPosition],
      balances: [balance],
      liabilities: [liability],
    });
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [original] },
      NOW,
    );

    await authoritativeReparse(client, {
      ...original,
      positions: [originalPosition, { ...originalPosition, price: "11" }],
      balances: [balance, { ...balance, periodStartValue: "9400" }],
      liabilities: [liability, { ...liability, rate: "4.75" }],
    });

    assert.equal(await count(client, "positions"), 1);
    assert.equal(await count(client, "balances"), 1);
    assert.equal(await count(client, "liabilities"), 1);
    const reviews = await all(
      client,
      `SELECT raw_value, projection_scope_kind
         FROM review_items
        WHERE kind = 'reparse_projection_mismatch'
        ORDER BY projection_scope_kind`,
    );
    assert.deepEqual(reviews, [
      {
        raw_value: "positions,balances,liabilities",
        projection_scope_kind: "balances",
      },
      {
        raw_value: "positions,balances,liabilities",
        projection_scope_kind: "liabilities",
      },
      {
        raw_value: "positions,balances,liabilities",
        projection_scope_kind: "positions",
      },
    ]);
    assert.equal(
      (
        await one(client, "SELECT parsed_ok FROM documents WHERE sha256 = $1", [
          original.sha256,
        ])
      ).parsed_ok,
      false,
    );
  },
);

test(
  "authoritative reparse never borrows another document's hash provenance",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    await client.query(
      "INSERT INTO instruments (id, symbol) VALUES ('inst_shared', 'SHR')",
    );
    const shared = position({
      instrumentId: "inst_shared",
      sourceLocator: "first",
    });
    const first = document("a8".padEnd(64, "0"), [], { positions: [shared] });
    const second = document("a9".padEnd(64, "0"), [], {
      positions: [{ ...shared, sourceLocator: "second" }],
    });
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [first] },
      NOW,
    );
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [second] },
      NOW,
    );
    await authoritativeReparse(client, second);

    const stored = await one(
      client,
      `SELECT p.source_locator, d.sha256 AS owner_sha
         FROM positions p JOIN documents d ON d.id = p.source_document_id`,
    );
    assert.equal(stored.source_locator, "first");
    assert.equal(stored.owner_sha, first.sha256);
    assert.equal(
      (
        await one(client, "SELECT parsed_ok FROM documents WHERE sha256 = $1", [
          second.sha256,
        ])
      ).parsed_ok,
      false,
    );
    assert.equal(
      await count(
        client,
        "review_items",
        "WHERE kind = 'reparse_projection_mismatch'",
      ),
      1,
    );
  },
);

// F1-8a. The hosted archive holds 49 (account, as_of) dates with two
// `balances` rows stating different cash: a per-period statement and,
// separately, a document that bundles many periods (an incidental second
// capture of the same date, e.g. a combined historical export) each state
// their own cash for the same day, and disagree. `row_hash` includes `cash`
// (balanceHash), so the two rows never collide there and both insert; ground
// rule 5 forbids the importer or the gate from silently picking one
// (reconciliation.ts's `reconcilePeriod` already refuses to reconcile a
// contradicted period). This test is the "record both, with a note" half of
// that decision: the second document's disagreement is named in a review
// item at import time, naming the earlier document and its cash, without
// changing which rows land in `balances` or how the gate reconciles them.
test(
  "two documents stating different cash at the same account and date both insert, and the second opens a review item naming the first",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    const first = document("16".padEnd(64, "0"), [], {
      balances: [
        {
          asOf: "2026-03-31",
          totalValueText: "10000",
          totalValueNote: null,
          cash: "500",
          currency: "USD",
          periodStartValue: null,
          periodEndValue: "10000",
          sourceLocator: "holdings:balance-a",
        },
      ],
    });
    const second = document("17".padEnd(64, "0"), [], {
      balances: [
        {
          asOf: "2026-03-31",
          totalValueText: "10250",
          totalValueNote: null,
          cash: "725",
          currency: "USD",
          periodStartValue: null,
          periodEndValue: "10250",
          sourceLocator: "holdings:balance-b",
        },
      ],
    });

    await importBatch(
      client,
      { source: "synthetic-pull", documents: [first] },
      NOW,
    );
    const summary = await importBatch(
      client,
      { source: "synthetic-pull", documents: [second] },
      NOW,
    );

    assert.equal(summary.rowsInserted, 1);
    assert.equal(summary.reviewItemsOpened, 1);
    assert.equal(await count(client, "balances"), 2);

    const review = await one(
      client,
      "SELECT reason, raw_value FROM review_items WHERE kind = 'balance_cash_conflict'",
    );
    assert.match(review.reason, /disagrees with 500/);
    assert.match(review.reason, /neither is picked/);
    assert.equal(review.raw_value, "725");
  },
);

test(
  "two documents stating the same cash at the same account and date open no conflict review item",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    const first = document("18".padEnd(64, "0"), [], {
      balances: [
        {
          asOf: "2026-03-31",
          totalValueText: "10000",
          totalValueNote: null,
          cash: "500",
          currency: "USD",
          periodStartValue: null,
          periodEndValue: "10000",
          sourceLocator: "holdings:balance-a",
        },
      ],
    });
    // Same cash, different total_value: a different row_hash (so it still
    // inserts as its own row), but not a cash disagreement.
    const second = document("19".padEnd(64, "0"), [], {
      balances: [
        {
          asOf: "2026-03-31",
          totalValueText: "10001",
          totalValueNote: null,
          cash: "500",
          currency: "USD",
          periodStartValue: null,
          periodEndValue: "10001",
          sourceLocator: "holdings:balance-b",
        },
      ],
    });

    await importBatch(
      client,
      { source: "synthetic-pull", documents: [first] },
      NOW,
    );
    const summary = await importBatch(
      client,
      { source: "synthetic-pull", documents: [second] },
      NOW,
    );

    assert.equal(summary.rowsInserted, 1);
    assert.equal(summary.reviewItemsOpened, 0);
    assert.equal(await count(client, "balances"), 2);
    assert.equal(
      await count(
        client,
        "review_items",
        "WHERE kind = 'balance_cash_conflict'",
      ),
      0,
    );
  },
);

// F1-8l. A consolidated statement's household roll-up section, attributed to
// no account by the parser and then to the document's own account by the
// `?? document.accountId` fallback, made one document state two balances for
// one (account, as_of). The parser refuses that section now; this refuses the
// second row whatever produces it.
test(
  "one document stating two balances for one account and date inserts one and opens a review item",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    const both = document("1a".padEnd(64, "0"), [], {
      balances: [
        {
          asOf: "2026-03-31",
          totalValueText: "10000",
          totalValueNote: null,
          cash: "500",
          currency: "USD",
          periodStartValue: null,
          periodEndValue: "10000",
          sourceLocator: "holdings:balance-own-section",
        },
        // The roll-up: a larger total and a different cash, stated by the
        // same document for the same account and date.
        {
          asOf: "2026-03-31",
          totalValueText: "98000",
          totalValueNote: null,
          cash: "4200",
          currency: "USD",
          periodStartValue: null,
          periodEndValue: "98000",
          sourceLocator: "holdings:balance-rollup-section",
        },
      ],
    });

    const summary = await importBatch(
      client,
      { source: "synthetic-pull", documents: [both] },
      NOW,
    );

    assert.equal(summary.rowsInserted, 1);
    assert.equal(summary.rowsRefused, 1);
    assert.equal(await count(client, "balances"), 1);
    // The first one stated is what stands; the second is not inserted and the
    // first is not altered.
    const stored = await one(client, "SELECT total_value, cash FROM balances");
    assert.equal(stored.total_value, "10000");
    assert.equal(stored.cash, "500");

    const review = await one(
      client,
      "SELECT reason, raw_value FROM review_items WHERE kind = 'balance_duplicate_in_document'",
    );
    assert.match(review.reason, /already states a balance/);
    assert.match(review.reason, /contradicting itself/);
    assert.equal(review.raw_value, "98000");
  },
);

test(
  "a reparse refuses a second same-document balance even when another document owns the conflict-map entry",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const balance = (cash) => ({
      asOf: "2026-03-31",
      totalValueText: "10000",
      totalValueNote: null,
      cash,
      currency: "USD",
      periodStartValue: null,
      periodEndValue: "10000",
      sourceLocator: "holdings:balance",
    });
    const original = document("1b".padEnd(64, "0"), [], {
      parseNote: "Synthetic incomplete extraction permits a later reparse.",
      balances: [balance("500")],
    });
    const other = document("1c".padEnd(64, "0"), [], {
      balances: [balance("600")],
    });
    await importBatch(
      client,
      { source: "synthetic-pull", documents: [original, other] },
      NOW,
    );
    const own = await one(
      client,
      "SELECT id FROM documents WHERE sha256 = $1",
      [original.sha256],
    );

    // Make the formerly lossy map select the other document deterministically,
    // without relying on PostgreSQL's unspecified row order.
    const query = client.query.bind(client);
    let reordered = false;
    client.query = async (...args) => {
      const result = await query(...args);
      if (typeof args[0] === "string" && args[0].includes("FROM balances b")) {
        result.rows.sort(
          (a, b) =>
            Number(a.source_document_id !== own.id) -
            Number(b.source_document_id !== own.id),
        );
        assert.equal(result.rows.length, 2);
        assert.equal(result.rows[0].source_document_id, own.id);
        assert.notEqual(result.rows[1].source_document_id, own.id);
        reordered = true;
      }
      return result;
    };
    let result;
    try {
      result = await importBatch(
        client,
        {
          source: "synthetic-pull",
          documents: [{ ...original, balances: [balance("700")] }],
        },
        NOW,
      );
    } finally {
      client.query = query;
    }
    assert.equal(reordered, true);
    assert.equal(result.rowsInserted, 0);
    assert.equal(result.rowsRefused, 1);
    assert.equal(await count(client, "balances"), 2);
    assert.equal(
      (
        await one(
          client,
          "SELECT cash FROM balances WHERE source_document_id = $1",
          [own.id],
        )
      ).cash,
      "500",
    );
    assert.equal(
      (
        await one(
          client,
          "SELECT count(*)::int AS n FROM review_items WHERE source_document_id = $1 AND kind = 'balance_duplicate_in_document'",
          [own.id],
        )
      ).n,
      1,
    );
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
        parseNote:
          "extractor found no text for the remainder of this statement",
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

// F1-49 review fix: positionHash originally hashed only account, instrument,
// as_of, quantity, market value, cost basis and valuation basis. Two
// unrelated lines a statement could not resolve to an instrument
// (instrumentId null) are identical on every one of those fields whenever
// their stated values happen to match too, so the second silently
// deduplicated instead of inserting. positionHash now also hashes
// sourceLocator when instrumentId is null, which is unique per line within
// one document.
test(
  "two positions with no resolvable instrument, identical stated values but different locators, both insert",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);
    const summary = await importBatch(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("19".padEnd(64, "0"), [], {
            positions: [
              position({ instrumentId: null, sourceLocator: "holdings:1" }),
              position({ instrumentId: null, sourceLocator: "holdings:2" }),
            ],
          }),
        ],
      },
      NOW,
    );
    assert.equal(summary.rowsInserted, 2);
    assert.equal(summary.rowsDeduplicated, 0);
    assert.equal(await count(client, "positions"), 2);
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

// --- F1-51: round trips must not scale with rows ----------------------------
//
// The archive is hosted, so an import's cost is the number of round trips,
// not the number of rows: at a ~50-100 ms round trip, a statement carrying
// two hundred holdings spent about ninety seconds almost entirely waiting.
// Every other test in this file is the oracle for *what* the importer writes
// and is unchanged; this one is the oracle for how many messages it takes to
// write it, which is the thing a later edit can silently undo by putting one
// more lookup back inside a per-row loop.
//
// The assertion is a comparison, not a magic number: a ten-row document and a
// two-hundred-row document must cost the same number of queries. A per-row
// query would make the second cost hundreds more.

/** Counts the queries `body` issues on `client`, and restores it after. */
async function countQueries(client, body) {
  const real = client.query.bind(client);
  let queries = 0;
  client.query = (...args) => {
    queries += 1;
    return real(...args);
  };
  try {
    const result = await body();
    return { queries, result };
  } finally {
    client.query = real;
  }
}

/**
 * A statement of `n` holdings and `n` transactions, every one distinct --
 * including across two statements of different sizes, so the comparison below
 * measures batching rather than one statement deduplicating against the
 * other. `asOf` differs between the two call sites for the same reason
 * (F1-8a): the importer now checks a new balance's (account, as_of) against
 * what is already on file, and two synthetic statements sharing both the
 * account and the date would otherwise flag each other's distinct cash as a
 * cross-document conflict and open review items, which is real behavior but
 * not what this test measures.
 */
function statement(sha256, n, asOf = "2026-03-31") {
  // F1-8l: one document states one balance per account per date, so `n`
  // balances in one document need `n` dates. They walk backwards from `asOf`,
  // one day each, which keeps the two call sites' ranges disjoint as well.
  const dayBefore = (iso, days) =>
    new Date(Date.parse(`${iso}T00:00:00Z`) - days * 86_400_000)
      .toISOString()
      .slice(0, 10);
  const rows = [];
  const positions = [];
  const balances = [];
  const liabilities = [];
  for (let i = 0; i < n; i += 1) {
    const k = n * 10_000 + i;
    rows.push(
      row({
        sourceLocator: `row:${k}`,
        description: `Synthetic purchase ${k}`,
        amountText: `-${k + 1}.00`,
      }),
    );
    positions.push(
      position({ sourceLocator: `holdings:${k}`, quantity: `${k + 1}` }),
    );
    balances.push({
      asOf: dayBefore(asOf, i),
      totalValueText: `${1000 + k}`,
      totalValueNote: null,
      cash: `${k}`,
      currency: "USD",
      periodStartValue: null,
      periodEndValue: null,
      sourceLocator: `summary:${k}`,
    });
    liabilities.push({
      kind: "margin",
      displayName: `Synthetic margin ${k}`,
      balanceText: `${100 + k}`,
      balanceNote: null,
      currency: "USD",
      rate: "0.05",
      asOf: "2026-03-31",
      collateralNote: null,
      sourceLocator: `liability:${k}`,
    });
  }
  return document(sha256, rows, { positions, balances, liabilities });
}

test(
  "a document's round trips do not scale with its rows: ten holdings and two hundred cost the same number of queries",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    const small = await countQueries(client, () =>
      importBatch(
        client,
        {
          source: "synthetic-pull",
          documents: [statement("c".repeat(64), 10, "2026-03-31")],
        },
        NOW,
      ),
    );
    const large = await countQueries(client, () =>
      importBatch(
        client,
        {
          source: "synthetic-pull",
          documents: [statement("d".repeat(64), 200, "2025-12-31")],
        },
        NOW,
      ),
    );

    assert.equal(small.result.rowsInserted, 40);
    assert.equal(large.result.rowsInserted, 800);
    assert.equal(
      large.queries,
      small.queries,
      `importing 200 holdings took ${large.queries} queries where 10 took ${small.queries}; ` +
        "a lookup or an insert has gone back inside a per-row loop",
    );
    // A floor as well as a ceiling: a suspiciously small count would mean the
    // import stopped doing the work rather than stopped waiting on it.
    assert.ok(
      large.queries > 5 && large.queries < 30,
      `expected a bounded per-document round trip count, got ${large.queries}`,
    );
  },
);

// --- F1-8b: amount_base/fx_rate/amount_base_rounding ------------------------
//
// ACCOUNT's base_currency is USD (seed()). A foreign-currency row's own
// amount stays in its own currency; amount_base is what the cash gate can
// sum across accounts/periods once it is populated here at import.

test(
  "F1-8b: a stated base-currency amount is used verbatim, never rounded",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    await importBatch(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("a".repeat(64), [
            row({
              providerTxnId: "ptx-1",
              currency: "EUR",
              amountText: "-100.00",
              // The statement itself states the USD-equivalent amount.
              amountBaseText: "-108.35",
              fxRateText: "1.0835",
            }),
          ]),
        ],
      },
      NOW,
    );

    const stored = await one(
      client,
      `SELECT amount::text AS amount, currency, amount_base::text AS amount_base,
              fx_rate::text AS fx_rate, amount_base_rounding
         FROM transactions WHERE provider_txn_id = 'ptx-1'`,
    );
    assert.equal(stored.amount, "-100");
    assert.equal(stored.currency, "EUR");
    // Verbatim: not re-derived from amount * fx_rate (which would also be
    // -108.35 here, so a rate-derivation bug rounding it differently would
    // not be caught by this assertion alone; the next test exercises that).
    assert.equal(stored.amount_base, "-108.35");
    assert.equal(stored.fx_rate, "1.0835");
    assert.equal(stored.amount_base_rounding, "none");
  },
);

test(
  "F1-8b: an amount and a stated FX rate derive amount_base, rounded half_even",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    // -100 * 1.08345 = -108.345 exactly: a genuine tie at the second decimal
    // place. Round-half-up would give -108.35; half_even rounds to the even
    // neighbor, -108.34, which is the assertion below -- proof this is
    // actually half_even and not some other rule that happens to agree with
    // it on non-tied inputs.
    await importBatch(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("b".repeat(64), [
            row({
              providerTxnId: "ptx-1",
              currency: "EUR",
              amountText: "-100",
              fxRateText: "1.08345",
            }),
          ]),
        ],
      },
      NOW,
    );

    const stored = await one(
      client,
      `SELECT amount_base::text AS amount_base, fx_rate::text AS fx_rate,
              amount_base_rounding
         FROM transactions WHERE provider_txn_id = 'ptx-1'`,
    );
    assert.equal(stored.amount_base, "-108.34");
    assert.equal(stored.fx_rate, "1.08345");
    assert.equal(stored.amount_base_rounding, "half_even");
  },
);

test(
  "F1-8b: a foreign-currency row with neither a stated base amount nor a rate leaves amount_base null",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    await importBatch(
      client,
      {
        source: "synthetic-pull",
        documents: [
          document("c".repeat(64), [
            row({
              providerTxnId: "ptx-1",
              currency: "EUR",
              amountText: "-100.00",
            }),
          ]),
        ],
      },
      NOW,
    );

    const stored = await one(
      client,
      `SELECT amount_base, fx_rate, amount_base_rounding
         FROM transactions WHERE provider_txn_id = 'ptx-1'`,
    );
    assert.equal(stored.amount_base, null);
    assert.equal(stored.fx_rate, null);
    assert.equal(stored.amount_base_rounding, null);
  },
);
