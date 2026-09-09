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
const stages = new Set(["export", "backup", "complete"]);

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
function exact(value, keys, code = "config_invalid") {
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
function text(value, max = 4_096) {
  if (
    typeof value !== "string" ||
    !value.length ||
    Buffer.byteLength(value) > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
  )
    fail("config_invalid");
  return value;
}
function absolute(value) {
  const path = text(value);
  if (!isAbsolute(path) || resolve(path) !== path) fail("config_invalid");
  return path;
}
async function protectedDirectory(path, ownerOnly = false) {
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
async function protectedExecutable(path) {
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
async function readProtected(path, maximum) {
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
async function fsyncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function writeAll(handle, bytes) {
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
function parseStatus(value) {
  const keys = [
    "version",
    "state",
    "stage",
    "runId",
    "startedAt",
    "updatedAt",
    "lastSuccessAt",
    ...(value?.state === "failed" ? ["failureCode"] : []),
  ];
  exact(value, keys, "status_invalid");
  if (
    value.version !== 1 ||
    !states.has(value.state) ||
    !stages.has(value.stage) ||
    typeof value.runId !== "string" ||
    !Number.isSafeInteger(value.startedAt) ||
    !Number.isSafeInteger(value.updatedAt) ||
    (value.lastSuccessAt !== null && !Number.isSafeInteger(value.lastSuccessAt))
  )
    fail("status_invalid");
  if (value.state === "failed") text(value.failureCode, 64);
  return value;
}
async function lastSuccess(path) {
  try {
    return parseStatus(
      JSON.parse((await readProtected(path, MAX_CONFIG)).toString("utf8")),
    ).lastSuccessAt;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
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
    ...(failureCode ? { failureCode } : {}),
  };
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
    prior = await lastSuccess(statusPath);
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
