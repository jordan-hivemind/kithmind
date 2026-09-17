import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import { auditCsvDirectory, exportConvexData, transformExport } from "../dist/index.js";
import {
  syntheticConvexTables,
  writeConvexExportDir,
} from "../test/fixtures/buildFixture.mjs";
import { resolveTestDatabase } from "./resolveTestDatabase.mjs";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A well-formed `kith.kith_id` (lowercase base32-ish, 20-64 characters) that
 * this fixture never assigns to any real row, for the "references a missing
 * parent" and "brand-new synthetic row" cases below. */
function syntheticId(label) {
  return `id${createHash("sha1").update(label).digest("hex").slice(0, 24)}`;
}

async function buildTransformedCsv(t, overrideTables) {
  const source = await mkdtemp(join(tmpdir(), "kith-audit-fixture-"));
  await writeConvexExportDir(source, overrideTables);
  const exportDir = await mkdtemp(join(tmpdir(), "kith-audit-export-"));
  await exportConvexData(source, exportDir, {
    deploymentIdentity: "synthetic-test",
    schemaVersion: 1,
    gitRevision: "abc1234",
  });
  const csvDir = await mkdtemp(join(tmpdir(), "kith-audit-csv-"));
  const transformReport = await transformExport(exportDir, csvDir);
  assert.deepEqual(transformReport.unmapped, []);
  return csvDir;
}

async function realTableRowCounts(connectionString, tables) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const counts = {};
    for (const table of tables) {
      const result = await pool.query(
        `SELECT to_regclass($1) IS NOT NULL AS present`,
        [`kith.${table}`],
      );
      if (!result.rows[0]?.present) {
        counts[table] = null;
        continue;
      }
      const count = await pool.query(`SELECT count(*)::int AS n FROM kith.${table}`);
      counts[table] = count.rows[0].n;
    }
    return counts;
  } finally {
    await pool.end();
  }
}

async function auditSchemaExists(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query(
      `SELECT to_regnamespace('kith_migrate_audit') IS NOT NULL AS present`,
    );
    return result.rows[0]?.present ?? false;
  } finally {
    await pool.end();
  }
}

test("a clean synthetic fixture audits with zero violations", async (t) => {
  const database = await resolveTestDatabase();
  if (!database) {
    t.skip("no throwaway Postgres available locally or via Docker");
    return;
  }
  try {
    const csvDir = await buildTransformedCsv(t);
    const report = await auditCsvDirectory({ connectionString: database.connectionString }, csvDir);

    assert.deepEqual(report.violations, []);
    assert.equal(report.ok, true);
    assert.ok(report.rowsAudited.users > 0);

    // The three constraints the first hosted rehearsal failed on, audited
    // here with rows present rather than skipped for lack of them: the
    // transform cleared the pointers into the drained worker tables and the
    // pointer to the deleted API key, so nothing dangles.
    for (const table of [
      "source_inventory",
      "ingest_jobs",
      "worker_reservation_receipts",
    ]) {
      assert.ok(report.rowsAudited[table] > 0, `${table} audited no rows`);
    }
    assert.equal(await auditSchemaExists(database.connectionString), false);

    const rowCounts = await realTableRowCounts(database.connectionString, [
      "users",
      "spaces",
      "space_members",
      "api_keys",
      "embedding_profiles",
    ]);
    for (const [table, count] of Object.entries(rowCounts)) {
      assert.equal(count, 0, `kith.${table} must stay empty: the audit never writes to it`);
    }
  } finally {
    await database.cleanup();
  }
});

test("a fixture with rows that violate several constraint kinds is fully reported, not just the first", async (t) => {
  const database = await resolveTestDatabase();
  if (!database) {
    t.skip("no throwaway Postgres available locally or via Docker");
    return;
  }
  try {
    const { tables } = syntheticConvexTables();
    const bad = structuredClone(tables);

    // 1. Invalid enum state: `space_members_role_check` allows only
    // owner/editor/reader.
    bad.spaceMembers[0].role = "superuser";

    // 2. Foreign key to a missing parent: a well-formed id (passes the
    // `kith.kith_id` domain) that no `users` row carries.
    const missingUserId = syntheticId("usr_missing_dangling_reference");
    bad.spaceMembers[1].userId = missingUserId;

    // 3. Malformed hash: `api_keys_key_hash_check` requires 64 lowercase hex
    // characters.
    bad.apiKeys[0].keyHash = "not-a-valid-hash";

    // 4. Bad integer dimension: `embedding_profiles_dimensions_check`
    // requires a positive whole number. `embeddingProfiles` has no row in
    // the base fixture, so this also proves the audit covers a table the
    // clean-fixture test never populates.
    const badProfileId = syntheticId("emb_profile_bad_dimensions");
    bad.embeddingProfiles = [
      {
        _id: badProfileId,
        _creationTime: tables.users[0]._creationTime,
        fingerprint: sha256("audit-test-profile"),
        protocol: "openai/v1",
        dimensions: -5,
      },
    ];

    // 5. and 6. Legacy duplicates under migration 020's partial unique indexes.
    // Convex could not declare an index unique, so the ported code asserts these
    // identities by reading `LIMIT 2` and refusing the second row; an export
    // carrying a pair that predates that check loads cleanly and then poisons
    // every later read of it. Each is a verbatim copy of an existing row under a
    // new id, so the *only* thing wrong with it is that the identity now repeats.
    // Nothing in the audit knows about these indexes: it reads them back out of
    // `pg_index`, so they are covered with no change to the audit itself.
    // 7. A dangling reference neither clearing rule covers, on the very row
    // whose credential pointer is cleared: `actor_user_id` names a `users`
    // row nothing in the export holds. Only the columns the spec marks are
    // emptied, so this one still reaches the audit as a violation.
    const missingActorUserId = syntheticId("usr_missing_receipt_actor");
    bad.workerReservationReceipts[0].actorUserId = missingActorUserId;

    const duplicateGenerationId = syntheticId("gen_rowan_1_legacy_duplicate");
    bad.processingGenerations = [
      ...bad.processingGenerations,
      { ...bad.processingGenerations[0], _id: duplicateGenerationId },
    ];
    const duplicateRequestId = syntheticId("req_rowan_1_legacy_duplicate");
    bad.ingestRequests = [
      ...bad.ingestRequests,
      { ...bad.ingestRequests[0], _id: duplicateRequestId },
    ];

    const csvDir = await buildTransformedCsv(t, bad);
    const report = await auditCsvDirectory({ connectionString: database.connectionString }, csvDir);

    assert.equal(report.ok, false);

    const byTable = {};
    for (const violation of report.violations) {
      (byTable[violation.table] ??= []).push(violation);
    }

    const roleViolation = (byTable.space_members ?? []).find((v) => v.kind === "check");
    assert.ok(roleViolation, "expected a CHECK violation on space_members");
    assert.match(roleViolation.constraint, /role_check/);
    assert.equal(roleViolation.id, bad.spaceMembers[0]._id);
    assert.match(roleViolation.detail, /superuser/);

    const fkViolation = (byTable.space_members ?? []).find((v) => v.kind === "foreign_key");
    assert.ok(fkViolation, "expected a foreign key violation on space_members");
    assert.equal(fkViolation.id, bad.spaceMembers[1]._id);
    assert.match(fkViolation.detail, new RegExp(missingUserId));

    const hashViolation = (byTable.api_keys ?? []).find((v) => v.kind === "check");
    assert.ok(hashViolation, "expected a CHECK violation on api_keys");
    assert.match(hashViolation.constraint, /key_hash_check/);
    assert.equal(hashViolation.id, bad.apiKeys[0]._id);
    assert.match(hashViolation.detail, /not-a-valid-hash/);

    const dimensionViolation = (byTable.embedding_profiles ?? []).find((v) => v.kind === "check");
    assert.ok(dimensionViolation, "expected a CHECK violation on embedding_profiles");
    assert.match(dimensionViolation.constraint, /dimensions_check/);
    assert.equal(dimensionViolation.id, bad.embeddingProfiles[0]._id);
    assert.match(dimensionViolation.detail, /-5/);

    // Both halves of a duplicate pair are named, not just the second: the audit
    // reports one violation per row in the group, because a fix has to choose
    // between two rows that are equally legal on their own.
    const generationDuplicates = (byTable.processing_generations ?? []).filter(
      (v) => v.kind === "unique",
    );
    assert.equal(
      generationDuplicates.length,
      2,
      JSON.stringify(generationDuplicates, null, 2),
    );
    for (const violation of generationDuplicates) {
      assert.equal(violation.constraint, "processing_generations_fingerprint_idx");
      assert.match(violation.detail, /duplicate/);
    }
    assert.deepEqual(
      generationDuplicates.map((v) => v.id).sort(),
      [bad.processingGenerations[0]._id, duplicateGenerationId].sort(),
    );

    const requestDuplicates = (byTable.ingest_requests ?? []).filter(
      (v) => v.kind === "unique",
    );
    assert.equal(
      requestDuplicates.length,
      2,
      JSON.stringify(requestDuplicates, null, 2),
    );
    for (const violation of requestDuplicates) {
      assert.equal(violation.constraint, "ingest_requests_request_idx");
      assert.match(violation.detail, /duplicate/);
    }
    assert.deepEqual(
      requestDuplicates.map((v) => v.id).sort(),
      [bad.ingestRequests[0]._id, duplicateRequestId].sort(),
    );

    const receiptViolations = byTable.worker_reservation_receipts ?? [];
    const actorViolation = receiptViolations.find((v) => v.kind === "foreign_key");
    assert.ok(actorViolation, "expected a foreign key violation on the receipt");
    assert.match(actorViolation.constraint, /actor_user_id_fkey/);
    assert.match(actorViolation.detail, new RegExp(missingActorUserId));
    // The cleared credential pointer is not reported as anything: it is NULL,
    // and a NULL reference is not checked.
    assert.equal(
      receiptViolations.some((v) => /actor_credential_id/.test(v.constraint)),
      false,
      JSON.stringify(receiptViolations, null, 2),
    );

    // Every violation is reported, not just the first: nine distinct rows
    // across six tables, none of them stopping the others from being
    // checked.
    assert.ok(report.violations.length >= 9, JSON.stringify(report.violations, null, 2));

    assert.equal(await auditSchemaExists(database.connectionString), false);
    const rowCounts = await realTableRowCounts(database.connectionString, [
      "users",
      "space_members",
      "api_keys",
      "embedding_profiles",
      "processing_generations",
      "ingest_requests",
    ]);
    for (const [table, count] of Object.entries(rowCounts)) {
      assert.equal(count, 0, `kith.${table} must stay empty: the audit never writes to it`);
    }
  } finally {
    await database.cleanup();
  }
});
