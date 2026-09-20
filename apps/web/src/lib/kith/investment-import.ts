// The one-time import of the owner's investments spreadsheet.
//
// No Google API and no upload: the operator exports the two tabs as CSV and
// the browser reads them. `Summary` becomes investments (and one `commitment`
// entry each), `Ledger` becomes entries.
//
// CSV rather than xlsx. The repo's xlsx reader
// (`packages/pipeline/src/spreadsheet.ts`) is a Node module built on
// `node:zlib` and `node:crypto`, so it cannot run in the browser, and running
// it in a route would mean adding `@repo/pipeline` to the web app and posting
// the whole workbook to the server before the operator has seen a preview. Two
// "Save as CSV" clicks cost less than either.
//
// Everything here is pure: parse, map, reconcile, plan, and an orchestration
// that takes its three writes as arguments. The screen renders what these
// return and performs what the operator approves, so every rule below is
// tested without a DOM, a network or a database -- which matters, because they
// are rules about the owner's money.

import {
  createEntrySchema,
  createInvestmentSchema,
} from "@/lib/kith/investment-schemas";

/** ---------------------------------------------------------------------------
 * The sign and currency rule, stated once. The preview shows this text, so the
 * operator is reading the same sentence the code is applying.
 * ------------------------------------------------------------------------- */
export const IMPORT_RULE =
  "Ledger: the sign comes from the Amount column (the USD column) when it has a value, and from the GBP column otherwise. " +
  "Negative is money out (capital call paid), positive is money in (distribution). " +
  "A value in the GBP column makes the entry GBP with that column as its amount and Exchange Rate as the rate to USD; otherwise the entry is USD. " +
  "Each GBP row is checked against the sheet's own USD Amount: GBP times rate must agree within 1% or $1. " +
  "Every type can be changed per row before importing.";

/** What a second import of a corrected row does, said before the operator
 * imports rather than discovered afterwards. */
export const IMPORT_REIMPORT_NOTE =
  "A row is matched by investment, date, currency and amount. Re-importing the same file changes nothing. " +
  "A row corrected in the sheet is a different row, so it is imported as a NEW entry and the old one stays: delete the old entry from its investment afterwards.";

/** The most decimal places the money column holds. */
const MONEY_SCALE = 6;
/** The most decimal places the exchange rate column holds. */
const RATE_SCALE = 10;
/** A GBP row's converted value may differ from the sheet's USD Amount by this
 * much before the rate is called into question. */
const RATE_TOLERANCE_FRACTION = 100n; // 1%
const RATE_TOLERANCE_FLOOR_CENTS = 100n; // $1.00
/** How far the Summary's Sent/Received may sit from the Ledger's own sum
 * before it is reported as a difference. The Summary's figures are whole
 * dollars, typed by hand; the Ledger's are to the cent. A sheet the owner
 * calls balanced can be off by the fraction that rounding to a dollar drops,
 * and reporting that every time would be a warning nobody reads. */
const RECONCILE_TOLERANCE_CENTS = 100n; // $1.00

export type LedgerDraft = {
  /**
   * Stable across imports of the same file, and distinct for two genuinely
   * identical rows.
   *
   * `occurrence` is why: a sheet may legitimately hold the same investment,
   * date, currency and amount twice (two calls of the same size on the same
   * day), and without an ordinal the second shares the first's key, the unique
   * index silently drops it, and the import reports two rows imported when one
   * was.
   */
  importKey: string;
  /** 1 for the first row with these values, 2 for the second, and so on. */
  occurrence: number;
  line: number;
  investmentName: string;
  entryType: "capital_call_paid" | "distribution";
  entryDate: string;
  amount: string;
  currency: string;
  exchangeRate: string | null;
  note: string | null;
  /** Which branch of the rule produced the type, for the preview. */
  why: string;
  /**
   * This row's value in USD: the amount itself, or amount times rate, at the
   * money column's own scale rather than rounded to cents.
   *
   * Unrounded because the reconciliation adds these and the store adds the
   * unrounded products too, rounding once at the end. Rounding per row here
   * made a sheet the store accepts as balanced show a difference of a few
   * cents, which forced the operator to acknowledge a rounding artifact.
   */
  usdAmount: string;
  /**
   * The sheet's own USD `Amount` beside what the rate produces, for a row that
   * states both. Null when the sheet gave only one of them, which is not a
   * disagreement.
   */
  rateCheck: {
    sheetUsd: string;
    convertedUsd: string;
    difference: string;
    /** True when the two differ by more than the tolerance. */
    suspect: boolean;
  } | null;
  /** Rounding this row's cells needed to fit the columns. Shown, not hidden. */
  notes: string[];
};

export type SummaryDraft = {
  importKey: string;
  line: number;
  name: string;
  category: string | null;
  signedOn: string | null;
  status: "active" | "closed" | "written_off";
  notes: string | null;
  /** The commitment entry the Summary row becomes, if it states one. */
  committed: string | null;
  /** The Summary's own figures, kept only to reconcile against the Ledger. */
  statedSent: string | null;
  statedReceived: string | null;
};

export type SkippedRow = { line: number; raw: string; reason: string };

export type Reconciliation = {
  investmentName: string;
  field: "sent" | "received";
  /** The Summary's figure, in USD. */
  stated: string;
  /** The Ledger's rows for this investment, converted to USD and added. */
  imported: string;
  difference: string;
  /** One line, ready to render. The preview shows this rather than composing
   * its own, so the words the operator approves are the words that were
   * computed. */
  label: string;
};

export type ImportPreview = {
  summary: SummaryDraft[];
  ledger: LedgerDraft[];
  skipped: SkippedRow[];
  reconciliation: Reconciliation[];
  /** Rows whose GBP, rate and USD columns disagree. Counted separately from a
   * per-investment difference because the cause is different: usually an
   * inverted rate. */
  suspectRates: LedgerDraft[];
  /** The sheet's own "Total" row, checked against the sums of the other
   * Summary rows and against the Ledger's totals. `null` when the sheet has
   * no such row. */
  topLineCheck: TopLineCheck | null;
  /** Investment names the Ledger mentions that the Summary never names. Each
   * is still created -- with no commitment, since the Summary is what states
   * one -- but is called out here rather than blending into the ordinary
   * investment list. */
  ledgerOnlyInvestments: string[];
  /** A Summary row that states a Sent amount but has no Ledger rows at all:
   * the commitment is still handled by the Docs Signed / estimated-date rule,
   * but there is nothing here to reconcile Sent against, which is worth the
   * operator's own look rather than silence. */
  sentWithNoLedgerRows: { investmentName: string; line: number; amount: string }[];
};

export type TopLineCheckField = {
  /** The Total row's own figure for this column, in USD. `null` when the
   * sheet left the cell blank. */
  totalRow: string | null;
  /** The sum of every other Summary row's figure for this column. */
  summarySum: string;
  /** The sum of the Ledger's own rows for this column, converted to USD.
   * `null` for Committed, which the Ledger has no entries for. */
  ledgerSum: string | null;
  /** `totalRow - summarySum`. `null` when the sheet left the cell blank. */
  difference: string | null;
  /** `totalRow - ledgerSum`. `null` whenever `ledgerSum` is (Committed), or
   * the sheet left the Total cell blank. Shown separately from `difference`
   * because the two can disagree: a Ledger-only investment or a Summary row
   * with no Ledger rows moves this figure but not the Summary-only one, and
   * a large gap here has to be visible on its own rather than folded into a
   * `ledgerSum` the operator has to subtract by hand to notice it. */
  ledgerDifference: string | null;
};

export type TopLineCheck = {
  line: number;
  committed: TopLineCheckField;
  sent: TopLineCheckField;
  received: TopLineCheckField;
};

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 enough for a spreadsheet export: quoted fields, doubled quotes
 * inside them, and newlines inside quotes. Written out rather than depended on
 * because it is twenty lines and a CSV dependency is not.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // A leading byte-order mark would otherwise become part of the first header.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

/** Header-keyed rows. Headers are matched case- and space-insensitively,
 * because a person's spreadsheet says "Docs Signed" one year and "docs signed"
 * the next. */
export function keyed(rows: string[][]): Record<string, string>[] {
  const [header, ...body] = rows;
  if (header === undefined) return [];
  const keys = header.map((cell) => cell.trim().toLowerCase());
  return body.map((cells) => {
    const record: Record<string, string> = {};
    keys.forEach((key, index) => {
      record[key] = (cells[index] ?? "").trim();
    });
    return record;
  });
}

// ---------------------------------------------------------------------------
// Exact decimal arithmetic
//
// Every figure below is a decimal string in and a decimal string out, with
// `bigint` in between. There is no `Number` arithmetic on money anywhere in
// this file: the reconciliation exists to find differences, and a difference
// it invented from a float would be worse than not reconciling at all.
// ---------------------------------------------------------------------------

/** `value` as an integer count of 10^-scale units, half-up beyond the scale. */
function units(value: string, scale: number): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace(/^[-+]/, "").split(".");
  const padded = `${fraction}${"0".repeat(scale + 1)}`;
  const kept = BigInt(`${whole}${padded.slice(0, scale)}`);
  const next = Number(padded[scale]);
  const rounded = next >= 5 ? kept + 1n : kept;
  return negative ? -rounded : rounded;
}

/** The inverse of `units`, trailing zeros trimmed to two places. */
function fromUnits(value: bigint, scale: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const whole = absolute / divisor;
  const fraction = `${absolute % divisor}`.padStart(scale, "0");
  const trimmed = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}${whole}.${trimmed}`;
}

/** Round to at most `scale` decimal places, half up. Returns the rounded
 * value and whether anything was actually dropped. */
export function roundToScale(
  value: string,
  scale: number,
): { value: string; rounded: boolean } {
  const result = fromUnits(units(value, scale), scale);
  // `units` is exact when the input already fits, so a changed value means a
  // digit was dropped. Compare numerically, not textually: `1.50` and `1.5`
  // are the same money.
  const rounded = units(value, MONEY_SCALE + RATE_SCALE) !==
    units(result, MONEY_SCALE + RATE_SCALE);
  return { value: result, rounded };
}

/** Exact addition, at money's scale. */
export function addDecimals(values: readonly string[]): string {
  let total = 0n;
  for (const value of values) total += units(value, MONEY_SCALE);
  return fromUnits(total, MONEY_SCALE);
}

export function subtractDecimals(left: string, right: string): string {
  return fromUnits(
    units(left, MONEY_SCALE) - units(right, MONEY_SCALE),
    MONEY_SCALE,
  );
}

/**
 * `amount * rate`, at `scale` decimal places.
 *
 * The store converts each entry and sums the unrounded products, rounding
 * once at the end. The preview has to convert the same way, or a sheet the
 * store would call balanced shows a difference of a few cents here and the
 * operator is made to acknowledge a rounding artifact. So rows are converted
 * at `MONEY_SCALE` and the reconciliation rounds its own totals once; only
 * the figure shown beside a row is rounded to cents.
 */
export function multiplyDecimals(
  amount: string,
  rate: string,
  scale = 2,
): string {
  const product = units(amount, MONEY_SCALE) * units(rate, RATE_SCALE);
  const divisor = 10n ** BigInt(MONEY_SCALE + RATE_SCALE - scale);
  const half = divisor / 2n;
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const scaled = (magnitude + half) / divisor;
  return fromUnits(negative ? -scaled : scaled, scale);
}

function absolute(value: string): string {
  return value.startsWith("-") ? value.slice(1) : value;
}

/** Whether a cell held text that did not read as a stated value: not blank,
 * but its parse (`parseMoney`, `parseRate`, ...) came back null. Distinct
 * from "not stated", so a malformed cell -- `1.234,56`, a comma-decimal a US
 * export never writes -- is reported for what it is rather than silently
 * treated the same as one the sheet simply left empty. */
function isUnreadable(raw: string | undefined, parsed: unknown): boolean {
  return (raw ?? "").trim() !== "" && parsed === null;
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/**
 * A spreadsheet money cell as an exact decimal string and a sign.
 *
 * `$1,234.50`, `(1,234.50)`, `-1234.5` and `1234.50` all parse. The magnitude
 * is returned separately from the sign because an entry's direction is its
 * type, never a negative amount. `null` means the cell holds no number, which
 * is a skip rather than a zero: a blank Sent column is "not stated", and
 * importing it as 0.00 would make the reconciliation agree with a figure the
 * sheet never gave.
 *
 * The sheet's own precision is kept, up to the money column's scale. Rounding
 * to two places here was wrong: a rate-derived cell with four places became a
 * different number before anything had looked at it. Anything beyond the
 * column's scale is rounded and `rounded` says so, so the preview can show it.
 */
/** A plain decimal (`1234.56`), or one grouped in threes with commas
 * (`1,234,567.89`). Checked against the cell -- with its symbol, parens and
 * whitespace stripped but its commas still in place -- before those commas
 * are ever removed: stripping them first accepted any placement, so
 * `1.234,56` (a comma decimal mark) silently became `1.23456`, `1 000,50`
 * became `100050.00`, and `1,2,3` became `123.00`, three different numbers
 * nobody chose. */
const GROUPED_OR_PLAIN_DECIMAL = /^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/;

export function parseMoney(
  value: string | undefined,
): { amount: string; negative: boolean; rounded: boolean } | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "-") return null;
  // Accounting style puts the symbol outside the parenthesis (`$ (72,182)`),
  // so the parenthesis is looked for anywhere in the cell rather than anchored
  // to its very start -- anchored, this cell's `(` never matched and every
  // capital call was read as a positive number.
  const parenthesised = trimmed.includes("(") && trimmed.endsWith(")");
  const hasSymbol = /[$£€]/.test(trimmed);
  // The symbol, the parens and every space gone -- an accounting cell puts a
  // space between the symbol and the number (`$ (72,182)`) -- but the sign
  // and the commas are still there: the sign, because the zero check below
  // needs to tell "$ -" from "-15,200.00"; the commas, because whether they
  // are really thousands separators is what `GROUPED_OR_PLAIN_DECIMAL` below
  // decides.
  const withoutSymbols = trimmed.replace(/[$£€\s()]/g, "");
  // The accounting zero placeholder (`$ -`, `$ -   `): a currency symbol with
  // nothing but a dash for its number. A bare dash with no symbol is the
  // "not stated" cell handled above and stays absent, not zero.
  if (withoutSymbols === "-" && hasSymbol) {
    return { amount: "0.00", negative: false, rounded: false };
  }
  const negativeSign = withoutSymbols.startsWith("-");
  const numeric = negativeSign ? withoutSymbols.slice(1) : withoutSymbols;
  if (!GROUPED_OR_PLAIN_DECIMAL.test(numeric)) return null;
  const digits = numeric.replace(/,/g, "");
  const negative = parenthesised || negativeSign;
  const scaled = roundToScale(digits, MONEY_SCALE);
  return { amount: scaled.value, negative, rounded: scaled.rounded };
}

/**
 * A rate cell, kept to the column's scale.
 *
 * A rate with more places than the column holds is rounded rather than
 * refused: an unimportable row is a worse answer than a rate correct to ten
 * decimal places, and the rounding is reported.
 */
export function parseRate(
  value: string | undefined,
): { rate: string; rounded: boolean } | null {
  if (value === undefined) return null;
  const digits = value.trim().replace(/[,\s$£€]/g, "");
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  const scaled = roundToScale(digits, RATE_SCALE);
  if (units(scaled.value, RATE_SCALE) <= 0n) return null;
  return { rate: scaled.value, rounded: scaled.rounded };
}

/** The year a real date may plausibly hold. A typo like `2/6/0206` matches the
 * `M/D/YYYY` shape and would otherwise become a stored date nobody chose. */
const MIN_PLAUSIBLE_YEAR = 1990;
const MAX_PLAUSIBLE_YEAR = 2100;

function plausibleYear(year: string): boolean {
  const numeric = Number(year);
  return numeric >= MIN_PLAUSIBLE_YEAR && numeric <= MAX_PLAUSIBLE_YEAR;
}

/**
 * A spreadsheet date cell as `YYYY-MM-DD`.
 *
 * ISO first, then the `M/D/YYYY` a US-locale export produces. Anything else is
 * a skipped row with a reason rather than a guess: `3/4/2024` is ambiguous
 * across locales and the only safe reading of an unrecognised date is to say
 * so. A year outside `MIN_PLAUSIBLE_YEAR`..`MAX_PLAUSIBLE_YEAR` is refused the
 * same way: `2/6/0206` matches the `M/D/YYYY` shape exactly and would
 * otherwise become `0206-02-06`, imported silently rather than reported.
 */
export function parseSheetDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) return plausibleYear(iso[1]!) ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (slashed) {
    if (!plausibleYear(slashed[3]!)) return null;
    const month = slashed[1]!.padStart(2, "0");
    const day = slashed[2]!.padStart(2, "0");
    return `${slashed[3]}-${month}-${day}`;
  }
  return null;
}

/**
 * Why a non-blank date cell produced no date, for a row's skip reason.
 *
 * Distinguished from "blank or unrecognised" only when the cell otherwise fit
 * a recognised shape and failed on its year: that is the one case a person
 * fixing the sheet needs a different sentence for, because "unrecognised"
 * reads as a formatting problem and this is a typo in the year itself.
 */
function unusableDateReason(raw: string): string {
  if (raw === "") return "Date is blank or unrecognised";
  const year =
    /^(\d{4})-\d{2}-\d{2}/.exec(raw)?.[1] ??
    /^\d{1,2}\/\d{1,2}\/(\d{4})$/.exec(raw)?.[1];
  if (year !== undefined && !plausibleYear(year)) {
    return `Date year ${year} is outside a plausible range (${MIN_PLAUSIBLE_YEAR}-${MAX_PLAUSIBLE_YEAR})`;
  }
  return "Date is blank or unrecognised";
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const STATUS_BY_LABEL: Record<string, SummaryDraft["status"]> = {
  active: "active",
  open: "active",
  closed: "closed",
  exited: "closed",
  "written off": "written_off",
  "write-off": "written_off",
};

/** The sheet's own totals row (Investment cell exactly "Total"), kept to check
 * against the sums of the other rows rather than imported as an investment. */
export type SummaryTotalsRow = {
  line: number;
  committed: string | null;
  sent: string | null;
  received: string | null;
};

/** `Summary` rows to investments. A row with no Investment name is skipped,
 * and the sheet's own "Total" row is pulled out rather than imported. */
export function mapSummary(
  rows: readonly Record<string, string>[],
): {
  drafts: SummaryDraft[];
  skipped: SkippedRow[];
  totalsRow: SummaryTotalsRow | null;
} {
  const drafts: SummaryDraft[] = [];
  const skipped: SkippedRow[] = [];
  let totalsRow: SummaryTotalsRow | null = null;
  rows.forEach((record, index) => {
    const line = index + 2;
    const name = (record.investment ?? "").trim();
    if (name === "") {
      skipped.push({
        line,
        raw: Object.values(record).join(","),
        reason: "No investment name",
      });
      return;
    }
    if (name.toLowerCase() === "total") {
      // Not an investment: the sheet's own check figure. `mapSummary` cannot
      // compute the check itself -- it needs the Ledger's totals too -- so it
      // only carries the row's own numbers out; `buildPreview` does the
      // comparison once it has both tabs.
      totalsRow = {
        line,
        committed: parseMoney(record.committed)?.amount ?? null,
        sent: parseMoney(record.sent)?.amount ?? null,
        received: parseMoney(record.received)?.amount ?? null,
      };
      return;
    }
    const committed = parseMoney(record.committed);
    const sent = parseMoney(record.sent);
    const received = parseMoney(record.received);
    const statusLabel = (record.status ?? "").trim().toLowerCase();
    // The two free-text columns are one note: they are the owner's comments on
    // the same row and nothing downstream reads them apart.
    const notes = Object.entries(record)
      .filter(([key]) => key.startsWith("comment"))
      .map(([, value]) => value.trim())
      .filter(Boolean)
      .join(" — ");
    const docsSignedRaw = (record["docs signed"] ?? "").trim();
    const signedOn = parseSheetDate(record["docs signed"]);
    if (docsSignedRaw !== "" && signedOn === null) {
      // Reported, not silently folded into "blank": a typo'd Docs Signed date
      // (an implausible year, an unrecognised format) is not the same fact as
      // an empty cell, and rule 3's ledger-date fallback below must not be
      // allowed to quietly absorb it.
      skipped.push({
        line,
        raw: docsSignedRaw,
        reason: `Docs Signed "${docsSignedRaw}" is not a usable date`,
      });
    }
    const unreadableMoney = (
      [
        ["Committed", record.committed, committed],
        ["Sent", record.sent, sent],
        ["Received", record.received, received],
      ] as const
    ).filter(([, raw, parsed]) => isUnreadable(raw, parsed));
    if (unreadableMoney.length > 0) {
      // Reported rather than silently read as "not stated": a malformed
      // amount is a data problem, not an empty cell, and folding the two
      // together lost a stated Committed figure with nothing said.
      skipped.push({
        line,
        raw: unreadableMoney.map(([field, raw]) => `${field}="${raw}"`).join(", "),
        reason: `${unreadableMoney.map(([field]) => field).join(", ")} value is unreadable`,
      });
    }
    drafts.push({
      importKey: `summary:${name.toLowerCase()}`,
      line,
      name,
      category: (record.category ?? "").trim() || null,
      signedOn,
      status: STATUS_BY_LABEL[statusLabel] ?? "active",
      notes: notes || null,
      committed: committed === null ? null : committed.amount,
      statedSent: sent === null ? null : sent.amount,
      statedReceived: received === null ? null : received.amount,
    });
  });
  return { drafts, skipped, totalsRow };
}

/** `Ledger` rows to entries, applying IMPORT_RULE. */
export function mapLedger(
  rows: readonly Record<string, string>[],
): { drafts: LedgerDraft[]; skipped: SkippedRow[] } {
  const drafts: LedgerDraft[] = [];
  const skipped: SkippedRow[] = [];
  /** How many rows already carried each identity, so the next gets its own
   * key rather than silently colliding with the first. */
  const seen = new Map<string, number>();

  rows.forEach((record, index) => {
    const line = index + 2;
    const raw = Object.values(record).join(",");
    const investmentName = (record.investment ?? "").trim();
    const entryDate = parseSheetDate(record.date);
    const usd = parseMoney(record.amount);
    const gbp = parseMoney(record.gbp);
    const rate = parseRate(record["exchange rate"]);
    if (investmentName === "") {
      skipped.push({ line, raw, reason: "No investment name" });
      return;
    }
    if (entryDate === null) {
      skipped.push({
        line,
        raw,
        reason: unusableDateReason((record.date ?? "").trim()),
      });
      return;
    }
    const unreadableAmount = isUnreadable(record.amount, usd);
    const unreadableGbp = isUnreadable(record.gbp, gbp);
    if (usd === null && gbp === null) {
      skipped.push({
        line,
        raw,
        reason:
          unreadableAmount || unreadableGbp
            ? `${[unreadableAmount && "Amount", unreadableGbp && "GBP"].filter(Boolean).join(" and ")} value is unreadable`
            : "No amount",
      });
      return;
    }
    if (unreadableAmount || unreadableGbp) {
      // One column read fine and the row still imports from it, but the
      // other was not blank -- it held text `parseMoney` could not read --
      // which is worth the operator's own look rather than silent loss.
      skipped.push({
        line,
        raw,
        reason: `${[unreadableAmount && "Amount", unreadableGbp && "GBP"].filter(Boolean).join(" and ")} value is unreadable`,
      });
    }
    if (gbp !== null && rate === null) {
      skipped.push({ line, raw, reason: "GBP amount with no exchange rate" });
      return;
    }

    // The currency comes from the GBP column; the sign comes from the USD
    // Amount column when it has one. Reading the sign off the GBP column alone
    // was wrong: a sheet that writes the GBP figure unsigned and puts the sign
    // only on the USD column would have had every GBP row imported as a
    // distribution.
    //
    // "Has one" excludes the accounting zero placeholder (`$ -`): a zero USD
    // cell states no direction, and reading it as positive turned a GBP
    // capital call with a blank Amount column (represented as `$ -`, not
    // truly absent) into a distribution. The USD cell is a real sign source
    // only when it is present and not that placeholder.
    const usdStatesValue = usd !== null && usd.amount !== "0.00";
    const currency = gbp === null ? "USD" : "GBP";
    const signSource = usdStatesValue ? usd! : (gbp ?? usd!);
    const amountSource = currency === "GBP" ? gbp! : usd!;
    const entryType = signSource.negative ? "capital_call_paid" : "distribution";
    const notes: string[] = [];
    if (amountSource.rounded) {
      notes.push("amount rounded to the money column's scale");
    }
    if (rate?.rounded === true) {
      notes.push("exchange rate rounded to 10 decimal places");
    }

    // Kept at the money column's scale: the reconciliation adds these, and
    // the store adds the unrounded products too.
    const convertedUsd =
      currency === "USD"
        ? amountSource.amount
        : multiplyDecimals(amountSource.amount, rate!.rate, MONEY_SCALE);
    // Both columns stated: the sheet is checkable against itself, and an
    // inverted rate shows up here rather than in a total months later. The
    // comparison itself is at cents, because that is the precision the sheet's
    // own USD column carries. Gated on `usdStatesValue`, not merely `usd !==
    // null`, for the same reason the sign is: the zero placeholder is not a
    // stated USD figure to check the rate against, and comparing it produced
    // a "rate looks wrong" warning on every GBP row that used it.
    const rateCheck =
      currency === "GBP" && usdStatesValue
        ? checkRate(
            usd!.amount,
            multiplyDecimals(amountSource.amount, rate!.rate),
          )
        : null;

    const identity = `ledger:${investmentName.toLowerCase()}:${entryDate}:${currency}:${
      signSource.negative ? "-" : ""
    }${amountSource.amount}`;
    const occurrence = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, occurrence);

    drafts.push({
      importKey: `${identity}#${occurrence}`,
      occurrence,
      line,
      investmentName,
      entryType,
      entryDate,
      amount: amountSource.amount,
      currency,
      exchangeRate: currency === "USD" ? null : rate!.rate,
      note: (record.comment ?? "").trim() || null,
      why:
        `${signSource.negative ? "negative" : "positive"} ` +
        `${usdStatesValue ? "Amount" : "GBP"} → ${entryType}`,
      usdAmount: convertedUsd,
      rateCheck,
      notes,
    });
  });
  return { drafts, skipped };
}

/** Whether the sheet's own USD figure and the converted one agree. */
function checkRate(
  sheetUsd: string,
  convertedUsd: string,
): NonNullable<LedgerDraft["rateCheck"]> {
  const difference = subtractDecimals(sheetUsd, convertedUsd);
  const gap = units(absolute(difference), 2);
  const scale = units(sheetUsd, 2);
  const allowed =
    (scale < 0n ? -scale : scale) / RATE_TOLERANCE_FRACTION >
    RATE_TOLERANCE_FLOOR_CENTS
      ? (scale < 0n ? -scale : scale) / RATE_TOLERANCE_FRACTION
      : RATE_TOLERANCE_FLOOR_CENTS;
  return {
    sheetUsd,
    convertedUsd,
    difference,
    suspect: gap > allowed,
  };
}

/**
 * Where the Ledger and the Summary disagree, in USD.
 *
 * Neither is trusted over the other: the preview reports the difference and
 * the operator decides. Silence here would mean importing a Sent total the
 * entries do not add up to, and the screen would then show a number the owner
 * cannot reconstruct from its own rows.
 *
 * Every entry is included, converted with its own rate. The earlier version
 * compared only USD rows, which meant any investment with a GBP call always
 * showed a difference the size of that call -- a warning that fires every time
 * is a warning nobody reads.
 *
 * The conversion is summed unrounded and rounded once at the end, which is
 * what the store does. Rounding each row first put the preview a few cents
 * away from the totals the screen would go on to show, and an acknowledgement
 * demanded for a rounding artifact teaches the operator to tick the box
 * without reading it.
 */
export function reconcile(
  summary: readonly SummaryDraft[],
  ledger: readonly LedgerDraft[],
): Reconciliation[] {
  const differences: Reconciliation[] = [];
  for (const investment of summary) {
    const mine = ledger.filter(
      (entry) =>
        entry.investmentName.toLowerCase() === investment.name.toLowerCase(),
    );
    const sumAs = (entryType: LedgerDraft["entryType"]) =>
      roundToScale(
        addDecimals(
          mine
            .filter((entry) => entry.entryType === entryType)
            .map((entry) => entry.usdAmount),
        ),
        2,
      ).value;
    const totals = {
      sent: sumAs("capital_call_paid"),
      received: sumAs("distribution"),
    };
    const stated = {
      sent: investment.statedSent,
      received: investment.statedReceived,
    };
    for (const field of ["sent", "received"] as const) {
      const claim = stated[field];
      if (claim === null) continue;
      const difference = subtractDecimals(claim, totals[field]);
      if (units(absolute(difference), 2) > RECONCILE_TOLERANCE_CENTS) {
        differences.push({
          investmentName: investment.name,
          field,
          stated: claim,
          imported: totals[field],
          difference,
          label:
            `${investment.name}: the sheet says ${field} ${claim} USD, ` +
            `its rows add to ${totals[field]} USD (${difference})`,
        });
      }
    }
  }
  return differences;
}

/** The sheet's own Total row against the sums this import computes. */
function checkTopLine(
  totalsRow: SummaryTotalsRow,
  summary: readonly SummaryDraft[],
  ledger: readonly LedgerDraft[],
): TopLineCheck {
  const sumOf = (values: readonly (string | null)[]) =>
    addDecimals(values.filter((value): value is string => value !== null));
  const ledgerSumAs = (entryType: LedgerDraft["entryType"]) =>
    roundToScale(
      addDecimals(
        ledger
          .filter((entry) => entry.entryType === entryType)
          .map((entry) => entry.usdAmount),
      ),
      2,
    ).value;
  const field = (
    totalRow: string | null,
    summarySum: string,
    ledgerSum: string | null,
  ): TopLineCheckField => ({
    totalRow,
    summarySum,
    ledgerSum,
    difference: totalRow === null ? null : subtractDecimals(totalRow, summarySum),
    ledgerDifference:
      totalRow === null || ledgerSum === null
        ? null
        : subtractDecimals(totalRow, ledgerSum),
  });
  return {
    line: totalsRow.line,
    committed: field(
      totalsRow.committed,
      sumOf(summary.map((row) => row.committed)),
      null, // The Ledger has no commitment entries to sum against.
    ),
    sent: field(
      totalsRow.sent,
      sumOf(summary.map((row) => row.statedSent)),
      ledgerSumAs("capital_call_paid"),
    ),
    received: field(
      totalsRow.received,
      sumOf(summary.map((row) => row.statedReceived)),
      ledgerSumAs("distribution"),
    ),
  };
}

/** Ledger investment names the Summary never mentions, in first-seen order. */
function findLedgerOnlyInvestments(
  summary: readonly SummaryDraft[],
  ledger: readonly LedgerDraft[],
): string[] {
  const summaryNames = new Set(summary.map((row) => row.name.toLowerCase()));
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of ledger) {
    const key = entry.investmentName.toLowerCase();
    if (summaryNames.has(key) || seen.has(key)) continue;
    seen.add(key);
    names.push(entry.investmentName);
  }
  return names;
}

/** Summary rows that state a Sent amount but have no Ledger rows at all. */
function findSentWithNoLedgerRows(
  summary: readonly SummaryDraft[],
  ledger: readonly LedgerDraft[],
): { investmentName: string; line: number; amount: string }[] {
  const ledgerNames = new Set(
    ledger.map((entry) => entry.investmentName.toLowerCase()),
  );
  return summary
    .filter(
      (row) => row.statedSent !== null && !ledgerNames.has(row.name.toLowerCase()),
    )
    .map((row) => ({
      investmentName: row.name,
      line: row.line,
      amount: row.statedSent!,
    }));
}

/** The whole preview from the two files' text. */
export function buildPreview(
  summaryCsv: string,
  ledgerCsv: string,
): ImportPreview {
  const summary = mapSummary(keyed(parseCsv(summaryCsv)));
  const ledger = mapLedger(keyed(parseCsv(ledgerCsv)));
  return {
    summary: summary.drafts,
    ledger: ledger.drafts,
    skipped: [...summary.skipped, ...ledger.skipped],
    reconciliation: reconcile(summary.drafts, ledger.drafts),
    suspectRates: ledger.drafts.filter(
      (draft) => draft.rateCheck?.suspect === true,
    ),
    topLineCheck:
      summary.totalsRow === null
        ? null
        : checkTopLine(summary.totalsRow, summary.drafts, ledger.drafts),
    ledgerOnlyInvestments: findLedgerOnlyInvestments(
      summary.drafts,
      ledger.drafts,
    ),
    sentWithNoLedgerRows: findSentWithNoLedgerRows(summary.drafts, ledger.drafts),
  };
}

// ---------------------------------------------------------------------------
// Planning and performing the import
// ---------------------------------------------------------------------------

export type InvestmentFields = {
  name: string;
  category?: string;
  signedOn?: string;
  status?: SummaryDraft["status"];
  notes?: string;
};

export type EntryBody = {
  entryType: string;
  entryDate: string;
  amount: string;
  currency: string;
  exchangeRate?: string;
  note?: string;
  /**
   * True when `entryDate` is this import's own estimate rather than a date
   * the sheet states (ADM-8b, slice 1b).
   *
   * Only rule 3's fallback sets it: a Summary row with a Committed amount and
   * no Docs Signed date, dated at the investment's earliest Ledger entry. A
   * Ledger row is never marked, because a Ledger row without a parsable date
   * is skipped rather than estimated.
   *
   * It is what lets a matched `investment_agreement` later replace the date
   * with the one the agreement actually states. Without it the store defaults
   * to false and the date is treated as the owner's own, which is the safe
   * side of the same rule.
   */
  dateIsEstimated?: boolean;
  importKey: string;
};

export type ImportOperation =
  | { kind: "investment"; key: string; label: string; fields: InvestmentFields }
  | {
      kind: "entry";
      key: string;
      label: string;
      investmentName: string;
      body: EntryBody;
    };

export type ImportRowResult = {
  key: string;
  label: string;
  status: "created" | "existing" | "failed";
  reason?: string;
};

export type ImportPlan = {
  operations: ImportOperation[];
  /** Rows that cannot be sent at all, with the reason, known before anything
   * is written rather than discovered as a 400 halfway through. */
  invalid: ImportRowResult[];
};

export type ImportOutcome = {
  investmentsCreated: number;
  investmentsExisting: number;
  entriesCreated: number;
  /** Rows the import key said were already here: not created, not an error. */
  entriesAlreadyImported: number;
  failed: ImportRowResult[];
  results: ImportRowResult[];
};

/** Drop the keys whose value is blank, so an empty spreadsheet cell is an
 * absent field rather than `""` -- which the schemas refuse, and which used to
 * make a whole Summary row vanish with its Committed figure. */
function present<T extends Record<string, string | null | undefined>>(
  fields: T,
): { [K in keyof T]?: string } {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string" && value.trim() !== "") kept[key] = value;
  }
  return kept as { [K in keyof T]?: string };
}

/**
 * The operations the preview implies, each validated against the very schema
 * its route will validate it with.
 *
 * Validating here rather than discovering a 400 mid-run is the point: the
 * operator sees every unimportable row before anything is written, and the run
 * itself has no expected failures left.
 */
export function planImport(preview: ImportPreview): ImportPlan {
  const operations: ImportOperation[] = [];
  const invalid: ImportRowResult[] = [];

  // Rule 3's fallback: the earliest Ledger entry per investment, for a
  // commitment whose Docs Signed cell is blank. Built once, from every Ledger
  // row, rather than re-scanning the Ledger per investment.
  const earliestLedgerDate = new Map<string, string>();
  for (const entry of preview.ledger) {
    const key = entry.investmentName.toLowerCase();
    const current = earliestLedgerDate.get(key);
    if (current === undefined || entry.entryDate < current) {
      earliestLedgerDate.set(key, entry.entryDate);
    }
  }

  for (const investment of preview.summary) {
    const fields = present({
      name: investment.name,
      category: investment.category,
      signedOn: investment.signedOn,
      notes: investment.notes,
    }) as InvestmentFields;
    fields.status = investment.status;
    const check = createInvestmentSchema.safeParse({
      ...fields,
      // A placeholder: the space is the screen's, not the sheet's, and the
      // schema only needs to see that one is present.
      spaceId: "space",
    });
    if (!check.success) {
      invalid.push({
        key: investment.importKey,
        label: `${investment.line}: ${investment.name}`,
        status: "failed",
        reason: check.error.issues[0]?.message ?? "Invalid investment",
      });
      continue;
    }
    operations.push({
      kind: "investment",
      key: investment.importKey,
      label: investment.name,
      fields,
    });

    if (investment.committed === null) continue;
    let commitmentDate = investment.signedOn;
    let estimated = false;
    if (commitmentDate === null) {
      // No Docs Signed date. Rather than block the commitment, date it at the
      // investment's own earliest Ledger entry and say so: the sheet's first
      // capital call is real evidence of when the commitment began, and it
      // beats leaving 34 of 40 commitments unimported. Today's date would
      // still be a fabricated fact, so that is never the fallback.
      const fallback = earliestLedgerDate.get(investment.name.toLowerCase());
      if (fallback === undefined) {
        // No ledger rows either: nothing to estimate from, so this is left
        // for the owner rather than guessed.
        invalid.push({
          key: `${investment.importKey}:commitment`,
          label: `${investment.line}: ${investment.name} commitment`,
          status: "failed",
          reason:
            "Committed amount with no Docs Signed date and no Ledger rows to estimate one from; set the date in the sheet, or add the commitment by hand",
        });
        continue;
      }
      commitmentDate = fallback;
      estimated = true;
    }
    const body: EntryBody = {
      entryType: "commitment",
      entryDate: commitmentDate,
      amount: investment.committed,
      currency: "USD",
      importKey: investment.importKey,
      // Two things, and they say different halves of the same fact. The
      // boolean is the marker the store reads (`date_is_estimated`, migration
      // 033): it is what allows a matched agreement to correct this date
      // later. The note says HOW it was estimated, which the boolean cannot
      // carry and which the owner reads in the drawer. Neither replaces the
      // other, so both are sent.
      ...(estimated
        ? {
            dateIsEstimated: true,
            note: "date estimated from first payment",
          }
        : {}),
    };
    pushEntry(operations, invalid, {
      key: body.importKey,
      label:
        `${investment.name} commitment ${body.amount} USD` +
        (estimated ? " (date estimated from first payment)" : ""),
      investmentName: investment.name,
      body,
    });
  }

  for (const entry of preview.ledger) {
    const body: EntryBody = {
      entryType: entry.entryType,
      entryDate: entry.entryDate,
      amount: entry.amount,
      currency: entry.currency,
      importKey: entry.importKey,
      ...(entry.exchangeRate === null ? {} : { exchangeRate: entry.exchangeRate }),
      ...(entry.note === null ? {} : { note: entry.note }),
    };
    pushEntry(operations, invalid, {
      key: entry.importKey,
      label: `${entry.line}: ${entry.investmentName} ${entry.entryDate} ${entry.amount} ${entry.currency}`,
      investmentName: entry.investmentName,
      body,
    });
  }

  return { operations, invalid };
}

function pushEntry(
  operations: ImportOperation[],
  invalid: ImportRowResult[],
  operation: Omit<Extract<ImportOperation, { kind: "entry" }>, "kind">,
): void {
  const check = createEntrySchema.safeParse(operation.body);
  if (!check.success) {
    invalid.push({
      key: operation.key,
      label: operation.label,
      status: "failed",
      reason: check.error.issues[0]?.message ?? "Invalid entry",
    });
    return;
  }
  operations.push({ kind: "entry", ...operation });
}

/** What `runImport` needs from the outside world. Three functions, so the
 * orchestration is testable without a network. */
export type ImportWriter = {
  /**
   * The investments that already exist, by lower-cased name.
   *
   * Archived ones included. The screen's ordinary read excludes them, and
   * building this map from that read meant a sheet naming an investment the
   * owner had archived created a live second one beside it -- the partial
   * unique index only covers live rows, so nothing refused it.
   */
  existing: ReadonlyMap<string, string>;
  createInvestment: (
    fields: InvestmentFields,
  ) => Promise<{ id: string; created: boolean }>;
  createEntry: (
    investmentId: string,
    body: EntryBody,
  ) => Promise<{ created: boolean }>;
};

/**
 * Perform an approved plan, one row at a time, collecting every outcome.
 *
 * Sequential rather than concurrent: the ledger rows need the investment ids
 * the summary rows create, and 39 investments with a few hundred entries is
 * not worth a dependency graph.
 *
 * A failed row is recorded and the run continues. The earlier version let the
 * first rejection escape, which stopped the import partway with nothing said
 * and no way to tell what had landed; every row carries its own key, so
 * re-running the same file after fixing the cause is safe.
 */
export async function runImport(
  plan: ImportPlan,
  writer: ImportWriter,
): Promise<ImportOutcome> {
  const byName = new Map(writer.existing);
  const results: ImportRowResult[] = [...plan.invalid];
  const outcome: ImportOutcome = {
    investmentsCreated: 0,
    investmentsExisting: 0,
    entriesCreated: 0,
    entriesAlreadyImported: 0,
    failed: [],
    results,
  };

  // Counted once per investment, not once per row that mentions one: the
  // Summary row and every Ledger row for the same fund resolve the same name,
  // and counting each of them would report thirty "existing" investments for
  // one that was already here.
  const counted = new Set<string>();
  const ensure = async (
    name: string,
    fields?: InvestmentFields,
  ): Promise<string> => {
    const key = name.toLowerCase();
    const known = byName.get(key);
    if (known !== undefined) {
      if (!counted.has(key)) {
        counted.add(key);
        outcome.investmentsExisting += 1;
      }
      return known;
    }
    const created = await writer.createInvestment(fields ?? { name });
    byName.set(key, created.id);
    counted.add(key);
    if (created.created) outcome.investmentsCreated += 1;
    else outcome.investmentsExisting += 1;
    return created.id;
  };

  for (const operation of plan.operations) {
    try {
      if (operation.kind === "investment") {
        const before = byName.size;
        await ensure(operation.fields.name, operation.fields);
        results.push({
          key: operation.key,
          label: operation.label,
          status: byName.size > before ? "created" : "existing",
        });
        continue;
      }
      const investmentId = await ensure(operation.investmentName);
      const written = await writer.createEntry(investmentId, operation.body);
      if (written.created) outcome.entriesCreated += 1;
      else outcome.entriesAlreadyImported += 1;
      results.push({
        key: operation.key,
        label: operation.label,
        status: written.created ? "created" : "existing",
      });
    } catch (error) {
      const failure: ImportRowResult = {
        key: operation.key,
        label: operation.label,
        status: "failed",
        reason: error instanceof Error ? error.message : "Request failed",
      };
      results.push(failure);
      outcome.failed.push(failure);
    }
  }

  outcome.failed.push(...plan.invalid);
  return outcome;
}
