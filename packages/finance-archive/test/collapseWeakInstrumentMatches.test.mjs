// F1-58. scripts/collapseWeakInstrumentMatches.mjs against a real, throwaway
// archive: it must fold every open weak_instrument_match row sharing an
// (institution, descriptor, matched instrument) into one survivor, carrying
// the summed occurrence count and the earliest/latest document, and leave
// resolved items and other kinds alone.

import assert from "node:assert/strict";
import test from "node:test";

import { createArchiveClient } from "../dist/pgStore.js";
import { applyPgSchema } from "../dist/pgSchema.js";

import { collapseWeakInstrumentMatches } from "../scripts/collapseWeakInstrumentMatches.mjs";

import { all, one, skip, testSchemaName } from "./helpers/pgArchive.mjs";

const url = process.env.FINANCE_ARCHIVE_DATABASE_URL;

/** A connected client on a fresh, fully-migrated archive schema. */
async function archive(t) {
  const schema = testSchemaName();
  const client = createArchiveClient(url, schema);
  await client.connect();
  await applyPgSchema(client, schema);
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
    "INSERT INTO instruments (id, symbol) VALUES ('instr-1', 'ZEPHYR'), ('instr-2', 'ZEPHYR')",
  );
  await client.query(
    `INSERT INTO documents (id, institution_id, doc_type, doc_date, file_path, sha256) VALUES
       ('doc-jan', 'inst-1', 'activity_pull', DATE '2026-01-04', '/raw/doc-jan', $1),
       ('doc-feb', 'inst-1', 'activity_pull', DATE '2026-02-04', '/raw/doc-feb', $2),
       ('doc-mar', 'inst-1', 'activity_pull', DATE '2026-03-04', '/raw/doc-mar', $3)`,
    ["a".repeat(64), "b".repeat(64), "c".repeat(64)],
  );
}

test(
  "collapseWeakInstrumentMatches folds legacy per-document rows (matched instrument parsed out of reason) into one survivor with the summed count and first/last document by date",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    // Three legacy rows -- exactly the shape a live archive has before this
    // migration: no institution_id or matched_instrument_id populated, the
    // matched instrument readable only out of the free-text reason, one row
    // per statement that restated the same weak match. Inserted out of
    // chronological order to prove the collapse sorts by document date
    // rather than insertion order.
    await client.query(
      `INSERT INTO review_items (id, kind, source_document_id, raw_value, reason) VALUES
         ('open-feb', 'weak_instrument_match', 'doc-feb', 'ZEPHYR-descriptor',
           'resolved by symbol "ZEPHYR" alone (no cusip, isin, or matching name) to existing instrument instr-1 (cusip=null, isin=null, name=null); confirm or correct this match'),
         ('open-jan', 'weak_instrument_match', 'doc-jan', 'ZEPHYR-descriptor',
           'resolved by symbol "ZEPHYR" alone (no cusip, isin, or matching name) to existing instrument instr-1 (cusip=null, isin=null, name=null); confirm or correct this match'),
         ('open-mar', 'weak_instrument_match', 'doc-mar', 'ZEPHYR-descriptor',
           'resolved by symbol "ZEPHYR" alone (no cusip, isin, or matching name) to existing instrument instr-1 (cusip=null, isin=null, name=null); confirm or correct this match')`,
    );

    const dryRun = await collapseWeakInstrumentMatches(client, { dryRun: true });
    assert.equal(dryRun.groups, 1);
    assert.equal(dryRun.survivors, 1);
    assert.equal(dryRun.deleted, 2);
    assert.equal(dryRun.unparseable, 0);

    const beforeCount = await one(client, "SELECT count(*)::text AS n FROM review_items");
    assert.equal(beforeCount.n, "3", "dry run must not have deleted anything");

    const report = await collapseWeakInstrumentMatches(client, { dryRun: false });
    assert.equal(report.groups, 1);
    assert.equal(report.survivors, 1);
    assert.equal(report.deleted, 2);

    const remaining = await all(
      client,
      "SELECT id, institution_id, matched_instrument_id, occurrence_count, source_document_id, last_seen_document_id FROM review_items",
    );
    assert.equal(remaining.length, 1);
    const survivor = remaining[0];
    assert.equal(survivor.institution_id, "inst-1");
    assert.equal(survivor.matched_instrument_id, "instr-1");
    assert.equal(survivor.occurrence_count, 3);
    assert.equal(survivor.source_document_id, "doc-jan", "earliest by document date");
    assert.equal(survivor.last_seen_document_id, "doc-mar", "latest by document date");

    // Idempotent: a second run finds one row already in the new shape and
    // changes nothing.
    const second = await collapseWeakInstrumentMatches(client, { dryRun: false });
    assert.equal(second.groups, 1);
    assert.equal(second.survivors, 1);
    assert.equal(second.deleted, 0);
    const stillOne = await all(client, "SELECT id, occurrence_count FROM review_items");
    assert.equal(stillOne.length, 1);
    assert.equal(stillOne[0].occurrence_count, 3, "count must not double on a second run");
  },
);

test(
  "collapseWeakInstrumentMatches leaves resolved items, other kinds, and unparseable reasons untouched",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    // A resolved item sharing the same key as two open ones: the person's
    // decision must never be moved, counted, or reopened.
    await client.query(
      `INSERT INTO review_items (id, kind, source_document_id, raw_value, reason, status, resolved_at, resolution_note) VALUES
         ('resolved-1', 'weak_instrument_match', 'doc-jan', 'ZEPHYR-descriptor',
           'resolved by symbol "ZEPHYR" alone to existing instrument instr-1 (cusip=null)', 'resolved',
           '2026-05-01T00:00:00Z', 'confirmed correct')`,
    );

    // An unrelated kind, and a reason this script cannot parse a matched
    // instrument out of: both must be left alone and reported separately.
    await client.query(
      `INSERT INTO review_items (id, kind, source_document_id, raw_value, reason) VALUES
         ('other-kind-1', 'undeclared_activity_type', 'doc-jan', 'wire_fee', 'not a declared activity type'),
         ('unparseable-1', 'weak_instrument_match', 'doc-jan', 'MYSTERY-descriptor', 'no instrument id in this reason at all')`,
    );

    const report = await collapseWeakInstrumentMatches(client, { dryRun: false });
    assert.equal(report.groups, 0, "the resolved item's key never forms an open group");
    assert.equal(report.deleted, 0);
    assert.equal(report.unparseable, 1);

    const remaining = (await all(client, "SELECT id FROM review_items ORDER BY id")).map(
      (r) => r.id,
    );
    assert.deepEqual(remaining, [
      "other-kind-1",
      "resolved-1",
      "unparseable-1",
    ]);

    const resolved = await one(
      client,
      "SELECT status, resolution_note FROM review_items WHERE id = 'resolved-1'",
    );
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolution_note, "confirmed correct");
  },
);

test(
  "collapseWeakInstrumentMatches leaves an already-migrated singleton row exactly as it found it",
  { skip },
  async (t) => {
    const client = await archive(t);
    await seed(client);

    // The post-migration, already-collapsed shape: real columns, no legacy
    // reason parsing needed.
    await client.query(
      `INSERT INTO review_items
         (id, kind, source_document_id, raw_value, reason, institution_id, matched_instrument_id, occurrence_count, last_seen_document_id)
       VALUES ('weak-1', 'weak_instrument_match', 'doc-jan', 'ZEPHYR-descriptor', 'first sighting', 'inst-1', 'instr-1', 4, 'doc-feb')`,
    );

    const report = await collapseWeakInstrumentMatches(client, { dryRun: false });
    assert.equal(report.groups, 1);
    assert.equal(report.deleted, 0);

    const row = await one(
      client,
      "SELECT occurrence_count, source_document_id, last_seen_document_id FROM review_items WHERE id = 'weak-1'",
    );
    assert.equal(row.occurrence_count, 4);
    assert.equal(row.source_document_id, "doc-jan");
    assert.equal(row.last_seen_document_id, "doc-feb");
  },
);
