// Money, quantities, prices and rates under Postgres NUMERIC.
//
// Postgres NUMERIC replaces the split representation SQLite forced on us
// (cash as INTEGER minor units so SUM stayed exact, quantities and prices as
// canonical decimal TEXT so precision survived). One type now does both.
//
// NUMERIC does not make money exact end to end, and no code here may assume
// it does. It gives exact arithmetic and exact aggregation inside the
// database. It does nothing about precision lost *before* insertion: a
// JavaScript `0.1 + 0.2` arrives as 0.30000000000000004 and NUMERIC stores
// that faithfully, damage included.
//
// So the storage-class CHECK constraints SQLite carried do not disappear when
// they stop translating. Their intent -- that a float from a parser cannot be
// silently stored -- moves here, to input validation, which is the only place
// that can see the difference. Decimal input is validated as text before any
// conversion, a JavaScript number is refused outright rather than stringified,
// non-finite values are refused (including all three that NUMERIC itself has:
// NaN, Infinity and -Infinity), and money crosses the driver, JSON and MCP
// boundaries as decimal strings.
//
// Extracted from the finance archive into `@repo/pg` (P2-39a): the brain schema
// lands beside `finance` in the same database and stores money under the same
// NUMERIC policy, and a second copy of this validation is a second place for it
// to drift.

import { canonicalizeDecimal } from "./decimal.js";

/**
 * The typed Kith Mind boundary carries 38 significant digits and 18
 * fractional places. The database columns themselves are NUMERIC with no
 * declared precision or scale, deliberately: NUMERIC(38, 18) would *round* a
 * more precise value into place on insert, which is the silent loss this
 * whole policy exists to prevent. The bound is therefore enforced here, on
 * the way in, where exceeding it is an explicit rejection the caller turns
 * into a review item (ground rule 5: ambiguous money is missing, never
 * inferred).
 */
export const NUMERIC_MAX_DIGITS = 38;
export const NUMERIC_MAX_SCALE = 18;

/**
 * Validates a stated decimal as text and returns the one canonical spelling.
 * Every write of a money, quantity, price or rate value goes through this.
 *
 * Rejects, never rounds: a JavaScript number, a non-finite value, exponent
 * notation, and anything wider than the boundary contract above.
 */
export function toNumericText(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError(
      `finance numeric must be decimal text, got ${typeof value}; ` +
        "a JavaScript number has already lost precision by the time it reaches here",
    );
  }
  const canonical = canonicalizeDecimal(value);
  const [whole = "", fraction = ""] = canonical.replace("-", "").split(".");
  if (fraction.length > NUMERIC_MAX_SCALE) {
    throw new RangeError(
      `${value} has ${fraction.length} fractional digits, past the ${NUMERIC_MAX_SCALE} the ` +
        "typed boundary carries; reject it into review rather than rounding it",
    );
  }
  const significant = (whole === "0" ? "" : whole).length + fraction.length;
  if (significant > NUMERIC_MAX_DIGITS) {
    throw new RangeError(
      `${value} has ${significant} significant digits, past the ${NUMERIC_MAX_DIGITS} the ` +
        "typed boundary carries; reject it into review rather than dropping digits",
    );
  }
  return canonical;
}

/**
 * Validates a NUMERIC value coming back out of the driver and returns its
 * canonical spelling.
 *
 * A `number` here means the driver decoded NUMERIC as binary floating point,
 * which reintroduces exactly the failure NUMERIC was chosen to prevent. That
 * is a hard error, not something to coerce past: by the time it is a number
 * the digits are already gone. See `ARCHIVE_TYPES` in the finance archive's
 * pgStore.ts, which pins NUMERIC to text per connection.
 */
export function fromNumericText(value: unknown): string {
  if (typeof value === "number") {
    throw new TypeError(
      "the driver decoded NUMERIC as a JavaScript number; money must cross the " +
        "driver boundary as decimal text (see ARCHIVE_TYPES)",
    );
  }
  if (typeof value !== "string") {
    throw new TypeError(
      `expected NUMERIC as decimal text, got ${value === null ? "null" : typeof value}`,
    );
  }
  // NUMERIC has three non-finite spellings, not one: Infinity and -Infinity
  // have been accepted since Postgres 14. The finance_numeric domain refuses
  // all three, so seeing one here means the value came from a bare NUMERIC
  // expression rather than a domain column, which is still not a finance value.
  if (value === "NaN" || value === "Infinity" || value === "-Infinity") {
    throw new RangeError(
      `Postgres returned NUMERIC ${value}, which is not a finance value; ` +
        "a non-finite amount is a review item, never a number to carry forward",
    );
  }
  return canonicalizeDecimal(value);
}
