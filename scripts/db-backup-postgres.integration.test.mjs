import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runPostgresDatabaseBackup, verifyPostgresBackup } from "./db-backup-postgres.mjs";
import { runWithDatabaseBackupState } from "./run-database-backup.mjs";
import pg from "../packages/kith-store/node_modules/pg/esm/index.mjs";
import {
  applyKithSchema,
  KITH_SCHEMA_VERSION,
} from "../packages/kith-store/dist/index.js";
import {
  applyPgSchema,
  PG_SCHEMA_VERSION,
} from "../packages/finance-archive/dist/index.js";
import {
  exportConvexData,
  loadCsvDirectory,
  runParityChecks,
  transformExport,
} from "../packages/kith-migrate/dist/index.js";
import { writeConvexExportDir } from "../packages/kith-migrate/test/fixtures/buildFixture.mjs";
import { createKithPool } from "../packages/kith-store/dist/index.js";
import { authDenialSurfaceOnPool } from "../packages/kith-store/dist/identity/index.js";

const execute = promisify(execFile);
const ADMIN = process.env.KITH_MIGRATE_TEST_DATABASE_URL;
const PG = ADMIN
  ? realpathSync(process.env.KITH_POSTGRES_17_BIN ?? "/opt/homebrew/opt/postgresql@17/bin")
  : "";
const AGE = ADMIN ? realpathSync(process.env.KITH_AGE_BINARY ?? "/opt/homebrew/bin/age") : "";
const AGE_KEYGEN = ADMIN
  ? realpathSync(process.env.KITH_AGE_KEYGEN_BINARY ?? "/opt/homebrew/bin/age-keygen")
  : "";
const RESTIC = ADMIN
  ? realpathSync(process.env.KITH_RESTIC_BINARY ?? "/opt/homebrew/bin/restic")
  : "";

function databaseUrl(base, name) {
  const url = new URL(base); url.pathname = `/${name}`; return url.toString();
}
async function helper(root, name, value) {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${value}'\n`, { mode: 0o700 });
  return { path, args: [] };
}
async function proxy(root, name, executable) {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\nexec '${executable}' "$@"\n`, { mode: 0o700 });
  return path;
}
test("postgres runner publishes, independently reads back, decrypts, and restores a synthetic database", { skip: !ADMIN }, async (t) => {
  const root = await mkdtemp(join(homedir(), ".kith-pg-runner-test-"));
  await chmod(root, 0o700);
  const suffix = Math.random().toString(16).slice(2, 12);
  const sourceName = `kith_runner_src_${suffix}`;
  const destinationName = `kith_runner_dst_${suffix}`;
  const source = databaseUrl(ADMIN, sourceName);
  const destination = databaseUrl(ADMIN, destinationName);
  t.after(async () => {
    for (const name of [sourceName, destinationName]) {
      await execute(join(PG, "dropdb"), ["--if-exists", "--force", "--maintenance-db", ADMIN, name]).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  for (const name of [sourceName, destinationName]) await execute(join(PG, "createdb"), ["--maintenance-db", ADMIN, name]);
  const client = new pg.Client({ connectionString: source });
  await client.connect();
  try {
    await applyPgSchema(client, "finance");
    await applyKithSchema(client);
  } finally {
    await client.end();
  }
  const convexFixture = join(root, "convex-fixture");
  const exportDirectory = join(root, "convex-export");
  const csvDirectory = join(root, "csv");
  await writeConvexExportDir(convexFixture);
  const exportManifest = await exportConvexData(
    convexFixture,
    exportDirectory,
    { deploymentIdentity: "synthetic-restore", schemaVersion: 1, gitRevision: "abc1234" },
  );
  const transformReport = await transformExport(exportDirectory, csvDirectory);
  await loadCsvDirectory({ connectionString: source }, csvDirectory);

  const stateDirectory = join(root, "state");
  const stagingRoot = join(root, "staging");
  const repository = join(root, "repository");
  await mkdir(stateDirectory, { mode: 0o700 });
  await mkdir(stagingRoot, { mode: 0o700 });
  const passwordCommand = await helper(root, "password.sh", "synthetic-password");
  const connectionCommand = await helper(root, "source.sh", source);
  const destinationCommand = await helper(root, "destination.sh", destination);
  const psqlPath = await proxy(root, "psql.sh", join(PG, "psql"));
  const pgDumpPath = await proxy(root, "pg-dump.sh", join(PG, "pg_dump"));
  const pgRestorePath = await proxy(root, "pg-restore.sh", join(PG, "pg_restore"));
  const agePath = await proxy(root, "age.sh", AGE);
  const resticPath = await proxy(root, "restic.sh", RESTIC);
  const identity = join(root, "identity.txt");
  await execute(AGE_KEYGEN, ["-o", identity]);
  await chmod(identity, 0o600);
  const recipient = (await execute(AGE_KEYGEN, ["-y", identity])).stdout.trim();
  await execute(RESTIC, ["--repo", repository, "--password-command", passwordCommand.path, "init"]);
  const repositoryId = JSON.parse((await execute(RESTIC, ["--repo", repository, "--password-command", passwordCommand.path, "--no-cache", "cat", "config"])).stdout).id;
  const restoreConfigPath = join(root, "restore.json");
  await writeFile(restoreConfigPath, JSON.stringify({
    version: 1, pgRestorePath, psqlPath,
    sourceConnectionCommand: connectionCommand, destinationConnectionCommand: destinationCommand,
    expectedFinanceSchemaVersion: PG_SCHEMA_VERSION,
    expectedKithSchemaVersion: KITH_SCHEMA_VERSION,
    timeoutMs: 60_000,
  }), { mode: 0o600 });
  const backupConfig = {
    version: 1, stateDirectory, stagingRoot, connectionCommand,
    psqlPath, pgDumpPath,
    ageBinary: agePath, ageRecipient: recipient, resticBinary: resticPath,
    resticRepositoryPath: repository, resticPasswordCommand: passwordCommand,
    expectedResticRepositoryId: repositoryId, host: "synthetic-host",
    operationId: "synthetic-proof", expectedDatabaseName: sourceName,
    expectedFinanceSchemaVersion: PG_SCHEMA_VERSION,
    expectedKithSchemaVersion: KITH_SCHEMA_VERSION,
    timeoutMs: 60_000,
    gitRevision: "b".repeat(40),
  };
  const verifyConfig = {
    version: 1, ageBinary: agePath, ageIdentityPath: identity, restoreProofConfigPath: restoreConfigPath,
    resticBinary: resticPath, resticRepositoryPath: repository, resticPasswordCommand: passwordCommand,
    expectedResticRepositoryId: repositoryId, host: "synthetic-host",
    operationId: "synthetic-proof", timeoutMs: 60_000,
  };
  // The owner's source is never idle: a watcher heartbeats, the deferred-work
  // daemon ticks, MCP writes land at any time. Keep writing to it for the
  // whole backup and verification, so this proves the published dump and the
  // manifest parity describe one snapshot rather than a quiet moment.
  const writer = new pg.Client({ connectionString: source });
  // The cleanup below drops this database with --force, which terminates this
  // connection; that is expected, not a test failure.
  writer.on("error", () => {});
  await writer.connect();
  let writing = true;
  let written = 0;
  const writes = (async () => {
    while (writing) {
      // A native operational table, not one the Convex export below counts,
      // so the migration parity report still describes the fixture.
      await writer.query(
        "INSERT INTO kith.deferred_work (id, kind, state) VALUES ($1, 'card_queue_tick', 'done')",
        [`livewrite${String(written).padStart(16, "0")}`],
      );
      written += 1;
      await new Promise((wake) => setTimeout(wake, 25));
    }
  })();
  t.after(async () => {
    writing = false;
    await writes.catch(() => {});
    await writer.end().catch(() => {});
  });

  const managed = await runWithDatabaseBackupState(
    backupConfig,
    async ({ setStage }) => {
      const result = await runPostgresDatabaseBackup(backupConfig);
      const altered = structuredClone(result);
      altered.plaintexts["kithmind.dump.age"].sha256 = "0".repeat(64);
      await assert.rejects(verifyPostgresBackup(verifyConfig, altered), {
        code: "verify_readback_mismatch",
      });
      const stillEmpty = (await execute(join(PG, "psql"), [destination, "-tAc", "select count(*) from pg_tables where schemaname in ('finance','kith')"])).stdout.trim();
      assert.equal(stillEmpty, "0");
      await setStage("verify");
      return { result, verification: await verifyPostgresBackup(verifyConfig, result) };
    },
  );
  writing = false;
  await writes;
  await writer.end();
  assert.equal(managed.verification.status, "passed");
  // The proof passed even though the source gained rows after the snapshot
  // was taken: the manifest counts the snapshot's rows, not today's.
  const snapshotted = managed.result.manifest.parity.tables.find(
    (row) => row.name === "kith.deferred_work",
  );
  const live = Number(
    (await execute(join(PG, "psql"), [source, "-X", "-tAc", "select count(*) from kith.deferred_work"])).stdout.trim(),
  );
  assert.ok(written > 0);
  assert.ok(live > snapshotted.rowCount, `source moved: ${live} now, ${snapshotted.rowCount} at snapshot`);
  assert.equal(
    managed.verification.restore.tablesVerified,
    managed.result.manifest.parity.tables.length,
  );
  assert.ok(managed.verification.restore.tablesVerified > 70);
  // The restore target is populated now, so the proof child refuses to start.
  // Its own code has to survive both process boundaries: this is the failure
  // the owner's daily run saw every day as a bare `command_failed`.
  await assert.rejects(verifyPostgresBackup(verifyConfig, managed.result), {
    code: "restore_proof_failed:restore_target_not_empty",
  });
  const restoredPool = createKithPool(destination, 2);
  restoredPool.on("error", () => {});
  let parityReport;
  try {
    parityReport = await runParityChecks({
      connectionString: destination,
      exportDir: exportDirectory,
      manifest: exportManifest,
      transformReport,
      authDenialSurface: authDenialSurfaceOnPool(restoredPool),
    });
  } finally {
    await restoredPool.end();
  }
  const parityByName = Object.fromEntries(
    parityReport.results.map((result) => [result.name, result.status]),
  );
  assert.deepEqual(parityByName, {
    counts: "pass",
    retained_text_hashes: "pass",
    provenance_chains_sample: "pass",
    space_isolation_data: "pass",
    archive_references: "pending",
    auth_denial_and_space_isolation_read_api: "pass",
  });
  assert.equal(parityReport.ok, true);
  const journal = JSON.parse(await readFile(join(stateDirectory, "database-backup-status.json"), "utf8"));
  assert.equal(journal.state, "succeeded");
  await assert.rejects(readFile(join(stateDirectory, "database-backup.lock")), { code: "ENOENT" });
});

// BAK-1: a compact fixture shared by the retry, retention and non-fatal
// forget-failure tests below -- just enough schema for preflight and writer
// quiescence to run, without the full Convex-migration corpus the test above
// builds (this row's tests are about the export/retention machinery, not
// migration parity).
async function minimalBackupFixture(t) {
  const root = await mkdtemp(join(homedir(), ".kith-pg-retry-retention-test-"));
  await chmod(root, 0o700);
  const suffix = Math.random().toString(16).slice(2, 12);
  const sourceName = `kith_retry_src_${suffix}`;
  const source = databaseUrl(ADMIN, sourceName);
  t.after(async () => {
    await execute(join(PG, "dropdb"), ["--if-exists", "--force", "--maintenance-db", ADMIN, sourceName]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await execute(join(PG, "createdb"), ["--maintenance-db", ADMIN, sourceName]);
  const client = new pg.Client({ connectionString: source });
  await client.connect();
  try {
    await applyPgSchema(client, "finance");
    await applyKithSchema(client);
  } finally {
    await client.end();
  }
  const stateDirectory = join(root, "state");
  const stagingRoot = join(root, "staging");
  const repository = join(root, "repository");
  await mkdir(stateDirectory, { mode: 0o700 });
  await mkdir(stagingRoot, { mode: 0o700 });
  const passwordCommand = await helper(root, "password.sh", "synthetic-password");
  const connectionCommand = await helper(root, "source.sh", source);
  const psqlPath = await proxy(root, "psql.sh", join(PG, "psql"));
  const identity = join(root, "identity.txt");
  await execute(AGE_KEYGEN, ["-o", identity]);
  await chmod(identity, 0o600);
  const recipient = (await execute(AGE_KEYGEN, ["-y", identity])).stdout.trim();
  const agePath = await proxy(root, "age.sh", AGE);
  await execute(RESTIC, ["--repo", repository, "--password-command", passwordCommand.path, "init"]);
  const repositoryId = JSON.parse((await execute(RESTIC, ["--repo", repository, "--password-command", passwordCommand.path, "--no-cache", "cat", "config"])).stdout).id;
  const backupConfig = {
    version: 1, stateDirectory, stagingRoot, connectionCommand,
    psqlPath, pgDumpPath: await proxy(root, "pg-dump.sh", join(PG, "pg_dump")),
    ageBinary: agePath, ageRecipient: recipient, resticBinary: await proxy(root, "restic.sh", RESTIC),
    resticRepositoryPath: repository, resticPasswordCommand: passwordCommand,
    expectedResticRepositoryId: repositoryId, host: "synthetic-host",
    operationId: `synthetic-${suffix}`, expectedDatabaseName: sourceName,
    timeoutMs: 60_000,
    gitRevision: "b".repeat(40),
  };
  return { root, backupConfig, agePath, identity };
}

test("a transient export failure is retried with backoff, and the backup still publishes", { skip: !ADMIN }, async (t) => {
  const { root, backupConfig } = await minimalBackupFixture(t);
  // Fails the first two actual `pg_dump` invocations (a dropped connection
  // mid export), then delegates to the real binary. The plain `--version`
  // preflight check (runPostgresDatabaseBackup's own, before the retry loop
  // even starts) always passes through untouched, so only the dump itself is
  // flaky. The snapshot-holding session is a separate `psql` process per
  // attempt, so this also proves a fresh holder is exported on each retry
  // rather than reusing a dead one.
  const counter = join(root, "pg-dump-attempts");
  await writeFile(counter, "0");
  const flaky = join(root, "pg-dump-flaky.sh");
  await writeFile(
    flaky,
    `#!/bin/sh\ncase "$*" in\n  *--format=custom*)\n    n=$(cat '${counter}')\n    n=$((n+1))\n    printf '%s' "$n" > '${counter}'\n    if [ "$n" -le 2 ]; then echo "synthetic dropped connection" >&2; exit 1; fi\n    ;;\nesac\nexec '${join(PG, "pg_dump")}' "$@"\n`,
    { mode: 0o700 },
  );
  backupConfig.pgDumpPath = flaky;
  const startedAt = Date.now();
  const result = await runPostgresDatabaseBackup(backupConfig);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.status, "passed");
  assert.equal(await readFile(counter, "utf8"), "3");
  // Two backoffs (2s, 5s) must have elapsed between the three attempts.
  assert.ok(elapsedMs >= 6_500, `expected at least ~7s of backoff, took ${elapsedMs}ms`);
});

test("a forget failure is reported but does not fail the backup", { skip: !ADMIN }, async (t) => {
  const { root, backupConfig } = await minimalBackupFixture(t);
  // Delegates every restic subcommand to the real binary except `forget`,
  // which always fails -- the new snapshot this run publishes must still be
  // a success regardless.
  const flakyRestic = join(root, "restic-forget-fails.sh");
  await writeFile(
    flakyRestic,
    `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "forget" ]; then echo "synthetic forget failure" >&2; exit 1; fi; done\nexec '${RESTIC}' "$@"\n`,
    { mode: 0o700 },
  );
  backupConfig.resticBinary = flakyRestic;
  const result = await runPostgresDatabaseBackup(backupConfig);
  assert.equal(result.status, "passed");
  assert.equal(result.retention.status, "failed");
  assert.equal(typeof result.retention.code, "string");
});

test("retention is scoped to this host and the kith-db tag with the configured defaults", { skip: !ADMIN }, async (t) => {
  const { backupConfig } = await minimalBackupFixture(t);
  const result = await runPostgresDatabaseBackup(backupConfig);
  assert.equal(result.status, "passed");
  assert.equal(result.retention.status, "passed");
  // Nothing was old enough to remove yet, but the snapshot this run just
  // published must itself already carry the retention tag going forward.
  assert.equal(result.retention.removedCount, 0);
  const snapshots = JSON.parse(
    (await execute(RESTIC, [
      "--repo", backupConfig.resticRepositoryPath,
      "--password-command", backupConfig.resticPasswordCommand.path,
      "--no-cache", "--host", backupConfig.host, "--tag", "kith-db",
      "snapshots", "--json",
    ])).stdout,
  );
  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0].tags.sort(), ["kith-db", backupConfig.operationId].sort());
  assert.equal(snapshots[0].hostname, backupConfig.host);
});
