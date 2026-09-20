import type { FinanceAccountDescriptor } from "@repo/finance-contract";

/** The fields the owner may layer over an archive account. */
export type FinanceAccountOverride = {
  accountId: string;
  displayName: string | null;
  accountLast4: string | null;
  accountType: string | null;
  closed: boolean;
};

/**
 * An account as the web app presents it after the archive contract is checked.
 *
 * `institutionName` remains the statement institution, while `archiveAccount`
 * retains the archive's original account label, last four and type for matching
 * statement wording. The owner's name belongs in the top-level `displayLabel`.
 * `closed` and the two metadata objects are present only when an override row
 * exists, which keeps an untouched archive response unchanged.
 */
export type WebFinanceAccountDescriptor = FinanceAccountDescriptor & {
  closed?: boolean;
  /** Original statement-derived fields, before the owner's overlay. */
  archiveAccount?: {
    displayLabel: string | null;
    accountLast4: string | null;
    accountType: string | null;
  };
  /** The explicit owner values. Null fields mean "use the archive value". */
  ownerOverride?: Omit<FinanceAccountOverride, "accountId">;
};

/** Apply the owner's descriptive fields without mutating the archive row. */
export function mergeFinanceAccountOverride(
  account: FinanceAccountDescriptor,
  override: FinanceAccountOverride | undefined,
): WebFinanceAccountDescriptor {
  if (override === undefined) return account;

  const disclosures =
    override.accountLast4 === null
      ? account.disclosures
      : account.disclosures.filter((item) => item.field !== "accountLast4");

  return {
    ...account,
    disclosures,
    ...(override.displayName === null
      ? {}
      : { displayLabel: override.displayName }),
    ...(override.accountLast4 === null
      ? {}
      : { accountLast4: override.accountLast4 }),
    ...(override.accountType === null
      ? {}
      : { accountType: override.accountType }),
    closed: override.closed,
    archiveAccount: {
      displayLabel: account.displayLabel ?? null,
      accountLast4: account.accountLast4 ?? null,
      accountType: account.accountType ?? null,
    },
    ownerOverride: {
      displayName: override.displayName,
      accountLast4: override.accountLast4,
      accountType: override.accountType,
      closed: override.closed,
    },
  };
}
