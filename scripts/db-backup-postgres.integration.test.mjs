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
async function sql(connection, statement) {
  await execute(join(PG, "psql"), [connection, "-X", "-v", "ON_ERROR_STOP=1", "-c", statement]);
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
  await sql(source, "create schema finance; create schema kith; create table finance.schema_version(version integer primary key, name text not null); create table kith.schema_version(version integer primary key, name text not null); create table finance.records(id text primary key, amount numeric not null); create table kith.notes(id text primary key, body text not null); insert into finance.schema_version values (3,'finance'); insert into kith.schema_version values (9,'kith'); insert into finance.records values ('r1',12.34); insert into kith.notes values ('n1',E'exact\\ntext');");

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
    expectedFinanceSchemaVersion: 3, expectedKithSchemaVersion: 9, timeoutMs: 60_000,
  }), { mode: 0o600 });
  const backupConfig = {
    version: 1, stateDirectory, stagingRoot, connectionCommand,
    psqlPath, pgDumpPath,
    ageBinary: agePath, ageRecipient: recipient, resticBinary: resticPath,
    resticRepositoryPath: repository, resticPasswordCommand: passwordCommand,
    expectedResticRepositoryId: repositoryId, host: "synthetic-host",
    operationId: "synthetic-proof", expectedDatabaseName: sourceName,
    expectedFinanceSchemaVersion: 3, expectedKithSchemaVersion: 9, timeoutMs: 60_000,
    gitRevision: "b".repeat(40),
  };
  const verifyConfig = {
    version: 1, ageBinary: agePath, ageIdentityPath: identity, restoreProofConfigPath: restoreConfigPath,
    resticBinary: resticPath, resticRepositoryPath: repository, resticPasswordCommand: passwordCommand,
    expectedResticRepositoryId: repositoryId, host: "synthetic-host",
    operationId: "synthetic-proof", timeoutMs: 60_000,
  };
  const managed = await runWithDatabaseBackupState(
    backupConfig,
    async ({ setStage }) => {
      const result = await runPostgresDatabaseBackup(backupConfig);
      const altered = structuredClone(result);
      altered.plaintexts["kithmind.dump.age"].sha256 = "0".repeat(64);
      await assert.rejects(verifyPostgresBackup(verifyConfig, altered), {
        code: "command_failed",
      });
      const stillEmpty = (await execute(join(PG, "psql"), [destination, "-tAc", "select count(*) from pg_tables where schemaname in ('finance','kith')"])).stdout.trim();
      assert.equal(stillEmpty, "0");
      await setStage("verify");
      return { result, verification: await verifyPostgresBackup(verifyConfig, result) };
    },
  );
  assert.equal(managed.verification.status, "passed");
  assert.equal(managed.verification.restore.tablesVerified, 4);
  const journal = JSON.parse(await readFile(join(stateDirectory, "database-backup-status.json"), "utf8"));
  assert.equal(journal.state, "succeeded");
  await assert.rejects(readFile(join(stateDirectory, "database-backup.lock")), { code: "ENOENT" });
});
