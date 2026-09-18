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
    { engine: "postgres", config: "/x", verify: true, verifyConfig: "/verify.json" },
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

test("runDbBackup routes --engine postgres to the postgres adapter only, and --verify runs verification", async () => {
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
      return { fake: "verify-config" };
    },
    runPostgresDatabaseBackup: async (config) => {
      calls.push(["run", config]);
      return { status: "passed", snapshotId: "s1" };
    },
    verifyPostgresBackup: async (config, result) => {
      calls.push(["verify", config, result]);
      return { status: "passed" };
    },
  };
  const output = await runDbBackup(
    ["--engine", "postgres", "--config", "/abs/pg.json", "--verify", "--verify-config", "/abs/verify.json"],
    {
      convexModule,
      postgresModule,
      stateRunner: async (_config, operation) =>
        operation({ setStage: async (stage) => calls.push(["stage", stage]) }),
    },
  );
  assert.deepEqual(calls, [
    ["load", "/abs/pg.json"],
    ["verify_load", "/abs/verify.json"],
    ["run", { fake: "pg-config" }],
    ["stage", "verify"],
    ["verify", { fake: "verify-config" }, { status: "passed", snapshotId: "s1" }],
  ]);
  assert.deepEqual(output, {
    engine: "postgres",
    result: { status: "passed", snapshotId: "s1" },
    verification: { status: "passed" },
  });
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
