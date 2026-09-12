// F1-65. scripts/collapseDuplicateReviewItems.mjs against a real, throwaway
// archive: it must find every group duplicated on (kind, source_document_id,
// source_locator, raw_value), keep the right survivor, print counts per
// kind, and leave alone everything the dedupe key does not cover (a null
// document or a null locator). A dry run must report the same groups and
// write nothing.
//
// Built at schema version 6, one migration short of
// `review_items_dedupe_key` (pgSchema.ts): that index is exactly what would
// refuse the duplicate rows this suite seeds, so the archive under test is
// built one migration at a time rather than through the shared `archive()`
// helper, which always applies the current schema in full. The migration
// test in pgSchema.test.mjs covers the index itself and the two working
// together.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createArchiveClient,
  PG_MIGRATIONS,
} from "../dist/index.js";

import { collapseDuplicateReviewItems } from "../scripts/collapseDuplicateReviewItems.mjs";

import { all, one, skip, testSchemaName } from "./helpers/pgArchive.mjs";

const url = process.env.FINANCE_ARCHIVE_DATABASE_URL;

/** Every migration except `review_items_dedupe_key`, applied one at a time
 * against a fresh schema: a live archive the night before F1-65 ships. */
async function archiveBeforeDedupeIndex(t) {
  const schema = testSchemaName();
  const client = createArchiveClient(url, schema);
  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(
    `CREATE TABLE ${schema}.schema_version (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  for (const migration of PG_MIGRATIONS.slice(0, -1)) {
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO ${schema}.schema_version (version, name) VALUES ($1, $2)`,
      [migration.version, migration.name],
    );
  }
  t.after(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  });
  return client;
}

async function seed(client) {
  await client.query(
    "INSERT INTO institutions (id, name, slug) VALUES ('inst-1', 'Thistlebrook Trust', 'thistlebrook')",
  );
  await client.query(
    `INSERT INTO documents (id, institution_id, doc_type, doc_date, file_path, sha256)
     VALUES ('doc-1', 'inst-1', 'activity_pull', DATE '2026-03-04', '/raw/doc-1', $1)`,
    ["c".repeat(64)],
  );
}

test(
  "collapseDuplicateReviewItems deletes every duplicate but the resolved survivor, and leaves null-pointer legacy items alone",
  { skip },
  async (t) => {
    const client = await archiveBeforeDedupeIndex(t);
    await seed(client);

    // Three duplicates on the same key: two still open, one already
    // resolved by a person. The resolved one must survive -- collapsing
    // must never turn a resolved item back into an open one.
    await client.query(
      `INSERT INTO review_items
         (id, kind, source_document_id, source_locator, raw_value, reason, status, resolved_at, resolution_note)
       VALUES
         ('open-1', 'weak_instrument_match', 'doc-1', 'row:1', 'ZZZ', 'first open', 'open', NULL, NULL),
         ('resolved-1', 'weak_instrument_match', 'doc-1', 'row:1', 'ZZZ', 'a person looked at this', 'resolved',
            '2026-06-01T00:00:00Z', 'confirmed correct'),
         ('open-2', 'weak_instrument_match', 'doc-1', 'row:1', 'ZZZ', 'second open', 'open', NULL, NULL)`,
    );

    // A second, unrelated duplicate group, different kind: counts must be
    // reported per kind, not lumped together.
    await client.query(
      `INSERT INTO review_items (id, kind, source_document_id, source_locator, raw_value, reason)
       VALUES
         ('undeclared-1', 'undeclared_activity_type', 'doc-1', 'row:2', 'unknown_type', 'not declared'),
         ('undeclared-2', 'undeclared_activity_type', 'doc-1', 'row:2', 'unknown_type', 'not declared')`,
    );

    // Legacy, pre-PR137 shape: both source_document_id and source_locator
    // null. Content-identical, but with no document or locator to say two
    // occurrences are "the same one" -- the dedupe key does not cover these,
    // and neither does this script.
    await client.query(
      `INSERT INTO review_items (id, kind, raw_value, reason)
       VALUES
         ('legacy-1', 'weak_instrument_match', 'ZZZ', 'pre-PR137, no document'),
         ('legacy-2', 'weak_instrument_match', 'ZZZ', 'pre-PR137, no document')`,
    );

    // A document-scoped item with no locator (every item
    // `AdapterReviewItem` produces today -- adapterImport.ts never carries
    // one). Same story: not covered by the dedupe key, not touched here.
    await client.query(
      `INSERT INTO review_items (id, kind, source_document_id, raw_value, reason)
       VALUES
         ('nulllocator-1', 'undeclared_activity_type', 'doc-1', 'other_type', 'not declared'),
         ('nulllocator-2', 'undeclared_activity_type', 'doc-1', 'other_type', 'not declared')`,
    );

    // A dry run reports the same groups and writes nothing.
    const dryRun = await collapseDuplicateReviewItems(client, { dryRun: true });
    assert.equal(dryRun.groups, 2);
    assert.equal(dryRun.deleted, 3);
    assert.deepEqual(dryRun.deletedByKind, {
      weak_instrument_match: 2,
      undeclared_activity_type: 1,
    });
    const beforeCount = await one(
      client,
      "SELECT count(*)::text AS n FROM review_items",
    );
    assert.equal(beforeCount.n, "9", "dry run must not have deleted anything");

    const report = await collapseDuplicateReviewItems(client, { dryRun: false });
    assert.equal(report.groups, 2);
    assert.equal(report.deleted, 3);
    assert.deepEqual(report.deletedByKind, {
      weak_instrument_match: 2,
      undeclared_activity_type: 1,
    });

    const remaining = (await all(client, "SELECT id FROM review_items ORDER BY id")).map(
      (r) => r.id,
    );
    assert.deepEqual(remaining, [
      "legacy-1",
      "legacy-2",
      "nulllocator-1",
      "nulllocator-2",
      "resolved-1",
      "undeclared-1",
    ].sort());

    // The resolved item survived, not one of the open duplicates.
    const survivor = await one(
      client,
      "SELECT status, resolution_note FROM review_items WHERE id = 'resolved-1'",
    );
    assert.equal(survivor.status, "resolved");
    assert.equal(survivor.resolution_note, "confirmed correct");

    // Idempotent: nothing left to collapse, so a second run deletes nothing.
    const second = await collapseDuplicateReviewItems(client, { dryRun: false });
    assert.equal(second.groups, 0);
    assert.equal(second.deleted, 0);
    assert.deepEqual(second.deletedByKind, {});
  },
);

test(
  "collapseDuplicateReviewItems keeps the lowest id when no candidate in a group is resolved",
  { skip },
  async (t) => {
    const client = await archiveBeforeDedupeIndex(t);
    await seed(client);

    await client.query(
      `INSERT INTO review_items (id, kind, source_document_id, source_locator, raw_value, reason)
       VALUES
         ('b-open', 'weak_instrument_match', 'doc-1', 'row:1', 'ZZZ', 'second'),
         ('a-open', 'weak_instrument_match', 'doc-1', 'row:1', 'ZZZ', 'first'),
         ('c-open', 'weak_instrument_match', 'doc-1', 'row:1', 'ZZZ', 'third')`,
    );

    const report = await collapseDuplicateReviewItems(client, { dryRun: false });
    assert.equal(report.deleted, 2);

    const remaining = await all(client, "SELECT id FROM review_items");
    assert.deepEqual(
      remaining.map((r) => r.id),
      ["a-open"],
      "lowest id survives when nothing in the group is resolved",
    );
  },
);
