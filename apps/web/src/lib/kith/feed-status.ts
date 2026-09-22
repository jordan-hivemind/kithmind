// FIN-STATUS-1: the Institutions screen's Status column, from the Plaid feed
// alone. See docs/plans/2026-09-22-simplification-and-feeds.md.
//
// This replaces `accountFreshness`'s status/statusDetail for that one column.
// `accountFreshness` still runs (`institutions.ts` still wants its cadence
// and expected-by-date for the account drawer), but its `status` and
// `statusDetail` are never read again: that function's "needs_review" branch
// exists to report an unpriced holding or a reconciliation mismatch, and the
// owner's retiring both checks from this screen. Those checks still run
// where the Needs Attention screen reads them (`attention-data.ts`, a
// separate read against `FinanceReviewItem`), untouched by this file.
//
// Pure, like every rule file in this directory: a function of the dates and
// flags a caller already holds, nothing invented here.

/** What the Institutions screen's Status column can say. Five states, and
 * only five -- there is no "needs review" here any more. */
export type FeedStatus = "fresh" | "stale" | "needs_relink" | "inactive" | "no_feed";

/** Days old a feed snapshot can be and still read as current. The owner
 * pulls daily; two days covers one missed or late pull without reading a
 * one-day-stale account as a problem. */
export const FEED_FRESH_DAYS = 2;

/** How long an archive-only account (no feed link at all) can go without a
 * record before it reads as inactive rather than merely unlinked. A year is
 * long enough that a dormant CD or an annual statement account is not
 * mistaken for one nobody is watching any more. */
export const FEED_INACTIVE_DAYS = 365;

export type FeedStatusInput = {
  /** The archive's own closed flag (the owner's override, or the archive's
   * own record when there is no override) -- never inferred. Wins over
   * every feed signal: there is nothing to relink or watch on an account the
   * owner marked closed. */
  archiveClosed: boolean;
  /** The archive's own most recent record for this account -- the latest
   * of its activity, statement balance and holdings observation dates.
   * Null when the archive holds nothing for it at all. Read only when there
   * is no feed link; a linked account's freshness comes from the feed. */
  archiveLastRecordAsOf: string | null;
  /** Whether `kith.fin_accounts` carries an active Plaid account link
   * (`plaid_account_id` set) for this account -- not merely a
   * `fin_accounts` row, which `import-archive` can also create with no
   * Plaid link at all. */
  feedLinked: boolean;
  /** `kith.plaid_items.needs_relink_at`, carried onto the linked
   * `fin_accounts` row. Ignored unless `feedLinked`. */
  needsRelinkAt: string | null;
  /** The latest `source = 'plaid'` balance or holdings snapshot date for
   * this account. Never an archive-sourced row that happens to be newer
   * (`import-archive` backfilling a statement): that is statement data, not
   * a live feed reading, and must not read as a fresh feed. Null when the
   * feed has never reported one, including the account linked but not yet
   * pulled. Ignored unless `feedLinked`. */
  latestFeedSnapshotAsOf: string | null;
};

/**
 * One account's Status, from the feed alone.
 *
 * | Case | Status |
 * | --- | --- |
 * | archive marks the account closed | inactive |
 * | no feed link, archive record within the last year | no_feed |
 * | no feed link, archive record older or absent | inactive |
 * | feed linked, item needs re-authentication | needs_relink |
 * | feed linked, no feed snapshot has arrived yet | stale |
 * | feed linked, latest feed snapshot within 2 days | fresh |
 * | feed linked, latest feed snapshot older than 2 days | stale |
 */
export function feedStatus(input: FeedStatusInput, now: number): FeedStatus {
  if (input.archiveClosed) return "inactive";
  if (!input.feedLinked) {
    return input.archiveLastRecordAsOf !== null &&
      daysSince(input.archiveLastRecordAsOf, now) <= FEED_INACTIVE_DAYS
      ? "no_feed"
      : "inactive";
  }
  if (input.needsRelinkAt !== null) return "needs_relink";
  if (input.latestFeedSnapshotAsOf === null) return "stale";
  return daysSince(input.latestFeedSnapshotAsOf, now) <= FEED_FRESH_DAYS
    ? "fresh"
    : "stale";
}

/** The tooltip behind a Status tag: only what the feed and the archive's own
 * closed/last-record facts say, never a valuation or reconciliation
 * finding -- there is none in this input to leak. */
export function feedStatusDetail(
  status: FeedStatus,
  input: FeedStatusInput,
  now: number,
): string {
  switch (status) {
    case "needs_relink":
      return input.needsRelinkAt === null
        ? "Plaid needs re-authentication"
        : `Plaid needs re-authentication since ${input.needsRelinkAt.slice(0, 10)}`;
    case "fresh":
      return input.latestFeedSnapshotAsOf === null
        ? "feed current"
        : `feed updated ${input.latestFeedSnapshotAsOf}`;
    case "stale":
      return input.latestFeedSnapshotAsOf === null
        ? "linked; no feed snapshot yet"
        : `feed last updated ${input.latestFeedSnapshotAsOf}, ${daysSince(input.latestFeedSnapshotAsOf, now)} days ago`;
    case "no_feed":
      return input.archiveLastRecordAsOf === null
        ? "no Plaid link; no archive record"
        : `no Plaid link; last archive record ${input.archiveLastRecordAsOf}`;
    case "inactive":
      if (input.archiveClosed) return "marked closed";
      return input.archiveLastRecordAsOf === null
        ? "no archive record"
        : `no archive record since ${input.archiveLastRecordAsOf}`;
  }
}

/** Worst first, for an institution header's own tag: an owner scanning the
 * list should see the one account that needs relinking before the three that
 * are merely quiet. `no_feed` outranks `inactive` -- an unlinked account with
 * recent archive activity is more worth the owner's attention than one gone
 * quiet or closed -- and `fresh` is never the worst of anything. */
const STATUS_SEVERITY: readonly FeedStatus[] = [
  "needs_relink",
  "stale",
  "no_feed",
  "inactive",
  "fresh",
];

const STATUS_LABEL: Record<FeedStatus, string> = {
  fresh: "fresh",
  stale: "stale",
  needs_relink: "needs relink",
  inactive: "inactive",
  no_feed: "no feed",
};

/** An institution's status: the worst of its accounts'. `fresh` when there
 * are no accounts to be worse -- an empty group reports nothing wrong. */
export function worstFeedStatus(statuses: readonly FeedStatus[]): FeedStatus {
  for (const candidate of STATUS_SEVERITY) {
    if (statuses.includes(candidate)) return candidate;
  }
  return "fresh";
}

/** The header row's tooltip: how many accounts sit at each status, worst
 * first. Null only when there are no accounts at all. */
export function aggregateFeedStatusDetail(
  statuses: readonly FeedStatus[],
): string | null {
  if (statuses.length === 0) return null;
  const counts = new Map<FeedStatus, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return STATUS_SEVERITY.filter((status) => counts.has(status))
    .map((status) => `${counts.get(status)} ${STATUS_LABEL[status]}`)
    .join(", ");
}

function daysSince(date: string, now: number): number {
  return Math.floor(
    Math.max(now - Date.parse(`${date}T00:00:00Z`), 0) / (24 * 60 * 60 * 1000),
  );
}
