import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TABLES,
  UnmappedFieldError,
  columnOrder,
  exportConvexData,
  knownUnmappedConvexTables,
  transformExport,
} from "../dist/index.js";
import { writeConvexExportDir } from "./fixtures/buildFixture.mjs";

/** The one CSV cell at `table.column`, for a fixture that writes one row. */
async function onlyCell(outDir, pgTable, pgColumn) {
  const spec = TABLES.find((t) => t.pg === pgTable);
  assert.ok(spec, `no table spec for ${pgTable}`);
  const index = columnOrder(spec).indexOf(pgColumn);
  assert.notEqual(index, -1, `${pgTable} has no column ${pgColumn}`);
  const csv = await readFile(join(outDir, `${pgTable}.csv`), "utf8");
  const lines = csv.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1, `${pgTable}.csv should hold exactly one row`);
  return lines[0].split(",")[index];
}

async function buildExport() {
  const source = await mkdtemp(join(tmpdir(), "kith-fixture-"));
  const fixture = await writeConvexExportDir(source);
  const out = await mkdtemp(join(tmpdir(), "kith-export-"));
  const manifest = await exportConvexData(source, out, {
    deploymentIdentity: "synthetic-test",
    schemaVersion: 1,
    gitRevision: "abc1234",
  });
  return { exportDir: out, manifest, fixture };
}

test("transforms the synthetic export with no unmapped fields", async () => {
  const { exportDir } = await buildExport();
  const outDir = await mkdtemp(join(tmpdir(), "kith-transform-"));
  const report = await transformExport(exportDir, outDir);
  assert.deepEqual(report.unmapped, []);
});

test("row counts match the export for migrated tables and are zero for drained tables", async () => {
  const { exportDir, fixture } = await buildExport();
  const outDir = await mkdtemp(join(tmpdir(), "kith-transform-"));
  const report = await transformExport(exportDir, outDir);

  assert.equal(report.rowCounts.users, fixture.tableCounts.users);
  // brain_documents/brain_chunks: the plan's real `documents`/`chunks` shape
  // lands under this name for now, see src/ddl.ts's module comment for why.
  assert.equal(report.rowCounts.brain_documents, fixture.tableCounts.documents);
  assert.equal(report.rowCounts.brain_chunks, fixture.tableCounts.chunks);
  assert.equal(report.rowCounts.family_invitations, fixture.tableCounts.familyInvitations);
  assert.equal(report.rowCounts.coverage_windows, fixture.tableCounts.coverageWindows);

  // inlineWork is migrated: false (drained before cutover). The export has
  // one row; the destination must still get zero.
  assert.equal(fixture.tableCounts.inlineWork, 1);
  assert.equal(report.rowCounts.inline_work, 0);

  // apiKeys' two grant arrays become child-table rows, not a jsonb column.
  assert.equal(report.childRowCounts.api_key_spaces, 1);
  assert.equal(report.childRowCounts.api_key_source_accounts, 1);
});

test("a reference into a drained table is cleared, not carried into the load", async () => {
  const { exportDir, fixture } = await buildExport();
  const outDir = await mkdtemp(join(tmpdir(), "kith-transform-"));
  const report = await transformExport(exportDir, outDir);

  // The export holds both targets and the load writes neither, so carrying
  // these ids would be one foreign-key violation per referencing row.
  assert.equal(fixture.tableCounts.workerSourceScans, 1);
  assert.equal(fixture.tableCounts.workerDiscoveryWork, 1);
  assert.equal(report.rowCounts.worker_source_scans, 0);
  assert.equal(report.rowCounts.worker_discovery_work, 0);

  for (const [pgTable, pgColumn] of [
    ["source_inventory", "first_seen_scan_id"],
    ["source_inventory", "last_seen_scan_id"],
    ["ingest_jobs", "worker_discovery_work_id"],
  ]) {
    assert.equal(
      await onlyCell(outDir, pgTable, pgColumn),
      "",
      `${pgTable}.${pgColumn} should be empty`,
    );
    assert.deepEqual(report.clearedReferences[`${pgTable}.${pgColumn}`], {
      count: 1,
      reason: "target drained",
    });
  }

  // A reference the export can satisfy is untouched.
  assert.equal(
    await onlyCell(outDir, "source_inventory", "source_item_id"),
    fixture.ids.sourceItemRowan,
  );
  assert.equal(report.clearedReferences["source_inventory.source_item_id"], undefined);
});

test("a credential pointer to an api key the export no longer holds is cleared", async () => {
  const { exportDir } = await buildExport();
  const outDir = await mkdtemp(join(tmpdir(), "kith-transform-"));
  const report = await transformExport(exportDir, outDir);

  assert.equal(
    await onlyCell(outDir, "worker_reservation_receipts", "actor_credential_id"),
    "",
  );
  assert.deepEqual(
    report.clearedReferences["worker_reservation_receipts.actor_credential_id"],
    { count: 1, reason: "referenced api key no longer exists in the export" },
  );

  // Only the missing id is dropped. The receipt's own row, and its user
  // pointer, are carried as the export held them.
  assert.equal(report.rowCounts.worker_reservation_receipts, 1);
  assert.notEqual(
    await onlyCell(outDir, "worker_reservation_receipts", "actor_user_id"),
    "",
  );
});

test("no reference is cleared without a rule for it", async () => {
  const { exportDir } = await buildExport();
  const outDir = await mkdtemp(join(tmpdir(), "kith-transform-"));
  const report = await transformExport(exportDir, outDir);

  assert.deepEqual(Object.keys(report.clearedReferences).sort(), [
    "ingest_jobs.worker_discovery_work_id",
    "source_inventory.first_seen_scan_id",
    "source_inventory.last_seen_scan_id",
    "worker_reservation_receipts.actor_credential_id",
  ]);
  // The report is published: counts and reasons only, never a row's id.
  const serialized = JSON.stringify(report.clearedReferences);
  assert.equal(/\bid[0-9a-f]{20,}/.test(serialized), false, serialized);
});

test("retired tables are never read and never reported unmapped", async () => {
  const { exportDir } = await buildExport();
  const outDir = await mkdtemp(join(tmpdir(), "kith-transform-"));
  const report = await transformExport(exportDir, outDir, { reportUnmappedOnly: true });
  assert.deepEqual(report.unmapped, []);
  assert.ok(knownUnmappedConvexTables().includes("lists"));
});

test("thoughts.embedding is excluded from the row and written to a cold audit file", async () => {
  const { exportDir, fixture } = await buildExport();
  const outDir = await mkdtemp(join(tmpdir(), "kith-transform-"));
  await transformExport(exportDir, outDir);

  const thoughtsCsv = await readFile(join(outDir, "thoughts.csv"), "utf8");
  assert.equal(thoughtsCsv.includes("0.1"), false);

  const audit = await readFile(join(outDir, "_excluded", "thoughts.embedding.jsonl"), "utf8");
  const parsed = JSON.parse(audit.trim());
  assert.deepEqual(parsed, {
    id: fixture.ids.thoughtRowan,
    embedding: [0.1, 0.2, 0.3],
  });
});

test("retained text hashes are recorded for source_pages and chunks", async () => {
  const { exportDir, fixture } = await buildExport();
  const outDir = await mkdtemp(join(tmpdir(), "kith-transform-"));
  const report = await transformExport(exportDir, outDir);

  const byTable = (table) =>
    report.retainedTextHashes.filter((h) => h.pgTable === table).map((h) => h.sha256).sort();
  const { createHash } = await import("node:crypto");
  const sha256 = (t) => createHash("sha256").update(t, "utf8").digest("hex");

  assert.deepEqual(
    byTable("source_pages"),
    [sha256(fixture.text.rowan), sha256(fixture.text.sage)].sort(),
  );
  assert.deepEqual(
    byTable("brain_chunks"),
    [sha256(fixture.text.rowan), sha256(fixture.text.sage)].sort(),
  );
});

test("an unmapped field is a hard failure by default", async () => {
  const source = await mkdtemp(join(tmpdir(), "kith-fixture-"));
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(source, "users"), { recursive: true });
  await writeFile(
    join(source, "users", "documents.jsonl"),
    `${JSON.stringify({ _id: "usr_x", _creationTime: 1, aFieldThatDoesNotExist: true })}\n`,
  );
  const out = await mkdtemp(join(tmpdir(), "kith-export-"));
  await exportConvexData(source, out, {
    deploymentIdentity: "t",
    schemaVersion: 1,
    gitRevision: "t",
  });
  const outDir = await mkdtemp(join(tmpdir(), "kith-transform-"));
  await assert.rejects(() => transformExport(out, outDir), UnmappedFieldError);
});

test("--report-unmapped collects the same failure instead of throwing", async () => {
  const source = await mkdtemp(join(tmpdir(), "kith-fixture-"));
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(source, "users"), { recursive: true });
  await writeFile(
    join(source, "users", "documents.jsonl"),
    `${JSON.stringify({ _id: "usr_x", _creationTime: 1, aFieldThatDoesNotExist: true })}\n`,
  );
  const out = await mkdtemp(join(tmpdir(), "kith-export-"));
  await exportConvexData(source, out, {
    deploymentIdentity: "t",
    schemaVersion: 1,
    gitRevision: "t",
  });
  const outDir = await mkdtemp(join(tmpdir(), "kith-transform-"));
  const report = await transformExport(out, outDir, { reportUnmappedOnly: true });
  assert.deepEqual(report.unmapped, ["users.aFieldThatDoesNotExist"]);
});
