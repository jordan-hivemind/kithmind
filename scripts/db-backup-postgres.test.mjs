import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PostgresBackupError,
  WRITER_LEASE_TABLES,
  buildManifest,
  loadPostgresBackupConfig,
  loadPostgresVerifyConfig,
  requireNoActiveWriters,
} from "./db-backup-postgres.mjs";

const HEX_64 = "a".repeat(64);

async function fixture(t) {
  const root = await mkdtemp(join(homedir(), ".kith-db-backup-postgres-test-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  const stagingRoot = join(root, "staging");
  await mkdir(stateDirectory, { mode: 0o700 });
  await mkdir(stagingRoot, { mode: 0o700 });
  const tool = join(root, "tool.sh");
  await writeFile(tool, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const restoreProofConfigPath = join(root, "restore.json");
  await writeFile(restoreProofConfigPath, "{}", { mode: 0o600 });
  return { root, stateDirectory, stagingRoot, tool, restoreProofConfigPath };
}

function backupConfig({ stateDirectory, stagingRoot, tool }, overrides = {}) {
  return {
    version: 1,
    stateDirectory,
    stagingRoot,
    connectionCommand: { path: tool, args: [] },
    psqlPath: tool,
    pgDumpPath: tool,
    ageBinary: tool,
    ageRecipient: "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    resticBinary: tool,
    resticRepositoryPath: "/abs/repo",
    resticPasswordCommand: { path: tool, args: [] },
    expectedResticRepositoryId: HEX_64,
    host: "kith-db-01",
    operationId: "dated-backup",
    expectedDatabaseName: "kithmind",
    expectedFinanceSchemaVersion: 3,
    expectedKithSchemaVersion: 6,
    gitRevision: "b".repeat(40),
    timeoutMs: 60_000,
    ...overrides,
  };
}

test("buildManifest is a pure record of the export date, versions, files and hashes", () => {
  const manifest = buildManifest({
    createdAt: "2026-09-12T00:00:00.000Z",
    host: "kith-db-01",
    operationId: "dated-backup",
    database: "kithmind",
    financeSchemaVersion: 3,
    kithSchemaVersion: 6,
    gitRevision: "b".repeat(40),
    parity: {
      version: 1,
      tables: [],
      invalidConstraints: 0,
    },
    files: [{ name: "kithmind.dump", sha256: "deadbeef", byteLength: 1024 }],
  });
  assert.deepEqual(manifest, {
    version: 1,
    engine: "postgres",
    createdAt: "2026-09-12T00:00:00.000Z",
    host: "kith-db-01",
    operationId: "dated-backup",
    database: "kithmind",
    financeSchemaVersion: 3,
    kithSchemaVersion: 6,
    gitRevision: "b".repeat(40),
    parity: {
      version: 1,
      tables: [],
      invalidConstraints: 0,
    },
    files: [{ name: "kithmind.dump", sha256: "deadbeef", byteLength: 1024 }],
  });
});

test("loadPostgresBackupConfig accepts a well-formed protected config", async (t) => {
  const fixtureState = await fixture(t);
  const configPath = join(fixtureState.root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify(backupConfig(fixtureState)),
    { mode: 0o600 },
  );
  const loaded = await loadPostgresBackupConfig(configPath);
  assert.equal(loaded.expectedDatabaseName, "kithmind");
  assert.equal(loaded.expectedResticRepositoryId, HEX_64);
});

test("loadPostgresBackupConfig rejects an extra or missing key", async (t) => {
  const fixtureState = await fixture(t);
  const configPath = join(fixtureState.root, "config.json");
  const bad = backupConfig(fixtureState);
  bad.extraKey = "nope";
  await writeFile(configPath, JSON.stringify(bad), { mode: 0o600 });
  await assert.rejects(
    loadPostgresBackupConfig(configPath),
    (error) => error instanceof PostgresBackupError && error.code === "config_invalid",
  );
});

test("loadPostgresBackupConfig rejects a non-hex-64 restic repository id", async (t) => {
  const fixtureState = await fixture(t);
  const configPath = join(fixtureState.root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify(backupConfig(fixtureState, { expectedResticRepositoryId: "not-hex" })),
    { mode: 0o600 },
  );
  await assert.rejects(
    loadPostgresBackupConfig(configPath),
    (error) => error.code === "config_invalid",
  );
});

test("loadPostgresBackupConfig rejects a relative command path", async (t) => {
  const fixtureState = await fixture(t);
  const configPath = join(fixtureState.root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify(backupConfig(fixtureState, { pgDumpPath: "pg_dump" })),
    { mode: 0o600 },
  );
  await assert.rejects(
    loadPostgresBackupConfig(configPath),
    (error) => error.code === "config_invalid",
  );
});

test("loadPostgresBackupConfig rejects a world- or group-writable staging root", async (t) => {
  const fixtureState = await fixture(t);
  await chmod(fixtureState.stagingRoot, 0o755);
  const configPath = join(fixtureState.root, "config.json");
  await writeFile(configPath, JSON.stringify(backupConfig(fixtureState)), {
    mode: 0o600,
  });
  await assert.rejects(loadPostgresBackupConfig(configPath));
});

function verifyConfig({ tool, restoreProofConfigPath }, overrides = {}) {
  return {
    version: 1,
    ageBinary: tool,
    ageIdentityPath: tool,
    restoreProofConfigPath,
    resticBinary: tool,
    resticRepositoryPath: "/abs/repo",
    resticPasswordCommand: { path: tool, args: [] },
    expectedResticRepositoryId: HEX_64,
    host: "kith-db-01",
    operationId: "dated-backup",
    timeoutMs: 60_000,
    ...overrides,
  };
}

test("loadPostgresVerifyConfig requires the age identity file to be mode 0600", async (t) => {
  const fixtureState = await fixture(t);
  const identityPath = join(fixtureState.root, "identity.txt");
  // writeFile's `mode` option is masked by this process's umask (the module
  // under test sets a strict one at import time, like the runner it borrows
  // helpers from), so widen permissions with a separate chmod instead.
  await writeFile(identityPath, "AGE-SECRET-KEY-1FAKE\n", { mode: 0o600 });
  await chmod(identityPath, 0o644);
  const configPath = join(fixtureState.root, "verify.json");
  await writeFile(
    configPath,
    JSON.stringify(verifyConfig(fixtureState, { ageIdentityPath: identityPath })),
    { mode: 0o600 },
  );
  await assert.rejects(
    loadPostgresVerifyConfig(configPath),
    (error) => error.code === "file_not_protected",
  );
});

test("loadPostgresVerifyConfig accepts a protected age identity file", async (t) => {
  const fixtureState = await fixture(t);
  const identityPath = join(fixtureState.root, "identity.txt");
  await writeFile(identityPath, "AGE-SECRET-KEY-1FAKE\n", { mode: 0o600 });
  const configPath = join(fixtureState.root, "verify.json");
  await writeFile(
    configPath,
    JSON.stringify(verifyConfig(fixtureState, { ageIdentityPath: identityPath })),
    { mode: 0o600 },
  );
  const loaded = await loadPostgresVerifyConfig(configPath);
  assert.equal(loaded.ageIdentityPath, identityPath);
});

// requireNoActiveWriters exercised against a fake query function, not a real
// database: AGENTS.md's writer-quiescence rule (P2-39k), applied every time
// the dated-backup postgres engine runs, not only at cutover.

function fakeQuery(counts) {
  const calls = [];
  const runQuery = async (sql) => {
    calls.push(sql);
    for (const [pattern, count] of Object.entries(counts)) {
      if (sql.includes(pattern)) return String(count);
    }
    return "0";
  };
  runQuery.calls = calls;
  return runQuery;
}

test("requireNoActiveWriters resolves when nothing is running or leased", async () => {
  const runQuery = fakeQuery({});
  await requireNoActiveWriters(runQuery);
  assert.equal(runQuery.calls.length, 1 + WRITER_LEASE_TABLES.length);
  assert.match(runQuery.calls[0], /kith\.deferred_work/);
  assert.match(runQuery.calls[0], /state = 'running'/);
});

test("requireNoActiveWriters refuses and names kith.deferred_work when a row is running", async () => {
  const runQuery = fakeQuery({ "kith.deferred_work": 2 });
  await assert.rejects(
    requireNoActiveWriters(runQuery),
    (error) =>
      error instanceof PostgresBackupError &&
      error.code === "writer_active" &&
      /kith\.deferred_work has 2 row\(s\) in state running/.test(error.detail),
  );
  // A deferred_work refusal stops before checking any lease table.
  assert.equal(runQuery.calls.length, 1);
});

test("requireNoActiveWriters refuses and names the specific worker lease table", async () => {
  const runQuery = fakeQuery({ "kith.worker_discovery_work": 1 });
  await assert.rejects(
    requireNoActiveWriters(runQuery),
    (error) =>
      error instanceof PostgresBackupError &&
      error.code === "writer_active" &&
      /kith\.worker_discovery_work has 1 unexpired worker lease\(s\)/.test(error.detail),
  );
});

test("requireNoActiveWriters checks every known worker lease table", async () => {
  for (const table of WRITER_LEASE_TABLES) {
    const runQuery = fakeQuery({ [table]: 3 });
    await assert.rejects(
      requireNoActiveWriters(runQuery),
      (error) => error.code === "writer_active" && error.detail.startsWith(table),
    );
  }
});

test("requireNoActiveWriters rejects a non-numeric count from the query function", async () => {
  const runQuery = async () => "not-a-number";
  await assert.rejects(
    requireNoActiveWriters(runQuery),
    (error) => error instanceof PostgresBackupError && error.code === "writer_check_failed",
  );
});

test("loadPostgresVerifyConfig never accepts a database connection field", async (t) => {
  const fixtureState = await fixture(t);
  const identityPath = join(fixtureState.root, "identity.txt");
  await writeFile(identityPath, "AGE-SECRET-KEY-1FAKE\n", { mode: 0o600 });
  const configPath = join(fixtureState.root, "verify.json");
  const withConnection = verifyConfig(fixtureState, {
    ageIdentityPath: identityPath,
  });
  withConnection.connectionCommand = { path: fixtureState.tool, args: [] };
  await writeFile(configPath, JSON.stringify(withConnection), { mode: 0o600 });
  await assert.rejects(
    loadPostgresVerifyConfig(configPath),
    (error) => error.code === "config_invalid",
  );
});
