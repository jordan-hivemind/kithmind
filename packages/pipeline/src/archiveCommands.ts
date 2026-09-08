import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { access, lstat, link, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, posix, resolve } from "node:path";

import {
  AGE_VERSION,
  DEFAULT_ARCHIVE_COMMAND_LIMITS,
  RCLONE_VERSION,
  RESTIC_VERSION,
  type ArchiveCommandFailureCode,
  type ArchiveCommandLimits,
  type ArchiveToolPaths,
  type ArchiveToolVersions,
  type BackupResticObjectInput,
  type EncryptAgeObjectInput,
  type DecryptAgeRecoveryInput,
  type DecryptedAgeRecoveryObject,
  type ForgetResticBackupInput,
  type ForgetResticBackupResult,
  type InventoryResticSnapshotTreeInput,
  type InventoryResticSnapshotsInput,
  type LocalBackupBoundary,
  type RemoteBackupBoundary,
  type ResticRepositoryLocation,
  type RcloneDropboxRepository,
  type PasswordCommand,
  type PreparedAgeObject,
  type PublishedAgeObject,
  type ReadbackResticObjectInput,
  type RestoreResticObjectInput,
  type RestoredResticObject,
  type RestoreResticSnapshotPathInput,
  type RestoredResticSnapshotPath,
  type RecoveredResticBackup,
  type RecoverResticBackupInput,
  type ResticBackupResult,
  type ResticReadbackResult,
  type ResticRepositoryIdentity,
  type ResticSnapshotInventory,
  type ResticSnapshotInventoryRow,
  type ResticSnapshotTreeEntry,
  type ResticSnapshotTreeInventory,
  type RemovePublishedAgeObjectInput,
  type RemovePublishedAgeObjectResult,
  type Sha256File,
} from "./archiveTypes.js";
import { verifyDropboxDirectoryBinding } from "./dropboxCredentials.js";

const HEX_64 = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OBJECT_NAME = /^[A-Za-z0-9_-]{1,128}\.age$/;
const PQ_RECIPIENT = /^age1pq1[023456789acdefghjklmnpqrstuvwxyz]{40,4090}$/;
const MAX_PASSWORD_COMMAND_ARGS = 16;
const MAX_PASSWORD_COMMAND_ARG_BYTES = 256;
const MAX_INVENTORY_SNAPSHOTS = 2_048;
const MAX_INVENTORY_TREE_NODES = 2_048;
const MAX_INVENTORY_TAGS = 32;
const MAX_INVENTORY_PATHS = 32;
const MAX_INVENTORY_HOSTNAME_BYTES = 255;
const MAX_INVENTORY_NAME_BYTES = 255;
const MAX_INVENTORY_TAG_BYTES = 128;
const MAX_INVENTORY_PATH_BYTES = 4_096;
const MAX_INVENTORY_OUTPUT_BYTES = 2 * 1024 * 1024;
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

function expectedDirectoryIdentity(value: { device: number; inode: number }): {
  device: number;
  inode: number;
} {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Number.isSafeInteger(value.device) ||
    value.device < 0 ||
    !Number.isSafeInteger(value.inode) ||
    value.inode < 1
  ) {
    fail("invalid_input", "expected directory identity is invalid");
  }
  return { device: value.device, inode: value.inode };
}

function expectedRemovalFile(
  value: RemovePublishedAgeObjectInput["expectedFile"],
  maximum: number,
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 4 ||
    !Number.isSafeInteger(value.device) ||
    value.device < 0 ||
    !Number.isSafeInteger(value.inode) ||
    value.inode < 1
  ) {
    fail("invalid_input", "expected ciphertext identity is invalid");
  }
  return {
    device: value.device,
    inode: value.inode,
    ...expectedFile(value, maximum),
  };
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
  extraEnv?: Readonly<Record<string, string>>,
): ChildProcessWithoutNullStreams {
  return spawn(executable, args, {
    cwd,
    detached: true,
    env: { LANG: "C", LC_ALL: "C", ...extraEnv },
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
  extraEnv?: Readonly<Record<string, string>>,
): Promise<ProcessResult> {
  const running = child(executable, args, cwd, extraEnv);
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
  extraEnv?: Readonly<Record<string, string>>,
): Promise<Sha256File> {
  const running = child(executable, args, undefined, extraEnv);
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
): Promise<FileIdentity> {
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
  return createdIdentity;
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

type ResticSnapshotRow = {
  id: string;
  hostname: string;
  tags: string[];
  paths: string[];
};

function parseResticSnapshotRows(stdout: Buffer): ResticSnapshotRow[] {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(stdout));
  } catch {
    fail("invalid_tool_result", "restic snapshots output is not JSON");
  }
  if (!Array.isArray(value) || value.length > 32) {
    fail("invalid_tool_result", "restic snapshot count is invalid");
  }
  return value.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      fail("invalid_tool_result", "restic snapshot row is invalid");
    }
    const row = candidate as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !HEX_64.test(row.id) ||
      typeof row.hostname !== "string" ||
      row.hostname.length < 1 ||
      row.hostname.length > 128 ||
      !Array.isArray(row.tags) ||
      row.tags.length > 32 ||
      row.tags.some(
        (tag) => typeof tag !== "string" || tag.length < 1 || tag.length > 128,
      ) ||
      !Array.isArray(row.paths) ||
      row.paths.length !== 1 ||
      typeof row.paths[0] !== "string" ||
      row.paths[0].length < 1 ||
      row.paths[0].length > 4_096
    ) {
      fail("invalid_tool_result", "restic snapshot row is invalid");
    }
    return {
      id: row.id,
      hostname: row.hostname,
      tags: [...row.tags] as string[],
      paths: [...row.paths] as string[],
    };
  });
}

function boundedInventoryText(
  value: unknown,
  maximumBytes: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

function boundedInventoryPath(value: unknown): value is string {
  return (
    boundedInventoryText(value, MAX_INVENTORY_PATH_BYTES) &&
    value !== "/" &&
    !value.includes("\\") &&
    posix.isAbsolute(value) &&
    posix.normalize(value) === value &&
    !value
      .slice(1)
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  );
}

function parseResticSnapshotInventory(
  stdout: Buffer,
): ResticSnapshotInventoryRow[] {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(stdout));
  } catch {
    fail("invalid_tool_result", "restic snapshot inventory is not JSON");
  }
  if (!Array.isArray(value) || value.length > MAX_INVENTORY_SNAPSHOTS) {
    fail("invalid_tool_result", "restic snapshot inventory count is invalid");
  }
  const snapshotIds = new Set<string>();
  const snapshots = value.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      fail("invalid_tool_result", "restic snapshot inventory row is invalid");
    }
    const row = candidate as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !HEX_64.test(row.id) ||
      snapshotIds.has(row.id) ||
      !boundedInventoryText(row.hostname, MAX_INVENTORY_HOSTNAME_BYTES) ||
      !Array.isArray(row.tags) ||
      row.tags.length > MAX_INVENTORY_TAGS ||
      row.tags.some(
        (tag) => !boundedInventoryText(tag, MAX_INVENTORY_TAG_BYTES),
      ) ||
      new Set(row.tags).size !== row.tags.length ||
      !Array.isArray(row.paths) ||
      row.paths.length < 1 ||
      row.paths.length > MAX_INVENTORY_PATHS ||
      row.paths.some((path) => !boundedInventoryPath(path)) ||
      new Set(row.paths).size !== row.paths.length
    ) {
      fail("invalid_tool_result", "restic snapshot inventory row is invalid");
    }
    snapshotIds.add(row.id);
    return {
      snapshotId: row.id,
      hostname: row.hostname,
      tags: [...row.tags] as string[],
      paths: [...row.paths] as string[],
    };
  });
  return snapshots.sort((left, right) =>
    left.snapshotId.localeCompare(right.snapshotId),
  );
}

function parseResticSnapshotTree(
  stdout: Buffer,
  snapshotId: string,
  maxCipherBytes: number,
): { treeId: string; entries: ResticSnapshotTreeEntry[] } {
  if (stdout.length < 1 || stdout.at(-1) !== 0x0a) {
    fail("invalid_tool_result", "restic snapshot tree output is truncated");
  }
  const lines = decodeUtf8(stdout).split("\n");
  lines.pop();
  if (lines.length < 2 || lines.length > MAX_INVENTORY_TREE_NODES + 1) {
    fail("invalid_tool_result", "restic snapshot tree node count is invalid");
  }
  const records = lines.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      fail("invalid_tool_result", "restic snapshot tree record is not JSON");
    }
  });
  const header = records[0];
  const headerRow = header as Record<string, unknown> | undefined;
  if (
    !headerRow ||
    typeof headerRow !== "object" ||
    Array.isArray(header) ||
    headerRow.struct_type !== "snapshot" ||
    headerRow.message_type !== "snapshot" ||
    headerRow.id !== snapshotId ||
    typeof headerRow.tree !== "string" ||
    !HEX_64.test(headerRow.tree)
  ) {
    fail("invalid_tool_result", "restic snapshot tree header is invalid");
  }
  const treeId = headerRow.tree;
  const paths = new Set<string>();
  const entries = records.slice(1).map((record): ResticSnapshotTreeEntry => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      fail("invalid_tool_result", "restic snapshot tree node is invalid");
    }
    const node = record as Record<string, unknown>;
    if (
      node.struct_type !== "node" ||
      node.message_type !== "node" ||
      (node.type !== "dir" && node.type !== "file") ||
      !boundedInventoryText(node.name, MAX_INVENTORY_NAME_BYTES) ||
      !boundedInventoryPath(node.path) ||
      posix.basename(node.path) !== node.name ||
      paths.has(node.path)
    ) {
      fail("invalid_tool_result", "restic snapshot tree node is invalid");
    }
    paths.add(node.path);
    if (node.type === "dir") {
      return { type: "dir", name: node.name, path: node.path };
    }
    if (
      !Number.isSafeInteger(node.size) ||
      (node.size as number) < 1 ||
      (node.size as number) > maxCipherBytes
    ) {
      fail("invalid_tool_result", "restic snapshot tree file size is invalid");
    }
    return {
      type: "file",
      name: node.name,
      path: node.path,
      byteLength: node.size as number,
    };
  });
  const files = entries.filter(
    (entry): entry is Extract<ResticSnapshotTreeEntry, { type: "file" }> =>
      entry.type === "file",
  );
  if (
    files.length !== 1 ||
    entries.some(
      (entry) =>
        entry.type === "dir" && !files[0]!.path.startsWith(`${entry.path}/`),
    )
  ) {
    fail("invalid_tool_result", "restic snapshot tree contents are invalid");
  }
  return {
    treeId,
    entries,
  };
}

function requireExactResticSnapshot(
  rows: ResticSnapshotRow[],
  expected: {
    operationId: string;
    host: string;
    snapshotId: string;
    objectName: string;
  },
): ResticSnapshotRow | undefined {
  if (rows.length > 1) {
    fail("invalid_tool_result", "restic snapshot result is ambiguous");
  }
  const row = rows[0];
  if (!row) return undefined;
  if (
    row.id !== expected.snapshotId ||
    row.hostname !== expected.host ||
    !row.tags.includes(expected.operationId) ||
    basename(row.paths[0]!) !== expected.objectName
  ) {
    fail("invalid_tool_result", "restic snapshot identity changed");
  }
  return row;
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

function resticBaseArgs(repository: string, passwordCommand: string, options: readonly string[] = []): string[] {
  return [
    "--repo",
    repository,
    "--password-command",
    passwordCommand,
    "--no-cache",
    ...options,
  ];
}

type ResolvedRepository = {
  locator: string;
  options: string[];
  environment?: Readonly<Record<string, string>>;
  localPath?: string;
  remoteBoundary?: Omit<RemoteBackupBoundary, "repositoryId">;
};

async function readResticRepositoryIdentity(
  resticBinary: string,
  repository: ResolvedRepository,
  password: string,
  commandLimits: ArchiveCommandLimits,
): Promise<ResticRepositoryIdentity> {
  const result = await runBounded(
    resticBinary,
    [
      ...resticBaseArgs(repository.locator, password, repository.options),
      "cat",
      "config",
    ],
    commandLimits,
    undefined,
    repository.environment,
  );
  try {
    return parseResticRepository(result.stdout);
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
}

function location(input: ResticRepositoryLocation): ResticRepositoryLocation {
  const local = typeof input.repositoryPath === "string";
  const remote = input.repository !== undefined;
  if (local === remote) fail("invalid_input", "exactly one restic repository is required");
  return remote ? { repository: input.repository! } : { repositoryPath: input.repositoryPath! };
}

async function resolveRepository(input: ResticRepositoryLocation, commandLimits: ArchiveCommandLimits): Promise<ResolvedRepository> {
  const selected = location(input);
  if (selected.repositoryPath !== undefined) {
    const localPath = safeAbsolutePath(selected.repositoryPath, "restic repository");
    await safeDirectory(localPath, "restic repository");
    return { locator: localPath, options: [], localPath };
  }
  const remote: RcloneDropboxRepository = selected.repository!;
  if (remote.kind !== "rclone_dropbox_v1" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(remote.remoteName) || !/^[A-Za-z0-9 _.-]+(?:\/[A-Za-z0-9 _.-]+)+$/.test(remote.rootPath) || /[:\\]/.test(remote.rootPath) || remote.rootPath.split("/").some((part) => !part || part === "." || part === ".." || part.trim() !== part) || !HEX_64.test(remote.configIdentityFingerprint) || !HEX_64.test(remote.expectedRootDirectoryIdHash)) fail("invalid_input", "rclone Dropbox repository is invalid");
  if (/\s|[\x00-\x1f\x7f]/.test(remote.rcloneBinary)) fail("invalid_input", "rclone binary path is unsafe");
  try {
    await verifyDropboxDirectoryBinding({
      rcloneBinary: remote.rcloneBinary,
      configPath: remote.configPath,
      remoteName: remote.remoteName,
      configIdentityFingerprint: remote.configIdentityFingerprint,
      rootPath: remote.rootPath,
      expectedRootDirectoryIdHash: remote.expectedRootDirectoryIdHash,
    });
  } catch {
    fail("digest_mismatch", "Dropbox repository binding could not be verified");
  }
  const environment = { RCLONE_CONFIG: remote.configPath } as const;
  return {
    locator: `rclone:${remote.remoteName}:${remote.rootPath}`,
    options: ["-o", `rclone.program=${remote.rcloneBinary}`, "-o", "rclone.args=serve restic --stdio --cache-objects=false"],
    environment,
    remoteBoundary: { mode: "independent_backup", readiness: "remote_repository_verified", backend: "rclone_dropbox_v1", remoteName: remote.remoteName, rootPath: remote.rootPath, rootDirectoryIdHash: remote.expectedRootDirectoryIdHash, configIdentityFingerprint: remote.configIdentityFingerprint, resticVersion: RESTIC_VERSION, rcloneVersion: RCLONE_VERSION },
  };
}

async function probeResticRepositoryInternal(input: ResticRepositoryLocation & {
  resticBinary: string;
  passwordCommand: PasswordCommand;
  limits?: ArchiveCommandLimits;
}): Promise<ResticRepositoryIdentity> {
  const commandLimits = limits(input.limits ?? DEFAULT_ARCHIVE_COMMAND_LIMITS);
  await validateExecutable(input.resticBinary, "restic binary");
  await requireResticVersion(input.resticBinary, commandLimits);
  const repository = await resolveRepository(input, commandLimits);
  const password = await passwordCommandArgument(input.passwordCommand);
  return readResticRepositoryIdentity(
    input.resticBinary,
    repository,
    password,
    commandLimits,
  );
}

async function requireResticRepository(
  input: ResticRepositoryLocation & {
    resticBinary: string;
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

async function verifyInventoryRepository(
  input: InventoryResticSnapshotsInput,
  commandLimits: ArchiveCommandLimits,
): Promise<{
  repository: ResolvedRepository;
  password: string;
  boundary: RemoteBackupBoundary;
}> {
  if (!HEX_64.test(input.expectedRepositoryId)) {
    fail("invalid_input", "expected restic repository identity is invalid");
  }
  await validateExecutable(input.resticBinary, "restic binary");
  await requireResticVersion(input.resticBinary, commandLimits);
  const repository = await resolveRepository(
    { repository: input.repository },
    commandLimits,
  );
  if (!repository.remoteBoundary) {
    fail("invalid_input", "remote restic repository is required");
  }
  const password = await passwordCommandArgument(input.passwordCommand);
  const identity = await readResticRepositoryIdentity(
    input.resticBinary,
    repository,
    password,
    commandLimits,
  );
  if (identity.repositoryId !== input.expectedRepositoryId) {
    fail("digest_mismatch", "restic repository identity changed");
  }
  return {
    repository,
    password,
    boundary: {
      ...repository.remoteBoundary,
      repositoryId: identity.repositoryId,
    },
  };
}

function requireSameRemoteBoundary(
  before: RemoteBackupBoundary,
  after: RemoteBackupBoundary,
): void {
  if (
    before.mode !== after.mode ||
    before.readiness !== after.readiness ||
    before.backend !== after.backend ||
    before.remoteName !== after.remoteName ||
    before.rootPath !== after.rootPath ||
    before.rootDirectoryIdHash !== after.rootDirectoryIdHash ||
    before.configIdentityFingerprint !== after.configIdentityFingerprint ||
    before.repositoryId !== after.repositoryId ||
    before.resticVersion !== after.resticVersion ||
    before.rcloneVersion !== after.rcloneVersion
  ) {
    fail("digest_mismatch", "remote backup boundary changed during inventory");
  }
}

async function inventoryResticSnapshotsInternal(
  input: InventoryResticSnapshotsInput,
): Promise<ResticSnapshotInventory> {
  const commandLimits = limits(input.limits ?? DEFAULT_ARCHIVE_COMMAND_LIMITS);
  if (commandLimits.maxOutputBytes > MAX_INVENTORY_OUTPUT_BYTES) {
    fail("invalid_input", "restic snapshot inventory output limit is invalid");
  }
  const before = await verifyInventoryRepository(input, commandLimits);
  const result = await runBounded(
    input.resticBinary,
    [
      ...resticBaseArgs(
        before.repository.locator,
        before.password,
        before.repository.options,
      ),
      "snapshots",
      "--json",
    ],
    commandLimits,
    undefined,
    before.repository.environment,
  );
  let snapshots: ResticSnapshotInventoryRow[];
  try {
    snapshots = parseResticSnapshotInventory(result.stdout);
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
  const after = await verifyInventoryRepository(input, commandLimits);
  requireSameRemoteBoundary(before.boundary, after.boundary);
  return {
    repositoryId: input.expectedRepositoryId,
    resticVersion: RESTIC_VERSION,
    boundary: after.boundary,
    snapshots,
    verification: "unfiltered_snapshot_inventory",
  };
}

async function inventoryResticSnapshotTreeInternal(
  input: InventoryResticSnapshotTreeInput,
): Promise<ResticSnapshotTreeInventory> {
  const commandLimits = limits(input.limits ?? DEFAULT_ARCHIVE_COMMAND_LIMITS);
  if (commandLimits.maxOutputBytes > MAX_INVENTORY_OUTPUT_BYTES) {
    fail("invalid_input", "restic snapshot tree output limit is invalid");
  }
  if (!HEX_64.test(input.snapshotId)) {
    fail("invalid_input", "restic snapshot identity is invalid");
  }
  const before = await verifyInventoryRepository(input, commandLimits);
  const result = await runBounded(
    input.resticBinary,
    [
      ...resticBaseArgs(
        before.repository.locator,
        before.password,
        before.repository.options,
      ),
      "ls",
      "--json",
      input.snapshotId,
    ],
    commandLimits,
    undefined,
    before.repository.environment,
  );
  let tree: ReturnType<typeof parseResticSnapshotTree>;
  try {
    tree = parseResticSnapshotTree(
      result.stdout,
      input.snapshotId,
      commandLimits.maxCipherBytes,
    );
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
  const after = await verifyInventoryRepository(input, commandLimits);
  requireSameRemoteBoundary(before.boundary, after.boundary);
  return {
    repositoryId: input.expectedRepositoryId,
    resticVersion: RESTIC_VERSION,
    boundary: after.boundary,
    snapshotId: input.snapshotId,
    treeId: tree.treeId,
    entries: tree.entries,
    verification: "exact_snapshot_tree_inventory",
  };
}

async function decryptAgeRecoveryInternal(
  input: DecryptAgeRecoveryInput,
): Promise<DecryptedAgeRecoveryObject> {
  const commandLimits = limits(input.limits ?? DEFAULT_ARCHIVE_COMMAND_LIMITS);
  if (!HEX_64.test(input.expectedPlaintextSha256))
    fail("invalid_input", "expected plaintext hash is invalid");
  const expected = expectedFile(input.expectedCiphertext, commandLimits.maxCipherBytes);
  await validateExecutable(input.ageBinary, "age binary");
  await requireAgeVersion(input.ageBinary, commandLimits);
  const ciphertextPath = safeAbsolutePath(input.ciphertextPath, "ciphertext path");
  const outputPath = safeAbsolutePath(input.outputPath, "recovery output path");
  const identityPath = safeAbsolutePath(input.identityPath, "recovery identity path");
  if (outputPath === ciphertextPath || outputPath === identityPath)
    fail("invalid_input", "recovery paths must differ");
  const directory = await safeDirectory(dirname(outputPath), "recovery output directory");
  const key = await readExactFile(identityPath, 16 * 1024, true);
  let ciphertext: Awaited<ReturnType<typeof readExactFile>> | undefined;
  let ownedOutput: FileIdentity | undefined;
  try {
    const keyStats = await lstat(identityPath);
    if (keyStats.nlink !== 1 || (keyStats.mode & 0o777) !== FILE_MODE)
      fail("unsafe_path", "recovery identity permissions or links are invalid");
    const lines = decodeUtf8(key.bytes).split(/\r?\n/).filter(line => line && !line.startsWith("#"));
    if (lines.length < 1 || lines.length > 8 || lines.some(line => !/^AGE-SECRET-KEY-(?:PQ-)?1[0-9A-Z]+$/.test(line)))
      fail("invalid_input", "only native unencrypted recovery identities are supported");
    ciphertext = await readExactFile(ciphertextPath, commandLimits.maxCipherBytes, true);
    if (ciphertext.digest.sha256 !== expected.sha256 || ciphertext.digest.byteLength !== expected.byteLength)
      fail("digest_mismatch", "recovery ciphertext identity changed");
    // Feed the key through stdin. No key value or identity path enters argv/env.
    ownedOutput = await streamAgeOutput(input.ageBinary,
      ["--decrypt", "--identity", "-", ciphertextPath], key.bytes, outputPath,
      { ...commandLimits, maxCipherBytes: commandLimits.maxSourceBytes });
    await recheckFile(ciphertextPath, ciphertext.identity);
    const plain = await readExactFile(outputPath, commandLimits.maxSourceBytes, true);
    plain.bytes.fill(0);
    const after = await safeDirectory(dirname(outputPath), "recovery output directory");
    const stats = await lstat(outputPath);
    if (!sameDirectoryIdentity(directory, after) || stats.nlink !== 1 || (stats.mode & 0o777) !== FILE_MODE || plain.identity.device !== ownedOutput.device || plain.identity.inode !== ownedOutput.inode)
      fail("unsafe_path", "recovery output identity changed");
    if (plain.digest.sha256 !== input.expectedPlaintextSha256)
      fail("digest_mismatch", "recovered plaintext does not match");
    await dirSync(dirname(outputPath));
    return { outputPath, plaintext: plain.digest, plaintextDevice: plain.identity.device,
      plaintextInode: plain.identity.inode, ageVersion: AGE_VERSION,
      verification: "decrypted_plaintext_hash" };
  } catch (error) {
    if (ownedOutput) await unlinkExact(outputPath, ownedOutput);
    throw error;
  } finally {
    key.bytes.fill(0);
    ciphertext?.bytes.fill(0);
  }
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
  const repository = await resolveRepository(input, commandLimits);
  const repositoryIdentity = await requireResticRepository(
    {
      resticBinary: input.resticBinary,
      ...location(input),
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
      ...resticBaseArgs(repository.locator, password, repository.options),
      "dump",
      input.snapshotId,
      `/${input.objectName}`,
    ],
    commandLimits.maxCipherBytes,
    commandLimits,
    repository.environment,
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

async function dirSync(path: string): Promise<void> {
  const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

async function restoreResticSnapshotPathInternal(
  input: RestoreResticSnapshotPathInput,
): Promise<RestoredResticSnapshotPath> {
  requiredOpenConstants();
  const commandLimits = limits(input.limits ?? DEFAULT_ARCHIVE_COMMAND_LIMITS);
  await validateExecutable(input.resticBinary, "restic binary");
  await requireResticVersion(input.resticBinary, commandLimits);
  if (!HEX_64.test(input.snapshotId) ||
    typeof input.objectPath !== "string" ||
    Buffer.byteLength(input.objectPath, "utf8") > 4096 ||
    !input.objectPath.startsWith("/") ||
    /[\x00-\x1f\x7f\\]/.test(input.objectPath) ||
    input.objectPath.slice(1).split("/").some(part => !part || part === "." || part === ".."))
    fail("invalid_input", "restic restore identity is invalid");
  const expected = expectedFile(
    input.expectedCiphertext,
    commandLimits.maxCipherBytes,
  );
  const destinationPath = safeAbsolutePath(
    input.destinationPath,
    "restore destination",
  );
  const destinationDirectory = await safeDirectory(
    dirname(destinationPath),
    "restore destination directory",
  );
  const existing = await lstat(destinationPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail("unsafe_path", "restore destination could not be inspected");
  });
  if (existing !== undefined)
    fail("destination_exists", "restore destination already exists");
  const repository = await resolveRepository(input, commandLimits);
  const repositoryIdentity = await requireResticRepository(
    {
      resticBinary: input.resticBinary,
      ...location(input),
      passwordCommand: input.passwordCommand,
      limits: commandLimits,
    },
    input.expectedRepositoryId,
  );
  const password = await passwordCommandArgument(input.passwordCommand);
  const tempPath = `${destinationPath}.restore-${crypto.randomUUID()}.tmp`;
  const handle = await open(
    tempPath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    FILE_MODE,
  ).catch(() => fail("unsafe_path", "restore temporary could not be created"));
  let tempIdentity: FileIdentity | undefined;
  let published = false;
  let running: ChildProcessWithoutNullStreams | undefined;
  try {
    await handle.chmod(FILE_MODE);
    tempIdentity = identity(await handle.stat());
    running = child(
      input.resticBinary,
      [
        ...resticBaseArgs(repository.locator, password, repository.options),
        "dump",
        input.snapshotId,
        input.objectPath,
      ],
      undefined,
      repository.environment,
    );
    running.stdin.end();
    const digest = createHash("sha256");
    let byteLength = 0;
    let fileOffset = 0;
    const output = (async () => {
      for await (const value of running.stdout) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        byteLength += chunk.length;
        if (byteLength > commandLimits.maxCipherBytes) {
          killProcessTree(running);
          fail("output_limit_exceeded", "restore exceeded limit");
        }
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const result = await handle.write(
            chunk,
            offset,
            chunk.length - offset,
            fileOffset + offset,
          );
          if (!result.bytesWritten)
            fail("process_failed", "restore write made no progress");
          offset += result.bytesWritten;
        }
        fileOffset += chunk.length;
        chunk.fill(0);
      }
    })();
    const stderr = collect(
      running.stderr,
      commandLimits.maxOutputBytes,
      running,
    );
    await withinProcessDeadline(
      running,
      Promise.all([output, stderr, processCompletion(running)]),
      commandLimits.deadlineMs,
    );
    if (
      byteLength < 1 ||
      digest.digest("hex") !== expected.sha256 ||
      byteLength !== expected.byteLength
    )
      fail("readback_failed", "restic restore did not match ciphertext");
    await handle.sync();
    const restored = await readExactFile(
      tempPath,
      commandLimits.maxCipherBytes,
      true,
    );
    restored.bytes.fill(0);
    if (
      !tempIdentity ||
      restored.identity.device !== tempIdentity.device ||
      restored.identity.inode !== tempIdentity.inode ||
      restored.digest.sha256 !== expected.sha256 ||
      restored.digest.byteLength !== expected.byteLength
    )
      fail("readback_failed", "restore temporary changed");
    const temporaryStats = await handle.stat();
    if (temporaryStats.nlink !== 1 || (temporaryStats.mode & 0o777) !== FILE_MODE)
      fail("unsafe_path", "restore temporary permissions or links changed");
    await handle.close();
    const currentDirectory = await safeDirectory(
      dirname(destinationPath),
      "restore destination directory",
    );
    if (!sameDirectoryIdentity(destinationDirectory, currentDirectory))
      fail("unsafe_path", "restore destination directory changed");
    await recheckFile(tempPath, restored.identity);
    await link(tempPath, destinationPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        fail("destination_exists", "restore destination already exists");
      fail("unsafe_path", "restore destination could not be published");
    });
    published = true;
    const publishedFile = await readExactFile(
      destinationPath,
      commandLimits.maxCipherBytes,
      true,
    );
    publishedFile.bytes.fill(0);
    if (
      !tempIdentity ||
      publishedFile.identity.device !== tempIdentity.device ||
      publishedFile.identity.inode !== tempIdentity.inode ||
      publishedFile.digest.sha256 !== expected.sha256 ||
      publishedFile.digest.byteLength !== expected.byteLength
    )
      fail("readback_failed", "restore publication changed");
    const dir = await open(
      dirname(destinationPath),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    const publishedStats = await lstat(destinationPath);
    if (publishedStats.nlink !== 2 || (publishedStats.mode & 0o777) !== FILE_MODE)
      fail("unsafe_path", "restore publication permissions or links changed");
    await unlinkExact(tempPath, tempIdentity!);
    await dirSync(dirname(destinationPath));
    const finalStats = await lstat(destinationPath);
    if (finalStats.dev !== tempIdentity.device || finalStats.ino !== tempIdentity.inode || finalStats.nlink !== 1 || (finalStats.mode & 0o777) !== FILE_MODE)
      fail("unsafe_path", "restore final identity changed");
    return {
      destinationPath,
      snapshotId: input.snapshotId,
      objectPath: input.objectPath,
      ciphertext: expected,
      resticVersion: RESTIC_VERSION,
      repositoryId: repositoryIdentity.repositoryId,
      verification: "exact_ciphertext_restore",
    };
  } catch (error) {
    if (running) {
      killProcessTree(running);
      running.stdin.destroy();
      running.stdout.destroy();
      running.stderr.destroy();
    }
    await handle.close().catch(() => undefined);
    if (!published && tempIdentity)
      await unlinkExact(tempPath, tempIdentity).catch(() => undefined);
    throw error;
  }
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
  const repository = await resolveRepository(input, commandLimits);
  if (
    repository.remoteBoundary !== undefined &&
    input.backupMode !== "independent_backup"
  ) {
    fail("invalid_input", "remote repository requires independent backup mode");
  }
  const repositoryIdentity = await requireResticRepository(
    {
      resticBinary: input.resticBinary,
      ...location(input),
      passwordCommand: input.passwordCommand,
      limits: commandLimits,
    },
    input.expectedRepositoryId,
  );
  const boundary = repository.remoteBoundary
    ? { ...repository.remoteBoundary, repositoryId: repositoryIdentity.repositoryId }
    : await assessLocalBackupBoundaryInternal(input.primaryArchiveRoot, repository.localPath!, input.backupMode);
  if (repository.localPath !== undefined) {
    const repositoryEntry = await safeDirectory(repository.localPath, "restic repository");
    if ("backupDevice" in boundary && repositoryEntry.dev !== boundary.backupDevice) fail("unsafe_path", "backup repository device changed");
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
        ...resticBaseArgs(repository.locator, password, repository.options),
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
      repository.environment,
    );
    const snapshotId = parseResticSummary(result.stdout, expected);
    await recheckFile(cipherPath, before.identity);
    await readbackResticObjectInternal({
      resticBinary: input.resticBinary,
      ...location(input),
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
  const repository = await resolveRepository(input, commandLimits);
  const repositoryIdentity = await requireResticRepository(
    {
      resticBinary: input.resticBinary,
      ...location(input),
      passwordCommand: input.passwordCommand,
      limits: commandLimits,
    },
    input.expectedRepositoryId,
  );
  const password = await passwordCommandArgument(input.passwordCommand);
  const result = await runBounded(
    input.resticBinary,
    [
      ...resticBaseArgs(repository.locator, password, repository.options),
      "snapshots",
      "--json",
      "--host",
      input.host,
      "--tag",
      input.operationId,
    ],
    commandLimits,
    undefined,
    repository.environment,
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
      ...location(input),
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
    ...(repository.remoteBoundary === undefined
      ? {}
      : { boundary: { ...repository.remoteBoundary, repositoryId: repositoryIdentity.repositoryId } }),
  };
}

async function removePublishedAgeObjectExactInternal(
  input: RemovePublishedAgeObjectInput,
): Promise<RemovePublishedAgeObjectResult> {
  const commandLimits = limits(input.limits ?? DEFAULT_ARCHIVE_COMMAND_LIMITS);
  const objectPath = safeAbsolutePath(input.objectPath, "archive object");
  if (!OBJECT_NAME.test(basename(objectPath))) {
    fail("invalid_input", "archive object name is invalid");
  }
  const expectedDirectory = expectedDirectoryIdentity(input.expectedDirectory);
  const expected = expectedRemovalFile(
    input.expectedFile,
    commandLimits.maxCipherBytes,
  );
  const parentPath = dirname(objectPath);
  const parent = await safeDirectory(parentPath, "archive object directory");
  if (
    parent.dev !== expectedDirectory.device ||
    parent.ino !== expectedDirectory.inode
  ) {
    fail("unsafe_path", "archive object directory identity changed");
  }

  const before = await lstat(objectPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    rethrowSafe(error, "unsafe_path", "archive object cannot be inspected");
  });
  if (before === undefined) {
    const parentAfter = await safeDirectory(
      parentPath,
      "archive object directory",
    );
    if (!sameDirectoryIdentity(parent, parentAfter)) {
      fail("unsafe_path", "archive object directory changed during removal");
    }
    const after = await lstat(objectPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      rethrowSafe(error, "unsafe_path", "archive object cannot be inspected");
    });
    if (after !== undefined) {
      fail("source_changed", "archive object appeared during removal");
    }
    return {
      outcome: "already_missing",
      verification: "exact_path_absence",
    };
  }

  const inspected = await readExactFile(
    objectPath,
    commandLimits.maxCipherBytes,
    true,
  );
  try {
    if (
      inspected.identity.device !== expected.device ||
      inspected.identity.inode !== expected.inode ||
      inspected.digest.sha256 !== expected.sha256 ||
      inspected.digest.byteLength !== expected.byteLength
    ) {
      fail("digest_mismatch", "archive object identity does not match intent");
    }
  } finally {
    inspected.bytes.fill(0);
  }

  const parentAfterRead = await safeDirectory(
    parentPath,
    "archive object directory",
  );
  if (!sameDirectoryIdentity(parent, parentAfterRead)) {
    fail("unsafe_path", "archive object directory changed during removal");
  }
  requiredOpenConstants();
  const directoryHandle = await open(
    parentPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    rethrowSafe(error, "unsafe_path", "archive object directory cannot open");
  });
  try {
    if (!sameDirectoryIdentity(parent, await directoryHandle.stat())) {
      fail("unsafe_path", "archive object directory changed before removal");
    }
    const current = await lstat(objectPath).catch((error: unknown) => {
      rethrowSafe(
        error,
        "source_changed",
        "archive object changed before removal",
      );
    });
    if (!sameIdentity(inspected.identity, identity(current))) {
      fail("source_changed", "archive object changed before removal");
    }
    await unlink(objectPath).catch((error: unknown) => {
      rethrowSafe(
        error,
        "process_failed",
        "archive object could not be removed",
      );
    });
    await directoryHandle.sync().catch((error: unknown) => {
      rethrowSafe(
        error,
        "process_failed",
        "archive removal could not be synced",
      );
    });
    const parentAfter = await safeDirectory(
      parentPath,
      "archive object directory",
    );
    if (!sameDirectoryIdentity(parent, parentAfter)) {
      fail("unsafe_path", "archive object directory changed after removal");
    }
    const remaining = await lstat(objectPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      rethrowSafe(error, "unsafe_path", "archive removal cannot be verified");
    });
    if (remaining !== undefined) {
      fail("source_changed", "archive object path is not absent");
    }
  } finally {
    await directoryHandle.close().catch(() => undefined);
  }
  return { outcome: "deleted", verification: "exact_path_absence" };
}

async function listResticSnapshotsForDeletion(
  resticBinary: string,
  baseArgs: string[],
  args: string[],
  commandLimits: ArchiveCommandLimits,
  environment?: Readonly<Record<string, string>>,
): Promise<ResticSnapshotRow[]> {
  const result = await runBounded(
    resticBinary,
    [...baseArgs, "snapshots", "--json", ...args],
    commandLimits,
    undefined,
    environment,
  );
  try {
    return parseResticSnapshotRows(result.stdout);
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
}

async function requireResticDeletionState(
  input: {
    resticBinary: string;
    baseArgs: string[];
    operationId: string;
    host: string;
    snapshotId: string;
    objectName: string;
    environment?: Readonly<Record<string, string>>;
  },
  commandLimits: ArchiveCommandLimits,
): Promise<"present" | "absent"> {
  const operationRows = await listResticSnapshotsForDeletion(
    input.resticBinary,
    input.baseArgs,
    ["--host", input.host, "--tag", input.operationId],
    commandLimits,
    input.environment,
  );
  const snapshotRows = await listResticSnapshotsForDeletion(
    input.resticBinary,
    input.baseArgs,
    [input.snapshotId],
    commandLimits,
    input.environment,
  );
  const expected = {
    operationId: input.operationId,
    host: input.host,
    snapshotId: input.snapshotId,
    objectName: input.objectName,
  };
  const byOperation = requireExactResticSnapshot(operationRows, expected);
  const bySnapshot = requireExactResticSnapshot(snapshotRows, expected);
  if ((byOperation === undefined) !== (bySnapshot === undefined)) {
    fail("invalid_tool_result", "restic snapshot lookup is inconsistent");
  }
  return byOperation === undefined ? "absent" : "present";
}

async function forgetResticBackupExactInternal(
  input: ForgetResticBackupInput,
): Promise<ForgetResticBackupResult> {
  const commandLimits = limits(input.limits ?? DEFAULT_ARCHIVE_COMMAND_LIMITS);
  await validateExecutable(input.resticBinary, "restic binary");
  await requireResticVersion(input.resticBinary, commandLimits);
  if (
    !OPAQUE_ID.test(input.operationId) ||
    !OPAQUE_ID.test(input.host) ||
    !HEX_64.test(input.snapshotId) ||
    !OBJECT_NAME.test(input.objectName)
  ) {
    fail("invalid_input", "restic deletion identity is invalid");
  }
  const expected = expectedFile(
    input.expectedCiphertext,
    commandLimits.maxCipherBytes,
  );
  const repository = await resolveRepository(input, commandLimits);
  const repositoryIdentity = await requireResticRepository(
    {
      resticBinary: input.resticBinary,
      ...location(input),
      passwordCommand: input.passwordCommand,
      limits: commandLimits,
    },
    input.expectedRepositoryId,
  );
  const password = await passwordCommandArgument(input.passwordCommand);
  const baseArgs = resticBaseArgs(repository.locator, password, repository.options);
  const identity = {
    resticBinary: input.resticBinary,
    baseArgs,
    operationId: input.operationId,
    host: input.host,
    snapshotId: input.snapshotId,
    objectName: input.objectName,
    environment: repository.environment,
  };
  const before = await requireResticDeletionState(identity, commandLimits);
  if (before === "present") {
    await readbackResticObjectInternal({
      resticBinary: input.resticBinary,
      ...location(input),
      expectedRepositoryId: repositoryIdentity.repositoryId,
      passwordCommand: input.passwordCommand,
      snapshotId: input.snapshotId,
      objectName: input.objectName,
      expectedCiphertext: expected,
      limits: commandLimits,
    });
  }
  const result = await runBounded(
    input.resticBinary,
    before === "present"
      ? [...baseArgs, "forget", input.snapshotId, "--prune"]
      : [...baseArgs, "prune"],
    commandLimits,
    undefined,
    repository.environment,
  );
  result.stdout.fill(0);
  result.stderr.fill(0);
  if (
    (await requireResticDeletionState(identity, commandLimits)) !== "absent"
  ) {
    fail("process_failed", "restic snapshot remains after deletion");
  }
  return {
    outcome: before === "present" ? "deleted" : "already_missing",
    snapshotId: input.snapshotId,
    repositoryId: repositoryIdentity.repositoryId,
    verification: "snapshot_absence_after_forget_prune",
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

export async function probeResticRepository(input: ResticRepositoryLocation & {
  resticBinary: string;
  passwordCommand: PasswordCommand;
  limits?: ArchiveCommandLimits;
}): Promise<ResticRepositoryIdentity> {
  return publicOperation(() => probeResticRepositoryInternal(input));
}

/** Read-only inventory of every snapshot in one verified remote repository. */
export async function inventoryResticSnapshots(
  input: InventoryResticSnapshotsInput,
): Promise<ResticSnapshotInventory> {
  return publicOperation(() => inventoryResticSnapshotsInternal(input));
}

/** Read-only inventory of one exact snapshot's files and ancestor directories. */
export async function inventoryResticSnapshotTree(
  input: InventoryResticSnapshotTreeInput,
): Promise<ResticSnapshotTreeInventory> {
  return publicOperation(() => inventoryResticSnapshotTreeInternal(input));
}

/** Explicit owner recovery only; the ingestion worker never receives this key. */
export async function decryptAgeRecoveryObject(
  input: DecryptAgeRecoveryInput,
): Promise<DecryptedAgeRecoveryObject> {
  return publicOperation(() => decryptAgeRecoveryInternal(input));
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

export async function restoreResticObject(
  input: RestoreResticObjectInput,
): Promise<RestoredResticObject> {
  return publicOperation(async () => {
    if (!OBJECT_NAME.test(input.objectName))
      fail("invalid_input", "restic restore object name is invalid");
    const { objectName, ...shared } = input;
    const { objectPath: _path, ...restored } = await restoreResticSnapshotPathInternal({
      ...shared, objectPath: `/${objectName}`,
    });
    return { ...restored, objectName };
  });
}

/** Restore an exact legacy receipt path inside a snapshot to a separate local destination. */
export async function restoreResticSnapshotPath(
  input: RestoreResticSnapshotPathInput,
): Promise<RestoredResticSnapshotPath> {
  return publicOperation(() => restoreResticSnapshotPathInternal(input));
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

/**
 * Removes one exact cataloged age object. Identity checks detect replacement;
 * they do not promise an atomic conditional unlink against a hostile same-UID
 * process within the supported local filesystem trust boundary.
 */
export async function removePublishedAgeObjectExact(
  input: RemovePublishedAgeObjectInput,
): Promise<RemovePublishedAgeObjectResult> {
  return publicOperation(() => removePublishedAgeObjectExactInternal(input));
}

/** Owner-operated retention action for one exact restic snapshot. */
export async function forgetResticBackupExact(
  input: ForgetResticBackupInput,
): Promise<ForgetResticBackupResult> {
  return publicOperation(() => forgetResticBackupExactInternal(input));
}
