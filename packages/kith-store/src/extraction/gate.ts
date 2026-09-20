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
 * occupies so a match can become an evidence span. */
export type Candidate = { text: string; start: number; end: number };

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
};

/** Longest alternative first, so `mm` is not read as `m` with an `m` left
 * over and `million` is not read as `m` followed by `illion`. */
const MAGNITUDE_WORD_LIST = [
  "millions",
  "million",
  "thousands",
  "thousand",
  "billions",
  "billion",
  "mm",
  "mn",
  "bn",
  "k",
  "m",
  "b",
] as const;

/**
 * The characters a document prints as a minus sign, other than the hyphen
 * they all fold to here: U+2212, the typographic minus a PDF's text layer
 * carries, and the en and em dashes an export substitutes for it.
 *
 * Folding them is not the same as reading them as a sign. A minus is a sign
 * only where a sign can stand -- pressed against the digits, with nothing
 * alphanumeric before it -- so a dash between two numbers stays what it is,
 * a range, and the token carrying it is refused whole.
 */
const MINUS_SIGNS = /[−–—]/g;

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
 * The one folding both the scanner and the finder read through.
 *
 * Every printed minus becomes a minus: U+2212 is what a PDF's text layer
 * carries, and an en or em dash stands in for it in exported statements.
 * Dropping the character dropped the sign, and a printed `−$5` was stored as
 * a charge. A dash *between* two numbers is a range, and the grammar refuses
 * that token whichever character it is written with.
 */
function foldAmountText(raw: string): string {
  return raw
    .replace(SUPERSCRIPTS, FRACTION_SLASH)
    .normalize("NFKC")
    .replace(MINUS_SIGNS, "-");
}

/**
 * Magnitude abbreviations that are only ever money.
 *
 * A single letter is not one of these: `B`, `K` and `M` a space away from
 * digits are a room, a suite and a metre at least as often as a magnitude.
 * The finder refuses those tokens too rather than offering the bare mantissa
 * -- `Room 12 B` offers nothing now, where it used to offer 12 -- but these
 * are listed because they are not even ambiguous: a line printing `2.5 mil`
 * does not print two and a half.
 */
const SPACED_MAGNITUDE_WORDS = new Set(["mm", "mn", "bn", "mil", "mio"]);

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
    if (!spaced && !trailingMinus && text[at] === "-") {
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
  let text = raw;
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
 * that one value or nothing at all. A span the scanner refuses is dropped
 * whole and its digits are never re-read in pieces, because a fragment of a
 * token the grammar could not read is the shape every wrong number in this
 * file's history has had: `$2.5 M` offering 2.5, `$2.5m²` offering two and a
 * half million for a token that ends in a digit, `(206) 555-0134` offering
 * -206, `$1 000 000` offering 0.
 *
 * Two rules are the finder's own, because the scanner reads a token and the
 * finder reads a line:
 *
 *   * **Where a token ends.** Whitespace ends it, unless a currency marker
 *     proves the gap is the column the amount sat in. Letters, a glued
 *     hyphen, and the digits after either, do not end it: `1099-K`,
 *     `INV-0012`, `5-10`, `$1M1` and `(206) 555-0134` are each one span, and
 *     each is refused whole.
 *   * **`CR`**, the one sign that is not part of the number and so cannot
 *     reach the scanner. Parentheses, a leading minus and a trailing minus
 *     are deliberately *not* read here: they go into the span and the
 *     scanner reads them, which is why `(-5)` is refused on both sides
 *     rather than read as -5 on one.
 *
 * Where the finder cannot tell where a token ends -- `1 000 000` and
 * `APPLES 12 990` are the same shape and two different readings -- it offers
 * nothing for the whole region rather than picking one of them.
 */
export function amountsInText(text: string): string[] {
  const normalized = closeColumnGaps(foldAmountText(text));
  const found: string[] = [];
  let at = 0;
  while (at < normalized.length) {
    if (!/\d/.test(normalized[at]!)) {
      at += 1;
      continue;
    }
    const span = amountSpanAt(normalized, at);
    if (!span.ambiguous) {
      const amount = parseAmount(normalized.slice(span.start, span.end));
      if (amount !== undefined) {
        // `CR` says the amount is a credit, not that its sign flips: a line
        // printing "(1,234.56) CR" says the same thing twice, and negating
        // twice made it a charge.
        found.push(span.credit ? negative(amount) : amount);
      }
    }
    // Past the whole span, parsed or not. Re-entering a span that failed is
    // exactly how a fragment gets offered.
    at = Math.max(span.end, at + 1);
  }
  return found;
}

/**
 * A parsed receipt prints "$ 165 .00" as readily as "$165.00": the space is a
 * rendering artifact of the column the amount sat in, not a separator. Closed
 * up only next to a currency mark, because a bare gap between two numbers is
 * two numbers -- "APPLES 12 .99" is a quantity beside a price.
 */
function closeColumnGaps(text: string): string {
  return text
    .replace(
      new RegExp(
        `(${CURRENCY_MARK})([ \\u00a0]*)(\\d+)[ \\u00a0]+\\.(?=\\d)`,
        "g",
      ),
      "$1$2$3.",
    )
    .replace(
      new RegExp(
        `(${CURRENCY_MARK})([ \\u00a0]*)(\\d+\\.)[ \\u00a0]+(?=\\d)`,
        "g",
      ),
      "$1$2$3",
    );
}

/** One candidate token: what the scanner is asked to read, and the one sign
 * that sits outside it. `ambiguous` means the finder could not tell where the
 * token ends, and nothing at all is offered for the region. */
type AmountSpan = {
  start: number;
  end: number;
  credit: boolean;
  ambiguous: boolean;
};

/** Glued to the digits and part of the token: a currency, the letters that
 * make `qty3` an identifier, the fraction slash a folded `½` or `²` leaves
 * behind, and -- on the left -- the separator that makes `.99` a fragment of
 * a number rather than ninety-nine, and the `#` that makes `#1234` an order
 * number. */
const GLUED_CHARS = /[A-Za-z$€£¥₹₩⁄]/;
const GLUED_LEFT_CHARS = /[A-Za-z$€£¥₹₩⁄.,#]/;

/**
 * Single letters that end an amount rather than sitting beside one.
 *
 * `k`, `m` and `b` are magnitudes, `c` and `d` are credit and debit. A
 * document that prints `$2.5 M`, `Room 12 B` or `45.00 C` may mean two and a
 * half million, twelve, or minus forty-five, and the finder cannot tell
 * which, so it offers none of them. Every other letter is left where it is:
 * `12.99 T` is a tax flag the scanner drops and `42.00 a month` is
 * forty-two.
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
  // it, with nothing alphanumeric before it. "Total - 42.00" is a separator
  // and forty-two; "-$42.00" is minus forty-two. More than one is not a
  // second negation, so the whole run goes into the span and the scanner
  // refuses it: `--5` is not five.
  let signs = start;
  while (signs > 0 && (text[signs - 1] === "-" || text[signs - 1] === "+")) {
    signs -= 1;
  }
  if (signs < start && !/[A-Za-z0-9]/.test(text[signs - 1] ?? "")) {
    start = signs;
    while (start > 0 && GLUED_CHARS.test(text[start - 1]!)) start -= 1;
    start = withSpacedCurrency(text, start);
  }

  // Accounting parentheses may be printed a space away from the digits.
  let open = start > 0 && text[start - 1] === "(";
  if (!open && text[start - 1] === " " && text[start - 2] === "(") {
    open = true;
    start -= 1;
  }
  let end = digit;
  let credit = false;
  let ambiguous = false;
  scan: for (;;) {
    // The token itself: digits, the separators between them, letters, a
    // glued hyphen -- and then digits again, because `$1M1` ends in one and
    // `1099-K`, `5-10` and `20260918-000123` are one token each.
    for (;;) {
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
    // with it. A digit right after the closing one says they were never
    // accounting parentheses: `(206) 555-0134` is a phone number, and reading
    // its area code as a negative amount is how it competed with a total.
    const closing = open ? /^ ?\)/.exec(text.slice(end)) : null;
    if (closing) {
      open = false;
      start -= 1;
      end += closing[0].length;
      const glued = /^ ?\d/.exec(text.slice(end));
      if (glued) {
        end += glued[0].length - 1;
        continue scan;
      }
    }
    // A fraction after the digits makes them a whole part, not a number:
    // "101 1/2" is a bond price, and a hundred and one is the wrong one.
    const fraction = /^ \d+\/\d+/.exec(text.slice(end));
    if (fraction) {
      ambiguous = true;
      end += fraction[0].length;
      continue scan;
    }
    // A single gap before a group of exactly three digits is either the
    // grouping of one number or the space between two of them. A currency
    // marker settles it; without one, nothing is offered for either reading.
    const grouped = /^ (\d{3})(?!\d)/.exec(text.slice(end));
    if (grouped && !/[.,]/.test(text[end - 1] ?? "")) {
      if (!carriesCurrency(text.slice(start, end))) ambiguous = true;
      end += grouped[0].length;
      continue scan;
    }
    // One word after the token, and only one space before it.
    const worded = /^ ([A-Za-z]+)/.exec(text.slice(end));
    if (!worded) break;
    const word = worded[1]!.toLowerCase();
    const glued = /\d/.test(text[end + worded[0].length] ?? "");
    if (!glued && (word === "cr" || word === "dr")) {
      // `CR` is a credit marker on the amount beside it, not a column
      // somewhere to its right: "Item 12.00      CR 45.00" needs the wide gap
      // to belong to the 45.00, and it does, because one space is the rule.
      //
      // The marker stays *outside* the span: it is a sign, not part of the
      // number, and the scanner refuses a token carrying it.
      credit = word === "cr";
      break;
    }
    if (
      glued ||
      (word.length === 1 && CLOSING_LETTERS.has(word)) ||
      SPACED_MAGNITUDE_WORDS.has(word) ||
      MAGNITUDE_WORDS.has(word) ||
      SUPPORTED_CURRENCY_SET.has(word.toUpperCase())
    ) {
      // Each of these belongs to the token, and the scanner decides what it
      // makes of it: a magnitude word scales, a currency code names the
      // money, a tax flag drops, and a magnitude abbreviation a space away
      // refuses the token whole -- which is the point. `$2.5 M` used to offer
      // two and a half.
      end += worded[0].length;
      continue scan;
    }
    break;
  }
  // A trailing separator belongs to the prose, not to the number: "refs 1,
  // 234" is three references and the comma is punctuation.
  while (end > digit && /[.,]/.test(text[end - 1]!)) end -= 1;
  return { start, end, credit, ambiguous };
}

/** A currency marker one space to the left of the token, which is how a
 * column prints one. Only a code this store supports counts, or "TAX 1.30"
 * would take `TAX` for a currency and refuse the line's only amount. */
function withSpacedCurrency(text: string, start: number): number {
  const spaced = /([A-Z]{3}|[$€£¥₹₩]) $/.exec(
    text.slice(Math.max(0, start - 4), start),
  );
  if (!spaced) return start;
  const marker = spaced[1]!;
  if (marker.length === 3 && !SUPPORTED_CURRENCY_SET.has(marker)) return start;
  const from = start - spaced[0].length;
  if (/[A-Za-z]/.test(text[from - 1] ?? "")) return start;
  return from;
}

/** Whether the span so far carries a currency marker -- a symbol, or a code
 * standing as its own word. */
function carriesCurrency(token: string): boolean {
  for (let at = 0; at < token.length; at += 1) {
    if (CURRENCY_SYMBOL_CHARS.has(token[at]!)) return true;
    if (
      !/[A-Za-z]/.test(token[at - 1] ?? "") &&
      currencyCodeAt(token, at) > 0
    ) {
      return true;
    }
  }
  return false;
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
  /([A-Za-z]{3,9})\.?[\s-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s-]+'?(\d{4}|\d{2})(?!\d)/g;
/** `1 September 2026`, `1st Sep. 2026`. */
const DAY_FIRST_DATE =
  /(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+'?(\d{4}|\d{2})(?!\d)/g;

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
    return iso ? { kind: "date", iso } : { kind: "none" };
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
    return iso ? { kind: "date", iso } : { kind: "none" };
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
      return iso ? { kind: "date", iso } : { kind: "none" };
    }
  }

  const dayFirst =
    /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+'?(\d{4}|\d{2})(?!\d)/.exec(
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
  cited: ReadonlyArray<{ id: number; text: string; start: number; end: number }>,
  valueType: DocumentFieldValueType,
): Candidate[] {
  const candidates: Candidate[] = cited.map((line) => ({
    text: line.text,
    start: line.start,
    end: line.end,
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

  const firstMatch = (predicate: (text: string) => boolean): number =>
    candidates.findIndex((candidate) => predicate(candidate.text));

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
      const at = firstMatch((text) => amountInQuote(amount, text));
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
      const iso = realIsoDate(literal)
        ? literal
        : (() => {
            const printed = readPrintedDate(literal, input.dateOrder);
            return printed.kind === "date" ? printed.iso : printed.kind;
          })();
      if (iso === "ambiguous") return fail("date_ambiguous");
      if (iso === "none") return fail("date_unparsable");
      const at = firstMatch((text) => dateInQuote(iso, text, input.dateOrder));
      if (at < 0) return fail("value_not_in_quote");
      return { ok: true, values: [{ type: "date", value: iso }], support: [at] };
    }
    case "number": {
      // Through `parseAmount`, not a bare canonicalize: a percentage prints as
      // `3,5%` in half the world, and stripping its separators outright turned
      // three and a half into thirty-five.
      const canonical = parseAmount(literal.replace(/%/g, ""));
      if (canonical === undefined) return fail("number_unparsable");
      const at = firstMatch((text) => amountInQuote(canonical, text));
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
      const at = firstMatch((text) => foldTextForMatch(text).includes(folded));
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
  cited: ReadonlyArray<{ id: number; text: string; start: number; end: number }>;
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
    amountInQuote(amount, candidate.text),
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
