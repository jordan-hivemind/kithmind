// The importer: turns normalized rows into `transactions`, `documents`,
// `review_items` and one `import_runs` summary. It never prints a row (see
// "Working on the archive without reading it" in the plan); a caller reads the
// returned ImportSummary, not the database contents.
//
// `ImportRow` is the seam an institution adapter's `parse()` output is mapped
// to (src/adapterImport.ts does the mapping): an explicit, documented
// contract, not an adapter interface of its own.
//
// F1-22 moved this file from SQLite to Postgres, and that was not a driver
// swap. Two things changed in the same edit and they are the whole risk:
//
//   - Cash stops being an integer at the currency's minor-unit exponent and
//     becomes the stated decimal in a NUMERIC column. `toMinorUnits` stays,
//     for a reason that was never about storage: it throws when a value is
//     more precise than its currency allows, and that value is *ambiguous
//     money*, which ground rule 5 says is null with a review item rather than
//     rounded. NUMERIC would store it happily, which is exactly why the check
//     has to stay here.
//   - The deduplication preimage moves with it, to `rowHashV2`/`contentKeyV2`
//     (rowHash.ts). Those two are used as a pair and never mixed with their
//     v1 counterparts: the occurrence ordinal is counted over the content key
//     and hashed into the row hash, so a key and a hash that disagreed about
//     what "the same content" means would break deduplication silently. `1`,
//     `1.0` and `1.00` are one amount and therefore one identity, which is
//     what `toNumericText` canonicalization guarantees before either is
//     computed.
//
// Publication is the other thing this file owns now that the archive is
// hosted. Single writer by convention is not a publication boundary: a laptop
// querying mid-import must not see half a ledger, and must never see new
// transactions against an old reconciliation verdict. `publishImport` below is
// that boundary.

import { randomUUID } from "node:crypto";

import type {
  BalanceScopeEvidence,
  BalanceScopeGapCode,
  PositionScopeEvidence,
  PositionScopeGapCode,
} from "./adapter.js";

import { multiplyDecimal } from "./decimal.js";
import {
  assertCandidateHashesOwnedByDocument,
  prepareHoldingCorrectionCandidate,
  readStoredHoldingProjection,
  type CandidateHoldingProjection,
  type HoldingProjectionTable,
  type StoredHoldingProjection,
} from "./holdingCorrectionCandidate.js";
import {
  emptyInstrumentMatchSummary,
  INSTITUTION_SYMBOL_INVALIDATED,
  INSTITUTION_SYMBOL_RULE,
  type InstitutionSymbolRefusalReason,
  type InstrumentMatchReasonCode,
  type InstrumentMatchSummary,
} from "./instrumentMatch.js";
import {
  DERIVED_ROUNDING_RULE,
  fromMinorUnits,
  type RoundingRule,
  roundToMinorUnits,
  toMinorUnits,
} from "./money.js";
import { toNumericText } from "./pgNumeric.js";
import { valuationNotesEquivalentSql } from "./valuationNote.js";
import {
  type ArchiveClient,
  insertRows,
  lockArchiveForWrite,
  withArchiveTransaction,
} from "./pgStore.js";
import {
  cashEffectiveDate,
  type CashGateScope,
  runReconciliationGate,
  type ReconciliationGateSummary,
} from "./reconciliation.js";
import {
  type PositionGateScope,
  runPositionReconciliationGate,
  type PositionReconciliationGateSummary,
} from "./positionReconciliation.js";
import {
  balanceHash,
  contentKeyV2,
  liabilityHash,
  positionHash,
  rowHashV2,
} from "./rowHash.js";

/**
 * One transaction as a source hands it to the importer, already normalized to
 * the archive's field names but not yet validated or stored. This is the
 * contract an institution adapter's `parse()` output must be mapped to.
 *
 * - `accountId` must already exist in `accounts` (the importer never creates
 *   accounts or institutions; provisioning them is out of this task's scope).
 * - `processDate` is required, ISO `YYYY-MM-DD`, matching `transactions
 *   .process_date NOT NULL`. A row whose source date cannot be parsed into
 *   this form is not insertable (the column has no other spelling); the
 *   importer opens a review item for it instead of inserting a placeholder.
 * - `quantity`, `price`, `runningBalance` accept any spelling `parseDecimal`
 *   understands (leading `+`, leading zeros, trailing zeros); the importer
 *   canonicalizes before storing. A malformed value, or one past the typed
 *   boundary's 38 significant digits and 18 fractional places, opens a review
 *   item and is stored as NULL rather than guessed or rounded.
 * - `amountText` is the amount as the source stated it, in `currency`'s
 *   units (e.g. `"12.34"` for USD), or `null` when the source itself has no
 *   amount for this row (a non-monetary event) or the amount is ambiguous.
 *   A value with more precision than `currency` allows (`toMinorUnits`
 *   throwing) is ambiguous money: the importer stores NULL and opens a
 *   review item (ground rule 5). This is the only path from source text to
 *   the `amount` column; nothing in this file parses a float, and no money
 *   value is ever a JavaScript number at any point.
 * - `amountNote` is required whenever `amountText` is null for a reason
 *   other than "this row has no amount": an adapter that could not read an
 *   amount (`ParsedAmount`'s `{ amount: null, amountNote: string }` case)
 *   passes that note through here rather than dropping it. The importer
 *   opens a review item carrying the note (ground rule 5); it never lets an
 *   unreadable amount vanish silently. Pass `null` only for a genuinely
 *   non-monetary row.
 * - `providerTxnId` is a stable per-account transaction identifier from the
 *   source, when one exists. It is the preferred, authoritative dedupe
 *   identity and should be supplied whenever an adapter's source offers one,
 *   including every paginated activity API. Without one, the importer falls
 *   back to content hashing scoped by document and row order (see
 *   `rowHashV2`'s `occurrence` field and `importRows` in this file), which
 *   correctly collapses the same transaction reappearing on an overlapping
 *   page while still preserving two genuinely distinct rows that happen to
 *   share the same date, amount and description.
 * - `sourceLocator` is a human-readable pointer into the source document
 *   (a page and row, a JSON path, a line number) for `get_evidence`. It is
 *   not part of the dedupe key, but a fallback-path collapse across two
 *   different documents is recorded with both locators in a review item,
 *   since that collapse rests on content evidence rather than a stable id.
 */
export type ImportRow = {
  accountId: string;
  tradeDate: string | null;
  /** ISO YYYY-MM-DD. Required; see the field comment above. */
  processDate: string;
  settleDate: string | null;
  datePrecision: "day" | "month" | "unknown";
  activityType: string;
  description: string;
  instrumentId: string | null;
  quantity: string | null;
  price: string | null;
  /** Decimal text in `currency` units, or null if the source has no amount. */
  amountText: string | null;
  /** A reason `amountText` is null because it was unreadable, not absent. See above. */
  amountNote: string | null;
  currency: string;
  runningBalance: string | null;
  /** Page, row or path locator within the source document. */
  sourceLocator: string;
  /** Stable per-account transaction id from the source, when one exists. */
  providerTxnId: string | null;
  /**
   * F1-8b. `amount` converted into the account's `base_currency`, when the
   * source itself states that converted amount (e.g. a "USD equivalent"
   * column) -- decimal text, used verbatim and never rounded. Omitted or
   * null when the source states no base-currency amount for this row; the
   * importer then tries `fxRateText` instead of leaving amount_base
   * unpopulated for a row this institution's own statement in fact converts.
   */
  amountBaseText?: string | null;
  /**
   * F1-8b. The FX rate the source states for this row, decimal text.
   * Recorded on `fx_rate` whenever it is known, and -- only when
   * `amountBaseText` is absent -- multiplied against `amount` to derive
   * `amount_base`, rounded `half_even` to the base currency's minor unit
   * (money.ts) and recorded as such. A stated amount never rounds; a
   * derived one does, and says so in `amount_base_rounding`.
   */
  fxRateText?: string | null;
};

/**
 * One holding from a statement's positions table, the seam an adapter's
 * `ParsedPosition` gets mapped to (see src/adapterImport.ts). `accountId` and
 * `sourceDocumentId` come from the enclosing `ImportDocument`, not this row,
 * since one document's positions table belongs to one account.
 *
 * `marketValueText`/`marketValueNote` follow the same rule as
 * `ImportRow.amountText`/`amountNote`: a value the source stated is decimal
 * text; a value the adapter could not read is null with a required note
 * (ground rule 5). `quantity`, `price`, `costBasis` and `unrealized` are
 * plain decimal text or null, validated the same way `quantity`/`price`
 * already are on `ImportRow`: malformed text opens a review item and stores
 * NULL rather than guessing.
 *
 * `valuationBasis` is one of `market_price`, `last_round`, `cost` or
 * `reported_nav`, or null when the source does not say -- never inferred.
 * `valuationNote` is required either way: it explains the basis when known,
 * and explains why it is unknown when it is not. Leaving both null is
 * exactly the gap the plan calls out: a total-assets query would then
 * silently mix marked securities with positions carried at cost.
 */
export type ImportPosition = {
  /**
   * F1-46. This holding's own account, when the caller resolved one (a
   * consolidated statement's per-section attribution, `adapterImport.ts`).
   * Falls back to the enclosing `ImportDocument.accountId` when omitted --
   * the ordinary case, one document naming one account -- exactly as before
   * this field existed.
   */
  accountId?: string | null;
  /** ISO YYYY-MM-DD. Required; positions.as_of has no other spelling to store. */
  asOf: string;
  instrumentId: string | null;
  quantity: string | null;
  price: string | null;
  marketValueText: string | null;
  marketValueNote: string | null;
  costBasis: string | null;
  unrealized: string | null;
  currency: string;
  valuationBasis: string | null;
  valuationNote: string;
  sourceLocator: string;
};

/** One point-in-time account total from a statement's summary section. */
export type ImportBalance = {
  /** F1-46. Same fallback rule as `ImportPosition.accountId`. */
  accountId?: string | null;
  /** ISO YYYY-MM-DD. Required; balances.as_of has no other spelling to store. */
  asOf: string;
  totalValueText: string | null;
  totalValueNote: string | null;
  cash: string | null;
  currency: string;
  periodStartValue: string | null;
  periodEndValue: string | null;
  sourceLocator: string;
};

/** What is owed: a loan, margin balance or similar, from a statement. */
export type ImportLiability = {
  /** F1-46. Same fallback rule as `ImportPosition.accountId`. */
  accountId?: string | null;
  kind: string;
  displayName: string | null;
  balanceText: string | null;
  balanceNote: string | null;
  currency: string;
  rate: string | null;
  /** ISO YYYY-MM-DD. Required; liabilities.as_of has no other spelling to store. */
  asOf: string;
  collateralNote: string | null;
  sourceLocator: string;
};

/** One adapter-proved source position projection for an exact account/date. */
export type ImportPositionScope = {
  accountId: string;
  asOf: string;
  proofVersion: "position_scope_v1";
  status: "complete" | "partial";
  emittedPositionCount: number;
  gapCodes: readonly PositionScopeGapCode[];
  zeroBasis?: "source_stated_none";
  evidence: PositionScopeEvidence;
};

/** One adapter-proved source balance projection for an exact account/date. */
export type ImportBalanceScope = {
  accountId: string;
  asOf: string;
  proofVersion: "balance_scope_v1";
  status: "complete" | "partial";
  emittedBalanceCount: 0 | 1;
  gapCodes: readonly BalanceScopeGapCode[];
  zeroBasis?: "source_stated_none";
  evidence: BalanceScopeEvidence;
};

/**
 * One acquired file (a raw statement, or one page of a paginated pull) and
 * the rows parsed from it. Rows are attributed to `documents` by content
 * hash, so importing the same bytes twice is a no-op (ground rule 1).
 * `positions`, `balances` and `liabilities` follow the same rule at the
 * whole-document level, and (F1-49) each also carries its own `row_hash`
 * (`rowHash.ts`'s `positionHash`/`balanceHash`/`liabilityHash`), so a document
 * reprocessed for some other reason -- a sibling row sent to review, a parse
 * note that never clears -- matches its own already-stored holdings instead
 * of inserting a second copy.
 */
export type ImportDocument = {
  /** sha256 of the raw file's bytes. The dedupe key for whole-document skip. */
  sha256: string;
  /** Present when the adapter retained the bytes but could not parse them; the
   * document is recorded as not parsed and a review item names why. */
  parseNote?: string | null;
  /** Local path in the raw tree. Never a repository path. */
  filePath: string;
  institutionId: string;
  accountId: string | null;
  docType: string;
  docDate: string | null;
  /**
   * F1-71. This document's identity inside its institution: the provider's
   * own id for it (`DiscoveredDocument.providerDocumentId`, adapter.ts).
   * `sha256` above answers "have these exact bytes been seen"; this answers
   * "is this the same document," which byte identity cannot for a provider
   * that renders a fresh file on every download. A pull carrying an id
   * already recorded for this institution is a *new capture* of a document
   * the archive already has: its bytes and its capture record are retained
   * (ground rule 1, written before `importBatch` ever runs), and no second
   * `documents` row and no re-import of its rows follow. Null or omitted for
   * an export-tier pull, which names no single provider document.
   */
  providerDocumentId?: string | null;
  /**
   * The provider's own reported row/transaction count for this document's
   * pull, when the source reports one. Ground rule 7: a mismatch between
   * this and `rows.length` fails the whole import loudly rather than being
   * absorbed. Pass `null` only when the source truly reports no total; such
   * a pull is never recorded as complete coverage by this importer alone.
   */
  providerReportedCount: number | null;
  /**
   * What this document's rows were parsed from, all four or none (F1-29,
   * docs/plans/2026-09-11-structured-evidence.md). `retainedSha256` is the
   * sha256 of the immutable retained bytes, which is *not* `sha256` for a
   * page row of a paginated pull: that one is a derived row identity naming
   * no bytes, and every page of one pull shares these four values.
   * `mediaType` is the adapter's own declaration, never inferred from the
   * capability tier. Omitted (or null) for a document whose bytes were never
   * recorded; the columns are nullable and such a row simply produces no
   * evidence. A partial set is refused by the table's CHECK.
   */
  retainedSha256?: string | null;
  retainedByteLength?: number | null;
  mediaType?: string | null;
  captureId?: string | null;
  /**
   * Path to this document's retained extracted text in the raw tree
   * (`persistAcquiredDocument`'s `PersistedAcquisition.textPath`), when the
   * caller extracted one. Written on the same insert as the rest of this
   * document's provenance rather than through a separate targeted `UPDATE`
   * after the fact (F1-33): `get_evidence` needs nothing after import to
   * return a path to the retained text.
   */
  textPath?: string | null;
  rows: readonly ImportRow[];
  /** F1-56. What the adapter seam flagged about this document's own rows,
   * written here so it lands with a `source_document_id`. */
  reviewItems?: readonly AdapterReviewItem[];
  /** Most documents (activity pulls) carry none of these. */
  positions?: readonly ImportPosition[];
  balances?: readonly ImportBalance[];
  liabilities?: readonly ImportLiability[];
  /** Optional positive source observations; absence preserves legacy gates. */
  positionScopes?: readonly ImportPositionScope[];
  /** Optional account-bound balance observations used by scoped correction. */
  balanceScopes?: readonly ImportBalanceScope[];
};

/**
 * F1-56. One review item an adapter pull opened while mapping this document
 * (adapterImport.ts's `resolveRowAccountId`, `resolveInstrumentId`'s weak
 * symbol match, `classifyActivity`'s taxonomy violations), carried on the
 * document rather than written at the seam.
 *
 * The seam runs before any `documents` row exists, so every item it wrote
 * itself carried a null `source_document_id` -- 116,828 of them on the
 * owner's archive, none joinable back to the document whose content they are
 * evidence about. `importBatch` knows the document id, so it writes them.
 * That also means a document the whole-document skip passes over reopens
 * none of them, instead of writing the same `weak_instrument_match` rows
 * again on every reparse of an already-imported document.
 */
export type AdapterReviewItem = {
  readonly kind: string;
  readonly accountId: string | null;
  readonly rawValue: string | null;
  readonly reason: string;
  /**
   * F1-58: for `weak_instrument_match` only -- the institution and the
   * instrument this descriptor was weakly matched to, so `importer.ts` can
   * fold every sighting of the same (institution, descriptor, matched
   * instrument) into one instrument-level item instead of one row per
   * document. Null (and ignored) for every other kind.
   */
  readonly institutionId?: string | null;
  readonly matchedInstrumentId?: string | null;
  /**
   * F1-76 phase 3. Which condition of the same-institution symbol rule this
   * item records (instrumentMatch.ts): the rule's own name on an
   * `institution_symbol_match`, or the refusal that kept a
   * `weak_instrument_match` flagged. Written to `review_items.reason_code`,
   * whose CHECK is the same closed list, so a decision is counted rather than
   * only read. Absent when the rule did not run at all.
   */
  readonly reasonCode?: InstrumentMatchReasonCode;
};

export type ImportBatch = {
  /** Recorded on `import_runs.source`, e.g. an adapter or institution slug. */
  source: string;
  documents: readonly ImportDocument[];
};

export type ImportOptions = {
  /**
   * The caller parsed one complete retained document again. This enables the
   * fail-closed comparison against that document's full stored holdings
   * projection. Ordinary acquisition and partial API pulls must omit it.
   */
  authoritativeReparse?: boolean;
};

export type ImportSummary = {
  importRunId: string;
  filesSeen: number;
  rowsInserted: number;
  /**
   * F1-36. Every row that did not insert used to be reported as
   * "deduplicated", which is only true of a provider id or row hash match
   * (a genuine re-encounter of already-imported content, including the
   * whole-document skip below). A row a source gave that this importer
   * could not parse or trust (`rowsRefused`) is a different fact, and
   * conflating the two is what let 1602 rows a bad date format sent to
   * review get reported as 1602 duplicates. Kept for whatever still reads
   * it; it is always `rowsDeduplicated + rowsRefused`.
   */
  rowsSkipped: number;
  /** A provider id or row hash matched an existing row -- content this
   * importer has already stored, including a whole document skipped
   * outright because it was already fully imported (see `importBatch`). */
  rowsDeduplicated: number;
  /** A review item was opened for the row instead of inserting it: an
   * unparseable process date or `as_of`, not a duplicate. */
  rowsRefused: number;
  reviewItemsOpened: number;
  /**
   * F1-55. A `document_unparsed` item this run closed because the same
   * document, reimported, no longer carries a parse note (see the
   * `parseNote`-less branch below). F1-76 phase 3 adds the second kind this
   * importer closes on its own: a `weak_instrument_match` whose match the
   * same-institution symbol rule now accepts. Never a count of items dismissed
   * or resolved by a person -- this importer only ever resolves kinds it
   * itself opens, and only when its own reason for opening them no longer
   * holds.
   */
  reviewItemsResolved: number;
  /**
   * F1-60. A `document_unparsed` item this run rewrote in place because the
   * same document, reimported, now reports a different parse note. One item
   * per document either way: this is the same finding restated, not a second
   * one, and an item a reviewer has already dismissed or resolved is never
   * touched.
   */
  reviewItemsUpdated: number;
  /**
   * F1-76 phase 3. Every symbol-only instrument match this run decided, and
   * how: accepted under the same-institution symbol rule, refused by which
   * condition, or withdrawn because later data stopped satisfying the rule.
   * The owner's requirement is that nothing is accepted or left broken
   * silently, so these are counts an operator sees on every run rather than a
   * query somebody has to think to write.
   */
  instrumentMatches: InstrumentMatchSummary;
  /** Always 0 here; `publishImport` reports what the gates found. */
  reconciliationsPassed: number;
  reconciliationsFailed: number;
  /**
   * F1-59. The rows this run actually inserted, as keys: what the two
   * reconciliation gates need to check only the periods this import could
   * have moved, instead of every period in the archive. Deduplicated and
   * bounded by the run's own inserts -- a deduplicated or refused row
   * changed nothing and appears here nowhere.
   */
  changed: ImportChanges;
};

/** Which periods `publishImport` hands each gate (F1-59). */
export type ImportChanges = {
  cash: CashGateScope;
  positions: PositionGateScope;
};

/**
 * What one publication produced: the import's own counts, plus both gates'
 * verdict counts. Counts and per-period facts only, never a row.
 */
export type PublishSummary = ImportSummary & {
  cash: ReconciliationGateSummary;
  positions: PositionReconciliationGateSummary;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Earliest plausible statement date. Anything before this is a review item. */
const MIN_PLAUSIBLE_DATE = "1900-01-01";
/** Mirrors positions.valuation_basis's CHECK constraint (pgSchema.ts). */
const VALUATION_BASES = new Set([
  "market_price",
  "last_round",
  "cost",
  "reported_nav",
]);
/** Mirrors adapter.ts's closed gap union and migration 15's CHECK. */
const POSITION_SCOPE_GAP_CODES = new Set<PositionScopeGapCode>([
  "unresolved_lots",
  "missing_security_start",
  "unsupported_table_header",
  "unsupported_value_column",
  "page_sequence_gap",
  "unbounded_account_scope",
  "unproven_empty",
]);

type ReviewCandidate = {
  kind: string;
  rawValue: string;
  reason: string;
};

type ProjectionScopeKind =
  "positions" | "balances" | "liabilities" | "activity";

type ProjectionMismatchScope = {
  kind: ProjectionScopeKind;
  accountId: string;
  asOf: string;
};

type ProjectionSafety = {
  safe: boolean;
  scopes: readonly ProjectionMismatchScope[];
  attributionComplete: boolean;
};

const HOLDING_MISMATCH_REASON_PREFIX =
  "authoritative reparse did not exactly restate this document's stored ";
const HOLDING_MISMATCH_REASON_SUFFIX =
  " projection, or matched a row owned by another document; old rows and evidence were preserved, no reparsed holdings were published, and the document remains partial pending a reviewed replacement";
const ACTIVITY_MISMATCH_REASON =
  "authoritative reparse did not safely restate this document's stored activity projection, or matched activity owned by another document; old activity and evidence were preserved and the document remains partial";
const VERSIONED_HOLDING_MISMATCH_REASON =
  "authoritative replay did not exactly restate this document's active reviewed holding projection; current holdings and history were preserved and the document remains partial";

// F1-51. The column order every batched INSERT below binds its tuples in.
// One list per table rather than a literal repeated in two places, because
// a column list and a values list that drift apart is a silent column swap,
// not a syntax error.
const TRANSACTION_COLUMNS = [
  "id",
  "account_id",
  "trade_date",
  "process_date",
  "settle_date",
  "date_precision",
  "activity_type",
  "description",
  "instrument_id",
  "quantity",
  "price",
  "amount",
  "currency",
  "amount_base",
  "fx_rate",
  "amount_base_rounding",
  "running_balance",
  "source_document_id",
  "source_locator",
  "row_hash",
  "provider_txn_id",
  "status",
  "imported_at",
] as const;

const POSITION_COLUMNS = [
  "id",
  "account_id",
  "as_of",
  "instrument_id",
  "quantity",
  "price",
  "market_value",
  "cost_basis",
  "unrealized",
  "currency",
  "valuation_basis",
  "valuation_note",
  "source_document_id",
  "source_locator",
  "row_hash",
] as const;

const BALANCE_COLUMNS = [
  "id",
  "account_id",
  "as_of",
  "total_value",
  "cash",
  "currency",
  "period_start_value",
  "period_end_value",
  "source_document_id",
  "source_locator",
  "row_hash",
] as const;

const LIABILITY_COLUMNS = [
  "id",
  "institution_id",
  "account_id",
  "kind",
  "display_name",
  "balance",
  "currency",
  "rate",
  "as_of",
  "collateral_note",
  "source_document_id",
  "source_locator",
  "row_hash",
] as const;

/** Shared with `adapterImport.ts`, which buffers its own review items. */
export const REVIEW_COLUMNS = [
  "id",
  "kind",
  "account_id",
  "source_document_id",
  "source_locator",
  "raw_value",
  "reason",
] as const;

/**
 * One holding (a position, balance or liability) ready to insert: the values
 * its columns take, its own `row_hash` (F1-49), and the review items it
 * earned. All three tables dedupe by `row_hash` and differ only in their
 * columns, so one shape and one batching function serve all three.
 */
type PreparedHolding = {
  hash: string;
  values: unknown[];
  pending: ReviewCandidate[];
  accountId: string | null;
  sourceLocator: string;
  /**
   * F1-59. What this holding is called in its table's reconciliation scope,
   * recorded only if it actually inserts. Null for a holding no gate checks:
   * a liability, or a position with no instrument to pair snapshots on.
   */
  changedKey: string | null;
};

/** `transactions`' provider-id identity: per account, not global. */
function providerKey(accountId: string, providerTxnId: string): string {
  return `${accountId}\u0000${providerTxnId}`;
}

/**
 * Imports one batch and immediately reconciles what it imported, as one
 * atomic publication.
 *
 * This is the entry point a caller should use. Running the import and then
 * the gates as separate transactions would publish a window in which the new
 * transactions are visible against the previous period's verdict, and a
 * reader cannot tell that window from a settled archive -- which is precisely
 * the confidently-wrong answer ground rule 3 exists to prevent. One
 * transaction, so a reader sees the ledger and the verdicts that judge it
 * change together or not at all.
 *
 * A second writer is excluded by the database: every writer takes the same
 * transaction-scoped advisory lock (see `lockArchiveForWrite`), so a
 * concurrent import waits rather than racing. Retries stay idempotent -- a
 * document already imported contributes nothing on a second run -- so a
 * retried publication after a lock wait inserts nothing new rather than
 * colliding on `row_hash`.
 */
export async function publishImport(
  client: ArchiveClient,
  batch: ImportBatch,
  now: Date = new Date(),
  options: ImportOptions = {},
): Promise<PublishSummary> {
  return withArchiveTransaction(client, async (tx) => {
    const summary = await importBatch(tx, batch, now, options);
    // F1-59: scoped to what this import inserted, so publishing a document
    // costs a handful of round trips against the periods that document
    // moved rather than a whole-archive pass. `run.ts` runs the
    // whole-archive form once at the end of a run.
    const cash = await runReconciliationGate(
      tx,
      summary.importRunId,
      summary.changed.cash,
    );
    const positions = await runPositionReconciliationGate(
      tx,
      summary.importRunId,
      summary.changed.positions,
    );
    return {
      ...summary,
      reconciliationsPassed: cash.passed + positions.passed,
      reconciliationsFailed:
        cash.failed + cash.unverified + positions.failed + positions.unverified,
      cash,
      positions,
    };
  });
}

/**
 * Runs one import batch to completion inside a single database transaction:
 * either every document's rows land and the run is recorded, or nothing does.
 * A provider-count mismatch or a broken row_hash/account invariant rolls the
 * whole run back rather than leaving a partially-imported archive (ground
 * rules 3 and 7 treat these as gates, not reports).
 *
 * Prefer `publishImport`, which additionally reconciles what it imported in
 * the same transaction. Calling this alone is correct for an import a caller
 * will gate separately; it is still atomic and still takes the write lock.
 *
 * `now` is injectable so future-date and implausible-date review checks are
 * deterministic in tests; it defaults to the wall clock.
 */
export async function importBatch(
  client: ArchiveClient,
  batch: ImportBatch,
  now: Date = new Date(),
  options: ImportOptions = {},
): Promise<ImportSummary> {
  const importRunId = randomUUID();
  const startedAt = now.toISOString();
  const today = startedAt.slice(0, 10);

  let filesSeen = 0;
  let rowsInserted = 0;
  let rowsDeduplicated = 0;
  let rowsRefused = 0;
  let reviewItemsOpened = 0;
  let reviewItemsResolved = 0;
  let reviewItemsUpdated = 0;

  // F1-8b. Every row's account, resolved to `accounts.base_currency` once
  // for the whole batch rather than once per row: `prepareRow` is otherwise
  // pure (no database access), and this is the one fact about an account it
  // needs to derive `amount_base` from a stated FX rate. Populated below,
  // before `prepareRow` is ever called; a `Map` a closure captures by
  // reference sees the values as of when it is read, not when it was
  // declared.
  const baseCurrencyByAccount = new Map<string, string | null>();

  // F1-59. The keys of every row this run inserts, deduplicated as strings
  // so a 20,000-row pull carries a few hundred of them rather than 20,000.
  // Only inserts: a deduplicated row is content the archive already held and
  // moves no verdict, and a refused one never landed at all.
  const changedTransactions = new Set<string>();
  const changedPositions = new Set<string>();
  const changedBalances = new Set<string>();

  // F1-51. Review items are buffered in the order they are opened and
  // written with one multi-row INSERT per document (`flushReviews`), rather
  // than one round trip each. The order they are opened in is unchanged, and
  // nothing between here and the flush reads `review_items` back except the
  // `document_unparsed` check, which is scoped to a kind this loop only ever
  // appends (never queries), and `flushReviews`' own dedupe check below.
  let reviews: unknown[][] = [];
  let scopedProjectionReviews: unknown[][] = [];

  // F1-58. `weak_instrument_match` items are buffered separately from
  // `reviews` above and flushed through `flushWeakInstrumentMatches`
  // instead of the generic `insertRows` path: this kind's identity is
  // (institution, descriptor, matched instrument), not (document, locator,
  // raw_value), so writing it needs an upsert that folds a later document's
  // sighting into the same row rather than a plain insert.
  let weakInstrumentReviews: WeakInstrumentCandidate[] = [];

  // F1-76 phase 3. Matches the same-institution symbol rule accepted, buffered
  // like the weak ones and written by `flushInstitutionSymbolMatches`.
  let institutionSymbolReviews: WeakInstrumentCandidate[] = [];

  /**
   * F1-76 phase 3. Every symbol-only match decision this run made, counted
   * once per (institution, descriptor, matched instrument) rather than once
   * per sighting: one statement per month restating the same holding is one
   * decision, and a per-sighting number would report the corpus size instead
   * of the outcome.
   */
  const instrumentMatches = emptyInstrumentMatchSummary();
  const decidedMatches = new Set<string>();

  function openReview(
    accountId: string | null,
    documentId: string | null,
    sourceLocator: string | null,
    candidate: ReviewCandidate,
  ): void {
    reviews.push([
      randomUUID(),
      candidate.kind,
      accountId,
      documentId,
      sourceLocator,
      candidate.rawValue,
      candidate.reason,
    ]);
  }

  function openScopedProjectionReview(
    documentId: string,
    kind:
      "reparse_projection_mismatch" | "reparse_activity_projection_mismatch",
    scope: ProjectionMismatchScope,
    rawValue: string,
    reason: string,
  ): void {
    scopedProjectionReviews.push([
      randomUUID(),
      kind,
      scope.accountId,
      documentId,
      null,
      rawValue,
      reason,
      scope.kind,
      scope.asOf,
    ]);
  }

  /**
   * F1-65. A reparse re-derives the identical review item every time it
   * re-encounters the same evidence: the same weak instrument match on every
   * row that references it, the same undeclared activity type on every row
   * of that type. Before this, `flushReviews` wrote whatever `reviews` held
   * with no check at all, so those duplicates piled up both within one
   * document's own batch (the actual majority of one hosted reparse's
   * 76,687 opened items) and across every reparse of a document that never
   * reached `parsed_ok`. This is the identity `review_items_dedupe_key`
   * (pgSchema.ts) enforces at the row level; this is where it is enforced
   * for the buffered path, one query and one INSERT per document.
   *
   * Only for `documentId !== null`: an item with no document to scope it
   * (adapterImport.ts's pull-level `flushInstruments`, and every item from
   * before PR137) has no stable identity across pulls to dedupe against, and
   * keeps opening a fresh row every time exactly as it always has -- see
   * `review_items_dedupe_key`'s own comment for why the same distinction is
   * drawn at the database level.
   */
  /** (kind, source_locator, raw_value) -- the nullable three of the four
   * `review_items_dedupe_key` columns (the fourth, `source_document_id`, is
   * fixed per `flushReviews` call and left out of the key).
   *
   * `source_locator` is coalesced to `""` before it goes into the key, the
   * same as `review_items_dedupe_key`'s indexed expression: every
   * `AdapterReviewItem`-produced kind (`weak_instrument_match`,
   * `undeclared_activity_type`, `unknown_account_key`) carries a null
   * locator, and most of one hosted reparse's duplicates were exactly this
   * shape -- a document set, a locator null. Two JS `null`s already compare
   * equal, so this coalesce changes nothing about *this* function's own
   * behavior; it exists so this key never disagrees with what the database
   * will accept. A plain `UNIQUE` index does not coalesce on its own --
   * unlike `GROUP BY`, it treats two `NULL`s in an indexed column as
   * distinct -- so without the same coalesce on both sides, a candidate this
   * function called new could still collide at `INSERT` time.
   */
  function reviewDedupeKey(row: {
    kind: string;
    source_locator: string | null;
    raw_value: string | null;
  }): string {
    return JSON.stringify([row.kind, row.source_locator ?? "", row.raw_value]);
  }

  /** A pending review candidate tuple's own dedupe key, read back out of the
   * positions `REVIEW_COLUMNS` binds it at. */
  function candidateKey(candidate: readonly unknown[]): string {
    return reviewDedupeKey({
      kind: candidate[1] as string,
      source_locator: candidate[4] as string | null,
      raw_value: candidate[5] as string | null,
    });
  }

  async function flushReviews(documentId: string | null): Promise<void> {
    const pending = reviews;
    reviews = [];
    let toInsert = pending;
    if (pending.length > 0 && documentId !== null) {
      const seen = new Set<string>();
      const deduped = pending.filter((candidate) => {
        const key = candidateKey(candidate);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const existing = await client.query<{
        kind: string;
        source_locator: string | null;
        raw_value: string | null;
      }>(
        `SELECT kind, source_locator, raw_value FROM review_items
          WHERE source_document_id = $1 AND projection_scope_kind IS NULL`,
        [documentId],
      );
      const alreadyOpen = new Set(existing.rows.map(reviewDedupeKey));
      toInsert = deduped.filter(
        (candidate) => !alreadyOpen.has(candidateKey(candidate)),
      );
    }

    reviewItemsOpened += toInsert.length;
    await insertRows(client, "review_items", REVIEW_COLUMNS, toInsert);

    const pendingScoped = scopedProjectionReviews;
    scopedProjectionReviews = [];
    if (pendingScoped.length === 0) return;
    if (documentId === null) {
      throw new Error("scoped projection review requires a source document");
    }
    const scopedKey = (row: readonly unknown[]) =>
      JSON.stringify([row[1], row[2], row[7], row[8], row[4] ?? "", row[5]]);
    const seenScoped = new Set<string>();
    const dedupedScoped = pendingScoped.filter((candidate) => {
      const key = scopedKey(candidate);
      if (seenScoped.has(key)) return false;
      seenScoped.add(key);
      return true;
    });
    const existingScoped = await client.query<{
      kind: string;
      account_id: string;
      projection_scope_kind: string;
      projection_scope_as_of: string;
      source_locator: string | null;
      raw_value: string | null;
    }>(
      `SELECT kind, account_id, projection_scope_kind,
              projection_scope_as_of::text, source_locator, raw_value
         FROM review_items
        WHERE source_document_id = $1 AND projection_scope_kind IS NOT NULL`,
      [documentId],
    );
    const existingKeys = new Set(
      existingScoped.rows.map((row) =>
        JSON.stringify([
          row.kind,
          row.account_id,
          row.projection_scope_kind,
          row.projection_scope_as_of,
          row.source_locator ?? "",
          row.raw_value,
        ]),
      ),
    );
    const newScoped = dedupedScoped.filter(
      (candidate) => !existingKeys.has(scopedKey(candidate)),
    );
    reviewItemsOpened += newScoped.length;
    await insertRows(
      client,
      "review_items",
      [...REVIEW_COLUMNS, "projection_scope_kind", "projection_scope_as_of"],
      newScoped,
    );
  }

  async function reopenSystemResolvedReview(
    documentId: string,
    kind: string,
    rawValue: string,
    reason: string,
  ): Promise<void> {
    const reopened = await client.query(
      `UPDATE review_items SET status = 'open', account_id = NULL
        WHERE source_document_id = $1 AND kind = $2 AND raw_value = $3
          AND reason = $4
          AND projection_scope_kind IS NULL
          AND (
            (status = 'open' AND account_id IS NOT NULL)
            OR (
              status = 'resolved'
              AND (
                resolution_note LIKE
                  'resolved on reimport: the authoritative % projection now safely restates every stored row (import_runs.id=%'
                OR resolution_note LIKE
                  'resolved on reimport: superseded by exact account/date system mismatch reviews (import_runs.id=%'
              )
            )
          )`,
      [documentId, kind, rawValue, reason],
    );
    reviewItemsUpdated += reopened.rowCount ?? 0;
  }

  const SCOPED_PROJECTION_RESOLUTION_PREFIX =
    "resolved on reimport: this exact system projection mismatch no longer applies";

  async function syncScopedProjectionReviews(
    documentId: string,
    reviewKind:
      "reparse_projection_mismatch" | "reparse_activity_projection_mismatch",
    projectionKind: ProjectionScopeKind,
    rawValue: string,
    reason: string,
    scopes: readonly ProjectionMismatchScope[],
  ): Promise<void> {
    const current = scopes.filter((scope) => scope.kind === projectionKind);
    const accountIds = current.map((scope) => scope.accountId);
    const dates = current.map((scope) => scope.asOf);
    const resolved = await client.query(
      `UPDATE review_items existing
          SET status = 'resolved', resolved_at = $4, resolution_note = $5
        WHERE existing.source_document_id = $1
          AND existing.kind = $2
          AND existing.projection_scope_kind = $3
          AND existing.status = 'open'
          AND (
            ($2 = 'reparse_projection_mismatch' AND (
              existing.reason LIKE $6 OR existing.reason = $7
            ))
            OR ($2 = 'reparse_activity_projection_mismatch'
                AND existing.reason = $8)
          )
          AND NOT (
            existing.raw_value IS NOT DISTINCT FROM $11
            AND existing.reason = $12
            AND EXISTS (
              SELECT 1 FROM unnest($9::text[], $10::date[])
                AS current_scope(account_id, as_of)
               WHERE current_scope.account_id = existing.account_id
                 AND current_scope.as_of = existing.projection_scope_as_of
            )
          )`,
      [
        documentId,
        reviewKind,
        projectionKind,
        now.toISOString(),
        `${SCOPED_PROJECTION_RESOLUTION_PREFIX} (import_runs.id=${importRunId})`,
        `${HOLDING_MISMATCH_REASON_PREFIX}%${HOLDING_MISMATCH_REASON_SUFFIX}`,
        VERSIONED_HOLDING_MISMATCH_REASON,
        ACTIVITY_MISMATCH_REASON,
        accountIds,
        dates,
        rawValue,
        reason,
      ],
    );
    reviewItemsResolved += resolved.rowCount ?? 0;
    for (const scope of current) {
      const reopened = await client.query(
        `UPDATE review_items SET status = 'open'
          WHERE source_document_id = $1 AND kind = $2
            AND projection_scope_kind = $3
            AND account_id = $4 AND projection_scope_as_of = $5::date
            AND raw_value = $6 AND reason = $7
            AND status = 'resolved'
            AND resolution_note LIKE $8`,
        [
          documentId,
          reviewKind,
          projectionKind,
          scope.accountId,
          scope.asOf,
          rawValue,
          reason,
          `${SCOPED_PROJECTION_RESOLUTION_PREFIX} (import_runs.id=%`,
        ],
      );
      reviewItemsUpdated += reopened.rowCount ?? 0;
      openScopedProjectionReview(
        documentId,
        reviewKind,
        scope,
        rawValue,
        reason,
      );
    }
  }

  async function supersedeSystemGenericProjectionReviews(
    documentId: string,
    reviewKind:
      "reparse_projection_mismatch" | "reparse_activity_projection_mismatch",
  ): Promise<void> {
    const superseded = await client.query(
      `UPDATE review_items
          SET status = 'resolved', resolved_at = $3, resolution_note = $4
        WHERE source_document_id = $1 AND kind = $2
          AND projection_scope_kind IS NULL AND status = 'open'
          AND (
            ($2 = 'reparse_projection_mismatch' AND (
              reason LIKE $5 OR reason = $6
            ))
            OR ($2 = 'reparse_activity_projection_mismatch' AND reason = $7)
          )`,
      [
        documentId,
        reviewKind,
        now.toISOString(),
        `resolved on reimport: superseded by exact account/date system mismatch reviews (import_runs.id=${importRunId})`,
        `${HOLDING_MISMATCH_REASON_PREFIX}%${HOLDING_MISMATCH_REASON_SUFFIX}`,
        VERSIONED_HOLDING_MISMATCH_REASON,
        ACTIVITY_MISMATCH_REASON,
      ],
    );
    reviewItemsResolved += superseded.rowCount ?? 0;
  }

  async function resolveSystemProjectionReviews(
    documentId: string,
    reviewKind:
      "reparse_projection_mismatch" | "reparse_activity_projection_mismatch",
    resolution: string,
  ): Promise<void> {
    const resolved = await client.query(
      `UPDATE review_items
          SET status = 'resolved', resolved_at = $3,
              resolution_note = CASE
                WHEN projection_scope_kind IS NOT NULL THEN $8
                ELSE $4
              END
        WHERE source_document_id = $1 AND kind = $2 AND status = 'open'
          AND (
            ($2 = 'reparse_projection_mismatch' AND (
              reason LIKE $5 OR reason = $6
            ))
            OR ($2 = 'reparse_activity_projection_mismatch' AND reason = $7)
          )`,
      [
        documentId,
        reviewKind,
        now.toISOString(),
        resolution,
        `${HOLDING_MISMATCH_REASON_PREFIX}%${HOLDING_MISMATCH_REASON_SUFFIX}`,
        VERSIONED_HOLDING_MISMATCH_REASON,
        ACTIVITY_MISMATCH_REASON,
        `${SCOPED_PROJECTION_RESOLUTION_PREFIX} (import_runs.id=${importRunId})`,
      ],
    );
    reviewItemsResolved += resolved.rowCount ?? 0;
  }

  const POSITION_SCOPE_MISMATCH_RESOLUTION_PREFIX =
    "resolved on reimport: every declared position scope validated and persisted exactly";

  async function reopenSystemResolvedPositionScopeMismatch(
    documentId: string,
    accountId: string,
    rawValue: string,
  ): Promise<void> {
    const reopened = await client.query(
      `UPDATE review_items SET status = 'open'
        WHERE source_document_id = $1
          AND kind = 'position_scope_mismatch'
          AND account_id = $2
          AND raw_value = $3
          AND status = 'resolved'
          AND resolution_note LIKE $4`,
      [
        documentId,
        accountId,
        rawValue,
        `${POSITION_SCOPE_MISMATCH_RESOLUTION_PREFIX} (import_runs.id=%`,
      ],
    );
    reviewItemsUpdated += reopened.rowCount ?? 0;
  }

  /** One `weak_instrument_match` sighting, not yet written: the descriptor
   * (`rawValue`), the matched instrument and institution it names, and the
   * `reason` the first sighting of this triple would open with. */
  type WeakInstrumentCandidate = {
    rawValue: string | null;
    reason: string;
    institutionId: string | null;
    matchedInstrumentId: string | null;
    reasonCode: InstrumentMatchReasonCode | null;
  };

  /** This kind's identity (F1-58): (institution, descriptor, matched
   * instrument), never the document. Shared between a pending candidate and
   * a row already on file so both sides compare the same way. */
  function weakInstrumentKey(
    institutionId: string | null,
    rawValue: string | null,
    matchedInstrumentId: string | null,
  ): string {
    return JSON.stringify([institutionId, rawValue, matchedInstrumentId]);
  }

  /**
   * F1-58. Folds every sighting of the same (institution, descriptor,
   * matched instrument) into one row instead of one per document: two
   * statements that both weakly match "ZEPHYR CORP" to the same instrument
   * open one item with `occurrence_count = 2`, not two items.
   *
   * `INSERT ... ON CONFLICT ... DO UPDATE` against
   * `review_items_weak_instrument_match_key` (pgSchema.ts migration 8) does
   * the fold: a first sighting inserts with `occurrence_count = 1`; a later
   * one increments it and moves `last_seen_document_id` forward, in the same
   * statement, so two documents in one batch see each other's writes without
   * either round-tripping to check first. The `DO UPDATE ... WHERE
   * review_items.status = 'open'` clause is what "resolving the item
   * records the mapping decision once for every row that shares the
   * descriptor" (README) actually enforces: once a person resolves or
   * dismisses one, a later document repeating the same descriptor finds the
   * conflict, the WHERE clause is false, and Postgres leaves the row
   * untouched -- no new row, no reopened count, no error.
   *
   * `RETURNING occurrence_count` distinguishes a genuinely new item from an
   * existing one that just had its count bumped: a fresh insert always
   * writes `1`, and an increment always writes something greater, so
   * `reviewItemsOpened` keeps counting items opened rather than sightings
   * recorded -- an increment is not a new item. (`xmax = 0` looks like the
   * obvious way to tell an INSERT and an UPDATE apart in one RETURNING, but
   * does not actually work here: `DO UPDATE` also produces a new tuple
   * version with `xmax = 0`, so it reads as "inserted" either way.)
   *
   * The idempotency guard below (`already`) is what a document-level insert
   * gets for free from `flushReviews`' own per-document check but this
   * upsert does not: a document not yet `parsed_ok` can be reimported more
   * than once before it succeeds (see `importBatch`'s whole-document skip,
   * which only ever short-circuits an already-`parsed_ok` document), and
   * without this check a retried document would increment the same item
   * again for a sighting it already recorded, either as the row's own first
   * sighting (`source_document_id`) or as whichever sighting most recently
   * moved `last_seen_document_id`.
   *
   * ponytail: a document reprocessed a third time, after a *different*,
   * newer document already moved `last_seen_document_id` past it, would not
   * match either half of this guard and would increment again. A document
   * not yet `parsed_ok` retried out of chronological order after a later one
   * already landed is not a shape this importer produces today (`run.ts`
   * always feeds it in pull order); track document ids visited by review
   * item on a real occurrence table if that ever changes.
   */
  async function flushWeakInstrumentMatches(
    documentId: string | null,
  ): Promise<void> {
    const pending = weakInstrumentReviews;
    weakInstrumentReviews = [];
    if (pending.length === 0) return;

    const seen = new Set<string>();
    const deduped = pending.filter((candidate) => {
      const key = weakInstrumentKey(
        candidate.institutionId,
        candidate.rawValue,
        candidate.matchedInstrumentId,
      );
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    let toUpsert = deduped;
    if (documentId !== null) {
      const already = await client.query<{
        institution_id: string | null;
        raw_value: string | null;
        matched_instrument_id: string | null;
      }>(
        `SELECT institution_id, raw_value, matched_instrument_id FROM review_items
          WHERE kind = 'weak_instrument_match'
            AND (source_document_id = $1 OR last_seen_document_id = $1)`,
        [documentId],
      );
      const attributed = new Set(
        already.rows.map((row) =>
          weakInstrumentKey(
            row.institution_id,
            row.raw_value,
            row.matched_instrument_id,
          ),
        ),
      );
      toUpsert = deduped.filter(
        (candidate) =>
          !attributed.has(
            weakInstrumentKey(
              candidate.institutionId,
              candidate.rawValue,
              candidate.matchedInstrumentId,
            ),
          ),
      );
    }
    if (toUpsert.length === 0) return;

    // ponytail: one statement, unchunked -- a document's own distinct weakly
    // matched instruments are at most a few hundred, far under
    // insertRows/MAX_BIND_PARAMETERS' chunking threshold. Chunk if a single
    // document's holdings ever approach that.
    const values: unknown[] = [];
    const tuples = toUpsert.map((candidate) => {
      const id = `$${values.push(randomUUID())}`;
      const doc = `$${values.push(documentId)}`;
      const rawValue = `$${values.push(candidate.rawValue)}`;
      const reason = `$${values.push(candidate.reason)}`;
      const institutionId = `$${values.push(candidate.institutionId)}`;
      const matchedInstrumentId = `$${values.push(candidate.matchedInstrumentId)}`;
      const reasonCode = `$${values.push(candidate.reasonCode)}`;
      // account_id and source_locator: always NULL for this kind, same as
      // the generic path. source_document_id (first-seen) and
      // last_seen_document_id both start at this document on first insert;
      // only the DO UPDATE branch moves last_seen_document_id forward.
      return `(${id}, 'weak_instrument_match', NULL, ${doc}, NULL, ${rawValue}, ${reason}, ${institutionId}, ${matchedInstrumentId}, 1, ${doc}, ${reasonCode})`;
    });

    // F1-76 phase 3: `reason_code` and `reason` are refreshed on the DO UPDATE
    // branch, not only written on insert. Which condition of the rule an open
    // item fails can change between runs, and an open item still naming last
    // month's condition is the review queue quietly describing something that
    // is no longer true.
    //
    // One reason is never overwritten.
    // `institution_symbol_match_invalidated` says this archive had accepted
    // the match and took the acceptance back, which no refusal code says and
    // which a reparse re-deriving the ordinary refusal would erase. It stands
    // as long as the item is open; the rule accepting the match again is what
    // clears it, in `flushInstitutionSymbolMatches`.
    const result = await client.query<{ occurrence_count: number }>(
      `INSERT INTO review_items
         (id, kind, account_id, source_document_id, source_locator, raw_value, reason,
          institution_id, matched_instrument_id, occurrence_count, last_seen_document_id,
          reason_code)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (kind, institution_id, raw_value, matched_instrument_id)
         WHERE kind IN ('weak_instrument_match', 'institution_symbol_match')
       DO UPDATE SET
         occurrence_count = review_items.occurrence_count + 1,
         last_seen_document_id = EXCLUDED.last_seen_document_id,
         reason = CASE WHEN review_items.reason_code = '${INSTITUTION_SYMBOL_INVALIDATED}'
                       THEN review_items.reason ELSE EXCLUDED.reason END,
         reason_code = CASE WHEN review_items.reason_code = '${INSTITUTION_SYMBOL_INVALIDATED}'
                            THEN review_items.reason_code ELSE EXCLUDED.reason_code END
         WHERE review_items.status = 'open'
       RETURNING occurrence_count`,
      values,
    );
    reviewItemsOpened += result.rows.filter(
      (row) => row.occurrence_count === 1,
    ).length;
  }

  /**
   * F1-76 phase 3. Writes what the same-institution symbol rule accepted, and
   * closes what it supersedes.
   *
   * Two statements, in this order, because they are two different facts. The
   * first records the decision: one `institution_symbol_match` row per
   * (institution, descriptor, matched instrument), written already `resolved`
   * and naming the rule, because an acceptance asks nobody anything and has no
   * business sitting in a queue. `DO NOTHING` on conflict -- the same rule
   * reaching the same conclusion on the next statement adds nothing to the row
   * it already wrote, which is also what makes a reimport idempotent. The one
   * exception is a row this rule itself withdrew
   * (`institution_symbol_match_invalidated`): if the broken condition holds
   * again, the acceptance is restored rather than left dismissed beside a
   * resolved weak item, which together would read as a full identifier match.
   * A row a *person* dismissed carries the rule's own reason code, never the
   * withdrawal's, and is never touched.
   *
   * The second closes the `weak_instrument_match` this match used to be. The
   * owner's archive carries 1,330 of them; leaving them open beside an
   * acceptance would say the archive is unsure about a match it just accepted.
   * The row is resolved rather than deleted (nothing here ever deletes a
   * review item) and the resolution note names the rule, so "why did this
   * close" is answerable a year from now. Only an `open` item is touched: a
   * person's own dismissal is never overruled by a rule.
   */
  async function flushInstitutionSymbolMatches(
    documentId: string | null,
  ): Promise<void> {
    const pending = institutionSymbolReviews;
    institutionSymbolReviews = [];
    if (pending.length === 0) return;

    const seen = new Set<string>();
    const accepted = pending.filter((candidate) => {
      const key = weakInstrumentKey(
        candidate.institutionId,
        candidate.rawValue,
        candidate.matchedInstrumentId,
      );
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const values: unknown[] = [];
    const tuples = accepted.map((candidate) => {
      const id = `$${values.push(randomUUID())}`;
      const doc = `$${values.push(documentId)}`;
      const rawValue = `$${values.push(candidate.rawValue)}`;
      const reason = `$${values.push(candidate.reason)}`;
      const institutionId = `$${values.push(candidate.institutionId)}`;
      const matchedInstrumentId = `$${values.push(candidate.matchedInstrumentId)}`;
      const reasonCode = `$${values.push(candidate.reasonCode)}`;
      return (
        `(${id}, 'institution_symbol_match', NULL, ${doc}, NULL, ${rawValue}, ${reason}, ` +
        `'resolved', $${values.push(now.toISOString())}, ` +
        `$${values.push(`accepted by ${INSTITUTION_SYMBOL_RULE} (import_runs.id=${importRunId})`)}, ` +
        `${reasonCode}, ${institutionId}, ${matchedInstrumentId}, 1, ${doc})`
      );
    });
    await client.query(
      `INSERT INTO review_items
         (id, kind, account_id, source_document_id, source_locator, raw_value, reason,
          status, resolved_at, resolution_note, reason_code,
          institution_id, matched_instrument_id, occurrence_count, last_seen_document_id)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (kind, institution_id, raw_value, matched_instrument_id)
         WHERE kind IN ('weak_instrument_match', 'institution_symbol_match')
       DO UPDATE SET status = 'resolved', resolved_at = EXCLUDED.resolved_at,
                     resolution_note = EXCLUDED.resolution_note,
                     reason = EXCLUDED.reason, reason_code = EXCLUDED.reason_code
         WHERE review_items.status = 'dismissed'
           AND review_items.reason_code = '${INSTITUTION_SYMBOL_INVALIDATED}'`,
      values,
    );

    const resolved = await client.query(
      `UPDATE review_items AS r
          SET status = 'resolved', resolved_at = $1, resolution_note = $2,
              reason_code = $3
         FROM (SELECT unnest($4::text[]) AS institution_id,
                      unnest($5::text[]) AS raw_value,
                      unnest($6::text[]) AS matched_instrument_id) AS accepted
        WHERE r.kind = 'weak_instrument_match' AND r.status = 'open'
          AND r.institution_id = accepted.institution_id
          AND r.raw_value = accepted.raw_value
          AND r.matched_instrument_id = accepted.matched_instrument_id`,
      [
        now.toISOString(),
        `resolved by ${INSTITUTION_SYMBOL_RULE}: this institution supplied both the holding ` +
          `and the matched instrument's identifier, and the symbol names exactly one ` +
          `instrument (import_runs.id=${importRunId})`,
        INSTITUTION_SYMBOL_RULE,
        accepted.map((candidate) => candidate.institutionId),
        accepted.map((candidate) => candidate.rawValue),
        accepted.map((candidate) => candidate.matchedInstrumentId),
      ],
    );
    reviewItemsResolved += resolved.rowCount ?? 0;
    instrumentMatches.resolvedByRule += resolved.rowCount ?? 0;
  }

  /**
   * F1-76 phase 3, the owner's self-correction requirement: an accepted match
   * must never stay accepted on stale evidence.
   *
   * Two later imports can make an acceptance unsafe. A second instrument can
   * appear carrying the same symbol, which breaks condition 1; or another
   * institution's rows can start referencing the matched instrument, which
   * breaks the only evidence this archive has for conditions 2 and 3. Both are
   * caused by writes, so this runs after each document's own writes and asks
   * the question only about matches that document could have disturbed: one on
   * an instrument it referenced, or on an instrument sharing a symbol with one
   * it referenced. The second half is what catches a document that minted the
   * colliding instrument itself, which the first half would miss -- its rows
   * point at the new row, never at the accepted one.
   *
   * A withdrawal is two writes for the same reason an acceptance is: the
   * accepted row is dismissed with a note saying what stopped holding, and the
   * `weak_instrument_match` beside it is reopened carrying
   * `institution_symbol_match_invalidated`. The read surface then reports the
   * positions as ambiguous again with no per-position rewrite, because a
   * position never stored the match kind -- it is derived from these rows.
   */
  async function invalidateStaleInstitutionSymbolMatches(
    instrumentIds: readonly string[],
  ): Promise<void> {
    if (instrumentIds.length === 0) return;
    const stale = await client.query<{
      id: string;
      institution_id: string | null;
      raw_value: string | null;
      matched_instrument_id: string | null;
      reason_code: InstitutionSymbolRefusalReason;
    }>(
      `WITH touched AS (
         SELECT id, upper(btrim(symbol)) AS symbol FROM instruments
          WHERE id = ANY($1::text[])
       ),
       item AS (
         SELECT r.id, r.institution_id, r.raw_value, r.matched_instrument_id,
                upper(btrim(i.symbol)) AS symbol
           FROM review_items r
           JOIN instruments i ON i.id = r.matched_instrument_id
          WHERE r.kind = 'institution_symbol_match' AND r.status = 'resolved'
            AND (r.matched_instrument_id IN (SELECT id FROM touched)
                 OR (i.symbol IS NOT NULL AND upper(btrim(i.symbol)) IN
                       (SELECT symbol FROM touched WHERE symbol IS NOT NULL)))
       ),
       sharing AS (
         SELECT upper(btrim(i.symbol)) AS symbol, count(*) AS n FROM instruments i
          WHERE upper(btrim(i.symbol)) IN
                (SELECT symbol FROM item WHERE symbol IS NOT NULL)
          GROUP BY upper(btrim(i.symbol))
       ),
       refs AS (
         SELECT s.instrument_id, count(*) AS institutions,
                min(s.institution_id) AS institution_id
           FROM instrument_identifier_sources s
          WHERE s.instrument_id IN (SELECT matched_instrument_id FROM item)
          GROUP BY s.instrument_id
       )
       SELECT * FROM (
         SELECT item.id, item.institution_id, item.raw_value, item.matched_instrument_id,
                CASE
                  WHEN coalesce(sharing.n, 1) > 1
                    THEN 'symbol_matches_several_instruments'
                  WHEN refs.instrument_id IS NULL
                    THEN 'instrument_has_no_institution_evidence'
                  WHEN refs.institutions > 1
                    THEN 'instrument_referenced_by_several_institutions'
                  WHEN refs.institution_id IS DISTINCT FROM item.institution_id
                    THEN 'instrument_vouched_by_another_institution'
                END AS reason_code
           FROM item
           LEFT JOIN sharing ON sharing.symbol = item.symbol
           LEFT JOIN refs ON refs.instrument_id = item.matched_instrument_id
       ) AS verdict
        WHERE reason_code IS NOT NULL`,
      [[...instrumentIds]],
    );
    if (stale.rows.length === 0) return;

    await client.query(
      `UPDATE review_items SET status = 'dismissed', resolved_at = $2,
              resolution_note = $3, reason_code = '${INSTITUTION_SYMBOL_INVALIDATED}'
        WHERE id = ANY($1::text[]) AND status = 'resolved'`,
      [
        stale.rows.map((row) => row.id),
        now.toISOString(),
        `withdrawn by ${INSTITUTION_SYMBOL_RULE}: later imported data stopped satisfying the ` +
          `rule, so this acceptance no longer stands (import_runs.id=${importRunId})`,
      ],
    );

    const values: unknown[] = [];
    const tuples = stale.rows.map((row) => {
      const id = `$${values.push(randomUUID())}`;
      const rawValue = `$${values.push(row.raw_value)}`;
      const reason = `$${values.push(
        "a match accepted under the same-institution symbol rule no longer satisfies it " +
          `(${row.reason_code}); the acceptance was withdrawn and this match is flagged again ` +
          "-- confirm or correct it",
      )}`;
      const institutionId = `$${values.push(row.institution_id)}`;
      const matchedInstrumentId = `$${values.push(row.matched_instrument_id)}`;
      return (
        `(${id}, 'weak_instrument_match', NULL, NULL, NULL, ${rawValue}, ${reason}, ` +
        `'open', $${values.push(INSTITUTION_SYMBOL_INVALIDATED)}, ` +
        `${institutionId}, ${matchedInstrumentId}, 1)`
      );
    });
    // Unconditional, including over an item a person dismissed. A dismissal
    // answered "is this weak match acceptable" against evidence that has since
    // changed, and this is a different question about different evidence, not
    // the same one asked again. Leaving a dismissed item alone here would let
    // the position keep reading as a settled identity while this run counted
    // the acceptance as withdrawn -- exactly the silence the owner's
    // requirement forbids. A withdrawal always leaves an open item.
    const reopened = await client.query(
      `INSERT INTO review_items
         (id, kind, account_id, source_document_id, source_locator, raw_value, reason,
          status, reason_code, institution_id, matched_instrument_id, occurrence_count)
       VALUES ${tuples.join(", ")}
       ON CONFLICT (kind, institution_id, raw_value, matched_instrument_id)
         WHERE kind IN ('weak_instrument_match', 'institution_symbol_match')
       DO UPDATE SET status = 'open', resolved_at = NULL, resolution_note = NULL,
                     reason = EXCLUDED.reason, reason_code = EXCLUDED.reason_code`,
      values,
    );
    reviewItemsOpened += reopened.rowCount ?? 0;
    instrumentMatches.invalidated += stale.rows.length;
  }

  /**
   * F1-76 phase 3. Routes one document's instrument-match items onto their
   * buffers and counts the decision, once per (institution, descriptor,
   * matched instrument) across the whole run. Shared by the ordinary import
   * path and the already-`parsed_ok` skip below, which is the path a
   * whole-archive reparse actually takes: without it a reparse would re-derive
   * every decision and write none of them.
   */
  function routeInstrumentMatch(item: AdapterReviewItem): boolean {
    const accepted = item.kind === "institution_symbol_match";
    if (!accepted && item.kind !== "weak_instrument_match") return false;
    const candidate: WeakInstrumentCandidate = {
      rawValue: item.rawValue,
      reason: item.reason,
      institutionId: item.institutionId ?? null,
      matchedInstrumentId: item.matchedInstrumentId ?? null,
      reasonCode: item.reasonCode ?? null,
    };
    if (accepted) institutionSymbolReviews.push(candidate);
    else weakInstrumentReviews.push(candidate);

    const key = `${item.kind}\u0000${weakInstrumentKey(
      candidate.institutionId,
      candidate.rawValue,
      candidate.matchedInstrumentId,
    )}`;
    if (!decidedMatches.has(key)) {
      decidedMatches.add(key);
      if (accepted) instrumentMatches.accepted += 1;
      else if (candidate.reasonCode !== null) {
        instrumentMatches.refused[
          candidate.reasonCode as InstitutionSymbolRefusalReason
        ] += 1;
      }
    }
    return true;
  }

  /** Every instrument one document's rows and holdings point at: what
   * `invalidateStaleInstitutionSymbolMatches` asks its question about. */
  function documentInstrumentIds(document: ImportDocument): string[] {
    const ids = new Set<string>();
    for (const row of document.rows) {
      if (row.instrumentId !== null) ids.add(row.instrumentId);
    }
    for (const position of document.positions ?? []) {
      if (position.instrumentId !== null) ids.add(position.instrumentId);
    }
    return [...ids];
  }

  /**
   * Everything one transaction row needs, computed without touching the
   * database: the canonicalized values that go into the columns, the review
   * items they earned, and the row hash. Splitting this out is what lets a
   * whole document's rows be deduplicated in one query each and inserted in
   * one statement (F1-51) while the per-row rules stay exactly as they were.
   */
  type PreparedTransaction = {
    row: ImportRow;
    hash: string;
    values: unknown[];
    pending: ReviewCandidate[];
  };

  function prepareRow(
    row: ImportRow,
    documentId: string,
    occurrences: Map<string, number>,
  ): PreparedTransaction | null {
    if (!ISO_DATE.test(row.processDate)) {
      openReview(row.accountId, documentId, row.sourceLocator, {
        kind: "unparseable_process_date",
        rawValue: row.processDate,
        reason: "process date is not a valid ISO YYYY-MM-DD date",
      });
      return null;
    }

    const pending: ReviewCandidate[] = [];
    if (row.processDate > today) {
      pending.push({
        kind: "future_date",
        rawValue: row.processDate,
        reason: "process date is after the import's reference date",
      });
    } else if (row.processDate < MIN_PLAUSIBLE_DATE) {
      pending.push({
        kind: "implausible_date",
        rawValue: row.processDate,
        reason: `process date is before ${MIN_PLAUSIBLE_DATE}, the earliest plausible statement date`,
      });
    }

    // trade_date and settle_date are nullable, so a malformed value is never
    // a reason to abort the row (let alone the batch): it is stored as NULL
    // with a review item, same spirit as process_date's plausibility checks.
    const tradeDate = resolveOptionalDate(row.tradeDate, "trade_date", pending);
    const settleDate = resolveOptionalDate(
      row.settleDate,
      "settle_date",
      pending,
    );

    // Ground rule 5: an amount the source could not give at all is still
    // null, but the reason must not vanish. This is the adapter's
    // ParsedAmount.amountNote, carried through rather than dropped.
    const amount = resolveAmbiguousMoney(
      row.amountText,
      row.amountNote,
      row.currency,
      "ambiguous_amount",
      pending,
    );

    const quantity = canonicalizeAmbiguous(
      row.quantity,
      "ambiguous_quantity",
      pending,
    );
    const price = canonicalizeAmbiguous(row.price, "ambiguous_price", pending);
    const runningBalance = canonicalizeAmbiguous(
      row.runningBalance,
      "ambiguous_running_balance",
      pending,
    );

    // F1-8b. amount_base/fx_rate/amount_base_rounding: see resolveAmountBase.
    const { amountBase, fxRate, amountBaseRounding } = resolveAmountBase(
      row.amountBaseText ?? null,
      row.fxRateText ?? null,
      amount,
      baseCurrencyByAccount.get(row.accountId) ?? null,
      pending,
    );

    // The occurrence ordinal is a hashed input, not a suffix appended after
    // the fact: the same real transaction reappearing on an overlapping page
    // gets the same ordinal (first time this content is seen in this
    // document) and therefore the same hash, so it is found by lookup below
    // instead of colliding at insert time. Two genuinely different rows with
    // identical content get different ordinals and therefore different
    // hashes, so neither is lost (ground rule: equal date, amount and
    // description is not proof of duplication).
    //
    // `contentKeyV2` and `rowHashV2` are used as a pair, and the amount they
    // are given is the canonicalized decimal that goes into the column. All
    // three agreeing on one spelling of one amount is what keeps `1`, `1.0`
    // and `1.00` a single identity.
    const content = {
      accountId: row.accountId,
      processDate: row.processDate,
      activityType: row.activityType,
      description: row.description,
      quantity,
      amount,
      currency: row.currency,
    };
    const key = contentKeyV2(content);
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);

    const hash = rowHashV2({ ...content, occurrence });

    return {
      row,
      hash,
      pending,
      values: [
        randomUUID(),
        row.accountId,
        tradeDate,
        row.processDate,
        settleDate,
        row.datePrecision,
        row.activityType,
        row.description,
        row.instrumentId,
        quantity,
        price,
        amount,
        row.currency,
        amountBase,
        fxRate,
        amountBaseRounding,
        runningBalance,
        documentId,
        row.sourceLocator,
        hash,
        row.providerTxnId,
        pending.length > 0 ? "review" : "imported",
        startedAt,
      ],
    };
  }

  /**
   * One document's transaction rows: two dedupe lookups for the whole
   * document instead of one per row, then one multi-row INSERT (F1-51).
   *
   * The in-memory `seenProvider`/`seenByHash` indexes are not a cache. They
   * are what makes a row see the rows *earlier in this same document* exactly
   * as it saw them when each insert was its own statement: a second row
   * carrying an already-inserted provider id still deduplicates, and a row
   * whose hash an earlier row in this document already inserted still
   * collapses with no review item (same document, so no cross-document
   * evidence to record). Rows from earlier documents are already committed
   * to this transaction by the time the next document's lookups run, so they
   * come back from the database as before.
   */
  async function importRows(
    rows: readonly ImportRow[],
    documentId: string,
    occurrences: Map<string, number>,
    preparedOverride?: readonly PreparedTransaction[],
  ): Promise<boolean> {
    const prepared: PreparedTransaction[] = [...(preparedOverride ?? [])];
    if (preparedOverride === undefined) {
      for (const row of rows) {
        const ready = prepareRow(row, documentId, occurrences);
        if (ready === null) rowsRefused += 1;
        else prepared.push(ready);
      }
    }
    if (prepared.length === 0) return false;

    const withProviderId = prepared.filter((p) => p.row.providerTxnId);
    const seenProvider = new Set<string>();
    if (withProviderId.length > 0) {
      // Both columns, not just the provider id: `transactions_provider_txn_id`
      // leads on `account_id`, and an index the leading column is missing from
      // is an index the planner cannot use. The pair set is the cross product
      // of this document's accounts and provider ids, which is wider than the
      // pairs actually asked about, so the exact pairs are matched below.
      const found = await client.query<{
        account_id: string;
        provider_txn_id: string;
      }>(
        `SELECT account_id, provider_txn_id FROM transactions
          WHERE account_id = ANY($1::text[]) AND provider_txn_id = ANY($2::text[])`,
        [
          [...new Set(withProviderId.map((p) => p.row.accountId))],
          [...new Set(withProviderId.map((p) => p.row.providerTxnId))],
        ],
      );
      for (const existing of found.rows) {
        seenProvider.add(
          providerKey(existing.account_id, existing.provider_txn_id),
        );
      }
    }

    const hashes = prepared
      .filter((p) => !p.row.providerTxnId)
      .map((p) => p.hash);
    const seenByHash = new Map<
      string,
      {
        id: string;
        source_document_id: string | null;
        source_locator: string | null;
      }
    >();
    if (hashes.length > 0) {
      const found = await client.query<{
        id: string;
        source_document_id: string | null;
        source_locator: string | null;
        row_hash: string;
      }>(
        "SELECT id, source_document_id, source_locator, row_hash FROM transactions WHERE row_hash = ANY($1::text[])",
        [hashes],
      );
      // row_hash is UNIQUE, so this is one row per hash, exactly what the
      // per-row `rows[0]` lookup returned.
      for (const existing of found.rows) {
        seenByHash.set(existing.row_hash, existing);
      }
    }

    const toInsert: unknown[][] = [];
    let anySuccess = false;
    for (const p of prepared) {
      if (p.row.providerTxnId) {
        const key = providerKey(p.row.accountId, p.row.providerTxnId);
        if (seenProvider.has(key)) {
          // Same account, same stable id: a re-encounter of an
          // already-imported row, most often from an overlapping page in a
          // paginated pull. This is an authoritative identity match, not
          // evidence, so no review item.
          rowsDeduplicated += 1;
          anySuccess = true;
          continue;
        }
        seenProvider.add(key);
        // ponytail: two distinct provider ids landing on the same content and
        // the same per-document occurrence ordinal, in two unrelated
        // documents, would hit the row_hash UNIQUE constraint here and abort
        // the batch loudly rather than silently merge or drop either row.
        // Real enough only if genuinely identical transactions happen on the
        // same account, day and ordinal position across separate pulls; widen
        // the hash to include provider_txn_id if that ever fires.
      } else {
        const existing = seenByHash.get(p.hash);
        if (existing) {
          // No stable id, so this collapse rests on content evidence rather
          // than a stable identifier. Within one document that never happens
          // (each occurrence in a document gets its own ordinal); across two
          // documents it is exactly the overlapping-page case, or, rarely, a
          // genuine coincidence. Either way, make the collapse visible.
          if (existing.source_document_id !== documentId) {
            openReview(p.row.accountId, documentId, p.row.sourceLocator, {
              kind: "cross_document_duplicate",
              rawValue: existing.id,
              reason:
                `matches an existing transaction from document ${existing.source_document_id} ` +
                `at ${existing.source_locator}; collapsed on content evidence, not a stable id`,
            });
          }
          rowsDeduplicated += 1;
          anySuccess = true;
          continue;
        }
      }

      seenByHash.set(p.hash, {
        id: p.values[0] as string,
        source_document_id: documentId,
        source_locator: p.row.sourceLocator,
      });
      // F1-8. The fourth segment is the row's cash-effective date, which the
      // cash gate places it by; the third stays `process_date`, which the
      // position gate places it by. One key, both gates, neither guessing at
      // the other's window.
      changedTransactions.add(
        `${p.row.accountId}\u0000${p.row.instrumentId ?? ""}\u0000` +
          `${p.row.processDate}\u0000` +
          `${cashEffectiveDate(p.row.processDate, p.row.settleDate)}`,
      );
      toInsert.push(p.values);
      for (const candidate of p.pending) {
        openReview(p.row.accountId, documentId, p.row.sourceLocator, candidate);
      }
      rowsInserted += 1;
      anySuccess = true;
    }

    await insertRows(client, "transactions", TRANSACTION_COLUMNS, toInsert);
    return anySuccess;
  }

  function mismatchScopeAccumulator(kind: ProjectionScopeKind) {
    const scopes = new Map<string, ProjectionMismatchScope>();
    let attributionComplete = true;
    return {
      add(accountId: unknown, asOf: unknown): void {
        if (
          typeof accountId !== "string" ||
          accountId.length === 0 ||
          typeof asOf !== "string" ||
          !ISO_DATE.test(asOf)
        ) {
          attributionComplete = false;
          return;
        }
        const scope = { kind, accountId, asOf } as const;
        scopes.set(`${kind}\u0000${accountId}\u0000${asOf}`, scope);
      },
      result(safe: boolean): ProjectionSafety {
        return {
          safe,
          scopes: [...scopes.values()].sort((left, right) =>
            `${left.kind}\u0000${left.accountId}\u0000${left.asOf}`.localeCompare(
              `${right.kind}\u0000${right.accountId}\u0000${right.asOf}`,
            ),
          ),
          attributionComplete: safe || (attributionComplete && scopes.size > 0),
        };
      },
    };
  }

  function versionedHoldingDifference(
    table: HoldingProjectionTable,
    stored: StoredHoldingProjection[HoldingProjectionTable],
    candidate: CandidateHoldingProjection[HoldingProjectionTable],
  ): ProjectionSafety {
    const scope = mismatchScopeAccumulator(table);
    const accountIndex = table === "liabilities" ? 1 : 0;
    const asOfIndex = table === "liabilities" ? 7 : 1;
    const key = (semantic: readonly (string | null)[]) =>
      JSON.stringify(semantic);
    const remaining = new Map<string, number>();
    for (const row of candidate) {
      const semanticKey = key(row.semantic);
      remaining.set(semanticKey, (remaining.get(semanticKey) ?? 0) + 1);
    }
    let safe = true;
    for (const row of stored) {
      const semanticKey = key(row.semantic);
      const count = remaining.get(semanticKey) ?? 0;
      if (count === 0) {
        safe = false;
        scope.add(row.semantic[accountIndex], row.semantic[asOfIndex]);
      } else {
        remaining.set(semanticKey, count - 1);
      }
    }
    for (const row of candidate) {
      const semanticKey = key(row.semantic);
      if ((remaining.get(semanticKey) ?? 0) === 0) continue;
      safe = false;
      scope.add(row.semantic[accountIndex], row.semantic[asOfIndex]);
      remaining.set(semanticKey, remaining.get(semanticKey)! - 1);
    }
    return scope.result(safe);
  }

  async function activityProjectionIsSafe(
    prepared: readonly PreparedTransaction[],
    documentId: string,
  ): Promise<ProjectionSafety> {
    const scope = mismatchScopeAccumulator("activity");
    const numericColumns = new Set([
      "quantity",
      "price",
      "amount",
      "amount_base",
      "fx_rate",
      "running_balance",
    ]);
    const semanticColumns = TRANSACTION_COLUMNS.filter(
      (column) =>
        column !== "id" &&
        column !== "source_document_id" &&
        column !== "source_locator" &&
        column !== "imported_at",
    );
    const indexes = semanticColumns.map((column) =>
      TRANSACTION_COLUMNS.indexOf(column),
    );
    const normalize = (column: string, value: unknown) => {
      if (value === null || value === undefined) return null;
      if (numericColumns.has(column)) return toNumericText(String(value));
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      return value;
    };
    const keyFromValues = (values: readonly unknown[]) =>
      JSON.stringify(
        indexes.map((index, position) =>
          normalize(semanticColumns[position]!, values[index]),
        ),
      );
    const keyFromRow = (row: Record<string, unknown>) =>
      JSON.stringify(
        semanticColumns.map((column) => normalize(column, row[column])),
      );

    const stored = await client.query<Record<string, unknown>>(
      `SELECT ${semanticColumns.join(", ")}
         FROM transactions WHERE source_document_id = $1`,
      [documentId],
    );
    const candidates = new Map<string, number>();
    const semanticByIdentity = new Map<string, string>();
    const semanticByHash = new Map<string, string>();
    const candidatesByIdentity = new Map<string, PreparedTransaction[]>();
    const candidatesByHash = new Map<string, PreparedTransaction[]>();
    let safe = true;
    let storedRowMissing = false;
    for (const candidate of prepared) {
      const key = keyFromValues(candidate.values);
      candidates.set(key, (candidates.get(key) ?? 0) + 1);
      const priorHash = semanticByHash.get(candidate.hash);
      if (priorHash !== undefined && priorHash !== key) {
        safe = false;
        scope.add(candidate.row.accountId, candidate.row.processDate);
        for (const prior of candidatesByHash.get(candidate.hash) ?? []) {
          scope.add(prior.row.accountId, prior.row.processDate);
        }
      }
      semanticByHash.set(candidate.hash, key);
      const hashCandidates = candidatesByHash.get(candidate.hash) ?? [];
      hashCandidates.push(candidate);
      candidatesByHash.set(candidate.hash, hashCandidates);
      const identity = candidate.row.providerTxnId
        ? `provider:${providerKey(candidate.row.accountId, candidate.row.providerTxnId)}`
        : `hash:${candidate.hash}`;
      const prior = semanticByIdentity.get(identity);
      if (prior !== undefined && prior !== key) {
        safe = false;
        scope.add(candidate.row.accountId, candidate.row.processDate);
        for (const priorCandidate of candidatesByIdentity.get(identity) ?? []) {
          scope.add(
            priorCandidate.row.accountId,
            priorCandidate.row.processDate,
          );
        }
      }
      semanticByIdentity.set(identity, key);
      const identityCandidates = candidatesByIdentity.get(identity) ?? [];
      identityCandidates.push(candidate);
      candidatesByIdentity.set(identity, identityCandidates);
    }
    for (const row of stored.rows) {
      const key = keyFromRow(row);
      const remaining = candidates.get(key) ?? 0;
      if (remaining === 0) {
        safe = false;
        storedRowMissing = true;
        scope.add(row.account_id, row.process_date);
      } else {
        candidates.set(key, remaining - 1);
      }
    }
    if (storedRowMissing) {
      for (const candidate of prepared) {
        const key = keyFromValues(candidate.values);
        if ((candidates.get(key) ?? 0) > 0) {
          scope.add(candidate.row.accountId, candidate.row.processDate);
        }
      }
    }

    const byHash = await client.query<Record<string, unknown>>(
      `SELECT ${semanticColumns.join(", ")}, source_document_id FROM transactions
        WHERE row_hash = ANY($1::text[])`,
      [prepared.map(({ hash }) => hash)],
    );
    for (const row of byHash.rows) {
      if (
        row.source_document_id === documentId &&
        semanticByHash.get(String(row.row_hash)) === keyFromRow(row)
      ) {
        continue;
      }
      safe = false;
      scope.add(row.account_id, row.process_date);
      for (const candidate of candidatesByHash.get(String(row.row_hash)) ??
        []) {
        scope.add(candidate.row.accountId, candidate.row.processDate);
      }
    }

    const withProviderId = prepared.filter((item) => item.row.providerTxnId);
    if (withProviderId.length === 0) return scope.result(safe);
    const byProvider = await client.query<Record<string, unknown>>(
      `SELECT ${semanticColumns.join(", ")}, source_document_id FROM transactions
        WHERE account_id = ANY($1::text[])
          AND provider_txn_id = ANY($2::text[])`,
      [
        [...new Set(withProviderId.map((item) => item.row.accountId))],
        [...new Set(withProviderId.map((item) => item.row.providerTxnId!))],
      ],
    );
    for (const row of byProvider.rows) {
      const identity = `provider:${providerKey(
        String(row.account_id),
        String(row.provider_txn_id),
      )}`;
      const candidate = semanticByIdentity.get(identity);
      const matches =
        candidate === undefined ||
        (row.source_document_id === documentId &&
          candidate === keyFromRow(row));
      if (matches) continue;
      safe = false;
      scope.add(row.account_id, row.process_date);
      for (const preparedCandidate of candidatesByIdentity.get(identity) ??
        []) {
        scope.add(
          preparedCandidate.row.accountId,
          preparedCandidate.row.processDate,
        );
      }
    }
    return scope.result(safe);
  }

  /**
   * `positions`, `balances` and `liabilities` dedupe at the whole-document
   * level (see `ImportDocument`'s doc comment) the same immutable-raw-file
   * check transactions get, and (F1-49) also look up their own content hash
   * before inserting, the same way `importRow` looks up `rowHashV2`: a
   * document reprocessed for some other reason -- one row sent to review, a
   * parse note that never clears -- matches a holding it already stored
   * instead of inserting it again. Only `as_of` unparseable to ISO blocks the
   * insert outright -- the column is NOT NULL with no other spelling to
   * store, the same reasoning as `transactions.process_date`. Every other
   * malformed or missing field stores NULL and opens a review item instead.
   */
  function preparePosition(
    position: ImportPosition,
    accountId: string,
    documentId: string,
  ): PreparedHolding | null {
    if (!ISO_DATE.test(position.asOf)) {
      openReview(accountId, documentId, position.sourceLocator, {
        kind: "unparseable_as_of",
        rawValue: position.asOf,
        reason: "as_of is not a valid ISO YYYY-MM-DD date",
      });
      return null;
    }

    const pending: ReviewCandidate[] = [];
    const quantity = canonicalizeAmbiguous(
      position.quantity,
      "ambiguous_position_quantity",
      pending,
    );
    const price = canonicalizeAmbiguous(
      position.price,
      "ambiguous_position_price",
      pending,
    );
    const marketValue = resolveAmbiguousMoney(
      position.marketValueText,
      position.marketValueNote,
      position.currency,
      "ambiguous_market_value",
      pending,
    );
    const costBasis = canonicalizeAmbiguousMoney(
      position.costBasis,
      position.currency,
      "ambiguous_cost_basis",
      pending,
    );
    const unrealized = canonicalizeAmbiguousMoney(
      position.unrealized,
      position.currency,
      "ambiguous_unrealized",
      pending,
    );

    let valuationBasis: string | null = position.valuationBasis;
    if (valuationBasis !== null && !VALUATION_BASES.has(valuationBasis)) {
      pending.push({
        kind: "ambiguous_valuation_basis",
        rawValue: valuationBasis,
        reason: `"${valuationBasis}" is not one of market_price, last_round, cost, reported_nav`,
      });
      valuationBasis = null;
    } else if (valuationBasis === null) {
      // Ground rule 5, and the plan's own warning: a null valuation basis is
      // never silent, because a total-assets query summing across it would
      // silently mix marked securities with positions carried at cost.
      pending.push({
        kind: "ambiguous_valuation_basis",
        rawValue: "",
        reason: position.valuationNote,
      });
    }

    const hash = positionHash({
      accountId,
      instrumentId: position.instrumentId,
      asOf: position.asOf,
      quantity,
      marketValue,
      costBasis,
      valuationBasis,
      sourceLocator: position.sourceLocator,
    });

    return {
      hash,
      pending,
      accountId,
      sourceLocator: position.sourceLocator,
      changedKey:
        position.instrumentId === null
          ? null
          : `${accountId}\u0000${position.instrumentId}\u0000${position.asOf}`,
      values: [
        randomUUID(),
        accountId,
        position.asOf,
        position.instrumentId,
        quantity,
        price,
        marketValue,
        costBasis,
        unrealized,
        position.currency,
        valuationBasis,
        position.valuationNote,
        documentId,
        position.sourceLocator,
        hash,
      ],
    };
  }

  type PreparedPositionScopeMember = {
    hash: string;
    accountId: string;
    asOf: string;
    instrumentId: string | null;
    quantity: string | null;
    price: string | null;
    marketValue: string | null;
    costBasis: string | null;
    unrealized: string | null;
    currency: string;
    valuationBasis: string | null;
    valuationNote: string | null;
    sourceLocator: string;
  };

  function positionScopeMember(
    prepared: PreparedHolding,
  ): PreparedPositionScopeMember {
    return {
      hash: prepared.hash,
      accountId: String(prepared.values[1]),
      asOf: String(prepared.values[2]),
      instrumentId: (prepared.values[3] as string | null) ?? null,
      quantity: (prepared.values[4] as string | null) ?? null,
      price: (prepared.values[5] as string | null) ?? null,
      marketValue: (prepared.values[6] as string | null) ?? null,
      costBasis: (prepared.values[7] as string | null) ?? null,
      unrealized: (prepared.values[8] as string | null) ?? null,
      currency: String(prepared.values[9]),
      valuationBasis: (prepared.values[10] as string | null) ?? null,
      valuationNote: (prepared.values[11] as string | null) ?? null,
      sourceLocator: String(prepared.values[13]),
    };
  }

  /**
   * Persist immutable source coverage without claiming ownership of current
   * rows. A foreign-owned global hash can be a member, but the read predicate
   * later compares every stored semantic field and the complete account/date
   * set before using it. A replay of the same proof is a no-op; a changed
   * payload under the same proof version is refused.
   */
  async function persistPositionScopes(
    document: ImportDocument,
    documentId: string,
    generationId: string | null,
    preparedPositions: readonly PreparedHolding[],
  ): Promise<void> {
    if ((document.positionScopes?.length ?? 0) === 0) return;
    if (
      document.retainedSha256 === null ||
      document.retainedSha256 === undefined
    ) {
      openReview(document.accountId, documentId, null, {
        kind: "position_scope_unretained",
        rawValue: "position_scope_v1",
        reason:
          "position scope proof was not stored because the source document has no retained SHA-256 binding",
      });
      return;
    }

    const scopeOutcomes = new Map<
      string,
      { accountId: string; reviewValue: string; valid: boolean }
    >();
    for (const scope of document.positionScopes ?? []) {
      const key = `${scope.accountId}\u0000${scope.asOf}\u0000${scope.proofVersion}`;
      const reviewValue = `${scope.accountId}:${scope.asOf}:${scope.proofVersion}`;
      const duplicateDeclaration = scopeOutcomes.has(key);
      const gapCodes = [...new Set(scope.gapCodes)].sort();
      const members = preparedPositions
        .map(positionScopeMember)
        .filter(
          (member) =>
            member.accountId === scope.accountId && member.asOf === scope.asOf,
        );
      const distinctHashes = new Set(members.map((member) => member.hash));
      const completeEvidence =
        scope.status !== "complete" ||
        (scope.evidence.scopeEnd !== undefined &&
          (scope.emittedPositionCount === 0
            ? scope.evidence.explicitNone !== undefined
            : scope.evidence.tables.length > 0 &&
              scope.evidence.tables.every(
                (table) => table.headers.length > 0 && table.end !== undefined,
              )));
      const structural =
        ISO_DATE.test(scope.asOf) &&
        Number.isSafeInteger(scope.emittedPositionCount) &&
        scope.emittedPositionCount >= 0 &&
        scope.gapCodes.every((code) => POSITION_SCOPE_GAP_CODES.has(code)) &&
        gapCodes.length === scope.gapCodes.length &&
        ((scope.status === "complete" && gapCodes.length === 0) ||
          (scope.status === "partial" && gapCodes.length > 0)) &&
        (scope.status === "complete" && scope.emittedPositionCount === 0
          ? scope.zeroBasis === "source_stated_none"
          : scope.zeroBasis === undefined) &&
        members.length === scope.emittedPositionCount &&
        distinctHashes.size === members.length &&
        completeEvidence &&
        !duplicateDeclaration;
      scopeOutcomes.set(key, {
        accountId: scope.accountId,
        reviewValue,
        valid: structural,
      });
      if (!structural) {
        await reopenSystemResolvedPositionScopeMismatch(
          documentId,
          scope.accountId,
          reviewValue,
        );
        openReview(scope.accountId, documentId, null, {
          kind: "position_scope_mismatch",
          rawValue: reviewValue,
          reason:
            "position scope proof was not stored because its account/date emitted count, gap state, positive boundary evidence, zero basis, or distinct prepared membership did not match the mapped source positions",
        });
        continue;
      }
      const existing = await client.query<{
        id: string;
        payload_matches: boolean;
      }>(
        `SELECT id,
                retained_sha256 = $6
                AND status = $7
                AND emitted_position_count = $8
                AND gap_codes = $9::text[]
                AND zero_basis IS NOT DISTINCT FROM $10
                AND evidence = $11::jsonb AS payload_matches
           FROM position_scope_observations
          WHERE source_document_id = $1
            AND holding_projection_generation_id IS NOT DISTINCT FROM $2
            AND account_id = $3 AND as_of = $4::date AND proof_version = $5`,
        [
          documentId,
          generationId,
          scope.accountId,
          scope.asOf,
          scope.proofVersion,
          document.retainedSha256,
          scope.status,
          scope.emittedPositionCount,
          gapCodes,
          scope.zeroBasis ?? null,
          JSON.stringify(scope.evidence),
        ],
      );
      let scopeId = existing.rows[0]?.id;
      if (scopeId === undefined) {
        scopeId = randomUUID();
        await client.query(
          `INSERT INTO position_scope_observations
             (id, source_document_id, holding_projection_generation_id,
              retained_sha256, account_id, as_of, proof_version, status,
              emitted_position_count, gap_codes, zero_basis, evidence, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9,
                   $10::text[], $11, $12::jsonb, $13)`,
          [
            scopeId,
            documentId,
            generationId,
            document.retainedSha256,
            scope.accountId,
            scope.asOf,
            scope.proofVersion,
            scope.status,
            scope.emittedPositionCount,
            gapCodes,
            scope.zeroBasis ?? null,
            JSON.stringify(scope.evidence),
            startedAt,
          ],
        );
        await insertRows(
          client,
          "position_scope_memberships",
          [
            "source_document_id",
            "scope_id",
            "position_row_hash",
            "account_id",
            "as_of",
            "instrument_id",
            "quantity",
            "price",
            "market_value",
            "cost_basis",
            "unrealized",
            "currency",
            "valuation_basis",
            "valuation_note",
            "source_locator",
          ],
          members.map((member) => [
            documentId,
            scopeId,
            member.hash,
            member.accountId,
            member.asOf,
            member.instrumentId,
            member.quantity,
            member.price,
            member.marketValue,
            member.costBasis,
            member.unrealized,
            member.currency,
            member.valuationBasis,
            member.valuationNote,
            member.sourceLocator,
          ]),
        );
      } else {
        if (existing.rows[0]?.payload_matches !== true) {
          throw new Error(
            "position scope replay changed an immutable proof payload",
          );
        }
        const storedMembers = await client.query<{
          position_row_hash: string;
          account_id: string;
          as_of: string;
          instrument_id: string | null;
          quantity: string | null;
          price: string | null;
          market_value: string | null;
          cost_basis: string | null;
          unrealized: string | null;
          currency: string;
          valuation_basis: string | null;
          valuation_note: string | null;
          source_locator: string;
        }>(
          `SELECT position_row_hash, account_id, as_of::text AS as_of,
                instrument_id, quantity::text AS quantity, price::text AS price,
                market_value::text AS market_value,
                cost_basis::text AS cost_basis, unrealized::text AS unrealized,
                currency::text AS currency, valuation_basis, valuation_note,
                source_locator
           FROM position_scope_memberships WHERE scope_id = $1
          ORDER BY position_row_hash`,
          [scopeId],
        );
        const expected = [...members]
          .sort((left, right) => left.hash.localeCompare(right.hash))
          .map((member) => ({
            position_row_hash: member.hash,
            account_id: member.accountId,
            as_of: member.asOf,
            instrument_id: member.instrumentId,
            quantity: member.quantity,
            price: member.price,
            market_value: member.marketValue,
            cost_basis: member.costBasis,
            unrealized: member.unrealized,
            currency: member.currency,
            valuation_basis: member.valuationBasis,
            valuation_note: member.valuationNote,
            source_locator: member.sourceLocator,
          }));
        if (JSON.stringify(storedMembers.rows) !== JSON.stringify(expected)) {
          throw new Error(
            "position scope replay changed immutable source memberships",
          );
        }
      }

      if (scope.status === "complete") {
        const exact = await client.query<{ exact: boolean }>(
          `SELECT
             (SELECT count(*) FROM position_scope_memberships m
               WHERE m.scope_id = $1) = $4
             AND NOT EXISTS (
               SELECT 1 FROM position_scope_memberships m
                WHERE m.scope_id = $1
                  AND NOT EXISTS (
                    SELECT 1 FROM positions p
                     WHERE p.account_id = m.account_id AND p.as_of = m.as_of
                       AND p.row_hash = m.position_row_hash
                       AND p.instrument_id IS NOT DISTINCT FROM m.instrument_id
                       AND p.quantity IS NOT DISTINCT FROM m.quantity
                       AND p.price IS NOT DISTINCT FROM m.price
                       AND p.market_value IS NOT DISTINCT FROM m.market_value
                       AND p.cost_basis IS NOT DISTINCT FROM m.cost_basis
                       AND p.unrealized IS NOT DISTINCT FROM m.unrealized
                       AND p.currency = m.currency
                       AND p.valuation_basis IS NOT DISTINCT FROM m.valuation_basis
                       AND ${valuationNotesEquivalentSql("p.valuation_note", "m.valuation_note")}))
             AND NOT EXISTS (
               SELECT 1 FROM positions p
                WHERE p.account_id = $2 AND p.as_of = $3::date
                  AND NOT EXISTS (
                    SELECT 1 FROM position_scope_memberships m
                     WHERE m.scope_id = $1
                       AND m.position_row_hash = p.row_hash
                       AND m.instrument_id IS NOT DISTINCT FROM p.instrument_id
                       AND m.quantity IS NOT DISTINCT FROM p.quantity
                       AND m.price IS NOT DISTINCT FROM p.price
                       AND m.market_value IS NOT DISTINCT FROM p.market_value
                       AND m.cost_basis IS NOT DISTINCT FROM p.cost_basis
                       AND m.unrealized IS NOT DISTINCT FROM p.unrealized
                       AND m.currency = p.currency
                       AND m.valuation_basis IS NOT DISTINCT FROM p.valuation_basis
                       AND ${valuationNotesEquivalentSql("m.valuation_note", "p.valuation_note")}))
             AS exact`,
          [scopeId, scope.accountId, scope.asOf, scope.emittedPositionCount],
        );
        if (exact.rows[0]?.exact !== true) {
          const outcome = scopeOutcomes.get(key)!;
          outcome.valid = false;
          await reopenSystemResolvedPositionScopeMismatch(
            documentId,
            scope.accountId,
            reviewValue,
          );
          openReview(scope.accountId, documentId, null, {
            kind: "position_scope_mismatch",
            rawValue: reviewValue,
            reason:
              "complete position scope proof does not exactly match the canonical account/date position set; source evidence was retained but coverage remains blocked",
          });
        }
      }
    }

    // This importer owns this review kind. It closes each exact account/date
    // key only after that declaration validated and either persisted or
    // matched immutable history. An invalid declaration for another account,
    // a key omitted by a later parser, a manually resolved item, and a
    // dismissed item are all left untouched.
    for (const outcome of scopeOutcomes.values()) {
      if (!outcome.valid) continue;
      const resolved = await client.query(
        `UPDATE review_items
            SET status = 'resolved', resolved_at = $2,
                resolution_note = $3
          WHERE source_document_id = $1
            AND kind = 'position_scope_mismatch'
            AND status = 'open'
            AND account_id = $4
            AND raw_value = $5`,
        [
          documentId,
          now.toISOString(),
          `${POSITION_SCOPE_MISMATCH_RESOLUTION_PREFIX} (import_runs.id=${importRunId})`,
          outcome.accountId,
          outcome.reviewValue,
        ],
      );
      reviewItemsResolved += resolved.rowCount ?? 0;
    }
  }

  function prepareBalance(
    balance: ImportBalance,
    accountId: string,
    documentId: string,
  ): PreparedHolding | null {
    if (!ISO_DATE.test(balance.asOf)) {
      openReview(accountId, documentId, balance.sourceLocator, {
        kind: "unparseable_as_of",
        rawValue: balance.asOf,
        reason: "as_of is not a valid ISO YYYY-MM-DD date",
      });
      return null;
    }

    const pending: ReviewCandidate[] = [];
    const totalValue = resolveAmbiguousMoney(
      balance.totalValueText,
      balance.totalValueNote,
      balance.currency,
      "ambiguous_total_value",
      pending,
    );
    const cash = canonicalizeAmbiguousMoney(
      balance.cash,
      balance.currency,
      "ambiguous_cash",
      pending,
    );
    const periodStartValue = canonicalizeAmbiguousMoney(
      balance.periodStartValue,
      balance.currency,
      "ambiguous_period_start_value",
      pending,
    );
    const periodEndValue = canonicalizeAmbiguousMoney(
      balance.periodEndValue,
      balance.currency,
      "ambiguous_period_end_value",
      pending,
    );

    const hash = balanceHash({
      accountId,
      asOf: balance.asOf,
      totalValue,
      cash,
    });

    return {
      hash,
      pending,
      accountId,
      sourceLocator: balance.sourceLocator,
      changedKey: `${accountId}\u0000${balance.asOf}`,
      values: [
        randomUUID(),
        accountId,
        balance.asOf,
        totalValue,
        cash,
        balance.currency,
        periodStartValue,
        periodEndValue,
        documentId,
        balance.sourceLocator,
        hash,
      ],
    };
  }

  function prepareLiability(
    liability: ImportLiability,
    institutionId: string | null,
    accountId: string | null,
    documentId: string,
  ): PreparedHolding | null {
    if (!ISO_DATE.test(liability.asOf)) {
      openReview(accountId, documentId, liability.sourceLocator, {
        kind: "unparseable_as_of",
        rawValue: liability.asOf,
        reason: "as_of is not a valid ISO YYYY-MM-DD date",
      });
      return null;
    }

    const pending: ReviewCandidate[] = [];
    const balanceAmount = resolveAmbiguousMoney(
      liability.balanceText,
      liability.balanceNote,
      liability.currency,
      "ambiguous_liability_balance",
      pending,
    );
    const rate = canonicalizeAmbiguous(
      liability.rate,
      "ambiguous_rate",
      pending,
    );

    const hash = liabilityHash({
      accountId,
      kind: liability.kind,
      asOf: liability.asOf,
      balance: balanceAmount,
    });

    return {
      hash,
      pending,
      accountId,
      sourceLocator: liability.sourceLocator,
      changedKey: null,
      values: [
        randomUUID(),
        institutionId,
        accountId,
        liability.kind,
        liability.displayName,
        balanceAmount,
        liability.currency,
        rate,
        liability.asOf,
        liability.collateralNote,
        documentId,
        liability.sourceLocator,
        hash,
      ],
    };
  }

  type HoldingTable = "positions" | "balances" | "liabilities";

  const holdingNumericColumns = new Set([
    "quantity",
    "price",
    "market_value",
    "cost_basis",
    "unrealized",
    "total_value",
    "cash",
    "period_start_value",
    "period_end_value",
    "balance",
    "rate",
  ]);

  /**
   * An authoritative reparse may add newly grounded rows only when every row
   * this document already owns is restated exactly. The comparison covers all
   * stored semantic columns, including fields omitted from row_hash. IDs and
   * locators are provenance mechanics: IDs are generated, and an otherwise
   * identical same-source replay is allowed to improve its locator.
   *
   * A global hash owned by another document is not proof that this document's
   * projection was persisted. Without a membership table, accepting it would
   * make a later omission invisible, so authoritative reparse fails closed.
   */
  async function holdingProjectionIsSafe(
    table: HoldingTable,
    columns: readonly string[],
    prepared: readonly PreparedHolding[],
    documentId: string,
  ): Promise<ProjectionSafety> {
    const scope = mismatchScopeAccumulator(table);
    const asOfIndex = columns.indexOf("as_of");
    const semanticColumns = columns.filter(
      (column) =>
        column !== "id" &&
        column !== "source_document_id" &&
        column !== "source_locator",
    );
    const indexes = semanticColumns.map((column) => columns.indexOf(column));
    const semanticValue = (column: string, value: unknown) => {
      if (value === null || value === undefined) return null;
      return holdingNumericColumns.has(column)
        ? toNumericText(String(value))
        : value;
    };
    const keyFromValues = (values: readonly unknown[]) =>
      JSON.stringify(
        indexes.map((index, position) =>
          semanticValue(semanticColumns[position]!, values[index]),
        ),
      );
    const keyFromRow = (row: Record<string, unknown>) =>
      JSON.stringify(
        semanticColumns.map((column) => semanticValue(column, row[column])),
      );

    const stored = await client.query<Record<string, unknown>>(
      `SELECT ${semanticColumns.join(", ")} FROM ${table} WHERE source_document_id = $1`,
      [documentId],
    );
    const candidates = new Map<string, number>();
    const semanticByHash = new Map<string, string>();
    const candidatesByHash = new Map<string, PreparedHolding[]>();
    let safe = true;
    let storedRowMissing = false;
    for (const candidate of prepared) {
      const key = keyFromValues(candidate.values);
      candidates.set(key, (candidates.get(key) ?? 0) + 1);
      const prior = semanticByHash.get(candidate.hash);
      if (prior !== undefined && prior !== key) {
        safe = false;
        scope.add(candidate.accountId, candidate.values[asOfIndex]);
        for (const priorCandidate of candidatesByHash.get(candidate.hash) ??
          []) {
          scope.add(priorCandidate.accountId, priorCandidate.values[asOfIndex]);
        }
      }
      semanticByHash.set(candidate.hash, key);
      const hashCandidates = candidatesByHash.get(candidate.hash) ?? [];
      hashCandidates.push(candidate);
      candidatesByHash.set(candidate.hash, hashCandidates);
    }
    for (const row of stored.rows) {
      const key = keyFromRow(row);
      const remaining = candidates.get(key) ?? 0;
      if (remaining === 0) {
        safe = false;
        storedRowMissing = true;
        scope.add(row.account_id, row.as_of);
      } else {
        candidates.set(key, remaining - 1);
      }
    }
    if (storedRowMissing) {
      for (const candidate of prepared) {
        const key = keyFromValues(candidate.values);
        if ((candidates.get(key) ?? 0) > 0) {
          scope.add(candidate.accountId, candidate.values[asOfIndex]);
        }
      }
    }

    if (prepared.length === 0) return scope.result(safe);
    const global = await client.query<Record<string, unknown>>(
      `SELECT ${semanticColumns.join(", ")}, source_document_id
         FROM ${table} WHERE row_hash = ANY($1::text[])`,
      [prepared.map(({ hash }) => hash)],
    );
    for (const row of global.rows) {
      if (
        row.source_document_id === documentId &&
        semanticByHash.get(String(row.row_hash)) === keyFromRow(row)
      ) {
        continue;
      }
      safe = false;
      scope.add(row.account_id, row.as_of);
      for (const candidate of candidatesByHash.get(String(row.row_hash)) ??
        []) {
        scope.add(candidate.accountId, candidate.values[asOfIndex]);
      }
    }
    return scope.result(safe);
  }

  /**
   * One document's positions, balances or liabilities: one `row_hash` lookup
   * for the whole table and one multi-row INSERT, in place of two round trips
   * per holding (F1-51). `seen` starts as what the database already has and
   * grows as rows are accepted, so two identical holdings inside one document
   * still collapse exactly as they did when each insert was its own
   * statement.
   */
  async function importHoldings(
    table: string,
    columns: readonly string[],
    prepared: readonly PreparedHolding[],
    documentId: string,
    changed: Set<string> | null,
  ): Promise<boolean> {
    if (prepared.length === 0) return false;
    const found = await client.query<{
      row_hash: string;
      source_locator: string | null;
      source_document_id: string | null;
    }>(
      `SELECT row_hash, source_locator, source_document_id
         FROM ${table} WHERE row_hash = ANY($1::text[])`,
      [prepared.map((p) => p.hash)],
    );
    const seen = new Map(found.rows.map((r) => [r.row_hash, r]));

    // F1-8a. `row_hash` includes `cash` (balanceHash), so two documents
    // stating different cash at the same (account_id, as_of) never collide
    // here -- both insert as separate rows, and the reconciliation gate
    // later marks that period unverified rather than picking one (ground
    // rule 5, reconciliation.ts's `reconcilePeriod`). That leaves the
    // conflict discoverable only by re-deriving it from every `balances`
    // row, which is exactly the report the gate already refuses to compute
    // per-period. A review item names the other document at import time
    // instead, without changing which cash the gate reconciles against.
    const storedBalances =
      table === "balances"
        ? (
            await client.query<{
              account_id: string;
              as_of: string;
              cash: string | null;
              source_document_id: string | null;
            }>(
              `SELECT b.account_id, b.as_of::text AS as_of, b.cash, b.source_document_id
             FROM balances b
             JOIN (SELECT unnest($1::text[]) AS account_id,
                          unnest($2::date[]) AS as_of) pairs
               ON pairs.account_id = b.account_id AND pairs.as_of = b.as_of`,
              [
                prepared.map((p) => p.accountId),
                prepared.map((p) => p.values[2] as string),
              ],
            )
          ).rows
        : null;
    const cashConflicts =
      storedBalances === null
        ? null
        : new Map(
            storedBalances.map((r) => [
              JSON.stringify([r.account_id, r.as_of]),
              r,
            ]),
          );

    // F1-8l. Keep every matching stored row when checking whether this
    // document already supplied a balance. The cross-document conflict map
    // retains only one row per account/date and cannot answer that question.
    // This set also grows as this batch accepts rows, so a second statement
    // of the same account/date is refused even when its amounts hash differently.
    const balanceKeys =
      storedBalances === null
        ? null
        : new Set(
            storedBalances
              .filter((r) => r.source_document_id === documentId)
              .map((r) => JSON.stringify([r.account_id, r.as_of])),
          );

    const toInsert: unknown[][] = [];
    let anySuccess = false;
    for (const p of prepared) {
      if (cashConflicts !== null) {
        const asOf = p.values[2] as string;
        const cash = p.values[4] as string | null;
        const existing = cashConflicts.get(JSON.stringify([p.accountId, asOf]));
        if (
          existing !== undefined &&
          existing.source_document_id !== documentId &&
          existing.cash !== null &&
          cash !== null &&
          existing.cash !== cash
        ) {
          openReview(p.accountId, documentId, p.sourceLocator, {
            kind: "balance_cash_conflict",
            rawValue: cash,
            reason:
              `this document states cash ${cash} for ${p.accountId} as of ${asOf}, ` +
              `which disagrees with ${existing.cash} already on file from document ` +
              `${existing.source_document_id}; both are kept, neither is picked ` +
              "(ground rule 5) -- see reconciliation.ts's cash_contradicts",
          });
        }
      }
      const existingByHash = seen.get(p.hash);
      if (existingByHash !== undefined) {
        rowsDeduplicated += 1;
        anySuccess = true;
        // F1-53. `row_hash` does not cover `source_locator` (positionHash's
        // own doc comment): a reparse that adds an evidence binding to an
        // otherwise-identical holding matches this stored row instead of
        // inserting a second one, which is correct, but must not leave the
        // old, uncited locator sitting there forever. Refresh it in place
        // rather than re-insert (row_hash is UNIQUE, so a second row with
        // the same hash cannot exist anyway). A second reparse computes the
        // same locator and this becomes a no-op update.
        if (
          existingByHash.source_document_id === documentId &&
          existingByHash.source_locator !== p.sourceLocator
        ) {
          await client.query(
            `UPDATE ${table} SET source_locator = $2 WHERE row_hash = $1`,
            [p.hash, p.sourceLocator],
          );
        }
        continue;
      }
      if (balanceKeys !== null) {
        const key = JSON.stringify([p.accountId, p.values[2] as string]);
        if (balanceKeys.has(key)) {
          openReview(p.accountId, documentId, p.sourceLocator, {
            kind: "balance_duplicate_in_document",
            rawValue: String(p.values[3] ?? ""),
            reason:
              `this document already states a balance for ${p.accountId} as of ` +
              `${p.values[2] as string}, so this second one is the document ` +
              "contradicting itself rather than a second stated fact; it is not " +
              "inserted, and neither stated balance is altered (ground rule 5)",
          });
          rowsRefused += 1;
          continue;
        }
        balanceKeys.add(key);
      }
      seen.set(p.hash, {
        row_hash: p.hash,
        source_locator: p.sourceLocator,
        source_document_id: documentId,
      });
      if (changed !== null && p.changedKey !== null) changed.add(p.changedKey);
      toInsert.push(p.values);
      for (const candidate of p.pending) {
        openReview(p.accountId, documentId, p.sourceLocator, candidate);
      }
      rowsInserted += 1;
      anySuccess = true;
    }
    await insertRows(client, table, columns, toInsert);
    return anySuccess;
  }

  /**
   * One document's positions, balances and liabilities: `preparePosition`/
   * `prepareBalance`/`prepareLiability` plus their own `importHoldings` call,
   * shared between an ordinary import and the already-`parsed_ok` reparse
   * path below (F1-53) -- holdings carry their own `row_hash` dedupe (unlike
   * `document.rows`, gated on the document as a whole), so re-examining them
   * on every reparse, even of a document that changed nothing, costs one
   * dedupe query per table and is what lets a locator refresh (above) reach
   * an already-successful document at all.
   */
  async function processHoldings(
    document: ImportDocument,
    documentId: string,
    generationId: string | null = null,
  ): Promise<{ anySuccess: boolean; projectionSafe: boolean }> {
    let anySuccess = false;

    const preparedPositions: PreparedHolding[] = [];
    for (const position of document.positions ?? []) {
      const accountId = position.accountId ?? document.accountId;
      if (accountId === null) {
        throw new Error(
          `document ${document.sha256} carries a position with no account_id; ` +
            "positions.account_id and balances.account_id are NOT NULL",
        );
      }
      const ready = preparePosition(position, accountId, documentId);
      if (ready === null) rowsRefused += 1;
      else preparedPositions.push(ready);
    }
    const preparedBalances: PreparedHolding[] = [];
    for (const balance of document.balances ?? []) {
      const accountId = balance.accountId ?? document.accountId;
      if (accountId === null) {
        throw new Error(
          `document ${document.sha256} carries a balance with no account_id; ` +
            "positions.account_id and balances.account_id are NOT NULL",
        );
      }
      const ready = prepareBalance(balance, accountId, documentId);
      if (ready === null) rowsRefused += 1;
      else preparedBalances.push(ready);
    }

    const preparedLiabilities: PreparedHolding[] = [];
    for (const liability of document.liabilities ?? []) {
      const ready = prepareLiability(
        liability,
        document.institutionId,
        liability.accountId ?? document.accountId,
        documentId,
      );
      if (ready === null) rowsRefused += 1;
      else preparedLiabilities.push(ready);
    }

    if (options.authoritativeReparse) {
      const checks = [
        await holdingProjectionIsSafe(
          "positions",
          POSITION_COLUMNS,
          preparedPositions,
          documentId,
        ),
        await holdingProjectionIsSafe(
          "balances",
          BALANCE_COLUMNS,
          preparedBalances,
          documentId,
        ),
        await holdingProjectionIsSafe(
          "liabilities",
          LIABILITY_COLUMNS,
          preparedLiabilities,
          documentId,
        ),
      ];
      const unsafeTables = (
        ["positions", "balances", "liabilities"] as const
      ).filter((_, index) => !checks[index]!.safe);
      if (unsafeTables.length > 0) {
        const rawValue = unsafeTables.join(",");
        const reason =
          `${HOLDING_MISMATCH_REASON_PREFIX}${rawValue}` +
          HOLDING_MISMATCH_REASON_SUFFIX;
        const unsafeChecks = checks.filter((check) => !check.safe);
        if (unsafeChecks.every((check) => check.attributionComplete)) {
          await supersedeSystemGenericProjectionReviews(
            documentId,
            "reparse_projection_mismatch",
          );
          for (const [index, table] of (
            ["positions", "balances", "liabilities"] as const
          ).entries()) {
            await syncScopedProjectionReviews(
              documentId,
              "reparse_projection_mismatch",
              table,
              rawValue,
              reason,
              checks[index]!.safe ? [] : checks[index]!.scopes,
            );
          }
        } else {
          for (const table of [
            "positions",
            "balances",
            "liabilities",
          ] as const) {
            await syncScopedProjectionReviews(
              documentId,
              "reparse_projection_mismatch",
              table,
              rawValue,
              reason,
              [],
            );
          }
          await reopenSystemResolvedReview(
            documentId,
            "reparse_projection_mismatch",
            rawValue,
            reason,
          );
          openReview(null, documentId, null, {
            kind: "reparse_projection_mismatch",
            rawValue,
            reason,
          });
        }
        await persistPositionScopes(
          document,
          documentId,
          generationId,
          preparedPositions,
        );
        return { anySuccess: false, projectionSafe: false };
      }
    }

    if (
      await importHoldings(
        "positions",
        POSITION_COLUMNS,
        preparedPositions,
        documentId,
        changedPositions,
      )
    ) {
      anySuccess = true;
    }

    if (
      await importHoldings(
        "balances",
        BALANCE_COLUMNS,
        preparedBalances,
        documentId,
        changedBalances,
      )
    ) {
      anySuccess = true;
    }

    if (
      await importHoldings(
        "liabilities",
        LIABILITY_COLUMNS,
        preparedLiabilities,
        documentId,
        null,
      )
    ) {
      anySuccess = true;
    }

    await persistPositionScopes(
      document,
      documentId,
      generationId,
      preparedPositions,
    );

    return { anySuccess, projectionSafe: true };
  }

  return withArchiveTransaction(client, async () => {
    await lockArchiveForWrite(client);

    // F1-8b. One batched lookup for every account this batch's rows name,
    // ahead of the document loop so every row sees it regardless of which
    // document it lands on.
    const batchAccountIds = new Set<string>();
    for (const document of batch.documents) {
      for (const row of document.rows) batchAccountIds.add(row.accountId);
    }
    if (batchAccountIds.size > 0) {
      const found = await client.query<{
        id: string;
        base_currency: string | null;
      }>("SELECT id, base_currency FROM accounts WHERE id = ANY($1::text[])", [
        [...batchAccountIds],
      ]);
      for (const row of found.rows) {
        baseCurrencyByAccount.set(row.id, row.base_currency);
      }
    }

    for (const document of batch.documents) {
      filesSeen += 1;

      if (
        document.providerReportedCount !== null &&
        document.providerReportedCount !== document.rows.length
      ) {
        throw new Error(
          `document ${document.sha256} reported ${document.providerReportedCount} rows ` +
            `but the pull produced ${document.rows.length}; refusing to import a ` +
            "partial or overcounted pull (ground rule 7)",
        );
      }

      const found = await client.query<{
        id: string;
        parsed_ok: boolean;
        active_holding_projection_generation_id: string | null;
      }>(
        `SELECT id, parsed_ok, active_holding_projection_generation_id
           FROM documents WHERE sha256 = $1`,
        [document.sha256],
      );
      const existing = found.rows[0];
      const versionedGenerationId =
        existing?.active_holding_projection_generation_id ?? null;
      if (versionedGenerationId !== null && !options.authoritativeReparse) {
        throw new Error(
          "document has versioned holdings; use an authoritative exact replay",
        );
      }
      if (
        existing !== undefined &&
        existing.parsed_ok === true &&
        !options.authoritativeReparse
      ) {
        // Ground rule 1: raw files are immutable. Byte-identical bytes that
        // already imported successfully contribute nothing new to
        // `transactions`: `document.rows`' own occurrence-ordinal dedupe
        // (importRow) and this document's `document_unparsed` bookkeeping
        // both assume a document is visited at most once, so neither runs
        // again here. F1-49: `parsed_ok` true means something in this
        // document landed last time, not that every one of them did.
        //
        // F1-53: holdings are not skipped the same way. `positions`,
        // `balances` and `liabilities` dedupe by their own `row_hash`
        // (matches its own already-stored rows regardless of how many times
        // a document is visited), and that hash does not cover
        // `source_locator` -- so a reparse that adds an evidence binding to
        // an otherwise-unchanged holding needs to reach `importHoldings`'s
        // locator refresh even on a document already `parsed_ok`. Without
        // this, a binding added to the parser could never reach a holding
        // this archive already has.
        rowsDeduplicated += document.rows.length;
        await processHoldings(document, existing.id);
        // Scope validation can open a bounded mismatch/unretained review on
        // this already-parsed path. Flush it against this document before
        // moving to the next one; pending reviews must never bleed across
        // document attribution.
        await flushReviews(existing.id);
        // F1-76 phase 3. Instrument-match decisions are re-derived on every
        // reparse (resolution happens in adapterImport.ts, before this skip),
        // and this is the path a whole-archive reparse of already-imported
        // statements takes, so it is the only place those decisions can land.
        // Only these two kinds: every other kind stays skipped exactly as it
        // was, which is what F1-56 made this branch for.
        for (const item of document.reviewItems ?? [])
          routeInstrumentMatch(item);
        await flushWeakInstrumentMatches(existing.id);
        await flushInstitutionSymbolMatches(existing.id);
        await invalidateStaleInstitutionSymbolMatches(
          documentInstrumentIds(document),
        );
        continue;
      }

      // F1-71. Different bytes, but a provider document id this institution
      // already has on file: the provider re-rendered a document the archive
      // already holds (Morgan Stanley does this on every download, which is
      // how 1,321 statements became 6,461 `documents` rows). The new bytes
      // and their capture manifest are already in the raw tree -- ground rule
      // 1 retains every capture, and the raw tree is where captures live --
      // so what is left to decide here is only what the *database* does, and
      // the answer is nothing: no second document row for one document, and
      // no re-import of rows that are already imported under the row the
      // archive has. A pull whose bytes are unchanged never reaches this
      // check; it matches on `sha256` above and stays the no-op it was.
      if (existing === undefined && document.providerDocumentId) {
        const prior = await client.query<{ id: string }>(
          `SELECT id FROM documents
            WHERE institution_id = $1 AND provider_document_id = $2
              AND superseded_by IS NULL`,
          [document.institutionId, document.providerDocumentId],
        );
        if (prior.rows[0] !== undefined) {
          rowsDeduplicated += document.rows.length;
          continue;
        }
      }

      const documentId = existing?.id ?? randomUUID();
      if (!existing) {
        await client.query(
          `INSERT INTO documents
             (id, institution_id, account_id, doc_type, doc_date, file_path, sha256, parsed_ok,
              retained_sha256, retained_byte_length, media_type, capture_id, text_path,
              provider_document_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9, $10, $11, $12, $13)`,
          [
            documentId,
            document.institutionId,
            document.accountId,
            document.docType,
            document.docDate,
            document.filePath,
            document.sha256,
            document.retainedSha256 ?? null,
            document.retainedByteLength ?? null,
            document.mediaType ?? null,
            document.captureId ?? null,
            document.textPath ?? null,
            document.providerDocumentId ?? null,
          ],
        );
      } else if (
        document.textPath !== null &&
        document.textPath !== undefined
      ) {
        // F1-44: a document retained before there was an extractor has no
        // retained text. Its bytes are immutable and its sha256 therefore
        // unchanged, so the reimport that finally parses it reuses this row --
        // and without this, the text artifact it just wrote would have nothing
        // pointing at it. COALESCE, not assignment: an existing path is a
        // content-addressed artifact that is already correct, and is never
        // repointed.
        await client.query(
          "UPDATE documents SET text_path = COALESCE(text_path, $2) WHERE id = $1",
          [documentId, document.textPath],
        );
      }

      // F1-56. The seam's own items for this document, now that there is a
      // document id to point them at. Pushed straight onto the buffer rather
      // than through `openReview`, whose `ReviewCandidate.rawValue` is
      // non-null: `document_unparsed` and an unresolved-instrument match can
      // both legitimately have none.
      //
      // F1-58: `weak_instrument_match` goes to its own buffer instead, since
      // its identity and write path (`flushWeakInstrumentMatches`) are both
      // different from every other kind here.
      for (const item of document.reviewItems ?? []) {
        if (routeInstrumentMatch(item)) continue;
        reviews.push([
          randomUUID(),
          item.kind,
          item.accountId,
          documentId,
          null,
          item.rawValue,
          item.reason,
        ]);
      }

      // Fresh per document: the occurrence ordinal is scoped to one document
      // in its own row order (see importRow). F1-49: `anySuccess` tracks
      // whether anything in this document -- a row, position, balance or
      // liability -- actually landed (inserted or deduplicated), which is
      // what decides `parsed_ok` below now: a document is "parsed" as soon
      // as something in it landed, even if something else was sent to
      // review, and stays unparsed only when it carries a parse note or when
      // literally nothing in it could be inserted or matched.
      const occurrences = new Map<string, number>();
      let anySuccess = false;
      if (document.parseNote) {
        // Retained but unparsed: keep it re-importable (parsed_ok stays
        // FALSE below regardless of anySuccess) and say so in the queue --
        // but only once. The same still-unparsed bytes produce the identical
        // parseNote on every rerun until a real extractor replaces this one,
        // so without this check a rerun reopens a duplicate document_unparsed
        // row forever instead of being recognized as already flagged.
        const reason = document.parseNote.slice(0, 500);
        const alreadyFlagged = await client.query<{
          id: string;
          reason: string;
        }>(
          `SELECT id, reason FROM review_items
           WHERE kind = 'document_unparsed' AND source_document_id = $1
           ORDER BY status = 'open' DESC
           LIMIT 1`,
          [documentId],
        );
        const flagged = alreadyFlagged.rows[0];
        if (flagged === undefined) {
          reviews.push([
            randomUUID(),
            "document_unparsed",
            document.accountId,
            documentId,
            null,
            reason,
            reason,
          ]);
        } else if (flagged.reason !== reason) {
          // F1-60. A better extractor reading the same immutable bytes reads
          // them differently: it gets further and says so, or it names the
          // real obstacle where the old one guessed. That is a new reading of
          // this document, not a new document and not a second finding, so
          // the one item this document already has is updated in place --
          // never a second row beside a stale one saying something the
          // parser no longer says. Only an `open` item is touched: a reviewer
          // who dismissed or resolved one is not overruled by a rerun, which
          // is why the row above is picked open-first and why this write
          // narrows to `open` again.
          const updated = await client.query(
            `UPDATE review_items SET reason = $2, raw_value = $2
             WHERE id = $1 AND status = 'open'`,
            [flagged.id, reason],
          );
          reviewItemsUpdated += updated.rowCount ?? 0;
        }
      }

      let activityProjectionSafe = true;
      let preparedActivity: PreparedTransaction[] | undefined;
      if (options.authoritativeReparse) {
        preparedActivity = [];
        for (const row of document.rows) {
          const ready = prepareRow(row, documentId, occurrences);
          if (ready === null) rowsRefused += 1;
          else preparedActivity.push(ready);
        }
        const activityAssessment = await activityProjectionIsSafe(
          preparedActivity,
          documentId,
        );
        activityProjectionSafe = activityAssessment.safe;
        if (!activityProjectionSafe) {
          if (activityAssessment.attributionComplete) {
            await supersedeSystemGenericProjectionReviews(
              documentId,
              "reparse_activity_projection_mismatch",
            );
            await syncScopedProjectionReviews(
              documentId,
              "reparse_activity_projection_mismatch",
              "activity",
              "activity",
              ACTIVITY_MISMATCH_REASON,
              activityAssessment.scopes,
            );
          } else {
            await syncScopedProjectionReviews(
              documentId,
              "reparse_activity_projection_mismatch",
              "activity",
              "activity",
              ACTIVITY_MISMATCH_REASON,
              [],
            );
            await reopenSystemResolvedReview(
              documentId,
              "reparse_activity_projection_mismatch",
              "activity",
              ACTIVITY_MISMATCH_REASON,
            );
            openReview(null, documentId, null, {
              kind: "reparse_activity_projection_mismatch",
              rawValue: "activity",
              reason: ACTIVITY_MISMATCH_REASON,
            });
          }
        }
      }
      if (
        activityProjectionSafe &&
        (await importRows(
          document.rows,
          documentId,
          occurrences,
          preparedActivity,
        ))
      ) {
        anySuccess = true;
      }

      // F1-46: each holding's own accountId (a consolidated statement's
      // per-section attribution) wins over the document's, which stays the
      // fallback for the ordinary one-document-one-account case -- see
      // ImportPosition.accountId's doc comment. See `processHoldings` above,
      // shared with the already-`parsed_ok` reparse path.
      let projectionSafe = true;
      if (versionedGenerationId !== null) {
        const stored = await readStoredHoldingProjection(client, documentId);
        const prepared = prepareHoldingCorrectionCandidate({
          documentId,
          retainedSha256: document.retainedSha256 ?? "",
          stored,
          candidate: document,
        });
        const active = await client.query<{
          retained_sha256: string;
          projection_digest: string;
          candidate_projection_digest: string | null;
        }>(
          `SELECT retained_sha256, projection_digest, candidate_projection_digest
             FROM holding_projection_generations
            WHERE document_id = $1 AND id = $2`,
          [documentId, versionedGenerationId],
        );
        const activeGeneration = active.rows[0];
        const attributionBaseIsExact =
          prepared.manifest.completeness.state === "unproven" &&
          activeGeneration?.retained_sha256 === document.retainedSha256 &&
          activeGeneration?.projection_digest ===
            prepared.manifest.oldProjectionDigest;
        projectionSafe =
          attributionBaseIsExact &&
          activeGeneration?.candidate_projection_digest ===
            prepared.manifest.candidateProjectionDigest;
        if (projectionSafe) {
          await assertCandidateHashesOwnedByDocument(
            client,
            documentId,
            document,
          );
          anySuccess =
            anySuccess ||
            prepared.projection.positions.length > 0 ||
            prepared.projection.balances.length > 0 ||
            prepared.projection.liabilities.length > 0;
        } else {
          const versionedChecks = (
            ["positions", "balances", "liabilities"] as const
          ).map((table) =>
            versionedHoldingDifference(
              table,
              stored[table],
              prepared.projection[table],
            ),
          );
          const unsafeVersionedChecks = versionedChecks.filter(
            (check) => !check.safe,
          );
          if (
            attributionBaseIsExact &&
            unsafeVersionedChecks.length > 0 &&
            unsafeVersionedChecks.every((check) => check.attributionComplete)
          ) {
            await supersedeSystemGenericProjectionReviews(
              documentId,
              "reparse_projection_mismatch",
            );
            for (const [index, table] of (
              ["positions", "balances", "liabilities"] as const
            ).entries()) {
              await syncScopedProjectionReviews(
                documentId,
                "reparse_projection_mismatch",
                table,
                "holdings",
                VERSIONED_HOLDING_MISMATCH_REASON,
                versionedChecks[index]!.safe
                  ? []
                  : versionedChecks[index]!.scopes,
              );
            }
          } else {
            for (const table of [
              "positions",
              "balances",
              "liabilities",
            ] as const) {
              await syncScopedProjectionReviews(
                documentId,
                "reparse_projection_mismatch",
                table,
                "holdings",
                VERSIONED_HOLDING_MISMATCH_REASON,
                [],
              );
            }
            await reopenSystemResolvedReview(
              documentId,
              "reparse_projection_mismatch",
              "holdings",
              VERSIONED_HOLDING_MISMATCH_REASON,
            );
            openReview(null, documentId, null, {
              kind: "reparse_projection_mismatch",
              rawValue: "holdings",
              reason: VERSIONED_HOLDING_MISMATCH_REASON,
            });
          }
        }
        const scopePositions: PreparedHolding[] = [];
        for (const position of document.positions ?? []) {
          const accountId = position.accountId ?? document.accountId;
          if (accountId === null) continue;
          const ready = preparePosition(position, accountId, documentId);
          if (ready !== null) scopePositions.push(ready);
        }
        await persistPositionScopes(
          document,
          documentId,
          versionedGenerationId,
          scopePositions,
        );
      } else {
        const holdings = await processHoldings(document, documentId);
        if (holdings.anySuccess) anySuccess = true;
        projectionSafe = holdings.projectionSafe;
      }

      if (options.authoritativeReparse && projectionSafe) {
        await resolveSystemProjectionReviews(
          documentId,
          "reparse_projection_mismatch",
          `resolved on reimport: the authoritative holdings projection now safely restates every stored row (import_runs.id=${importRunId})`,
        );
      }

      if (options.authoritativeReparse && activityProjectionSafe) {
        await resolveSystemProjectionReviews(
          documentId,
          "reparse_activity_projection_mismatch",
          `resolved on reimport: the authoritative activity projection now safely restates every stored row (import_runs.id=${importRunId})`,
        );
      }

      if (!document.parseNote && activityProjectionSafe && projectionSafe) {
        const resolved = await client.query(
          `UPDATE review_items
             SET status = 'resolved', resolved_at = $2, resolution_note = $3
           WHERE kind = 'document_unparsed' AND source_document_id = $1 AND status = 'open'`,
          [
            documentId,
            now.toISOString(),
            `resolved on reimport: this document now parses without a parse note (import_runs.id=${importRunId})`,
          ],
        );
        reviewItemsResolved += resolved.rowCount ?? 0;
      }

      await flushReviews(documentId);
      await flushWeakInstrumentMatches(documentId);
      await flushInstitutionSymbolMatches(documentId);
      await invalidateStaleInstitutionSymbolMatches(
        documentInstrumentIds(document),
      );

      // F1-49. `parsed_ok` used to be `!documentRefused`: any single
      // refusal anywhere in the document (even alongside 1000 clean rows)
      // kept it FALSE forever, which was the only thing making a rerun safe
      // when holdings had no dedupe of their own. Now that positions,
      // balances and liabilities carry their own `row_hash` (this
      // migration), that safety net is unconditional -- a reprocessed
      // document matches whatever it already stored instead of duplicating
      // it -- so `parsed_ok` can go back to answering its own question:
      // did this document contribute anything. FALSE only when it carries a
      // parse note (retained but never parsed at all) or when nothing in it
      // -- no row, position, balance or liability -- was ever inserted or
      // matched; a document that landed some things and sent others to
      // review is TRUE, and the whole-document skip above is safe to take
      // next time (see that branch's comment).
      const versionedOpenGaps =
        versionedGenerationId === null
          ? false
          : (
              await client.query<{ present: boolean }>(
                `SELECT EXISTS (
                   SELECT 1 FROM review_items
                    WHERE source_document_id = $1 AND status = 'open'
                 ) AS present`,
                [documentId],
              )
            ).rows[0]?.present === true;
      const parsedOk =
        !document.parseNote &&
        anySuccess &&
        activityProjectionSafe &&
        projectionSafe &&
        !versionedOpenGaps;
      await client.query("UPDATE documents SET parsed_ok = $2 WHERE id = $1", [
        documentId,
        parsedOk,
      ]);
    }

    await assertInvariants(client);

    const rowsSkipped = rowsDeduplicated + rowsRefused;
    await client.query(
      `INSERT INTO import_runs
         (id, started_at, finished_at, source, files_seen, rows_inserted,
          rows_skipped, reconciliations_passed, reconciliations_failed, review_items)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8)`,
      [
        importRunId,
        startedAt,
        new Date().toISOString(),
        batch.source,
        filesSeen,
        rowsInserted,
        rowsSkipped,
        reviewItemsOpened,
      ],
    );

    return {
      importRunId,
      filesSeen,
      rowsInserted,
      rowsSkipped,
      rowsDeduplicated,
      rowsRefused,
      reviewItemsOpened,
      reviewItemsResolved,
      reviewItemsUpdated,
      instrumentMatches,
      reconciliationsPassed: 0,
      reconciliationsFailed: 0,
      changed: {
        cash: {
          snapshots: [...changedBalances].map(toCashChange),
          activity: [...changedTransactions].map((key) => {
            const [accountId = "", , , date = ""] = key.split("\u0000");
            return { accountId, date };
          }),
        },
        positions: {
          snapshots: [...changedPositions].map(toPositionChange),
          // A transaction with no instrument moves no position series.
          activity: [...changedTransactions]
            .filter((key) => key.split("\u0000")[1] !== "")
            .map(toPositionChange),
        },
      },
    };
  });
}

function toCashChange(key: string): { accountId: string; date: string } {
  const [accountId = "", date = ""] = key.split("\u0000");
  return { accountId, date };
}

function toPositionChange(key: string): {
  accountId: string;
  instrumentId: string;
  date: string;
} {
  const [accountId = "", instrumentId = "", date = ""] = key.split("\u0000");
  return { accountId, instrumentId, date };
}

/**
 * trade_date and settle_date are nullable columns, so a value the source
 * could not give a valid ISO date for is stored as NULL with a review item
 * rather than reaching the column as a hard, batch-aborting error.
 */
function resolveOptionalDate(
  text: string | null,
  kind: string,
  pending: ReviewCandidate[],
): string | null {
  if (text === null) return null;
  if (ISO_DATE.test(text)) return text;
  pending.push({
    kind: `unparseable_${kind}`,
    rawValue: text,
    reason: `${kind} is not a valid ISO YYYY-MM-DD date`,
  });
  return null;
}

/**
 * A quantity, price or rate: not money, so it carries no currency and gets no
 * minor-unit check, but it is still a NUMERIC column and still bounded by the
 * typed boundary's 38 significant digits and 18 fractional places.
 * `toNumericText` rejects past that explicitly rather than rounding into
 * place, and the rejection becomes a review item with a NULL stored value.
 */
function canonicalizeAmbiguous(
  text: string | null,
  kind: string,
  pending: ReviewCandidate[],
): string | null {
  if (text === null) return null;
  try {
    return toNumericText(text);
  } catch (error) {
    pending.push({
      kind,
      rawValue: text,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * F1-8b. `transactions.amount_base`/`fx_rate`/`amount_base_rounding`: the
 * cash gate (reconciliation.ts) refuses to sum a foreign-currency row
 * without a base-currency equivalent, so this is what populates one at
 * import when the source gives us anything to compute it from.
 *
 * Precedence, per the plan's "a stated amount never rounds; a derived one
 * uses half_even and records it":
 *
 *   1. `amountBaseText` -- the source's own stated base-currency amount --
 *      is used verbatim. It goes through the same currency-precision
 *      ambiguity check `amount` itself does (ground rule 5): more digits
 *      than `baseCurrency` allows is ambiguous money, not a value to round
 *      away. `amount_base_rounding` records `none`.
 *   2. Otherwise, a stated `fxRateText` multiplied against the already
 *      -resolved `amount` (exact product, `multiplyDecimal`) and rounded
 *      `half_even` to `baseCurrency`'s minor unit (`money.ts`'s
 *      `roundToMinorUnits`/`fromMinorUnits`, the same helpers the SQLite
 *      engine used for exactly this derivation, wired up here for the first
 *      time). `amount_base_rounding` records `half_even`.
 *   3. Neither resolves, or `baseCurrency` is not yet known for this account
 *      (nullable since F1-32) -- `amount_base` stays null, honestly
 *      unpopulated rather than guessed. This is the case the cash gate's
 *      coverage rule treats as unverified, not failed.
 *
 * `fxRate` is recorded whenever it validates, independent of which branch
 * populated `amount_base`: a statement can state both its own converted
 * amount and the rate it used, and losing the rate because the amount made
 * it unnecessary would drop evidence for no reason.
 */
function resolveAmountBase(
  amountBaseText: string | null,
  fxRateText: string | null,
  amount: string | null,
  baseCurrency: string | null,
  pending: ReviewCandidate[],
): {
  amountBase: string | null;
  fxRate: string | null;
  amountBaseRounding: RoundingRule | null;
} {
  const fxRate = canonicalizeAmbiguous(
    fxRateText,
    "ambiguous_fx_rate",
    pending,
  );

  if (amountBaseText !== null) {
    let amountBase: string | null;
    try {
      amountBase =
        baseCurrency === null
          ? toNumericText(amountBaseText)
          : checkedMoney(amountBaseText, baseCurrency);
    } catch (error) {
      pending.push({
        kind: "ambiguous_amount_base",
        rawValue: amountBaseText,
        reason: error instanceof Error ? error.message : String(error),
      });
      amountBase = null;
    }
    return {
      amountBase,
      fxRate,
      amountBaseRounding: amountBase === null ? null : "none",
    };
  }

  if (fxRate === null || amount === null || baseCurrency === null) {
    return { amountBase: null, fxRate, amountBaseRounding: null };
  }

  try {
    const product = multiplyDecimal(amount, fxRate);
    const amountBase = fromMinorUnits(
      roundToMinorUnits(product, baseCurrency, DERIVED_ROUNDING_RULE),
      baseCurrency,
    );
    return { amountBase, fxRate, amountBaseRounding: DERIVED_ROUNDING_RULE };
  } catch (error) {
    pending.push({
      kind: "ambiguous_amount_base",
      rawValue: `${amount} * ${fxRate}`,
      reason: `could not derive a base-currency amount: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { amountBase: null, fxRate, amountBaseRounding: null };
  }
}

/**
 * The transaction-amount pattern (`ImportRow.amountText`/`amountNote`),
 * generalized: `text` is decimal in `currency` units, or `note` is the reason
 * no value exists (ground rule 5). Shared by `transactions.amount` and every
 * holdings money field that plays the same load-bearing role:
 * `positions.market_value`, `balances.total_value`, `liabilities.balance`.
 */
function resolveAmbiguousMoney(
  text: string | null,
  note: string | null,
  currency: string,
  kind: string,
  pending: ReviewCandidate[],
): string | null {
  if (text !== null) {
    try {
      return checkedMoney(text, currency);
    } catch (error) {
      pending.push({
        kind,
        rawValue: text,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
  if (note !== null) {
    pending.push({ kind, rawValue: "", reason: note });
  }
  return null;
}

/**
 * A secondary, optional money field with no adapter-supplied note: plain
 * decimal text or null. A malformed value opens a review item; null with no
 * note simply means the source did not state this figure at all -- unlike
 * `resolveAmbiguousMoney`'s primary value, absence here is not itself
 * ambiguous. Used for `positions.cost_basis`/`unrealized` and `balances
 * .cash`/`period_start_value`/`period_end_value`.
 */
function canonicalizeAmbiguousMoney(
  text: string | null,
  currency: string,
  kind: string,
  pending: ReviewCandidate[],
): string | null {
  if (text === null) return null;
  try {
    return checkedMoney(text, currency);
  } catch (error) {
    pending.push({
      kind,
      rawValue: text,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The one path from a source's stated money text to a NUMERIC column, and the
 * one place the two checks money has to pass are applied together.
 *
 * `toMinorUnits` is called for its exception and not for its value. Under
 * SQLite it was also the conversion to what got stored; here nothing is
 * stored in minor units, and the check stays for the reason it always
 * actually had: a value more precise than its currency allows is *ambiguous
 * money*, and ground rule 5 says ambiguous money is null with a review item,
 * never inferred. `NUMERIC` would accept 12.345 USD without complaint, which
 * is exactly why dropping this check when the column type changed would have
 * been a silent loss of the rule rather than a simplification.
 *
 * `toNumericText` is the second check and the value that is stored: decimal
 * text, canonical, refused outright past the typed boundary rather than
 * rounded into it. Both rejections reach the caller as an exception and
 * become a review item.
 */
function checkedMoney(text: string, currency: string): string {
  toMinorUnits(text, currency);
  return toNumericText(text);
}

/**
 * Acceptance criterion 7: every run asserts that unique row_hash count equals
 * inserted row count (the UNIQUE constraint already guarantees this; this is
 * a defensive re-check against the aggregate, not trust in the schema alone),
 * and that every transaction resolves to an account.
 *
 * ponytail: both of these aggregate over the whole `transactions` table on
 * every batch, which with `--commit-every 1` means once per document. That is
 * a scan, not a round trip, so it is not what F1-51 was about; scope it to the
 * run's own rows (or drop it for the UNIQUE constraint it re-checks) if a
 * large archive ever makes it the next bottleneck.
 */
async function assertInvariants(client: ArchiveClient): Promise<void> {
  const counts = await client.query<{ total: string; distinct_hashes: string }>(
    "SELECT count(*)::text AS total, count(DISTINCT row_hash)::text AS distinct_hashes FROM transactions",
  );
  const { total = "0", distinct_hashes = "0" } = counts.rows[0] ?? {};
  if (total !== distinct_hashes) {
    throw new Error(
      `row_hash is not unique per transaction: ${total} rows but ` +
        `${distinct_hashes} distinct hashes`,
    );
  }
  const orphans = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE a.id IS NULL`,
  );
  if (orphans.rows[0]?.n !== "0") {
    throw new Error(
      `${orphans.rows[0]?.n} transaction(s) do not resolve to an account`,
    );
  }
}
