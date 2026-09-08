// The deduplication contract. Overlapping pages from a paginated activity API
// are normal and a naive import double-counts, so every transaction carries a
// row_hash over account, process date, activity type, description, quantity and
// amount. A provider transaction ID is preferred where one exists and is
// stable; this hash is the fallback.
//
// The hash is built on canonical forms only. An unstable spelling of the same
// number would silently break dedupe, which is why decimal.ts pins one spelling
// per value and why the amount carries the currency that gives its minor units
// a scale.

import { createHash } from "node:crypto";

import { canonicalizeDecimal } from "./decimal.js";
import { currencyExponent } from "./money.js";

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
};

/**
 * Collapses runs of whitespace and trims. PDF text extraction varies the gaps
 * inside a description between runs; the words are the identity.
 */
function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Length prefixes so no field can impersonate a field boundary. */
function field(value: string | null): string {
  return value === null ? "-" : `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export function rowHash(input: RowHashInput): string {
  currencyExponent(input.currency);
  const parts = [
    field(input.accountId),
    field(input.processDate),
    field(normalizeText(input.activityType).toLowerCase()),
    field(normalizeText(input.description)),
    field(input.quantity === null ? null : canonicalizeDecimal(input.quantity)),
    field(input.amount === null ? null : input.amount.toString()),
    field(input.currency),
  ];
  return createHash("sha256")
    .update(ROW_HASH_DOMAIN + parts.join("\0"), "utf8")
    .digest("hex");
}
