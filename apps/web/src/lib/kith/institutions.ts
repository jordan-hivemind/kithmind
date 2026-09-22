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
import type { admin } from "@repo/kith-store";

import {
  accountFreshness,
  type FreshnessReason,
  type FreshnessStatus,
  type StatementCadence,
  valueIsStale,
} from "@/lib/kith/account-freshness";
import { mergeFinanceAccountOverride } from "@/lib/kith/finance-account-overrides";

/**
 * What a statement archive can be: holding nothing, gone quiet (closed or
 * dormant, nothing to file), live but behind on statements or holdings, or
 * current. The rule is `accountFreshness` in `account-freshness.ts`.
 */
export type InstitutionStatus = FreshnessStatus;

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
  latestHoldingsObservedAsOf: string | null;
  /** The account's latest statement balance date. Never merged with
   * `latestSnapshotAsOf`: a balance says a statement arrived, a snapshot says
   * its holdings were recorded. On a group, the latest of its accounts'. */
  latestBalanceAsOf: string | null;
  /** The statement cadence the archive's balance dates show. Null on a group. */
  cadence: StatementCadence | null;
  /** Why the account has its status. Null on a group. */
  freshnessReason: FreshnessReason | null;
  /** When the next statement becomes overdue, an expectation and not data.
   * Null when none is expected, and on a group. */
  expectedBy: string | null;
  openReviews: number;
  /** The account's latest reported value in `currentValueCurrency`, dated
   * `currentValueAsOf`. On a group: the sum of its live accounts, and null
   * unless every one of them has a value in one shared currency, dated by the
   * oldest of them. See `groupValue`. */
  currentValue: number | null;
  currentValueCurrency: string | null;
  currentValueAsOf: string | null;
  /** The figure is older than the account's dormancy threshold for its
   * cadence, so the screen shows its date beside it and mutes it rather than
   * letting it read as today's. See `valueIsStale`. */
  currentValueStale: boolean;
  /**
   * FIN-1: the account's latest value from `kith.fin_accounts` -- the
   * latest Plaid balance snapshot, or (for a depository account Plaid never
   * reports a balance for, only holdings) the latest holdings snapshot
   * total -- for whichever of this account's rows is linked to a Plaid
   * account. `null` for an archive-only account nothing links to yet. See
   * `mergeLiveAccounts`.
   */
  liveValue: number | null;
  liveValueCurrency: string | null;
  liveAsOf: string | null;
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
  const found = account.disclosures.find(
    (item) => item.field === "accountLast4",
  );
  return found === undefined ? null : LAST4_REASON[found.reason];
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
    const hasContent =
      record.statementCount + record.recordCount > 0 ||
      record.latestHoldingsObservation !== undefined;
    const override = overrides.get(record.account.accountId) ?? null;
    const shownAccount = mergeFinanceAccountOverride(
      record.account,
      override === null
        ? undefined
        : { accountId: record.account.accountId, ...override },
    );
    const archiveName = friendlyAccountName(record.account);
    const shownName =
      shownAccount.ownerOverride?.displayName ??
      friendlyAccountName(record.account);
    const accountLast4 = shownAccount.accountLast4 ?? null;
    const judged = accountFreshness(
      {
        hasContent,
        closed: shownAccount.closed === true,
        accountType: shownAccount.accountType ?? null,
        activityTo: record.activityTo ?? null,
        latestSnapshotAsOf: record.latestSnapshotAsOf ?? null,
        latestHoldingsObservation: record.latestHoldingsObservation,
        balanceDates: record.balanceDates ?? [],
        latestBalanceHoldsSecurities:
          record.latestBalanceHoldsSecurities ?? null,
      },
      now,
    );
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
      currentValueStale: valueIsStale(
        record.currentValue?.asOf ?? null,
        now,
        judged.cadence,
      ),
      // Filled in by `mergeLiveAccounts` for an account a `kith.fin_accounts`
      // row links to; every archive account starts with none.
      liveValue: null,
      liveValueCurrency: null,
      liveAsOf: null,
      accountType: shownAccount.accountType ?? null,
      accounts: null,
      statements: record.statementCount,
      records: record.recordCount,
      activityFrom: record.activityFrom ?? null,
      activityTo: record.activityTo ?? null,
      latestSnapshotAsOf: record.latestSnapshotAsOf ?? null,
      latestHoldingsObservedAsOf:
        record.latestHoldingsObservation?.asOf ??
        record.latestSnapshotAsOf ??
        null,
      latestBalanceAsOf: record.balanceDates?.[0] ?? null,
      cadence: judged.cadence,
      freshnessReason: judged.reason,
      expectedBy: judged.expectedBy,
      openReviews: record.openReviewCount,
      status: judged.status,
      statusDetail: judged.statusDetail,
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
      currentValueStale: false,
      currentValueCurrency: null,
      currentValueAsOf: null,
      liveValue: null,
      liveValueCurrency: null,
      liveAsOf: null,
      accountType: null,
      accounts: 0,
      statements: 0,
      records: 0,
      activityFrom: null,
      activityTo: null,
      latestSnapshotAsOf: null,
      latestHoldingsObservedAsOf: null,
      latestBalanceAsOf: null,
      cadence: null,
      freshnessReason: null,
      expectedBy: null,
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
    group.latestHoldingsObservedAsOf = later(
      group.latestHoldingsObservedAsOf,
      child.latestHoldingsObservedAsOf,
    );
    group.latestBalanceAsOf = later(
      group.latestBalanceAsOf,
      child.latestBalanceAsOf,
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
 * The stale accounts are counted by reason, because "statement overdue" and
 * "holdings behind" call for different actions (fetch a statement, or repair
 * what reads one), and a group that said only "2 stale" would hide which.
 *
 * No `now` of its own: each child already carries the tag `accountFreshness`
 * gave it against the same clock, so re-deriving here could only disagree
 * with the row beneath it.
 */
const STALE_REASON_LABEL: Partial<Record<FreshnessReason, string>> = {
  statement_overdue: "statement overdue",
  holdings_behind: "holdings behind",
  holdings_missing: "holdings missing",
};

function groupFreshness(group: InstitutionRow): {
  status: InstitutionStatus;
  statusDetail: string | null;
} {
  const children = group.children ?? [];
  const needingReview = children.filter(
    (child) => child.status === "needs_review",
  );
  const reviewDetails = needingReview
    .map(
      (child) =>
        `${child.name} (${child.statusDetail ?? "data verification incomplete"})`,
    )
    .join("; ");
  const staleDate = (child: InstitutionRow) =>
    child.freshnessReason === "statement_overdue"
      ? (child.latestBalanceAsOf ?? "")
      : (child.latestHoldingsObservedAsOf ?? "");
  const stale = children
    .filter((child) => child.status === "stale")
    .sort((left, right) => staleDate(left).localeCompare(staleDate(right)));
  if (stale.length > 0) {
    // Always in the label table's order, so the same accounts read the same.
    const breakdown = Object.entries(STALE_REASON_LABEL)
      .map(([reason, label]) => {
        const count = stale.filter(
          (child) => child.freshnessReason === reason,
        ).length;
        return count === 0 ? null : `${count} ${label}`;
      })
      .filter((part) => part !== null)
      .join(", ");
    const oldest = stale[0]!;
    return {
      status: "stale",
      statusDetail: `${stale.length} stale (${breakdown}), oldest ${oldest.name} (${
        oldest.statusDetail ?? ""
      })${needingReview.length > 0 ? `; ${needingReview.length} accounts need review: ${reviewDetails}` : ""}`,
    };
  }
  if (children.every((child) => child.status === "empty")) {
    return { status: "empty", statusDetail: null };
  }

  if (needingReview.length > 0) {
    return {
      status: "needs_review",
      statusDetail: `${needingReview.length} accounts need review: ${needingReview.map((child) => `${child.name} (${child.statusDetail ?? "data verification incomplete"})`).join("; ")}`,
    };
  }
  if (children.every((child) => child.status !== "fresh")) {
    return { status: "inactive", statusDetail: "no recent activity" };
  }
  const fresh = children.filter((child) => child.status === "fresh").length;
  const quiet = children.filter((child) => child.status === "inactive").length;
  return {
    status: "fresh",
    statusDetail: `${fresh} current${quiet > 0 ? `, ${quiet} inactive` : ""}`,
  };
}

const NO_VALUE = {
  currentValue: null,
  currentValueCurrency: null,
  currentValueAsOf: null,
  currentValueStale: false,
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
 * Live means `fresh` or `stale`. An `inactive` account -- closed, or quiet
 * past the threshold -- is not in the sum: its last figure is the day it went
 * quiet, which is not what the institution is worth now, and its own row still
 * shows that figure, dated.
 *
 * But leaving it out of the sum is only honest while it holds nothing. An
 * account can pass the inactivity threshold and still hold money: a CD, an
 * account on quarterly statements, one the owner marked Closed before the
 * balance was moved. Dropping half a million dollars out of a total that still
 * says "the institution's value" is the same silent subtraction this function
 * exists to prevent, so any excluded account with a non-zero value blanks the
 * total instead. A zero and an unvalued excluded account block nothing: there
 * is nothing to have dropped.
 *
 * `empty` accounts never block. The archive holds no statement and no record
 * for them, so there is no value to have left out, and the table hides them by
 * default for the same reason.
 *
 * The date is the OLDEST component's, never the newest. A total dated by its
 * newest part claims every other part was still true that day. The oldest is
 * the honest answer: no part of this figure is older than this. The total is
 * stale when any part of it is stale, each part judged against its own
 * account's cadence: a quarterly account's quarter-end figure is not stale on
 * the day a monthly one's would be.
 */
function groupValue(group: InstitutionRow): {
  currentValue: number | null;
  currentValueCurrency: string | null;
  currentValueAsOf: string | null;
  currentValueStale: boolean;
} {
  const children = group.children ?? [];
  const live = children.filter(
    (child) =>
      child.status === "fresh" ||
      child.status === "stale" ||
      child.status === "needs_review",
  );
  if (live.length === 0) return { ...NO_VALUE };
  if (
    live.some(
      (child) => child.currentValue === null || child.currentValueAsOf === null,
    )
  )
    return { ...NO_VALUE };
  const held = children.some(
    (child) =>
      child.status === "inactive" &&
      child.currentValue !== null &&
      child.currentValue !== 0,
  );
  if (held) return { ...NO_VALUE };
  const currencies = new Set(live.map((child) => child.currentValueCurrency));
  if (currencies.size !== 1) return { ...NO_VALUE };
  const asOf = live.map((child) => child.currentValueAsOf!).sort()[0]!;
  return {
    currentValue: live.reduce((sum, child) => sum + child.currentValue!, 0),
    currentValueCurrency: live[0]!.currentValueCurrency,
    currentValueAsOf: asOf,
    currentValueStale: live.some((child) => child.currentValueStale),
  };
}

// ---------------------------------------------------------------------------
// FIN-1: live values and Plaid-only accounts (migration 048_finance_unify.sql)
// ---------------------------------------------------------------------------

/** An account row's live figure: its latest balance snapshot, or (a
 * depository-style account Plaid never balances, only holdings) its latest
 * holdings snapshot total. Neither present is "no live figure yet". */
function liveValueOf(row: admin.FinAccountRow): {
  value: number | null;
  currency: string | null;
  asOf: string | null;
} {
  if (row.currentBalance !== null) {
    return { value: row.currentBalance, currency: row.currency, asOf: row.balanceAsOf };
  }
  if (row.holdingsValue !== null) {
    return { value: row.holdingsValue, currency: row.currency, asOf: row.holdingsAsOf };
  }
  return { value: null, currency: null, asOf: null };
}

/** A `kith.fin_accounts` row with no archive counterpart yet, as its own
 * account row under its institution's group -- a new group when the
 * institution has no archive presence at all (Vanguard, Fidelity, Chase). */
function plaidOnlyChild(row: admin.FinAccountRow): InstitutionRow {
  const live = liveValueOf(row);
  return {
    id: `plaid:${row.accountId}`,
    name: row.accountName,
    institutionName: row.institutionName,
    accountName: row.accountName,
    accountLast4: row.mask,
    accountType: row.subtype ?? row.type,
    accounts: null,
    statements: 0,
    records: 0,
    activityFrom: null,
    activityTo: null,
    latestSnapshotAsOf: null,
    latestHoldingsObservedAsOf: row.holdingsAsOf,
    latestBalanceAsOf: row.balanceAsOf,
    cadence: null,
    freshnessReason: null,
    expectedBy: null,
    openReviews: 0,
    currentValue: null,
    currentValueCurrency: null,
    currentValueAsOf: null,
    currentValueStale: false,
    liveValue: live.value,
    liveValueCurrency: live.currency,
    liveAsOf: live.asOf,
    archive: null,
    override: null,
    last4Reason: null,
    // "fresh" rather than "empty": an "empty" account is hidden by the
    // screen's default "Hide empty accounts" toggle, and a Plaid-only
    // account is exactly the row that toggle must not hide -- it is the one
    // place the owner sees it at all.
    status: "fresh",
    statusDetail: "Plaid feed only; no statement archive account yet",
  };
}

function emptyPlaidOnlyGroup(institutionName: string): InstitutionRow {
  return {
    id: institutionName,
    name: institutionName,
    institutionName,
    accountName: null,
    accountLast4: null,
    archive: null,
    override: null,
    last4Reason: null,
    currentValue: null,
    currentValueStale: false,
    currentValueCurrency: null,
    currentValueAsOf: null,
    liveValue: null,
    liveValueCurrency: null,
    liveAsOf: null,
    accountType: null,
    accounts: 0,
    statements: 0,
    records: 0,
    activityFrom: null,
    activityTo: null,
    latestSnapshotAsOf: null,
    latestHoldingsObservedAsOf: null,
    latestBalanceAsOf: null,
    cadence: null,
    freshnessReason: null,
    expectedBy: null,
    openReviews: 0,
    status: "fresh",
    statusDetail: null,
    children: [],
  };
}

/**
 * The archive's institution groups (`groupInstitutions`'s own result), with
 * `kith.fin_accounts`' live figures folded in.
 *
 * Two things happen here, both keyed off `admin.listFinAccounts`' rows:
 *
 *   - An account linked to the archive (`archiveAccountId` set) fills in
 *     that same child row's `liveValue`/`liveValueCurrency`/`liveAsOf`.
 *   - An account with no archive counterpart (`archiveAccountId === null`,
 *     Plaid-only) becomes its own child row, under its institution's
 *     existing group when there is one or a new group when there is not --
 *     so the owner sees every linked account in one table, not two.
 *
 * Pure, like the rest of this file: a function of `groupInstitutions`'s
 * output and the read `finAccounts` rows, nothing else.
 */
export function mergeLiveAccounts(
  groups: readonly InstitutionRow[],
  finAccounts: readonly admin.FinAccountRow[],
): InstitutionRow[] {
  const liveByArchiveId = new Map(
    finAccounts
      .filter((row) => row.archiveAccountId !== null)
      .map((row) => [row.archiveAccountId!, row]),
  );
  const merged: InstitutionRow[] = groups.map((group) => {
    const children = (group.children ?? []).map((child) => {
      const fin = liveByArchiveId.get(child.id);
      if (fin === undefined) return child;
      const live = liveValueOf(fin);
      return {
        ...child,
        liveValue: live.value,
        liveValueCurrency: live.currency,
        liveAsOf: live.asOf,
      };
    });
    return { ...group, children };
  });

  const byInstitution = new Map<string, InstitutionRow>(
    merged.map((group) => [group.name, group]),
  );
  for (const fin of finAccounts) {
    if (fin.archiveAccountId !== null || fin.plaidAccountId === null) continue;
    let group = byInstitution.get(fin.institutionName);
    if (group === undefined) {
      group = emptyPlaidOnlyGroup(fin.institutionName);
      byInstitution.set(fin.institutionName, group);
      merged.push(group);
    }
    group.accounts = (group.accounts ?? 0) + 1;
    group.children = [...(group.children ?? []), plaidOnlyChild(fin)];
  }

  return merged.sort((left, right) => left.name.localeCompare(right.name));
}
