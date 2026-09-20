import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DbBackupCliError,
  parseDbBackupArgs,
  runDbBackup,
} from "./db-backup.mjs";

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
// context object (`priorProof`/`recordProof`), so the cadence decision in
// runDbBackup can be exercised without the durable status journal.
function fakeStateRunner(calls, priorProof) {
  return async (_config, operation) =>
    operation({
      setStage: async (stage) => calls.push(["stage", stage]),
      priorProof,
      recordProof: (next) => calls.push(["recordProof", next]),
    });
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
  ]);
  assert.deepEqual(output, {
    engine: "postgres",
    result: { status: "passed", snapshotId: "s1" },
    verification: { status: "passed", restore: { status: "passed" } },
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
});

test("postgres CLI cannot report success without restore verification", () => {
  assert.throws(
    () => parseDbBackupArgs(["--engine", "postgres", "--config", "/abs/pg.json"]),
    (error) => error.code === "postgres_requires_verify",
  );
});
