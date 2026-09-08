import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { mkdir, lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  decryptAgeRecoveryObject,
  inventoryResticSnapshots,
  inventoryResticSnapshotTree,
  restoreResticObject,
  restoreResticSnapshotPath,
} from "./archiveCommands.js";
import {
  decodeNativeDatabasePayload,
  type DecodedNativeDatabasePayload,
  type NativeDatabasePayloadManifest,
} from "./archiveNativePayload.js";
import {
  reconcileArchiveRelocationInventory,
  type ArchiveRelocationInventoryManifest,
} from "./archiveRelocationInventory.js";
import {
  parseOwnerArchiveRelocationRecipe,
  type OwnerArchiveRelocationRecipe,
} from "./archiveRelocationRecipe.js";
import type {
  ArchiveCommandLimits,
  DecryptedAgeRecoveryObject,
  InventoryResticSnapshotTreeInput,
  InventoryResticSnapshotsInput,
  PasswordCommand,
  RcloneDropboxRepository,
  ResticSnapshotTreeInventory,
  RestoredResticObject,
  RestoredResticSnapshotPath,
  Sha256File,
} from "./archiveTypes.js";
import { AGE_VERSION, RESTIC_VERSION } from "./archiveTypes.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const CREATED_AT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export type RepositoryRecoveryConfig = Readonly<{
  resticBinary: string;
  repository: RcloneDropboxRepository;
  expectedRepositoryId: string;
  passwordCommand: PasswordCommand;
  ageBinary: string;
  identityPath: string;
  limits?: ArchiveCommandLimits;
}>;

export type NativeArchiveVerification = Readonly<{
  passed: true;
  nativeZipSha256: string;
  backendSha256: string;
  verificationResultSha256: string;
  outputDirectory: string;
  outputDirectoryDevice: number;
  outputDirectoryInode: number;
}>;

export type NativeArchiveVerifier = (
  input: Readonly<{
    recipeHash: string;
    workflowRelocationId: string;
    receiptFingerprint: string;
    nativeZipPath: string;
    nativeZipSha256: string;
    outputDirectory: string;
    payloadManifest: NativeDatabasePayloadManifest;
  }>,
) => Promise<NativeArchiveVerification>;

export type ArchiveRecoveryObjectProof = Readonly<{
  domain: "processing" | "database";
  identityFingerprint: string;
  snapshotId: string;
  treeId: string;
  storedPath: string;
  ciphertextPath: string;
  ciphertext: Sha256File;
  plaintextPath: string;
  plaintext: Sha256File;
  plaintextDevice: number;
  plaintextInode: number;
  payloadManifest?: NativeDatabasePayloadManifest;
}>;

export type ArchiveRelocationRecoveryProof = Readonly<{
  version: 1;
  recipeHash: string;
  workflowRelocationId: string;
  phase: "old" | "new";
  manifestSha256: string;
  workflowArtifacts: ArchiveRelocationInventoryManifest["workflowArtifacts"];
  attemptDirectory: string;
  attemptDirectoryDevice: number;
  attemptDirectoryInode: number;
  objects: readonly ArchiveRecoveryObjectProof[];
  nativeVerification: NativeArchiveVerification;
  completedAt: number;
}>;

type RecoveryAdapters = Readonly<{
  inventorySnapshots: typeof inventoryResticSnapshots;
  inventoryTree: typeof inventoryResticSnapshotTree;
  restoreObject: typeof restoreResticObject;
  restoreSnapshotPath: typeof restoreResticSnapshotPath;
  decrypt: typeof decryptAgeRecoveryObject;
  decodeNativePayload: typeof decodeNativeDatabasePayload;
  readPayload: typeof readPayload;
  now: () => number;
}>;

const DEFAULT_ADAPTERS: RecoveryAdapters = {
  inventorySnapshots: inventoryResticSnapshots,
  inventoryTree: inventoryResticSnapshotTree,
  restoreObject: restoreResticObject,
  restoreSnapshotPath: restoreResticSnapshotPath,
  decrypt: decryptAgeRecoveryObject,
  decodeNativePayload: decodeNativeDatabasePayload,
  readPayload,
  now: Date.now,
};

export class ArchiveRelocationRecoveryError extends Error {
  constructor(
    readonly code: "invalid_input" | "unsafe_path" | "verification_failed",
  ) {
    super(`Archive relocation recovery failed: ${code}`);
    this.name = "ArchiveRelocationRecoveryError";
  }
}

function fail(code: ArchiveRelocationRecoveryError["code"]): never {
  throw new ArchiveRelocationRecoveryError(code);
}

function uid(): number {
  const value = process.getuid?.();
  if (value === undefined) fail("unsafe_path");
  return value;
}

function exactKeys(value: object, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    actual.some(
      (key) =>
        key === "__proto__" || key === "prototype" || key === "constructor",
    )
  )
    fail("verification_failed");
}

function requireDirectory(stats: Stats): void {
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.uid !== uid() ||
    (stats.mode & 0o777) !== DIRECTORY_MODE
  )
    fail("unsafe_path");
}

async function requireProtectedAncestors(path: string): Promise<void> {
  let current = path;
  while (true) {
    const stats = await lstat(current).catch(() => fail("unsafe_path"));
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (current === path
        ? stats.uid !== uid() || (stats.mode & 0o777) !== DIRECTORY_MODE
        : (stats.uid !== uid() && stats.uid !== 0) ||
          (stats.mode & 0o022) !== 0)
    )
      fail("unsafe_path");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function createAttemptDirectory(
  path: string,
): Promise<{ device: number; inode: number }> {
  if (resolve(path) !== path || basename(path).length < 1)
    fail("invalid_input");
  const parent = dirname(path);
  if ((await realpath(parent).catch(() => "")) !== parent) fail("unsafe_path");
  await requireProtectedAncestors(parent);
  await mkdir(path, { mode: DIRECTORY_MODE }).catch(() => fail("unsafe_path"));
  const stats = await lstat(path).catch(() => fail("unsafe_path"));
  requireDirectory(stats);
  if ((await realpath(path).catch(() => "")) !== path) fail("unsafe_path");
  await requireProtectedAncestors(path);
  return { device: stats.dev, inode: stats.ino };
}

async function createChildDirectory(
  parent: string,
  name: string,
): Promise<string> {
  const path = join(parent, name);
  if (dirname(path) !== parent) fail("invalid_input");
  await mkdir(path, { mode: DIRECTORY_MODE }).catch(() => fail("unsafe_path"));
  await requireProtectedAncestors(path);
  return path;
}

async function assertDirectoryIdentity(
  path: string,
  expected: { device: number; inode: number },
): Promise<void> {
  const stats = await lstat(path).catch(() => fail("unsafe_path"));
  requireDirectory(stats);
  if (stats.dev !== expected.device || stats.ino !== expected.inode)
    fail("unsafe_path");
  await requireProtectedAncestors(path);
}

async function readPayload(
  path: string,
  expectedSha256: string,
  expectedIdentity: { device: number; inode: number },
): Promise<Buffer> {
  const before = await lstat(path).catch(() => fail("unsafe_path"));
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== uid() ||
    (before.mode & 0o777) !== FILE_MODE ||
    before.nlink !== 1 ||
    before.size < 1 ||
    before.size > MAX_PAYLOAD_BYTES
  )
    fail("unsafe_path");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => fail("unsafe_path"));
  let payload: Buffer | undefined;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.uid !== uid() ||
      (opened.mode & 0o777) !== FILE_MODE ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.dev !== expectedIdentity.device ||
      opened.ino !== expectedIdentity.inode ||
      opened.size !== before.size
    )
      fail("unsafe_path");
    payload = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < payload.length) {
      const { bytesRead } = await handle.read(
        payload,
        offset,
        payload.length - offset,
        offset,
      );
      if (bytesRead === 0) fail("unsafe_path");
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size
    )
      fail("unsafe_path");
    if (createHash("sha256").update(payload).digest("hex") !== expectedSha256) {
      payload.fill(0);
      fail("verification_failed");
    }
    const named = await lstat(path).catch(() => fail("unsafe_path"));
    if (
      !named.isFile() ||
      named.isSymbolicLink() ||
      named.uid !== uid() ||
      (named.mode & 0o777) !== FILE_MODE ||
      named.nlink !== 1 ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      named.size !== opened.size
    )
      fail("unsafe_path");
    return payload;
  } catch (error) {
    payload?.fill(0);
    throw error;
  } finally {
    await handle.close();
  }
}

async function writeNativeZip(
  path: string,
  value: Buffer,
): Promise<Sha256File> {
  const handle = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    FILE_MODE,
  ).catch(() => fail("unsafe_path"));
  try {
    await handle.chmod(FILE_MODE);
    await handle.writeFile(value);
    await handle.sync();
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.uid !== uid() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== FILE_MODE ||
      stats.size !== value.length
    )
      fail("unsafe_path");
  } finally {
    await handle.close();
  }
  return {
    sha256: createHash("sha256").update(value).digest("hex"),
    byteLength: value.length,
  };
}

function repositoryInput(
  config: RepositoryRecoveryConfig,
): InventoryResticSnapshotsInput {
  return {
    resticBinary: config.resticBinary,
    repository: config.repository,
    expectedRepositoryId: config.expectedRepositoryId,
    passwordCommand: config.passwordCommand,
    ...(config.limits === undefined ? {} : { limits: config.limits }),
  };
}

async function collectInventory(
  recipe: OwnerArchiveRelocationRecipe,
  phase: "old" | "new",
  processingConfig: RepositoryRecoveryConfig,
  databaseConfig: RepositoryRecoveryConfig,
  adapters: RecoveryAdapters,
): Promise<ArchiveRelocationInventoryManifest> {
  const [processingSnapshots, databaseSnapshots] = await Promise.all([
    adapters.inventorySnapshots(repositoryInput(processingConfig)),
    adapters.inventorySnapshots(repositoryInput(databaseConfig)),
  ]);
  const tree = (
    config: RepositoryRecoveryConfig,
    snapshotId: string,
  ): InventoryResticSnapshotTreeInput => ({
    ...repositoryInput(config),
    snapshotId,
  });
  const requireSnapshotSet = (
    inventory: unknown,
    expectedIds: readonly string[],
  ): void => {
    if (!inventory || typeof inventory !== "object")
      fail("verification_failed");
    const snapshots = (inventory as { snapshots?: unknown }).snapshots;
    if (!Array.isArray(snapshots) || snapshots.length !== expectedIds.length)
      fail("verification_failed");
    const ids = snapshots.map((row) =>
      row && typeof row === "object"
        ? (row as { snapshotId?: unknown }).snapshotId
        : undefined,
    );
    const actualIds = ids as string[];
    const actualSorted = [...actualIds].sort();
    const expectedSorted = [...expectedIds].sort();
    if (
      ids.some((id) => typeof id !== "string") ||
      new Set(ids).size !== ids.length ||
      expectedSorted.some((id, index) => id !== actualSorted[index])
    )
      fail("verification_failed");
  };
  const processingIds = recipe.body.processing.artifactBindings.map(
    (binding) => binding.snapshotId,
  );
  const databaseIds = recipe.body.database.receipts.map(
    (binding) => binding.receipt.snapshotId,
  );
  requireSnapshotSet(processingSnapshots, processingIds);
  requireSnapshotSet(databaseSnapshots, databaseIds);
  const processingTrees: ResticSnapshotTreeInventory[] = [];
  const databaseTrees: ResticSnapshotTreeInventory[] = [];
  for (const snapshotId of processingIds) {
    processingTrees.push(
      await adapters.inventoryTree(tree(processingConfig, snapshotId)),
    );
  }
  for (const snapshotId of databaseIds) {
    databaseTrees.push(
      await adapters.inventoryTree(tree(databaseConfig, snapshotId)),
    );
  }
  return reconcileArchiveRelocationInventory({
    recipe,
    phase,
    processing: { snapshots: processingSnapshots, trees: processingTrees },
    database: { snapshots: databaseSnapshots, trees: databaseTrees },
  });
}

function restoreBase(
  config: RepositoryRecoveryConfig,
  snapshotId: string,
  expectedCiphertext: Sha256File,
  destinationPath: string,
) {
  return {
    resticBinary: config.resticBinary,
    repository: config.repository,
    expectedRepositoryId: config.expectedRepositoryId,
    passwordCommand: config.passwordCommand,
    snapshotId,
    expectedCiphertext,
    destinationPath,
    ...(config.limits === undefined ? {} : { limits: config.limits }),
  };
}

function assertRestored(
  value: RestoredResticObject | RestoredResticSnapshotPath,
  expected: {
    snapshotId: string;
    repositoryId: string;
    ciphertext: Sha256File;
    destinationPath: string;
    locator: { objectName: string } | { objectPath: string };
  },
): void {
  if (
    value.snapshotId !== expected.snapshotId ||
    value.repositoryId !== expected.repositoryId ||
    value.destinationPath !== expected.destinationPath ||
    value.verification !== "exact_ciphertext_restore" ||
    value.resticVersion !== RESTIC_VERSION ||
    value.ciphertext.sha256 !== expected.ciphertext.sha256 ||
    value.ciphertext.byteLength !== expected.ciphertext.byteLength ||
    ("objectName" in expected.locator
      ? !("objectName" in value) ||
        value.objectName !== expected.locator.objectName
      : !("objectPath" in value) ||
        value.objectPath !== expected.locator.objectPath)
  )
    fail("verification_failed");
}

function assertDecrypted(
  value: DecryptedAgeRecoveryObject,
  expectedPath: string,
  expected: Sha256File,
): void {
  if (
    value.outputPath !== expectedPath ||
    value.verification !== "decrypted_plaintext_hash" ||
    value.plaintext.sha256 !== expected.sha256 ||
    value.plaintext.byteLength !== expected.byteLength ||
    value.ageVersion !== AGE_VERSION ||
    !Number.isSafeInteger(value.plaintextDevice) ||
    value.plaintextDevice < 0 ||
    !Number.isSafeInteger(value.plaintextInode) ||
    value.plaintextInode < 1
  )
    fail("verification_failed");
}

function validateNativeResult(
  value: NativeArchiveVerification,
  expectedPath: string,
  expectedZipSha256: string,
): void {
  if (!value || typeof value !== "object") fail("verification_failed");
  exactKeys(value, [
    "passed",
    "nativeZipSha256",
    "backendSha256",
    "verificationResultSha256",
    "outputDirectory",
    "outputDirectoryDevice",
    "outputDirectoryInode",
  ]);
  if (
    value.passed !== true ||
    value.outputDirectory !== expectedPath ||
    value.nativeZipSha256 !== expectedZipSha256 ||
    !SHA256.test(value.backendSha256) ||
    !SHA256.test(value.verificationResultSha256) ||
    !Number.isSafeInteger(value.outputDirectoryDevice) ||
    value.outputDirectoryDevice < 0 ||
    !Number.isSafeInteger(value.outputDirectoryInode) ||
    value.outputDirectoryInode < 1
  )
    fail("verification_failed");
}

function validatePayloadManifest(
  value: NativeDatabasePayloadManifest,
  expectedZipSha256: string,
  expectedZipByteLength: number,
): void {
  if (!value || typeof value !== "object") fail("verification_failed");
  exactKeys(value, [
    "kind",
    "deployment",
    "createdAt",
    "includeFileStorage",
    "byteLength",
    "sha256",
    "sourceCommit",
  ]);
  if (
    value.kind !== "native_convex_snapshot_v1" ||
    value.includeFileStorage !== true ||
    typeof value.deployment !== "string" ||
    value.deployment.length < 1 ||
    Buffer.byteLength(value.deployment, "utf8") > 256 ||
    /[\x00-\x1f\x7f]/.test(value.deployment) ||
    typeof value.createdAt !== "string" ||
    Buffer.byteLength(value.createdAt, "utf8") > 64 ||
    !CREATED_AT.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    value.byteLength !== expectedZipByteLength ||
    value.sha256 !== expectedZipSha256 ||
    !GIT_COMMIT.test(value.sourceCommit)
  )
    fail("verification_failed");
}

export type VerifyArchiveRelocationRecoveryInput = Readonly<{
  recipe: unknown;
  phase: "old" | "new";
  attemptDirectory: string;
  processing: RepositoryRecoveryConfig;
  database: RepositoryRecoveryConfig;
  nativeVerifier: NativeArchiveVerifier;
}>;

async function verifyRecovery(
  input: VerifyArchiveRelocationRecoveryInput,
  adapters: RecoveryAdapters,
): Promise<ArchiveRelocationRecoveryProof> {
  const recipe = parseOwnerArchiveRelocationRecipe(input.recipe);
  if (input.phase !== "old" && input.phase !== "new") fail("invalid_input");
  const attemptIdentity = await createAttemptDirectory(input.attemptDirectory);
  const processingDirectory = await createChildDirectory(
    input.attemptDirectory,
    "processing",
  );
  const databaseDirectory = await createChildDirectory(
    input.attemptDirectory,
    "database",
  );
  const nativeDirectory = join(input.attemptDirectory, "native-verification");
  const manifest = await collectInventory(
    recipe,
    input.phase,
    input.processing,
    input.database,
    adapters,
  );
  const objects: ArchiveRecoveryObjectProof[] = [];

  for (const binding of recipe.body.processing.artifactBindings) {
    const reconciled = manifest.processingObjects.find(
      (item) => item.snapshotId === binding.snapshotId,
    )!;
    const ciphertextPath = join(
      processingDirectory,
      `${reconciled.identityFingerprint}.age`,
    );
    const plaintextPath = join(
      processingDirectory,
      `${reconciled.identityFingerprint}.plaintext`,
    );
    const expectedCiphertext = {
      sha256: binding.ciphertextSha256,
      byteLength: binding.ciphertextByteLength,
    };
    const restored = await adapters.restoreObject({
      ...restoreBase(
        input.processing,
        binding.snapshotId,
        expectedCiphertext,
        ciphertextPath,
      ),
      objectName: binding.objectName,
    });
    assertRestored(restored, {
      snapshotId: binding.snapshotId,
      repositoryId: input.processing.expectedRepositoryId,
      ciphertext: expectedCiphertext,
      destinationPath: ciphertextPath,
      locator: { objectName: binding.objectName },
    });
    const decrypted = await adapters.decrypt({
      ageBinary: input.processing.ageBinary,
      identityPath: input.processing.identityPath,
      ciphertextPath,
      outputPath: plaintextPath,
      expectedCiphertext,
      expectedPlaintextSha256: binding.plaintextSha256,
      ...(input.processing.limits === undefined
        ? {}
        : { limits: input.processing.limits }),
    });
    const expectedPlaintext = {
      sha256: binding.plaintextSha256,
      byteLength: binding.plaintextByteLength,
    };
    assertDecrypted(decrypted, plaintextPath, expectedPlaintext);
    objects.push({
      domain: "processing",
      identityFingerprint: reconciled.identityFingerprint,
      snapshotId: binding.snapshotId,
      treeId: reconciled.treeId,
      storedPath: reconciled.storedPath,
      ciphertextPath,
      ciphertext: expectedCiphertext,
      plaintextPath,
      plaintext: expectedPlaintext,
      plaintextDevice: decrypted.plaintextDevice,
      plaintextInode: decrypted.plaintextInode,
    });
  }

  let nativeVerification: NativeArchiveVerification | undefined;
  for (const binding of recipe.body.database.receipts) {
    const receipt = binding.receipt;
    const reconciled = manifest.databaseObjects.find(
      (item) => item.snapshotId === receipt.snapshotId,
    )!;
    const ciphertextPath = join(
      databaseDirectory,
      `${binding.receiptFingerprint}.age`,
    );
    const plaintextPath = join(
      databaseDirectory,
      `${binding.receiptFingerprint}.payload`,
    );
    const expectedCiphertext = {
      sha256: receipt.ciphertextHash,
      byteLength: receipt.ciphertextByteLength,
    };
    const restored = await adapters.restoreSnapshotPath({
      ...restoreBase(
        input.database,
        receipt.snapshotId,
        expectedCiphertext,
        ciphertextPath,
      ),
      objectPath: receipt.objectPath,
    });
    assertRestored(restored, {
      snapshotId: receipt.snapshotId,
      repositoryId: input.database.expectedRepositoryId,
      ciphertext: expectedCiphertext,
      destinationPath: ciphertextPath,
      locator: { objectPath: receipt.objectPath },
    });
    const decrypted = await adapters.decrypt({
      ageBinary: input.database.ageBinary,
      identityPath: input.database.identityPath,
      ciphertextPath,
      outputPath: plaintextPath,
      expectedCiphertext,
      expectedPlaintextSha256: receipt.payloadHash,
      ...(input.database.limits === undefined
        ? {}
        : { limits: input.database.limits }),
    });
    if (
      decrypted.outputPath !== plaintextPath ||
      decrypted.verification !== "decrypted_plaintext_hash" ||
      decrypted.ageVersion !== AGE_VERSION ||
      decrypted.plaintext.sha256 !== receipt.payloadHash ||
      !Number.isSafeInteger(decrypted.plaintext.byteLength) ||
      decrypted.plaintext.byteLength < 1 ||
      decrypted.plaintext.byteLength > MAX_PAYLOAD_BYTES ||
      !Number.isSafeInteger(decrypted.plaintextDevice) ||
      decrypted.plaintextDevice < 0 ||
      !Number.isSafeInteger(decrypted.plaintextInode) ||
      decrypted.plaintextInode < 1
    )
      fail("verification_failed");
    let payload: Buffer | undefined;
    let decoded: DecodedNativeDatabasePayload | undefined;
    try {
      payload = await adapters.readPayload(plaintextPath, receipt.payloadHash, {
        device: decrypted.plaintextDevice,
        inode: decrypted.plaintextInode,
      });
      if (decrypted.plaintext.byteLength !== payload.byteLength)
        fail("verification_failed");
      decoded = adapters.decodeNativePayload({
        payload,
        expectedPayloadSha256: receipt.payloadHash,
        expectedNativeZipSha256: receipt.nativeZipHash,
      });
      if (
        createHash("sha256").update(decoded.nativeZip).digest("hex") !==
        receipt.nativeZipHash
      )
        fail("verification_failed");
      validatePayloadManifest(
        decoded.manifest,
        receipt.nativeZipHash,
        decoded.nativeZip.byteLength,
      );
      if (
        binding.receiptFingerprint ===
        recipe.body.database.selectedNativeRestoreReceiptFingerprint
      ) {
        const nativeZipPath = join(
          databaseDirectory,
          `${binding.receiptFingerprint}.native.zip`,
        );
        const written = await writeNativeZip(nativeZipPath, decoded.nativeZip);
        if (
          written.sha256 !== receipt.nativeZipHash ||
          written.byteLength !== decoded.nativeZip.byteLength
        )
          fail("verification_failed");
        const value = await input.nativeVerifier({
          recipeHash: recipe.recipeHash,
          workflowRelocationId: recipe.workflowRelocationId,
          receiptFingerprint: binding.receiptFingerprint,
          nativeZipPath,
          nativeZipSha256: receipt.nativeZipHash,
          outputDirectory: nativeDirectory,
          payloadManifest: decoded.manifest,
        });
        validateNativeResult(value, nativeDirectory, receipt.nativeZipHash);
        await assertDirectoryIdentity(nativeDirectory, {
          device: value.outputDirectoryDevice,
          inode: value.outputDirectoryInode,
        });
        nativeVerification = value;
      }
      objects.push({
        domain: "database",
        identityFingerprint: binding.receiptFingerprint,
        snapshotId: receipt.snapshotId,
        treeId: reconciled.treeId,
        storedPath: receipt.objectPath,
        ciphertextPath,
        ciphertext: expectedCiphertext,
        plaintextPath,
        plaintext: decrypted.plaintext,
        plaintextDevice: decrypted.plaintextDevice,
        plaintextInode: decrypted.plaintextInode,
        payloadManifest: decoded.manifest,
      });
    } finally {
      decoded?.nativeZip.fill(0);
      payload?.fill(0);
    }
  }
  if (!nativeVerification) fail("verification_failed");
  await assertDirectoryIdentity(input.attemptDirectory, attemptIdentity);
  const completedAt = adapters.now();
  if (!Number.isSafeInteger(completedAt) || completedAt < 0)
    fail("verification_failed");
  return {
    version: 1,
    recipeHash: recipe.recipeHash,
    workflowRelocationId: recipe.workflowRelocationId,
    phase: input.phase,
    manifestSha256: manifest.manifestSha256,
    workflowArtifacts: manifest.workflowArtifacts,
    attemptDirectory: input.attemptDirectory,
    attemptDirectoryDevice: attemptIdentity.device,
    attemptDirectoryInode: attemptIdentity.inode,
    objects,
    nativeVerification,
    completedAt,
  };
}

/** Production entrypoint. Recovery primitives cannot be replaced by callers. */
export function verifyArchiveRelocationRecovery(
  input: VerifyArchiveRelocationRecoveryInput,
): Promise<ArchiveRelocationRecoveryProof> {
  return verifyRecovery(input, DEFAULT_ADAPTERS);
}

/** @internal Test seam only. Never use this to produce owner recovery evidence. */
export function __testOnlyVerifyArchiveRelocationRecovery(
  input: VerifyArchiveRelocationRecoveryInput,
  overrides: Partial<RecoveryAdapters>,
): Promise<ArchiveRelocationRecoveryProof> {
  return verifyRecovery(input, { ...DEFAULT_ADAPTERS, ...overrides });
}
