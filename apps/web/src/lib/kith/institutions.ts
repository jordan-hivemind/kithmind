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
  type StatementCadence,
  valueIsStale,
} from "@/lib/kith/account-freshness";
import {
  aggregateFeedStatusDetail,
  type FeedStatus,
  feedStatus,
  feedStatusDetail,
  type FeedStatusInput,
  worstFeedStatus,
} from "@/lib/kith/feed-status";
import { mergeFinanceAccountOverride } from "@/lib/kith/finance-account-overrides";

/**
 * What the Status column can say, from the Plaid feed alone
 * (`feed-status.ts`): fresh, stale, needing a relink, inactive, or archived
 * with no feed link. `accountFreshness`'s own statement/holdings freshness
 * (`FreshnessReason` below) still describes the archive's own cadence for
 * the account drawer; it no longer decides this column.
 */
export type InstitutionStatus = FeedStatus;

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
  /**
   * FIN-5: the account's name before any owner rename, when it differs from
   * `name` -- the archive's own name for an archive-linked account, or
   * `kith.fin_accounts.name` (the feed's own name) for a Plaid-only one.
   * Null when there is nothing to show beside `name` at all: a group row, or
   * an account with no owner rename in effect. A reader shows it as a
   * tooltip or muted secondary text, never as the row's own label.
   */
  feedName: string | null;
  /**
   * FIN-5: `kith.fin_accounts.id`, set only on a Plaid-only child (`id` on
   * that row is `plaid:<accountId>`, prefixed for uniqueness against an
   * archive account id in the same table). This is what a Rename action
   * writes `display_name` to; an archive-linked row's Rename writes
   * `kith.finance_account_overrides` instead, keyed by `id` itself. Null on
   * every other row.
   */
  finAccountId: string | null;
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
   * cadence (an archive value), or older than the feed's own 2-day freshness
   * window (a feed value), so the screen shows its date beside it and mutes
   * it rather than letting it read as today's. See `valueIsStale`. */
  currentValueStale: boolean;
  /**
   * FIN-1: whether `currentValue` (and `latestHoldingsObservedAsOf`, when it
   * came from the same place) is a `kith.fin_accounts` reading or the
   * archive's own parsed statement figure -- the small source indicator
   * beside the value. Null when there is no value at all. See
   * `mergeLiveAccounts`.
   */
  valueSource: "feed" | "statement" | null;
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
  /** The archive's own closed flag (the owner's override, or the archive's
   * record when there is none), carried separately from `status` so a feed
   * merge can tell "closed" apart from every other reason an unlinked
   * account reads `inactive`. False on a group and on a Plaid-only child,
   * which have no archive record to be closed in. */
  archiveClosed: boolean;
  /** No archive content and no feed value at all -- the row the "Hide empty
   * accounts" toggle removes. Never true for a Plaid-only child: that row is
   * the one place the owner sees a feed-only account at all. */
  empty: boolean;
  status: InstitutionStatus;
  /** The reasoning behind the status, for the tooltip. Null only when there
   * are no accounts to report on (an institution header with none). */
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
    // Still computed for `cadence`/`freshnessReason`/`expectedBy`, which the
    // account drawer shows as the archive's own statement rhythm. Its
    // `status`/`statusDetail` are not read below: that is the one place this
    // function can report an unpriced holding or a failed reconciliation,
    // and the Status column no longer reads either from the archive at all
    // (`feedStatus` below). A `needs_review` reason code can still land in
    // `freshnessReason`, so it is blanked rather than passed through -- nothing
    // on this screen renders that field today, but nothing should ever have to
    // remember that rule to stay compliant.
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
    const archiveClosed = shownAccount.closed === true;
    const archiveCurrentValue =
      record.currentValue === undefined
        ? null
        : Number(record.currentValue.value.decimal);
    const archiveCurrentValueAsOf = record.currentValue?.asOf ?? null;
    const latestHoldingsObservedAsOf =
      record.latestHoldingsObservation?.asOf ??
      record.latestSnapshotAsOf ??
      null;
    const latestBalanceAsOf = record.balanceDates?.[0] ?? null;
    // The archive's own last record of any kind, for the "no feed link, no
    // record in 12 months" branch of `feedStatus` -- read only when there is
    // no feed link at all, so a linked account's freshness never depends on
    // this.
    const archiveLastRecordAsOf = later(
      later(record.activityTo ?? null, latestBalanceAsOf),
      latestHoldingsObservedAsOf,
    );
    const status = feedStatus(
      {
        archiveClosed,
        archiveLastRecordAsOf,
        feedLinked: false,
        needsRelinkAt: null,
        latestFeedSnapshotAsOf: null,
      },
      now,
    );
    const child: InstitutionRow = {
      id: record.account.accountId,
      name: shownName,
      institutionName: record.account.institutionName,
      accountName: shownName,
      // Only when the owner's rename actually replaced the archive's own
      // name on screen -- an unrenamed account has nothing to show beside
      // its one name.
      feedName: shownName === archiveName ? null : archiveName,
      finAccountId: null,
      accountLast4,
      archive: {
        name: archiveName,
        accountLast4: record.account.accountLast4 ?? null,
        accountType: record.account.accountType ?? null,
      },
      override,
      last4Reason: accountLast4 === null ? last4Reason(record.account) : null,
      currentValue: archiveCurrentValue,
      currentValueCurrency: record.currentValue?.value.currency ?? null,
      currentValueAsOf: archiveCurrentValueAsOf,
      currentValueStale: valueIsStale(
        archiveCurrentValueAsOf,
        now,
        judged.cadence,
      ),
      valueSource: archiveCurrentValue === null ? null : "statement",
      accountType: shownAccount.accountType ?? null,
      accounts: null,
      statements: record.statementCount,
      records: record.recordCount,
      activityFrom: record.activityFrom ?? null,
      activityTo: record.activityTo ?? null,
      latestSnapshotAsOf: record.latestSnapshotAsOf ?? null,
      latestHoldingsObservedAsOf,
      latestBalanceAsOf,
      cadence: judged.cadence,
      freshnessReason: judged.status === "needs_review" ? null : judged.reason,
      expectedBy: judged.expectedBy,
      openReviews: record.openReviewCount,
      archiveClosed,
      empty: !hasContent && archiveCurrentValue === null,
      status,
      statusDetail: feedStatusDetail(
        status,
        {
          archiveClosed,
          archiveLastRecordAsOf,
          feedLinked: false,
          needsRelinkAt: null,
          latestFeedSnapshotAsOf: null,
        },
        now,
      ),
    };
    const name = record.account.institutionName;
    const group = groups.get(name) ?? {
      id: name,
      name,
      institutionName: name,
      accountName: null,
      feedName: null,
      finAccountId: null,
      accountLast4: null,
      archive: null,
      override: null,
      last4Reason: null,
      currentValue: null,
      currentValueStale: false,
      currentValueCurrency: null,
      currentValueAsOf: null,
      valueSource: null,
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
      archiveClosed: false,
      empty: false,
      status: "no_feed" as InstitutionStatus,
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
      ...groupValue(group),
      ...groupStatus(group),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * An institution header's Status: the worst of its accounts' (item 4,
 * `worstFeedStatus` in `feed-status.ts`), and a tooltip counting how many
 * sit at each one. Called both here (the archive-only baseline, before any
 * feed is merged in) and again by `mergeLiveAccounts` once a linked
 * account's status can change -- a group built before the merge is not
 * re-read afterward, so its own status has to be recomputed, not carried
 * over from a `groupInstitutions` call that ran first.
 */
function groupStatus(group: InstitutionRow): {
  status: InstitutionStatus;
  statusDetail: string | null;
} {
  const statuses = (group.children ?? []).map((child) => child.status);
  return {
    status: worstFeedStatus(statuses),
    statusDetail: aggregateFeedStatusDetail(statuses),
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
 * Live means every status but `inactive` -- `fresh`, `stale`, `needs_relink`
 * and `no_feed` all still describe an account the archive or the feed holds
 * a current figure for. An `inactive` account -- closed, or quiet past the
 * threshold -- is not in the sum: its last figure is the day it went quiet,
 * which is not what the institution is worth now, and its own row still
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
 * An account with no archive content and no feed link (`empty`) never blocks:
 * it has no record at all, so `feedStatus` reads it `inactive` -- nothing to
 * have left out -- and the table hides it by default for the same reason.
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
  const live = children.filter((child) => child.status !== "inactive");
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
// FIN-1/FIN-STATUS-1: feed values, feed status and Plaid-only accounts
// (migration 048_finance_unify.sql, docs/plans/2026-09-22-simplification-
// and-feeds.md)
// ---------------------------------------------------------------------------

/** An account row's merged latest figure: its latest balance snapshot, or (a
 * depository-style account Plaid never balances, only holdings) its latest
 * holdings snapshot total -- across both sources `kith.fin_accounts` can
 * carry (`import-archive`'s statement backfill and `pull`'s daily feed), so
 * this can be the more recent of the two whichever it is. Neither present is
 * "no figure yet". `source` is the source that won, for the value's own
 * feed/statement indicator. */
function mergedValueOf(row: admin.FinAccountRow): {
  value: number | null;
  currency: string | null;
  asOf: string | null;
  source: "archive" | "plaid" | null;
} {
  if (row.currentBalance !== null) {
    return {
      value: row.currentBalance,
      currency: row.currency,
      asOf: row.balanceAsOf,
      source: row.balanceSource,
    };
  }
  if (row.holdingsValue !== null) {
    return {
      value: row.holdingsValue,
      currency: row.currency,
      asOf: row.holdingsAsOf,
      source: row.holdingsSource,
    };
  }
  return { value: null, currency: null, asOf: null, source: null };
}

/** The latest balance or holdings snapshot the Plaid feed itself reported
 * for this account -- `source = 'plaid'` rows only. An `import-archive`
 * backfill can be the newer row in `mergedValueOf` above without the feed
 * having reported anything recently, and Status must judge the feed's own
 * freshness, not the ledger's newest row regardless of source. */
function latestPlaidSnapshotAsOf(row: admin.FinAccountRow): string | null {
  const dates = [
    row.balanceSource === "plaid" ? row.balanceAsOf : null,
    row.holdingsSource === "plaid" ? row.holdingsAsOf : null,
  ].filter((date): date is string => date !== null);
  return dates.length === 0 ? null : dates.sort().at(-1)!;
}

/** A linked child's Status inputs, from the `fin_accounts` row its archive
 * account matched (or none, for a not-yet-merged baseline). */
function feedStatusInputFor(
  fin: admin.FinAccountRow | undefined,
  archiveClosed: boolean,
  archiveLastRecordAsOf: string | null,
): FeedStatusInput {
  const feedLinked = fin !== undefined && fin.plaidAccountId !== null;
  return {
    archiveClosed,
    archiveLastRecordAsOf,
    feedLinked,
    needsRelinkAt: feedLinked ? fin!.needsRelinkAt : null,
    latestFeedSnapshotAsOf: feedLinked ? latestPlaidSnapshotAsOf(fin!) : null,
  };
}

/** The archive's own last record for `child` -- its most recent activity,
 * statement balance or holdings observation date, from the fields
 * `groupInstitutions` already set on it (never a merged-in feed date). Read
 * only for the "no feed link" branch of `feedStatus`. */
function archiveLastRecordOf(child: InstitutionRow): string | null {
  return later(
    later(child.activityTo, child.latestBalanceAsOf),
    child.latestHoldingsObservedAsOf,
  );
}

/** `child` with a matched `kith.fin_accounts` row's feed folded in: Status
 * from the feed (item 2), and Current value/Holdings as of from the feed
 * when the row carries an active Plaid link (item 1) -- otherwise `child`'s
 * own archive value stands, since a `fin_accounts` row `import-archive`
 * alone created is not "linked to a feed account". */
function withFeedAccount(
  child: InstitutionRow,
  fin: admin.FinAccountRow,
  now: number,
): InstitutionRow {
  const input = feedStatusInputFor(fin, child.archiveClosed, archiveLastRecordOf(child));
  const status = feedStatus(input, now);
  const statusDetail = feedStatusDetail(status, input, now);
  const feedLinked = fin.plaidAccountId !== null;
  const merged = mergedValueOf(fin);
  const hasFeedValue = feedLinked && merged.value !== null;
  return {
    ...child,
    status,
    statusDetail,
    currentValue: hasFeedValue ? merged.value : child.currentValue,
    currentValueCurrency: hasFeedValue ? merged.currency : child.currentValueCurrency,
    currentValueAsOf: hasFeedValue ? merged.asOf : child.currentValueAsOf,
    currentValueStale: hasFeedValue ? status !== "fresh" : child.currentValueStale,
    valueSource: hasFeedValue
      ? merged.source === "plaid"
        ? "feed"
        : "statement"
      : child.valueSource,
    latestHoldingsObservedAsOf:
      feedLinked && fin.holdingsAsOf !== null
        ? fin.holdingsAsOf
        : child.latestHoldingsObservedAsOf,
    empty: hasFeedValue ? false : child.empty,
  };
}

/** A `kith.fin_accounts` row with no archive counterpart yet, as its own
 * account row under its institution's group -- a new group when the
 * institution has no archive presence at all (Vanguard, Fidelity, Chase).
 * Always feed-linked by construction (the caller filters to
 * `plaidAccountId !== null`), so every value and every snapshot date on it
 * is the feed's own. */
function plaidOnlyChild(row: admin.FinAccountRow, now: number): InstitutionRow {
  const input = feedStatusInputFor(row, false, null);
  const status = feedStatus(input, now);
  const merged = mergedValueOf(row);
  return {
    id: `plaid:${row.accountId}`,
    name: row.accountName,
    institutionName: row.institutionName,
    accountName: row.accountName,
    // FIN-5: `row.accountName` is already `displayName ?? feedName`
    // (`admin.listFinAccounts`); show the feed's own name beside it only
    // when an owner rename actually replaced it on screen.
    feedName: row.accountName === row.feedName ? null : row.feedName,
    finAccountId: row.accountId,
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
    currentValue: merged.value,
    currentValueCurrency: merged.currency,
    currentValueAsOf: merged.asOf,
    currentValueStale: status !== "fresh",
    valueSource: merged.value === null ? null : "feed",
    archive: null,
    override: null,
    last4Reason: null,
    archiveClosed: false,
    // Never true: an "empty" account is hidden by the screen's default "Hide
    // empty accounts" toggle, and a Plaid-only account is exactly the row
    // that toggle must not hide -- it is the one place the owner sees it at
    // all, whatever its feed status is.
    empty: false,
    status,
    statusDetail: feedStatusDetail(status, input, now),
  };
}

function emptyPlaidOnlyGroup(institutionName: string): InstitutionRow {
  return {
    id: institutionName,
    name: institutionName,
    institutionName,
    accountName: null,
    feedName: null,
    finAccountId: null,
    accountLast4: null,
    archive: null,
    override: null,
    last4Reason: null,
    currentValue: null,
    currentValueStale: false,
    currentValueCurrency: null,
    currentValueAsOf: null,
    valueSource: null,
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
    archiveClosed: false,
    empty: false,
    status: "fresh",
    statusDetail: null,
    children: [],
  };
}

/**
 * The archive's institution groups (`groupInstitutions`'s own result), with
 * `kith.fin_accounts`' feed folded in.
 *
 * Three things happen here, all keyed off `admin.listFinAccounts`' rows:
 *
 *   - An account linked to the archive (`archiveAccountId` set) gets its
 *     Status recomputed from the feed, and its Current value/Holdings as of
 *     replaced by the feed's own reading when the row is also Plaid-linked
 *     (`withFeedAccount`).
 *   - An account with no archive counterpart (`archiveAccountId === null`,
 *     Plaid-only) becomes its own child row, under its institution's
 *     existing group when there is one or a new group when there is not --
 *     so the owner sees every linked account in one table, not two.
 *   - Every institution header is recomputed from its final children (value
 *     sum, latest as-of, worst status, item 4): a header built by
 *     `groupInstitutions` before this function ran does not know about any
 *     feed yet, and a child's status or value can change above.
 *
 * Pure, like the rest of this file: a function of `groupInstitutions`'s
 * output, the read `finAccounts` rows and `now`, nothing else.
 */
export function mergeLiveAccounts(
  groups: readonly InstitutionRow[],
  finAccounts: readonly admin.FinAccountRow[],
  now: number,
): InstitutionRow[] {
  const liveByArchiveId = new Map(
    finAccounts
      .filter((row) => row.archiveAccountId !== null)
      .map((row) => [row.archiveAccountId!, row]),
  );
  const merged: InstitutionRow[] = groups.map((group) => ({
    ...group,
    children: (group.children ?? []).map((child) => {
      const fin = liveByArchiveId.get(child.id);
      return fin === undefined ? child : withFeedAccount(child, fin, now);
    }),
  }));

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
    group.children = [...(group.children ?? []), plaidOnlyChild(fin, now)];
  }

  return merged
    .map((group) => {
      const withLatestHoldings = {
        ...group,
        latestHoldingsObservedAsOf: (group.children ?? []).reduce(
          (asOf, child) => later(asOf, child.latestHoldingsObservedAsOf),
          null as string | null,
        ),
      };
      return {
        ...withLatestHoldings,
        ...groupValue(withLatestHoldings),
        ...groupStatus(withLatestHoldings),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}
