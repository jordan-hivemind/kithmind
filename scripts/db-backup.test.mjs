import assert from "node:assert/strict";
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

test("parseDbBackupArgs rejects unknown arguments", () => {
  assert.throws(
    () =>
      parseDbBackupArgs(["--engine", "postgres", "--config", "/x", "--oops"]),
    (error) => error.code === "usage_invalid",
  );
});

test("parseDbBackupArgs accepts a valid postgres --verify invocation", () => {
  assert.deepEqual(
    parseDbBackupArgs(["--engine", "postgres", "--config", "/x", "--verify"]),
    { engine: "postgres", config: "/x", verify: true },
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
    ["--engine", "postgres", "--config", "/abs/pg.json", "--verify"],
    { convexModule, postgresModule },
  );
  assert.deepEqual(calls, [
    ["load", "/abs/pg.json"],
    ["run", { fake: "pg-config" }],
    ["verify", { fake: "pg-config" }, { status: "passed", snapshotId: "s1" }],
  ]);
  assert.deepEqual(output, {
    engine: "postgres",
    result: { status: "passed", snapshotId: "s1" },
    verification: { status: "passed" },
  });
});

test("runDbBackup does not verify when --verify is absent", async () => {
  const postgresModule = {
    loadPostgresBackupConfig: async () => ({}),
    runPostgresDatabaseBackup: async () => ({ status: "passed" }),
    verifyPostgresBackup: async () => {
      throw new Error("must not be called");
    },
  };
  const output = await runDbBackup(
    ["--engine", "postgres", "--config", "/abs/pg.json"],
    { convexModule: {}, postgresModule },
  );
  assert.deepEqual(output, {
    engine: "postgres",
    result: { status: "passed" },
  });
});
