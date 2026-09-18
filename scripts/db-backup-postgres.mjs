#!/usr/bin/env node
// The postgres engine for the dated-backup recipe (docs/plans/
// 2026-09-08-dated-database-backups.md, step 10 of
// docs/plans/2026-09-12-postgres-consolidation.md, tracker row P2-39k).
//
// Replaces the native Convex export with `pg_dump` of both schemas
// (`finance` and `kith`) from one database. This component supplies the
// database preflight, protected staging, content manifest, encryption, restic
// repository identity, separate-process byte equality, and isolated restore.
// Secrets (the connection string, the restic password, the age
// private identity) are never embedded in configuration; each is read from a
// protected command or file the owner already has, exactly as the existing
// Convex recipe's adapters do.
// This is the engine component. Owner orchestration still proves the external
// storage-folder identity, quiesces writers, and records the operational run.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  createReadStream,
  createWriteStream,
  lstatSync,
  realpathSync,
} from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  DatabaseBackupRunnerError,
  absolute as sharedAbsolute,
  exact as sharedExact,
  fsyncDirectory,
  protectedDirectory as sharedProtectedDirectory,
  protectedExecutable as sharedProtectedExecutable,
  readProtected as sharedReadProtected,
  text as sharedText,
  writeAll,
} from "./run-database-backup.mjs";
import { capturePostgresParity, SNAPSHOT_ID } from "./db-postgres-parity.mjs";
import { RESTORE_PROOF_CODES } from "./db-restore-proof.mjs";

process.umask(0o077);

// The shared validation helpers above are borrowed from the Convex runner
// rather than re-implemented (same protected-path rules, one audited copy),
// but they raise their own error class. Rethrow under this module's own
// class so every caller here can catch one error type with a stable `.code`.
function rethrown(code) {
  throw new PostgresBackupError(code);
}
function wrapSync(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (error) {
      if (error instanceof DatabaseBackupRunnerError) rethrown(error.code);
      throw error;
    }
  };
}
function wrapAsync(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof DatabaseBackupRunnerError) rethrown(error.code);
      throw error;
    }
  };
}
const exact = wrapSync(sharedExact);
const text = wrapSync(sharedText);
const absolute = wrapSync(sharedAbsolute);
const protectedDirectory = wrapAsync(sharedProtectedDirectory);
const protectedExecutable = wrapAsync(sharedProtectedExecutable);
const readProtected = wrapAsync(sharedReadProtected);

// Pinned to match the versions already required elsewhere in this repo
// (docs/pdf-pipeline-development.md), so a silent tool upgrade cannot change
// this recipe's behaviour unnoticed.
const AGE_VERSION = "v1.3.2";
const RESTIC_VERSION_RE =
  /^restic 0\.19\.1 compiled with go[0-9.]+ on [a-z0-9_./-]+$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SECRET_BYTES = 4_096;
const MAX_DUMP_BYTES = 2 * 1024 * 1024 * 1024;
// ponytail: a single flat limit, not a tiered one; raise it (or stream the
// dump straight into age instead of staging a plaintext copy) once the real
// archive's dump routinely nears it.
const MAX_COMMAND_OUTPUT_BYTES = 262_144;
const DEFAULT_TIMEOUT_MS = 600_000;
const POSTGRES_MAJOR = "17";

export class PostgresBackupError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "PostgresBackupError";
    this.code = code;
    this.detail = detail;
  }
}
function fail(code, detail) {
  throw new PostgresBackupError(code, detail);
}

// Every code this module can report, including the restore proof's own codes
// re-exported under a prefix so the verify worker can say which check inside
// the proof failed without inventing new text. `db-backup-failure-codes.
// test.mjs` asserts this set stays complete as the module changes.
export const POSTGRES_BACKUP_CODES = new Set([
  "age_version_mismatch",
  "command_failed",
  "command_not_canonical",
  "command_not_protected",
  "command_output_too_large",
  "command_spawn_failed",
  "command_timeout",
  "config_invalid",
  "constraint_inventory_invalid",
  "database_identity_invalid",
  "directory_not_private",
  "dump_size_out_of_bounds",
  "file_not_protected",
  "parity_manifest_invalid",
  "path_not_canonical",
  "path_not_protected",
  "postgres_client_version_mismatch",
  "preflight_constraints_invalid",
  "preflight_database_mismatch",
  "preflight_finance_schema_mismatch",
  "preflight_kith_schema_mismatch",
  "preflight_query_failed",
  "published_manifest_invalid",
  "restic_backup_summary_missing",
  "restic_repository_identity_mismatch",
  "restic_repository_unreadable",
  "restic_version_mismatch",
  "restore_worker_output_invalid",
  "row_count_invalid",
  "runner_failed",
  "secret_command_empty",
  "snapshot_export_failed",
  "snapshot_holder_lost",
  "snapshot_id_invalid",
  "table_inventory_invalid",
  "unknown",
  "usage_invalid",
  "verify_payload_invalid",
  "verify_readback_mismatch",
  "verify_worker_output_invalid",
  "writer_active",
  "writer_check_failed",
  ...[...RESTORE_PROOF_CODES, "unknown"].map((code) => `restore_proof_failed:${code}`),
]);

/** Reads a failed child's own `{"status":"failed","code":...}` line and
 * returns that code, accepting only codes the child is known to emit. An
 * unreadable or unknown answer becomes `unknown` rather than free text, so a
 * failure code is always one of a closed set. */
function childFailureCode(error, allowed, prefix = "") {
  const lines = String(error?.stderr ?? "").trim().split("\n");
  let parsed;
  try {
    parsed = JSON.parse(lines[lines.length - 1]);
  } catch {
    parsed = undefined;
  }
  const code =
    parsed?.status === "failed" && allowed.has(parsed.code) ? parsed.code : "unknown";
  return `${prefix}${code}`;
}

// A restic repository is either a local absolute path or restic's rclone
// backend spec (`rclone:<remote>:<path>`), which is how the owner's
// Dropbox-independent repository is reached. restic finds `rclone` on PATH.
const RCLONE_REPOSITORY = /^rclone:[A-Za-z0-9][A-Za-z0-9_-]{0,63}:[^\0]{1,1024}$/;
function resticRepository(value) {
  const spec = text(value, 1100);
  if (RCLONE_REPOSITORY.test(spec)) return spec;
  return absolute(spec);
}

// An age recipient is a bech32 string; plugin recipients (`age1<plugin>1...`,
// such as the post-quantum plugin's) run to a few thousand characters, so
// the bound is well above a native X25519 recipient's 62.
const AGE_RECIPIENT = /^age1[a-z0-9]{58,4000}$/;
function ageRecipient(value) {
  const recipient = text(value, 4096);
  if (!AGE_RECIPIENT.test(recipient)) fail("config_invalid");
  return recipient;
}

function parseSecretCommand(value) {
  const row = exact(value, ["path", "args"]);
  if (!Array.isArray(row.args) || row.args.length > 16) fail("config_invalid");
  return {
    path: absolute(row.path),
    args: row.args.map((argument) => text(argument, 256)),
  };
}

function parseBackupConfig(value) {
  const row = exact(value, [
    "version",
    "stateDirectory",
    "stagingRoot",
    "connectionCommand",
    "psqlPath",
    "pgDumpPath",
    "ageBinary",
    "ageRecipient",
    "resticBinary",
    "resticRepositoryPath",
    "resticPasswordCommand",
    "expectedResticRepositoryId",
    "host",
    "operationId",
    "expectedDatabaseName",
    "expectedFinanceSchemaVersion",
    "expectedKithSchemaVersion",
    "gitRevision",
    "timeoutMs",
  ]);
  if (row.version !== 1) fail("config_invalid");
  if (
    !Number.isSafeInteger(row.timeoutMs) ||
    row.timeoutMs < 1_000 ||
    row.timeoutMs > 3_600_000
  )
    fail("config_invalid");
  if (!HEX_64.test(row.expectedResticRepositoryId)) fail("config_invalid");
  if (!OPAQUE_ID.test(row.host) || !OPAQUE_ID.test(row.operationId))
    fail("config_invalid");
  if (typeof row.gitRevision !== "string" || !/^[a-f0-9]{40}$/.test(row.gitRevision))
    fail("config_invalid");
  if (
    !Number.isSafeInteger(row.expectedFinanceSchemaVersion) ||
    row.expectedFinanceSchemaVersion < 1 ||
    !Number.isSafeInteger(row.expectedKithSchemaVersion) ||
    row.expectedKithSchemaVersion < 1
  )
    fail("config_invalid");
  return {
    version: 1,
    stateDirectory: absolute(row.stateDirectory),
    stagingRoot: absolute(row.stagingRoot),
    connectionCommand: parseSecretCommand(row.connectionCommand),
    psqlPath: absolute(row.psqlPath),
    pgDumpPath: absolute(row.pgDumpPath),
    ageBinary: absolute(row.ageBinary),
    ageRecipient: ageRecipient(row.ageRecipient),
    resticBinary: absolute(row.resticBinary),
    resticRepositoryPath: resticRepository(row.resticRepositoryPath),
    resticPasswordCommand: parseSecretCommand(row.resticPasswordCommand),
    expectedResticRepositoryId: row.expectedResticRepositoryId,
    host: row.host,
    operationId: row.operationId,
    expectedDatabaseName: text(row.expectedDatabaseName, 200),
    expectedFinanceSchemaVersion: row.expectedFinanceSchemaVersion,
    expectedKithSchemaVersion: row.expectedKithSchemaVersion,
    gitRevision: row.gitRevision,
    timeoutMs: row.timeoutMs,
  };
}

async function validateBackupConfigPaths(config) {
  await Promise.all([
    protectedDirectory(config.stateDirectory, true),
    protectedDirectory(config.stagingRoot, true),
    protectedExecutable(config.connectionCommand.path),
    protectedExecutable(config.psqlPath),
    protectedExecutable(config.pgDumpPath),
    protectedExecutable(config.ageBinary),
    protectedExecutable(config.resticBinary),
    protectedExecutable(config.resticPasswordCommand.path),
  ]);
}

export async function loadPostgresBackupConfig(path) {
  const configPath = absolute(path);
  let value;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readProtected(configPath, 65_536),
      ),
    );
  } catch (error) {
    if (error instanceof PostgresBackupError) throw error;
    fail("config_invalid");
  }
  const config = parseBackupConfig(value);
  await validateBackupConfigPaths(config);
  return config;
}

// The verify-only identity never travels with the backup config: the
// exporter that can publish a dump must not also be able to decrypt one.
function parseVerifyConfig(value) {
  const row = exact(value, [
    "version",
    "ageBinary",
    "ageIdentityPath",
    "restoreProofConfigPath",
    "resticBinary",
    "resticRepositoryPath",
    "resticPasswordCommand",
    "expectedResticRepositoryId",
    "host",
    "operationId",
    "timeoutMs",
  ]);
  if (row.version !== 1) fail("config_invalid");
  if (!HEX_64.test(row.expectedResticRepositoryId)) fail("config_invalid");
  if (!OPAQUE_ID.test(row.host) || !OPAQUE_ID.test(row.operationId))
    fail("config_invalid");
  if (
    !Number.isSafeInteger(row.timeoutMs) ||
    row.timeoutMs < 1_000 ||
    row.timeoutMs > 3_600_000
  )
    fail("config_invalid");
  return {
    version: 1,
    ageBinary: absolute(row.ageBinary),
    ageIdentityPath: absolute(row.ageIdentityPath),
    restoreProofConfigPath: absolute(row.restoreProofConfigPath),
    resticBinary: absolute(row.resticBinary),
    resticRepositoryPath: resticRepository(row.resticRepositoryPath),
    resticPasswordCommand: parseSecretCommand(row.resticPasswordCommand),
    expectedResticRepositoryId: row.expectedResticRepositoryId,
    host: row.host,
    operationId: row.operationId,
    timeoutMs: row.timeoutMs,
  };
}

// Validates the isolated restore worker's `citationSample` field (step 10's
// "returns a sampled cited answer"): a fixed shape so this strict verify path
// can check it without trusting the subprocess's JSON any further than the
// rest of `restore`. `available` is only ever true here because
// `db-restore-proof.mjs` itself fails the whole restore on a hash mismatch
// rather than reporting one; this still asserts that invariant rather than
// assuming it.
function validCitationSample(value) {
  const keys = [
    "attempted",
    "available",
    "reason",
    "documentId",
    "documentTitle",
    "question",
    "citationHashMatched",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.sort().join() ||
    typeof value.attempted !== "boolean" ||
    typeof value.available !== "boolean" ||
    (value.reason !== null && typeof value.reason !== "string")
  )
    return false;
  if (value.available) {
    return (
      typeof value.documentId === "string" &&
      typeof value.documentTitle === "string" &&
      typeof value.question === "string" &&
      value.citationHashMatched === true
    );
  }
  return (
    value.documentId === null &&
    value.documentTitle === null &&
    value.question === null &&
    value.citationHashMatched === null
  );
}

function protectedFile(path) {
  if (realpathSync(path) !== path) fail("file_not_protected");
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== 0o600
  )
    fail("file_not_protected");
}

export async function loadPostgresVerifyConfig(path) {
  const configPath = absolute(path);
  let value;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readProtected(configPath, 65_536),
      ),
    );
  } catch (error) {
    if (error instanceof PostgresBackupError) throw error;
    fail("config_invalid");
  }
  const config = parseVerifyConfig(value);
  await protectedDirectory(dirname(config.ageIdentityPath));
  protectedFile(config.ageIdentityPath);
  protectedFile(config.restoreProofConfigPath);
  await protectedExecutable(config.ageBinary);
  await protectedExecutable(config.resticBinary);
  await protectedExecutable(config.resticPasswordCommand.path);
  return config;
}

function runCapture(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let child;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      finish(new PostgresBackupError("command_spawn_failed"));
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(new PostgresBackupError("command_timeout"));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const stdout = [];
    let stdoutBytes = 0;
    const stderr = [];
    let stderrBytes = 0;
    const maxOutput = options.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES;
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutput) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        finish(new PostgresBackupError("command_output_too_large"));
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxOutput) stderr.push(chunk);
    });
    child.once("error", () =>
      finish(new PostgresBackupError("command_spawn_failed")),
    );
    child.once("close", (code, signal) => {
      if (signal || code !== 0) {
        // Carry the child's own stderr on the error. A child of this recipe
        // reports a closed-enum failure code as JSON there, and dropping it
        // here is what turned every restore-proof failure into a bare
        // `command_failed`. Only `childFailureCode` reads it, and only through
        // an allowlist, so nothing free-form escapes.
        const failure = new PostgresBackupError("command_failed");
        failure.stderr = Buffer.concat(stderr);
        finish(failure, undefined);
        return;
      }
      finish(undefined, {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function runToProtectedFile(command, args, path, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errors = [];
  let errorBytes = 0;
  child.stderr.on("data", (chunk) => {
    errorBytes += chunk.length;
    if (errorBytes <= MAX_COMMAND_OUTPUT_BYTES) errors.push(chunk);
  });
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) callback(new PostgresBackupError("command_output_too_large"));
      else callback(undefined, chunk);
    },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  const exited = new Promise((resolvePromise, rejectPromise) => {
    child.once("error", () => rejectPromise(new PostgresBackupError("command_spawn_failed")));
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) rejectPromise(new PostgresBackupError(signal === "SIGKILL" ? "command_timeout" : "command_failed"));
      else if (code !== 0) rejectPromise(new PostgresBackupError("command_failed"));
      else resolvePromise();
    });
  });
  try {
    await Promise.all([
      exited,
      pipeline(
        child.stdout,
        limiter,
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      ),
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    await rm(path, { force: true });
    if (error instanceof PostgresBackupError) throw error;
    fail("command_failed");
  }
}

async function secret(command, timeoutMs) {
  const result = await runCapture(command.path, command.args, {
    timeoutMs,
    maxOutputBytes: MAX_SECRET_BYTES,
  });
  const value = result.stdout.toString("utf8").replace(/\r?\n$/, "");
  if (!value) fail("secret_command_empty");
  return value;
}

async function requireAgeVersion(ageBinary, timeoutMs) {
  const result = await runCapture(ageBinary, ["--version"], { timeoutMs });
  if (result.stdout.toString("utf8").trim() !== AGE_VERSION)
    fail("age_version_mismatch");
}
async function requireResticVersion(resticBinary, timeoutMs) {
  const result = await runCapture(resticBinary, ["version"], { timeoutMs });
  if (!RESTIC_VERSION_RE.test(result.stdout.toString("utf8").trim()))
    fail("restic_version_mismatch");
}
async function requirePostgresClientVersion(binary, timeoutMs) {
  const result = await runCapture(binary, ["--version"], { timeoutMs });
  if (!new RegExp(`PostgreSQL\\) ${POSTGRES_MAJOR}\\.`).test(result.stdout.toString("utf8"))) {
    fail("postgres_client_version_mismatch");
  }
}

async function psqlScalar(config, connectionString, sql) {
  const result = await runCapture(
    config.psqlPath,
    [connectionString, "-v", "ON_ERROR_STOP=1", "-tAc", sql],
    { timeoutMs: config.timeoutMs },
  );
  const value = result.stdout.toString("utf8").trim();
  if (!value) fail("preflight_query_failed");
  return value;
}

/** Explicit deployment preflight: the connected database and both schemas'
 * recorded versions must match what the recipe was told to expect, in the
 * same credential context used for the dump. */
async function preflight(config, connectionString) {
  const database = await psqlScalar(
    config,
    connectionString,
    "select current_database()",
  );
  if (database !== config.expectedDatabaseName)
    fail("preflight_database_mismatch");
  const financeVersion = Number(
    await psqlScalar(
      config,
      connectionString,
      "select max(version) from finance.schema_version",
    ),
  );
  if (financeVersion !== config.expectedFinanceSchemaVersion)
    fail("preflight_finance_schema_mismatch");
  const kithVersion = Number(
    await psqlScalar(
      config,
      connectionString,
      "select max(version) from kith.schema_version",
    ),
  );
  if (kithVersion !== config.expectedKithSchemaVersion)
    fail("preflight_kith_schema_mismatch");
  return { database, financeVersion, kithVersion };
}

// Every kith table that carries a `lease_expires_at` column for its own
// worker-claim protocol (migrations 002, 004, 008, 010). A backup started
// while one of these is unexpired can dump a row mid-write, so the recipe
// refuses to start rather than publish a torn snapshot.
export const WRITER_LEASE_TABLES = [
  "kith.worker_jobs",
  "kith.ingest_jobs",
  "kith.worker_discovery_work",
  "kith.worker_reservation_targets",
];

/** AGENTS.md's archive-writer quiescence rule, applied to the dated-backup
 * engine: refuse to start a dump while any kith writer looks active, and say
 * exactly which one. Takes `runQuery(sql) => Promise<string>` (a scalar text
 * result, matching `psqlScalar`'s shape) rather than a connection string, so
 * it can be exercised with a fake query function in tests that never open a
 * real database. */
export async function requireNoActiveWriters(runQuery) {
  const deferredRunning = Number(
    await runQuery(
      "select count(*) from kith.deferred_work where state = 'running'",
    ),
  );
  if (!Number.isSafeInteger(deferredRunning) || deferredRunning < 0)
    fail("writer_check_failed");
  if (deferredRunning > 0) {
    fail(
      "writer_active",
      `kith.deferred_work has ${deferredRunning} row(s) in state running`,
    );
  }
  for (const table of WRITER_LEASE_TABLES) {
    const active = Number(
      await runQuery(
        `select count(*) from ${table} where lease_expires_at is not null and lease_expires_at > now()`,
      ),
    );
    if (!Number.isSafeInteger(active) || active < 0) fail("writer_check_failed");
    if (active > 0) {
      fail(
        "writer_active",
        `${table} has ${active} unexpired worker lease(s)`,
      );
    }
  }
}

/** Opens a REPEATABLE READ transaction on the source and exports its
 * snapshot, then holds that transaction open until `release()`. `pg_dump
 * --snapshot` and the parity capture both import the same id, so the dump and
 * the manifest parity that the restore proof compares against describe one
 * consistent instant. Without this the two read a database that never stops
 * being written to, and no restore could ever match the manifest.
 *
 * `release()` fails if the holding session died in the meantime, because a
 * snapshot whose exporting transaction ended no longer guarantees anything. */
function exportSnapshot(psqlPath, connectionString, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(
        psqlPath,
        [connectionString, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        },
      );
    } catch {
      rejectPromise(new PostgresBackupError("command_spawn_failed"));
      return;
    }
    let settled = false;
    let output = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill("SIGKILL");
        rejectPromise(error);
      } else resolvePromise(value);
    };
    const timer = setTimeout(
      () => finish(new PostgresBackupError("command_timeout")),
      timeoutMs,
    );
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (!output.includes("\n")) return;
      const id = output.split("\n")[0].trim();
      if (!SNAPSHOT_ID.test(id)) {
        finish(new PostgresBackupError("snapshot_export_failed"));
        return;
      }
      finish(undefined, {
        id,
        abort: () => child.kill("SIGKILL"),
        release: () =>
          new Promise((resolveRelease, rejectRelease) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              rejectRelease(new PostgresBackupError("snapshot_holder_lost"));
              return;
            }
            const releaseTimer = setTimeout(() => {
              child.kill("SIGKILL");
            }, timeoutMs);
            child.once("close", (code, signal) => {
              clearTimeout(releaseTimer);
              if (signal || code !== 0)
                rejectRelease(new PostgresBackupError("snapshot_holder_lost"));
              else resolveRelease();
            });
            child.stdin.end("commit;\n");
          }),
      });
    });
    child.once("error", () =>
      finish(new PostgresBackupError("command_spawn_failed")),
    );
    child.once("close", () =>
      finish(new PostgresBackupError("snapshot_export_failed")),
    );
    child.stdin.write(
      "begin transaction isolation level repeatable read;\nselect pg_export_snapshot();\n",
    );
  });
}

async function freshStagingDirectory(config, tag) {
  const directory = join(
    config.stagingRoot,
    `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${tag}`,
  );
  await mkdir(directory, { mode: 0o700 });
  await fsyncDirectory(config.stagingRoot);
  await protectedDirectory(directory, true);
  return directory;
}

async function dumpBothSchemas(config, connectionString, stagingDirectory, snapshotId) {
  const dumpPath = join(stagingDirectory, "kithmind.dump");
  await runCapture(
    config.pgDumpPath,
    [
      `--snapshot=${snapshotId}`,
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--schema=finance",
      "--schema=kith",
      // pg_dump's `--schema` filter excludes extensions, which always live
      // outside the schemas they are dumped for (`vector` lives in
      // `public`). `kith.embedding_vectors.embedding` is `public.vector`, so
      // without this an isolated restore into a genuinely empty database
      // fails on that one table's CREATE TABLE with "type public.vector does
      // not exist" -- proven by hand against this repo's own migrations
      // before this line was added. `--extension` is additive with
      // `--schema`, not a replacement for it.
      "--extension=vector",
      connectionString,
      "-f",
      dumpPath,
    ],
    { timeoutMs: config.timeoutMs },
  );
  return dumpPath;
}

function hashFile(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    let byteLength = 0;
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      byteLength += chunk.length;
      hash.update(chunk);
    });
    stream.on("error", rejectPromise);
    stream.on("end", () =>
      resolvePromise({ sha256: hash.digest("hex"), byteLength }),
    );
  });
}

async function requireBoundedFile(path) {
  const digest = await hashFile(path);
  if (digest.byteLength < 1 || digest.byteLength > MAX_DUMP_BYTES)
    fail("dump_size_out_of_bounds");
  return digest;
}

/** Builds the manifest recording the export date, versions, file list, byte
 * lengths and hashes (the recipe's step 3), as a pure function so it can be
 * unit-tested without a real database or dump file. */
export function buildManifest({
  createdAt,
  host,
  operationId,
  database,
  financeSchemaVersion,
  kithSchemaVersion,
  gitRevision,
  parity,
  files,
}) {
  return {
    version: 1,
    engine: "postgres",
    createdAt,
    host,
    operationId,
    database,
    financeSchemaVersion,
    kithSchemaVersion,
    gitRevision,
    parity,
    files,
  };
}

async function writeManifestFile(stagingDirectory, manifest) {
  const path = join(stagingDirectory, "manifest.json");
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await writeAll(handle, bytes);
  } finally {
    await handle.close();
  }
  await fsyncDirectory(stagingDirectory);
  return path;
}

async function encryptFile(ageBinary, recipient, plainPath, cipherPath, timeoutMs) {
  await runCapture(
    ageBinary,
    ["-r", recipient, "-o", cipherPath, plainPath],
    { timeoutMs },
  );
  return requireBoundedFile(cipherPath);
}

function quoteShellWord(word) {
  return `'${word.replaceAll("'", String.raw`'\''`)}'`;
}
async function passwordCommandArgument(command) {
  await protectedExecutable(command.path);
  return [command.path, ...command.args].map(quoteShellWord).join(" ");
}
function resticBaseArgs(repositoryPath, passwordCommandArgument_) {
  return [
    "--repo",
    repositoryPath,
    "--password-command",
    passwordCommandArgument_,
    "--no-cache",
  ];
}

async function requireResticRepositoryIdentity(
  resticBinary,
  repositoryPath,
  passwordCommandArgument_,
  expectedRepositoryId,
  timeoutMs,
) {
  const result = await runCapture(
    resticBinary,
    [...resticBaseArgs(repositoryPath, passwordCommandArgument_), "cat", "config"],
    { timeoutMs },
  );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    fail("restic_repository_unreadable");
  }
  if (typeof parsed?.id !== "string" || !HEX_64.test(parsed.id))
    fail("restic_repository_unreadable");
  if (parsed.id !== expectedRepositoryId)
    fail("restic_repository_identity_mismatch");
  return parsed.id;
}

async function resticBackup(
  resticBinary,
  repositoryPath,
  passwordCommandArgument_,
  host,
  operationId,
  stagingDirectory,
  objectNames,
  timeoutMs,
) {
  const result = await runCapture(
    resticBinary,
    [
      ...resticBaseArgs(repositoryPath, passwordCommandArgument_),
      "backup",
      "--json",
      "--host",
      host,
      "--tag",
      operationId,
      ...objectNames,
    ],
    { timeoutMs, cwd: stagingDirectory, maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES },
  );
  const lines = result.stdout
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const summary = lines.find((line) => line.message_type === "summary");
  if (!summary || typeof summary.snapshot_id !== "string")
    fail("restic_backup_summary_missing");
  return summary.snapshot_id;
}

/** Steps 1-6 of the recipe for the postgres engine: preflight, protected
 * staging, `pg_dump` of both schemas, a manifest with sizes and hashes,
 * encryption, and a restic repository identity check before publication. */
export async function runPostgresDatabaseBackup(config) {
  config = parseBackupConfig(config);
  await validateBackupConfigPaths(config);
  await requireAgeVersion(config.ageBinary, config.timeoutMs);
  await requireResticVersion(config.resticBinary, config.timeoutMs);
  await requirePostgresClientVersion(config.psqlPath, config.timeoutMs);
  await requirePostgresClientVersion(config.pgDumpPath, config.timeoutMs);
  const connectionString = await secret(
    config.connectionCommand,
    config.timeoutMs,
  );
  const identity = await preflight(config, connectionString);
  // AGENTS.md: quiesce every kith writer before a backup, or refuse and say
  // which one is still active. This is checked every run, not only at
  // cutover, since the dated recipe runs on a schedule against a live
  // database that may have a worker or deferred-work drain mid-write.
  await requireNoActiveWriters((sql) => psqlScalar(config, connectionString, sql));
  const passwordCommandArgument_ = await passwordCommandArgument(
    config.resticPasswordCommand,
  );
  await requireResticRepositoryIdentity(
    config.resticBinary,
    config.resticRepositoryPath,
    passwordCommandArgument_,
    config.expectedResticRepositoryId,
    config.timeoutMs,
  );
  const stagingDirectory = await freshStagingDirectory(
    config,
    "postgres-backup",
  );
  // One exported snapshot covers both the parity capture and pg_dump, so the
  // manifest describes exactly the database state the dump contains even
  // though a watcher, the deferred-work daemon or an MCP write may commit at
  // any moment. Everything that can fail cheaply has already run, so the
  // holding transaction stays open only for the capture and the dump.
  const snapshot = await exportSnapshot(
    config.psqlPath,
    connectionString,
    config.timeoutMs,
  );
  let parity;
  let dumpPath;
  try {
    parity = await capturePostgresParity(
      config.psqlPath,
      connectionString,
      config.timeoutMs,
      snapshot.id,
    );
    if (parity.invalidConstraints !== 0) fail("preflight_constraints_invalid");
    dumpPath = await dumpBothSchemas(
      config,
      connectionString,
      stagingDirectory,
      snapshot.id,
    );
  } catch (error) {
    snapshot.abort();
    throw error;
  }
  await snapshot.release();
  const dumpDigest = await requireBoundedFile(dumpPath);
  const manifest = buildManifest({
    createdAt: new Date().toISOString(),
    host: config.host,
    operationId: config.operationId,
    database: identity.database,
    financeSchemaVersion: identity.financeVersion,
    kithSchemaVersion: identity.kithVersion,
    gitRevision: config.gitRevision,
    parity,
    files: [
      {
        name: "kithmind.dump",
        sha256: dumpDigest.sha256,
        byteLength: dumpDigest.byteLength,
      },
    ],
  });
  const manifestPath = await writeManifestFile(stagingDirectory, manifest);
  const dumpCipherPath = `${dumpPath}.age`;
  const manifestCipherPath = `${manifestPath}.age`;
  const dumpCiphertext = await encryptFile(
    config.ageBinary,
    config.ageRecipient,
    dumpPath,
    dumpCipherPath,
    config.timeoutMs,
  );
  const manifestCiphertext = await encryptFile(
    config.ageBinary,
    config.ageRecipient,
    manifestPath,
    manifestCipherPath,
    config.timeoutMs,
  );
  const snapshotId = await resticBackup(
    config.resticBinary,
    config.resticRepositoryPath,
    passwordCommandArgument_,
    config.host,
    config.operationId,
    stagingDirectory,
    ["kithmind.dump.age", "manifest.json.age"],
    config.timeoutMs,
  );
  return {
    status: "passed",
    stagingDirectory,
    snapshotId,
    repositoryId: config.expectedResticRepositoryId,
    manifest,
    ciphertexts: {
      "kithmind.dump.age": dumpCiphertext,
      "manifest.json.age": manifestCiphertext,
    },
    plaintexts: {
      "kithmind.dump.age": dumpDigest,
      "manifest.json.age": await requireBoundedFile(manifestPath),
    },
  };
}

// --- Separate-process verification (recipe step 7) -----------------------
//
// This runs in a freshly spawned process rather than a function call in the
// backup process: a dump/encrypt/publish path that also decrypts and
// compares its own output cannot catch a bug that corrupts data on the way
// in and on the way out identically. A new process, a fresh `--no-cache`
// restic invocation, and the protected age identity (never held by the
// backup config) prove the *published* ciphertext independently.

async function runVerifyWorker(payload) {
  const envelope = exact(payload, ["config", "backupResult"]);
  const config = parseVerifyConfig(envelope.config);
  const { backupResult } = envelope;
  await protectedDirectory(dirname(config.ageIdentityPath));
  protectedFile(config.ageIdentityPath);
  protectedFile(config.restoreProofConfigPath);
  const names = ["kithmind.dump.age", "manifest.json.age"];
  if (
    !backupResult ||
    JSON.stringify(Object.keys(backupResult).sort()) !==
      JSON.stringify(["status", "stagingDirectory", "snapshotId", "repositoryId", "manifest", "ciphertexts", "plaintexts"].sort()) ||
    backupResult.status !== "passed" ||
    backupResult.repositoryId !== config.expectedResticRepositoryId ||
    typeof backupResult.stagingDirectory !== "string" ||
    !backupResult.manifest ||
    typeof backupResult.snapshotId !== "string" ||
    !/^[a-f0-9]{8,64}$/.test(backupResult.snapshotId) ||
    !backupResult.ciphertexts || !backupResult.plaintexts ||
    JSON.stringify(Object.keys(backupResult.ciphertexts).sort()) !== JSON.stringify(names) ||
    JSON.stringify(Object.keys(backupResult.plaintexts).sort()) !== JSON.stringify(names) ||
    names.some((name) => {
      const cipher = backupResult.ciphertexts[name];
      const plain = backupResult.plaintexts[name];
      return !cipher || !plain || !HEX_64.test(cipher.sha256) || !HEX_64.test(plain.sha256) ||
        !Number.isSafeInteger(cipher.byteLength) || !Number.isSafeInteger(plain.byteLength) ||
        cipher.byteLength < 1 || plain.byteLength < 1 || cipher.byteLength > MAX_DUMP_BYTES || plain.byteLength > MAX_DUMP_BYTES;
    })
  ) fail("verify_payload_invalid");
  await protectedExecutable(config.resticBinary);
  await protectedExecutable(config.ageBinary);
  const passwordCommandArgument_ = await passwordCommandArgument(
    config.resticPasswordCommand,
  );
  await requireResticVersion(config.resticBinary, config.timeoutMs);
  await requireAgeVersion(config.ageBinary, config.timeoutMs);
  const repositoryId = await requireResticRepositoryIdentity(
    config.resticBinary,
    config.resticRepositoryPath,
    passwordCommandArgument_,
    config.expectedResticRepositoryId,
    config.timeoutMs,
  );
  const workDirectory = await mkdtemp(
    join(realpathSync(tmpdir()), "kith-db-verify-"),
  );
  try {
    const mismatches = [];
    for (const [objectName, expected] of Object.entries(
      backupResult.ciphertexts,
    )) {
      const cipherPath = join(workDirectory, objectName);
      await runToProtectedFile(
        config.resticBinary,
        [
          ...resticBaseArgs(config.resticRepositoryPath, passwordCommandArgument_),
          "dump",
          backupResult.snapshotId,
          `/${objectName}`,
        ],
        cipherPath,
        { timeoutMs: config.timeoutMs, maxOutputBytes: MAX_DUMP_BYTES },
      );
      const cipherDigest = await hashFile(cipherPath);
      if (
        cipherDigest.sha256 !== expected.sha256 ||
        cipherDigest.byteLength !== expected.byteLength
      ) {
        mismatches.push(`${objectName}: ciphertext byte mismatch`);
        continue;
      }
      const plainPath = join(workDirectory, `${objectName}.plain`);
      await runCapture(
        config.ageBinary,
        ["--decrypt", "-i", config.ageIdentityPath, "-o", plainPath, cipherPath],
        { timeoutMs: config.timeoutMs },
      );
      const plainDigest = await hashFile(plainPath);
      const expectedPlain = backupResult.plaintexts?.[objectName];
      if (
        !expectedPlain ||
        plainDigest.sha256 !== expectedPlain.sha256 ||
        plainDigest.byteLength !== expectedPlain.byteLength
      ) {
        mismatches.push(`${objectName}: plaintext byte mismatch`);
      }
    }
    if (mismatches.length) fail("verify_readback_mismatch", mismatches.join("; "));
    let publishedManifest;
    try {
      publishedManifest = JSON.parse(
        await readFile(join(workDirectory, "manifest.json.age.plain"), "utf8"),
      );
    } catch {
      fail("published_manifest_invalid");
    }
    const dumpFile = publishedManifest?.files?.find(
      (entry) => entry?.name === "kithmind.dump",
    );
    if (
      JSON.stringify(publishedManifest) !== JSON.stringify(backupResult.manifest) ||
      publishedManifest.host !== config.host ||
      publishedManifest.operationId !== config.operationId ||
      !dumpFile ||
      dumpFile.sha256 !== backupResult.plaintexts["kithmind.dump.age"].sha256 ||
      dumpFile.byteLength !== backupResult.plaintexts["kithmind.dump.age"].byteLength
    ) fail("published_manifest_invalid");
    let restoreResult;
    try {
      restoreResult = await runCapture(
        process.execPath,
        [
          fileURLToPath(new URL("./db-restore-proof.mjs", import.meta.url)),
          "--isolated",
          "--config",
          config.restoreProofConfigPath,
          "--dump",
          join(workDirectory, "kithmind.dump.age.plain"),
          "--manifest",
          join(workDirectory, "manifest.json.age.plain"),
        ],
        { timeoutMs: config.timeoutMs, maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES },
      );
    } catch (error) {
      if (error?.code !== "command_failed") throw error;
      fail(childFailureCode(error, RESTORE_PROOF_CODES, "restore_proof_failed:"));
    }
    let restore;
    try {
      restore = JSON.parse(restoreResult.stdout.toString("utf8"));
    } catch {
      fail("restore_worker_output_invalid");
    }
    if (
      !restore ||
      Object.keys(restore).sort().join() !==
        ["status", "source", "restored", "tablesVerified", "citationSample"].sort().join() ||
      restore.status !== "passed" ||
      !Number.isSafeInteger(restore.tablesVerified) ||
      restore.tablesVerified < 2 ||
      JSON.stringify(Object.keys(restore.source ?? {}).sort()) !==
        JSON.stringify(["financeVersion", "kithVersion"]) ||
      JSON.stringify(Object.keys(restore.restored ?? {}).sort()) !==
        JSON.stringify(["financeVersion", "kithVersion"]) ||
      restore.source.financeVersion !== publishedManifest.financeSchemaVersion ||
      restore.source.kithVersion !== publishedManifest.kithSchemaVersion ||
      JSON.stringify(restore.source) !== JSON.stringify(restore.restored) ||
      !validCitationSample(restore.citationSample)
    ) fail("restore_worker_output_invalid");
    return { status: "passed", repositoryId, mismatches: [], restore };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

/** Spawns the separate-process verify worker and requires its exact
 * `{status:"passed"}` result, matching the generic command-output contract
 * the rest of this recipe already uses. */
export async function verifyPostgresBackup(verifyConfig, backupResult) {
  const config = parseVerifyConfig(verifyConfig);
  await protectedDirectory(dirname(config.ageIdentityPath));
  protectedFile(config.ageIdentityPath);
  protectedFile(config.restoreProofConfigPath);
  const workerPath = fileURLToPath(import.meta.url);
  const payload = Buffer.from(
    JSON.stringify({ config, backupResult }),
    "utf8",
  );
  let result;
  try {
    result = await runCapture(
      process.execPath,
      [workerPath, "--verify-worker"],
      {
        timeoutMs: config.timeoutMs,
        maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
        input: payload,
      },
    );
  } catch (error) {
    // The worker's own code, including a `restore_proof_failed:<code>` it
    // passed up from the restore proof, so the status file and the operator's
    // log name the check that failed instead of `command_failed`.
    if (error?.code !== "command_failed") throw error;
    fail(childFailureCode(error, POSTGRES_BACKUP_CODES));
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    fail("verify_worker_output_invalid");
  }
  if (
    !parsed ||
    Object.keys(parsed).sort().join() !==
      ["status", "repositoryId", "mismatches", "restore"].sort().join() ||
    parsed.status !== "passed" ||
    parsed.repositoryId !== config.expectedResticRepositoryId ||
    !Array.isArray(parsed.mismatches) ||
    parsed.mismatches.length !== 0 ||
    parsed.restore?.status !== "passed"
  ) fail("verify_worker_output_invalid");
  return parsed;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function main() {
  if (process.argv[2] === "--verify-worker") {
    const payload = JSON.parse((await readStdin()).toString("utf8"));
    const result = await runVerifyWorker(payload);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== "passed") process.exitCode = 1;
    return;
  }
  if (process.argv.length !== 4 || process.argv[2] !== "--config")
    fail("usage_invalid");
  const result = await runPostgresDatabaseBackup(
    await loadPostgresBackupConfig(process.argv[3]),
  );
  process.stdout.write(
    `${JSON.stringify({ status: result.status, snapshotId: result.snapshotId })}\n`,
  );
}
if (isMain())
  main().catch((error) => {
    const code =
      error instanceof PostgresBackupError && POSTGRES_BACKUP_CODES.has(error.code)
        ? error.code
        : "runner_failed";
    const detail = error instanceof PostgresBackupError ? error.detail : undefined;
    process.stderr.write(
      `${JSON.stringify({ status: "failed", code, ...(detail ? { detail } : {}) })}\n`,
    );
    process.exitCode = 1;
  });
