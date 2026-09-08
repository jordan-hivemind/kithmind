// get_coverage: per account, what was acquired, what parsed, what
// reconciled, what is under review, and when each source was last updated.
// Reported at account granularity, matching the record-query contract's
// completeness granularity (source inventory, date range, no relevant gaps
// or pending work) so a later Kith Mind adapter wraps this surface instead
// of re-deriving it.
//
// Three states an account can be in must never collapse into one: a period
// whose reconciliation has not passed, an account with an open review item,
// and an account nothing has been acquired for yet. Only the account and
// reconciliations tables are per-account/per-period; documents,
// transactions and review_items are summarized per account because that is
// the granularity the schema actually carries for them in v1.

import type { DatabaseSync } from "node:sqlite";

import { fromMinorUnits } from "../money.js";

export type PeriodCoverage = {
  periodStart: string;
  periodEnd: string;
  status: "pass" | "fail" | "unverified";
  tolerance: string;
  currency: string;
};

export type AccountCoverage = {
  accountId: string;
  displayName: string | null;
  /** "never_acquired" means no document, transaction, reconciliation or
   * review item exists for this account at all -- distinct from an account
   * that was acquired but has an unreconciled or under-review period. */
  acquisitionState: "acquired" | "never_acquired";
  documents: {
    count: number;
    docTypes: Readonly<Record<string, number>>;
    earliestDocDate: string | null;
    latestDocDate: string | null;
  };
  transactions: {
    count: number;
    earliestProcessDate: string | null;
    latestProcessDate: string | null;
    lastImportedAt: string | null;
  };
  periods: PeriodCoverage[];
  /** Stated holdings and how far transaction history reaches behind them. */
  positions: {
    count: number;
    earliestAsOf: string | null;
    latestAsOf: string | null;
    /** True when transaction history begins after the first stated position,
     * so the earliest position periods cannot be checked at all. A measured
     * coverage gap, not a reconciliation failure. */
    historyStartsAfterFirstStatedPosition: boolean;
  };
  /** Position quantity gate, summarized. Per-instrument verdicts are in
   * position_reconciliations; counts here keep this response bounded by
   * account count rather than by instrument count. */
  positionPeriods: {
    checked: number;
    pass: number;
    fail: number;
    unverified: number;
    instruments: number;
  };
  reviewItems: { open: number; resolved: number; dismissed: number };
};

type AccountRow = { id: string; display_name: string | null };

export function getCoverage(
  db: DatabaseSync,
  accountId?: string,
): AccountCoverage[] | null {
  const accounts = (
    accountId
      ? db
          .prepare("SELECT id, display_name FROM accounts WHERE id = ?")
          .all(accountId)
      : db.prepare("SELECT id, display_name FROM accounts ORDER BY id").all()
  ) as AccountRow[];

  if (accountId !== undefined && accounts.length === 0) return null;
  return accounts.map((account) => coverageForAccount(db, account));
}

function coverageForAccount(
  db: DatabaseSync,
  account: AccountRow,
): AccountCoverage {
  const docRows = db
    .prepare("SELECT doc_type, doc_date FROM documents WHERE account_id = ?")
    .all(account.id) as { doc_type: string; doc_date: string | null }[];
  const docTypes: Record<string, number> = {};
  let earliestDocDate: string | null = null;
  let latestDocDate: string | null = null;
  for (const doc of docRows) {
    docTypes[doc.doc_type] = (docTypes[doc.doc_type] ?? 0) + 1;
    if (doc.doc_date !== null) {
      if (earliestDocDate === null || doc.doc_date < earliestDocDate) {
        earliestDocDate = doc.doc_date;
      }
      if (latestDocDate === null || doc.doc_date > latestDocDate) {
        latestDocDate = doc.doc_date;
      }
    }
  }

  const txnAgg = db
    .prepare(
      `SELECT count(*) AS n, min(process_date) AS earliest, max(process_date) AS latest,
              max(imported_at) AS last_imported
       FROM transactions WHERE account_id = ?`,
    )
    .get(account.id) as {
    n: number;
    earliest: string | null;
    latest: string | null;
    last_imported: string | null;
  };

  // tolerance is a money column (minor units); read it as BigInt like every
  // other money column so it never passes through a JS number.
  const periodStatement = db.prepare(
    `SELECT period_start, period_end, status, tolerance, currency
     FROM reconciliations WHERE account_id = ? ORDER BY period_start`,
  );
  periodStatement.setReadBigInts(true);
  const periodRows = periodStatement.all(account.id) as {
    period_start: string;
    period_end: string;
    status: "pass" | "fail" | "unverified";
    tolerance: bigint;
    currency: string;
  }[];
  const periods: PeriodCoverage[] = periodRows.map((row) => ({
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    tolerance: fromMinorUnits(row.tolerance, row.currency),
    currency: row.currency,
  }));

  const positionAgg = db
    .prepare(
      `SELECT count(*) AS n, min(as_of) AS earliest, max(as_of) AS latest
       FROM positions WHERE account_id = ?`,
    )
    .get(account.id) as { n: number; earliest: string | null; latest: string | null };

  const positionPeriodRows = db
    .prepare(
      `SELECT status, count(*) AS n
       FROM position_reconciliations WHERE account_id = ? GROUP BY status`,
    )
    .all(account.id) as {
    status: "pass" | "fail" | "unverified";
    n: number;
  }[];
  const positionPeriods = {
    checked: 0,
    pass: 0,
    fail: 0,
    unverified: 0,
    instruments: 0,
  };
  for (const row of positionPeriodRows) {
    positionPeriods[row.status] = row.n;
    positionPeriods.checked += row.n;
  }
  positionPeriods.instruments = (
    db
      .prepare(
        "SELECT count(DISTINCT instrument_id) AS n FROM position_reconciliations WHERE account_id = ?",
      )
      .get(account.id) as { n: number }
  ).n;

  const reviewRows = db
    .prepare(
      "SELECT status, count(*) AS n FROM review_items WHERE account_id = ? GROUP BY status",
    )
    .all(account.id) as {
    status: "open" | "resolved" | "dismissed";
    n: number;
  }[];
  const reviewItems = { open: 0, resolved: 0, dismissed: 0 };
  for (const row of reviewRows) reviewItems[row.status] = row.n;

  const acquisitionState: AccountCoverage["acquisitionState"] =
    docRows.length === 0 &&
    txnAgg.n === 0 &&
    periods.length === 0 &&
    positionAgg.n === 0 &&
    reviewRows.length === 0
      ? "never_acquired"
      : "acquired";

  return {
    accountId: account.id,
    displayName: account.display_name,
    acquisitionState,
    documents: {
      count: docRows.length,
      docTypes,
      earliestDocDate,
      latestDocDate,
    },
    transactions: {
      count: txnAgg.n,
      earliestProcessDate: txnAgg.earliest,
      latestProcessDate: txnAgg.latest,
      lastImportedAt: txnAgg.last_imported,
    },
    periods,
    positions: {
      count: positionAgg.n,
      earliestAsOf: positionAgg.earliest,
      latestAsOf: positionAgg.latest,
      historyStartsAfterFirstStatedPosition:
        positionAgg.earliest !== null &&
        (txnAgg.earliest === null || txnAgg.earliest > positionAgg.earliest),
    },
    positionPeriods,
    reviewItems,
  };
}
