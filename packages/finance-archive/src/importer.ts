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

import { toMinorUnits } from "./money.js";
import { toNumericText } from "./pgNumeric.js";
import {
  type ArchiveClient,
  lockArchiveForWrite,
  withArchiveTransaction,
} from "./pgStore.js";
import {
  runReconciliationGate,
  type ReconciliationGateSummary,
} from "./reconciliation.js";
import {
  runPositionReconciliationGate,
  type PositionReconciliationGateSummary,
} from "./positionReconciliation.js";
import { contentKeyV2, rowHashV2 } from "./rowHash.js";

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
 *   `rowHashV2`'s `occurrence` field and `importRow` in this file), which
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

/**
 * One acquired file (a raw statement, or one page of a paginated pull) and
 * the rows parsed from it. Rows are attributed to `documents` by content
 * hash, so importing the same bytes twice is a no-op (ground rule 1).
 * `positions`, `balances` and `liabilities` follow the same rule: a document
 * already imported successfully contributes nothing new on a second import,
 * holdings included, since there is no dedupe key on those tables other than
 * "which document stated this."
 */
export type ImportDocument = {
  /** sha256 of the raw file's bytes. The dedupe key for whole-document skip. */
  sha256: string;
  /** Local path in the raw tree. Never a repository path. */
  filePath: string;
  institutionId: string;
  accountId: string | null;
  docType: string;
  docDate: string | null;
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
  /** Most documents (activity pulls) carry none of these. */
  positions?: readonly ImportPosition[];
  balances?: readonly ImportBalance[];
  liabilities?: readonly ImportLiability[];
};

export type ImportBatch = {
  /** Recorded on `import_runs.source`, e.g. an adapter or institution slug. */
  source: string;
  documents: readonly ImportDocument[];
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
  /** Always 0 here; `publishImport` reports what the gates found. */
  reconciliationsPassed: number;
  reconciliationsFailed: number;
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

type ReviewCandidate = {
  kind: string;
  rawValue: string;
  reason: string;
};

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
): Promise<PublishSummary> {
  return withArchiveTransaction(client, async (tx) => {
    const summary = await importBatch(tx, batch, now);
    const cash = await runReconciliationGate(tx, summary.importRunId);
    const positions = await runPositionReconciliationGate(
      tx,
      summary.importRunId,
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
): Promise<ImportSummary> {
  const importRunId = randomUUID();
  const startedAt = now.toISOString();
  const today = startedAt.slice(0, 10);

  let filesSeen = 0;
  let rowsInserted = 0;
  let rowsDeduplicated = 0;
  let rowsRefused = 0;
  let reviewItemsOpened = 0;

  async function openReview(
    accountId: string | null,
    documentId: string | null,
    sourceLocator: string | null,
    candidate: ReviewCandidate,
  ): Promise<void> {
    await client.query(
      `INSERT INTO review_items
         (id, kind, account_id, source_document_id, source_locator, raw_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        candidate.kind,
        accountId,
        documentId,
        sourceLocator,
        candidate.rawValue,
        candidate.reason,
      ],
    );
    reviewItemsOpened += 1;
  }

  async function importRow(
    row: ImportRow,
    documentId: string,
    occurrences: Map<string, number>,
  ): Promise<"inserted" | "deduplicated" | "refused"> {
    if (!ISO_DATE.test(row.processDate)) {
      await openReview(row.accountId, documentId, row.sourceLocator, {
        kind: "unparseable_process_date",
        rawValue: row.processDate,
        reason: "process date is not a valid ISO YYYY-MM-DD date",
      });
      return "refused";
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

    if (row.providerTxnId) {
      const byProviderId = await client.query(
        "SELECT 1 FROM transactions WHERE account_id = $1 AND provider_txn_id = $2",
        [row.accountId, row.providerTxnId],
      );
      if ((byProviderId.rowCount ?? 0) > 0) {
        // Same account, same stable id: a re-encounter of an already-imported
        // row, most often from an overlapping page in a paginated pull. This
        // is an authoritative identity match, not evidence, so no review item.
        return "deduplicated";
      }
      // ponytail: two distinct provider ids landing on the same content and
      // the same per-document occurrence ordinal, in two unrelated
      // documents, would hit the row_hash UNIQUE constraint here and abort
      // the batch loudly rather than silently merge or drop either row.
      // Real enough only if genuinely identical transactions happen on the
      // same account, day and ordinal position across separate pulls; widen
      // the hash to include provider_txn_id if that ever fires.
    } else {
      const byHash = await client.query<{
        id: string;
        source_document_id: string | null;
        source_locator: string | null;
      }>(
        "SELECT id, source_document_id, source_locator FROM transactions WHERE row_hash = $1",
        [hash],
      );
      const existing = byHash.rows[0];
      if (existing) {
        // No stable id, so this collapse rests on content evidence rather
        // than a stable identifier. Within one document that never happens
        // (each occurrence in a document gets its own ordinal); across two
        // documents it is exactly the overlapping-page case, or, rarely, a
        // genuine coincidence. Either way, make the collapse visible.
        if (existing.source_document_id !== documentId) {
          await openReview(row.accountId, documentId, row.sourceLocator, {
            kind: "cross_document_duplicate",
            rawValue: existing.id,
            reason:
              `matches an existing transaction from document ${existing.source_document_id} ` +
              `at ${existing.source_locator}; collapsed on content evidence, not a stable id`,
          });
        }
        return "deduplicated";
      }
    }

    await client.query(
      `INSERT INTO transactions
         (id, account_id, trade_date, process_date, settle_date, date_precision,
          activity_type, description, instrument_id, quantity, price, amount,
          currency, running_balance, source_document_id, source_locator,
          row_hash, provider_txn_id, status, imported_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20)`,
      [
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
        runningBalance,
        documentId,
        row.sourceLocator,
        hash,
        row.providerTxnId,
        pending.length > 0 ? "review" : "imported",
        startedAt,
      ],
    );
    for (const candidate of pending) {
      await openReview(row.accountId, documentId, row.sourceLocator, candidate);
    }
    return "inserted";
  }

  /**
   * `positions`, `balances` and `liabilities` dedupe at the whole-document
   * level (see `ImportDocument`'s doc comment) rather than by their own
   * content hash, so unlike `importRow` these three never look up an
   * existing row: the caller only reaches them for a document being
   * imported for the first time. Only `as_of` unparseable to ISO blocks the
   * insert outright -- the column is NOT NULL with no other spelling to
   * store, the same reasoning as `transactions.process_date`. Every other
   * malformed or missing field stores NULL and opens a review item instead.
   */
  async function importPosition(
    position: ImportPosition,
    accountId: string,
    documentId: string,
  ): Promise<"inserted" | "refused"> {
    if (!ISO_DATE.test(position.asOf)) {
      await openReview(accountId, documentId, position.sourceLocator, {
        kind: "unparseable_as_of",
        rawValue: position.asOf,
        reason: "as_of is not a valid ISO YYYY-MM-DD date",
      });
      return "refused";
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

    await client.query(
      `INSERT INTO positions
         (id, account_id, as_of, instrument_id, quantity, price, market_value,
          cost_basis, unrealized, currency, valuation_basis, valuation_note,
          source_document_id, source_locator)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
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
      ],
    );
    for (const candidate of pending) {
      await openReview(
        accountId,
        documentId,
        position.sourceLocator,
        candidate,
      );
    }
    return "inserted";
  }

  async function importBalance(
    balance: ImportBalance,
    accountId: string,
    documentId: string,
  ): Promise<"inserted" | "refused"> {
    if (!ISO_DATE.test(balance.asOf)) {
      await openReview(accountId, documentId, balance.sourceLocator, {
        kind: "unparseable_as_of",
        rawValue: balance.asOf,
        reason: "as_of is not a valid ISO YYYY-MM-DD date",
      });
      return "refused";
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

    await client.query(
      `INSERT INTO balances
         (id, account_id, as_of, total_value, cash, currency,
          period_start_value, period_end_value, source_document_id, source_locator)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
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
      ],
    );
    for (const candidate of pending) {
      await openReview(accountId, documentId, balance.sourceLocator, candidate);
    }
    return "inserted";
  }

  async function importLiability(
    liability: ImportLiability,
    institutionId: string | null,
    accountId: string | null,
    documentId: string,
  ): Promise<"inserted" | "refused"> {
    if (!ISO_DATE.test(liability.asOf)) {
      await openReview(accountId, documentId, liability.sourceLocator, {
        kind: "unparseable_as_of",
        rawValue: liability.asOf,
        reason: "as_of is not a valid ISO YYYY-MM-DD date",
      });
      return "refused";
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

    await client.query(
      `INSERT INTO liabilities
         (id, institution_id, account_id, kind, display_name, balance, currency,
          rate, as_of, collateral_note, source_document_id, source_locator)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
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
      ],
    );
    for (const candidate of pending) {
      await openReview(
        accountId,
        documentId,
        liability.sourceLocator,
        candidate,
      );
    }
    return "inserted";
  }

  return withArchiveTransaction(client, async () => {
    await lockArchiveForWrite(client);

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

      const found = await client.query<{ id: string; parsed_ok: boolean }>(
        "SELECT id, parsed_ok FROM documents WHERE sha256 = $1",
        [document.sha256],
      );
      const existing = found.rows[0];
      if (existing?.parsed_ok === true) {
        // Ground rule 1: raw files are immutable. Byte-identical bytes that
        // already imported successfully contribute nothing new. Holdings
        // dedupe the same way (see ImportDocument's doc comment): there is
        // no per-row key for them, only "which document stated this." A
        // whole-document skip is a dedupe, not a refusal -- F1-36's
        // `parsed_ok` fix below is what keeps this branch honest: it only
        // ever fires for a document every one of whose rows actually
        // imported or matched last time, never one this importer refused.
        const skipped =
          document.rows.length +
          (document.positions?.length ?? 0) +
          (document.balances?.length ?? 0) +
          (document.liabilities?.length ?? 0);
        rowsDeduplicated += skipped;
        continue;
      }

      const documentId = existing?.id ?? randomUUID();
      if (!existing) {
        await client.query(
          `INSERT INTO documents
             (id, institution_id, account_id, doc_type, doc_date, file_path, sha256, parsed_ok,
              retained_sha256, retained_byte_length, media_type, capture_id, text_path)
           VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9, $10, $11, $12)`,
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
          ],
        );
      }

      // Fresh per document: the occurrence ordinal is scoped to one document
      // in its own row order (see importRow). F1-36: `documentRefused`
      // tracks whether anything in this document was refused rather than
      // inserted or deduplicated, which decides `parsed_ok` below -- a
      // document is only "already fully imported" (safe to whole-document
      // skip next time) if nothing in it was ever refused.
      const occurrences = new Map<string, number>();
      let documentRefused = false;
      for (const row of document.rows) {
        const outcome = await importRow(row, documentId, occurrences);
        if (outcome === "inserted") rowsInserted += 1;
        else if (outcome === "deduplicated") rowsDeduplicated += 1;
        else {
          rowsRefused += 1;
          documentRefused = true;
        }
      }

      // ponytail: a retried document (parsed_ok false, existing above) that
      // mixes activity rows with holdings, and whose holdings already
      // inserted cleanly on an earlier attempt that only a row refusal
      // reopened, re-inserts those holdings here -- positions, balances and
      // liabilities have no per-row identity to dedupe on (see
      // ImportDocument's doc comment), only the whole-document skip this
      // very fix had to stop trusting blindly. Narrow: it needs one document
      // to carry both a refused activity row and already-successful
      // holdings. Give holdings their own content hash (mirroring row_hash)
      // if a real pull ever mixes the two this way.
      const positions = document.positions ?? [];
      const balances = document.balances ?? [];
      if (
        (positions.length > 0 || balances.length > 0) &&
        document.accountId === null
      ) {
        throw new Error(
          `document ${document.sha256} carries a position or balance but has no account_id; ` +
            "positions.account_id and balances.account_id are NOT NULL",
        );
      }
      for (const position of positions) {
        const outcome = await importPosition(
          position,
          document.accountId as string,
          documentId,
        );
        if (outcome === "inserted") rowsInserted += 1;
        else {
          rowsRefused += 1;
          documentRefused = true;
        }
      }
      for (const balance of balances) {
        const outcome = await importBalance(
          balance,
          document.accountId as string,
          documentId,
        );
        if (outcome === "inserted") rowsInserted += 1;
        else {
          rowsRefused += 1;
          documentRefused = true;
        }
      }
      for (const liability of document.liabilities ?? []) {
        const outcome = await importLiability(
          liability,
          document.institutionId,
          document.accountId,
          documentId,
        );
        if (outcome === "inserted") rowsInserted += 1;
        else {
          rowsRefused += 1;
          documentRefused = true;
        }
      }

      // F1-36. Previously always TRUE, which is what let a document every
      // one of whose rows was refused (a bad date format on 1602 rows, say)
      // get recorded as fully, successfully imported. The next run's
      // whole-document skip above then trusted that lie and never looked at
      // this document's rows again -- not even after the parser that
      // produced them was fixed, because the document's sha256 (the raw
      // file's bytes) does not change when only its parsing does. `FALSE`
      // here leaves the document eligible for the whole-document skip only
      // once nothing in it needs a second look; until then every rerun
      // reprocesses it, and every row and holding in it is idempotent on
      // its own (row_hash/provider_txn_id for rows; the skip itself for
      // holdings, which only applies once this flips TRUE).
      await client.query("UPDATE documents SET parsed_ok = $2 WHERE id = $1", [
        documentId,
        !documentRefused,
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
      reconciliationsPassed: 0,
      reconciliationsFailed: 0,
    };
  });
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
