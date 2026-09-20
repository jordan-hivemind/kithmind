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
  "preflight_query_failed",
  "published_manifest_invalid",
  "restic_backup_summary_missing",
  "restic_repository_identity_mismatch",
  "restic_repository_unreadable",
  "restic_version_mismatch",
  "retention_output_invalid",
  "restore_worker_output_invalid",
  "row_count_invalid",
  "runner_failed",
  "secret_command_empty",
  "snapshot_export_failed",
  "snapshot_holder_lost",
  "snapshot_id_invalid",
  "snapshot_not_importable",
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

/** A named, non-fatal notice on stderr: used where a value that used to be a
 * hard gate (a pinned expected schema version) is now recorded instead, so an
 * operator watching logs still sees a mismatch without the run failing over
 * it. Never the mechanism for an actual failure code. */
function notice(code, detail) {
  process.stderr.write(`${JSON.stringify({ notice: code, ...detail })}\n`);
}

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

// Retention defaults (owner decision, 2026-09-20): a week of dailies, a
// month and a bit of weeklies, a year of monthlies. Config can override any
// of the three; restic's own `forget` computes the buckets.
const DEFAULT_RETENTION = { keepDaily: 7, keepWeekly: 5, keepMonthly: 12 };
function parseRetention(value) {
  if (value === undefined) return DEFAULT_RETENTION;
  const row = exact(value, ["keepDaily", "keepWeekly", "keepMonthly"]);
  for (const key of ["keepDaily", "keepWeekly", "keepMonthly"]) {
    if (!Number.isSafeInteger(row[key]) || row[key] < 0) fail("config_invalid");
  }
  // All three at zero keeps nothing at all, every run: only restic's own
  // guard would stand between that config and a full delete. Refuse it here
  // instead of trusting restic to save an operator from their own config.
  if (row.keepDaily + row.keepWeekly + row.keepMonthly < 1) fail("config_invalid");
  return { keepDaily: row.keepDaily, keepWeekly: row.keepWeekly, keepMonthly: row.keepMonthly };
}

// Present-if-given keys: a config written before these existed still parses
// unchanged. `expected*SchemaVersion` used to be a required hard gate (an
// operator had to edit two JSON files after every migration or the backup
// failed); kept only as an optional sanity value now, logged as a notice on
// drift rather than enforced, per the "recorded, not pinned" change.
function optionalKeysPresent(value, keys) {
  return keys.filter((key) => value && typeof value === "object" && key in value);
}

function parseBackupConfig(value) {
  const optional = optionalKeysPresent(value, [
    "expectedFinanceSchemaVersion",
    "expectedKithSchemaVersion",
    "resticRetention",
  ]);
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
    "gitRevision",
    "timeoutMs",
    ...optional,
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
  for (const key of ["expectedFinanceSchemaVersion", "expectedKithSchemaVersion"]) {
    // `!= null` (loose), not `!== undefined`: this function re-parses its own
    // already-parsed output (runPostgresDatabaseBackup accepts a config
    // object directly, not only a file path), and the resolved value for an
    // omitted key is `null`, not absence of the key. Requiring strict
    // `undefined` here made every config that omits these now-optional keys
    // fail closed on its second parse, which is every real CLI run.
    if (row[key] != null && (!Number.isSafeInteger(row[key]) || row[key] < 1))
      fail("config_invalid");
  }
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
    // Recorded, not pinned (owner decision, 2026-09-20): `null` when the
    // config omits them, so a run never fails only because a migration
    // moved a schema version since the config was last edited.
    expectedFinanceSchemaVersion: row.expectedFinanceSchemaVersion ?? null,
    expectedKithSchemaVersion: row.expectedKithSchemaVersion ?? null,
    resticRetention: parseRetention(row.resticRetention),
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
// Restore-proof cadence default (owner decision, 2026-09-20): the isolated
// restore -- a full pg_restore into a scratch database -- runs every 30 days
// unless the config says otherwise or `--proof-now` forces it. The daily
// ciphertext/plaintext readback checks are unaffected; only this heavier
// check moves off "every run".
const DEFAULT_RESTORE_PROOF_EVERY_DAYS = 30;

function parseVerifyConfig(value) {
  const optional = optionalKeysPresent(value, ["restoreProofEveryDays"]);
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
    ...optional,
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
  if (
    row.restoreProofEveryDays !== undefined &&
    (!Number.isSafeInteger(row.restoreProofEveryDays) || row.restoreProofEveryDays < 1)
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
    restoreProofEveryDays: row.restoreProofEveryDays ?? DEFAULT_RESTORE_PROOF_EVERY_DAYS,
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

/** Explicit deployment preflight: the connected database must be the one
 * the recipe was told to expect, in the same credential context used for the
 * dump. Both schemas' versions are read here and recorded into the manifest
 * as-is (`buildManifest` below) rather than checked against a configured
 * expectation: a schema version is expected to move as migrations ship, and
 * requiring an operator to edit `expected*SchemaVersion` after every one is
 * exactly the pinning this recipe no longer does. When the config still
 * carries an expected value (kept for backward compatibility), a drift is
 * logged as a notice, never a failure. */
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
  if (
    config.expectedFinanceSchemaVersion !== null &&
    financeVersion !== config.expectedFinanceSchemaVersion
  ) {
    notice("schema_version_recorded_not_pinned", {
      schema: "finance",
      expected: config.expectedFinanceSchemaVersion,
      actual: financeVersion,
    });
  }
  const kithVersion = Number(
    await psqlScalar(
      config,
      connectionString,
      "select max(version) from kith.schema_version",
    ),
  );
  if (
    config.expectedKithSchemaVersion !== null &&
    kithVersion !== config.expectedKithSchemaVersion
  ) {
    notice("schema_version_recorded_not_pinned", {
      schema: "kith",
      expected: config.expectedKithSchemaVersion,
      actual: kithVersion,
    });
  }
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

// How often the holder proves it is still there. The session sits idle in a
// transaction for the whole capture and dump, about seven minutes on the
// owner's archive, which a hosted platform is entitled to cut off.
const SNAPSHOT_KEEPALIVE_MS = 60_000;

/** Opens a REPEATABLE READ transaction on the source and exports its
 * snapshot, then holds that transaction open until `release()`. `pg_dump
 * --snapshot` and the parity capture both import the same id, so the dump and
 * the manifest parity that the restore proof compares against describe one
 * consistent instant. Without this the two read a database that never stops
 * being written to, and no restore could ever match the manifest.
 *
 * The session clears its own `idle_in_transaction_session_timeout` and
 * `statement_timeout`, and runs a trivial statement every minute besides: a
 * hosted source may cap or ignore what a session asks for, and a holder killed
 * mid-dump would fail the run every day. The connection must be a direct one,
 * not a pooled endpoint, because one session has to hold the snapshot open
 * while others import it.
 *
 * `release()` fails if the holding session died in the meantime, because a
 * snapshot whose exporting transaction ended no longer guarantees anything. */
export function exportSnapshot(psqlPath, connectionString, timeoutMs) {
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
    let keepalive;
    const stopKeepalive = () => clearInterval(keepalive);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        stopKeepalive();
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
      keepalive = setInterval(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.stdin.write("select 1;\n");
        }
      }, SNAPSHOT_KEEPALIVE_MS);
      keepalive.unref();
      finish(undefined, {
        id,
        abort: () => {
          stopKeepalive();
          child.kill("SIGKILL");
        },
        release: () =>
          new Promise((resolveRelease, rejectRelease) => {
            stopKeepalive();
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
      "set idle_in_transaction_session_timeout = 0;\nset statement_timeout = 0;\nbegin transaction isolation level repeatable read;\nselect pg_export_snapshot();\n",
    );
  });
}

/** Proves a second session can import the snapshot before the dump commits to
 * it. A pooled endpoint hands each session a different backend, so the import
 * fails there; failing here names that cause instead of surfacing a generic
 * command failure seven minutes into the run. */
async function requireImportableSnapshot(config, connectionString, snapshotId) {
  try {
    await runCapture(
      config.psqlPath,
      [connectionString, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
      {
        timeoutMs: config.timeoutMs,
        input: `begin transaction isolation level repeatable read;\nset transaction snapshot '${snapshotId}';\nselect 1;\ncommit;\n`,
      },
    );
  } catch {
    fail("snapshot_not_importable");
  }
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

// Every snapshot this recipe creates carries this tag, in addition to its
// operationId tag, so retention (`resticForget` below) can scope `forget
// --prune` to exactly the snapshots this recipe owns. A restic repository is
// not necessarily dedicated to database backups: the pipeline's independent
// archive backup (`pdfDocQa.archive.independentBackup.repositoryPath` /
// `.repository`, packages/pipeline/src/config.ts) is a completely separate,
// independently configured `resticRepositoryPath`/rclone spec, and nothing in
// either config ties the two together or stops an operator pointing both at
// the same repository. Filtering `forget` by this tag is what keeps a
// database-backup retention policy from ever touching a document-archive
// snapshot that happens to share the repository.
const RETENTION_TAG = "kith-db";

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
      "--tag",
      RETENTION_TAG,
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

/** Ages out old database-backup snapshots with restic's own retention policy,
 * scoped to this host and the `kith-db` tag so a shared repository's other
 * snapshot kinds (e.g. the pipeline's document archive) are never in the
 * candidate set. `--prune` reclaims space from a real run; a dry run only
 * reports counts and snapshot times, matching the CLI's `--dry-run` flag.
 * A caller failure here must never fail the backup itself: the new snapshot
 * this run just published already exists and is independently readable,
 * which is the whole point this row (BAK-1) exists to keep true. */
export async function resticForget(
  resticBinary,
  repositoryPath,
  passwordCommandArgument_,
  host,
  retention,
  timeoutMs,
  dryRun = false,
) {
  // Defense in depth: parseRetention already bounds the three keep counts and
  // loadPostgresBackupConfig already bounds `host` with OPAQUE_ID, but this is
  // the function that actually builds the forget argv, so it re-checks the
  // two values a hostile or malformed direct call (this function is exported)
  // could otherwise send straight through to restic.
  if (!host || !RETENTION_TAG) fail("config_invalid");
  const result = await runCapture(
    resticBinary,
    [
      ...resticBaseArgs(repositoryPath, passwordCommandArgument_),
      "forget",
      "--json",
      "--host",
      host,
      "--tag",
      RETENTION_TAG,
      // restic's default `--group-by host,paths` groups snapshots by their
      // exact backed-up path set. Every run's staging directory is uniquely
      // timestamped (`freshStagingDirectory`), so without this flag every
      // snapshot lands alone in its own group and "keep N" trivially keeps
      // that lone snapshot and removes nothing, forever -- retention would
      // silently do nothing while `--prune` ran nightly for no reason. Group
      // by host alone (not host,tags: operationId can vary run to run) so
      // every kith-db-tagged snapshot on this host falls into one group and
      // the keep-daily/weekly/monthly buckets actually apply across it.
      "--group-by",
      "host",
      "--keep-daily",
      String(retention.keepDaily),
      "--keep-weekly",
      String(retention.keepWeekly),
      "--keep-monthly",
      String(retention.keepMonthly),
      ...(dryRun ? ["--dry-run"] : ["--prune"]),
    ],
    { timeoutMs, maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES },
  );
  let groups;
  try {
    // `forget --json` prints the JSON result as its own first line, but a
    // real `--prune` that actually rewrites pack files can still print a
    // plain-text warning afterward (observed: "running prune without a
    // cache, this may be very slow!", tied to `--no-cache` above, not
    // suppressed by `--json`). Parsing the whole of stdout as one JSON
    // document broke on exactly that combination -- the case that only
    // starts happening once `--group-by host` (this same row) makes
    // retention actually remove anything. Only the first line is ever the
    // JSON result; anything after it is diagnostic text this function
    // doesn't need.
    const firstLine = result.stdout.toString("utf8").split("\n", 1)[0];
    groups = JSON.parse(firstLine);
  } catch {
    fail("retention_output_invalid");
  }
  if (!Array.isArray(groups)) fail("retention_output_invalid");
  const removed = groups.flatMap((group) => group?.remove ?? []);
  const kept = groups.flatMap((group) => group?.keep ?? []);
  return {
    status: "passed",
    dryRun,
    keptCount: kept.length,
    removedCount: removed.length,
    // Counts and snapshot times only -- never the snapshots' own content or
    // paths -- so a `--dry-run` report stays safe to print or log.
    removedTimes: removed
      .map((snapshot) => snapshot?.time)
      .filter((time) => typeof time === "string"),
  };
}

/** Runs retention after this backup has been independently verified --
 * db-backup.mjs calls this only once `verifyPostgresBackup` has already
 * succeeded, never before. A failure here is caught and reported, never
 * thrown: the backup that was just verified stays a success regardless of
 * what `forget`/`prune` do afterward, but the failure must not be silent, so
 * it is logged here as a named stderr notice (the caller additionally
 * persists it into the durable status journal). */
export async function runPostgresRetention(config, options = {}) {
  config = parseBackupConfig(config);
  await validateBackupConfigPaths(config);
  const passwordCommandArgument_ = await passwordCommandArgument(
    config.resticPasswordCommand,
  );
  try {
    return await resticForget(
      config.resticBinary,
      config.resticRepositoryPath,
      passwordCommandArgument_,
      config.host,
      config.resticRetention,
      config.timeoutMs,
      options.dryRun ?? false,
    );
  } catch (error) {
    const code = error instanceof PostgresBackupError ? error.code : "unknown";
    notice("retention_failed", { code, host: config.host });
    return { status: "failed", code };
  }
}

// ponytail: a fixed 3-attempt count and fixed backoff, not a configurable
// retry policy; raise it (or make it config) once a real dropped-connection
// rate shows 3 is not enough.
const EXPORT_RETRY_BACKOFF_MS = [2_000, 5_000];
async function withExportRetry(attempt) {
  let lastError;
  for (let index = 0; index < 1 + EXPORT_RETRY_BACKOFF_MS.length; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      const backoff = EXPORT_RETRY_BACKOFF_MS[index];
      if (backoff === undefined) break;
      await new Promise((wake) => setTimeout(wake, backoff));
    }
  }
  throw lastError;
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
  // Resilience to a dropped connection (the laptop LaunchAgent's original
  // failure mode): retry the snapshot-export-and-dump sequence up to 3 times
  // with backoff before the run is marked failed. It has to retry the whole
  // sequence, not just `pg_dump`, because a lost connection can just as
  // easily kill the snapshot-holding session; a bare `pg_dump` retry against
  // a dead holder would only fail again with `snapshot_holder_lost`. Whatever
  // partial `kithmind.dump` bytes an aborted attempt left behind are
  // overwritten by the next attempt's `pg_dump -f`, and the whole staging
  // directory is removed below if every attempt fails.
  let parity;
  let dumpPath;
  try {
    ({ parity, dumpPath } = await withExportRetry(async () => {
      // One exported snapshot covers both the parity capture and pg_dump, so
      // the manifest describes exactly the database state the dump contains
      // even though a watcher, the deferred-work daemon or an MCP write may
      // commit at any moment. Everything that can fail cheaply has already
      // run, so the holding transaction stays open only for the capture and
      // the dump.
      const snapshot = await exportSnapshot(
        config.psqlPath,
        connectionString,
        config.timeoutMs,
      );
      try {
        await requireImportableSnapshot(config, connectionString, snapshot.id);
        const attemptParity = await capturePostgresParity(
          config.psqlPath,
          connectionString,
          config.timeoutMs,
          snapshot.id,
        );
        if (attemptParity.invalidConstraints !== 0)
          fail("preflight_constraints_invalid");
        const attemptDumpPath = await dumpBothSchemas(
          config,
          connectionString,
          stagingDirectory,
          snapshot.id,
        );
        await snapshot.release();
        return { parity: attemptParity, dumpPath: attemptDumpPath };
      } catch (error) {
        snapshot.abort();
        throw error;
      }
    }));
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
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
  // Retention (restic forget/prune) does NOT run here. It runs only after
  // the separate-process verification below has proven this snapshot's
  // ciphertext round-trips and restores correctly (db-backup.mjs calls
  // runPostgresRetention once verifyPostgresBackup has succeeded). Pruning
  // here, before verification, could age an older backup out on the strength
  // of a new one that turns out to be corrupt -- exactly backwards from what
  // a backup's retention policy is supposed to protect.
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
  const envelope = exact(payload, ["config", "backupResult", "runRestoreProof"]);
  const config = parseVerifyConfig(envelope.config);
  const { backupResult } = envelope;
  if (typeof envelope.runRestoreProof !== "boolean") fail("verify_payload_invalid");
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
    // The isolated restore proof (a full pg_restore into a scratch database
    // plus parity recapture) is the expensive part of verification and now
    // runs on a cadence (`restoreProofEveryDays`, decided by the caller in
    // db-backup.mjs from the durable status journal), not every day. The
    // ciphertext/plaintext readback and manifest checks above still run every
    // time regardless: those are the "recovery record" checks docs/
    // database-backups.md distinguishes from the isolated restore itself.
    let restore;
    if (!envelope.runRestoreProof) {
      restore = { status: "skipped" };
    } else {
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
        // Compared against the *restored* database, not the live source: the
        // source may have since migrated (schema versions are recorded, not
        // pinned), so only the restored-versus-manifest equality proves the
        // published dump restores to what was dumped.
        restore.restored.financeVersion !== publishedManifest.financeSchemaVersion ||
        restore.restored.kithVersion !== publishedManifest.kithSchemaVersion ||
        !validCitationSample(restore.citationSample)
      ) fail("restore_worker_output_invalid");
    }
    return { status: "passed", repositoryId, mismatches: [], restore };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

/** Spawns the separate-process verify worker and requires its exact
 * `{status:"passed"}` result, matching the generic command-output contract
 * the rest of this recipe already uses. `options.runRestoreProof` defaults to
 * true (every direct caller, including both integration tests, keeps getting
 * a full proof unless it explicitly opts out); db-backup.mjs's cadence
 * decision is the only caller that passes `false`. */
export async function verifyPostgresBackup(verifyConfig, backupResult, options = {}) {
  const config = parseVerifyConfig(verifyConfig);
  await protectedDirectory(dirname(config.ageIdentityPath));
  protectedFile(config.ageIdentityPath);
  protectedFile(config.restoreProofConfigPath);
  const runRestoreProof = options.runRestoreProof !== false;
  const workerPath = fileURLToPath(import.meta.url);
  const payload = Buffer.from(
    JSON.stringify({ config, backupResult, runRestoreProof }),
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
    (parsed.restore?.status !== "passed" && parsed.restore?.status !== "skipped") ||
    (runRestoreProof && parsed.restore?.status !== "passed")
  ) fail("verify_worker_output_invalid");
  return parsed;
}

/** Pure argv parsing for the `--forget` operator command, kept separate from
 * dispatch so its usage rules are unit-testable without a real restic
 * repository. Dry-run by default (BAK-1 second review): `--apply` is
 * required to actually delete/prune, because the previous default did the
 * opposite -- it pruned a real repository unless an operator remembered
 * `--dry-run`. Any argument other than `--config <path>` and `--apply` is
 * rejected instead of silently ignored. */
export function parseForgetArgs(argv) {
  let configPath;
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") configPath = argv[(i += 1)];
    else if (arg === "--apply") apply = true;
    else fail("usage_invalid");
  }
  if (typeof configPath !== "string" || configPath.length === 0)
    fail("usage_invalid");
  return { configPath, apply };
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
  if (process.argv[2] === "--forget") {
    // Operator command: `node db-backup-postgres.mjs --forget --config
    // <path> [--apply]`. Reuses the backup config (it already carries the
    // restic binary, repository and password command this needs) but never
    // touches Postgres, age, or the dump/publish path. Dry-run unless
    // --apply is given.
    const { configPath, apply } = parseForgetArgs(process.argv.slice(3));
    const config = await loadPostgresBackupConfig(configPath);
    const passwordCommandArgument_ = await passwordCommandArgument(
      config.resticPasswordCommand,
    );
    const result = await resticForget(
      config.resticBinary,
      config.resticRepositoryPath,
      passwordCommandArgument_,
      config.host,
      config.resticRetention,
      config.timeoutMs,
      !apply,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
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
    // Membership, not class: a `PostgresParityError` from the parity capture
    // carries a code from this same enum and deserves to be reported by it.
    const code = POSTGRES_BACKUP_CODES.has(error?.code)
      ? error.code
      : "runner_failed";
    const detail = error instanceof PostgresBackupError ? error.detail : undefined;
    process.stderr.write(
      `${JSON.stringify({ status: "failed", code, ...(detail ? { detail } : {}) })}\n`,
    );
    process.exitCode = 1;
  });
