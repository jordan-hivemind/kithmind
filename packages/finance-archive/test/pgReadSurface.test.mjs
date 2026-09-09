// The archive's read surface against the shared contract (F1-21).
//
// Everything here runs as the reader role against a real database, and every
// response is put back through the contract's own exchange parser, which
// checks the response against the request that produced it. A test that only
// looked at fields this file chose to assert would drift from the contract;
// running the contract's parser cannot.
//
// No test reads a row of archive data into an assertion beyond the counts and
// totals it is checking, which is the same rule the rest of this package
// follows.

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAuthorizedFinanceReadExchange,
  parseFinanceReadRequest,
} from "@repo/finance-contract";

import { archive, one, reader, skip } from "./helpers/pgArchive.mjs";
import { serveFinanceRead } from "../dist/index.js";

const SPACE = "space-synthetic-f121";
const TRUSTED = {
  principalId: "principal-synthetic-f121",
  authorizedSpaceIds: [SPACE],
};

/**
 * Four synthetic institutions, one per coverage state the surface has to keep
 * distinct, plus the two money edge cases.
 */
const SOURCES = {
  // Acquired, reconciled, nothing open. The only "complete" state.
  settled: "river-oak",
  // Acquired, one period the gate has not passed.
  unreconciled: "cedar-ridge",
  // Acquired, period passed, but a value is still under review.
  underReview: "willow-bend",
  // Accounts exist; nothing has ever been acquired for them.
  neverAcquired: "quiet-harbor",
};

let documentCounter = 0;

async function institution(client, slug, { accounts = 1 } = {}) {
  const id = `inst_${slug.replace(/-/g, "_")}`;
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, $2, $3)",
    [id, `Synthetic ${slug}`, slug],
  );
  const accountIds = [];
  for (let index = 0; index < accounts; index += 1) {
    const accountId = `acct_${slug.replace(/-/g, "_")}_${index}`;
    await client.query(
      `INSERT INTO accounts (id, institution_id, acct_last4, base_currency)
       VALUES ($1, $2, $3, 'USD')`,
      [accountId, id, `10${index}0`],
    );
    accountIds.push(accountId);
  }
  return { id, accountIds };
}

async function document(client, institutionId, accountId, docDate) {
  documentCounter += 1;
  const id = `doc_${documentCounter}`;
  await client.query(
    `INSERT INTO documents (id, institution_id, account_id, doc_type, doc_date, file_path, sha256, parsed_ok)
     VALUES ($1, $2, $3, 'statement', $4::date, $5, $6, TRUE)`,
    [
      id,
      institutionId,
      accountId,
      docDate,
      `documents/synthetic/${id}`,
      documentCounter.toString(16).padStart(64, "0"),
    ],
  );
  return id;
}

async function transaction(client, accountId, documentId, date, amount, currency = "USD") {
  documentCounter += 1;
  await client.query(
    `INSERT INTO transactions
       (id, account_id, process_date, activity_type, description, amount, currency,
        source_document_id, source_locator, row_hash, imported_at)
     VALUES ($1, $2, $3::date, 'fee', 'Synthetic fee', $4::numeric, $5, $6, $7, $8, now())`,
    [
      `txn_${documentCounter}`,
      accountId,
      date,
      amount,
      currency,
      documentId,
      JSON.stringify({ row: { source: "pdf", index: 1 } }),
      `hash_${documentCounter}`,
    ],
  );
  return `txn_${documentCounter}`;
}

async function reconciliation(client, accountId, start, end, status) {
  documentCounter += 1;
  await client.query(
    `INSERT INTO reconciliations
       (id, account_id, period_start, period_end, currency, status)
     VALUES ($1, $2, $3::date, $4::date, 'USD', $5)`,
    [`rec_${documentCounter}`, accountId, start, end, status],
  );
}

/** The whole synthetic archive the surface tests read. */
async function seed(client) {
  const settled = await institution(client, SOURCES.settled);
  const settledDoc = await document(
    client,
    settled.id,
    settled.accountIds[0],
    "2026-01-31",
  );
  const citedTransactionId = await transaction(
    client,
    settled.accountIds[0],
    settledDoc,
    "2026-01-10",
    "-12.34",
  );
  await transaction(client, settled.accountIds[0], settledDoc, "2026-01-20", "-7.66");
  // A second currency, so a cross-currency total would be visible if one
  // could ever happen.
  await transaction(client, settled.accountIds[0], settledDoc, "2026-01-21", "-5.00", "EUR");
  // A currency the contract's closed registry does not carry.
  await transaction(client, settled.accountIds[0], settledDoc, "2026-01-22", "-1.00", "XTS");
  // Past the contract's 38 significant digits: an explicit out-of-range
  // outcome, never a rounding and never a silent omission.
  await transaction(
    client,
    settled.accountIds[0],
    settledDoc,
    "2026-01-23",
    "1234567890123456789012345678901234567890",
    "JPY",
  );
  await reconciliation(client, settled.accountIds[0], "2026-01-01", "2026-01-31", "pass");

  const unreconciled = await institution(client, SOURCES.unreconciled);
  const unreconciledDoc = await document(
    client,
    unreconciled.id,
    unreconciled.accountIds[0],
    "2026-01-31",
  );
  await transaction(
    client,
    unreconciled.accountIds[0],
    unreconciledDoc,
    "2026-01-15",
    "-3.00",
  );
  await reconciliation(
    client,
    unreconciled.accountIds[0],
    "2026-01-01",
    "2026-01-31",
    "unverified",
  );

  const underReview = await institution(client, SOURCES.underReview);
  const reviewDoc = await document(
    client,
    underReview.id,
    underReview.accountIds[0],
    "2026-01-31",
  );
  await transaction(client, underReview.accountIds[0], reviewDoc, "2026-01-15", "-9.00");
  await reconciliation(
    client,
    underReview.accountIds[0],
    "2026-01-01",
    "2026-01-31",
    "pass",
  );
  await client.query(
    `INSERT INTO review_items (id, kind, account_id, source_document_id, raw_value, reason, status)
     VALUES ('review_1', 'ambiguous_amount', $1, $2, 'unreadable', 'amount could not be read', 'open')`,
    [underReview.accountIds[0], reviewDoc],
  );

  await institution(client, SOURCES.neverAcquired);
  return { settled, unreconciled, underReview, citedTransactionId };
}

async function fixture(t) {
  const owner = await archive(t);
  const seeded = await seed(owner);
  const r = await reader(t, owner);
  return { owner, reader: r, seeded };
}


/** Serves one request and checks the whole exchange against the contract. */
async function serve(r, request) {
  const parsed = parseFinanceReadRequest({
    contractVersion: 1,
    spaceId: SPACE,
    limit: 10,
    ...request,
  });
  const response = await serveFinanceRead(r.client, parsed, SPACE);
  const exchange = parseAuthorizedFinanceReadExchange({
    request: parsed,
    response,
    trustedContext: TRUSTED,
  });
  return exchange.response;
}

test("every operation answers, and answers the contract", { skip }, async (t) => {
  const { reader: r, seeded } = await fixture(t);
  const operations = [
    { operation: "list_transactions" },
    { operation: "list_holdings" },
    { operation: "list_balances" },
    { operation: "aggregate_money", metric: "transaction_amount", groupBy: "currency" },
    { operation: "get_evidence", recordId: `txn:${seeded.citedTransactionId}` },
    { operation: "get_coverage" },
  ];
  for (const request of operations) {
    const response = await serve(r, request);
    assert.equal(response.operation, request.operation);
    assert.ok(response.datasetRevision.startsWith("rev-"));
    assert.ok(["complete", "partial"].includes(response.completeness));
  }
});

test("the dataset revision is stable, and moves when the archive does", { skip }, async (t) => {
  const { owner, reader: r, seeded } = await fixture(t);
  const request = { operation: "get_coverage" };
  const first = await serve(r, request);
  const second = await serve(r, request);
  assert.equal(
    first.datasetRevision,
    second.datasetRevision,
    "two reads of an unchanged archive must report one revision, or pinning is useless",
  );

  const doc = await document(owner, seeded.settled.id, seeded.settled.accountIds[0], "2026-02-28");
  await transaction(owner, seeded.settled.accountIds[0], doc, "2026-02-10", "-1.00");
  const third = await serve(r, request);
  assert.notEqual(third.datasetRevision, first.datasetRevision);
});

test("a request for another space is not authorized", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  const parsed = parseFinanceReadRequest({
    contractVersion: 1,
    spaceId: "space-someone-else",
    limit: 10,
    operation: "get_coverage",
  });
  await assert.rejects(
    () => serveFinanceRead(r.client, parsed, SPACE),
    (error) => error.code === "not_authorized",
  );
});

test("money crosses the wire as decimal strings and never crosses currencies", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  const response = await serve(r, {
    operation: "aggregate_money",
    metric: "transaction_amount",
    groupBy: "currency",
    sourceId: SOURCES.settled,
    from: "2026-01-01",
    toExclusive: "2026-02-01",
  });

  for (const item of response.items) {
    assert.equal(typeof item.total.decimal, "string");
    assert.equal(item.total.currency, item.currency);
  }
  const byCurrency = new Map(response.items.map((item) => [item.currency, item]));
  // Two USD fees, summed exactly by the database, never by JavaScript.
  assert.equal(byCurrency.get("USD").total.decimal, "-20");
  assert.equal(byCurrency.get("USD").contributingRecordCount, 2);
  // The EUR fee stays its own total. There is no request shape that adds it
  // to the USD one: the grouping key always carries the currency.
  assert.equal(byCurrency.get("EUR").total.decimal, "-5");
  assert.equal(
    new Set(response.items.map((item) => item.currency)).size,
    response.items.length,
    "one total per currency",
  );
});

test("a currency outside the contract's registry is withheld, not coerced", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  const response = await serve(r, {
    operation: "aggregate_money",
    metric: "transaction_amount",
    groupBy: "currency",
  });
  assert.ok(
    !response.items.some((item) => item.currency === "XTS"),
    "an unregistered currency is never emitted",
  );
  assert.equal(response.completeness, "partial");
  assert.ok(response.coverage.reasons.includes("unsupported_value"));
});

test("a value past the 38 and 18 boundary is an explicit out-of-range outcome", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  const response = await serve(r, {
    operation: "aggregate_money",
    metric: "transaction_amount",
    groupBy: "currency",
    currency: "JPY",
  });
  // The only JPY row is 40 significant digits. It is not rounded into range
  // and it is not silently dropped: no total is offered and the response says
  // a value was unsupported.
  assert.equal(response.items.length, 0);
  assert.equal(response.completeness, "partial");
  assert.ok(response.coverage.reasons.includes("unsupported_value"));
});

test("a truncated page is marked truncated and carries a cursor", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  const response = await serve(r, { operation: "list_transactions", limit: 1 });
  assert.equal(response.truncated, true);
  assert.ok(response.nextCursor, "a truncated page is never silently short");
  assert.equal(response.completeness, "partial");

  const next = await serve(r, {
    operation: "list_transactions",
    limit: 1,
    cursor: response.nextCursor,
  });
  assert.equal(next.operation, "list_transactions");
});

test("a cursor this surface did not mint is an invalid request", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  await assert.rejects(
    () =>
      serve(r, {
        operation: "list_transactions",
        cursor: "AAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    (error) => error.code === "invalid_request",
  );
});

test("zero rows never claims absence", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  // A range nothing was ever acquired for. The empty result is the same empty
  // result a genuine absence would produce, so it must not read as complete.
  const response = await serve(r, {
    operation: "list_transactions",
    from: "2019-01-01",
    toExclusive: "2019-02-01",
  });
  assert.equal(response.items.length, 0);
  assert.equal(response.completeness, "partial");
  assert.notEqual(
    response.coverage.status,
    "complete",
    "an empty page may never be reported against complete coverage",
  );

  const coverage = await serve(r, {
    operation: "get_coverage",
    from: "2019-01-01",
    toExclusive: "2019-02-01",
    recordKinds: ["transaction"],
  });
  for (const item of coverage.items) {
    assert.equal(
      item.status,
      "unknown",
      "nothing vouches for 2019, so coverage there is unknown, not complete",
    );
    assert.ok(item.gaps.some((gap) => gap.code === "source_gap"));
  }
});

test("get_coverage keeps the three states apart", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  const response = await serve(r, {
    operation: "get_coverage",
    recordKinds: ["transaction"],
    from: "2026-01-01",
    toExclusive: "2026-02-01",
  });
  const bySource = new Map(response.items.map((item) => [item.sourceId, item]));

  // 1. Reconciled, nothing open.
  const settled = bySource.get(SOURCES.settled);
  assert.equal(settled.status, "complete");
  assert.deepEqual(settled.gaps, []);
  assert.equal(typeof settled.lastVerifiedAt, "number");

  // 2. An unreconciled period. Not complete, and not the same state as 3.
  const unreconciled = bySource.get(SOURCES.unreconciled);
  assert.equal(unreconciled.status, "partial");
  assert.deepEqual(
    unreconciled.gaps.map((gap) => gap.code),
    ["pending_import"],
  );

  // 3. A period that passed but still has an open review item.
  const underReview = bySource.get(SOURCES.underReview);
  assert.equal(underReview.status, "partial");
  assert.deepEqual(
    underReview.gaps.map((gap) => gap.code),
    ["failed_import"],
  );

  // 4. An account nothing was ever acquired for. Never "complete and empty".
  const neverAcquired = bySource.get(SOURCES.neverAcquired);
  assert.equal(neverAcquired.status, "unknown");
  assert.deepEqual(
    neverAcquired.gaps.map((gap) => gap.code),
    ["source_gap"],
  );

  // The three non-complete states must not have collapsed into one code.
  assert.equal(
    new Set([
      unreconciled.gaps[0].code,
      underReview.gaps[0].code,
      neverAcquired.gaps[0].code,
    ]).size,
    3,
  );
});

test("get_evidence reports why it has no citation rather than inventing one", { skip }, async (t) => {
  const { reader: r, seeded } = await fixture(t);
  // A record that exists. The archive holds a source document for it but no
  // character span, so there is no contract evidence to return, and saying so
  // is the only honest answer. See `retainedTextSpanEvidence` in pgRead.ts.
  const known = await serve(r, {
    operation: "get_evidence",
    recordId: `txn:${seeded.citedTransactionId}`,
  });
  assert.equal(known.items.length, 0);
  assert.equal(known.completeness, "partial");
  assert.ok(known.coverage.reasons.includes("retained_evidence_unavailable"));

  // An id the archive has never heard of is a different answer: a gap, not a
  // citation-free row.
  const unknown = await serve(r, {
    operation: "get_evidence",
    recordId: "txn:not-a-record",
  });
  assert.equal(unknown.items.length, 0);
  assert.ok(unknown.coverage.reasons.includes("source_gap"));
  assert.equal(unknown.coverage.status, "unknown");
});

test("list operations withhold rows they cannot cite, and say so", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  for (const operation of [
    "list_transactions",
    "list_holdings",
    "list_balances",
  ]) {
    const response = await serve(r, { operation });
    assert.equal(response.completeness, "partial", operation);
    // list_holdings and list_balances have no seeded rows, so only
    // list_transactions can prove the withholding is reported rather than
    // being indistinguishable from an empty table.
    if (operation === "list_transactions") {
      assert.ok(
        response.coverage.reasons.includes("retained_evidence_unavailable"),
        "a withheld row is reported, never silently dropped",
      );
    }
  }
});

test("the surface reads through the reader role, not the owner", { skip }, async (t) => {
  const { reader: r } = await fixture(t);
  const who = await one(r.client, "SELECT current_user AS name");
  assert.equal(who.name, r.summary.role);
  // And the read it just did is still a read: the reader cannot write.
  await assert.rejects(() => r.client.query("DELETE FROM transactions"));
});

test("a holdings aggregate sums the latest snapshot, not every snapshot", { skip }, async (t) => {
  const owner = await archive(t);
  const seeded = await seed(owner);
  const account = seeded.settled.accountIds[0];
  const doc = await document(owner, seeded.settled.id, account, "2026-02-28");
  // Two statements, two stated cash balances for the same account. Summing
  // both would count the same money twice and produce a plausible wrong
  // number, which is the failure mode that matters here.
  await owner.query(
    `INSERT INTO balances (id, account_id, as_of, total_value, cash, currency, source_document_id)
     VALUES ('bal_jan', $1, DATE '2026-01-31', '100.00', '40.00', 'USD', $2),
            ('bal_feb', $1, DATE '2026-02-28', '120.00', '55.00', 'USD', $2)`,
    [account, doc],
  );
  const r = await reader(t, owner);
  const response = await serve(r, {
    operation: "aggregate_money",
    metric: "cash",
    groupBy: "account_currency",
    accountId: account,
  });
  assert.equal(response.items.length, 1);
  assert.equal(response.items[0].total.decimal, "55");
  assert.equal(response.items[0].contributingRecordCount, 1);
  assert.equal(response.items[0].accountId, account);
});

test("an aggregate over more contributors than the contract carries offers a breakdown", { skip }, async (t) => {
  const owner = await archive(t);
  const seeded = await seed(owner);
  const doc = await document(owner, seeded.settled.id, seeded.settled.accountIds[0], "2026-03-31");
  // The contract carries at most 25 contributor ids inline; past that it
  // requires a breakdown reference rather than a shortened list presented as
  // the whole one.
  for (let index = 0; index < 30; index += 1) {
    await transaction(owner, seeded.settled.accountIds[0], doc, "2026-03-10", "-1.00", "CAD");
  }
  const r = await reader(t, owner);
  const response = await serve(r, {
    operation: "aggregate_money",
    metric: "transaction_amount",
    groupBy: "currency",
    currency: "CAD",
  });
  assert.equal(response.items.length, 1);
  const item = response.items[0];
  assert.equal(item.contributingRecordCount, 30);
  assert.equal(item.contributorRecordIds.length, 25);
  assert.ok(item.breakdown, "a shortened contributor list must carry a breakdown");
  assert.equal(item.total.decimal, "-30");
});
