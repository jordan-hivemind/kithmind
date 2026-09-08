// Cash amounts. The archive stores them as INTEGER minor units at the ISO 4217
// exponent of the row's own currency: 2 for USD, 0 for JPY, 3 for KWD. That is
// what lets the read-only SQL surface compute an exact total with SUM() without
// a binary float ever existing. Quantities, prices and rates are not amounts;
// they stay canonical decimal text (see decimal.ts).
//
// The rule for any column added later: amounts get summed, prices do not.

import { formatDecimal, parseDecimal, type Decimal } from "./decimal.js";

/**
 * ISO 4217 minor-unit exponents. Deliberately a closed list. An unknown code is
 * an error rather than an assumed 2, because assuming 2 for JPY is exactly the
 * bug this table exists to prevent. Extend it when an institution needs it.
 */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> =
  Object.freeze({
    AUD: 2,
    BHD: 3,
    CAD: 2,
    CHF: 2,
    CNY: 2,
    EUR: 2,
    GBP: 2,
    HKD: 2,
    ILS: 2,
    INR: 2,
    JPY: 0,
    KRW: 0,
    KWD: 3,
    MXN: 2,
    NOK: 2,
    NZD: 2,
    SEK: 2,
    SGD: 2,
    USD: 2,
  });

/** Rounding rules a derived amount may record. Ingested amounts never round. */
export type RoundingRule = "half_even" | "none";

/**
 * The rule for a value derived by conversion, such as amount_base computed from
 * fx_rate. It is recorded on the row (transactions.amount_base_rounding) so a
 * reader can tell a stated amount from a computed one.
 */
export const DERIVED_ROUNDING_RULE: RoundingRule = "half_even";

export type MoneyAmount = {
  /** Minor units at the currency's exponent. */
  readonly amount: bigint;
  readonly currency: string;
};

export function currencyExponent(currency: string): number {
  const exponent = CURRENCY_EXPONENTS[currency];
  if (exponent === undefined) {
    throw new RangeError(`unknown currency ${JSON.stringify(currency)}`);
  }
  return exponent;
}

/**
 * Converts a stated amount to minor units with no rounding at all. A value with
 * more fraction digits than the currency allows is ambiguous money: the caller
 * writes a review_items row and stores NULL, it never rounds the difference
 * away (ground rule 5).
 */
export function toMinorUnits(text: string, currency: string): bigint {
  const exponent = currencyExponent(currency);
  const value = parseDecimal(text);
  if (value.scale > exponent) {
    throw new RangeError(
      `${text} has more precision than ${currency} minor units and would need rounding`,
    );
  }
  return value.unscaled * 10n ** BigInt(exponent - value.scale);
}

/** The inverse: minor units back to the canonical decimal the document stated. */
export function fromMinorUnits(amount: bigint, currency: string): string {
  return formatDecimal({ unscaled: amount, scale: currencyExponent(currency) });
}

/**
 * Rounds a derived value into minor units under a stated rule. Only ever used
 * for a value the archive computed, never for a value a document stated.
 */
export function roundToMinorUnits(
  text: string,
  currency: string,
  rule: RoundingRule = DERIVED_ROUNDING_RULE,
): bigint {
  const exponent = currencyExponent(currency);
  const value = parseDecimal(text);
  if (rule === "none" || value.scale <= exponent)
    return toMinorUnits(text, currency);
  return roundHalfEven(value, exponent);
}

function roundHalfEven(value: Decimal, targetScale: number): bigint {
  const divisor = 10n ** BigInt(value.scale - targetScale);
  const quotient = value.unscaled / divisor;
  const remainder = value.unscaled % divisor;
  const doubled = (remainder < 0n ? -remainder : remainder) * 2n;
  const step = value.unscaled < 0n ? -1n : 1n;
  if (doubled > divisor || (doubled === divisor && quotient % 2n !== 0n)) {
    return quotient + step;
  }
  return quotient;
}

/**
 * The currency-mixing guard. Summing across currencies is never implicit: a
 * total either belongs to one currency or it does not exist. Callers that hold
 * several currencies group by currency and sum each group.
 */
export function sumMinorUnits(amounts: Iterable<MoneyAmount>): MoneyAmount {
  let total: MoneyAmount | undefined;
  for (const entry of amounts) {
    currencyExponent(entry.currency);
    if (total === undefined) {
      total = { amount: entry.amount, currency: entry.currency };
      continue;
    }
    if (total.currency !== entry.currency) {
      throw new TypeError(
        `refusing to total ${total.currency} with ${entry.currency}; group by currency first`,
      );
    }
    total = { amount: total.amount + entry.amount, currency: total.currency };
  }
  if (total === undefined) {
    throw new TypeError(
      "a total needs at least one amount to know its currency",
    );
  }
  return total;
}
