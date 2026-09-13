// The position quantity reconciliation gate (F1-17): the validation half of
// holdings, and the position-side analogue of the cash gate in
// reconciliation.ts. Cash compares a stated balance change against summed
// transaction amounts; this compares a stated quantity change against summed
// transaction quantities, per account, per instrument, per period.
//
// Stated holdings are authoritative and are what the archive reports.
// Derived holdings -- quantity replayed from transactions -- are a gate and
// never a second source of truth, so nothing here writes to `positions` and
// nothing here is ever reported as a holding.
//
// Three constraints from the plan keep the gate from failing constantly and
// being ignored, which is the only way a gate really dies:
//
//   1. Anchor on the prior stated position, never on zero. Acquired history
//      rarely reaches an account's opening, so a comparison derived from
//      zero would fail every period forever. Each period is the span between
//      two consecutive stated snapshots for one account and one instrument,
//      paired with LAG, exactly as the cash gate diffs two balance
//      snapshots.
//   2. Quantity only. Cost basis is not gated. Quantity is additive and
//      exactly reconcilable; cost basis depends on lot selection, wash
//      sales, return of capital and provider adjustments, and tax-lot
//      matching is deferred. This file never reads `cost_basis`,
//      `market_value`, `price` or `unrealized`, so there is nothing in it
//      that could fail a period on a basis divergence by mistake.
//   3. Corporate actions fail periods until they are modelled. A split
//      changes quantity with no transaction behind it, so under an exact
//      tolerance those periods fail. That is the gate surfacing a modelling
//      gap, not absorbing one. There is deliberately no heuristic here that
//      guesses at a split.
//
// Tolerance is exact zero, the same owner decision the cash gate already
// applies, and it is recorded on every row -- passing or not -- so a later
// loosening cannot silently reinterpret an old pass.
//
// Quantities are NUMERIC, which sums exactly in Postgres and crosses the
// driver as decimal text (pgStore.ts pins that decoding). Every comparison
// here goes through the exact base-10 helpers, so no quantity is ever a float
// at any point: no parseFloat, no Number, no binary arithmetic.

import { randomUUID } from "node:crypto";

import { compareDecimal, subtractDecimal } from "./decimal.js";
import { fromNumericText } from "./pgNumeric.js";
import {
  type ArchiveClient,
  insertRows,
  lockArchiveForWrite,
  withArchiveTransaction,
} from "./pgStore.js";
import type { ReconciliationStatus } from "./reconciliation.js";

/**
 * How much history is missing for one account, measured rather than
 * tolerated: the account has a stated position dated before the earliest
 * transaction the archive holds, so the periods before that point cannot be
 * checked at all. Bounded by account count, never by row count.
 */
export type PositionCoverageGap = {
  accountId: string;
  /** as_of of the earliest stated position for the account. */
  firstStatedPositionAsOf: string;
  /** Earliest acquired transaction, or null when none was acquired at all. */
  transactionHistoryStartsAt: string | null;
  /** Periods this gap left unverified. */
  periodsUnverified: number;
};

/**
 * Counts and coverage, never a row (see the plan's "Working on the archive
 * without reading it"). Per-period verdicts live in
 * `position_reconciliations`; a consumer finds everything needing attention
 * with `WHERE status != 'pass'` rather than through this return value.
 */
export type PositionReconciliationGateSummary = {
  periodsChecked: number;
  passed: number;
  failed: number;
  unverified: number;
  accountsChecked: number;
  instrumentsChecked: number;
  coverageGaps: readonly PositionCoverageGap[];
};

/**
 * One (account, instrument, date) an import actually inserted a row at
 * (F1-59). `date` is `positions.as_of` for a stated snapshot and
 * `transactions.process_date` for activity.
 */
export type PositionChange = {
  accountId: string;
  instrumentId: string;
  date: string;
};

/**
 * What one import changed, as the importer itself observed it: the rows it
 * inserted, never a table scan. Passing it runs the gate incrementally --
 * only the periods that import could have moved -- instead of over the whole
 * archive. See `runPositionReconciliationGate`.
 */
export type PositionGateScope = {
  /** `positions` rows this import inserted. */
  snapshots: readonly PositionChange[];
  /** `transactions` rows this import inserted that name an instrument. */
  activity: readonly PositionChange[];
};

/** Canonical decimal text. The gate's tolerance policy: exact zero. */
const TOLERANCE = "0";

/** The column order the batched verdict INSERT binds its tuples in. */
const VERDICT_COLUMNS = [
  "id",
  "account_id",
  "instrument_id",
  "period_start",
  "period_end",
  "expected_change",
  "computed_change",
  "delta",
  "tolerance",
  "status",
  "notes",
] as const;

type PositionPairRow = {
  account_id: string;
  instrument_id: string;
  as_of: string;
  quantity: string | null;
  prev_as_of: string;
  prev_quantity: string | null;
};

type PeriodResult = {
  status: ReconciliationStatus;
  expectedChange: string | null;
  computedChange: string | null;
  delta: string | null;
  notes: string | null;
};

/** What the archive holds for one account, read once and reused per period. */
type AccountHistory = {
  earliestTransaction: string | null;
  firstStatedPositionAsOf: string | null;
};

/**
 * Runs the position gate over every account and instrument with two or more
 * stated `positions` snapshots, writing one `position_reconciliations` row
 * per period (period boundaries are consecutive snapshot dates for that
 * account and instrument; the window between them is half-open,
 * `(period_start, period_end]`, matching the cash gate).
 * Re-running replaces any prior row for the same account, instrument and
 * period, so it is idempotent after a corrected import. It also deletes any
 * row for a period that no longer exists at all -- archive-wide with no
 * `scope`, or within `scope`'s own series with one (F1-72) -- so a document
 * collapse or account re-attribution that changes the window set cannot
 * leave the old windows' verdicts behind counting toward every reader's
 * failure totals.
 *
 * A position with no `instrument_id` has no identity to pair snapshots on
 * and is skipped; such a row is already an unidentified holding rather than
 * something this gate can check.
 *
 * Like the cash gate, this is one transaction that joins the caller's when
 * there is one, so `publishImport` publishes rows and both verdicts together.
 *
 * F1-59. With no `scope` this is the whole-archive pass, run once at the end
 * of an operator run. With one it checks only the periods that import could
 * have moved (see `scopedPairs`) and writes the same rows for them, which is
 * what keeps a per-document gate proportional to the document rather than to
 * the archive. Either way the work is batched: a pass costs a fixed handful
 * of round trips instead of four per period.
 *
 * When `importRunId` is given, that run's counters are incremented and a
 * note is appended. `unverified` counts toward `reconciliations_failed`, as
 * it does for cash: neither is a clean pass and `import_runs` has no third
 * bucket. The note is appended rather than replaced so running both gates
 * against one import run does not lose the cash gate's note.
 */
export async function runPositionReconciliationGate(
  client: ArchiveClient,
  importRunId?: string,
  scope?: PositionGateScope,
): Promise<PositionReconciliationGateSummary> {
  return withArchiveTransaction(client, async () => {
    await lockArchiveForWrite(client);

    const scoped = scope === undefined ? undefined : await scopedPairs(client, scope);
    const pairs =
      scope === undefined
        ? (await client.query<PositionPairRow>(pairSql(""))).rows
        : scoped!.pairs;

    // F1-59. Everything the loop below needs is fetched before it, in a
    // fixed number of round trips rather than four per period: the archive
    // is hosted, so a gate's cost is messages, not rows. The verdict logic
    // itself is unchanged -- same inputs, same comparisons, same notes.
    const histories = await accountHistories(client, pairs);
    const computed = await sumQuantityWindows(client, pairs);

    const gapPeriods = new Map<string, number>();
    const accounts = new Set<string>();
    const instruments = new Set<string>();
    let passed = 0;
    let failed = 0;
    let unverified = 0;

    // Keyed, so two pairs that land on the same period (a series carrying
    // two snapshots at one as_of) leave exactly one row, the later one --
    // what a DELETE-then-INSERT per pair already did.
    const verdicts = new Map<string, unknown[]>();

    for (const [index, pair] of pairs.entries()) {
      const periodStart = pair.prev_as_of;
      const periodEnd = pair.as_of;
      const history = histories.get(pair.account_id) ?? EMPTY_HISTORY;
      const result = reconcilePeriod(
        pair,
        history,
        computed[index] ?? { error: "the period was not summed" },
      );

      if (result.status === "pass") passed += 1;
      else if (result.status === "fail") failed += 1;
      else unverified += 1;

      accounts.add(pair.account_id);
      instruments.add(pair.instrument_id);
      if (isCoverageGap(history, periodStart)) {
        gapPeriods.set(
          pair.account_id,
          (gapPeriods.get(pair.account_id) ?? 0) + 1,
        );
      }

      verdicts.set(
        periodKey(pair.account_id, pair.instrument_id, periodStart, periodEnd),
        [
          randomUUID(),
          pair.account_id,
          pair.instrument_id,
          periodStart,
          periodEnd,
          result.expectedChange,
          result.computedChange,
          result.delta,
          TOLERANCE,
          result.status,
          result.notes,
        ],
      );
    }

    // A snapshot inserted between two existing ones ends the period that
    // used to span it, so the verdict for that span is not stale, it is
    // about a period that no longer exists. A whole-archive pass over the
    // same rows would never produce it; deleting it is what keeps the two
    // forms producing the same table.
    if (scope !== undefined) await deleteSpannedVerdicts(client, scope);

    // F1-72. `pairs`/`scoped.currentPairs` is every period that still exists
    // under the archive's current positions -- for the whole archive, or for
    // this run's series. A row outside that set is a period from an earlier
    // run (a collapsed document, a re-attributed account) that the gate no
    // longer evaluates at all, not merely one it left unrewritten. Never a
    // "stale" status: this schema has none, and the row is simply wrong now.
    if (scoped === undefined) {
      await deleteVanishedVerdicts(client, pairs);
    } else {
      await deleteVanishedScopedVerdicts(
        client,
        scoped.series,
        scoped.currentPairs,
      );
    }

    await deleteVerdicts(client, [...verdicts.values()]);
    await insertRows(client, "position_reconciliations", VERDICT_COLUMNS, [
      ...verdicts.values(),
    ]);

    const coverageGaps: PositionCoverageGap[] = [];
    for (const [accountId, periodsUnverified] of gapPeriods) {
      const history = histories.get(accountId);
      if (history?.firstStatedPositionAsOf == null) continue;
      coverageGaps.push({
        accountId,
        firstStatedPositionAsOf: history.firstStatedPositionAsOf,
        transactionHistoryStartsAt: history.earliestTransaction,
        periodsUnverified,
      });
    }

    if (importRunId !== undefined) {
      await appendImportRunNote(client, importRunId, {
        periodsChecked: pairs.length,
        passed,
        failed,
        unverified,
        instrumentsChecked: instruments.size,
        coverageGaps,
      });
    }

    return {
      periodsChecked: pairs.length,
      passed,
      failed,
      unverified,
      accountsChecked: accounts.size,
      instrumentsChecked: instruments.size,
      coverageGaps,
    };
  });
}

/**
 * One row per account, instrument and snapshot after the first, paired with
 * its immediately preceding snapshot. This is the anchor: the comparison is
 * between two consecutive stated positions, never against zero. An
 * account/instrument with 0 or 1 snapshots yields no period, which is not a
 * failure -- there is simply nothing to check yet.
 *
 * `seriesPredicate` narrows which series are paired at all, and nothing
 * else: one template so the incremental form cannot drift from the
 * whole-archive one. It is this file's own literal, never caller input.
 */
function pairSql(seriesPredicate: string): string {
  return `SELECT account_id, instrument_id, as_of, quantity, prev_as_of, prev_quantity
     FROM (
       SELECT
         account_id, instrument_id, as_of, quantity,
         LAG(as_of) OVER (PARTITION BY account_id, instrument_id ORDER BY as_of) AS prev_as_of,
         LAG(quantity) OVER (PARTITION BY account_id, instrument_id ORDER BY as_of) AS prev_quantity
       FROM positions
       WHERE instrument_id IS NOT NULL${seriesPredicate}
     ) AS paired
     WHERE prev_as_of IS NOT NULL
     ORDER BY account_id, instrument_id, as_of`;
}

const SERIES_IN_SCOPE = `
         AND (account_id, instrument_id) IN (
           SELECT s.a, s.i FROM unnest($1::text[], $2::text[]) AS s(a, i)
         )`;

function seriesKey(accountId: string, instrumentId: string): string {
  return `${accountId}\u0000${instrumentId}`;
}

function periodKey(
  accountId: string,
  instrumentId: string,
  periodStart: string,
  periodEnd: string,
): string {
  return `${accountId}\u0000${instrumentId}\u0000${periodStart}\u0000${periodEnd}`;
}

/**
 * The periods one import could have moved, and no others (F1-59). Three
 * things make a period's verdict different from the one already stored, and
 * all three are derivable from what the import inserted:
 *
 *   1. A stated snapshot at one of the period's two ends changed, so the
 *      expected change did.
 *   2. A transaction landed inside the period's window, so the computed
 *      change did.
 *   3. The period's stored verdict is not a `pass`. A backdated transaction
 *      moves an account's earliest acquired activity earlier, which can turn
 *      an `unverified` coverage gap anywhere in that account into a real
 *      verdict -- including for instruments this import never touched. Every
 *      such period is already sitting in the table saying it did not pass,
 *      so rechecking exactly those costs one query and is bounded by the
 *      outstanding-not-passed count, not by the archive.
 *
 * A `pass` cannot go the other way: transactions are only ever inserted, so
 * an account's earliest activity only ever moves earlier and coverage only
 * ever improves.
 */
type ScopedPairs = {
  /** Only the periods this run needs to recompute a verdict for. */
  pairs: PositionPairRow[];
  /** The (account, instrument) series this run evaluated, and no others
   * (F1-72). */
  series: readonly { accountId: string; instrumentId: string }[];
  /**
   * Every period that currently exists for those series, recomputed or not.
   * This is what a period no longer being in `pairs` cannot tell you -- it
   * is silent on whether the period still exists at all -- so vanished
   * windows for this run's series are found from this set (F1-72).
   */
  currentPairs: PositionPairRow[];
};

async function scopedPairs(
  client: ArchiveClient,
  scope: PositionGateScope,
): Promise<ScopedPairs> {
  const series = new Map<string, PositionChange>();
  const changedDates = new Map<string, Set<string>>();
  const activityDates = new Map<string, string[]>();
  const accounts = new Set<string>();

  for (const change of scope.snapshots) {
    const key = seriesKey(change.accountId, change.instrumentId);
    series.set(key, change);
    accounts.add(change.accountId);
    const dates = changedDates.get(key) ?? new Set<string>();
    dates.add(change.date);
    changedDates.set(key, dates);
  }
  for (const change of scope.activity) {
    const key = seriesKey(change.accountId, change.instrumentId);
    series.set(key, change);
    accounts.add(change.accountId);
    const dates = activityDates.get(key) ?? [];
    dates.push(change.date);
    activityDates.set(key, dates);
  }

  const recheck = new Set<string>();
  if (accounts.size > 0) {
    const stale = await client.query<{
      account_id: string;
      instrument_id: string;
      period_start: string;
      period_end: string;
    }>(
      `SELECT account_id, instrument_id, period_start, period_end
       FROM position_reconciliations
       WHERE account_id = ANY($1::text[]) AND status <> 'pass'`,
      [[...accounts]],
    );
    for (const row of stale.rows) {
      series.set(seriesKey(row.account_id, row.instrument_id), {
        accountId: row.account_id,
        instrumentId: row.instrument_id,
        date: row.period_end,
      });
      recheck.add(
        periodKey(
          row.account_id,
          row.instrument_id,
          row.period_start,
          row.period_end,
        ),
      );
    }
  }

  if (series.size === 0) return { pairs: [], series: [], currentPairs: [] };
  const inScope = [...series.values()];
  const paired = await client.query<PositionPairRow>(pairSql(SERIES_IN_SCOPE), [
    inScope.map((s) => s.accountId),
    inScope.map((s) => s.instrumentId),
  ]);

  const pairs = paired.rows.filter((pair) => {
    const key = seriesKey(pair.account_id, pair.instrument_id);
    const changed = changedDates.get(key);
    if (changed?.has(pair.as_of) === true) return true;
    if (changed?.has(pair.prev_as_of) === true) return true;
    const activity = activityDates.get(key);
    if (
      activity?.some((date) => date > pair.prev_as_of && date <= pair.as_of) ===
      true
    ) {
      return true;
    }
    return recheck.has(
      periodKey(
        pair.account_id,
        pair.instrument_id,
        pair.prev_as_of,
        pair.as_of,
      ),
    );
  });
  return {
    pairs,
    series: inScope.map((s) => ({
      accountId: s.accountId,
      instrumentId: s.instrumentId,
    })),
    currentPairs: paired.rows,
  };
}

/** One statement for every period about to be rewritten. */
async function deleteVerdicts(
  client: ArchiveClient,
  verdicts: readonly (readonly unknown[])[],
): Promise<void> {
  if (verdicts.length === 0) return;
  await client.query(
    `DELETE FROM position_reconciliations r
     USING unnest($1::text[], $2::text[], $3::date[], $4::date[])
       AS k(account_id, instrument_id, period_start, period_end)
     WHERE r.account_id = k.account_id AND r.instrument_id = k.instrument_id
       AND r.period_start = k.period_start AND r.period_end = k.period_end`,
    [
      verdicts.map((v) => v[1]),
      verdicts.map((v) => v[2]),
      verdicts.map((v) => v[3]),
      verdicts.map((v) => v[4]),
    ],
  );
}

/**
 * Deletes every stored verdict whose (account, instrument, period) is not in
 * `pairs` (F1-72). Called only for a whole-archive pass, where `pairs` is
 * every period the archive currently has, so anything else in the table is a
 * period from an earlier run -- an account re-attribution or a document
 * collapse changed the window set -- that this gate no longer evaluates.
 */
async function deleteVanishedVerdicts(
  client: ArchiveClient,
  pairs: readonly PositionPairRow[],
): Promise<void> {
  await client.query(
    `DELETE FROM position_reconciliations r
     WHERE NOT EXISTS (
       SELECT 1 FROM unnest($1::text[], $2::text[], $3::date[], $4::date[])
         AS k(account_id, instrument_id, period_start, period_end)
       WHERE r.account_id = k.account_id AND r.instrument_id = k.instrument_id
         AND r.period_start = k.period_start AND r.period_end = k.period_end
     )`,
    [
      pairs.map((p) => p.account_id),
      pairs.map((p) => p.instrument_id),
      pairs.map((p) => p.prev_as_of),
      pairs.map((p) => p.as_of),
    ],
  );
}

/**
 * The same, but scoped to `series` -- an incremental run's own (account,
 * instrument) series, never archive-wide (F1-72). `currentPairs` is
 * `scopedPairs`' full current pairing for those series, not only the periods
 * this run recomputed, so a period this run had no reason to recheck keeps
 * its row.
 */
async function deleteVanishedScopedVerdicts(
  client: ArchiveClient,
  series: readonly { accountId: string; instrumentId: string }[],
  currentPairs: readonly PositionPairRow[],
): Promise<void> {
  if (series.length === 0) return;
  await client.query(
    `DELETE FROM position_reconciliations r
     WHERE (r.account_id, r.instrument_id) IN (
         SELECT s.a, s.i FROM unnest($5::text[], $6::text[]) AS s(a, i)
       )
       AND NOT EXISTS (
         SELECT 1 FROM unnest($1::text[], $2::text[], $3::date[], $4::date[])
           AS k(account_id, instrument_id, period_start, period_end)
         WHERE r.account_id = k.account_id AND r.instrument_id = k.instrument_id
           AND r.period_start = k.period_start AND r.period_end = k.period_end
       )`,
    [
      currentPairs.map((p) => p.account_id),
      currentPairs.map((p) => p.instrument_id),
      currentPairs.map((p) => p.prev_as_of),
      currentPairs.map((p) => p.as_of),
      series.map((s) => s.accountId),
      series.map((s) => s.instrumentId),
    ],
  );
}

/** One statement for every period a newly stated snapshot cut in half. */
async function deleteSpannedVerdicts(
  client: ArchiveClient,
  scope: PositionGateScope,
): Promise<void> {
  if (scope.snapshots.length === 0) return;
  await client.query(
    `DELETE FROM position_reconciliations r
     USING unnest($1::text[], $2::text[], $3::date[])
       AS c(account_id, instrument_id, as_of)
     WHERE r.account_id = c.account_id AND r.instrument_id = c.instrument_id
       AND r.period_start < c.as_of AND r.period_end > c.as_of`,
    [
      scope.snapshots.map((s) => s.accountId),
      scope.snapshots.map((s) => s.instrumentId),
      scope.snapshots.map((s) => s.date),
    ],
  );
}

/**
 * One period's verdict. Never throws: any problem that prevents a verdict is
 * `unverified` with a note, so one bad account, instrument or period never
 * blocks reconciling every other one.
 */
function reconcilePeriod(
  pair: PositionPairRow,
  history: AccountHistory,
  window: WindowSum,
): PeriodResult {
  const periodStart = pair.prev_as_of;
  if ("error" in window) {
    return {
      status: "unverified",
      expectedChange: null,
      computedChange: null,
      delta: null,
      notes: `could not sum transaction quantities for the period: ${window.error}`,
    };
  }
  const computedChange = window.total;

  // Ambiguous quantity (ground rule 5): a snapshot the importer already sent
  // to review with a null quantity cannot be diffed, and counting it as zero
  // would invent a stated holding the statement never stated.
  if (pair.prev_quantity === null || pair.quantity === null) {
    return {
      status: "unverified",
      expectedChange: null,
      computedChange,
      delta: null,
      notes: "a stated position snapshot for this period has no quantity",
    };
  }

  let expectedChange: string;
  try {
    expectedChange = subtractDecimal(
      fromNumericText(pair.quantity),
      fromNumericText(pair.prev_quantity),
    );
  } catch (error) {
    return {
      status: "unverified",
      expectedChange: null,
      computedChange,
      delta: null,
      notes: `a stated position quantity is not a decimal: ${messageOf(error)}`,
    };
  }

  // Coverage, not tolerance. When transaction history does not reach back to
  // the start of this period, the derived change cannot explain the stated
  // change no matter what it sums to, so the period is unverified and the
  // missing history is measured in the summary. Silently tolerating it would
  // hide exactly the thing worth knowing.
  if (isCoverageGap(history, periodStart)) {
    return {
      status: "unverified",
      expectedChange,
      computedChange,
      delta: null,
      notes:
        history.earliestTransaction === null
          ? "no transaction history has been acquired for this account, so this period cannot be checked"
          : `acquired transaction history begins ${history.earliestTransaction}, ` +
            `after this period's start ${periodStart}; the period cannot be checked`,
    };
  }

  const delta = subtractDecimal(computedChange, expectedChange);
  const reconciled = compareDecimal(delta, TOLERANCE) === 0;

  return {
    status: reconciled ? "pass" : "fail",
    expectedChange,
    computedChange,
    delta,
    notes: reconciled
      ? null
      : "the sum of this period's transaction quantities does not match the stated position change",
  };
}

/**
 * True when the archive's transaction history does not reach the start of
 * this period. `min(process_date)` is the archive's only record of how far
 * back activity was acquired; an account whose earliest transaction post-dates
 * a stated position genuinely has unverifiable periods before that point.
 *
 * Exported for the cash gate (F1-8e), which has the same shape of gap --
 * stated balances reaching further back than acquired activity -- and takes
 * only the one field this actually reads rather than the position gate's
 * full `AccountHistory` (which also carries `firstStatedPositionAsOf`,
 * meaningless for a balance).
 */
export function isCoverageGap(
  history: { earliestTransaction: string | null },
  periodStart: string,
): boolean {
  return (
    history.earliestTransaction === null ||
    periodStart < history.earliestTransaction
  );
}

/** One period's summed transaction quantities, or why there is no sum. */
type WindowSum = { total: string } | { error: string };

/**
 * Sums signed transaction quantities in (periodStart, periodEnd] for every
 * period at once (F1-59), one round trip instead of one per period. An empty
 * window is a valid 0: a period with no activity should show no stated
 * change. Summed by Postgres, where NUMERIC adds exactly, and read back as
 * decimal text.
 *
 * F1-8. The window is half-open for the same reason the cash gate's is: a
 * stated position is the close of business on its own date, so
 * `periodStart`'s own trades are already inside the position stated there
 * and counting them again double-counted every boundary day. Unlike cash,
 * quantity is placed by `process_date` alone: a stated share count moves
 * when the trade posts, not when its money settles.
 *
 * An ambiguous quantity the importer already sent to review is excluded
 * rather than guessed. Excluding a real movement is exactly what should
 * surface as a nonzero delta instead of being masked.
 *
 * A failure is still per period rather than thrown: one window that cannot
 * be decoded leaves that period unverified with the note it always had.
 */
async function sumQuantityWindows(
  client: ArchiveClient,
  pairs: readonly PositionPairRow[],
): Promise<WindowSum[]> {
  if (pairs.length === 0) return [];
  let rows: readonly { i: number; total: string | null }[];
  try {
    const result = await client.query<{ i: number; total: string | null }>(
      `SELECT w.i::int AS i, sum(t.quantity)::text AS total
       FROM unnest($1::text[], $2::text[], $3::date[], $4::date[])
         WITH ORDINALITY AS w(account_id, instrument_id, period_start, period_end, i)
       LEFT JOIN transactions t
         ON t.account_id = w.account_id
        AND t.instrument_id = w.instrument_id
        AND t.process_date > w.period_start
        AND t.process_date <= w.period_end
        AND t.quantity IS NOT NULL
       GROUP BY w.i`,
      [
        pairs.map((p) => p.account_id),
        pairs.map((p) => p.instrument_id),
        pairs.map((p) => p.prev_as_of),
        pairs.map((p) => p.as_of),
      ],
    );
    rows = result.rows;
  } catch (error) {
    return pairs.map(() => ({ error: messageOf(error) }));
  }

  const totals = new Map<number, string | null>();
  for (const row of rows) totals.set(row.i, row.total);
  return pairs.map((_, index) => {
    const total = totals.get(index + 1);
    try {
      return {
        total:
          total === null || total === undefined ? "0" : fromNumericText(total),
      };
    } catch (error) {
      return { error: messageOf(error) };
    }
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An account with neither acquired activity nor a stated position. */
const EMPTY_HISTORY: AccountHistory = Object.freeze({
  earliestTransaction: null,
  firstStatedPositionAsOf: null,
});

/**
 * How far back activity and stated positions reach, for every account with a
 * period to check, in one round trip (F1-59) rather than one per account.
 */
async function accountHistories(
  client: ArchiveClient,
  pairs: readonly PositionPairRow[],
): Promise<Map<string, AccountHistory>> {
  const histories = new Map<string, AccountHistory>();
  const accounts = [...new Set(pairs.map((pair) => pair.account_id))];
  if (accounts.length === 0) return histories;
  const result = await client.query<{
    account_id: string;
    earliest_transaction: string | null;
    first_stated_position: string | null;
  }>(
    `SELECT a.account_id,
       (SELECT min(process_date) FROM transactions WHERE account_id = a.account_id) AS earliest_transaction,
       (SELECT min(as_of) FROM positions WHERE account_id = a.account_id) AS first_stated_position
     FROM unnest($1::text[]) AS a(account_id)`,
    [accounts],
  );
  for (const row of result.rows) {
    histories.set(row.account_id, {
      earliestTransaction: row.earliest_transaction,
      firstStatedPositionAsOf: row.first_stated_position,
    });
  }
  return histories;
}

/**
 * Counts only. The note is bounded by a fixed number of numbers no matter
 * how many instruments an account holds, so an import log never turns into a
 * row dump.
 */
async function appendImportRunNote(
  client: ArchiveClient,
  importRunId: string,
  summary: {
    periodsChecked: number;
    passed: number;
    failed: number;
    unverified: number;
    instrumentsChecked: number;
    coverageGaps: readonly PositionCoverageGap[];
  },
): Promise<void> {
  const notPassed = summary.failed + summary.unverified;
  const note =
    notPassed === 0 && summary.coverageGaps.length === 0
      ? null
      : `position reconciliation: ${notPassed} of ${summary.periodsChecked} period(s) ` +
        `across ${summary.instrumentsChecked} instrument(s) did not pass ` +
        `(${summary.failed} failed, ${summary.unverified} unverified); ` +
        `${summary.coverageGaps.length} account(s) have transaction history ` +
        `starting after their first stated position`;
  await client.query(
    `UPDATE import_runs
     SET reconciliations_passed = reconciliations_passed + $1,
         reconciliations_failed = reconciliations_failed + $2,
         notes = CASE
           WHEN $3::text IS NULL THEN notes
           WHEN notes IS NULL THEN $3::text
           ELSE notes || ' | ' || $3::text
         END
     WHERE id = $4`,
    [summary.passed, notPassed, note, importRunId],
  );
}
