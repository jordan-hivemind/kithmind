import { test } from "node:test";
import assert from "node:assert/strict";
import adapter, { extractStatementText, parseStatementLines } from "../src/adapter.mjs";
import { createFixtureSession } from "../fixtures/session.mjs";
import { STATEMENT_LINES, CONFIRMATION_LINES } from "../fixtures/statementLines.mjs";
import { buildMinimalPdf } from "../fixtures/pdf.mjs";

test("parseStatementLines reads positions, balances and liabilities from statement text", () => {
  const parsed = parseStatementLines(STATEMENT_LINES, "pdf_statement");

  assert.equal(parsed.activity.length, 5);
  assert.equal(parsed.holdings.positions.length, 2);
  assert.equal(parsed.holdings.balances.length, 1);
  assert.equal(parsed.holdings.liabilities.length, 1);

  const fund = parsed.holdings.positions.find((p) => p.instrument?.symbol === "WNDF");
  assert.equal(fund.marketValue, "44576", "marketValue is canonicalized through resolveAmount");
  assert.equal(fund.costBasis, "41000.00", "costBasis is carried through as the statement's own text");
  assert.equal(fund.valuationBasis, "market_price");
  // "PAGE 2" is the last page marker before "HOLDINGS", so holdings lines
  // locate against page 2, not page 1.
  assert.deepEqual(fund.locators.row, { source: "pdf_statement", index: 2, field: "holdings line 0" });

  const privateFund = parsed.holdings.positions.find((p) => p.instrument?.name?.includes("Cairn"));
  assert.equal(privateFund.instrument.symbol, null, "no symbol for an illiquid privately held fund unit");
  assert.equal(privateFund.quantity, null);
  assert.equal(privateFund.valuationBasis, "cost");

  const balance = parsed.holdings.balances[0];
  assert.equal(balance.totalValue, "58612.40");
  assert.equal(balance.periodStartValue, "55210.00");

  const liability = parsed.holdings.liabilities[0];
  assert.equal(liability.kind, "securities_based_line_of_credit");
  assert.equal(liability.balance, "-12500.00");
  assert.equal(liability.rate, "6.750");

  const treasury = parsed.activity.find((r) => r.activityType === "Bought" && r.description.includes("TREASURY"));
  assert.equal(treasury.quantity, "10000");
  assert.equal(treasury.description, "TREASURY BILL PURCHASE\nRATE:4.500 DUE:2026-03-15");
});

test("no PDF-tier row carries a binding -- the PDF tier declines one", () => {
  const parsed = parseStatementLines(STATEMENT_LINES, "pdf_statement");
  for (const row of parsed.activity) {
    assert.equal(row.locators.row.binding, undefined);
  }
  for (const position of parsed.holdings.positions) {
    assert.equal(position.locators.row.binding, undefined);
  }
});

test("a trade confirmation carries its FINRA markup in description and honestly declines holdings", () => {
  const parsed = parseStatementLines(CONFIRMATION_LINES, "trade_confirmation");
  assert.equal(parsed.activity.length, 1);
  assert.deepEqual(parsed.holdings, { positions: [], balances: [], liabilities: [] });
  assert.match(parsed.activity[0].description, /MARKUP:12\.50/);
  assert.equal(parsed.activity[0].quantity, "50");
});

test("extractStatementText reads a generated PDF's Tj text back out unchanged", () => {
  const pdfBytes = buildMinimalPdf(STATEMENT_LINES.split("\n"));
  assert.ok(Buffer.from(pdfBytes).toString("latin1").startsWith("%PDF-"));
  assert.equal(extractStatementText(pdfBytes), STATEMENT_LINES);
});

test("extractStatementText falls back to plain UTF-8 decoding for non-PDF bytes", () => {
  const text = "not a pdf, just text";
  assert.equal(extractStatementText(new TextEncoder().encode(text)), text);
});

test("acquire + parse round-trip a real PDF-shaped statement end to end", async () => {
  const session = createFixtureSession();
  const discovered = await adapter.discover(session);
  const statement = discovered.documents.items.find((d) => d.kind === "pdf_statement");
  const acquired = await adapter.acquire({ kind: "pdf_statement", session, externalId: statement.externalId });

  assert.equal(acquired.manifest.mediaType, "application/pdf");
  assert.equal(acquired.retention.policy.kind, "opaque");
  assert.ok(Buffer.from(acquired.bytes).toString("latin1").startsWith("%PDF-"));

  const parsed = await adapter.parse({ kind: "pdf_statement", bytes: acquired.bytes });
  assert.equal(parsed.holdings.positions.length, 2);
  assert.equal(parsed.holdings.balances.length, 1);
  assert.equal(parsed.holdings.liabilities.length, 1);
});

test("acquire + parse round-trip a confirmation, which reports EMPTY_HOLDINGS", async () => {
  const session = createFixtureSession();
  const discovered = await adapter.discover(session);
  const confirmation = discovered.documents.items.find((d) => d.kind === "trade_confirmation");
  const acquired = await adapter.acquire({ kind: "trade_confirmation", session, externalId: confirmation.externalId });
  const parsed = await adapter.parse({ kind: "trade_confirmation", bytes: acquired.bytes });

  assert.equal(parsed.activity.length, 1);
  assert.deepEqual(parsed.holdings, { positions: [], balances: [], liabilities: [] });
});

test("a statement row sets no accountExternalKey -- the document is one account's", () => {
  const { activity } = parseStatementLines(STATEMENT_LINES, "pdf_statement");

  assert.ok(activity.length > 0);
  // Omitted, not empty: adapterImport treats undefined as "this pull's own
  // account" and an unresolvable string as a review item.
  assert.ok(activity.every((r) => r.accountExternalKey === undefined));
});
