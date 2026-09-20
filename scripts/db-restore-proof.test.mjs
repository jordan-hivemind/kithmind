import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import test from "node:test";

import { buildManifest } from "./db-backup-postgres.mjs";
import { capturePostgresParity, hashFileSha256 } from "./db-postgres-parity.mjs";
import { RestoreProofError, loadRestoreProofConfig, restorePostgresProof } from "./db-restore-proof.mjs";

const execute = promisify(execFile);
const ADMIN = process.env.KITH_MIGRATE_TEST_DATABASE_URL;

// BAK-1: schema versions are recorded, not pinned -- `expected*SchemaVersion`
// is kept only for backward compatibility and is now optional. A config
// written before this change (both keys present) and one written after (both
// keys absent) must both still load.
async function writeConfigFixture(t, overrides = {}) {
  const root = await mkdtemp(join(homedir(), ".kith-restore-proof-config-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tool = join(root, "tool.sh");
  await writeFile(tool, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const configPath = join(root, "restore.json");
  const base = {
    version: 1,
    pgRestorePath: tool,
    psqlPath: tool,
    sourceConnectionCommand: { path: tool, args: [] },
    destinationConnectionCommand: { path: tool, args: [] },
    timeoutMs: 60_000,
    ...overrides,
  };
  await writeFile(configPath, JSON.stringify(base), { mode: 0o600 });
  return configPath;
}

test("loadRestoreProofConfig accepts a config with no expected schema versions", async (t) => {
  const configPath = await writeConfigFixture(t);
  const loaded = await loadRestoreProofConfig(configPath);
  assert.equal(loaded.expectedFinanceSchemaVersion, null);
  assert.equal(loaded.expectedKithSchemaVersion, null);
  assert.equal(loaded.scratchDatabase, false);
});

test("loadRestoreProofConfig still accepts a config carrying the old required expected schema versions", async (t) => {
  const configPath = await writeConfigFixture(t, {
    expectedFinanceSchemaVersion: 3,
    expectedKithSchemaVersion: 9,
  });
  const loaded = await loadRestoreProofConfig(configPath);
  assert.equal(loaded.expectedFinanceSchemaVersion, 3);
  assert.equal(loaded.expectedKithSchemaVersion, 9);
});

test("loadRestoreProofConfig rejects a non-integer expected schema version when the key is present", async (t) => {
  const configPath = await writeConfigFixture(t, { expectedFinanceSchemaVersion: 0 });
  await assert.rejects(
    loadRestoreProofConfig(configPath),
    (error) => error instanceof RestoreProofError && error.code === "config_invalid",
  );
});
const PG = ADMIN
  ? realpathSync(process.env.KITH_POSTGRES_17_BIN ?? "/opt/homebrew/opt/postgresql@17/bin")
  : "";

function databaseUrl(base, name) {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}
async function commandFile(root, name, value) {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${value}'\n`, { mode: 0o700 });
  return { path, args: [] };
}
async function sql(connection, statement) {
  await execute(join(PG, "psql"), [connection, "-X", "-v", "ON_ERROR_STOP=1", "-c", statement]);
}

async function tableCount(connection) {
  const { stdout } = await execute(join(PG, "psql"), [connection, "-X", "-tAc", "select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema')"]);
  return Number(stdout.trim());
}

test("published dump restores every row exactly while the source keeps moving, and refuses aliases, dirty targets, and a drifted manifest", { skip: !ADMIN }, async (t) => {
  const root = await mkdtemp(join(homedir(), ".kith-restore-proof-test-"));
  const suffix = Math.random().toString(16).slice(2, 12);
  const sourceName = `kith_restore_src_${suffix}`;
  const destinationName = `kith_restore_dst_${suffix}`;
  const changedName = `kith_restore_changed_${suffix}`;
  const scratchName = `kith_restore_proof_${suffix}`;
  const source = databaseUrl(ADMIN, sourceName);
  const destination = databaseUrl(ADMIN, destinationName);
  const changed = databaseUrl(ADMIN, changedName);
  const scratch = databaseUrl(ADMIN, scratchName);
  t.after(async () => {
    for (const name of [sourceName, destinationName, changedName, scratchName]) {
      await execute(join(PG, "dropdb"), ["--if-exists", "--force", "--maintenance-db", ADMIN, name]).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  for (const name of [sourceName, destinationName, changedName, scratchName]) {
    await execute(join(PG, "createdb"), ["--maintenance-db", ADMIN, name]);
  }
  await sql(source, "create schema finance; create schema kith; create table finance.schema_version(version integer primary key, name text not null); create table kith.schema_version(version integer primary key, name text not null); create table kith.parent(id text primary key, body text not null); create table kith.child(id text primary key, parent_id text not null references kith.parent(id)); insert into finance.schema_version values (3,'finance'); insert into kith.schema_version values (9,'kith'); insert into kith.parent values ('p1',E'bounded\\ntext'),('p2','other'); insert into kith.child values ('c1','p1');");
  const dumpPath = join(root, "kithmind.dump");
  await execute(join(PG, "pg_dump"), ["--format=custom", "--no-owner", "--no-acl", "--schema=finance", "--schema=kith", source, "-f", dumpPath]);
  await chmod(dumpPath, 0o600);
  const parity = await capturePostgresParity(join(PG, "psql"), source, 60_000);
  const dumpDigest = await hashFileSha256(dumpPath);
  const manifest = buildManifest({
    createdAt: "2026-09-13T00:00:00.000Z", host: "synthetic", operationId: "proof",
    database: sourceName, financeSchemaVersion: 3, kithSchemaVersion: 9, parity,
    gitRevision: "b".repeat(40),
    files: [{ name: "kithmind.dump", ...dumpDigest }],
  });
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const baseConfig = {
    version: 1,
    pgRestorePath: join(PG, "pg_restore"),
    psqlPath: join(PG, "psql"),
    sourceConnectionCommand: await commandFile(root, "source.sh", source),
    destinationConnectionCommand: await commandFile(root, "destination.sh", destination),
    expectedFinanceSchemaVersion: 3,
    expectedKithSchemaVersion: 9,
    timeoutMs: 60_000,
  };
  const corruptDumpPath = join(root, "corrupt.dump");
  const corruptDump = await readFile(dumpPath);
  corruptDump[corruptDump.length - 1] ^= 1;
  await writeFile(corruptDumpPath, corruptDump, { mode: 0o600 });
  await assert.rejects(
    restorePostgresProof(baseConfig, corruptDumpPath, manifestPath),
    { code: "dump_manifest_mismatch" },
  );

  // The live source keeps being written to between the dump and the proof
  // (a watcher heartbeat, the deferred-work daemon, an MCP write). The proof
  // compares the restored database with the manifest captured at dump time,
  // so this must not affect it.
  await sql(source, "update kith.parent set body='altered' where id='p1'; insert into kith.parent values ('p3','new');");
  const passed = await restorePostgresProof(baseConfig, dumpPath, manifestPath);
  assert.equal(passed.status, "passed");
  assert.equal(passed.tablesVerified, 4);
  // This fixture's schema has no `kith.documents` table (only the two
  // synthetic tables above), so the sampled-citation step degrades to
  // "not available" rather than failing the whole restore.
  assert.equal(passed.citationSample.attempted, true);
  assert.equal(passed.citationSample.available, false);
  assert.match(passed.citationSample.reason, /kith\.documents|kith-store read surface unavailable/);

  await assert.rejects(
    restorePostgresProof({ ...baseConfig, destinationConnectionCommand: await commandFile(root, "alias.sh", source.replace("127.0.0.1", "localhost")) }, dumpPath, manifestPath),
    { code: "restore_not_isolated" },
  );
  await assert.rejects(
    restorePostgresProof(baseConfig, dumpPath, manifestPath),
    { code: "restore_target_not_empty" },
  );
  await sql(changed, "create schema existing");
  const changedCommand = await commandFile(root, "dirty.sh", changed);
  await assert.rejects(
    restorePostgresProof({ ...baseConfig, destinationConnectionCommand: changedCommand }, dumpPath, manifestPath),
    { code: "restore_target_not_empty" },
  );

  // A manifest whose parity no longer describes the dump it names: the
  // restored database cannot match it, and the proof says exactly that.
  const driftedManifestPath = join(root, "drifted.json");
  await writeFile(driftedManifestPath, JSON.stringify(buildManifest({
    ...manifest,
    parity: await capturePostgresParity(join(PG, "psql"), source, 60_000),
    files: manifest.files,
  })), { mode: 0o600 });
  const freshName = `kith_restore_fresh_${suffix}`;
  await execute(join(PG, "createdb"), ["--maintenance-db", ADMIN, freshName]);
  t.after(() => execute(join(PG, "dropdb"), ["--if-exists", "--force", "--maintenance-db", ADMIN, freshName]).catch(() => {}));
  await assert.rejects(
    restorePostgresProof({ ...baseConfig, destinationConnectionCommand: await commandFile(root, "fresh.sh", databaseUrl(ADMIN, freshName)) }, dumpPath, driftedManifestPath),
    { code: "restore_parity_failed" },
  );

  // --- The opted-in scratch target recycles itself ---
  const scratchConfig = {
    ...baseConfig,
    destinationConnectionCommand: await commandFile(root, "scratch.sh", scratch),
  };
  // A run without the opt-in leaves the restored copy behind, exactly as a
  // previous day's run would.
  assert.equal((await restorePostgresProof(scratchConfig, dumpPath, manifestPath)).status, "passed");
  assert.ok((await tableCount(scratch)) > 0);
  await assert.rejects(
    restorePostgresProof(scratchConfig, dumpPath, manifestPath),
    { code: "restore_target_not_empty" },
  );
  // With the opt-in the next run starts anyway, and leaves the target empty.
  const recycled = await restorePostgresProof({ ...scratchConfig, scratchDatabase: true }, dumpPath, manifestPath);
  assert.equal(recycled.status, "passed");
  assert.equal(recycled.tablesVerified, 4);
  assert.equal(await tableCount(scratch), 0);
  // The reset must never reach the source, opt-in or not: the isolation check
  // runs first, and the source keeps every table.
  await assert.rejects(
    restorePostgresProof({ ...baseConfig, destinationConnectionCommand: baseConfig.sourceConnectionCommand, scratchDatabase: true }, dumpPath, manifestPath),
    { code: "restore_not_isolated" },
  );
  assert.equal(await tableCount(source), 4);
  // A target that is not named as a scratch database is refused, not emptied.
  await assert.rejects(
    restorePostgresProof({ ...baseConfig, destinationConnectionCommand: changedCommand, scratchDatabase: true }, dumpPath, manifestPath),
    { code: "scratch_database_name_invalid" },
  );
  const { stdout: survivors } = await execute(join(PG, "psql"), [changed, "-X", "-tAc", "select count(*) from pg_namespace where nspname='existing'"]);
  assert.equal(survivors.trim(), "1");
});

// BAK-1: schema versions are recorded, not pinned. A migration landing on the
// live source between the dump and the restore proof running must not fail
// the proof -- that pinned-expectation gate (`source_schema_mismatch`, an
// operator having to edit config after every migration) is exactly what this
// row removes. The only version comparison left is restored-versus-manifest.
test("a schema version bump on the live source after the dump does not fail the restore proof", { skip: !ADMIN }, async (t) => {
  const root = await mkdtemp(join(homedir(), ".kith-restore-proof-drift-test-"));
  const suffix = Math.random().toString(16).slice(2, 12);
  const sourceName = `kith_restore_drift_src_${suffix}`;
  const destinationName = `kith_restore_drift_dst_${suffix}`;
  const source = databaseUrl(ADMIN, sourceName);
  const destination = databaseUrl(ADMIN, destinationName);
  t.after(async () => {
    for (const name of [sourceName, destinationName]) {
      await execute(join(PG, "dropdb"), ["--if-exists", "--force", "--maintenance-db", ADMIN, name]).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  for (const name of [sourceName, destinationName]) {
    await execute(join(PG, "createdb"), ["--maintenance-db", ADMIN, name]);
  }
  await sql(source, "create schema finance; create schema kith; create table finance.schema_version(version integer primary key, name text not null); create table kith.schema_version(version integer primary key, name text not null); insert into finance.schema_version values (3,'finance'); insert into kith.schema_version values (9,'kith');");
  const dumpPath = join(root, "kithmind.dump");
  await execute(join(PG, "pg_dump"), ["--format=custom", "--no-owner", "--no-acl", "--schema=finance", "--schema=kith", source, "-f", dumpPath]);
  await chmod(dumpPath, 0o600);
  const parity = await capturePostgresParity(join(PG, "psql"), source, 60_000);
  const dumpDigest = await hashFileSha256(dumpPath);
  const manifest = buildManifest({
    createdAt: "2026-09-20T00:00:00.000Z", host: "synthetic", operationId: "proof",
    database: sourceName, financeSchemaVersion: 3, kithSchemaVersion: 9, parity,
    gitRevision: "b".repeat(40),
    files: [{ name: "kithmind.dump", ...dumpDigest }],
  });
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  // A migration lands on the live source after the dump was taken, and it
  // still carries a stale `expected*SchemaVersion` from before the change
  // (kept only for backward compatibility): neither should fail the proof.
  await sql(source, "insert into kith.schema_version values (10,'kith-migration');");
  const config = {
    version: 1,
    pgRestorePath: join(PG, "pg_restore"),
    psqlPath: join(PG, "psql"),
    sourceConnectionCommand: await commandFile(root, "source.sh", source),
    destinationConnectionCommand: await commandFile(root, "destination.sh", destination),
    expectedFinanceSchemaVersion: 3,
    expectedKithSchemaVersion: 9,
    timeoutMs: 60_000,
  };
  const passed = await restorePostgresProof(config, dumpPath, manifestPath);
  assert.equal(passed.status, "passed");
  // The restored database matches what was dumped (the manifest), not the
  // source's current, migrated-past-it version.
  assert.equal(passed.restored.kithVersion, 9);
  assert.equal(passed.source.kithVersion, 10);
});
