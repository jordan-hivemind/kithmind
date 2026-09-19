// ADM-2: the pure half of screens 1 (Health) and 4 (Coverage).
//
// No database, no clock of its own, no React. Everything here is a function of
// the facts `health.ts` and `areas.ts` read plus a `now` the caller passes, so
// every rule below -- which age is late, which count is a problem, what the
// single line beside a check says -- is testable without a Postgres and is the
// same rule whether it runs in a server component or in a route.
//
// The owner's UI decision is "no explanatory prose in the UI", so a `detail`
// here is a clause, not a sentence: "last pass 4m ago, active", never "The
// watcher last reported four minutes ago, which is within the expected
// interval." A tooltip carries the breakdown, which is why `tooltip` is a
// separate field and not more text appended to `detail`.

import type { AreaCoverageRow } from "./areas.js";
import type { HealthFacts, WatcherFact } from "./health.js";

/**
 * Four words, ordered worst first, and the same four on both screens so one
 * tag legend covers the panel.
 *
 * `unknown` is not a failure: it is what a check says before anything has ever
 * reported to it. Collapsing it into `problem` would make a system that has
 * not run yet look broken, and collapsing it into `ok` would make a system
 * that stopped reporting look healthy.
 */
export const HEALTH_STATUSES = [
  "problem",
  "attention",
  "unknown",
  "not_configured",
  "ok",
] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export type HealthCheck = {
  /** Stable across renders and reads, so the table can key rows on it. */
  id: string;
  name: string;
  status: HealthStatus;
  /** One clause. Empty when there is nothing to say. */
  detail: string;
  /** The breakdown, for the tooltip. Null when there is none. */
  tooltip: string | null;
  lastCheckedAt: number | null;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "4m", "3h", "2d". Coarse on purpose: an age is read, not measured. */
export function humanAge(ms: number): string {
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

function ago(at: number | null, now: number): string {
  return at === null ? "never" : `${humanAge(Math.max(now - at, 0))} ago`;
}

/** The worst of several statuses, by `HEALTH_STATUSES` order. */
export function worstStatus(statuses: readonly HealthStatus[]): HealthStatus {
  let worst: HealthStatus = "ok";
  for (const status of statuses) {
    if (HEALTH_STATUSES.indexOf(status) < HEALTH_STATUSES.indexOf(worst)) {
      worst = status;
    }
  }
  return worst;
}

/**
 * `{ a: 2, b: 1 }` as `a 2, b 1`, biggest first. Empty string for none.
 *
 * The value is optional because `NotReadyReasons` is a `Partial` record: a
 * key present with no count is dropped the same way a zero is.
 */
export function countsLine(
  counts: Readonly<Record<string, number | undefined>>,
): string {
  return Object.entries(counts)
    .filter((entry): entry is [string, number] => (entry[1] ?? 0) > 0)
    .sort(([leftName, left], [rightName, right]) =>
      right - left || leftName.localeCompare(rightName),
    )
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
}

/**
 * One source account's watcher status.
 *
 * A disabled source is `not_configured` rather than a failure: nothing is
 * supposed to be watching it, which is the same rule `inventoryStatus` in
 * `model.ts` applies to the sources screen. A watcher past its
 * `nextExpectedAt` is `problem` because a host that stopped reporting is the
 * one failure on this screen that silently stops ingestion.
 */
function watcherStatus(watcher: WatcherFact, now: number): HealthStatus {
  if (!watcher.enabled) return "not_configured";
  if (watcher.watcherState === null) return "unknown";
  if (watcher.watcherState === "awaiting_heartbeat") return "unknown";
  if (watcher.nextExpectedAt === null) return "unknown";
  return watcher.nextExpectedAt < now ? "problem" : "ok";
}

function watcherCheck(watchers: readonly WatcherFact[], now: number): HealthCheck {
  const watching = watchers.filter((watcher) => watcher.enabled);
  if (watching.length === 0) {
    return {
      id: "documents_watcher",
      name: "Documents watcher",
      status: "not_configured",
      detail: "no enabled source",
      tooltip: null,
      lastCheckedAt: null,
    };
  }
  const status = worstStatus(
    watching.map((watcher) => watcherStatus(watcher, now)),
  );
  const lastSeen = watching
    .map((watcher) => watcher.lastSeenAt)
    .filter((at): at is number => at !== null);
  const lastCheckedAt = lastSeen.length === 0 ? null : Math.max(...lastSeen);
  const late = watching.filter(
    (watcher) => watcherStatus(watcher, now) === "problem",
  ).length;
  const detail = [
    `last pass ${ago(lastCheckedAt, now)}`,
    `${watching.length} watched`,
    ...(late > 0 ? [`${late} overdue`] : []),
  ].join(", ");
  // One line per source: its latest assessment's state, then why items were
  // not ready. These are closed literals (`workers/notReady.ts` forbids
  // interpolating a row value into one), so the tooltip carries no document
  // title, path or id.
  const tooltip = watching
    .map((watcher) => {
      const reasons = countsLine(watcher.notReadyReasons);
      const state = watcher.assessmentState ?? "no pass";
      return `${watcher.name || watcher.sourceAccountId}: ${state}${
        reasons === "" ? "" : ` (${reasons})`
      }`;
    })
    .join("\n");
  return {
    id: "documents_watcher",
    name: "Documents watcher",
    status,
    detail,
    tooltip: tooltip === "" ? null : tooltip,
    lastCheckedAt,
  };
}

/**
 * The brain's own checks, in the order the screen shows them.
 *
 * The finance archive and the database backup are not here: one lives behind a
 * different database's read contract and the other on the owner's machine, so
 * both are appended by the caller that can actually reach them.
 */
export function deriveHealthChecks(
  facts: HealthFacts,
  now: number,
): HealthCheck[] {
  const { index, jobs, review } = facts;
  return [
    watcherCheck(facts.watchers, now),
    {
      id: "search_index",
      name: "Search index",
      // Owing work is not a failure -- a fill runs it down -- but an index
      // that owes more than it covers is not answering searches over the
      // corpus the owner thinks it has.
      status:
        index.eligible === 0
          ? "unknown"
          : index.owed === 0
            ? "ok"
            : index.owed > index.covered
              ? "problem"
              : "attention",
      detail:
        index.eligible === 0
          ? "nothing eligible"
          : `${index.covered} of ${index.eligible} embedded, ${index.owed} owed`,
      tooltip: null,
      lastCheckedAt: null,
    },
    {
      id: "background_jobs",
      name: "Background jobs",
      status:
        jobs.failed > 0
          ? "problem"
          : jobs.overdueQueued > 0
            ? "attention"
            : "ok",
      detail: `${jobs.overdueQueued} overdue, ${jobs.failed} failed in 24h`,
      tooltip:
        jobs.failed === 0 ? null : `failed: ${countsLine(jobs.failedKinds)}`,
      lastCheckedAt: null,
    },
    {
      id: "review_queue",
      name: "Review queue",
      // Queued review is work waiting for a person, never a fault: the whole
      // point of the queue is that a guess was refused in favour of asking.
      status:
        review.pendingBindings + review.fieldDrops > 0 ? "attention" : "ok",
      detail: `${review.pendingBindings + review.fieldDrops} open`,
      tooltip:
        review.pendingBindings + review.fieldDrops === 0
          ? null
          : countsLine({
              "entity bindings": review.pendingBindings,
              "dropped fields": review.fieldDrops,
            }),
      lastCheckedAt: null,
    },
  ];
}

/**
 * The backup check, which has no data and says so.
 *
 * Section 7 of the plan puts the watcher on the owner's own machine, and the
 * dated database backup runs there too: nothing in either database records
 * whether last night's dump succeeded. Rather than leave the row off the
 * screen -- "the UI must show a complete inventory so gaps are visible" -- it
 * is listed as reported from somewhere this app cannot see, with no status to
 * report.
 */
export const BACKUP_CHECK: HealthCheck = {
  id: "database_backup",
  name: "Database backup",
  status: "unknown",
  detail: "reported by the daily check",
  tooltip: null,
  lastCheckedAt: null,
};

/** Screen 4's tag. `empty` is the one the screen exists to show. */
export type CoverageStatus = "empty" | "gaps" | "covered";

/**
 * An area's tag.
 *
 * `empty` is decided on contents, not on configuration: an area with a
 * configured source and nothing ingested through it is still empty, because
 * what the screen answers is "what does the system hold", not "what did
 * someone intend it to hold".
 */
export function coverageStatus(row: AreaCoverageRow): CoverageStatus {
  if (row.documents === 0 && row.records === 0) return "empty";
  return row.gaps > 0 ? "gaps" : "covered";
}

/**
 * The finance archive's freshness, from its latest snapshot date.
 *
 * `null` is "this deployment has no archive configured", which is not an
 * empty archive and must not read as one.
 */
export function financeFreshnessCheck(
  latestSnapshotAsOf: string | null,
  now: number,
  configured = true,
): HealthCheck {
  if (!configured) {
    return {
      id: "finance_archive",
      name: "Finance archive",
      status: "not_configured",
      detail: "not configured",
      tooltip: null,
      lastCheckedAt: null,
    };
  }
  if (latestSnapshotAsOf === null) {
    return {
      id: "finance_archive",
      name: "Finance archive",
      status: "unknown",
      detail: "no snapshot",
      tooltip: null,
      lastCheckedAt: null,
    };
  }
  // A snapshot is dated by the statement it came from, not by when it was
  // imported, so a month-old statement is ordinary and a quarter-old one means
  // a statement was never filed.
  const age = Math.max(now - Date.parse(`${latestSnapshotAsOf}T00:00:00Z`), 0);
  return {
    id: "finance_archive",
    name: "Finance archive",
    status: age > 100 * DAY ? "problem" : age > 45 * DAY ? "attention" : "ok",
    detail: `latest snapshot ${latestSnapshotAsOf}, ${humanAge(age)} old`,
    tooltip: null,
    lastCheckedAt: null,
  };
}
