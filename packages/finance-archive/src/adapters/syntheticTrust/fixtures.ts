// Generated fixture data for the synthetic reference adapter. Nothing here is
// hand-written per row: everything is derived from a handful of constants by
// generateActivityRows below, per the F1-2 instruction to generate fixtures
// rather than hand-write thousands of lines.
//
// "Thistlebrook Trust" is an invented institution. "FKE" and "SGH" are
// invented tickers. Every date, amount and identifier here is synthetic and
// could not be anyone's real data.

import {
  canonicalizeDecimal,
  multiplyDecimal,
  negateDecimal,
  subtractDecimal,
} from "../../decimal.js";
import { fromMinorUnits } from "../../money.js";
import type { ParsedInstrument } from "../../adapter.js";

export const INSTITUTION_SLUG = "thistlebrook-trust";
export const INSTITUTION_NAME = "Thistlebrook Trust";

export const INSTRUMENTS: readonly ParsedInstrument[] = [
  { symbol: "FKE", name: "Fictional Kelp ETF", cusip: "000000FK1", isin: null },
  { symbol: "SGH", name: "Synthetic Glacier Holdings", cusip: "000000SG2", isin: null },
];

/** No symbol or cusip: an illiquid, privately held fund unit, carried at cost. */
export const PRIVATE_FUND_INSTRUMENT: ParsedInstrument = {
  symbol: null,
  cusip: null,
  isin: null,
  name: "Synthetic Cairn Private Fund, LP",
};

/** A EUR-listed share class of the same fictional ETF, for the multi-currency holdings fixture. */
export const EUR_INSTRUMENT: ParsedInstrument = {
  symbol: "FKE-EUR",
  cusip: null,
  isin: "SY0000000FK1",
  name: "Fictional Kelp ETF (EUR share class)",
};

/**
 * Every instrument a holdings fixture can reference, including the two that
 * never appear in `INSTRUMENTS` (activity-only): the symbol-less private
 * fund and the EUR share class. `parseStatementText`'s holdings branch looks
 * an instrument up here by symbol, falling back to name, since the private
 * fund has no symbol at all for `instrumentBySymbol`'s lookup to find.
 */
export const HOLDINGS_INSTRUMENTS: readonly ParsedInstrument[] = [
  ...INSTRUMENTS,
  PRIVATE_FUND_INSTRUMENT,
  EUR_INSTRUMENT,
];

const ACTIVITY_TYPES = ["buy", "sell", "dividend", "fee", "interest"] as const;

/** `ACTIVITY_TYPES[i % ACTIVITY_TYPES.length]` is always in range; this just says so to the type checker. */
function activityTypeAt(index: number): (typeof ACTIVITY_TYPES)[number] {
  const type = ACTIVITY_TYPES[index % ACTIVITY_TYPES.length];
  if (type === undefined) throw new Error("ACTIVITY_TYPES is empty");
  return type;
}

/** Same shape of guarantee for the fixed, non-empty INSTRUMENTS table. */
function instrumentAt(index: number): ParsedInstrument {
  const instrument = INSTRUMENTS[index % INSTRUMENTS.length];
  if (instrument === undefined) throw new Error("INSTRUMENTS is empty");
  return instrument;
}

export type ActivityRow = {
  readonly externalId: string;
  readonly date: string;
  readonly activityType: string;
  readonly description: string;
  readonly instrument: ParsedInstrument | null;
  readonly quantity: string | null;
  readonly price: string | null;
  readonly amount: string;
  readonly currency: string;
};

/** Pure calendar math, no money involved. */
function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * `count` deterministic, synthetic activity rows starting at `startDate`.
 * Amounts and prices are built through fromMinorUnits/multiplyDecimal/
 * negateDecimal (the F1-1 decimal and money helpers) so nothing here
 * reimplements decimal formatting or touches a float.
 */
export function generateActivityRows(
  count: number,
  startDate = "2025-01-06",
): readonly ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const type = activityTypeAt(i);
    const date = addDaysIso(startDate, i * 3);
    const externalId = `tx-${String(i + 1).padStart(4, "0")}`;
    if (type === "buy" || type === "sell") {
      const instrument = instrumentAt(i);
      const units = canonicalizeDecimal(String(5 + (i % 6) * 3));
      const price = fromMinorUnits(BigInt(5000 + ((i * 211) % 8000)), "USD");
      const gross = multiplyDecimal(units, price);
      rows.push({
        externalId,
        date,
        activityType: type,
        description: `${type === "buy" ? "Buy" : "Sell"} ${instrument.symbol}`,
        instrument,
        // Signed: a disposal is negative (ParsedRow.quantity). Cash and
        // quantity carry opposite signs on a trade, which is why a sale is
        // a positive amount and a negative quantity.
        quantity: type === "buy" ? units : negateDecimal(units),
        price,
        amount: type === "buy" ? negateDecimal(gross) : gross,
        currency: "USD",
      });
      continue;
    }
    const cents = BigInt(500 + ((i * 137) % 4000));
    const amount = fromMinorUnits(type === "fee" ? -cents : cents, "USD");
    rows.push({
      externalId,
      date,
      activityType: type,
      description:
        type === "dividend"
          ? `Dividend ${instrumentAt(i).symbol}`
          : type === "fee"
            ? "Account fee"
            : "Interest credit",
      instrument: type === "dividend" ? instrumentAt(i) : null,
      quantity: null,
      price: null,
      amount,
      currency: "USD",
    });
  }
  return rows;
}

export type ActivityPage = {
  readonly page: number;
  /** The provider's own count of unique rows across the whole range. */
  readonly totalCount: number;
  readonly hasMore: boolean;
  readonly items: readonly ActivityRow[];
};

/**
 * Splits `rows` into pages of `pageSize`, overlapping each page boundary by
 * one row, which is how the real activity APIs this models actually behave.
 * The overlap is the case F1-3's dedupe has to survive: parsing these pages
 * as-is yields two rows with identical content, and only row_hash collapses
 * them, not this function.
 */
export function paginateWithOverlap(
  rows: readonly ActivityRow[],
  pageSize: number,
): readonly ActivityPage[] {
  const pages: ActivityPage[] = [];
  let start = 0;
  let page = 1;
  while (start < rows.length) {
    const end = Math.min(start + pageSize, rows.length);
    const items = rows.slice(start, end);
    const hasMore = end < rows.length;
    pages.push({ page, totalCount: rows.length, hasMore, items });
    if (!hasMore) break;
    // Next page starts one row back, reproducing the boundary overlap.
    start = end - 1;
    page += 1;
  }
  return pages;
}

// ponytail: unquoted comma-joined fields, fine only because this fixture's
// own descriptions never contain a comma (generateActivityRows keeps them
// that way). A real institution's CSV export needs a proper CSV reader, not
// this joiner; that reader belongs to a real adapter's own directory.
export function buildTabularExportCsv(rows: readonly ActivityRow[]): string {
  const header = "date,activity_type,description,symbol,quantity,price,amount,currency";
  const lines = rows.map((row) =>
    [
      row.date,
      row.activityType,
      row.description,
      row.instrument?.symbol ?? "-",
      row.quantity ?? "-",
      row.price ?? "-",
      row.amount,
      row.currency,
    ].join(","),
  );
  return [header, ...lines].join("\n");
}

/**
 * One line of the pipe-delimited text this fixture uses to stand in for a
 * PDF's extracted text (real PDF parsing is out of scope for F1-2, per the
 * task). `amountOverride` lets a caller substitute deliberately malformed
 * text for the ambiguous-row case.
 */
function statementLine(row: ActivityRow, amountOverride?: string): string {
  return [
    row.date,
    row.activityType,
    row.description,
    row.instrument?.symbol ?? "-",
    row.quantity ?? "-",
    row.price ?? "-",
    amountOverride ?? row.amount,
    row.currency,
  ].join("|");
}

/**
 * A transaction whose statement text is deliberately garbled: a comma and a
 * letter "O" in place of a zero, exactly the kind of OCR/extraction damage
 * ground rule 5 exists for. `1,2O3.45` fails decimal parsing outright, so
 * parse() must record it as null with a note rather than guess at a value.
 */
export const AMBIGUOUS_ROW: ActivityRow = {
  externalId: "tx-stmt-ambiguous-1",
  date: "2025-02-18",
  activityType: "fee",
  description: "Statement fee, smudged ledger copy",
  instrument: null,
  quantity: null,
  price: null,
  amount: "1,2O3.45",
  currency: "USD",
};

// --- holdings fixtures ---------------------------------------------------
//
// F1-16: the February statement's positions table, small enough to be
// hand-fixed (unlike the hundreds-of-rows activity feed) but still exact
// arithmetic through the F1-1 decimal/money helpers, never a hardcoded
// product. One marked position, one carried-at-cost position (proving a
// total-assets query can separate the two, acceptance criterion 3), one
// ambiguous market value (criterion 5), and one EUR position alongside the
// USD ones (criterion 6, multi-currency round trip).

export const HOLDINGS_AS_OF = "2025-02-28";

const MARKET_QUANTITY = "40";
const MARKET_PRICE = fromMinorUnits(10530n, "USD"); // 105.30
const MARKET_VALUE = multiplyDecimal(MARKET_QUANTITY, MARKET_PRICE);
const MARKET_COST_BASIS = fromMinorUnits(390000n, "USD"); // 3900.00
const MARKET_UNREALIZED = subtractDecimal(MARKET_VALUE, MARKET_COST_BASIS);

const COST_QUANTITY = "100";
const COST_MARKET_VALUE = fromMinorUnits(500000n, "USD"); // 5000.00, no independent mark

const EUR_QUANTITY = "12";
const EUR_PRICE = fromMinorUnits(8850n, "EUR"); // 88.50
const EUR_MARKET_VALUE = multiplyDecimal(EUR_QUANTITY, EUR_PRICE);
const EUR_COST_BASIS = fromMinorUnits(90000n, "EUR"); // 900.00
const EUR_UNREALIZED = subtractDecimal(EUR_MARKET_VALUE, EUR_COST_BASIS);

export type PositionFixture = {
  readonly asOf: string;
  readonly instrument: ParsedInstrument | null;
  readonly quantity: string | null;
  readonly price: string | null;
  /** `1,2O3.45`-style garbled text stands in for a market value parse() cannot read. */
  readonly marketValue: string;
  readonly costBasis: string | null;
  readonly unrealized: string | null;
  readonly currency: string;
  readonly valuationBasis: "market_price" | "last_round" | "cost" | "reported_nav";
  readonly valuationNote: string;
};

export const POSITIONS: readonly PositionFixture[] = [
  {
    asOf: HOLDINGS_AS_OF,
    instrument: instrumentAt(0), // FKE
    quantity: MARKET_QUANTITY,
    price: MARKET_PRICE,
    marketValue: MARKET_VALUE,
    costBasis: MARKET_COST_BASIS,
    unrealized: MARKET_UNREALIZED,
    currency: "USD",
    valuationBasis: "market_price",
    valuationNote: "Priced from delayed market feed, end of day 2025-02-28.",
  },
  {
    asOf: HOLDINGS_AS_OF,
    instrument: PRIVATE_FUND_INSTRUMENT,
    quantity: COST_QUANTITY,
    price: null,
    marketValue: COST_MARKET_VALUE,
    costBasis: COST_MARKET_VALUE,
    unrealized: null,
    currency: "USD",
    valuationBasis: "cost",
    valuationNote: "No independent market or administrator NAV; carried at cost.",
  },
  {
    asOf: HOLDINGS_AS_OF,
    instrument: instrumentAt(1), // SGH
    quantity: "25",
    price: null,
    // Deliberately garbled, same damage as AMBIGUOUS_ROW: parse() must
    // record this as null with a note rather than guess (ground rule 5).
    marketValue: "1,2O3.45",
    costBasis: fromMinorUnits(120000n, "USD"),
    unrealized: null,
    currency: "USD",
    valuationBasis: "market_price",
    valuationNote: "Priced from delayed market feed, end of day 2025-02-28.",
  },
  {
    asOf: HOLDINGS_AS_OF,
    instrument: EUR_INSTRUMENT,
    quantity: EUR_QUANTITY,
    price: EUR_PRICE,
    marketValue: EUR_MARKET_VALUE,
    costBasis: EUR_COST_BASIS,
    unrealized: EUR_UNREALIZED,
    currency: "EUR",
    valuationBasis: "market_price",
    valuationNote: "Priced from the instrument's home-exchange feed, in EUR, not converted.",
  },
];

export type BalanceFixture = {
  readonly asOf: string;
  readonly totalValue: string;
  readonly cash: string;
  readonly currency: string;
  readonly periodStartValue: string;
  readonly periodEndValue: string;
};

export const BALANCE: BalanceFixture = {
  asOf: HOLDINGS_AS_OF,
  totalValue: fromMinorUnits(1815045n, "USD"), // 18150.45
  cash: fromMinorUnits(42010n, "USD"), // 420.10
  currency: "USD",
  periodStartValue: fromMinorUnits(1760000n, "USD"), // 17600.00
  periodEndValue: fromMinorUnits(1815045n, "USD"),
};

export type LiabilityFixture = {
  readonly kind: string;
  readonly displayName: string;
  readonly balance: string;
  readonly currency: string;
  readonly rate: string;
  readonly asOf: string;
  readonly collateralNote: string;
};

export const LIABILITY: LiabilityFixture = {
  kind: "margin_loan",
  displayName: "Margin balance",
  balance: fromMinorUnits(500000n, "USD"), // 5000.00
  currency: "USD",
  rate: "4.25",
  asOf: HOLDINGS_AS_OF,
  collateralNote: "Collateralized by securities held in this account.",
};

export type DocumentFixture = {
  readonly externalId: string;
  readonly kind: "pdf_statement" | "trade_confirmation";
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly label: string;
  readonly text: () => string;
};

const STATEMENT_ROWS = generateActivityRows(5, "2025-02-01");

/**
 * A statement's positions-table line. Unlike `statementLine`, the instrument
 * is spelled out as both symbol and name (not just a symbol): the private
 * fund fixture has no symbol at all, and a lookup by symbol alone -- as
 * `instrumentBySymbol` does for activity rows -- would not find it.
 */
function positionLine(position: PositionFixture): string {
  return [
    "POSITION",
    position.asOf,
    position.instrument?.symbol ?? "-",
    position.instrument?.name ?? "-",
    position.quantity ?? "-",
    position.price ?? "-",
    position.marketValue,
    position.costBasis ?? "-",
    position.unrealized ?? "-",
    position.currency,
    position.valuationBasis,
    position.valuationNote,
  ].join("|");
}

function balanceLine(balance: BalanceFixture): string {
  return [
    "BALANCE",
    balance.asOf,
    balance.totalValue,
    balance.cash,
    balance.currency,
    balance.periodStartValue,
    balance.periodEndValue,
  ].join("|");
}

function liabilityLine(liability: LiabilityFixture): string {
  return [
    "LIABILITY",
    liability.kind,
    liability.displayName,
    liability.balance,
    liability.currency,
    liability.rate,
    liability.asOf,
    liability.collateralNote,
  ].join("|");
}

function buildStatementText(): string {
  const page1 = STATEMENT_ROWS.slice(0, 3);
  const page2 = STATEMENT_ROWS.slice(3);
  return [
    "# Thistlebrook Trust statement (synthetic fixture) 2025-02-01..2025-02-28",
    "PAGE 1",
    ...page1.map((row) => statementLine(row)),
    "PAGE 2",
    ...page2.map((row) => statementLine(row)),
    statementLine(AMBIGUOUS_ROW, AMBIGUOUS_ROW.amount),
    "HOLDINGS",
    ...POSITIONS.map((position) => positionLine(position)),
    balanceLine(BALANCE),
    liabilityLine(LIABILITY),
  ].join("\n");
}

const CONFIRMATION_ROW: ActivityRow = {
  externalId: "tx-conf-0001",
  date: "2025-02-10",
  activityType: "buy",
  description: "Trade confirmation, FKE",
  instrument: instrumentAt(0),
  quantity: "15",
  price: "101.20",
  amount: "-1518.00",
  currency: "EUR",
};

function buildConfirmationText(): string {
  return [
    "# Thistlebrook Trust trade confirmation (synthetic fixture)",
    "PAGE 1",
    statementLine(CONFIRMATION_ROW),
  ].join("\n");
}

export const DOCUMENTS: readonly DocumentFixture[] = [
  {
    externalId: "doc-stmt-2025-q1",
    kind: "pdf_statement",
    periodStart: "2025-02-01",
    periodEnd: "2025-02-28",
    label: "February 2025 statement",
    text: buildStatementText,
  },
  {
    externalId: "doc-stmt-2025-q2",
    kind: "pdf_statement",
    periodStart: "2025-03-01",
    periodEnd: "2025-03-31",
    label: "March 2025 statement",
    text: () =>
      [
        "# Thistlebrook Trust statement (synthetic fixture) 2025-03-01..2025-03-31",
        "PAGE 1",
        ...generateActivityRows(2, "2025-03-04").map((row) => statementLine(row)),
      ].join("\n"),
  },
  {
    externalId: "doc-conf-2025-02-10",
    kind: "trade_confirmation",
    periodStart: "2025-02-10",
    periodEnd: "2025-02-10",
    label: "Trade confirmation, 2025-02-10",
    text: buildConfirmationText,
  },
];

// --- F1-23 leak fixture ------------------------------------------------------
//
// Credential-shaped material for the negative tests. It is deliberately not
// in any real token format: every value is the same obviously-fake canary
// string with a prefix naming the shape it stands for, so the tests can
// assert one substring is absent from the bytes on disk and no reader could
// mistake any of it for a live secret. Nothing here is ever printed.

/** The one substring every piece of the fixture below contains. A negative
 * test asserts this cannot be found anywhere in the raw tree. */
export const LEAK_CANARY = "SYNTHETIC-LEAK-CANARY-DO-NOT-RETAIN";

/**
 * The shapes a provider actually echoes back alongside a business payload: a
 * bearer token, a `Set-Cookie` value, an `Authorization` header echo, a
 * refresh token, a long opaque session id, a device identifier, and a
 * signed-in user profile. None of them is named by any adapter's retention
 * declaration, which is the entire point: the allowlist never had to know
 * these key names to keep them out.
 */
export const CREDENTIAL_SHAPED_ECHO: Readonly<Record<string, unknown>> = {
  sessionToken: `session-token-${LEAK_CANARY}`,
  authorization: `Bearer ${LEAK_CANARY}`,
  setCookie: `synthetic_session=${LEAK_CANARY}; Path=/; HttpOnly`,
  refreshToken: `refresh-token-${LEAK_CANARY}`,
  deviceId: `device-${LEAK_CANARY}`,
  opaqueSessionId: `${LEAK_CANARY}-000000000000000000000000000000000000`,
  userProfile: {
    displayName: `Synthetic Placeholder ${LEAK_CANARY}`,
    email: `nobody-${LEAK_CANARY}@example.invalid`,
  },
};

/** The same material nested one level deeper, on an individual activity row,
 * so the tests prove the projection drops undeclared keys inside a declared
 * array element and not only at the top of a response. */
export const CREDENTIAL_SHAPED_ROW_ECHO: Readonly<Record<string, unknown>> = {
  rowSessionToken: `row-session-token-${LEAK_CANARY}`,
  rowAuthorization: `Bearer ${LEAK_CANARY}`,
};
