import { test } from "node:test";
import assert from "node:assert/strict";
import adapter from "../src/adapter.mjs";
import { createFixtureSession } from "../fixtures/session.mjs";
import { STATEMENT_DOCS, CONFIRMATION_DOCS, PAGINATED_STATEMENT_DOCS } from "../fixtures/documents.mjs";

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
  assert.match(result.documents.reason, /reports no document total/);
  // What was actually seen is still returned, never discarded.
  assert.equal(result.documents.items.length, STATEMENT_DOCS.length + CONFIRMATION_DOCS.length);
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

test("the documents listing pages through to the provider's stated total", async () => {
  const documentsPagesRequested = [];
  const session = createFixtureSession({ documentsMode: "paginated", documentsPagesRequested });
  const result = await adapter.discover(session);

  assert.equal(result.documents.status, "exhaustive");
  assert.equal(result.documents.items.length, PAGINATED_STATEMENT_DOCS.length + CONFIRMATION_DOCS.length);
  // Three pages for the statements (two full, one partial), one for the
  // confirmations -- never a conclusion drawn from page one alone.
  assert.deepEqual(
    documentsPagesRequested.filter((r) => r.docType === "Statements").map((r) => r.page),
    ["1", "2", "3"],
  );
  assert.deepEqual(
    documentsPagesRequested.filter((r) => r.docType !== "Statements").map((r) => r.page),
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
  assert.match(result.documents.reason, /docType=Statements failed/);
  assert.match(result.documents.reason, /docType=Trade confirmations failed/);
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
