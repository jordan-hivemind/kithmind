import assert from "node:assert/strict";
import test from "node:test";

import {
  compareDecimal,
  createSyntheticSession,
  exhaustiveListing,
  incompleteListing,
  sha256Hex,
  syntheticAdapter,
} from "../dist/index.js";

// This suite is the acceptance test for the adapter interface itself: it
// runs the synthetic reference adapter through all three capability tiers
// against generated fixtures, with no real institution, account, credential
// or private file anywhere in it.

test("capabilities() declares all three tiers and carries no credential-shaped field", () => {
  const capabilities = syntheticAdapter.capabilities();
  assert.equal(capabilities.institutionSlug, "thistlebrook-trust");
  assert.deepEqual(
    [...capabilities.tiers].sort(),
    ["pdf_statement", "structured_api", "tabular_export", "trade_confirmation"],
  );
  assert.ok(capabilities.retentionWindow.earliest);
  assert.ok(capabilities.quirks.length > 0);
  const serialized = JSON.stringify(capabilities).toLowerCase();
  for (const forbidden of ["credential", "password", "token", "cookie", "secret"]) {
    assert.ok(!serialized.includes(forbidden), `capabilities() must not mention "${forbidden}"`);
  }
});

test("Listing: exhaustive requires items to reconcile against the provider's total", () => {
  assert.deepEqual(exhaustiveListing(["a", "b"], 2), {
    status: "exhaustive",
    items: ["a", "b"],
    providerTotal: 2,
  });
  // A provider reporting zero is exhaustively representable...
  assert.deepEqual(exhaustiveListing([], 0), { status: "exhaustive", items: [], providerTotal: 0 });
  // ...but a mismatch is refused rather than silently accepted as complete.
  assert.throws(() => exhaustiveListing(["a"], 2), /refusing to mark a listing exhaustive/);
});

test("Listing: incomplete distinguishes a reported total from no total at all", () => {
  const reportedButShort = incompleteListing(["a"], 5, "stopped after page 1");
  assert.equal(reportedButShort.providerTotal, 5);
  const noTotal = incompleteListing(["a", "b"], null, "provider does not report a total");
  assert.equal(noTotal.providerTotal, null);
  // Same item count, different meaning: one caller can assert a shortfall
  // against 5, the other has nothing to assert against at all.
  assert.notEqual(reportedButShort.providerTotal, noTotal.providerTotal);
});

test("discover() returns an exhaustive document listing when the provider's count is reachable", async () => {
  const result = await syntheticAdapter.discover(createSyntheticSession());
  assert.equal(result.documents.status, "exhaustive");
  assert.equal(result.documents.providerTotal, result.documents.items.length);
  assert.ok(result.documents.items.length > 0);
  for (const doc of result.documents.items) {
    assert.ok(["pdf_statement", "trade_confirmation"].includes(doc.kind));
  }
  const kinds = result.exportRanges.map((range) => range.kind).sort();
  assert.deepEqual(kinds, ["structured_api", "tabular_export"]);
});

test("discover() never claims completeness when the pull came up short of a stated total", async () => {
  const session = createSyntheticSession({ documentsLimit: 1 });
  const result = await syntheticAdapter.discover(session);
  assert.equal(result.documents.status, "incomplete");
  assert.equal(result.documents.items.length, 1);
  assert.equal(typeof result.documents.providerTotal, "number");
  assert.ok(result.documents.providerTotal > 1);
  assert.ok(result.documents.reason.length > 0);
});

test("discover() distinguishes 'provider reported no total' from 'provider reported zero'", async () => {
  const full = await syntheticAdapter.discover(createSyntheticSession());
  const withheldTotal = await syntheticAdapter.discover(
    createSyntheticSession({ omitDocumentsTotal: true }),
  );
  // Same documents either way...
  assert.equal(withheldTotal.documents.items.length, full.documents.items.length);
  // ...but ground rule 7 forbids calling it exhaustive without a stated total,
  // even though every document was in fact returned.
  assert.equal(withheldTotal.documents.status, "incomplete");
  assert.equal(withheldTotal.documents.providerTotal, null);
  assert.equal(full.documents.status, "exhaustive");
  assert.notEqual(full.documents.providerTotal, null);

  const tabularRange = full.exportRanges.find((range) => range.kind === "tabular_export");
  const apiRange = full.exportRanges.find((range) => range.kind === "structured_api");
  assert.equal(tabularRange.reportedRowCount, null); // documented quirk: never reported
  assert.equal(typeof apiRange.reportedRowCount, "number");
});

test("acquire() on the structured API tier is deterministic and carries no gap on a clean pull", async () => {
  const session = createSyntheticSession();
  const first = await syntheticAdapter.acquire({
    kind: "structured_api",
    session,
    periodStart: "2025-01-01",
    periodEnd: "2025-04-01",
  });
  const second = await syntheticAdapter.acquire({
    kind: "structured_api",
    session,
    periodStart: "2025-01-01",
    periodEnd: "2025-04-01",
  });
  assert.equal(first.manifest.contentHash, second.manifest.contentHash);
  assert.equal(first.manifest.contentHash, sha256Hex(first.bytes));
  assert.equal(first.manifest.gaps.length, 0);
  assert.equal(typeof first.manifest.reportedRowCount, "number");
});

test("acquire() records a gap, not a silent truncation, when a page fetch fails mid-pull", async () => {
  const session = createSyntheticSession({ activityFailAtPage: 2 });
  const acquired = await syntheticAdapter.acquire({
    kind: "structured_api",
    session,
    periodStart: "2025-01-01",
    periodEnd: "2025-04-01",
  });
  assert.equal(acquired.manifest.gaps.length, 1);
  assert.match(acquired.manifest.gaps[0].reason, /page 2/);
  // The provider's claimed total survives the failure, so an importer can
  // still see exactly how far short this pull fell.
  assert.equal(typeof acquired.manifest.reportedRowCount, "number");
  const { activity } = await syntheticAdapter.parse({ kind: "structured_api", bytes: acquired.bytes });
  assert.ok(activity.length < acquired.manifest.reportedRowCount);
});

test("acquire() on the tabular export tier records the documented no-total quirk", async () => {
  const session = createSyntheticSession();
  const acquired = await syntheticAdapter.acquire({
    kind: "tabular_export",
    session,
    periodStart: "2025-01-01",
    periodEnd: "2025-04-01",
  });
  assert.equal(acquired.manifest.reportedRowCount, null);
  assert.equal(acquired.manifest.gaps.length, 0);
});

test("acquire() on a document tier fetches exactly the discovered document and rejects an unknown id", async () => {
  const session = createSyntheticSession();
  const { documents } = await syntheticAdapter.discover(session);
  const statement = documents.items.find((doc) => doc.kind === "pdf_statement");
  const acquired = await syntheticAdapter.acquire({
    kind: "pdf_statement",
    session,
    externalId: statement.externalId,
  });
  assert.equal(acquired.manifest.periodStart, statement.periodStart);
  assert.equal(acquired.manifest.periodEnd, statement.periodEnd);
  assert.equal(acquired.manifest.contentHash, sha256Hex(acquired.bytes));
  await assert.rejects(
    () =>
      syntheticAdapter.acquire({ kind: "pdf_statement", session, externalId: "not-a-real-id" }),
    /unknown document/,
  );
});

test("parse() on overlapping structured-API pages surfaces the raw overlap and tags each row's page, and declines holdings honestly", async () => {
  const session = createSyntheticSession();
  const acquired = await syntheticAdapter.acquire({
    kind: "structured_api",
    session,
    periodStart: "2025-01-01",
    periodEnd: "2025-04-01",
  });
  const { activity: rows, holdings } = await syntheticAdapter.parse({
    kind: "structured_api",
    bytes: acquired.bytes,
  });
  assert.ok(rows.length > acquired.manifest.reportedRowCount, "the raw pull includes the overlap");
  // An activity-only source is not asked to invent holdings it does not
  // have: it declines with an explicit empty ParsedHoldings, not an omitted
  // field a caller has to guess the meaning of.
  assert.deepEqual(holdings, { positions: [], balances: [], liabilities: [] });

  // parse() does not dedupe; it only tags each row with which page it came
  // from (sourceDocument), which is what lets a caller scope the importer's
  // occurrence ordinal to the right document and collapse the overlap
  // correctly. See test/adapterImport.test.mjs for the actual import and
  // dedupe, end to end through the F1-3 importer -- rowHash requires a
  // supplied occurrence now (F1-12), so it can no longer be computed
  // correctly from a flat, unscoped row list the way this test used to.
  const pageKeys = new Set(rows.map((row) => row.sourceDocument));
  assert.ok(pageKeys.size > 1, "the pull spans more than one page document");

  for (const row of rows) {
    assert.ok(row.amount === null || typeof row.amount === "string");
    assert.ok(row.quantity === null || typeof row.quantity === "string");
    assert.ok(row.price === null || typeof row.price === "string");
    assert.ok(row.locators.row, "every row locates itself in its source");
    assert.equal(typeof row.sourceDocument, "string");
    assert.ok(row.sourceDocument.length > 0);
  }
});

test("parse() on the tabular export cross-checks the same activity the structured API reports", async () => {
  const session = createSyntheticSession();
  const apiAcquired = await syntheticAdapter.acquire({
    kind: "structured_api",
    session,
    periodStart: "2025-01-01",
    periodEnd: "2025-04-01",
  });
  const { activity: apiRows } = await syntheticAdapter.parse({
    kind: "structured_api",
    bytes: apiAcquired.bytes,
  });

  const tabularAcquired = await syntheticAdapter.acquire({
    kind: "tabular_export",
    session,
    periodStart: "2025-01-01",
    periodEnd: "2025-04-01",
  });
  const { activity: tabularRows } = await syntheticAdapter.parse({
    kind: "tabular_export",
    bytes: tabularAcquired.bytes,
  });

  // The tabular export has no pagination, so it never double-counts.
  assert.equal(tabularRows.length, apiAcquired.manifest.reportedRowCount);
  assert.ok(tabularRows.every((row) => row.externalId === null)); // documented quirk

  const sampleDescription = apiRows[0].description;
  assert.ok(tabularRows.some((row) => row.description === sampleDescription));
});

test("parse() signs quantity by direction: a disposal is negative, an acquisition positive", async () => {
  const session = createSyntheticSession();
  const acquired = await syntheticAdapter.acquire({
    kind: "structured_api",
    session,
    periodStart: "2025-01-01",
    periodEnd: "2025-04-01",
  });
  const { activity: rows } = await syntheticAdapter.parse({
    kind: "structured_api",
    bytes: acquired.bytes,
  });

  const buys = rows.filter((row) => row.activityType === "buy");
  const sells = rows.filter((row) => row.activityType === "sell");
  assert.ok(buys.length > 0 && sells.length > 0);

  // The position gate replays these quantities against a stated position
  // change, so an unsigned disposal would read as an acquisition and fail
  // every period containing a sale. The sign lives on quantity itself and
  // cannot be recovered from activityType, which is free provider text.
  assert.ok(buys.every((row) => compareDecimal(row.quantity, "0") > 0));
  assert.ok(sells.every((row) => compareDecimal(row.quantity, "0") < 0));

  // Cash and quantity carry opposite signs on a trade: a sale pays in and
  // reduces the holding.
  assert.ok(sells.every((row) => compareDecimal(row.amount, "0") > 0));
  assert.ok(buys.every((row) => compareDecimal(row.amount, "0") < 0));
});

test("parse() on a PDF statement surfaces the ambiguous row as null with a note, not a guess", async () => {
  const session = createSyntheticSession();
  const { documents } = await syntheticAdapter.discover(session);
  const statement = documents.items.find((doc) => doc.kind === "pdf_statement");
  const acquired = await syntheticAdapter.acquire({
    kind: "pdf_statement",
    session,
    externalId: statement.externalId,
  });
  const { activity: rows } = await syntheticAdapter.parse({ kind: "pdf_statement", bytes: acquired.bytes });

  const ambiguous = rows.filter((row) => row.amount === null);
  assert.equal(ambiguous.length, 1);
  assert.ok(ambiguous[0].amountNote.length > 0);
  assert.ok(ambiguous[0].locators.amount, "the ambiguous field has its own locator");

  const resolved = rows.filter((row) => row.amount !== null);
  assert.ok(resolved.length > 0);
  for (const row of resolved) {
    assert.equal(row.amountNote, null);
    assert.equal(typeof row.amount, "string");
  }
});

test("parse() on a PDF statement's positions table separates a marked position from one carried at cost, and surfaces an ambiguous market value as null with a note", async () => {
  const session = createSyntheticSession();
  const { documents } = await syntheticAdapter.discover(session);
  const statement = documents.items.find((doc) => doc.kind === "pdf_statement");
  const acquired = await syntheticAdapter.acquire({
    kind: "pdf_statement",
    session,
    externalId: statement.externalId,
  });
  const { holdings } = await syntheticAdapter.parse({ kind: "pdf_statement", bytes: acquired.bytes });

  assert.ok(holdings.positions.length >= 3);
  assert.ok(holdings.balances.length >= 1);
  assert.ok(holdings.liabilities.length >= 1);

  const marked = holdings.positions.filter((p) => p.valuationBasis === "market_price");
  const atCost = holdings.positions.filter((p) => p.valuationBasis === "cost");
  assert.ok(marked.length > 0);
  assert.ok(atCost.length > 0);
  // Every position states a basis and a note; F1-16's whole point is that
  // this is never left for a total-assets query to assume.
  for (const position of holdings.positions) {
    assert.ok(position.valuationBasis === null || typeof position.valuationBasis === "string");
    assert.ok(position.valuationNote.length > 0);
  }

  const ambiguous = holdings.positions.filter((p) => p.marketValue === null);
  assert.equal(ambiguous.length, 1);
  assert.ok(ambiguous[0].marketValueNote.length > 0);
  assert.ok(ambiguous[0].locators.marketValue, "the ambiguous field has its own locator");

  // Multi-currency: at least one holding stays in its own currency, not USD.
  const currencies = new Set(holdings.positions.map((p) => p.currency));
  assert.ok(currencies.has("EUR"));
  assert.ok(currencies.has("USD"));
});

test("parse() on a trade confirmation preserves the original currency without converting it, and carries no holdings", async () => {
  const session = createSyntheticSession();
  const acquired = await syntheticAdapter.acquire({
    kind: "trade_confirmation",
    session,
    externalId: "doc-conf-2025-02-10",
  });
  const { activity: rows, holdings } = await syntheticAdapter.parse({
    kind: "trade_confirmation",
    bytes: acquired.bytes,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].currency, "EUR");
  assert.equal(typeof rows[0].quantity, "string");
  assert.equal(typeof rows[0].price, "string");
  assert.equal(typeof rows[0].amount, "string");
  assert.deepEqual(holdings, { positions: [], balances: [], liabilities: [] });
});

test("no adapter output anywhere in this suite mentions anything credential-shaped", async () => {
  const session = createSyntheticSession();
  const discovered = await syntheticAdapter.discover(session);
  const acquired = await syntheticAdapter.acquire({
    kind: "structured_api",
    session,
    periodStart: "2025-01-01",
    periodEnd: "2025-04-01",
  });
  const parsed = await syntheticAdapter.parse({ kind: "structured_api", bytes: acquired.bytes });
  const serialized = JSON.stringify({
    discovered,
    manifest: acquired.manifest,
    parsed,
  }).toLowerCase();
  for (const forbidden of ["credential", "password", "authtoken", "cookie", "secret"]) {
    assert.ok(!serialized.includes(forbidden), `output must not mention "${forbidden}"`);
  }
});
