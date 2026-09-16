// Migration 020: the identities the store asserts at read time are database
// facts, not merely conventions the service upholds.
//
// Every table below carries a lookup in `src/` that reads its identity key with
// `LIMIT 2` and throws ("X identity is not unique") or answers `scan_conflict`
// when two rows come back. Those checks stay, and the suites that exercise them
// still pass; what this suite proves is the half they cannot cover -- that the
// second row is refused by the database at write time, under any isolation level
// and from any writer, rather than being written and then poisoning every later
// read of that identity.
//
// Each case inserts one row, then a second carrying the same key, and requires
// SQLSTATE 23505 naming the index. The foreign keys on these tables are all
// DEFERRABLE INITIALLY DEFERRED, so a case can run inside a transaction it never
// commits and reference parents that do not exist; the unique index is not
// deferred and fires on the second insert regardless.
//
// Each case also inserts two rows that leave one key column NULL and requires
// both to be admitted. Migration 004 built these tables from the Convex export
// with every key column nullable, and existing fixtures write rows without one;
// the partial `WHERE ... IS NOT NULL` predicate is what keeps those rows out of
// the index, and this asserts the predicate is really there rather than the index
// happening to tolerate them.
//
// Each test runs in its own throwaway database (test/helpers/pgDatabase.mjs).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyKithSchema,
  KITH_MIGRATIONS,
  KITH_SCHEMA_VERSION,
  newKithId,
} from "../dist/index.js";

import { all, connect, skip, throwawayDatabase } from "./helpers/pgDatabase.mjs";

const SPACE = "space0000000000000001";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

/**
 * Every identity migration 020 enforces.
 *
 * `key` is the identity taken from the WHERE clause of the lookup named in
 * `lookup`; `other` is a column the two rows may differ in, which is what makes
 * the refusal about the key rather than about the whole row.
 */
const IDENTITIES = [
  {
    index: "source_items_external_identity_idx",
    table: "source_items",
    key: { source_account_id: "acct0000000000000001", external_id_hash: HASH_A },
    other: { title: "Synthetic item" },
    lookup: "createOrGetSourceItem (src/provenance/model.ts)",
  },
  {
    index: "source_revisions_content_idx",
    table: "source_revisions",
    key: { source_item_id: "item0000000000000001", content_hash: HASH_A },
    other: { media_type: "text/plain" },
    lookup:
      "createOrGetRevision (src/provenance/model.ts), createOrGetArchivedRevision (binary.ts)",
  },
  {
    index: "source_text_versions_extraction_idx",
    table: "source_text_versions",
    key: {
      source_revision_id: "rev00000000000000001",
      extraction_fingerprint: HASH_A,
    },
    other: { text_hash: HASH_B },
    lookup:
      "createOrGetTextVersion (src/provenance/model.ts), createOrGetParsedTextVersion (binary.ts)",
  },
  {
    index: "source_pages_ordinal_idx",
    table: "source_pages",
    key: { source_text_version_id: "text0000000000000001", ordinal: 0 },
    other: { text_hash: HASH_B },
    lookup: "stagePages (src/provenance/model.ts)",
  },
  {
    index: "evidence_spans_ordinal_idx",
    table: "evidence_spans",
    key: { source_page_id: "page0000000000000001", ordinal: 0 },
    other: { quote_hash: HASH_B },
    lookup: "stageEvidenceSpans (src/provenance/model.ts)",
  },
  {
    index: "documents_key_idx",
    table: "documents",
    key: {
      processing_generation_id: "gen00000000000000001",
      document_key: "statement:0",
    },
    other: { title: "Synthetic document" },
    lookup: "stageDocuments (src/provenance/model.ts)",
  },
  {
    index: "source_parser_artifacts_fingerprint_idx",
    table: "source_parser_artifacts",
    key: { source_revision_id: "rev00000000000000001", parser_fingerprint: HASH_A },
    other: { client_artifact_id: "artifact-2" },
    lookup: "createOrGetParserArtifact (src/provenance/artifacts.ts)",
  },
  {
    index: "source_parser_artifacts_client_idx",
    table: "source_parser_artifacts",
    key: { source_account_id: "acct0000000000000001", client_artifact_id: "artifact-1" },
    other: { parser_fingerprint: HASH_B },
    lookup: "createOrGetParserArtifact (src/provenance/artifacts.ts)",
  },
  {
    index: "source_artifact_archive_receipts_client_idx",
    table: "source_artifact_archive_receipts",
    key: { source_account_id: "acct0000000000000001", client_receipt_id: "receipt-1" },
    other: { archive_object_id: "object-2" },
    lookup: "createOrGetArchiveReceipt (src/provenance/artifacts.ts)",
  },
  {
    index: "source_artifact_archive_receipts_object_idx",
    table: "source_artifact_archive_receipts",
    key: { archive_identity_fingerprint: HASH_A, archive_object_id: "object-1" },
    other: { client_receipt_id: "receipt-2" },
    lookup: "createOrGetArchiveReceipt (src/provenance/artifacts.ts)",
  },
  {
    index: "processing_generations_fingerprint_idx",
    table: "processing_generations",
    key: { source_revision_id: "rev00000000000000001", processing_fingerprint: HASH_A },
    other: { correction_revision: "inline-epoch:1" },
    lookup:
      "admitInlineSourceRevision (src/ingestion/inlineWork.ts), createArchivedIngestWork (src/workers/archivedDiscovery.ts)",
  },
  {
    index: "ingest_requests_request_idx",
    table: "ingest_requests",
    key: { source_account_id: "acct0000000000000001", request_id: "fs-admit:1" },
    other: { request_digest: HASH_B },
    lookup:
      "admitInlineWork (src/ingestion/inlineWork.ts), createOrReuseInlineAdmission (src/workers/discovery.ts)",
  },
];

/** One row in `table`: a fresh id, the shared space, and the given columns. */
function insert(client, table, columns) {
  const names = Object.keys(columns);
  const columnList = ["id", "space_id", "created_at", ...names]
    .map((name) => `"${name}"`)
    .join(",");
  const placeholders = [
    "$1",
    "$2",
    "transaction_timestamp()",
    ...names.map((_, index) => `$${index + 3}`),
  ].join(",");
  return client.query(
    `INSERT INTO kith.${table} (${columnList}) VALUES (${placeholders})`,
    [newKithId(), SPACE, ...Object.values(columns)],
  );
}

async function refusedInTransaction(client, work) {
  await client.query("BEGIN");
  try {
    return await work();
  } finally {
    await client.query("ROLLBACK");
  }
}

test(
  "every identity the store asserts unique is refused a second row by its index",
  { skip },
  async (t) => {
    const client = await connect(await throwawayDatabase(t));
    assert.equal(await applyKithSchema(client), KITH_SCHEMA_VERSION);

    for (const identity of IDENTITIES) {
      await refusedInTransaction(client, async () => {
        await insert(client, identity.table, {
          ...identity.key,
          ...identity.other,
        });
        let error;
        try {
          await insert(client, identity.table, identity.key);
        } catch (caught) {
          error = caught;
        }
        assert.ok(
          error,
          `${identity.table} accepted a second row for ${identity.index}, which ${identity.lookup} asserts is unique`,
        );
        assert.equal(
          error.code,
          "23505",
          `${identity.index} should refuse with a unique violation, got ${error.code}: ${error.message}`,
        );
        assert.match(
          error.message,
          new RegExp(identity.index),
          `the refusal should name ${identity.index}`,
        );
      });
    }
  },
);

test(
  "a NULL key column is outside every identity index, not a duplicate within it",
  { skip },
  async (t) => {
    const client = await connect(await throwawayDatabase(t));
    assert.equal(await applyKithSchema(client), KITH_SCHEMA_VERSION);

    for (const identity of IDENTITIES) {
      // Migration 004 left every key column nullable and existing fixtures write
      // rows without one. The partial predicate has to keep them out of the index
      // entirely, so two such rows are both admitted.
      const [nulled] = Object.keys(identity.key);
      const partial = { ...identity.key, [nulled]: null };
      await refusedInTransaction(client, async () => {
        await insert(client, identity.table, partial);
        await insert(client, identity.table, partial);
        const [row] = await all(
          client,
          `SELECT count(*)::int AS count FROM kith.${identity.table}`,
        );
        assert.equal(
          row.count,
          2,
          `${identity.index} should not index rows with a NULL ${nulled}`,
        );
      });
    }
  },
);

test(
  "migration 020 applies to a database that already holds rows in those tables",
  { skip },
  async (t) => {
    const client = await connect(await throwawayDatabase(t));

    // Everything up to 019, by hand, so the database reaches the state a real
    // deployment is in before this migration runs. `applyKithSchema` always
    // migrates to the newest version, so it cannot stop short on its own.
    const before = KITH_MIGRATIONS.filter((migration) => migration.version < 20);
    assert.equal(before.length, 19);
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA kith");
    await client.query(`
      CREATE TABLE kith.schema_version (
        version integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
      )`);
    for (const migration of before) {
      await client.query(await readFile(fileURLToPath(migration.url), "utf8"));
      await client.query(
        "INSERT INTO kith.schema_version (version, name) VALUES ($1, $2)",
        [migration.version, migration.name],
      );
    }
    // The foreign keys come off first. They are DEFERRABLE INITIALLY DEFERRED,
    // which defers them to COMMIT rather than waiving them, and building whole
    // parent chains for ten tables would test referential integrity -- which the
    // provenance suites already cover -- instead of what is under test here:
    // whether migration 020's DDL applies to tables that already hold rows.
    await client.query(`
      DO $$
      DECLARE target record;
      BEGIN
        FOR target IN
          SELECT c.relname AS table_name, con.conname AS constraint_name
            FROM pg_constraint con
            JOIN pg_class c ON c.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'kith' AND con.contype = 'f'
        LOOP
          EXECUTE format(
            'ALTER TABLE kith.%I DROP CONSTRAINT %I',
            target.table_name, target.constraint_name);
        END LOOP;
      END $$;`);
    // Data in every table migration 020 indexes, distinct under each identity,
    // so the indexes are built over rows rather than over nothing.
    for (const identity of IDENTITIES) {
      await insert(client, identity.table, {
        ...identity.key,
        ...identity.other,
      });
    }
    await client.query("COMMIT");

    assert.equal(await applyKithSchema(client), KITH_SCHEMA_VERSION);

    // The rows survived, and the indexes now hold over them.
    for (const identity of IDENTITIES) {
      let error;
      try {
        await refusedInTransaction(client, () =>
          insert(client, identity.table, identity.key),
        );
      } catch (caught) {
        error = caught;
      }
      assert.equal(
        error?.code,
        "23505",
        `${identity.index} should hold over the rows that were already there`,
      );
      assert.match(error.message, new RegExp(identity.index));
    }
  },
);

test(
  "the non-unique indexes migration 020 replaces are gone",
  { skip },
  async (t) => {
    const client = await connect(await throwawayDatabase(t));
    assert.equal(await applyKithSchema(client), KITH_SCHEMA_VERSION);

    // Each of these covered exactly the columns a new unique index now covers,
    // so leaving it would cost every write a second index for no extra lookup.
    for (const name of [
      "worker_source_items_external_idx",
      "worker_ingest_requests_request_idx",
    ]) {
      const [row] = await all(
        client,
        "SELECT to_regclass($1) IS NULL AS dropped",
        [`kith.${name}`],
      );
      assert.equal(row.dropped, true, `kith.${name} should have been dropped`);
    }

    // These two keep their names and become unique in place, so the lookups they
    // back are unchanged while the invariant is now enforced.
    for (const name of [
      "source_revisions_content_idx",
      "processing_generations_fingerprint_idx",
    ]) {
      const [row] = await all(
        client,
        `SELECT indisunique AS unique, indpred IS NOT NULL AS partial
           FROM pg_index WHERE indexrelid = $1::regclass`,
        [`kith.${name}`],
      );
      assert.equal(row.unique, true, `kith.${name} should be unique`);
      assert.equal(row.partial, true, `kith.${name} should be partial`);
    }
  },
);
