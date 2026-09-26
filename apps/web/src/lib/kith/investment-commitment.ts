// The commitment as a property of the investment.
//
// The owner reads a commitment as a fact about the investment, not an event
// in its ledger, so the screen shows and edits it on the Edit investment
// drawer and leaves it out of the expanded entries. Storage is unchanged: it
// is still the investment's `commitment` entry, because the totals
// (`committed`, `outstanding`, over-called) are computed from entries in one
// SQL aggregation and a second home for the same number would drift.
//
// This file decides which single entry write, if any, makes the stored
// commitment match what the drawer holds.

import type { admin } from "@repo/kith-store";

type Entry = Pick<
  admin.InvestmentEntry,
  "id" | "entryType" | "amount" | "currency" | "dateIsEstimated" | "entryDate"
>;

/** The one entry type the drawer owns rather than the ledger. A
 * `commitment_change` stays in the ledger: it is an event with its own date. */
export const COMMITMENT_ENTRY_TYPE = "commitment";

/** The investment's base commitment entry, or null when it has none or more
 * than one (the drawer cannot edit a sum of several rows safely). */
export function commitmentEntry<T extends Pick<Entry, "entryType">>(
  entries: readonly T[],
): T | null {
  const commitments = entries.filter(
    (entry) => entry.entryType === COMMITMENT_ENTRY_TYPE,
  );
  return commitments.length === 1 ? commitments[0]! : null;
}

/** Numerically equal decimal strings ("25000" and "25000.00"). */
function sameAmount(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const [whole = "0", fraction = ""] = value.trim().split(".");
    const trimmed = fraction.replace(/0+$/, "");
    return `${whole.replace(/^0+(?=\d)/, "")}${trimmed ? `.${trimmed}` : ""}`;
  };
  return normalize(left) === normalize(right);
}

export type CommitmentWrite =
  | { method: "POST"; body: Record<string, unknown> }
  | { method: "PATCH"; body: Record<string, unknown> }
  | { method: "DELETE"; body: { entryId: string } };

/**
 * The write that brings the stored commitment to `amount`, or null when none
 * is needed or when the drawer cannot express the change safely.
 *
 * - No commitment entry and an amount: create one, dated the signed date when
 *   there is one, else today and marked estimated.
 * - One commitment entry: change its amount, or delete it when the amount is
 *   cleared. An estimated date moves to a newly known signed date.
 * - Two or more commitment entries: null. Their sum has no single row to
 *   edit, and guessing one would rewrite money the owner entered.
 */
export function commitmentWrite(input: {
  entries: readonly Entry[];
  amount: string;
  currency: string;
  signedOn: string | null;
  today: string;
}): CommitmentWrite | null {
  const commitments = input.entries.filter(
    (entry) => entry.entryType === COMMITMENT_ENTRY_TYPE,
  );
  const amount = input.amount.trim();
  if (commitments.length === 0) {
    if (amount === "") return null;
    return {
      method: "POST",
      body: {
        entryType: "commitment",
        entryDate: input.signedOn ?? input.today,
        amount,
        currency: input.currency,
        dateIsEstimated: input.signedOn === null,
      },
    };
  }
  if (commitments.length > 1) return null;
  const entry = commitments[0]!;
  if (amount === "") return { method: "DELETE", body: { entryId: entry.id } };
  const patch: Record<string, unknown> = {};
  if (!sameAmount(entry.amount, amount)) patch.amount = amount;
  if (
    entry.dateIsEstimated &&
    input.signedOn !== null &&
    input.signedOn !== entry.entryDate
  ) {
    patch.entryDate = input.signedOn;
    patch.dateIsEstimated = false;
  }
  if (Object.keys(patch).length === 0) return null;
  return { method: "PATCH", body: { entryId: entry.id, ...patch } };
}
