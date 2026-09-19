// The gate: per value type, in code, never in the model.
//
// The model is an untrusted reader. It proposes `{field, valueType, value,
// page, quote}`; everything here decides whether that proposal may be stored
// as fact. A statement that passes becomes an observation with an evidence
// span. A statement that fails is not stored as a weaker fact, or stored with
// a confidence, or dropped: it opens a `corrections` row carrying the model's
// reading and a reason code, so the owner sees it.
//
// The rules, one per value type, all of them on top of the one rule every
// statement has to pass first:
//
// | Rule            | What it means                                                        |
// | --------------- | -------------------------------------------------------------------- |
// | quote on page   | The quote is found on the cited page, whitespace-normalized, and it resolves to an evidence span. |
// | money           | Parses exactly to a decimal and an ISO 4217 currency. A currency with no symbol or code anywhere on the page is the document type's default, or USD, and is flagged assumed. |
// | date            | Parses to a real ISO calendar date. The original text survives as the quote. |
// | number          | Parses exactly to a decimal.                                          |
// | line_item_list  | Items sum to a stated total when both exist, at tolerance zero.       |
// | text and friends| The value appears within its own quote.                               |
//
// No fuzzy fallbacks and no tolerances. "Wrong or unsure extractions are
// visible and correctable, never silent" is only true if the boundary is
// sharp.

import type { DocumentFieldValueType } from "../admin/model.js";
import {
  addDecimals,
  canonicalizeDecimal,
  compareDecimals,
  SUPPORTED_CURRENCIES,
  type ObservationValue,
} from "../records/values.js";

/**
 * Why a statement did not become a fact. A closed list: the corrections screen
 * groups by it, so a free-text reason would make the screen unreadable within
 * a week.
 */
export const CORRECTION_REASONS = [
  /** The cited quote is not on the cited page. */
  "quote_not_found",
  /** The quote is on the page but could not be turned into an evidence span. */
  "span_unresolved",
  /** The model named a field the document type does not have. */
  "unknown_field",
  /** The value does not appear within the quote that is supposed to support it. */
  "value_not_in_quote",
  /** A money value did not parse to an exact decimal. */
  "money_unparsable",
  /** A date value was not a real ISO calendar date. */
  "date_unparsable",
  /** A numeric date could be read two ways and the kind does not say which.
   * `01/02/26` is the first of February or the second of January, and a
   * coin flip stored with a citation is worse than an item in the queue. Set
   * the kind's `date_order` to settle it. */
  "date_ambiguous",
  /** A number value did not parse to an exact decimal. */
  "number_unparsable",
  /** Line items did not sum to the total stated alongside them. */
  "line_items_mismatch",
  /** The document was longer than the extraction bound, so part was not read. */
  "input_truncated",
  /** The kind named a model the provider would not take. The document was
   * read with the default instead, so this is a configuration item rather
   * than a reading to fix. */
  "extraction_model_refused",
  /** The model's output was not the shape the prompt asks for. */
  "malformed_statement",
  /** The statement cited a page number that is not in the document as shown.
   * Distinct from a bad line id on purpose: this one means the model and the
   * server disagree about how pages are numbered, which is a fault in the
   * prompt or the presentation rather than in the reading. */
  "citation_page_unknown",
  /** The statement cited line ids the page does not have, or a
   * range too wide to be a citation. A citation, unlike a quote, is either in
   * range or it is not: the server builds the text, so there is nothing left
   * for the model to get wrong except the numbers. */
  "citation_out_of_range",
  /** Two statements gave the same field two different values. Neither is
   * stored: a coin flip between two readings is the silent wrongness this
   * whole gate exists to prevent. */
  "conflicting_values",
] as const;

export type CorrectionReason = (typeof CORRECTION_REASONS)[number];

/** One line of a `line_item_list`, as the model returns it. */
export type LineItem = { description: string; amount: string };

/** A model statement, after JSON parsing and before any check. */
export type RawStatement = {
  field: string;
  value: unknown;
  page: number;
  quote: string;
};

export type GateFailure = { ok: false; reason: CorrectionReason };

export type GateSuccess = {
  ok: true;
  /** The observations this statement becomes. More than one only for line
   * items, which become one money observation each. */
  values: ObservationValue[];
  /** True when no currency symbol or code was anywhere on the page, so the
   * default was used rather than read. Never silent: it is stored on the
   * extraction row and shown with the statement. */
  currencyAssumed?: true;
  /** Line item sums carry their total forward so the caller can compare it
   * against a separately stated total field. */
  itemsTotal?: string;
};

export type GateResult = GateSuccess | GateFailure;

function fail(reason: CorrectionReason): GateFailure {
  return { ok: false, reason };
}

/** The same normalization the quote locator uses, so "found on the page" and
 * "contains its value" agree about what whitespace is. */
export function normalizeForMatch(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** What marks the digits after it as money: a symbol, or three capitals
 * standing as their own word. Used only to decide whether a space inside a
 * number is a rendering artifact. */
const CURRENCY_MARK =
  "[$\u20ac\u00a3\u00a5\u20b9\u20a9]|(?<![A-Za-z])[A-Z]{3}(?![A-Za-z])";

const CURRENCY_SYMBOLS: ReadonlyArray<readonly [string, string]> = [
  ["$", "USD"],
  ["US$", "USD"],
  ["€", "EUR"],
  ["£", "GBP"],
  ["¥", "JPY"],
  ["₹", "INR"],
  ["₩", "KRW"],
  ["CHF", "CHF"],
];

/**
 * The currency this page states, or undefined when it states none.
 *
 * A symbol wins over a bare ISO code. A symbol is only ever a currency, while
 * three capitals are also a word: "CAD drawing", "USD Holdings LLC" and a
 * column header that says CHF are all English, not prices. So a code counts
 * only when it sits against a number, which is how a document writes an amount
 * and how a sentence does not.
 *
 * A page carrying two different currencies states none. Guessing between them
 * is exactly the silent wrongness this feature exists to prevent, and the
 * caller marks the value's currency assumed instead.
 */
export function currencyOnPage(pageText: string): string | undefined {
  const symbols = new Set<string>();
  for (const [symbol, code] of CURRENCY_SYMBOLS) {
    // A symbol that is also an ISO code (CHF) has to earn its place the same
    // way a code does, or the word would count as a symbol and skip the check.
    if (/^[A-Z]{3}$/.test(symbol)) continue;
    if (pageText.includes(symbol)) symbols.add(code);
  }
  if (symbols.size === 1) return [...symbols][0];
  if (symbols.size > 1) return undefined;
  const codes = new Set<string>();
  for (const code of SUPPORTED_CURRENCIES) {
    const word = `(?<![A-Za-z])${code}(?![A-Za-z])`;
    if (
      new RegExp(`${word}[\\s(]*[-+]?\\d`).test(pageText) ||
      new RegExp(`\\d[\\s)]*${word}`).test(pageText)
    ) {
      codes.add(code);
    }
  }
  return codes.size === 1 ? [...codes][0] : undefined;
}

/**
 * A money literal to an exact decimal string.
 *
 * Accepts what a document actually prints: a leading or trailing symbol or
 * code, grouping separators, and accounting parentheses for a negative. It
 * does not accept anything that would need rounding, an exponent, or a
 * separator pattern it has to guess at, because `numeric` is exact and every
 * amount here is one the owner will later reconcile against a bank.
 */
export function parseAmount(raw: string): string | undefined {
  let text = raw.normalize("NFKC").trim();
  if (!text) return undefined;
  let negative = false;
  const accounting = /^\((.*)\)$/.exec(text);
  if (accounting) {
    negative = true;
    text = accounting[1]!.trim();
    // Parentheses already say negative. A sign inside them is either a second
    // negation or a contradiction, and `(-5)` is not a number any ledger
    // prints, so it is refused rather than read as one of the two.
    if (/[-+]/.test(text)) return undefined;
  }
  text = text.replace(/[A-Z]{3}/g, "");
  for (const [symbol] of CURRENCY_SYMBOLS) text = text.split(symbol).join("");
  text = text.replace(/[\s ]/g, "");
  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }
  if (text.endsWith("-")) {
    negative = !negative;
    text = text.slice(0, -1);
  }
  // Grouping separators only where a document would actually put them, so a
  // stray comma cannot quietly move a decimal point.
  //
  // The dot is the hard case, because `3.499` is a European three-thousand and
  // an English three-and-a-half at the same time and nothing in the string
  // settles it. The dot is therefore only a grouping separator when the string
  // proves it: either a decimal comma follows the groups (`1.234.567,89`), or
  // there are at least two of them (`1.234.567`). One dot group and nothing
  // else is read as a decimal point, which is what makes `$3.499`, `$0.125`
  // and `1.075` the amounts a reader would say out loud rather than 3499, 125
  // and 1075.
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.split(",").join("");
  else if (
    /^\d{1,3}(\.\d{3}){2,}$/.test(text) ||
    /^\d{1,3}(\.\d{3})+,\d+$/.test(text)
  ) {
    text = text.split(".").join("").replace(",", ".");
  } else if (/^\d+,\d+$/.test(text)) text = text.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined;
  try {
    return canonicalizeDecimal(`${negative ? "-" : ""}${text}`);
  } catch {
    return undefined;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function realIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Every number the quote prints, as exact decimals, with the sign the quote
 * gives it.
 *
 * The digit runs are taken greedily (`1,234.56` is one token, not three) and
 * each is parsed by the same function that parses the value itself, so the
 * quote and the value are read under one set of rules. A token that does not
 * parse is dropped rather than reported: the quote is prose, and prose
 * contains things like `4471` that are not amounts.
 *
 * The sign lives around the token, not in it, because that is where a document
 * puts it. Reading it is what lets the caller refuse `-42.00` cited to
 * "Payment 42.00".
 *
 * A hyphen is the hard case, because a document uses it as a separator far
 * more often than as a minus: "Total - 42.00", "Invoice 12-42.00" and
 * "Item 1 - 42.00" are all positive forty-two. So a leading minus counts only
 * when it is pressed against the digits -- at most one currency symbol may sit
 * between them, and no whitespace -- and only when what precedes it is not
 * alphanumeric. A trailing minus counts only immediately after the digits and
 * only when no digit follows it, which is the same rule read from the other
 * side. Parentheses and `CR` keep their whitespace tolerance: neither is ever
 * a separator.
 */
export function amountsInText(text: string): string[] {
  // A parsed receipt prints "$ 165 .00" as readily as "$165.00": the space is
  // a rendering artifact of the column the amount sat in, not a separator.
  // Closing it up before tokenizing is what lets such an amount be found.
  //
  // Only ever next to a currency symbol or an ISO code, and only around a
  // decimal point. A bare gap between two numbers is two numbers, and joining
  // them invents an amount the page does not state: "APPLES 12 .99" is a
  // quantity beside a price, "3. 12 Pack Soda 5.99" is a list position beside
  // an item, "Milk 2. 5L" is a size, and "refs 1, 234, 567" is three
  // references. Every one of those was read as a single amount by the first
  // version of this repair, which is a fabricated value with a citation --
  // the one outcome this gate exists to prevent. A comma is never closed at
  // all, because a comma between numbers is a list far more often than it is
  // a decimal point.
  //
  // The cost of the narrow rule is a column-rendered amount with no symbol
  // beside it, which becomes a correction. An extra correction is cheap; a
  // wrong stored number is not.
  const normalized = text
    .normalize("NFKC")
    .replace(
      new RegExp(`(${CURRENCY_MARK})([ \u00a0]*)(\\d+)[ \u00a0]+\\.(?=\\d)`, "g"),
      "$1$2$3.",
    )
    .replace(
      new RegExp(`(${CURRENCY_MARK})([ \u00a0]*)(\\d+\\.)[ \u00a0]+(?=\\d)`, "g"),
      "$1$2$3",
    );
  const symbols = new Set(["$", "\u20ac", "\u00a3", "\u00a5", "\u20b9", "\u20a9"]);
  const found: string[] = [];
  const runs = /\d[\d.,]*/g;
  let match: RegExpExecArray | null;
  while ((match = runs.exec(normalized)) !== null) {
    const amount = parseAmount(match[0].replace(/[.,]+$/, ""));
    if (amount === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    let signAt = start - 1;
    if (signAt >= 0 && symbols.has(normalized[signAt]!)) signAt -= 1;
    const leadingMinus =
      signAt >= 0 &&
      normalized[signAt] === "-" &&
      (signAt === 0 || !/[A-Za-z0-9]/.test(normalized[signAt - 1]!));
    const trailingMinus =
      normalized[end] === "-" && !/\d/.test(normalized[end + 1] ?? "");
    const after = normalized.slice(end, end + 4);
    const negative =
      leadingMinus ||
      trailingMinus ||
      /^\s*\)/.test(after) ||
      /^\s*CR\b/i.test(after);
    found.push(negative ? negate(amount) : amount);
  }
  return found;
}

function negate(decimal: string): string {
  if (compareDecimals(decimal, "0") === 0) return decimal;
  return decimal.startsWith("-") ? decimal.slice(1) : `-${decimal}`;
}

/**
 * Whether the quote actually prints this amount, sign and all.
 *
 * Sign agreement is part of the claim. A refund read as a charge is the same
 * class of error as a wrong digit and it is harder to notice, so `42.00` cited
 * to "Credit (42.00)" fails here rather than becoming a positive balance the
 * owner reconciles against a statement that disagrees.
 */
function amountInQuote(amount: string, quote: string): boolean {
  return amountsInText(quote).some(
    (found) => compareDecimals(found, amount) === 0,
  );
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

/** Whether one word names this month. A word counts when the month's full name
 * starts with it and it is at least three letters, so `Sep`, `Sept` and
 * `September` all name September and `Market` does not name March. */
function namesMonth(month: number, word: string): boolean {
  const name = MONTH_NAMES[month - 1]!;
  const cleaned = word.toLowerCase();
  return cleaned.length >= 3 && name.startsWith(cleaned);
}

/** Three digit runs written as one date: `09/01/2026`, `2026-11-02`, `1.2.26`.
 * At most two non-word characters between the parts, so "2 pages of 3 in 2026"
 * is not a date. */
const NUMERIC_DATE = /\d+[^\w]{1,2}\d+[^\w]{1,2}\d+/g;
/** `September 1, 2026`, `Sep 1 2026`, `Sept. 1st, 2026`. */
const MONTH_FIRST_DATE =
  /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}|\d{2})\b/g;
/** `1 September 2026`, `1st Sep. 2026`. */
const DAY_FIRST_DATE =
  /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4}|\d{2})\b/g;

/**
 * Whether the quote prints this ISO date.
 *
 * Two rules, and the second is the one that matters.
 *
 * All three parts have to be there: the year, the day of the month and the
 * month. Without the month, `2026-01-02` was supported by "Due 2026-11-02" and
 * by "Feb 2, 2026" -- a wrong date under a citation that looks right, which is
 * the one failure this gate exists to prevent.
 *
 * And they have to be there *together*, inside one run of text shaped like a
 * date. Three digit runs scattered across a line are not a date: "Page 1 of 2
 * (c) 2026" carries a 1, a 2 and a 2026 and says nothing about January the
 * second. A month written as a word counts only inside such a window too,
 * which is what keeps "may be late" and a street called March out of it.
 *
 * Within a window the parts are consumed as they are matched, so a day and a
 * month that are the same number need two runs of it. A quote that prints the
 * ISO date outright is taken as it stands.
 *
 * Deliberately strict. A date this refuses opens a correction the owner
 * resolves in a moment; a date it wrongly accepts is a stored fact nobody
 * looks at again.
 */
/**
 * Two-digit years. 00-69 is this century, 70-99 the last one.
 *
 * The POSIX rule, and the one a receipt printed `09/18/26` means. It is stated
 * rather than inferred because the alternative -- refusing every two-digit
 * year -- loses the date on most till receipts, and guessing differently per
 * document would make two identical receipts disagree.
 */
export function expandTwoDigitYear(year: number): number {
  return year <= 69 ? 2000 + year : 1900 + year;
}

function isoFrom(year: number, month: number, day: number): string | undefined {
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return realIsoDate(iso) ? iso : undefined;
}

export type DateOrder = "MDY" | "DMY";

/** What `readPrintedDate` made of the text. `ambiguous` is a numeric date
 * that could be read two ways, which is a different answer from "not a date"
 * and gets its own correction reason. */
export type PrintedDate =
  | { kind: "date"; iso: string }
  | { kind: "ambiguous" }
  | { kind: "none" };

/**
 * A printed date, read.
 *
 * The backstop for a model that copies a date as the document prints it,
 * which is what the prompt now asks it to do: a receipt says `09/18/26 14:32`
 * and re-typing that as `2026-09-18` is a conversion, which the prompt
 * forbids for good reason. So the conversion happens here, where it can be
 * checked, rather than in the model, where it cannot.
 *
 * Nothing is invented, and nothing is guessed. `01/02/26` is the first of
 * February to most of the world and the second of January to the United
 * States, and no amount of reading the string settles it -- so unless the
 * document's kind says which order it uses, this returns `ambiguous` and the
 * value becomes a correction. An earlier version of this function assumed
 * month-first silently, which stored one of the two readings under a citation
 * that supported either.
 *
 * A form that settles itself needs no knob: `13/02/2026` has no thirteenth
 * month, `9 Apr 26` names it, and an ISO date is an ISO date.
 */
export function readPrintedDate(raw: string, order?: DateOrder): PrintedDate {
  const text = raw.normalize("NFKC").trim();
  if (!text) return { kind: "none" };

  const isoLike = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(text);
  if (isoLike) {
    const iso = isoFrom(
      Number(isoLike[1]),
      Number(isoLike[2]),
      Number(isoLike[3]),
    );
    return iso ? { kind: "date", iso } : { kind: "none" };
  }

  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/.exec(text);
  if (numeric) {
    const resolved = resolveNumericParts(
      Number(numeric[1]),
      Number(numeric[2]),
      order,
    );
    if (resolved === "ambiguous") return { kind: "ambiguous" };
    if (!resolved) return { kind: "none" };
    const iso = isoFrom(namedYear(numeric[3]!), resolved.month, resolved.day);
    return iso ? { kind: "date", iso } : { kind: "none" };
  }

  const monthFirst =
    /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}|\d{2})\b/.exec(
      text,
    );
  if (monthFirst) {
    const month = monthNumber(monthFirst[1]!);
    if (month) {
      const iso = isoFrom(
        namedYear(monthFirst[3]!),
        month,
        Number(monthFirst[2]),
      );
      return iso ? { kind: "date", iso } : { kind: "none" };
    }
  }

  const dayFirst =
    /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4}|\d{2})\b/.exec(
      text,
    );
  if (dayFirst) {
    const month = monthNumber(dayFirst[2]!);
    if (month) {
      const iso = isoFrom(namedYear(dayFirst[3]!), month, Number(dayFirst[1]));
      return iso ? { kind: "date", iso } : { kind: "none" };
    }
  }
  return { kind: "none" };
}

function namedYear(digits: string): number {
  return digits.length === 2
    ? expandTwoDigitYear(Number(digits))
    : Number(digits);
}

/**
 * Which of two numbers is the month.
 *
 * One of them being impossible as a month settles it. Both being possible and
 * different is the ambiguity, and only the kind's declared order settles that.
 * Both being the same number settles itself: `03/03/26` is the third of March
 * either way.
 */
function resolveNumericParts(
  first: number,
  second: number,
  order?: DateOrder,
): { month: number; day: number } | "ambiguous" | null {
  const firstCanBeMonth = first >= 1 && first <= 12;
  const secondCanBeMonth = second >= 1 && second <= 12;
  if (!firstCanBeMonth && !secondCanBeMonth) return null;
  if (firstCanBeMonth && !secondCanBeMonth) return { month: first, day: second };
  if (!firstCanBeMonth && secondCanBeMonth) return { month: second, day: first };
  if (first === second) return { month: first, day: second };
  if (order === "MDY") return { month: first, day: second };
  if (order === "DMY") return { month: second, day: first };
  return "ambiguous";
}

/** The ISO form, or undefined. A thin wrapper over {@link readPrintedDate}
 * for callers that do not distinguish "ambiguous" from "not a date". */
export function printedDateToIso(
  raw: string,
  order?: DateOrder,
): string | undefined {
  const read = readPrintedDate(raw, order);
  return read.kind === "date" ? read.iso : undefined;
}

function monthNumber(word: string): number | undefined {
  const cleaned = word.toLowerCase();
  if (cleaned.length < 3) return undefined;
  const at = MONTH_NAMES.findIndex((name) => name.startsWith(cleaned));
  return at < 0 ? undefined : at + 1;
}

function dateInQuote(
  iso: string,
  quote: string,
  order?: DateOrder,
): boolean {
  const [year, month, day] = iso.split("-") as [string, string, string];
  const text = quote.normalize("NFKC");
  if (text.includes(iso)) return true;
  const days = [day, String(Number(day))];

  // A numeric window is read positionally, by the same rules the value is
  // read by. Matching its three runs in any order was what let a quote of
  // "Date 01/02/26" support both the first of February and the second of
  // January: whichever the model said, the citation agreed.
  for (const window of text.match(NUMERIC_DATE) ?? []) {
    const printed = readPrintedDate(window, order);
    if (printed.kind === "date" && printed.iso === iso) return true;
  }

  for (const [pattern, position] of [
    [MONTH_FIRST_DATE, "month"],
    [DAY_FIRST_DATE, "day"],
  ] as const) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const word = position === "month" ? match[1]! : match[2]!;
      const dayPart = position === "month" ? match[2]! : match[1]!;
      if (
        namesMonth(Number(month), word) &&
        days.includes(dayPart) &&
        String(namedYear(match[3]!)) === year
      ) {
        return true;
      }
    }
  }
  return false;
}

function asLineItems(value: unknown): LineItem[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    return undefined;
  }
  const items: LineItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return undefined;
    const item = entry as { description?: unknown; amount?: unknown };
    if (
      typeof item.description !== "string" ||
      !item.description.trim() ||
      item.description.length > 500 ||
      (typeof item.amount !== "string" && typeof item.amount !== "number")
    ) {
      return undefined;
    }
    items.push({ description: item.description, amount: String(item.amount) });
  }
  return items;
}

export type GateInput = {
  valueType: DocumentFieldValueType;
  value: unknown;
  quote: string;
  pageText: string;
  /** The document type's declared currency, or USD. Used only when the page
   * states none, and flagged when it is. */
  defaultCurrency: string;
  /** How this kind writes a numeric date, when it says. Unset, an ambiguous
   * one is a correction rather than a guess. */
  dateOrder?: DateOrder;
};

/**
 * The per-value-type check. The caller has already confirmed the quote is on
 * the page (that is the evidence span's job, and it happens first because a
 * statement with no span cannot be cited whatever its value parses to).
 */
export function checkValue(input: GateInput): GateResult {
  const { valueType, value, quote, pageText, defaultCurrency } = input;
  const normalizedQuote = normalizeForMatch(quote);

  if (valueType === "line_item_list") {
    const items = asLineItems(value);
    if (!items) return fail("malformed_statement");
    const values: ObservationValue[] = [];
    let total = "0";
    const pageCurrency = currencyOnPage(pageText);
    const currency = pageCurrency ?? defaultCurrency;
    for (const item of items) {
      const amount = parseAmount(item.amount);
      if (amount === undefined) return fail("money_unparsable");
      // Same rule as a single money value: the quote has to print it.
      if (!amountInQuote(amount, quote)) return fail("value_not_in_quote");
      total = addDecimals(total, amount);
      values.push({ type: "money", amount, currency });
    }
    return {
      ok: true,
      values,
      itemsTotal: total,
      ...(pageCurrency === undefined ? { currencyAssumed: true as const } : {}),
    };
  }

  if (typeof value !== "string" && typeof value !== "number") {
    return fail("malformed_statement");
  }
  const literal = String(value).trim();
  if (!literal || literal.length > 1000) return fail("malformed_statement");

  switch (valueType) {
    // The three parsed types check the quote as well as the value. A value
    // that parses is only half the claim; the other half is that the document
    // says it. Without this, `1500.00` cited to "Total $15.50" is a stored
    // fact with a citation that contradicts it -- the worst outcome this
    // feature has, because the citation is what makes the number trustworthy.
    case "money": {
      const amount = parseAmount(literal);
      if (amount === undefined) return fail("money_unparsable");
      if (!amountInQuote(amount, quote)) return fail("value_not_in_quote");
      const pageCurrency = currencyOnPage(pageText);
      return {
        ok: true,
        values: [
          { type: "money", amount, currency: pageCurrency ?? defaultCurrency },
        ],
        ...(pageCurrency === undefined
          ? { currencyAssumed: true as const }
          : {}),
      };
    }
    case "date": {
      // ISO first, then the printed forms a document actually uses. The value
      // is normalized here and checked against the cited lines afterwards, so
      // a date can only be stored when the page prints it, in the order the
      // page prints it.
      if (realIsoDate(literal)) {
        if (!dateInQuote(literal, quote, input.dateOrder)) {
          return fail("value_not_in_quote");
        }
        return { ok: true, values: [{ type: "date", value: literal }] };
      }
      const printed = readPrintedDate(literal, input.dateOrder);
      if (printed.kind === "ambiguous") return fail("date_ambiguous");
      if (printed.kind === "none") return fail("date_unparsable");
      if (!dateInQuote(printed.iso, quote, input.dateOrder)) {
        return fail("value_not_in_quote");
      }
      return { ok: true, values: [{ type: "date", value: printed.iso }] };
    }
    case "number": {
      // Through `parseAmount`, not a bare canonicalize: a percentage prints as
      // `3,5%` in half the world, and stripping its separators outright turned
      // three and a half into thirty-five.
      const canonical = parseAmount(literal.replace(/%/g, ""));
      if (canonical === undefined) return fail("number_unparsable");
      if (!amountInQuote(canonical, quote)) return fail("value_not_in_quote");
      // `unitCode: "1"` is UCUM's dimensionless unit: these are counts,
      // percentages and odometer readings, not quantities this schema converts.
      return {
        ok: true,
        values: [{ type: "decimal", value: canonical, unitCode: "1" }],
      };
    }
    default: {
      // text, organization, person, identifier: names are stored as written
      // (the entity binding gate is dropped), so the only check is that the
      // value is actually part of the quote that is supposed to support it.
      if (!normalizeForMatch(literal)) return fail("malformed_statement");
      if (!normalizedQuote.includes(normalizeForMatch(literal))) {
        return fail("value_not_in_quote");
      }
      return { ok: true, values: [{ type: "text", value: literal }] };
    }
  }
}

/** Zero tolerance, by design. A receipt whose items do not sum to its total is
 * a document worth a human glance, not a rounding problem. */
export function itemsSumToTotal(itemsTotal: string, total: string): boolean {
  return compareDecimals(itemsTotal, total) === 0;
}

/**
 * Whether a document type's field name can be an observation type.
 *
 * `OBSERVATION_TYPE_PATTERN` in `../records/model.ts` is the read side's rule
 * and it is enforced on the way out of the database as well as in. A field row
 * the admin screen writes is not checked against it by the schema, so a name
 * with a space in it would pass every gate here and then make the observation
 * it produced unreadable. Checking it with the other gates turns that into an
 * ordinary correction item instead.
 */
export function isObservationFieldName(name: string): boolean {
  return /^[a-z][a-z0-9_]{0,63}$/.test(name);
}
