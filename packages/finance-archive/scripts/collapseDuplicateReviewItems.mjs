#!/usr/bin/env node
// F1-65. Collapses `review_items` rows that already duplicate each other on
// (kind, source_document_id, source_locator, raw_value) -- the identity
// `review_items_dedupe_key` (pgSchema.ts migration version 7) makes unique
// going forward, and the one `importer.ts`'s buffered insert now checks
// before writing (see `flushReviews`). Neither of those stops a document
// already reparsed before this shipped from having piled up duplicates on a
// live archive: one hosted reparse of 854 already-imported statements opened
// 76,687 review items, 84,266 of them exact duplicates by this key.
//
// Must run against a live archive BEFORE migration 7 is applied. CREATE
// UNIQUE INDEX refuses outright, with a message pointing back at this
// script, if the table still holds rows that would violate it -- see
// REVIEW_ITEMS_DEDUPE_KEY's DO block in pgSchema.ts, which runs the identical
// duplicate check this script does.
//
// Scope: only groups where both source_document_id and source_locator are
// non-null, exactly what the partial index covers. An item with either null
// -- every item from before PR137, and every pull-level item
// adapterImport.ts's `flushInstruments` still writes today -- has no stable
// identity across pulls to call two occurrences "the same one," and this
// script does not touch them: collapsing them would be guessing, and ground
// rule 5 is the rule against exactly that.
//
// Which row survives a group: whichever already carries a `resolved_at` (a
// person's own review work), so collapsing never turns a resolved item back
// into an open one. Among ties -- every row in the group still open, or more
// than one already resolved -- the lowest id: `review_items` carries no
// created_at to break the tie on, and a UUID primary key is at least a
// stable, deterministic order, not a chronological one.
//
// Idempotent: a second run finds no remaining duplicate group and deletes
// nothing.
//
// Usage (development-first: point this at a throwaway database before a
// hosted one, same as scripts/backfillHoldingRowHash.mjs):
//
//   FINANCE_ARCHIVE_DATABASE_URL=postgresql://<owner>@<host>/<db> \
//     node scripts/collapseDuplicateReviewItems.mjs [--dry-run]

import { parseArgs } from "node:util";

import {
  archiveDatabaseUrl,
  archiveSchemaName,
  createArchiveClient,
  lockArchiveForWrite,
  withArchiveTransaction,
} from "../dist/pgStore.js";

/**
 * Finds every duplicate group and deletes every row but the survivor,
 * against an already-connected archive client. `dryRun` still finds and
 * reports every group, but writes nothing.
 *
 * Exported so `test/collapseDuplicateReviewItems.test.mjs` can drive it
 * directly against a throwaway schema instead of shelling out to this file.
 */
export async function collapseDuplicateReviewItems(
  client,
  { dryRun = false } = {},
) {
  return withArchiveTransaction(client, async (tx) => {
    await lockArchiveForWrite(tx);

    // One query finds every group and, within it, orders candidates
    // resolved-first then by id -- the same rule the doc comment above
    // states -- so the survivor is always `ids[0]` and everything after it
    // in the array is what gets deleted.
    const groups = await tx.query(
      `SELECT kind,
              array_agg(id ORDER BY (resolved_at IS NULL), id) AS ids
         FROM review_items
        WHERE source_document_id IS NOT NULL AND source_locator IS NOT NULL
        GROUP BY kind, source_document_id, source_locator, raw_value
       HAVING count(*) > 1`,
    );

    const deletedByKind = {};
    const toDelete = [];
    for (const row of groups.rows) {
      const [, ...duplicates] = row.ids;
      if (duplicates.length === 0) continue;
      deletedByKind[row.kind] = (deletedByKind[row.kind] ?? 0) + duplicates.length;
      toDelete.push(...duplicates);
    }

    if (!dryRun && toDelete.length > 0) {
      await tx.query("DELETE FROM review_items WHERE id = ANY($1::text[])", [
        toDelete,
      ]);
    }

    return {
      groups: groups.rows.length,
      deleted: toDelete.length,
      deletedByKind,
      deletedIds: toDelete,
    };
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
    const report = await collapseDuplicateReviewItems(client, { dryRun });
    console.log(
      `mode: collapseDuplicateReviewItems${dryRun ? " (dry run)" : ""}`,
    );
    console.log(`duplicate groups found: ${report.groups}`);
    console.log(
      `rows ${dryRun ? "that would be deleted" : "deleted"}: ${report.deleted}`,
    );
    for (const [kind, count] of Object.entries(report.deletedByKind).sort()) {
      console.log(`  ${kind}: ${count}`);
    }
    if (report.groups === 0) {
      console.log("nothing to collapse; the unique index migration can proceed");
    } else if (dryRun) {
      console.log(
        "re-run without --dry-run to delete these rows, then apply the schema migration",
      );
    } else {
      console.log("done; the unique index migration can now proceed");
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
