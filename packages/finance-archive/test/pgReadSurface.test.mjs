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
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseAuthorizedFinanceReadExchange,
  parseFinanceReadRequest,
} from "@repo/finance-contract";

import { archive, count, one, reader, skip } from "./helpers/pgArchive.mjs";
import {
  adapterPullToImportDocuments,
  createArchivePool,
  createSyntheticSession,
  importBatch,
  persistAcquiredDocument,
  resolveRawTreeRoot,
  serveFinanceRead,
  syntheticAdapter,
} from "../dist/index.js";

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

/** The opaque source identity the read surface emits and filters on
 * (F1-34): `institutions.id`, never the slug. */
function sourceIdOf(slug) {
  return `inst_${slug.replace(/-/g, "_")}`;
}

let documentCounter = 0;

async function institution(client, slug, { accounts = 1 } = {}) {
  const id = sourceIdOf(slug);
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

test(
  "a read served through a pooled connection resolves the archive schema even when the connection's session search_path was reset to public (F1-52)",
  { skip },
  async (t) => {
    const { reader: r } = await fixture(t);
    const pool = createArchivePool(r.url, r.summary.schema);
    t.after(() => pool.end());
    const poolClient = await pool.connect();
    try {
      // What a pooler can hand back for any given checkout: a backend whose
      // ambient search_path is not the archive's. `serveFinanceRead` must
      // still resolve archive tables through its own `SET LOCAL`, not
      // through anything set on the session.
      await poolClient.query("SET search_path TO public");
      const parsed = parseFinanceReadRequest({
        contractVersion: 1,
        spaceId: SPACE,
        limit: 10,
        operation: "get_coverage",
      });
      const response = await serveFinanceRead(poolClient, parsed, SPACE);
      const settledSource = response.items.find(
        (item) => item.sourceId === sourceIdOf(SOURCES.settled),
      );
      assert.ok(
        settledSource,
        "expected the seeded institution to be visible through the pooled " +
          "connection; a missing source here means the read landed against " +
          "public rather than the archive schema",
      );
    } finally {
      poolClient.release();
    }
  },
);

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
    sourceId: sourceIdOf(SOURCES.settled),
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
  const settled = bySource.get(sourceIdOf(SOURCES.settled));
  assert.equal(settled.status, "complete");
  assert.deepEqual(settled.gaps, []);
  assert.equal(typeof settled.lastVerifiedAt, "number");

  // 2. An unreconciled period. Not complete, and not the same state as 3.
  const unreconciled = bySource.get(sourceIdOf(SOURCES.unreconciled));
  assert.equal(unreconciled.status, "partial");
  assert.deepEqual(
    unreconciled.gaps.map((gap) => gap.code),
    ["pending_import"],
  );

  // 3. A period that passed but still has an open review item.
  const underReview = bySource.get(sourceIdOf(SOURCES.underReview));
  assert.equal(underReview.status, "partial");
  assert.deepEqual(
    underReview.gaps.map((gap) => gap.code),
    ["failed_import"],
  );

  // 4. An account nothing was ever acquired for. Never "complete and empty".
  const neverAcquired = bySource.get(sourceIdOf(SOURCES.neverAcquired));
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

// --- F1-29: structured field evidence ---------------------------------------
//
// The tests above read a hand-seeded archive, which is the right shape for
// coverage states and money edge cases and the wrong one for citations: a
// citation is only worth anything if it resolves in bytes some adapter
// actually retained. So these run the real composition -- the synthetic
// adapter acquires, `persistAcquiredDocument` writes the retained bytes to a
// throwaway raw tree, the importer lands the rows -- and then check every
// returned citation twice: once against the response, and once against the
// bytes on disk with no access to the archive database at all, which is
// exactly what a consumer of the contract has.

const ADAPTER = {
  institution: {
    id: "inst_thistlebrook",
    name: "Thistlebrook Trust (synthetic)",
    slug: "thistlebrook-trust",
  },
  // Two accounts, because the tabular export restates the same activity the
  // structured API served: imported against one account the second tier
  // deduplicates away by row hash, which is the importer working correctly
  // and would leave this test with only one tier to check.
  accounts: [
    { id: "acct_synthetic", last4: "0142" },
    { id: "acct_synthetic_export", last4: "0143" },
  ],
  spaceId: "space_synthetic_f129",
};

/** The media type each capability tier declares for what it retained. */
const JSON_TIER = "application/json";
const TABULAR_TIER = "text/csv; charset=utf-8";
const PDF_TIER = "text/plain; charset=utf-8";

/**
 * Every synthetic tier acquired, persisted and imported into one archive.
 * Returns the owner client plus the retained bytes' paths on disk, keyed by
 * the same content hash a citation carries.
 */
async function importedPull(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-read-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const rawTreeRoot = resolveRawTreeRoot({
    FINANCE_ARCHIVE_RAW_TREE_ROOT: join(directory, "raw"),
    FINANCE_ARCHIVE_SPACE_ID: ADAPTER.spaceId,
  });

  const client = await archive(t);
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, $2, $3)",
    [ADAPTER.institution.id, ADAPTER.institution.name, ADAPTER.institution.slug],
  );
  for (const account of ADAPTER.accounts) {
    await client.query(
      `INSERT INTO accounts (id, institution_id, acct_last4, base_currency)
       VALUES ($1, $2, $3, 'USD')`,
      [account.id, ADAPTER.institution.id, account.last4],
    );
  }

  const session = createSyntheticSession();
  const retainedPaths = new Map();
  async function pull(selection, docType, docDate, accountId = ADAPTER.accounts[0].id) {
    const acquired = await syntheticAdapter.acquire({ session, ...selection });
    const { activity: rows, holdings } = await syntheticAdapter.parse({
      kind: selection.kind,
      bytes: acquired.bytes,
    });
    // F1-33: persistAcquiredDocument opens no database; institution slug and
    // account last4 are the same plain fixture values seeded into Postgres
    // above, not read back from a SQLite provenance file.
    const persisted = persistAcquiredDocument(rawTreeRoot, {
      institutionId: ADAPTER.institution.id,
      accountId,
      institutionSlug: ADAPTER.institution.slug,
      accountLast4:
        ADAPTER.accounts.find((account) => account.id === accountId)?.last4 ?? null,
      docType,
      acquired,
    });
    retainedPaths.set(
      persisted.documentWrite.sha256,
      persisted.documentWrite.path,
    );
    const documents = await adapterPullToImportDocuments(client, {
      institutionId: ADAPTER.institution.id,
      accountId,
      acquired,
      rows,
      holdings,
      docType,
      docDate,
      persisted,
    });
    await importBatch(
      client,
      { source: ADAPTER.institution.slug, documents },
      new Date("2025-05-01"),
    );
  }

  await pull(
    {
      kind: "structured_api",
      periodStart: "2025-01-01",
      periodEnd: "2025-04-01",
    },
    "activity_pull",
    null,
  );
  await pull(
    {
      kind: "tabular_export",
      periodStart: "2025-01-01",
      periodEnd: "2025-04-01",
    },
    "tabular_export",
    "2025-04-01",
    ADAPTER.accounts[1].id,
  );
  const { documents: discovered } = await syntheticAdapter.discover(session);
  const statement = discovered.items.find(
    (doc) => doc.kind === "pdf_statement",
  );
  await pull(
    { kind: "pdf_statement", externalId: statement.externalId },
    "pdf_statement",
    statement.periodEnd,
  );

  // A verdict spanning everything the pull landed, so these responses report
  // the state this suite is about -- rows withheld for want of a citation --
  // rather than the unrelated "nothing vouches for this range" an
  // unreconciled archive is always in.
  const period = `least((SELECT min(process_date) FROM transactions),
                        (SELECT min(as_of) FROM positions),
                        (SELECT min(as_of) FROM balances)),
                  greatest((SELECT max(process_date) FROM transactions),
                           (SELECT max(as_of) FROM positions),
                           (SELECT max(as_of) FROM balances))`;
  for (const account of ADAPTER.accounts) {
    await client.query(
      `INSERT INTO reconciliations
         (id, account_id, period_start, period_end, currency, status)
       SELECT $2, $1, ${period}, 'USD', 'pass'`,
      [account.id, `rec_${account.id}`],
    );
    await client.query(
      `INSERT INTO position_reconciliations
         (id, account_id, instrument_id, period_start, period_end, status)
       SELECT $2, $1, (SELECT id FROM instruments ORDER BY id LIMIT 1),
              ${period}, 'pass'`,
      [account.id, `posrec_${account.id}`],
    );
  }
  return { client, retainedPaths };
}

/** The retained bytes a citation names, checked against the citation's own
 * hash and byte length before anything is read out of them. */
function retainedBytesFor(retainedPaths, sourceObject) {
  const path = retainedPaths.get(sourceObject.retainedSha256);
  assert.ok(path, "a citation names retained bytes this pull actually wrote");
  const bytes = readFileSync(path);
  assert.equal(bytes.byteLength, sourceObject.retainedByteLength);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    sourceObject.retainedSha256,
  );
  return bytes;
}

/** An RFC 6901 pointer resolved against retained JSON, returning the target's
 * exact source token -- what `json_pointer_v1` binds -- rather than a decoded
 * value re-serialized back into one. */
function resolveJsonPointer(bytes, pointer) {
  const parsed = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    (_key, value, context) =>
      context?.source === undefined ? value : context.source,
  );
  let node = parsed;
  for (const escaped of pointer.slice(1).split("/")) {
    const segment = escaped.replaceAll("~1", "/").replaceAll("~0", "~");
    node = node[Array.isArray(node) ? Number(segment) : segment];
  }
  return node;
}

/** `delimited_row_v1` resolved against retained bytes: split, drop the
 * header, index the physical data record, index the field. */
function resolveDelimitedField(bytes, locator) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const records = text.split(locator.recordSeparator === "lf" ? "\n" : "\r\n");
  // One trailing record separator at end of file does not create a record.
  if (records.at(-1) === "") records.pop();
  const record = records.slice(locator.headerRows)[locator.rowIndex];
  assert.ok(record !== undefined, "the cited row exists in the retained bytes");
  if (locator.headerRows === 1) {
    assert.equal(
      records[0].split(locator.delimiter)[locator.columnIndex],
      locator.columnName,
      "the cited column is the one the header names",
    );
  }
  return record.split(locator.delimiter)[locator.columnIndex];
}

/** Every check a consumer can run with the retained bytes and nothing else. */
function assertCitationResolves(retainedPaths, item) {
  assert.equal(item.kind, "structured_field_v1");
  assert.equal(
    createHash("sha256").update(item.locator.rawValue, "utf8").digest("hex"),
    item.locator.rawValueSha256,
  );
  const bytes = retainedBytesFor(retainedPaths, item.sourceObject);
  const resolved =
    item.locator.format === "json_pointer_v1"
      ? resolveJsonPointer(bytes, item.locator.pointer)
      : resolveDelimitedField(bytes, item.locator);
  assert.equal(
    resolved,
    item.locator.rawValue,
    "the cited datum must be the one actually at that position",
  );
}

test("a cited record resolves in the retained bytes it names", { skip }, async (t) => {
  const { client, retainedPaths } = await importedPull(t);
  const r = await reader(t, client);
  const response = await serve(r, { operation: "list_transactions", limit: 100 });

  // Exactly the rows whose tier can bind a datum, cited once each.
  const citable = await count(
    client,
    "transactions t JOIN documents d ON d.id = t.source_document_id",
    "WHERE d.media_type = ANY($1)",
    [[JSON_TIER, TABULAR_TIER]],
  );
  assert.ok(citable > 0, "the fixture still has citable rows");
  assert.equal(response.items.length, citable);

  const formats = new Set();
  for (const item of response.items) {
    assert.equal(item.evidence.length, 1);
    const [evidence] = item.evidence;
    assert.equal(evidence.evidenceId, `ev:${item.recordId}:amount`);
    assert.equal(
    evidence.sourceObject.sourceId,
    ADAPTER.institution.id,
    "the cited source identity is the opaque institution id, not the slug (F1-34)",
  );
    assert.equal(
      evidence.sourceObject.revisionId,
      `sha256-${evidence.sourceObject.retainedSha256}`,
    );
    assertCitationResolves(retainedPaths, evidence);
    formats.add(evidence.locator.format);
  }
  assert.deepEqual(
    [...formats].sort(),
    ["delimited_row_v1", "json_pointer_v1"],
    "both bindable tiers are represented",
  );
  assert.ok(
    !response.items.some(
      (item) => item.evidence[0].sourceObject.mediaType === PDF_TIER,
    ),
    "the PDF tier binds nothing, so it is never cited",
  );
  assert.equal(response.completeness, "partial");
  assert.ok(response.coverage.reasons.includes("retained_evidence_unavailable"));

  // `get_evidence` for a returned record answers with that same item.
  const [first] = response.items;
  const evidence = await serve(r, {
    operation: "get_evidence",
    recordId: first.recordId,
  });
  assert.deepEqual(evidence.items, first.evidence);
});

test("PDF-tier holdings and balances stay withheld", { skip }, async (t) => {
  const { client } = await importedPull(t);
  const r = await reader(t, client);
  for (const operation of ["list_holdings", "list_balances"]) {
    const table = operation === "list_holdings" ? "positions" : "balances";
    assert.ok(
      (await count(client, table)) > 0,
      `${table} has rows, so an empty page here is a withholding, not an empty table`,
    );
    const response = await serve(r, { operation, limit: 100 });
    assert.equal(response.items.length, 0, operation);
    assert.equal(response.completeness, "partial", operation);
    assert.equal(response.coverage.status, "partial", operation);
    assert.ok(
      response.coverage.reasons.includes("retained_evidence_unavailable"),
      operation,
    );
  }
});

test("a document whose retained bytes were never recorded cites nothing", { skip }, async (t) => {
  const { client } = await importedPull(t);
  const r = await reader(t, client);
  const before = await serve(r, { operation: "list_transactions", limit: 100 });
  // What a document imported before F1-29 looks like: four nulls, all or
  // nothing, which is what the `documents` CHECK enforces.
  await client.query(
    `UPDATE documents
        SET retained_sha256 = NULL, retained_byte_length = NULL,
            media_type = NULL, capture_id = NULL
      WHERE media_type = $1`,
    [TABULAR_TIER],
  );
  const after = await serve(r, { operation: "list_transactions", limit: 100 });
  assert.ok(after.items.length < before.items.length);
  assert.ok(
    after.items.every(
      (item) => item.evidence[0].sourceObject.mediaType === JSON_TIER,
    ),
    "a row whose document names no bytes is withheld, never cited to nothing",
  );
  assert.ok(after.coverage.reasons.includes("retained_evidence_unavailable"));
});

test("a binding that disagrees with the stored amount withholds its row", { skip }, async (t) => {
  const { client } = await importedPull(t);
  const r = await reader(t, client);
  const before = await serve(r, { operation: "list_transactions", limit: 100 });
  const [target] = before.items;
  // The stored value moves and the binding does not. The citation would still
  // resolve in the retained bytes; it would just cite a different number than
  // the row asserts, which is the wrong-bytes failure the cross-check exists
  // to catch.
  await client.query(
    "UPDATE transactions SET amount = amount + 1 WHERE id = $1",
    [target.recordId.slice("txn:".length)],
  );
  const after = await serve(r, { operation: "list_transactions", limit: 100 });
  assert.equal(after.items.length, before.items.length - 1);
  assert.ok(!after.items.some((item) => item.recordId === target.recordId));
  assert.ok(after.coverage.reasons.includes("retained_evidence_unavailable"));
});

/**
 * Rewrites one transaction's `source_locator`, keeping the binding the
 * adapter actually recorded so the bound token still agrees with the stored
 * amount. Hand-built because no adapter binds two fields yet, and the
 * selection rule has to hold before one does.
 */
async function rebind(client, recordId, locatorsFor) {
  const id = recordId.slice("txn:".length);
  const stored = await one(
    client,
    "SELECT source_locator FROM transactions WHERE id = $1",
    [id],
  );
  const binding = Object.values(JSON.parse(stored.source_locator))
    .map((locator) => locator?.binding)
    .find((candidate) => candidate);
  assert.ok(binding, "the row this test rewrites really is bound");
  await client.query(
    "UPDATE transactions SET source_locator = $2 WHERE id = $1",
    [id, JSON.stringify(locatorsFor(binding))],
  );
  return binding;
}

/** One bound transaction from a tier whose locator carries a pointer. */
async function boundTransaction(t) {
  const { client } = await importedPull(t);
  const r = await reader(t, client);
  const before = await serve(r, { operation: "list_transactions", limit: 100 });
  const target = before.items.find(
    (item) => item.evidence[0].locator.format === "json_pointer_v1",
  );
  assert.ok(target, "the fixture still returns a JSON-tier row");
  return { client, reader: r, before, target };
}

test("two bindings on one record are told apart by name, not by key order", { skip }, async (t) => {
  const { client, reader: r, target } = await boundTransaction(t);
  const cited = target.evidence[0].locator.pointer;
  // Two bound locators whose rawValues are identical -- a price that happens
  // to equal the amount -- so the decimal cross-check cannot separate them,
  // with the wrong one first in key order.
  await rebind(client, target.recordId, (binding) => ({
    price: {
      source: "structured_api",
      index: 0,
      field: "price",
      binding: { ...binding, pointer: cited.replace(/amount$/, "price") },
    },
    amount: { source: "structured_api", index: 0, field: "amount", binding },
  }));

  const after = await serve(r, { operation: "list_transactions", limit: 100 });
  const item = after.items.find((row) => row.recordId === target.recordId);
  assert.ok(item, "a record whose amount is bound is still citable");
  assert.equal(
    item.evidence[0].locator.pointer,
    cited,
    "the binding named for the load-bearing field is the cited one",
  );
});

test("several bindings and none for the money field withholds the row", { skip }, async (t) => {
  const { client, reader: r, before, target } = await boundTransaction(t);
  const cited = target.evidence[0].locator.pointer;
  // Neither key names the record's load-bearing field, so which binding the
  // amount belongs to is not stated anywhere. Withheld beats guessing.
  await rebind(client, target.recordId, (binding) => ({
    row: { source: "structured_api", index: 0, binding },
    quantity: {
      source: "structured_api",
      index: 0,
      field: "quantity",
      binding: { ...binding, pointer: cited.replace(/amount$/, "quantity") },
    },
  }));

  const after = await serve(r, { operation: "list_transactions", limit: 100 });
  assert.equal(after.items.length, before.items.length - 1);
  assert.ok(!after.items.some((row) => row.recordId === target.recordId));
  assert.ok(after.coverage.reasons.includes("retained_evidence_unavailable"));
});
