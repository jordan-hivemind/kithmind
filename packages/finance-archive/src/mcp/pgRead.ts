// The archive's read surface on Postgres (F1-21), serving the six operations
// `@repo/finance-contract` defines. This replaces the SQLite `run_query`
// surface entirely: there is no caller-supplied SQL here at all, which is the
// typed-bounded-query rule the plan stopped waiving.
//
// Three properties are carried forward from the surface this replaces,
// because each of them is a correctness property rather than a nicety:
//
//   1. Every response carries the dataset revision and an explicit
//      completeness state. All of one response's queries run inside one
//      REPEATABLE READ, READ ONLY transaction, so the revision it reports is
//      the snapshot every number in it was computed from -- a laptop querying
//      mid-import sees one settled dataset, never half a ledger.
//   2. A truncated result is marked truncated and never silently short.
//   3. Zero rows with unknown coverage means no indexed match, not proof that
//      no event occurred. This is why `get_coverage` reports `unknown` with a
//      `source_gap` for a source nothing vouches for, rather than reporting a
//      clean empty range as `complete`. This workstream has been burned once
//      by a confident false negative.
//
// What the archive cannot satisfy today, stated here rather than approximated
// (see `retainedTextSpanEvidence` below): the contract's evidence type.

import type pg from "pg";

import {
  type AggregateMoneyRequest,
  type CanonicalFinanceDecimal,
  canonicalizeFinanceDecimal,
  type FinanceAccountId,
  type FinanceAggregateRecord,
  type FinanceCoverageRecord,
  type FinanceCoverageSummary,
  type FinanceCurrency,
  type FinanceDatasetRevision,
  type FinanceReadRequest,
  type FinanceReadResponse,
  type FinanceRecordId,
  type FinanceRecordKind,
  type FinanceSourceId,
  type FinanceSpaceId,
  FinanceContractError,
  type GetCoverageRequest,
  type GetEvidenceRequest,
  type ListBalancesRequest,
  type ListHoldingsRequest,
  type ListTransactionsRequest,
  parseFinanceCurrency,
  parseFinanceReadResponseShape,
  type RetainedTextSpanEvidence,
  SUPPORTED_FINANCE_CURRENCIES,
} from "@repo/finance-contract";

import { fromNumericText } from "../pgNumeric.js";
import { READER_STATEMENT_TIMEOUT_MS } from "../pgReaderRole.js";
import { archiveSchemaOf } from "../pgStore.js";

/** Ceiling on rows any one coverage-support query may return. */
const MAX_SUPPORT_ROWS = 500;
/** The contract caps a coverage record at 32 gaps. */
const MAX_COVERAGE_GAPS = 32;
/** The contract caps contributor ids at 25 before a breakdown is required. */
const MAX_CONTRIBUTORS = 25;
/** Floor for a coverage range when the archive has no dates to bound it. */
const MIN_PLAUSIBLE_DATE = "1900-01-01";

const supportedCurrencies = new Set<string>(SUPPORTED_FINANCE_CURRENCIES);

/**
 * Reasons a value or record was withheld from a response, or a range is not
 * vouched for. Every one of these is a `FinanceCoverageSummary` reason, so a
 * caller reads them from `coverage.reasons` rather than from prose.
 */
type WithholdReason =
  | "unsupported_value"
  | "retained_evidence_unavailable"
  | "source_gap"
  | "pending_import"
  | "failed_import"
  | "stale_source";

/**
 * **The archive cannot produce the contract's evidence type today.**
 *
 * `RetainedTextSpanEvidence` is a character span inside a retained text blob:
 * it requires `start`, `end`, `quote` and `quoteSha256` in Unicode code
 * points, plus `textSha256`, `textByteLength`, `textCodepointLength`,
 * `retainedByteLength`, `mediaType`, `revisionId` and `captureId`.
 *
 * What the archive has is `documents.sha256`, `documents.file_path`,
 * `documents.text_path`, and a `source_locator` that adapters fill with
 * `FieldLocator` values -- a capability tier, a row index or page number, and
 * a column label. A row index is not a character offset, and no code in this
 * package has ever produced one. `documents` carries no byte length and no
 * media type, and capture and revision identity live in the raw tree's
 * capture manifests on the always-on machine's filesystem, which the read
 * surface does not have.
 *
 * The contract requires at least one evidence item on every transaction,
 * holding and balance record, so a record whose evidence cannot be built
 * cannot be returned at all. The choice is between fabricating a quote to
 * fill the shape and withholding the record. A fabricated citation on a
 * financial figure is the worst failure this archive has, so records are
 * withheld, and every response that withholds one says so: coverage carries
 * `retained_evidence_unavailable` and completeness is `partial`. A caller can
 * still see that rows *matched* -- `truncated` and the coverage reason
 * together say "there is something here you cannot cite yet", which is not
 * the same claim as absence.
 *
 * Closing this needs three things outside F1-21's scope: character-offset
 * locators from the parsers, retained byte length and media type on
 * `documents`, and capture and revision identity reachable from the database.
 * When they exist, this function is where they are assembled and the three
 * list operations start returning rows with no other change here.
 */
function retainedTextSpanEvidence(): RetainedTextSpanEvidence[] | null {
  return null;
}

type ReadScope = {
  spaceId: FinanceSpaceId;
  datasetRevision: FinanceDatasetRevision;
  withheld: Set<WithholdReason>;
};

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify({ v: 1, k: payload }), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(cursor: string | undefined): unknown {
  if (cursor === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { v?: unknown }).v === 1
    ) {
      return (parsed as { k: unknown }).k;
    }
  } catch {
    // A cursor this surface did not mint is an invalid request, not a reason
    // to silently serve page one, which would loop a caller forever.
  }
  throw new FinanceContractError("invalid_request");
}

/** A NUMERIC column as a contract decimal, or null when it cannot be one. */
function decimalOrNull(
  value: unknown,
  scope: ReadScope,
): CanonicalFinanceDecimal | null {
  if (value === null || value === undefined) return null;
  try {
    return canonicalizeFinanceDecimal(fromNumericText(value));
  } catch {
    // Past the contract's 38 significant digits or 18 fractional places, or
    // non-finite. An explicit out-of-range outcome, never a rounding and
    // never a silent omission: the value is withheld and the response says a
    // value was unsupported.
    scope.withheld.add("unsupported_value");
    return null;
  }
}

function currencyOrNull(
  value: unknown,
  scope: ReadScope,
): FinanceCurrency | null {
  if (typeof value !== "string" || !supportedCurrencies.has(value)) {
    scope.withheld.add("unsupported_value");
    return null;
  }
  return parseFinanceCurrency(value);
}

/**
 * One response's snapshot. REPEATABLE READ so every query behind one answer
 * sees one dataset, READ ONLY so the transaction itself refuses a write even
 * before privileges are consulted, and a `SET LOCAL statement_timeout` on top
 * of the role's own default so a raised role setting does not raise this one.
 */
async function withReadSnapshot<T>(
  client: pg.ClientBase,
  body: () => Promise<T>,
): Promise<T> {
  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  try {
    await client.query(`SET LOCAL search_path TO ${archiveSchemaOf(client)}`);
    await client.query(
      `SET LOCAL statement_timeout = '${READER_STATEMENT_TIMEOUT_MS}ms'`,
    );
    const result = await body();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * A token that changes exactly when the archive's content changes and is
 * stable across repeated reads of an unchanged archive, so a caller can pin
 * one with `expectedDatasetRevision`.
 *
 * Derived from the archive's own content rather than from a transaction id:
 * `pg_snapshot_xmin` advances with unrelated activity anywhere in the
 * cluster, which would make two identical reads report two revisions and
 * break exactly the pinning the field exists for.
 *
 * ponytail: counts and maxima over every table, which is a scan per table.
 * Fine for an archive of tens of thousands of rows queried occasionally.
 * Upgrade path if it stops being fine: a revision row written by
 * `publishImport`, which is the real publication boundary.
 */
const REVISION_TABLES = [
  "institutions",
  "accounts",
  "instruments",
  "documents",
  "transactions",
  "positions",
  "balances",
  "liabilities",
  "commitments",
  "import_runs",
  "reconciliations",
  "position_reconciliations",
  "review_items",
] as const;

async function datasetRevision(
  client: pg.ClientBase,
): Promise<FinanceDatasetRevision> {
  const parts = REVISION_TABLES.map(
    (table) =>
      `(SELECT coalesce(count(*)::text || ':' || coalesce(max(id), ''), '') FROM ${table})`,
  ).join(" || '|' || ");
  const result = await client.query<{ revision: string }>(
    `SELECT md5(${parts}) AS revision`,
  );
  return `rev-${result.rows[0]!.revision}` as FinanceDatasetRevision;
}

function coverageSummaryOf(scope: ReadScope): FinanceCoverageSummary {
  if (scope.withheld.size === 0) return { status: "complete", asOf: Date.now() };
  const reasons = [...scope.withheld];
  // `source_gap` means something the archive has no record of at all, which
  // is the difference between "partial" and "unknown": a caller must not read
  // absence out of a range nothing vouches for.
  const status = scope.withheld.has("source_gap") ? "unknown" : "partial";
  return { status, asOf: Date.now(), reasons };
}

function envelope(
  scope: ReadScope,
  operation: FinanceReadRequest["operation"],
  truncated: boolean,
  nextCursor: string | undefined,
) {
  const coverage = coverageSummaryOf(scope);
  const complete = !truncated && coverage.status === "complete";
  return {
    contractVersion: 1 as const,
    operation,
    spaceId: scope.spaceId,
    datasetRevision: scope.datasetRevision,
    coverage,
    completeness: complete ? ("complete" as const) : ("partial" as const),
    truncated,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    issues: [],
  };
}

// --- list operations --------------------------------------------------------

type ListRow = {
  id: string;
  account_id: string;
  ordinal: string;
};

/**
 * Runs one page of a list operation and reports how much of it survived.
 *
 * Every list operation withholds every row today, for the reason
 * `retainedTextSpanEvidence` gives. The query still runs and the page is
 * still bounded, because "rows matched but none can be cited" and "no row
 * matched" are different answers and a caller has to be able to tell them
 * apart.
 */
async function listPage(
  client: pg.ClientBase,
  scope: ReadScope,
  sql: string,
  values: unknown[],
  limit: number,
): Promise<{ truncated: boolean; nextCursor: string | undefined }> {
  const result = await client.query<ListRow>(sql, [...values, limit + 1]);
  const rows = result.rows;
  const page = rows.slice(0, limit);
  for (const _row of page) {
    if (retainedTextSpanEvidence() === null) {
      scope.withheld.add("retained_evidence_unavailable");
    }
  }
  const truncated = rows.length > limit;
  const last = page[page.length - 1];
  return {
    truncated,
    nextCursor:
      truncated && last ? encodeCursor([last.ordinal, last.id]) : undefined,
  };
}

function cursorBounds(cursor: string | undefined): [string | null, string | null] {
  const decoded = decodeCursor(cursor);
  if (decoded === undefined) return [null, null];
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== "string" ||
    typeof decoded[1] !== "string"
  ) {
    throw new FinanceContractError("invalid_request");
  }
  return [decoded[0], decoded[1]];
}

async function listTransactions(
  client: pg.ClientBase,
  scope: ReadScope,
  request: ListTransactionsRequest,
): Promise<FinanceReadResponse> {
  const [afterDate, afterId] = cursorBounds(request.cursor);
  const page = await listPage(
    client,
    scope,
    `SELECT t.id, t.account_id, t.process_date AS ordinal
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       JOIN institutions i ON i.id = a.institution_id
      WHERE ($1::text IS NULL OR i.slug = $1)
        AND ($2::text IS NULL OR t.account_id = $2)
        AND ($3::text IS NULL OR t.currency = $3)
        AND ($4::date IS NULL OR t.process_date >= $4::date)
        AND ($5::date IS NULL OR t.process_date < $5::date)
        AND ($6::date IS NULL OR (t.process_date, t.id) > ($6::date, $7::text))
      ORDER BY t.process_date, t.id
      LIMIT $8`,
    [
      request.sourceId ?? null,
      request.accountId ?? null,
      request.currency ?? null,
      request.from ?? null,
      request.toExclusive ?? null,
      afterDate,
      afterId,
    ],
    request.limit,
  );
  await foldScopeCoverage(client, scope, {
    ...(request.sourceId === undefined ? {} : { sourceId: request.sourceId }),
    ...(request.from === undefined ? {} : { from: request.from }),
    ...(request.toExclusive === undefined
      ? {}
      : { toExclusive: request.toExclusive }),
    kinds: ["transaction"],
  });
  return {
    ...envelope(scope, "list_transactions", page.truncated, page.nextCursor),
    operation: "list_transactions",
    items: [],
  } as FinanceReadResponse;
}

async function listHoldings(
  client: pg.ClientBase,
  scope: ReadScope,
  request: ListHoldingsRequest,
): Promise<FinanceReadResponse> {
  const [afterDate, afterId] = cursorBounds(request.cursor);
  const page = await listPage(
    client,
    scope,
    `SELECT p.id, p.account_id, p.as_of AS ordinal
       FROM positions p
       JOIN accounts a ON a.id = p.account_id
       JOIN institutions i ON i.id = a.institution_id
      WHERE ($1::text IS NULL OR i.slug = $1)
        AND ($2::text IS NULL OR p.account_id = $2)
        AND ($3::date IS NULL OR p.as_of <= $3::date)
        AND ($4::date IS NULL OR (p.as_of, p.id) > ($4::date, $5::text))
      ORDER BY p.as_of, p.id
      LIMIT $6`,
    [
      request.sourceId ?? null,
      request.accountId ?? null,
      request.asOf ?? null,
      afterDate,
      afterId,
    ],
    request.limit,
  );
  await foldScopeCoverage(client, scope, {
    ...(request.sourceId === undefined ? {} : { sourceId: request.sourceId }),
    ...(request.asOf === undefined ? {} : { toExclusive: addDays(request.asOf, 1) }),
    kinds: ["holding"],
  });
  return {
    ...envelope(scope, "list_holdings", page.truncated, page.nextCursor),
    operation: "list_holdings",
    items: [],
  } as FinanceReadResponse;
}

async function listBalances(
  client: pg.ClientBase,
  scope: ReadScope,
  request: ListBalancesRequest,
): Promise<FinanceReadResponse> {
  const [afterDate, afterId] = cursorBounds(request.cursor);
  const page = await listPage(
    client,
    scope,
    `SELECT b.id, b.account_id, b.as_of AS ordinal
       FROM balances b
       JOIN accounts a ON a.id = b.account_id
       JOIN institutions i ON i.id = a.institution_id
      WHERE ($1::text IS NULL OR i.slug = $1)
        AND ($2::text IS NULL OR b.account_id = $2)
        AND ($3::date IS NULL OR b.as_of >= $3::date)
        AND ($4::date IS NULL OR b.as_of < $4::date)
        AND ($5::date IS NULL OR (b.as_of, b.id) > ($5::date, $6::text))
      ORDER BY b.as_of, b.id
      LIMIT $7`,
    [
      request.sourceId ?? null,
      request.accountId ?? null,
      request.from ?? null,
      request.toExclusive ?? null,
      afterDate,
      afterId,
    ],
    request.limit,
  );
  await foldScopeCoverage(client, scope, {
    ...(request.sourceId === undefined ? {} : { sourceId: request.sourceId }),
    ...(request.from === undefined ? {} : { from: request.from }),
    ...(request.toExclusive === undefined
      ? {}
      : { toExclusive: request.toExclusive }),
    kinds: ["balance"],
  });
  return {
    ...envelope(scope, "list_balances", page.truncated, page.nextCursor),
    operation: "list_balances",
    items: [],
  } as FinanceReadResponse;
}

// --- aggregate_money --------------------------------------------------------

type AggregateRow = {
  currency: string;
  account_id: string | null;
  total: string | null;
  contributors: string;
  ids: string[];
};

/**
 * The SQL behind each metric. Every one of them groups by currency, which is
 * how "a total never crosses currencies" is made structural rather than
 * remembered: there is no shape of request that sums two currencies into one
 * number, because the grouping key always contains the currency.
 *
 * The three holdings metrics reduce to the latest stated snapshot per account
 * inside the requested window before summing. Summing every snapshot in a
 * range would count the same position once per statement, which is a wrong
 * answer that looks like a plausible one.
 */
function aggregateSql(
  request: AggregateMoneyRequest,
  groupsByAccount: boolean,
): { sql: string; values: unknown[] } {
  const account = groupsByAccount ? ", a.id AS account_id" : ", NULL AS account_id";
  const group = groupsByAccount ? ", a.id" : "";
  const shared = [
    request.sourceId ?? null,
    request.accountId ?? null,
    request.from ?? null,
    request.toExclusive ?? null,
  ];

  if (request.metric === "transaction_amount") {
    return {
      sql: `SELECT t.currency${account}, sum(t.amount) AS total,
                   count(*)::text AS contributors,
                   (array_agg('txn:' || t.id ORDER BY t.process_date, t.id))[1:${MAX_CONTRIBUTORS}] AS ids
              FROM transactions t
              JOIN accounts a ON a.id = t.account_id
              JOIN institutions i ON i.id = a.institution_id
             WHERE t.amount IS NOT NULL
               AND ($1::text IS NULL OR i.slug = $1)
               AND ($2::text IS NULL OR t.account_id = $2)
               AND ($3::date IS NULL OR t.process_date >= $3::date)
               AND ($4::date IS NULL OR t.process_date < $4::date)
               AND ($5::text IS NULL OR t.currency = $5)
             GROUP BY t.currency${group}
             ORDER BY t.currency${group}
             LIMIT $6`,
      values: [...shared, request.currency ?? null],
    };
  }

  const [table, column, dateColumn] =
    request.metric === "cash"
      ? ["balances", "cash", "as_of"]
      : [
          "positions",
          request.metric === "market_value" ? "market_value" : "cost_basis",
          "as_of",
        ];

  return {
    sql: `WITH scoped AS (
            SELECT s.*, a.id AS acct, i.slug AS slug
              FROM ${table} s
              JOIN accounts a ON a.id = s.account_id
              JOIN institutions i ON i.id = a.institution_id
             WHERE ($1::text IS NULL OR i.slug = $1)
               AND ($2::text IS NULL OR s.account_id = $2)
               AND ($3::date IS NULL OR s.${dateColumn} >= $3::date)
               AND ($4::date IS NULL OR s.${dateColumn} < $4::date)
          ),
          latest AS (
            SELECT acct, max(${dateColumn}) AS ${dateColumn} FROM scoped GROUP BY acct
          )
          SELECT s.currency${groupsByAccount ? ", s.acct AS account_id" : ", NULL AS account_id"},
                 sum(s.${column}) AS total,
                 count(*)::text AS contributors,
                 (array_agg('${table === "balances" ? "bal" : "pos"}:' || s.id ORDER BY s.id))[1:${MAX_CONTRIBUTORS}] AS ids
            FROM scoped s
            JOIN latest l ON l.acct = s.acct AND l.${dateColumn} = s.${dateColumn}
           WHERE s.${column} IS NOT NULL
             AND ($5::text IS NULL OR s.currency = $5)
           GROUP BY s.currency${groupsByAccount ? ", s.acct" : ""}
           ORDER BY s.currency${groupsByAccount ? ", s.acct" : ""}
           LIMIT $6`,
    values: [...shared, request.currency ?? null],
  };
}

async function aggregateMoney(
  client: pg.ClientBase,
  scope: ReadScope,
  request: AggregateMoneyRequest,
): Promise<FinanceReadResponse> {
  const groupsByAccount = request.groupBy === "account_currency";
  const { sql, values } = aggregateSql(request, groupsByAccount);
  const result = await client.query<AggregateRow>(sql, [
    ...values,
    request.limit + 1,
  ]);
  const rows = result.rows.slice(0, request.limit);
  const truncated = result.rows.length > request.limit;

  const items: FinanceAggregateRecord[] = [];
  for (const row of rows) {
    const currency = currencyOrNull(row.currency, scope);
    const decimal = decimalOrNull(row.total, scope);
    if (currency === null || decimal === null) continue;
    const contributingRecordCount = Number(row.contributors);
    const contributorRecordIds = (row.ids ?? []).map(
      (id) => id as FinanceRecordId,
    );
    const needsBreakdown =
      contributingRecordCount > contributorRecordIds.length;
    items.push({
      currency,
      total: { decimal, currency },
      contributingRecordCount,
      contributorRecordIds,
      ...(groupsByAccount && row.account_id !== null
        ? { accountId: row.account_id as FinanceAccountId }
        : {}),
      ...(needsBreakdown
        ? {
            breakdown: {
              queryReference: `aggregate_money.${request.metric}.${currency}`,
              cursor: encodeCursor([
                request.metric,
                currency,
                row.account_id ?? "",
              ]),
            },
          }
        : {}),
    });
  }

  await foldScopeCoverage(client, scope, {
    ...(request.sourceId === undefined ? {} : { sourceId: request.sourceId }),
    ...(request.from === undefined ? {} : { from: request.from }),
    ...(request.toExclusive === undefined
      ? {}
      : { toExclusive: request.toExclusive }),
    kinds: [
      request.metric === "transaction_amount"
        ? "transaction"
        : request.metric === "cash"
          ? "balance"
          : "holding",
    ],
  });

  const last = rows[rows.length - 1];
  return {
    ...envelope(
      scope,
      "aggregate_money",
      truncated,
      truncated && last
        ? encodeCursor([last.currency, last.account_id ?? ""])
        : undefined,
    ),
    operation: "aggregate_money",
    items,
  } as FinanceReadResponse;
}

// --- get_evidence -----------------------------------------------------------

const RECORD_TABLES: Readonly<Record<string, string>> = Object.freeze({
  txn: "transactions",
  pos: "positions",
  bal: "balances",
});

async function getEvidence(
  client: pg.ClientBase,
  scope: ReadScope,
  request: GetEvidenceRequest,
): Promise<FinanceReadResponse> {
  const separator = request.recordId.indexOf(":");
  const table = RECORD_TABLES[request.recordId.slice(0, separator)];
  const id = request.recordId.slice(separator + 1);
  if (!table || id.length === 0) {
    // Not a record id this surface mints. Absence of evidence for an id the
    // archive has never heard of is a coverage gap, not a citation-free row.
    scope.withheld.add("source_gap");
  } else {
    const found = await client.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE id = $1`,
      [id],
    );
    scope.withheld.add(
      found.rowCount ? "retained_evidence_unavailable" : "source_gap",
    );
  }
  return {
    ...envelope(scope, "get_evidence", false, undefined),
    operation: "get_evidence",
    recordId: request.recordId,
    items: [],
  } as FinanceReadResponse;
}

// --- get_coverage -----------------------------------------------------------

type Gap = FinanceCoverageRecord["gaps"][number];

type SourceRow = {
  slug: string;
  accounts: string;
  transactions: string;
  positions: string;
  balances: string;
  documents: string;
  txn_min: string | null;
  txn_max: string | null;
  pos_min: string | null;
  pos_max: string | null;
  bal_min: string | null;
  bal_max: string | null;
};

type PeriodRow = {
  slug: string;
  period_start: string;
  period_end: string;
  status: "pass" | "fail" | "unverified";
};

type ReviewRow = {
  slug: string;
  open: string;
  first_date: string | null;
  last_date: string | null;
  undated: string;
};

/** Merges overlapping and touching gaps of the same code, keeping order. */
function mergeGaps(gaps: Gap[]): Gap[] {
  const sorted = [...gaps].sort(
    (left, right) => left.from.localeCompare(right.from) || left.code.localeCompare(right.code),
  );
  const merged: Gap[] = [];
  for (const gap of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && previous.code === gap.code && gap.from <= previous.toExclusive) {
      if (gap.toExclusive > previous.toExclusive) {
        merged[merged.length - 1] = { ...previous, toExclusive: gap.toExclusive };
      }
      continue;
    }
    merged.push(gap);
  }
  if (merged.length <= MAX_COVERAGE_GAPS) return merged;
  // Coalescing the tail rather than dropping it: a dropped gap would understate
  // what is missing, which is the one direction this must never fail in.
  const head = merged.slice(0, MAX_COVERAGE_GAPS - 1);
  const tail = merged.slice(MAX_COVERAGE_GAPS - 1);
  head.push({
    code: "source_gap",
    from: tail[0]!.from,
    toExclusive: tail.reduce(
      (latest, gap) => (gap.toExclusive > latest ? gap.toExclusive : latest),
      tail[0]!.toExclusive,
    ),
  });
  return head;
}

function clampGap(gap: Gap, from: string, toExclusive: string): Gap | null {
  const start = gap.from < from ? from : gap.from;
  const end = gap.toExclusive > toExclusive ? toExclusive : gap.toExclusive;
  return start < end ? { code: gap.code, from: start, toExclusive: end } : null;
}

/** The parts of [from, toExclusive) no verdict covers. Nothing vouches there. */
function uncovered(
  periods: readonly { from: string; toExclusive: string }[],
  from: string,
  toExclusive: string,
): Gap[] {
  const sorted = [...periods].sort((left, right) =>
    left.from.localeCompare(right.from),
  );
  const gaps: Gap[] = [];
  let cursor = from;
  for (const period of sorted) {
    if (period.toExclusive <= cursor) continue;
    if (period.from > cursor) {
      gaps.push({
        code: "source_gap",
        from: cursor,
        toExclusive: period.from < toExclusive ? period.from : toExclusive,
      });
    }
    cursor = period.toExclusive > cursor ? period.toExclusive : cursor;
    if (cursor >= toExclusive) break;
  }
  if (cursor < toExclusive) {
    gaps.push({ code: "source_gap", from: cursor, toExclusive });
  }
  return gaps.filter((gap) => gap.from < gap.toExclusive);
}

/** What a coverage question is asked about, from any operation. */
type CoverageFilters = {
  sourceId?: string;
  from?: string;
  toExclusive?: string;
  kinds: FinanceRecordKind[];
};

/**
 * Folds coverage for one operation's own filters into its response.
 *
 * This is what stops an empty page from reading as absence. Without it a list
 * over a range nothing was ever acquired for returns zero items against
 * `complete` coverage, which is a confident false negative -- the same empty
 * result a genuine absence produces. Coverage is therefore computed for the
 * scope the caller actually asked about, not only for `get_coverage`.
 *
 * ponytail: four extra queries per list or aggregate call. Fine for an
 * archive of tens of thousands of rows queried occasionally. Upgrade path if
 * it stops being fine: a coverage summary table maintained by `publishImport`.
 */
async function foldScopeCoverage(
  client: pg.ClientBase,
  scope: ReadScope,
  filters: CoverageFilters,
): Promise<void> {
  const records = await coverageRecords(client, filters);
  if (records.length === 0) {
    // No source matched the filter at all, so nothing in the archive vouches
    // for what was asked about.
    scope.withheld.add("source_gap");
    return;
  }
  for (const record of records) {
    for (const gap of record.gaps) scope.withheld.add(gap.code);
  }
}

async function coverageRecords(
  client: pg.ClientBase,
  filters: CoverageFilters,
): Promise<FinanceCoverageRecord[]> {
  const request = filters;
  const kinds = filters.kinds;

  const sources = await client.query<SourceRow>(
    `SELECT i.slug,
            (SELECT count(*)::text FROM accounts a WHERE a.institution_id = i.id) AS accounts,
            (SELECT count(*)::text FROM transactions t JOIN accounts a ON a.id = t.account_id
              WHERE a.institution_id = i.id) AS transactions,
            (SELECT count(*)::text FROM positions p JOIN accounts a ON a.id = p.account_id
              WHERE a.institution_id = i.id) AS positions,
            (SELECT count(*)::text FROM balances b JOIN accounts a ON a.id = b.account_id
              WHERE a.institution_id = i.id) AS balances,
            (SELECT count(*)::text FROM documents d WHERE d.institution_id = i.id) AS documents,
            (SELECT min(t.process_date)::text FROM transactions t JOIN accounts a ON a.id = t.account_id
              WHERE a.institution_id = i.id) AS txn_min,
            (SELECT max(t.process_date)::text FROM transactions t JOIN accounts a ON a.id = t.account_id
              WHERE a.institution_id = i.id) AS txn_max,
            (SELECT min(p.as_of)::text FROM positions p JOIN accounts a ON a.id = p.account_id
              WHERE a.institution_id = i.id) AS pos_min,
            (SELECT max(p.as_of)::text FROM positions p JOIN accounts a ON a.id = p.account_id
              WHERE a.institution_id = i.id) AS pos_max,
            (SELECT min(b.as_of)::text FROM balances b JOIN accounts a ON a.id = b.account_id
              WHERE a.institution_id = i.id) AS bal_min,
            (SELECT max(b.as_of)::text FROM balances b JOIN accounts a ON a.id = b.account_id
              WHERE a.institution_id = i.id) AS bal_max
       FROM institutions i
      WHERE ($1::text IS NULL OR i.slug = $1)
      ORDER BY i.slug
      LIMIT $2`,
    [request.sourceId ?? null, MAX_SUPPORT_ROWS],
  );

  const cashPeriods = await client.query<PeriodRow>(
    `SELECT i.slug, r.period_start::text, r.period_end::text, r.status
       FROM reconciliations r
       JOIN accounts a ON a.id = r.account_id
       JOIN institutions i ON i.id = a.institution_id
      WHERE ($1::text IS NULL OR i.slug = $1)
      ORDER BY i.slug, r.period_start
      LIMIT $2`,
    [request.sourceId ?? null, MAX_SUPPORT_ROWS],
  );

  const positionPeriods = await client.query<PeriodRow>(
    `SELECT i.slug, pr.period_start::text, pr.period_end::text, pr.status
       FROM position_reconciliations pr
       JOIN accounts a ON a.id = pr.account_id
       JOIN institutions i ON i.id = a.institution_id
      WHERE ($1::text IS NULL OR i.slug = $1)
      ORDER BY i.slug, pr.period_start
      LIMIT $2`,
    [request.sourceId ?? null, MAX_SUPPORT_ROWS],
  );

  const reviews = await client.query<ReviewRow>(
    `SELECT i.slug,
            count(*)::text AS open,
            min(d.doc_date)::text AS first_date,
            max(d.doc_date)::text AS last_date,
            count(*) FILTER (WHERE d.doc_date IS NULL)::text AS undated
       FROM review_items ri
       JOIN accounts a ON a.id = ri.account_id
       JOIN institutions i ON i.id = a.institution_id
       LEFT JOIN documents d ON d.id = ri.source_document_id
      WHERE ri.status = 'open'
        AND ($1::text IS NULL OR i.slug = $1)
      GROUP BY i.slug
      LIMIT $2`,
    [request.sourceId ?? null, MAX_SUPPORT_ROWS],
  );
  const reviewBySlug = new Map(reviews.rows.map((row) => [row.slug, row]));

  const records: FinanceCoverageRecord[] = [];
  for (const source of sources.rows) {
    for (const kind of kinds) {
      const record = coverageRecordFor(
        source,
        kind,
        request,
        kind === "holding" ? positionPeriods.rows : cashPeriods.rows,
        reviewBySlug.get(source.slug),
      );
      if (record) records.push(record);
    }
  }
  return records;
}

async function getCoverage(
  client: pg.ClientBase,
  scope: ReadScope,
  request: GetCoverageRequest,
): Promise<FinanceReadResponse> {
  const records = await coverageRecords(client, {
    ...(request.sourceId === undefined ? {} : { sourceId: request.sourceId }),
    ...(request.from === undefined ? {} : { from: request.from }),
    ...(request.toExclusive === undefined
      ? {}
      : { toExclusive: request.toExclusive }),
    kinds: request.recordKinds ?? ["transaction", "holding", "balance"],
  });

  const offset = coverageOffset(request.cursor);
  const page = records.slice(offset, offset + request.limit);
  const truncated = records.length > offset + page.length;
  for (const record of page) {
    for (const gap of record.gaps) scope.withheld.add(gap.code);
  }
  return {
    ...envelope(
      scope,
      "get_coverage",
      truncated,
      truncated ? encodeCursor(offset + page.length) : undefined,
    ),
    operation: "get_coverage",
    items: page,
  } as FinanceReadResponse;
}

function coverageOffset(cursor: string | undefined): number {
  const decoded = decodeCursor(cursor);
  if (decoded === undefined) return 0;
  if (typeof decoded !== "number" || !Number.isSafeInteger(decoded) || decoded < 0) {
    throw new FinanceContractError("invalid_request");
  }
  return decoded;
}

/**
 * One source, one record kind. The three states that must never collapse:
 *
 * | State                                     | status    | gap code         |
 * | ----------------------------------------- | --------- | ---------------- |
 * | Nothing ever acquired for this source     | `unknown` | `source_gap`     |
 * | A period no verdict covers                | `unknown` | `source_gap`     |
 * | A period whose gate has not passed         | `partial` | `pending_import` |
 * | A period that passed but is under review   | `partial` | `failed_import`  |
 * | A period that passed with nothing open     | `complete`| none             |
 *
 * `unknown` is reserved for "nothing vouches for this range", which is the
 * state a caller must never read as "no event occurred".
 */
function coverageRecordFor(
  source: SourceRow,
  kind: FinanceRecordKind,
  request: CoverageFilters,
  periods: readonly PeriodRow[],
  review: ReviewRow | undefined,
): FinanceCoverageRecord | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(source.slug)) return null;

  const [dataMin, dataMax] =
    kind === "transaction"
      ? [source.txn_min, source.txn_max]
      : kind === "holding"
        ? [source.pos_min, source.pos_max]
        : [source.bal_min, source.bal_max];

  const from = request.from ?? dataMin ?? MIN_PLAUSIBLE_DATE;
  const defaultTo = dataMax ? addDays(dataMax, 1) : addDays(from, 1);
  const toExclusive =
    request.toExclusive ?? (defaultTo > from ? defaultTo : addDays(from, 1));
  if (from >= toExclusive) return null;

  const acquired =
    Number(source.documents) > 0 ||
    Number(source.transactions) > 0 ||
    Number(source.positions) > 0 ||
    Number(source.balances) > 0;

  const gaps: Gap[] = [];
  if (!acquired) {
    // Never acquired at all. Distinct from an acquired source with an open
    // period, and the only honest answer is that nothing is known here.
    gaps.push({ code: "source_gap", from, toExclusive });
  } else {
    const mine = periods.filter((period) => period.slug === source.slug);
    for (const period of mine) {
      if (period.status === "pass") continue;
      const gap = clampGap(
        {
          code: period.status === "fail" ? "failed_import" : "pending_import",
          from: period.period_start,
          toExclusive: addDays(period.period_end, 1),
        },
        from,
        toExclusive,
      );
      if (gap) gaps.push(gap);
    }
    gaps.push(
      ...uncovered(
        mine.map((period) => ({
          from: period.period_start,
          toExclusive: addDays(period.period_end, 1),
        })),
        from,
        toExclusive,
      ),
    );
    if (review && Number(review.open) > 0) {
      // A period that reconciled but still has an open review item is a third
      // state, not a passing one: a value the importer refused to guess at is
      // missing from it. `failed_import` is the code for "the import did not
      // fully land", which is exactly what an open review item records.
      const undated = Number(review.undated) > 0 || review.first_date === null;
      const gap = clampGap(
        {
          code: "failed_import",
          from: undated ? from : review.first_date!,
          toExclusive: undated ? toExclusive : addDays(review.last_date!, 1),
        },
        from,
        toExclusive,
      );
      if (gap) gaps.push(gap);
    }
  }

  const merged = mergeGaps(gaps);
  const status: FinanceCoverageRecord["status"] =
    merged.length === 0
      ? "complete"
      : merged.some((gap) => gap.code === "source_gap")
        ? "unknown"
        : "partial";

  return {
    sourceId: source.slug as FinanceSourceId,
    recordKind: kind,
    from,
    toExclusive,
    status,
    gaps: merged,
    ...(status === "complete" ? { lastVerifiedAt: Date.now() } : {}),
  };
}

// --- entry point ------------------------------------------------------------

/**
 * Serves one already-parsed, already-authorized contract request.
 *
 * The response is run back through the contract's own response parser before
 * it is returned. That is not belt and braces: the parser enforces invariants
 * this file would otherwise have to restate and could drift from -- that a
 * truncated response carries a cursor, that a complete one carries neither
 * gaps nor issues, that an aggregate's currency matches its total's, that a
 * contributor list shorter than its count carries a breakdown. A response
 * that fails it is a bug here, and failing loudly beats shipping a
 * confidently wrong shape to a caller that trusts the contract.
 */
export async function serveFinanceRead(
  client: pg.ClientBase,
  request: FinanceReadRequest,
  spaceId: string,
): Promise<FinanceReadResponse> {
  if (request.spaceId !== spaceId) {
    throw new FinanceContractError("not_authorized");
  }
  const response = await withReadSnapshot(client, async () => {
    const scope: ReadScope = {
      spaceId: request.spaceId,
      datasetRevision: await datasetRevision(client),
      withheld: new Set<WithholdReason>(),
    };
    switch (request.operation) {
      case "list_transactions":
        return listTransactions(client, scope, request);
      case "list_holdings":
        return listHoldings(client, scope, request);
      case "list_balances":
        return listBalances(client, scope, request);
      case "aggregate_money":
        return aggregateMoney(client, scope, request);
      case "get_evidence":
        return getEvidence(client, scope, request);
      case "get_coverage":
        return getCoverage(client, scope, request);
    }
  });
  return parseFinanceReadResponseShape(response);
}
