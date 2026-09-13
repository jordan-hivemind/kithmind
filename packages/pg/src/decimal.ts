// Exact base-10 decimal arithmetic for quantities, prices and rates.
//
// Every value is a sign, an unscaled BigInt and a base-10 scale. Binary
// floating point never appears: no parseFloat, no Number, no REAL column.
// Cash amounts do not live here. They are integer minor units (see the finance
// archive's money.ts).
//
// It lives in `@repo/pg` (P2-39a) because `numeric.ts` beside it is what every
// NUMERIC write in either schema is validated through, and that validation is
// canonicalization: splitting the two would either duplicate the parser or
// leave the shared validator depending on one caller's package.

export type Decimal = {
  /** Signed integer value of the digits, ignoring the decimal point. */
  readonly unscaled: bigint;
  /** Number of digits after the decimal point. Always >= 0. */
  readonly scale: number;
};

/** Accepted on input: optional sign, optional leading zeros, optional fraction. */
const DECIMAL_INPUT = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/**
 * The canonical form, which is what the archive stores and what row_hash
 * hashes over:
 *
 * - a single leading `-` for negatives, never `+`,
 * - no leading zeros, except the single `0` before a decimal point,
 * - no trailing decimal point,
 * - no trailing zeros in the fraction, so one number has one spelling,
 * - zero is always `0`, never `-0` or `0.00`.
 */
const CANONICAL_DECIMAL = /^(?:0|-?(?:0\.\d*[1-9]|[1-9]\d*(?:\.\d*[1-9])?))$/;

/** Largest scale accepted, so a hostile string cannot allocate a huge BigInt. */
const MAX_SCALE = 40;
const MAX_DIGITS = 80;

export function isCanonicalDecimal(text: string): boolean {
  return CANONICAL_DECIMAL.test(text);
}

export function parseDecimal(text: string): Decimal {
  const match = DECIMAL_INPUT.exec(text);
  const whole = match?.[2] ?? "";
  const fraction = match?.[3] ?? "";
  if (!match || whole.length + fraction.length === 0) {
    throw new TypeError("decimal must be a base-10 number without exponent");
  }
  if (
    fraction.length > MAX_SCALE ||
    whole.length + fraction.length > MAX_DIGITS
  ) {
    throw new RangeError("decimal has more digits than the archive accepts");
  }
  const digits = BigInt(`${whole || "0"}${fraction}`);
  return normalize({
    unscaled: match[1] === "-" ? -digits : digits,
    scale: fraction.length,
  });
}

/** Drops trailing fraction zeros so equal numbers have equal representations. */
function normalize(value: Decimal): Decimal {
  let { unscaled, scale } = value;
  if (unscaled === 0n) return { unscaled: 0n, scale: 0 };
  while (scale > 0 && unscaled % 10n === 0n) {
    unscaled /= 10n;
    scale -= 1;
  }
  return { unscaled, scale };
}

export function formatDecimal(value: Decimal): string {
  const { unscaled, scale } = normalize(value);
  const sign = unscaled < 0n ? "-" : "";
  const digits = (unscaled < 0n ? -unscaled : unscaled)
    .toString()
    .padStart(scale + 1, "0");
  if (scale === 0) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** Parses any accepted spelling and returns the one canonical spelling. */
export function canonicalizeDecimal(text: string): string {
  return formatDecimal(parseDecimal(text));
}

/** Rescales both operands to a shared scale so they can be compared exactly. */
function align(
  a: Decimal,
  b: Decimal,
): { left: bigint; right: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return {
    left: a.unscaled * 10n ** BigInt(scale - a.scale),
    right: b.unscaled * 10n ** BigInt(scale - b.scale),
    scale,
  };
}

export function addDecimal(a: string, b: string): string {
  const { left, right, scale } = align(parseDecimal(a), parseDecimal(b));
  return formatDecimal({ unscaled: left + right, scale });
}

export function subtractDecimal(a: string, b: string): string {
  const { left, right, scale } = align(parseDecimal(a), parseDecimal(b));
  return formatDecimal({ unscaled: left - right, scale });
}

export function negateDecimal(a: string): string {
  const value = parseDecimal(a);
  return formatDecimal({ unscaled: -value.unscaled, scale: value.scale });
}

/** Exact product, used for quantity times price. Scales add, nothing rounds. */
export function multiplyDecimal(a: string, b: string): string {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  return formatDecimal({
    unscaled: left.unscaled * right.unscaled,
    scale: left.scale + right.scale,
  });
}

/** Returns -1, 0 or 1. Differing scales compare by value, not by spelling. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const { left, right } = align(parseDecimal(a), parseDecimal(b));
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
