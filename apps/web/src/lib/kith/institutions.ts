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

/** Fresh, stale or empty: the three things a statement archive can be. */
export type InstitutionStatus = "fresh" | "stale" | "empty";

/**
 * A statement is filed monthly or quarterly, so an archive whose latest
 * snapshot is a quarter old is missing a statement rather than merely waiting
 * for one. Same threshold the health screen's finance check uses for
 * `attention`, and deliberately the same number in both places.
 */
const STALE_AFTER_DAYS = 45;
const DAY = 24 * 60 * 60 * 1000;

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
  status: InstitutionStatus;
  /** The age behind the status, for the tooltip. Null when there is none. */
  statusDetail: string | null;
  children?: InstitutionRow[];
};

/** The archive's account name, without substituting an identifier for it. */
export function friendlyAccountName(
  account: FinanceAccountInventoryRecord["account"],
): string {
  return account.displayLabel?.trim() || "Unlabeled account";
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
): { status: InstitutionStatus; statusDetail: string | null } {
  if (!hasContent) return { status: "empty", statusDetail: null };
  const age = ageDays(latestSnapshotAsOf, now);
  if (age === null) {
    // Records but no snapshot: a cash account has balances and transactions
    // and never a position. Not stale, and not something to flag.
    return { status: "fresh", statusDetail: "no snapshot" };
  }
  return {
    status: age > STALE_AFTER_DAYS ? "stale" : "fresh",
    statusDetail: `latest snapshot ${latestSnapshotAsOf}, ${age}d old`,
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
): InstitutionRow[] {
  const groups = new Map<string, InstitutionRow>();
  for (const record of records) {
    const hasContent = record.statementCount + record.recordCount > 0;
    const child: InstitutionRow = {
      id: record.account.accountId,
      name: friendlyAccountName(record.account),
      institutionName: record.account.institutionName,
      accountName: friendlyAccountName(record.account),
      accountLast4: record.account.accountLast4 ?? null,
      accountType: record.account.accountType ?? null,
      accounts: null,
      statements: record.statementCount,
      records: record.recordCount,
      activityFrom: record.activityFrom ?? null,
      activityTo: record.activityTo ?? null,
      latestSnapshotAsOf: record.latestSnapshotAsOf ?? null,
      openReviews: record.openReviewCount,
      ...freshness(record.latestSnapshotAsOf ?? null, hasContent, now),
    };
    const name = record.account.institutionName;
    const group = groups.get(name) ?? {
      id: name,
      name,
      institutionName: name,
      accountName: null,
      accountLast4: null,
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
    .map((group) => ({ ...group, ...groupFreshness(group) }))
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
      statusDetail: `${stale.length} stale, oldest ${oldest.name} ${
        oldest.statusDetail ?? ""
      }`.trim(),
    };
  }
  if (children.every((child) => child.status === "empty")) {
    return { status: "empty", statusDetail: null };
  }
  return {
    status: "fresh",
    statusDetail:
      group.latestSnapshotAsOf === null
        ? "no snapshot"
        : `latest snapshot ${group.latestSnapshotAsOf}`,
  };
}
