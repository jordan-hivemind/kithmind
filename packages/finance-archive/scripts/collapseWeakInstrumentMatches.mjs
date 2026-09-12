#!/usr/bin/env node
// F1-58. Collapses `weak_instrument_match` review items -- one row per
// (institution, descriptor, matched instrument) with an occurrence count and
// first/last-seen document ids -- from the previous row-per-statement shape:
// every monthly statement re-lists the same instruments, so what used to be
// one review item per document became one item per (institution, descriptor,
// matched instrument) restated across however many statements mention it.
// The owner's archive holds 73,247 open weak_instrument_match items with
// document pointers, one per holding per statement.
//
// Must run after pgSchema.ts migration 8 (`institution_id`,
// `matched_instrument_id`, `occurrence_count`, `last_seen_document_id` on
// `review_items`) has been applied. That migration is safe to apply first
// on any archive: the four new columns start out NULL for every existing
// row, and a NULL never collides with another NULL under
// `review_items_weak_instrument_match_key`'s partial unique index -- so
// nothing about applying it requires this script to have run yet. This
// script is what actually populates those columns for the rows that
// predate them, the same order `backfillHoldingRowHash.mjs` follows
// `HOLDING_ROW_HASH` (pgSchema.ts).
//
// Every open weak_instrument_match row that already carries a document
// (`source_document_id IS NOT NULL` -- the same scope
// `collapseDuplicateReviewItems.mjs` uses) is grouped by
// (institution, raw_value, matched instrument). `institution` and `matched
// instrument` are read directly off the row when this script has already
// populated them (a second, idempotent run); for a row it has not touched
// yet, both are derived the only way they are available at all: institution
// via the row's own document, matched instrument by parsing it back out of
// `reason` ("...to existing instrument <id>..." -- the only place
// `resolveInstrumentId`/`prefetchInstruments` in adapterImport.ts ever wrote
// it before this migration added a real column for it). A row whose
// `reason` does not match that shape is left untouched and reported as
// unparseable rather than guessed at (ground rule 5): its own group cannot
// be determined, so collapsing it would risk merging it into the wrong one.
//
// One survivor per group -- the lowest id, the same deterministic tie-break
// `collapseDuplicateReviewItems.mjs` uses -- gets `occurrence_count` set to
// the sum of every row in the group's own count (1 for a row this script has
// never touched), `source_document_id` set to the earliest sighting and
// `last_seen_document_id` to the most recent, ordered by document date where
// the document has one and by document id otherwise. Every other row in the
// group is deleted. Resolved and dismissed items are never read, grouped, or
// touched: a person's own decision about a descriptor is not something a
// bulk collapse should ever move, count, or reopen.
//
// Idempotent: a second run finds every remaining group already of size one,
// already carrying the columns this script would have set, and changes
// nothing.
//
// Usage (development-first: point this at a throwaway database before a
// hosted one, same as scripts/collapseDuplicateReviewItems.mjs):
//
//   FINANCE_ARCHIVE_DATABASE_URL=postgresql://<owner>@<host>/<db> \
//     node scripts/collapseWeakInstrumentMatches.mjs --dry-run
//   FINANCE_ARCHIVE_DATABASE_URL=postgresql://<owner>@<host>/<db> \
//     node scripts/collapseWeakInstrumentMatches.mjs

import { parseArgs } from "node:util";

import {
  archiveDatabaseUrl,
  archiveSchemaName,
  createArchiveClient,
  lockArchiveForWrite,
  withArchiveTransaction,
} from "../dist/pgStore.js";

/** Matches `prefetchInstruments`' own weak-match reason text
 * (adapterImport.ts): "...to existing instrument <id> (cusip=...". The
 * instrument id is a UUID, so it never contains whitespace or `(`. */
const MATCHED_INSTRUMENT_IN_REASON = /to existing instrument (\S+)/;

function parseMatchedInstrumentId(reason) {
  const match = MATCHED_INSTRUMENT_IN_REASON.exec(reason ?? "");
  if (!match) return null;
  // Trims a trailing "(" or punctuation the regex's \S+ over-captured up to
  // the next space -- the reason text always follows the id with
  // " (cusip=...", so this only ever strips that opening paren.
  return match[1].replace(/[(),;]+$/, "");
}

/** Orders two (documentId, docDate) candidates by date when both have one,
 * falling back to the document id -- the same "by document date if
 * available, else ids" rule the task requires, applied consistently for
 * both the earliest and the latest candidate in a group. */
function compareOccurrence(a, b) {
  if (a.date !== null && b.date !== null && a.date !== b.date) {
    return a.date < b.date ? -1 : 1;
  }
  if (a.docId === b.docId) return 0;
  return a.docId < b.docId ? -1 : 1;
}

/**
 * Finds every open `weak_instrument_match` group and collapses it to one
 * survivor, against an already-connected archive client. `dryRun` still
 * finds and reports every group, but writes nothing.
 *
 * Exported so `test/collapseWeakInstrumentMatches.test.mjs` can drive it
 * directly against a throwaway schema instead of shelling out to this file.
 */
export async function collapseWeakInstrumentMatches(
  client,
  { dryRun = false } = {},
) {
  return withArchiveTransaction(client, async (tx) => {
    await lockArchiveForWrite(tx);

    const { rows } = await tx.query(
      `SELECT ri.id, ri.raw_value, ri.reason,
              ri.institution_id, ri.matched_instrument_id, ri.occurrence_count,
              ri.source_document_id, ri.last_seen_document_id,
              d.institution_id AS doc_institution_id, d.doc_date AS source_doc_date,
              ld.doc_date AS last_doc_date
         FROM review_items ri
         JOIN documents d ON d.id = ri.source_document_id
         LEFT JOIN documents ld ON ld.id = ri.last_seen_document_id
        WHERE ri.kind = 'weak_instrument_match' AND ri.status = 'open'`,
    );

    const groups = new Map();
    let unparseable = 0;
    for (const row of rows) {
      const institutionId = row.institution_id ?? row.doc_institution_id;
      const matchedInstrumentId =
        row.matched_instrument_id ?? parseMatchedInstrumentId(row.reason);
      if (matchedInstrumentId === null) {
        unparseable += 1;
        continue;
      }
      const key = JSON.stringify([institutionId, row.raw_value, matchedInstrumentId]);
      let group = groups.get(key);
      if (!group) {
        group = { institutionId, rawValue: row.raw_value, matchedInstrumentId, rows: [] };
        groups.set(key, group);
      }
      group.rows.push({
        id: row.id,
        occurrenceCount: row.occurrence_count ?? 1,
        first: { docId: row.source_document_id, date: row.source_doc_date },
        last: row.last_seen_document_id
          ? { docId: row.last_seen_document_id, date: row.last_doc_date }
          : { docId: row.source_document_id, date: row.source_doc_date },
      });
    }

    let survivors = 0;
    let deleted = 0;
    for (const group of groups.values()) {
      const occurrenceCount = group.rows.reduce(
        (sum, row) => sum + row.occurrenceCount,
        0,
      );
      const first = group.rows
        .map((row) => row.first)
        .sort(compareOccurrence)[0];
      const last = group.rows
        .map((row) => row.last)
        .sort((a, b) => compareOccurrence(b, a))[0];
      // Deterministic tie-break, the same rule
      // collapseDuplicateReviewItems.mjs uses: no created_at to order by, so
      // the lowest id is at least stable.
      const survivorId = [...group.rows].map((row) => row.id).sort()[0];
      const toDelete = group.rows
        .map((row) => row.id)
        .filter((id) => id !== survivorId);

      if (!dryRun) {
        // Delete the other rows in the group before moving the survivor's
        // own source_document_id: review_items_dedupe_key (migration 7) is
        // still keyed on (kind, source_document_id, locator, raw_value), and
        // the survivor's new source_document_id (the group's earliest
        // sighting) can be the exact document another still-present row in
        // this same group already carries. Deleting first means that
        // document is only ever claimed by one row at a time.
        if (toDelete.length > 0) {
          await tx.query("DELETE FROM review_items WHERE id = ANY($1::text[])", [
            toDelete,
          ]);
        }
        await tx.query(
          `UPDATE review_items
              SET institution_id = $2, matched_instrument_id = $3,
                  occurrence_count = $4, source_document_id = $5,
                  last_seen_document_id = $6
            WHERE id = $1`,
          [
            survivorId,
            group.institutionId,
            group.matchedInstrumentId,
            occurrenceCount,
            first.docId,
            last.docId,
          ],
        );
      }
      survivors += 1;
      deleted += toDelete.length;
    }

    return { groups: groups.size, survivors, deleted, unparseable };
  });
}

async function main() {
  const { values } = parseArgs({
    options: { "dry-run": { type: "boolean", default: false } },
  });
  const dryRun = values["dry-run"] === true;

  const url = archiveDatabaseUrl();
  const schema = archiveSchemaName();
  const client = createArchiveClient(url, schema);
  await client.connect();
  try {
    const report = await collapseWeakInstrumentMatches(client, { dryRun });
    console.log(
      `mode: collapseWeakInstrumentMatches${dryRun ? " (dry run)" : ""}`,
    );
    console.log(`instrument-level groups: ${report.groups}`);
    console.log(
      `rows ${dryRun ? "that would be" : ""} kept as survivors: ${report.survivors}`,
    );
    console.log(`rows ${dryRun ? "that would be deleted" : "deleted"}: ${report.deleted}`);
    if (report.unparseable > 0) {
      console.log(
        `rows left untouched (matched instrument could not be determined): ${report.unparseable}`,
      );
    }
    if (report.groups === 0) {
      console.log("nothing to collapse");
    } else if (dryRun) {
      console.log("re-run without --dry-run to collapse these groups");
    } else {
      console.log("done");
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
