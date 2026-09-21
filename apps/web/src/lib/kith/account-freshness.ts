// FIN-FRESHNESS-1: whether one finance account's archive is keeping up with
// the statements its institution sends.
//
// Pure. Every input is a date the archive holds a row for; nothing here
// invents a snapshot date, closes an account, or reads a balance's size.
// "Expected by" dates are computed only to say when a missing statement
// becomes a gap, and they are shown as expectations, never as data.
//
// Why cadence matters: a brokerage sends a statement every month the account
// has activity and at least one every quarter end. A single 45-day threshold
// calls a quiet quarterly account stale for most of every quarter, and
// judging holdings by their own age calls an all-cash account stale forever.
// Both hid the one case that is a real gap: statements keep arriving and the
// holdings in them stopped being recorded.

/** How often the archive's own balance dates say statements arrive. */
export type StatementCadence = "monthly" | "quarterly" | "unknown";

/** Why an account has the status it has. One code per account row. */
export type FreshnessReason =
  // not live
  | "empty"
  | "closed"
  | "dormant"
  // fresh
  | "current"
  | "balance_only"
  | "no_balance"
  // stale
  | "statement_overdue"
  | "holdings_behind"
  | "holdings_missing";

export type FreshnessStatus = "fresh" | "stale" | "inactive" | "empty";

export type AccountFreshnessInput = {
  /** Any statement or record at all. */
  hasContent: boolean;
  /** The owner's closed flag. Never inferred. */
  closed: boolean;
  accountType: string | null;
  activityTo: string | null;
  latestSnapshotAsOf: string | null;
  /** Distinct balance dates, newest first. Empty when there are none. */
  balanceDates: readonly string[];
  /** See `FinanceAccountInventoryRecord.latestBalanceHoldsSecurities`. */
  latestBalanceHoldsSecurities: boolean | null;
};

export type AccountFreshness = {
  status: FreshnessStatus;
  reason: FreshnessReason;
  cadence: StatementCadence;
  /** When the next statement becomes overdue. Null when no statement is
   * expected (not live, or no balance to measure cadence from). */
  expectedBy: string | null;
  statusDetail: string | null;
};

/**
 * Days after a period ends before its statement counts as missing. Statements
 * post within a week or two of the period end; three weeks leaves room for a
 * late one without letting a missing one pass for a month.
 */
export const STATEMENT_GRACE_DAYS = 20;

/**
 * How long an account can go without any activity before it is dormant
 * rather than behind: a quarter and a month for a monthly (or unknown)
 * account, two quarters and the grace for a quarterly one. Past this the
 * account has stopped, not missed a statement. The owner's Closed flag is the
 * only thing that says an account is closed.
 */
export function dormantAfterDays(cadence: StatementCadence): number {
  return cadence === "quarterly" ? 2 * 92 + STATEMENT_GRACE_DAYS : 100;
}

/**
 * Account types that hold no securities, so no holdings snapshot is ever
 * expected. Matched on the shown type, lower-cased.
 */
const NO_HOLDINGS_TYPES = new Set([
  "bank",
  "checking",
  "savings",
  "cash",
  "credit_card",
  "credit_line",
  "loan",
  "mortgage",
]);

const DAY = 24 * 60 * 60 * 1000;
/** How many recent balance months the cadence is read from. */
const CADENCE_WINDOW = 7;
/**
 * A longer allowance needs repeated evidence. Three long intervals require
 * four observed statement months and prevent one missed monthly import from
 * teaching the account a quarterly cadence.
 */
const QUARTERLY_INTERVALS_REQUIRED = 3;

function parts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return { year, month, day };
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Last day of a month, leap years included. `month` is 1 to 12. */
function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthIndex(date: string): number {
  const { year, month } = parts(date);
  return year * 12 + (month - 1);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
}

/** The UTC calendar date of an instant. */
export function dateOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function ageDays(asOf: string, now: number): number {
  return Math.floor(Math.max(now - Date.parse(`${asOf}T00:00:00Z`), 0) / DAY);
}

/**
 * The first period end strictly after `date`: a month end for a monthly (or
 * unknown) cadence, a quarter end for a quarterly one. A statement dated
 * mid-month is followed by that month's own end.
 */
export function nextPeriodEnd(date: string, cadence: StatementCadence): string {
  const { year, month, day } = parts(date);
  let y = year;
  let m = month;
  if (day >= lastDay(y, m)) {
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  if (cadence === "quarterly") {
    while (m % 3 !== 0) m += 1;
  }
  return iso(y, m, lastDay(y, m));
}

/**
 * The cadence the archive's own balance dates show.
 *
 * `monthly` when each of the recent balances is one month after the one
 * before. `quarterly` requires at least three repeated long intervals; gaps
 * must be at most three months and every long gap must end on a quarter end.
 * That admits a statement monthly while active and quarterly while quiet,
 * but neither two isolated dates nor one missed monthly import earns the
 * longer allowance. Anything else, including sparse or interrupted history,
 * is `unknown`, which is judged as monthly: an unknown cadence never earns a
 * longer allowance than the strictest regular one.
 */
export function inferCadence(
  balanceDates: readonly string[],
): StatementCadence {
  const months: number[] = [];
  for (const date of balanceDates) {
    const index = monthIndex(date);
    if (months.at(-1) !== index) months.push(index);
    if (months.length === CADENCE_WINDOW) break;
  }
  if (months.length < 2) return "unknown";
  let monthly = true;
  let quarterlyIntervals = 0;
  for (let i = 1; i < months.length; i += 1) {
    const gap = months[i - 1]! - months[i]!;
    if (gap < 1 || gap > 3) return "unknown";
    if (gap === 1) continue;
    monthly = false;
    // The later date of a long gap must be a quarter end month.
    if ((months[i - 1]! % 12) % 3 !== 2) return "unknown";
    quarterlyIntervals += 1;
  }
  if (monthly) return "monthly";
  return quarterlyIntervals >= QUARTERLY_INTERVALS_REQUIRED
    ? "quarterly"
    : "unknown";
}

function cadenceLabel(cadence: StatementCadence): string {
  return cadence === "unknown" ? "cadence unknown" : cadence;
}

function later(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

/**
 * One account's status, the reason behind it, and the tooltip's words.
 *
 * | Case | Status | Reason |
 * | --- | --- | --- |
 * | no statement or record | empty | empty |
 * | owner marked Closed | inactive | closed |
 * | no activity past `dormantAfterDays` | inactive | dormant |
 * | latest balance past its next period end plus grace | stale | statement_overdue |
 * | balances current, latest says it holds securities, never a snapshot | stale | holdings_missing |
 * | balances current, snapshot older than the latest balance and itself overdue | stale | holdings_behind |
 * | balances current, all cash or a cash-type account | fresh | balance_only |
 * | no balance at all (activity only) | fresh | no_balance |
 * | otherwise | fresh | current |
 *
 * `latestSnapshotAsOf` and the balance dates are never merged into one date:
 * a current balance says the statements are arriving, and only a snapshot says
 * the holdings in them were recorded.
 */
export function accountFreshness(
  input: AccountFreshnessInput,
  now: number,
): AccountFreshness {
  const cadence = inferCadence(input.balanceDates);
  const none = (
    status: FreshnessStatus,
    reason: FreshnessReason,
    statusDetail: string | null,
  ): AccountFreshness => ({
    status,
    reason,
    cadence,
    expectedBy: null,
    statusDetail,
  });
  if (!input.hasContent) return none("empty", "empty", null);
  if (input.closed) return none("inactive", "closed", "marked closed");

  const quietAfter = dormantAfterDays(cadence);
  if (input.activityTo !== null) {
    const quiet = ageDays(input.activityTo, now);
    if (quiet > quietAfter) {
      return none(
        "inactive",
        "dormant",
        `no activity since ${input.activityTo}, ${quiet} days ago`,
      );
    }
  }

  const today = dateOf(now);
  const dueAfter = (date: string) =>
    addDays(nextPeriodEnd(date, cadence), STATEMENT_GRACE_DAYS);
  const latestBalance = input.balanceDates[0] ?? null;
  const type = input.accountType?.toLowerCase() ?? null;
  const holdingsExpected =
    input.latestBalanceHoldsSecurities === false ||
    (type !== null && NO_HOLDINGS_TYPES.has(type))
      ? false
      : input.latestBalanceHoldsSecurities === true ||
        input.latestSnapshotAsOf !== null;

  if (latestBalance === null) {
    // No balance, so no statement cadence to hold the account to. Holdings
    // alone can still fall behind: judge the snapshot as monthly.
    if (holdingsExpected && input.latestSnapshotAsOf !== null) {
      const due = dueAfter(input.latestSnapshotAsOf);
      if (today > due) {
        return {
          status: "stale",
          reason: "holdings_behind",
          cadence,
          expectedBy: due,
          statusDetail:
            `holdings last recorded ${input.latestSnapshotAsOf}, next expected by ${due}; ` +
            "no statement balance recorded",
        };
      }
      return {
        status: "fresh",
        reason: "current",
        cadence,
        expectedBy: due,
        statusDetail: `holdings recorded ${input.latestSnapshotAsOf}; no statement balance recorded`,
      };
    }
    return none(
      "fresh",
      "no_balance",
      input.activityTo === null
        ? "no statement balance recorded"
        : `no statement balance recorded; activity through ${input.activityTo}`,
    );
  }

  const statementDue = dueAfter(latestBalance);
  if (today > statementDue) {
    return {
      status: "stale",
      reason: "statement_overdue",
      cadence,
      expectedBy: statementDue,
      statusDetail:
        `latest statement balance ${latestBalance}, ${ageDays(latestBalance, now)} days ago; ` +
        `next was expected by ${statementDue} (${cadenceLabel(cadence)})`,
    };
  }

  if (holdingsExpected) {
    const snapshot = input.latestSnapshotAsOf;
    if (snapshot === null && input.latestBalanceHoldsSecurities === true) {
      return {
        status: "stale",
        reason: "holdings_missing",
        cadence,
        expectedBy: statementDue,
        statusDetail:
          `statement balance current to ${latestBalance} and holds securities; ` +
          "no holdings recorded",
      };
    }
    if (snapshot !== null && snapshot < latestBalance) {
      const holdingsDue = dueAfter(snapshot);
      if (today > holdingsDue) {
        return {
          status: "stale",
          reason: "holdings_behind",
          cadence,
          expectedBy: statementDue,
          statusDetail:
            `statement balance current to ${latestBalance}; ` +
            `holdings last recorded ${snapshot}`,
        };
      }
    }
  }

  const expected = `next expected by ${statementDue} (${cadenceLabel(cadence)})`;
  if (!holdingsExpected) {
    return {
      status: "fresh",
      reason: "balance_only",
      cadence,
      expectedBy: statementDue,
      statusDetail: `balance only, latest statement balance ${latestBalance}; ${expected}`,
    };
  }
  return {
    status: "fresh",
    reason: "current",
    cadence,
    expectedBy: statementDue,
    statusDetail: `latest statement ${later(latestBalance, input.latestSnapshotAsOf)}; ${expected}`,
  };
}

/**
 * Whether a reported value is too old to read as the account's value now:
 * older than the account's own dormancy threshold, so a quarterly account's
 * quarter-end balance stays current until its next quarter is overdue.
 * Exactly the threshold is still current; a day past it is not.
 */
export function valueIsStale(
  currentValueAsOf: string | null,
  now: number,
  cadence: StatementCadence = "monthly",
): boolean {
  return (
    currentValueAsOf !== null &&
    ageDays(currentValueAsOf, now) > dormantAfterDays(cadence)
  );
}
