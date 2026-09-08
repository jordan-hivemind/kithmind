// The reconciliation gate (F1-4): for every account and every statement
// period, ties the period's stated cash-balance change to the sum of that
// window's transactions. Ground rule 3: reconciliation is a gate, not a
// report. A period whose transactions cannot explain the stated balance
// change fails loudly and is marked unverified rather than absorbed
// silently.
//
// A period is the span between two consecutive `balances` snapshots for one
// account (schemaDoc.ts: "balances: Point-in-time account totals, used by
// the reconciliation gate"). This file does not populate `balances`; writing
// what a statement stated is out of this task's scope. It only reads what is
// already there, sums `transactions` in the window, and writes
// `reconciliations`.
//
// The tolerance is an owner decision already made: exact zero. Any nonzero
// delta fails the period. Zero is achievable because cash is exact integer
// minor units and a correctly parsed statement has nothing left to round
// away; a nonzero delta means a real modeling gap, not noise to average out.
// Loosening the tolerance later needs evidence, so every row -- pass or fail
// -- records the tolerance it was held to (schemaDoc.ts:
// "reconciliations.tolerance ... recorded even when it passed").
//
// Market movement makes an exact diff possible only for cash-like balances,
// so this gate always reconciles `balances.cash`, never `total_value`. It
// never even reads `total_value`, `period_start_value` or `period_end_value`:
// there is nothing in this file that could accidentally compare against
// them. For a cash-only account (checking, savings) cash is the account's
// only balance, so the same comparison is correct there too.

import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";

import { fromMinorUnits } from "./money.js";

export type ReconciliationStatus = "pass" | "fail" | "unverified";

/**
 * One period's outcome: account, period-level facts, never a transaction
 * row (see the plan's "Working on the archive without reading it"). Bounded
 * by the number of periods checked, the same way review_items is bounded by
 * review count.
 */
export type ReconciliationOutcome = {
  accountId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  status: ReconciliationStatus;
  /** Decimal text in `currency` units, or null when it could not be computed. */
  expectedChange: string | null;
  computedChange: string | null;
  delta: string | null;
  notes: string | null;
};

export type ReconciliationGateSummary = {
  periodsChecked: number;
  passed: number;
  failed: number;
  unverified: number;
  outcomes: readonly ReconciliationOutcome[];
};

/** Minor units. The gate's tolerance policy: exact zero, for every period. */
const TOLERANCE = 0n;

type BalancePairRow = {
  account_id: string;
  as_of: string;
  cash: bigint | null;
  currency: string;
  prev_as_of: string | null;
  prev_cash: bigint | null;
  prev_currency: string | null;
};

/** The minor-units result of one period, before formatting for the report. */
type PeriodResult = {
  status: ReconciliationStatus;
  expectedMinor: bigint | null;
  computedMinor: bigint | null;
  deltaMinor: bigint | null;
  notes: string | null;
};

/**
 * Runs the reconciliation gate over every account with two or more
 * `balances` snapshots, writing one `reconciliations` row per period
 * (period boundaries are consecutive snapshot dates for that account,
 * inclusive on both ends). Re-running the gate replaces any prior row for
 * the same account and period, so it is idempotent after a corrected
 * import.
 *
 * When `importRunId` is given, that run's `reconciliations_passed` and
 * `reconciliations_failed` counters and `notes` are updated so a failure is
 * visible in the import log without a caller reading this function's return
 * value. `unverified` periods count toward `reconciliations_failed`:
 * neither is a clean pass, and `import_runs` has no third bucket.
 */
export function runReconciliationGate(
  db: DatabaseSync,
  importRunId?: string,
): ReconciliationGateSummary {
  const deleteExisting = db.prepare(
    "DELETE FROM reconciliations WHERE account_id = ? AND period_start = ? AND period_end = ?",
  );
  const insert = db.prepare(
    `INSERT INTO reconciliations
       (id, account_id, period_start, period_end, expected_change,
        computed_change, delta, currency, tolerance, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const sumTransactionsStatement = db.prepare(
    `SELECT amount, currency FROM transactions
     WHERE account_id = ? AND process_date >= ? AND process_date <= ?`,
  );
  sumTransactionsStatement.setReadBigInts(true);

  // One row per account per snapshot after the first, paired with its
  // immediately preceding snapshot via LAG. Each pair is one statement
  // period. An account with 0 or 1 balances rows yields no periods.
  const pairsStatement = db.prepare(
    `SELECT account_id, as_of, cash, currency, prev_as_of, prev_cash, prev_currency
     FROM (
       SELECT
         account_id, as_of, cash, currency,
         LAG(as_of) OVER (PARTITION BY account_id ORDER BY as_of) AS prev_as_of,
         LAG(cash) OVER (PARTITION BY account_id ORDER BY as_of) AS prev_cash,
         LAG(currency) OVER (PARTITION BY account_id ORDER BY as_of) AS prev_currency
       FROM balances
     )
     WHERE prev_as_of IS NOT NULL
     ORDER BY account_id, as_of`,
  );
  pairsStatement.setReadBigInts(true);
  const pairs = pairsStatement.all() as BalancePairRow[];

  const outcomes: ReconciliationOutcome[] = [];
  let passed = 0;
  let failed = 0;
  let unverified = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const pair of pairs) {
      const periodStart = pair.prev_as_of as string;
      const periodEnd = pair.as_of;
      const result = reconcilePeriod(
        sumTransactionsStatement,
        pair.account_id,
        periodStart,
        periodEnd,
        pair.currency,
        pair.prev_currency,
        pair.prev_cash,
        pair.cash,
      );

      if (result.status === "pass") passed += 1;
      else if (result.status === "fail") failed += 1;
      else unverified += 1;

      outcomes.push({
        accountId: pair.account_id,
        periodStart,
        periodEnd,
        currency: pair.currency,
        status: result.status,
        expectedChange:
          result.expectedMinor === null
            ? null
            : fromMinorUnits(result.expectedMinor, pair.currency),
        computedChange:
          result.computedMinor === null
            ? null
            : fromMinorUnits(result.computedMinor, pair.currency),
        delta:
          result.deltaMinor === null
            ? null
            : fromMinorUnits(result.deltaMinor, pair.currency),
        notes: result.notes,
      });

      deleteExisting.run(pair.account_id, periodStart, periodEnd);
      insert.run(
        randomUUID(),
        pair.account_id,
        periodStart,
        periodEnd,
        result.expectedMinor,
        result.computedMinor,
        result.deltaMinor,
        pair.currency,
        TOLERANCE,
        result.status,
        result.notes,
      );
    }

    if (importRunId !== undefined) {
      updateImportRun(db, importRunId, passed, failed + unverified, outcomes);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    periodsChecked: outcomes.length,
    passed,
    failed,
    unverified,
    outcomes,
  };
}

/**
 * One period's reconciliation. Never throws: any problem that prevents a
 * verdict (a currency mismatch, a snapshot missing its cash balance) is
 * reported as `unverified` with a note, so one bad account or period never
 * blocks reconciling every other one.
 */
function reconcilePeriod(
  sumTransactionsStatement: StatementSync,
  accountId: string,
  periodStart: string,
  periodEnd: string,
  currency: string,
  prevCurrency: string | null,
  cashStart: bigint | null,
  cashEnd: bigint | null,
): PeriodResult {
  if (prevCurrency !== null && prevCurrency !== currency) {
    return {
      status: "unverified",
      expectedMinor: null,
      computedMinor: null,
      deltaMinor: null,
      notes:
        `the account's balances currency changed within this period ` +
        `(${prevCurrency} to ${currency}); refusing to diff across currencies`,
    };
  }

  let computedMinor: bigint;
  try {
    computedMinor = sumTransactionWindow(
      sumTransactionsStatement,
      accountId,
      periodStart,
      periodEnd,
      currency,
    );
  } catch (error) {
    return {
      status: "unverified",
      expectedMinor: null,
      computedMinor: null,
      deltaMinor: null,
      notes: `could not sum transactions for the period: ${messageOf(error)}`,
    };
  }

  // Ambiguous money (ground rule 5): a snapshot with no stated cash balance
  // cannot be diffed, so the period is unverified rather than guessed.
  if (cashStart === null || cashEnd === null) {
    return {
      status: "unverified",
      expectedMinor: null,
      computedMinor,
      deltaMinor: null,
      notes: "a balances snapshot for this period has no stated cash value",
    };
  }

  const expectedMinor = cashEnd - cashStart;
  const deltaMinor = computedMinor - expectedMinor;

  return {
    status: deltaMinor === 0n ? "pass" : "fail",
    expectedMinor,
    computedMinor,
    deltaMinor,
    notes:
      deltaMinor === 0n
        ? null
        : "the sum of this period's transactions does not match the stated cash balance change",
  };
}

/** Sums cash transactions in [periodStart, periodEnd]. Empty is a valid 0. */
function sumTransactionWindow(
  statement: StatementSync,
  accountId: string,
  periodStart: string,
  periodEnd: string,
  currency: string,
): bigint {
  const rows = statement.all(accountId, periodStart, periodEnd) as {
    amount: bigint | null;
    currency: string;
  }[];
  let total = 0n;
  for (const row of rows) {
    // Ambiguous money the importer already sent to review (null amount) is
    // excluded rather than guessed; excluding real money is exactly what
    // should surface as a nonzero delta instead of being masked.
    if (row.amount === null) continue;
    if (row.currency !== currency) {
      throw new Error(
        `a transaction in this window is in ${row.currency}, not the period's ${currency}`,
      );
    }
    total += row.amount;
  }
  return total;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function updateImportRun(
  db: DatabaseSync,
  importRunId: string,
  passed: number,
  notPassed: number,
  outcomes: readonly ReconciliationOutcome[],
): void {
  const failing = outcomes.filter((o) => o.status !== "pass");
  const notes =
    failing.length === 0
      ? null
      : `reconciliation: ${failing.length} of ${outcomes.length} period(s) did not pass -- ` +
        failing
          .map(
            (o) =>
              `${o.accountId} ${o.periodStart}..${o.periodEnd}: ${o.status}` +
              (o.delta === null ? "" : ` (delta ${o.delta} ${o.currency})`),
          )
          .join("; ");
  db.prepare(
    `UPDATE import_runs
     SET reconciliations_passed = reconciliations_passed + ?,
         reconciliations_failed = reconciliations_failed + ?,
         notes = COALESCE(?, notes)
     WHERE id = ?`,
  ).run(passed, notPassed, notes, importRunId);
}
