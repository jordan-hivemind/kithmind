#!/usr/bin/env node
// The postgres engine for the dated-backup recipe (docs/plans/
// 2026-09-08-dated-database-backups.md, step 10 of
// docs/plans/2026-09-12-postgres-consolidation.md, tracker row P2-39k).
//
// Replaces the native Convex export with `pg_dump` of both schemas
// (`finance` and `kith`) from one database. Keeps every safeguard the Convex
// recipe already has: an explicit preflight, a protected staging directory,
// a manifest with sizes and hashes, encryption, a restic repository identity
// check before publication, and a separate-process byte-equality
// verification. Secrets (the connection string, the restic password, the age
// private identity) are never embedded in configuration; each is read from a
// protected command or file the owner already has, exactly as the existing
// Convex recipe's adapters do.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  createReadStream,
  lstatSync,
  realpathSync,
} from "node:fs";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  constructor(code) {
    super(code);
    this.name = "PostgresBackupError";
    this.code = code;
  }
}
function fail(code) {
  throw new PostgresBackupError(code);
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
    ageRecipient: text(row.ageRecipient, 200),
    resticBinary: absolute(row.resticBinary),
    resticRepositoryPath: absolute(row.resticRepositoryPath),
    resticPasswordCommand: parseSecretCommand(row.resticPasswordCommand),
    expectedResticRepositoryId: row.expectedResticRepositoryId,
    host: row.host,
    operationId: row.operationId,
    expectedDatabaseName: text(row.expectedDatabaseName, 200),
    expectedFinanceSchemaVersion: row.expectedFinanceSchemaVersion,
    expectedKithSchemaVersion: row.expectedKithSchemaVersion,
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
    resticBinary: absolute(row.resticBinary),
    resticRepositoryPath: absolute(row.resticRepositoryPath),
    resticPasswordCommand: parseSecretCommand(row.resticPasswordCommand),
    expectedResticRepositoryId: row.expectedResticRepositoryId,
    host: row.host,
    operationId: row.operationId,
    timeoutMs: row.timeoutMs,
  };
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
        finish(
          new PostgresBackupError("command_failed"),
          undefined,
        );
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

async function dumpBothSchemas(config, connectionString, stagingDirectory) {
  const dumpPath = join(stagingDirectory, "kithmind.dump");
  await runCapture(
    config.pgDumpPath,
    [
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--schema=finance",
      "--schema=kith",
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
  const dumpPath = await dumpBothSchemas(
    config,
    connectionString,
    stagingDirectory,
  );
  const dumpDigest = await requireBoundedFile(dumpPath);
  const manifest = buildManifest({
    createdAt: new Date().toISOString(),
    host: config.host,
    operationId: config.operationId,
    database: identity.database,
    financeSchemaVersion: identity.financeVersion,
    kithSchemaVersion: identity.kithVersion,
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
  const { config, backupResult } = payload;
  const names = ["kithmind.dump.age", "manifest.json.age"];
  if (
    !backupResult ||
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
  const workDirectory = await mkdtemp(join(tmpdir(), "kith-db-verify-"));
  try {
    const mismatches = [];
    for (const [objectName, expected] of Object.entries(
      backupResult.ciphertexts,
    )) {
      const cipherPath = join(workDirectory, objectName);
      const dumped = await runCapture(
        config.resticBinary,
        [
          ...resticBaseArgs(config.resticRepositoryPath, passwordCommandArgument_),
          "dump",
          backupResult.snapshotId,
          `/${objectName}`,
        ],
        { timeoutMs: config.timeoutMs, maxOutputBytes: MAX_DUMP_BYTES },
      );
      await writeFile(cipherPath, dumped.stdout, { mode: 0o600, flag: "wx" });
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
    return { status: mismatches.length ? "failed" : "passed", repositoryId, mismatches };
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
  const workerPath = fileURLToPath(import.meta.url);
  const payload = Buffer.from(
    JSON.stringify({ config, backupResult }),
    "utf8",
  );
  const result = await runCapture(
    process.execPath,
    [workerPath, "--verify-worker"],
    {
      timeoutMs: config.timeoutMs,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      input: payload,
    },
  );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    fail("verify_worker_output_invalid");
  }
  if (parsed.status !== "passed") fail("verify_failed");
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
      error instanceof PostgresBackupError ? error.code : "runner_failed";
    process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
    process.exitCode = 1;
  });
