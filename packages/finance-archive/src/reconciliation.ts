// The reconciliation gate (F1-4): for every account and every statement
// period, ties the period's stated cash-balance change to the sum of that
// window's transactions. Ground rule 3: reconciliation is a gate, not a
// report. A period whose transactions cannot explain the stated balance
// change fails loudly and is marked unverified rather than absorbed
// silently.
//
// A period is the span between two consecutive `balances` snapshots for one
// account. This file does not populate `balances`; writing what a statement
// stated is the importer's job. It only reads what is already there, sums
// `transactions` in the window, and writes `reconciliations`.
//
// The tolerance is an owner decision already made: exact zero. Any nonzero
// delta fails the period. Under F1-22's move to NUMERIC that comparison is
// the one place a float could creep back in, so it does not happen in
// JavaScript arithmetic at all: the window is summed by Postgres, where
// NUMERIC sums exactly, and the delta is taken and compared with the exact
// base-10 helpers in decimal.ts. `compareDecimal(delta, "0")` compares digits,
// so `0.00` and `-0` are zero and `0.000000000000000001` is not -- which a
// float comparison would get wrong in both directions.
//
// Zero is achievable because a correctly parsed statement has nothing left to
// round away; a nonzero delta means a real modeling gap, not noise to average
// out. Loosening the tolerance later needs evidence, so every row -- pass or
// fail -- records the tolerance it was held to.
//
// Market movement makes an exact diff possible only for cash-like balances,
// so this gate always reconciles `balances.cash`, never `total_value`. It
// never even reads `total_value`, `period_start_value` or `period_end_value`:
// there is nothing in this file that could accidentally compare against
// them. For a cash-only account (checking, savings) cash is the account's
// only balance, so the same comparison is correct there too.

import { randomUUID } from "node:crypto";

import { compareDecimal, subtractDecimal } from "./decimal.js";
import { fromNumericText } from "./pgNumeric.js";
import {
  type ArchiveClient,
  lockArchiveForWrite,
  withArchiveTransaction,
} from "./pgStore.js";

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
  /** Canonical decimal text in `currency`, or null when it could not be computed. */
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

/** Canonical decimal text. The gate's tolerance policy: exact zero. */
const TOLERANCE = "0";

type BalancePairRow = {
  account_id: string;
  as_of: string;
  cash: string | null;
  currency: string;
  prev_as_of: string;
  prev_cash: string | null;
  prev_currency: string | null;
};

type PeriodResult = {
  status: ReconciliationStatus;
  expectedChange: string | null;
  computedChange: string | null;
  delta: string | null;
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
 * The whole gate is one transaction, and it joins the caller's transaction
 * when there is one -- which is how `publishImport` gets new transactions and
 * the verdicts that judge them to become visible in the same instant. Called
 * on its own it is still atomic and still takes the archive write lock.
 *
 * When `importRunId` is given, that run's `reconciliations_passed` and
 * `reconciliations_failed` counters and `notes` are updated so a failure is
 * visible in the import log without a caller reading this function's return
 * value. `unverified` periods count toward `reconciliations_failed`:
 * neither is a clean pass, and `import_runs` has no third bucket.
 */
export async function runReconciliationGate(
  client: ArchiveClient,
  importRunId?: string,
): Promise<ReconciliationGateSummary> {
  return withArchiveTransaction(client, async () => {
    await lockArchiveForWrite(client);

    // One row per account per snapshot after the first, paired with its
    // immediately preceding snapshot via LAG. Each pair is one statement
    // period. An account with 0 or 1 balances rows yields no periods.
    const pairs = await client.query<BalancePairRow>(
      `SELECT account_id, as_of, cash, currency, prev_as_of, prev_cash, prev_currency
       FROM (
         SELECT
           account_id, as_of, cash, currency,
           LAG(as_of) OVER (PARTITION BY account_id ORDER BY as_of) AS prev_as_of,
           LAG(cash) OVER (PARTITION BY account_id ORDER BY as_of) AS prev_cash,
           LAG(currency) OVER (PARTITION BY account_id ORDER BY as_of) AS prev_currency
         FROM balances
       ) AS paired
       WHERE prev_as_of IS NOT NULL
       ORDER BY account_id, as_of`,
    );

    const outcomes: ReconciliationOutcome[] = [];
    let passed = 0;
    let failed = 0;
    let unverified = 0;

    for (const pair of pairs.rows) {
      const periodStart = pair.prev_as_of;
      const periodEnd = pair.as_of;
      const result = await reconcilePeriod(client, pair);

      if (result.status === "pass") passed += 1;
      else if (result.status === "fail") failed += 1;
      else unverified += 1;

      outcomes.push({
        accountId: pair.account_id,
        periodStart,
        periodEnd,
        currency: pair.currency,
        status: result.status,
        expectedChange: result.expectedChange,
        computedChange: result.computedChange,
        delta: result.delta,
        notes: result.notes,
      });

      await client.query(
        "DELETE FROM reconciliations WHERE account_id = $1 AND period_start = $2 AND period_end = $3",
        [pair.account_id, periodStart, periodEnd],
      );
      await client.query(
        `INSERT INTO reconciliations
           (id, account_id, period_start, period_end, expected_change,
            computed_change, delta, currency, tolerance, status, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          randomUUID(),
          pair.account_id,
          periodStart,
          periodEnd,
          result.expectedChange,
          result.computedChange,
          result.delta,
          pair.currency,
          TOLERANCE,
          result.status,
          result.notes,
        ],
      );
    }

    if (importRunId !== undefined) {
      await updateImportRun(
        client,
        importRunId,
        passed,
        failed + unverified,
        outcomes,
      );
    }

    return {
      periodsChecked: outcomes.length,
      passed,
      failed,
      unverified,
      outcomes,
    };
  });
}

/**
 * One period's reconciliation. Never throws: any problem that prevents a
 * verdict (a currency mismatch, a snapshot missing its cash balance) is
 * reported as `unverified` with a note, so one bad account or period never
 * blocks reconciling every other one.
 */
async function reconcilePeriod(
  client: ArchiveClient,
  pair: BalancePairRow,
): Promise<PeriodResult> {
  if (pair.prev_currency !== null && pair.prev_currency !== pair.currency) {
    return {
      status: "unverified",
      expectedChange: null,
      computedChange: null,
      delta: null,
      notes:
        `the account's balances currency changed within this period ` +
        `(${pair.prev_currency} to ${pair.currency}); refusing to diff across currencies`,
    };
  }

  let computedChange: string;
  try {
    computedChange = await sumTransactionWindow(
      client,
      pair.account_id,
      pair.prev_as_of,
      pair.as_of,
      pair.currency,
    );
  } catch (error) {
    return {
      status: "unverified",
      expectedChange: null,
      computedChange: null,
      delta: null,
      notes: `could not sum transactions for the period: ${messageOf(error)}`,
    };
  }

  // Ambiguous money (ground rule 5): a snapshot with no stated cash balance
  // cannot be diffed, so the period is unverified rather than guessed.
  if (pair.prev_cash === null || pair.cash === null) {
    return {
      status: "unverified",
      expectedChange: null,
      computedChange,
      delta: null,
      notes: "a balances snapshot for this period has no stated cash value",
    };
  }

  let expectedChange: string;
  try {
    expectedChange = subtractDecimal(
      fromNumericText(pair.cash),
      fromNumericText(pair.prev_cash),
    );
  } catch (error) {
    return {
      status: "unverified",
      expectedChange: null,
      computedChange,
      delta: null,
      notes: `a stated cash balance is not a decimal: ${messageOf(error)}`,
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
      : "the sum of this period's transactions does not match the stated cash balance change",
  };
}

/**
 * Sums cash transactions in [periodStart, periodEnd]. Empty is a valid 0.
 *
 * Summed by Postgres, where NUMERIC adds exactly, and grouped by currency so
 * the currency-mixing guard is the query's own shape rather than a loop that
 * could be edited out: more than one group in one period's window means the
 * window is not in one currency, which is not a total this gate is allowed to
 * take. Rows whose amount is NULL -- ambiguous money the importer already
 * sent to review -- are excluded rather than guessed; excluding real money is
 * exactly what should surface as a nonzero delta instead of being masked.
 */
async function sumTransactionWindow(
  client: ArchiveClient,
  accountId: string,
  periodStart: string,
  periodEnd: string,
  currency: string,
): Promise<string> {
  const sums = await client.query<{ currency: string; total: string }>(
    `SELECT currency, sum(amount)::text AS total
     FROM transactions
     WHERE account_id = $1 AND process_date >= $2 AND process_date <= $3
       AND amount IS NOT NULL
     GROUP BY currency`,
    [accountId, periodStart, periodEnd],
  );
  if (sums.rowCount === 0) return "0";
  const foreign = sums.rows.find((row) => row.currency !== currency);
  if (foreign) {
    throw new Error(
      `a transaction in this window is in ${foreign.currency}, not the period's ${currency}`,
    );
  }
  return fromNumericText(sums.rows[0]?.total ?? "0");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function updateImportRun(
  client: ArchiveClient,
  importRunId: string,
  passed: number,
  notPassed: number,
  outcomes: readonly ReconciliationOutcome[],
): Promise<void> {
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
  await client.query(
    `UPDATE import_runs
     SET reconciliations_passed = reconciliations_passed + $1,
         reconciliations_failed = reconciliations_failed + $2,
         notes = COALESCE($3, notes)
     WHERE id = $4`,
    [passed, notPassed, notes, importRunId],
  );
}
