import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import {
  exportConvexData,
  loadCsvDirectory,
  runParityChecks,
  transformExport,
} from "../dist/index.js";
import { writeConvexExportDir } from "../test/fixtures/buildFixture.mjs";
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

    const report = await runParityChecks({
      connectionString: database.connectionString,
      exportDir,
      manifest,
      transformReport,
    });

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
    assert.equal(byName.auth_denial_and_space_isolation_read_api.status, "pending");
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
    // (plan section 2.2/2.5) should make unrepresentable.
    const documentsPath = join(csvDir, "documents.csv");
    const original = await readFile(documentsPath, "utf8");
    const corrupted = original.replace("itm_rowan_invoice", "itm_sage_note");
    assert.notEqual(corrupted, original, "fixture row to corrupt was not found");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(documentsPath, corrupted);

    await assert.rejects(() =>
      loadCsvDirectory({ connectionString: database.connectionString }, csvDir),
    );

    const pool = new pg.Pool({ connectionString: database.connectionString, max: 1 });
    try {
      const result = await pool.query(
        "SELECT to_regclass('kith.documents') IS NOT NULL AS present",
      );
      if (result.rows[0]?.present) {
        const count = await pool.query("SELECT count(*)::int AS n FROM kith.documents");
        assert.equal(count.rows[0].n, 0, "the whole load must roll back, not partially apply");
      }
    } finally {
      await pool.end();
    }
  } finally {
    await database.cleanup();
  }
});
