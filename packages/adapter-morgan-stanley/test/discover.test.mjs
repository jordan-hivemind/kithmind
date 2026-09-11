import { test } from "node:test";
import assert from "node:assert/strict";
import adapter, { documentTimeFrames, selectDateRangeType } from "../src/adapter.mjs";
import { createFixtureSession } from "../fixtures/session.mjs";
import {
  STATEMENT_DOCS,
  CONFIRMATION_DOCS,
  PAGINATED_STATEMENT_DOCS,
  OLDEST_YEAR,
  NEWER_YEAR,
  MOST_RECENT_YEAR,
  OVERLAP_DOC,
  LAST12MONTHS_ONLY_DOC,
} from "../fixtures/documents.mjs";

test("discover returns an exhaustive listing when the provider states a total for every doc type", async () => {
  const session = createFixtureSession({ documentsMode: "exhaustive" });
  const result = await adapter.discover(session);

  assert.equal(result.documents.status, "exhaustive");
  assert.equal(result.documents.items.length, STATEMENT_DOCS.length + CONFIRMATION_DOCS.length);
  assert.equal(result.documents.providerTotal, STATEMENT_DOCS.length + CONFIRMATION_DOCS.length);
  assert.ok(result.documents.items.every((d) => d.kind === "pdf_statement" || d.kind === "trade_confirmation"));
  // Ground rule: never an account number or name in a document label.
  assert.ok(result.documents.items.every((d) => !/MS-ACCT/.test(d.label)));

  assert.equal(result.exportRanges.length, 2);
  assert.deepEqual(
    result.exportRanges.map((r) => r.kind).sort(),
    ["structured_api", "tabular_export"],
  );
  for (const range of result.exportRanges) {
    assert.equal(range.reportedRowCount, null);
    assert.ok(typeof range.earliest === "string" && range.earliest.length > 0);
    assert.ok(typeof range.latest === "string" && range.latest.length > 0);
  }
});

test("discover never claims exhaustive when a doc type reports no total -- ground rule 7", async () => {
  const session = createFixtureSession({ documentsMode: "noTotal" });
  const result = await adapter.discover(session);

  assert.equal(result.documents.status, "incomplete");
  assert.match(result.documents.reason, /reported no total/);
  // What was actually seen is still returned, never discarded. The pull
  // stops at the first year that reports no total -- the oldest year in the
  // seven-year window, which the adapter queries first, and exactly where
  // these fixtures' items live.
  assert.equal(result.documents.items.length, STATEMENT_DOCS.length + CONFIRMATION_DOCS.length);
});

test("discover sets each document's accountExternalKey from the account it already encodes into externalId", async () => {
  const session = createFixtureSession({ documentsMode: "exhaustive" });
  const result = await adapter.discover(session);

  const byDocumentGuid = new Map(
    [...STATEMENT_DOCS, ...CONFIRMATION_DOCS].map((d) => [d.documentGuid, d.keyAccountNo]),
  );
  for (const doc of result.documents.items) {
    const [rawDocId] = doc.externalId.split("::");
    const expectedKey = byDocumentGuid.get(rawDocId);
    if (expectedKey === undefined) {
      // F1-40: the fixture's one keyless document -- discover() must not
      // invent a key the provider never sent.
      assert.equal(doc.accountExternalKey, undefined);
    } else {
      assert.equal(doc.accountExternalKey, expectedKey);
    }
  }
});

test("discover's accounts map every account kind mapAccountKind recognises", async () => {
  const session = createFixtureSession();
  const { accounts } = await adapter.discover(session);

  assert.equal(accounts.length, 8);
  assert.ok(accounts.every((a) => typeof a.externalKey === "string" && a.externalKey.length > 0));
  assert.ok(accounts.every((a) => typeof a.last4 === "string"));
  const kinds = new Set(accounts.map((a) => a.kind));
  assert.deepEqual(kinds, new Set(["brokerage", "retirement", "trust", "bank", "credit_line", "mortgage"]));
  // No "other" fallbacks for any of this fixture's accounts.
  assert.ok(accounts.every((a) => a.kind !== "other"));
  // An aggregated outside-institution account (IsExternal: true) is listed
  // by the site but not held here, and discover() excludes it.
  assert.ok(accounts.every((a) => a.externalKey !== "EXT-ACCT-0009"));
});

test("a document's externalId round-trips through acquire without a second documents-list call", async () => {
  const session = createFixtureSession();
  const result = await adapter.discover(session);
  const statement = result.documents.items.find((d) => d.kind === "pdf_statement");
  assert.ok(statement);

  const acquired = await adapter.acquire({ kind: "pdf_statement", session, externalId: statement.externalId });
  assert.equal(acquired.manifest.periodStart, statement.periodStart);
  assert.equal(acquired.manifest.periodEnd, statement.periodEnd);
});

test("the documents listing pages within a calendar year, and the per-year totals sum to the provider total", async () => {
  const documentsPagesRequested = [];
  const session = createFixtureSession({ documentsMode: "paginated", documentsPagesRequested });
  const result = await adapter.discover(session);

  assert.equal(result.documents.status, "exhaustive");
  assert.equal(result.documents.items.length, PAGINATED_STATEMENT_DOCS.length + CONFIRMATION_DOCS.length);
  assert.equal(result.documents.providerTotal, PAGINATED_STATEMENT_DOCS.length + CONFIRMATION_DOCS.length);

  // Every year in the confirmed seven-year window is queried once per doc
  // type -- even the empty ones, which is how a per-year total of zero is
  // told apart from a missing total.
  const statementYears = documentsPagesRequested.filter((r) => r.docType === "ClientStatements").map((r) => r.timeFrame);
  assert.deepEqual(new Set(statementYears), new Set(documentTimeFrames()));

  // Three different per-year totals -- two full pages and a partial third,
  // one full page, and zero -- summing to the provider total above.
  assert.deepEqual(
    documentsPagesRequested.filter((r) => r.docType === "ClientStatements" && r.timeFrame === OLDEST_YEAR).map((r) => r.page),
    ["1", "2", "3"],
  );
  assert.deepEqual(
    documentsPagesRequested.filter((r) => r.docType === "ClientStatements" && r.timeFrame === NEWER_YEAR).map((r) => r.page),
    ["1"],
  );
  for (const year of documentTimeFrames()) {
    if (year === OLDEST_YEAR || year === NEWER_YEAR) continue;
    assert.deepEqual(
      documentsPagesRequested.filter((r) => r.docType === "ClientStatements" && r.timeFrame === year).map((r) => r.page),
      ["1"],
    );
  }
  // The confirmations, all in the oldest year, take one page.
  assert.deepEqual(
    documentsPagesRequested.filter((r) => r.docType === "TradeConfirmations" && r.timeFrame === OLDEST_YEAR).map((r) => r.page),
    ["1"],
  );
});

test("a document download that answers with an HTML page is refused, not retained", async () => {
  const session = createFixtureSession({ documentDownloadHtml: true });
  const { documents } = await adapter.discover(session);
  const statement = documents.items.find((d) => d.kind === "pdf_statement");

  await assert.rejects(
    adapter.acquire({ kind: "pdf_statement", session, externalId: statement.externalId }),
    /did not return a PDF/,
  );
});

test("discover tolerates a documents pull failing outright (e.g. the missing Authorization bearer) and still returns accounts", async () => {
  const session = createFixtureSession({ documentsFail: true });
  const result = await adapter.discover(session);

  assert.equal(result.documents.status, "incomplete");
  assert.match(result.documents.reason, /docType=ClientStatements failed/);
  assert.match(result.documents.reason, /docType=TradeConfirmations failed/);
  assert.equal(result.documents.items.length, 0);
  // The activity-only bounded pull can still proceed: accounts are unaffected.
  assert.equal(result.accounts.length, 8);
});

test("discover falls back to deriving accounts from the activity API when the accounts endpoint 403s", async () => {
  const session = createFixtureSession({ accountsStatus: 403 });
  const result = await adapter.discover(session);

  assert.deepEqual(result.accounts, [
    { externalKey: "MS-ACCT-0001", label: "MS-ACCT-0001", last4: "0001", kind: "other" },
  ]);
  // The documents pull is unaffected by the accounts fallback.
  assert.equal(result.documents.status, "exhaustive");
});

test("documentTimeFrames returns six prior calendar years then Last12Months, and never the current year", () => {
  const frames = documentTimeFrames(new Date("2026-09-11T00:00:00.000Z"));
  assert.deepEqual(frames, ["2020", "2021", "2022", "2023", "2024", "2025", "Last12Months"]);
  assert.equal(frames.includes("2026"), false);
});

test("selectDateRangeType maps a window inside the prior calendar year to LastYear", () => {
  const thisYear = new Date().getUTCFullYear();
  assert.equal(selectDateRangeType(`${thisYear - 1}-02-01`, `${thisYear - 1}-11-30`), "LastYear");
  // A window that also reaches back a further year is not covered by
  // LastYear and falls through to the existing YearToDate default.
  assert.equal(selectDateRangeType(`${thisYear - 2}-06-01`, `${thisYear - 1}-11-30`), "Custom");
});

test("overlapping items from Last12Months and the prior calendar year are merged once by documentId, and the reported total is the unique count", async () => {
  const session = createFixtureSession({ documentsMode: "overlapping" });
  const result = await adapter.discover(session);

  const statements = result.documents.items.filter((d) => d.kind === "pdf_statement");
  assert.equal(statements.length, 2, "the overlapping document is counted once, not twice");
  const docIds = statements.map((d) => d.externalId.split("::")[0]).sort();
  assert.deepEqual(docIds, [OVERLAP_DOC.documentId, LAST12MONTHS_ONLY_DOC.documentId].sort());

  // 2 unique statements + the 3 fixture confirmations, all reported as
  // exhaustive: the per-type total the adapter now sums is already the
  // unique count, so it matches what discover() actually returned.
  assert.equal(result.documents.status, "exhaustive");
  assert.equal(result.documents.items.length, 2 + CONFIRMATION_DOCS.length);
  assert.equal(result.documents.providerTotal, 2 + CONFIRMATION_DOCS.length);
});

test("the two document types are pulled sequentially, not concurrently", async () => {
  const documentsCallLog = [];
  let releaseFirstCall;
  const gate = new Promise((resolve) => {
    releaseFirstCall = resolve;
  });
  const session = createFixtureSession({ documentsCallLog, documentsGateFirstCall: gate });

  const resultPromise = adapter.discover(session);
  // Give every microtask that can run without the gate a chance to run.
  for (let i = 0; i < 20; i += 1) await Promise.resolve();

  // ClientStatements is queried first (DOCUMENT_TYPES' order) and its very
  // first request is the one gated above. While it is still pending, a
  // concurrent (Promise.all-style) pull would already have issued
  // TradeConfirmations' first request too -- the sequential pull must not.
  assert.equal(documentsCallLog.some((c) => c.docType === "TradeConfirmations"), false);
  assert.equal(documentsCallLog.some((c) => c.docType === "ClientStatements"), true);

  releaseFirstCall();
  const result = await resultPromise;
  assert.equal(result.documents.status, "exhaustive");
});

/** Advances node:test's mock timers in a loop, flushing microtasks between
 * ticks, until `done()` reports true or the loop gives up. Used by the two
 * retry tests below, which need the retry's real setTimeout delays to
 * resolve without the test actually waiting seconds for them. */
async function advanceTimersUntil(t, done) {
  for (let i = 0; i < 200 && !done(); i += 1) {
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(60_000);
  }
}

test("a transient 400 Service Error is retried until it succeeds, not just any failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const documentsCallLog = [];
  const session = createFixtureSession({ documentsServiceErrorCount: 3, documentsCallLog });

  const resultPromise = adapter.discover(session);
  await advanceTimersUntil(t, () => documentsCallLog.length >= 4);
  const result = await resultPromise;

  assert.equal(result.documents.status, "exhaustive");
  // The first three attempts at the very first page fail with the transient
  // error and are retried; the fourth succeeds -- all against the same
  // docType/timeFrame/page, proving this is a retry, not a skip-ahead.
  const first = documentsCallLog.slice(0, 4);
  assert.equal(first.length, 4);
  assert.ok(first.every((c) => c.docType === "ClientStatements" && c.timeFrame === OLDEST_YEAR && c.page === "1"));
});

test("a transient 400 Service Error that never clears exhausts the retry budget and is reported, never retried forever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const documentsCallLog = [];
  const session = createFixtureSession({ documentsServiceErrorCount: Infinity, documentsCallLog });

  const resultPromise = adapter.discover(session);
  await advanceTimersUntil(t, () => documentsCallLog.length >= 16);
  const result = await resultPromise;

  assert.equal(result.documents.status, "incomplete");
  assert.match(result.documents.reason, /docType=ClientStatements failed/);
  assert.match(result.documents.reason, /Service Error/);

  // Exactly eight attempts (the retry's default budget) at the same first
  // page for each doc type -- not fewer (still retrying) and not more
  // (retrying past its own budget).
  for (const docType of ["ClientStatements", "TradeConfirmations"]) {
    const attempts = documentsCallLog.filter((c) => c.docType === docType);
    assert.equal(attempts.length, 8, `${docType} attempts`);
    assert.ok(attempts.every((c) => c.timeFrame === OLDEST_YEAR && c.page === "1"));
  }
});
