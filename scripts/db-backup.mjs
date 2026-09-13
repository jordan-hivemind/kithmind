#!/usr/bin/env node
// Engine-selecting entry point for the dated-backup recipe (docs/plans/
// 2026-09-08-dated-database-backups.md, section 3 step 10 of
// docs/plans/2026-09-12-postgres-consolidation.md, tracker row P2-39k).
//
// `--engine convex` is today's behaviour, unchanged: it forwards to
// `run-database-backup.mjs`'s existing generic runner and private adapters
// exactly as before. `--engine postgres` is new: it runs the pg_dump-based
// export of both schemas defined in `db-backup-postgres.mjs`. Both engines
// stay available side by side until Convex is torn down in step 11, per the
// plan's 14-day read-only window.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export class DbBackupCliError extends Error {
  constructor(code) {
    super(code);
    this.name = "DbBackupCliError";
    this.code = code;
  }
}
function fail(code) {
  throw new DbBackupCliError(code);
}

const ENGINES = new Set(["convex", "postgres"]);

/** Pure argv parsing, kept separate from dispatch so flag routing is
 * unit-testable without spawning pg_dump, restic, or age. */
export function parseDbBackupArgs(argv) {
  let engine;
  let config;
  let verify = false;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--engine") engine = argv[(i += 1)];
    else if (arg === "--config") config = argv[(i += 1)];
    else if (arg === "--verify") verify = true;
    else rest.push(arg);
  }
  if (rest.length > 0) fail("usage_invalid");
  if (typeof engine !== "string" || !ENGINES.has(engine))
    fail("engine_invalid");
  if (typeof config !== "string" || config.length === 0)
    fail("config_required");
  if (verify && engine !== "postgres") fail("verify_requires_postgres_engine");
  return { engine, config, verify };
}

/**
 * `deps` exists only so tests can inject fake engine modules instead of
 * exercising real pg_dump/restic/age subprocesses. Production callers never
 * pass it; the dynamic imports below are the real, unchanged modules.
 */
export async function runDbBackup(argv, deps = {}) {
  const { engine, config, verify } = parseDbBackupArgs(argv);
  if (engine === "convex") {
    const convex =
      deps.convexModule ?? (await import("./run-database-backup.mjs"));
    const result = await convex.runDatabaseBackup(
      await convex.loadDatabaseBackupConfig(config),
    );
    return { engine, result };
  }
  const postgres =
    deps.postgresModule ?? (await import("./db-backup-postgres.mjs"));
  const loaded = await postgres.loadPostgresBackupConfig(config);
  const result = await postgres.runPostgresDatabaseBackup(loaded);
  if (!verify) return { engine, result };
  const verification = await postgres.verifyPostgresBackup(loaded, result);
  return { engine, result, verification };
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
async function main() {
  const output = await runDbBackup(process.argv.slice(2));
  process.stdout.write(
    `${JSON.stringify({ status: "passed", engine: output.engine })}\n`,
  );
}
if (isMain())
  main().catch((error) => {
    const code = error instanceof DbBackupCliError ? error.code : "runner_failed";
    process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
    process.exitCode = 1;
  });
