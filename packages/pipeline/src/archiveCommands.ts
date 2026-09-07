import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { access, lstat, link, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import {
  AGE_VERSION,
  DEFAULT_ARCHIVE_COMMAND_LIMITS,
  RESTIC_VERSION,
  type ArchiveCommandFailureCode,
  type ArchiveCommandLimits,
  type ArchiveToolPaths,
  type ArchiveToolVersions,
  type BackupResticObjectInput,
  type EncryptAgeObjectInput,
  type LocalBackupBoundary,
  type PasswordCommand,
  type PreparedAgeObject,
  type PublishedAgeObject,
  type ReadbackResticObjectInput,
  type RecoveredResticBackup,
  type RecoverResticBackupInput,
  type ResticBackupResult,
  type ResticReadbackResult,
  type ResticRepositoryIdentity,
  type Sha256File,
} from "./archiveTypes.js";

const HEX_64 = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OBJECT_NAME = /^[A-Za-z0-9_-]{1,128}\.age$/;
const PQ_RECIPIENT = /^age1pq1[023456789acdefghjklmnpqrstuvwxyz]{40,4090}$/;
const MAX_PASSWORD_COMMAND_ARGS = 16;
const MAX_PASSWORD_COMMAND_ARG_BYTES = 256;
const FILE_MODE = 0o600;

type ProcessResult = { stdout: Buffer; stderr: Buffer };
type FileIdentity = {
  device: number;
  inode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

export class ArchiveCommandError extends Error {
  constructor(
    readonly code: ArchiveCommandFailureCode,
    message: string,
  ) {
    super(`Archive command failed: ${message}`);
    this.name = "ArchiveCommandError";
  }
}

function fail(code: ArchiveCommandFailureCode, message: string): never {
  throw new ArchiveCommandError(code, message);
}

function rethrowSafe(
  error: unknown,
  code: ArchiveCommandFailureCode,
  message: string,
): never {
  if (error instanceof ArchiveCommandError) throw error;
  throw new ArchiveCommandError(code, message);
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    fail("unsupported_platform", "POSIX ownership checks are unavailable");
  }
  return uid;
}

function requiredOpenConstants(): void {
  if (
    typeof constants.O_NOFOLLOW !== "number" ||
    constants.O_NOFOLLOW === 0 ||
    typeof constants.O_NONBLOCK !== "number"
  ) {
    fail("unsupported_platform", "safe file open flags are unavailable");
  }
}

function safeAbsolutePath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 4_096
  ) {
    fail("invalid_input", `${label} is invalid`);
  }
  return resolve(value);
}

function limits(value: ArchiveCommandLimits): ArchiveCommandLimits {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 4 ||
    !Object.prototype.hasOwnProperty.call(value, "deadlineMs") ||
    !Object.prototype.hasOwnProperty.call(value, "maxOutputBytes") ||
    !Object.prototype.hasOwnProperty.call(value, "maxSourceBytes") ||
    !Object.prototype.hasOwnProperty.call(value, "maxCipherBytes")
  ) {
    fail("invalid_input", "command limits are invalid");
  }
  const entries = [
    value.deadlineMs,
    value.maxOutputBytes,
    value.maxSourceBytes,
    value.maxCipherBytes,
  ];
  if (
    entries.some((entry) => !Number.isSafeInteger(entry) || entry < 1) ||
    value.deadlineMs > 10 * 60_000 ||
    value.maxOutputBytes > 2 * 1024 * 1024 ||
    value.maxSourceBytes > 64 * 1024 * 1024 ||
    value.maxCipherBytes > 66 * 1024 * 1024 ||
    value.maxCipherBytes < value.maxSourceBytes
  ) {
    fail("invalid_input", "command limits are invalid");
  }
  return {
    deadlineMs: value.deadlineMs,
    maxOutputBytes: value.maxOutputBytes,
    maxSourceBytes: value.maxSourceBytes,
    maxCipherBytes: value.maxCipherBytes,
  };
}

function expectedFile(value: Sha256File, maximum: number): Sha256File {
  if (
    !HEX_64.test(value.sha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 1 ||
    value.byteLength > maximum
  ) {
    fail("invalid_input", "expected file identity is invalid");
  }
  return { sha256: value.sha256, byteLength: value.byteLength };
}

function identity(entry: Stats): FileIdentity {
  return {
    device: entry.dev,
    inode: entry.ino,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameDirectoryIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function safeDirectoryAncestors(
  path: string,
  label: string,
): Promise<void> {
  const uid = currentUid();
  let ancestor = path;
  for (let depth = 0; ; depth += 1) {
    if (depth >= 256) fail("unsafe_path", `${label} ancestry is too deep`);
    const entry = await lstat(ancestor).catch(() =>
      fail("unsafe_path", `${label} ancestor is unavailable`),
    );
    const protectedSticky = entry.uid === 0 && (entry.mode & 0o1000) !== 0;
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      (entry.uid !== uid && entry.uid !== 0) ||
      ((entry.mode & 0o022) !== 0 && !protectedSticky)
    ) {
      fail("unsafe_path", `${label} ancestor is not trusted`);
    }
    const next = dirname(ancestor);
    if (next === ancestor) return;
    ancestor = next;
  }
}

function safeDirectoryEntry(entry: Stats, label: string): void {
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    entry.uid !== currentUid() ||
    (entry.mode & 0o022) !== 0
  ) {
    fail("unsafe_path", `${label} is not a protected directory`);
  }
}

async function safeDirectory(path: string, label: string): Promise<Stats> {
  const requested = safeAbsolutePath(path, label);
  let before: Stats;
  try {
    before = await lstat(requested);
  } catch {
    fail("unsafe_path", `${label} is unavailable`);
  }
  safeDirectoryEntry(before, label);
  let canonical: string;
  try {
    canonical = await realpath(requested);
  } catch {
    fail("unsafe_path", `${label} cannot be resolved`);
  }
  if (canonical !== requested) {
    fail("unsafe_path", `${label} must be canonical`);
  }
  await safeDirectoryAncestors(canonical, label);
  const after = await lstat(canonical).catch(() =>
    fail("unsafe_path", `${label} changed during validation`),
  );
  safeDirectoryEntry(after, label);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    fail("unsafe_path", `${label} changed during validation`);
  }
  await safeDirectoryAncestors(canonical, label);
  return after;
}

async function validateExecutable(path: string, label: string): Promise<void> {
  requiredOpenConstants();
  const requested = safeAbsolutePath(path, label);
  const canonical = await realpath(requested).catch(() =>
    fail("unsafe_path", `${label} cannot be resolved`),
  );
  if (canonical !== requested) {
    fail("unsafe_path", `${label} must use its canonical path`);
  }
  const parent = dirname(requested);
  const parentEntry = await lstat(parent).catch(() =>
    fail("unsafe_path", `${label} parent is unavailable`),
  );
  const uid = currentUid();
  // A protected immediate parent can itself be replaced through a writable
  // ancestor. Root-owned sticky temporary directories preserve ownership of
  // their child entries and are the sole writable-ancestor exception.
  let ancestor = parent;
  for (let depth = 0; ; depth += 1) {
    if (depth >= 256) fail("unsafe_path", `${label} ancestry is too deep`);
    const entry = await lstat(ancestor).catch(() =>
      fail("unsafe_path", `${label} ancestor is unavailable`),
    );
    const protectedSticky = entry.uid === 0 && (entry.mode & 0o1000) !== 0;
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      (entry.uid !== uid && entry.uid !== 0) ||
      ((entry.mode & 0o022) !== 0 && !protectedSticky)
    ) {
      fail("unsafe_path", `${label} ancestor is not trusted`);
    }
    const next = dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  if (
    parentEntry.isSymbolicLink() ||
    !parentEntry.isDirectory() ||
    (parentEntry.uid !== uid && parentEntry.uid !== 0) ||
    (parentEntry.mode & 0o022) !== 0 ||
    (await realpath(parent).catch(() => "")) !== parent
  ) {
    fail("unsafe_path", `${label} parent is not trusted`);
  }
  const before = await lstat(requested).catch(() =>
    fail("unsafe_path", `${label} is unavailable`),
  );
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    (before.uid !== uid && before.uid !== 0) ||
    (before.mode & 0o022) !== 0
  ) {
    fail("unsafe_path", `${label} is not a trusted executable`);
  }
  await access(requested, constants.X_OK).catch(() =>
    fail("unsafe_path", `${label} is not executable`),
  );
  const handle = await open(
    requested,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => fail("unsafe_path", `${label} cannot be opened safely`));
  try {
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      fail("unsafe_path", `${label} changed during validation`);
    }
  } finally {
    await handle.close();
  }
}

function killProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function child(
  executable: string,
  args: readonly string[],
  cwd?: string,
): ChildProcessWithoutNullStreams {
  return spawn(executable, args, {
    cwd,
    detached: true,
    env: { LANG: "C", LC_ALL: "C" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function processCompletion(
  running: ChildProcessWithoutNullStreams,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    running.once("error", () => {
      reject(new ArchiveCommandError("process_failed", "tool did not start"));
    });
    running.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolvePromise();
      else
        reject(
          new ArchiveCommandError("process_failed", "tool returned failure"),
        );
    });
  });
}

async function withinProcessDeadline<T>(
  running: ChildProcessWithoutNullStreams,
  work: Promise<T>,
  deadlineMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      killProcessTree(running);
      running.stdin.destroy();
      running.stdout.destroy();
      running.stderr.destroy();
      reject(
        new ArchiveCommandError("process_timeout", "tool exceeded deadline"),
      );
    }, deadlineMs);
    timer.unref();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function collect(
  stream: NodeJS.ReadableStream,
  maximum: number,
  running: ChildProcessWithoutNullStreams,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      length += chunk.length;
      if (length > maximum) {
        killProcessTree(running);
        fail("output_limit_exceeded", "tool output exceeded limit");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    if (error instanceof ArchiveCommandError) throw error;
    fail("process_failed", "tool output could not be read");
  }
}

async function runBounded(
  executable: string,
  args: readonly string[],
  commandLimits: ArchiveCommandLimits,
  cwd?: string,
): Promise<ProcessResult> {
  const running = child(executable, args, cwd);
  running.stdin.end();
  const stdoutPromise = collect(
    running.stdout,
    commandLimits.maxOutputBytes,
    running,
  );
  const stderrPromise = collect(
    running.stderr,
    commandLimits.maxOutputBytes,
    running,
  );
  const completion = processCompletion(running);
  const work = Promise.all([stdoutPromise, stderrPromise, completion]).then(
    ([stdout, stderr]) => ({ stdout, stderr }),
  );
  try {
    return await withinProcessDeadline(running, work, commandLimits.deadlineMs);
  } catch (error) {
    killProcessTree(running);
    running.stdin.destroy();
    running.stdout.destroy();
    running.stderr.destroy();
    throw error;
  }
}

async function runHashedOutput(
  executable: string,
  args: readonly string[],
  maximumBytes: number,
  commandLimits: ArchiveCommandLimits,
): Promise<Sha256File> {
  const running = child(executable, args);
  running.stdin.end();
  const digest = createHash("sha256");
  let byteLength = 0;
  const outputPromise = (async () => {
    try {
      for await (const value of running.stdout) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        byteLength += chunk.length;
        if (byteLength > maximumBytes) {
          killProcessTree(running);
          fail("output_limit_exceeded", "readback exceeded limit");
        }
        digest.update(chunk);
        chunk.fill(0);
      }
    } catch (error) {
      if (error instanceof ArchiveCommandError) throw error;
      fail("process_failed", "readback could not be consumed");
    }
  })();
  const stderrPromise = collect(
    running.stderr,
    commandLimits.maxOutputBytes,
    running,
  );
  const completion = processCompletion(running);
  let stderr: Buffer | undefined;
  try {
    const work = Promise.all([outputPromise, stderrPromise, completion]);
    [, stderr] = await withinProcessDeadline(
      running,
      work,
      commandLimits.deadlineMs,
    );
    if (byteLength < 1) {
      fail("invalid_tool_result", "readback is empty");
    }
    return { sha256: digest.digest("hex"), byteLength };
  } catch (error) {
    killProcessTree(running);
    running.stdin.destroy();
    running.stdout.destroy();
    running.stderr.destroy();
    throw error;
  } finally {
    stderr?.fill(0);
  }
}

async function requireAgeVersion(
  executable: string,
  commandLimits: ArchiveCommandLimits,
): Promise<void> {
  const result = await runBounded(executable, ["--version"], commandLimits);
  try {
    if (decodeUtf8(result.stdout).trim() !== AGE_VERSION) {
      fail("tool_version_mismatch", "age version is not pinned");
    }
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
}

async function requireResticVersion(
  executable: string,
  commandLimits: ArchiveCommandLimits,
): Promise<void> {
  const result = await runBounded(executable, ["version"], commandLimits);
  try {
    if (
      !/^restic 0\.19\.1 compiled with go[0-9.]+ on [a-z0-9_/-]+$/.test(
        decodeUtf8(result.stdout).trim(),
      )
    ) {
      fail("tool_version_mismatch", "restic version is not pinned");
    }
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
}

async function readExactFile(
  path: string,
  maximum: number,
  protectedMode: boolean,
): Promise<{ bytes: Buffer; identity: FileIdentity; digest: Sha256File }> {
  requiredOpenConstants();
  const requested = safeAbsolutePath(path, "file");
  await safeDirectory(dirname(requested), "file parent");
  const beforePath = await lstat(requested).catch(() =>
    fail("unsafe_path", "file is unavailable"),
  );
  if (
    beforePath.isSymbolicLink() ||
    !beforePath.isFile() ||
    beforePath.uid !== currentUid() ||
    (protectedMode && (beforePath.mode & 0o077) !== 0) ||
    beforePath.size < 1 ||
    beforePath.size > maximum
  ) {
    fail("unsafe_path", "file is not a safe bounded regular file");
  }
  const handle = await open(
    requested,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => fail("unsafe_path", "file cannot be opened safely"));
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== beforePath.dev ||
      before.ino !== beforePath.ino ||
      before.size !== beforePath.size ||
      before.size < 1 ||
      before.size > maximum
    ) {
      fail("source_changed", "file changed before read");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== bytes.length) {
      bytes.fill(0);
      fail("source_changed", "file changed during read");
    }
    const after = await handle.stat();
    const afterPath = await lstat(requested).catch(() =>
      fail("source_changed", "file path changed during read"),
    );
    const beforeIdentity = identity(before);
    if (
      !sameIdentity(beforeIdentity, identity(after)) ||
      !sameIdentity(identity(beforePath), identity(afterPath))
    ) {
      bytes.fill(0);
      fail("source_changed", "file changed during read");
    }
    return {
      bytes,
      identity: beforeIdentity,
      digest: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.length,
      },
    };
  } finally {
    await handle.close();
  }
}

async function recheckFile(
  path: string,
  expected: FileIdentity,
): Promise<void> {
  const current = await lstat(path).catch(() =>
    fail("source_changed", "file changed after command"),
  );
  if (!sameIdentity(expected, identity(current))) {
    fail("source_changed", "file changed after command");
  }
}

async function unlinkExact(
  path: string,
  expected: FileIdentity,
): Promise<void> {
  const current = await lstat(path).catch(() => undefined);
  if (
    current !== undefined &&
    current.dev === expected.device &&
    current.ino === expected.inode
  ) {
    await unlink(path).catch(() => undefined);
  }
}

async function streamAgeOutput(
  executable: string,
  args: readonly string[],
  plaintext: Buffer,
  outputPath: string,
  commandLimits: ArchiveCommandLimits,
): Promise<void> {
  requiredOpenConstants();
  const parent = dirname(outputPath);
  await safeDirectory(parent, "age output parent");
  const handle = await open(
    outputPath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    FILE_MODE,
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail("destination_exists", "age output already exists");
    }
    fail("unsafe_path", "age output could not be created");
  });
  const createdIdentity = identity(
    await handle.stat().catch((error: unknown) => {
      rethrowSafe(error, "unsafe_path", "age output could not be inspected");
    }),
  );
  try {
    await handle.chmod(FILE_MODE);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlinkExact(outputPath, createdIdentity);
    rethrowSafe(
      error,
      "unsafe_path",
      "age output permissions could not be fixed",
    );
  }
  const running = child(executable, args);
  const stderrPromise = collect(
    running.stderr,
    commandLimits.maxOutputBytes,
    running,
  );
  const completion = processCompletion(running);
  const outputPromise = (async () => {
    let offset = 0;
    for await (const value of running.stdout) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (offset + chunk.length > commandLimits.maxCipherBytes) {
        killProcessTree(running);
        fail("output_limit_exceeded", "ciphertext exceeded limit");
      }
      let written = 0;
      while (written < chunk.length) {
        const result = await handle.write(
          chunk,
          written,
          chunk.length - written,
          offset + written,
        );
        if (result.bytesWritten === 0) {
          killProcessTree(running);
          fail("process_failed", "ciphertext write made no progress");
        }
        written += result.bytesWritten;
      }
      offset += chunk.length;
    }
    if (offset < 1) fail("invalid_tool_result", "ciphertext is empty");
  })();
  running.stdin.on("error", () => undefined);
  running.stdin.end(plaintext);
  let stderr: Buffer | undefined;
  try {
    const work = Promise.all([outputPromise, stderrPromise, completion]);
    [, stderr] = await withinProcessDeadline(
      running,
      work,
      commandLimits.deadlineMs,
    );
    await handle.sync();
  } catch (error) {
    killProcessTree(running);
    running.stdin.destroy();
    running.stdout.destroy();
    running.stderr.destroy();
    await handle.close().catch(() => undefined);
    await unlinkExact(outputPath, createdIdentity);
    rethrowSafe(error, "process_failed", "age encryption failed");
  } finally {
    stderr?.fill(0);
    await handle.close().catch(() => undefined);
  }
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail("invalid_tool_result", "tool output is not UTF-8");
  }
}

function parseResticSummary(stdout: Buffer, expected: Sha256File): string {
  const lines = decodeUtf8(stdout)
    .split("\n")
    .filter((line) => line.length > 0);
  if (lines.length < 1 || lines.length > 4_096) {
    fail("invalid_tool_result", "restic output has invalid framing");
  }
  let snapshotId: string | undefined;
  let summaryIndex = -1;
  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      fail("invalid_tool_result", "restic output is not JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail("invalid_tool_result", "restic output row is invalid");
    }
    const row = value as Record<string, unknown>;
    if (row.message_type !== "summary") continue;
    if (snapshotId !== undefined) {
      fail("invalid_tool_result", "restic returned multiple summaries");
    }
    if (
      !Number.isSafeInteger(row.total_files_processed) ||
      row.total_files_processed !== 1 ||
      !Number.isSafeInteger(row.total_bytes_processed) ||
      row.total_bytes_processed !== expected.byteLength ||
      typeof row.snapshot_id !== "string" ||
      !HEX_64.test(row.snapshot_id)
    ) {
      fail("invalid_tool_result", "restic summary is inconsistent");
    }
    snapshotId = row.snapshot_id;
    summaryIndex = index;
  }
  if (snapshotId === undefined || summaryIndex !== lines.length - 1) {
    fail("invalid_tool_result", "restic summary is missing");
  }
  return snapshotId;
}

function parseResticSnapshots(
  stdout: Buffer,
  operationId: string,
  host: string,
  objectName: string,
): string[] {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(stdout));
  } catch {
    fail("invalid_tool_result", "restic snapshots output is not JSON");
  }
  if (!Array.isArray(value)) {
    fail("invalid_tool_result", "restic snapshot count is invalid");
  }
  if (value.length === 0) {
    fail("not_found", "restic snapshot was not found");
  }
  if (value.length !== 1) {
    fail("invalid_tool_result", "restic snapshot result is ambiguous");
  }
  const matches: string[] = [];
  for (const candidate of value) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      fail("invalid_tool_result", "restic snapshot row is invalid");
    }
    const row = candidate as Record<string, unknown>;
    if (
      row.hostname !== host ||
      typeof row.id !== "string" ||
      !HEX_64.test(row.id) ||
      !Array.isArray(row.tags) ||
      row.tags.length < 1 ||
      row.tags.length > 32 ||
      row.tags.some((tag) => typeof tag !== "string") ||
      !row.tags.includes(operationId) ||
      !Array.isArray(row.paths) ||
      row.paths.length !== 1 ||
      typeof row.paths[0] !== "string" ||
      basename(row.paths[0]) !== objectName
    ) {
      fail("invalid_tool_result", "restic snapshot identity is inconsistent");
    }
    matches.push(row.id);
  }
  if (new Set(matches).size !== matches.length) {
    fail("invalid_tool_result", "restic returned duplicate snapshot IDs");
  }
  return matches.sort();
}

function parseResticRepository(stdout: Buffer): ResticRepositoryIdentity {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(stdout));
  } catch {
    fail("invalid_tool_result", "restic repository config is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_tool_result", "restic repository config is invalid");
  }
  const config = value as Record<string, unknown>;
  if (
    config.version !== 2 ||
    typeof config.id !== "string" ||
    !HEX_64.test(config.id)
  ) {
    fail("invalid_tool_result", "restic repository identity is invalid");
  }
  return { repositoryId: config.id, repositoryVersion: 2 };
}

function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function passwordCommandArgument(
  command: PasswordCommand,
): Promise<string> {
  await validateExecutable(command.executable, "password command");
  const args = [...(command.publicArgs ?? [])];
  if (
    args.length > MAX_PASSWORD_COMMAND_ARGS ||
    args.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        Buffer.byteLength(value, "utf8") > MAX_PASSWORD_COMMAND_ARG_BYTES ||
        /[\x00-\x1f\x7f]/.test(value),
    )
  ) {
    fail("invalid_input", "password command selectors are invalid");
  }
  return [command.executable, ...args].map(quoteShellWord).join(" ");
}

function resticBaseArgs(repository: string, passwordCommand: string): string[] {
  return [
    "--repo",
    repository,
    "--password-command",
    passwordCommand,
    "--no-cache",
  ];
}

async function probeResticRepositoryInternal(input: {
  resticBinary: string;
  repositoryPath: string;
  passwordCommand: PasswordCommand;
  limits?: ArchiveCommandLimits;
}): Promise<ResticRepositoryIdentity> {
  const commandLimits = limits(input.limits ?? DEFAULT_ARCHIVE_COMMAND_LIMITS);
  await validateExecutable(input.resticBinary, "restic binary");
  await requireResticVersion(input.resticBinary, commandLimits);
  const repository = safeAbsolutePath(
    input.repositoryPath,
    "restic repository",
  );
  await safeDirectory(repository, "restic repository");
  const password = await passwordCommandArgument(input.passwordCommand);
  const result = await runBounded(
    input.resticBinary,
    [...resticBaseArgs(repository, password), "cat", "config"],
    commandLimits,
  );
  try {
    return parseResticRepository(result.stdout);
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
}

async function requireResticRepository(
  input: {
    resticBinary: string;
    repositoryPath: string;
    passwordCommand: PasswordCommand;
    limits?: ArchiveCommandLimits;
  },
  expectedRepositoryId: string,
): Promise<ResticRepositoryIdentity> {
  if (!HEX_64.test(expectedRepositoryId)) {
    fail("invalid_input", "expected restic repository identity is invalid");
  }
  const repository = await probeResticRepositoryInternal(input);
  if (repository.repositoryId !== expectedRepositoryId) {
    fail("digest_mismatch", "restic repository identity changed");
  }
  return repository;
}

async function probeArchiveToolsInternal(
  tools: ArchiveToolPaths,
  requestedLimits: ArchiveCommandLimits = DEFAULT_ARCHIVE_COMMAND_LIMITS,
): Promise<ArchiveToolVersions> {
  const commandLimits = limits(requestedLimits);
  await Promise.all([
    validateExecutable(tools.ageBinary, "age binary"),
    validateExecutable(tools.resticBinary, "restic binary"),
  ]);
  await Promise.all([
    requireAgeVersion(tools.ageBinary, commandLimits),
    requireResticVersion(tools.resticBinary, commandLimits),
  ]);
  return { age: AGE_VERSION, restic: RESTIC_VERSION };
}

async function encryptAgeObjectInternal(
  input: EncryptAgeObjectInput,
): Promise<PreparedAgeObject> {
  const commandLimits = limits(input.limits ?? DEFAULT_ARCHIVE_COMMAND_LIMITS);
  await validateExecutable(input.ageBinary, "age binary");
  await requireAgeVersion(input.ageBinary, commandLimits);
  if (!PQ_RECIPIENT.test(input.recipient)) {
    fail("invalid_input", "age recipient must be one native PQ recipient");
  }
  const expected = expectedFile(
    input.expectedSource,
    commandLimits.maxSourceBytes,
  );
  const sourcePath = safeAbsolutePath(input.sourcePath, "source path");
  const outputPath = safeAbsolutePath(input.tempOutputPath, "age output path");
  if (sourcePath === outputPath) {
    fail("invalid_input", "source and output paths must differ");
  }
  const archiveDirectory = await safeDirectory(
    dirname(outputPath),
    "archive object directory",
  );
  const source = await readExactFile(
    sourcePath,
    commandLimits.maxSourceBytes,
    false,
  );
  try {
    if (
      source.digest.sha256 !== expected.sha256 ||
      source.digest.byteLength !== expected.byteLength
    ) {
      fail("digest_mismatch", "source identity does not match intent");
    }
    await streamAgeOutput(
      input.ageBinary,
      ["--recipient", input.recipient],
      source.bytes,
      outputPath,
      commandLimits,
    );
    await recheckFile(sourcePath, source.identity);
    const ciphertext = await readExactFile(
      outputPath,
      commandLimits.maxCipherBytes,
      true,
    );
    ciphertext.bytes.fill(0);
    const archiveDirectoryAfter = await safeDirectory(
      dirname(outputPath),
      "archive object directory",
    );
    if (!sameDirectoryIdentity(archiveDirectory, archiveDirectoryAfter)) {
      fail(
        "source_changed",
        "archive object directory changed during preparation",
      );
    }
    return {
      state: "prepared",
      tempPath: outputPath,
      source: expected,
      ciphertext: ciphertext.digest,
      ciphertextDevice: ciphertext.identity.device,
      ciphertextInode: ciphertext.identity.inode,
      archiveDirectoryDevice: archiveDirectory.dev,
      archiveDirectoryInode: archiveDirectory.ino,
      ageVersion: AGE_VERSION,
    };
  } finally {
    source.bytes.fill(0);
  }
}

async function publishAgeObjectInternal(
  prepared: PreparedAgeObject,
  finalPath: string,
  requestedLimits: ArchiveCommandLimits = DEFAULT_ARCHIVE_COMMAND_LIMITS,
): Promise<PublishedAgeObject> {
  const commandLimits = limits(requestedLimits);
  if (prepared.state !== "prepared" || prepared.ageVersion !== AGE_VERSION) {
    fail("invalid_input", "prepared ciphertext is invalid");
  }
  const expected = expectedFile(
    prepared.ciphertext,
    commandLimits.maxCipherBytes,
  );
  const source = expectedFile(prepared.source, commandLimits.maxSourceBytes);
  if (
    !Number.isSafeInteger(prepared.ciphertextDevice) ||
    prepared.ciphertextDevice < 0 ||
    !Number.isSafeInteger(prepared.ciphertextInode) ||
    prepared.ciphertextInode < 1 ||
    !Number.isSafeInteger(prepared.archiveDirectoryDevice) ||
    prepared.archiveDirectoryDevice < 0 ||
    !Number.isSafeInteger(prepared.archiveDirectoryInode) ||
    prepared.archiveDirectoryInode < 1
  ) {
    fail("invalid_input", "prepared ciphertext identity is invalid");
  }
  const tempPath = safeAbsolutePath(prepared.tempPath, "temporary object");
  const objectPath = safeAbsolutePath(finalPath, "final object");
  if (tempPath === objectPath || dirname(tempPath) !== dirname(objectPath)) {
    fail("invalid_input", "publication must stay in one directory");
  }
  if (!OBJECT_NAME.test(basename(objectPath))) {
    fail("invalid_input", "final object name is invalid");
  }
  const archiveDirectory = await safeDirectory(
    dirname(tempPath),
    "archive object directory",
  );
  if (
    archiveDirectory.dev !== prepared.archiveDirectoryDevice ||
    archiveDirectory.ino !== prepared.archiveDirectoryInode
  ) {
    fail("unsafe_path", "archive object directory does not match preparation");
  }
  const cleanupOwnedObject = async (
    path: string,
    expectedIdentity: FileIdentity,
  ) => {
    const currentDirectory = await safeDirectory(
      dirname(path),
      "archive object directory",
    ).catch(() => undefined);
    if (
      currentDirectory !== undefined &&
      sameDirectoryIdentity(archiveDirectory, currentDirectory)
    ) {
      await unlinkExact(path, expectedIdentity);
    }
  };
  const temporary = await readExactFile(
    tempPath,
    commandLimits.maxCipherBytes,
    true,
  );
  temporary.bytes.fill(0);
  if (
    temporary.identity.device !== prepared.ciphertextDevice ||
    temporary.identity.inode !== prepared.ciphertextInode ||
    temporary.digest.sha256 !== expected.sha256 ||
    temporary.digest.byteLength !== expected.byteLength
  ) {
    fail("digest_mismatch", "prepared ciphertext changed");
  }
  await link(tempPath, objectPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail("destination_exists", "final object already exists");
    }
    fail("unsafe_path", "final object could not be published");
  });
  const linked = await lstat(objectPath).catch((error: unknown) => {
    rethrowSafe(
      error,
      "unsafe_path",
      "published object could not be inspected",
    );
  });
  const linkedIdentity = identity(linked);
  if (
    linkedIdentity.device !== temporary.identity.device ||
    linkedIdentity.inode !== temporary.identity.inode
  ) {
    // The observed inode may be an unrelated replacement. Cleanup can only
    // target the inode owned by the persisted preparation.
    await cleanupOwnedObject(objectPath, temporary.identity);
    fail("unsafe_path", "published object does not match prepared object");
  }
  const archiveDirectoryBeforeRead = await safeDirectory(
    dirname(objectPath),
    "archive object directory",
  );
  if (!sameDirectoryIdentity(archiveDirectory, archiveDirectoryBeforeRead)) {
    fail("unsafe_path", "archive object directory changed during publication");
  }
  const published = await readExactFile(
    objectPath,
    commandLimits.maxCipherBytes,
    true,
  ).catch(async (error: unknown) => {
    await cleanupOwnedObject(objectPath, linkedIdentity);
    throw error;
  });
  published.bytes.fill(0);
  const archiveDirectoryAfterRead = await safeDirectory(
    dirname(objectPath),
    "archive object directory",
  );
  if (!sameDirectoryIdentity(archiveDirectory, archiveDirectoryAfterRead)) {
    fail("unsafe_path", "archive object directory changed during readback");
  }
  if (
    published.digest.sha256 !== expected.sha256 ||
    published.digest.byteLength !== expected.byteLength
  ) {
    await cleanupOwnedObject(objectPath, linkedIdentity);
    fail("digest_mismatch", "published ciphertext is inconsistent");
  }
  const directoryHandle = await open(
    dirname(objectPath),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (
      !sameDirectoryIdentity(archiveDirectory, await directoryHandle.stat())
    ) {
      fail("unsafe_path", "archive object directory changed before cleanup");
    }
    await directoryHandle.sync();
    const currentDirectory = await safeDirectory(
      dirname(tempPath),
      "archive object directory",
    );
    if (!sameDirectoryIdentity(archiveDirectory, currentDirectory)) {
      fail("unsafe_path", "archive object directory changed before cleanup");
    }
    await unlinkExact(tempPath, temporary.identity);
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  return {
    state: "published",
    objectPath,
    source,
    ciphertext: expected,
    ciphertextDevice: prepared.ciphertextDevice,
    ciphertextInode: prepared.ciphertextInode,
    ageVersion: AGE_VERSION,
  };
}

async function recoverPublishedAgeObjectInternal(
  prepared: PreparedAgeObject,
  finalPath: string,
  requestedLimits: ArchiveCommandLimits = DEFAULT_ARCHIVE_COMMAND_LIMITS,
): Promise<void> {
  const commandLimits = limits(requestedLimits);
  if (prepared.state !== "prepared" || prepared.ageVersion !== AGE_VERSION) {
    fail("invalid_input", "prepared ciphertext is invalid");
  }
  const ciphertext = expectedFile(
    prepared.ciphertext,
    commandLimits.maxCipherBytes,
  );
  expectedFile(prepared.source, commandLimits.maxSourceBytes);
  if (
    !Number.isSafeInteger(prepared.ciphertextDevice) ||
    prepared.ciphertextDevice < 0 ||
    !Number.isSafeInteger(prepared.ciphertextInode) ||
    prepared.ciphertextInode < 1 ||
    !Number.isSafeInteger(prepared.archiveDirectoryDevice) ||
    prepared.archiveDirectoryDevice < 0 ||
    !Number.isSafeInteger(prepared.archiveDirectoryInode) ||
    prepared.archiveDirectoryInode < 1
  ) {
    fail("invalid_input", "prepared ciphertext identity is invalid");
  }
  const tempPath = safeAbsolutePath(prepared.tempPath, "temporary object");
  const objectPath = safeAbsolutePath(finalPath, "final object");
  if (tempPath === objectPath || dirname(tempPath) !== dirname(objectPath)) {
    fail("invalid_input", "publication must stay in one directory");
  }
  if (!OBJECT_NAME.test(basename(objectPath))) {
    fail("invalid_input", "final object name is invalid");
  }
  const archiveDirectory = await safeDirectory(
    dirname(objectPath),
    "archive object directory",
  );
  if (
    archiveDirectory.dev !== prepared.archiveDirectoryDevice ||
    archiveDirectory.ino !== prepared.archiveDirectoryInode
  ) {
    fail("unsafe_path", "archive object directory does not match preparation");
  }
  const recovered = await readExactFile(
    objectPath,
    commandLimits.maxCipherBytes,
    true,
  );
  const archiveDirectoryAfter = await safeDirectory(
    dirname(objectPath),
    "archive object directory",
  );
  recovered.bytes.fill(0);
  if (
    !sameDirectoryIdentity(archiveDirectory, archiveDirectoryAfter) ||
    recovered.identity.device !== prepared.ciphertextDevice ||
    recovered.identity.inode !== prepared.ciphertextInode ||
    recovered.digest.sha256 !== ciphertext.sha256 ||
    recovered.digest.byteLength !== ciphertext.byteLength
  ) {
    fail("digest_mismatch", "published ciphertext recovery is inconsistent");
  }
}

async function assessLocalBackupBoundaryInternal(
  primaryArchiveRoot: string,
  repositoryPath: string,
  mode: "synthetic" | "independent_backup",
): Promise<LocalBackupBoundary> {
  if (mode !== "synthetic" && mode !== "independent_backup") {
    fail("invalid_input", "backup boundary mode is invalid");
  }
  const [primary, backup] = await Promise.all([
    safeDirectory(primaryArchiveRoot, "primary archive root"),
    safeDirectory(repositoryPath, "restic repository"),
  ]);
  if (mode === "independent_backup" && primary.dev === backup.dev) {
    fail("backup_not_independent", "backup repository is on the same device");
  }
  return {
    mode,
    readiness:
      primary.dev === backup.dev
        ? "synthetic_only"
        : "different_device_unverified",
    primaryDevice: primary.dev,
    backupDevice: backup.dev,
  };
}

async function readbackResticObjectInternal(
  input: ReadbackResticObjectInput,
): Promise<ResticReadbackResult> {
  const commandLimits = limits(input.limits ?? DEFAULT_ARCHIVE_COMMAND_LIMITS);
  await validateExecutable(input.resticBinary, "restic binary");
  await requireResticVersion(input.resticBinary, commandLimits);
  const repository = safeAbsolutePath(
    input.repositoryPath,
    "restic repository",
  );
  const repositoryIdentity = await requireResticRepository(
    {
      resticBinary: input.resticBinary,
      repositoryPath: repository,
      passwordCommand: input.passwordCommand,
      limits: commandLimits,
    },
    input.expectedRepositoryId,
  );
  if (!HEX_64.test(input.snapshotId) || !OBJECT_NAME.test(input.objectName)) {
    fail("invalid_input", "restic restore identity is invalid");
  }
  const expected = expectedFile(
    input.expectedCiphertext,
    commandLimits.maxCipherBytes,
  );
  const password = await passwordCommandArgument(input.passwordCommand);
  const restored = await runHashedOutput(
    input.resticBinary,
    [
      ...resticBaseArgs(repository, password),
      "dump",
      input.snapshotId,
      `/${input.objectName}`,
    ],
    commandLimits.maxCipherBytes,
    commandLimits,
  );
  if (
    restored.sha256 !== expected.sha256 ||
    restored.byteLength !== expected.byteLength
  ) {
    fail("readback_failed", "restic readback did not match ciphertext");
  }
  return {
    snapshotId: input.snapshotId,
    objectName: input.objectName,
    ciphertext: expected,
    resticVersion: RESTIC_VERSION,
    repositoryId: repositoryIdentity.repositoryId,
    verification: "destination_ciphertext_readback",
  };
}

async function backupResticObjectInternal(
  input: BackupResticObjectInput,
): Promise<ResticBackupResult> {
  const commandLimits = limits(input.limits ?? DEFAULT_ARCHIVE_COMMAND_LIMITS);
  await validateExecutable(input.resticBinary, "restic binary");
  await requireResticVersion(input.resticBinary, commandLimits);
  if (!OPAQUE_ID.test(input.operationId) || !OPAQUE_ID.test(input.host)) {
    fail("invalid_input", "backup operation identity is invalid");
  }
  const repository = safeAbsolutePath(
    input.repositoryPath,
    "restic repository",
  );
  const repositoryIdentity = await requireResticRepository(
    {
      resticBinary: input.resticBinary,
      repositoryPath: repository,
      passwordCommand: input.passwordCommand,
      limits: commandLimits,
    },
    input.expectedRepositoryId,
  );
  const boundary = await assessLocalBackupBoundaryInternal(
    input.primaryArchiveRoot,
    repository,
    input.backupMode,
  );
  const repositoryEntry = await safeDirectory(repository, "restic repository");
  if (repositoryEntry.dev !== boundary.backupDevice) {
    fail("unsafe_path", "backup repository device changed");
  }
  const cipherPath = safeAbsolutePath(input.ciphertextPath, "ciphertext path");
  const objectName = basename(cipherPath);
  if (!OBJECT_NAME.test(objectName)) {
    fail("invalid_input", "ciphertext object name is invalid");
  }
  const expected = expectedFile(
    input.expectedCiphertext,
    commandLimits.maxCipherBytes,
  );
  const before = await readExactFile(
    cipherPath,
    commandLimits.maxCipherBytes,
    true,
  );
  before.bytes.fill(0);
  if (
    before.digest.sha256 !== expected.sha256 ||
    before.digest.byteLength !== expected.byteLength
  ) {
    fail("digest_mismatch", "ciphertext does not match backup intent");
  }
  const password = await passwordCommandArgument(input.passwordCommand);
  let result: ProcessResult | undefined;
  try {
    result = await runBounded(
      input.resticBinary,
      [
        ...resticBaseArgs(repository, password),
        "backup",
        "--json",
        "--host",
        input.host,
        "--tag",
        input.operationId,
        objectName,
      ],
      commandLimits,
      dirname(cipherPath),
    );
    const snapshotId = parseResticSummary(result.stdout, expected);
    await recheckFile(cipherPath, before.identity);
    await readbackResticObjectInternal({
      resticBinary: input.resticBinary,
      repositoryPath: repository,
      expectedRepositoryId: repositoryIdentity.repositoryId,
      passwordCommand: input.passwordCommand,
      snapshotId,
      objectName,
      expectedCiphertext: expected,
      limits: commandLimits,
    });
    return {
      operationId: input.operationId,
      snapshotId,
      objectName,
      ciphertext: expected,
      resticVersion: RESTIC_VERSION,
      repositoryId: repositoryIdentity.repositoryId,
      verification: "destination_ciphertext_readback",
      boundary,
    };
  } finally {
    result?.stdout.fill(0);
    result?.stderr.fill(0);
  }
}

async function recoverResticBackupInternal(
  input: RecoverResticBackupInput,
): Promise<RecoveredResticBackup> {
  const commandLimits = limits(input.limits ?? DEFAULT_ARCHIVE_COMMAND_LIMITS);
  await validateExecutable(input.resticBinary, "restic binary");
  await requireResticVersion(input.resticBinary, commandLimits);
  if (
    !OPAQUE_ID.test(input.operationId) ||
    !OPAQUE_ID.test(input.host) ||
    !OBJECT_NAME.test(input.objectName)
  ) {
    fail("invalid_input", "backup recovery identity is invalid");
  }
  const expected = expectedFile(
    input.expectedCiphertext,
    commandLimits.maxCipherBytes,
  );
  const repository = safeAbsolutePath(
    input.repositoryPath,
    "restic repository",
  );
  const repositoryIdentity = await requireResticRepository(
    {
      resticBinary: input.resticBinary,
      repositoryPath: repository,
      passwordCommand: input.passwordCommand,
      limits: commandLimits,
    },
    input.expectedRepositoryId,
  );
  const password = await passwordCommandArgument(input.passwordCommand);
  const result = await runBounded(
    input.resticBinary,
    [
      ...resticBaseArgs(repository, password),
      "snapshots",
      "--json",
      "--host",
      input.host,
      "--tag",
      input.operationId,
    ],
    commandLimits,
  );
  let snapshotIds: string[];
  try {
    snapshotIds = parseResticSnapshots(
      result.stdout,
      input.operationId,
      input.host,
      input.objectName,
    );
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
  for (const snapshotId of snapshotIds) {
    await readbackResticObjectInternal({
      resticBinary: input.resticBinary,
      repositoryPath: repository,
      expectedRepositoryId: repositoryIdentity.repositoryId,
      passwordCommand: input.passwordCommand,
      snapshotId,
      objectName: input.objectName,
      expectedCiphertext: expected,
      limits: commandLimits,
    });
  }
  return {
    operationId: input.operationId,
    snapshotId: snapshotIds[0]!,
    matchingSnapshotCount: snapshotIds.length,
    objectName: input.objectName,
    ciphertext: expected,
    resticVersion: RESTIC_VERSION,
    repositoryId: repositoryIdentity.repositoryId,
    verification: "destination_ciphertext_readback",
  };
}

async function publicOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    rethrowSafe(
      error,
      "process_failed",
      "archive operation could not complete",
    );
  }
}

export async function probeArchiveTools(
  tools: ArchiveToolPaths,
  requestedLimits: ArchiveCommandLimits = DEFAULT_ARCHIVE_COMMAND_LIMITS,
): Promise<ArchiveToolVersions> {
  return publicOperation(() =>
    probeArchiveToolsInternal(tools, requestedLimits),
  );
}

export async function probeResticRepository(input: {
  resticBinary: string;
  repositoryPath: string;
  passwordCommand: PasswordCommand;
  limits?: ArchiveCommandLimits;
}): Promise<ResticRepositoryIdentity> {
  return publicOperation(() => probeResticRepositoryInternal(input));
}

export async function encryptAgeObject(
  input: EncryptAgeObjectInput,
): Promise<PreparedAgeObject> {
  return publicOperation(() => encryptAgeObjectInternal(input));
}

export async function publishAgeObject(
  prepared: PreparedAgeObject,
  finalPath: string,
  requestedLimits: ArchiveCommandLimits = DEFAULT_ARCHIVE_COMMAND_LIMITS,
): Promise<PublishedAgeObject> {
  return publicOperation(() =>
    publishAgeObjectInternal(prepared, finalPath, requestedLimits),
  );
}

/**
 * Re-open a cataloged age object after a crash. This never creates, replaces,
 * removes, or adopts an object: a durable catalog must already bind the stable
 * name, ciphertext digest, and publication inode/device.
 */
export async function recoverPublishedAgeObject(
  prepared: PreparedAgeObject,
  finalPath: string,
  requestedLimits: ArchiveCommandLimits = DEFAULT_ARCHIVE_COMMAND_LIMITS,
): Promise<void> {
  return publicOperation(() =>
    recoverPublishedAgeObjectInternal(prepared, finalPath, requestedLimits),
  );
}

export async function assessLocalBackupBoundary(
  primaryArchiveRoot: string,
  repositoryPath: string,
  mode: "synthetic" | "independent_backup",
): Promise<LocalBackupBoundary> {
  return publicOperation(() =>
    assessLocalBackupBoundaryInternal(primaryArchiveRoot, repositoryPath, mode),
  );
}

export async function readbackResticObject(
  input: ReadbackResticObjectInput,
): Promise<ResticReadbackResult> {
  return publicOperation(() => readbackResticObjectInternal(input));
}

export async function backupResticObject(
  input: BackupResticObjectInput,
): Promise<ResticBackupResult> {
  return publicOperation(() => backupResticObjectInternal(input));
}

export async function recoverResticBackup(
  input: RecoverResticBackupInput,
): Promise<RecoveredResticBackup> {
  return publicOperation(() => recoverResticBackupInternal(input));
}
