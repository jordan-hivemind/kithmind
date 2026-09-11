// A synthetic CLIENT STATEMENT in the real layout.
//
// Every label here -- section titles, column headers, row labels -- is the
// institution's own vocabulary, recorded in README, "Statement layout". Every
// *value* is invented: the account number, the securities, the amounts and
// the dates are made up for this test and match nothing real. No byte of a
// real document is reproduced here or anywhere else in this repository.
//
// Lines are laid out as the extractor lays them out: fixed pitch, each datum
// at the character column it occupies, right-aligned numbers under
// right-aligned headers. `place` builds them from the column definitions so
// the header and its rows cannot drift apart.

/** Builds one fixed-pitch line. A cell is right-aligned at `end` unless it
 * states `start`, in which case it is left-aligned there. */
export function place(cells) {
  let line = "";
  for (const cell of cells) {
    const start = cell.start ?? cell.end - cell.text.length;
    line = line.padEnd(start, " ") + cell.text;
  }
  return line;
}

// --- balance sheet ----------------------------------------------------------

const LABEL = 8;
const LAST_PERIOD = 58;
const THIS_PERIOD = 78;
const FLOW_LABEL = 92;
const FLOW_PERIOD = 138;
const FLOW_YEAR = 158;

/** BALANCE SHEET on the left, the unrelated CASH FLOW table on the right, on
 * the same visual lines -- the shape that makes column position load-bearing. */
export function balanceSheetLines({
  totalValueLast = "$1,250,400.00",
  totalValueThis = "$1,302,775.50",
  cashThis = "$42,118.25",
  liabilityThis = "—",
} = {}) {
  return [
    place([
      { text: "BALANCE SHEET  (^ Includes accrued interest)", start: LABEL },
      { text: "CASH FLOW", start: FLOW_LABEL },
    ]),
    place([
      { text: "Last Period", end: LAST_PERIOD },
      { text: "This Period", end: THIS_PERIOD },
      { text: "This Period", end: FLOW_PERIOD },
      { text: "This Year", end: FLOW_YEAR },
    ]),
    place([
      { text: "(as of 02/28/26)", end: LAST_PERIOD },
      { text: "(as of 03/31/26)", end: THIS_PERIOD },
      { text: "(3/1/26-3/31/26)", end: FLOW_PERIOD },
      { text: "(1/1/26-3/31/26)", end: FLOW_YEAR },
    ]),
    place([
      { text: "Cash, BDP, MMFs", start: LABEL },
      { text: "$39,004.10", end: LAST_PERIOD },
      { text: cashThis, end: THIS_PERIOD },
      { text: "OPENING CASH, BDP, MMFs", start: FLOW_LABEL },
      { text: "$39,004.10", end: FLOW_PERIOD },
      { text: "$28,650.00", end: FLOW_YEAR },
    ]),
    place([
      { text: "Stocks", start: LABEL },
      { text: "1,211,395.90", end: LAST_PERIOD },
      { text: "1,260,657.25", end: THIS_PERIOD },
      { text: "Purchases", start: FLOW_LABEL },
      { text: "(12,000.00)", end: FLOW_PERIOD },
      { text: "(48,500.00)", end: FLOW_YEAR },
    ]),
    place([
      { text: "Total Assets", start: LABEL },
      { text: "$1,250,400.00", end: LAST_PERIOD },
      { text: "$1,302,775.50", end: THIS_PERIOD },
      { text: "Sales and Redemptions", start: FLOW_LABEL },
      { text: "9,314.15", end: FLOW_PERIOD },
      { text: "31,880.00", end: FLOW_YEAR },
    ]),
    place([
      { text: "Total Liabilities   (outstanding balance)", start: LABEL },
      { text: "—", end: LAST_PERIOD },
      { text: liabilityThis, end: THIS_PERIOD },
      { text: "Income and Distributions", start: FLOW_LABEL },
      { text: "5,460.00", end: FLOW_PERIOD },
      { text: "16,380.00", end: FLOW_YEAR },
    ]),
    place([
      { text: "TOTAL VALUE", start: LABEL },
      { text: totalValueLast, end: LAST_PERIOD },
      { text: totalValueThis, end: THIS_PERIOD },
      { text: "CLOSING CASH, BDP, MMFs", start: FLOW_LABEL },
      { text: "$42,118.25", end: FLOW_PERIOD },
      { text: "$42,118.25", end: FLOW_YEAR },
    ]),
  ];
}

// --- holdings ---------------------------------------------------------------

const EQUITY_COLUMNS = {
  description: { start: LABEL },
  tradeDate: { end: 62 },
  quantity: { end: 92 },
  unitCost: { end: 104 },
  sharePrice: { end: 120 },
  totalCost: { end: 134 },
  marketValue: { end: 150 },
  gainLoss: { end: 164 },
  income: { end: 180 },
  yield: { end: 188 },
};

export const EQUITY_HEADER = place([
  { text: "Security Description", ...EQUITY_COLUMNS.description },
  { text: "Trade Date", ...EQUITY_COLUMNS.tradeDate },
  { text: "Quantity", ...EQUITY_COLUMNS.quantity },
  { text: "Unit Cost", ...EQUITY_COLUMNS.unitCost },
  { text: "Share Price", ...EQUITY_COLUMNS.sharePrice },
  { text: "Total Cost", ...EQUITY_COLUMNS.totalCost },
  { text: "Market Value", ...EQUITY_COLUMNS.marketValue },
  { text: "Gain/(Loss)", ...EQUITY_COLUMNS.gainLoss },
  { text: "Est Ann Income", ...EQUITY_COLUMNS.income },
  { text: "Yield %", ...EQUITY_COLUMNS.yield },
]);

function equityRow({ description, tradeDate, quantity, unitCost, sharePrice, totalCost, marketValue, gainLoss, income, yieldPct }) {
  const cells = [];
  if (description) cells.push({ text: description, ...EQUITY_COLUMNS.description });
  if (tradeDate) cells.push({ text: tradeDate, ...EQUITY_COLUMNS.tradeDate });
  if (quantity) cells.push({ text: quantity, ...EQUITY_COLUMNS.quantity });
  if (unitCost) cells.push({ text: unitCost, ...EQUITY_COLUMNS.unitCost });
  if (sharePrice) cells.push({ text: sharePrice, ...EQUITY_COLUMNS.sharePrice });
  if (totalCost) cells.push({ text: totalCost, ...EQUITY_COLUMNS.totalCost });
  if (marketValue) cells.push({ text: marketValue, ...EQUITY_COLUMNS.marketValue });
  if (gainLoss) cells.push({ text: gainLoss, ...EQUITY_COLUMNS.gainLoss });
  if (income) cells.push({ text: income, ...EQUITY_COLUMNS.income });
  if (yieldPct) cells.push({ text: yieldPct, ...EQUITY_COLUMNS.yield });
  return place(cells);
}

/** Two tax lots and the Total row that states the position, exactly as an
 * equity block is printed. */
export function equityBlockLines({ marketValue = "3,184.00" } = {}) {
  return [
    "        COMMON STOCKS",
    EQUITY_HEADER,
    equityRow({
      description: "WIDGET NEUTRAL FUND (WNDF)",
      tradeDate: "01/12/26",
      quantity: "6.000",
      unitCost: "$300.000",
      sharePrice: "$318.400",
      totalCost: "$1,800.00",
      marketValue: "$1,910.40",
      gainLoss: "$110.40 NA",
    }),
    equityRow({
      tradeDate: "02/03/26",
      quantity: "4.000",
      unitCost: "300.000",
      sharePrice: "318.400",
      totalCost: "1,200.00",
      marketValue: "1,273.60",
      gainLoss: "73.60 NA",
    }),
    equityRow({
      tradeDate: "Total",
      quantity: "10.000",
      totalCost: "3,000.00",
      marketValue,
      gainLoss: "184.00 NA",
      income: "40.00",
      yieldPct: "1.26",
    }),
    "        Next Dividend Payable 04/2026; Asset Class: Equities",
  ];
}

/**
 * Two valued lots under one security and no Total row: no single row states
 * the position and no column can be filled from rows that disagree, so this
 * block is refused rather than guessed at.
 */
export function ambiguousBlockLines() {
  return [
    "        COMMON STOCKS",
    EQUITY_HEADER,
    equityRow({
      description: "CAIRN SYNTHETIC HOLDINGS (CSHZ)",
      tradeDate: "01/05/26",
      quantity: "5.000",
      sharePrice: "$20.000",
      totalCost: "$100.00",
      marketValue: "$100.00",
    }),
    equityRow({
      tradeDate: "01/06/26",
      quantity: "7.000",
      sharePrice: "20.000",
      totalCost: "140.00",
      marketValue: "140.00",
    }),
  ];
}

const BOND_COLUMNS = {
  description: { start: LABEL },
  tradeDate: { end: 62 },
  faceValue: { end: 92 },
  adjUnitCost: { end: 106 },
  unitPrice: { end: 120 },
  adjTotalCost: { end: 136 },
  marketValue: { end: 152 },
  gainLoss: { end: 166 },
  accrued: { end: 184 },
  yield: { end: 192 },
};

export const BOND_HEADER = place([
  { text: "Security Description", ...BOND_COLUMNS.description },
  { text: "Trade Date", ...BOND_COLUMNS.tradeDate },
  { text: "Face Value", ...BOND_COLUMNS.faceValue },
  { text: "Adj Unit Cost", ...BOND_COLUMNS.adjUnitCost },
  { text: "Unit Price", ...BOND_COLUMNS.unitPrice },
  { text: "Adj Total Cost", ...BOND_COLUMNS.adjTotalCost },
  { text: "Market Value", ...BOND_COLUMNS.marketValue },
  { text: "Gain/(Loss)", ...BOND_COLUMNS.gainLoss },
  { text: "Accrued Interest", ...BOND_COLUMNS.accrued },
  { text: "Yield %", ...BOND_COLUMNS.yield },
]);

/** A bond: the security on one row, its market value on the detail row
 * beneath it, and no Total row anywhere. */
export function bondBlockLines() {
  return [
    "        CORPORATE FIXED INCOME",
    BOND_HEADER,
    place([
      { text: "SYNTHETIC CAIRN MUNICIPAL SERIES A", ...BOND_COLUMNS.description },
      { text: "05/18/25", ...BOND_COLUMNS.tradeDate },
      { text: "25,000.000", ...BOND_COLUMNS.faceValue },
      { text: "$98.250", ...BOND_COLUMNS.adjUnitCost },
      { text: "$99.500", ...BOND_COLUMNS.unitPrice },
      { text: "$24,562.50", ...BOND_COLUMNS.adjTotalCost },
    ]),
    place([
      { text: "Coupon Rate 4.250%; Matures 06/01/2031; CUSIP 00000WNF1", ...BOND_COLUMNS.description },
      { text: "$24,875.00", ...BOND_COLUMNS.marketValue },
      { text: "$312.50 NA", ...BOND_COLUMNS.gainLoss },
      { text: "$88.54", ...BOND_COLUMNS.accrued },
    ]),
    "        Interest Paid Semiannually; Federal Tax Exempt; Asset Class: Fixed Income & Preferreds",
  ];
}

// --- whole documents --------------------------------------------------------

const ACCOUNT_HEADER = [
  "        Page 1 of 2",
  "        CLIENT STATEMENT   For the Period March 1-31, 2026",
  "        Synthetic Active Assets Account    123-456789-012",
];

/** One single-account statement: header, balance sheet, holdings. */
export function statementPages(options = {}) {
  return [
    [...ACCOUNT_HEADER, ...balanceSheetLines(options)],
    [
      "        Page 2 of 2",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      "        HOLDINGS",
      ...equityBlockLines(options),
      ...bondBlockLines(),
    ],
  ];
}

export const STATEMENT_LAYOUT_TEXT = statementPages()
  .map((page) => page.join("\n"))
  .join("\n\f\n");

/** Two account numbers on one document: a consolidated statement. */
export const CONSOLIDATED_LAYOUT_TEXT = [
  ...ACCOUNT_HEADER,
  "        Synthetic Retirement Account    987-654321-098",
  ...balanceSheetLines(),
].join("\n");
