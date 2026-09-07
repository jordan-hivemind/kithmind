import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import type { SafeRoot } from "./filesystem.js";

export const MAX_CAPTURED_PDF_BYTES = 16 * 1024 * 1024;
const DEFAULT_DEADLINE_MS = 30_000;
const CAPTURE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BUFFER_BYTES = 64 * 1024;

export type CaptureFailureCode =
  | "invalid_input"
  | "unsupported_platform"
  | "unsafe_path"
  | "source_changed"
  | "digest_mismatch"
  | "destination_exists"
  | "timeout"
  | "io_failed";

export class CaptureStoreError extends Error {
  constructor(
    readonly code: CaptureFailureCode,
    message: string,
  ) {
    super(`PDF capture failed: ${message}`);
    this.name = "CaptureStoreError";
  }
}

export type ExpectedPdfSource = {
  sha256: string;
  byteLength: number;
  sourceModifiedAt: number;
};

export type CapturedPdf = {
  version: 1;
  captureId: string;
  captureDirectory: {
    path: string;
    device: number;
    inode: number;
  };
  path: string;
  sha256: string;
  byteLength: number;
  sourceModifiedAt: number;
  device: number;
  inode: number;
};

export type CapturePdfInput = {
  root: SafeRoot;
  relativePath: string;
  captureDirectory: string;
  captureId: string;
  expected: ExpectedPdfSource;
  deadlineMs?: number;
};

function fail(code: CaptureFailureCode, message: string): never {
  throw new CaptureStoreError(code, message);
}

function rethrowSafe(
  error: unknown,
  code: CaptureFailureCode,
  message: string,
): never {
  if (error instanceof CaptureStoreError) throw error;
  fail(code, message);
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
    fail("unsupported_platform", "safe file-open flags are unavailable");
  }
}

function safeInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function expectedSource(value: ExpectedPdfSource): ExpectedPdfSource {
  if (
    !value ||
    typeof value !== "object" ||
    !SHA256.test(value.sha256) ||
    !safeInteger(value.byteLength, 1, MAX_CAPTURED_PDF_BYTES) ||
    !safeInteger(value.sourceModifiedAt, 0, Number.MAX_SAFE_INTEGER)
  ) {
    fail("invalid_input", "expected source identity is invalid");
  }
  return { ...value };
}

function captureIdentifier(value: string): string {
  if (typeof value !== "string" || !CAPTURE_ID.test(value)) {
    fail("invalid_input", "capture ID is invalid");
  }
  return value;
}

function absolutePath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 4_096
  ) {
    fail("invalid_input", `${label} is invalid`);
  }
  return value;
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function pathParts(value: string): string[] {
  if (typeof value !== "string" || isAbsolute(value)) {
    fail("invalid_input", "relative source path is invalid");
  }
  const parts = value.split(sep);
  if (
    parts.length === 0 ||
    Buffer.byteLength(value, "utf8") > 2_048 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("/") ||
        part.includes("\\") ||
        part.includes("\0"),
    )
  ) {
    fail("invalid_input", "relative source path is invalid");
  }
  return parts;
}

function safeDirectoryEntry(entry: Stats, label: string): void {
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    entry.uid !== currentUid() ||
    (entry.mode & 0o077) !== 0
  ) {
    fail("unsafe_path", `${label} is not a protected directory`);
  }
}

type DirectoryIdentity = {
  path: string;
  device: number;
  inode: number;
};

async function protectedDirectory(
  path: string,
  label: string,
): Promise<DirectoryIdentity> {
  const requested = absolutePath(path, label);
  const before = await lstat(requested).catch(() =>
    fail("unsafe_path", `${label} is unavailable`),
  );
  safeDirectoryEntry(before, label);
  const canonical = await realpath(requested).catch(() =>
    fail("unsafe_path", `${label} cannot be resolved`),
  );
  if (canonical !== requested)
    fail("unsafe_path", `${label} must be canonical`);
  await trustedDirectoryAncestors(canonical, label);
  const after = await lstat(canonical).catch(() =>
    fail("unsafe_path", `${label} changed during validation`),
  );
  safeDirectoryEntry(after, label);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    fail("unsafe_path", `${label} changed during validation`);
  }
  return { path: canonical, device: after.dev, inode: after.ino };
}

async function trustedDirectoryAncestors(
  path: string,
  label: string,
): Promise<void> {
  const uid = currentUid();
  let current = path;
  for (let depth = 0; ; depth += 1) {
    if (depth >= 256) fail("unsafe_path", `${label} ancestry is too deep`);
    const entry = await lstat(current).catch(() =>
      fail("unsafe_path", `${label} ancestor is unavailable`),
    );
    const rootOwnedSticky = entry.uid === 0 && (entry.mode & 0o1000) !== 0;
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      (entry.uid !== uid && entry.uid !== 0) ||
      ((entry.mode & 0o022) !== 0 && !rootOwnedSticky)
    ) {
      fail("unsafe_path", `${label} ancestor is not trusted`);
    }
    const next = dirname(current);
    if (next === current) return;
    current = next;
  }
}

async function recheckDirectory(
  expected: DirectoryIdentity,
  label: string,
): Promise<void> {
  const entry = await lstat(expected.path).catch(() =>
    fail("unsafe_path", `${label} changed during capture`),
  );
  safeDirectoryEntry(entry, label);
  if (entry.dev !== expected.device || entry.ino !== expected.inode) {
    fail("unsafe_path", `${label} changed during capture`);
  }
  const canonical = await realpath(expected.path).catch(() =>
    fail("unsafe_path", `${label} cannot be resolved`),
  );
  if (canonical !== expected.path) {
    fail("unsafe_path", `${label} changed during capture`);
  }
  await trustedDirectoryAncestors(expected.path, label);
}

async function syncDirectory(directory: DirectoryIdentity): Promise<void> {
  await recheckDirectory(directory, "capture directory");
  const handle = await open(
    directory.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) =>
    rethrowSafe(error, "io_failed", "capture directory cannot be opened"),
  );
  try {
    const current = await handle.stat();
    if (
      !current.isDirectory() ||
      current.dev !== directory.device ||
      current.ino !== directory.inode
    ) {
      fail("unsafe_path", "capture directory changed before sync");
    }
    await handle
      .sync()
      .catch((error: unknown) =>
        rethrowSafe(error, "io_failed", "capture directory cannot be synced"),
      );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function deadline(input: number | undefined): number {
  const duration = input ?? DEFAULT_DEADLINE_MS;
  if (!safeInteger(duration, 1, 5 * 60_000)) {
    fail("invalid_input", "capture deadline is invalid");
  }
  return Date.now() + duration;
}

async function beforeDeadline<T>(
  operation: Promise<T>,
  end: number,
  message: string,
): Promise<T> {
  const remaining = end - Date.now();
  if (remaining <= 0) fail("timeout", message);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new CaptureStoreError("timeout", message)),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function rootShape(root: SafeRoot): void {
  if (
    !root ||
    typeof root !== "object" ||
    typeof root.alias !== "string" ||
    !root.alias ||
    !isAbsolute(root.canonicalPath) ||
    !safeInteger(root.device, 0, Number.MAX_SAFE_INTEGER) ||
    !safeInteger(root.inode, 0, Number.MAX_SAFE_INTEGER)
  ) {
    fail("invalid_input", "safe root identity is invalid");
  }
}

async function verifySourceAncestors(
  root: SafeRoot,
  relativePath: string,
  end: number,
): Promise<string> {
  rootShape(root);
  await beforeDeadline(
    trustedDirectoryAncestors(root.canonicalPath, "source root"),
    end,
    "source root ancestry check timed out",
  );
  const parts = pathParts(relativePath);
  const rootEntry = await beforeDeadline(
    lstat(root.canonicalPath),
    end,
    "source root check timed out",
  ).catch((error: unknown) =>
    rethrowSafe(error, "unsafe_path", "source root is unavailable"),
  );
  if (
    rootEntry.isSymbolicLink() ||
    !rootEntry.isDirectory() ||
    rootEntry.uid !== currentUid() ||
    (rootEntry.mode & 0o022) !== 0 ||
    rootEntry.dev !== root.device ||
    rootEntry.ino !== root.inode
  ) {
    fail("unsafe_path", "source root changed or is not protected");
  }
  let current = root.canonicalPath;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const entry = await beforeDeadline(
      lstat(current),
      end,
      "source ancestor check timed out",
    ).catch((error: unknown) =>
      rethrowSafe(error, "unsafe_path", "source ancestor is unavailable"),
    );
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      entry.uid !== currentUid() ||
      (entry.mode & 0o022) !== 0
    ) {
      fail("unsafe_path", "source ancestor is not protected");
    }
    const canonical = await beforeDeadline(
      realpath(current),
      end,
      "source ancestor resolution timed out",
    ).catch((error: unknown) =>
      rethrowSafe(error, "unsafe_path", "source ancestor cannot be resolved"),
    );
    if (canonical !== current || !contains(root.canonicalPath, canonical)) {
      fail("unsafe_path", "source ancestor escaped its root");
    }
  }
  return parts.length === 1 ? root.canonicalPath : current;
}

type FileIdentity = {
  device: number;
  inode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

function fileIdentity(entry: Stats): FileIdentity {
  return {
    device: entry.dev,
    inode: entry.ino,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs,
  };
}

function sameFile(left: FileIdentity, right: Stats): boolean {
  return (
    right.isFile() &&
    left.device === right.dev &&
    left.inode === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function unlinkExact(
  path: string,
  expected: FileIdentity,
): Promise<boolean> {
  const current = await lstat(path).catch(() => null);
  if (
    !current ||
    !current.isFile() ||
    current.dev !== expected.device ||
    current.ino !== expected.inode
  ) {
    return false;
  }
  await unlink(path);
  return true;
}

async function inspectCaptureFile(
  directory: DirectoryIdentity,
  captureId: string,
  expected: ExpectedPdfSource,
): Promise<CapturedPdf> {
  await recheckDirectory(directory, "capture directory");
  const path = join(directory.path, `${captureId}.pdf`);
  const before = await lstat(path).catch(() =>
    fail("unsafe_path", "captured PDF is unavailable"),
  );
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.uid !== currentUid() ||
    (before.mode & 0o077) !== 0
  ) {
    fail("unsafe_path", "captured PDF is not a protected regular file");
  }
  if (before.size !== expected.byteLength) {
    fail("source_changed", "captured PDF length changed");
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) =>
    rethrowSafe(error, "unsafe_path", "captured PDF cannot be opened"),
  );
  const digest = createHash("sha256");
  let length = 0;
  let prefix = Buffer.alloc(0);
  try {
    const opened = await handle.stat();
    if (!sameFile(fileIdentity(before), opened)) {
      fail("unsafe_path", "captured PDF changed before inspection");
    }
    const buffer = Buffer.alloc(BUFFER_BYTES);
    while (length < expected.byteLength) {
      const read = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, expected.byteLength - length),
        length,
      );
      if (read.bytesRead === 0) break;
      if (prefix.length < 5) {
        prefix = Buffer.concat([
          prefix,
          buffer.subarray(0, Math.min(read.bytesRead, 5 - prefix.length)),
        ]);
      }
      digest.update(buffer.subarray(0, read.bytesRead));
      length += read.bytesRead;
    }
    buffer.fill(0);
    const after = await handle.stat();
    const afterPath = await lstat(path).catch(() =>
      fail("unsafe_path", "captured PDF changed during inspection"),
    );
    if (
      length !== expected.byteLength ||
      !sameFile(fileIdentity(before), after) ||
      !sameFile(fileIdentity(before), afterPath)
    ) {
      fail("unsafe_path", "captured PDF changed during inspection");
    }
    if (!prefix.equals(Buffer.from("%PDF-"))) {
      fail("invalid_input", "captured input is not a supported PDF");
    }
    const sha256 = digest.digest("hex");
    if (sha256 !== expected.sha256) {
      fail("digest_mismatch", "captured PDF digest does not match intent");
    }
    await recheckDirectory(directory, "capture directory");
    return {
      version: 1,
      captureId,
      captureDirectory: {
        path: directory.path,
        device: directory.device,
        inode: directory.inode,
      },
      path,
      sha256,
      byteLength: length,
      sourceModifiedAt: expected.sourceModifiedAt,
      device: before.dev,
      inode: before.ino,
    };
  } finally {
    prefix.fill(0);
    await handle.close().catch(() => undefined);
  }
}

export async function capturePdfFile(
  input: CapturePdfInput,
): Promise<CapturedPdf> {
  try {
    requiredOpenConstants();
    const expected = expectedSource(input.expected);
    const captureId = captureIdentifier(input.captureId);
    const end = deadline(input.deadlineMs);
    const outputDirectory = await protectedDirectory(
      input.captureDirectory,
      "capture directory",
    );
    rootShape(input.root);
    if (
      contains(input.root.canonicalPath, outputDirectory.path) ||
      contains(outputDirectory.path, input.root.canonicalPath)
    ) {
      fail("unsafe_path", "capture directory overlaps the source root");
    }
    const parts = pathParts(input.relativePath);
    const sourcePath = join(input.root.canonicalPath, ...parts);
    const canonicalParent = await verifySourceAncestors(
      input.root,
      input.relativePath,
      end,
    );
    const resolvedBefore = await beforeDeadline(
      realpath(sourcePath),
      end,
      "source resolution timed out",
    ).catch((error: unknown) =>
      rethrowSafe(error, "unsafe_path", "source cannot be resolved"),
    );
    if (
      !contains(input.root.canonicalPath, resolvedBefore) ||
      dirname(resolvedBefore) !== canonicalParent
    ) {
      fail("unsafe_path", "source escaped its configured root");
    }
    const beforePath = await lstat(sourcePath).catch(() =>
      fail("unsafe_path", "source is unavailable"),
    );
    if (beforePath.isSymbolicLink() || !beforePath.isFile()) {
      fail("unsafe_path", "source is not a regular file");
    }
    if (
      beforePath.size !== expected.byteLength ||
      Math.trunc(beforePath.mtimeMs) !== expected.sourceModifiedAt
    ) {
      fail("source_changed", "source no longer matches its observation");
    }
    const sourceOpening = open(
      sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let source: Awaited<ReturnType<typeof open>>;
    try {
      source = await beforeDeadline(
        sourceOpening,
        end,
        "source open timed out",
      );
    } catch (error) {
      void sourceOpening.then((late) => late.close()).catch(() => undefined);
      throw error;
    }

    const temporaryPath = join(
      outputDirectory.path,
      `.${captureId}.${randomUUID()}.tmp`,
    );
    const finalPath = join(outputDirectory.path, `${captureId}.pdf`);
    let temporaryIdentity: FileIdentity | undefined;
    let output: Awaited<ReturnType<typeof open>> | undefined;
    let published = false;
    try {
      const openedSource = await source.stat();
      if (
        !sameFile(fileIdentity(beforePath), openedSource) ||
        openedSource.size !== expected.byteLength
      ) {
        fail("source_changed", "source changed before capture");
      }
      output = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      ).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          fail("destination_exists", "capture output already exists");
        }
        rethrowSafe(error, "io_failed", "capture output cannot be created");
      });
      const created = await output.stat();
      temporaryIdentity = fileIdentity(created);
      if (
        !created.isFile() ||
        created.uid !== currentUid() ||
        (created.mode & 0o077) !== 0 ||
        created.nlink !== 1
      ) {
        fail("unsafe_path", "capture output is not protected");
      }
      const digest = createHash("sha256");
      const buffer = Buffer.alloc(BUFFER_BYTES);
      let offset = 0;
      let prefix = Buffer.alloc(0);
      try {
        while (offset < expected.byteLength) {
          const read = await beforeDeadline(
            source.read(
              buffer,
              0,
              Math.min(buffer.length, expected.byteLength - offset),
              offset,
            ),
            end,
            "source capture timed out",
          );
          if (read.bytesRead === 0) break;
          const chunk = buffer.subarray(0, read.bytesRead);
          if (prefix.length < 5) {
            prefix = Buffer.concat([
              prefix,
              chunk.subarray(0, Math.min(chunk.length, 5 - prefix.length)),
            ]);
          }
          digest.update(chunk);
          let written = 0;
          while (written < chunk.length) {
            const result = await beforeDeadline(
              output.write(
                chunk,
                written,
                chunk.length - written,
                offset + written,
              ),
              end,
              "capture write timed out",
            );
            if (result.bytesWritten === 0) {
              fail("io_failed", "capture output could not be written");
            }
            written += result.bytesWritten;
          }
          offset += read.bytesRead;
        }
        buffer.fill(0);
        if (
          offset !== expected.byteLength ||
          !prefix.equals(Buffer.from("%PDF-"))
        ) {
          fail("source_changed", "source is incomplete or not a supported PDF");
        }
        const sha256 = digest.digest("hex");
        if (sha256 !== expected.sha256) {
          fail("digest_mismatch", "source digest changed after observation");
        }
      } finally {
        prefix.fill(0);
      }
      await output
        .sync()
        .catch((error: unknown) =>
          rethrowSafe(error, "io_failed", "capture output cannot be synced"),
        );
      const captured = await output.stat();
      if (
        captured.dev !== temporaryIdentity.device ||
        captured.ino !== temporaryIdentity.inode ||
        captured.size !== expected.byteLength ||
        captured.uid !== currentUid() ||
        (captured.mode & 0o077) !== 0 ||
        captured.nlink !== 1
      ) {
        fail("unsafe_path", "capture output changed while writing");
      }
      const afterSource = await source.stat();
      const repeatedParent = await verifySourceAncestors(
        input.root,
        input.relativePath,
        end,
      );
      const afterPath = await lstat(sourcePath).catch(() =>
        fail("source_changed", "source changed after capture"),
      );
      const resolvedAfter = await realpath(sourcePath).catch(() =>
        fail("source_changed", "source changed after capture"),
      );
      if (
        repeatedParent !== canonicalParent ||
        resolvedAfter !== resolvedBefore ||
        !sameFile(fileIdentity(beforePath), afterSource) ||
        !sameFile(fileIdentity(beforePath), afterPath)
      ) {
        fail("source_changed", "source changed during capture");
      }
      await recheckDirectory(outputDirectory, "capture directory");
      await link(temporaryPath, finalPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          fail("destination_exists", "capture already exists");
        }
        rethrowSafe(error, "io_failed", "capture cannot be published");
      });
      published = true;
      const final = await lstat(finalPath).catch(() =>
        fail("io_failed", "published capture is unavailable"),
      );
      if (
        final.dev !== captured.dev ||
        final.ino !== captured.ino ||
        !final.isFile() ||
        final.nlink !== 2
      ) {
        fail("unsafe_path", "published capture does not match its output");
      }
      await syncDirectory(outputDirectory);
      if (!(await unlinkExact(temporaryPath, fileIdentity(captured)))) {
        fail("unsafe_path", "capture temporary file changed before cleanup");
      }
      await syncDirectory(outputDirectory);
      return await inspectCaptureFile(outputDirectory, captureId, expected);
    } finally {
      await source.close().catch(() => undefined);
      await output?.close().catch(() => undefined);
      if (!published && temporaryIdentity) {
        await unlinkExact(temporaryPath, temporaryIdentity).catch(() => false);
      }
    }
  } catch (error) {
    rethrowSafe(error, "io_failed", "capture could not complete");
  }
}

export async function inspectCapturedPdf(input: {
  captureDirectory: string;
  captureId: string;
  expected: ExpectedPdfSource;
  expectedDirectory: CapturedPdf["captureDirectory"];
}): Promise<CapturedPdf> {
  try {
    requiredOpenConstants();
    const directory = await protectedDirectory(
      input.captureDirectory,
      "capture directory",
    );
    if (
      directory.path !== input.expectedDirectory.path ||
      directory.device !== input.expectedDirectory.device ||
      directory.inode !== input.expectedDirectory.inode
    ) {
      fail("unsafe_path", "capture directory identity changed");
    }
    return await inspectCaptureFile(
      directory,
      captureIdentifier(input.captureId),
      expectedSource(input.expected),
    );
  } catch (error) {
    rethrowSafe(error, "io_failed", "captured PDF could not be inspected");
  }
}

function parsedCapture(value: CapturedPdf): CapturedPdf {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    !CAPTURE_ID.test(value.captureId) ||
    basename(value.path) !== `${value.captureId}.pdf` ||
    !SHA256.test(value.sha256) ||
    !safeInteger(value.byteLength, 1, MAX_CAPTURED_PDF_BYTES) ||
    !safeInteger(value.sourceModifiedAt, 0, Number.MAX_SAFE_INTEGER) ||
    !safeInteger(value.device, 0, Number.MAX_SAFE_INTEGER) ||
    !safeInteger(value.inode, 0, Number.MAX_SAFE_INTEGER) ||
    !value.captureDirectory ||
    typeof value.captureDirectory !== "object" ||
    dirname(value.path) !== value.captureDirectory.path ||
    !isAbsolute(value.captureDirectory.path) ||
    !safeInteger(value.captureDirectory.device, 0, Number.MAX_SAFE_INTEGER) ||
    !safeInteger(value.captureDirectory.inode, 0, Number.MAX_SAFE_INTEGER)
  ) {
    fail("invalid_input", "captured PDF identity is invalid");
  }
  return { ...value };
}

export async function removeCapturedPdfExact(
  input: CapturedPdf,
): Promise<{ state: "removed" | "already_missing" }> {
  try {
    requiredOpenConstants();
    const capture = parsedCapture(input);
    absolutePath(capture.path, "capture path");
    const directory = await protectedDirectory(
      capture.captureDirectory.path,
      "capture directory",
    );
    if (
      directory.path !== capture.captureDirectory.path ||
      directory.device !== capture.captureDirectory.device ||
      directory.inode !== capture.captureDirectory.inode
    ) {
      fail("unsafe_path", "capture directory identity changed");
    }
    const present = await lstat(capture.path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      rethrowSafe(error, "io_failed", "captured PDF cannot be checked");
    });
    if (!present) {
      await recheckDirectory(directory, "capture directory");
      return { state: "already_missing" };
    }
    const inspected = await inspectCaptureFile(directory, capture.captureId, {
      sha256: capture.sha256,
      byteLength: capture.byteLength,
      sourceModifiedAt: capture.sourceModifiedAt,
    });
    if (
      inspected.path !== capture.path ||
      inspected.device !== capture.device ||
      inspected.inode !== capture.inode
    ) {
      fail("source_changed", "captured PDF was replaced");
    }
    await recheckDirectory(directory, "capture directory");
    const current = await lstat(capture.path).catch(() =>
      fail("source_changed", "captured PDF is unavailable"),
    );
    if (current.dev !== capture.device || current.ino !== capture.inode) {
      fail("source_changed", "captured PDF was replaced");
    }
    await unlink(capture.path).catch((error: unknown) =>
      rethrowSafe(error, "io_failed", "captured PDF cannot be removed"),
    );
    await syncDirectory(directory);
    return { state: "removed" };
  } catch (error) {
    rethrowSafe(error, "io_failed", "captured PDF removal could not complete");
  }
}
