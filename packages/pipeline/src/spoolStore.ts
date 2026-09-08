import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, opendir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type {
  LocalDirectoryIdentity,
  LocalFileIdentity,
} from "./archiveCatalogTypes.js";
import type { CapturedPdf } from "./captureStore.js";
import {
  inspectCapturedPdfParserOutput,
  type ParserOutputIntent,
  type ParserProcessLimits,
  DurableParserOutputArtifacts,
  ValidatedNormalizedBundleResult,
} from "./parserProcess.js";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_SPOOL_BYTES = 4 * 1024 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SpoolStoreFailureCode =
  | "invalid_input"
  | "unsupported_platform"
  | "unsafe_path"
  | "source_changed"
  | "digest_mismatch"
  | "destination_exists"
  | "io_failed";

export class SpoolStoreError extends Error {
  constructor(readonly code: SpoolStoreFailureCode) {
    super(`Normalized spool failed: ${code}`);
    this.name = "SpoolStoreError";
  }
}

type Directory = LocalDirectoryIdentity & { path: string };
type OpenedFile = {
  bytes: Buffer;
  stats: Stats;
};

type ValidatedParserOutput = {
  artifacts: DurableParserOutputArtifacts;
  validated: ValidatedNormalizedBundleResult;
};

function fail(code: SpoolStoreFailureCode): never {
  throw new SpoolStoreError(code);
}

function safeRethrow(error: unknown, code: SpoolStoreFailureCode): never {
  if (error instanceof SpoolStoreError) throw error;
  fail(code);
}

function uid(): number {
  const value = process.getuid?.();
  if (value === undefined) fail("unsupported_platform");
  return value;
}

function requiredConstants(): void {
  if (
    typeof constants.O_NOFOLLOW !== "number" ||
    constants.O_NOFOLLOW === 0 ||
    typeof constants.O_NONBLOCK !== "number"
  )
    fail("unsupported_platform");
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function opaqueId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) fail("invalid_input");
  return value;
}

function absolute(value: unknown): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 4096
  )
    fail("invalid_input");
  return resolve(value);
}

async function trustedAncestors(path: string): Promise<void> {
  let current = path;
  for (let depth = 0; depth < 256; depth += 1) {
    const entry = await lstat(current).catch(() => fail("unsafe_path"));
    const stickyRoot = entry.uid === 0 && (entry.mode & 0o1000) !== 0;
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      (entry.uid !== uid() && entry.uid !== 0) ||
      ((entry.mode & 0o022) !== 0 && !stickyRoot)
    )
      fail("unsafe_path");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
  fail("unsafe_path");
}

async function protectedRoot(pathValue: unknown): Promise<Directory> {
  requiredConstants();
  const requested = absolute(pathValue);
  const before = await lstat(requested).catch(() => fail("unsafe_path"));
  const canonical = await realpath(requested).catch(() => fail("unsafe_path"));
  if (
    canonical !== requested ||
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    before.uid !== uid() ||
    (before.mode & 0o777) !== DIRECTORY_MODE
  )
    fail("unsafe_path");
  await trustedAncestors(canonical);
  const after = await lstat(canonical).catch(() => fail("unsafe_path"));
  if (
    !after.isDirectory() ||
    after.dev !== before.dev ||
    after.ino !== before.ino
  )
    fail("unsafe_path");
  return { path: canonical, device: after.dev, inode: after.ino };
}

async function recheckRoot(root: Directory): Promise<void> {
  const current = await lstat(root.path).catch(() => fail("unsafe_path"));
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.uid !== uid() ||
    (current.mode & 0o777) !== DIRECTORY_MODE ||
    current.dev !== root.device ||
    current.ino !== root.inode ||
    (await realpath(root.path).catch(() => "")) !== root.path
  )
    fail("unsafe_path");
}

function requireExpectedRoot(
  root: Directory,
  expected: LocalDirectoryIdentity,
): void {
  if (
    !safeInteger(expected?.device) ||
    !safeInteger(expected?.inode, 1) ||
    root.device !== expected.device ||
    root.inode !== expected.inode
  )
    fail("unsafe_path");
}

function requireFile(
  stats: Stats,
  maximum = MAX_SPOOL_BYTES,
  expectedLinks = 1,
): void {
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.uid !== uid() ||
    (stats.mode & 0o777) !== FILE_MODE ||
    stats.nlink !== expectedLinks ||
    !safeInteger(stats.size, 1) ||
    stats.size > maximum
  )
    fail("unsafe_path");
}

async function readExact(
  path: string,
  maximum: number,
  expected?: Pick<
    LocalFileIdentity,
    "device" | "inode" | "sha256" | "byteLength"
  >,
  expectedLinks = 1,
): Promise<OpenedFile> {
  requiredConstants();
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => fail("io_failed"));
  try {
    const before = await handle.stat();
    requireFile(before, maximum, expectedLinks);
    if (
      expected &&
      (before.dev !== expected.device ||
        before.ino !== expected.inode ||
        before.size !== expected.byteLength)
    )
      fail("source_changed");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read.bytesRead === 0) fail("source_changed");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(path).catch(() => fail("source_changed"));
    requireFile(after, maximum, expectedLinks);
    requireFile(current, maximum, expectedLinks);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.dev !== current.dev ||
      after.ino !== current.ino
    )
      fail("source_changed");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (expected && sha256 !== expected.sha256) fail("digest_mismatch");
    return { bytes, stats: after };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r").catch(() => fail("io_failed"));
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function resultIdentity(
  name: string,
  stats: Stats,
  bytes: Buffer,
): LocalFileIdentity {
  return {
    opaqueName: name,
    device: stats.dev,
    inode: stats.ino,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
  };
}

export async function inspectSpoolRoot(
  spoolRoot: string,
): Promise<LocalDirectoryIdentity> {
  const root = await protectedRoot(spoolRoot);
  await recheckRoot(root);
  return { device: root.device, inode: root.inode };
}

/** Read-only lost-result check for one deterministic spool namespace. */
export async function inspectSpoolIntentState(input: {
  spoolRoot: string;
  expectedRoot: LocalDirectoryIdentity;
  spoolId: string;
}): Promise<{ state: "absent" | "present_unowned" }> {
  const root = await protectedRoot(input.spoolRoot);
  requireExpectedRoot(root, input.expectedRoot);
  const spoolId = opaqueId(input.spoolId);
  const finalName = `${spoolId}.json`;
  const tempPrefix = `.${spoolId}.`;
  const entries = await opendir(root.path).catch(() => fail("io_failed"));
  let count = 0;
  let present = false;
  try {
    for await (const entry of entries) {
      count += 1;
      if (count > 2_048) fail("unsafe_path");
      if (
        entry.name === finalName ||
        (entry.name.startsWith(tempPrefix) && entry.name.endsWith(".tmp"))
      )
        present = true;
    }
  } finally {
    await entries.close().catch(() => undefined);
  }
  await recheckRoot(root);
  return { state: present ? "present_unowned" : "absent" };
}

export async function prepareNormalizedBundleSpool(input: {
  spoolRoot: string;
  expectedRoot: LocalDirectoryIdentity;
  spoolId: string;
  parserOutput: ValidatedParserOutput;
}): Promise<LocalFileIdentity> {
  const root = await protectedRoot(input.spoolRoot);
  requireExpectedRoot(root, input.expectedRoot);
  const spoolId = opaqueId(input.spoolId);
  const sourceIdentity = input.parserOutput?.artifacts?.normalizedBundle;
  if (
    !sourceIdentity ||
    sourceIdentity.mediaType !== "application/json" ||
    !isAbsolute(sourceIdentity.path)
  )
    fail("invalid_input");
  const source = await readExact(sourceIdentity.path, MAX_SPOOL_BYTES, {
    device: sourceIdentity.device,
    inode: sourceIdentity.inode,
    sha256: sourceIdentity.sha256,
    byteLength: sourceIdentity.byteLength,
  });
  const tempName = `.${spoolId}.${randomUUID()}.tmp`;
  const temp = join(root.path, tempName);
  let tempIdentity: Pick<Stats, "dev" | "ino"> | undefined;
  try {
    await recheckRoot(root);
    const handle = await open(temp, "wx", FILE_MODE);
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.uid !== uid() ||
        (opened.mode & 0o777) !== FILE_MODE ||
        opened.nlink !== 1 ||
        opened.size !== 0
      )
        fail("unsafe_path");
      tempIdentity = { dev: opened.dev, ino: opened.ino };
      await handle.writeFile(source.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(root.path);
    await recheckRoot(root);
    const inspected = await readExact(temp, MAX_SPOOL_BYTES);
    const identity = resultIdentity(tempName, inspected.stats, inspected.bytes);
    if (
      identity.sha256 !== sourceIdentity.sha256 ||
      identity.byteLength !== sourceIdentity.byteLength
    )
      fail("digest_mismatch");
    tempIdentity = undefined;
    return identity;
  } catch (error) {
    if (tempIdentity) {
      const current = await lstat(temp).catch(() => null);
      const currentRoot = await lstat(root.path).catch(() => null);
      if (
        current?.isFile() &&
        current.dev === tempIdentity.dev &&
        current.ino === tempIdentity.ino &&
        current.nlink === 1 &&
        currentRoot?.dev === root.device &&
        currentRoot.ino === root.inode
      )
        await unlink(temp).catch(() => undefined);
    }
    safeRethrow(error, "io_failed");
  }
}

export async function publishNormalizedBundleSpool(input: {
  spoolRoot: string;
  expectedRoot: LocalDirectoryIdentity;
  spoolId: string;
  prepared: LocalFileIdentity;
}): Promise<LocalFileIdentity> {
  const root = await protectedRoot(input.spoolRoot);
  requireExpectedRoot(root, input.expectedRoot);
  const spoolId = opaqueId(input.spoolId);
  if (
    !input.prepared.opaqueName.startsWith(`.${spoolId}.`) ||
    !input.prepared.opaqueName.endsWith(".tmp")
  )
    fail("invalid_input");
  const temp = join(root.path, input.prepared.opaqueName);
  const name = `${spoolId}.json`;
  const target = join(root.path, name);
  const prepared = await readExact(temp, MAX_SPOOL_BYTES, input.prepared);
  await recheckRoot(root);
  try {
    await link(temp, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      fail("destination_exists");
    safeRethrow(error, "io_failed");
  }
  await recheckRoot(root);
  const published = await readExact(target, MAX_SPOOL_BYTES, undefined, 2);
  if (
    published.stats.dev !== prepared.stats.dev ||
    published.stats.ino !== prepared.stats.ino ||
    createHash("sha256").update(published.bytes).digest("hex") !==
      input.prepared.sha256 ||
    published.bytes.length !== input.prepared.byteLength
  )
    fail("source_changed");
  const currentTemp = await lstat(temp).catch(() => fail("source_changed"));
  if (
    currentTemp.dev !== prepared.stats.dev ||
    currentTemp.ino !== prepared.stats.ino ||
    currentTemp.nlink !== 2
  )
    fail("source_changed");
  await recheckRoot(root);
  await unlink(temp).catch(() => fail("io_failed"));
  await fsyncDirectory(root.path);
  await recheckRoot(root);
  const final = await readExact(target, MAX_SPOOL_BYTES);
  return resultIdentity(name, final.stats, final.bytes);
}

export async function recoverNormalizedBundleSpool(input: {
  spoolRoot: string;
  expectedRoot: LocalDirectoryIdentity;
  spoolId: string;
  prepared: LocalFileIdentity;
}): Promise<LocalFileIdentity> {
  const root = await protectedRoot(input.spoolRoot);
  requireExpectedRoot(root, input.expectedRoot);
  const spoolId = opaqueId(input.spoolId);
  if (
    !input.prepared.opaqueName.startsWith(`.${spoolId}.`) ||
    !input.prepared.opaqueName.endsWith(".tmp")
  )
    fail("invalid_input");
  const temp = join(root.path, input.prepared.opaqueName);
  const target = join(root.path, `${spoolId}.json`);
  const targetStats = await lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail("io_failed");
  });
  if (targetStats === null) return await publishNormalizedBundleSpool(input);
  const tempStats = await lstat(temp).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail("io_failed");
  });
  const published = await readExact(
    target,
    MAX_SPOOL_BYTES,
    undefined,
    tempStats === null ? 1 : 2,
  );
  if (
    published.stats.dev !== input.prepared.device ||
    published.stats.ino !== input.prepared.inode ||
    published.bytes.length !== input.prepared.byteLength ||
    createHash("sha256").update(published.bytes).digest("hex") !==
      input.prepared.sha256
  )
    fail("source_changed");
  if (tempStats !== null) {
    if (
      tempStats.dev !== input.prepared.device ||
      tempStats.ino !== input.prepared.inode ||
      tempStats.nlink !== 2
    )
      fail("source_changed");
    await recheckRoot(root);
    await unlink(temp).catch(() => fail("io_failed"));
    await fsyncDirectory(root.path);
  }
  await recheckRoot(root);
  const final = await readExact(target, MAX_SPOOL_BYTES);
  return resultIdentity(`${spoolId}.json`, final.stats, final.bytes);
}

export async function inspectNormalizedBundleSpool(input: {
  spoolRoot: string;
  expectedRoot: LocalDirectoryIdentity;
  spool: LocalFileIdentity;
  parserRecovery: {
    capture: CapturedPdf;
    outputRoot: string;
    outputIntent: ParserOutputIntent;
    expectedParserFingerprint: string;
    expectedExtractionConfigurationFingerprint: string;
    expectedModelManifestSha256: string;
    limits?: ParserProcessLimits;
  };
}): Promise<ValidatedNormalizedBundleResult> {
  const root = await protectedRoot(input.spoolRoot);
  requireExpectedRoot(root, input.expectedRoot);
  const matched = /^([0-9a-f-]{36})\.json$/.exec(input.spool.opaqueName);
  if (!matched) fail("invalid_input");
  opaqueId(matched[1]);
  const target = join(root.path, input.spool.opaqueName);
  const inspected = await readExact(target, MAX_SPOOL_BYTES, input.spool);
  const parserOutput = await inspectCapturedPdfParserOutput(
    input.parserRecovery,
  );
  const source = parserOutput.artifacts.normalizedBundle;
  if (
    inspected.bytes.length !== source.byteLength ||
    createHash("sha256").update(inspected.bytes).digest("hex") !==
      source.sha256 ||
    source.sha256 !== input.spool.sha256 ||
    source.byteLength !== input.spool.byteLength
  )
    fail("digest_mismatch");
  await recheckRoot(root);
  return structuredClone(parserOutput.validated);
}

export async function removeNormalizedBundleSpoolExact(input: {
  spoolRoot: string;
  expectedRoot: LocalDirectoryIdentity;
  spool: LocalFileIdentity;
}): Promise<{ state: "removed" | "already_missing" }> {
  const root = await protectedRoot(input.spoolRoot);
  requireExpectedRoot(root, input.expectedRoot);
  const matched = /^([0-9a-f-]{36})\.json$/.exec(input.spool.opaqueName);
  if (!matched) fail("invalid_input");
  opaqueId(matched[1]);
  const target = join(root.path, input.spool.opaqueName);
  const current = await lstat(target).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail("io_failed");
  });
  if (current === null) {
    await recheckRoot(root);
    return { state: "already_missing" };
  }
  requireFile(current);
  if (
    current.dev !== input.spool.device ||
    current.ino !== input.spool.inode ||
    current.size !== input.spool.byteLength
  )
    fail("source_changed");
  const inspected = await readExact(target, MAX_SPOOL_BYTES, input.spool);
  if (
    inspected.stats.dev !== current.dev ||
    inspected.stats.ino !== current.ino
  )
    fail("source_changed");
  await recheckRoot(root);
  const final = await lstat(target).catch(() => fail("source_changed"));
  if (
    final.dev !== current.dev ||
    final.ino !== current.ino ||
    final.nlink !== 1
  )
    fail("source_changed");
  await unlink(target).catch(() => fail("io_failed"));
  await recheckRoot(root);
  await fsyncDirectory(root.path);
  return { state: "removed" };
}
