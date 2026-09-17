import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import { createKithPool } from "@repo/kith-store";
import { authDenialSurfaceOnPool } from "@repo/kith-store/identity";

import {
  exportConvexData,
  loadCsvDirectory,
  runParityChecks,
  transformExport,
} from "../dist/index.js";
import {
  syntheticConvexTables,
  writeConvexExportDir,
} from "../test/fixtures/buildFixture.mjs";
import { resolveTestDatabase } from "./resolveTestDatabase.mjs";

test("export, transform, COPY-load and the parity harness round-trip on a throwaway Postgres 17", async (t) => {
  const database = await resolveTestDatabase();
  if (!database) {
    t.skip("no throwaway Postgres available locally or via Docker");
    return;
  }

  try {
    const source = await mkdtemp(join(tmpdir(), "kith-fixture-"));
    await writeConvexExportDir(source);
    const exportDir = await mkdtemp(join(tmpdir(), "kith-export-"));
    const manifest = await exportConvexData(source, exportDir, {
      deploymentIdentity: "synthetic-test",
      schemaVersion: 1,
      gitRevision: "abc1234",
    });

    const csvDir = await mkdtemp(join(tmpdir(), "kith-csv-"));
    const transformReport = await transformExport(exportDir, csvDir);
    assert.deepEqual(transformReport.unmapped, []);

    await loadCsvDirectory({ connectionString: database.connectionString }, csvDir);

    // The cleared references arrive as NULL on rows that are otherwise whole:
    // the deferred foreign keys hold at COMMIT, and the row keeps every
    // pointer the export could still satisfy.
    const { ids } = syntheticConvexTables();
    const clearedPool = new pg.Pool({
      connectionString: database.connectionString,
      max: 1,
    });
    try {
      const inventory = await clearedPool.query(
        `SELECT first_seen_scan_id, last_seen_scan_id, source_item_id
           FROM kith.source_inventory WHERE id = $1`,
        [ids.sourceInventoryRowan],
      );
      assert.equal(inventory.rows[0].first_seen_scan_id, null);
      assert.equal(inventory.rows[0].last_seen_scan_id, null);
      assert.equal(inventory.rows[0].source_item_id, ids.sourceItemRowan);

      const job = await clearedPool.query(
        `SELECT worker_discovery_work_id, source_item_id
           FROM kith.ingest_jobs WHERE id = $1`,
        [ids.ingestJobRowan],
      );
      assert.equal(job.rows[0].worker_discovery_work_id, null);
      assert.equal(job.rows[0].source_item_id, ids.sourceItemRowan);

      const receipt = await clearedPool.query(
        `SELECT actor_credential_id, actor_user_id
           FROM kith.worker_reservation_receipts WHERE id = $1`,
        [ids.reservationReceiptRowan],
      );
      assert.equal(receipt.rows[0].actor_credential_id, null);
      assert.notEqual(receipt.rows[0].actor_user_id, null);
    } finally {
      await clearedPool.end();
    }

    // Check 6's surface, supplied by P2-39c. It drives the real identity
    // functions against the loaded database, so the six denials are proven on the
    // schema the migration produced rather than on a fixture.
    const pool = createKithPool(database.connectionString, 2);
    pool.on("error", () => {});
    let report;
    try {
      report = await runParityChecks({
        connectionString: database.connectionString,
        exportDir,
        manifest,
        transformReport,
        authDenialSurface: authDenialSurfaceOnPool(pool),
      });
    } finally {
      await pool.end().catch(() => {});
    }

    const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
    assert.equal(byName.counts.status, "pass", JSON.stringify(byName.counts.details));
    assert.equal(
      byName.retained_text_hashes.status,
      "pass",
      JSON.stringify(byName.retained_text_hashes.details),
    );
    assert.equal(
      byName.provenance_chains_sample.status,
      "pass",
      JSON.stringify(byName.provenance_chains_sample.details),
    );
    assert.equal(
      byName.space_isolation_data.status,
      "pass",
      JSON.stringify(byName.space_isolation_data.details),
    );
    assert.equal(byName.archive_references.status, "pending");
    assert.equal(
      byName.auth_denial_and_space_isolation_read_api.status,
      "pass",
      JSON.stringify(byName.auth_denial_and_space_isolation_read_api.details),
    );
    assert.equal(report.ok, true);
  } finally {
    await database.cleanup();
  }
});

test("a row that would cross a space boundary is refused at load, not silently accepted", async (t) => {
  const database = await resolveTestDatabase();
  if (!database) {
    t.skip("no throwaway Postgres available locally or via Docker");
    return;
  }

  try {
    const source = await mkdtemp(join(tmpdir(), "kith-fixture-"));
    await writeConvexExportDir(source);
    const exportDir = await mkdtemp(join(tmpdir(), "kith-export-"));
    await exportConvexData(source, exportDir, {
      deploymentIdentity: "synthetic-test",
      schemaVersion: 1,
      gitRevision: "abc1234",
    });
    const csvDir = await mkdtemp(join(tmpdir(), "kith-csv-"));
    await transformExport(exportDir, csvDir);

    // Corrupt one row after the transform: point Rowan's document at Sage's
    // source item, a cross-space reference the composite foreign key
    // (plan section 2.2/2.5) should make unrepresentable. `brain_documents`:
    // the plan's real `documents` shape lands under this name for now, see
    // src/ddl.ts's module comment for why.
    const { ids } = syntheticConvexTables();
    const documentsPath = join(csvDir, "brain_documents.csv");
    const original = await readFile(documentsPath, "utf8");
    const corrupted = original.replace(ids.sourceItemRowan, ids.sourceItemSage);
    assert.notEqual(corrupted, original, "fixture row to corrupt was not found");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(documentsPath, corrupted);

    await assert.rejects(() =>
      loadCsvDirectory({ connectionString: database.connectionString }, csvDir),
    );

    const pool = new pg.Pool({ connectionString: database.connectionString, max: 1 });
    try {
      const result = await pool.query(
        "SELECT to_regclass('kith.brain_documents') IS NOT NULL AS present",
      );
      if (result.rows[0]?.present) {
        const count = await pool.query(
          "SELECT count(*)::int AS n FROM kith.brain_documents",
        );
        assert.equal(count.rows[0].n, 0, "the whole load must roll back, not partially apply");
      }
    } finally {
      await pool.end();
    }
  } finally {
    await database.cleanup();
  }
});
