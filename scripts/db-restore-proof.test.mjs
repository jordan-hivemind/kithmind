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
import { restorePostgresProof } from "./db-restore-proof.mjs";

const execute = promisify(execFile);
const ADMIN = process.env.KITH_MIGRATE_TEST_DATABASE_URL;
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

test("published dump restores every row exactly and refuses aliases, dirty targets, and changed source data", { skip: !ADMIN }, async (t) => {
  const root = await mkdtemp(join(homedir(), ".kith-restore-proof-test-"));
  const suffix = Math.random().toString(16).slice(2, 12);
  const sourceName = `kith_restore_src_${suffix}`;
  const destinationName = `kith_restore_dst_${suffix}`;
  const changedName = `kith_restore_changed_${suffix}`;
  const source = databaseUrl(ADMIN, sourceName);
  const destination = databaseUrl(ADMIN, destinationName);
  const changed = databaseUrl(ADMIN, changedName);
  t.after(async () => {
    for (const name of [sourceName, destinationName, changedName]) {
      await execute(join(PG, "dropdb"), ["--if-exists", "--force", "--maintenance-db", ADMIN, name]).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  for (const name of [sourceName, destinationName, changedName]) {
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
  const passed = await restorePostgresProof(baseConfig, dumpPath, manifestPath);
  assert.equal(passed.status, "passed");
  assert.equal(passed.tablesVerified, 4);

  await assert.rejects(
    restorePostgresProof({ ...baseConfig, destinationConnectionCommand: await commandFile(root, "alias.sh", source.replace("127.0.0.1", "localhost")) }, dumpPath, manifestPath),
    { code: "restore_not_isolated" },
  );
  await assert.rejects(
    restorePostgresProof(baseConfig, dumpPath, manifestPath),
    { code: "restore_target_not_empty" },
  );
  await sql(changed, "create schema existing");
  await assert.rejects(
    restorePostgresProof({ ...baseConfig, destinationConnectionCommand: await commandFile(root, "dirty.sh", changed) }, dumpPath, manifestPath),
    { code: "restore_target_not_empty" },
  );
  await sql(source, "update kith.parent set body='altered' where id='p1'");
  const freshName = `kith_restore_fresh_${suffix}`;
  await execute(join(PG, "createdb"), ["--maintenance-db", ADMIN, freshName]);
  t.after(() => execute(join(PG, "dropdb"), ["--if-exists", "--force", "--maintenance-db", ADMIN, freshName]).catch(() => {}));
  await assert.rejects(
    restorePostgresProof({ ...baseConfig, destinationConnectionCommand: await commandFile(root, "fresh.sh", databaseUrl(ADMIN, freshName)) }, dumpPath, manifestPath),
    { code: "source_parity_failed" },
  );
});
