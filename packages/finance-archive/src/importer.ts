// The importer: turns normalized rows into `transactions`, `documents`,
// `review_items` and one `import_runs` summary. It never prints a row (see
// "Working on the archive without reading it" in the plan); a caller reads the
// returned ImportSummary, not the database contents.
//
// This package does not yet have an adapter. F1-2 owns `parse()`, which will
// eventually produce the rows below; F1-3 defines the row shape it consumes so
// the two can be wired together later. `ImportRow` is that seam: an explicit,
// documented contract, not an adapter interface of its own.
//
// The reconciliation gate (comparing a period's stated balance change against
// the sum of its transactions) is F1-4's job, not this file's. This importer
// only guarantees the invariants a single import run owns: idempotent
// re-import, deduplication, provenance, and the review queue.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { canonicalizeDecimal } from "./decimal.js";
import { toMinorUnits } from "./money.js";
import { contentKey, rowHash } from "./rowHash.js";

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
 *   canonicalizes before storing. A malformed value opens a review item and
 *   is stored as NULL rather than guessed.
 * - `amountText` is the amount as the source stated it, in `currency`'s
 *   units (e.g. `"12.34"` for USD), or `null` when the source itself has no
 *   amount for this row (a non-monetary event) or the amount is ambiguous.
 *   A value with more precision than `currency` allows (`toMinorUnits`
 *   throwing) is ambiguous money: the importer stores NULL and opens a
 *   review item (ground rule 5). This is the only path from source text to
 *   the `amount` column; nothing in this file parses a float or writes a
 *   REAL.
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
 *   `rowHash`'s `occurrence` field and `importRow` in this file), which
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
  rowsSkipped: number;
  reviewItemsOpened: number;
  /** Always 0 here. The reconciliation gate is F1-4's, not this importer's. */
  reconciliationsPassed: number;
  reconciliationsFailed: number;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Earliest plausible statement date. Anything before this is a review item. */
const MIN_PLAUSIBLE_DATE = "1900-01-01";
/** Mirrors positions.valuation_basis's CHECK constraint (schema.ts). */
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
 * Runs one import batch to completion inside a single database transaction:
 * either every document's rows land and the run is recorded, or nothing does.
 * A provider-count mismatch or a broken row_hash/account invariant rolls the
 * whole run back rather than leaving a partially-imported archive (ground
 * rules 3 and 7 treat these as gates, not reports).
 *
 * `now` is injectable so future-date and implausible-date review checks are
 * deterministic in tests; it defaults to the wall clock.
 */
export function importBatch(
  db: DatabaseSync,
  batch: ImportBatch,
  now: Date = new Date(),
): ImportSummary {
  const importRunId = randomUUID();
  const startedAt = now.toISOString();
  const today = startedAt.slice(0, 10);

  let filesSeen = 0;
  let rowsInserted = 0;
  let rowsSkipped = 0;
  let reviewItemsOpened = 0;

  const insertDocument = db.prepare(
    `INSERT INTO documents (id, institution_id, account_id, doc_type, doc_date, file_path, sha256, parsed_ok)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  const findDocument = db.prepare(
    "SELECT id, parsed_ok FROM documents WHERE sha256 = ?",
  );
  const markParsed = db.prepare(
    "UPDATE documents SET parsed_ok = 1 WHERE id = ?",
  );
  const findByProviderTxnId = db.prepare(
    "SELECT 1 FROM transactions WHERE account_id = ? AND provider_txn_id = ?",
  );
  const findByRowHash = db.prepare(
    "SELECT id, source_document_id, source_locator FROM transactions WHERE row_hash = ?",
  );
  const insertTransaction = db.prepare(
    `INSERT INTO transactions
       (id, account_id, trade_date, process_date, settle_date, date_precision,
        activity_type, description, instrument_id, quantity, price, amount,
        currency, running_balance, source_document_id, source_locator,
        row_hash, provider_txn_id, status, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertReviewItem = db.prepare(
    `INSERT INTO review_items
       (id, kind, account_id, source_document_id, source_locator, raw_value, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertPosition = db.prepare(
    `INSERT INTO positions
       (id, account_id, as_of, instrument_id, quantity, price, market_value,
        cost_basis, unrealized, currency, valuation_basis, valuation_note,
        source_document_id, source_locator)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertBalance = db.prepare(
    `INSERT INTO balances
       (id, account_id, as_of, total_value, cash, currency,
        period_start_value, period_end_value, source_document_id, source_locator)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLiability = db.prepare(
    `INSERT INTO liabilities
       (id, institution_id, account_id, kind, display_name, balance, currency,
        rate, as_of, collateral_note, source_document_id, source_locator)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  function openReview(
    accountId: string | null,
    documentId: string | null,
    sourceLocator: string | null,
    candidate: ReviewCandidate,
  ): void {
    insertReviewItem.run(
      randomUUID(),
      candidate.kind,
      accountId,
      documentId,
      sourceLocator,
      candidate.rawValue,
      candidate.reason,
    );
    reviewItemsOpened += 1;
  }

  function importRow(
    row: ImportRow,
    documentId: string,
    occurrences: Map<string, number>,
  ): "inserted" | "skipped" {
    if (!ISO_DATE.test(row.processDate)) {
      openReview(row.accountId, documentId, row.sourceLocator, {
        kind: "unparseable_process_date",
        rawValue: row.processDate,
        reason: "process date is not a valid ISO YYYY-MM-DD date",
      });
      return "skipped";
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
    const key = contentKey({
      accountId: row.accountId,
      processDate: row.processDate,
      activityType: row.activityType,
      description: row.description,
      quantity,
      amount,
      currency: row.currency,
    });
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);

    const hash = rowHash({
      accountId: row.accountId,
      processDate: row.processDate,
      activityType: row.activityType,
      description: row.description,
      quantity,
      amount,
      currency: row.currency,
      occurrence,
    });

    if (row.providerTxnId) {
      if (findByProviderTxnId.get(row.accountId, row.providerTxnId)) {
        // Same account, same stable id: a re-encounter of an already-imported
        // row, most often from an overlapping page in a paginated pull. This
        // is an authoritative identity match, not evidence, so no review item.
        return "skipped";
      }
      // ponytail: two distinct provider ids landing on the same content and
      // the same per-document occurrence ordinal, in two unrelated
      // documents, would hit the row_hash UNIQUE constraint here and abort
      // the batch loudly rather than silently merge or drop either row.
      // Real enough only if genuinely identical transactions happen on the
      // same account, day and ordinal position across separate pulls; widen
      // the hash to include provider_txn_id if that ever fires.
    } else {
      const existing = findByRowHash.get(hash) as
        | { id: string; source_document_id: string | null; source_locator: string | null }
        | undefined;
      if (existing) {
        // No stable id, so this collapse rests on content evidence rather
        // than a stable identifier. Within one document that never happens
        // (each occurrence in a document gets its own ordinal); across two
        // documents it is exactly the overlapping-page case, or, rarely, a
        // genuine coincidence. Either way, make the collapse visible.
        if (existing.source_document_id !== documentId) {
          openReview(row.accountId, documentId, row.sourceLocator, {
            kind: "cross_document_duplicate",
            rawValue: existing.id,
            reason:
              `matches an existing transaction from document ${existing.source_document_id} ` +
              `at ${existing.source_locator}; collapsed on content evidence, not a stable id`,
          });
        }
        return "skipped";
      }
    }

    insertTransaction.run(
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
    );
    for (const candidate of pending) {
      openReview(row.accountId, documentId, row.sourceLocator, candidate);
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
  function importPosition(
    position: ImportPosition,
    accountId: string,
    documentId: string,
  ): "inserted" | "skipped" {
    if (!ISO_DATE.test(position.asOf)) {
      openReview(accountId, documentId, position.sourceLocator, {
        kind: "unparseable_as_of",
        rawValue: position.asOf,
        reason: "as_of is not a valid ISO YYYY-MM-DD date",
      });
      return "skipped";
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

    insertPosition.run(
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
    );
    for (const candidate of pending) {
      openReview(accountId, documentId, position.sourceLocator, candidate);
    }
    return "inserted";
  }

  function importBalance(
    balance: ImportBalance,
    accountId: string,
    documentId: string,
  ): "inserted" | "skipped" {
    if (!ISO_DATE.test(balance.asOf)) {
      openReview(accountId, documentId, balance.sourceLocator, {
        kind: "unparseable_as_of",
        rawValue: balance.asOf,
        reason: "as_of is not a valid ISO YYYY-MM-DD date",
      });
      return "skipped";
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

    insertBalance.run(
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
    );
    for (const candidate of pending) {
      openReview(accountId, documentId, balance.sourceLocator, candidate);
    }
    return "inserted";
  }

  function importLiability(
    liability: ImportLiability,
    institutionId: string | null,
    accountId: string | null,
    documentId: string,
  ): "inserted" | "skipped" {
    if (!ISO_DATE.test(liability.asOf)) {
      openReview(accountId, documentId, liability.sourceLocator, {
        kind: "unparseable_as_of",
        rawValue: liability.asOf,
        reason: "as_of is not a valid ISO YYYY-MM-DD date",
      });
      return "skipped";
    }

    const pending: ReviewCandidate[] = [];
    const balanceAmount = resolveAmbiguousMoney(
      liability.balanceText,
      liability.balanceNote,
      liability.currency,
      "ambiguous_liability_balance",
      pending,
    );
    const rate = canonicalizeAmbiguous(liability.rate, "ambiguous_rate", pending);

    insertLiability.run(
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
    );
    for (const candidate of pending) {
      openReview(accountId, documentId, liability.sourceLocator, candidate);
    }
    return "inserted";
  }

  db.exec("BEGIN IMMEDIATE");
  try {
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

      const existing = findDocument.get(document.sha256) as
        | { id: string; parsed_ok: number }
        | undefined;
      if (existing?.parsed_ok === 1) {
        // Ground rule 1: raw files are immutable. Byte-identical bytes that
        // already imported successfully contribute nothing new. Holdings
        // dedupe the same way (see ImportDocument's doc comment): there is
        // no per-row key for them, only "which document stated this."
        rowsSkipped +=
          document.rows.length +
          (document.positions?.length ?? 0) +
          (document.balances?.length ?? 0) +
          (document.liabilities?.length ?? 0);
        continue;
      }

      const documentId = existing?.id ?? randomUUID();
      if (!existing) {
        insertDocument.run(
          documentId,
          document.institutionId,
          document.accountId,
          document.docType,
          document.docDate,
          document.filePath,
          document.sha256,
        );
      }

      // Fresh per document: the occurrence ordinal is scoped to one document
      // in its own row order (see importRow).
      const occurrences = new Map<string, number>();
      for (const row of document.rows) {
        const outcome = importRow(row, documentId, occurrences);
        if (outcome === "inserted") rowsInserted += 1;
        else rowsSkipped += 1;
      }

      const positions = document.positions ?? [];
      const balances = document.balances ?? [];
      if ((positions.length > 0 || balances.length > 0) && document.accountId === null) {
        throw new Error(
          `document ${document.sha256} carries a position or balance but has no account_id; ` +
            "positions.account_id and balances.account_id are NOT NULL",
        );
      }
      for (const position of positions) {
        const outcome = importPosition(position, document.accountId as string, documentId);
        if (outcome === "inserted") rowsInserted += 1;
        else rowsSkipped += 1;
      }
      for (const balance of balances) {
        const outcome = importBalance(balance, document.accountId as string, documentId);
        if (outcome === "inserted") rowsInserted += 1;
        else rowsSkipped += 1;
      }
      for (const liability of document.liabilities ?? []) {
        const outcome = importLiability(
          liability,
          document.institutionId,
          document.accountId,
          documentId,
        );
        if (outcome === "inserted") rowsInserted += 1;
        else rowsSkipped += 1;
      }

      markParsed.run(documentId);
    }

    assertInvariants(db);

    const finishedAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO import_runs
         (id, started_at, finished_at, source, files_seen, rows_inserted,
          rows_skipped, reconciliations_passed, reconciliations_failed, review_items)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    ).run(
      importRunId,
      startedAt,
      finishedAt,
      batch.source,
      filesSeen,
      rowsInserted,
      rowsSkipped,
      reviewItemsOpened,
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    importRunId,
    filesSeen,
    rowsInserted,
    rowsSkipped,
    reviewItemsOpened,
    reconciliationsPassed: 0,
    reconciliationsFailed: 0,
  };
}

/**
 * trade_date and settle_date are nullable columns, so a value the source
 * could not give a valid ISO date for is stored as NULL with a review item
 * rather than reaching the CHECK constraint as a hard, batch-aborting error.
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

function canonicalizeAmbiguous(
  text: string | null,
  kind: string,
  pending: ReviewCandidate[],
): string | null {
  if (text === null) return null;
  try {
    return canonicalizeDecimal(text);
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
 * generalized: `text` is decimal in `currency` units and gets converted to
 * minor units, or `note` is the reason no value exists (ground rule 5).
 * Shared by `transactions.amount` and every holdings money field that plays
 * the same load-bearing role: `positions.market_value`, `balances
 * .total_value`, `liabilities.balance`.
 */
function resolveAmbiguousMoney(
  text: string | null,
  note: string | null,
  currency: string,
  kind: string,
  pending: ReviewCandidate[],
): bigint | null {
  if (text !== null) {
    try {
      return toMinorUnits(text, currency);
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
): bigint | null {
  if (text === null) return null;
  try {
    return toMinorUnits(text, currency);
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
 * Acceptance criterion 7: every run asserts that unique row_hash count equals
 * inserted row count (the UNIQUE constraint already guarantees this; this is
 * a defensive re-check against the aggregate, not trust in the schema alone),
 * and that every transaction resolves to an account.
 */
function assertInvariants(db: DatabaseSync): void {
  const counts = db
    .prepare(
      "SELECT COUNT(*) AS total, COUNT(DISTINCT row_hash) AS distinctHashes FROM transactions",
    )
    .get() as { total: number | bigint; distinctHashes: number | bigint };
  if (Number(counts.total) !== Number(counts.distinctHashes)) {
    throw new Error(
      `row_hash is not unique per transaction: ${counts.total} rows but ` +
        `${counts.distinctHashes} distinct hashes`,
    );
  }
  const orphans = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE a.id IS NULL`,
    )
    .get() as { n: number | bigint };
  if (Number(orphans.n) !== 0) {
    throw new Error(
      `${orphans.n} transaction(s) do not resolve to an account`,
    );
  }
}
