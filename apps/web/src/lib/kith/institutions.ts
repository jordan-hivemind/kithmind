// ADM-2, screen 3 (Institutions): the archive's account inventory as groups
// over their accounts.
//
// Pure. The finance read happens in `admin-data.ts`; everything here is a
// function of the rows it returned plus a `now`, so the grouping rule, the
// masking rule and the freshness rule are all testable without a database, an
// archive or a DOM.
//
// PRIVACY: the account column uses the archive's friendly display name. The
// separate identifier column receives only the four digits the archive chose
// to disclose. The contract never returns a full account number
// (`accounts.acct_last4` is the only account-number field it stores).

import type { FinanceAccountInventoryRecord } from "@repo/finance-contract";

/**
 * What a statement archive can be: holding nothing, gone quiet (closed or
 * dormant, nothing to file), live but behind on statements, or current.
 */
export type InstitutionStatus = "fresh" | "stale" | "inactive" | "empty";

/**
 * A statement is filed monthly or quarterly, so an archive whose latest
 * snapshot is a quarter old is missing a statement rather than merely waiting
 * for one. Same threshold the health screen's finance check uses for
 * `attention`, and deliberately the same number in both places.
 */
const STALE_AFTER_DAYS = 45;
/**
 * An account with no activity of any kind for this long is not waiting on a
 * statement, it has stopped. A quarter plus a month's lag, and the same number
 * the health screen uses for a statement that was never filed.
 */
const INACTIVE_AFTER_DAYS = 100;
const DAY = 24 * 60 * 60 * 1000;

/** The owner's own values for an account, from `kith.finance_account_overrides`. */
export type AccountOverrideValues = {
  displayName: string | null;
  accountLast4: string | null;
  accountType: string | null;
  closed: boolean;
};

export type InstitutionRow = {
  /** Unique across the table: an institution name, or an account id. */
  id: string;
  /** The institution's name on a group row, the account's label on a child. */
  name: string;
  /** The institution that owns an account. Repeated on children only so the
   * UI can give the parent and child rows distinct, unambiguous columns. */
  institutionName: string;
  /** A human-friendly account label. Null for an institution parent row. */
  accountName: string | null;
  /** Only the archive-disclosed last four digits. Null when undisclosed. */
  accountLast4: string | null;
  /** Null on a group row: an institution has no single type. */
  accountType: string | null;
  /** Accounts in the group. Null on a child row. */
  accounts: number | null;
  statements: number;
  records: number;
  activityFrom: string | null;
  activityTo: string | null;
  latestSnapshotAsOf: string | null;
  openReviews: number;
  /** The account's latest reported value in `currentValueCurrency`, dated
   * `currentValueAsOf`. On a group: the sum of its live accounts, and null
   * unless every one of them has a value in one shared currency, dated by the
   * oldest of them. See `groupValue`. */
  currentValue: number | null;
  currentValueCurrency: string | null;
  currentValueAsOf: string | null;
  /** What the archive itself says, and the owner's override of it. On an
   * account row only: the edit panel shows the first as what clearing the
   * second returns to. */
  archive: {
    name: string;
    accountLast4: string | null;
    accountType: string | null;
  } | null;
  override: AccountOverrideValues | null;
  /** Why the last four are missing, in the reader's words. Null when shown,
   * and on a group row. */
  last4Reason: string | null;
  status: InstitutionStatus;
  /** The age behind the status, for the tooltip. Null when there is none. */
  statusDetail: string | null;
  children?: InstitutionRow[];
};

/**
 * Morgan Stanley's site labels accounts "<Category>: <AccountType>". Its "BDA"
 * type code sits on every investment, trust and retirement account, so it
 * tells one account from another no better than nothing does and is dropped.
 */
const BDA_SUFFIX = /:\s*BDA$/i;

/** The archive's account name, without substituting an identifier for it. */
export function friendlyAccountName(
  account: FinanceAccountInventoryRecord["account"],
): string {
  const name = account.displayLabel?.trim().replace(BDA_SUFFIX, "");
  return name || "Unlabeled account";
}

const LAST4_REASON = {
  not_reported: "No statement has printed this account's number yet",
  ambiguous_aliases: "Statements print conflicting numbers for this account",
  unsupported_value: "A statement printed a number in a format we don't read",
} as const;

function last4Reason(
  account: FinanceAccountInventoryRecord["account"],
): string | null {
  if (account.accountLast4 !== undefined) return null;
  const found = account.disclosures.find((item) => item.field === "accountLast4");
  return found === undefined ? null : LAST4_REASON[found.reason];
}

function ageDays(asOf: string | null, now: number): number | null {
  if (asOf === null) return null;
  return Math.floor(Math.max(now - Date.parse(`${asOf}T00:00:00Z`), 0) / DAY);
}

/** One row's tag, plus the age the tooltip explains it with. */
export function freshness(
  latestSnapshotAsOf: string | null,
  hasContent: boolean,
  now: number,
  activityTo: string | null,
  closed = false,
): { status: InstitutionStatus; statusDetail: string | null } {
  if (!hasContent) return { status: "empty", statusDetail: null };
  if (closed) return { status: "inactive", statusDetail: "marked closed" };
  const quiet = ageDays(activityTo, now);
  if (quiet !== null && quiet > INACTIVE_AFTER_DAYS) {
    return {
      status: "inactive",
      statusDetail: `no activity since ${activityTo}, ${quiet} days ago`,
    };
  }
  const age = ageDays(latestSnapshotAsOf, now);
  if (age === null) {
    // Records but no snapshot: a cash account has balances and transactions
    // and never a position. Not stale, and not something to flag.
    return { status: "fresh", statusDetail: "no snapshot" };
  }
  return {
    status: age > STALE_AFTER_DAYS ? "stale" : "fresh",
    statusDetail: `latest holdings statement ${latestSnapshotAsOf}, ${age} days ago`,
  };
}

function earlier(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

function later(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

/**
 * The inventory as one row per institution, each with its accounts beneath.
 *
 * A group's numbers are its accounts' numbers summed and its ranges widened,
 * never a separate read: two reads of the same archive a moment apart could
 * disagree, and a total that does not match the rows under it is worse than no
 * total. Its status is the worst of its accounts', so an institution with one
 * stale account reads stale.
 */
export function groupInstitutions(
  records: readonly FinanceAccountInventoryRecord[],
  now: number,
  overrides: ReadonlyMap<string, AccountOverrideValues> = new Map(),
): InstitutionRow[] {
  const groups = new Map<string, InstitutionRow>();
  for (const record of records) {
    const hasContent = record.statementCount + record.recordCount > 0;
    const override = overrides.get(record.account.accountId) ?? null;
    const archiveName = friendlyAccountName(record.account);
    const shownName = override?.displayName ?? archiveName;
    const accountLast4 =
      override?.accountLast4 ?? record.account.accountLast4 ?? null;
    const child: InstitutionRow = {
      id: record.account.accountId,
      name: shownName,
      institutionName: record.account.institutionName,
      accountName: shownName,
      accountLast4,
      archive: {
        name: archiveName,
        accountLast4: record.account.accountLast4 ?? null,
        accountType: record.account.accountType ?? null,
      },
      override,
      last4Reason: accountLast4 === null ? last4Reason(record.account) : null,
      currentValue:
        record.currentValue === undefined
          ? null
          : Number(record.currentValue.value.decimal),
      currentValueCurrency: record.currentValue?.value.currency ?? null,
      currentValueAsOf: record.currentValue?.asOf ?? null,
      accountType: override?.accountType ?? record.account.accountType ?? null,
      accounts: null,
      statements: record.statementCount,
      records: record.recordCount,
      activityFrom: record.activityFrom ?? null,
      activityTo: record.activityTo ?? null,
      latestSnapshotAsOf: record.latestSnapshotAsOf ?? null,
      openReviews: record.openReviewCount,
      ...freshness(
        record.latestSnapshotAsOf ?? null,
        hasContent,
        now,
        record.activityTo ?? null,
        override?.closed === true,
      ),
    };
    const name = record.account.institutionName;
    const group = groups.get(name) ?? {
      id: name,
      name,
      institutionName: name,
      accountName: null,
      accountLast4: null,
      archive: null,
      override: null,
      last4Reason: null,
      currentValue: null,
      currentValueCurrency: null,
      currentValueAsOf: null,
      accountType: null,
      accounts: 0,
      statements: 0,
      records: 0,
      activityFrom: null,
      activityTo: null,
      latestSnapshotAsOf: null,
      openReviews: 0,
      status: "empty" as InstitutionStatus,
      statusDetail: null,
      children: [],
    };
    group.accounts = (group.accounts ?? 0) + 1;
    group.statements += child.statements;
    group.records += child.records;
    group.openReviews += child.openReviews;
    group.activityFrom = earlier(group.activityFrom, child.activityFrom);
    group.activityTo = later(group.activityTo, child.activityTo);
    group.latestSnapshotAsOf = later(
      group.latestSnapshotAsOf,
      child.latestSnapshotAsOf,
    );
    group.children!.push(child);
    groups.set(name, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      ...groupFreshness(group),
      ...groupValue(group),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * A group's tag is the worst of its accounts', derived from the *oldest*
 * account snapshot rather than the latest one the group's own column shows.
 *
 * Those are different questions and the distinction matters: an institution
 * whose brokerage account was updated last week and whose IRA was last updated
 * two years ago has a recent latest snapshot and a missing statement, and a
 * tag built on the latest would report the first and hide the second. The
 * tooltip names the account behind the tag.
 *
 * No `now` of its own: each child already carries the tag `freshness` gave it
 * against the same clock, so re-deriving here could only disagree with the row
 * beneath it.
 */
function groupFreshness(group: InstitutionRow): {
  status: InstitutionStatus;
  statusDetail: string | null;
} {
  const children = group.children ?? [];
  const stale = children
    .filter((child) => child.status === "stale")
    .sort((left, right) =>
      (left.latestSnapshotAsOf ?? "").localeCompare(
        right.latestSnapshotAsOf ?? "",
      ),
    );
  if (stale.length > 0) {
    const oldest = stale[0]!;
    return {
      status: "stale",
      statusDetail: `${stale.length} stale, oldest ${oldest.name} (${
        oldest.statusDetail ?? ""
      })`,
    };
  }
  if (children.every((child) => child.status === "empty")) {
    return { status: "empty", statusDetail: null };
  }
  if (children.every((child) => child.status !== "fresh")) {
    return { status: "inactive", statusDetail: "no recent activity" };
  }
  return {
    status: "fresh",
    statusDetail:
      group.latestSnapshotAsOf === null
        ? "no snapshot"
        : `latest snapshot ${group.latestSnapshotAsOf}`,
  };
}

const NO_VALUE = {
  currentValue: null,
  currentValueCurrency: null,
  currentValueAsOf: null,
} as const;

/**
 * The sum of a group's live accounts' values, or nothing at all.
 *
 * Nothing at all unless every live account has a value and they are all in
 * one currency. Adding up the accounts that happen to have one and showing
 * the result as the institution's value is the same partial total the archive
 * refuses to build out of half-valued holdings, one level up: the owner reads
 * this figure as what the institution holds, and a total quietly missing an
 * account is worse than an empty cell that makes him open the rows.
 *
 * Live means `fresh` or `stale`. Two kinds of account are left out of both
 * the sum and the requirement, because neither is a gap in what is held now:
 *
 *   * `inactive` -- closed, or quiet past the threshold. Its last figure is
 *     the day it went quiet, which is not what the institution is worth now.
 *     Its own row still shows that figure, dated.
 *   * `empty` -- the archive holds no statement and no record for it, so
 *     there is nothing to have failed to value. The table hides these by
 *     default for the same reason.
 *
 * The date is the OLDEST component's, never the newest. A total dated by its
 * newest part claims every other part was still true that day. The oldest is
 * the honest answer: no part of this figure is older than this.
 */
function groupValue(group: InstitutionRow): {
  currentValue: number | null;
  currentValueCurrency: string | null;
  currentValueAsOf: string | null;
} {
  const live = (group.children ?? []).filter(
    (child) => child.status === "fresh" || child.status === "stale",
  );
  if (live.length === 0) return { ...NO_VALUE };
  if (
    live.some(
      (child) =>
        child.currentValue === null || child.currentValueAsOf === null,
    )
  )
    return { ...NO_VALUE };
  const currencies = new Set(live.map((child) => child.currentValueCurrency));
  if (currencies.size !== 1) return { ...NO_VALUE };
  return {
    currentValue: live.reduce((sum, child) => sum + child.currentValue!, 0),
    currentValueCurrency: live[0]!.currentValueCurrency,
    currentValueAsOf: live
      .map((child) => child.currentValueAsOf!)
      .sort()[0]!,
  };
}
