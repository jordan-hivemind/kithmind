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
  type DatePrecision,
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
  /** The statement cited no lines at all, and carried no quote either. Its
   * own reason, because "the model forgot to cite" and "the quote is not on
   * the page" are different faults and the counts have to separate them. */
  "citation_missing",
  /** A correction the owner made on one line of a list no longer matches any
   * stored line: the newest run cited a different, equally valid line for it.
   * The correction stands and is not applied, because inserting it would make
   * the item appear twice and every sum double count. */
  "correction_orphaned",
  /** Some lines of a list failed while others stored. One row for the list,
   * carrying how many. */
  "line_items_partial",
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

/** One line of a `line_item_list`, as the model returns it. Each item may
 * cite its own lines: on a receipt the items are on different lines, and a
 * citation shared by the whole list cannot be right for more than one of
 * them. */
export type LineItem = {
  description: string;
  amount: string;
  lines: number[];
};

/** A model statement, after JSON parsing and before any check. */
export type RawStatement = {
  field: string;
  value: unknown;
  page: number;
  quote: string;
};

export type GateFailure = { ok: false; reason: CorrectionReason };

/** One piece of page text a value may be checked against, with the range it
 * occupies so a match can become an evidence span.
 *
 * `cutStart` and `cutEnd` say whether each end of `text` is a real line edge
 * or a cut `splitLongLine` made inside one. A cut edge is unknown to the
 * amount finder -- the character beyond it could be a magnitude letter, a
 * `CR` or half a number -- so an amount touching one is never offered. */
export type Candidate = {
  text: string;
  start: number;
  end: number;
  cutStart?: boolean;
  cutEnd?: boolean;
  /** The last token of the line before this one, and the first token of the
   * line after it. A printed sentence wraps, and the wrap is a real line
   * edge rather than a cut, so `raised $2.5` on one line and `million` on the
   * next used to offer two and a half. See `AmountScanOptions`. */
  previousToken?: string;
  nextToken?: string;
};

/**
 * How one text is scanned for amounts.
 *
 * `cutStart`/`cutEnd` mark an end of `text` that `splitLongLine` cut inside a
 * longer line; the character beyond it is unknown, so an amount touching it
 * is never offered. `percentIsNeutral` is set by the `number` value type
 * alone, and nothing else may set it.
 */
export type AmountScanOptions = {
  cutStart?: boolean;
  cutEnd?: boolean;
  percentIsNeutral?: boolean;
  /**
   * The last token of the line before this one and the first token of the
   * line after it, when those ends are real line edges rather than cuts.
   *
   * A line end is not the end of a sentence. A letter prints `raised $2.5`
   * and wraps `million` onto the next line, and the finder offered two and a
   * half for a page stating two and a half million; a prefix-credit ledger
   * prints `CR` at the end of one line and the amount at the start of the
   * next, and the finder offered a charge. The token is not read as part of
   * the amount -- assembling a number across two lines is the fabrication
   * this gate exists to prevent -- it only has to be provably unable to
   * scale or sign it, exactly as a neighbour on the same line does.
   */
  previousToken?: string;
  nextToken?: string;
};

/** One cited line, as `pageLines` produced it. Structurally a `PageLine`;
 * named here so the gate does not import the line splitter to describe its
 * own input. */
export type CitedLine = {
  id: number;
  text: string;
  start: number;
  end: number;
  cutStart?: boolean;
  cutEnd?: boolean;
  previousToken?: string;
  nextToken?: string;
};

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
  /**
   * Which candidate supports each value, aligned with `values`.
   *
   * One value is supported by one cited line, never by an assembly of
   * several: that is what keeps a citation checkable. Line items may each be
   * on a different cited line, so this is per value rather than per
   * statement, and the caller makes one evidence span per distinct line.
   */
  support: number[];
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

/**
 * The same marker, but only a code this store actually prices.
 *
 * `CURRENCY_MARK` reads any three capitals, which is right where a loose
 * reading can only make the grammar *refuse* more. It is wrong where the
 * marker licenses a rescue: `closeColumnGaps` closed the gap in `FEE 162. 95`
 * and `QTY 12. 34` on the strength of three capitals that are an English
 * word, and the rest of this file has validated a code against
 * {@link SUPPORTED_CURRENCIES} since it was written.
 */
const PRICED_MARK = `[$\u20ac\u00a3\u00a5\u20b9\u20a9]|(?<![A-Za-z])(?:${SUPPORTED_CURRENCIES.join("|")})(?![A-Za-z])`;

/**
 * Letters that may follow a price as a tax or status flag.
 *
 * Deliberately small, and deliberately a list of what IS allowed. `T` is tax,
 * `A`/`F`/`N` are the status letters supermarket receipts print, `X` marks an
 * exempt line. `E` is excluded because it is an exponent, `C` because a lone
 * `C` beside a number is a credit marker and dropping it would lose a sign,
 * and `K`, `M` and `B` because they are magnitudes, which is a different rule
 * entirely and shares nothing with this one.
 */
const PRICE_FLAGS = "TAFNXtafnx";

/**
 * What a magnitude suffix multiplies by.
 *
 * Applied, not refused. `$2.5M` unambiguously means two and a half million to
 * the people who write it, and it is how an email, a chat message or a note
 * states a fund size; refusing it would be a systematic hole in what can be
 * read from those sources. What was wrong before was dropping the suffix
 * silently, which turned two and a half million into two and a half.
 *
 * **Known ambiguity, deliberately resolved one way.** In some banking and
 * accounting conventions a bare `M` is the Roman thousand and `MM` is the
 * million. This reads `M` as a million, because the documents in question are
 * venture and personal finance, where it is. If a kind ever needs the other
 * reading it becomes a per-kind setting beside `date_order`; it is not one
 * today, and a knob nobody has asked for is a knob that will be set wrong.
 */
const MAGNITUDES: Readonly<Record<string, number>> = {
  k: 3,
  thousand: 3,
  thousands: 3,
  m: 6,
  mm: 6,
  mn: 6,
  million: 6,
  millions: 6,
  b: 9,
  bn: 9,
  billion: 9,
  billions: 9,
  // ADM-5k. Each of these spells one number and no other, so reading it is
  // strictly better than refusing it: `$2.5 trillion` used to offer two and
  // a half, and `₹2.5 lakh` and `₹2.5 crore` the same. A lakh is a
  // hundred thousand and a crore is ten million wherever they are printed,
  // and neither word has a second meaning to weigh against it.
  trillion: 12,
  trillions: 12,
  lakh: 5,
  lakhs: 5,
  crore: 7,
  crores: 7,
};

/** Longest alternative first, so `mm` is not read as `m` with an `m` left
 * over and `million` is not read as `m` followed by `illion`. */
const MAGNITUDE_WORD_LIST = [
  "millions",
  "million",
  "thousands",
  "thousand",
  "trillions",
  "trillion",
  "billions",
  "billion",
  "crores",
  "crore",
  "lakhs",
  "lakh",
  "mm",
  "mn",
  "bn",
  "k",
  "m",
  "b",
] as const;

/**
 * The characters a document prints as a minus sign, other than the hyphen
 * they all fold to here.
 *
 * Every Unicode dash, not a hand-picked three. The fourth review found that
 * U+2010, U+2011, U+2012, U+2015 and U+02D7 were not folded, so `‐1,234`
 * offered a positive 1,234 and `1099‐K`, `5‐10` and `2026‐11‐02` each offered
 * the fragments the ASCII-hyphen rules exist to prevent. The list is now the
 * whole block plus the three compatibility forms NFKC would fold anyway.
 *
 * Folding them is not the same as reading them as a sign. A minus is a sign
 * only where a sign can stand -- pressed against the digits, with nothing
 * alphanumeric before it -- so a dash between two numbers stays what it is,
 * a range, and the token carrying it is refused whole.
 */
const MINUS_SIGNS =
  /[‐‑‒–—―−˗﹘﹣－]/g;

/**
 * Superscripts and subscripts, folded to a character no amount survives.
 *
 * NFKC turns `²` into `2`, which read `$2.5m²` as two and a half million
 * (square metres) and `12.99²` as 12.992 (a footnote marker). Dropping them
 * instead would read the square metres as a magnitude, so neither reading is
 * offered: they fold to the fraction slash, which is glued to the digits and
 * parses as nothing. NFKC folds `½` to `1⁄2` for the same reason -- twelve
 * and a half is not 121 and 2.
 */
const SUPERSCRIPTS = /[²³¹⁰-₟]/g;
const FRACTION_SLASH = "⁄";

/**
 * Characters with no width, removed outright.
 *
 * A reader sees `1\u200b234.56` as 1,234.56 and `mill\u200bion` as a
 * magnitude, so that is what the grammar sees too. Treating them as token
 * boundaries instead split the first into two fragments and, worse, hid the
 * second from the magnitude rule entirely, which would have offered two and a
 * half for a line printing two and a half million.
 */
const ZERO_WIDTH = /[\u200b\u200c\u200d\u2060\ufeff]/g;

/**
 * Every digit Unicode files as "other number": `①`, `⑴`, `⒈`, `🄀`, `❶`, `➉`
 * and `½`.
 *
 * NFKC turns most of them into an ASCII digit, which is how `①250.00` read as
 * 1,250 and `⒈250` as 1.25. The ones it does not fold are no safer: the
 * dingbat circled digits U+2776 to U+2793 reached review as an unpoisoned
 * `7.❶ 45`, and a digit a reader can read but the grammar cannot is
 * exactly the character an amount must not be built from.
 *
 * A property rather than a list, because a list is what the last four reviews
 * kept finding a gap in.
 */
const ENCLOSED_DIGITS = /^\p{No}$/u;

/**
 * Whether one character is a digit the amount grammar must not read.
 *
 * `\d` is ASCII-only in JavaScript, with or without the `u` flag, so every
 * other digit form reaches the grammar either untouched (Arabic-Indic, which
 * then matches nothing) or through NFKC as an ASCII digit that was never
 * printed. Both are refused here instead: anything that is a digit to Unicode
 * or becomes one under NFKC, and is not a plain or fullwidth ASCII digit,
 * poisons its token the way a superscript already did.
 */
function exoticDigit(unit: string): boolean {
  if (unit < "\u0080") return false;
  if (/^[０-９]$/.test(unit)) return false;
  if (ENCLOSED_DIGITS.test(unit)) return true;
  if (/^\p{Nd}$/u.test(unit)) return true;
  return /\d/.test(unit.normalize("NFKC"));
}

/**
 * The one folding both the scanner and the finder read through.
 *
 * Every printed minus becomes a minus: U+2212 is what a PDF's text layer
 * carries, and an en or em dash stands in for it in exported statements.
 * Dropping the character dropped the sign, and a printed `−$5` was stored as
 * a charge. A dash *between* two numbers is a range, and the grammar refuses
 * that token whichever character it is written with.
 *
 * Digits that are not digits are poisoned **before** NFKC, because NFKC is
 * what makes them look like digits. They fold to the fraction slash, which is
 * glued to the digits and parses as nothing, so `①250.00`, `⒈250` and `12½`
 * are each refused whole rather than read as a number the page never printed.
 */
function foldAmountText(raw: string): string {
  let poisoned = "";
  for (const unit of raw) poisoned += exoticDigit(unit) ? FRACTION_SLASH : unit;
  return poisoned
    .replace(SUPERSCRIPTS, FRACTION_SLASH)
    .replace(ZERO_WIDTH, "")
    .normalize("NFKC")
    .replace(MINUS_SIGNS, "-");
}

/**
 * Scale-bearing words the grammar will not price.
 *
 * Every one of them says the number beside it is not the number printed, and
 * none of them says by how much with the certainty {@link MAGNITUDES}
 * demands. `mil` is a million and a millilitre and a thousandth of an inch;
 * `mill` is a million and a property-tax mill; `thou` is a thousand and a
 * thousandth; `bill` is a billion and an invoice; `grand` is a thousand and
 * an adjective; `tn` is a trillion and Tennessee. So the word joins the span
 * and {@link parseAmount} refuses the whole token, which is the answer the
 * owner asked for: `$2.5 mil` is two and a half million or nothing, never
 * two and a half.
 *
 * Deliberately not a single-letter list: `B`, `K` and `M` a space away from
 * digits are a room, a suite and a metre at least as often as a magnitude,
 * and {@link CLOSING_LETTERS} refuses those from the other direction.
 */
const SPACED_MAGNITUDE_WORDS = new Set([
  "mm",
  "mn",
  "bn",
  "mil",
  "mio",
  // ADM-5k: these offered the unscaled number, and none of them is an
  // ordinary English word or a name.
  "mln",
  "trn",
  "tril",
  "trill",
  "lac",
  "lacs",
  "thous",
]);

/**
 * Scale words that are also ordinary words, or names.
 *
 * `$2.5 mill` is two and a half million; `Mill Creek Partners LP` is a
 * partnership and `12 Mill Lane` is a street. `bill` is a billion and an
 * invoice, `grand` is a thousand and an adjective, `thou` is a thousand and a
 * thousandth, `tn` is a trillion and Tennessee. The first confirmation review
 * found the round refusing `Water Bill $64.12`, `Bill 120.00`,
 * `Nashville, TN $45.00`, `$1,250.00 Mill Creek Partners LP` and
 * `500.00 Grand Rapids`, which is a third of a receipt file's ordinary lines.
 *
 * So these are not in {@link SPACED_MAGNITUDE_WORDS}, which joins a word to
 * the span wherever it stands. They refuse under two conditions together,
 * both mechanical:
 *
 *   - **Directly after the amount.** A scale binds backwards, so a word in
 *     front of a number is that number's label and can say nothing about it.
 *   - **Not the start of a name.** A Capitalized word followed by another
 *     Capitalized word is a name, wherever it stands: `Mill Creek`,
 *     `Grand Rapids`, `Thousand Oaks`, `Lakh Street`. The same test refuses a
 *     Capitalized *read* magnitude, which is the other half of this rule --
 *     `45.00 Thousand Oaks` offered forty-five thousand.
 */
const NAMEABLE_SCALE_WORDS = new Set([
  "mill",
  "mills",
  "thou",
  "grand",
  "bil",
  "bill",
  "bills",
  "tn",
]);

/**
 * Words that change what the number beside them measures.
 *
 * A unit is not a scale, so none of these belongs in {@link MAGNITUDES}, and
 * refusing them is the only reading that cannot be wrong: `45 cents` is not
 * forty-five dollars and `45.00 percent` is not forty-five of anything a
 * money field stores. `bps` and `basis` are hundredths of a percent.
 *
 * `per`, `each` and `apiece` are **not** here. A rate is still the printed
 * dollars: `Rent $2,000.00 per month` prints two thousand dollars, and the
 * gate's claim is that the cited text prints the value, not that the value is
 * a total. {@link COUNTED_UNIT_WORDS} holds the nouns that do change the
 * number, and only where it is not already money.
 *
 * **Only directly after the amount**, which is the one place a unit can
 * stand. `Cost basis 1,234.56` prints a money value and `basis` is its
 * label, so the word is neutral on the left; `1,234.56 basis points` is not
 * a money value at all. Scale words are refused on both sides instead,
 * because that is the rule the grammar has had since ADM-5g and narrowing it
 * would be a weakening rather than a fix.
 *
 * Neutral for the `number` value type, which is dimensionless by
 * construction and already reads `12 %` as twelve. See `percentIsNeutral`.
 */
const UNIT_WORDS = new Set([
  "cent",
  "cents",
  "percent",
  "percents",
  "percentage",
  "pct",
  "bp",
  "bps",
  "basis",
]);

/**
 * Units that say the number is a count rather than a sum, and only where the
 * number is not already money.
 *
 * `100 shares` is a holding and storing a hundred dollars for it is wrong.
 * `Invested $50,000.00 Shares issued 5,000` is fifty thousand dollars with a
 * word after it, and the currency mark is what says so: a marked amount is
 * money whatever noun follows it. The first confirmation review found the
 * round refusing the fifty thousand.
 */
const COUNTED_UNIT_WORDS = new Set(["share", "shares", "unit", "units"]);

/** Magnitude *words*, which scale a space away from the digits. */
const MAGNITUDE_WORDS = new Set<string>(
  MAGNITUDE_WORD_LIST.filter((word) => word.length > 2),
);

const CURRENCY_SYMBOL_CHARS = new Set([
  "$",
  "\u20ac",
  "\u00a3",
  "\u00a5",
  "\u20b9",
  "\u20a9",
]);

/** The ISO codes this store supports, as a set. A currency marker is
 * validated against this, never against "three letters". */
const SUPPORTED_CURRENCY_SET = new Set<string>(SUPPORTED_CURRENCIES);

const PRICE_FLAG_SET = new Set(PRICE_FLAGS.split(""));


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
/** A currency symbol this grammar knows. */
function currencySymbolAt(text: string, at: number): number {
  return CURRENCY_SYMBOL_CHARS.has(text[at] ?? "") ? 1 : 0;
}

/** A validated ISO 4217 code, not merely three letters. `[A-Z]{3}` under an
 * `i` flag matched `qty`, `abc` and `Tax`, and each of those read as an
 * amount. */
function currencyCodeAt(text: string, at: number): number {
  const code = text.slice(at, at + 3).toUpperCase();
  if (code.length < 3 || !SUPPORTED_CURRENCY_SET.has(code)) return 0;
  return /[A-Za-z]/.test(text[at + 3] ?? "") ? 0 : 3;
}

function currencyAt(text: string, at: number): number {
  return currencySymbolAt(text, at) || currencyCodeAt(text, at);
}

/** Which currency a marker names, so the grammar can tell the ones whose
 * locale settles a separator from the ones whose locale does not. */
const CURRENCY_SYMBOL_CODES: Readonly<Record<string, string>> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
  "₩": "KRW",
};

function currencyNameAt(text: string, at: number): string | undefined {
  if (currencySymbolAt(text, at)) return CURRENCY_SYMBOL_CODES[text[at]!];
  if (currencyCodeAt(text, at)) return text.slice(at, at + 3).toUpperCase();
  return undefined;
}

/**
 * Currencies whose own locale writes the dot as a grouping separator and the
 * comma as a decimal point, so `12.345` and `12,345` beside one of them are
 * two readings a thousand apart and the text settles neither.
 *
 * Only the euro, deliberately. `$12.345`, `£12.345` and `CHF 12.345` are
 * three and a bit in every country that prints them, and the spec has relied
 * on that reading since the grammar was written; `12.345 €` is twelve
 * thousand across most of the eurozone and three and a bit in the rest, which
 * is exactly the coin flip this gate exists to refuse.
 */
const DOT_AMBIGUOUS_CURRENCIES = new Set(["EUR"]);

/** The one shape those two readings share: three digits after a single
 * separator, with nothing else in the token to say which it is. */
const AMBIGUOUS_GROUP = /^\d{1,3}[.,]\d{3}$/;

/** How many characters of a magnitude sit at this position, and how much it
 * multiplies by. */
function magnitudeAt(
  text: string,
  at: number,
): { length: number; places: number; abbreviation: boolean } | undefined {
  const rest = text.slice(at);
  for (const word of MAGNITUDE_WORD_LIST) {
    if (rest.toLowerCase().startsWith(word)) {
      const after = rest[word.length] ?? "";
      if (/[A-Za-z0-9]/.test(after)) continue;
      return {
        length: word.length,
        places: MAGNITUDES[word]!,
        abbreviation: word.length <= 2,
      };
    }
  }
  return undefined;
}

/**
 * One printed amount, read.
 *
 * Written as a scanner rather than a regex because each piece has its own
 * rule about the space before it, and a single pattern could not say so: a
 * magnitude *abbreviation* has to be pressed against the digits while a
 * magnitude *word* may be a space away, and that distinction is the whole
 * difference between `$2.5M` and `Room 12 B`.
 *
 * The governing rule, learned the hard way: **letters glued to digits are
 * never ignored.** They are a currency this grammar knows, a magnitude, or a
 * tax flag -- or the token is not an amount and is refused whole. An earlier
 * version let unknown letters fall away and read `qty3` as 3, `abc12.00` as
 * 12 and `1099-K` as -1099.
 */
export function parseAmount(raw: string): string | undefined {
  let text = foldAmountText(raw).trim();
  if (!text) return undefined;
  let negative = false;

  // Accounting parentheses, first and on their own: they wrap everything else.
  const accounting = /^\((.*)\)$/.exec(text);
  if (accounting) {
    negative = true;
    text = accounting[1]!.trim();
    // Parentheses already say negative. A sign inside them is either a second
    // negation or a contradiction, and `(-5)` is not a number any ledger
    // prints, so it is refused rather than read as one of the two.
    if (/[-+]/.test(text)) return undefined;
  }

  let at = 0;
  const space = (): void => {
    while (/[\s\u00a0]/.test(text[at] ?? "")) at += 1;
  };
  let currency = false;
  let currencyName: string | undefined;

  // One sign, on whichever side of the currency the document prints it:
  // `-$42.00` and `$-42.00` are both minus forty-two. Two of them are not a
  // second negation -- `--5` is not five and `-+5` is not anything -- so the
  // token is refused rather than read as one of the ways to resolve it.
  let signed = false;
  let twiceSigned = false;
  const sign = (): void => {
    if (text[at] !== "-" && text[at] !== "+") return;
    if (signed) {
      twiceSigned = true;
      return;
    }
    signed = true;
    if (text[at] === "-") negative = !negative;
    at += 1;
    space();
  };
  sign();
  const leading = currencyAt(text, at);
  if (leading) {
    currency = true;
    currencyName = currencyNameAt(text, at);
    at += leading;
    space();
  }
  sign();
  if (twiceSigned) return undefined;

  // The digit core. Whitespace inside it is a rendering artifact of the
  // column the amount sat in ("$ 165 .00"), never a separator: by the time a
  // value reaches here it is one value. The quote side keeps its own, much
  // stricter rule; see `amountsInText`.
  const coreStart = at;
  let core = "";
  while (at < text.length) {
    const unit = text[at]!;
    if (/[\d.,]/.test(unit)) {
      core += unit;
      at += 1;
      continue;
    }
    if (/[\s\u00a0]/.test(unit) && /[\d.,]/.test(text[at + 1] ?? "")) {
      at += 1;
      continue;
    }
    break;
  }
  if (at === coreStart || !/\d/.test(core)) return undefined;
  const digits = readDigits(core);
  if (digits === undefined) return undefined;

  let magnitude: { places: number; abbreviation: boolean } | undefined;
  let flag = false;
  let trailingMinus = false;
  while (at < text.length) {
    const spaced = /[\s\u00a0]/.test(text[at] ?? "");
    const probe = spaced ? at + 1 : at;
    if (spaced && /[\s\u00a0]/.test(text[probe] ?? "")) return undefined;

    const found = magnitudeAt(text, probe);
    if (found && magnitude === undefined) {
      // An abbreviation must be pressed against the digits. With a space
      // allowed, "Room 12 B" read as twelve billion and "2 m cable" as two
      // million -- a number the page never states, which is worse than any
      // amount this rule was meant to rescue. A word is unambiguous and may
      // be a space away.
      if (found.abbreviation && spaced) return undefined;
      magnitude = found;
      at = probe + found.length;
      continue;
    }
    const nextCurrency = currencyAt(text, probe);
    if (nextCurrency && !currency) {
      currency = true;
      currencyName = currencyNameAt(text, probe);
      at = probe + nextCurrency;
      continue;
    }
    if (!flag && PRICE_FLAG_SET.has(text[probe] ?? "")) {
      // A flag is one letter and ends the token.
      const after = text[probe + 1] ?? "";
      if (after === "" || /[\s\u00a0]/.test(after)) {
        flag = true;
        at = probe + 1;
        continue;
      }
    }
    // A trailing minus is *trailing*: it ends the token. With anything after
    // it, the character is a separator inside an identifier, and reading it
    // as a sign turned `1099-K` beside a currency marker into minus one
    // million and ninety-nine thousand.
    if (
      !spaced &&
      !trailingMinus &&
      text[at] === "-" &&
      !/[^\s\u00a0]/.test(text.slice(at + 1))
    ) {
      trailingMinus = true;
      at += 1;
      continue;
    }
    if (spaced && at + 1 >= text.length) {
      at += 1;
      continue;
    }
    return undefined;
  }
  // A sign on each end is two negations, and two negations are not a
  // positive number on a printed page -- they are a token this grammar cannot
  // read, exactly as `--5` is. `-¥39.305mm-` used to come out positive.
  if (trailingMinus && signed) return undefined;
  if (trailingMinus) negative = !negative;

  // A tax or status flag is a separate rule from a magnitude and shares
  // nothing with it. A flagged price has exactly two decimal places, which is
  // what tells `12.99T` from `12.5T` and from `2.5M`.
  if (flag && !/\.\d{2}$/.test(digits)) return undefined;

  // A magnitude abbreviation scales only beside a currency marker.
  //
  // The owner asked for "$2.5M" to be understood, and it is. He did not ask
  // for "401K" to be money, and it is not: a plan name, an SEC form, a unit
  // and a room number all look like this, and reading one as an amount puts a
  // number on a document that never stated it. Without a currency marker a
  // magnitude letter means the token is not an amount at all -- not that it
  // is the bare number, or "401K" would quietly become 401.
  if (magnitude?.abbreviation && !currency) return undefined;

  // A separator the currency's own locale reads the other way. Refused, not
  // guessed: `12.345 €` is twelve thousand to most of the people who print it
  // and three and a bit to the rest, and a coin flip stored with a citation
  // is the failure this gate exists to prevent. The check is on the digits as
  // printed, before grouping was resolved.
  if (
    currencyName !== undefined &&
    DOT_AMBIGUOUS_CURRENCIES.has(currencyName) &&
    AMBIGUOUS_GROUP.test(core)
  ) {
    return undefined;
  }

  const scaled =
    magnitude === undefined ? digits : shiftDecimal(digits, magnitude.places);

  try {
    return canonicalizeDecimal(`${negative ? "-" : ""}${scaled}`);
  } catch {
    return undefined;
  }
}

/**
 * The digits themselves, with their grouping resolved.
 *
 * The dot is the hard case, because `3.499` is a European three-thousand and
 * an English three-and-a-half at the same time and nothing in the string
 * settles it. The dot is therefore only a grouping separator when the string
 * proves it: either a decimal comma follows the groups (`1.234.567,89`), or
 * there are at least two of them (`1.234.567`). One dot group and nothing
 * else is read as a decimal point, which is what makes `$3.499`, `$0.125` and
 * `1.075` the amounts a reader would say out loud rather than 3499, 125 and
 * 1075.
 */
function readDigits(raw: string): string | undefined {
  // A tax form prints whole dollars with the point still there and no cents
  // after it: "5.", "12,345.", "-9,999.". The point is typography rather
  // than a fraction, so it is dropped and the whole number reads.
  //
  // It is only ever dropped from the *end* of the digit core, which is what
  // "nothing digit-like follows" means mechanically: the core already
  // swallows digits across any gap ("$ 165 .00" is one value), so a point
  // with a digit anywhere after it is never the last character here. `5. 25`
  // reaches this function as `5.25`, not as `5.`, and the finder then calls
  // that line ambiguous and offers neither number.
  let text = raw.replace(/(\d)\.$/, "$1");
  // `1000,000` is a thousand under a decimal comma and a million under an
  // English grouping comma, and nothing in the string settles it: four or
  // more digits before a comma are not a group, and a group of exactly three
  // after one is not a decimal. It used to read as 1000, which is the wrong
  // number by three orders of magnitude if the writer meant the other.
  if (/^\d{4,},\d{3}$/.test(text)) return undefined;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.split(",").join("");
  else if (
    /^\d{1,3}(\.\d{3}){2,}$/.test(text) ||
    /^\d{1,3}(\.\d{3})+,\d+$/.test(text)
  ) {
    text = text.split(".").join("").replace(",", ".");
  } else if (/^\d+,\d+$/.test(text)) text = text.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined;
  // A zero in front of more digits is padding, and padding is an identifier:
  // a check number, an invoice number, the `000123` in a wire reference. It
  // is never how a document prints an amount, and reading it as one put 123
  // on the page beside the total it was competing with.
  if (/^0\d/.test(text)) return undefined;
  return text;
}

/**
 * Multiplies by a power of ten by moving the point, never by multiplying.
 *
 * `numeric` is exact and every amount here is one the owner will reconcile
 * against a statement, so `2.5 * 1e6` is not an acceptable way to reach two
 * and a half million. Moving the decimal point is exact by construction.
 */
function shiftDecimal(value: string, places: number): string {
  const [whole, fraction = ""] = value.split(".") as [string, string?];
  if (places <= fraction.length) {
    const moved = whole + fraction.slice(0, places);
    const rest = fraction.slice(places);
    return rest ? `${moved}.${rest}` : moved;
  }
  return whole + fraction + "0".repeat(places - fraction.length);
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
 * Every amount the text prints, as exact decimals, with the sign it prints
 * beside them.
 *
 * A **candidate finder**, not a second grammar. It decides where one printed
 * token starts and ends, hands that whole span to `parseAmount`, and offers
 * that one value or nothing at all.
 *
 * ## ADM-5g, round five: the neighbour rule, inverted
 *
 * Four reviews each found an input this function accepted and the document
 * did not print, and every one came from the same shape: the finder listed
 * the surroundings that make a number unreadable, and the next reviewer found
 * a surrounding that was not on the list. A list of bad neighbours is a list
 * somebody has to finish, and nobody ever did.
 *
 * So the list is inverted. Once a span is found, the nearest non-gap
 * character on each side is located -- skipping **any** run of whitespace and
 * zero-width characters, not the single U+0020 the fourth review broke -- and
 * the value is offered only when **both** neighbours are provably unable to
 * change its sign or its scale:
 *
 * | Neighbour                                                    | Offered |
 * | ------------------------------------------------------------ | ------- |
 * | The start or end of the original line                         | yes     |
 * | A word of two letters or more that is not a magnitude, `CR`/`DR`, or an ISO code this store supports | yes |
 * | `;` `!` `?` `"` `“` `”` `„`                                   | yes     |
 * | `:` `/` `#` `'` with a gap before it and no digit beyond it    | yes     |
 * | A `.` `,` or digit that no reading joins to this span          | yes     |
 * | An edge left by `splitLongLine`                                | **no**  |
 * | Anything else at all                                           | **no**  |
 *
 * "Anything else" is the point, and it covers every counterexample the four
 * reviews produced: a magnitude word or letter, `CR` or `DR` on either side,
 * any parenthesis, any dash or plus, a percent sign, a currency mark or code
 * the span did not consume, an apostrophe or colon or slash pressed against
 * the digits, an enclosed digit, and a line-split edge.
 *
 * Where the scanner legitimately owns a neighbour -- a magnitude word, a
 * currency code or symbol, balanced parentheses, a `CR` one space away -- the
 * span **extends across the whole gap run**, and all of it, with its gaps
 * collapsed to single spaces, goes to `parseAmount`. That is what makes
 * `$2.5  million` two and a half million or nothing and never 2.5,
 * `(   1,234)` minus 1,234 or nothing, and `45.00  CR` minus 45 or nothing.
 *
 * Two neighbours cannot be settled by any list, because whether they belong
 * to this number is a question about the number: a digit, and a `.` or `,`
 * that leads to one. Those are settled mechanically instead -- the span and
 * the neighbouring token are pasted back together exactly as the line prints
 * them and handed to `parseAmount`. A reading means the text is ambiguous and
 * neither side is offered (`1, 234` is 1,234; `10. 80` is 10.80; `12 .99` is
 * 12.99); no reading means they are provably two tokens and both read, which
 * is what keeps a receipt column (`20.00   1.60   21.60`) readable.
 *
 * @param edges Whether each end of `text` is a real line edge or a cut made
 * by `splitLongLine`. A cut edge is *unknown*: the character beyond it could
 * be anything, so an amount touching it is never offered.
 */
export function amountsInText(
  text: string,
  options?: AmountScanOptions,
): string[] {
  return scanAmounts(text, options).found.map((one) => one.amount);
}

/** One amount the finder offered, and where it stands in the normalized
 * text. The span covers everything the amount owns -- its sign, its
 * parentheses, its currency mark or code, and a `CR`/`DR` marker -- which is
 * what lets {@link statesOnlyOneAmount} ask what is left of the line. */
type FoundAmount = { start: number; end: number; amount: string };

/** The finder proper. {@link amountsInText} is this with the positions
 * dropped, which is all every existing caller wants. */
function scanAmounts(
  text: string,
  options?: AmountScanOptions,
): { normalized: string; found: FoundAmount[] } {
  const normalized = closeColumnGaps(foldAmountText(text));
  const ordinal = listOrdinalStart(normalized, options);
  const found: FoundAmount[] = [];
  let at = 0;
  while (at < normalized.length) {
    if (!/\d/.test(normalized[at]!)) {
      at += 1;
      continue;
    }
    const span = amountSpanAt(normalized, at);
    // A list ordinal counts nothing and is worth nothing. See
    // {@link listOrdinalStart}.
    if (span.start === ordinal) {
      at = Math.max(span.end, at + 1);
      continue;
    }
    if (!span.ambiguous && neighboursAreNeutral(normalized, span, options)) {
      const amount = parseAmount(
        collapseGaps(normalized.slice(span.start, span.parseEnd)),
      );
      if (amount !== undefined) {
        // `CR` says the amount is a credit, not that its sign flips: a line
        // printing "(1,234.56) CR" says the same thing twice, and negating
        // twice made it a charge.
        found.push({
          start: span.start,
          end: span.end,
          amount: span.credit ? negative(amount) : amount,
        });
      }
    }
    // Past the whole span, parsed or not. Re-entering a span that failed is
    // exactly how a fragment gets offered.
    at = Math.max(span.end, at + 1);
  }
  return { normalized, found };
}

/**
 * What a line may print beside its one amount and still print nothing else.
 *
 * Whitespace, dot leaders, cell rules and sentence punctuation. No letter and
 * no digit: a word beside a number is a label, and a label is what tells a
 * reader which field the number belongs to. That is the whole point of
 * {@link statesOnlyOneAmount} -- a line with a label on it belongs to its own
 * label, and a citation may not be moved onto it.
 */
const VALUE_ONLY_RESIDUE =
  /^[\s\u200b\u200c\u200d\u2060\ufeff.,;:!?*_=~+\-\u2013\u2014()[\]{}|\u00a6\u2502\u2503\u2551"\u201c\u201d\u201e'\u2019\u00b7\u2022\u2026\\/]*$/u;

/**
 * Whether the line prints one amount and nothing else a reader could read.
 *
 * The line is scanned exactly as the finder scans it, the one span it offered
 * is removed whole -- sign, parentheses, currency mark or code, `CR`/`DR` --
 * and what is left has to be whitespace and neutral punctuation. A `%` beside
 * the amount goes with it for the `number` value type, which is the one type
 * for which a percent sign cannot change what the number is.
 *
 * This exists for the citation repair in `extraction/model.ts` and for
 * nothing else. A repair moves a field's citation onto a neighbouring line,
 * and the question it has to answer is "does this line belong to the field
 * that cited it, or to a label of its own". `Tax 1.60` next to `Subtotal`
 * answers it: the line names its own field, and a subtotal read off it is a
 * tax stored as a subtotal.
 */
export function statesOnlyOneAmount(
  text: string,
  options?: AmountScanOptions,
): boolean {
  const { normalized, found } = scanAmounts(text, options);
  if (found.length !== 1) return false;
  const one = found[0]!;
  let tail = normalized.slice(one.end);
  if (options?.percentIsNeutral) {
    // One percent sign, and only the one pressed against the amount. A
    // `number` is dimensionless, so `12 %` is the same twelve as `12`; every
    // other value type refuses the line instead.
    const mark = afterGap(tail, 0);
    if (tail[mark] === "%") tail = tail.slice(0, mark) + tail.slice(mark + 1);
  }
  return VALUE_ONLY_RESIDUE.test(normalized.slice(0, one.start) + tail);
}

/** A numbered list's ordinal: digits at the very start of a line, then `.`
 * or `)`, then a space and a word. `1. Rent 500.00` and `3) Repairs 42.00`
 * both print it, and every form with numbered boxes prints dozens. */
const LIST_ORDINAL = /^([ \t\u00a0]*)(\d{1,3})[.)][ \u00a0]+\p{L}/u;

/**
 * Where a line's leading list ordinal begins, or -1.
 *
 * An ordinal is a position in a list, never a quantity and never an amount,
 * so the finder offers it nothing. It reached review as `1. Rent 500.00`
 * offering both 1 and 500: the 1 is a bullet, and a bullet that can be
 * stored as a money field is a number on a page that nobody wrote as one.
 *
 * Only at the start of a real line. A piece cut out of a longer line has no
 * start to speak of -- whatever stood to its left is gone -- and the amount
 * finder refuses everything touching that edge anyway.
 */
function listOrdinalStart(
  text: string,
  options?: AmountScanOptions,
): number {
  if (options?.cutStart) return -1;
  const match = LIST_ORDINAL.exec(text);
  return match ? match[1]!.length : -1;
}

/** What may stand after the cents for a one-space gap at the point to be a
 * rendering artifact: nothing, a gap, or a mark that cannot be part of a
 * number or change one. A digit, a letter, a point or a sign each say the run
 * is something other than cents. */
const AFTER_CENTS =
  "(?:$|[,;!?*\"\\u201d)\\]}|\\u00a6\\u2502\\u2503\\u2551]|[\\s\\u200b\\u200c\\u200d\\u2060\\ufeff](?![\\s\\u200b\\u200c\\u200d\\u2060\\ufeff]*[\\p{Ll}\\d]))";

/**
 * A parsed receipt prints "$ 165 .00" as readily as "$165.00": the space is a
 * rendering artifact of the column the amount sat in, not a separator. Closed
 * up only next to a currency mark, because a bare gap between two numbers is
 * two numbers -- "APPLES 12 .99" is a quantity beside a price.
 *
 * **One space, and exactly two digits after the point.** Both halves were
 * forced by review. The width goes by the rule every other gap in this file
 * is read by: a gap inside one printed number is one space wide, and a wider
 * one is a column boundary. ADM-5h, which made a trailing point a whole
 * dollar, is what forced the point: `\u00a35.<nbsp><nbsp>61` was closed up into 5.61, and
 * `\u20ac546.<six spaces>82138K` into minus five hundred and forty-six
 * thousand -- each of them a number the page does not print. The digit
 * count, because cents are two digits and nothing else is: `$82. 129961.-`
 * is not minus 82.129961 and `$94. 504. billion` is not ninety-four and a
 * half billion. Every one of those now reads as the ambiguous pair it is,
 * and the finder offers neither side.
 *
 * **And the two digits have to end there.** A gap, the end of the line, or a
 * mark that cannot belong to a number. Anything else and the run is not
 * cents: a letter makes it a box label or a magnitude (`$6. 25a` read as
 * 6.25, `$5. 25b` as five and a quarter billion), a second point makes it the
 * first half of something longer, and a sign makes it a ledger's own
 * (`€642. 73.-` read as a credit of 642.73). None of those numbers is on
 * the page, and each of them now reads as the ambiguous pair it is.
 */
const GAP_BEFORE_POINT = new RegExp(
  `(${PRICED_MARK})([ \\u00a0]*)(\\d+)[ \\u00a0]\\.(?=\\d\\d(?!\\d))`,
  "gu",
);

const GAP_AFTER_POINT = new RegExp(
  `(${PRICED_MARK})([ \\u00a0]*)(\\d+\\.)[ \\u00a0](?=\\d\\d${AFTER_CENTS})`,
  "gu",
);

function closeColumnGaps(text: string): string {
  return text
    .replace(GAP_BEFORE_POINT, "$1$2$3.")
    .replace(GAP_AFTER_POINT, "$1$2$3");
}

/**
 * What separates two printed tokens and means nothing on its own.
 *
 * `\s` already covers the no-break space, the en and em spaces, the narrow
 * no-break space, the ideographic space, the line and paragraph separators
 * and U+FEFF. The zero-width space, the word joiner and the zero-width
 * joiners it does not, and a PDF's text layer emits all of them. The fourth
 * review's first and largest finding was that only a single U+0020 counted
 * here, so `$2.5  million` dropped its suffix and stored 2.5.
 */
const GAP = /[\s​‌‍⁠﻿]/;
const GAP_RUN = /[\s​‌‍⁠﻿]+/g;

/** Every gap run inside one span as a single space, which is the one shape
 * `parseAmount` reads. A span may legitimately carry a gap -- `$1 000 000`,
 * `( 1,234 )`, `$2.5 million` -- and the scanner's rule for each of them is
 * written for one space. */
function collapseGaps(text: string): string {
  return text.replace(GAP_RUN, " ");
}

/** The run of digits and separators that ends at `end`: what a span has read
 * so far, without the currency marker or sign in front of it. */
function headOfDigits(text: string, end: number): string {
  let from = end;
  while (from > 0 && /[\d.,]/.test(text[from - 1]!)) from -= 1;
  return text.slice(from, end);
}

/** The nearest non-gap character strictly before `at`, or -1 for the start of
 * the text. */
function beforeGap(text: string, at: number): number {
  let probe = at - 1;
  while (probe >= 0 && GAP.test(text[probe]!)) probe -= 1;
  return probe;
}

/** The nearest non-gap character at or after `at`, or `text.length` for the
 * end of the text. */
function afterGap(text: string, at: number): number {
  let probe = at;
  while (probe < text.length && GAP.test(text[probe]!)) probe += 1;
  return probe;
}

/** One candidate token: what the scanner is asked to read, how far the span
 * reaches for the neighbour rule, and the one sign that sits outside it.
 * `ambiguous` means the finder could not tell where the token ends, and
 * nothing at all is offered for the region. */
type AmountSpan = {
  start: number;
  /** The end of the text handed to `parseAmount`. */
  parseEnd: number;
  /** The end of everything the span owns, including a `CR` or `DR`, which is
   * a sign rather than part of the number. The neighbour rule looks past
   * this, and the finder resumes past it. */
  end: number;
  credit: boolean;
  ambiguous: boolean;
  /** Whether the span carries a currency marker of its own. A marked amount
   * is money whatever noun follows it; see {@link COUNTED_UNIT_WORDS}. */
  currency: boolean;
  /** How many places the span's own magnitude moves the point, or undefined
   * for a span that carries none. Two scaled spans a single space apart are
   * one compound amount -- `$3 million 2 thousand` -- and the finder offered
   * the first of them whole. */
  scale?: number;
};

/**
 * The magnitude a finished span carries, or undefined.
 *
 * Read back off the text the span covers rather than recorded as it is built,
 * because a magnitude reaches the span three different ways: glued to the
 * digits, a gap away as a word, and swallowed with the letters that make
 * `401K` one token. The one question afterwards is the same for all three.
 */
const SCALE_TAIL = new RegExp(
  `[\\d ](${MAGNITUDE_WORD_LIST.join("|")})\\s*$`,
  "i",
);

function scaleOf(body: string): number | undefined {
  const found = SCALE_TAIL.exec(body);
  return found ? MAGNITUDES[found[1]!.toLowerCase()] : undefined;
}

/** Glued to the digits and part of the token: a currency, the letters that
 * make `qty3` an identifier, the fraction slash a folded `½`, `²` or `①`
 * leaves behind, and -- on the left -- the separator that makes `.99` a
 * fragment of a number rather than ninety-nine, and the `#` that makes
 * `#1234` an order number. */
const GLUED_CHARS = /[A-Za-z$€£¥₹₩⁄]/;
const GLUED_LEFT_CHARS = /[A-Za-z$€£¥₹₩⁄.,#]/;

/**
 * Single letters that end an amount rather than sitting beside one.
 *
 * `k`, `m` and `b` are magnitudes, `c` and `d` are credit and debit. A
 * document that prints `$2.5 M`, `Room 12 B` or `45.00 C` may mean two and a
 * half million, twelve, or minus forty-five, and the finder cannot tell
 * which, so the letter goes into the span and the scanner refuses it whole.
 */
const CLOSING_LETTERS = new Set(["k", "m", "b", "c", "d"]);

/**
 * The span around one digit: everything a printed amount could carry, and
 * nothing the line merely puts near it.
 */
function amountSpanAt(text: string, digit: number): AmountSpan {
  let start = digit;
  for (;;) {
    const before = text[start - 1] ?? "";
    if (start > 0 && GLUED_LEFT_CHARS.test(before)) {
      start -= 1;
      continue;
    }
    // A hyphen with a letter before it is an identifier, not a sign:
    // `INV-0012` is one token and not twelve. (A hyphen with a *digit*
    // before it is reached from the other side, where the span starts at
    // those digits and swallows the hyphen going right.)
    if (start > 0 && before === "-" && /[A-Za-z]/.test(text[start - 2] ?? "")) {
      start -= 1;
      continue;
    }
    break;
  }
  start = withSpacedCurrency(text, start);
  // The sign, and only where a sign can stand: pressed against what follows
  // it, with nothing alphanumeric before it. More than one is not a second
  // negation, so the whole run goes into the span and the scanner refuses it:
  // `--5` is not five. A sign a *gap* away is not a sign here; the neighbour
  // rule refuses the token rather than reading it unsigned.
  let signs = start;
  while (signs > 0 && (text[signs - 1] === "-" || text[signs - 1] === "+")) {
    signs -= 1;
  }
  if (signs < start && !/[A-Za-z0-9]/.test(text[signs - 1] ?? "")) {
    start = signs;
    while (start > 0 && GLUED_CHARS.test(text[start - 1]!)) start -= 1;
    start = withSpacedCurrency(text, start);
  }

  // Accounting parentheses may be printed any gap away from the digits. The
  // opening one joins the span only when its closing one is found, so an
  // unbalanced `(250.00` is not minus 250; the neighbour rule then refuses it
  // on the `(` it left behind. A `(` pressed against the token before it is
  // not accounting either -- `45.00(1)` and `401(k)` are a footnote and a
  // plan, and both used to offer a number.
  const opener = beforeGap(text, start);
  let open =
    opener >= 0 &&
    text[opener] === "(" &&
    !/[\p{L}\d]/u.test(text[opener - 1] ?? "");

  let end = digit;
  let credit = false;
  let ambiguous = false;
  /** How many characters at the end of the span are a `CR`/`DR` marker and
   * its gap, which the scanner must not see. */
  let markerChars = 0;

  // Whether the span carries a currency marker, scanned once. The fourth
  // review timed a 100k-character line at 63 seconds because this was
  // `carriesCurrency(text.slice(start, end))` inside the loop. `end` only
  // grows, so the answer is a prefix scan that never re-reads a character.
  /** A trailing currency marker ends the token: nothing after it belongs to
   * this number. Without this the span swallowed the *next* amount whole --
   * `#1234 $9.99` and `09/01/2026 $42.00` became one unreadable token, and
   * the line's only real amount was never offered. */
  let closed = false;
  let currencySeen = false;
  let currencyCheckedTo = start;
  const spanCarriesCurrency = (): boolean => {
    while (currencyCheckedTo < end) {
      const probe = currencyCheckedTo;
      if (CURRENCY_SYMBOL_CHARS.has(text[probe]!)) currencySeen = true;
      else if (
        !/[A-Za-z]/.test(text[probe - 1] ?? "") &&
        currencyCodeAt(text, probe) > 0
      ) {
        currencySeen = true;
      }
      currencyCheckedTo = probe + 1;
    }
    return currencySeen;
  };

  scan: for (;;) {
    // The token itself: digits, the separators between them, letters, a
    // glued hyphen -- and then digits again, because `$1M1` ends in one and
    // `1099-K`, `5-10` and `20260918-000123` are one token each.
    for (; !closed; ) {
      const from = end;
      while (end < text.length && /[\d.,]/.test(text[end]!)) end += 1;
      while (end < text.length && GLUED_CHARS.test(text[end]!)) end += 1;
      if (end < text.length && text[end] === "-") end += 1;
      // A slash between two digit runs is a date or a fraction, never an
      // amount: `09/01/2026` used to offer 9, 1 and 2026 beside the total.
      // A slash before a word is the `/mo` on a subscription line, and the
      // amount before it still reads.
      if (text[end] === "/" && /\d/.test(text[end + 1] ?? "")) end += 1;
      if (end === from) break;
    }
    // Accounting parentheses wrap the whole token, so they go to the scanner
    // with it. A digit after the closing one says they were never accounting
    // parentheses: `(206) 555-0134` is a phone number, and reading its area
    // code as a negative amount is how it competed with a total.
    if (open) {
      const closing = afterGap(text, end);
      if (closing < text.length && text[closing] === ")") {
        open = false;
        start = opener;
        end = closing + 1;
        const glued = afterGap(text, end);
        if (glued < text.length && /\d/.test(text[glued]!)) {
          end = glued;
          continue scan;
        }
      }
    }
    const afterToken = afterGap(text, end);
    if (afterToken > end && !closed) {
      // A fraction after the digits makes them a whole part, not a number:
      // "101 1/2" is a bond price, and a hundred and one is the wrong one.
      const fraction = /^\d+\/\d+/.exec(text.slice(afterToken));
      if (fraction) {
        ambiguous = true;
        end = afterToken + fraction[0].length;
        continue scan;
      }
      // Gaps before groups of exactly three digits are either the grouping of
      // one number or the spaces between several. Three things together
      // settle it, and nothing less does: a currency marker, **two** such
      // groups, and a single U+0020 before each of them.
      //
      // Each of the three closes a hole. One group is `$5 250 shares`, which
      // read as 5,250 on a page that said five dollars and 250 shares. No
      // currency is `APPLES 12 990`. And a *wide* gap is a column: `$123
      // 456   789` is three receipt cells, while `$1 000 000` is one amount,
      // and a grouping separator is never two spaces wide. Everything this
      // does not settle is refused for the whole region -- `$1  000 000`
      // offers a million or nothing, never the 1 the fourth review found.
      //
      // And the head has to be a bare run of digits. A decimal head may never
      // take space groups: `$12.99 100 200` is a price and two cells, and the
      // span swallowed all three and offered 12.991002 -- a number with the
      // cents of one cell and the digits of the others. Only the last
      // character was checked, so a separator further back went unseen. A
      // head that does carry one falls through to the neighbour rule, which
      // pastes the two together, reads 12.991 and refuses both.
      if (
        !/[.,]/.test(headOfDigits(text, end)) &&
        /^\d{3}(?!\d)/.test(text.slice(afterToken))
      ) {
        let probe = end;
        let groups = 0;
        let singleSpaced = true;
        for (;;) {
          const next = afterGap(text, probe);
          if (next === probe || !/^\d{3}(?!\d)/.test(text.slice(next))) break;
          if (next !== probe + 1 || text[probe] !== " ") singleSpaced = false;
          groups += 1;
          probe = next + 3;
        }
        if (groups < 2 || !singleSpaced || !spanCarriesCurrency()) {
          ambiguous = true;
        }
        end = probe;
        continue scan;
      }
      // A currency symbol printed after the amount, any gap away. Only a
      // currency *code* could be reached here before, so `(5,79 €)` lost its
      // parenthesis and stored a charge where the page printed a credit.
      //
      // A trailing marker is trailing: nothing may be pressed against its
      // right. Without that, `1099-K $2.5m²` took the *next* token's dollar
      // sign, which turned a form name into a currency and offered minus one
      // million and ninety-nine thousand.
      if (currencySymbolAt(text, afterToken) && ownsTrailingMarker(text, end, afterToken, 1)) {
        end = afterToken + 1;
        closed = true;
        continue scan;
      }
    }
    if (afterToken > end) {
      const worded = /^\p{L}+/u.exec(text.slice(afterToken));
      if (worded) {
        const word = worded[0].toLowerCase();
        const glued = /\d/.test(text[afterToken + worded[0].length] ?? "");
        if (!glued && (word === "cr" || word === "dr")) {
          // `CR` is a credit marker on the amount beside it, not a column
          // somewhere to its right: "Item 12.00      CR 45.00" needs the wide
          // gap to belong to the 45.00. One space is the rule, exactly as
          // ADM-5f set it, and a marker further away now makes the finder
          // refuse this amount rather than read it as a charge.
          //
          // The marker stays *outside* the text handed to the scanner: it is
          // a sign, not part of the number.
          if (afterToken === end + 1 && text[end] === " ") {
            credit = word === "cr";
            markerChars = worded[0].length + 1;
            end = afterToken + worded[0].length;
          }
          break;
        }
        const currencyCode =
          SUPPORTED_CURRENCY_SET.has(word.toUpperCase()) &&
          ownsTrailingMarker(text, end, afterToken, worded[0].length);
        // A Capitalized scale word followed by another Capitalized word is a
        // name, not a magnitude: `45.00 Thousand Oaks` offered forty-five
        // thousand and `45.00 Lakh Street` four and a half million. The word
        // stays outside the span, and the neighbour rule then refuses the
        // amount on it -- a line that may print a place and may print a scale
        // prints neither number for certain.
        const namesSomething = opensAName(
          text,
          afterToken,
          afterToken + worded[0].length,
        );
        if (
          !closed &&
          !namesSomething &&
          (glued ||
            (word.length === 1 && CLOSING_LETTERS.has(word)) ||
            (worded[0].length === 1 && PRICE_FLAG_SET.has(worded[0])) ||
            SPACED_MAGNITUDE_WORDS.has(word) ||
            MAGNITUDE_WORDS.has(word) ||
            currencyCode)
        ) {
          // Each of these belongs to the token, and the scanner decides what
          // it makes of it: a magnitude word scales, a currency code names
          // the money, and a magnitude abbreviation a gap away refuses the
          // token whole -- which is the point. `$2.5 M` used to offer two and
          // a half.
          end = afterToken + worded[0].length;
          continue scan;
        }
      }
    }
    break;
  }
  // A trailing separator belongs to the prose, not to the number: "refs 1,
  // 234" is three references and the comma is punctuation.
  let parseEnd = end - markerChars;
  while (parseEnd > digit && /[.,\s]/.test(text[parseEnd - 1]!)) parseEnd -= 1;
  if (markerChars === 0) end = parseEnd;
  currencyCheckedTo = start;
  currencySeen = false;
  const carriesCurrency = ((): boolean => {
    const saved = end;
    end = parseEnd;
    const answer = spanCarriesCurrency();
    end = saved;
    return answer;
  })();
  return {
    start,
    parseEnd,
    end,
    credit,
    ambiguous,
    currency: carriesCurrency,
    scale: scaleOf(collapseGaps(text.slice(start, parseEnd))),
  };
}

/**
 * Whether both ends of a span are provably unable to change its sign or its
 * scale. The table in {@link amountsInText} is the specification; this is it
 * in code.
 */
function neighboursAreNeutral(
  text: string,
  span: AmountSpan,
  options?: AmountScanOptions,
): boolean {
  const left = beforeGap(text, span.start);
  if (left < 0) {
    if (!edgeIsNeutral(-1, options)) return false;
  } else if (!neutralNeighbour(text, span, left, -1, options)) {
    return false;
  }
  const right = afterGap(text, span.end);
  if (right >= text.length) {
    if (!edgeIsNeutral(1, options)) return false;
  } else if (!neutralNeighbour(text, span, right, 1, options)) {
    return false;
  }
  return true;
}

/**
 * What stands past one end of this text.
 *
 * A cut is unknown and refuses outright. A real line edge is a line edge, and
 * a printed sentence wraps across one: the wrap token is asked the same
 * question a neighbour on the same line is asked. Nothing beyond the end at
 * all is the end of the page, which can change no number.
 */
function edgeIsNeutral(
  direction: -1 | 1,
  options?: AmountScanOptions,
): boolean {
  if (direction === -1 ? options?.cutStart : options?.cutEnd) return false;
  const token =
    direction === -1 ? options?.previousToken : options?.nextToken;
  return neutralAcrossTheWrap(token, direction);
}

/** What a token may open or close with and still be unable to sign or scale
 * the amount on the line beside it. A sign, a bracket, a percent sign and a
 * currency symbol each can. */
const WRAP_SIGNS = new Set([
  "-",
  "+",
  "(",
  ")",
  "%",
  ...CURRENCY_SYMBOL_CHARS,
]);

/**
 * Whether the token on the other side of a real line break leaves this
 * amount alone.
 *
 * Only scale and sign are asked about, and deliberately nothing else. A
 * column receipt prints its amounts one per line, so a digit on the next
 * line is the ordinary case and refusing it would cost every receipt in the
 * store; a word is a label for the same reason. What a line break may not
 * hide is a magnitude, a `CR`, a sign or a bracket -- the wrap of one
 * printed token, which is the only way the next line can change this
 * number.
 *
 * An absent token is a line with nothing after it, and that is the end of
 * the page rather than an unknown.
 */
function neutralAcrossTheWrap(
  token: string | undefined,
  direction: -1 | 1,
): boolean {
  if (!token) return true;
  const lead = foldAmountText(token).replace(INVISIBLE_CHARS, "").trim();
  if (lead === "") return true;
  // **An amount the neighbouring line prints for itself is a value, not a
  // marker on this one.** A column receipt prints `$20.00`, `$1.60`, `$21.60`
  // one to a line, an accounting statement prints `($ 9,696,944)` over
  // `197,577.62`, and a ledger prints `45.00 CR` over the next row -- and
  // refusing every line whose neighbour faces it with a currency mark, a
  // parenthesis, a minus or a `CR` cost an eighth of the correct offers on
  // amount columns.
  //
  // The question is asked of the *edge*: the neighbouring line's own reading
  // has to reach the break. An amount in the middle of that line settles
  // nothing, which is what keeps `raised $2.5` over `million from` refusing.
  // The scan is run without wrap tokens of its own, so it cannot recur.
  if (edgeStatesAnAmount(lead, direction)) return true;
  // Punctuation in front of the word is skipped, not stopped at, exactly as
  // it is within a line: a next line beginning `*CR`, `[CR]`, `.million` or
  // `, million` hid the marker behind the mark and offered the unsigned or
  // unscaled value. A sign is not punctuation and stops the walk.
  const walked = skipWrapPunctuation(lead, direction);
  if (walked === "") return true;
  const facing = direction === 1 ? walked[0]! : walked[walked.length - 1]!;
  if (WRAP_SIGNS.has(facing)) return false;
  const word =
    direction === 1 ? /^\p{L}+/u.exec(walked) : /\p{L}+$/u.exec(walked);
  if (!word) return true;
  // A letter run glued to digits is an identifier, a form name or half a
  // wrapped amount, and none of them is a word this rule can clear.
  const glued =
    direction === 1
      ? walked.slice(word[0].length, word[0].length + 1)
      : walked.slice(
          walked.length - word[0].length - 1,
          walked.length - word[0].length,
        );
  if (/\d/.test(glued)) return false;
  // A single letter is refused on the same line because the finder cannot
  // tell `$2.5 M` from `Room 12 B`. Across a line break a form labels its
  // rows with exactly these letters -- a K-1 prints `K Net rental real estate
  // income` and `M Section 179 deduction`, a W-2 prints code `D` -- so a
  // closing letter is refused only where it is not a row label: standing
  // alone, at the end of its line, or followed by punctuation or a digit.
  // Followed by a space and a word it is a label and the line above it reads.
  if (word[0].length === 1 && direction === 1) {
    if (!CLOSING_LETTERS.has(word[0].toLowerCase())) return true;
    return labelsARow(walked);
  }
  if (word[0].length === 1) return !CLOSING_LETTERS.has(word[0].toLowerCase());
  return neutralWord(word[0], direction);
}

/** Zero-width characters and the soft hyphen, which a reader does not see.
 * `pageLines` strips them from the wrap tokens; this is the same strip on the
 * gate's own side, for a caller that built its options by hand. */
const INVISIBLE_CHARS = /[\u200b\u200c\u200d\u2060\ufeff\u00ad]/g;

/** Whether the neighbouring line's own reading runs right up to the break:
 * an amount it opens with, going forward, or one it ends with, going back. */
function edgeStatesAnAmount(lead: string, direction: -1 | 1): boolean {
  const { normalized, found } = scanAmounts(lead);
  return found.some((one) =>
    direction === 1
      ? beforeGap(normalized, one.start) < 0
      : afterGap(normalized, one.end) >= normalized.length,
  );
}

/** The lead with the punctuation in front of its first word taken off. A sign
 * is not punctuation: the walk stops on one and the caller refuses. */
function skipWrapPunctuation(lead: string, direction: -1 | 1): string {
  const harmless = (unit: string): boolean =>
    !/[\p{L}\d]/u.test(unit) && !WRAP_SIGNS.has(unit) && !/\s/.test(unit);
  if (direction === 1) {
    let at = 0;
    while (at < lead.length && (harmless(lead[at]!) || /\s/.test(lead[at]!))) {
      at += 1;
    }
    return lead.slice(at);
  }
  let to = lead.length;
  while (to > 0 && (harmless(lead[to - 1]!) || /\s/.test(lead[to - 1]!))) {
    to -= 1;
  }
  return lead.slice(0, to);
}

/** Whether a lead beginning with one letter is a form's row label: the letter,
 * then a gap, then a word. `K Net rental` is a K-1 row and `K` alone is a
 * magnitude the line above may have wrapped. */
function labelsARow(walked: string): boolean {
  return /^\p{L}[ \u00a0]+\p{L}/u.test(walked);
}

/**
 * Sentence punctuation and cell rules, which no document uses to sign or
 * scale a number.
 *
 * The vertical bars are here because a pipe-rendered table is how several of
 * this repository's parsed receipts print a column: `Total | 21.60`. A bar
 * cannot be a sign, a magnitude, or a separator inside a number, so it is as
 * neutral as a full stop and it carries real recall.
 */
const NEUTRAL_PUNCTUATION = new Set([
  ";",
  "!",
  "?",
  '"',
  "\u201c",
  "\u201d",
  "\u201e",
  "|",
  "\u00a6",
  "\u2502",
  "\u2503",
  "\u2551",
]);

/** Joiners that mean something only when they touch digits: `12:30` is a
 * time, `CHF 1'234.56` is a grouped amount, `401(k)` is a plan. Neutral only
 * with a gap between them and the span, and no digit beyond them --
 * `Total: 42.00` is a label, and forty-two still reads. */
const CONDITIONAL_JOINERS = new Set([":", "/", "#", "'", "’"]);

function neutralNeighbour(
  text: string,
  span: AmountSpan,
  start: number,
  direction: -1 | 1,
  options?: AmountScanOptions,
): boolean {
  /** Whether the end of the text on one side leaves this amount alone. A cut
   * edge hides the rest of whatever touches it -- `...$3.0 mill` is a cut
   * `$3.0 million`, and `...55,390.` is a cut `55,390.38` -- and a real line
   * edge may be a wrap, so every scan that reaches an end asks, not only the
   * ones where the span itself touched it. */
  const edge = (side: -1 | 1): boolean => edgeIsNeutral(side, options);
  const cutOn = (side: -1 | 1): boolean =>
    Boolean(side === -1 ? options?.cutStart : options?.cutEnd);
  let at = start;
  /** Whether a cell boundary has been crossed to get here. */
  let stepped = false;
  // Sentence punctuation is stepped over rather than stopped at; the loop is
  // bounded so a line of nothing but full stops cannot walk the whole page.
  for (let hops = 0; hops < 64; hops += 1) {
    const unit = text[at]!;
    // A percent sign scales what it follows, so it is never neutral beside an
    // amount: "Rate 12.99% on $1,000.00" prints no twelve-dollar charge. The
    // `number` value type is the one caller for which it is neutral, because a
    // `number` is dimensionless by construction -- a rate, a count, an odometer
    // -- and can never become money. See `checkValue`.
    if (unit === "%" && options?.percentIsNeutral) return true;
    // An alphanumeric run is one token. One carrying a digit is settled by
    // pasting it back onto the span; one that does not is a word.
    if (/[\p{L}\d]/u.test(unit)) {
      const token = alphanumericRun(text, at);
      // A token that runs into a cut is only the part of itself that survived.
      if (token.from <= 0 && cutOn(-1)) return false;
      if (token.to >= text.length && cutOn(1)) return false;
      // A token the folding poisoned is a token this grammar cannot read, and
      // an unreadable neighbour is not a *separate* one: `380 3१ 24.5`
      // (with a Devanagari digit inside the second run) offered 380, because
      // the run beside it had been cut in half by the poison mark and the two
      // halves would not paste back into one amount. Unknown is refused, the
      // same answer a cut edge gets.
      if (poisonedAround(text, token)) return false;
      if (/\d/.test(text.slice(token.from, token.to))) {
        return !joinsIntoOneAmount(text, span, token);
      }
      void stepped;
      const word = text.slice(token.from, token.to);
      // A currency code that provably introduces the *next* number belongs to
      // that number and settles nothing about this one: `Column CAD 12 USD 15`
      // prints twelve Canadian dollars whichever amount the `USD` leads, and
      // the finder used to refuse the line outright. This is the question
      // `ownsTrailingMarker` asks, asked from the neighbour rule's side --
      // and it is only ever asked about a marker the span did not take, so a
      // marker that *could* be this amount's has already gone into the span.
      if (
        direction === 1 &&
        SUPPORTED_CURRENCY_SET.has(word.toUpperCase()) &&
        /^\d/.test(text.slice(afterGap(text, token.to)))
      ) {
        return true;
      }
      return neutralWord(
        word,
        direction,
        options,
        span,
        opensAName(text, token.from, token.to),
      );
    }
    if (unit === "." || unit === ",") {
      // A separator is part of a *number* only when a digit is reachable
      // through it.
      const digits = digitThrough(text, at, direction);
      if (digits === "edge") return edge(direction);
      if (digits !== undefined) {
        if (digits.from <= 0 && cutOn(-1)) return false;
        if (digits.to >= text.length && cutOn(1)) return false;
        // A **point** pressed against this span, with a digit reachable
        // through it, is a decimal point as readily as a full stop. That is
        // the whole reason `12,345. 80` and `5. 25` offer nothing: the line
        // says one number to one reader and two to another. Until the ADM-5h
        // re-review this leaned on the pasted region failing to parse, which
        // proves the two are separate only when the other one is readable --
        // so `$780. 554a` offered 780 for a line that may well print 780.554,
        // and `USD 6. 9a` offered 6. The shape settles it without asking.
        if (unit === "." && hops === 0) return false;
        return !joinsIntoOneAmount(text, span, digits);
      }
      // No digit through it, so it is punctuation -- and punctuation is not a
      // wall. Whatever stands beyond it is still this span's neighbour and
      // still has to be provably harmless. ADM-5h: a whole dollar prints its
      // point with no cents after it, and that point hid the token behind it.
      // `\u00a54,543,586.<tab>CR` offered a charge for a line printing a
      // credit, and `1.<gap>USD-` offered a positive one.
      const beyond =
        direction === -1 ? beforeGap(text, at) : afterGap(text, at + 1);
      if (beyond < 0) return edge(-1);
      if (beyond >= text.length) return edge(1);
      at = beyond;
      continue;
    }
    // Neutral punctuation is not a wall either. A bar, a semicolon or a quote
    // mark cannot sign or scale a number, but it cannot hide what stands
    // behind it: `| Payment | 45.00 | CR |` printed a credit and offered a
    // charge, `$45.00 | million` offered forty-five, and `-| 45.00` offered a
    // positive. A pipe-rendered table is how many of this store's parsed
    // receipts print a column, so the bar still costs nothing when the cell
    // beyond it is a label or the end of the line -- `| Total | 1,234.56 |`
    // reads exactly as it did.
    if (NEUTRAL_PUNCTUATION.has(unit)) {
      const beyond =
        direction === -1 ? beforeGap(text, at) : afterGap(text, at + 1);
      if (beyond < 0) return edge(-1);
      if (beyond >= text.length) return edge(1);
      // The cell on the other side of the rule, asked as a cell. A bar is a
      // cell boundary, so what stands beyond it is a *neighbouring value*
      // rather than a word pressed against this one, and three kinds of cell
      // provably say nothing about this amount. Without this, stepping over
      // the bar refused a third of the correct offers on the pipe-rendered
      // tables several of this store's parsed receipts print.
      if (cellIsHarmless(text, at, direction, options)) return true;
      at = beyond;
      stepped = true;
      continue;
    }
    if (CONDITIONAL_JOINERS.has(unit)) {
      const touching =
        direction === -1 ? at === span.start - 1 : at === span.end;
      if (touching) return false;
      const beyond =
        direction === -1 ? beforeGap(text, at) : afterGap(text, at + 1);
      if (beyond < 0) return edge(-1);
      if (beyond >= text.length) return edge(1);
      return !/\d/.test(text[beyond]!);
    }
    return false;
  }
  return false;
}

/**
 * Whether the cell past a rule says nothing about the amount on this side.
 *
 * A bar, a semicolon or a quote mark is a boundary between two printed
 * things, so the question is about the *whole* cell rather than the character
 * facing us -- which is how `| Net income (loss) | (12,500) |` refused on the
 * closing parenthesis of a label. Three kinds of cell are harmless, and each
 * of them is decided mechanically:
 *
 *   - **A whole amount of its own.** `$150.00`, `(6.00)`, `-1,204.17`,
 *     `3,200`: the scanner reads the cell entire, so it is a value beside
 *     this one and not a marker on it.
 *   - **A lone currency code, or a blank marker.** `USD` naming the column's
 *     currency, and `N/A` where a figure is not stated.
 *   - **A label.** No digit, balanced parentheses, nothing that signs or
 *     scales, and every word in it neutral on its own account.
 *
 * Everything else falls through to the ordinary neighbour rule, so a `CR`,
 * `DR`, `%`, magnitude or unit cell refuses exactly as it did.
 */
const BLANK_CELLS = new Set(["n/a", "na", "n.a.", "none", "nil"]);

function cellIsHarmless(
  text: string,
  bar: number,
  direction: -1 | 1,
  options?: AmountScanOptions,
): boolean {
  const cell = cellPast(text, bar, direction);
  if (cell === undefined) return false;
  const body = collapseGaps(cell).trim();
  if (body === "") return false;
  // One printed amount and nothing else beside it, which is the same question
  // the citation repair asks about a line. The scanner reads the cell entire,
  // so its sign lives inside it: `£9,898.64 CR` is a credit of its own and
  // said nothing about the cell after it, and the finder refused that cell on
  // the `CR`.
  if (parseAmount(body) !== undefined) return true;
  if (statesOnlyOneAmount(body)) return true;
  const lower = body.toLowerCase();
  if (BLANK_CELLS.has(lower)) return true;
  if (SUPPORTED_CURRENCY_SET.has(body.toUpperCase())) return true;
  return labelCell(body, direction, options);
}

/** The text between this rule and the next one, on the given side. */
function cellPast(
  text: string,
  bar: number,
  direction: -1 | 1,
): string | undefined {
  let at = bar + direction;
  for (let steps = 0; steps < 512; steps += 1) {
    if (at < 0 || at >= text.length) break;
    if (NEUTRAL_PUNCTUATION.has(text[at]!)) break;
    at += direction;
  }
  return direction === 1 ? text.slice(bar + 1, at) : text.slice(at + 1, bar);
}

/** Whether a cell is a label: nothing in it can sign, scale or join a number
 * on the other side of the rule. */
function labelCell(
  body: string,
  direction: -1 | 1,
  options?: AmountScanOptions,
): boolean {
  if (/[\d%+]/.test(body)) return false;
  if (/[-\u2013\u2014]/.test(body)) return false;
  for (const unit of body) {
    if (CURRENCY_SYMBOL_CHARS.has(unit)) return false;
    if (unit === FRACTION_SLASH) return false;
  }
  let depth = 0;
  for (const unit of body) {
    if (unit === "(") depth += 1;
    else if (unit === ")") depth -= 1;
    if (depth < 0) return false;
  }
  if (depth !== 0) return false;
  for (const word of body.match(/\p{L}+/gu) ?? []) {
    if (!neutralWord(word, direction, options)) return false;
  }
  return true;
}

/**
 * Whether the token at `token` is a piece of something the folding poisoned.
 *
 * {@link foldAmountText} replaces every digit this grammar must not read with
 * a fraction slash, which is glued to the digits and parses as nothing. An
 * alphanumeric run stops at that mark, so the neighbour rule was handed half
 * a token and asked whether it joined -- and half a token joins nothing. The
 * mark on either side of the run says the run is a fragment of a token the
 * grammar cannot read, and unknown is refused.
 */
function poisonedAround(
  text: string,
  token: { from: number; to: number },
): boolean {
  return (
    text[token.from - 1] === FRACTION_SLASH || text[token.to] === FRACTION_SLASH
  );
}

/** The whole letters-and-digits run the character at `at` belongs to. */
function alphanumericRun(
  text: string,
  at: number,
): { from: number; to: number } {
  let from = at;
  let to = at + 1;
  while (from > 0 && /[\p{L}\d]/u.test(text[from - 1]!)) from -= 1;
  while (to < text.length && /[\p{L}\d]/u.test(text[to]!)) to += 1;
  return { from, to };
}

/**
 * A word that cannot scale, sign or re-measure the number beside it.
 *
 * A single letter always can -- `M`, `K`, `B`, `C`, `D` and the tax flags are
 * all one letter -- so a single letter is never neutral. A scale word is
 * refused whichever side it stands on. A unit word is refused only where a
 * unit can stand, which is after its quantity, and is neutral for the
 * dimensionless `number` type. See {@link UNIT_WORDS}.
 */
function neutralWord(
  word: string,
  direction: -1 | 1,
  options?: AmountScanOptions,
  span?: { currency: boolean },
  nameStart = false,
): boolean {
  if (word.length < 2) return false;
  const lower = word.toLowerCase();
  if (lower === "cr" || lower === "dr") return false;
  if (Object.hasOwn(MAGNITUDES, lower)) return false;
  if (MAGNITUDE_WORDS.has(lower) || SPACED_MAGNITUDE_WORDS.has(lower)) {
    return false;
  }
  if (SUPPORTED_CURRENCY_SET.has(word.toUpperCase())) return false;
  // A scale word that is also a name or an ordinary word: see
  // {@link NAMEABLE_SCALE_WORDS}.
  if (NAMEABLE_SCALE_WORDS.has(lower)) {
    return direction === -1 || nameStart;
  }
  if (UNIT_WORDS.has(lower)) {
    return direction === -1 || Boolean(options?.percentIsNeutral);
  }
  if (COUNTED_UNIT_WORDS.has(lower)) {
    // A marked amount is money whatever noun follows it.
    return (
      direction === -1 ||
      Boolean(span?.currency) ||
      Boolean(options?.percentIsNeutral)
    );
  }
  return true;
}

/**
 * Whether the word at `from` opens a name.
 *
 * A Capitalized word followed by another Capitalized word, which is what
 * `Mill Creek`, `Grand Rapids`, `Thousand Oaks` and `Lakh Street` are and
 * what `2.5 million dollars` is not. Mechanical on purpose: the finder has no
 * gazetteer and every other reading of these words is a guess.
 *
 * An all-capitals word is not Capitalized in this sense -- `TOTAL MILL` is a
 * receipt shouting, not a place -- so the test is one upper-case letter
 * followed by a lower-case one.
 */
const CAPITALIZED = /^\p{Lu}\p{Ll}/u;

function opensAName(text: string, from: number, to: number): boolean {
  if (!CAPITALIZED.test(text.slice(from, to))) return false;
  const next = afterGap(text, to);
  if (next === to || next >= text.length) return false;
  const run = alphanumericRun(text, next);
  if (run.from !== next) return false;
  const following = text.slice(run.from, run.to);
  if (/\d/.test(following)) return false;
  return CAPITALIZED.test(following);
}

/** The digit-bearing token a run of separators and gaps leads to; `"edge"`
 * when the run reaches the end of the text, which the caller has to ask about
 * because the end may be a cut and a cut may hide a digit. */
function digitThrough(
  text: string,
  at: number,
  direction: -1 | 1,
): { from: number; to: number } | "edge" | undefined {
  let probe = at;
  for (let steps = 0; steps < 64; steps += 1) {
    probe += direction;
    if (probe < 0 || probe >= text.length) return "edge";
    const unit = text[probe]!;
    if (/\d/.test(unit)) return alphanumericRun(text, probe);
    if (!GAP.test(unit) && unit !== "." && unit !== ",") return undefined;
  }
  return undefined;
}

/**
 * Whether the span and the token beside it read as one amount.
 *
 * The mechanical half of the neighbour rule, and the only part of it that is
 * not a list. Nothing is enumerated: the two are pasted back together exactly
 * as the line prints them, their gaps collapsed, and `parseAmount` is asked.
 * A reading means the printed text is ambiguous and neither side may be
 * offered; no reading means they are provably two tokens, which is what keeps
 * a receipt column readable.
 */
function joinsIntoOneAmount(
  text: string,
  span: AmountSpan,
  token: { from: number; to: number },
): boolean {
  const other = amountSpanAt(text, nearestDigit(text, token));
  // A compound amount: `$3 million 2 thousand`, `1 crore 25 lakh`,
  // `5 lakh 20 thousand`. Two scaled spans one space apart, the larger scale
  // first, are one number written the way a person says it out loud -- and
  // the finder offered the first of them whole, which is the wrong number by
  // whatever the second one adds. One space, because a wider gap is a column
  // and a column of scaled cells is two amounts.
  const [first, second] =
    span.start < other.start ? [span, other] : [other, span];
  if (
    first.scale !== undefined &&
    second.scale !== undefined &&
    second.scale < first.scale &&
    text.slice(first.end, second.start) === " "
  ) {
    return true;
  }
  let start = Math.min(span.start, other.start);
  // A pasted region may not begin inside a printed number. `amountSpanAt`
  // walks left from the *nearest* digit of the neighbouring token, and a
  // grouping separator stops that walk on its left-hand side, so
  // `12,345. 80` used to be pasted back together as `,345. 80`. That reads
  // as nothing, which said the two were provably separate tokens, and the
  // finder offered 80 for a line that may well print 12,345.80. Widening
  // the region to the whole digit run is the same question asked about the
  // text the page actually prints.
  while (start > 0 && /\d/.test(text[start - 1]!)) start -= 1;
  const end = Math.max(span.parseEnd, other.parseEnd);
  // A region this wide is not one printed amount; refusing is the safe answer
  // and it keeps the check linear on a pathological line.
  if (end - start > 512) return true;
  const region = collapseGaps(text.slice(start, end));
  // Every way the printed text between the two runs could be one token.
  //
  // "Do these two runs join" is a question about digits and separators, and a
  // reading refused for any *other* reason is no evidence they are separate.
  // Three things had to be asked besides the region as it stands, and each of
  // them was a wrong number the finder offered:
  //
  //   - **Without a currency marker the region opens with.** A marker can
  //     only make the joined reading harder to price: a euro amount refuses
  //     `5.123` outright, because a dot is a grouping separator where euros
  //     are printed. Without this, `\u20ac5. 123` read as two separate cells
  //     and offered 5 and 123 -- while `$5. 123` refused both, which is the
  //     answer a currency cannot be allowed to change. Only a marker the
  //     region *opens* with: one standing between the two runs introduces
  //     the second of them, which is what `Paid 09/01/2026 $42.00` prints.
  //   - **With a marker it does not print.** `1, 234K` refuses only because a
  //     magnitude letter without a currency marker means the token is not an
  //     amount, and that is a rule about `401K` rather than a proof that the
  //     `1` stands alone. The finder offered the 1.
  //   - **Without a tail that belongs to neither run.** The neighbouring
  //     span swallows a closing letter, and that letter is what made the
  //     joined reading unreadable: `Refs 1, 234 m` offered the 1, because
  //     `1,234 m` is a magnitude abbreviation a space away from its digits
  //     and this grammar refuses those whole.
  const readings = new Set<string>();
  const consider = (one: string): void => {
    readings.add(one);
    const bare = one.replace(new RegExp(`^(?:${CURRENCY_MARK})[ ]?`), "");
    readings.add(bare === one ? `$${one}` : bare);
  };
  consider(region);
  const trimmed = region.replace(/[^\d]+$/u, "");
  if (trimmed !== "" && trimmed !== region) consider(trimmed);
  for (const reading of readings) {
    if (parseAmount(reading) !== undefined) return true;
  }
  return false;
}

function nearestDigit(text: string, token: { from: number; to: number }): number {
  for (let at = token.from; at < token.to; at += 1) {
    if (/\d/.test(text[at]!)) return at;
  }
  return token.from;
}

/**
 * Whether a currency marker printed after the digits belongs to *this*
 * amount.
 *
 * Two conditions, and each of them is a counterexample the oracle fuzzer
 * found. **One space**, because a wide gap is a column boundary and reaching
 * across one takes the next cell's marker: `10K<tab>\u20a9  9,299.47` read the
 * form name as ten thousand won. **No digit after it**, because a marker
 * between two numbers belongs to the one it leads, not the one it follows:
 * `401K \u20b9 8,145,933` is a plan name beside a rupee amount, and it read as
 * four hundred and one thousand. The digit is looked for past any gap, since
 * `401K \u20b9   4.9` is the same marker in the same place.
 *
 * NFKC has already folded the no-break, narrow, em and ideographic spaces to
 * U+0020 by the time the finder sees them, so "one space" is one character.
 */
function ownsTrailingMarker(
  text: string,
  end: number,
  at: number,
  length: number,
): boolean {
  if (at !== end + 1 || text[end] !== " ") return false;
  const beyond = afterGap(text, at + length);
  return beyond >= text.length || !/\d/.test(text[beyond]!);
}

/** A currency marker a gap to the left of the token, which is how a column
 * prints one. Only a code this store supports counts, or "TAX 1.30" would
 * take `TAX` for a currency and refuse the line's only amount. */
function withSpacedCurrency(text: string, start: number): number {
  // Exactly one space, which is what a marker printed beside its amount looks
  // like once NFKC has folded the no-break, em, narrow and ideographic spaces
  // to U+0020. A *wide* gap is a column boundary, and reaching across one
  // takes the neighbouring cell's marker: `9,923,064.917 \u00a5      401K` read the
  // form name beside the yen sign as four hundred and one thousand.
  //
  // No gap at all means a marker is already inside the span: the left-hand
  // scan above swallows a glued symbol or code.
  if (start < 2 || text[start - 1] !== " ") return start;
  const at = start - 2;
  const marker = CURRENCY_SYMBOL_CHARS.has(text[at] ?? "")
    ? at
    : /^[A-Z]{3}$/.test(text.slice(at - 2, at + 1)) &&
        SUPPORTED_CURRENCY_SET.has(text.slice(at - 2, at + 1))
      ? at - 2
      : -1;
  if (marker < 0) return start;
  // Anything pressed against the marker's own left makes it part of *that*
  // token: `C$`, `US$`, and the `$` at the end of `1099-K $`, are each
  // somebody else's.
  if (/[\p{L}\d]/u.test(text[marker - 1] ?? "")) return start;
  // A number of its own behind the marker puts it between two of them, and it
  // provably leads neither: `7,000.455      GBP 401K` and
  // `84,825.0thousand \u20a9 10K` both read the plan name *after* the marker as
  // an amount, because the marker belonged to the amount before it. A word
  // behind the marker is a label and settles nothing, which is what keeps
  // `Total USD 42.00` readable; a word with digits in it is a number.
  const behind = beforeGap(text, marker);
  if (behind >= 0) {
    const run = alphanumericRun(text, behind);
    if (/\d/.test(text.slice(run.from, run.to))) return start;
  }
  return marker;
}

/** A credit is negative, however many ways the line says so. Not a toggle:
 * "(1,234.56) CR" prints the sign twice and means it once. */
function negative(decimal: string): string {
  if (compareDecimals(decimal, "0") === 0) return decimal;
  return decimal.startsWith("-") ? decimal : `-${decimal}`;
}

/**
 * Whether the quote actually prints this amount, sign and all.
 *
 * Sign agreement is part of the claim. A refund read as a charge is the same
 * class of error as a wrong digit and it is harder to notice, so `42.00` cited
 * to "Credit (42.00)" fails here rather than becoming a positive balance the
 * owner reconciles against a statement that disagrees.
 */
function amountInQuote(
  amount: string,
  quote: Candidate,
  percentIsNeutral?: boolean,
): boolean {
  return amountsInText(quote.text, {
    cutStart: quote.cutStart,
    cutEnd: quote.cutEnd,
    previousToken: quote.previousToken,
    nextToken: quote.nextToken,
    percentIsNeutral,
  }).some((found) => compareDecimals(found, amount) === 0);
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
  /([A-Za-z]{3,9})\.?[\s-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s-]+'?(\d{4}|\d{2})(?!\d)/g;
/** `1 September 2026`, `1st Sep. 2026`. */
const DAY_FIRST_DATE =
  /(\d{1,2})(?:st|nd|rd|th)?[\s-]+(?:of[\s-]+)?([A-Za-z]{3,9})\.?,?[\s-]+'?(\d{4}|\d{2})(?!\d)/g;

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
  | { kind: "date"; iso: string; precision: DatePrecision }
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

  // A year on its own, or a month and a year, is a date. A tax letter states
  // "2024" and a cover letter states "March 2024", and refusing both lost
  // the only date those documents have. Padding either to the first of the
  // month would invent a day the page does not print and that every reader
  // after this one would repeat as fact, so the value stays exactly as long
  // as the page and carries its precision with it.
  //
  // Anchored whole, all of them: a partial date is the *entire* value, never
  // a year plucked out of a longer string. `2026-09-18` reaches the ISO
  // branch below and stays a day.
  const yearOnly = /^(\d{4})$/.exec(text);
  if (yearOnly) {
    return Number(yearOnly[1]) >= 1000
      ? { kind: "date", iso: yearOnly[1]!, precision: "year" }
      : { kind: "none" };
  }
  // Which part is the year is never a guess here: a year is four digits, a
  // month is one or two or a name. `03/04` settles nothing at all, so it is
  // not read as a month and a year by either order; it falls through to the
  // three-part numeric rule below, matches nothing, and is refused.
  //
  // A two-digit year is refused with it. `March 24` is March 2024 and the
  // twenty-fourth of March at the same time, and a partial date has no third
  // part to tell them apart -- unlike `9 Apr 26`, where the day is printed
  // and only the century is missing, which is what `expandTwoDigitYear` is
  // for and where it stays.
  const named = /^([A-Za-z]{3,9})\.?,?[\s-]+'?(\d{4})$/.exec(text);
  const yearFirst = /^(\d{4})[-/.](\d{1,2})$/.exec(text);
  const monthFirstOnly = /^(\d{1,2})[-/.](\d{4})$/.exec(text);
  if (named || yearFirst || monthFirstOnly) {
    const month = named
      ? monthNumber(named[1]!)
      : yearFirst
        ? Number(yearFirst[2])
        : Number(monthFirstOnly![1]);
    const year = named
      ? Number(named[2])
      : yearFirst
        ? Number(yearFirst[1])
        : Number(monthFirstOnly![2]);
    if (month !== undefined && month >= 1 && month <= 12 && year >= 1000) {
      return {
        kind: "date",
        iso: `${year}-${String(month).padStart(2, "0")}`,
        precision: "month",
      };
    }
    return { kind: "none" };
  }

  // `(?!\d)` rather than `\b`, so an ISO date with a time glued to it
  // ("2026-09-18T14:32") reads: `T` is a word character, so `\b` refused the
  // very form a machine-written timestamp takes.
  const isoLike = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/.exec(text);
  if (isoLike) {
    const iso = isoFrom(
      Number(isoLike[1]),
      Number(isoLike[2]),
      Number(isoLike[3]),
    );
    return iso ? { kind: "date", iso, precision: "day" } : { kind: "none" };
  }

  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/.exec(
    text,
  );
  if (numeric) {
    const resolved = resolveNumericParts(
      Number(numeric[1]),
      Number(numeric[2]),
      order,
    );
    if (resolved === "ambiguous") return { kind: "ambiguous" };
    if (!resolved) return { kind: "none" };
    const iso = isoFrom(namedYear(numeric[3]!), resolved.month, resolved.day);
    return iso ? { kind: "date", iso, precision: "day" } : { kind: "none" };
  }

  // Separators may be spaces or hyphens ("18-Sep-2026"), the comma is
  // optional, and a two-digit year may wear an apostrophe ("Sep 18 '26").
  const monthFirst =
    /^([A-Za-z]{3,9})\.?[\s-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s-]+'?(\d{4}|\d{2})(?!\d)/.exec(
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
      return iso ? { kind: "date", iso, precision: "day" } : { kind: "none" };
    }
  }

  const dayFirst =
    /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+(?:of[\s-]+)?([A-Za-z]{3,9})\.?,?[\s-]+'?(\d{4}|\d{2})(?!\d)/.exec(
      text,
    );
  if (dayFirst) {
    const month = monthNumber(dayFirst[2]!);
    if (month) {
      const iso = isoFrom(namedYear(dayFirst[3]!), month, Number(dayFirst[1]));
      return iso ? { kind: "date", iso, precision: "day" } : { kind: "none" };
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
  precision: DatePrecision = "day",
): boolean {
  const text = quote.normalize("NFKC");

  // A partial date is checked for exactly the parts it claims, and for
  // nothing it does not. It gets its own check rather than the day rule's
  // fast path below, because `includes("2024")` is true of a line printing
  // an account number ending 120245 and of one printing $2,024.00.
  if (precision === "year") return printsYear(text, iso, order);
  if (precision === "month") return printsMonthAndYear(text, iso, order);

  if (text.includes(iso)) return true;

  const [year, month, day] = iso.split("-") as [string, string, string];
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

/**
 * Whether the line prints this year *as a year*.
 *
 * Four digits are a year, a quantity, the whole dollars of an amount and the
 * middle of an account number, and only what stands around them says which.
 * So the run of digits and separators the year sits in has to be the year and
 * nothing else: `2024` and `FY2024` read, `120245`, `2,024` and `2024.00` do
 * not, and a currency marker pressed against it makes it money.
 *
 * This is deliberately narrower than the day rule's substring check. A day
 * has eight digits in a fixed order and a coincidence is vanishingly
 * unlikely; a year has four and a page of numbers is full of them.
 */
function printsYear(text: string, year: string, order?: DateOrder): boolean {
  const number = Number(year);
  if (number < EARLIEST_YEAR || number > LATEST_YEAR) return false;
  for (const match of text.matchAll(/\d+(?:[.,]\d+)*/g)) {
    if (match[0] !== year) continue;
    const at = match.index ?? 0;
    if (!leftOfYearIsClear(text, at)) continue;
    // `2024 Main Street` is a house number. A year names no address, and a
    // document's address block is full of four-digit runs.
    if (STREET_AFTER_NUMBER.test(text.slice(at + year.length))) continue;
    return true;
  }
  // A whole date printed on the line states its year as plainly as a bare
  // run does, and this is the only way one reads: `09/18/2024` has a slash
  // glued to its left, and the rule above refuses that on purpose.
  return printedDateYears(text, order).has(year);
}

/** The bounds of a year a document states. Outside them a four-digit run is
 * a form number, a quantity or a code: `Form 1040` is not the year 1040. */
const EARLIEST_YEAR = 1900;
const LATEST_YEAR = 2100;

/** The only letters that may be glued to the left of a year and leave it a
 * year. A fiscal, calendar or tax year prefix, and nothing else: `x2024` is
 * not a year, and nothing mechanical tells it from `FY2024` but this list. */
const YEAR_PREFIXES = new Set(["fy", "cy", "ty"]);

/** Words that, standing to the left, say the number after them is something
 * else that happens to fall between 1900 and 2100: a revision, a form, a
 * reference, a room. */
const NOT_A_YEAR_LABELS = new Set([
  "rev", "revised", "revision", "ver", "version", "form", "no", "num",
  "number", "ref", "reference", "acct", "account", "invoice", "suite", "ste",
  "apt", "unit", "box", "room", "rm", "page", "pg", "line", "id", "pin",
  "policy", "claim", "order", "check", "cheque", "serial", "model", "lot",
  "permit", "license", "licence", "ext", "extension",
]);

/** A street name following a number, which makes the number a house number.
 * Up to three words between, so `2024 North Main Street` reads. */
const STREET_AFTER_NUMBER =
  /^[ \u00a0]+(?:[A-Za-z][A-Za-z.'-]*[ \u00a0]+){0,3}(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|way|court|ct|place|pl|terrace|ter|highway|hwy|parkway|pkwy|circle|cir|square|sq|trail|trl)\b/i;

/**
 * Whether what stands to the left of a four-digit run leaves it a year.
 *
 * Glued, nothing survives but a year prefix: a letter, a digit, a dash, a
 * hash, a slash, a currency mark or a symbol all say the run is part of
 * something longer -- `98101-2024` is a postcode, `(206) 555-2024` a
 * telephone number, `1099-2024` a form, `x2024` an extension, a copyright
 * sign a copyright.
 *
 * One space away, a currency mark or an ISO code makes it money (`$ 2024`,
 * `USD 2024`) and a label from {@link NOT_A_YEAR_LABELS} makes it a
 * revision or a reference (`Rev. 2023`). Every other word is left alone,
 * because `for the tax year 2024` is exactly the shape a year is printed in.
 */
function leftOfYearIsClear(text: string, at: number): boolean {
  const before = text.slice(0, at);
  if (before === "") return true;
  const glued = before.slice(-1);
  if (!/[\s\u00a0]/.test(glued)) {
    const word = /([A-Za-z]+)$/.exec(before);
    return word !== null && YEAR_PREFIXES.has(word[1]!.toLowerCase());
  }
  const trimmed = before.replace(/[\s\u00a0]+$/, "");
  if (trimmed === "") return true;
  const word = /([A-Za-z]+)\.?$/.exec(trimmed);
  if (word) {
    if (SUPPORTED_CURRENCY_SET.has(word[1]!.toUpperCase())) return false;
    return !NOT_A_YEAR_LABELS.has(word[1]!.toLowerCase());
  }
  const mark = trimmed.slice(-1);
  if (CURRENCY_SYMBOL_CHARS.has(mark)) return false;
  return mark !== "-" && mark !== "#" && mark !== "/";
}

/** Every year a whole date on this line prints. */
function printedDateYears(text: string, order?: DateOrder): Set<string> {
  const years = new Set<string>();
  for (const window of text.match(NUMERIC_DATE) ?? []) {
    const read = readPrintedDate(window, order);
    if (read.kind === "date" && read.precision === "day") {
      years.add(read.iso.slice(0, 4));
    }
  }
  for (const [pattern, position] of [
    [MONTH_FIRST_DATE, "month"],
    [DAY_FIRST_DATE, "day"],
  ] as const) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const word = position === "month" ? match[1]! : match[2]!;
      if (monthNumber(word) === undefined) continue;
      years.add(String(namedYear(match[3]!)));
    }
  }
  return years;
}

/** A month name pressed against a year, with no day between them:
 * `March 2024`, `Sep. 2026`. The two dated patterns both require a day, so
 * neither of them reads this, which is the form a cover letter prints. */
const MONTH_NAME_AND_YEAR = /([A-Za-z]{3,9})\.?,?[\s-]+'?(\d{4})(?!\d)/g;

/** `09/2026`, `2026-09`. The left-hand guard keeps this off the middle of a
 * three-part date: in `03/04/2026` the `04/2026` is not a month and a year,
 * it is the last two thirds of the fourth of March. */
const NUMERIC_MONTH_AND_YEAR =
  /(?<![\d/.-])(\d{1,2})[-/.](\d{4})(?!\d)|(?<![\d/.-])(\d{4})[-/.](\d{1,2})(?!\d)/g;

/**
 * Whether the line prints this month *and* this year, together.
 *
 * Adjacency is the whole rule. A month number found somewhere on the line and
 * a year found somewhere else are two facts about the line and not a date on
 * it: `Invoice 3 paid in 2024` does not say March 2024, and reading it that
 * way would file a document under a month no one wrote down.
 */
function printsMonthAndYear(
  text: string,
  iso: string,
  order?: DateOrder,
): boolean {
  const [year, month] = iso.split("-") as [string, string];
  const number = Number(month);
  // The line read whole, which is how a cover letter's only line arrives.
  const printed = readPrintedDate(text.trim(), order);
  if (
    printed.kind === "date" &&
    (printed.precision === "month"
      ? printed.iso === iso
      : printed.precision === "day" && printed.iso.startsWith(`${iso}-`))
  ) {
    return true;
  }
  // A full numeric date on the line, read positionally by the same rule the
  // value is read by. `04/03/2024` is in March under `DMY` and in April
  // under `MDY`, and with neither it is ambiguous and supports nothing.
  for (const window of text.match(NUMERIC_DATE) ?? []) {
    const inWindow = readPrintedDate(window, order);
    if (inWindow.kind === "date" && inWindow.iso.startsWith(`${iso}-`)) {
      return true;
    }
  }
  // A full date on the line is in this month when it names it and the year.
  for (const [pattern, position] of [
    [MONTH_FIRST_DATE, "month"],
    [DAY_FIRST_DATE, "day"],
  ] as const) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const word = position === "month" ? match[1]! : match[2]!;
      if (namesMonth(number, word) && String(namedYear(match[3]!)) === year) {
        return true;
      }
    }
  }
  MONTH_NAME_AND_YEAR.lastIndex = 0;
  let named: RegExpExecArray | null;
  while ((named = MONTH_NAME_AND_YEAR.exec(text)) !== null) {
    if (!namesMonth(number, named[1]!) || named[2] !== year) continue;
    if (isDated(text, named.index)) return true;
  }
  NUMERIC_MONTH_AND_YEAR.lastIndex = 0;
  let numeric: RegExpExecArray | null;
  while ((numeric = NUMERIC_MONTH_AND_YEAR.exec(text)) !== null) {
    const [printedMonth, printedYear] = numeric[1]
      ? [numeric[1], numeric[2]!]
      : [numeric[4]!, numeric[3]!];
    if (Number(printedMonth) !== number || printedYear !== year) continue;
    if (isDated(text, numeric.index)) return true;
  }
  return false;
}

/**
 * Words after which a bare month and year is a date rather than two numbers
 * that happen to sit next to each other.
 */
const DATE_LABELS = new Set([
  "period", "periods", "date", "dated", "dates", "month", "months",
  "statement", "for", "of", "as", "through", "thru", "to", "from", "ending",
  "ended", "end", "beginning", "began", "begins", "effective", "issued",
  "filed", "due", "paid", "posted", "closing", "closed", "cycle", "year",
  "fy", "billing", "service", "coverage", "term", "since", "until",
  "starting", "covering", "between", "on", "in", "by", "quarter", "week",
]);

/**
 * Whether a month-and-year token at `at` is printed as a date.
 *
 * Two digits beside four are a date only where a date is what the line is
 * saying. `Ratio 3/2024` is a ratio, `Pages 3-2024` a page range and
 * `You may 2024` a sentence, and reading any of them as March 2024 would
 * file a document under a month nobody wrote. So the token has to open the
 * line or follow a word that introduces a date.
 */
function isDated(text: string, at: number): boolean {
  const before = text.slice(0, at);
  if (before.trim() === "") return true;
  const word = /([A-Za-z]+)[.,:;]?[\s\u00a0]*$/.exec(before);
  return word !== null && DATE_LABELS.has(word[1]!.toLowerCase());
}

/** One entry of a list, read or refused on its own. */
export type ReadLineItem =
  | { ok: true; item: LineItem }
  | { ok: false; reason: CorrectionReason };

/**
 * The entries of a `line_item_list`, each read on its own.
 *
 * Per entry, not per list. One malformed line used to refuse the whole
 * statement, so a receipt with six good items and one the model garbled
 * stored nothing -- which is how a strong model still lost every line item on
 * both trial documents. A bad entry is now one refused entry and the rest
 * store.
 */
export function readLineItems(value: unknown): ReadLineItem[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    return undefined;
  }
  return value.map((entry): ReadLineItem => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, reason: "malformed_statement" };
    }
    const item = entry as {
      description?: unknown;
      amount?: unknown;
      lines?: unknown;
    };
    if (
      typeof item.description !== "string" ||
      !item.description.trim() ||
      item.description.length > 500 ||
      (typeof item.amount !== "string" && typeof item.amount !== "number")
    ) {
      return { ok: false, reason: "malformed_statement" };
    }
    const lines = Array.isArray(item.lines)
      ? item.lines
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id) && id >= 1)
          .slice(0, 3)
      : [];
    return {
      ok: true,
      item: {
        description: item.description,
        amount: String(item.amount),
        lines,
      },
    };
  });
}

export type GateInput = {
  valueType: DocumentFieldValueType;
  value: unknown;
  /**
   * The cited lines, each on its own, and for text fields each adjacent pair
   * as well. A value must sit entirely inside one of these; the lines between
   * two cited ones are not here, so they cannot support anything.
   */
  candidates: readonly Candidate[];
  pageText: string;
  /** The document type's declared currency, or USD. Used only when the page
   * states none, and flagged when it is. */
  defaultCurrency: string;
  /** How this kind writes a numeric date, when it says. Unset, an ambiguous
   * one is a correction rather than a guess. */
  dateOrder?: DateOrder;
};

/**
 * Candidate texts for one citation.
 *
 * Each cited line on its own, always. For a text field, each pair of
 * *adjacent* cited lines as well: a vendor on a receipt is regularly split
 * across two printed lines, and refusing that costs the field. Money, numbers
 * and dates never get the pairs -- assembling `12` on one line and `.99` on
 * the next into an amount is inventing a number, which is the failure this
 * whole gate exists to prevent.
 *
 * The lines *between* two cited lines never appear here. That is what lets a
 * citation name lines seven apart without an unrelated amount in between
 * standing in for the value.
 */
export function candidatesFor(
  cited: ReadonlyArray<CitedLine>,
  valueType: DocumentFieldValueType,
): Candidate[] {
  const candidates: Candidate[] = cited.map((line) => ({
    text: line.text,
    start: line.start,
    end: line.end,
    cutStart: line.cutStart,
    cutEnd: line.cutEnd,
    previousToken: line.previousToken,
    nextToken: line.nextToken,
  }));
  const textual =
    valueType === "text" ||
    valueType === "organization" ||
    valueType === "person" ||
    valueType === "identifier";
  if (!textual) return candidates;
  for (let index = 1; index < cited.length; index += 1) {
    const previous = cited[index - 1]!;
    const line = cited[index]!;
    // Adjacent by line id, so the span stays a contiguous range of the page
    // and covers nothing that was not cited.
    if (line.id === previous.id + 1) {
      candidates.push({
        text: `${previous.text}\n${line.text}`,
        start: previous.start,
        end: line.end,
        cutStart: previous.cutStart,
        cutEnd: line.cutEnd,
        previousToken: previous.previousToken,
        nextToken: line.nextToken,
      });
    }
  }
  return candidates;
}

/**
 * How a text value is compared with the line that should print it.
 *
 * Case and whitespace were already folded. Punctuation joins them here,
 * because a receipt prints `BRACKEN TOOLS,` or `Bracken Tools.` or
 * `BRACKEN  TOOLS` for the same vendor, and a comma is not a difference of
 * fact. Only text fields are read this way; a money or date value keeps its
 * exact reading.
 */
export function foldTextForMatch(value: string): string {
  return foldTextWithOffsets(value).folded;
}

/**
 * The same fold, keeping where each folded character came from.
 *
 * An identifier is stored as the *document* spells it, not as the model
 * spells it, and that needs the original offsets: `INV.0012`, `INV 0012` and
 * `inv 0012` all fold to the same thing as the page's `INV-0012`, and storing
 * whichever of them the model happened to type makes the stored identifier
 * disagree with the document it cites.
 */
export function foldTextWithOffsets(value: string): {
  folded: string;
  starts: number[];
  ends: number[];
} {
  const normalized = value.normalize("NFKC");
  const units: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let at = 0;
  let pendingSpace = false;
  while (at < normalized.length) {
    const unit = normalized[at]!;
    const run = /[\s.,;:!?'"`()[\]{}*_+\\/|-]/.test(unit);
    if (run) {
      let ahead = at;
      while (
        ahead < normalized.length &&
        /[\s.,;:!?'"`()[\]{}*_+\\/|-]/.test(normalized[ahead]!)
      ) {
        ahead += 1;
      }
      pendingSpace = units.length > 0;
      at = ahead;
      continue;
    }
    if (pendingSpace) {
      units.push(" ");
      starts.push(at);
      ends.push(at);
      pendingSpace = false;
    }
    units.push(unit.toLowerCase());
    starts.push(at);
    ends.push(at + 1);
    at += 1;
  }
  return { folded: units.join(""), starts, ends };
}

/**
 * The per-value-type check, against the cited lines.
 *
 * A value must sit entirely inside one candidate. The caller turns the
 * candidate that supported it into the evidence span, so what is stored cites
 * the line that prints it rather than the region it was found somewhere in.
 */
export function checkValue(input: GateInput): GateResult {
  const { valueType, value, candidates, pageText, defaultCurrency } = input;
  if (candidates.length === 0) return fail("value_not_in_quote");

  const firstMatch = (predicate: (candidate: Candidate) => boolean): number =>
    candidates.findIndex(predicate);

  if (valueType === "line_item_list") {
    // Handled by `checkLineItems`, which gates each entry on its own cited
    // lines. Reaching here means a caller has not been updated.
    return fail("malformed_statement");
  }

  if (typeof value !== "string" && typeof value !== "number") {
    return fail("malformed_statement");
  }
  const literal = String(value).trim();
  if (!literal || literal.length > 1000) return fail("malformed_statement");

  switch (valueType) {
    // The three parsed types check the cited line as well as the value. A
    // value that parses is only half the claim; the other half is that the
    // document says it. Without this, `1500.00` cited to "Total $15.50" is a
    // stored fact with a citation that contradicts it -- the worst outcome
    // this feature has, because the citation is what makes it trustworthy.
    case "money": {
      const amount = parseAmount(literal);
      if (amount === undefined) return fail("money_unparsable");
      const at = firstMatch((candidate) => amountInQuote(amount, candidate));
      if (at < 0) return fail("value_not_in_quote");
      const pageCurrency = currencyOnPage(pageText);
      return {
        ok: true,
        values: [
          { type: "money", amount, currency: pageCurrency ?? defaultCurrency },
        ],
        support: [at],
        ...(pageCurrency === undefined
          ? { currencyAssumed: true as const }
          : {}),
      };
    }
    case "date": {
      // ISO first, then the printed forms a document actually uses. The value
      // is normalized here and checked against the cited lines afterwards, so
      // a date can only be stored when a cited line prints it, in the order
      // that line prints it.
      const printed: PrintedDate = realIsoDate(literal)
        ? { kind: "date", iso: literal, precision: "day" }
        : readPrintedDate(literal, input.dateOrder);
      if (printed.kind === "ambiguous") return fail("date_ambiguous");
      if (printed.kind === "none") return fail("date_unparsable");
      const at = firstMatch((candidate) =>
        dateInQuote(
          printed.iso,
          candidate.text,
          input.dateOrder,
          printed.precision,
        ),
      );
      if (at < 0) return fail("value_not_in_quote");
      return {
        ok: true,
        // A day-precision value keeps the shape every stored date has had,
        // with no `precision` key; a partial one says how much it knows.
        values: [
          printed.precision === "day"
            ? { type: "date", value: printed.iso }
            : { type: "date", value: printed.iso, precision: printed.precision },
        ],
        support: [at],
      };
    }
    case "number": {
      // Through `parseAmount`, not a bare canonicalize: a percentage prints as
      // `3,5%` in half the world, and stripping its separators outright turned
      // three and a half into thirty-five.
      const canonical = parseAmount(literal.replace(/%/g, ""));
      if (canonical === undefined) return fail("number_unparsable");
      const at = firstMatch((candidate) =>
        amountInQuote(canonical, candidate, true),
      );
      if (at < 0) return fail("value_not_in_quote");
      // `unitCode: "1"` is UCUM's dimensionless unit: these are counts,
      // percentages and odometer readings, not quantities this schema converts.
      return {
        ok: true,
        values: [{ type: "decimal", value: canonical, unitCode: "1" }],
        support: [at],
      };
    }
    default: {
      // text, organization, person, identifier: names are stored as written
      // (the entity binding gate is dropped), so the only check is that the
      // value is actually part of a cited line, read the way a printed name
      // has to be read.
      const folded = foldTextForMatch(literal);
      if (!folded) return fail("malformed_statement");
      const at = firstMatch((candidate) =>
        foldTextForMatch(candidate.text).includes(folded),
      );
      if (at < 0) return fail("value_not_in_quote");
      // An identifier is stored as the document spells it. A name may be
      // stored as the model wrote it -- a vendor read off a logo has no one
      // spelling -- but an identifier is a key, and `INV 0012` is not the key
      // a page printing `INV-0012` carries.
      const stored =
        valueType === "identifier"
          ? (printedFormOf(candidates[at]!.text, folded) ?? literal)
          : literal;
      return {
        ok: true,
        values: [{ type: "text", value: stored }],
        support: [at],
      };
    }
  }
}

/** `compareDecimals` throws on anything that is not a decimal. The diagnostic
 * compares strings it did not produce, so it needs the total version. */
export function compareDecimalsSafely(
  left: string,
  right: string,
): -1 | 0 | 1 | null {
  try {
    return compareDecimals(left, right);
  } catch {
    return null;
  }
}

/**
 * The substring of the cited line whose fold equals `folded`.
 *
 * Undefined when the fold does not occur, which the caller has already ruled
 * out; the fallback keeps it total rather than relying on that.
 */
function printedFormOf(text: string, folded: string): string | undefined {
  const mapped = foldTextWithOffsets(text);
  const at = mapped.folded.indexOf(folded);
  if (at < 0 || folded.length === 0) return undefined;
  const from = mapped.starts[at];
  const to = mapped.ends[at + folded.length - 1];
  if (from === undefined || to === undefined || to <= from) return undefined;
  return text.normalize("NFKC").slice(from, to);
}

/** One entry's outcome: the money value it becomes, and which candidate line
 * printed the amount. */
export type LineItemOutcome =
  | {
      ok: true;
      value: ObservationValue;
      amount: string;
      span: Candidate;
      /** The cited line the amount was found on. The stored observation key
       * is derived from it, so a key does not move when the model reorders
       * the list between runs. */
      lineId: number;
      currencyAssumed?: true;
    }
  | { ok: false; reason: CorrectionReason };

export type LineItemCheck = {
  item: LineItem;
  /** The lines this entry cites, already resolved. */
  cited: ReadonlyArray<CitedLine>;
  pageText: string;
  defaultCurrency: string;
};

/**
 * One line item, gated on its own citation.
 *
 * The amount must occur within a single cited line, exactly as a money value
 * anywhere else must. The description is a text field, so it folds and may
 * span two adjacent cited lines, exactly as a vendor may. The span stored is
 * the line that prints the *amount*: that is the number someone will later
 * check against a statement.
 */
export function checkLineItem(input: LineItemCheck): LineItemOutcome {
  const { item, cited, pageText, defaultCurrency } = input;
  if (cited.length === 0) return { ok: false, reason: "citation_missing" };
  const amount = parseAmount(item.amount);
  if (amount === undefined) return { ok: false, reason: "money_unparsable" };

  const amountCandidates = candidatesFor(cited, "money");
  const at = amountCandidates.findIndex((candidate) =>
    amountInQuote(amount, candidate),
  );
  if (at < 0) return { ok: false, reason: "value_not_in_quote" };

  // The description is checked the way a name is, against the same lines.
  const folded = foldTextForMatch(item.description);
  const described =
    folded.length > 0 &&
    candidatesFor(cited, "text").some((candidate) =>
      foldTextForMatch(candidate.text).includes(folded),
    );
  if (!described) return { ok: false, reason: "value_not_in_quote" };

  const pageCurrency = currencyOnPage(pageText);
  return {
    ok: true,
    amount,
    value: {
      type: "money",
      amount,
      currency: pageCurrency ?? defaultCurrency,
    },
    span: amountCandidates[at]!,
    lineId: cited[at]?.id ?? 0,
    ...(pageCurrency === undefined ? { currencyAssumed: true as const } : {}),
  };
}

/** The widest a signature gets. Long enough to see a shape, short enough that
 * it cannot carry a sentence. */
const MAX_SIGNATURE_CHARS = 24;

/** Punctuation a signature keeps, because the shape of an amount or a date is
 * the point. Everything else becomes `.`-free: letters fold to `a`, digits to
 * `9`, and anything else is dropped. */
const KEPT_IN_SIGNATURE = new Set([
  "$",
  ".",
  ",",
  "/",
  "-",
  ":",
  " ",
]);

/**
 * The character-class shape of a value.
 *
 * `"$1,234.56"` becomes `"$9,999.99"` and `"Bracken Tools"` becomes
 * `"aaaaaaa aaaaa"`. Enough to see that a money field came back as words, or
 * that a date came back with a time on it; not enough to learn anything about
 * the household.
 */
export function valueSignature(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : value === null || value === undefined
          ? ""
          : JSON.stringify(value).slice(0, 200);
  let signature = "";
  for (const unit of text.normalize("NFKC")) {
    if (signature.length >= MAX_SIGNATURE_CHARS) break;
    if (/[0-9]/.test(unit)) signature += "9";
    else if (/[A-Za-z]/.test(unit)) signature += "a";
    else if (KEPT_IN_SIGNATURE.has(unit)) signature += unit;
  }
  return signature;
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
