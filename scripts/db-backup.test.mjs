import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DbBackupCliError,
  parseDbBackupArgs,
  runDbBackup,
} from "./db-backup.mjs";
import { runWithDatabaseBackupState } from "./run-database-backup.mjs";

const SYSTEM_NODE = realpathSync(process.execPath);
const SHELL = realpathSync("/bin/sh");
const CLI = new URL("./db-backup.mjs", import.meta.url).pathname;

test("parseDbBackupArgs requires a known engine", () => {
  assert.throws(
    () => parseDbBackupArgs(["--config", "/x"]),
    (error) => error instanceof DbBackupCliError && error.code === "engine_invalid",
  );
  assert.throws(
    () => parseDbBackupArgs(["--engine", "convexx", "--config", "/x"]),
    (error) => error.code === "engine_invalid",
  );
});

test("parseDbBackupArgs requires a config path", () => {
  assert.throws(
    () => parseDbBackupArgs(["--engine", "postgres"]),
    (error) => error.code === "config_required",
  );
});

test("parseDbBackupArgs rejects --verify with the convex engine", () => {
  assert.throws(
    () =>
      parseDbBackupArgs([
        "--engine",
        "convex",
        "--config",
        "/x",
        "--verify",
      ]),
    (error) => error.code === "verify_requires_postgres_engine",
  );
});

test("parseDbBackupArgs requires a separate protected verify config", () => {
  assert.throws(
    () => parseDbBackupArgs(["--engine", "postgres", "--config", "/x", "--verify"]),
    (error) => error.code === "verify_config_required",
  );
});

test("parseDbBackupArgs rejects unknown arguments", () => {
  assert.throws(
    () =>
      parseDbBackupArgs(["--engine", "postgres", "--config", "/x", "--oops"]),
    (error) => error.code === "usage_invalid",
  );
});

test("parseDbBackupArgs accepts a valid postgres --verify invocation", () => {
  assert.deepEqual(
    parseDbBackupArgs(["--engine", "postgres", "--config", "/x", "--verify", "--verify-config", "/verify.json"]),
    { engine: "postgres", config: "/x", verify: true, verifyConfig: "/verify.json", proofNow: false },
  );
});

test("parseDbBackupArgs accepts --proof-now with the postgres engine", () => {
  assert.deepEqual(
    parseDbBackupArgs([
      "--engine", "postgres", "--config", "/x", "--verify", "--verify-config", "/verify.json", "--proof-now",
    ]),
    { engine: "postgres", config: "/x", verify: true, verifyConfig: "/verify.json", proofNow: true },
  );
});

test("parseDbBackupArgs rejects --proof-now with the convex engine", () => {
  assert.throws(
    () => parseDbBackupArgs(["--engine", "convex", "--config", "/x", "--proof-now"]),
    (error) => error.code === "proof_now_requires_postgres_engine",
  );
});

test("runDbBackup routes --engine convex to the unchanged Convex runner only", async () => {
  const calls = [];
  const convexModule = {
    loadDatabaseBackupConfig: async (path) => {
      calls.push(["load", path]);
      return { fake: "config" };
    },
    runDatabaseBackup: async (config) => {
      calls.push(["run", config]);
      return { status: "passed" };
    },
  };
  const postgresModule = {
    loadPostgresBackupConfig: async () => calls.push(["postgres_load"]),
    runPostgresDatabaseBackup: async () => calls.push(["postgres_run"]),
    verifyPostgresBackup: async () => calls.push(["postgres_verify"]),
  };
  const output = await runDbBackup(
    ["--engine", "convex", "--config", "/abs/config.json"],
    { convexModule, postgresModule },
  );
  assert.deepEqual(calls, [
    ["load", "/abs/config.json"],
    ["run", { fake: "config" }],
  ]);
  assert.deepEqual(output, { engine: "convex", result: { status: "passed" } });
});

// A fake stateRunner standing in for runWithDatabaseBackupState's real
// context object (`priorProof`/`recordProof`/`recordRetention`), so the
// cadence decision and the retention ordering in runDbBackup can be
// exercised without the durable status journal.
function fakeStateRunner(calls, priorProof) {
  return async (_config, operation) =>
    operation({
      setStage: async (stage) => calls.push(["stage", stage]),
      priorProof,
      recordProof: (next) => calls.push(["recordProof", next]),
      recordRetention: (next) => calls.push(["recordRetention", next]),
    });
}
// Every postgresModule fake below reaches retention after a passing verify
// (BAK-1 review row 3: retention runs only after verification succeeds), so
// each one needs this stubbed even when a given test's own assertions are
// about the proof cadence rather than retention.
function fakeRunPostgresRetention(calls) {
  return async () => {
    calls.push(["retention"]);
    return { status: "passed", dryRun: false, keptCount: 1, removedCount: 0, removedTimes: [] };
  };
}

test("runDbBackup routes --engine postgres to the postgres adapter only, runs a due restore proof, and records it", async () => {
  const calls = [];
  const convexModule = {
    loadDatabaseBackupConfig: async () => calls.push(["convex_load"]),
    runDatabaseBackup: async () => calls.push(["convex_run"]),
  };
  const postgresModule = {
    loadPostgresBackupConfig: async (path) => {
      calls.push(["load", path]);
      return { fake: "pg-config" };
    },
    loadPostgresVerifyConfig: async (path) => {
      calls.push(["verify_load", path]);
      return { fake: "verify-config", restoreProofEveryDays: 30 };
    },
    runPostgresDatabaseBackup: async (config) => {
      calls.push(["run", config]);
      return { status: "passed", snapshotId: "s1" };
    },
    verifyPostgresBackup: async (config, result, options) => {
      calls.push(["verify", config, result, options]);
      return { status: "passed", restore: { status: "passed" } };
    },
    runPostgresRetention: async (config) => {
      calls.push(["retention", config]);
      return { status: "passed", dryRun: false, keptCount: 7, removedCount: 2, removedTimes: [] };
    },
  };
  // No prior proof recorded: due on the very first backup.
  const output = await runDbBackup(
    ["--engine", "postgres", "--config", "/abs/pg.json", "--verify", "--verify-config", "/abs/verify.json"],
    {
      convexModule,
      postgresModule,
      clock: () => 1_000,
      stateRunner: fakeStateRunner(calls, { lastProofAt: null, nextProofDueAt: null }),
    },
  );
  assert.deepEqual(calls, [
    ["load", "/abs/pg.json"],
    ["verify_load", "/abs/verify.json"],
    ["run", { fake: "pg-config" }],
    ["stage", "verify"],
    [
      "verify",
      { fake: "verify-config", restoreProofEveryDays: 30 },
      { status: "passed", snapshotId: "s1" },
      { runRestoreProof: true },
    ],
    ["recordProof", { lastProofAt: 1_000, nextProofDueAt: 1_000 + 30 * 86_400_000 }],
    // Retention runs strictly after the verify call above, not before it.
    ["stage", "retention"],
    ["retention", { fake: "pg-config" }],
    ["recordRetention", { state: "ok", code: null, at: 1_000, removed: 2, kept: 7 }],
  ]);
  assert.deepEqual(output, {
    engine: "postgres",
    result: { status: "passed", snapshotId: "s1" },
    verification: { status: "passed", restore: { status: "passed" } },
    retention: { status: "passed", dryRun: false, keptCount: 7, removedCount: 2, removedTimes: [] },
    retentionState: "ok",
  });
});

test("runDbBackup skips the restore proof when one already passed within the cadence", async () => {
  const calls = [];
  const postgresModule = {
    loadPostgresBackupConfig: async () => ({ fake: "pg-config" }),
    loadPostgresVerifyConfig: async () => ({ restoreProofEveryDays: 30 }),
    runPostgresDatabaseBackup: async () => ({ status: "passed", snapshotId: "s1" }),
    verifyPostgresBackup: async (config, result, options) => {
      calls.push(["verify", options]);
      return { status: "passed", restore: { status: "skipped" } };
    },
    runPostgresRetention: fakeRunPostgresRetention(calls),
  };
  const now = 20 * 86_400_000;
  await runDbBackup(
    ["--engine", "postgres", "--config", "/abs/pg.json", "--verify", "--verify-config", "/abs/verify.json"],
    {
      postgresModule,
      clock: () => now,
      // A proof 10 days ago, well inside a 30-day cadence.
      stateRunner: fakeStateRunner(calls, { lastProofAt: now - 10 * 86_400_000, nextProofDueAt: now + 20 * 86_400_000 }),
    },
  );
  assert.deepEqual(
    calls.filter((call) => call[0] === "verify"),
    [["verify", { runRestoreProof: false }]],
  );
  // A skipped proof must never be recorded as one that ran.
  assert.deepEqual(calls.filter((call) => call[0] === "recordProof"), []);
  // Retention still runs regardless of the proof cadence decision.
  assert.deepEqual(calls.filter((call) => call[0] === "retention"), [["retention"]]);
});

test("runDbBackup forces the restore proof with --proof-now even inside the cadence", async () => {
  const calls = [];
  const postgresModule = {
    loadPostgresBackupConfig: async () => ({ fake: "pg-config" }),
    loadPostgresVerifyConfig: async () => ({ restoreProofEveryDays: 30 }),
    runPostgresDatabaseBackup: async () => ({ status: "passed", snapshotId: "s1" }),
    verifyPostgresBackup: async (config, result, options) => {
      calls.push(["verify", options]);
      return { status: "passed", restore: { status: "passed" } };
    },
    runPostgresRetention: fakeRunPostgresRetention(calls),
  };
  const now = 20 * 86_400_000;
  await runDbBackup(
    [
      "--engine", "postgres", "--config", "/abs/pg.json", "--verify",
      "--verify-config", "/abs/verify.json", "--proof-now",
    ],
    {
      postgresModule,
      clock: () => now,
      stateRunner: fakeStateRunner(calls, { lastProofAt: now - 10 * 86_400_000, nextProofDueAt: now + 20 * 86_400_000 }),
    },
  );
  assert.deepEqual(
    calls.filter((call) => call[0] === "verify"),
    [["verify", { runRestoreProof: true }]],
  );
});

test("runDbBackup runs a due restore proof once the cadence has elapsed", async () => {
  const calls = [];
  const postgresModule = {
    loadPostgresBackupConfig: async () => ({ fake: "pg-config" }),
    loadPostgresVerifyConfig: async () => ({ restoreProofEveryDays: 30 }),
    runPostgresDatabaseBackup: async () => ({ status: "passed", snapshotId: "s1" }),
    verifyPostgresBackup: async (config, result, options) => {
      calls.push(["verify", options]);
      return { status: "passed", restore: { status: "passed" } };
    },
    runPostgresRetention: fakeRunPostgresRetention(calls),
  };
  const now = 40 * 86_400_000;
  await runDbBackup(
    ["--engine", "postgres", "--config", "/abs/pg.json", "--verify", "--verify-config", "/abs/verify.json"],
    {
      postgresModule,
      clock: () => now,
      // A proof 31 days ago: overdue against a 30-day cadence.
      stateRunner: fakeStateRunner(calls, { lastProofAt: now - 31 * 86_400_000, nextProofDueAt: now - 86_400_000 }),
    },
  );
  assert.deepEqual(
    calls.filter((call) => call[0] === "verify"),
    [["verify", { runRestoreProof: true }]],
  );
});

// P2-101: the restore proof's own code has to survive two process boundaries
// and the state runner to be worth reporting at all. This proves the last
// hop: a verify failure carrying `restore_proof_failed:<code>` reaches the
// caller and the durable status file instead of being flattened.
test("a restore-proof failure code reaches the caller and the status file", async (t) => {
  const stateDirectory = await mkdtemp(join(homedir(), ".kith-db-backup-state-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const failure = Object.assign(new Error("verify failed"), {
    code: "restore_proof_failed:restore_parity_failed",
  });
  const postgresModule = {
    loadPostgresBackupConfig: async () => ({ stateDirectory }),
    loadPostgresVerifyConfig: async () => ({}),
    runPostgresDatabaseBackup: async () => ({ status: "passed", snapshotId: "s1" }),
    verifyPostgresBackup: async () => {
      throw failure;
    },
  };
  await assert.rejects(
    runDbBackup(
      ["--engine", "postgres", "--config", "/abs/pg.json", "--verify", "--verify-config", "/abs/verify.json"],
      { postgresModule },
    ),
    (error) => error.code === "restore_proof_failed:restore_parity_failed",
  );
  const journal = JSON.parse(
    await readFile(join(stateDirectory, "database-backup-status.json"), "utf8"),
  );
  assert.equal(journal.state, "failed");
  assert.equal(journal.stage, "verify");
  assert.equal(journal.failureCode, "restore_proof_failed:restore_parity_failed");
  // BAK-1 review row 3: retention must never run against an unverified
  // backup. It is recorded as skipped, not silently left unset, so a health
  // check can tell "verify failed" apart from "retention not attempted yet".
  assert.equal(journal.retention.state, "skipped");
  assert.equal(journal.retention.code, null);
});

test("postgres CLI cannot report success without restore verification", () => {
  assert.throws(
    () => parseDbBackupArgs(["--engine", "postgres", "--config", "/abs/pg.json"]),
    (error) => error.code === "postgres_requires_verify",
  );
});

// BAK-1 second review, row 1 and row 3: the tests above stand in for
// runWithDatabaseBackupState with `fakeStateRunner`, which only records
// `setStage` calls and never validates them, so all of them kept passing
// while `setStage("retention")` (line 118 above) threw `status_invalid`
// against the real runner -- `retention` was missing from its valid-stage
// set. These three drive the REAL runWithDatabaseBackupState (the default
// `stateRunner`, the same shared journal a live postgres run uses) through
// runDbBackup's actual callback, so a stage this file learns to set that the
// runner does not yet accept as valid fails here again, honestly, instead of
// only in production.
function fakePostgresModule(overrides = {}) {
  return {
    loadPostgresBackupConfig: async () => overrides.backupConfig ?? {},
    loadPostgresVerifyConfig: async () =>
      overrides.verifyConfig ?? { restoreProofEveryDays: 30 },
    runPostgresDatabaseBackup:
      overrides.runPostgresDatabaseBackup ??
      (async () => ({ status: "passed", snapshotId: "s1" })),
    verifyPostgresBackup:
      overrides.verifyPostgresBackup ??
      (async () => ({ status: "passed", restore: { status: "passed" } })),
    runPostgresRetention:
      overrides.runPostgresRetention ??
      (async () => ({
        status: "passed",
        dryRun: false,
        keptCount: 1,
        removedCount: 0,
        removedTimes: [],
      })),
  };
}
async function stateFixture(t) {
  const stateDirectory = await mkdtemp(join(homedir(), ".kith-db-backup-e2e-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  return stateDirectory;
}
const journalOf = async (stateDirectory) =>
  JSON.parse(
    await readFile(join(stateDirectory, "database-backup-status.json"), "utf8"),
  );
const lockPathOf = (stateDirectory) =>
  join(stateDirectory, "database-backup.lock");

test("runDbBackup drives the real runWithDatabaseBackupState through every stage db-backup.mjs sets, ending at retention then complete", async (t) => {
  const stateDirectory = await stateFixture(t);
  const postgresModule = fakePostgresModule({ backupConfig: { stateDirectory } });
  const output = await runDbBackup(
    ["--engine", "postgres", "--config", "/abs/pg.json", "--verify", "--verify-config", "/abs/verify.json"],
    { postgresModule, stateRunner: runWithDatabaseBackupState },
  );
  assert.equal(output.retention.status, "passed");
  const journal = await journalOf(stateDirectory);
  assert.equal(journal.state, "succeeded");
  assert.equal(journal.stage, "complete");
  assert.equal(journal.retention.state, "ok");
  assert.equal(journal.retention.removed, 0);
  assert.equal(journal.retention.kept, 1);
  await assert.rejects(readFile(lockPathOf(stateDirectory)), { code: "ENOENT" });
});

test("runDbBackup's real ordering runs backup, then verify, then retention -- a verify failure records retention as skipped, fails the run, and releases the lock", async (t) => {
  const stateDirectory = await stateFixture(t);
  const calls = [];
  const postgresModule = fakePostgresModule({
    backupConfig: { stateDirectory },
    runPostgresDatabaseBackup: async () => {
      calls.push("backup");
      return { status: "passed", snapshotId: "s1" };
    },
    verifyPostgresBackup: async () => {
      calls.push("verify");
      throw Object.assign(new Error("bad"), { code: "restore_proof_failed:x" });
    },
    runPostgresRetention: async () => {
      calls.push("retention");
      return { status: "passed", dryRun: false, keptCount: 1, removedCount: 0, removedTimes: [] };
    },
  });
  await assert.rejects(
    runDbBackup(
      ["--engine", "postgres", "--config", "/abs/pg.json", "--verify", "--verify-config", "/abs/verify.json"],
      { postgresModule, stateRunner: runWithDatabaseBackupState },
    ),
    (error) => error.code === "restore_proof_failed:x",
  );
  // Retention never ran: ordering holds even on the failure path.
  assert.deepEqual(calls, ["backup", "verify"]);
  const journal = await journalOf(stateDirectory);
  assert.equal(journal.state, "failed");
  assert.equal(journal.stage, "verify");
  assert.equal(journal.retention.state, "skipped");
  assert.equal(journal.retention.code, null);
  await assert.rejects(readFile(lockPathOf(stateDirectory)), { code: "ENOENT" });
});

test("a failure during the backup step -- before retention is ever reached -- is recorded failed, releases the lock, and does not report a stale prior retention outcome as this run's own", async (t) => {
  const stateDirectory = await stateFixture(t);
  // A prior successful run recorded retention "ok".
  await runWithDatabaseBackupState({ stateDirectory }, async ({ recordRetention }) => {
    recordRetention({ state: "ok", code: null, at: 1, removed: 2, kept: 3 });
    return {};
  });
  const postgresModule = fakePostgresModule({
    backupConfig: { stateDirectory },
    runPostgresDatabaseBackup: async () => {
      throw Object.assign(new Error("boom"), { code: "command_failed" });
    },
  });
  await assert.rejects(
    runDbBackup(
      ["--engine", "postgres", "--config", "/abs/pg.json", "--verify", "--verify-config", "/abs/verify.json"],
      { postgresModule, stateRunner: runWithDatabaseBackupState },
    ),
    (error) => error.code === "command_failed",
  );
  const journal = await journalOf(stateDirectory);
  assert.equal(journal.state, "failed");
  assert.equal(journal.stage, "export");
  // Not the prior run's "ok" -- this run never reached retention at all, so
  // it must not read as though retention succeeded this run.
  assert.equal(journal.retention.state, "skipped");
  assert.equal(journal.retention.removed, null);
  assert.equal(journal.retention.kept, null);
  await assert.rejects(readFile(lockPathOf(stateDirectory)), { code: "ENOENT" });
});

// BAK-1 second review, "also worth doing": the CLI's success line now
// reports the retention outcome, not just the engine. Run against the real
// CLI process (the convex engine, which needs no restic/pg_dump/age
// fixtures) so this proves the actual stdout contract, not a mock of it.
test("the CLI success line reports retention: null for the convex engine, which has no retention step", async (t) => {
  const root = await mkdtemp(join(homedir(), ".kith-db-backup-cli-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  const stagingRoot = join(root, "staging");
  await mkdir(stateDirectory, { mode: 0o700 });
  await mkdir(stagingRoot, { mode: 0o700 });
  const helper = join(root, "helper.mjs");
  await writeFile(
    helper,
    `flag=$1\ndirectory=$2\nprintf '%s' "$directory" > "$directory/\${flag#--}.txt"\nprintf '{"status":"passed"}\\n'\n`,
    { mode: 0o700 },
  );
  const config = {
    version: 1,
    stateDirectory,
    stagingRoot,
    cwd: root,
    timeoutMs: 2_000,
    exportCommand: { path: SHELL, args: [helper] },
    backupCommand: { path: SHELL, args: [helper] },
  };
  const configPath = join(root, "config.json");
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  const output = await new Promise((ok, no) =>
    execFile(
      SYSTEM_NODE,
      [CLI, "--engine", "convex", "--config", configPath],
      { encoding: "utf8" },
      (error, stdout) => (error ? no(error) : ok(stdout)),
    ),
  );
  assert.deepEqual(JSON.parse(output), {
    status: "passed",
    engine: "convex",
    retention: null,
  });
});
