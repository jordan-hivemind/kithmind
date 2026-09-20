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
import {
  DatabaseBackupRunnerError,
  runWithDatabaseBackupState,
} from "./run-database-backup.mjs";

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
  let verifyConfig;
  let verify = false;
  let proofNow = false;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--engine") engine = argv[(i += 1)];
    else if (arg === "--config") config = argv[(i += 1)];
    else if (arg === "--verify-config") verifyConfig = argv[(i += 1)];
    else if (arg === "--verify") verify = true;
    else if (arg === "--proof-now") proofNow = true;
    else rest.push(arg);
  }
  if (rest.length > 0) fail("usage_invalid");
  if (typeof engine !== "string" || !ENGINES.has(engine))
    fail("engine_invalid");
  if (typeof config !== "string" || config.length === 0)
    fail("config_required");
  if (verify && engine !== "postgres") fail("verify_requires_postgres_engine");
  if (verify && (typeof verifyConfig !== "string" || verifyConfig.length === 0))
    fail("verify_config_required");
  if (engine === "postgres" && !verify) fail("postgres_requires_verify");
  if (!verify && verifyConfig !== undefined) fail("verify_config_without_verify");
  if (proofNow && engine !== "postgres") fail("proof_now_requires_postgres_engine");
  return { engine, config, verify, verifyConfig, proofNow };
}

/**
 * `deps` exists only so tests can inject fake engine modules instead of
 * exercising real pg_dump/restic/age subprocesses. Production callers never
 * pass it; the dynamic imports below are the real, unchanged modules.
 */
export async function runDbBackup(argv, deps = {}) {
  const { engine, config, verify, verifyConfig, proofNow } = parseDbBackupArgs(argv);
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
  const loadedVerify = await postgres.loadPostgresVerifyConfig(verifyConfig);
  const stateRunner = deps.stateRunner ?? runWithDatabaseBackupState;
  const clock = deps.clock ?? Date.now;
  return stateRunner(loaded, async ({ setStage, priorProof, recordProof, recordRetention }) => {
    const result = await postgres.runPostgresDatabaseBackup(loaded);
    await setStage("verify");
    // The isolated restore proof runs on a cadence
    // (`restoreProofEveryDays`), not every backup: due when it has never
    // passed, when the configured interval has elapsed since it last did, or
    // when the operator forces it with `--proof-now`.
    const everyMs = loadedVerify.restoreProofEveryDays * 86_400_000;
    const runRestoreProof =
      proofNow || priorProof.lastProofAt === null ||
      clock() - priorProof.lastProofAt >= everyMs;
    let verification;
    try {
      verification = await postgres.verifyPostgresBackup(
        loadedVerify,
        result,
        { runRestoreProof },
      );
    } catch (error) {
      // Retention (forget/prune) must never run against an unverified
      // backup: pruning here could age an older, known-good snapshot out on
      // the strength of a new one that turns out not to verify (BAK-1
      // review). Record why retention was skipped this run rather than
      // leaving the field silently unchanged, so a health check reading the
      // status file can tell "skipped because verify failed" apart from
      // "not attempted yet".
      recordRetention({ state: "skipped", code: null, at: clock(), removed: null, kept: null });
      throw error;
    }
    if (verification.restore?.status === "passed") {
      const at = clock();
      recordProof({ lastProofAt: at, nextProofDueAt: at + everyMs });
    }
    await setStage("retention");
    const retention = await postgres.runPostgresRetention(loaded);
    recordRetention({
      state: retention.status === "passed" ? "ok" : "failed",
      code: retention.code ?? null,
      at: clock(),
      removed: retention.removedCount ?? null,
      kept: retention.keptCount ?? null,
    });
    return { engine, result, verification, retention };
  });
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
    // `runWithDatabaseBackupState` already recorded this code in the status
    // file and rethrows it. Reporting `runner_failed` here instead is what
    // hid every engine failure, including the restore proof's own code, from
    // the operator's log.
    const code =
      error instanceof DbBackupCliError ||
      error instanceof DatabaseBackupRunnerError
        ? error.code
        : "runner_failed";
    process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
    process.exitCode = 1;
  });
