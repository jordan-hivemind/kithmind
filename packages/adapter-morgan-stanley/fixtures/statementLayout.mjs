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

/**
 * F1-61. The same equity security, printed across a page break: three lots at
 * the bottom of one page, the page footer, the next page's running header,
 * the identical table header reprinted, and then the rest of the lots and the
 * `Total` row that states the position. Returns the two pages' lines.
 */
export function pageSplitEquityPages() {
  return [
    [
      "        Page 1 of 2",
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      "        Synthetic Active Assets Account    123-456789-012",
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
      "        Page 1 of 2",
    ],
    [
      "        CLIENT STATEMENT   For the Period March 1-31, 2026",
      "        Synthetic Active Assets Account    123-456789-012",
      EQUITY_HEADER,
      equityRow({
        tradeDate: "02/20/26",
        quantity: "5.000",
        unitCost: "300.000",
        sharePrice: "318.400",
        totalCost: "1,500.00",
        marketValue: "1,592.00",
        gainLoss: "92.00 NA",
      }),
      equityRow({
        tradeDate: "Total",
        quantity: "15.000",
        totalCost: "4,500.00",
        marketValue: "4,776.00",
        gainLoss: "276.00 NA",
        income: "60.00",
        yieldPct: "1.26",
      }),
      "        Next Dividend Payable 04/2026; Asset Class: Equities",
    ],
  ];
}

/**
 * F1-61. The sub-header a table reprints above a section's own totals, and
 * the two totals-row spellings that follow it: a bare percentage row, and one
 * that repeats the section's name in the description column with its share of
 * holdings where a lot would print its trade date.
 */
export function sectionSummaryLines({ named = false } = {}) {
  return [
    place([
      { text: "Percentage", ...EQUITY_COLUMNS.tradeDate },
      { text: "Unrealized", ...EQUITY_COLUMNS.gainLoss },
    ]),
    place([
      { text: "of Holdings", ...EQUITY_COLUMNS.tradeDate },
      { text: "Total Cost", ...EQUITY_COLUMNS.totalCost },
      { text: "Market Value", ...EQUITY_COLUMNS.marketValue },
      { text: "Gain/(Loss)", ...EQUITY_COLUMNS.gainLoss },
    ]),
    place([
      ...(named ? [{ text: "ALTERNATIVE INVESTMENTS", ...EQUITY_COLUMNS.description }] : []),
      { text: "62.4%", ...EQUITY_COLUMNS.tradeDate },
      { text: "$3,000.00", ...EQUITY_COLUMNS.totalCost },
      { text: "$3,184.00", ...EQUITY_COLUMNS.marketValue },
      { text: "$184.00", ...EQUITY_COLUMNS.gainLoss },
    ]),
  ];
}

// --- NAV-priced funds and aggregate private holdings (F1-61) ----------------

const NAV_COLUMNS = {
  description: { start: LABEL },
  tradeDate: { end: 62 },
  quantity: { end: 92 },
  unitCost: { end: 106 },
  nav: { end: 120 },
  totalCost: { end: 136 },
  value: { end: 152 },
  gainLoss: { end: 166 },
  date: { end: 184 },
};

/**
 * The NAV-priced fund table: its value column is headed `Value`, not `Market
 * Value`, and the holding is priced at the reported NAV.
 */
export function navFundBlockLines() {
  return [
    "        ALTERNATIVE INVESTMENTS",
    place([
      { text: "Security Description", ...NAV_COLUMNS.description },
      { text: "Trade Date", ...NAV_COLUMNS.tradeDate },
      { text: "Quantity", ...NAV_COLUMNS.quantity },
      { text: "Unit Cost", ...NAV_COLUMNS.unitCost },
      { text: "NAV", ...NAV_COLUMNS.nav },
      { text: "Total Cost", ...NAV_COLUMNS.totalCost },
      { text: "Value", ...NAV_COLUMNS.value },
      { text: "Gain/(Loss)", ...NAV_COLUMNS.gainLoss },
      { text: "Date", ...NAV_COLUMNS.date },
    ]),
    place([
      { text: "SYNTHETIC PRIVATE GROWTH FUND II", ...NAV_COLUMNS.description },
      { text: "07/01/24", ...NAV_COLUMNS.tradeDate },
      { text: "250.000", ...NAV_COLUMNS.quantity },
      { text: "$100.000", ...NAV_COLUMNS.unitCost },
      { text: "$118.500", ...NAV_COLUMNS.nav },
      { text: "$25,000.00", ...NAV_COLUMNS.totalCost },
      { text: "$29,625.00", ...NAV_COLUMNS.value },
      { text: "$4,625.00", ...NAV_COLUMNS.gainLoss },
      { text: "12/31/25", ...NAV_COLUMNS.date },
    ]),
    "        Asset Class: Alternative Investments",
  ];
}

const PRIVATE_COLUMNS = {
  description: { start: LABEL },
  investment: { end: 92 },
  totalCost: { end: 120 },
  value: { end: 140 },
  distributions: { end: 160 },
  totalReturn: { end: 176 },
  date: { end: 192 },
};

/**
 * The aggregate private-holdings table. Its only value column is `Value +
 * Distributions` -- a value with distributions added into it, which is not
 * what the holding is worth -- so no market value is read from it.
 */
export function privateHoldingsBlockLines() {
  return [
    "        ALTERNATIVE INVESTMENTS",
    place([
      { text: "Security Description", ...PRIVATE_COLUMNS.description },
      { text: "Aggregate Investment", ...PRIVATE_COLUMNS.investment },
      { text: "Total Cost", ...PRIVATE_COLUMNS.totalCost },
      { text: "Value", ...PRIVATE_COLUMNS.value },
      { text: "+ Distributions", ...PRIVATE_COLUMNS.distributions },
      { text: "Total Return", ...PRIVATE_COLUMNS.totalReturn },
      { text: "Date", ...PRIVATE_COLUMNS.date },
    ]),
    place([
      { text: "SYNTHETIC CAIRN OPPORTUNITY PARTNERS", ...PRIVATE_COLUMNS.description },
      { text: "07/01/24", ...PRIVATE_COLUMNS.investment },
      { text: "$50,000.00", ...PRIVATE_COLUMNS.totalCost },
      { text: "$61,200.00", ...PRIVATE_COLUMNS.value },
      { text: "$4,000.00", ...PRIVATE_COLUMNS.distributions },
      { text: "30.4%", ...PRIVATE_COLUMNS.totalReturn },
      { text: "12/31/25", ...PRIVATE_COLUMNS.date },
    ]),
    "        Asset Class: Alternative Investments",
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

// --- other statement families (F1-61) ---------------------------------------
//
// Three shapes the corpus prints that the one-month period line and the
// BALANCE SHEET block alone do not cover. Every value below is invented.

/** A period that opens mid-month names its month twice. */
export const CROSS_MONTH_LAYOUT_TEXT = [
  "        Page 1 of 1",
  "        CLIENT STATEMENT   For the Period November 26-December 31, 2025",
  "        Synthetic Active Assets Account    123-456789-012",
  ...balanceSheetLines(),
].join("\n");

/** The same, running backwards over a year boundary: the year is stated once,
 * at the end, so the month it opened in belongs to no stated year. */
export const YEAR_ROLLOVER_LAYOUT_TEXT = [
  "        Page 1 of 1",
  "        CLIENT STATEMENT   For the Period December 26-January 5, 2026",
  "        Synthetic Active Assets Account    123-456789-012",
  ...balanceSheetLines(),
].join("\n");

const COVER_LABEL = 100;
const COVER_VALUE = 168;

/** The cover page's own account total: a banner with the amount alone on the
 * next line. `totalValue` defaults to the em dash this layout prints for an
 * account holding nothing. */
function coverPage(totalValue) {
  return [
    "        Page 1 of 1",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    "        Synthetic Active Assets Account    123-456789-012",
    place([
      { text: "STATEMENT FOR:", start: 8 },
      { text: "TOTAL VALUE OF YOUR ACCOUNT", start: COVER_LABEL },
    ]),
    place([{ text: totalValue, end: COVER_VALUE }]),
    place([{ text: "Includes Accrued Interest", end: COVER_VALUE }]),
    "        Account Summary",
  ];
}

/** A statement with no BALANCE SHEET block whose cover page states the
 * account total: the banner is the only account total the document carries. */
export const COVER_TOTAL_LAYOUT_TEXT = coverPage("$74,310.25").join("\n");

/** A statement for an account holding nothing: no BALANCE SHEET block, no
 * holdings table, and a cover page stating the total as "none". */
export const EMPTY_ACCOUNT_LAYOUT_TEXT = coverPage("—").join("\n");

/** The cash activity summary this institution prints alongside the
 * statements: an Activity Date table, and no period line, BALANCE SHEET or
 * holdings table anywhere in it. */
export const ACTIVITY_SUMMARY_TEXT = [
  "        Page 1 of 1",
  "        CLIENT STATEMENT",
  "        Synthetic Active Assets Account    123-456789-012",
  "        CASH MANAGEMENT ACTIVITY",
  place([
    { text: "Activity Date", start: 8 },
    { text: "Activity Type", start: 30 },
    { text: "Description", start: 60 },
    { text: "Amount", end: 168 },
  ]),
  place([
    { text: "03/04/26", start: 8 },
    { text: "Funds Transferred", start: 30 },
    { text: "SYNTHETIC TRANSFER", start: 60 },
    { text: "$1,250.00", end: 168 },
  ]),
].join("\n");

// --- consolidated (F1-46) ---------------------------------------------------
//
// About one real statement in five prints several accounts in one PDF
// (README, "Consolidated statements"). Each account's own pages repeat a
// running header before its BALANCE SHEET and holdings: a line carrying only
// that account's number, one line above a line reading "Account <name>". This
// is the shape the parser keys on (`BARE_ACCOUNT_LINE`,
// `accountKeysByLine`) to attribute each position, balance and liability to
// the account whose pages it was printed under. The account numbers and every
// other value below are invented.

export const CONSOLIDATED_ACCOUNT_ONE = "123-456789-012";
export const CONSOLIDATED_ACCOUNT_TWO = "987-654321-098";

/** The running per-account page header a consolidated statement repeats
 * before each account's own BALANCE SHEET and holdings tables. */
function consolidatedAccountHeader(accountNumber) {
  return [accountNumber, "        Account Synthetic Household"];
}

/** Two accounts, each with its own BALANCE SHEET and one holdings table, so a
 * position, a balance and a liability each land on the right account rather
 * than all three on whichever account the pull names. */
export const CONSOLIDATED_LAYOUT_TEXT = [
  [
    "        Page 1 of 2",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    "        Synthetic Active Assets Account",
    ...consolidatedAccountHeader(CONSOLIDATED_ACCOUNT_ONE),
    ...balanceSheetLines(),
    "        HOLDINGS",
    ...equityBlockLines(),
  ].join("\n"),
  [
    "        Page 2 of 2",
    "        CLIENT STATEMENT   For the Period March 1-31, 2026",
    "        Synthetic Retirement Assets Account",
    ...consolidatedAccountHeader(CONSOLIDATED_ACCOUNT_TWO),
    ...balanceSheetLines({
      totalValueLast: "$500,000.00",
      totalValueThis: "$512,340.00",
      cashThis: "$8,200.00",
      liabilityThis: "$1,500.00",
    }),
    "        HOLDINGS",
    ...bondBlockLines(),
  ].join("\n"),
].join("\n\f\n");
