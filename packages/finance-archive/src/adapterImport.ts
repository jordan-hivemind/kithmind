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
import type { ImportDocument, ImportRow } from "./importer.js";

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

/**
 * Resolves a parsed instrument descriptor to a stable `instruments.id`,
 * creating the row the first time it is seen. Identity strength follows the
 * plan: a real identifier is preferred over a symbol, and a symbol alone is
 * never enough to merge two rows, because two different instruments can
 * share a ticker. `cusip` is checked first, then `isin`, then the pair
 * (`symbol`, `name`) together -- never `symbol` alone -- and only when none
 * of those match (or apply) is a new row created.
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
 * Turns one adapter pull into the `ImportDocument`s `importBatch` consumes.
 *
 * A pull that parse() reported as a single document (`sourceDocument`
 * constant across every row -- the normal case for a statement, a
 * confirmation, or a tabular export) becomes one `ImportDocument`, and the
 * pull's own `providerReportedCount` is asserted on it exactly as before.
 *
 * A paginated pull (several distinct `sourceDocument` values) becomes one
 * `ImportDocument` per page, each with its own content hash derived from the
 * pull's immutable content hash plus the page key, so the importer's
 * per-document occurrence ordinal is scoped correctly (ground rule 7 is
 * checked separately here, across the whole pull, using the provider's
 * transaction ids when every row carries one).
 */
export function adapterPullToImportDocuments(
  db: DatabaseSync,
  pull: AdapterPull,
): ImportDocument[] {
  const groups = groupBySourceDocument(pull.rows);
  const reportedRowCount = pull.acquired.manifest.reportedRowCount;

  if (groups.size > 1 && reportedRowCount !== null) {
    assertReportedCountAcrossPages(pull.rows, reportedRowCount, groups.size);
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

/**
 * Ground rule 7 for a pull split across several page-documents: the whole
 * pull must still reconcile against the provider's own reported total, even
 * though no single page-document carries that total anymore. Checked via
 * distinct provider transaction ids, since that is the identity every row
 * of this adapter's paginated tier carries; a source without one cannot be
 * checked here and relies on the per-document invariants alone.
 */
function assertReportedCountAcrossPages(
  rows: readonly ParsedRow[],
  reportedRowCount: number,
  pageCount: number,
): void {
  const externalIds = rows.map((row) => row.externalId);
  if (!externalIds.every((id): id is string => id !== null)) return;
  const distinct = new Set(externalIds).size;
  if (distinct !== reportedRowCount) {
    throw new Error(
      `adapter pull reported ${reportedRowCount} unique row(s) but ${distinct} distinct ` +
        `provider transaction id(s) were parsed across ${pageCount} page document(s); ` +
        "refusing to import a pull that does not reconcile against the provider's total " +
        "(ground rule 7)",
    );
  }
}
