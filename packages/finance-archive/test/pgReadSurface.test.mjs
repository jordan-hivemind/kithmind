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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  canonicalizeFinanceDecimal,
  FINANCE_READ_REQUEST_DESCRIPTION,
  parseAuthorizedFinanceReadExchange,
  parseFinanceReadRequest,
} from "@repo/finance-contract";

import { archive, count, one, reader, skip } from "./helpers/pgArchive.mjs";
import {
  adapterPullToImportDocuments,
  createArchivePool,
  createSyntheticSession,
  fromNumericText,
  importBatch,
  persistAcquiredDocument,
  retainPayload,
  resolveRawTreeRoot,
  serveFinanceRead,
  storeRetainedText,
  syntheticAdapter,
  textRelativePath,
  writeRetainedText,
} from "../dist/index.js";
import { createFinanceArchiveMcpServer } from "../dist/mcp/server.js";

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

async function transaction(
  client,
  accountId,
  documentId,
  date,
  amount,
  currency = "USD",
) {
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

function structuredBindings(values) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(values).map(([field, value]) => [
        field,
        {
          binding: {
            format: "json_pointer_v1",
            pointer: `/synthetic/${field}`,
            rawValue: String(value),
          },
        },
      ]),
    ),
  );
}

async function makeDocumentCitable(client, documentId) {
  const retainedSha256 = createHash("sha256")
    .update(`synthetic retained ${documentId}`)
    .digest("hex");
  await client.query(
    `UPDATE documents
        SET retained_sha256 = $2, retained_byte_length = 128,
            media_type = 'application/json', capture_id = $3
      WHERE id = $1`,
    [documentId, retainedSha256, `capture-${documentId}`],
  );
}

async function citedSnapshot(client, seeded, asOf = "2026-02-28") {
  const accountId = seeded.settled.accountIds[0];
  const documentId = await document(client, seeded.settled.id, accountId, asOf);
  await makeDocumentCitable(client, documentId);
  await client.query(
    `INSERT INTO instruments (id, symbol, name) VALUES
       ('instrument-usd', 'SUSD', 'Synthetic USD Fund'),
       ('instrument-usd-2', 'SUS2', 'Synthetic USD Bond'),
       ('instrument-eur', 'SEUR', 'Synthetic EUR Fund')`,
  );
  const positions = [
    ["cited-usd", "instrument-usd", "2", "60", "120", "100", null, "USD"],
    ["cited-usd-2", "instrument-usd-2", "4", "20", "80", "70", null, "USD"],
    ["cited-eur", "instrument-eur", "3", "50", "150", "135", "14", "EUR"],
  ];
  for (const [
    id,
    instrumentId,
    quantity,
    price,
    marketValue,
    costBasis,
    unrealized,
    currency,
  ] of positions) {
    await client.query(
      `INSERT INTO positions
         (id, account_id, as_of, instrument_id, quantity, price, market_value,
          cost_basis, unrealized, currency, valuation_basis,
          source_document_id, source_locator)
       VALUES ($1, $2, $3::date, $4, $5::numeric, $6::numeric, $7::numeric,
               $8::numeric, $9::numeric, $10, 'market_price', $11, $12)`,
      [
        id,
        accountId,
        asOf,
        instrumentId,
        quantity,
        price,
        marketValue,
        costBasis,
        unrealized,
        currency,
        documentId,
        structuredBindings({
          quantity,
          price,
          marketValue,
          costBasis,
          ...(unrealized === null ? {} : { unrealized }),
        }),
      ],
    );
  }
  for (const [id, totalValue, currency] of [
    ["balance-usd", "205", "USD"],
    ["balance-eur", "150", "EUR"],
  ]) {
    await client.query(
      `INSERT INTO balances
         (id, account_id, as_of, total_value, currency,
          source_document_id, source_locator)
       VALUES ($1, $2, $3::date, $4::numeric, $5, $6, $7)`,
      [
        id,
        accountId,
        asOf,
        totalValue,
        currency,
        documentId,
        structuredBindings({ totalValue }),
      ],
    );
  }
  return { accountId, documentId, asOf };
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
  await transaction(
    client,
    settled.accountIds[0],
    settledDoc,
    "2026-01-20",
    "-7.66",
  );
  // A second currency, so a cross-currency total would be visible if one
  // could ever happen.
  await transaction(
    client,
    settled.accountIds[0],
    settledDoc,
    "2026-01-21",
    "-5.00",
    "EUR",
  );
  // A currency the contract's closed registry does not carry.
  await transaction(
    client,
    settled.accountIds[0],
    settledDoc,
    "2026-01-22",
    "-1.00",
    "XTS",
  );
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
  await reconciliation(
    client,
    settled.accountIds[0],
    "2026-01-01",
    "2026-01-31",
    "pass",
  );

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
  await transaction(
    client,
    underReview.accountIds[0],
    reviewDoc,
    "2026-01-15",
    "-9.00",
  );
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
async function serve(r, request, options) {
  const parsed = parseFinanceReadRequest({
    contractVersion: 1,
    spaceId: SPACE,
    limit: 10,
    ...request,
  });
  const response = await serveFinanceRead(r.client, parsed, SPACE, {
    principalId: TRUSTED.principalId,
    cursorSigningSecret: "synthetic-finance-cursor-secret-at-least-32-bytes",
    ...options,
  });
  const exchange = parseAuthorizedFinanceReadExchange({
    request: parsed,
    response,
    trustedContext: TRUSTED,
  });
  return exchange.response;
}

test(
  "every operation answers, and answers the contract",
  { skip },
  async (t) => {
    const { reader: r, seeded } = await fixture(t);
    const operations = [
      { operation: "list_transactions" },
      { operation: "list_holdings" },
      { operation: "list_balances" },
      {
        operation: "aggregate_money",
        metric: "transaction_amount",
        groupBy: "currency",
      },
      {
        operation: "get_evidence",
        recordId: `txn:${seeded.citedTransactionId}`,
      },
      { operation: "get_coverage" },
    ];
    for (const request of operations) {
      const response = await serve(r, request);
      assert.equal(response.operation, request.operation);
      assert.ok(response.datasetRevision.startsWith("rev-"));
      assert.ok(["complete", "partial"].includes(response.completeness));
    }
  },
);

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
      const response = await serveFinanceRead(poolClient, parsed, SPACE, {
        principalId: TRUSTED.principalId,
        cursorSigningSecret:
          "synthetic-finance-cursor-secret-at-least-32-bytes",
      });
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

test(
  "the dataset revision is stable, and moves when the archive does",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const request = { operation: "get_coverage" };
    const first = await serve(r, request);
    const second = await serve(r, request);
    assert.equal(
      first.datasetRevision,
      second.datasetRevision,
      "two reads of an unchanged archive must report one revision, or pinning is useless",
    );

    const doc = await document(
      owner,
      seeded.settled.id,
      seeded.settled.accountIds[0],
      "2026-02-28",
    );
    await transaction(
      owner,
      seeded.settled.accountIds[0],
      doc,
      "2026-02-10",
      "-1.00",
    );
    const third = await serve(r, request);
    assert.notEqual(third.datasetRevision, first.datasetRevision);
    await owner.query(
      "UPDATE accounts SET display_name = 'Changed synthetic label' WHERE id = $1",
      [seeded.settled.accountIds[0]],
    );
    const fourth = await serve(r, request);
    assert.notEqual(
      fourth.datasetRevision,
      third.datasetRevision,
      "a same-id content update must invalidate a continuation revision",
    );
  },
);

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

test(
  "money crosses the wire as decimal strings and never crosses currencies",
  { skip },
  async (t) => {
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
    const byCurrency = new Map(
      response.items.map((item) => [item.currency, item]),
    );
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
  },
);

test(
  "a currency outside the contract's registry is withheld, not coerced",
  { skip },
  async (t) => {
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
  },
);

test(
  "a value past the 38 and 18 boundary is an explicit out-of-range outcome",
  { skip },
  async (t) => {
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
  },
);

test(
  "a truncated page is marked truncated and carries a cursor",
  { skip },
  async (t) => {
    const { reader: r } = await fixture(t);
    const response = await serve(r, {
      operation: "list_transactions",
      limit: 1,
    });
    assert.equal(response.truncated, true);
    assert.ok(response.nextCursor, "a truncated page is never silently short");
    assert.equal(response.completeness, "partial");

    const next = await serve(r, {
      operation: "list_transactions",
      limit: 1,
      cursor: response.nextCursor,
    });
    assert.equal(next.operation, "list_transactions");
  },
);

test(
  "a cursor this surface did not mint is an invalid request",
  { skip },
  async (t) => {
    const { reader: r } = await fixture(t);
    await assert.rejects(
      () =>
        serve(r, {
          operation: "list_transactions",
          cursor: "AAAAAAAAAAAAAAAAAAAAAAAA",
        }),
      (error) => error.code === "invalid_request",
    );
  },
);

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

test(
  "signed cursors are bound to principal, filters, limit, and revision",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const first = await serve(r, { operation: "list_transactions", limit: 1 });
    assert.ok(first.nextCursor);
    const attempts = [
      () =>
        serve(
          r,
          {
            operation: "list_transactions",
            limit: 1,
            cursor: first.nextCursor,
          },
          { principalId: "principal-other-key" },
        ),
      () =>
        serve(r, {
          operation: "list_transactions",
          limit: 2,
          cursor: first.nextCursor,
        }),
      () =>
        serve(r, {
          operation: "list_transactions",
          limit: 1,
          sourceId: seeded.settled.id,
          cursor: first.nextCursor,
        }),
    ];
    for (const attempt of attempts)
      await assert.rejects(
        attempt,
        (error) => error.code === "invalid_request",
      );

    await owner.query(
      "UPDATE accounts SET display_name = 'Revision moved' WHERE id = $1",
      [seeded.settled.accountIds[0]],
    );
    await assert.rejects(
      () =>
        serve(r, {
          operation: "list_transactions",
          limit: 1,
          cursor: first.nextCursor,
        }),
      (error) => error.code === "revision_changed",
    );
  },
);

test(
  "account discovery reports ambiguity and a truthful terminal page",
  { skip },
  async (t) => {
    const { reader: r } = await fixture(t);
    const first = await serve(r, { operation: "list_accounts", limit: 2 });
    assert.equal(first.matchStatus, "ambiguous");
    assert.ok(first.totalMatches > first.items.length);
    assert.equal(first.truncated, true);
    const terminal = await serve(r, {
      operation: "list_accounts",
      limit: 2,
      cursor: first.nextCursor,
      expectedDatasetRevision: first.datasetRevision,
    });
    assert.equal(terminal.matchStatus, "ambiguous");
    assert.equal(terminal.totalMatches, first.totalMatches);
    assert.ok(terminal.items.length <= terminal.totalMatches);

    const ambiguousLastFour = await serve(r, {
      operation: "list_accounts",
      accountLast4: "1000",
    });
    assert.equal(ambiguousLastFour.matchStatus, "ambiguous");
    const unique = await serve(r, {
      operation: "list_accounts",
      institutionName: "  Synthetic   river-oak ",
      accountLast4: "1000",
    });
    assert.equal(unique.matchStatus, "unique");
    const none = await serve(r, {
      operation: "list_accounts",
      accountLast4: "9999",
    });
    assert.deepEqual(
      { status: none.matchStatus, count: none.totalMatches, items: none.items },
      { status: "none", count: 0, items: [] },
    );
  },
);

test(
  "account discovery derives last four only from verified statement aliases",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const aliasPrivilege = await r.client.query(
      "SELECT count(*)::text AS count FROM account_aliases",
    );
    assert.equal(aliasPrivilege.rows[0].count, "0");
    const accountId = seeded.settled.accountIds[0];
    const statementAlias = "123-450042-987";
    await owner.query(
      `UPDATE accounts
          SET external_key = '2026-01-02-03.04.05.000001', acct_last4 = '7711'
        WHERE id = $1`,
      [accountId],
    );
    await owner.query(
      `INSERT INTO account_aliases
         (id, account_id, institution_id, external_key, kind)
       VALUES ('alias-primary', $1, $2, $3, 'statement_number')`,
      [accountId, seeded.settled.id, statementAlias],
    );
    await owner.query(
      `INSERT INTO positions (id, account_id, as_of, currency)
       VALUES ('alias-snapshot', $1, DATE '2026-04-30', 'USD')`,
      [accountId],
    );

    const discovered = await serve(r, {
      operation: "list_accounts",
      accountLast4: "0042",
    });
    assert.equal(discovered.matchStatus, "unique");
    assert.equal(discovered.items[0].accountId, accountId);
    assert.equal(discovered.items[0].accountLast4, "0042");
    assert.equal(discovered.items[0].matchedAccountLast4, undefined);
    assert.doesNotMatch(JSON.stringify(discovered), /123-450042-987/);

    const storedSuffix = await serve(r, {
      operation: "list_accounts",
      accountLast4: "7711",
    });
    assert.equal(storedSuffix.matchStatus, "none");
    const branchTaintedSuffix = await serve(r, {
      operation: "list_accounts",
      accountLast4: "2987",
    });
    assert.equal(branchTaintedSuffix.matchStatus, "none");

    const snapshot = await serve(r, {
      operation: "get_holdings_snapshot",
      accountId,
      snapshot: { mode: "exact", asOf: "2026-04-30" },
    });
    assert.equal(snapshot.selectedSnapshot.status, "found");
    assert.equal(snapshot.account.accountLast4, "0042");
    assert.doesNotMatch(JSON.stringify(snapshot.account), /123-450042-987/);

    const opaqueWithoutAliasId = seeded.unreconciled.accountIds[0];
    await owner.query(
      `UPDATE accounts
          SET external_key = '2026-01-02-03.04.05.000002', acct_last4 = '8822'
        WHERE id = $1`,
      [opaqueWithoutAliasId],
    );
    const opaqueWithoutAlias = await serve(r, {
      operation: "list_accounts",
      institutionName: "Synthetic cedar-ridge",
    });
    assert.equal(opaqueWithoutAlias.matchStatus, "unique");
    assert.equal(opaqueWithoutAlias.items[0].accountLast4, undefined);
    assert.deepEqual(opaqueWithoutAlias.items[0].disclosures, [
      { field: "accountLast4", reason: "not_reported" },
    ]);
    assert.equal(opaqueWithoutAlias.completeness, "partial");
    assert.ok(opaqueWithoutAlias.coverage.reasons.includes("missing_value"));
    const opaqueSuffix = await serve(r, {
      operation: "list_accounts",
      accountLast4: "8822",
    });
    assert.equal(opaqueSuffix.matchStatus, "none");

    await owner.query(
      `INSERT INTO account_aliases
         (id, account_id, institution_id, external_key, kind)
       VALUES ('alias-conflicting', $1, $2, '444-991177-555', 'statement_number')`,
      [accountId, seeded.settled.id],
    );
    const ambiguousAlias = await serve(r, {
      operation: "list_accounts",
      accountLast4: "0042",
    });
    assert.equal(ambiguousAlias.matchStatus, "unique");
    assert.equal(ambiguousAlias.items[0].accountLast4, undefined);
    assert.equal(ambiguousAlias.items[0].matchedAccountLast4, "0042");
    assert.deepEqual(ambiguousAlias.items[0].disclosures, [
      { field: "accountLast4", reason: "ambiguous_aliases" },
    ]);
    assert.ok(ambiguousAlias.coverage.reasons.includes("unresolved_identity"));

    const collidingAccountId = seeded.underReview.accountIds[0];
    await owner.query(
      `INSERT INTO account_aliases
         (id, account_id, institution_id, external_key, kind)
       VALUES ('alias-collision', $1, $2, '777-880042-333', 'statement_number')`,
      [collidingAccountId, seeded.underReview.id],
    );
    const collision = await serve(r, {
      operation: "list_accounts",
      accountLast4: "0042",
    });
    assert.equal(collision.matchStatus, "ambiguous");
    assert.equal(collision.totalMatches, 2);
    assert.deepEqual(
      new Set(collision.items.map((item) => item.accountId)),
      new Set([accountId, collidingAccountId]),
    );
  },
);

test(
  "accounts with missing or unsupported base currency remain discoverable and snapshot-readable",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const cases = [
      {
        accountId: seeded.settled.accountIds[0],
        baseCurrency: null,
        institutionName: "Synthetic river-oak",
        reason: "not_reported",
        coverageReason: "missing_value",
        positionId: "unknown-base-null",
      },
      {
        accountId: seeded.unreconciled.accountIds[0],
        baseCurrency: "XTS",
        institutionName: "Synthetic cedar-ridge",
        reason: "unsupported_value",
        coverageReason: "unsupported_value",
        positionId: "unknown-base-unsupported",
      },
    ];

    for (const item of cases) {
      await owner.query(
        "UPDATE accounts SET base_currency = $2 WHERE id = $1",
        [item.accountId, item.baseCurrency],
      );
      await owner.query(
        `INSERT INTO positions (id, account_id, as_of, currency)
         VALUES ($1, $2, DATE '2026-04-30', 'USD')`,
        [item.positionId, item.accountId],
      );

      const discovered = await serve(r, {
        operation: "list_accounts",
        institutionName: item.institutionName,
      });
      assert.equal(discovered.matchStatus, "unique");
      assert.equal(discovered.items.length, 1);
      assert.equal(discovered.items[0].accountId, item.accountId);
      assert.equal(discovered.items[0].baseCurrency, undefined);
      assert.deepEqual(discovered.items[0].disclosures, [
        { field: "baseCurrency", reason: item.reason },
      ]);
      assert.equal(discovered.completeness, "partial");
      assert.ok(discovered.coverage.reasons.includes(item.coverageReason));

      const snapshot = await serve(r, {
        operation: "get_holdings_snapshot",
        accountId: item.accountId,
        snapshot: { mode: "exact", asOf: "2026-04-30" },
      });
      assert.deepEqual(snapshot.selectedSnapshot, {
        status: "found",
        asOf: "2026-04-30",
      });
      assert.equal(snapshot.account.accountId, item.accountId);
      assert.equal(snapshot.account.baseCurrency, undefined);
      assert.deepEqual(snapshot.account.disclosures, [
        { field: "baseCurrency", reason: item.reason },
      ]);
      assert.equal(snapshot.items[0].currency, "USD");
      assert.equal(snapshot.completeness, "partial");
      assert.ok(snapshot.coverage.reasons.includes(item.coverageReason));
    }
  },
);

test(
  "cited multi-currency snapshot totals and field evidence are exact",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const snapshot = await citedSnapshot(owner, seeded);
    const response = await serve(r, {
      operation: "get_holdings_snapshot",
      accountId: snapshot.accountId,
      snapshot: { mode: "exact", asOf: snapshot.asOf },
    });
    assert.equal(response.summary.status, "complete");
    assert.equal(response.summary.positionCount, 3);
    assert.equal(response.summary.resolvedInstrumentCount, 3);
    const byCurrency = new Map(
      response.summary.currencies.map((item) => [item.currency, item]),
    );
    assert.deepEqual(
      {
        market: byCurrency.get("USD").marketValue.amount.decimal,
        basis: byCurrency.get("USD").costBasis.amount.decimal,
        derived: byCurrency.get("USD").derivedUnrealizedGainLoss.amount.decimal,
        stored: byCurrency.get("USD").storedUnrealizedGainLoss,
        reconciliation: byCurrency.get("USD").reconciliation,
      },
      {
        market: "200",
        basis: "170",
        derived: "30",
        stored: { contributingPositionCount: 0, missingPositionCount: 2 },
        reconciliation: {
          status: "difference",
          difference: { decimal: "5", currency: "USD" },
          formula: "stated_account_total_minus_position_market_value",
        },
      },
    );
    assert.equal(byCurrency.get("EUR").reconciliation.status, "match");
    const usd = response.items.find((item) => item.currency === "USD");
    assert.equal(usd.instrument.name, "Synthetic USD Fund");
    assert.equal(usd.derivedUnrealizedGainLoss.amount.decimal, "20");
    assert.ok(
      ["quantity", "price", "marketValue", "costBasis"].every((field) =>
        usd.fieldEvidence.some((item) => item.field === field),
      ),
    );

    const evidence = await serve(r, {
      operation: "get_evidence",
      recordId: usd.recordId,
    });
    assert.deepEqual(
      new Set(evidence.items.map((item) => item.evidenceId.split(":").at(-1))),
      new Set(["quantity", "price", "marketValue", "costBasis"]),
    );

    const aggregate = await serve(r, {
      operation: "aggregate_money",
      metric: "market_value",
      groupBy: "currency",
      accountId: snapshot.accountId,
      from: snapshot.asOf,
      toExclusive: "2026-03-01",
    });
    assert.equal(
      aggregate.items.find((item) => item.currency === "USD").total.decimal,
      "200",
    );
  },
);

test(
  "the standalone MCP advertises and serves account discovery through a cited snapshot",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const snapshot = await citedSnapshot(owner, seeded);
    const { server } = createFinanceArchiveMcpServer(
      r.client,
      SPACE,
      TRUSTED,
      "synthetic-finance-cursor-secret-at-least-32-bytes",
    );
    const client = new Client({ name: "fresh-finance-client", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const tools = await client.listTools();
      const financeRead = tools.tools.find(
        (tool) => tool.name === "finance_read",
      );
      const advertised = JSON.stringify(financeRead);
      for (const term of [
        "contractVersion",
        "list_accounts",
        "get_holdings_snapshot",
        "accountLast4",
        "expectedDatasetRevision",
      ])
        assert.ok(advertised.includes(term), term);
      assert.ok(
        advertised.includes(FINANCE_READ_REQUEST_DESCRIPTION.slice(0, 80)),
      );

      const discovered = await client.callTool({
        name: "finance_read",
        arguments: {
          request: {
            contractVersion: 1,
            spaceId: SPACE,
            operation: "list_accounts",
            institutionName: "Synthetic river-oak",
            accountLast4: "1000",
            limit: 10,
          },
        },
      });
      assert.notEqual(discovered.isError, true);
      const accountResponse = JSON.parse(discovered.content[0].text);
      assert.equal(accountResponse.matchStatus, "unique");
      assert.equal(accountResponse.items[0].accountId, snapshot.accountId);

      const holdings = await client.callTool({
        name: "finance_read",
        arguments: {
          request: {
            contractVersion: 1,
            spaceId: SPACE,
            operation: "get_holdings_snapshot",
            accountId: accountResponse.items[0].accountId,
            snapshot: { mode: "exact", asOf: snapshot.asOf },
            limit: 100,
          },
        },
      });
      assert.notEqual(holdings.isError, true);
      const snapshotResponse = JSON.parse(holdings.content[0].text);
      assert.equal(snapshotResponse.selectedSnapshot.asOf, snapshot.asOf);
      assert.equal(snapshotResponse.summary.positionCount, 3);
      assert.ok(snapshotResponse.items.every((item) => item.instrument.name));
    } finally {
      await client.close();
      await server.close();
    }
  },
);

test(
  "snapshot totals stay conservative for missing values and ambiguous balances",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const snapshot = await citedSnapshot(owner, seeded);
    await owner.query(
      "UPDATE positions SET market_value = NULL WHERE id = 'cited-usd'",
    );
    await owner.query(
      `INSERT INTO balances
       (id, account_id, as_of, total_value, currency)
     VALUES ('balance-usd-uncited', $1, $2::date, '125', 'USD')`,
      [snapshot.accountId, snapshot.asOf],
    );
    const response = await serve(r, {
      operation: "get_holdings_snapshot",
      accountId: snapshot.accountId,
      snapshot: { mode: "exact", asOf: snapshot.asOf },
    });
    assert.equal(response.summary.status, "partial");
    const usd = response.summary.currencies.find(
      (item) => item.currency === "USD",
    );
    assert.deepEqual(usd.marketValue.amount, {
      decimal: "80",
      currency: "USD",
    });
    assert.equal(usd.marketValue.contributingPositionCount, 1);
    assert.equal(usd.marketValue.missingPositionCount, 1);
    assert.equal(usd.statedAccountTotal.status, "ambiguous");
    assert.equal(usd.reconciliation.status, "incomplete");
    const position = response.items.find((item) => item.currency === "USD");
    assert.ok(
      position.disclosures.some(
        (item) =>
          item.field === "marketValue" && item.reason === "not_reported",
      ),
    );
  },
);

test(
  "derived and reconciliation overflow are disclosed instead of aborting the snapshot",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const snapshot = await citedSnapshot(owner, seeded);
    const maximum = "99999999999999999999999999999999999999";
    await owner.query(
      `UPDATE positions
        SET market_value = $1::numeric, cost_basis = (-$1::numeric),
            source_locator = $2
      WHERE id = 'cited-usd'`,
      [
        maximum,
        structuredBindings({
          quantity: "2",
          price: "60",
          marketValue: maximum,
          costBasis: `-${maximum}`,
        }),
      ],
    );
    let response = await serve(r, {
      operation: "get_holdings_snapshot",
      accountId: snapshot.accountId,
      snapshot: { mode: "exact", asOf: snapshot.asOf },
    });
    let usd = response.items.find((item) => item.currency === "USD");
    assert.equal(usd.derivedUnrealizedGainLoss, undefined);
    assert.ok(
      usd.disclosures.some(
        (item) =>
          item.field === "derivedUnrealizedGainLoss" &&
          item.reason === "precision_overflow",
      ),
    );
    assert.equal(
      response.summary.currencies.find((item) => item.currency === "USD")
        .derivedUnrealizedGainLoss.issue,
      "precision_overflow",
    );

    await owner.query(
      `UPDATE positions
        SET market_value = (-$1::numeric), cost_basis = (-$1::numeric),
            source_locator = $2
      WHERE id = 'cited-usd'`,
      [
        maximum,
        structuredBindings({
          quantity: "2",
          price: "60",
          marketValue: `-${maximum}`,
          costBasis: `-${maximum}`,
        }),
      ],
    );
    await owner.query(
      `UPDATE balances SET total_value = $1::numeric, source_locator = $2
      WHERE id = 'balance-usd'`,
      [maximum, structuredBindings({ totalValue: maximum })],
    );
    response = await serve(r, {
      operation: "get_holdings_snapshot",
      accountId: snapshot.accountId,
      snapshot: { mode: "exact", asOf: snapshot.asOf },
    });
    usd = response.summary.currencies.find((item) => item.currency === "USD");
    assert.equal(usd.reconciliation.status, "precision_overflow");
    assert.equal(response.summary.status, "partial");
  },
);

test(
  "snapshot keyset pagination traverses beyond the whole-summary ceiling",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const accountId = seeded.settled.accountIds[0];
    await owner.query(
      `INSERT INTO positions (id, account_id, as_of, currency)
     SELECT 'bulk-' || lpad(n::text, 5, '0'), $1, DATE '2026-03-31', 'USD'
       FROM generate_series(1, 10002) AS n`,
      [accountId],
    );
    const first = await serve(r, {
      operation: "get_holdings_snapshot",
      accountId,
      snapshot: { mode: "exact", asOf: "2026-03-31" },
      limit: 100,
    });
    assert.deepEqual(first.summary, {
      status: "unavailable",
      reason: "position_limit",
      positionCount: 10002,
      currencies: [],
    });
    assert.equal(first.issues[0].code, "snapshot_summary_limit");
    const seen = new Set(first.items.map((item) => item.recordId));
    let page = first;
    while (page.nextCursor !== undefined) {
      page = await serve(r, {
        operation: "get_holdings_snapshot",
        accountId,
        snapshot: { mode: "exact", asOf: "2026-03-31" },
        limit: 100,
        expectedDatasetRevision: first.datasetRevision,
        cursor: page.nextCursor,
      });
      for (const item of page.items) {
        assert.equal(seen.has(item.recordId), false, item.recordId);
        seen.add(item.recordId);
      }
    }
    assert.equal(seen.size, 10002);
    assert.ok(seen.has("pos:bulk-10002"));
  },
);

test(
  "aggregate group cursors advance instead of repeating the first group",
  { skip },
  async (t) => {
    const { reader: r } = await fixture(t);
    const first = await serve(r, {
      operation: "aggregate_money",
      metric: "transaction_amount",
      groupBy: "currency",
      limit: 1,
    });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const seen = new Set(first.items.map((item) => item.currency));
    let page = first;
    while (page.nextCursor !== undefined) {
      page = await serve(r, {
        operation: "aggregate_money",
        metric: "transaction_amount",
        groupBy: "currency",
        limit: 1,
        expectedDatasetRevision: first.datasetRevision,
        cursor: page.nextCursor,
      });
      for (const item of page.items) {
        assert.equal(seen.has(item.currency), false);
        seen.add(item.currency);
      }
    }
    assert.deepEqual(seen, new Set(["EUR", "USD"]));
  },
);

test(
  "snapshot selection is exact, latest is fixed, and signed pages do not duplicate rows",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    for (const [id, date] of [
      ["snap_old", "2026-01-31"],
      ["snap_a", "2026-02-28"],
      ["snap_b", "2026-02-28"],
    ]) {
      await owner.query(
        `INSERT INTO positions (id, account_id, as_of, quantity, market_value, currency, valuation_basis)
       VALUES ($1, $2, $3::date, '1', '10', 'USD', 'market_price')`,
        [id, seeded.settled.accountIds[0], date],
      );
    }
    const exact = await serve(r, {
      operation: "get_holdings_snapshot",
      accountId: seeded.settled.accountIds[0],
      snapshot: { mode: "exact", asOf: "2026-02-28" },
      limit: 1,
    });
    assert.equal(exact.selectedSnapshot.asOf, "2026-02-28");
    assert.equal(exact.items.length, 1);
    assert.ok(exact.nextCursor);
    const next = await serve(r, {
      operation: "get_holdings_snapshot",
      accountId: seeded.settled.accountIds[0],
      snapshot: { mode: "exact", asOf: "2026-02-28" },
      limit: 1,
      expectedDatasetRevision: exact.datasetRevision,
      cursor: exact.nextCursor,
    });
    assert.equal(next.selectedSnapshot.asOf, "2026-02-28");
    assert.equal(next.items.length, 1);
    assert.notEqual(next.items[0].recordId, exact.items[0].recordId);
    await assert.rejects(
      () =>
        serve(r, {
          operation: "get_holdings_snapshot",
          accountId: seeded.settled.accountIds[0],
          snapshot: { mode: "exact", asOf: "2026-01-31" },
          limit: 1,
          cursor: exact.nextCursor,
        }),
      (error) => error.code === "invalid_request",
      "a cursor is bound to the selected snapshot, not merely its shape",
    );
    await assert.rejects(
      () =>
        serve(r, {
          operation: "get_holdings_snapshot",
          accountId: seeded.settled.accountIds[0],
          snapshot: { mode: "exact", asOf: "2026-02-28" },
          limit: 1,
          expectedDatasetRevision: "rev-not-the-snapshot",
        }),
      (error) => error.code === "revision_changed",
      "a caller cannot silently continue after its pinned dataset moved",
    );
    const latest = await serve(r, {
      operation: "get_holdings_snapshot",
      accountId: seeded.settled.accountIds[0],
      snapshot: { mode: "latest", onOrBefore: "2026-02-28" },
      limit: 10,
    });
    assert.equal(latest.selectedSnapshot.asOf, "2026-02-28");
    const absent = await serve(r, {
      operation: "get_holdings_snapshot",
      accountId: seeded.settled.accountIds[0],
      snapshot: { mode: "exact", asOf: "2026-02-27" },
      limit: 10,
    });
    assert.deepEqual(absent.selectedSnapshot, { status: "not_found" });
    await assert.rejects(
      () =>
        serve(r, {
          operation: "get_holdings_snapshot",
          accountId: seeded.settled.accountIds[0],
          snapshot: { mode: "exact", asOf: "2026-02-27" },
          limit: 1,
          cursor: exact.nextCursor,
        }),
      (error) => error.code === "invalid_request",
      "a continuation cannot turn into an absent selection",
    );
  },
);

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

test(
  "get_evidence reports why it has no citation rather than inventing one",
  { skip },
  async (t) => {
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
  },
);

test(
  "list operations withhold rows they cannot cite, and say so",
  { skip },
  async (t) => {
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
  },
);

test(
  "the surface reads through the reader role, not the owner",
  { skip },
  async (t) => {
    const { reader: r } = await fixture(t);
    const who = await one(r.client, "SELECT current_user AS name");
    assert.equal(who.name, r.summary.role);
    // And the read it just did is still a read: the reader cannot write.
    await assert.rejects(() => r.client.query("DELETE FROM transactions"));
  },
);

test(
  "a holdings aggregate sums the latest snapshot, not every snapshot",
  { skip },
  async (t) => {
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
  },
);

test(
  "an aggregate over more contributors than the contract carries offers a breakdown",
  { skip },
  async (t) => {
    const owner = await archive(t);
    const seeded = await seed(owner);
    const doc = await document(
      owner,
      seeded.settled.id,
      seeded.settled.accountIds[0],
      "2026-03-31",
    );
    // The contract carries at most 25 contributor ids inline; past that it
    // requires a breakdown reference rather than a shortened list presented as
    // the whole one.
    for (let index = 0; index < 30; index += 1) {
      await transaction(
        owner,
        seeded.settled.accountIds[0],
        doc,
        "2026-03-10",
        "-1.00",
        "CAD",
      );
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
    assert.ok(
      item.breakdown,
      "a shortened contributor list must carry a breakdown",
    );
    assert.equal(item.total.decimal, "-30");
  },
);

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
    [
      ADAPTER.institution.id,
      ADAPTER.institution.name,
      ADAPTER.institution.slug,
    ],
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
  async function pull(
    selection,
    docType,
    docDate,
    accountId = ADAPTER.accounts[0].id,
  ) {
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
        ADAPTER.accounts.find((account) => account.id === accountId)?.last4 ??
        null,
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
  return { client, retainedPaths, rawTreeRoot };
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

test(
  "a cited record resolves in the retained bytes it names",
  { skip },
  async (t) => {
    const { client, retainedPaths } = await importedPull(t);
    const r = await reader(t, client);
    const response = await serve(r, {
      operation: "list_transactions",
      limit: 100,
    });

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
    assert.ok(
      response.coverage.reasons.includes("retained_evidence_unavailable"),
    );

    // `get_evidence` for a returned record answers with that same item.
    const [first] = response.items;
    const evidence = await serve(r, {
      operation: "get_evidence",
      recordId: first.recordId,
    });
    assert.deepEqual(evidence.items, first.evidence);
  },
);

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

/**
 * Rewrites one positions row's `source_locator`, adding a `marketValue` key
 * whose binding is a `retained_text_span_v1` span into a text file this
 * helper actually writes under `rawTreeRoot` (F1-53). `quote` is
 * `"$" + money`, which `textSpanQuoteAgrees` (pgRead.ts) reads back to the
 * same canonical decimal after stripping the currency symbol.
 */
async function bindPdfPositionToRetainedText(client, rawTreeRoot) {
  const row = await one(
    client,
    `SELECT p.id, p.market_value, p.quantity, p.currency
       FROM positions p JOIN documents d ON d.id = p.source_document_id
      WHERE d.media_type = $1
      LIMIT 1`,
    [PDF_TIER],
  );
  const money = canonicalizeFinanceDecimal(fromNumericText(row.market_value));
  const quote = `$${money}`;
  const text = `HOLDINGS\nSynthetic Neutral Fund   10.000   ${quote}   Cost 3,000.00\n`;
  const start = text.indexOf(quote);
  const written = writeRetainedText(rawTreeRoot, text);
  const binding = {
    format: "retained_text_span_v1",
    textSha256: written.sha256,
    textByteLength: Buffer.byteLength(text, "utf8"),
    textCodepointLength: Array.from(text).length,
    start,
    end: start + quote.length,
    quote,
  };
  const quantityQuote = canonicalizeFinanceDecimal(
    fromNumericText(row.quantity),
  );
  const quantityStart = text.indexOf("10.000");
  const quantityBinding = {
    ...binding,
    start: quantityStart,
    end: quantityStart + "10.000".length,
    quote: "10.000",
  };
  await client.query(
    `UPDATE positions SET quantity = '10', source_locator = $2 WHERE id = $1`,
    [
      row.id,
      JSON.stringify({
        row: { source: "pdf_statement", index: 1 },
        marketValue: {
          source: "pdf_statement",
          index: 1,
          field: "HOLDINGS / Market Value",
          binding,
        },
        quantity: {
          source: "pdf_statement",
          index: 1,
          field: "HOLDINGS / Quantity",
          binding: quantityBinding,
        },
      }),
    ],
  );
  return {
    recordId: `pos:${row.id}`,
    text,
    binding,
    quantityBinding,
    quantityQuote,
  };
}

async function bindPdfPositionToExactSpanSum(client, rawTreeRoot) {
  const row = await one(
    client,
    `SELECT p.id
       FROM positions p JOIN documents d ON d.id = p.source_document_id
      WHERE d.media_type = $1
      LIMIT 1`,
    [PDF_TIER],
  );
  const quotes = ["$10.25", "19.75"];
  const text = `HOLDINGS\nSynthetic Neutral Fund lot 1   ${quotes[0]}\nSynthetic Neutral Fund lot 2   ${quotes[1]}\n`;
  const written = writeRetainedText(rawTreeRoot, text);
  const terms = quotes.map((quote) => {
    const start = text.indexOf(quote);
    return {
      format: "retained_text_span_v1",
      textSha256: written.sha256,
      textByteLength: Buffer.byteLength(text, "utf8"),
      textCodepointLength: Array.from(text).length,
      start,
      end: start + quote.length,
      quote,
    };
  });
  await client.query(
    `UPDATE positions SET market_value = '30', quantity = '2', source_locator = $2 WHERE id = $1`,
    [
      row.id,
      JSON.stringify({
        row: { source: "pdf_statement", index: 1 },
        marketValue: {
          source: "pdf_statement",
          index: 1,
          field: "HOLDINGS / Market Value / sum of 2 dated lots",
          calculation: { format: "decimal_sum_v1", terms },
        },
      }),
    ],
  );
  return { recordId: `pos:${row.id}`, terms };
}

function retainedSpanBinding(text, quote) {
  const start = text.indexOf(quote);
  assert.notEqual(start, -1, "the synthetic quote is present in retained text");
  return {
    format: "retained_text_span_v1",
    textSha256: createHash("sha256").update(text, "utf8").digest("hex"),
    textByteLength: Buffer.byteLength(text, "utf8"),
    textCodepointLength: Array.from(text).length,
    start,
    end: start + quote.length,
    quote,
  };
}

async function importLotOnlyAggregatePosition(t) {
  const directory = mkdtempSync(join(tmpdir(), "kith-finance-lot-mcp-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const rawTreeRoot = resolveRawTreeRoot({
    FINANCE_ARCHIVE_RAW_TREE_ROOT: join(directory, "raw"),
    FINANCE_ARCHIVE_SPACE_ID: ADAPTER.spaceId,
  });

  const client = await archive(t);
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ($1, $2, $3)",
    [
      ADAPTER.institution.id,
      ADAPTER.institution.name,
      ADAPTER.institution.slug,
    ],
  );
  await client.query(
    `INSERT INTO accounts (id, institution_id, acct_last4, base_currency)
     VALUES ($1, $2, $3, 'USD')`,
    [
      ADAPTER.accounts[0].id,
      ADAPTER.institution.id,
      ADAPTER.accounts[0].last4,
    ],
  );

  const quotes = ["$10.25", "19.75"];
  const text =
    "HOLDINGS\n" +
    `Synthetic Aggregate Fund lot 1   ${quotes[0]}\n` +
    `Synthetic Aggregate Fund lot 2   ${quotes[1]}\n`;
  await storeRetainedText(client, text);
  const retained = retainPayload(
    {
      kind: "opaque",
      version: "test-pdf-lot-aggregate-1",
      note: "synthetic statement text for aggregate lot evidence",
    },
    new TextEncoder().encode(text),
    "pdf_statement",
  );
  const acquired = {
    bytes: retained.bytes,
    retention: retained.record,
    manifest: {
      kind: "pdf_statement",
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      capturedAt: "2026-03-01T00:00:00.000Z",
      contentHash: retained.sha256,
      mediaType: "text/plain; charset=utf-8",
      reportedRowCount: null,
      gaps: [],
    },
  };
  const persisted = persistAcquiredDocument(
    rawTreeRoot,
    {
      institutionId: ADAPTER.institution.id,
      accountId: ADAPTER.accounts[0].id,
      institutionSlug: ADAPTER.institution.slug,
      accountLast4: ADAPTER.accounts[0].last4,
      docType: "pdf_statement",
      acquired,
    },
    text,
  );
  const terms = quotes.map((quote) => retainedSpanBinding(text, quote));
  const locators = {
    row: {
      source: "pdf_statement",
      index: 1,
      field: "HOLDINGS / Synthetic Aggregate Fund",
    },
    "marketValue.lot.1": {
      source: "pdf_statement",
      index: 1,
      field: "HOLDINGS / Market Value / lot 1",
      binding: terms[0],
    },
    "marketValue.lot.2": {
      source: "pdf_statement",
      index: 1,
      field: "HOLDINGS / Market Value / lot 2",
      binding: terms[1],
    },
  };
  const documents = await adapterPullToImportDocuments(client, {
    institutionId: ADAPTER.institution.id,
    accountId: ADAPTER.accounts[0].id,
    acquired,
    rows: [],
    holdings: {
      positions: [
        {
          sourceDocument: "statement",
          asOf: "2026-02-28",
          instrument: {
            symbol: "SAGG",
            cusip: null,
            isin: null,
            name: "SYNTHETIC AGGREGATE FUND",
          },
          quantity: "2",
          price: null,
          marketValue: "30",
          marketValueNote: null,
          costBasis: null,
          unrealized: null,
          currency: "USD",
          valuationBasis: "market_price",
          valuationNote: "Synthetic aggregate lot statement",
          locators,
        },
      ],
      balances: [],
      liabilities: [],
    },
    docType: "pdf_statement",
    docDate: "2026-02-28",
    persisted,
  });
  await importBatch(
    client,
    { source: ADAPTER.institution.slug, documents },
    new Date("2026-03-01"),
  );
  return { client, terms };
}

test(
  "an exact sum over constituent retained spans serves the calculated holding with every term as evidence",
  { skip },
  async (t) => {
    const { client, rawTreeRoot } = await importedPull(t);
    const r = await reader(t, client);
    const { recordId, terms } = await bindPdfPositionToExactSpanSum(
      client,
      rawTreeRoot,
    );

    const listed = await serve(r, { operation: "list_holdings", limit: 100 });
    const item = listed.items.find(
      (candidate) => candidate.recordId === recordId,
    );
    assert.ok(item, "the exactly verified calculated position is served");
    assert.equal(item.marketValue.decimal, "30");
    assert.deepEqual(
      item.evidence.map(({ locator }) => locator.quote),
      terms.map(({ quote }) => quote),
    );
    assert.equal(
      new Set(item.evidence.map(({ evidenceId }) => evidenceId)).size,
      2,
    );

    const evidence = await serve(
      r,
      { operation: "get_evidence", recordId },
      { rawTreeRoot },
    );
    assert.deepEqual(
      evidence.items.map(({ locator }) => locator.quote),
      terms.map(({ quote }) => quote),
    );

    await client.query(
      "UPDATE positions SET market_value = '30.01' WHERE id = $1",
      [recordId.slice("pos:".length)],
    );
    const mismatched = await serve(r, {
      operation: "list_holdings",
      limit: 100,
    });
    assert.ok(
      !mismatched.items.some((candidate) => candidate.recordId === recordId),
    );
    assert.ok(
      mismatched.coverage.reasons.includes("retained_evidence_unavailable"),
    );
  },
);

test(
  "a lot-only aggregate holding imports and is served through MCP with retained evidence",
  { skip },
  async (t) => {
    const { client: archiveClient, terms } =
      await importLotOnlyAggregatePosition(t);
    const r = await reader(t, archiveClient);
    const trusted = {
      principalId: TRUSTED.principalId,
      authorizedSpaceIds: [ADAPTER.spaceId],
    };
    const { server } = createFinanceArchiveMcpServer(
      r.client,
      ADAPTER.spaceId,
      trusted,
      "synthetic-finance-cursor-secret-at-least-32-bytes",
    );
    const client = new Client({ name: "aggregate-finance-client", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const listed = await client.callTool({
        name: "finance_read",
        arguments: {
          request: {
            contractVersion: 1,
            spaceId: ADAPTER.spaceId,
            operation: "list_holdings",
            sourceId: ADAPTER.institution.id,
            limit: 100,
          },
        },
      });
      assert.notEqual(listed.isError, true);
      const response = JSON.parse(listed.content[0].text);
      assert.equal(response.operation, "list_holdings");
      assert.equal(response.items.length, 1);
      const [item] = response.items;
      assert.equal(item.marketValue.decimal, "30");
      assert.deepEqual(
        item.evidence.map(({ locator }) => locator.quote),
        terms.map(({ quote }) => quote),
      );

      const evidence = await client.callTool({
        name: "finance_read",
        arguments: {
          request: {
            contractVersion: 1,
            spaceId: ADAPTER.spaceId,
            operation: "get_evidence",
            recordId: item.recordId,
            limit: 10,
          },
        },
      });
      assert.notEqual(evidence.isError, true);
      const evidenceResponse = JSON.parse(evidence.content[0].text);
      assert.deepEqual(
        evidenceResponse.items.map(({ locator }) => locator.quote),
        terms.map(({ quote }) => quote),
      );
    } finally {
      await client.close();
      await server.close();
    }
  },
);

test(
  "a PDF-tier position with a retained-text-span binding is served, and get_evidence verifies it against the retained text on disk",
  { skip },
  async (t) => {
    const { client, rawTreeRoot } = await importedPull(t);
    const r = await reader(t, client);
    const { recordId, binding, quantityBinding } =
      await bindPdfPositionToRetainedText(client, rawTreeRoot);

    const response = await serve(r, { operation: "list_holdings", limit: 100 });
    const item = response.items.find((row) => row.recordId === recordId);
    assert.ok(item, "the bound position is served, not withheld");
    assert.equal(item.evidence.length, 1);
    const [evidence] = item.evidence;
    assert.equal(evidence.kind, "retained_text_span_v1");
    assert.equal(evidence.locator.quote, binding.quote);
    assert.equal(evidence.locator.textSha256, binding.textSha256);
    assert.equal(
      evidence.locator.relativePath,
      textRelativePath(binding.textSha256),
    );
    assert.equal(
      evidence.locator.quoteSha256,
      createHash("sha256").update(evidence.locator.quote, "utf8").digest("hex"),
    );

    // get_evidence, unlike list_holdings, opens the file and checks the
    // quote against the actual bytes -- the "retained_sha256 check".
    const getEvidenceResponse = await serve(
      r,
      { operation: "get_evidence", recordId },
      { rawTreeRoot },
    );
    assert.ok(
      item.evidence.every((expected) =>
        getEvidenceResponse.items.some(
          (actual) => actual.evidenceId === expected.evidenceId,
        ),
      ),
    );
    assert.ok(
      getEvidenceResponse.items.some((evidence) =>
        evidence.evidenceId.endsWith(":quantity"),
      ),
    );
  },
);

test(
  "get_evidence withholds a retained-text-span citation it cannot verify on disk, even though list_holdings already served it",
  { skip },
  async (t) => {
    const { client, rawTreeRoot } = await importedPull(t);
    const r = await reader(t, client);
    const { recordId } = await bindPdfPositionToRetainedText(
      client,
      rawTreeRoot,
    );

    const listed = await serve(r, { operation: "list_holdings", limit: 100 });
    assert.ok(
      listed.items.some((row) => row.recordId === recordId),
      "list_holdings trusts the binding's own internal consistency",
    );

    // A raw tree root with no such file at all -- the disk check cannot even
    // open the retained text, let alone verify the quote against it.
    const emptyRoot = mkdtempSync(join(tmpdir(), "kith-finance-no-such-root-"));
    t.after(() => rmSync(emptyRoot, { recursive: true, force: true }));
    const response = await serve(
      r,
      { operation: "get_evidence", recordId },
      { rawTreeRoot: emptyRoot },
    );
    assert.deepEqual(response.items, []);
    assert.ok(
      response.coverage.reasons.includes("retained_evidence_unavailable"),
    );
  },
);

test(
  "F1-66: get_evidence verifies a retained-text span against the archive's own copy, with no raw tree configured at all",
  { skip },
  async (t) => {
    const { client, rawTreeRoot } = await importedPull(t);
    const r = await reader(t, client);
    const { recordId, text } = await bindPdfPositionToRetainedText(
      client,
      rawTreeRoot,
    );
    // The import path writes this row beside the raw-tree file (run.ts); this
    // helper writes only the file, so the row is written here by the same
    // function the import calls.
    await storeRetainedText(client, text);

    const listed = await serve(r, { operation: "list_holdings", limit: 100 });
    const item = listed.items.find((row) => row.recordId === recordId);
    assert.ok(item);

    // `rawTreeRoot: null` is the gateway: a reader-role pool in a Vercel
    // function, with no raw tree anywhere near it. Before F1-66 this answered
    // `retained_evidence_unavailable` for every text-span citation the list
    // operation had just served.
    const response = await serve(
      r,
      { operation: "get_evidence", recordId },
      { rawTreeRoot: null },
    );
    assert.ok(
      item.evidence.every((expected) =>
        response.items.some(
          (actual) => actual.evidenceId === expected.evidenceId,
        ),
      ),
    );
    assert.ok(
      response.items.some((evidence) =>
        evidence.evidenceId.endsWith(":quantity"),
      ),
    );
    assert.ok(
      !(response.coverage.reasons ?? []).includes(
        "retained_evidence_unavailable",
      ),
      "nothing was withheld: the archive had the bytes",
    );
  },
);

test(
  "F1-66: a retained_texts row whose content no longer hashes to its key is refused, and never falls back to an intact raw tree",
  { skip },
  async (t) => {
    const { client, rawTreeRoot } = await importedPull(t);
    const r = await reader(t, client);
    const { recordId, text, binding } = await bindPdfPositionToRetainedText(
      client,
      rawTreeRoot,
    );
    await storeRetainedText(client, text);

    // One byte, in place: the length still matches (the table's own CHECK
    // sees nothing wrong) and the sha256 no longer does, which is the only
    // thing verification actually trusts.
    await client.query(
      "UPDATE retained_texts SET content = overlay(content placing $2::bytea from 1 for 1) WHERE sha256 = $1",
      [binding.textSha256, Buffer.from("X", "utf8")],
    );

    // The raw tree still holds the true bytes, and this still refuses: a row
    // that is present but wrong is a tampered archive, not a cache miss, so
    // the fallback is for an absent row only.
    const response = await serve(
      r,
      { operation: "get_evidence", recordId },
      { rawTreeRoot },
    );
    assert.deepEqual(response.items, []);
    assert.ok(
      response.coverage.reasons.includes("retained_evidence_unavailable"),
    );
  },
);

test(
  "a document whose retained bytes were never recorded cites nothing",
  { skip },
  async (t) => {
    const { client } = await importedPull(t);
    const r = await reader(t, client);
    const before = await serve(r, {
      operation: "list_transactions",
      limit: 100,
    });
    // What a document imported before F1-29 looks like: four nulls, all or
    // nothing, which is what the `documents` CHECK enforces.
    await client.query(
      `UPDATE documents
        SET retained_sha256 = NULL, retained_byte_length = NULL,
            media_type = NULL, capture_id = NULL
      WHERE media_type = $1`,
      [TABULAR_TIER],
    );
    const after = await serve(r, {
      operation: "list_transactions",
      limit: 100,
    });
    assert.ok(after.items.length < before.items.length);
    assert.ok(
      after.items.every(
        (item) => item.evidence[0].sourceObject.mediaType === JSON_TIER,
      ),
      "a row whose document names no bytes is withheld, never cited to nothing",
    );
    assert.ok(after.coverage.reasons.includes("retained_evidence_unavailable"));
  },
);

test(
  "a binding that disagrees with the stored amount withholds its row",
  { skip },
  async (t) => {
    const { client } = await importedPull(t);
    const r = await reader(t, client);
    const before = await serve(r, {
      operation: "list_transactions",
      limit: 100,
    });
    const [target] = before.items;
    // The stored value moves and the binding does not. The citation would still
    // resolve in the retained bytes; it would just cite a different number than
    // the row asserts, which is the wrong-bytes failure the cross-check exists
    // to catch.
    await client.query(
      "UPDATE transactions SET amount = amount + 1 WHERE id = $1",
      [target.recordId.slice("txn:".length)],
    );
    const after = await serve(r, {
      operation: "list_transactions",
      limit: 100,
    });
    assert.equal(after.items.length, before.items.length - 1);
    assert.ok(!after.items.some((item) => item.recordId === target.recordId));
    assert.ok(after.coverage.reasons.includes("retained_evidence_unavailable"));
  },
);

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

test(
  "two bindings on one record are told apart by name, not by key order",
  { skip },
  async (t) => {
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

    const after = await serve(r, {
      operation: "list_transactions",
      limit: 100,
    });
    const item = after.items.find((row) => row.recordId === target.recordId);
    assert.ok(item, "a record whose amount is bound is still citable");
    assert.equal(
      item.evidence[0].locator.pointer,
      cited,
      "the binding named for the load-bearing field is the cited one",
    );
  },
);

test(
  "several bindings and none for the money field withholds the row",
  { skip },
  async (t) => {
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

    const after = await serve(r, {
      operation: "list_transactions",
      limit: 100,
    });
    assert.equal(after.items.length, before.items.length - 1);
    assert.ok(!after.items.some((row) => row.recordId === target.recordId));
    assert.ok(after.coverage.reasons.includes("retained_evidence_unavailable"));
  },
);

test(
  "F1-76: a position accepted under the same-institution symbol rule reports its own identity state, and the snapshot counts it separately",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const snapshot = await citedSnapshot(owner, seeded);

    const baseline = await serve(r, {
      operation: "get_holdings_snapshot",
      accountId: snapshot.accountId,
      snapshot: { mode: "exact", asOf: snapshot.asOf },
    });
    assert.equal(baseline.summary.institutionSymbolInstrumentCount, 0);

    // The decision row the importer writes when the rule accepts a match. The
    // read surface derives the position's identity state from it; a position
    // never stores the match kind itself.
    await owner.query(
      `INSERT INTO review_items
         (id, kind, raw_value, reason, status, resolved_at, resolution_note,
          reason_code, institution_id, matched_instrument_id, occurrence_count)
       VALUES ('accepted-usd', 'institution_symbol_match', 'descriptor',
               'accepted under the same-institution symbol rule', 'resolved',
               now(), 'accepted by same_institution_symbol_v1',
               'same_institution_symbol_v1', $1, 'instrument-usd', 1)`,
      [seeded.settled.id],
    );

    const accepted = await serve(r, {
      operation: "get_holdings_snapshot",
      accountId: snapshot.accountId,
      snapshot: { mode: "exact", asOf: snapshot.asOf },
    });
    const byRecord = new Map(
      accepted.items.map((item) => [item.recordId, item.instrument.status]),
    );
    assert.equal(byRecord.get("pos:cited-usd"), "institution_symbol");
    assert.equal(byRecord.get("pos:cited-usd-2"), "resolved");
    assert.equal(accepted.summary.institutionSymbolInstrumentCount, 1);
    assert.equal(accepted.summary.resolvedInstrumentCount, 2);
    assert.equal(accepted.summary.unresolvedInstrumentCount, 0);
    // An accepted identity is usable, so it does not by itself make the
    // snapshot incomplete or the coverage partial.
    assert.equal(accepted.summary.status, baseline.summary.status);
    assert.equal(accepted.completeness, baseline.completeness);

    // Withdrawing the acceptance reopens the weak item beside it, and the
    // position goes straight back to ambiguous with nothing else rewritten.
    await owner.query(
      "UPDATE review_items SET status = 'dismissed' WHERE id = 'accepted-usd'",
    );
    await owner.query(
      `INSERT INTO review_items
         (id, kind, raw_value, reason, status, reason_code,
          institution_id, matched_instrument_id, occurrence_count)
       VALUES ('reflagged-usd', 'weak_instrument_match', 'descriptor',
               'the acceptance was withdrawn', 'open',
               'institution_symbol_match_invalidated', $1, 'instrument-usd', 1)`,
      [seeded.settled.id],
    );
    const withdrawn = await serve(r, {
      operation: "get_holdings_snapshot",
      accountId: snapshot.accountId,
      snapshot: { mode: "exact", asOf: snapshot.asOf },
    });
    assert.equal(
      new Map(
        withdrawn.items.map((item) => [item.recordId, item.instrument.status]),
      ).get("pos:cited-usd"),
      "ambiguous",
    );
    assert.equal(withdrawn.summary.institutionSymbolInstrumentCount, 0);
    assert.equal(withdrawn.summary.unresolvedInstrumentCount, 1);
    assert.ok(withdrawn.coverage.reasons.includes("unresolved_identity"));
  },
);

// --- ADM-2: list_account_inventory -----------------------------------------

/**
 * Replaces one account's money rows with exactly the scenario named, so a
 * `currentValue` assertion is about the rule under test and nothing else.
 *
 * `balances` are `[asOf, totalValue, currency, cash]` and `positions` are
 * `[asOf, marketValue, currency, valuationBasis, sourceDocumentId]`, both
 * with `null` allowed wherever the column is nullable, which is the whole
 * point: an archive whose every column is populated is not the archive this
 * rule exists for.
 */
async function moneyRows(owner, accountId, { balances = [], positions = [] }) {
  await owner.query("DELETE FROM positions WHERE account_id = $1", [accountId]);
  await owner.query("DELETE FROM balances WHERE account_id = $1", [accountId]);
  let index = 0;
  for (const [asOf, totalValue, currency, cash = null] of balances) {
    index += 1;
    await owner.query(
      `INSERT INTO balances (id, account_id, as_of, total_value, currency, cash)
       VALUES ($1, $2, $3::date, $4::numeric, $5, $6::numeric)`,
      [`cv-balance-${index}`, accountId, asOf, totalValue, currency, cash],
    );
  }
  index = 0;
  for (const [
    asOf,
    marketValue,
    currency,
    basis = "market_price",
    sourceDocumentId = null,
  ] of positions) {
    index += 1;
    await owner.query(
      `INSERT INTO positions
         (id, account_id, as_of, market_value, currency, valuation_basis,
          source_document_id)
       VALUES ($1, $2, $3::date, $4::numeric, $5, $6, $7)`,
      [
        `cv-position-${index}`,
        accountId,
        asOf,
        marketValue,
        currency,
        basis,
        sourceDocumentId,
      ],
    );
  }
}

test(
  "list_account_inventory withholds a holdings value when any position on the date has no market value (ADM-2)",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const accountId = seeded.settled.accountIds[0];
    const inventory = async () =>
      (
        await serve(r, { operation: "list_account_inventory", limit: 100 })
      ).items.find((item) => item.account.accountId === accountId);

    // The reviewer's fixture: a valued USD position beside two unvalued ones,
    // one of them in another currency, and no balance to fall back on. Summing
    // what happens to carry a market value would report 100 as the account's
    // value and would never notice the EUR row at all.
    await moneyRows(owner, accountId, {
      positions: [
        ["2026-03-31", "100", "USD"],
        ["2026-03-31", null, "USD"],
        ["2026-03-31", null, "EUR"],
      ],
    });
    assert.equal((await inventory()).currentValue, undefined);

    // One unvalued row in the same currency is still a hole in the total.
    await moneyRows(owner, accountId, {
      positions: [
        ["2026-03-31", "100", "USD"],
        ["2026-03-31", null, "USD"],
      ],
    });
    assert.equal((await inventory()).currentValue, undefined);

    // Mixed currencies with every row valued: still no single figure.
    await moneyRows(owner, accountId, {
      positions: [
        ["2026-03-31", "100", "USD"],
        ["2026-03-31", "80", "EUR"],
      ],
    });
    assert.equal((await inventory()).currentValue, undefined);

    // The positive control: every row on the date valued, one currency.
    await moneyRows(owner, accountId, {
      positions: [
        ["2026-03-31", "100", "USD"],
        ["2026-03-31", "80", "USD"],
      ],
    });
    assert.deepEqual((await inventory()).currentValue, {
      value: { decimal: "180", currency: "USD" },
      asOf: "2026-03-31",
      source: "positions",
    });

    // An earlier date's hole says nothing about the date being reported.
    await moneyRows(owner, accountId, {
      positions: [
        ["2026-01-31", null, "USD"],
        ["2026-03-31", "100", "USD"],
      ],
    });
    assert.deepEqual((await inventory()).currentValue, {
      value: { decimal: "100", currency: "USD" },
      asOf: "2026-03-31",
      source: "positions",
    });
  },
);

test(
  "list_account_inventory prefers a balance's own total over later holdings, dated by the balance (ADM-2)",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const accountId = seeded.settled.accountIds[0];
    const inventory = async () =>
      (
        await serve(r, { operation: "list_account_inventory", limit: 100 })
      ).items.find((item) => item.account.accountId === accountId);

    // A single later position is a fragment of the account, not the account.
    await moneyRows(owner, accountId, {
      balances: [["2026-02-28", "1000000", "USD"]],
      positions: [["2026-03-15", "5", "USD"]],
    });
    assert.deepEqual((await inventory()).currentValue, {
      value: { decimal: "1000000", currency: "USD" },
      asOf: "2026-02-28",
      source: "balance",
    });

    // The same rule with a plausible-looking pair: the balance includes cash
    // the holdings do not, so 101 is not this account's value.
    await moneyRows(owner, accountId, {
      balances: [["2026-02-28", "1000", "USD"]],
      positions: [["2026-03-31", "101", "USD"]],
    });
    assert.deepEqual((await inventory()).currentValue, {
      value: { decimal: "1000", currency: "USD" },
      asOf: "2026-02-28",
      source: "balance",
    });

    // And across currencies: the later USD holdings never replace the balance.
    await moneyRows(owner, accountId, {
      balances: [["2026-02-28", "1000", "EUR"]],
      positions: [["2026-03-31", "100", "USD"]],
    });
    assert.deepEqual((await inventory()).currentValue, {
      value: { decimal: "1000", currency: "EUR" },
      asOf: "2026-02-28",
      source: "balance",
    });

    // Two balances on the latest dated total: ambiguous, and the holdings do
    // not get to answer in their place.
    await moneyRows(owner, accountId, {
      balances: [
        ["2026-02-28", "1000", "USD"],
        ["2026-02-28", "900", "EUR"],
      ],
      positions: [["2026-03-31", "100", "USD"]],
    });
    assert.equal((await inventory()).currentValue, undefined);

    // A latest balance with no total falls back to the last balance that has
    // one, dated by that older row rather than by the empty newer one.
    await moneyRows(owner, accountId, {
      balances: [
        ["2026-01-31", "700", "USD"],
        ["2026-02-28", null, "USD"],
      ],
    });
    assert.deepEqual((await inventory()).currentValue, {
      value: { decimal: "700", currency: "USD" },
      asOf: "2026-01-31",
      source: "balance",
    });

    // Positions answer only when no balance anywhere carries a total.
    await moneyRows(owner, accountId, {
      balances: [["2026-02-28", null, "USD"]],
      positions: [["2026-03-31", "101", "USD"]],
    });
    assert.deepEqual((await inventory()).currentValue, {
      value: { decimal: "101", currency: "USD" },
      asOf: "2026-03-31",
      source: "positions",
    });
  },
);

test(
  "list_account_inventory reports balance dates, the all-cash flag, and one total from agreeing duplicate balances (FIN-FRESHNESS-1)",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const accountId = seeded.settled.accountIds[0];
    const inventory = async () =>
      (
        await serve(r, { operation: "list_account_inventory", limit: 100 })
      ).items.find((item) => item.account.accountId === accountId);

    // One statement imported as two balance rows with the same total, one of
    // them also stating cash: the same answer twice is not a choice.
    await moneyRows(owner, accountId, {
      balances: [
        ["2026-03-31", "1000", "USD", "10"],
        ["2026-03-31", "1000", "USD"],
        ["2025-12-31", "900", "USD", "10"],
        ["2025-09-30", "800", "USD", "10"],
      ],
      positions: [["2026-03-31", "990", "USD"]],
    });
    let row = await inventory();
    assert.deepEqual(row.currentValue, {
      value: { decimal: "1000", currency: "USD" },
      asOf: "2026-03-31",
      source: "balance",
    });
    assert.deepEqual(row.balanceDates, [
      "2026-03-31",
      "2025-12-31",
      "2025-09-30",
    ]);
    assert.equal(row.latestBalanceHoldsSecurities, true);

    // All cash on the latest date: nothing besides cash is held.
    await moneyRows(owner, accountId, {
      balances: [
        ["2026-03-31", "25", "USD", "25"],
        ["2025-12-31", "900", "USD", "10"],
      ],
      positions: [["2025-12-31", "890", "USD"]],
    });
    row = await inventory();
    assert.equal(row.latestBalanceHoldsSecurities, false);
    assert.equal(row.latestSnapshotAsOf, "2025-12-31");

    // The latest date states no cash: the flag is absent, never carried
    // forward from an older date.
    await moneyRows(owner, accountId, {
      balances: [
        ["2026-03-31", "1000", "USD"],
        ["2025-12-31", "25", "USD", "25"],
      ],
    });
    row = await inventory();
    assert.equal(row.latestBalanceHoldsSecurities, undefined);
    assert.deepEqual(row.balanceDates, ["2026-03-31", "2025-12-31"]);

    // Rows on the latest date that disagree about holding securities: absent.
    await moneyRows(owner, accountId, {
      balances: [
        ["2026-03-31", "1000", "USD", "1000"],
        ["2026-03-31", "1000", "USD", "10"],
      ],
    });
    assert.equal((await inventory()).latestBalanceHoldsSecurities, undefined);

    // At most twelve dates, newest first; no balances at all is no field.
    await moneyRows(owner, accountId, {
      balances: Array.from({ length: 14 }, (_, i) => [
        `2025-${String(i < 12 ? 12 - i : 1).padStart(2, "0")}-${i < 12 ? "01" : String(10 + i)}`,
        "1",
        "USD",
      ]),
    });
    row = await inventory();
    assert.equal(row.balanceDates.length, 12);
    assert.equal(row.balanceDates[0], "2025-12-01");
    await moneyRows(owner, accountId, {});
    row = await inventory();
    assert.equal(row.balanceDates, undefined);
    assert.equal(row.latestBalanceHoldsSecurities, undefined);
  },
);

test(
  "list_account_inventory rejects a mixed-source date until every source parses completely (FIN-FRESHNESS-1)",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const accountId = seeded.settled.accountIds[0];
    const priorDoc = await document(
      owner,
      seeded.settled.id,
      accountId,
      "2026-03-31",
    );
    const latestCompleteDoc = await document(
      owner,
      seeded.settled.id,
      accountId,
      "2026-04-30",
    );
    const latestPartialDoc = await document(
      owner,
      seeded.settled.id,
      accountId,
      "2026-04-30",
    );
    const inventory = async () =>
      (
        await serve(r, { operation: "list_account_inventory", limit: 100 })
      ).items.find((item) => item.account.accountId === accountId);

    await moneyRows(owner, accountId, {
      positions: [
        ["2026-03-31", "100", "USD", "market_price", priorDoc],
        [
          "2026-04-30",
          "5",
          "USD",
          "market_price",
          latestCompleteDoc,
        ],
        [
          "2026-04-30",
          "7",
          "USD",
          "market_price",
          latestPartialDoc,
        ],
      ],
    });
    // This is the durable state the importer writes when one of multiple
    // sources for an account/date is only partially parsed. The complete
    // source must not let that fragmentary date advance. The safety decision
    // comes from `parsed_ok`, not mutable review workflow or attribution.
    await owner.query(
      "UPDATE documents SET parsed_ok = FALSE WHERE id = $1",
      [latestPartialDoc],
    );
    await owner.query(
      `INSERT INTO review_items
         (id, kind, account_id, source_document_id, raw_value, reason, status)
       VALUES ('snapshot-review-latest', 'document_unparsed', NULL, $1,
               'partial statement', 'synthetic parser left holdings unparsed', 'resolved')`,
      [latestPartialDoc],
    );

    let row = await inventory();
    assert.equal(row.latestSnapshotAsOf, "2026-03-31");
    assert.deepEqual(row.currentValue, {
      value: { decimal: "100", currency: "USD" },
      asOf: "2026-03-31",
      source: "positions",
    });
    assert.equal(row.openReviewCount, 0);

    await owner.query(
      "UPDATE review_items SET status = 'dismissed' WHERE id = 'snapshot-review-latest'",
    );
    row = await inventory();
    assert.equal(
      row.latestSnapshotAsOf,
      "2026-03-31",
      "dismissing the review cannot make an incomplete document a snapshot",
    );

    // A successful reparse is the only transition that makes the statement
    // eligible. Its historical review may remain dismissed without changing
    // that source-evidence fact.
    await owner.query(
      "UPDATE documents SET parsed_ok = TRUE WHERE id = $1",
      [latestPartialDoc],
    );
    row = await inventory();
    assert.equal(row.latestSnapshotAsOf, "2026-04-30");
    assert.deepEqual(row.currentValue, {
      value: { decimal: "12", currency: "USD" },
      asOf: "2026-04-30",
      source: "positions",
    });
  },
);

test(
  "list_account_inventory does not advance the holdings snapshot from a failed position gate (FIN-FRESHNESS-1)",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const accountId = seeded.settled.accountIds[0];
    const priorDoc = await document(
      owner,
      seeded.settled.id,
      accountId,
      "2026-03-31",
    );
    const latestDoc = await document(
      owner,
      seeded.settled.id,
      accountId,
      "2026-04-30",
    );
    const inventory = async () =>
      (
        await serve(r, { operation: "list_account_inventory", limit: 100 })
      ).items.find((item) => item.account.accountId === accountId);

    await owner.query(
      `INSERT INTO instruments (id, symbol, name)
       VALUES ('snapshot-gate-instrument', 'SGI', 'Synthetic Gate Instrument')
       ON CONFLICT (id) DO NOTHING`,
    );
    await moneyRows(owner, accountId, {
      positions: [
        ["2026-03-31", "100", "USD", "market_price", priorDoc],
        ["2026-04-30", "105", "USD", "market_price", latestDoc],
      ],
    });
    await owner.query(
      `INSERT INTO position_reconciliations
         (id, account_id, instrument_id, period_start, period_end, status)
       VALUES ('snapshot-gate-unverified', $1, 'snapshot-gate-instrument',
               '2026-03-31'::date, '2026-04-30'::date, 'unverified')`,
      [accountId],
    );

    let row = await inventory();
    assert.equal(row.latestSnapshotAsOf, "2026-03-31");
    assert.deepEqual(row.currentValue, {
      value: { decimal: "100", currency: "USD" },
      asOf: "2026-03-31",
      source: "positions",
    });

    await owner.query(
      "UPDATE position_reconciliations SET status = 'pass' WHERE id = 'snapshot-gate-unverified'",
    );
    row = await inventory();
    assert.equal(row.latestSnapshotAsOf, "2026-04-30");
    assert.deepEqual(row.currentValue, {
      value: { decimal: "105", currency: "USD" },
      asOf: "2026-04-30",
      source: "positions",
    });
  },
);

test(
  "list_account_inventory withholds a holdings value unless every position is marked at market price (ADM-2)",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const accountId = seeded.settled.accountIds[0];
    const inventory = async () =>
      (
        await serve(r, { operation: "list_account_inventory", limit: 100 })
      ).items.find((item) => item.account.accountId === accountId);

    // The reviewer's fixture: 5100 is a marked security added to something
    // carried at cost, which is the mix `pgSchema.ts` warns about.
    await moneyRows(owner, accountId, {
      positions: [
        ["2026-03-31", "100", "USD", "market_price"],
        ["2026-03-31", "5000", "USD", "cost"],
      ],
    });
    assert.equal((await inventory()).currentValue, undefined);

    // Cost alone is no better: it is not what the account is worth.
    await moneyRows(owner, accountId, {
      positions: [["2026-03-31", "5000", "USD", "cost"]],
    });
    assert.equal((await inventory()).currentValue, undefined);

    // Nor is any other basis in the vocabulary, alone or mixed.
    for (const basis of ["last_round", "reported_nav"]) {
      await moneyRows(owner, accountId, {
        positions: [["2026-03-31", "5000", "USD", basis]],
      });
      assert.equal((await inventory()).currentValue, undefined, basis);
      await moneyRows(owner, accountId, {
        positions: [
          ["2026-03-31", "100", "USD", "market_price"],
          ["2026-03-31", "5000", "USD", basis],
        ],
      });
      assert.equal(
        (await inventory()).currentValue,
        undefined,
        `${basis} mixed`,
      );
    }

    // An unstated basis is the same refusal `financeHoldingRecord` already
    // makes: without it there is no telling a marked security from one at
    // cost, so there is no total either.
    await moneyRows(owner, accountId, {
      positions: [["2026-03-31", "100", "USD", null]],
    });
    assert.equal((await inventory()).currentValue, undefined);

    await moneyRows(owner, accountId, {
      positions: [
        ["2026-03-31", "100", "USD", "market_price"],
        ["2026-03-31", "80", "USD", null],
      ],
    });
    assert.equal((await inventory()).currentValue, undefined);

    // The positive control, once more with the basis stated on every row.
    await moneyRows(owner, accountId, {
      positions: [
        ["2026-03-31", "100", "USD", "market_price"],
        ["2026-03-31", "80", "USD", "market_price"],
      ],
    });
    assert.deepEqual((await inventory()).currentValue, {
      value: { decimal: "180", currency: "USD" },
      asOf: "2026-03-31",
      source: "positions",
    });
  },
);

test(
  "list_account_inventory reports a current value from the latest balance or holdings, never across currencies (ADM-2)",
  { skip },
  async (t) => {
    const { owner, reader: r, seeded } = await fixture(t);
    const snapshot = await citedSnapshot(owner, seeded);
    const inventory = async () =>
      (
        await serve(r, { operation: "list_account_inventory", limit: 100 })
      ).items.find((item) => item.account.accountId === snapshot.accountId);

    // The cited snapshot has two balances on its date (one per currency) and
    // holdings in two currencies: no single figure the archive can stand
    // behind, from either side.
    assert.equal((await inventory()).currentValue, undefined);

    // Dropping the EUR positions does not help while the two balances stand:
    // a balance with a total is what answers, and there are two of them.
    await owner.query("DELETE FROM positions WHERE currency = 'EUR'");
    assert.equal((await inventory()).currentValue, undefined);

    // One balance left, and it answers with its own date -- not the holdings'.
    await owner.query("DELETE FROM balances WHERE currency = 'EUR'");
    const stated = await inventory();
    assert.equal(stated.currentValue.source, "balance");
    assert.equal(stated.currentValue.asOf, snapshot.asOf);
    assert.deepEqual(stated.currentValue.value, {
      decimal: "205",
      currency: "USD",
    });

    // A later balance is the latest figure the archive has.
    await owner.query(
      `INSERT INTO balances (id, account_id, as_of, total_value, currency)
       VALUES ('balance-later', $1, $2::date + 30, '999', 'USD')`,
      [snapshot.accountId, snapshot.asOf],
    );
    const later = await inventory();
    assert.equal(later.currentValue.source, "balance");
    assert.deepEqual(later.currentValue.value, {
      decimal: "999",
      currency: "USD",
    });

    // With every balance gone the cited holdings answer, summed on their own
    // latest date and in their own currency.
    await owner.query("DELETE FROM balances WHERE account_id = $1", [
      snapshot.accountId,
    ]);
    const held = await inventory();
    assert.equal(held.currentValue.source, "positions");
    assert.equal(held.currentValue.asOf, snapshot.asOf);
    assert.deepEqual(held.currentValue.value, {
      decimal: "200",
      currency: "USD",
    });
  },
);

test(
  "list_account_inventory reports one row per account, with the counts and dates the archive actually holds (ADM-2)",
  { skip },
  async (t) => {
    const { reader: r, seeded } = await fixture(t);
    const response = await serve(r, {
      operation: "list_account_inventory",
      limit: 100,
    });
    assert.equal(response.operation, "list_account_inventory");
    const byAccount = new Map(
      response.items.map((item) => [item.account.accountId, item]),
    );

    // The seeded institution has one statement document and five
    // transactions, dated 2026-01-10 through 2026-01-23.
    const settled = byAccount.get(seeded.settled.accountIds[0]);
    assert.ok(settled, "expected the settled account to be inventoried");
    assert.equal(settled.statementCount, 1);
    assert.equal(settled.recordCount, 5);
    assert.equal(settled.activityFrom, "2026-01-10");
    assert.equal(settled.activityTo, "2026-01-23");
    // No positions were seeded for it, so there is no snapshot to report.
    assert.equal(settled.latestSnapshotAsOf, undefined);
    assert.equal(settled.openReviewCount, 0);

    // The one open review item in the fixture is on the under-review account,
    // and it is the only account that reports one.
    const underReview = byAccount.get(seeded.underReview.accountIds[0]);
    assert.equal(underReview.openReviewCount, 1);
    assert.equal(
      response.items.filter((item) => item.openReviewCount > 0).length,
      1,
    );

    // An institution with accounts and nothing acquired is a row of zeros and
    // no dates, never an absent row: that is the whole point of the screen
    // this operation feeds.
    const empty = response.items.filter((item) =>
      item.account.institutionName.includes("quiet-harbor"),
    );
    assert.equal(empty.length, 1);
    assert.equal(empty[0].statementCount, 0);
    assert.equal(empty[0].recordCount, 0);
    assert.equal(empty[0].activityFrom, undefined);
    assert.equal(empty[0].activityTo, undefined);
  },
);

test(
  "list_account_inventory pages on a signed cursor and refuses another space (ADM-2)",
  { skip },
  async (t) => {
    const { reader: r } = await fixture(t);
    const first = await serve(r, {
      operation: "list_account_inventory",
      limit: 1,
    });
    assert.equal(first.items.length, 1);
    assert.equal(first.truncated, true);
    assert.ok(first.nextCursor);
    const second = await serve(r, {
      operation: "list_account_inventory",
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(second.items.length, 1);
    assert.notEqual(
      second.items[0].account.accountId,
      first.items[0].account.accountId,
    );

    const parsed = parseFinanceReadRequest({
      contractVersion: 1,
      spaceId: "space-synthetic-other",
      limit: 10,
      operation: "list_account_inventory",
    });
    await assert.rejects(
      serveFinanceRead(r.client, parsed, SPACE, {
        principalId: TRUSTED.principalId,
        cursorSigningSecret:
          "synthetic-finance-cursor-secret-at-least-32-bytes",
      }),
      /not_authorized/,
    );
  },
);
