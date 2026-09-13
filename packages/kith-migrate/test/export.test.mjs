import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { exportConvexData, verifyManifest } from "../dist/index.js";
import { writeConvexExportDir } from "./fixtures/buildFixture.mjs";

const execFileAsync = promisify(execFile);

test("exports a Convex export directory into per-table JSONL plus a manifest", async () => {
  const source = await mkdtemp(join(tmpdir(), "kith-fixture-"));
  const { tableCounts } = await writeConvexExportDir(source);
  const out = await mkdtemp(join(tmpdir(), "kith-export-out-"));

  const manifest = await exportConvexData(source, out, {
    deploymentIdentity: "synthetic-test",
    schemaVersion: 1,
    gitRevision: "abc1234",
  });

  for (const [table, count] of Object.entries(tableCounts)) {
    assert.equal(manifest.tables[table]?.rowCount, count, `row count for ${table}`);
  }

  const outputDirStat = await stat(out);
  assert.equal(outputDirStat.mode & 0o777, 0o700);
  const usersFileStat = await stat(join(out, "users.jsonl"));
  assert.equal(usersFileStat.mode & 0o777, 0o600);

  const verification = await verifyManifest(out);
  assert.deepEqual(verification, { ok: true, problems: [] });
});

test("verifyManifest fails when a table file is tampered with", async () => {
  const source = await mkdtemp(join(tmpdir(), "kith-fixture-"));
  await writeConvexExportDir(source);
  const out = await mkdtemp(join(tmpdir(), "kith-export-out-"));
  await exportConvexData(source, out, {
    deploymentIdentity: "synthetic-test",
    schemaVersion: 1,
    gitRevision: "abc1234",
  });

  await appendFile(join(out, "users.jsonl"), '{"_id":"usr_extra","_creationTime":1}\n');

  const verification = await verifyManifest(out);
  assert.equal(verification.ok, false);
  assert.ok(verification.problems.some((p) => p.startsWith("hash_mismatch:users")));
});

test("reads an export from a zip archive the same way as from a directory", async () => {
  const source = await mkdtemp(join(tmpdir(), "kith-fixture-"));
  await writeConvexExportDir(source);
  const zipDir = await mkdtemp(join(tmpdir(), "kith-zip-"));
  const zipPath = join(zipDir, "export.zip");
  const entries = await readdir(source);
  await execFileAsync("zip", ["-qr", zipPath, ...entries], { cwd: source });

  const out = await mkdtemp(join(tmpdir(), "kith-export-zip-out-"));
  const manifest = await exportConvexData(zipPath, out, {
    deploymentIdentity: "synthetic-test",
    schemaVersion: 1,
    gitRevision: "abc1234",
  });
  assert.ok(manifest.tables.users);
  assert.equal(manifest.tables.users.rowCount, 2);
});
