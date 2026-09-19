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
  /** A number value did not parse to an exact decimal. */
  "number_unparsable",
  /** Line items did not sum to the total stated alongside them. */
  "line_items_mismatch",
  /** The document was longer than the extraction bound, so part was not read. */
  "input_truncated",
  /** The model's output was not the shape the prompt asks for. */
  "malformed_statement",
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
 * An explicit ISO code wins over a symbol, because `$` is ambiguous across
 * several supported currencies and `CAD` is not. A page carrying two different
 * explicit codes states none: guessing between them is exactly the silent
 * wrongness this feature exists to prevent.
 */
export function currencyOnPage(pageText: string): string | undefined {
  const codes = new Set<string>();
  for (const code of SUPPORTED_CURRENCIES) {
    if (new RegExp(`(?<![A-Z])${code}(?![A-Z])`).test(pageText)) codes.add(code);
  }
  if (codes.size === 1) return [...codes][0];
  if (codes.size > 1) return undefined;
  const symbols = new Set<string>();
  for (const [symbol, code] of CURRENCY_SYMBOLS) {
    if (pageText.includes(symbol)) symbols.add(code);
  }
  return symbols.size === 1 ? [...symbols][0] : undefined;
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
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.split(",").join("");
  else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(text)) {
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
    case "money": {
      const amount = parseAmount(literal);
      if (amount === undefined) return fail("money_unparsable");
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
      if (!realIsoDate(literal)) return fail("date_unparsable");
      return { ok: true, values: [{ type: "date", value: literal }] };
    }
    case "number": {
      let canonical: string;
      try {
        canonical = canonicalizeDecimal(
          literal.replace(/[\s,%]/g, "").replace(/^\+/, ""),
        );
      } catch {
        return fail("number_unparsable");
      }
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
