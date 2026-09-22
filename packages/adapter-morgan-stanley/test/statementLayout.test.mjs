// F1-44: real PDF text extraction, and the parser for the layout it produces.
//
// Every fixture here is generated in-process. The labels are the
// institution's vocabulary (README, "Statement layout"); the values are
// invented. No real document content appears in this repository.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { positionHash } from "@repo/finance-archive";
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
  ACTIVITY_SUMMARY_TEXT,
  BOND_HEADER,
  lotsWithoutTotalLines,
  balanceSheetLines,
  bondBlockLines,
  CONSOLIDATED_ACCOUNT_ONE,
  CONSOLIDATED_ACCOUNT_TWO,
  CONSOLIDATED_LAYOUT_TEXT,
  CONSOLIDATED_ROLLUP_LAYOUT_TEXT,
  COVER_TOTAL_LAYOUT_TEXT,
  CROSS_MONTH_LAYOUT_TEXT,
  EMPTY_ACCOUNT_LAYOUT_TEXT,
  EQUITY_HEADER,
  equityBlockLines,
  navFundBlockLines,
  pageSplitEquityPages,
  place,
  privateHoldingsBlockLines,
  sectionSummaryLines,
  SHORT_CASH_LAYOUT_TEXT,
  STATEMENT_LAYOUT_TEXT,
  statementPages,
  YEAR_ROLLOVER_LAYOUT_TEXT,
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
  const deflated = await extractStatementText(
    buildMinimalPdf(lines, { compress: true }),
  );
  assert.equal(plain, deflated);
});

test("extraction is deterministic: the same bytes give the same text", async () => {
  const pdf = buildMinimalPdf(statementPages(), { compress: true });
  assert.equal(
    await extractStatementText(pdf),
    await extractStatementText(pdf),
  );
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
  assert.equal(
    await extractStatementText(new TextEncoder().encode(text)),
    text,
  );
});

// --- money ------------------------------------------------------------------

test("money is exact decimal text: parentheses are negative, an em dash is not zero", () => {
  // Canonical decimal: one spelling per number, so a trailing zero is dropped.
  assert.deepEqual(resolveStatementMoney("$1,302,775.50"), {
    value: "1302775.5",
    note: null,
  });
  assert.deepEqual(resolveStatementMoney("(48,500.00)"), {
    value: "-48500",
    note: null,
  });
  // A footnote reference printed after a value is a reference, not a digit.
  assert.deepEqual(resolveStatementMoney("$312.50 NA"), {
    value: "312.5",
    note: null,
  });
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

// F1-8c. Measured against the hosted archive: a real BALANCE SHEET whose
// Cash, BDP, MMFs figure is short enough (a small cash balance under a
// header as wide as "(as of 03/31/26)") that neither of its two edges lands
// within the ordinary column tolerance, while TOTAL VALUE's larger figure on
// the same block still binds fine. `BALANCE_SHEET_EDGE_TOLERANCE` widens
// binding for this block's two money columns only; holdings tables keep the
// tighter default (unchanged by every other test in this file).
test("a short cash figure a few characters shy of the column edge still binds, not just a long one", () => {
  const parsed = parseStatementLines(SHORT_CASH_LAYOUT_TEXT, kind);
  assert.equal(parsed.holdings.balances.length, 1);
  const [balance] = parsed.holdings.balances;
  assert.equal(balance.totalValue, "1302775.5");
  assert.equal(balance.cash, "500");
  assert.equal(balance.periodStartValue, "1250400");
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
  const equity = parsed.holdings.positions.find(
    (p) => p.instrument?.symbol === "WNDF",
  );
  assert.ok(equity, "the equity block produced exactly one position");
  assert.equal(
    parsed.holdings.positions.filter((p) => p.instrument?.symbol === "WNDF")
      .length,
    1,
  );
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
  const equity = parsed.holdings.positions.find(
    (p) => p.instrument?.symbol === "WNDF",
  );
  // Both lots print the same Share Price, so the position's price is that
  // price -- read from a labelled column, not derived from value/quantity.
  assert.equal(equity.price, "318.4");
});

test("a bond's market value is read off its detail line, and its CUSIP with it", () => {
  const parsed = parseStatementLines(STATEMENT_LAYOUT_TEXT, kind);
  const bond = parsed.holdings.positions.find(
    (p) => p.instrument?.cusip === "00000WNF1",
  );
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

function noTotalStatement(options = {}, trailing = []) {
  return [
    "        Page 1 of 1",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    "        Synthetic Active Assets Account    123-456789-012",
    "        HOLDINGS",
    "        123-456789-012",
    ...lotsWithoutTotalLines(options),
    ...trailing,
  ].join("\n");
}

test("complete dated lots without Total produce one summed position with source evidence", () => {
  const text = noTotalStatement();
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 1);
  const [position] = parsed.holdings.positions;
  assert.equal(position.quantity, "12");
  assert.equal(position.marketValue, "240");
  assert.equal(position.costBasis, "240");
  assert.equal(position.price, "20");
  assert.equal(position.unrealized, null);
  assert.equal(position.accountExternalKey, "123-456789-012");
  assert.equal(position.instrument.symbol, "CSHZ");
  assert.equal(position.asOf, "2026-03-31");
  assert.equal(position.valuationBasis, "market_price");
  assert.match(position.valuationNote, /summed from 2 dated lots/);
  assert.equal(position.locators.marketValue.binding, undefined);
  assert.match(position.locators.marketValue.field, /sum of 2 dated lots/);
  assert.equal(
    position.locators.marketValue.calculation.format,
    "decimal_sum_v1",
  );
  assert.deepEqual(
    position.locators.marketValue.calculation.terms.map(({ quote }) => quote),
    ["$100.00", "140.00"],
  );
  for (const field of ["quantity", "marketValue", "costBasis"]) {
    for (const lot of [1, 2]) {
      const { binding } = position.locators[`${field}.lot.${lot}`];
      assert.equal(text.slice(binding.start, binding.end), binding.quote);
      assert.equal(
        binding.textSha256,
        createHash("sha256").update(text).digest("hex"),
      );
    }
  }
  assert.doesNotMatch(parsed.parseNote ?? "", /holdings block/);
  assert.deepEqual(parseStatementLines(text, kind), parsed);
});

test("lot aggregation preserves exact fractional quantities and signed amounts", () => {
  const text = noTotalStatement({
    first: {
      quantity: "0.1",
      marketValue: "$2.00",
      totalCost: "$3.00",
      gainLoss: "(1.00)",
    },
    second: {
      quantity: "0.2",
      marketValue: "4.00",
      totalCost: "2.50",
      gainLoss: "1.50",
    },
  });
  const [position] = parseStatementLines(text, kind).holdings.positions;
  assert.equal(position.quantity, "0.3");
  assert.equal(position.marketValue, "6");
  assert.equal(position.costBasis, "5.5");
  assert.equal(position.unrealized, "0.5");
});

test("summed lots and a printed Total have the same downstream position identity", () => {
  const lines = equityBlockLines();
  const parse = (rows) =>
    parseStatementLines(
      [
        "        CLIENT STATEMENT   For the Period March 1-31, 2026",
        ...rows,
      ].join("\n"),
      kind,
    ).holdings.positions[0];
  const withTotal = parse(lines);
  const withoutTotal = parse(
    lines.filter((line) => !/\bTotal\s+\d/.test(line)),
  );
  for (const field of [
    "quantity",
    "price",
    "marketValue",
    "costBasis",
    "unrealized",
  ]) {
    assert.equal(withoutTotal[field], withTotal[field]);
  }
  const hash = (position) =>
    positionHash({
      ...position,
      accountId: "synthetic-account",
      instrumentId: "synthetic-instrument",
      sourceLocator: JSON.stringify(position.locators),
    });
  assert.equal(hash(withoutTotal), hash(withTotal));
});

test("missing or unreadable secondary lot fields remain null, never a partial sum", () => {
  for (const totalCost of ["", "—", "1S0.00"]) {
    const [position] = parseStatementLines(
      noTotalStatement({ second: { totalCost } }),
      kind,
    ).holdings.positions;
    assert.equal(position.marketValue, "240");
    assert.equal(position.costBasis, null);
    assert.equal(position.locators.costBasis, undefined);
  }
});

test("incomplete or conflicting lots without Total still route to review", () => {
  for (const second of [
    { quantity: "" },
    { quantity: "7S" },
    { marketValue: "" },
    { marketValue: "—" },
    { marketValue: "14S.00" },
    { sharePrice: "" },
    { sharePrice: "21.00" },
    { tradeDate: "" },
    { tradeDate: "subtotal" },
  ]) {
    const parsed = parseStatementLines(noTotalStatement({ second }), kind);
    assert.deepEqual(parsed.holdings.positions, [], JSON.stringify(second));
    assert.match(parsed.parseNote, /1 holdings block\(s\) left unparsed/);
    assert.match(parsed.parseNote, /not a complete set of dated lots/);
  }
});

test("an undated extra value row cannot silently enter a lot sum", () => {
  const extraRow = lotsWithoutTotalLines({ second: { tradeDate: "" } }).at(-1);
  const parsed = parseStatementLines(noTotalStatement({}, [extraRow]), kind);
  assert.deepEqual(parsed.holdings.positions, []);
  assert.match(parsed.parseNote, /holdings block\(s\) left unparsed/);
});

const purchasesEstimatedValueSummary = (label) =>
  place([
    { text: label, start: 8 },
    { text: "$100.00", end: 134 },
    { text: "$120.00", end: 150 },
  ]);

function purchasesSummaryStatement(
  label = "Total Purchases vs Estimated Value",
) {
  const [section, header, datedRow] = lotsWithoutTotalLines();
  return [
    "        Page 1 of 1",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    "        Synthetic Active Assets Account    123-456789-012",
    "        HOLDINGS",
    section,
    header,
    datedRow,
    purchasesEstimatedValueSummary(label),
    place([{ text: "$6.00", end: 134 }]),
    place([{ text: "$7.00", end: 150 }]),
  ].join("\n");
}

test("the exact purchases-versus-estimated-value summary closes the final security", () => {
  const text = purchasesSummaryStatement();
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 1);
  const [position] = parsed.holdings.positions;
  assert.equal(position.instrument.name, "CAIRN SYNTHETIC HOLDINGS");
  assert.equal(position.quantity, "5");
  assert.equal(position.marketValue, "100");
  assert.equal(position.locators.marketValue.binding.quote, "$100.00");
  assert.equal(
    text.slice(
      position.locators.marketValue.binding.start,
      position.locators.marketValue.binding.end,
    ),
    "$100.00",
  );
  const [scope] = parsed.holdings.positionScopes;
  assert.equal(scope.status, "complete");
  assert.deepEqual(scope.gapCodes, []);
  assert.equal(
    scope.evidence.tables[0].end.binding.quote,
    purchasesEstimatedValueSummary("Total Purchases vs Estimated Value").trim(),
  );
});

test("similar totals, ordinary Total rows, TOTAL-named securities and true lots remain rows", () => {
  const unknown = parseStatementLines(
    purchasesSummaryStatement("Total Purchases and Estimated Value"),
    kind,
  );
  assert.deepEqual(unknown.holdings.positions, []);
  assert.ok(
    unknown.holdings.positionScopes[0].gapCodes.includes("unresolved_lots"),
  );

  const ordinaryTotal = parseStatementLines(
    purchasesSummaryStatement().replace(
      lotsWithoutTotalLines()[2],
      equityBlockLines().slice(2, 5).join("\n"),
    ),
    kind,
  );
  assert.equal(ordinaryTotal.holdings.positions.length, 1);
  assert.equal(ordinaryTotal.holdings.positions[0].marketValue, "3184");

  const datedTotalName = parseStatementLines(
    purchasesSummaryStatement().replace(
      "CAIRN SYNTHETIC HOLDINGS (CSHZ)",
      "TOTAL RETURN FUND (TRNF)".padEnd(
        "CAIRN SYNTHETIC HOLDINGS (CSHZ)".length,
      ),
    ),
    kind,
  );
  assert.equal(datedTotalName.holdings.positions.length, 1);
  assert.equal(datedTotalName.holdings.positions[0].instrument.symbol, "TRNF");

  const completeLots = parseStatementLines(noTotalStatement(), kind);
  assert.equal(completeLots.holdings.positions.length, 1);
  assert.equal(completeLots.holdings.positions[0].marketValue, "240");
});

const sameSectionSubtotal = ({
  label = "COMMON STOCKS",
  tradeDate = null,
} = {}) =>
  place([
    { text: label, start: 8 },
    ...(tradeDate === null ? [] : [{ text: tradeDate, end: 62 }]),
    { text: "$100.00", end: 134 },
    { text: "$120.00", end: 150 },
    { text: "$20.00", end: 164 },
    { text: "$3.00", end: 180 },
    { text: "2.5%", end: 188 },
  ]);

function sameSectionSubtotalStatement({
  includeAssetClass = true,
  label,
  tradeDate,
  marketValue = "$100.00",
} = {}) {
  const [section, header, datedRow] = lotsWithoutTotalLines({
    first: { marketValue },
  });
  return [
    "        Page 1 of 1",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    "        Synthetic Active Assets Account    123-456789-012",
    "        HOLDINGS",
    section,
    header,
    datedRow,
    ...(includeAssetClass
      ? ["        Next Dividend Payable 04/2026; Asset Class: Equities"]
      : []),
    sameSectionSubtotal({ label, tradeDate }),
    place([{ text: "$6.00 ST", end: 164 }]),
    place([{ text: "$7.00 ST", end: 164 }]),
    place([
      { text: "Unrealized", end: 164 },
      { text: "Current", end: 180 },
    ]),
  ].join("\n");
}

test("an exact same-section subtotal after Asset Class closes a complete security", () => {
  const text = sameSectionSubtotalStatement();
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 1);
  const [position] = parsed.holdings.positions;
  assert.equal(position.instrument.symbol, "CSHZ");
  assert.equal(position.marketValue, "100");
  assert.equal(position.locators.marketValue.binding.quote, "$100.00");
  const [scope] = parsed.holdings.positionScopes;
  assert.equal(scope.status, "complete");
  assert.deepEqual(scope.gapCodes, []);
  assert.equal(
    scope.evidence.tables[0].end.binding.quote,
    sameSectionSubtotal().trim(),
  );
});

test("same-section subtotal recognition requires its marker, section, undated shape and complete predecessor", () => {
  for (const [name, options] of [
    ["no Asset Class marker", { includeAssetClass: false }],
    ["mismatched section", { label: "CORPORATE FIXED INCOME" }],
  ]) {
    const parsed = parseStatementLines(
      sameSectionSubtotalStatement(options),
      kind,
    );
    assert.deepEqual(parsed.holdings.positions, [], name);
    assert.ok(
      parsed.holdings.positionScopes[0].gapCodes.includes("unresolved_lots"),
      name,
    );
  }

  const dated = parseStatementLines(
    sameSectionSubtotalStatement({ tradeDate: "03/01/26" }),
    kind,
  );
  assert.equal(dated.holdings.positions.length, 2);
  assert.equal(dated.holdings.positions[1].instrument.name, "COMMON STOCKS");

  const incomplete = parseStatementLines(
    sameSectionSubtotalStatement({ marketValue: "" }),
    kind,
  );
  assert.notEqual(
    incomplete.holdings.positionScopes[0].evidence.tables[0].end.binding.quote,
    sameSectionSubtotal().trim(),
  );
});

const EQUITY_TEST_COLUMNS = {
  description: { start: 8 },
  tradeDate: { end: 62 },
  quantity: { end: 92 },
  price: { end: 120 },
  costBasis: { end: 134 },
  marketValue: { end: 150 },
  unrealized: { end: 164 },
};

function undatedTickerRow({
  description,
  quantity = "5.000",
  price = "$20.000",
  costBasis = "$90.00",
  marketValue = "$100.00",
  unrealized = "$10.00",
}) {
  return place([
    { text: description, ...EQUITY_TEST_COLUMNS.description },
    { text: quantity, ...EQUITY_TEST_COLUMNS.quantity },
    { text: price, ...EQUITY_TEST_COLUMNS.price },
    { text: costBasis, ...EQUITY_TEST_COLUMNS.costBasis },
    { text: marketValue, ...EQUITY_TEST_COLUMNS.marketValue },
    { text: unrealized, ...EQUITY_TEST_COLUMNS.unrealized },
  ]);
}

function equityTotalRow({
  quantity = "5.000",
  costBasis = "90.00",
  marketValue = "100.00",
  unrealized = "10.00",
} = {}) {
  return place([
    { text: "Total", ...EQUITY_TEST_COLUMNS.tradeDate },
    { text: quantity, ...EQUITY_TEST_COLUMNS.quantity },
    { text: costBasis, ...EQUITY_TEST_COLUMNS.costBasis },
    { text: marketValue, ...EQUITY_TEST_COLUMNS.marketValue },
    { text: unrealized, ...EQUITY_TEST_COLUMNS.unrealized },
  ]);
}

function identifierStartStatement(rows, header = EQUITY_HEADER) {
  return [
    "        Page 1 of 1",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    `        ${CONSOLIDATED_ACCOUNT_ONE}`,
    "        Account Synthetic Household",
    "        HOLDINGS",
    "        COMMON STOCKS",
    header,
    ...rows,
    "        TOTAL",
  ].join("\n");
}

function positiveCents(value) {
  const [whole, fraction = ""] = value.replace(/[$,]/g, "").split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

test("a distinct parenthesized ticker starts an undated security with exact totals and locators", () => {
  const first = equityBlockLines().slice(2, 5);
  const second = undatedTickerRow({
    description: "SYNTHETIC SECOND FUND (SNDF)",
  });
  const text = identifierStartStatement([...first, second, equityTotalRow()]);
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 2);
  const [dated, undated] = parsed.holdings.positions;
  assert.equal(dated.instrument.symbol, "WNDF");
  assert.equal(dated.marketValue, "3184");
  assert.equal(
    positiveCents("1910.40") + positiveCents("1273.60"),
    positiveCents(dated.marketValue),
  );
  assert.equal(undated.instrument.symbol, "SNDF");
  assert.equal(undated.quantity, "5");
  assert.equal(undated.price, "20");
  assert.equal(undated.marketValue, "100");
  assert.equal(
    resolveStatementMoney("$100.00").value,
    resolveStatementMoney(undated.locators.marketValue.binding.quote).value,
  );
  assert.equal(
    parsed.holdings.positions.reduce(
      (sum, position) => sum + positiveCents(position.marketValue),
      0n,
    ),
    328400n,
  );
  for (const [field, quote] of [
    ["quantity", "5.000"],
    ["price", "$20.000"],
    ["marketValue", "100.00"],
  ]) {
    const binding = undated.locators[field].binding;
    assert.equal(binding.quote, quote);
    assert.equal(text.slice(binding.start, binding.end), quote);
  }
});

test("one adjacent same-page CUSIP detail row can identify an undated priced bond", () => {
  const block = bondBlockLines();
  const undated = block[2].replace("05/18/25", " ".repeat("05/18/25".length));
  const text = identifierStartStatement([undated, block[3]], block[1]).replace(
    "        COMMON STOCKS",
    block[0],
  );
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 1);
  const [bond] = parsed.holdings.positions;
  assert.equal(bond.instrument.cusip, "00000WNF1");
  assert.equal(bond.quantity, "25000");
  assert.equal(bond.price, "99.5");
  assert.equal(bond.marketValue, "24875");
  for (const field of ["quantity", "price", "marketValue"]) {
    const binding = bond.locators[field].binding;
    assert.equal(text.slice(binding.start, binding.end), binding.quote);
  }
});

test("repeated undated identity stays unresolved even when a Total follows", () => {
  const repeated = undatedTickerRow({
    description: "SYNTHETIC REPEATED FUND (RPTD)",
  });
  const second = repeated.replace("$100.00", "$120.00");
  const conflicting = `${second.slice(0, 83)}1   ${second.slice(87)}`;
  for (const [name, repeatedRow] of [
    ["readable repeated row", second],
    ["unreadable repeated price", second.replace("$20.000", "$2O.000")],
    ["conflicting repeated quantity cells", conflicting],
  ]) {
    const text = identifierStartStatement([
      repeated,
      repeatedRow,
      equityTotalRow({
        quantity: "10.000",
        costBasis: "180.00",
        marketValue: "220.00",
        unrealized: "20.00",
      }),
    ]);
    const parsed = parseStatementLines(text, kind);
    assert.deepEqual(parsed.holdings.positions, [], name);
    assert.ok(
      parsed.holdings.positionScopes[0].gapCodes.includes("unresolved_lots"),
      name,
    );
  }

  const bond = bondBlockLines();
  const undatedBond = bond[2].replace(
    "05/18/25",
    " ".repeat("05/18/25".length),
  );
  const repeatedCusip = identifierStartStatement(
    [undatedBond, bond[3], undatedBond, bond[3]],
    bond[1],
  ).replace("        COMMON STOCKS", bond[0]);
  const parsedCusip = parseStatementLines(repeatedCusip, kind);
  assert.deepEqual(parsedCusip.holdings.positions, []);
  assert.ok(
    parsedCusip.holdings.positionScopes[0].gapCodes.includes("unresolved_lots"),
  );
});

test("identifier-backed starts refuse generic names, unreadable prices and weak CUSIP detail", () => {
  const bond = bondBlockLines();
  const undatedBond = bond[2].replace(
    "05/18/25",
    " ".repeat("05/18/25".length),
  );
  const bondDetailDescription =
    "Coupon Rate 4.250%; Matures 06/01/2031; CUSIP 00000WNF1";
  const duplicateCusips = "CUSIP 00000WNF1; CUSIP 00000WNF2".padEnd(
    bondDetailDescription.length,
  );
  const cases = [
    {
      name: "generic description",
      text: identifierStartStatement([
        undatedTickerRow({ description: "SYNTHETIC UNIDENTIFIED FUND" }),
        equityTotalRow(),
      ]),
    },
    {
      name: "unreadable price",
      text: identifierStartStatement([
        undatedTickerRow({
          description: "SYNTHETIC IDENTIFIED FUND (SIDF)",
          price: "$2O.000",
        }),
        equityTotalRow(),
      ]),
    },
    {
      name: "two CUSIPs",
      text: identifierStartStatement(
        [undatedBond, bond[3].replace(bondDetailDescription, duplicateCusips)],
        bond[1],
      ).replace("        COMMON STOCKS", bond[0]),
    },
    {
      name: "description-only CUSIP",
      text: identifierStartStatement(
        [
          undatedBond,
          place([
            { text: "CUSIP 00000WNF1", ...EQUITY_TEST_COLUMNS.description },
          ]),
        ],
        bond[1],
      ).replace("        COMMON STOCKS", bond[0]),
    },
    {
      name: "CUSIP on another physical page",
      text: identifierStartStatement(
        [undatedBond, PAGE_SEPARATOR, bond[3]],
        bond[1],
      ).replace("        COMMON STOCKS", bond[0]),
    },
  ];
  for (const { name, text } of cases) {
    const parsed = parseStatementLines(text, kind);
    assert.deepEqual(parsed.holdings.positions, [], name);
    assert.ok(
      parsed.holdings.positionScopes[0].gapCodes.some((code) =>
        ["missing_security_start", "unresolved_lots"].includes(code),
      ),
      name,
    );
  }
});

test("an identifier-shaped undated row cannot leave a section summary", () => {
  const text = identifierStartStatement([
    ...equityBlockLines().slice(2, 5),
    ...sectionSummaryLines(),
    undatedTickerRow({ description: "SUMMARY LOOKALIKE FUND (SLKF)" }),
  ]);
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 1);
  assert.equal(parsed.holdings.positions[0].instrument.symbol, "WNDF");
  assert.equal(
    parsed.holdings.positions.some(
      (position) => position.instrument?.symbol === "SLKF",
    ),
    false,
  );
});

const BOND_TEST_COLUMNS = {
  description: { start: 8 },
  tradeDate: { end: 62 },
  quantity: { end: 92 },
  unitCost: { end: 106 },
  price: { end: 120 },
  costBasis: { end: 136 },
  marketValue: { end: 152 },
  unrealized: { end: 166 },
};

function wrappedBondRows({
  startDescription = "SYNTHETIC FLOATING NOTE VAR 06/15/26",
  percentage = "4.250%",
  descriptor = "Coupon Rate 4.250%; Perpetual Maturity; CUSIP 00000WNF1 06/15/26 1,234.56 99.500",
  startPrice = "$99.500",
  detailPrice = "99.500",
  firstMarket = "$100.00",
  secondMarket = "200.00",
  totalMarket = "300.00",
  includeTotal = true,
} = {}) {
  const rows = [
    place([
      { text: startDescription, ...BOND_TEST_COLUMNS.description },
      { text: "100.000", ...BOND_TEST_COLUMNS.quantity },
      { text: "$98.000", ...BOND_TEST_COLUMNS.unitCost },
      { text: startPrice, ...BOND_TEST_COLUMNS.price },
      { text: "$90.00", ...BOND_TEST_COLUMNS.costBasis },
    ]),
    place([
      { text: percentage, ...BOND_TEST_COLUMNS.description },
      { text: "98.000", ...BOND_TEST_COLUMNS.unitCost },
      { text: "90.00", ...BOND_TEST_COLUMNS.costBasis },
      { text: firstMarket, ...BOND_TEST_COLUMNS.marketValue },
      { text: "$10.00", ...BOND_TEST_COLUMNS.unrealized },
    ]),
    place([
      { text: descriptor, ...BOND_TEST_COLUMNS.description },
      { text: detailPrice, ...BOND_TEST_COLUMNS.price },
      { text: "180.00", ...BOND_TEST_COLUMNS.costBasis },
    ]),
    place([
      { text: "98.000", ...BOND_TEST_COLUMNS.unitCost },
      { text: "180.00", ...BOND_TEST_COLUMNS.costBasis },
      { text: secondMarket, ...BOND_TEST_COLUMNS.marketValue },
      { text: "20.00", ...BOND_TEST_COLUMNS.unrealized },
    ]),
  ];
  if (!includeTotal) return rows;
  return rows.concat(
    place([
      { text: "Total", ...BOND_TEST_COLUMNS.tradeDate },
      { text: "300.000", ...BOND_TEST_COLUMNS.quantity },
      { text: "270.00", ...BOND_TEST_COLUMNS.costBasis },
    ]),
    place([
      { text: "270.00", ...BOND_TEST_COLUMNS.costBasis },
      { text: totalMarket, ...BOND_TEST_COLUMNS.marketValue },
      { text: "30.00", ...BOND_TEST_COLUMNS.unrealized },
    ]),
  );
}

function wrappedBondStatement(rows = wrappedBondRows()) {
  return identifierStartStatement(rows, BOND_HEADER).replace(
    "        COMMON STOCKS",
    "        CORPORATE FIXED INCOME",
  );
}

test("the exact six-row wrapped bond uses its paired printed Total and exact evidence", () => {
  const text = wrappedBondStatement();
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 1);
  const [position] = parsed.holdings.positions;
  assert.equal(position.instrument.cusip, "00000WNF1");
  assert.equal(
    position.instrument.name,
    "SYNTHETIC FLOATING NOTE VAR 06/15/26",
  );
  assert.equal(position.quantity, "300");
  assert.equal(position.price, "99.5");
  assert.equal(position.costBasis, "270");
  assert.equal(position.marketValue, "300");
  assert.equal(position.unrealized, "30");
  assert.equal(
    positiveCents("100") + positiveCents("200"),
    positiveCents(position.marketValue),
  );
  for (const [field, quote] of [
    ["quantity", "300.000"],
    ["price", "$99.500"],
    ["costBasis", "270.00"],
    ["marketValue", "300.00"],
  ]) {
    const binding = position.locators[field].binding;
    assert.equal(binding.quote, quote);
    assert.equal(text.slice(binding.start, binding.end), quote);
  }
  assert.equal(position.locators.marketValue.calculation, undefined);
  assert.equal(
    Object.keys(position.locators).some((key) => key.includes(".lot.")),
    false,
  );
  assert.doesNotMatch(position.valuationNote, /summed from/);
  const [scope] = parsed.holdings.positionScopes;
  assert.equal(scope.status, "complete");
  assert.deepEqual(scope.gapCodes, []);
});

test("wrapped bond proof rejects descriptor, identity, topology, numeric and Total defects", () => {
  const base = wrappedBondRows();
  const cases = [
    {
      name: "arbitrary percentage continuation",
      rows: wrappedBondRows({ percentage: "Synthetic continuation" }),
    },
    {
      name: "different detail price",
      rows: wrappedBondRows({ detailPrice: "98.500" }),
    },
    {
      name: "dated-maturity descriptor instead of the proven perpetual form",
      rows: wrappedBondRows({
        descriptor: "Coupon Rate 4.250%; Maturity 06/15/31; CUSIP 00000WNF1",
      }),
    },
    {
      name: "unreadable descriptor suffix",
      rows: wrappedBondRows({
        descriptor:
          "Coupon Rate 4.250%; Perpetual Maturity; CUSIP 00000WNF1 06/15/26 1,23O.56 99.500",
      }),
    },
    {
      name: "duplicate CUSIP",
      rows: wrappedBondRows({
        descriptor:
          "Coupon Rate 4.250%; Perpetual Maturity; CUSIP 00000WNF1 CUSIP 00000WNF2 06/15/26 1,234.56 99.500",
      }),
    },
    {
      name: "competing CUSIP on the start row",
      rows: wrappedBondRows({
        startDescription: "NOTE VAR 06/15/26 CUSIP 111111111",
      }),
    },
    {
      name: "competing ticker identity on the start row",
      rows: wrappedBondRows({
        startDescription: "NOTE VAR 06/15/26 (BOND)",
      }),
    },
    {
      name: "competing security description",
      rows: wrappedBondRows({ percentage: "OTHER FUND (OTHR)" }),
    },
    {
      name: "physical page crossing",
      rows: [...base.slice(0, 2), PAGE_SEPARATOR, ...base.slice(2)],
    },
    {
      name: "header crossing",
      rows: [...base.slice(0, 2), BOND_HEADER, ...base.slice(2)],
    },
    {
      name: "account crossing",
      rows: [
        ...base.slice(0, 2),
        `        ${CONSOLIDATED_ACCOUNT_TWO}`,
        ...base.slice(2),
      ],
    },
    {
      name: "missing paired Total",
      rows: wrappedBondRows({ includeTotal: false }),
    },
    {
      name: "unreadable market amount",
      rows: wrappedBondRows({ firstMarket: "$1O0.00" }),
    },
    {
      name: "market sum disagreement",
      rows: wrappedBondRows({ totalMarket: "301.00" }),
    },
  ];
  for (const { name, rows } of cases) {
    const parsed = parseStatementLines(wrappedBondStatement(rows), kind);
    assert.deepEqual(parsed.holdings.positions, [], name);
    assert.ok(
      parsed.holdings.positionScopes[0].gapCodes.some((code) =>
        ["missing_security_start", "unresolved_lots"].includes(code),
      ),
      name,
    );
  }
});

test("two cells bound to one lot column are refused instead of choosing the first", () => {
  const text = noTotalStatement().replace("       7.000", "   1   7.000");
  assert.notEqual(text, noTotalStatement());
  const parsed = parseStatementLines(text, kind);
  assert.deepEqual(parsed.holdings.positions, []);
  assert.match(parsed.parseNote, /holdings block\(s\) left unparsed/);
});

test("section totals and the next security stay outside a lot sum", () => {
  const parsed = parseStatementLines(
    noTotalStatement({}, [
      ...sectionSummaryLines({ named: true }),
      ...bondBlockLines(),
    ]),
    kind,
  );
  assert.equal(parsed.holdings.positions.length, 2);
  assert.equal(parsed.holdings.positions[0].marketValue, "240");
});

test("page continuations without Total aggregate only after the block completes", () => {
  const pages = pageSplitEquityPages().map((page) =>
    page.filter((line) => !/\bTotal\s+\d/.test(line)),
  );
  // The reprint is semantically identical but its columns and rows shifted
  // together. Each page must bind against its own header offsets.
  pages[1] = pages[1].map((line) =>
    /Security Description|02\/20\/26/.test(line) ? `   ${line}` : line,
  );
  const text = pages
    .map((page) => page.join("\n"))
    .join(`\n${PAGE_SEPARATOR}\n`);
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 1);
  const [position] = parsed.holdings.positions;
  assert.equal(position.quantity, "15");
  assert.equal(position.marketValue, "4776");
  assert.equal(position.locators["marketValue.lot.1"].index, 1);
  assert.equal(position.locators["marketValue.lot.3"].index, 2);
  for (const lot of [1, 2, 3]) {
    const { binding } = position.locators[`marketValue.lot.${lot}`];
    assert.equal(text.slice(binding.start, binding.end), binding.quote);
  }
  assert.deepEqual(parseStatementLines(text, kind), parsed);
  const firstOnly = parseStatementLines(pages[0].join("\n"), kind);
  assert.deepEqual(firstOnly.holdings.positions, []);
});

test("a printed Total continues across a shifted semantic header", () => {
  const pages = pageSplitEquityPages();
  pages[1] = pages[1].map((line) =>
    /Security Description|02\/20\/26|\bTotal\s+15/.test(line)
      ? `    ${line}`
      : line,
  );
  const parsed = parseStatementLines(
    pages.map((page) => page.join("\n")).join(`\n${PAGE_SEPARATOR}\n`),
    kind,
  );
  assert.equal(parsed.holdings.positions.length, 1);
  assert.equal(parsed.holdings.positions[0].instrument.symbol, "WNDF");
  assert.equal(parsed.holdings.positions[0].marketValue, "4776");
});

test("leading and trailing printed-page furniture preserve identical holdings", () => {
  const footerBottom = pageSplitEquityPages();
  const headerTop = footerBottom.map((page) => [...page]);
  headerTop[0] = headerTop[0].slice(0, -1);
  headerTop[1] = [headerTop[1].at(-1), ...headerTop[1].slice(0, -1)];
  const parse = (pages) =>
    parseStatementLines(
      pages.map((page) => page.join("\n")).join(`\n${PAGE_SEPARATOR}\n`),
      kind,
    );
  const bottom = parse(footerBottom);
  const top = parse(headerTop);
  const withoutEvidence = ({ locators: _locators, ...position }) => position;
  assert.deepEqual(
    top.holdings.positions.map(withoutEvidence),
    bottom.holdings.positions.map(withoutEvidence),
  );
  assert.equal(top.holdings.positions.length, 1);
  assert.equal(top.holdings.positions[0].marketValue, "4776");
  for (const parsed of [bottom, top]) {
    assert.equal(parsed.holdings.positionScopes.length, 1);
    assert.equal(parsed.holdings.positionScopes[0].status, "complete");
    assert.deepEqual(parsed.holdings.positionScopes[0].gapCodes, []);
  }
});

test("an unnumbered cover can anchor a complete adjacent printed-page run", () => {
  const pages = pageSplitEquityPages().map((page) =>
    page.filter((line) => !/\bTotal\s+\d/.test(line)),
  );
  const cover = ["        CLIENT STATEMENT   For the Period March 1-31, 2026"];
  pages[0] = pages[0].map((line) =>
    line.replace(/Page 1 of 2/g, "Page 2 of 3"),
  );
  pages[1] = pages[1].map((line) =>
    line.replace(/Page 2 of 2/g, "Page 3 of 3"),
  );
  const parsed = parseStatementLines(
    [cover, ...pages]
      .map((page) => page.join("\n"))
      .join(`\n${PAGE_SEPARATOR}\n`),
    kind,
  );
  assert.equal(parsed.holdings.positions.length, 1);
  assert.equal(parsed.holdings.positions[0].marketValue, "4776");
});

test("uppercase account-page furniture is not a holdings section boundary", () => {
  for (const printedTotal of [false, true]) {
    const pages = pageSplitEquityPages().map((page) =>
      printedTotal ? page : page.filter((line) => !/\bTotal\s+\d/.test(line)),
    );
    for (const page of pages) {
      const accountLine = page.findIndex((line) =>
        line.includes("Synthetic Active"),
      );
      page.splice(
        accountLine,
        1,
        "                                                                 SYNTHETIC ACCOUNT LABEL",
        "                                                                 123-456789-012",
        "        Account Synthetic Example",
      );
    }
    pages[1] = pages[1].map((line) =>
      /Security Description|02\/20\/26|\bTotal\s+15/.test(line)
        ? `   ${line}`
        : line,
    );
    const text = pages
      .map((page) => page.join("\n"))
      .join(`\n${PAGE_SEPARATOR}\n`);
    const parsed = parseStatementLines(text, kind);
    assert.equal(parsed.holdings.positions.length, 1);
    const [position] = parsed.holdings.positions;
    assert.equal(position.instrument.symbol, "WNDF");
    assert.equal(position.accountExternalKey, "123-456789-012");
    assert.equal(position.marketValue, "4776");
    assert.match(position.valuationNote, /COMMON STOCKS holdings table/);
    assert.doesNotMatch(position.valuationNote, /SYNTHETIC ACCOUNT LABEL/);
    assert.deepEqual(
      parseStatementLines(pages[0].join("\n"), kind).holdings.positions,
      [],
    );
    // The same all-caps text after the account marker is an explicit new
    // section, even when it happens to equal the running account label.
    const header = pages[1].findIndex((line) =>
      line.includes("Security Description"),
    );
    pages[1].splice(header, 0, "        SYNTHETIC ACCOUNT LABEL");
    const changed = parseStatementLines(
      pages.map((page) => page.join("\n")).join(`\n${PAGE_SEPARATOR}\n`),
      kind,
    );
    assert.deepEqual(changed.holdings.positions, []);
    assert.match(changed.parseNote, /holdings block\(s\) left unparsed/);
  }
});

test("matching columns cannot join an explicitly different holdings section", () => {
  for (const printedTotal of [false, true]) {
    for (const section of [
      "MUTUAL FUNDS",
      "ETFS & CEFS",
      "MUNICIPAL BONDS",
      "ALTERNATIVE INVESTMENTS",
      "SYNTHETIC NEW ASSET CLASS",
      "COMMON STOCKS (CONTINUED)",
    ]) {
      const pages = pageSplitEquityPages().map((page) =>
        printedTotal ? page : page.filter((line) => !/\bTotal\s+\d/.test(line)),
      );
      const header = pages[1].findIndex((line) =>
        line.includes("Security Description"),
      );
      pages[1].splice(header, 0, `        ${section}`);
      const parsed = parseStatementLines(
        pages.map((page) => page.join("\n")).join(`\n${PAGE_SEPARATOR}\n`),
        kind,
      );
      const joined = parsed.holdings.positions.find(
        (position) => position.instrument?.symbol === "WNDF",
      );
      if (section !== "COMMON STOCKS (CONTINUED)") {
        assert.equal(joined, undefined);
        assert.deepEqual(parsed.holdings.positions, []);
        assert.match(parsed.parseNote, /holdings block\(s\) left unparsed/);
      } else {
        assert.equal(joined.marketValue, "4776");
      }
    }
  }
});

test("page topology and semantic changes cannot complete an interrupted lot block", () => {
  const cases = [
    {
      name: "zero-based printed page",
      mutate(pages) {
        pages[0] = pages[0].map((line) =>
          line.replace(/Page 1 of 2/g, "Page 0 of 2"),
        );
        pages[1] = pages[1].map((line) =>
          line.replace(/Page 2 of 2/g, "Page 1 of 2"),
        );
      },
    },
    {
      name: "missing cover",
      mutate(pages) {
        pages[0] = pages[0].map((line) =>
          line.replace(/Page 1 of 2/g, "Page 2 of 3"),
        );
        pages[1] = pages[1].map((line) =>
          line.replace(/Page 2 of 2/g, "Page 3 of 3"),
        );
      },
    },
    {
      name: "missing middle page",
      mutate(pages) {
        pages[0] = pages[0].map((line) =>
          line.replace(/Page 1 of 2/g, "Page 1 of 3"),
        );
        pages[1] = pages[1].map((line) =>
          line.replace(/Page 2 of 2/g, "Page 3 of 3"),
        );
      },
    },
    {
      name: "duplicate page number",
      mutate(pages) {
        pages[1] = pages[1].map((line) =>
          line.replace(/Page 2 of 2/g, "Page 1 of 2"),
        );
      },
    },
    {
      name: "reordered page number",
      mutate(pages) {
        pages[0] = pages[0].map((line) =>
          line.replace(/Page 1 of 2/g, "Page 2 of 2"),
        );
        pages[1] = pages[1].map((line) =>
          line.replace(/Page 2 of 2/g, "Page 1 of 2"),
        );
      },
    },
    {
      name: "inconsistent total",
      mutate(pages) {
        pages[1] = pages[1].map((line) =>
          line.replace(/Page 2 of 2/g, "Page 2 of 3"),
        );
      },
    },
    {
      name: "missing successor footer",
      mutate(pages) {
        pages[1] = pages[1].filter((line) => !/Page 2 of 2/.test(line));
      },
    },
    {
      name: "conflicting successor declarations",
      mutate(pages) {
        pages[1].push("        Page 2 of 3");
      },
    },
    {
      name: "changed column semantics",
      mutate(pages) {
        pages[1] = pages[1].map((line) =>
          line.replace("Market Value", "Value       "),
        );
      },
    },
  ];
  for (const { name, mutate } of cases) {
    const pages = pageSplitEquityPages().map((page) =>
      page.filter((line) => !/\bTotal\s+\d/.test(line)),
    );
    mutate(pages);
    const parsed = parseStatementLines(
      pages.map((page) => page.join("\n")).join(`\n${PAGE_SEPARATOR}\n`),
      kind,
    );
    assert.equal(
      parsed.holdings.positions.some(
        (position) =>
          position.instrument?.symbol === "WNDF" ||
          position.marketValue === "4776",
      ),
      false,
      name,
    );
    assert.match(parsed.parseNote, /holdings block\(s\) left unparsed/, name);
  }
});

test("an empty extracted page prevents a page-spanning lot completion", () => {
  const pages = pageSplitEquityPages().map((page) =>
    page.filter((line) => !/\bTotal\s+\d/.test(line)),
  );
  const parsed = parseStatementLines(
    [pages[0].join("\n"), "", pages[1].join("\n")].join(
      `\n${PAGE_SEPARATOR}\n`,
    ),
    kind,
  );
  assert.equal(
    parsed.holdings.positions.some(
      (position) =>
        position.instrument?.symbol === "WNDF" ||
        position.marketValue === "4776",
    ),
    false,
  );
  assert.match(parsed.parseNote, /holdings block\(s\) left unparsed/);
});

test("an interrupted or missing page produces only a partial position scope", () => {
  const cases = [
    {
      name: "interrupted",
      pages: [pageSplitEquityPages()[0]],
    },
    {
      name: "missing middle page",
      pages: pageSplitEquityPages().map((page, index) =>
        page.map((line) =>
          line.replace(
            index === 0 ? /Page 1 of 2/g : /Page 2 of 2/g,
            index === 0 ? "Page 1 of 3" : "Page 3 of 3",
          ),
        ),
      ),
    },
  ];
  for (const { name, pages } of cases) {
    const parsed = parseStatementLines(
      pages.map((page) => page.join("\n")).join(`\n${PAGE_SEPARATOR}\n`),
      kind,
    );
    assert.equal(parsed.holdings.positionScopes.length, 1, name);
    const [scope] = parsed.holdings.positionScopes;
    assert.equal(scope.status, "partial", name);
    assert.ok(scope.gapCodes.includes("page_sequence_gap"), name);
    assert.equal(scope.zeroBasis, undefined, name);
  }
});

test("a printed Total after a page gap cannot complete the interrupted security", () => {
  const pages = pageSplitEquityPages();
  pages[0] = pages[0].map((line) =>
    line.replace(/Page 1 of 2/g, "Page 1 of 3"),
  );
  pages[1] = pages[1].map((line) =>
    line.replace(/Page 2 of 2/g, "Page 3 of 3"),
  );
  const parsed = parseStatementLines(
    pages.map((page) => page.join("\n")).join(`\n${PAGE_SEPARATOR}\n`),
    kind,
  );
  // Neither the interrupted prefix nor its unidentified successor is a
  // complete security. A printed aggregate alone cannot establish identity.
  assert.deepEqual(parsed.holdings.positions, []);
  assert.match(parsed.parseNote, /holdings block\(s\) left unparsed/);
});

test("an isolated successor cannot become an anonymous holding", () => {
  for (const printedTotal of [false, true]) {
    const page = pageSplitEquityPages()[1].filter(
      (line) => printedTotal || !/\bTotal\s+\d/.test(line),
    );
    const parsed = parseStatementLines(page.join("\n"), kind);
    assert.deepEqual(parsed.holdings.positions, []);
    assert.match(parsed.parseNote, /holdings block\(s\) left unparsed/);
  }
});

test("an earlier topology defect cannot become a physical-number anchor", () => {
  for (const priorPage of [
    ["        prior page", "        Page 2 of 5"],
    ["        prior page with no footer"],
  ]) {
    for (const printedTotal of [false, true]) {
      const pages = pageSplitEquityPages().map((page) =>
        printedTotal ? page : page.filter((line) => !/\bTotal\s+\d/.test(line)),
      );
      pages[0] = pages[0].map((line) =>
        line.replace(/Page 1 of 2/g, "Page 3 of 4"),
      );
      pages[1] = pages[1].map((line) =>
        line.replace(/Page 2 of 2/g, "Page 4 of 4"),
      );
      const cover = [
        "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      ];
      const parsed = parseStatementLines(
        [cover, priorPage, ...pages]
          .map((page) => page.join("\n"))
          .join(`\n${PAGE_SEPARATOR}\n`),
        kind,
      );
      assert.equal(
        parsed.holdings.positions.some(
          (position) => position.instrument?.symbol === "WNDF",
        ),
        false,
      );
      assert.match(
        parsed.parseNote,
        /holdings block\(s\) left unparsed/,
        "a balance-sheet note alone must not satisfy this assertion",
      );
    }
  }
});

test("a continuation for another account cannot complete a lot block", () => {
  const text = noTotalStatement({}, [
    "        Page 1 of 2",
    PAGE_SEPARATOR,
    "        987-654321-098",
    ...lotsWithoutTotalLines(),
    "        Page 2 of 2",
  ]);
  const parsed = parseStatementLines(text, kind);
  assert.deepEqual(parsed.holdings.positions, []);
  assert.match(parsed.parseNote, /holdings block\(s\) left unparsed/);
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

// F1-76. Three different reasons a position has no market value used to share
// one note, `no value stated ("")`, which told a reviewer nothing about which
// of them it was: the note is the `ambiguous_market_value` review item's whole
// reason (importer.ts). None of them is read as a value here either.
function unvaluedPosition(options) {
  const text = [
    "        Page 1 of 1",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    "        Synthetic Active Assets Account    123-456789-012",
    "        HOLDINGS",
    ...equityBlockLines(options),
  ].join("\n");
  const [position] = parseStatementLines(text, kind).holdings.positions;
  assert.equal(position.marketValue, null);
  return position.marketValueNote;
}

test("a market value the statement itself states none for quotes what it printed", () => {
  // The source's own answer, and the em dash is the evidence it is the
  // source's: nothing here is a parser gap to go and fix.
  assert.equal(unvaluedPosition({ marketValue: "—" }), 'no value stated ("—")');
});

test("a market value column no row of the block binds says so, not that none was stated", () => {
  assert.equal(
    unvaluedPosition({ marketValue: "", lotMarketValues: ["", ""] }),
    "no Market Value cell bound on this security's 3 row(s)",
  );
});

test("a position row stating no market value over lots that disagree says that instead", () => {
  assert.match(
    unvaluedPosition({ marketValue: "" }),
    /^this position's row states no Market Value and the security's other 2 row\(s\) do not agree/,
  );
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
  const equity = parsed.holdings.positions.find(
    (p) => p.instrument?.symbol === "WNDF",
  );
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

test("a consolidated statement proves each account balance from exact bounded source spans", () => {
  const parsed = parseStatementLines(CONSOLIDATED_LAYOUT_TEXT, kind);
  assert.deepEqual(
    parsed.holdings.balanceScopes.map((scope) => ({
      accountExternalKey: scope.accountExternalKey,
      asOf: scope.asOf,
      status: scope.status,
      emittedBalanceCount: scope.emittedBalanceCount,
      gapCodes: scope.gapCodes,
      proofVersion: scope.proofVersion,
    })),
    [
      {
        accountExternalKey: CONSOLIDATED_ACCOUNT_ONE,
        asOf: "2026-03-31",
        status: "complete",
        emittedBalanceCount: 1,
        gapCodes: [],
        proofVersion: "balance_scope_v1",
      },
      {
        accountExternalKey: CONSOLIDATED_ACCOUNT_TWO,
        asOf: "2026-03-31",
        status: "complete",
        emittedBalanceCount: 1,
        gapCodes: [],
        proofVersion: "balance_scope_v1",
      },
    ],
  );
  for (const scope of parsed.holdings.balanceScopes) {
    for (const locator of Object.values(scope.evidence)) {
      assert.equal(locator.binding.format, "retained_text_span_v1");
      assert.equal(
        CONSOLIDATED_LAYOUT_TEXT.slice(
          locator.binding.start,
          locator.binding.end,
        ),
        locator.binding.quote,
      );
    }
    assert.match(scope.evidence.header.binding.quote, /BALANCE SHEET/);
    assert.match(scope.evidence.asOf.binding.quote, /as of 03\/31\/26/);
    assert.match(scope.evidence.row.binding.quote, /^TOTAL VALUE/);
    assert.match(scope.evidence.scopeEnd.binding.quote, /^TOTAL VALUE/);
  }
});

test("a balance block cannot borrow its date and total from the next account", () => {
  const text = [
    "        Page 1 of 1",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    CONSOLIDATED_ACCOUNT_ONE,
    "        Account Synthetic Household",
    "        BALANCE SHEET",
    "        section intentionally has no date or total",
    CONSOLIDATED_ACCOUNT_TWO,
    "        Account Synthetic Household",
    ...balanceSheetLines({ totalValueThis: "$512,340.00" }),
    "        HOLDINGS",
  ].join("\n");
  const parsed = parseStatementLines(text, kind);
  assert.deepEqual(
    parsed.holdings.balances.map((balance) => ({
      accountExternalKey: balance.accountExternalKey,
      totalValue: balance.totalValue,
    })),
    [
      {
        accountExternalKey: CONSOLIDATED_ACCOUNT_TWO,
        totalValue: "512340",
      },
    ],
  );
  assert.deepEqual(
    parsed.holdings.balanceScopes.map((scope) => scope.accountExternalKey),
    [CONSOLIDATED_ACCOUNT_TWO],
  );
});

test("an unanchored printed page leaves balance output intact but makes its scope partial", () => {
  const text = CONSOLIDATED_LAYOUT_TEXT.replace("Page 1 of 2", "Page 2 of 3");
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.balances.length, 2);
  assert.equal(parsed.holdings.balanceScopes[0].status, "partial");
  assert.deepEqual(parsed.holdings.balanceScopes[0].gapCodes, [
    "page_sequence_gap",
  ]);
});

test("two TOTAL VALUE rows never become a complete one-row balance proof", () => {
  const totalRow = balanceSheetLines().at(-1);
  const text = CONSOLIDATED_LAYOUT_TEXT.replace(
    "        HOLDINGS",
    `${totalRow}\n        HOLDINGS`,
  );
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.balances.length, 2);
  assert.equal(parsed.holdings.balanceScopes[0].status, "partial");
  assert.deepEqual(parsed.holdings.balanceScopes[0].gapCodes, [
    "multiple_balance_rows",
  ]);
});

test("a later unreadable balance section prevents a complete selector from disappearing", () => {
  const text = CONSOLIDATED_LAYOUT_TEXT.replace(
    "        HOLDINGS",
    [
      "        BALANCE SHEET",
      "        unsupported replacement section with no date or total",
      "        HOLDINGS",
    ].join("\n"),
  );
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.balances.length, 2);
  assert.deepEqual(
    parsed.holdings.balanceScopes.map((scope) => scope.accountExternalKey),
    [CONSOLIDATED_ACCOUNT_TWO],
    "no arbitrary complete scope survives two observed sections for account one",
  );
});

test("a consolidated statement attributes each position to the account whose pages it was printed under", () => {
  const parsed = parseStatementLines(CONSOLIDATED_LAYOUT_TEXT, kind);
  assert.equal(parsed.holdings.positions.length, 2);
  const [equity, bond] = parsed.holdings.positions;
  assert.equal(equity.accountExternalKey, CONSOLIDATED_ACCOUNT_ONE);
  assert.equal(bond.accountExternalKey, CONSOLIDATED_ACCOUNT_TWO);
});

test("a consolidated statement proves each account position scope from bounded tables", () => {
  const parsed = parseStatementLines(CONSOLIDATED_LAYOUT_TEXT, kind);
  assert.deepEqual(
    parsed.holdings.positionScopes.map((scope) => ({
      accountExternalKey: scope.accountExternalKey,
      asOf: scope.asOf,
      status: scope.status,
      emittedPositionCount: scope.emittedPositionCount,
      gapCodes: scope.gapCodes,
      proofVersion: scope.proofVersion,
    })),
    [
      {
        accountExternalKey: CONSOLIDATED_ACCOUNT_ONE,
        asOf: "2026-03-31",
        status: "complete",
        emittedPositionCount: 1,
        gapCodes: [],
        proofVersion: "position_scope_v1",
      },
      {
        accountExternalKey: CONSOLIDATED_ACCOUNT_TWO,
        asOf: "2026-03-31",
        status: "complete",
        emittedPositionCount: 1,
        gapCodes: [],
        proofVersion: "position_scope_v1",
      },
    ],
  );
  for (const scope of parsed.holdings.positionScopes) {
    assert.ok(scope.evidence.account?.binding);
    assert.ok(scope.evidence.scopeEnd?.binding);
    assert.ok(scope.evidence.tables.length > 0);
    for (const table of scope.evidence.tables) {
      assert.ok(table.headers.length > 0);
      assert.ok(table.end?.binding);
      for (const locator of [...table.headers, table.end]) {
        assert.equal(
          CONSOLIDATED_LAYOUT_TEXT.slice(
            locator.binding.start,
            locator.binding.end,
          ),
          locator.binding.quote,
        );
      }
    }
  }
});

test("a source section summary closes a table before next-page furniture", () => {
  const text = [
    [
      "        Page 1 of 2",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      CONSOLIDATED_ACCOUNT_ONE,
      "        Account Synthetic Household",
      "        HOLDINGS",
      ...equityBlockLines(),
      ...sectionSummaryLines(),
    ].join("\n"),
    [
      "        Page 2 of 2",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      CONSOLIDATED_ACCOUNT_ONE,
      "        Account Synthetic Household",
      "        ACTIVITY",
    ].join("\n"),
  ].join(`\n${PAGE_SEPARATOR}\n`);
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 1);
  const [scope] = parsed.holdings.positionScopes;
  assert.equal(scope.status, "complete");
  assert.deepEqual(scope.gapCodes, []);
  assert.match(
    scope.evidence.tables[0].end.binding.quote,
    /^(Percentage|of Holdings)/,
  );
});

test("a dated row without a security description after a summary remains partial", () => {
  const described = equityBlockLines()[2];
  const name = "WIDGET NEUTRAL FUND (WNDF)";
  const missingDescription = described.replace(name, " ".repeat(name.length));
  const text = [
    [
      "        Page 1 of 2",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      CONSOLIDATED_ACCOUNT_ONE,
      "        Account Synthetic Household",
      "        HOLDINGS",
      ...equityBlockLines(),
      ...sectionSummaryLines(),
      missingDescription,
      ...sectionSummaryLines(),
    ].join("\n"),
    [
      "        Page 2 of 2",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      CONSOLIDATED_ACCOUNT_ONE,
      "        Account Synthetic Household",
      "        ACTIVITY",
    ].join("\n"),
  ].join(`\n${PAGE_SEPARATOR}\n`);
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 1);
  const [scope] = parsed.holdings.positionScopes;
  assert.equal(scope.status, "partial");
  assert.ok(scope.gapCodes.includes("missing_security_start"));
});

test("an adjacent anchored ACTIVITY section closes an independently complete carried position", () => {
  const text = [
    [
      "        Page 1 of 2",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      CONSOLIDATED_ACCOUNT_ONE,
      "        Account Synthetic Household",
      "        HOLDINGS",
      ...equityBlockLines(),
    ].join("\n"),
    [
      "        Page 2 of 2",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      CONSOLIDATED_ACCOUNT_ONE,
      "        Account Synthetic Household",
      "        ACTIVITY",
    ].join("\n"),
  ].join(`\n${PAGE_SEPARATOR}\n`);
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 1);
  const [scope] = parsed.holdings.positionScopes;
  assert.equal(scope.status, "complete");
  assert.deepEqual(scope.gapCodes, []);
  assert.equal(scope.evidence.tables[0].end.binding.quote, "ACTIVITY");
});

function adjacentSummaryText({
  nextPage = "Page 2 of 2",
  nextAccount = CONSOLIDATED_ACCOUNT_ONE,
  nextClient = "CLIENT STATEMENT   For the Period March 1-31, 2026",
  includeSection = true,
  beforeSummary = [],
  afterSummaryHeader = [],
} = {}) {
  const client = "CLIENT STATEMENT   For the Period March 1-31, 2026";
  const personal = "Personal investment statement";
  const accountTitle = "Account Synthetic Household";
  const accountTitleContinuation = "PERSONAL ADVISORY SERVICES";
  return [
    [
      "        Page 1 of 2",
      `        ${client}`,
      `        ${personal}`,
      CONSOLIDATED_ACCOUNT_ONE,
      `        ${accountTitle}`,
      `        ${accountTitleContinuation}`,
      "        HOLDINGS",
      ...(includeSection ? equityBlockLines() : equityBlockLines().slice(1)),
    ].join("\n"),
    [
      `        ${nextPage}`,
      `        ${nextClient}`,
      `        ${personal}`,
      nextAccount,
      `        ${accountTitle}`,
      `        ${accountTitleContinuation}`,
      ...beforeSummary,
      ...sectionSummaryLines().slice(0, 2),
      ...afterSummaryHeader,
      ...sectionSummaryLines().slice(2),
      "        ACTIVITY",
    ].join("\n"),
  ].join(`\n${PAGE_SEPARATOR}\n`);
}

test("an exact repeated next-page header and section summary close a carried position", () => {
  const parsed = parseStatementLines(adjacentSummaryText(), kind);
  assert.equal(parsed.holdings.positions.length, 1);
  const [scope] = parsed.holdings.positionScopes;
  assert.equal(scope.status, "complete");
  assert.deepEqual(scope.gapCodes, []);
  assert.match(scope.evidence.tables[0].end.binding.quote, /^Percentage\b/);
});

test("the repeated account header bounds a successor summary without a nearby section title", () => {
  const parsed = parseStatementLines(
    adjacentSummaryText({ includeSection: false }),
    kind,
  );
  assert.equal(parsed.holdings.positions.length, 1);
  const [scope] = parsed.holdings.positionScopes;
  assert.equal(scope.status, "complete");
  assert.deepEqual(scope.gapCodes, []);
});

test("successor summary uses the latest header of a table carried across several pages", () => {
  const client = "CLIENT STATEMENT   For the Period March 1-31, 2026";
  const personal = "Personal investment statement";
  const accountTitle = "Account Synthetic Household";
  const continuation = "Personal advisory services";
  const block = equityBlockLines();
  const runningHeader = [
    `        ${client}`,
    `        ${personal}`,
    CONSOLIDATED_ACCOUNT_ONE,
    `        ${accountTitle}`,
    `        ${continuation}`,
  ];
  const text = [
    [
      "        Page 1 of 3",
      ...runningHeader,
      "        HOLDINGS",
      block[0],
      block[1],
      block[2],
    ].join("\n"),
    [
      "        Page 2 of 3",
      ...runningHeader,
      block[1],
      block[3],
      block[4],
      block[5],
    ].join("\n"),
    [
      "        Page 3 of 3",
      ...runningHeader,
      ...sectionSummaryLines(),
      "        ACTIVITY",
    ].join("\n"),
  ].join(`\n${PAGE_SEPARATOR}\n`);
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 1);
  const [scope] = parsed.holdings.positionScopes;
  assert.equal(scope.status, "complete");
  assert.deepEqual(scope.gapCodes, []);
});

test("the first percentage row proves closure without consuming later summaries", () => {
  const percentage = sectionSummaryLines()[2];
  const parsed = parseStatementLines(
    adjacentSummaryText({
      afterSummaryHeader: [
        percentage,
        "        SYNTHETIC SUMMARY CLASS",
        "        Summary class detail",
        ...sectionSummaryLines().slice(0, 2),
        percentage,
        "        TOTAL HOLDINGS",
        "        Subsequent summary prose is outside the proved boundary",
      ],
    }),
    kind,
  );
  assert.equal(parsed.holdings.positions.length, 1);
  const [scope] = parsed.holdings.positionScopes;
  assert.equal(scope.status, "complete");
  assert.deepEqual(scope.gapCodes, []);
});

test("adjacent summary closure refuses topology, account, header and security changes", () => {
  const datedSecurity = equityBlockLines()[2];
  const cases = [
    {
      name: "missing printed page",
      options: { nextPage: "Page 3 of 3" },
    },
    {
      name: "changed account",
      options: { nextAccount: CONSOLIDATED_ACCOUNT_TWO },
    },
    {
      name: "changed repeated header",
      options: {
        nextClient: "CLIENT STATEMENT   For the Period February 1-28, 2026",
      },
    },
    {
      name: "unknown intervening content",
      options: { beforeSummary: ["        New unsupported section"] },
    },
    {
      name: "dated security after summary",
      options: { afterSummaryHeader: [datedSecurity] },
    },
    {
      name: "dated TOTAL-named security after summary",
      options: {
        afterSummaryHeader: [
          datedSecurity.replace(
            "WIDGET NEUTRAL FUND (WNDF)",
            "TOTAL RETURN FUND (TRNF)",
          ),
        ],
      },
    },
    {
      name: "new section label after summary",
      options: { afterSummaryHeader: ["        UNKNOWN ASSET CLASS"] },
    },
  ];
  for (const { name, options } of cases) {
    const parsed = parseStatementLines(adjacentSummaryText(options), kind);
    assert.equal(
      parsed.holdings.positions.length,
      1,
      `${name}: row emission remains unchanged`,
    );
    const scope = parsed.holdings.positionScopes.find(
      (candidate) => candidate.accountExternalKey === CONSOLIDATED_ACCOUNT_ONE,
    );
    assert.equal(scope.status, "partial", name);
    assert.ok(scope.gapCodes.includes("page_sequence_gap"), name);
  }
});

test("an ACTIVITY marker after a printed-page gap cannot close a carried table", () => {
  const text = [
    [
      "        Page 1 of 3",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      CONSOLIDATED_ACCOUNT_ONE,
      "        Account Synthetic Household",
      "        HOLDINGS",
      ...equityBlockLines(),
    ].join("\n"),
    [
      "        Page 3 of 3",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      CONSOLIDATED_ACCOUNT_ONE,
      "        Account Synthetic Household",
      "        ACTIVITY",
    ].join("\n"),
  ].join(`\n${PAGE_SEPARATOR}\n`);
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 1);
  const [scope] = parsed.holdings.positionScopes;
  assert.equal(scope.status, "partial");
  assert.ok(scope.gapCodes.includes("page_sequence_gap"));
});

test("another account's ACTIVITY marker cannot close a carried table", () => {
  const text = [
    [
      "        Page 1 of 2",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      CONSOLIDATED_ACCOUNT_ONE,
      "        Account Synthetic Household",
      "        HOLDINGS",
      ...equityBlockLines(),
    ].join("\n"),
    [
      "        Page 2 of 2",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      CONSOLIDATED_ACCOUNT_TWO,
      "        Account Synthetic Household",
      "        ACTIVITY",
    ].join("\n"),
  ].join(`\n${PAGE_SEPARATOR}\n`);
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 1);
  const firstScope = parsed.holdings.positionScopes.find(
    (scope) => scope.accountExternalKey === CONSOLIDATED_ACCOUNT_ONE,
  );
  assert.equal(firstScope.status, "partial");
  assert.ok(firstScope.gapCodes.includes("page_sequence_gap"));
});

test("Account-prefixed value content is not page furniture before ACTIVITY", () => {
  const text = [
    [
      "        Page 1 of 2",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      CONSOLIDATED_ACCOUNT_ONE,
      "        Account Synthetic Household",
      "        HOLDINGS",
      ...equityBlockLines(),
    ].join("\n"),
    [
      "        Page 2 of 2",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      CONSOLIDATED_ACCOUNT_ONE,
      "        Account Value $74,310.25",
      "        ACTIVITY",
    ].join("\n"),
  ].join(`\n${PAGE_SEPARATOR}\n`);
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 1);
  const [scope] = parsed.holdings.positionScopes;
  assert.equal(scope.status, "partial");
  assert.ok(scope.gapCodes.includes("page_sequence_gap"));
});

test("a new account page-one reset cannot hide the prior account's missing page", () => {
  const [firstPage, secondPage] = CONSOLIDATED_LAYOUT_TEXT.split(
    `\n${PAGE_SEPARATOR}\n`,
  );
  const text = `${firstPage}\n${PAGE_SEPARATOR}\n${secondPage.replace(
    "Page 2 of 2",
    "Page 1 of 1",
  )}`;
  const parsed = parseStatementLines(text, kind);
  assert.equal(
    parsed.holdings.positions.length,
    2,
    "scope proof does not alter established row emission",
  );
  assert.deepEqual(
    parsed.holdings.positionScopes.map((scope) => ({
      accountExternalKey: scope.accountExternalKey,
      status: scope.status,
      gapCodes: scope.gapCodes,
    })),
    [
      {
        accountExternalKey: CONSOLIDATED_ACCOUNT_ONE,
        status: "partial",
        gapCodes: ["page_sequence_gap"],
      },
      {
        accountExternalKey: CONSOLIDATED_ACCOUNT_TWO,
        status: "complete",
        gapCodes: [],
      },
    ],
  );
});

test("a complete non-holdings tail can finish an account before the next page-one reset", () => {
  const [firstPage, secondPage] = CONSOLIDATED_LAYOUT_TEXT.split(
    `\n${PAGE_SEPARATOR}\n`,
  );
  const pages = [
    firstPage.replace("Page 1 of 2", "Page 1 of 4"),
    [
      "        Page 2 of 4",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      "        ACTIVITY",
      "        Synthetic activity section retained in full",
    ].join("\n"),
    [
      "        Page 3 of 4",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      "        DISCLOSURES",
      "        Synthetic disclosure section retained in full",
    ].join("\n"),
    [
      "        Page 4 of 4",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      "        DISCLOSURES",
      "        End of synthetic account section",
    ].join("\n"),
    secondPage.replace("Page 2 of 2", "Page 1 of 1"),
  ];
  const parsed = parseStatementLines(pages.join(`\n${PAGE_SEPARATOR}\n`), kind);
  assert.equal(parsed.holdings.positions.length, 2);
  assert.deepEqual(
    parsed.holdings.positionScopes.map((scope) => ({
      accountExternalKey: scope.accountExternalKey,
      status: scope.status,
      gapCodes: scope.gapCodes,
    })),
    [
      {
        accountExternalKey: CONSOLIDATED_ACCOUNT_ONE,
        status: "complete",
        gapCodes: [],
      },
      {
        accountExternalKey: CONSOLIDATED_ACCOUNT_TWO,
        status: "complete",
        gapCodes: [],
      },
    ],
  );
});

test("continuous global numbering can cross account summaries before the next holdings table", () => {
  const [originalFirstPage, originalSecondPage] =
    CONSOLIDATED_LAYOUT_TEXT.split(`\n${PAGE_SEPARATOR}\n`);
  const firstLines = originalFirstPage.split("\n");
  const firstHoldings = firstLines.indexOf("        HOLDINGS");
  const secondLines = originalSecondPage.split("\n");
  const secondHoldings = secondLines.indexOf("        HOLDINGS");
  const numberedPage = (number, title) =>
    [
      `        Page ${number} of 10`,
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      `        ${title}`,
    ].join("\n");
  const pages = [
    firstLines
      .slice(0, firstHoldings)
      .join("\n")
      .replace("Page 1 of 2", "Page 1 of 10"),
    [
      numberedPage(2, "Synthetic Active Assets Account"),
      CONSOLIDATED_ACCOUNT_ONE,
      "        Account Synthetic Household",
      ...firstLines.slice(firstHoldings),
    ].join("\n"),
    numberedPage(3, "ACTIVITY"),
    numberedPage(4, "ACTIVITY CONTINUED"),
    numberedPage(5, "DISCLOSURES"),
    secondLines
      .slice(0, secondHoldings)
      .join("\n")
      .replace("Page 2 of 2", "Page 6 of 10"),
    numberedPage(7, "ACCOUNT SUMMARY CONTINUED"),
    [
      numberedPage(8, "Synthetic Retirement Assets Account"),
      CONSOLIDATED_ACCOUNT_TWO,
      "        Account Synthetic Household",
      ...secondLines.slice(secondHoldings),
      "        TOTAL",
    ].join("\n"),
    numberedPage(9, "DISCLOSURES"),
    numberedPage(10, "END OF STATEMENT"),
  ];
  const parsed = parseStatementLines(pages.join(`\n${PAGE_SEPARATOR}\n`), kind);
  assert.equal(parsed.holdings.positions.length, 2);
  assert.deepEqual(
    parsed.holdings.positionScopes.map((scope) => ({
      accountExternalKey: scope.accountExternalKey,
      status: scope.status,
      gapCodes: scope.gapCodes,
    })),
    [
      {
        accountExternalKey: CONSOLIDATED_ACCOUNT_ONE,
        status: "complete",
        gapCodes: [],
      },
      {
        accountExternalKey: CONSOLIDATED_ACCOUNT_TWO,
        status: "complete",
        gapCodes: [],
      },
    ],
  );
});

test("one consolidated account can be complete while another has a zero-emitted typed gap", () => {
  const [firstPage, originalSecondPage] = CONSOLIDATED_LAYOUT_TEXT.split(
    `\n${PAGE_SEPARATOR}\n`,
  );
  const secondPagePrefix = originalSecondPage.slice(
    0,
    originalSecondPage.indexOf("        HOLDINGS"),
  );
  const secondPage = [
    secondPagePrefix,
    "        HOLDINGS",
    ...lotsWithoutTotalLines({ second: { sharePrice: "21.000" } }),
  ].join("\n");
  const parsed = parseStatementLines(
    `${firstPage}\n${PAGE_SEPARATOR}\n${secondPage}`,
    kind,
  );
  assert.equal(parsed.holdings.positions.length, 1);
  assert.deepEqual(
    parsed.holdings.positionScopes.map((scope) => ({
      accountExternalKey: scope.accountExternalKey,
      status: scope.status,
      emittedPositionCount: scope.emittedPositionCount,
      gapCodes: scope.gapCodes,
    })),
    [
      {
        accountExternalKey: CONSOLIDATED_ACCOUNT_ONE,
        status: "complete",
        emittedPositionCount: 1,
        gapCodes: [],
      },
      {
        accountExternalKey: CONSOLIDATED_ACCOUNT_TWO,
        status: "partial",
        emittedPositionCount: 0,
        gapCodes: ["unproven_empty", "unresolved_lots"],
      },
    ],
  );
  assert.match(parsed.parseNote, /holdings block\(s\) left unparsed/);
});

test("a table before any consolidated account marker creates no account scope", () => {
  const [rollupPage, ...accountPages] = CONSOLIDATED_ROLLUP_LAYOUT_TEXT.split(
    `\n${PAGE_SEPARATOR}\n`,
  );
  const text = [
    [rollupPage, "        HOLDINGS", ...equityBlockLines()].join("\n"),
    ...accountPages,
  ].join(`\n${PAGE_SEPARATOR}\n`);
  const parsed = parseStatementLines(text, kind);
  assert.equal(
    parsed.holdings.positions.some(
      (position) => position.accountExternalKey === undefined,
    ),
    true,
    "legacy row behavior is unchanged",
  );
  assert.deepEqual(
    parsed.holdings.positionScopes.map((scope) => scope.accountExternalKey),
    [CONSOLIDATED_ACCOUNT_ONE, CONSOLIDATED_ACCOUNT_TWO],
    "an unattributed household table cannot fall back to the pull account",
  );
});

test("unsupported account tables remain partial even beside a recognized table", () => {
  const [originalFirstPage, originalSecondPage] =
    CONSOLIDATED_LAYOUT_TEXT.split(`\n${PAGE_SEPARATOR}\n`);
  const malformed = (line) =>
    line.replace("Security Description", "Security Name       ");
  const unsupportedTail = equityBlockLines().slice(1).map(malformed);
  const firstPage = [
    originalFirstPage,
    "        TOTAL",
    "        SYNTHETIC PRIVATE ASSETS",
    ...unsupportedTail,
  ].join("\n");
  const secondPage = originalSecondPage.split("\n").map(malformed).join("\n");
  const parsed = parseStatementLines(
    `${firstPage}\n${PAGE_SEPARATOR}\n${secondPage}`,
    kind,
  );
  assert.deepEqual(
    parsed.holdings.positionScopes.map((scope) => ({
      accountExternalKey: scope.accountExternalKey,
      status: scope.status,
      emittedPositionCount: scope.emittedPositionCount,
      gapCodes: scope.gapCodes,
    })),
    [
      {
        accountExternalKey: CONSOLIDATED_ACCOUNT_ONE,
        status: "partial",
        emittedPositionCount: 1,
        gapCodes: ["unsupported_table_header"],
      },
      {
        accountExternalKey: CONSOLIDATED_ACCOUNT_TWO,
        status: "partial",
        emittedPositionCount: 0,
        gapCodes: ["unproven_empty", "unsupported_table_header"],
      },
    ],
  );
});

test("a security name containing header words is not an unsupported table", () => {
  const text = STATEMENT_LAYOUT_TEXT.replace(
    "WIDGET NEUTRAL FUND (WNDF)",
    "Security Value Fund (SQVF)",
  );
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 2);
  assert.equal(
    parsed.holdings.positions.some(
      (position) => position.instrument?.symbol === "SQVF",
    ),
    true,
  );
  assert.equal(
    parsed.holdings.positionScopes.some((scope) =>
      scope.gapCodes.includes("unsupported_table_header"),
    ),
    false,
  );
});

test("a consolidated statement attributes a liability to its own account, not the other one", () => {
  const parsed = parseStatementLines(CONSOLIDATED_LAYOUT_TEXT, kind);
  assert.equal(parsed.holdings.liabilities.length, 1);
  const [liability] = parsed.holdings.liabilities;
  assert.equal(liability.accountExternalKey, CONSOLIDATED_ACCOUNT_TWO);
  assert.equal(liability.balance, "1500");
});

// F1-8l: the household roll-up section is the one BALANCE SHEET on a
// consolidated statement that belongs to no single account.
test("a consolidated statement's roll-up BALANCE SHEET is recorded against no account at all", () => {
  const parsed = parseStatementLines(CONSOLIDATED_ROLLUP_LAYOUT_TEXT, kind);
  assert.equal(parsed.holdings.balances.length, 2);
  assert.deepEqual(
    parsed.holdings.balances.map((balance) => balance.accountExternalKey),
    [CONSOLIDATED_ACCOUNT_ONE, CONSOLIDATED_ACCOUNT_TWO],
  );
  // The roll-up's own figures appear nowhere: recording them with no account
  // key is what let the importer attribute them to the pull's own account.
  for (const balance of parsed.holdings.balances) {
    assert.notEqual(balance.totalValue, "1815115.5");
    assert.notEqual(balance.cash, "50318.25");
    assert.notEqual(balance.accountExternalKey, undefined);
  }
  assert.equal(parsed.holdings.liabilities.length, 1);
  assert.equal(
    parsed.holdings.liabilities[0].accountExternalKey,
    CONSOLIDATED_ACCOUNT_TWO,
  );
  assert.match(
    parsed.parseNote,
    /^partially parsed: 1 BALANCE SHEET section\(s\) printed /,
  );
  assert.match(parsed.parseNote, /Consolidated Summary/);
  assert.deepEqual(
    parsed.holdings.balanceScopes.map((scope) => scope.accountExternalKey),
    [CONSOLIDATED_ACCOUNT_ONE, CONSOLIDATED_ACCOUNT_TWO],
    "the unattributed household roll-up has no positive account scope",
  );
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

// --- F1-61: layouts the first pass over the corpus did not cover -----------

test("a security the page break cut in half is one position, not two blocks refused", () => {
  const text = pageSplitEquityPages()
    .map((page) => page.join("\n"))
    .join(`\n${PAGE_SEPARATOR}\n`);
  const parsed = parseStatementLines(text, kind);
  assert.doesNotMatch(
    parsed.parseNote ?? "",
    /holdings block\(s\) left unparsed/,
  );
  assert.equal(
    parsed.holdings.positions.length,
    1,
    "the two halves are one security",
  );
  const [position] = parsed.holdings.positions;
  // The Total row on the second page states the position; the description
  // came from the first page, so the security is still named.
  assert.equal(position.instrument.symbol, "WNDF");
  assert.equal(position.quantity, "15");
  assert.equal(position.marketValue, "4776");
  // The price is per-lot and every lot agrees on it, so it still fills in --
  // across the page break as well as within one page.
  assert.equal(position.price, "318.4");
});

test("a block the page break cut and nothing continued is refused exactly as before", () => {
  const [firstPage] = pageSplitEquityPages();
  const parsed = parseStatementLines(firstPage.join("\n"), kind);
  assert.deepEqual(parsed.holdings.positions, []);
  assert.match(parsed.parseNote, /1 holdings block\(s\) left unparsed/);
});

test("a section's own totals row is not read as a security", () => {
  for (const named of [false, true]) {
    const text = [
      "        Page 1 of 1",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      "        Synthetic Active Assets Account    123-456789-012",
      ...balanceSheetLines(),
      "        HOLDINGS",
      ...equityBlockLines(),
      ...sectionSummaryLines({ named }),
    ].join("\n");
    const parsed = parseStatementLines(text, kind);
    assert.equal(
      parsed.parseNote,
      undefined,
      `totals row (named: ${named}) left a note`,
    );
    assert.equal(
      parsed.holdings.positions.length,
      1,
      "only the security is a position",
    );
    assert.equal(parsed.holdings.positions[0].marketValue, "3184");
  }
});

test("a security printed after a section summary still starts its own block", () => {
  const text = [
    "        Page 1 of 1",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    "        Synthetic Active Assets Account    123-456789-012",
    "        HOLDINGS",
    ...equityBlockLines(),
    ...sectionSummaryLines({ named: true }),
    ...bondBlockLines().slice(2),
  ].join("\n");
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 2);
  assert.equal(parsed.holdings.positions[1].instrument.cusip, "00000WNF1");
});

test("the NAV-priced fund table's `Value` column is that holding's value, at NAV", () => {
  const text = [
    "        Page 1 of 1",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    "        Synthetic Active Assets Account    123-456789-012",
    ...balanceSheetLines(),
    "        HOLDINGS",
    ...navFundBlockLines(),
  ].join("\n");
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.parseNote, undefined);
  const [position] = parsed.holdings.positions;
  assert.equal(position.marketValue, "29625");
  assert.equal(position.price, "118.5");
  // The basis is what the column says it is: this value is a reported NAV,
  // not a market price, and the note says which column it came from.
  assert.equal(position.valuationBasis, "reported_nav");
  assert.match(position.valuationNote, /NAV column/);
});

test("`Value + Distributions` is never read as a holding's value", () => {
  const text = [
    "        Page 1 of 1",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    "        Synthetic Active Assets Account    123-456789-012",
    "        HOLDINGS",
    ...privateHoldingsBlockLines(),
  ].join("\n");
  const parsed = parseStatementLines(text, kind);
  assert.deepEqual(
    parsed.holdings.positions,
    [],
    "a value with distributions in it is not a value",
  );
  assert.match(parsed.parseNote, /states no Market Value or NAV column/);
});

test("a period that opens mid-month names its month twice and still resolves", () => {
  const parsed = parseStatementLines(CROSS_MONTH_LAYOUT_TEXT, kind);
  assert.equal(parsed.parseNote, undefined);
  const [balance] = parsed.holdings.balances;
  assert.equal(balance.totalValue, "1302775.5");
  // The as-of rule is unchanged: the period's own end date, never today.
  assert.equal(balance.asOf, "2026-03-31");
});

test("a period running backwards over a year boundary is refused, not assumed", () => {
  const parsed = parseStatementLines(YEAR_ROLLOVER_LAYOUT_TEXT, kind);
  assert.deepEqual(parsed.holdings.balances, []);
  assert.match(parsed.parseNote, /period is unknown/);
});

test("the cover page's account total is read when there is no BALANCE SHEET block", () => {
  const parsed = parseStatementLines(COVER_TOTAL_LAYOUT_TEXT, kind);
  assert.equal(parsed.parseNote, undefined);
  const [balance] = parsed.holdings.balances;
  assert.equal(balance.totalValue, "74310.25");
  assert.equal(balance.periodEndValue, "74310.25");
  assert.equal(balance.asOf, "2026-03-31");
  // The banner states one number: no cash, no opening value, no liability,
  // and the note says so rather than leaving a reader to assume zero.
  assert.equal(balance.cash, null);
  assert.equal(balance.periodStartValue, null);
  assert.deepEqual(parsed.holdings.liabilities, []);
  assert.match(balance.totalValueNote, /prints no BALANCE SHEET block/);
});

test("an explicitly account-bound cover total proves one complete balance", () => {
  const text = COVER_TOTAL_LAYOUT_TEXT.replace(
    "        Synthetic Active Assets Account    123-456789-012",
    [
      "        Synthetic Active Assets Account",
      CONSOLIDATED_ACCOUNT_ONE,
      "        Account Synthetic Household",
    ].join("\n"),
  );
  const parsed = parseStatementLines(text, kind);
  const [scope] = parsed.holdings.balanceScopes;
  assert.deepEqual(
    {
      accountExternalKey: scope.accountExternalKey,
      asOf: scope.asOf,
      status: scope.status,
      emittedBalanceCount: scope.emittedBalanceCount,
      gapCodes: scope.gapCodes,
      zeroBasis: scope.zeroBasis,
    },
    {
      accountExternalKey: CONSOLIDATED_ACCOUNT_ONE,
      asOf: "2026-03-31",
      status: "complete",
      emittedBalanceCount: 1,
      gapCodes: [],
      zeroBasis: undefined,
    },
  );
  assert.equal(scope.evidence.account.binding.quote, CONSOLIDATED_ACCOUNT_ONE);
  assert.equal(scope.evidence.totalValue.binding.quote, "$74,310.25");
  assert.equal(scope.evidence.scopeEnd.binding.quote, "Account Summary");
});

test("an explicitly account-bound source statement of none proves a zero balance", () => {
  const text = EMPTY_ACCOUNT_LAYOUT_TEXT.replace(
    "        Synthetic Active Assets Account    123-456789-012",
    [
      "        Synthetic Active Assets Account",
      CONSOLIDATED_ACCOUNT_ONE,
      "        Account Synthetic Household",
    ].join("\n"),
  );
  const parsed = parseStatementLines(text, kind);
  assert.deepEqual(parsed.holdings.balances, []);
  const [scope] = parsed.holdings.balanceScopes;
  assert.deepEqual(
    {
      accountExternalKey: scope.accountExternalKey,
      status: scope.status,
      emittedBalanceCount: scope.emittedBalanceCount,
      gapCodes: scope.gapCodes,
      zeroBasis: scope.zeroBasis,
    },
    {
      accountExternalKey: CONSOLIDATED_ACCOUNT_ONE,
      status: "complete",
      emittedBalanceCount: 0,
      gapCodes: [],
      zeroBasis: "source_stated_none",
    },
  );
  assert.equal(scope.evidence.explicitNone.binding.quote, "—");
  assert.equal(scope.evidence.scopeEnd.binding.quote, "Account Summary");
});

test("a cover banner cannot borrow an amount from the next account or page", () => {
  const text = [
    [
      "        Page 1 of 2",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      CONSOLIDATED_ACCOUNT_ONE,
      "        Account Synthetic Household",
      "        TOTAL VALUE OF YOUR ACCOUNT",
    ].join("\n"),
    [
      "        Page 2 of 2",
      CONSOLIDATED_ACCOUNT_TWO,
      "        $74,310.25",
      "        Account Summary",
    ].join("\n"),
  ].join(`\n${PAGE_SEPARATOR}\n`);
  const parsed = parseStatementLines(text, kind);
  assert.deepEqual(parsed.holdings.balances, []);
  assert.equal(parsed.holdings.balanceScopes, undefined);
});

test("a second account banner prevents the first explicit none from becoming a unique proof", () => {
  const text = EMPTY_ACCOUNT_LAYOUT_TEXT.replace(
    "        Synthetic Active Assets Account    123-456789-012",
    [
      "        Synthetic Active Assets Account",
      CONSOLIDATED_ACCOUNT_ONE,
      "        Account Synthetic Household",
    ].join("\n"),
  ).concat("\n        TOTAL VALUE OF YOUR ACCOUNT", "\n        $74,310.25");
  const parsed = parseStatementLines(text, kind);
  assert.deepEqual(parsed.holdings.balances, []);
  assert.equal(parsed.holdings.balanceScopes, undefined);
});

test("an account holding nothing says so, and is not a statement left unparsed", () => {
  const parsed = parseStatementLines(EMPTY_ACCOUNT_LAYOUT_TEXT, kind);
  assert.equal(
    parsed.parseNote,
    undefined,
    "the statement states its total: none",
  );
  // "none" is not zero and is never recorded as one.
  assert.deepEqual(parsed.holdings.positions, []);
  assert.deepEqual(parsed.holdings.balances, []);
  assert.deepEqual(parsed.holdings.liabilities, []);
  assert.equal(parsed.holdings.positionScopes.length, 1);
  const [scope] = parsed.holdings.positionScopes;
  assert.deepEqual(
    {
      accountExternalKey: scope.accountExternalKey,
      asOf: scope.asOf,
      status: scope.status,
      emittedPositionCount: scope.emittedPositionCount,
      gapCodes: scope.gapCodes,
      zeroBasis: scope.zeroBasis,
    },
    {
      accountExternalKey: undefined,
      asOf: "2026-03-31",
      status: "complete",
      emittedPositionCount: 0,
      gapCodes: [],
      zeroBasis: "source_stated_none",
    },
  );
  assert.equal(scope.evidence.tables.length, 0);
  assert.equal(scope.evidence.explicitNone.binding.quote, "—");
  assert.equal(scope.evidence.scopeEnd.binding.quote, "Account Summary");
});

test("a statement with no positions does not prove zero without an explicit source statement", () => {
  const parsed = parseStatementLines(COVER_TOTAL_LAYOUT_TEXT, kind);
  assert.equal(parsed.holdings.positions.length, 0);
  assert.equal(parsed.holdings.positionScopes, undefined);
});

test("a cover page stating none, over holdings, still reports the missing balance sheet", () => {
  const text = [
    EMPTY_ACCOUNT_LAYOUT_TEXT,
    "        HOLDINGS",
    ...equityBlockLines(),
  ].join("\n");
  const parsed = parseStatementLines(text, kind);
  assert.equal(parsed.holdings.positions.length, 1);
  assert.match(parsed.parseNote, /no readable BALANCE SHEET block/);
});

test("the cash activity summary is named for what it is, not blamed on the period line", () => {
  const parsed = parseStatementLines(ACTIVITY_SUMMARY_TEXT, kind);
  assert.deepEqual(parsed.holdings, {
    positions: [],
    balances: [],
    liabilities: [],
  });
  assert.match(
    parsed.parseNote,
    /cash activity summary, not a holdings statement/,
  );
  assert.doesNotMatch(parsed.parseNote, /period is unknown/);
});

test("text in neither grammar routes to review instead of reaching a parser blind", () => {
  const parsed = parseStatementLines(
    "TRADE CONFIRMATION\nsomething this adapter has never been shown",
    "trade_confirmation",
  );
  assert.deepEqual(parsed.holdings, {
    positions: [],
    balances: [],
    liabilities: [],
  });
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
  const pdf = buildMinimalPdf([["TRADE CONFIRMATION", "an unstudied layout"]], {
    compress: true,
  });
  const parsed = await adapter.parse({
    kind: "trade_confirmation",
    bytes: pdf,
  });
  assert.match(parsed.extractedText, /TRADE CONFIRMATION/);
  assert.match(parsed.parseNote, /matches neither/);
});

test("the synthetic fixture grammar still parses through its own function", () => {
  const parsed = parseSyntheticStatementLines(STATEMENT_LINES, kind);
  assert.equal(parsed.activity.length, 5);
  assert.equal(parsed.holdings.positions.length, 2);
  assert.equal(parsed.holdings.balances.length, 1);
});
