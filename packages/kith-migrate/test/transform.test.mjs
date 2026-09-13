import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  UnmappedFieldError,
  exportConvexData,
  knownUnmappedConvexTables,
  transformExport,
} from "../dist/index.js";
import { writeConvexExportDir } from "./fixtures/buildFixture.mjs";

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
