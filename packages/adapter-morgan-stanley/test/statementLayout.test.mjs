// F1-44: real PDF text extraction, and the parser for the layout it produces.
//
// Every fixture here is generated in-process. The labels are the
// institution's vocabulary (README, "Statement layout"); the values are
// invented. No real document content appears in this repository.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import adapter, {
  extractStatementText,
  parseStatementLines,
  parseSyntheticStatementLines,
} from "../src/adapter.mjs";
import { extractWithTjScan, PAGE_SEPARATOR } from "../src/pdfText.mjs";
import { resolveStatementMoney } from "../src/statementLayout.mjs";
import { buildMinimalPdf } from "../fixtures/pdf.mjs";
import { STATEMENT_LINES } from "../fixtures/statementLines.mjs";
import {
  ambiguousBlockLines,
  balanceSheetLines,
  bondBlockLines,
  CONSOLIDATED_ACCOUNT_ONE,
  CONSOLIDATED_ACCOUNT_TWO,
  CONSOLIDATED_LAYOUT_TEXT,
  equityBlockLines,
  STATEMENT_LAYOUT_TEXT,
  statementPages,
} from "../fixtures/statementLayout.mjs";

const kind = "pdf_statement";
const trimmed = (text) => text.split("\n").map((line) => line.trim());

// --- extraction -------------------------------------------------------------

test("extraction keeps a page's lines in reading order", async () => {
  const pdf = buildMinimalPdf(STATEMENT_LINES.split("\n"));
  const extracted = await extractStatementText(pdf);
  assert.deepEqual(trimmed(extracted), STATEMENT_LINES.split("\n"));
});

test("a compressed content stream reads only through pdfjs, which is the whole point", async () => {
  const lines = STATEMENT_LINES.split("\n");
  const compressed = buildMinimalPdf(lines, { compress: true });
  // This is the shape every live statement had: the dependency-free scan sees
  // no literal Tj operators in a deflated stream and reads nothing at all.
  assert.equal(extractWithTjScan(compressed), null);
  assert.deepEqual(trimmed(await extractStatementText(compressed)), lines);
});

test("a TJ-array, compressed content stream extracts through pdfjs (F1-55)", async () => {
  const lines = STATEMENT_LINES.split("\n");
  const pdf = buildMinimalPdf(lines, { compress: true, useTJ: true });
  // TJ (not Tj) with a kerning number between two string pieces is what a
  // real generator emits; a plain Tj fixture never exercises this path.
  assert.equal(extractWithTjScan(pdf), null);
  assert.deepEqual(trimmed(await extractStatementText(pdf)), lines);
});

test("compressed and uncompressed bytes of the same content extract to the same text", async () => {
  const lines = STATEMENT_LINES.split("\n");
  const plain = await extractStatementText(buildMinimalPdf(lines));
  const deflated = await extractStatementText(buildMinimalPdf(lines, { compress: true }));
  assert.equal(plain, deflated);
});

test("extraction is deterministic: the same bytes give the same text", async () => {
  const pdf = buildMinimalPdf(statementPages(), { compress: true });
  assert.equal(await extractStatementText(pdf), await extractStatementText(pdf));
});

test("pages are separated by a form feed, and the separator is not a line", async () => {
  const pdf = buildMinimalPdf(statementPages());
  const extracted = await extractStatementText(pdf);
  const pages = extracted.split(PAGE_SEPARATOR);
  assert.equal(pages.length, 2);
  assert.match(pages[0], /Page 1 of 2/);
  assert.match(pages[1], /Page 2 of 2/);
  assert.doesNotMatch(pages[0], /Page 2 of 2/);
});

test("extraction does not consume the caller's bytes", async () => {
  // pdfjs transfers the buffer it is handed; these bytes are the retained
  // archive object and every later reader -- the content hash above all --
  // has to still see them.
  const pdf = buildMinimalPdf(["PAGE 1"]);
  const before = pdf.byteLength;
  await extractStatementText(pdf);
  assert.equal(pdf.byteLength, before);
  assert.equal(String.fromCharCode(...pdf.slice(0, 4)), "%PDF");
});

test("a PDF with no text layer at all is reported, not silently parsed as empty", async () => {
  const pdf = buildMinimalPdf([[]]);
  await assert.rejects(() => extractStatementText(pdf), /no readable text/);
});

test("non-PDF bytes are decoded as UTF-8 unchanged", async () => {
  const text = "not a pdf, just text";
  assert.equal(await extractStatementText(new TextEncoder().encode(text)), text);
});

// --- money ------------------------------------------------------------------

test("money is exact decimal text: parentheses are negative, an em dash is not zero", () => {
  // Canonical decimal: one spelling per number, so a trailing zero is dropped.
  assert.deepEqual(resolveStatementMoney("$1,302,775.50"), { value: "1302775.5", note: null });
  assert.deepEqual(resolveStatementMoney("(48,500.00)"), { value: "-48500", note: null });
  // A footnote reference printed after a value is a reference, not a digit.
  assert.deepEqual(resolveStatementMoney("$312.50 NA"), { value: "312.5", note: null });
  assert.equal(resolveStatementMoney("—").value, null);
  assert.match(resolveStatementMoney("—").note, /no value stated/);
  assert.equal(resolveStatementMoney("1.2e5").value, null);
  assert.match(resolveStatementMoney("1.2e5").note, /unparseable amount/);
  for (const text of ["$1,302,775.50", "(48,500.00)", "$312.50 NA"]) {
    assert.equal(typeof resolveStatementMoney(text).value, "string");
  }
});

// --- period, balance, liability ---------------------------------------------

test("the statement's own period bounds both ends of the balance it states", () => {
  const parsed = parseStatementLines(STATEMENT_LAYOUT_TEXT, kind);
  const [balance] = parsed.holdings.balances;
  assert.equal(balance.asOf, "2026-03-31");
  assert.equal(balance.currency, "USD");
});

test("TOTAL VALUE fills the period's opening and closing value from its own two columns", () => {
  const parsed = parseStatementLines(STATEMENT_LAYOUT_TEXT, kind);
  assert.equal(parsed.holdings.balances.length, 1);
  const [balance] = parsed.holdings.balances;
  assert.equal(balance.totalValue, "1302775.5");
  assert.equal(balance.totalValueNote, null);
  assert.equal(balance.periodStartValue, "1250400");
  assert.equal(balance.periodEndValue, "1302775.5");
  assert.equal(balance.cash, "42118.25");
  assert.equal(balance.locators.row.source, kind);
  assert.equal(balance.locators.row.index, 1);
  assert.match(balance.locators.row.field, /BALANCE SHEET/);
});

test("the CASH FLOW table printed beside the balance sheet never bleeds into it", () => {
  const parsed = parseStatementLines(STATEMENT_LAYOUT_TEXT, kind);
  const [balance] = parsed.holdings.balances;
  // The CASH FLOW row on the TOTAL VALUE line states 42,118.25 in both of its
  // columns. Reading by column position is what keeps it out of the balance.
  assert.notEqual(balance.periodStartValue, "42118.25");
  assert.notEqual(balance.periodEndValue, "42118.25");
});

test("an em dash liability is absent, not a zero balance", () => {
  const parsed = parseStatementLines(STATEMENT_LAYOUT_TEXT, kind);
  assert.deepEqual(parsed.holdings.liabilities, []);
});

test("a stated liability becomes a ParsedLiability with its own locator", () => {
  const text = [
    "        Page 1 of 1",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    "        Synthetic Liquidity Access Line    123-456789-012",
    ...balanceSheetLines({ liabilityThis: "(250,000.00)" }),
  ].join("\n");
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.liabilities.length, 1);
  const [liability] = parsed.holdings.liabilities;
  assert.equal(liability.balance, "-250000");
  assert.equal(liability.balanceNote, null);
  assert.equal(liability.kind, "outstanding_balance");
  assert.equal(liability.asOf, "2026-03-31");
  assert.equal(liability.locators.row.index, 1);
});

test("an unreadable TOTAL VALUE is null with a note and its own locator, never a guess", () => {
  const text = [
    "        Page 1 of 1",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    "        Synthetic Active Assets Account    123-456789-012",
    ...balanceSheetLines({ totalValueThis: "$1,302,77S.50" }),
  ].join("\n");
  const [balance] = parseStatementLines(text, kind).holdings.balances;
  assert.equal(balance.totalValue, null);
  assert.match(balance.totalValueNote, /unparseable amount/);
  assert.equal(balance.locators.totalValue.index, 1);
});

// --- holdings ---------------------------------------------------------------

test("an equity's Total row is the position; its lots are not each a holding", () => {
  const parsed = parseStatementLines(STATEMENT_LAYOUT_TEXT, kind);
  const equity = parsed.holdings.positions.find((p) => p.instrument?.symbol === "WNDF");
  assert.ok(equity, "the equity block produced exactly one position");
  assert.equal(parsed.holdings.positions.filter((p) => p.instrument?.symbol === "WNDF").length, 1);
  assert.equal(equity.quantity, "10");
  assert.equal(equity.marketValue, "3184");
  assert.equal(equity.costBasis, "3000");
  assert.equal(equity.unrealized, "184");
  assert.equal(equity.instrument.name, "WIDGET NEUTRAL FUND");
  assert.equal(equity.currency, "USD");
  assert.equal(equity.asOf, "2026-03-31");
  assert.equal(equity.valuationBasis, "market_price");
  assert.match(equity.valuationNote, /Market Value column/);
  assert.equal(equity.locators.row.index, 2);
});

test("a price the Total row omits is filled only from lots that agree on it", () => {
  const parsed = parseStatementLines(STATEMENT_LAYOUT_TEXT, kind);
  const equity = parsed.holdings.positions.find((p) => p.instrument?.symbol === "WNDF");
  // Both lots print the same Share Price, so the position's price is that
  // price -- read from a labelled column, not derived from value/quantity.
  assert.equal(equity.price, "318.4");
});

test("a bond's market value is read off its detail line, and its CUSIP with it", () => {
  const parsed = parseStatementLines(STATEMENT_LAYOUT_TEXT, kind);
  const bond = parsed.holdings.positions.find((p) => p.instrument?.cusip === "00000WNF1");
  assert.ok(bond, "the bond block produced one position");
  assert.equal(bond.instrument.name, "SYNTHETIC CAIRN MUNICIPAL SERIES A");
  assert.equal(bond.instrument.symbol, null);
  assert.equal(bond.quantity, "25000");
  assert.equal(bond.price, "99.5");
  assert.equal(bond.costBasis, "24562.5");
  assert.equal(bond.marketValue, "24875");
  assert.equal(bond.unrealized, "312.5");
});

test("holdings and the balance come from one parse of one document", () => {
  const parsed = parseStatementLines(STATEMENT_LAYOUT_TEXT, kind);
  assert.equal(parsed.holdings.positions.length, 2);
  assert.equal(parsed.holdings.balances.length, 1);
  for (const position of parsed.holdings.positions) {
    assert.equal(position.sourceDocument, "statement");
    assert.equal(typeof position.marketValue, "string");
  }
});

test("an asset-class heading is not read as a security", () => {
  const parsed = parseStatementLines(STATEMENT_LAYOUT_TEXT, kind);
  const names = parsed.holdings.positions.map((p) => p.instrument?.name);
  assert.ok(!names.includes("COMMON STOCKS"));
  assert.ok(!names.includes("CORPORATE FIXED INCOME"));
});

// --- review routing ---------------------------------------------------------

test("two valued lots with no Total row are refused, with the reason on the pull", () => {
  const text = [
    "        Page 1 of 1",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    "        Synthetic Active Assets Account    123-456789-012",
    "        HOLDINGS",
    ...ambiguousBlockLines(),
  ].join("\n");
  const parsed = parseStatementLines(text, kind);
  assert.deepEqual(parsed.holdings.positions, []);
  assert.match(parsed.parseNote, /1 holdings block\(s\) left unparsed/);
  assert.match(parsed.parseNote, /neither a Total row nor a single valued lot/);
});

test("an unreadable market value is null with a note and a marketValue locator", () => {
  const text = [
    "        Page 1 of 1",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    "        Synthetic Active Assets Account    123-456789-012",
    "        HOLDINGS",
    ...equityBlockLines({ marketValue: "3,184.OO" }),
  ].join("\n");
  const [position] = parseStatementLines(text, kind).holdings.positions;
  assert.equal(position.marketValue, null);
  assert.match(position.marketValueNote, /unparseable amount/);
  assert.equal(position.locators.marketValue.source, kind);
});

// --- evidence spans (F1-53) --------------------------------------------------

/** Every `retained_text_span_v1` binding a `locators` map carries. */
function bindings(locators) {
  return Object.values(locators)
    .map((locator) => locator.binding)
    .filter((binding) => binding !== undefined);
}

test("every retained-text-span binding slices `text` to its own quote", () => {
  const parsed = parseStatementLines(STATEMENT_LAYOUT_TEXT, kind);
  const all = [
    ...parsed.holdings.positions.flatMap((p) => bindings(p.locators)),
    ...parsed.holdings.balances.flatMap((b) => bindings(b.locators)),
  ];
  assert.ok(all.length > 0, "at least one binding was produced");
  for (const binding of all) {
    assert.equal(binding.format, "retained_text_span_v1");
    assert.equal(
      STATEMENT_LAYOUT_TEXT.slice(binding.start, binding.end),
      binding.quote,
    );
    assert.equal(Array.from(binding.quote).length, binding.end - binding.start);
  }
});

test("every binding on one document shares that document's own text identity", () => {
  const parsed = parseStatementLines(STATEMENT_LAYOUT_TEXT, kind);
  const all = [
    ...parsed.holdings.positions.flatMap((p) => bindings(p.locators)),
    ...parsed.holdings.balances.flatMap((b) => bindings(b.locators)),
  ];
  const expectedSha256 = createHash("sha256")
    .update(Buffer.from(STATEMENT_LAYOUT_TEXT, "utf8"))
    .digest("hex");
  const expectedByteLength = Buffer.byteLength(STATEMENT_LAYOUT_TEXT, "utf8");
  const expectedCodepointLength = Array.from(STATEMENT_LAYOUT_TEXT).length;
  for (const binding of all) {
    assert.equal(binding.textSha256, expectedSha256);
    assert.equal(binding.textByteLength, expectedByteLength);
    assert.equal(binding.textCodepointLength, expectedCodepointLength);
  }
});

test("a position's quantity, price, cost basis and market value each carry their own span", () => {
  const parsed = parseStatementLines(STATEMENT_LAYOUT_TEXT, kind);
  const equity = parsed.holdings.positions.find((p) => p.instrument?.symbol === "WNDF");
  for (const field of ["quantity", "price", "costBasis", "marketValue"]) {
    const locator = equity.locators[field];
    assert.ok(locator, `locators.${field} is present`);
    assert.equal(locator.binding.format, "retained_text_span_v1");
    assert.equal(
      STATEMENT_LAYOUT_TEXT.slice(locator.binding.start, locator.binding.end),
      locator.binding.quote,
    );
  }
});

test("a balance's totalValue and cash each carry their own span", () => {
  const parsed = parseStatementLines(STATEMENT_LAYOUT_TEXT, kind);
  const [balance] = parsed.holdings.balances;
  for (const field of ["totalValue", "cash"]) {
    const locator = balance.locators[field];
    assert.ok(locator, `locators.${field} is present`);
    assert.equal(
      STATEMENT_LAYOUT_TEXT.slice(locator.binding.start, locator.binding.end),
      locator.binding.quote,
    );
  }
});

test("a consolidated statement's account-number line is its own citable span", () => {
  const parsed = parseStatementLines(CONSOLIDATED_LAYOUT_TEXT, kind);
  const [firstBalance, secondBalance] = parsed.holdings.balances;
  assert.equal(
    CONSOLIDATED_LAYOUT_TEXT.slice(
      firstBalance.locators.account.binding.start,
      firstBalance.locators.account.binding.end,
    ),
    CONSOLIDATED_ACCOUNT_ONE,
  );
  assert.equal(
    CONSOLIDATED_LAYOUT_TEXT.slice(
      secondBalance.locators.account.binding.start,
      secondBalance.locators.account.binding.end,
    ),
    CONSOLIDATED_ACCOUNT_TWO,
  );
});

test("a single-account statement never had a bare account-number line, so no account span", () => {
  const parsed = parseStatementLines(STATEMENT_LAYOUT_TEXT, kind);
  const [balance] = parsed.holdings.balances;
  assert.equal(balance.locators.account, undefined);
});

// F1-46: a consolidated statement is parsed, not refused. Each account's own
// running header (a line carrying only that account's number) attributes
// every position, balance and liability found under it.
test("a consolidated statement attributes each balance to its own account", () => {
  const parsed = parseStatementLines(CONSOLIDATED_LAYOUT_TEXT, kind);
  assert.equal(parsed.parseNote, undefined);
  assert.equal(parsed.holdings.balances.length, 2);
  const [first, second] = parsed.holdings.balances;
  assert.equal(first.accountExternalKey, CONSOLIDATED_ACCOUNT_ONE);
  assert.equal(first.totalValue, "1302775.5");
  assert.equal(second.accountExternalKey, CONSOLIDATED_ACCOUNT_TWO);
  assert.equal(second.totalValue, "512340");
});

test("a consolidated statement attributes each position to the account whose pages it was printed under", () => {
  const parsed = parseStatementLines(CONSOLIDATED_LAYOUT_TEXT, kind);
  assert.equal(parsed.holdings.positions.length, 2);
  const [equity, bond] = parsed.holdings.positions;
  assert.equal(equity.accountExternalKey, CONSOLIDATED_ACCOUNT_ONE);
  assert.equal(bond.accountExternalKey, CONSOLIDATED_ACCOUNT_TWO);
});

test("a consolidated statement attributes a liability to its own account, not the other one", () => {
  const parsed = parseStatementLines(CONSOLIDATED_LAYOUT_TEXT, kind);
  assert.equal(parsed.holdings.liabilities.length, 1);
  const [liability] = parsed.holdings.liabilities;
  assert.equal(liability.accountExternalKey, CONSOLIDATED_ACCOUNT_TWO);
  assert.equal(liability.balance, "1500");
});

test("a single-account statement still omits accountExternalKey: this pull's own account, unchanged", () => {
  const parsed = parseStatementLines(STATEMENT_LAYOUT_TEXT, kind);
  const [balance] = parsed.holdings.balances;
  assert.equal(balance.accountExternalKey, undefined);
  for (const position of parsed.holdings.positions) {
    assert.equal(position.accountExternalKey, undefined);
  }
});

test("a statement with no period line is refused rather than dated by inference", () => {
  const text = [
    "        Synthetic Active Assets Account    123-456789-012",
    "        CLIENT STATEMENT",
    ...balanceSheetLines(),
  ].join("\n");
  const parsed = parseStatementLines(text, kind);
  assert.deepEqual(parsed.holdings.balances, []);
  assert.match(parsed.parseNote, /period is unknown/);
});

test("a statement with no readable balance sheet still reports its holdings and says so", () => {
  const text = [
    "        Page 1 of 1",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    "        Synthetic Active Assets Account    123-456789-012",
    "        HOLDINGS",
    ...bondBlockLines(),
  ].join("\n");
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 1);
  assert.deepEqual(parsed.holdings.balances, []);
  assert.match(parsed.parseNote, /no readable BALANCE SHEET block/);
});

test("text in neither grammar routes to review instead of reaching a parser blind", () => {
  const parsed = parseStatementLines(
    "TRADE CONFIRMATION\nsomething this adapter has never been shown",
    "trade_confirmation",
  );
  assert.deepEqual(parsed.holdings, { positions: [], balances: [], liabilities: [] });
  assert.deepEqual(parsed.activity, []);
  assert.match(parsed.parseNote, /matches neither the CLIENT STATEMENT layout/);
});

// --- end to end -------------------------------------------------------------

test("parse returns the extracted text so the raw tree retains it, parsed or not", async () => {
  const pdf = buildMinimalPdf(statementPages(), { compress: true });
  const parsed = await adapter.parse({ kind, bytes: pdf });
  assert.equal(typeof parsed.extractedText, "string");
  assert.match(parsed.extractedText, /CLIENT STATEMENT/);
  assert.equal(parsed.holdings.positions.length, 2);
  assert.equal(parsed.holdings.balances[0].totalValue, "1302775.5");
});

test("a document whose layout no parser reads still returns its text to retain", async () => {
  const pdf = buildMinimalPdf([["TRADE CONFIRMATION", "an unstudied layout"]], { compress: true });
  const parsed = await adapter.parse({ kind: "trade_confirmation", bytes: pdf });
  assert.match(parsed.extractedText, /TRADE CONFIRMATION/);
  assert.match(parsed.parseNote, /matches neither/);
});

test("the synthetic fixture grammar still parses through its own function", () => {
  const parsed = parseSyntheticStatementLines(STATEMENT_LINES, kind);
  assert.equal(parsed.activity.length, 5);
  assert.equal(parsed.holdings.positions.length, 2);
  assert.equal(parsed.holdings.balances.length, 1);
});
