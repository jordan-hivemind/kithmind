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
// Quantities are canonical decimal TEXT, not integer minor units, so every
// comparison and sum here goes through the decimal helpers. No parseFloat,
// no Number, no REAL touches a quantity at any point.

import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";

import { addDecimal, compareDecimal, subtractDecimal } from "./decimal.js";
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

/** Canonical decimal text. The gate's tolerance policy: exact zero. */
const TOLERANCE = "0";

type PositionPairRow = {
  account_id: string;
  instrument_id: string;
  as_of: string;
  quantity: string | null;
  prev_as_of: string | null;
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
 * account and instrument, inclusive on both ends, matching the cash gate).
 * Re-running replaces any prior row for the same account, instrument and
 * period, so it is idempotent after a corrected import.
 *
 * A position with no `instrument_id` has no identity to pair snapshots on
 * and is skipped; such a row is already an unidentified holding rather than
 * something this gate can check.
 *
 * When `importRunId` is given, that run's counters are incremented and a
 * note is appended. `unverified` counts toward `reconciliations_failed`, as
 * it does for cash: neither is a clean pass and `import_runs` has no third
 * bucket. The note is appended rather than replaced so running both gates
 * against one import run does not lose the cash gate's note.
 */
export function runPositionReconciliationGate(
  db: DatabaseSync,
  importRunId?: string,
): PositionReconciliationGateSummary {
  const deleteExisting = db.prepare(
    `DELETE FROM position_reconciliations
     WHERE account_id = ? AND instrument_id = ? AND period_start = ? AND period_end = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO position_reconciliations
       (id, account_id, instrument_id, period_start, period_end,
        expected_change, computed_change, delta, tolerance, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const sumQuantities = db.prepare(
    `SELECT quantity FROM transactions
     WHERE account_id = ? AND instrument_id = ?
       AND process_date >= ? AND process_date <= ?`,
  );

  // One row per account, instrument and snapshot after the first, paired
  // with its immediately preceding snapshot. This is the anchor: the
  // comparison is between two consecutive stated positions, never against
  // zero. An account/instrument with 0 or 1 snapshots yields no period,
  // which is not a failure -- there is simply nothing to check yet.
  const pairs = db
    .prepare(
      `SELECT account_id, instrument_id, as_of, quantity, prev_as_of, prev_quantity
       FROM (
         SELECT
           account_id, instrument_id, as_of, quantity,
           LAG(as_of) OVER (PARTITION BY account_id, instrument_id ORDER BY as_of) AS prev_as_of,
           LAG(quantity) OVER (PARTITION BY account_id, instrument_id ORDER BY as_of) AS prev_quantity
         FROM positions
         WHERE instrument_id IS NOT NULL
       )
       WHERE prev_as_of IS NOT NULL
       ORDER BY account_id, instrument_id, as_of`,
    )
    .all() as PositionPairRow[];

  const histories = new Map<string, AccountHistory>();
  const gapPeriods = new Map<string, number>();
  const accounts = new Set<string>();
  const instruments = new Set<string>();
  let passed = 0;
  let failed = 0;
  let unverified = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const pair of pairs) {
      const periodStart = pair.prev_as_of as string;
      const periodEnd = pair.as_of;
      const history = accountHistory(db, histories, pair.account_id);
      const result = reconcilePeriod(
        sumQuantities,
        pair,
        periodStart,
        periodEnd,
        history,
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

      deleteExisting.run(
        pair.account_id,
        pair.instrument_id,
        periodStart,
        periodEnd,
      );
      insert.run(
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
      );
    }

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
      appendImportRunNote(db, importRunId, {
        periodsChecked: pairs.length,
        passed,
        failed,
        unverified,
        instrumentsChecked: instruments.size,
        coverageGaps,
      });
    }

    db.exec("COMMIT");

    return {
      periodsChecked: pairs.length,
      passed,
      failed,
      unverified,
      accountsChecked: accounts.size,
      instrumentsChecked: instruments.size,
      coverageGaps,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * One period's verdict. Never throws: any problem that prevents a verdict is
 * `unverified` with a note, so one bad account, instrument or period never
 * blocks reconciling every other one.
 */
function reconcilePeriod(
  sumQuantities: StatementSync,
  pair: PositionPairRow,
  periodStart: string,
  periodEnd: string,
  history: AccountHistory,
): PeriodResult {
  let computedChange: string;
  try {
    computedChange = sumQuantityWindow(
      sumQuantities,
      pair.account_id,
      pair.instrument_id,
      periodStart,
      periodEnd,
    );
  } catch (error) {
    return {
      status: "unverified",
      expectedChange: null,
      computedChange: null,
      delta: null,
      notes: `could not sum transaction quantities for the period: ${messageOf(error)}`,
    };
  }

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
    expectedChange = subtractDecimal(pair.quantity, pair.prev_quantity);
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
 */
function isCoverageGap(history: AccountHistory, periodStart: string): boolean {
  return (
    history.earliestTransaction === null ||
    periodStart < history.earliestTransaction
  );
}

/**
 * Sums signed transaction quantities in [periodStart, periodEnd] for one
 * account and instrument. An empty window is a valid 0: a period with no
 * activity should show no stated change. Every add goes through the exact
 * decimal helpers, so no quantity is ever a float.
 */
function sumQuantityWindow(
  statement: StatementSync,
  accountId: string,
  instrumentId: string,
  periodStart: string,
  periodEnd: string,
): string {
  const rows = statement.all(
    accountId,
    instrumentId,
    periodStart,
    periodEnd,
  ) as { quantity: string | null }[];
  let total = "0";
  for (const row of rows) {
    // Ambiguous quantity the importer already sent to review is excluded
    // rather than guessed. Excluding a real movement is exactly what should
    // surface as a nonzero delta instead of being masked.
    if (row.quantity === null) continue;
    total = addDecimal(total, row.quantity);
  }
  return total;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function accountHistory(
  db: DatabaseSync,
  cache: Map<string, AccountHistory>,
  accountId: string,
): AccountHistory {
  const cached = cache.get(accountId);
  if (cached !== undefined) return cached;
  const transactions = db
    .prepare("SELECT min(process_date) AS earliest FROM transactions WHERE account_id = ?")
    .get(accountId) as { earliest: string | null };
  const positions = db
    .prepare("SELECT min(as_of) AS earliest FROM positions WHERE account_id = ?")
    .get(accountId) as { earliest: string | null };
  const history: AccountHistory = {
    earliestTransaction: transactions.earliest,
    firstStatedPositionAsOf: positions.earliest,
  };
  cache.set(accountId, history);
  return history;
}

/**
 * Counts only. The note is bounded by a fixed number of numbers no matter
 * how many instruments an account holds, so an import log never turns into a
 * row dump.
 */
function appendImportRunNote(
  db: DatabaseSync,
  importRunId: string,
  summary: {
    periodsChecked: number;
    passed: number;
    failed: number;
    unverified: number;
    instrumentsChecked: number;
    coverageGaps: readonly PositionCoverageGap[];
  },
): void {
  const notPassed = summary.failed + summary.unverified;
  const note =
    notPassed === 0 && summary.coverageGaps.length === 0
      ? null
      : `position reconciliation: ${notPassed} of ${summary.periodsChecked} period(s) ` +
        `across ${summary.instrumentsChecked} instrument(s) did not pass ` +
        `(${summary.failed} failed, ${summary.unverified} unverified); ` +
        `${summary.coverageGaps.length} account(s) have transaction history ` +
        `starting after their first stated position`;
  db.prepare(
    `UPDATE import_runs
     SET reconciliations_passed = reconciliations_passed + ?1,
         reconciliations_failed = reconciliations_failed + ?2,
         notes = CASE
           WHEN ?3 IS NULL THEN notes
           WHEN notes IS NULL THEN ?3
           ELSE notes || ' | ' || ?3
         END
     WHERE id = ?4`,
  ).run(summary.passed, notPassed, note, importRunId);
}
