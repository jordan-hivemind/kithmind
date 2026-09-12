// The deduplication contract. Overlapping pages from a paginated activity API
// are normal and a naive import double-counts, so every transaction carries a
// row_hash over account, process date, activity type, description, quantity,
// amount and an occurrence ordinal. A provider transaction ID is preferred
// where one exists and is stable; this hash is the fallback.
//
// The hash is built on canonical forms only. An unstable spelling of the same
// number would silently break dedupe, which is why decimal.ts pins one spelling
// per value and why the amount carries the currency that gives its minor units
// a scale.
//
// `occurrence` exists because equal date, amount and description is not proof
// of duplication: two legitimately identical transactions must hash
// differently, while the same transaction reappearing on an overlapping page
// must hash the same. The importer resolves that by counting, per source
// document and in document order, how many times a given content has been
// seen so far, and hashing that count as a field rather than disambiguating
// a collision after the fact (which would make row_hash stop being a hash of
// the row's content, and would make the "row_hash is unique" invariant
// vacuous). See packages/finance-archive/src/importer.ts.

import { createHash } from "node:crypto";

import { canonicalizeDecimal } from "./decimal.js";
import { currencyExponent } from "./money.js";
import { toNumericText } from "./pgNumeric.js";

/** v1: the amount field is minor units. See ROW_HASH_DOMAIN_V2 below. */
export const ROW_HASH_DOMAIN = "kith-finance-row:v1\0";

export type RowHashInput = {
  accountId: string;
  /** ISO YYYY-MM-DD. */
  processDate: string;
  activityType: string;
  description: string;
  /** Canonical decimal text, or null where the source states no quantity. */
  quantity: string | null;
  /** Minor units, or null where the amount is ambiguous and under review. */
  amount: bigint | null;
  currency: string;
  /**
   * 1-indexed: how many times this exact content (every field above) has
   * already been seen within the current source document, in document
   * order, including this row. The first occurrence of any content is 1.
   */
  occurrence: number;
};

/** `RowHashInput` minus the occurrence ordinal: the content an occurrence counts over. */
export type RowContent = Omit<RowHashInput, "occurrence">;

/**
 * Collapses runs of whitespace and trims. PDF text extraction varies the gaps
 * inside a description between runs; the words are the identity.
 */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The key an occurrence ordinal counts over: every `rowHash` input field
 * except the ordinal itself, normalized the same way `rowHash` normalizes
 * them. Shared by the importer (which counts per document while inserting)
 * and the adapter-import wiring (which needs the same count ahead of time,
 * to check a paginated pull's row count without inserting anything) so the
 * two never drift into computing "how many times has this been seen" two
 * different ways.
 */
export function contentKey(row: RowContent): string {
  return [
    row.accountId,
    row.processDate,
    normalizeText(row.activityType).toLowerCase(),
    normalizeText(row.description),
    row.quantity ?? "-",
    row.amount === null ? "-" : row.amount.toString(),
    row.currency,
  ].join(" ");
}

/** Length prefixes so no field can impersonate a field boundary. */
function field(value: string | null): string {
  return value === null ? "-" : `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function assertOccurrence(occurrence: number): void {
  if (!Number.isInteger(occurrence) || occurrence < 1) {
    throw new RangeError(
      `rowHash: occurrence must be an integer >= 1, got ${JSON.stringify(occurrence)}; ` +
        "omitting it hashes undefined into its own namespace and silently breaks deduplication",
    );
  }
}

function digest(domain: string, parts: readonly string[]): string {
  return createHash("sha256")
    .update(domain + parts.join("\0"), "utf8")
    .digest("hex");
}

export function rowHash(input: RowHashInput): string {
  assertOccurrence(input.occurrence);
  currencyExponent(input.currency);
  return digest(ROW_HASH_DOMAIN, [
    field(input.accountId),
    field(input.processDate),
    field(normalizeText(input.activityType).toLowerCase()),
    field(normalizeText(input.description)),
    field(input.quantity === null ? null : canonicalizeDecimal(input.quantity)),
    field(input.amount === null ? null : input.amount.toString()),
    field(input.currency),
    field(String(input.occurrence)),
  ]);
}

// ---------------------------------------------------------------------------
// v2: the preimage under a decimal amount representation.
//
// The preimage is versioned rather than quietly changed. v1 meant one thing
// and still does; nothing reinterprets a v1 hash as a v2 one.
//
//   v1 amount field: the minor-unit integer at the currency's exponent, as
//     produced by `toMinorUnits`. USD 12.34 hashed as "1234".
//   v2 amount field: the stated amount in canonical decimal form, as produced
//     by `toNumericText`. USD 12.34 hashes as "12.34".
//
// The mapping between them is exactly `fromMinorUnits(amount, currency)`,
// which is total and, for a fixed currency, injective. So two rows share a v1
// hash if and only if they share a v2 hash: the identities the archive
// deduplicates on are the same set before and after the move. That is the
// property `test/pgMoney.test.mjs` asserts over a synthetic row set, along
// with the matching property for `contentKey`/`contentKeyV2`: the ordinal a
// row is assigned is unchanged by the move, because the key partitions the
// same rows the same way.
//
// Canonicalization is what makes this safe, and skipping it is how the
// archive would start double-counting: `1`, `1.0` and `1.00` are one amount
// and must be one identity, so the amount is canonicalized before it is
// hashed rather than hashed as the source spelled it.
//
// Everything else about the preimage is unchanged, including the occurrence
// ordinal and its validation. The ordinal is what lets one formula both
// collapse an overlapping paginated page and keep two legitimately identical
// transactions in one document apart, and it is still a hashed field rather
// than a suffix appended after the fact.
// ---------------------------------------------------------------------------

export const ROW_HASH_DOMAIN_V2 = "kith-finance-row:v2\0";

export type RowHashInputV2 = Omit<RowHashInput, "amount"> & {
  /**
   * The stated amount as decimal text in `currency`, or null where the amount
   * is ambiguous and under review. Never a number, and never minor units.
   */
  amount: string | null;
};

/** `RowHashInputV2` minus the ordinal: the content an occurrence counts over. */
export type RowContentV2 = Omit<RowHashInputV2, "occurrence">;

/** The v2 counterpart of `contentKey`, so the two never drift apart. */
export function contentKeyV2(row: RowContentV2): string {
  return [
    row.accountId,
    row.processDate,
    normalizeText(row.activityType).toLowerCase(),
    normalizeText(row.description),
    row.quantity === null ? "-" : canonicalizeDecimal(row.quantity),
    row.amount === null ? "-" : toNumericText(row.amount),
    row.currency,
  ].join(" ");
}

export function rowHashV2(input: RowHashInputV2): string {
  assertOccurrence(input.occurrence);
  currencyExponent(input.currency);
  return digest(ROW_HASH_DOMAIN_V2, [
    field(input.accountId),
    field(input.processDate),
    field(normalizeText(input.activityType).toLowerCase()),
    field(normalizeText(input.description)),
    field(input.quantity === null ? null : canonicalizeDecimal(input.quantity)),
    field(input.amount === null ? null : toNumericText(input.amount)),
    field(input.currency),
    field(String(input.occurrence)),
  ]);
}

// ---------------------------------------------------------------------------
// F1-49: positions, balances and liabilities. Each stated holding gets its own
// content identity, the same reason a transaction does -- a rerun of the same
// statement pull, or a document reprocessed for some other reason (a parse
// note that never clears, or a sibling row sent to review), must match its
// own already-stored holdings instead of inserting a second copy.
//
// Unlike a transaction, a holding has no occurrence ordinal: a statement
// states one quantity for one instrument as of one date, not the same fact
// twice, so there is no legitimate reason for two holdings in one document to
// share every field below. And unlike a transaction, the field set is
// per-table, over exactly the columns that make a *stated* holding the same
// holding -- not `price` or `unrealized`, which are derived from `quantity`
// and `market_value`/`cost_basis` and would make a revalued but otherwise
// identical holding register as two facts instead of one holding whose
// valuation was corrected.
//
// Each domain is versioned the same way `ROW_HASH_DOMAIN`/`_V2` are, so a
// later change to a preimage is a new domain, never a silent reinterpretation
// of hashes already stored.
// ---------------------------------------------------------------------------

export const POSITION_HASH_DOMAIN = "kith-finance-position:v1\0";
export const BALANCE_HASH_DOMAIN = "kith-finance-balance:v1\0";
export const LIABILITY_HASH_DOMAIN = "kith-finance-liability:v1\0";

export type PositionHashInput = {
  accountId: string;
  instrumentId: string | null;
  /** ISO YYYY-MM-DD. */
  asOf: string;
  quantity: string | null;
  marketValue: string | null;
  costBasis: string | null;
  valuationBasis: string | null;
};

/** account, instrument (or null), as_of, quantity, market value, cost basis,
 * valuation basis: the fields that make a stated position the same position. */
export function positionHash(input: PositionHashInput): string {
  return digest(POSITION_HASH_DOMAIN, [
    field(input.accountId),
    field(input.instrumentId),
    field(input.asOf),
    field(input.quantity === null ? null : canonicalizeDecimal(input.quantity)),
    field(
      input.marketValue === null ? null : canonicalizeDecimal(input.marketValue),
    ),
    field(
      input.costBasis === null ? null : canonicalizeDecimal(input.costBasis),
    ),
    field(input.valuationBasis),
  ]);
}

export type BalanceHashInput = {
  accountId: string;
  /** ISO YYYY-MM-DD. */
  asOf: string;
  totalValue: string | null;
  cash: string | null;
};

/** account, as_of, total value, cash: the fields that make a stated balance
 * snapshot the same snapshot. */
export function balanceHash(input: BalanceHashInput): string {
  return digest(BALANCE_HASH_DOMAIN, [
    field(input.accountId),
    field(input.asOf),
    field(
      input.totalValue === null ? null : canonicalizeDecimal(input.totalValue),
    ),
    field(input.cash === null ? null : canonicalizeDecimal(input.cash)),
  ]);
}

export type LiabilityHashInput = {
  accountId: string | null;
  kind: string;
  /** ISO YYYY-MM-DD. */
  asOf: string;
  balance: string | null;
};

/** account, kind, as_of, balance: the fields that make a stated liability the
 * same liability. */
export function liabilityHash(input: LiabilityHashInput): string {
  return digest(LIABILITY_HASH_DOMAIN, [
    field(input.accountId),
    field(normalizeText(input.kind).toLowerCase()),
    field(input.asOf),
    field(input.balance === null ? null : canonicalizeDecimal(input.balance)),
  ]);
}
