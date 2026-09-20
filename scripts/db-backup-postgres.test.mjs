import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PostgresBackupError,
  WRITER_LEASE_TABLES,
  buildManifest,
  exportSnapshot,
  loadPostgresBackupConfig,
  loadPostgresVerifyConfig,
  parseForgetArgs,
  requireNoActiveWriters,
  resticForget,
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

test("loadPostgresBackupConfig accepts a long plugin age recipient and rejects a malformed one", async (t) => {
  const fixtureState = await fixture(t);
  const configPath = join(fixtureState.root, "backup.json");
  const plugin = `age1pq1${"q".repeat(1950)}`;
  await writeFile(
    configPath,
    JSON.stringify(backupConfig(fixtureState, { ageRecipient: plugin })),
    { mode: 0o600 },
  );
  assert.equal((await loadPostgresBackupConfig(configPath)).ageRecipient, plugin);
  for (const ageRecipient of ["age1short", "AGE-SECRET-KEY-1QQQQ", `x${plugin}`]) {
    await writeFile(
      configPath,
      JSON.stringify(backupConfig(fixtureState, { ageRecipient })),
      { mode: 0o600 },
    );
    await assert.rejects(
      loadPostgresBackupConfig(configPath),
      (error) => error.code === "config_invalid",
    );
  }
});

test("loadPostgresBackupConfig accepts restic's rclone repository spec", async (t) => {
  const fixtureState = await fixture(t);
  const configPath = join(fixtureState.root, "backup.json");
  await writeFile(
    configPath,
    JSON.stringify(
      backupConfig(fixtureState, {
        resticRepositoryPath: "rclone:kith_remote:Kith Mind/backups/database/restic-v1",
      }),
    ),
    { mode: 0o600 },
  );
  const config = await loadPostgresBackupConfig(configPath);
  assert.equal(
    config.resticRepositoryPath,
    "rclone:kith_remote:Kith Mind/backups/database/restic-v1",
  );
});

test("loadPostgresBackupConfig rejects a relative or non-rclone remote repository", async (t) => {
  const fixtureState = await fixture(t);
  for (const resticRepositoryPath of ["relative/repo", "sftp:host:/repo", "rclone:bad remote:x"]) {
    const configPath = join(fixtureState.root, "backup.json");
    await writeFile(
      configPath,
      JSON.stringify(backupConfig(fixtureState, { resticRepositoryPath })),
      { mode: 0o600 },
    );
    await assert.rejects(
      loadPostgresBackupConfig(configPath),
      (error) => error.code === "config_invalid",
    );
  }
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

test("loadPostgresVerifyConfig accepts restic's rclone repository spec", async (t) => {
  const fixtureState = await fixture(t);
  const identityPath = join(fixtureState.root, "identity.txt");
  await writeFile(identityPath, "AGE-SECRET-KEY-1FAKE\n", { mode: 0o600 });
  const configPath = join(fixtureState.root, "verify.json");
  await writeFile(
    configPath,
    JSON.stringify(
      verifyConfig(fixtureState, {
        ageIdentityPath: identityPath,
        resticRepositoryPath: "rclone:kith_remote:backups/restic-v1",
      }),
    ),
    { mode: 0o600 },
  );
  const loaded = await loadPostgresVerifyConfig(configPath);
  assert.equal(loaded.resticRepositoryPath, "rclone:kith_remote:backups/restic-v1");
});

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

// P2-101: the snapshot holder is the one long-lived session in the recipe. A
// fake psql stands in for a hosted server here, so both failure modes are
// covered without a database: an answer that is not a snapshot id, and a
// session that is gone by the time the dump finishes.
async function fakePsql(root, name, body) {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return path;
}

test("a holder that answers with something other than a snapshot id fails closed", async (t) => {
  const { root } = await fixture(t);
  // Reads the script on stdin, answers with a line that is not an id.
  const psql = await fakePsql(root, "not-an-id.sh", "printf 'ERROR: pooled\\n'\nexec cat >/dev/null");
  await assert.rejects(
    exportSnapshot(psql, "postgres://fake/db", 5_000),
    (error) => error.code === "snapshot_export_failed",
  );
});

test("a holder that exits before the dump finishes fails the run rather than publishing", async (t) => {
  const { root } = await fixture(t);
  const psql = await fakePsql(root, "dies.sh", "printf '00000003-0000001B-1\\n'\nexit 1");
  const snapshot = await exportSnapshot(psql, "postgres://fake/db", 5_000);
  assert.equal(snapshot.id, "00000003-0000001B-1");
  await new Promise((wake) => setTimeout(wake, 50));
  await assert.rejects(
    snapshot.release(),
    (error) => error.code === "snapshot_holder_lost",
  );
});

test("a holder that survives the dump releases cleanly", async (t) => {
  const { root } = await fixture(t);
  const psql = await fakePsql(root, "holds.sh", "printf '00000003-0000001B-1\\n'\nexec cat >/dev/null");
  const snapshot = await exportSnapshot(psql, "postgres://fake/db", 5_000);
  await snapshot.release();
});

// BAK-1: schema versions are recorded (read from the database and written
// into the manifest by `preflight`/`buildManifest`), not pinned. Both configs
// still accept `expected*SchemaVersion` for backward compatibility, but the
// keys are now optional, and loading a config that omits them must not fail.

test("loadPostgresBackupConfig accepts a config with no expected schema versions", async (t) => {
  const fixtureState = await fixture(t);
  const configPath = join(fixtureState.root, "config.json");
  const config = backupConfig(fixtureState);
  delete config.expectedFinanceSchemaVersion;
  delete config.expectedKithSchemaVersion;
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const loaded = await loadPostgresBackupConfig(configPath);
  assert.equal(loaded.expectedFinanceSchemaVersion, null);
  assert.equal(loaded.expectedKithSchemaVersion, null);
});

test("loadPostgresBackupConfig defaults retention to 7 daily / 5 weekly / 12 monthly", async (t) => {
  const fixtureState = await fixture(t);
  const configPath = join(fixtureState.root, "config.json");
  await writeFile(configPath, JSON.stringify(backupConfig(fixtureState)), { mode: 0o600 });
  const loaded = await loadPostgresBackupConfig(configPath);
  assert.deepEqual(loaded.resticRetention, { keepDaily: 7, keepWeekly: 5, keepMonthly: 12 });
});

test("loadPostgresBackupConfig accepts an overridden retention policy and rejects a malformed one", async (t) => {
  const fixtureState = await fixture(t);
  const configPath = join(fixtureState.root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify(backupConfig(fixtureState, { resticRetention: { keepDaily: 3, keepWeekly: 1, keepMonthly: 6 } })),
    { mode: 0o600 },
  );
  const loaded = await loadPostgresBackupConfig(configPath);
  assert.deepEqual(loaded.resticRetention, { keepDaily: 3, keepWeekly: 1, keepMonthly: 6 });
  await writeFile(
    configPath,
    JSON.stringify(backupConfig(fixtureState, { resticRetention: { keepDaily: -1, keepWeekly: 1, keepMonthly: 6 } })),
    { mode: 0o600 },
  );
  await assert.rejects(
    loadPostgresBackupConfig(configPath),
    (error) => error.code === "config_invalid",
  );
});

test("loadPostgresVerifyConfig defaults restoreProofEveryDays to 30 and accepts an override", async (t) => {
  const fixtureState = await fixture(t);
  const identityPath = join(fixtureState.root, "identity.txt");
  await writeFile(identityPath, "AGE-SECRET-KEY-1FAKE\n", { mode: 0o600 });
  const configPath = join(fixtureState.root, "verify.json");
  await writeFile(
    configPath,
    JSON.stringify(verifyConfig(fixtureState, { ageIdentityPath: identityPath })),
    { mode: 0o600 },
  );
  assert.equal((await loadPostgresVerifyConfig(configPath)).restoreProofEveryDays, 30);
  await writeFile(
    configPath,
    JSON.stringify(verifyConfig(fixtureState, { ageIdentityPath: identityPath, restoreProofEveryDays: 7 })),
    { mode: 0o600 },
  );
  assert.equal((await loadPostgresVerifyConfig(configPath)).restoreProofEveryDays, 7);
});

// BAK-1: retention scoping (`--host`, `--tag kith-db`, the three keep counts)
// and the --dry-run/--prune split, exercised against a fake restic that just
// echoes its own argv back as the "forget" JSON report, and separately fails
// closed so a caller can prove the failure never reaches past resticForget's
// own boundary (runPostgresDatabaseBackup catches it and marks retention
// failed instead of failing the backup -- proven end to end in the postgres
// integration test, which has a real restic binary to fail against).

async function fakeResticForget(root, body) {
  const path = join(root, "restic-forget.sh");
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return path;
}

test("resticForget scopes forget to the host and the kith-db tag, with the configured retention counts and --group-by host", async (t) => {
  const { root } = await fixture(t);
  const captured = join(root, "argv.txt");
  const restic = await fakeResticForget(
    root,
    `printf '%s\\n' "$@" > '${captured}'\nprintf '[{"keep":[],"remove":[]}]'`,
  );
  const result = await resticForget(
    restic, "/abs/repo", "'/bin/true'", "kith-db-01",
    { keepDaily: 7, keepWeekly: 5, keepMonthly: 12 }, 5_000, false,
  );
  assert.equal(result.status, "passed");
  assert.equal(result.dryRun, false);
  assert.equal(result.keptCount, 0);
  assert.equal(result.removedCount, 0);
  const argv = (await readFile(captured, "utf8")).trim().split("\n");
  // Exact argv, not just presence: `--group-by host` is load-bearing (BAK-1
  // review row 1) -- without it every uniquely-timestamped staging
  // directory's snapshot lands in its own restic default `host,paths` group,
  // and "keep N" trivially keeps a group of one, so retention would remove
  // nothing, forever, while --prune ran every night for no reason.
  assert.deepEqual(argv, [
    "--repo", "/abs/repo",
    "--password-command", "'/bin/true'",
    "--no-cache",
    "forget", "--json",
    "--host", "kith-db-01",
    "--tag", "kith-db",
    "--group-by", "host",
    "--keep-daily", "7",
    "--keep-weekly", "5",
    "--keep-monthly", "12",
    "--prune",
  ]);
});

test("resticForget's --dry-run reports counts and snapshot times, with --prune omitted", async (t) => {
  const { root } = await fixture(t);
  const captured = join(root, "argv.txt");
  const restic = await fakeResticForget(
    root,
    `printf '%s\\n' "$@" > '${captured}'\nprintf '[{"keep":[{"time":"2026-01-01T00:00:00Z"}],"remove":[{"time":"2025-01-01T00:00:00Z"},{"time":"2025-02-01T00:00:00Z"}]}]'`,
  );
  const result = await resticForget(
    restic, "/abs/repo", "'/bin/true'", "kith-db-01",
    { keepDaily: 7, keepWeekly: 5, keepMonthly: 12 }, 5_000, true,
  );
  assert.equal(result.dryRun, true);
  assert.equal(result.keptCount, 1);
  assert.equal(result.removedCount, 2);
  assert.deepEqual(result.removedTimes, ["2025-01-01T00:00:00Z", "2025-02-01T00:00:00Z"]);
  const argv = await readFile(captured, "utf8");
  assert.ok(argv.includes("--dry-run"));
  assert.ok(!argv.includes("--prune"));
});

test("resticForget fails closed on output that is not a JSON array of groups", async (t) => {
  const { root } = await fixture(t);
  const restic = await fakeResticForget(root, "printf 'not json'");
  await assert.rejects(
    resticForget(restic, "/abs/repo", "'/bin/true'", "kith-db-01", { keepDaily: 7, keepWeekly: 5, keepMonthly: 12 }, 5_000, true),
    (error) => error instanceof PostgresBackupError && error.code === "retention_output_invalid",
  );
});

// BAK-1 second review, "also worth doing": the `--forget` operator command
// used to prune a real repository by default unless an operator remembered
// `--dry-run`. It is dry-run by default now; `--apply` is required to
// actually delete/prune, and any argument this command does not recognize is
// rejected instead of silently ignored (a typo like `--force` used to just
// do nothing and still prune).
test("parseForgetArgs defaults to dry-run (apply: false) with only --config given", () => {
  assert.deepEqual(parseForgetArgs(["--config", "/abs/backup.json"]), {
    configPath: "/abs/backup.json",
    apply: false,
  });
});

test("parseForgetArgs requires --apply to opt into deleting/pruning", () => {
  assert.deepEqual(
    parseForgetArgs(["--config", "/abs/backup.json", "--apply"]),
    { configPath: "/abs/backup.json", apply: true },
  );
});

test("parseForgetArgs requires --config", () => {
  assert.throws(
    () => parseForgetArgs(["--apply"]),
    (error) => error instanceof PostgresBackupError && error.code === "usage_invalid",
  );
  assert.throws(
    () => parseForgetArgs([]),
    (error) => error.code === "usage_invalid",
  );
});

test("parseForgetArgs rejects stray arguments, including the old --dry-run flag", () => {
  for (const argv of [
    ["--config", "/abs/backup.json", "--dry-run"],
    ["--config", "/abs/backup.json", "--force"],
    ["--config", "/abs/backup.json", "--apply", "extra"],
  ]) {
    assert.throws(
      () => parseForgetArgs(argv),
      (error) => error.code === "usage_invalid",
      `expected usage_invalid for ${JSON.stringify(argv)}`,
    );
  }
});
