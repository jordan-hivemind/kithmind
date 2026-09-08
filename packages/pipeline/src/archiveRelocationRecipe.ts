import { createHash } from "node:crypto";
import { posix, resolve } from "node:path";

import type {
  ArchiveBoundaryRelocationArtifact,
  ArchiveBoundaryRelocationArtifactBinding,
} from "./archiveCatalogTypes.js";
import { ArchiveCatalog } from "./archiveCatalog.js";
import { validateArchiveRelocationConfig } from "./archiveRelocationConfig.js";
import type { RelocationIntent } from "./archiveRelocationWorkflow.js";
import { Journal } from "./journal.js";
import type { JsonValue } from "./journalTypes.js";
import {
  RCLONE_VERSION,
  RESTIC_VERSION,
  type RemoteBackupBoundary,
} from "./archiveTypes.js";
import { parseConfig } from "./config.js";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ROOT_PATH = /^[A-Za-z0-9 _.-]+(?:\/[A-Za-z0-9 _.-]+)+$/;
const OBJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SNAPSHOT_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PROCESSING_ARTIFACTS = 2_048;
const MAX_DATABASE_RECEIPTS = 128;
const MAX_RECIPE_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const CONFIG_TEXT_MAX_BYTES = 64 * 1024;

export const OWNER_ARCHIVE_RELOCATION_NAMESPACE =
  "84baabd3-0c79-528f-81ac-4e059454e4f3" as const;

export type ProcessingArtifactBinding =
  ArchiveBoundaryRelocationArtifactBinding;

export type LegacyDatabaseBackupReceipt = Readonly<{
  kind: "native_database_backup_receipt_v1";
  status: string;
  repositoryId: string;
  rootDirectoryIdHash: string;
  snapshotId: string;
  snapshotTag: string;
  objectPath: string;
  ciphertextHash: string;
  ciphertextByteLength: number;
  payloadHash: string;
  nativeZipHash: string;
  remoteReadback: boolean;
  exactDecryption: boolean;
  schemaRestore: string;
  sourcePDFsCopied: boolean;
}>;

export type DatabaseReceiptBinding = Readonly<{
  receiptFingerprint: string;
  receipt: LegacyDatabaseBackupReceipt;
}>;

export type OwnerArchiveRelocationRecipeBody = Readonly<{
  version: 1;
  wholeRoot: Readonly<{
    sourceId: string;
    sourceParentId: string;
    destinationParentId: string;
    destinationName: string;
    oldBoundary: Readonly<{ rootPath: string; rootId: string }>;
    newRootPath: string;
  }>;
  processing: Readonly<{
    repositoryRelativePath: "processing-artifacts/restic-v1";
    catalogAuthorityDigest: string;
    catalogRevision: number;
    oldBoundary: RemoteBackupBoundary;
    newBoundary: RemoteBackupBoundary;
    artifacts: readonly ArchiveBoundaryRelocationArtifact[];
    artifactBindings: readonly ProcessingArtifactBinding[];
  }>;
  database: Readonly<{
    repositoryRelativePath: "database/restic-v1";
    oldBoundary: RemoteBackupBoundary;
    newBoundary: RemoteBackupBoundary;
    receipts: readonly DatabaseReceiptBinding[];
    selectedNativeRestoreReceiptFingerprint: string;
  }>;
  localBindings: Readonly<{
    previousConfigPath: string;
    proposedConfigPath: string;
    previousConfigText: string;
    proposedConfigText: string;
    previousConfigSha256: string;
    proposedConfigSha256: string;
    previousWatcherId: string;
    previousJournalStateSha256: string;
    databaseReceiptPaths: readonly Readonly<{
      receiptFingerprint: string;
      path: string;
    }>[];
    credentialReferenceFingerprint: string;
  }>;
}>;

export type OwnerArchiveRelocationRecipe = Readonly<{
  recipeHash: string;
  workflowRelocationId: string;
  catalogRelocationId: string;
  watcherResetRequestId: string;
  body: OwnerArchiveRelocationRecipeBody;
}>;

export class OwnerArchiveRelocationRecipeError extends Error {
  constructor(readonly code: "invalid_recipe" | "identity_conflict") {
    super(`Owner archive relocation recipe failed: ${code}`);
    this.name = "OwnerArchiveRelocationRecipeError";
  }
}

function fail(
  code: OwnerArchiveRelocationRecipeError["code"] = "invalid_recipe",
): never {
  throw new OwnerArchiveRelocationRecipeError(code);
}

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    Object.keys(value).some(
      (field) =>
        field === "__proto__" ||
        field === "prototype" ||
        field === "constructor",
    )
  )
    fail();
}

function text(value: unknown, maximum = 1_024): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ||
    value.normalize("NFC") !== value
  )
    fail();
  return value;
}

function sha(value: unknown): string {
  const result = text(value, 64);
  if (!SHA256.test(result)) fail();
  return result;
}

function uuid(value: unknown): string {
  const result = text(value, 36);
  if (!UUID.test(result)) fail();
  return result;
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  )
    fail();
  return value as number;
}

function absolutePath(value: unknown): string {
  const result = text(value, 4_096);
  if (resolve(result) !== result) fail();
  return result;
}

function providerPath(value: unknown): string {
  const result = text(value, 1_024);
  if (
    !result.startsWith("/") ||
    result === "/" ||
    posix.normalize(result) !== result ||
    result.includes("\\")
  )
    fail();
  return result;
}

function remoteRootPath(value: unknown): string {
  const result = text(value, 512);
  if (
    !ROOT_PATH.test(result) ||
    /[:\\]/.test(result) ||
    result
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || part.trim() !== part,
      )
  )
    fail();
  return result;
}

function identifier(value: unknown, maximum = 1_024): string {
  return text(value, maximum);
}

function remoteBoundary(value: unknown): RemoteBackupBoundary {
  const entry = row(value);
  exact(entry, [
    "mode",
    "readiness",
    "backend",
    "remoteName",
    "rootPath",
    "rootDirectoryIdHash",
    "configIdentityFingerprint",
    "repositoryId",
    "resticVersion",
    "rcloneVersion",
  ]);
  if (
    entry.mode !== "independent_backup" ||
    entry.readiness !== "remote_repository_verified" ||
    entry.backend !== "rclone_dropbox_v1" ||
    entry.resticVersion !== RESTIC_VERSION ||
    entry.rcloneVersion !== RCLONE_VERSION
  )
    fail();
  const remoteName = text(entry.remoteName, 64);
  if (!REMOTE_NAME.test(remoteName)) fail();
  return {
    mode: "independent_backup",
    readiness: "remote_repository_verified",
    backend: "rclone_dropbox_v1",
    remoteName,
    rootPath: remoteRootPath(entry.rootPath),
    rootDirectoryIdHash: sha(entry.rootDirectoryIdHash),
    configIdentityFingerprint: sha(entry.configIdentityFingerprint),
    repositoryId: sha(entry.repositoryId),
    resticVersion: RESTIC_VERSION,
    rcloneVersion: RCLONE_VERSION,
  };
}

function sameExceptRootPath(
  before: RemoteBackupBoundary,
  after: RemoteBackupBoundary,
): boolean {
  return (
    before.rootPath !== after.rootPath &&
    before.mode === after.mode &&
    before.readiness === after.readiness &&
    before.backend === after.backend &&
    before.remoteName === after.remoteName &&
    before.rootDirectoryIdHash === after.rootDirectoryIdHash &&
    before.configIdentityFingerprint === after.configIdentityFingerprint &&
    before.repositoryId === after.repositoryId &&
    before.resticVersion === after.resticVersion &&
    before.rcloneVersion === after.rcloneVersion
  );
}

function wholeRoot(
  value: unknown,
): OwnerArchiveRelocationRecipeBody["wholeRoot"] {
  const entry = row(value);
  exact(entry, [
    "sourceId",
    "sourceParentId",
    "destinationParentId",
    "destinationName",
    "oldBoundary",
    "newRootPath",
  ]);
  const old = row(entry.oldBoundary);
  exact(old, ["rootPath", "rootId"]);
  const destinationName = text(entry.destinationName, 255);
  const result = {
    sourceId: identifier(entry.sourceId),
    sourceParentId: identifier(entry.sourceParentId),
    destinationParentId: identifier(entry.destinationParentId),
    destinationName,
    oldBoundary: {
      rootPath: providerPath(old.rootPath),
      rootId: identifier(old.rootId),
    },
    newRootPath: providerPath(entry.newRootPath),
  };
  if (
    result.sourceId !== result.oldBoundary.rootId ||
    result.sourceParentId === result.destinationParentId ||
    destinationName.includes("/") ||
    destinationName === "." ||
    destinationName === ".." ||
    posix.basename(result.newRootPath) !== destinationName ||
    result.oldBoundary.rootPath === result.newRootPath
  )
    fail("identity_conflict");
  return result;
}

function artifact(value: unknown): ArchiveBoundaryRelocationArtifact {
  const entry = row(value);
  exact(entry, [
    "snapshotId",
    "objectName",
    "ciphertextSha256",
    "ciphertextByteLength",
  ]);
  const objectName = text(entry.objectName, 128);
  if (!OBJECT_NAME.test(objectName)) fail();
  return {
    snapshotId: sha(entry.snapshotId),
    objectName,
    ciphertextSha256: sha(entry.ciphertextSha256),
    ciphertextByteLength: integer(
      entry.ciphertextByteLength,
      MAX_ARTIFACT_BYTES,
    ),
  };
}

function processingBinding(value: unknown): ProcessingArtifactBinding {
  const entry = row(value);
  exact(entry, [
    "kind",
    "catalogId",
    "snapshotId",
    "objectName",
    "ciphertextSha256",
    "ciphertextByteLength",
    "plaintextSha256",
    "plaintextByteLength",
  ]);
  if (
    entry.kind !== "original_backup" &&
    entry.kind !== "provider_locator" &&
    entry.kind !== "parser_backup"
  )
    fail();
  const objectName = text(entry.objectName, 128);
  if (!OBJECT_NAME.test(objectName)) fail();
  return {
    kind: entry.kind,
    catalogId: uuid(entry.catalogId),
    snapshotId: sha(entry.snapshotId),
    objectName,
    ciphertextSha256: sha(entry.ciphertextSha256),
    ciphertextByteLength: integer(
      entry.ciphertextByteLength,
      MAX_ARTIFACT_BYTES,
    ),
    plaintextSha256: sha(entry.plaintextSha256),
    plaintextByteLength: integer(entry.plaintextByteLength, MAX_ARTIFACT_BYTES),
  };
}

function legacyReceipt(value: unknown): LegacyDatabaseBackupReceipt {
  const entry = row(value);
  exact(entry, [
    "kind",
    "status",
    "repositoryId",
    "rootDirectoryIdHash",
    "snapshotId",
    "snapshotTag",
    "objectPath",
    "ciphertextHash",
    "ciphertextByteLength",
    "payloadHash",
    "nativeZipHash",
    "remoteReadback",
    "exactDecryption",
    "schemaRestore",
    "sourcePDFsCopied",
  ]);
  if (
    entry.kind !== "native_database_backup_receipt_v1" ||
    typeof entry.remoteReadback !== "boolean" ||
    typeof entry.exactDecryption !== "boolean" ||
    typeof entry.sourcePDFsCopied !== "boolean"
  )
    fail();
  const snapshotTag = text(entry.snapshotTag, 128);
  if (!SNAPSHOT_TAG.test(snapshotTag)) fail();
  const objectPath = providerPath(entry.objectPath);
  return {
    kind: "native_database_backup_receipt_v1",
    status: text(entry.status, 64),
    repositoryId: sha(entry.repositoryId),
    rootDirectoryIdHash: sha(entry.rootDirectoryIdHash),
    snapshotId: sha(entry.snapshotId),
    snapshotTag,
    objectPath,
    ciphertextHash: sha(entry.ciphertextHash),
    ciphertextByteLength: integer(
      entry.ciphertextByteLength,
      MAX_ARTIFACT_BYTES,
    ),
    payloadHash: sha(entry.payloadHash),
    nativeZipHash: sha(entry.nativeZipHash),
    remoteReadback: entry.remoteReadback,
    exactDecryption: entry.exactDecryption,
    schemaRestore: text(entry.schemaRestore, 4_096),
    sourcePDFsCopied: entry.sourcePDFsCopied,
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function receiptFingerprint(receipt: LegacyDatabaseBackupReceipt): string {
  return hash(
    Buffer.concat([
      Buffer.from("native-database-backup-receipt:v1\0", "utf8"),
      Buffer.from(canonicalJson(receipt), "utf8"),
    ]),
  );
}

/** Fingerprint one closed historical receipt. It is identity, not a fresh
 * readback, decryption, or restore assertion. */
export function fingerprintLegacyDatabaseBackupReceipt(value: unknown): string {
  return receiptFingerprint(legacyReceipt(value));
}

function parseJson(textValue: string): unknown {
  if (
    Buffer.byteLength(textValue, "utf8") < 2 ||
    Buffer.byteLength(textValue, "utf8") > CONFIG_TEXT_MAX_BYTES
  )
    fail();
  try {
    return JSON.parse(textValue) as unknown;
  } catch {
    fail();
  }
}

function configText(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") < 2 ||
    Buffer.byteLength(value, "utf8") > CONFIG_TEXT_MAX_BYTES
  )
    fail();
  return value;
}

function boundaryFromConfig(
  value: ReturnType<typeof parseConfig>,
): RemoteBackupBoundary {
  const backup = value.pdfDocQa?.archive.independentBackup;
  const repository = backup?.repository;
  if (!backup || !repository) fail("identity_conflict");
  return {
    mode: "independent_backup",
    readiness: "remote_repository_verified",
    backend: "rclone_dropbox_v1",
    remoteName: repository.remoteName,
    rootPath: repository.rootPath,
    rootDirectoryIdHash: repository.expectedRootDirectoryIdHash,
    configIdentityFingerprint: repository.configIdentityFingerprint,
    repositoryId: backup.expectedRepositoryId,
    resticVersion: RESTIC_VERSION,
    rcloneVersion: RCLONE_VERSION,
  };
}

function expectedLeafRoot(wholeRootPath: string, suffix: string): string {
  return `${wholeRootPath.slice(1)}/${suffix}`;
}

function parseBody(value: unknown): OwnerArchiveRelocationRecipeBody {
  const entry = row(value);
  exact(entry, [
    "version",
    "wholeRoot",
    "processing",
    "database",
    "localBindings",
  ]);
  if (entry.version !== 1) fail();
  const whole = wholeRoot(entry.wholeRoot);

  const processingEntry = row(entry.processing);
  exact(processingEntry, [
    "repositoryRelativePath",
    "catalogAuthorityDigest",
    "catalogRevision",
    "oldBoundary",
    "newBoundary",
    "artifacts",
    "artifactBindings",
  ]);
  if (
    processingEntry.repositoryRelativePath !== "processing-artifacts/restic-v1"
  )
    fail();
  const processingOld = remoteBoundary(processingEntry.oldBoundary);
  const processingNew = remoteBoundary(processingEntry.newBoundary);
  if (!sameExceptRootPath(processingOld, processingNew))
    fail("identity_conflict");
  if (
    !Array.isArray(processingEntry.artifacts) ||
    processingEntry.artifacts.length < 1 ||
    processingEntry.artifacts.length > MAX_PROCESSING_ARTIFACTS
  )
    fail();
  const artifacts = processingEntry.artifacts.map(artifact);
  artifacts.sort((left, right) =>
    `${left.snapshotId}\0${left.objectName}`.localeCompare(
      `${right.snapshotId}\0${right.objectName}`,
    ),
  );
  if (
    !Array.isArray(processingEntry.artifactBindings) ||
    processingEntry.artifactBindings.length < 1 ||
    processingEntry.artifactBindings.length > MAX_PROCESSING_ARTIFACTS
  )
    fail();
  const artifactBindings =
    processingEntry.artifactBindings.map(processingBinding);
  const artifactKeys = artifactBindings.map(
    (binding) => `${binding.snapshotId}\0${binding.objectName}`,
  );
  if (new Set(artifactKeys).size !== artifactKeys.length)
    fail("identity_conflict");
  const relocationByKey = new Map(
    artifacts.map((item) => [
      `${item.snapshotId}\0${item.objectName}`,
      canonicalJson(item),
    ]),
  );
  if (
    relocationByKey.size !== artifacts.length ||
    artifactBindings.length !== artifacts.length ||
    artifactBindings.some((binding) => {
      const {
        kind: _kind,
        catalogId: _catalogId,
        plaintextSha256: _hash,
        plaintextByteLength: _length,
        ...ciphertext
      } = binding;
      return (
        relocationByKey.get(`${binding.snapshotId}\0${binding.objectName}`) !==
        canonicalJson(ciphertext)
      );
    })
  )
    fail("identity_conflict");
  artifactBindings.sort((left, right) =>
    `${left.snapshotId}\0${left.objectName}`.localeCompare(
      `${right.snapshotId}\0${right.objectName}`,
    ),
  );

  const databaseEntry = row(entry.database);
  exact(databaseEntry, [
    "repositoryRelativePath",
    "oldBoundary",
    "newBoundary",
    "receipts",
    "selectedNativeRestoreReceiptFingerprint",
  ]);
  if (databaseEntry.repositoryRelativePath !== "database/restic-v1") fail();
  const databaseOld = remoteBoundary(databaseEntry.oldBoundary);
  const databaseNew = remoteBoundary(databaseEntry.newBoundary);
  if (!sameExceptRootPath(databaseOld, databaseNew)) fail("identity_conflict");
  if (
    databaseOld.remoteName !== processingOld.remoteName ||
    databaseOld.configIdentityFingerprint !==
      processingOld.configIdentityFingerprint ||
    databaseOld.backend !== processingOld.backend ||
    databaseOld.resticVersion !== processingOld.resticVersion ||
    databaseOld.rcloneVersion !== processingOld.rcloneVersion
  )
    fail("identity_conflict");
  if (
    !Array.isArray(databaseEntry.receipts) ||
    databaseEntry.receipts.length < 1 ||
    databaseEntry.receipts.length > MAX_DATABASE_RECEIPTS
  )
    fail();
  const receipts = databaseEntry.receipts.map((value) => {
    const binding = row(value);
    exact(binding, ["receiptFingerprint", "receipt"]);
    const receipt = legacyReceipt(binding.receipt);
    const fingerprint = sha(binding.receiptFingerprint);
    if (
      fingerprint !== receiptFingerprint(receipt) ||
      receipt.repositoryId !== databaseOld.repositoryId ||
      receipt.rootDirectoryIdHash !== databaseOld.rootDirectoryIdHash
    )
      fail("identity_conflict");
    return { receiptFingerprint: fingerprint, receipt };
  });
  const receiptIds = receipts.map((receipt) => receipt.receiptFingerprint);
  const snapshotPaths = receipts.map(
    ({ receipt }) => `${receipt.snapshotId}\0${receipt.objectPath}`,
  );
  if (
    new Set(receiptIds).size !== receiptIds.length ||
    new Set(snapshotPaths).size !== snapshotPaths.length
  )
    fail("identity_conflict");
  receipts.sort((left, right) =>
    left.receiptFingerprint.localeCompare(right.receiptFingerprint),
  );
  const selectedNativeRestoreReceiptFingerprint = sha(
    databaseEntry.selectedNativeRestoreReceiptFingerprint,
  );
  if (!receiptIds.includes(selectedNativeRestoreReceiptFingerprint))
    fail("identity_conflict");

  const localEntry = row(entry.localBindings);
  exact(localEntry, [
    "previousConfigPath",
    "proposedConfigPath",
    "previousConfigText",
    "proposedConfigText",
    "previousConfigSha256",
    "proposedConfigSha256",
    "previousWatcherId",
    "previousJournalStateSha256",
    "databaseReceiptPaths",
    "credentialReferenceFingerprint",
  ]);
  const previousConfigPath = absolutePath(localEntry.previousConfigPath);
  const proposedConfigPath = absolutePath(localEntry.proposedConfigPath);
  if (previousConfigPath === proposedConfigPath) fail("identity_conflict");
  const previousConfigText = configText(localEntry.previousConfigText);
  const proposedConfigText = configText(localEntry.proposedConfigText);
  const previousConfigSha256 = sha(localEntry.previousConfigSha256);
  const proposedConfigSha256 = sha(localEntry.proposedConfigSha256);
  if (
    hash(previousConfigText) !== previousConfigSha256 ||
    hash(proposedConfigText) !== proposedConfigSha256
  )
    fail("identity_conflict");
  const previousConfigValue = parseJson(previousConfigText);
  const proposedConfigValue = parseJson(proposedConfigText);
  validateArchiveRelocationConfig(previousConfigValue, proposedConfigValue);
  const previousConfig = parseConfig(previousConfigValue);
  const proposedConfig = parseConfig(proposedConfigValue);
  const expectedProcessingOld = boundaryFromConfig(previousConfig);
  const expectedProcessingNew = boundaryFromConfig(proposedConfig);
  if (
    canonicalJson(expectedProcessingOld) !== canonicalJson(processingOld) ||
    canonicalJson(expectedProcessingNew) !== canonicalJson(processingNew)
  )
    fail("identity_conflict");

  if (
    processingOld.rootPath !==
      expectedLeafRoot(
        whole.oldBoundary.rootPath,
        "processing-artifacts/restic-v1",
      ) ||
    processingNew.rootPath !==
      expectedLeafRoot(whole.newRootPath, "processing-artifacts/restic-v1") ||
    databaseOld.rootPath !==
      expectedLeafRoot(whole.oldBoundary.rootPath, "database/restic-v1") ||
    databaseNew.rootPath !==
      expectedLeafRoot(whole.newRootPath, "database/restic-v1")
  )
    fail("identity_conflict");

  if (
    !Array.isArray(localEntry.databaseReceiptPaths) ||
    localEntry.databaseReceiptPaths.length !== receipts.length
  )
    fail();
  const databaseReceiptPaths = localEntry.databaseReceiptPaths.map((value) => {
    const binding = row(value);
    exact(binding, ["receiptFingerprint", "path"]);
    return {
      receiptFingerprint: sha(binding.receiptFingerprint),
      path: absolutePath(binding.path),
    };
  });
  const pathFingerprints = databaseReceiptPaths.map(
    ({ receiptFingerprint: fingerprint }) => fingerprint,
  );
  if (
    new Set(pathFingerprints).size !== pathFingerprints.length ||
    new Set(databaseReceiptPaths.map(({ path }) => path)).size !==
      databaseReceiptPaths.length ||
    pathFingerprints.some((fingerprint) => !receiptIds.includes(fingerprint))
  )
    fail("identity_conflict");
  databaseReceiptPaths.sort((left, right) =>
    left.receiptFingerprint.localeCompare(right.receiptFingerprint),
  );

  return {
    version: 1,
    wholeRoot: whole,
    processing: {
      repositoryRelativePath: "processing-artifacts/restic-v1",
      catalogAuthorityDigest: sha(processingEntry.catalogAuthorityDigest),
      catalogRevision: integer(processingEntry.catalogRevision),
      oldBoundary: processingOld,
      newBoundary: processingNew,
      artifacts,
      artifactBindings,
    },
    database: {
      repositoryRelativePath: "database/restic-v1",
      oldBoundary: databaseOld,
      newBoundary: databaseNew,
      receipts,
      selectedNativeRestoreReceiptFingerprint,
    },
    localBindings: {
      previousConfigPath,
      proposedConfigPath,
      previousConfigText,
      proposedConfigText,
      previousConfigSha256,
      proposedConfigSha256,
      previousWatcherId: uuid(localEntry.previousWatcherId),
      previousJournalStateSha256: sha(localEntry.previousJournalStateSha256),
      databaseReceiptPaths,
      credentialReferenceFingerprint: sha(
        localEntry.credentialReferenceFingerprint,
      ),
    },
  };
}

function uuidBytes(value: string): Buffer {
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function uuidV5(namespace: string, name: string): string {
  const digest = createHash("sha1")
    .update(uuidBytes(namespace))
    .update(name, "utf8")
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function derive(body: OwnerArchiveRelocationRecipeBody): {
  recipeHash: string;
  workflowRelocationId: string;
  catalogRelocationId: string;
  watcherResetRequestId: string;
} {
  const encoded = Buffer.from(canonicalJson(body), "utf8");
  if (encoded.byteLength > MAX_RECIPE_BYTES) fail();
  const recipeHash = hash(
    Buffer.concat([
      Buffer.from("owner-archive-relocation-recipe:v1\0", "utf8"),
      encoded,
    ]),
  );
  return {
    recipeHash,
    workflowRelocationId: uuidV5(
      OWNER_ARCHIVE_RELOCATION_NAMESPACE,
      `${recipeHash}:whole-root-workflow`,
    ),
    catalogRelocationId: uuidV5(
      OWNER_ARCHIVE_RELOCATION_NAMESPACE,
      `${recipeHash}:processing-catalog-relocation`,
    ),
    watcherResetRequestId: uuidV5(
      OWNER_ARCHIVE_RELOCATION_NAMESPACE,
      `${recipeHash}:owner-watcher-reset`,
    ),
  };
}

/**
 * Prepare one recipe while the original journal and catalog are held. The
 * caller supplies the intended complete artifact set; authority, revision,
 * watcher, and journal-state identities are derived from the held objects.
 */
export async function prepareOwnerArchiveRelocationRecipe(
  value: unknown,
  args: {
    journal: Journal<JsonValue, JsonValue>;
    catalog: ArchiveCatalog;
  },
): Promise<OwnerArchiveRelocationRecipe> {
  try {
    const draft = row(value);
    exact(draft, [
      "version",
      "wholeRoot",
      "processing",
      "database",
      "localBindings",
    ]);
    const processing = row(draft.processing);
    exact(processing, [
      "repositoryRelativePath",
      "oldBoundary",
      "newBoundary",
      "artifacts",
      "artifactBindings",
    ]);
    const local = row(draft.localBindings);
    exact(local, [
      "previousConfigPath",
      "proposedConfigPath",
      "previousConfigText",
      "proposedConfigText",
      "previousConfigSha256",
      "proposedConfigSha256",
      "databaseReceiptPaths",
      "credentialReferenceFingerprint",
    ]);
    const previousConfigText = configText(local.previousConfigText);
    const proposedConfigText = configText(local.proposedConfigText);
    const previousConfig = parseJson(previousConfigText);
    const proposedConfig = parseJson(proposedConfigText);
    const status = await args.journal.archiveRelocationRebindStatus({
      previousConfig,
      proposedConfig,
    });
    if (
      status.state !== "previous" ||
      args.journal.credentialStatus !== "current"
    )
      fail("identity_conflict");
    const provisional = parseBody({
      ...draft,
      processing: {
        ...processing,
        catalogAuthorityDigest: "0".repeat(64),
        catalogRevision: 1,
      },
      localBindings: {
        ...local,
        previousWatcherId: args.journal.watcherId,
        previousJournalStateSha256: status.stateSha256,
      },
    });
    const snapshot = await args.catalog.snapshotRemoteBoundaryForRelocation({
      expectedJournal: args.journal,
      oldBoundary: provisional.processing.oldBoundary,
      newBoundary: provisional.processing.newBoundary,
    });
    if (
      canonicalJson(snapshot.oldBoundary) !==
        canonicalJson(provisional.processing.oldBoundary) ||
      canonicalJson(snapshot.artifacts) !==
        canonicalJson(provisional.processing.artifacts) ||
      canonicalJson(snapshot.artifactBindings) !==
        canonicalJson(provisional.processing.artifactBindings)
    )
      fail("identity_conflict");
    const body = parseBody({
      ...provisional,
      processing: {
        ...provisional.processing,
        catalogAuthorityDigest: snapshot.authorityDigest,
        catalogRevision: snapshot.catalogRevision,
      },
    });
    return { ...derive(body), body };
  } catch (error) {
    if (error instanceof OwnerArchiveRelocationRecipeError) throw error;
    fail();
  }
}

export function parseOwnerArchiveRelocationRecipe(
  value: unknown,
): OwnerArchiveRelocationRecipe {
  try {
    const entry = row(value);
    exact(entry, [
      "recipeHash",
      "workflowRelocationId",
      "catalogRelocationId",
      "watcherResetRequestId",
      "body",
    ]);
    const body = parseBody(entry.body);
    const derived = derive(body);
    if (
      sha(entry.recipeHash) !== derived.recipeHash ||
      uuid(entry.workflowRelocationId) !== derived.workflowRelocationId ||
      uuid(entry.catalogRelocationId) !== derived.catalogRelocationId ||
      uuid(entry.watcherResetRequestId) !== derived.watcherResetRequestId
    )
      fail("identity_conflict");
    return { ...derived, body };
  } catch (error) {
    if (error instanceof OwnerArchiveRelocationRecipeError) throw error;
    fail();
  }
}

export function relocationIntentFromRecipe(
  recipe: OwnerArchiveRelocationRecipe,
): RelocationIntent {
  const parsed = parseOwnerArchiveRelocationRecipe(recipe);
  return {
    relocationId: parsed.workflowRelocationId,
    ...parsed.body.wholeRoot,
  };
}
