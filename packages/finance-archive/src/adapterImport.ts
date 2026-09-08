// The seam between an institution adapter's parse() output (ParsedRow, see
// adapter.ts) and the importer's row shape (ImportRow, see importer.ts).
// Neither F1-2 nor F1-3 owned this mapping; this file does.
//
// Two things happen here that neither adapter.ts nor importer.ts can do on
// its own:
//
// 1. Instrument resolution. `parse()` returns a descriptor (symbol, cusip,
//    isin, name); the importer wants a resolved `instrumentId`. Nothing
//    before this file creates `instruments` rows.
// 2. Document splitting. A paginated pull is captured as one immutable
//    RawFile (one content hash), but is logically several documents for
//    dedupe purposes -- one per page -- so the same real transaction on an
//    overlapping page boundary lands on the same occurrence ordinal (and
//    therefore the same row_hash) in each page's document and collapses.
//    See ParsedRow.sourceDocument's doc comment for the reasoning.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { AcquiredDocument, ParsedInstrument, ParsedRow } from "./adapter.js";
import { sha256Hex } from "./adapter.js";
import { canonicalizeDecimal } from "./decimal.js";
import type { ImportDocument, ImportRow } from "./importer.js";
import { toMinorUnits } from "./money.js";
import { type RawTreeWriteResult, writeRawDocument, writeRetainedText } from "./rawTree.js";
import { contentKey, rowHash } from "./rowHash.js";

/**
 * One acquired-and-parsed pull, ready to become one or more `ImportDocument`s.
 * `filePath` is where the whole pull's raw bytes live (or will live) in the
 * raw tree; writing them there is the caller's job, same as the importer's
 * own `ImportDocument.filePath`.
 */
export type AdapterPull = {
  readonly institutionId: string;
  readonly accountId: string;
  readonly acquired: AcquiredDocument;
  readonly rows: readonly ParsedRow[];
  readonly docType: string;
  readonly docDate: string | null;
  readonly filePath: string;
};

function insertReviewItem(
  db: DatabaseSync,
  fields: {
    kind: string;
    accountId: string | null;
    rawValue: string | null;
    reason: string;
  },
): void {
  db.prepare(
    `INSERT INTO review_items (id, kind, account_id, source_document_id, source_locator, raw_value, reason)
     VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(randomUUID(), fields.kind, fields.accountId, fields.rawValue, fields.reason);
}

/**
 * Resolves a parsed instrument descriptor to a stable `instruments.id`,
 * creating the row the first time it is seen. Identity strength follows the
 * plan: a real identifier is preferred over a symbol.
 *
 * Precedence: `cusip`, then `isin`, then `symbol` and `name` together, then
 * `symbol` alone, then a new row. A bare symbol never *merges silently* --
 * matching on it alone opens a `review_items` entry recording the weak
 * identity and what it matched, the same way a cross-document row_hash
 * collapse is made visible rather than happening quietly -- but it does
 * resolve to the existing row rather than minting a new one every time.
 * Never merging on a bare symbol sounds safer than this, but it is not: it
 * means every reference to an instrument with no stronger identifier gets
 * its own row forever, scattering one real holding across many
 * `instrument_id`s and silently breaking any "every purchase of instrument
 * X" query. A flagged, stable match is the smaller failure of the two.
 */
export function resolveInstrumentId(
  db: DatabaseSync,
  instrument: ParsedInstrument,
): string {
  if (instrument.cusip) {
    return findOrCreateInstrument(db, "cusip", instrument.cusip, instrument);
  }
  if (instrument.isin) {
    return findOrCreateInstrument(db, "isin", instrument.isin, instrument);
  }
  if (instrument.symbol && instrument.name) {
    const existing = db
      .prepare("SELECT id FROM instruments WHERE symbol = ? AND name = ?")
      .get(instrument.symbol, instrument.name) as { id: string } | undefined;
    if (existing) return existing.id;
  }
  if (instrument.symbol) {
    // rowid orders by insertion, so this is deterministically the first
    // instrument row ever created for this symbol -- a naive heuristic
    // (there is no way to know if it is the *right* one without a stronger
    // identifier), which is exactly why the match is flagged for review
    // rather than trusted silently.
    const weak = db
      .prepare(
        "SELECT id, cusip, isin, name FROM instruments WHERE symbol = ? ORDER BY rowid LIMIT 1",
      )
      .get(instrument.symbol) as
      | { id: string; cusip: string | null; isin: string | null; name: string | null }
      | undefined;
    if (weak) {
      insertReviewItem(db, {
        kind: "weak_instrument_match",
        accountId: null,
        rawValue: JSON.stringify(instrument),
        reason:
          `resolved by symbol "${instrument.symbol}" alone (no cusip, isin, or matching name) ` +
          `to existing instrument ${weak.id} (cusip=${weak.cusip ?? "null"}, isin=${weak.isin ?? "null"}, ` +
          `name=${JSON.stringify(weak.name)}); two different instruments sharing this symbol ` +
          "would incorrectly merge here -- confirm or correct this match",
      });
      return weak.id;
    }
  }
  return insertInstrument(db, instrument);
}

function findOrCreateInstrument(
  db: DatabaseSync,
  column: "cusip" | "isin",
  value: string,
  instrument: ParsedInstrument,
): string {
  const existing = db
    .prepare(`SELECT id FROM instruments WHERE ${column} = ?`)
    .get(value) as { id: string } | undefined;
  if (existing) return existing.id;
  return insertInstrument(db, instrument);
}

function insertInstrument(db: DatabaseSync, instrument: ParsedInstrument): string {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO instruments (id, symbol, cusip, isin, name) VALUES (?, ?, ?, ?, ?)",
  ).run(id, instrument.symbol, instrument.cusip, instrument.isin, instrument.name);
  return id;
}

function parsedRowToImportRow(
  db: DatabaseSync,
  accountId: string,
  row: ParsedRow,
): ImportRow {
  return {
    accountId,
    tradeDate: row.tradeDate,
    processDate: row.processDate,
    settleDate: row.settleDate,
    datePrecision: row.datePrecision,
    activityType: row.activityType,
    description: row.description,
    instrumentId:
      row.instrument === null ? null : resolveInstrumentId(db, row.instrument),
    quantity: row.quantity,
    price: row.price,
    amountText: row.amount,
    amountNote: row.amountNote,
    currency: row.currency,
    runningBalance: row.runningBalance,
    // Widened, not discarded: every field-level locator parse() attached
    // (ground rule 2), not just the row-level one. transactions.source_locator
    // is a free-text column; get_evidence returns it opaque to the caller.
    sourceLocator: JSON.stringify(row.locators),
    providerTxnId: row.externalId,
  };
}

/** Groups rows by `sourceDocument`, preserving first-seen order and each row's own order within its group. */
function groupBySourceDocument(
  rows: readonly ParsedRow[],
): Map<string, ParsedRow[]> {
  const groups = new Map<string, ParsedRow[]>();
  for (const row of rows) {
    const group = groups.get(row.sourceDocument);
    if (group) group.push(row);
    else groups.set(row.sourceDocument, [row]);
  }
  return groups;
}

/**
 * How many distinct transactions this pull's rows reduce to once each
 * page-document's own occurrence ordinal is applied, i.e. exactly the count
 * `importBatch` will insert for this pull if nothing else collides with an
 * earlier import. Computed with `rowHash`'s own `contentKey` (shared with
 * `importer.ts`, see rowHash.ts) so this count is never allowed to drift
 * from what the importer actually does. Works with or without provider
 * transaction ids -- unlike an id-based count, it cannot go silent just
 * because a source has none.
 */
function countDistinctRowHashes(
  accountId: string,
  groups: ReadonlyMap<string, readonly ParsedRow[]>,
): number {
  const hashes = new Set<string>();
  for (const rows of groups.values()) {
    // Fresh per page-document, mirroring importBatch: the ordinal is scoped
    // to one document so the same real transaction on an overlapping page
    // lands on the same ordinal (and hash) in each page's document.
    const occurrences = new Map<string, number>();
    for (const row of rows) {
      let amount: bigint | null = null;
      if (row.amount !== null) {
        try {
          amount = toMinorUnits(row.amount, row.currency);
        } catch {
          // Ambiguous money: importBatch stores NULL for this too (ground
          // rule 5), so NULL is what belongs in the hash here as well.
        }
      }
      let quantity: string | null = null;
      if (row.quantity !== null) {
        try {
          quantity = canonicalizeDecimal(row.quantity);
        } catch {
          // A malformed quantity becomes NULL on import too; same reasoning.
        }
      }
      const content = {
        accountId,
        processDate: row.processDate,
        activityType: row.activityType,
        description: row.description,
        quantity,
        amount,
        currency: row.currency,
      };
      const key = contentKey(content);
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      hashes.add(rowHash({ ...content, occurrence }));
    }
  }
  return hashes.size;
}

/**
 * Turns one adapter pull into the `ImportDocument`s `importBatch` consumes.
 *
 * A pull that parse() reported as a single document (`sourceDocument`
 * constant across every row -- the normal case for a statement, a
 * confirmation, or a tabular export) becomes one `ImportDocument`, and the
 * pull's own `providerReportedCount` is asserted on it exactly as before.
 *
 * A paginated pull (several distinct `sourceDocument` values) becomes one
 * `ImportDocument` per page, so ground rule 7 -- the whole pull must
 * reconcile against the provider's own reported total -- is checked
 * separately here, across every page: the post-dedup row_hash count (see
 * `countDistinctRowHashes`) is compared against `reportedRowCount`, which
 * works whether or not the rows carry a provider transaction id. When the
 * provider reports no total at all, that pull's completeness cannot be
 * checked at all, and ground rule 7 forbids asserting it anyway: this opens
 * a `review_items` entry recording that this pull was never verified,
 * rather than importing it with no mark left behind.
 */
export function adapterPullToImportDocuments(
  db: DatabaseSync,
  pull: AdapterPull,
): ImportDocument[] {
  const groups = groupBySourceDocument(pull.rows);
  const reportedRowCount = pull.acquired.manifest.reportedRowCount;

  if (groups.size > 1) {
    if (reportedRowCount === null) {
      insertReviewItem(db, {
        kind: "unverified_pagination_total",
        accountId: pull.accountId,
        rawValue: pull.acquired.manifest.contentHash,
        reason:
          `paginated pull split into ${groups.size} page document(s), but the provider ` +
          "reported no total for this pull; completeness cannot be asserted (ground rule 7) " +
          "without a stated total to reconcile against -- treat this pull as unverified",
      });
    } else {
      const distinct = countDistinctRowHashes(pull.accountId, groups);
      if (distinct !== reportedRowCount) {
        throw new Error(
          `adapter pull reported ${reportedRowCount} unique row(s) but ${distinct} distinct ` +
            `row(s) remain after per-document dedup across ${groups.size} page document(s); ` +
            "refusing to import a pull that does not reconcile against the provider's total " +
            "(ground rule 7)",
        );
      }
    }
  }

  const documents: ImportDocument[] = [];
  for (const [sourceDocument, rows] of groups) {
    const single = groups.size === 1;
    documents.push({
      // For a single document this literally is the acquired file's own
      // content hash. A page split has no bytes of its own -- the whole
      // pull was captured as one immutable RawFile -- so its "document"
      // identity is derived from that same content hash plus the page key,
      // which is still stable and still changes if the underlying pull does.
      sha256: single
        ? pull.acquired.manifest.contentHash
        : sha256Hex(
            new TextEncoder().encode(
              `${pull.acquired.manifest.contentHash}:${sourceDocument}`,
            ),
          ),
      filePath: single ? pull.filePath : `${pull.filePath}#${sourceDocument}`,
      institutionId: pull.institutionId,
      accountId: pull.accountId,
      docType: pull.docType,
      docDate: pull.docDate,
      providerReportedCount: single ? reportedRowCount : null,
      rows: rows.map((row) => parsedRowToImportRow(db, pull.accountId, row)),
    });
  }
  return documents;
}

// --- F1-18: raw tree persistence -------------------------------------------
// `acquire` (adapter.ts) returns bytes and a manifest; nothing before this
// wrote them anywhere. This is the seam: the one place an adapter pull's raw
// bytes (and, when the caller has retained it, the document's extracted
// text) actually get written to the raw tree, before the pull becomes an
// `AdapterPull.filePath`/`ImportDocument.filePath` that `importBatch` records
// on the `documents` row. Self-contained -- it only calls into rawTree.ts and
// does its own small, targeted write to `documents.text_path` -- so it does
// not touch `importer.ts`'s insert statement or any other function in this
// file.

/** What `persistAcquiredDocument` wrote and where, for the caller to use as
 * `AdapterPull.filePath` and, after import, as the argument to
 * `recordRetainedTextPath`. */
export type PersistedAcquisition = {
  readonly filePath: string;
  readonly textPath: string | null;
  readonly documentWrite: RawTreeWriteResult;
  readonly textWrite: RawTreeWriteResult | null;
};

/**
 * Persists one acquired document's raw bytes -- and, when supplied, its
 * retained extracted text -- to the raw tree rooted at `rawTreeRoot`.
 * Write-once: a re-acquisition of identical bytes reports
 * `status: "already_exists"` on `documentWrite`/`textWrite` rather than
 * rewriting or raising an error that would abort a run (requirement 1). See
 * `rawTree.ts` for how the write-once and hash-verification guarantees are
 * implemented.
 *
 * Cross-checks the written sha256 against the adapter's own claimed
 * `acquired.manifest.contentHash`: an adapter that mis-hashed its own bytes
 * is exactly the kind of bug provenance exists to catch, not a reason to
 * store the bytes under a path some other code goes on to trust as if the
 * two hashes agreed.
 */
export function persistAcquiredDocument(
  rawTreeRoot: string,
  acquired: AcquiredDocument,
  extractedText: string | null = null,
): PersistedAcquisition {
  const documentWrite = writeRawDocument(rawTreeRoot, acquired.bytes);
  if (documentWrite.sha256 !== acquired.manifest.contentHash) {
    throw new Error(
      `acquired document's manifest hash ${acquired.manifest.contentHash} does not match ` +
        `its bytes' actual sha256 ${documentWrite.sha256}; refusing to persist a document ` +
        "whose adapter mis-reported its own content hash",
    );
  }
  const textWrite =
    extractedText === null ? null : writeRetainedText(rawTreeRoot, extractedText);
  return {
    filePath: documentWrite.path,
    textPath: textWrite?.path ?? null,
    documentWrite,
    textWrite,
  };
}

/**
 * Records the retained-text path on the `documents` row already imported for
 * `sha256` (the same content hash `persistAcquiredDocument` just verified),
 * so `get_evidence` can return it. A direct, targeted `UPDATE` rather than a
 * new field threaded through `ImportDocument`/`importBatch` -- importer.ts's
 * insert is out of this task's scope -- so this can run any time after the
 * matching `documents` row exists: immediately after import, or later, for a
 * document whose text is extracted after the fact.
 */
export function recordRetainedTextPath(
  db: DatabaseSync,
  sha256: string,
  textPath: string,
): void {
  const result = db
    .prepare("UPDATE documents SET text_path = ? WHERE sha256 = ?")
    .run(textPath, sha256);
  if (result.changes === 0) {
    throw new Error(
      `no documents row with sha256 ${sha256}; import the document before recording its retained text path`,
    );
  }
}
