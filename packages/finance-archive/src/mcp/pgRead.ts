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
// A fourth, added by F1-29: a record is returned only when its load-bearing
// money value can be cited inside the retained bytes it was parsed from (see
// `evidenceFor` below). A record that cannot be is withheld with
// `retained_evidence_unavailable` rather than returned beside a citation that
// points at nothing, and the response says so through partial coverage. The
// PDF tier has no such binding yet, so its rows stay withheld in full
// (docs/plans/2026-09-11-structured-evidence.md, section 4).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type pg from "pg";

import {
  type AggregateMoneyRequest,
  type CanonicalFinanceDecimal,
  canonicalizeFinanceDecimal,
  type FinanceAccountId,
  type FinanceAggregateRecord,
  type FinanceBalanceRecord,
  type FinanceCaptureId,
  type FinanceCoverageRecord,
  type FinanceCoverageSummary,
  type FinanceCurrency,
  type FinanceDatasetRevision,
  type FinanceDocumentId,
  type FinanceEvidence,
  type FinanceEvidenceId,
  type FinanceHoldingRecord,
  type FinanceInstrumentId,
  type FinanceReadRequest,
  type FinanceReadResponse,
  type FinanceRecordId,
  type FinanceRecordKind,
  type FinanceRevisionId,
  type FinanceSourceId,
  type FinanceSpaceId,
  type FinanceTransactionRecord,
  FinanceContractError,
  type GetCoverageRequest,
  type GetEvidenceRequest,
  type ListBalancesRequest,
  type ListHoldingsRequest,
  type ListTransactionsRequest,
  parseFinanceCurrency,
  parseFinanceReadResponseShape,
  type RetainedSourceObject,
  type RetainedTextSpanEvidence,
  type StructuredFieldLocator,
  SUPPORTED_FINANCE_CURRENCIES,
} from "@repo/finance-contract";

import { fromNumericText } from "../pgNumeric.js";
import { READER_STATEMENT_TIMEOUT_MS } from "../pgReaderRole.js";
import { archiveSchemaOf } from "../pgStore.js";
import { resolveRawTreeRoot, sha256HexOf, textRelativePath } from "../rawTree.js";
import { selectRetainedText } from "../retainedTexts.js";

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

// --- evidence ---------------------------------------------------------------
//
// The contract requires at least one evidence item on every transaction,
// holding and balance record, so a record whose evidence cannot be built
// cannot be returned at all. The choice is between fabricating a citation to
// fill the shape and withholding the record. A fabricated citation on a
// financial figure is the worst failure this archive has, so such records are
// withheld, and every response that withholds one says so: coverage carries
// `retained_evidence_unavailable` and completeness is `partial`. A caller can
// still see that rows *matched* -- `truncated` and the coverage reason
// together say "there is something here you cannot cite yet", which is not
// the same claim as absence.

/** The four `documents` provenance columns, plus the joined identities, that
 * every citable row selects. Written for a query that aliases the document
 * `d` and the institution `i`.
 *
 * The source identity is `institutions.id` and not the slug (F1-34): the
 * contract's `sourceId` is an opaque, stable id, and a slug is neither --
 * it is finance-local, human-readable, and renameable, so citing it
 * published who a source is and broke every stored citation the day someone
 * renamed one. Every `sourceId` filter in this file matches the same column,
 * so an id a response hands back is an id a later request can use. */
const EVIDENCE_COLUMNS = `i.id AS source_id,
            d.id AS document_id, d.retained_sha256,
            d.retained_byte_length::text AS retained_byte_length,
            d.media_type, d.capture_id`;

/** What `EVIDENCE_COLUMNS` and a record's own money columns select. */
type EvidenceRow = {
  source_id: string;
  money: string | null;
  currency: string | null;
  source_document_id: string | null;
  source_locator: string | null;
  document_id: string | null;
  retained_sha256: string | null;
  retained_byte_length: string | null;
  media_type: string | null;
  capture_id: string | null;
};

/** The media types the contract's `RetainedSourceObject` can carry. A
 * document declaring anything else names bytes no consumer of this contract
 * knows how to read, so it is not cited. */
const RETAINED_MEDIA_TYPES = new Set<string>([
  "application/pdf",
  "application/json",
  "text/csv; charset=utf-8",
  "text/plain; charset=utf-8",
]);

/**
 * The immutable retained bytes this row's data was parsed from, or null when
 * the archive cannot name them.
 *
 * All four provenance columns or none: `documents` carries a CHECK saying so,
 * and a document imported before that migration has four nulls, which is the
 * honest answer for bytes whose identity was never recorded.
 *
 * `revisionId` is derived rather than stored. One revision is one immutable
 * retained byte object, which `retained_sha256` already identifies, so a
 * stored column would be a second copy of one value. Every page row of a
 * paginated pull therefore shares a revision and differs by document id,
 * which is the correct reading: one byte revision, several row slices of it.
 */
function documentOf(row: EvidenceRow): RetainedSourceObject | null {
  if (
    row.source_document_id === null ||
    row.document_id === null ||
    row.retained_sha256 === null ||
    row.retained_byte_length === null ||
    row.media_type === null ||
    row.capture_id === null ||
    !RETAINED_MEDIA_TYPES.has(row.media_type)
  )
    return null;
  const retainedByteLength = Number(row.retained_byte_length);
  if (!Number.isSafeInteger(retainedByteLength) || retainedByteLength < 1)
    return null;
  return {
    sourceId: row.source_id as FinanceSourceId,
    documentId: row.document_id as FinanceDocumentId,
    revisionId: `sha256-${row.retained_sha256}` as FinanceRevisionId,
    captureId: row.capture_id as FinanceCaptureId,
    retainedSha256: row.retained_sha256,
    retainedByteLength,
    mediaType: row.media_type as RetainedSourceObject["mediaType"],
  };
}

/**
 * The `FieldBinding` an adapter recorded for this record's load-bearing money
 * field, named by `field` as the parsers spell it ("amount", "marketValue",
 * "totalValue").
 *
 * Today's parsers emit exactly one binding per record, and it sits on the
 * `row` locator rather than under a key named for the field, so a lone
 * binding is taken as that field's. Once more than one locator is bound --
 * an adapter that also binds `price` -- key order is not evidence of
 * anything, and the decimal cross-check cannot separate two bindings whose
 * values coincide. So several bindings must be disambiguated by name, and a
 * record whose load-bearing field is not among them is withheld rather than
 * cited from whichever binding happened to be first.
 */
function bindingOf(sourceLocator: string | null, field: string): unknown {
  if (sourceLocator === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceLocator);
  } catch {
    // A `source_locator` that is not JSON carries no binding to read, which
    // is a withheld row rather than a failed response.
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const bound = Object.entries(parsed as Record<string, unknown>).filter(
    ([, locator]) =>
      locator !== null &&
      typeof locator === "object" &&
      typeof (locator as { binding?: unknown }).binding === "object" &&
      (locator as { binding?: unknown }).binding !== null,
  );
  const chosen =
    bound.length === 1 ? bound[0] : bound.find(([key]) => key === field);
  return chosen === undefined
    ? null
    : (chosen[1] as { binding: unknown }).binding;
}

/**
 * A stored binding as a contract locator, or null when it is not one.
 *
 * Rebuilt field by field rather than spread: `source_locator` is JSON in a
 * TEXT column, and a key that does not belong in the locator must not travel
 * into a response the contract's parser would then reject whole. A binding
 * that does not check out withholds its own row, exactly as no binding does.
 */
function structuredLocator(value: unknown): StructuredFieldLocator | null {
  if (value === null || typeof value !== "object") return null;
  const binding = value as Record<string, unknown>;
  const rawValue = binding.rawValue;
  if (typeof rawValue !== "string" || rawValue.length === 0) return null;
  const rawValueSha256 = createHash("sha256")
    .update(rawValue, "utf8")
    .digest("hex");
  if (binding.format === "json_pointer_v1") {
    const pointer = binding.pointer;
    return typeof pointer === "string"
      ? { format: "json_pointer_v1", pointer, rawValue, rawValueSha256 }
      : null;
  }
  if (binding.format !== "delimited_row_v1") return null;
  const { delimiter, quote, headerRows, recordSeparator } = binding;
  const { rowIndex, columnIndex, columnName } = binding;
  if (
    binding.encoding !== "utf-8" ||
    (delimiter !== "," &&
      delimiter !== "\t" &&
      delimiter !== ";" &&
      delimiter !== "|") ||
    (quote !== '"' && quote !== "none") ||
    (headerRows !== 0 && headerRows !== 1) ||
    (recordSeparator !== "lf" && recordSeparator !== "crlf") ||
    typeof rowIndex !== "number" ||
    !Number.isSafeInteger(rowIndex) ||
    typeof columnIndex !== "number" ||
    !Number.isSafeInteger(columnIndex) ||
    typeof columnName !== "string"
  )
    return null;
  return {
    format: "delimited_row_v1",
    encoding: "utf-8",
    delimiter,
    quote,
    headerRows,
    recordSeparator,
    rowIndex,
    columnIndex,
    columnName,
    rawValue,
    rawValueSha256,
  };
}

/**
 * Whether the bound token and the stored money value are the same number.
 *
 * The comparison is canonical decimal equality, never float equality: a
 * `json_pointer_v1` binding cites the exact JSON source token, which for a
 * string target arrives with its quotes, and `1200.00` and `1200` are one
 * value written two ways. A disagreement means the locator points at a datum
 * that is not the one this row asserts, which is precisely the wrong-bytes
 * citation this work exists to prevent, so the row is withheld instead.
 */
function bindingAgrees(
  rawValue: string,
  money: CanonicalFinanceDecimal,
): boolean {
  let token = rawValue;
  if (token.startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(token);
      if (typeof decoded !== "string") return false;
      token = decoded;
    } catch {
      return false;
    }
  }
  try {
    return canonicalizeFinanceDecimal(token) === money;
  } catch {
    return false;
  }
}

/**
 * A stored `retained_text_span_v1` `FieldBinding` (adapter.ts) as the
 * contract's locator, or null when it is not one. `quoteSha256` is derived
 * from `quote` rather than trusted from storage, the same way
 * `structuredLocator` derives `rawValueSha256`; `relativePath` is derived
 * from `textSha256` (`textRelativePath`, rawTree.ts) rather than stored at
 * all -- the parser that wrote this binding knows neither the raw tree root
 * nor `documents.text_path`, and does not need to.
 */
function textSpanLocator(
  value: unknown,
): RetainedTextSpanEvidence["locator"] | null {
  if (value === null || typeof value !== "object") return null;
  const binding = value as Record<string, unknown>;
  const { textSha256, textByteLength, textCodepointLength, start, end, quote } = binding;
  if (
    typeof textSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(textSha256) ||
    typeof textByteLength !== "number" ||
    !Number.isSafeInteger(textByteLength) ||
    textByteLength < 1 ||
    typeof textCodepointLength !== "number" ||
    !Number.isSafeInteger(textCodepointLength) ||
    textCodepointLength < 1 ||
    typeof start !== "number" ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    typeof end !== "number" ||
    !Number.isSafeInteger(end) ||
    end <= start ||
    end > textCodepointLength ||
    typeof quote !== "string" ||
    quote.length === 0 ||
    Array.from(quote).length !== end - start
  )
    return null;
  return {
    relativePath: textRelativePath(textSha256),
    textSha256,
    textByteLength,
    textCodepointLength,
    offsetUnit: "unicode_code_points",
    start,
    end,
    quote,
    quoteSha256: createHash("sha256").update(quote, "utf8").digest("hex"),
  };
}

/** A one- or two-letter footnote reference printed after a statement value
 * (statementLayout.mjs's own `FOOTNOTE_SUFFIX`) -- common enough across
 * financial-statement formatting that stripping it here, generically, does
 * not tie this read surface to one adapter's layout. */
const TEXT_SPAN_FOOTNOTE_SUFFIX = /\s+[A-Za-z]{1,2}$/;

/**
 * Whether a `retained_text_span_v1` quote and the stored money value are the
 * same number, under the small set of formatting conventions common to a
 * printed financial statement: a leading currency symbol, thousands commas,
 * parentheses for negative, and a trailing footnote letter. Never adapter
 * specific beyond that -- see `bindingAgrees` for the structured-field twin.
 */
function textSpanQuoteAgrees(
  quote: string,
  money: CanonicalFinanceDecimal,
): boolean {
  const withoutFootnote = quote.trim().replace(TEXT_SPAN_FOOTNOTE_SUFFIX, "").trim();
  const negative = /^\(.*\)$/.test(withoutFootnote);
  const digits = withoutFootnote.replace(/^\(|\)$/g, "").replace(/[$,\s]/g, "");
  if (digits.length === 0) return false;
  try {
    return canonicalizeFinanceDecimal(negative ? `-${digits}` : digits) === money;
  } catch {
    return false;
  }
}

/**
 * One record's evidence, or null when the archive cannot cite it.
 *
 * Null -- and a row withheld with `retained_evidence_unavailable` -- whenever
 * any of these is missing or unusable: the source document, any of its four
 * retained-provenance columns, a parsable `source_locator`, a binding on the
 * record's load-bearing money field, a usable money value and currency for
 * that field, or agreement between the two. F1-53: the binding may be either
 * `structured_field_v1` (F1-29, the JSON/tabular tiers) or
 * `retained_text_span_v1` (the PDF tier) -- which one decides the evidence
 * kind returned, and each kind's own agreement check decides whether the row
 * is servable at all.
 */
function evidenceFor(
  record: {
    recordId: FinanceRecordId;
    field: string;
    money: CanonicalFinanceDecimal | null;
    currency: FinanceCurrency | null;
    sourceLocator: string | null;
  },
  document: RetainedSourceObject | null,
): FinanceEvidence[] | null {
  if (document === null || record.money === null || record.currency === null)
    return null;
  const binding = bindingOf(record.sourceLocator, record.field);
  if (binding === null || typeof binding !== "object") return null;
  if ((binding as { format?: unknown }).format === "retained_text_span_v1") {
    const locator = textSpanLocator(binding);
    if (locator === null || !textSpanQuoteAgrees(locator.quote, record.money))
      return null;
    return [
      {
        kind: "retained_text_span_v1",
        evidenceId: `ev:${record.recordId}:${record.field}` as FinanceEvidenceId,
        sourceObject: document,
        locator,
      },
    ];
  }
  const locator = structuredLocator(binding);
  if (locator === null || !bindingAgrees(locator.rawValue, record.money))
    return null;
  return [
    {
      kind: "structured_field_v1",
      evidenceId: `ev:${record.recordId}:${record.field}` as FinanceEvidenceId,
      sourceObject: document,
      locator,
    },
  ];
}

/**
 * Whether a `retained_text_span_v1` item's quote is actually present in the
 * retained text it cites, not just self-consistent in storage (F1-53's
 * "retained_sha256 check"). Every other evidence kind, and every list
 * operation, trusts a binding's own internal consistency instead -- this
 * check is `get_evidence`-only, one record at a time, precisely because it
 * costs a fetch of the whole text.
 *
 * F1-66: the archive itself is the first place the bytes are looked for
 * (`retained_texts`, keyed on the same sha256 the raw tree content-addresses
 * the file under). That is what makes this work from the gateway at all: the
 * Vercel function serving `apps/web/src/lib/mcp/finance.ts` has a reader-role
 * connection and no raw tree, so every text-span citation used to come back
 * `retained_evidence_unavailable` there while `json_pointer_v1` evidence --
 * whose bytes are the `source_locator` already in the database -- verified
 * fine.
 *
 * The raw tree is the fallback, and only when the table has no row *and* a
 * root is configured: an archive whose texts have not been backfilled yet
 * still verifies on the machine that holds them. A row that is present but
 * wrong is refused rather than fallen back from -- falling back would let a
 * tampered row be papered over by a file that happens to be intact.
 * `rawTreeRoot` is null when the caller has none configured
 * (`serveFinanceRead`'s `resolveRawTreeRoot()` fallback threw), which is not
 * an error: it withholds a text-span item that is nowhere to be found rather
 * than throwing mid-response, and every other evidence kind is unaffected.
 *
 * The quote is recomputed from the retained text and compared, never read
 * back out of the binding: `start` and `end` are unicode code point offsets
 * (the contract's `offsetUnit`, and what `textSpanLocator` above validates
 * `quote` against), so the slice is taken over code points rather than over
 * UTF-16 units, which coincide only while the text stays inside the BMP.
 */
async function verifiedAgainstRetainedText(
  client: pg.ClientBase,
  item: FinanceEvidence,
  rawTreeRoot: string | null,
): Promise<boolean> {
  if (item.kind !== "retained_text_span_v1") return true;
  const { textSha256, textByteLength, textCodepointLength, start, end, quote } =
    item.locator;
  let bytes = await selectRetainedText(client, textSha256);
  if (bytes === null) {
    if (rawTreeRoot === null) return false;
    try {
      bytes = readFileSync(join(rawTreeRoot, item.locator.relativePath));
    } catch {
      return false;
    }
  }
  if (sha256HexOf(bytes) !== textSha256 || bytes.byteLength !== textByteLength)
    return false;
  const codepoints = Array.from(bytes.toString("utf8"));
  if (codepoints.length !== textCodepointLength) return false;
  return codepoints.slice(start, end).join("") === quote;
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

type ListRow = EvidenceRow & {
  id: string;
  account_id: string;
  ordinal: string;
};

/**
 * Runs one page of a list operation and reports how much of it survived.
 *
 * A row that `itemOf` cannot build is dropped from the page but not from the
 * page's bounds: the query still runs and the cursor still advances over it,
 * because "rows matched but none can be cited" and "no row matched" are
 * different answers and a caller has to be able to tell them apart.
 */
async function listPage<Row extends ListRow, Item>(
  client: pg.ClientBase,
  scope: ReadScope,
  sql: string,
  values: unknown[],
  limit: number,
  itemOf: (row: Row, scope: ReadScope) => Item | null,
): Promise<{
  items: Item[];
  truncated: boolean;
  nextCursor: string | undefined;
}> {
  const result = await client.query<Row>(sql, [...values, limit + 1]);
  const rows = result.rows;
  const page = rows.slice(0, limit);
  const items: Item[] = [];
  for (const row of page) {
    const item = itemOf(row, scope);
    if (item !== null) items.push(item);
  }
  const truncated = rows.length > limit;
  const last = page[page.length - 1];
  return {
    items,
    truncated,
    nextCursor:
      truncated && last ? encodeCursor([last.ordinal, last.id]) : undefined,
  };
}

type TransactionRow = ListRow & {
  activity_type: string;
  description: string;
  quantity: string | null;
  price: string | null;
};

type HoldingRow = ListRow & {
  instrument_id: string | null;
  quantity: string | null;
  price: string | null;
  cost_basis: string | null;
  valuation_basis: string | null;
};

type BalanceRow = ListRow & { cash: string | null };

function transactionItem(
  row: TransactionRow,
  scope: ReadScope,
): FinanceTransactionRecord | null {
  const recordId = `txn:${row.id}` as FinanceRecordId;
  const decimal = decimalOrNull(row.money, scope);
  const currency = currencyOrNull(row.currency, scope);
  const evidence = evidenceFor(
    {
      recordId,
      field: "amount",
      money: decimal,
      currency,
      sourceLocator: row.source_locator,
    },
    documentOf(row),
  );
  if (evidence === null || decimal === null || currency === null) {
    scope.withheld.add("retained_evidence_unavailable");
    return null;
  }
  const quantity = decimalOrNull(row.quantity, scope);
  const price = decimalOrNull(row.price, scope);
  return {
    recordId,
    accountId: row.account_id as FinanceAccountId,
    occurredOn: row.ordinal,
    activityType: row.activity_type,
    description: row.description,
    amount: { decimal, currency },
    ...(quantity === null ? {} : { quantity }),
    ...(price === null ? {} : { price: { decimal: price, currency } }),
    evidence,
  };
}

function holdingItem(
  row: HoldingRow,
  scope: ReadScope,
): FinanceHoldingRecord | null {
  const recordId = `pos:${row.id}` as FinanceRecordId;
  const decimal = decimalOrNull(row.money, scope);
  const currency = currencyOrNull(row.currency, scope);
  const evidence = evidenceFor(
    {
      recordId,
      field: "marketValue",
      money: decimal,
      currency,
      sourceLocator: row.source_locator,
    },
    documentOf(row),
  );
  if (evidence === null || decimal === null || currency === null) {
    scope.withheld.add("retained_evidence_unavailable");
    return null;
  }
  const quantity = decimalOrNull(row.quantity, scope);
  const basis = row.valuation_basis;
  if (
    row.instrument_id === null ||
    quantity === null ||
    basis === null ||
    !VALUATION_BASES.has(basis)
  ) {
    // A holding with no instrument, no quantity or no stated valuation basis
    // cannot be a contract record at all: a total-assets query over one would
    // mix marked securities with positions carried at cost. Withheld as an
    // unsupported value, which is what it is -- the citation is fine.
    scope.withheld.add("unsupported_value");
    return null;
  }
  const price = decimalOrNull(row.price, scope);
  const costBasis = decimalOrNull(row.cost_basis, scope);
  return {
    recordId,
    accountId: row.account_id as FinanceAccountId,
    instrumentId: row.instrument_id as FinanceInstrumentId,
    asOf: row.ordinal,
    quantity,
    valuationBasis: basis as FinanceHoldingRecord["valuationBasis"],
    ...(price === null ? {} : { price: { decimal: price, currency } }),
    marketValue: { decimal, currency },
    ...(costBasis === null
      ? {}
      : { costBasis: { decimal: costBasis, currency } }),
    evidence,
  };
}

const VALUATION_BASES = new Set<string>([
  "market_price",
  "last_round",
  "cost",
  "reported_nav",
]);

function balanceItem(
  row: BalanceRow,
  scope: ReadScope,
): FinanceBalanceRecord | null {
  const recordId = `bal:${row.id}` as FinanceRecordId;
  const decimal = decimalOrNull(row.money, scope);
  const currency = currencyOrNull(row.currency, scope);
  const evidence = evidenceFor(
    {
      recordId,
      field: "totalValue",
      money: decimal,
      currency,
      sourceLocator: row.source_locator,
    },
    documentOf(row),
  );
  if (evidence === null || decimal === null || currency === null) {
    scope.withheld.add("retained_evidence_unavailable");
    return null;
  }
  const cash = decimalOrNull(row.cash, scope);
  return {
    recordId,
    accountId: row.account_id as FinanceAccountId,
    asOf: row.ordinal,
    totalValue: { decimal, currency },
    ...(cash === null ? {} : { cash: { decimal: cash, currency } }),
    evidence,
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
    `SELECT t.id, t.account_id, t.process_date::text AS ordinal,
            t.activity_type, t.description, t.amount AS money, t.currency,
            t.quantity, t.price, t.source_document_id, t.source_locator,
            ${EVIDENCE_COLUMNS}
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       JOIN institutions i ON i.id = a.institution_id
       LEFT JOIN documents d ON d.id = t.source_document_id
      WHERE ($1::text IS NULL OR i.id = $1)
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
    transactionItem,
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
    items: page.items,
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
    `SELECT p.id, p.account_id, p.as_of::text AS ordinal,
            p.instrument_id, p.quantity, p.price, p.market_value AS money,
            p.cost_basis, p.currency, p.valuation_basis,
            p.source_document_id, p.source_locator,
            ${EVIDENCE_COLUMNS}
       FROM positions p
       JOIN accounts a ON a.id = p.account_id
       JOIN institutions i ON i.id = a.institution_id
       LEFT JOIN documents d ON d.id = p.source_document_id
      WHERE ($1::text IS NULL OR i.id = $1)
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
    holdingItem,
  );
  await foldScopeCoverage(client, scope, {
    ...(request.sourceId === undefined ? {} : { sourceId: request.sourceId }),
    ...(request.asOf === undefined ? {} : { toExclusive: addDays(request.asOf, 1) }),
    kinds: ["holding"],
  });
  return {
    ...envelope(scope, "list_holdings", page.truncated, page.nextCursor),
    operation: "list_holdings",
    items: page.items,
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
    `SELECT b.id, b.account_id, b.as_of::text AS ordinal,
            b.total_value AS money, b.cash, b.currency,
            b.source_document_id, b.source_locator,
            ${EVIDENCE_COLUMNS}
       FROM balances b
       JOIN accounts a ON a.id = b.account_id
       JOIN institutions i ON i.id = a.institution_id
       LEFT JOIN documents d ON d.id = b.source_document_id
      WHERE ($1::text IS NULL OR i.id = $1)
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
    balanceItem,
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
    items: page.items,
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
               AND ($1::text IS NULL OR i.id = $1)
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
            SELECT s.*, a.id AS acct, i.id AS source_id
              FROM ${table} s
              JOIN accounts a ON a.id = s.account_id
              JOIN institutions i ON i.id = a.institution_id
             WHERE ($1::text IS NULL OR i.id = $1)
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

/** Each record kind's table, its load-bearing money column, and the contract
 * field name that column fills. Frozen and keyed by the id prefix this
 * surface itself mints: nothing a caller sends reaches the SQL below. */
const RECORD_TABLES: Readonly<
  Record<string, { table: string; money: string; field: string } | undefined>
> = Object.freeze({
  txn: { table: "transactions", money: "amount", field: "amount" },
  pos: { table: "positions", money: "market_value", field: "marketValue" },
  bal: { table: "balances", money: "total_value", field: "totalValue" },
});

async function getEvidence(
  client: pg.ClientBase,
  scope: ReadScope,
  request: GetEvidenceRequest,
  rawTreeRoot: string | null,
): Promise<FinanceReadResponse> {
  const separator = request.recordId.indexOf(":");
  const record = RECORD_TABLES[request.recordId.slice(0, separator)];
  const id = request.recordId.slice(separator + 1);
  let items: FinanceEvidence[] = [];
  if (!record || id.length === 0) {
    // Not a record id this surface mints. Absence of evidence for an id the
    // archive has never heard of is a coverage gap, not a citation-free row.
    scope.withheld.add("source_gap");
  } else {
    const found = await client.query<EvidenceRow>(
      `SELECT r.${record.money} AS money, r.currency,
              r.source_document_id, r.source_locator,
              ${EVIDENCE_COLUMNS}
         FROM ${record.table} r
         JOIN accounts a ON a.id = r.account_id
         JOIN institutions i ON i.id = a.institution_id
         LEFT JOIN documents d ON d.id = r.source_document_id
        WHERE r.id = $1`,
      [id],
    );
    const row = found.rows[0];
    const evidence = row
      ? evidenceFor(
          {
            recordId: request.recordId,
            field: record.field,
            money: decimalOrNull(row.money, scope),
            currency: currencyOrNull(row.currency, scope),
            sourceLocator: row.source_locator,
          },
          documentOf(row),
        )
      : null;
    // F1-53: get_evidence, unlike a list operation, fetches the retained text
    // a `retained_text_span_v1` item names and checks the quote against the
    // actual bytes (verifiedAgainstRetainedText's doc comment) -- asked for
    // one record at a time, it can afford the fetch a page of up to
    // `MAX_FINANCE_PAGE_SIZE` rows cannot. An item survives that check only
    // when the quote recomputed from those bytes is exactly the one in the
    // locator, so the items returned below carry the verified quote rather
    // than the binding's unverified claim about it.
    //
    // `Promise.all` over one client: node-postgres queues queries on a client
    // and runs them in order, so these are serialized inside this
    // transaction, not concurrent.
    if (
      evidence !== null &&
      (
        await Promise.all(
          evidence.map((item) =>
            verifiedAgainstRetainedText(client, item, rawTreeRoot),
          ),
        )
      ).every(Boolean)
    ) {
      items = evidence;
    } else {
      scope.withheld.add(row ? "retained_evidence_unavailable" : "source_gap");
    }
  }
  return {
    ...envelope(scope, "get_evidence", false, undefined),
    operation: "get_evidence",
    recordId: request.recordId,
    items,
  } as FinanceReadResponse;
}

// --- get_coverage -----------------------------------------------------------

type Gap = FinanceCoverageRecord["gaps"][number];

type SourceRow = {
  source_id: string;
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
  source_id: string;
  period_start: string;
  period_end: string;
  status: "pass" | "fail" | "unverified";
};

type ReviewRow = {
  source_id: string;
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
    `SELECT i.id AS source_id,
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
      WHERE ($1::text IS NULL OR i.id = $1)
      ORDER BY i.id
      LIMIT $2`,
    [request.sourceId ?? null, MAX_SUPPORT_ROWS],
  );

  const cashPeriods = await client.query<PeriodRow>(
    `SELECT i.id AS source_id, r.period_start::text, r.period_end::text, r.status
       FROM reconciliations r
       JOIN accounts a ON a.id = r.account_id
       JOIN institutions i ON i.id = a.institution_id
      WHERE ($1::text IS NULL OR i.id = $1)
      ORDER BY i.id, r.period_start
      LIMIT $2`,
    [request.sourceId ?? null, MAX_SUPPORT_ROWS],
  );

  const positionPeriods = await client.query<PeriodRow>(
    `SELECT i.id AS source_id, pr.period_start::text, pr.period_end::text, pr.status
       FROM position_reconciliations pr
       JOIN accounts a ON a.id = pr.account_id
       JOIN institutions i ON i.id = a.institution_id
      WHERE ($1::text IS NULL OR i.id = $1)
      ORDER BY i.id, pr.period_start
      LIMIT $2`,
    [request.sourceId ?? null, MAX_SUPPORT_ROWS],
  );

  const reviews = await client.query<ReviewRow>(
    `SELECT i.id AS source_id,
            count(*)::text AS open,
            min(d.doc_date)::text AS first_date,
            max(d.doc_date)::text AS last_date,
            count(*) FILTER (WHERE d.doc_date IS NULL)::text AS undated
       FROM review_items ri
       JOIN accounts a ON a.id = ri.account_id
       JOIN institutions i ON i.id = a.institution_id
       LEFT JOIN documents d ON d.id = ri.source_document_id
      WHERE ri.status = 'open'
        AND ($1::text IS NULL OR i.id = $1)
      GROUP BY i.id
      LIMIT $2`,
    [request.sourceId ?? null, MAX_SUPPORT_ROWS],
  );
  const reviewBySource = new Map(reviews.rows.map((row) => [row.source_id, row]));

  const records: FinanceCoverageRecord[] = [];
  for (const source of sources.rows) {
    for (const kind of kinds) {
      const record = coverageRecordFor(
        source,
        kind,
        request,
        kind === "holding" ? positionPeriods.rows : cashPeriods.rows,
        reviewBySource.get(source.source_id),
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
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(source.source_id)) return null;

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
    const mine = periods.filter((period) => period.source_id === source.source_id);
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
    sourceId: source.source_id as FinanceSourceId,
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
  /**
   * F1-53: the raw tree root `get_evidence` falls back to for a
   * `retained_text_span_v1` item's text when the archive itself has no
   * `retained_texts` row for it (`verifiedAgainstRetainedText`). Omitted in
   * every real caller (`mcp/server.ts`), which falls back to the configured
   * `FINANCE_ARCHIVE_RAW_TREE_ROOT` (`resolveRawTreeRoot()`); a test supplies
   * one explicitly, or `null` to pin "this caller has no raw tree" -- the
   * gateway's case -- instead of mutating that process-wide environment
   * variable. Every other operation ignores this entirely.
   */
  options: { rawTreeRoot?: string | null } = {},
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
      case "get_evidence": {
        let rawTreeRoot: string | null;
        if (options.rawTreeRoot !== undefined) {
          rawTreeRoot = options.rawTreeRoot;
        } else {
          try {
            rawTreeRoot = resolveRawTreeRoot();
          } catch {
            rawTreeRoot = null;
          }
        }
        return getEvidence(client, scope, request, rawTreeRoot);
      }
      case "get_coverage":
        return getCoverage(client, scope, request);
    }
  });
  return parseFinanceReadResponseShape(response);
}
