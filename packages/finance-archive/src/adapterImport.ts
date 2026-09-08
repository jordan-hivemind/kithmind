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

import type {
  AcquiredDocument,
  ParsedBalance,
  ParsedHoldings,
  ParsedInstrument,
  ParsedLiability,
  ParsedPosition,
  ParsedRow,
} from "./adapter.js";
import { EMPTY_HOLDINGS, sha256Hex } from "./adapter.js";
import {
  type CaptureWriteResult,
  writeCaptureManifest,
} from "./captures.js";
import { canonicalizeDecimal } from "./decimal.js";
import type {
  ImportBalance,
  ImportDocument,
  ImportLiability,
  ImportPosition,
  ImportRow,
} from "./importer.js";
import { toMinorUnits } from "./money.js";
import { toNumericText } from "./pgNumeric.js";
import type { ArchiveClient } from "./pgStore.js";
import {
  type RawTreeWriteResult,
  writeRawDocument,
  writeRetainedText,
} from "./rawTree.js";
import { retainPayload } from "./retention.js";
import { contentKeyV2, rowHashV2 } from "./rowHash.js";

/**
 * One acquired-and-parsed pull, ready to become one or more `ImportDocument`s.
 * `persisted` is the raw tree's own record of where this pull's bytes (and
 * any retained text) actually live -- the *only* way to get one is to call
 * `persistAcquiredDocument` first, which is what makes it structurally
 * impossible to build an `AdapterPull` around a `filePath` nothing ever
 * wrote (this is exactly the bug F1-18 exists to fix; see
 * `persistAcquiredDocument`'s doc comment below).
 *
 * `holdings` defaults to `EMPTY_HOLDINGS` when omitted: most pulls (every
 * paginated activity feed, every tabular export) carry none, and a caller
 * building one from an activity-only adapter's `parse()` output does not
 * need to spell that out.
 */
export type AdapterPull = {
  readonly institutionId: string;
  readonly accountId: string;
  readonly acquired: AcquiredDocument;
  readonly rows: readonly ParsedRow[];
  readonly holdings?: ParsedHoldings;
  readonly docType: string;
  readonly docDate: string | null;
  readonly persisted: PersistedAcquisition;
};

type ReviewItemFields = {
  kind: string;
  accountId: string | null;
  rawValue: string | null;
  reason: string;
};

async function openReviewItem(
  client: ArchiveClient,
  fields: ReviewItemFields,
): Promise<void> {
  await client.query(
    `INSERT INTO review_items (id, kind, account_id, source_document_id, source_locator, raw_value, reason)
     VALUES ($1, $2, $3, NULL, NULL, $4, $5)`,
    [
      randomUUID(),
      fields.kind,
      fields.accountId,
      fields.rawValue,
      fields.reason,
    ],
  );
}

/**
 * The SQLite-handle counterpart, still used by the raw-tree persistence half
 * of this file below. F1-24 owns that half and is moving it in parallel; when
 * it lands on the archive client this function goes with it.
 */
function insertReviewItem(db: DatabaseSync, fields: ReviewItemFields): void {
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
export async function resolveInstrumentId(
  client: ArchiveClient,
  instrument: ParsedInstrument,
): Promise<string> {
  if (instrument.cusip) {
    return findOrCreateInstrument(
      client,
      "cusip",
      instrument.cusip,
      instrument,
    );
  }
  if (instrument.isin) {
    return findOrCreateInstrument(client, "isin", instrument.isin, instrument);
  }
  if (instrument.symbol && instrument.name) {
    const found = await client.query<{ id: string }>(
      "SELECT id FROM instruments WHERE symbol = $1 AND name = $2",
      [instrument.symbol, instrument.name],
    );
    const existing = found.rows[0];
    if (existing) return existing.id;
  }
  if (instrument.symbol) {
    // ponytail: ctid orders by physical position, which for this
    // insert-only table is insertion order, so this is the first instrument
    // row created for this symbol. A rewrite (VACUUM FULL, a future UPDATE)
    // could reorder it; add an inserted_at column if that ever matters.
    // Either way it is a naive heuristic -- there is no way to know if it is
    // the *right* row without a stronger identifier -- which is exactly why
    // the match is flagged for review rather than trusted silently.
    const found = await client.query<{
      id: string;
      cusip: string | null;
      isin: string | null;
      name: string | null;
    }>(
      "SELECT id, cusip, isin, name FROM instruments WHERE symbol = $1 ORDER BY ctid LIMIT 1",
      [instrument.symbol],
    );
    const weak = found.rows[0];
    if (weak) {
      await openReviewItem(client, {
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
  return insertInstrument(client, instrument);
}

async function findOrCreateInstrument(
  client: ArchiveClient,
  column: "cusip" | "isin",
  value: string,
  instrument: ParsedInstrument,
): Promise<string> {
  // The column name is one of two literals chosen by this file, never caller
  // input, so it is safe to interpolate where a placeholder cannot go.
  const found = await client.query<{ id: string }>(
    `SELECT id FROM instruments WHERE ${column} = $1`,
    [value],
  );
  const existing = found.rows[0];
  if (existing) return existing.id;
  return insertInstrument(client, instrument);
}

async function insertInstrument(
  client: ArchiveClient,
  instrument: ParsedInstrument,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    "INSERT INTO instruments (id, symbol, cusip, isin, name) VALUES ($1, $2, $3, $4, $5)",
    [id, instrument.symbol, instrument.cusip, instrument.isin, instrument.name],
  );
  return id;
}

async function parsedRowToImportRow(
  client: ArchiveClient,
  accountId: string,
  row: ParsedRow,
): Promise<ImportRow> {
  return {
    accountId,
    tradeDate: row.tradeDate,
    processDate: row.processDate,
    settleDate: row.settleDate,
    datePrecision: row.datePrecision,
    activityType: row.activityType,
    description: row.description,
    instrumentId:
      row.instrument === null
        ? null
        : await resolveInstrumentId(client, row.instrument),
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

/**
 * Maps one parsed holding to the importer's row shape. `sourceDocument` is
 * used only for grouping (see `groupBySourceDocument`) and does not appear
 * on the `Import*` row itself, the same way `ParsedRow.sourceDocument`
 * never reaches `ImportRow` -- the document it belongs to is expressed by
 * which `ImportDocument` the row ends up on, not a field on the row.
 */
async function parsedPositionToImportPosition(
  client: ArchiveClient,
  position: ParsedPosition,
): Promise<ImportPosition> {
  return {
    asOf: position.asOf,
    instrumentId:
      position.instrument === null
        ? null
        : await resolveInstrumentId(client, position.instrument),
    quantity: position.quantity,
    price: position.price,
    marketValueText: position.marketValue,
    marketValueNote: position.marketValueNote,
    costBasis: position.costBasis,
    unrealized: position.unrealized,
    currency: position.currency,
    valuationBasis: position.valuationBasis,
    valuationNote: position.valuationNote,
    sourceLocator: JSON.stringify(position.locators),
  };
}

function parsedBalanceToImportBalance(balance: ParsedBalance): ImportBalance {
  return {
    asOf: balance.asOf,
    totalValueText: balance.totalValue,
    totalValueNote: balance.totalValueNote,
    cash: balance.cash,
    currency: balance.currency,
    periodStartValue: balance.periodStartValue,
    periodEndValue: balance.periodEndValue,
    sourceLocator: JSON.stringify(balance.locators),
  };
}

function parsedLiabilityToImportLiability(
  liability: ParsedLiability,
): ImportLiability {
  return {
    kind: liability.kind,
    displayName: liability.displayName,
    balanceText: liability.balance,
    balanceNote: liability.balanceNote,
    currency: liability.currency,
    rate: liability.rate,
    asOf: liability.asOf,
    collateralNote: liability.collateralNote,
    sourceLocator: JSON.stringify(liability.locators),
  };
}

/**
 * Groups rows by `sourceDocument`, preserving first-seen order and each
 * row's own order within its group. Shared by activity rows and every
 * holdings row type, all four of which carry `sourceDocument` for exactly
 * this reason (see `ParsedRow.sourceDocument`'s doc comment).
 */
function groupBySourceDocument<T extends { readonly sourceDocument: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.sourceDocument);
    if (group) group.push(row);
    else groups.set(row.sourceDocument, [row]);
  }
  return groups;
}

/** `Array.map` for an async mapper, one at a time and in order. */
async function mapSeries<T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await map(item));
  return out;
}

/**
 * How many distinct transactions this pull's rows reduce to once each
 * page-document's own occurrence ordinal is applied, i.e. exactly the count
 * `importBatch` will insert for this pull if nothing else collides with an
 * earlier import. Computed with `contentKeyV2` and `rowHashV2` -- the same
 * pair `importer.ts` uses, in the same order, over the same normalized values
 * -- so this count is never allowed to drift from what the importer actually
 * does. Using one version's key with the other's hash is the specific way
 * this goes silently wrong, so the two are always taken together. Works with
 * or without provider transaction ids: unlike an id-based count, it cannot go
 * silent just because a source has none.
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
      let amount: string | null = null;
      if (row.amount !== null) {
        try {
          // Both of the importer's checks, in the importer's order: the
          // minor-unit check for ambiguous money, then canonicalization to
          // the decimal that is stored and hashed. A value failing either
          // becomes NULL on import (ground rule 5), so NULL is what belongs
          // in the hash here as well.
          toMinorUnits(row.amount, row.currency);
          amount = toNumericText(row.amount);
        } catch {
          // Ambiguous money: importBatch stores NULL for this too.
        }
      }
      let quantity: string | null = null;
      if (row.quantity !== null) {
        try {
          quantity = toNumericText(row.quantity);
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
      const key = contentKeyV2(content);
      const occurrence = (occurrences.get(key) ?? 0) + 1;
      occurrences.set(key, occurrence);
      hashes.add(rowHashV2({ ...content, occurrence }));
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
 *
 * Holdings (`pull.holdings`) are grouped and attached to `ImportDocument`s
 * the same way activity rows are, each `ParsedPosition`/`ParsedBalance`/
 * `ParsedLiability` carrying its own `sourceDocument` so a holding lands on
 * the right document even when a pull's activity is paginated and its
 * holdings are not (the normal case: a statement's positions table is never
 * itself paginated). Ground rule 7's provider-total check above stays scoped
 * to activity rows -- `reportedRowCount` is a transaction-row count, and
 * holdings have no analogous provider total to reconcile against.
 */
export async function adapterPullToImportDocuments(
  client: ArchiveClient,
  pull: AdapterPull,
): Promise<ImportDocument[]> {
  const activityGroups = groupBySourceDocument(pull.rows);
  const holdings = pull.holdings ?? EMPTY_HOLDINGS;
  const positionGroups = groupBySourceDocument(holdings.positions);
  const balanceGroups = groupBySourceDocument(holdings.balances);
  const liabilityGroups = groupBySourceDocument(holdings.liabilities);
  const reportedRowCount = pull.acquired.manifest.reportedRowCount;

  if (activityGroups.size > 1) {
    if (reportedRowCount === null) {
      await openReviewItem(client, {
        kind: "unverified_pagination_total",
        accountId: pull.accountId,
        rawValue: pull.acquired.manifest.contentHash,
        reason:
          `paginated pull split into ${activityGroups.size} page document(s), but the provider ` +
          "reported no total for this pull; completeness cannot be asserted (ground rule 7) " +
          "without a stated total to reconcile against -- treat this pull as unverified",
      });
    } else {
      const distinct = countDistinctRowHashes(pull.accountId, activityGroups);
      if (distinct !== reportedRowCount) {
        throw new Error(
          `adapter pull reported ${reportedRowCount} unique row(s) but ${distinct} distinct ` +
            `row(s) remain after per-document dedup across ${activityGroups.size} page document(s); ` +
            "refusing to import a pull that does not reconcile against the provider's total " +
            "(ground rule 7)",
        );
      }
    }
  }

  const sourceDocuments = new Set<string>([
    ...activityGroups.keys(),
    ...positionGroups.keys(),
    ...balanceGroups.keys(),
    ...liabilityGroups.keys(),
  ]);
  const single = sourceDocuments.size === 1;

  const documents: ImportDocument[] = [];
  for (const sourceDocument of sourceDocuments) {
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
      filePath: single
        ? pull.persisted.filePath
        : `${pull.persisted.filePath}#${sourceDocument}`,
      institutionId: pull.institutionId,
      accountId: pull.accountId,
      docType: pull.docType,
      docDate: pull.docDate,
      providerReportedCount: single ? reportedRowCount : null,
      // Sequential rather than concurrent on purpose: instrument resolution
      // creates rows, and two rows for the same new instrument resolved in
      // parallel would each fail to find it and mint a second id.
      rows: await mapSeries(activityGroups.get(sourceDocument) ?? [], (row) =>
        parsedRowToImportRow(client, pull.accountId, row),
      ),
      positions: await mapSeries(
        positionGroups.get(sourceDocument) ?? [],
        (position) => parsedPositionToImportPosition(client, position),
      ),
      balances: (balanceGroups.get(sourceDocument) ?? []).map(
        parsedBalanceToImportBalance,
      ),
      liabilities: (liabilityGroups.get(sourceDocument) ?? []).map(
        parsedLiabilityToImportLiability,
      ),
    });
  }
  return documents;
}

// --- F1-18: raw tree persistence -------------------------------------------
// `acquire` (adapter.ts) returns bytes and a manifest; nothing before this
// wrote them anywhere. This is the seam: the one place an adapter pull's raw
// bytes (and, when the caller has retained it, the document's extracted
// text) actually get written to the raw tree, before the pull becomes an
// `AdapterPull.persisted`/`ImportDocument.filePath` that `importBatch`
// records on the `documents` row. `persistAcquiredDocument` is also the
// *only* way to produce a `PersistedAcquisition`, which is in turn the only
// way to fill in `AdapterPull.persisted` -- so a caller cannot build an
// `AdapterPull` around an invented path, and cannot skip persisting bytes
// that a document row then claims exist. Self-contained -- it only calls
// into rawTree.ts (bytes) and captures.ts (acquisition provenance, F1-24)
// and does its own small, targeted write to `documents.text_path` -- so it
// does not touch `importer.ts`'s insert statement or any other function in
// this file.

/** Everything needed to persist one acquired document and the capture that
 * produced it: enough for the raw tree's capture manifest (captures.ts) to
 * identify both without the archive database, on top of the acquired bytes
 * themselves. */
export type AcquisitionDescriptor = {
  readonly institutionId: string;
  readonly accountId: string;
  readonly docType: string;
  readonly acquired: AcquiredDocument;
  /** Dot-prefixed (".pdf", ".csv"), when the source gave one. Recorded on
   * the capture manifest only; the raw bytes stay content-addressed and
   * extension-less either way. */
  readonly originalExtension?: string | null;
  /**
   * This acquisition attempt's own idempotency key (F1-24). Two calls with
   * the same `captureId` are two attempts at *one* acquisition -- a retry --
   * and must produce a byte-identical capture manifest; two calls with
   * different `captureId`s are two acquisitions, whether or not the bytes
   * they acquire turn out identical, and both keep their own provenance.
   * Defaults to a fresh random id when omitted, which is correct for any
   * caller that is not itself retrying a specific earlier attempt.
   */
  readonly captureId?: string;
};

/** What `persistAcquiredDocument` wrote and where, for the caller to use as
 * `AdapterPull.persisted` and, after import, as the argument to
 * `recordRetainedTextPath`. */
export type PersistedAcquisition = {
  readonly filePath: string;
  readonly textPath: string | null;
  readonly captureId: string;
  readonly capturePath: string;
  readonly documentWrite: RawTreeWriteResult;
  readonly textWrite: RawTreeWriteResult | null;
  readonly captureWrite: CaptureWriteResult;
};

/**
 * Persists one acquired document's raw bytes -- and, when supplied, its
 * retained extracted text -- to the raw tree rooted at `rawTreeRoot`, along
 * with a capture manifest (captures.ts) recording what this acquisition is:
 * institution, account, document type, statement period, capture time,
 * capability tier, gaps, original extension. That manifest is what makes
 * ground rule 1's "can be rebuilt from scratch" true in practice: the
 * archive database is derived data, so if it is ever lost, the raw tree
 * still says what each capture is well enough to re-import, instead of
 * becoming an unlabelled pile of hashes.
 *
 * F1-24: the document's bytes and the capture that acquired them are two
 * different write-once records now. `writeRawDocument` still keys purely on
 * content, so a second acquisition of byte-identical content never rewrites
 * the bytes; `writeCaptureManifest` keys on `captureId` instead, so that
 * second acquisition's own provenance -- its own time, source, period and
 * retention declaration -- is written as its own capture rather than
 * discarded because the bytes it names already exist. A repeat call with the
 * *same* `captureId` (a retry of one attempt) reports `status:
 * "already_exists"` on `documentWrite`/`textWrite`/`captureWrite`, never a
 * rewrite; reusing a `captureId` for a capture that would hash differently
 * is refused outright (`CaptureConflictError`), never silently overwritten
 * or silently coexisting. See `rawTree.ts` and `captures.ts` for how the
 * write-once and hash-verification guarantees are implemented.
 *
 * F1-23: re-applies the adapter's declared retention projection before
 * anything is hashed or written, and records the resulting
 * `RetentionRecord` on the capture manifest so the retained file is never
 * presented as the untouched provider response. Undeclared source paths that
 * the projection dropped open a `review_items` entry rather than passing
 * unremarked.
 *
 * Cross-checks the written sha256 against the adapter's own claimed
 * `acquired.manifest.contentHash`: an adapter that mis-hashed its own bytes
 * is exactly the kind of bug provenance exists to catch, not a reason to
 * store the bytes under a path some other code goes on to trust as if the
 * two hashes agreed. Institution and account are resolved from the database
 * by id -- both are foreign keys, so a valid id guarantees a real row exists
 * to read the institution's slug and the account's last four digits from,
 * rather than asking every caller to also pass and keep in sync values the
 * database already has authoritatively.
 */
export function persistAcquiredDocument(
  db: DatabaseSync,
  rawTreeRoot: string,
  descriptor: AcquisitionDescriptor,
  extractedText: string | null = null,
): PersistedAcquisition {
  const {
    institutionId,
    accountId,
    docType,
    acquired,
    originalExtension = null,
    captureId = randomUUID(),
  } = descriptor;

  // F1-23. The projection is re-applied here, at the one seam that produces
  // bytes for the raw tree, rather than trusted from the adapter. It is
  // idempotent, so for an adapter that projected correctly this is a no-op
  // that costs one parse; for an adapter that returned the response body, it
  // produces different bytes and the hash cross-check below fails loudly.
  // Combined with `writeRawDocument` accepting only a `RetainedPayload`,
  // there is no path by which an unprojected payload is hashed or written.
  const retained = retainPayload(
    acquired.retention.policy,
    acquired.bytes,
    acquired.manifest.kind,
  );
  if (retained.sha256 !== acquired.manifest.contentHash) {
    throw new Error(
      `acquired document's manifest hash ${acquired.manifest.contentHash} does not match ` +
        `the sha256 ${retained.sha256} of its retained bytes; refusing to persist a document ` +
        "whose adapter mis-reported its own content hash or hashed the provider's response " +
        "instead of the projection it retained",
    );
  }
  const documentWrite = writeRawDocument(rawTreeRoot, retained);
  if (documentWrite.sha256 !== retained.sha256) {
    // The raw tree hashes what it actually wrote. If that disagrees with the
    // projection's own hash, the bytes changed between the two, and the
    // whole point of the content hash is that it is the hash of the file.
    throw new Error(
      `retained bytes hashed ${retained.sha256} but landed on disk as ${documentWrite.sha256}; ` +
        "the content hash must always be the hash of the bytes in the raw tree",
    );
  }

  const institution = db
    .prepare("SELECT slug FROM institutions WHERE id = ?")
    .get(institutionId) as { slug: string } | undefined;
  if (!institution) {
    throw new Error(
      `no institutions row with id ${institutionId}; provision the institution before ` +
        "persisting one of its documents",
    );
  }
  const account = db
    .prepare("SELECT acct_last4 FROM accounts WHERE id = ?")
    .get(accountId) as { acct_last4: string | null } | undefined;
  if (!account) {
    throw new Error(
      `no accounts row with id ${accountId}; provision the account before persisting one of ` +
        "its documents",
    );
  }

  const captureWrite = writeCaptureManifest(rawTreeRoot, {
    captureId,
    documentSha256: documentWrite.sha256,
    institutionSlug: institution.slug,
    acctLast4: account.acct_last4,
    docType,
    periodStart: acquired.manifest.periodStart,
    periodEnd: acquired.manifest.periodEnd,
    capturedAt: acquired.manifest.capturedAt,
    capabilityTier: acquired.manifest.kind,
    gaps: acquired.manifest.gaps,
    originalExtension,
    retention: acquired.retention,
  });

  // A provider field the declaration does not name is dropped, which is the
  // safe outcome, but it is never a *silent* one: the adapter's allowlist has
  // fallen behind the provider's response and someone has to look. Paths
  // only, never values -- a leak report that quotes the leak is not a fix.
  if (acquired.retention.droppedPaths.length > 0) {
    insertReviewItem(db, {
      kind: "retention_dropped_fields",
      accountId,
      rawValue: acquired.retention.droppedPaths.join(" "),
      reason:
        `the retained projection of this document dropped ${acquired.retention.droppedPaths.length} ` +
        `undeclared source path(s) under policy ${JSON.stringify(acquired.retention.policy.version)}; ` +
        "the provider's payload carries fields the adapter does not declare -- confirm none of " +
        "them is business data the archive should be retaining, then extend the declaration",
    });
  }

  const textWrite =
    extractedText === null ? null : writeRetainedText(rawTreeRoot, extractedText);
  return {
    filePath: documentWrite.path,
    textPath: textWrite?.path ?? null,
    captureId,
    capturePath: captureWrite.path,
    documentWrite,
    textWrite,
    captureWrite,
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
