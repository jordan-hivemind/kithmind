// Generated fixture data for the synthetic reference adapter. Nothing here is
// hand-written per row: everything is derived from a handful of constants by
// generateActivityRows below, per the F1-2 instruction to generate fixtures
// rather than hand-write thousands of lines.
//
// "Thistlebrook Trust" is an invented institution. "FKE" and "SGH" are
// invented tickers. Every date, amount and identifier here is synthetic and
// could not be anyone's real data.

import { canonicalizeDecimal, multiplyDecimal, negateDecimal } from "../../decimal.js";
import { fromMinorUnits } from "../../money.js";
import type { ParsedInstrument } from "../../adapter.js";

export const INSTITUTION_SLUG = "thistlebrook-trust";
export const INSTITUTION_NAME = "Thistlebrook Trust";

export const INSTRUMENTS: readonly ParsedInstrument[] = [
  { symbol: "FKE", name: "Fictional Kelp ETF", cusip: "000000FK1", isin: null },
  { symbol: "SGH", name: "Synthetic Glacier Holdings", cusip: "000000SG2", isin: null },
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
      const quantity = canonicalizeDecimal(String(5 + (i % 6) * 3));
      const price = fromMinorUnits(BigInt(5000 + ((i * 211) % 8000)), "USD");
      const gross = multiplyDecimal(quantity, price);
      rows.push({
        externalId,
        date,
        activityType: type,
        description: `${type === "buy" ? "Buy" : "Sell"} ${instrument.symbol}`,
        instrument,
        quantity,
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

export type DocumentFixture = {
  readonly externalId: string;
  readonly kind: "pdf_statement" | "trade_confirmation";
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly label: string;
  readonly text: () => string;
};

const STATEMENT_ROWS = generateActivityRows(5, "2025-02-01");

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
