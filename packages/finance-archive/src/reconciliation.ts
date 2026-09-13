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
// F1-8 fixed two things about which rows land in that window, both measured
// against the hosted archive before and after.
//
// The window is half-open: `(period_start, period_end]`. A stated balance is
// the close of business on its own date, so the activity of `period_start`
// is already inside the *previous* snapshot. Counting it again at the start
// of the next period charged every boundary day's cash twice.
//
// The date a row is placed by is its cash-effective date --
// `greatest(process_date, settle_date)` -- not `process_date` alone. A
// statement's cash balance is settled cash: a trade executed and processed
// before the close but settling after it has not moved the stated balance
// yet, and posting a row before it settles does not release the money
// either. `greatest` of the two is the first date on which both are true.
// `settle_date` is nullable, and a row without one falls back to
// `process_date` unchanged.
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
  insertRows,
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

/**
 * One (account, date) an import actually inserted a row at (F1-59). `date`
 * is `balances.as_of` for a stated snapshot and, for activity, the row's
 * cash-effective date -- `cashEffectiveDate(processDate, settleDate)`, the
 * same date `CASH_DATE` places the row on. Keying the scope by
 * `process_date` while the window sums by settlement would let a scoped run
 * miss the period a row actually moved.
 */
export type CashChange = {
  accountId: string;
  date: string;
};

/**
 * What one import changed, as the importer itself observed it: the rows it
 * inserted, never a table scan. Passing it runs the gate incrementally --
 * only the periods that import could have moved -- instead of over the whole
 * archive. See `runReconciliationGate`.
 */
export type CashGateScope = {
  /** `balances` rows this import inserted. */
  snapshots: readonly CashChange[];
  /** `transactions` rows this import inserted. */
  activity: readonly CashChange[];
};

/** Canonical decimal text. The gate's tolerance policy: exact zero. */
const TOLERANCE = "0";

/**
 * The date one transaction's cash lands on, as SQL over an aliased
 * `transactions t`. See the header: a stated cash balance is settled cash,
 * so a row counts in the period containing the later of the date it was
 * processed and the date it settled. Exported as `cashEffectiveDate` for the
 * importer, which has to key an incremental gate scope by the same date this
 * expression puts the row on, or a scoped run could skip the period the row
 * actually moved.
 */
const CASH_DATE =
  "greatest(t.process_date, coalesce(t.settle_date, t.process_date))";

/** The TypeScript twin of `CASH_DATE`; ISO dates compare lexicographically. */
export function cashEffectiveDate(
  processDate: string,
  settleDate: string | null,
): string {
  return settleDate !== null && settleDate > processDate
    ? settleDate
    : processDate;
}

/** The column order the batched verdict INSERT binds its tuples in. */
const VERDICT_COLUMNS = [
  "id",
  "account_id",
  "period_start",
  "period_end",
  "expected_change",
  "computed_change",
  "delta",
  "currency",
  "tolerance",
  "status",
  "notes",
] as const;

type BalancePairRow = {
  account_id: string;
  as_of: string;
  cash: string | null;
  currency: string;
  cash_contradicts: boolean;
  prev_as_of: string;
  prev_cash: string | null;
  prev_currency: string | null;
  prev_cash_contradicts: boolean | null;
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
 * (period boundaries are consecutive snapshot dates for that account; the
 * window between them is half-open, `(period_start, period_end]`, because
 * `period_start`'s own activity is already inside the balance stated there).
 * Re-running the gate replaces any prior row for the same account and
 * period, so it is idempotent after a corrected import. It also deletes any
 * row for a period that no longer exists at all -- archive-wide with no
 * `scope`, or within `scope`'s own accounts with one (F1-72) -- so a
 * document collapse or account re-attribution that changes the window set
 * cannot leave the old windows' verdicts behind counting toward every
 * reader's failure totals.
 *
 * The whole gate is one transaction, and it joins the caller's transaction
 * when there is one -- which is how `publishImport` gets new transactions and
 * the verdicts that judge them to become visible in the same instant. Called
 * on its own it is still atomic and still takes the archive write lock.
 *
 * F1-59. With no `scope` this is the whole-archive pass, run once at the end
 * of an operator run. With one it checks only the periods that import could
 * have moved (see `scopedPairs`) and writes the same rows for them, which is
 * what keeps a per-document gate proportional to the document rather than to
 * the archive; `outcomes` then covers the periods it checked, not every
 * period in the archive. Either way the work is batched: a pass costs a
 * fixed handful of round trips instead of three per period.
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
  scope?: CashGateScope,
): Promise<ReconciliationGateSummary> {
  return withArchiveTransaction(client, async () => {
    await lockArchiveForWrite(client);

    const scoped = scope === undefined ? undefined : await scopedPairs(client, scope);
    const pairs =
      scope === undefined
        ? (await client.query<BalancePairRow>(pairSql(""))).rows
        : scoped!.pairs;

    // F1-59. Every window is summed before the loop, in one round trip
    // rather than one per period: the archive is hosted, so a gate's cost is
    // messages, not rows. The verdict logic itself is unchanged.
    const computed = await sumTransactionWindows(client, pairs);

    const outcomes: ReconciliationOutcome[] = [];
    let passed = 0;
    let failed = 0;
    let unverified = 0;

    // Keyed, so two pairs that land on the same period (an account carrying
    // two balances at one as_of) leave exactly one row, the later one --
    // what a DELETE-then-INSERT per pair already did.
    const verdicts = new Map<string, unknown[]>();

    for (const [index, pair] of pairs.entries()) {
      const periodStart = pair.prev_as_of;
      const periodEnd = pair.as_of;
      const result = reconcilePeriod(
        pair,
        computed[index] ?? { error: "the period was not summed" },
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
        expectedChange: result.expectedChange,
        computedChange: result.computedChange,
        delta: result.delta,
        notes: result.notes,
      });

      verdicts.set(periodKey(pair.account_id, periodStart, periodEnd), [
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
      ]);
    }

    // A snapshot inserted between two existing ones ends the period that
    // used to span it, so the verdict for that span is not stale, it is
    // about a period that no longer exists. A whole-archive pass over the
    // same rows would never produce it; deleting it is what keeps the two
    // forms producing the same table.
    if (scope !== undefined) await deleteSpannedVerdicts(client, scope);

    // F1-72. `pairs`/`scoped.currentPairs` is every period that still exists
    // under the archive's current balances -- for the whole archive, or for
    // this run's accounts. A row outside that set is a period from an
    // earlier run (a collapsed document, a re-attributed account) that the
    // gate no longer evaluates at all, not merely one it left unrewritten.
    // Never a "stale" status: this schema has none, and the row is simply
    // wrong now.
    if (scoped === undefined) {
      await deleteVanishedVerdicts(client, pairs);
    } else {
      await deleteVanishedScopedVerdicts(
        client,
        scoped.accountIds,
        scoped.currentPairs,
      );
    }

    await deleteVerdicts(client, [...verdicts.values()]);
    await insertRows(client, "reconciliations", VERDICT_COLUMNS, [
      ...verdicts.values(),
    ]);

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
function reconcilePeriod(
  pair: BalancePairRow,
  window: WindowSum,
): PeriodResult {
  // F1-8. Two `balances` rows at one `as_of` stating different cash is the
  // archive holding two contradictory statements of the same fact, not a
  // period the transactions could ever explain. Diffing against either one
  // would be picking a winner silently (ground rule 5), and which one the
  // window function picked was not even deterministic before this. The
  // period is unverified and says so; the contradiction is the thing to fix.
  if (pair.cash_contradicts || pair.prev_cash_contradicts === true) {
    const which =
      pair.cash_contradicts && pair.prev_cash_contradicts === true
        ? "both ends of"
        : pair.cash_contradicts
          ? "the end of"
          : "the start of";
    return {
      status: "unverified",
      expectedChange: null,
      computedChange: null,
      delta: null,
      notes:
        `the archive holds more than one stated cash balance, disagreeing, at ` +
        `${which} this period; refusing to pick one`,
    };
  }

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

  if ("error" in window) {
    return {
      status: "unverified",
      expectedChange: null,
      computedChange: null,
      delta: null,
      notes: `could not sum transactions for the period: ${window.error}`,
    };
  }
  const computedChange = window.total;

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

/** One period's summed cash transactions, or why there is no sum. */
type WindowSum = { total: string } | { error: string };

/**
 * Sums cash transactions in [periodStart, periodEnd] for every period at
 * once (F1-59), one round trip instead of one per period. Empty is a valid 0.
 *
 * Summed by Postgres, where NUMERIC adds exactly, and grouped by currency so
 * the currency-mixing guard is the query's own shape rather than a loop that
 * could be edited out: more than one group in one period's window means the
 * window is not in one currency, which is not a total this gate is allowed to
 * take. Rows whose amount is NULL -- ambiguous money the importer already
 * sent to review -- are excluded rather than guessed; excluding real money is
 * exactly what should surface as a nonzero delta instead of being masked.
 *
 * Grouping by period as well as currency keeps that guard per period: a
 * foreign-currency transaction leaves its own period unverified with the
 * note it always had and every other period untouched.
 */
async function sumTransactionWindows(
  client: ArchiveClient,
  pairs: readonly BalancePairRow[],
): Promise<WindowSum[]> {
  if (pairs.length === 0) return [];
  let rows: readonly { i: number; currency: string; total: string }[];
  try {
    const result = await client.query<{
      i: number;
      currency: string;
      total: string;
    }>(
      `SELECT w.i::int AS i, t.currency, sum(t.amount)::text AS total
       FROM unnest($1::text[], $2::date[], $3::date[])
         WITH ORDINALITY AS w(account_id, period_start, period_end, i)
       JOIN transactions t
         ON t.account_id = w.account_id
        AND ${CASH_DATE} > w.period_start
        AND ${CASH_DATE} <= w.period_end
        AND t.amount IS NOT NULL
       GROUP BY w.i, t.currency`,
      [
        pairs.map((p) => p.account_id),
        pairs.map((p) => p.prev_as_of),
        pairs.map((p) => p.as_of),
      ],
    );
    rows = result.rows;
  } catch (error) {
    return pairs.map(() => ({ error: messageOf(error) }));
  }

  const byPeriod = new Map<number, { currency: string; total: string }[]>();
  for (const row of rows) {
    const groups = byPeriod.get(row.i) ?? [];
    groups.push(row);
    byPeriod.set(row.i, groups);
  }
  return pairs.map((pair, index) => {
    const groups = byPeriod.get(index + 1) ?? [];
    if (groups.length === 0) return { total: "0" };
    const foreign = groups.find((group) => group.currency !== pair.currency);
    if (foreign) {
      return {
        error: `a transaction in this window is in ${foreign.currency}, not the period's ${pair.currency}`,
      };
    }
    try {
      return { total: fromNumericText(groups[0]?.total ?? "0") };
    } catch (error) {
      return { error: messageOf(error) };
    }
  });
}

/**
 * One row per account per snapshot after the first, paired with its
 * immediately preceding snapshot via LAG. Each pair is one statement period.
 * An account with 0 or 1 balances rows yields no periods.
 *
 * F1-8. `balances` rows are collapsed to one per (account, as_of) before
 * pairing. Two rows at one date used to pair with each other and produce a
 * zero-length "period" that blamed a day's transactions for the difference
 * between two statements of the same balance, and left the real neighbouring
 * periods anchored on whichever of the two LAG happened to order first.
 * Collapsing first means one snapshot per date; `cash_contradicts` carries
 * the disagreement to `reconcilePeriod` instead of hiding it in a verdict
 * about transactions.
 *
 * `accountPredicate` narrows which accounts are paired at all, and nothing
 * else: one template so the incremental form cannot drift from the
 * whole-archive one. It is this file's own literal, never caller input.
 */
function pairSql(accountPredicate: string): string {
  return `SELECT account_id, as_of, cash, currency, cash_contradicts,
            prev_as_of, prev_cash, prev_currency, prev_cash_contradicts
     FROM (
       SELECT
         account_id, as_of, cash, currency, cash_contradicts,
         LAG(as_of) OVER w AS prev_as_of,
         LAG(cash) OVER w AS prev_cash,
         LAG(currency) OVER w AS prev_currency,
         LAG(cash_contradicts) OVER w AS prev_cash_contradicts
       FROM (
         SELECT
           account_id,
           as_of,
           CASE WHEN count(DISTINCT cash) > 1 THEN NULL ELSE min(cash) END AS cash,
           count(DISTINCT cash) > 1 AS cash_contradicts,
           min(currency) AS currency
         FROM balances${accountPredicate}
         GROUP BY account_id, as_of
       ) AS snapshot
       WINDOW w AS (PARTITION BY account_id ORDER BY as_of)
     ) AS paired
     WHERE prev_as_of IS NOT NULL
     ORDER BY account_id, as_of`;
}

const ACCOUNTS_IN_SCOPE = `
       WHERE account_id = ANY($1::text[])`;

function periodKey(
  accountId: string,
  periodStart: string,
  periodEnd: string,
): string {
  return `${accountId}\u0000${periodStart}\u0000${periodEnd}`;
}

/**
 * The periods one import could have moved, and no others (F1-59). The same
 * three reasons a period's verdict can differ from the one already stored as
 * `positionReconciliation.ts`'s `scopedPairs` documents at length: a stated
 * balance at one of the period's ends changed, a transaction landed inside
 * the window, or the stored verdict is not a `pass` and this account's
 * acquired history may just have reached further back.
 */
type ScopedPairs = {
  /** Only the periods this run needs to recompute a verdict for. */
  pairs: BalancePairRow[];
  /** The accounts this run evaluated, and no others (F1-72). */
  accountIds: string[];
  /**
   * Every period that currently exists for those accounts, recomputed or
   * not. This is what a period no longer being in `pairs` cannot tell you --
   * it is silent on whether the period still exists at all -- so vanished
   * windows for this run's accounts are found from this set (F1-72).
   */
  currentPairs: BalancePairRow[];
};

async function scopedPairs(
  client: ArchiveClient,
  scope: CashGateScope,
): Promise<ScopedPairs> {
  const accounts = new Set<string>();
  const changedDates = new Map<string, Set<string>>();
  const activityDates = new Map<string, string[]>();

  for (const change of scope.snapshots) {
    accounts.add(change.accountId);
    const dates = changedDates.get(change.accountId) ?? new Set<string>();
    dates.add(change.date);
    changedDates.set(change.accountId, dates);
  }
  for (const change of scope.activity) {
    accounts.add(change.accountId);
    const dates = activityDates.get(change.accountId) ?? [];
    dates.push(change.date);
    activityDates.set(change.accountId, dates);
  }
  if (accounts.size === 0) return { pairs: [], accountIds: [], currentPairs: [] };

  const stale = await client.query<{
    account_id: string;
    period_start: string;
    period_end: string;
  }>(
    `SELECT account_id, period_start, period_end
     FROM reconciliations
     WHERE account_id = ANY($1::text[]) AND status <> 'pass'`,
    [[...accounts]],
  );
  const recheck = new Set(
    stale.rows.map((row) =>
      periodKey(row.account_id, row.period_start, row.period_end),
    ),
  );

  const paired = await client.query<BalancePairRow>(
    pairSql(ACCOUNTS_IN_SCOPE),
    [[...accounts]],
  );
  const pairs = paired.rows.filter((pair) => {
    const changed = changedDates.get(pair.account_id);
    if (changed?.has(pair.as_of) === true) return true;
    if (changed?.has(pair.prev_as_of) === true) return true;
    const activity = activityDates.get(pair.account_id);
    if (
      activity?.some((date) => date > pair.prev_as_of && date <= pair.as_of) ===
      true
    ) {
      return true;
    }
    return recheck.has(periodKey(pair.account_id, pair.prev_as_of, pair.as_of));
  });
  return { pairs, accountIds: [...accounts], currentPairs: paired.rows };
}

/** One statement for every period about to be rewritten. */
async function deleteVerdicts(
  client: ArchiveClient,
  verdicts: readonly (readonly unknown[])[],
): Promise<void> {
  if (verdicts.length === 0) return;
  await client.query(
    `DELETE FROM reconciliations r
     USING unnest($1::text[], $2::date[], $3::date[])
       AS k(account_id, period_start, period_end)
     WHERE r.account_id = k.account_id
       AND r.period_start = k.period_start AND r.period_end = k.period_end`,
    [
      verdicts.map((v) => v[1]),
      verdicts.map((v) => v[2]),
      verdicts.map((v) => v[3]),
    ],
  );
}

/**
 * Deletes every stored verdict whose (account, period) is not in `pairs`
 * (F1-72). Called only for a whole-archive pass, where `pairs` is every
 * period the archive currently has, so anything else in the table is a
 * period from an earlier run -- an account re-attribution or a document
 * collapse changed the window set -- that this gate no longer evaluates.
 */
async function deleteVanishedVerdicts(
  client: ArchiveClient,
  pairs: readonly BalancePairRow[],
): Promise<void> {
  await client.query(
    `DELETE FROM reconciliations r
     WHERE NOT EXISTS (
       SELECT 1 FROM unnest($1::text[], $2::date[], $3::date[])
         AS k(account_id, period_start, period_end)
       WHERE r.account_id = k.account_id
         AND r.period_start = k.period_start AND r.period_end = k.period_end
     )`,
    [
      pairs.map((p) => p.account_id),
      pairs.map((p) => p.prev_as_of),
      pairs.map((p) => p.as_of),
    ],
  );
}

/**
 * The same, but scoped to `accountIds` -- an incremental run's own accounts,
 * never archive-wide (F1-72). `currentPairs` is `scopedPairs`' full current
 * pairing for those accounts, not only the periods this run recomputed, so a
 * period this run had no reason to recheck keeps its row.
 */
async function deleteVanishedScopedVerdicts(
  client: ArchiveClient,
  accountIds: readonly string[],
  currentPairs: readonly BalancePairRow[],
): Promise<void> {
  if (accountIds.length === 0) return;
  await client.query(
    `DELETE FROM reconciliations r
     WHERE r.account_id = ANY($4::text[])
       AND NOT EXISTS (
         SELECT 1 FROM unnest($1::text[], $2::date[], $3::date[])
           AS k(account_id, period_start, period_end)
         WHERE r.account_id = k.account_id
           AND r.period_start = k.period_start AND r.period_end = k.period_end
       )`,
    [
      currentPairs.map((p) => p.account_id),
      currentPairs.map((p) => p.prev_as_of),
      currentPairs.map((p) => p.as_of),
      accountIds,
    ],
  );
}

/** One statement for every period a newly stated balance cut in half. */
async function deleteSpannedVerdicts(
  client: ArchiveClient,
  scope: CashGateScope,
): Promise<void> {
  if (scope.snapshots.length === 0) return;
  await client.query(
    `DELETE FROM reconciliations r
     USING unnest($1::text[], $2::date[]) AS c(account_id, as_of)
     WHERE r.account_id = c.account_id
       AND r.period_start < c.as_of AND r.period_end > c.as_of`,
    [
      scope.snapshots.map((s) => s.accountId),
      scope.snapshots.map((s) => s.date),
    ],
  );
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
