#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.umask(0o077);
const MAX_CONFIG = 65_536;
const MAX_STDOUT = 4_096;
const MAX_STDERR = 65_536;
const KILL_GRACE = 250;
const states = new Set(["running", "succeeded", "failed"]);
const stages = new Set(["export", "backup", "verify", "retention", "complete"]);

export class DatabaseBackupRunnerError extends Error {
  constructor(code) {
    super(code);
    this.name = "DatabaseBackupRunnerError";
    this.code = code;
  }
}
const fail = (code) => {
  throw new DatabaseBackupRunnerError(code);
};
export function exact(value, keys, code = "config_invalid") {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail(code);
  return value;
}
export function text(value, max = 4_096) {
  if (
    typeof value !== "string" ||
    !value.length ||
    Buffer.byteLength(value) > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
  )
    fail("config_invalid");
  return value;
}
export function absolute(value) {
  const path = text(value);
  if (!isAbsolute(path) || resolve(path) !== path) fail("config_invalid");
  return path;
}
export async function protectedDirectory(path, ownerOnly = false) {
  if (realpathSync(path) !== path) fail("path_not_canonical");
  let current = path;
  while (true) {
    const handle = await open(
      current,
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isDirectory() ||
        (stat.uid !== process.getuid() && stat.uid !== 0) ||
        stat.mode & 0o022
      )
        fail("path_not_protected");
      if (
        current === path &&
        ownerOnly &&
        (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700)
      )
        fail("directory_not_private");
    } finally {
      await handle.close();
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export async function protectedExecutable(path) {
  await protectedDirectory(dirname(path));
  if (realpathSync(path) !== path) fail("command_not_canonical");
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    (stat.uid !== process.getuid() && stat.uid !== 0) ||
    stat.mode & 0o022 ||
    !(stat.mode & 0o111)
  )
    fail("command_not_protected");
}
export async function readProtected(path, maximum) {
  if (realpathSync(path) !== path) fail("file_not_protected");
  await protectedDirectory(dirname(path));
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(process.getuid()) ||
      before.mode % 0o1000n !== 0o600n ||
      before.nlink !== 1n ||
      before.size < 2n ||
      before.size > BigInt(maximum)
    )
      fail("file_not_protected");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"])
      if (before[key] !== after[key] || before[key] !== named[key])
        fail("file_changed");
    if (offset !== bytes.length) fail("file_changed");
    return bytes;
  } finally {
    await handle.close();
  }
}
function parseCommand(value, reserved) {
  const row = exact(value, ["path", "args"]);
  if (!Array.isArray(row.args) || row.args.length > 32) fail("config_invalid");
  const args = row.args.map((arg) => text(arg));
  if (args.includes(reserved)) fail("config_invalid");
  return { path: absolute(row.path), args };
}
function parseConfig(value) {
  const row = exact(value, [
    "version",
    "stateDirectory",
    "stagingRoot",
    "cwd",
    "timeoutMs",
    "exportCommand",
    "backupCommand",
  ]);
  if (
    row.version !== 1 ||
    !Number.isSafeInteger(row.timeoutMs) ||
    row.timeoutMs < 100 ||
    row.timeoutMs > 3_600_000
  )
    fail("config_invalid");
  const config = {
    version: 1,
    stateDirectory: absolute(row.stateDirectory),
    stagingRoot: absolute(row.stagingRoot),
    cwd: absolute(row.cwd),
    timeoutMs: row.timeoutMs,
    exportCommand: parseCommand(row.exportCommand, "--output-directory"),
    backupCommand: parseCommand(row.backupCommand, "--input-directory"),
  };
  if (
    config.stateDirectory === config.stagingRoot ||
    config.stateDirectory.startsWith(`${config.stagingRoot}/`) ||
    config.stagingRoot.startsWith(`${config.stateDirectory}/`)
  )
    fail("config_invalid");
  return config;
}
async function validateConfigPaths(config) {
  await Promise.all([
    protectedDirectory(config.stateDirectory, true),
    protectedDirectory(config.stagingRoot, true),
    protectedDirectory(config.cwd),
    protectedExecutable(config.exportCommand.path),
    protectedExecutable(config.backupCommand.path),
  ]);
}
export async function loadDatabaseBackupConfig(path) {
  const configPath = absolute(path);
  let value;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readProtected(configPath, MAX_CONFIG),
      ),
    );
  } catch (error) {
    if (error instanceof DatabaseBackupRunnerError) throw error;
    fail("config_invalid");
  }
  const config = parseConfig(value);
  await validateConfigPaths(config);
  return config;
}
export async function fsyncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (!bytesWritten) fail("state_write_failed");
    offset += bytesWritten;
  }
  await handle.sync();
}
async function atomicStatus(path, value, runId) {
  const keys = [
    "version",
    "state",
    "stage",
    "runId",
    "startedAt",
    "updatedAt",
    "lastSuccessAt",
    "lastProofAt",
    "nextProofDueAt",
    "retention",
    ...(value.state === "failed" ? ["failureCode"] : []),
  ];
  exact(value, keys, "status_invalid");
  if (!states.has(value.state) || !stages.has(value.stage))
    fail("status_invalid");
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const temporary = join(dirname(path), `.status.${runId}.${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await writeAll(handle, bytes);
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await fsyncDirectory(dirname(path));
}
const RETENTION_STATES = new Set(["ok", "failed", "skipped"]);
// A run's own retention outcome (BAK-1 review row 2): null until the postgres
// engine's first retention-aware run, then always this shape so a health
// check has one field to read instead of grepping logs for a notice.
function validRetention(value) {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join() !== ["state", "code", "at", "removed", "kept"].sort().join())
    return false;
  return (
    RETENTION_STATES.has(value.state) &&
    (value.code === null || (typeof value.code === "string" && value.code.length <= 64)) &&
    (value.at === null || Number.isSafeInteger(value.at)) &&
    (value.removed === null || Number.isSafeInteger(value.removed)) &&
    (value.kept === null || Number.isSafeInteger(value.kept))
  );
}
// The three proof/retention keys below (BAK-1 second review, row 2) did not
// exist in the status file this repository already writes on `main` --
// `lastProofAt`, `nextProofDueAt`, and `retention` are new. Each is optional
// on read, independently, and defaults to null when absent, so the exact-key
// check below still accepts the deployed shape (none of the three present)
// without a deploy-time migration step. `atomicStatus` still always WRITES
// the full new shape (via `status()`'s own `?? null` defaults), so every run
// upgrades the file in place the moment it next records status.
const OPTIONAL_STATUS_KEYS = ["lastProofAt", "nextProofDueAt", "retention"];
function parseStatus(value) {
  const present = OPTIONAL_STATUS_KEYS.filter((key) =>
    Object.hasOwn(value ?? {}, key),
  );
  const keys = [
    "version",
    "state",
    "stage",
    "runId",
    "startedAt",
    "updatedAt",
    "lastSuccessAt",
    ...present,
    ...(value?.state === "failed" ? ["failureCode"] : []),
  ];
  exact(value, keys, "status_invalid");
  const lastProofAt = present.includes("lastProofAt") ? value.lastProofAt : null;
  const nextProofDueAt = present.includes("nextProofDueAt")
    ? value.nextProofDueAt
    : null;
  const retention = present.includes("retention") ? value.retention : null;
  if (
    value.version !== 1 ||
    !states.has(value.state) ||
    !stages.has(value.stage) ||
    typeof value.runId !== "string" ||
    !Number.isSafeInteger(value.startedAt) ||
    !Number.isSafeInteger(value.updatedAt) ||
    (value.lastSuccessAt !== null && !Number.isSafeInteger(value.lastSuccessAt)) ||
    (lastProofAt !== null && !Number.isSafeInteger(lastProofAt)) ||
    (nextProofDueAt !== null && !Number.isSafeInteger(nextProofDueAt)) ||
    !validRetention(retention)
  )
    fail("status_invalid");
  if (value.state === "failed") text(value.failureCode, 64);
  return { ...value, lastProofAt, nextProofDueAt, retention };
}
// The isolated restore proof (unlike the backup itself) now runs on a
// cadence, not every run (P2-39k follow-up: `restoreProofEveryDays`), so the
// durable status journal carries its own last-success time and next-due time
// alongside the backup's, and preserves both across a run that did not
// attempt a proof, the same way `lastSuccessAt` already survives a failure.
// `retention` is carried forward the same way on a SUCCESSFUL run that never
// calls recordRetention (an engine, like convex, that has none): nothing went
// wrong, so the last known outcome stays the best available answer. A FAILED
// run is different (BAK-1 second review): it records `skipped` instead of
// carrying the prior value forward, so a failed run never reads as though
// retention succeeded this time. See the failure branch of
// runWithDatabaseBackupState below.
async function priorStatus(path) {
  try {
    const parsed = parseStatus(
      JSON.parse((await readProtected(path, MAX_CONFIG)).toString("utf8")),
    );
    return {
      lastSuccessAt: parsed.lastSuccessAt,
      lastProofAt: parsed.lastProofAt,
      nextProofDueAt: parsed.nextProofDueAt,
      retention: parsed.retention,
    };
  } catch (error) {
    if (error?.code === "ENOENT")
      return { lastSuccessAt: null, lastProofAt: null, nextProofDueAt: null, retention: null };
    if (error instanceof DatabaseBackupRunnerError) throw error;
    fail("status_invalid");
  }
}
async function acquireLock(path, runId, startedAt) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error?.code === "EEXIST")
      fail("backup_already_running_or_recovery_required");
    throw error;
  }
  try {
    await writeAll(
      handle,
      Buffer.from(
        `${JSON.stringify({ version: 1, runId, startedAt, pid: process.pid })}\n`,
      ),
    );
    const identity = await handle.stat({ bigint: true });
    await fsyncDirectory(dirname(path));
    return identity;
  } finally {
    await handle.close();
  }
}
async function releaseLock(path, expected) {
  const value = await lstat(path, { bigint: true });
  if (
    !value.isFile() ||
    value.dev !== expected.dev ||
    value.ino !== expected.ino ||
    value.nlink !== 1n ||
    value.uid !== BigInt(process.getuid()) ||
    value.mode % 0o1000n !== 0o600n
  )
    fail("lock_changed");
  await unlink(path);
  await fsyncDirectory(dirname(path));
}
function killGroup(child, signal) {
  if (!Number.isInteger(child.pid)) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}
async function runCommand(command, flag, directory, config) {
  return await new Promise((resolveCommand, rejectCommand) => {
    let child;
    let failure;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const output = [];
    let killTimer;
    let timeout;
    const terminate = (code, immediate = false) => {
      if (failure) return;
      failure = code;
      try {
        killGroup(child, immediate ? "SIGKILL" : "SIGTERM");
      } catch {
        failure = "command_termination_failed";
      }
      if (!immediate)
        killTimer = setTimeout(() => {
          try {
            killGroup(child, "SIGKILL");
          } catch {}
        }, KILL_GRACE);
    };
    try {
      child = spawn(command.path, [...command.args, flag, directory], {
        cwd: config.cwd,
        env: { HOME: homedir(), LANG: "C", LC_ALL: "C" },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      rejectCommand(new DatabaseBackupRunnerError("command_spawn_failed"));
      return;
    }
    timeout = setTimeout(() => terminate("command_timeout"), config.timeoutMs);
    child.once("error", () => {
      failure = "command_spawn_failed";
    });
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT) terminate("command_output_too_large", true);
      else output.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR) terminate("command_output_too_large", true);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (failure) return rejectCommand(new DatabaseBackupRunnerError(failure));
      if (signal || code !== 0)
        return rejectCommand(new DatabaseBackupRunnerError("command_failed"));
      try {
        const result = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(output),
          ),
        );
        exact(result, ["status"], "command_output_invalid");
        if (result.status !== "passed") fail("command_output_invalid");
      } catch (error) {
        return rejectCommand(
          error instanceof DatabaseBackupRunnerError
            ? error
            : new DatabaseBackupRunnerError("command_output_invalid"),
        );
      }
      resolveCommand();
    });
  });
}
function status({
  state,
  stage,
  runId,
  startedAt,
  updatedAt,
  lastSuccessAt,
  lastProofAt,
  nextProofDueAt,
  retention,
  failureCode,
}) {
  return {
    version: 1,
    state,
    stage,
    runId,
    startedAt,
    updatedAt,
    lastSuccessAt,
    lastProofAt: lastProofAt ?? null,
    nextProofDueAt: nextProofDueAt ?? null,
    retention: retention ?? null,
    ...(failureCode ? { failureCode } : {}),
  };
}

/** Shared lock and durable status journal for engine-specific backup work. */
export async function runWithDatabaseBackupState(config, operation, options = {}) {
  await protectedDirectory(config.stateDirectory, true);
  const clock = options.clock ?? Date.now;
  const runId = randomUUID();
  const startedAt = clock();
  const lockPath = join(config.stateDirectory, "database-backup.lock");
  const statusPath = join(config.stateDirectory, "database-backup-status.json");
  const lock = await acquireLock(lockPath, runId, startedAt);
  let mayRelease = false;
  let stage = "export";
  let prior = { lastSuccessAt: null, lastProofAt: null, nextProofDueAt: null, retention: null };
  let runningRecorded = false;
  // The operation callback (the postgres engine's own cadence decision, in
  // db-backup.mjs) calls this when a restore proof actually ran and passed;
  // omitted, the prior proof time carries forward unchanged, on both success
  // and failure, exactly like `lastSuccessAt` already does.
  let proof = null;
  // Same carry-forward contract for retention (BAK-1 review row 2): the
  // operation calls recordRetention once, after it has decided the run's own
  // outcome (ok/failed/skipped); a run that never calls it (an engine with no
  // retention step, or a failure before reaching that point) keeps the prior
  // recorded outcome rather than erasing it.
  let retention = null;
  const record = async () => atomicStatus(statusPath, status({
    state: "running", stage, runId, startedAt, updatedAt: clock(),
    lastSuccessAt: prior.lastSuccessAt,
    lastProofAt: prior.lastProofAt, nextProofDueAt: prior.nextProofDueAt,
    retention: prior.retention,
  }), runId);
  try {
    prior = await priorStatus(statusPath);
    await record();
    runningRecorded = true;
    const result = await operation({
      runId,
      startedAt,
      setStage: async (nextStage) => { stage = text(nextStage, 64); await record(); },
      priorProof: { lastProofAt: prior.lastProofAt, nextProofDueAt: prior.nextProofDueAt },
      recordProof: (next) => {
        proof = {
          lastProofAt: Number.isSafeInteger(next?.lastProofAt) ? next.lastProofAt : null,
          nextProofDueAt: Number.isSafeInteger(next?.nextProofDueAt) ? next.nextProofDueAt : null,
        };
      },
      recordRetention: (next) => {
        const candidate = {
          state: next?.state,
          code: typeof next?.code === "string" ? next.code : null,
          at: Number.isSafeInteger(next?.at) ? next.at : null,
          removed: Number.isSafeInteger(next?.removed) ? next.removed : null,
          kept: Number.isSafeInteger(next?.kept) ? next.kept : null,
        };
        if (!RETENTION_STATES.has(candidate.state)) fail("status_invalid");
        retention = candidate;
      },
    });
    const finishedAt = clock();
    await atomicStatus(statusPath, status({
      state: "succeeded", stage: "complete", runId, startedAt,
      updatedAt: finishedAt, lastSuccessAt: finishedAt,
      lastProofAt: proof?.lastProofAt ?? prior.lastProofAt,
      nextProofDueAt: proof?.nextProofDueAt ?? prior.nextProofDueAt,
      retention: retention ?? prior.retention,
    }), runId);
    mayRelease = true;
    return { ...result, runId, startedAt, finishedAt };
  } catch (error) {
    const failureCode =
      typeof error?.code === "string" && error.code.length <= 64
        ? error.code
        : "runner_failed";
    try {
      if (!runningRecorded) throw new DatabaseBackupRunnerError("status_unusable");
      await atomicStatus(statusPath, status({
        state: "failed", stage, runId, startedAt, updatedAt: clock(),
        lastSuccessAt: prior.lastSuccessAt,
        lastProofAt: proof?.lastProofAt ?? prior.lastProofAt,
        nextProofDueAt: proof?.nextProofDueAt ?? prior.nextProofDueAt,
        // Unlike lastSuccessAt/lastProofAt, a FAILED run must not report the
        // previous run's retention outcome as its own (BAK-1 second review):
        // an operator reading "ok" on a failed run's status record would
        // reasonably conclude retention ran fine this time. When the
        // operation never called recordRetention this run -- a failure
        // during export or backup, before retention is ever reached -- record
        // it as not run (`skipped`) instead of carrying the stale value
        // forward. The one call site that already reaches recordRetention on
        // a failure (a verify failure, recorded `skipped` explicitly in
        // db-backup.mjs) is unaffected: `retention` is already non-null there.
        retention: retention ?? { state: "skipped", code: null, at: clock(), removed: null, kept: null },
        failureCode,
      }), runId);
      mayRelease = true;
    } catch {
      mayRelease = false;
    }
    throw new DatabaseBackupRunnerError(failureCode);
  } finally {
    if (mayRelease) await releaseLock(lockPath, lock);
  }
}

export async function runDatabaseBackup(config, options = {}) {
  config = parseConfig(config);
  await validateConfigPaths(config);
  const clock = options.clock ?? Date.now;
  const command = options.command ?? runCommand;
  const runId = randomUUID();
  const startedAt = clock();
  const lockPath = join(config.stateDirectory, "database-backup.lock");
  const statusPath = join(config.stateDirectory, "database-backup-status.json");
  const lock = await acquireLock(lockPath, runId, startedAt);
  let mayRelease = false;
  let stage = "export";
  let prior = null;
  let runningRecorded = false;
  try {
    prior = (await priorStatus(statusPath)).lastSuccessAt;
    await atomicStatus(
      statusPath,
      status({
        state: "running",
        stage,
        runId,
        startedAt,
        updatedAt: clock(),
        lastSuccessAt: prior,
      }),
      runId,
    );
    runningRecorded = true;
    const directory = join(
      config.stagingRoot,
      `${new Date(startedAt).toISOString().replace(/[:.]/gu, "-")}-${runId}`,
    );
    await mkdir(directory, { mode: 0o700 });
    await fsyncDirectory(config.stagingRoot);
    await protectedDirectory(directory, true);
    await command(
      config.exportCommand,
      "--output-directory",
      directory,
      config,
    );
    stage = "backup";
    await atomicStatus(
      statusPath,
      status({
        state: "running",
        stage,
        runId,
        startedAt,
        updatedAt: clock(),
        lastSuccessAt: prior,
      }),
      runId,
    );
    await command(config.backupCommand, "--input-directory", directory, config);
    const finishedAt = clock();
    await atomicStatus(
      statusPath,
      status({
        state: "succeeded",
        stage: "complete",
        runId,
        startedAt,
        updatedAt: finishedAt,
        lastSuccessAt: finishedAt,
      }),
      runId,
    );
    mayRelease = true;
    return { status: "passed", runId, startedAt, finishedAt };
  } catch (error) {
    const failureCode =
      error instanceof DatabaseBackupRunnerError ? error.code : "runner_failed";
    try {
      if (!runningRecorded)
        throw new DatabaseBackupRunnerError("status_unusable");
      await atomicStatus(
        statusPath,
        status({
          state: "failed",
          stage,
          runId,
          startedAt,
          updatedAt: clock(),
          lastSuccessAt: prior,
          failureCode,
        }),
        runId,
      );
      mayRelease = true;
    } catch {
      mayRelease = false;
    }
    throw new DatabaseBackupRunnerError(failureCode);
  } finally {
    if (mayRelease) await releaseLock(lockPath, lock);
  }
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
  if (process.argv.length !== 4 || process.argv[2] !== "--config")
    fail("usage_invalid");
  const result = await runDatabaseBackup(
    await loadDatabaseBackupConfig(process.argv[3]),
  );
  process.stdout.write(
    `${JSON.stringify({ status: result.status, runId: result.runId })}\n`,
  );
}
if (isMain())
  main().catch((error) => {
    const code =
      error instanceof DatabaseBackupRunnerError ? error.code : "runner_failed";
    process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
    process.exitCode = 1;
  });
