import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, join } from "node:path";

import type {
  ArchiveBoundaryRelocation,
  ArchiveBoundaryRelocationArtifact,
  ArchiveBoundaryRelocationArtifactBinding,
  ArchiveBoundaryRelocationPreparation,
  ArchiveCatalogSnapshot,
  ArchiveCopyRecord,
  ArchiveDeletionTarget,
  ArchiveSubject,
  DurableParserOutput,
  LocalFileIdentity,
  OriginalCatalogIdentity,
  OriginalCatalogRow,
  OriginalReuseIdentity,
  ProcessingCatalogIdentity,
  ProcessingCatalogRow,
} from "./archiveCatalogTypes.js";
import {
  ArchiveBoundaryRelocationError,
  assertRootPathOnlyBoundaryRelocation,
  relocationAuthorizesArtifact,
} from "./archiveBoundaryRelocation.js";
import type {
  PreparedAgeObject,
  PublishedAgeObject,
  RecoveredResticBackup,
  RemoteBackupBoundary,
  ResticBackupResult,
} from "./archiveTypes.js";
import { Journal } from "./journal.js";
import type { JsonValue } from "./journalTypes.js";

const CATALOG_FILE = "archive-catalog.json";
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 48;
const MAX_JSON_NODES = 100_000;
const MAX_ORIGINALS = 256;
const MAX_PROCESSINGS = 512;
const MAX_BOUNDARY_RELOCATIONS = 16;
const MAX_DIRECTORY_ENTRIES = 64;
const TEMP_FILE = /^\.archive-catalog\.json\.[0-9a-f-]{36}\.tmp$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const OPAQUE_NAME =
  /^(?:[0-9a-f-]{36}(?:\.age|\.json|\.tmp)?|lossless\.json|bundle\.json|\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.tmp)$/;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export type ArchiveCatalogFailureCode =
  | "invalid_input"
  | "unsafe_store"
  | "catalog_invalid"
  | "catalog_capacity_exceeded"
  | "catalog_conflict"
  | "catalog_not_found"
  | "invalid_transition"
  | "durability_failed";

export class ArchiveCatalogError extends Error {
  constructor(readonly code: ArchiveCatalogFailureCode) {
    super(`Archive catalog failed: ${code}`);
    this.name = "ArchiveCatalogError";
  }
}

type DirectoryIdentity = { path: string; device: number; inode: number };

function fail(code: ArchiveCatalogFailureCode): never {
  throw new ArchiveCatalogError(code);
}

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("catalog_invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail("catalog_invalid");
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !own(value, key)) ||
    Object.keys(value).some(
      (key) =>
        !allowed.has(key) ||
        key === "__proto__" ||
        key === "prototype" ||
        key === "constructor",
    )
  )
    fail("catalog_invalid");
}

function string(value: unknown, maximum: number, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    (pattern !== undefined && !pattern.test(value))
  )
    fail("catalog_invalid");
  return value;
}

function integer(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  )
    fail("catalog_invalid");
  return value as number;
}

function uuid(value: unknown): string {
  return string(value, 36, UUID);
}

function id(value: unknown): string {
  return string(value, 256, ID);
}

function sha(value: unknown): string {
  return string(value, 64, SHA256);
}

function normalizeJson(value: unknown): unknown {
  let nodes = 0;
  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH)
      fail("catalog_capacity_exceeded");
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    )
      return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail("catalog_invalid");
      return current;
    }
    if (Array.isArray(current))
      return current.map((entry) => visit(entry, depth + 1));
    const record = object(current);
    const result = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) {
      if (
        key === "__proto__" ||
        key === "prototype" ||
        key === "constructor" ||
        Buffer.byteLength(key, "utf8") > 256
      )
        fail("catalog_invalid");
      Object.defineProperty(result, key, {
        enumerable: true,
        value: visit(entry, depth + 1),
      });
    }
    return result;
  };
  return visit(value, 0);
}

function hashLength(value: unknown): { sha256: string; byteLength: number } {
  const row = object(value);
  exact(row, ["sha256", "byteLength"]);
  return {
    sha256: sha(row.sha256),
    byteLength: integer(row.byteLength, 1, 70 * 1024 * 1024),
  };
}

function directoryIdentity(value: unknown): { device: number; inode: number } {
  const row = object(value);
  exact(row, ["device", "inode"]);
  return {
    device: integer(row.device),
    inode: integer(row.inode, 1),
  };
}

function localFile(value: unknown): LocalFileIdentity {
  const row = object(value);
  exact(row, ["opaqueName", "device", "inode", "sha256", "byteLength"]);
  return {
    opaqueName: string(row.opaqueName, 96, OPAQUE_NAME),
    device: integer(row.device),
    inode: integer(row.inode, 1),
    sha256: sha(row.sha256),
    byteLength: integer(row.byteLength, 1, 70 * 1024 * 1024),
  };
}

function archiveCopyIntent(value: unknown, expectedRole?: string) {
  const row = object(value);
  exact(
    row,
    [
      "role",
      "clientReceiptId",
      "archiveObjectId",
      "objectName",
      "archiveIdentityFingerprint",
      "archiveProfileFingerprint",
      "recipientFingerprint",
      "repositoryKeyDomainFingerprint",
      "storageFailureDomainFingerprint",
    ],
    ["restic"],
  );
  if (
    (row.role !== "primary" && row.role !== "independent_backup") ||
    (expectedRole !== undefined && row.role !== expectedRole)
  )
    fail("catalog_invalid");
  const restic =
    row.restic === undefined
      ? undefined
      : (() => {
          const entry = object(row.restic);
          exact(entry, ["operationId", "host", "repositoryId"]);
          return {
            operationId: uuid(entry.operationId),
            host: id(entry.host),
            repositoryId: string(entry.repositoryId, 128, ID),
          };
        })();
  if (
    (row.role === "primary" && restic !== undefined) ||
    (row.role === "independent_backup" && restic === undefined) ||
    row.objectName !== `${row.archiveObjectId}.age`
  )
    fail("catalog_invalid");
  return {
    role: row.role as "primary" | "independent_backup",
    clientReceiptId: uuid(row.clientReceiptId),
    archiveObjectId: uuid(row.archiveObjectId),
    objectName: string(row.objectName, 48, OPAQUE_NAME),
    archiveIdentityFingerprint: sha(row.archiveIdentityFingerprint),
    archiveProfileFingerprint: sha(row.archiveProfileFingerprint),
    recipientFingerprint: sha(row.recipientFingerprint),
    repositoryKeyDomainFingerprint: sha(row.repositoryKeyDomainFingerprint),
    storageFailureDomainFingerprint: sha(row.storageFailureDomainFingerprint),
    ...(restic === undefined ? {} : { restic }),
  };
}

function prepared(value: unknown) {
  const row = object(value);
  exact(row, [
    "state",
    "tempName",
    "source",
    "ciphertext",
    "ciphertextDevice",
    "ciphertextInode",
    "archiveDirectoryDevice",
    "archiveDirectoryInode",
    "ageVersion",
  ]);
  if (row.state !== "prepared" || row.ageVersion !== "v1.3.2")
    fail("catalog_invalid");
  return {
    state: "prepared" as const,
    tempName: string(row.tempName, 48, OPAQUE_NAME),
    source: hashLength(row.source),
    ciphertext: hashLength(row.ciphertext),
    ciphertextDevice: integer(row.ciphertextDevice),
    ciphertextInode: integer(row.ciphertextInode, 1),
    archiveDirectoryDevice: integer(row.archiveDirectoryDevice),
    archiveDirectoryInode: integer(row.archiveDirectoryInode, 1),
    ageVersion: "v1.3.2" as const,
  };
}

function published(value: unknown) {
  const row = object(value);
  exact(row, [
    "state",
    "source",
    "ciphertext",
    "ciphertextDevice",
    "ciphertextInode",
    "ageVersion",
  ]);
  if (row.state !== "published" || row.ageVersion !== "v1.3.2")
    fail("catalog_invalid");
  return {
    state: "published" as const,
    source: hashLength(row.source),
    ciphertext: hashLength(row.ciphertext),
    ciphertextDevice: integer(row.ciphertextDevice),
    ciphertextInode: integer(row.ciphertextInode, 1),
    ageVersion: "v1.3.2" as const,
  };
}

function backup(value: unknown): ResticBackupResult | RecoveredResticBackup {
  const row = object(value);
  exact(
    row,
    [
      "operationId",
      "snapshotId",
      "objectName",
      "ciphertext",
      "resticVersion",
      "repositoryId",
      "verification",
    ],
    ["boundary", "matchingSnapshotCount"],
  );
  if (
    row.resticVersion !== "0.19.1" ||
    row.verification !== "destination_ciphertext_readback" ||
    (!own(row, "boundary") && !own(row, "matchingSnapshotCount"))
  )
    fail("catalog_invalid");
  const base = {
    operationId: uuid(row.operationId),
    snapshotId: string(row.snapshotId, 128, ID),
    objectName: string(row.objectName, 48, OPAQUE_NAME),
    ciphertext: hashLength(row.ciphertext),
    resticVersion: "0.19.1" as const,
    repositoryId: string(row.repositoryId, 128, ID),
    verification: "destination_ciphertext_readback" as const,
  };
  if (row.matchingSnapshotCount !== undefined) {
    if (row.matchingSnapshotCount !== 1) fail("catalog_invalid");
    return {
      ...base,
      matchingSnapshotCount: 1,
      ...(row.boundary === undefined
        ? {}
        : { boundary: remoteBoundary(row.boundary, base.repositoryId) }),
    };
  }
  const boundary = object(row.boundary);
  if (boundary.backend === "rclone_dropbox_v1") {
    return { ...base, boundary: remoteBoundary(boundary, base.repositoryId) };
  }
  exact(boundary, ["mode", "readiness", "primaryDevice", "backupDevice"]);
  if (
    (boundary.mode !== "synthetic" && boundary.mode !== "independent_backup") ||
    (boundary.readiness !== "synthetic_only" &&
      boundary.readiness !== "different_device_unverified")
  )
    fail("catalog_invalid");
  return {
    ...base,
    boundary: {
      mode: boundary.mode,
      readiness: boundary.readiness,
      primaryDevice: integer(boundary.primaryDevice),
      backupDevice: integer(boundary.backupDevice),
    },
  };
}

function remoteBoundary(value: unknown, repositoryId: string) {
  const boundary = object(value);
  exact(boundary, [
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
    boundary.mode !== "independent_backup" ||
    boundary.readiness !== "remote_repository_verified" ||
    boundary.backend !== "rclone_dropbox_v1" ||
    boundary.repositoryId !== repositoryId ||
    boundary.resticVersion !== "0.19.1" ||
    boundary.rcloneVersion !== "v1.74.4"
  )
    fail("catalog_invalid");
  const rootPath = string(boundary.rootPath, 512);
  if (
    !/^[A-Za-z0-9 _.-]+(?:\/[A-Za-z0-9 _.-]+)+$/.test(rootPath) ||
    /[:\\]/.test(rootPath) ||
    rootPath
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || part.trim() !== part,
      )
  )
    fail("catalog_invalid");
  return {
    mode: "independent_backup" as const,
    readiness: "remote_repository_verified" as const,
    backend: "rclone_dropbox_v1" as const,
    remoteName: string(boundary.remoteName, 64, /^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    rootPath,
    rootDirectoryIdHash: string(
      boundary.rootDirectoryIdHash,
      64,
      /^[a-f0-9]{64}$/,
    ),
    configIdentityFingerprint: string(
      boundary.configIdentityFingerprint,
      64,
      /^[a-f0-9]{64}$/,
    ),
    repositoryId,
    resticVersion: "0.19.1" as const,
    rcloneVersion: "v1.74.4" as const,
  };
}

function relocationArtifact(value: unknown): ArchiveBoundaryRelocationArtifact {
  const row = object(value);
  exact(row, [
    "snapshotId",
    "objectName",
    "ciphertextSha256",
    "ciphertextByteLength",
  ]);
  return {
    snapshotId: sha(row.snapshotId),
    objectName: string(row.objectName, 128, OPAQUE_NAME),
    ciphertextSha256: sha(row.ciphertextSha256),
    ciphertextByteLength: integer(
      row.ciphertextByteLength,
      1,
      64 * 1024 * 1024,
    ),
  };
}

function boundaryRelocation(value: unknown): ArchiveBoundaryRelocation {
  const row = object(value);
  exact(row, [
    "relocationId",
    "oldBoundary",
    "newBoundary",
    "artifacts",
    "verifiedAt",
  ]);
  if (!Array.isArray(row.artifacts) || row.artifacts.length > 2_048)
    fail("catalog_invalid");
  const oldRecord = object(row.oldBoundary);
  const newRecord = object(row.newBoundary);
  const oldRepositoryId = sha(oldRecord.repositoryId);
  const newRepositoryId = sha(newRecord.repositoryId);
  if (oldRepositoryId !== newRepositoryId) fail("catalog_invalid");
  try {
    return assertRootPathOnlyBoundaryRelocation({
      relocationId: uuid(row.relocationId),
      oldBoundary: remoteBoundary(oldRecord, oldRepositoryId),
      newBoundary: remoteBoundary(newRecord, newRepositoryId),
      artifacts: row.artifacts.map(relocationArtifact),
      verifiedAt: integer(row.verifiedAt),
    });
  } catch (error) {
    if (error instanceof ArchiveBoundaryRelocationError)
      fail("catalog_invalid");
    throw error;
  }
}

function deletion(value: unknown) {
  const row = object(value);
  const optional = ["forgetEpoch", "receiptRequestDigest"];
  if (row.state === "pending") {
    exact(row, ["state", "deletionId", "reason", "plannedAt"], optional);
    if (row.reason !== "forget" && row.reason !== "verified_orphan")
      fail("catalog_invalid");
    if (
      (row.reason === "forget") !== (row.forgetEpoch !== undefined) ||
      (row.receiptRequestDigest !== undefined && row.reason !== "forget")
    )
      fail("catalog_invalid");
    return {
      state: "pending" as const,
      deletionId: uuid(row.deletionId),
      reason: row.reason as "forget" | "verified_orphan",
      plannedAt: integer(row.plannedAt),
      ...(row.forgetEpoch === undefined
        ? {}
        : { forgetEpoch: integer(row.forgetEpoch, 1) }),
      ...(row.receiptRequestDigest === undefined
        ? {}
        : { receiptRequestDigest: sha(row.receiptRequestDigest) }),
    };
  }
  if (row.state === "complete") {
    exact(
      row,
      ["state", "deletionId", "reason", "plannedAt", "completedAt", "object"],
      ["backup", "forgetEpoch", "receiptRequestDigest"],
    );
    if (
      (row.reason !== "forget" && row.reason !== "verified_orphan") ||
      !["deleted", "already_missing"].includes(String(row.object)) ||
      (row.backup !== undefined &&
        !["deleted", "already_missing"].includes(String(row.backup))) ||
      (row.reason === "forget") !== (row.forgetEpoch !== undefined) ||
      (row.receiptRequestDigest !== undefined && row.reason !== "forget")
    )
      fail("catalog_invalid");
    const plannedAt = integer(row.plannedAt);
    const completedAt = integer(row.completedAt);
    if (completedAt < plannedAt) fail("catalog_invalid");
    return {
      state: "complete" as const,
      deletionId: uuid(row.deletionId),
      reason: row.reason as "forget" | "verified_orphan",
      plannedAt,
      completedAt,
      object: row.object as "deleted" | "already_missing",
      ...(row.backup === undefined
        ? {}
        : { backup: row.backup as "deleted" | "already_missing" }),
      ...(row.forgetEpoch === undefined
        ? {}
        : { forgetEpoch: integer(row.forgetEpoch, 1) }),
      ...(row.receiptRequestDigest === undefined
        ? {}
        : { receiptRequestDigest: sha(row.receiptRequestDigest) }),
    };
  }
  fail("catalog_invalid");
}

function archiveCopy(value: unknown, role: "primary" | "independent_backup") {
  const row = object(value);
  exact(
    row,
    [
      "role",
      "clientReceiptId",
      "archiveObjectId",
      "objectName",
      "archiveIdentityFingerprint",
      "archiveProfileFingerprint",
      "recipientFingerprint",
      "repositoryKeyDomainFingerprint",
      "storageFailureDomainFingerprint",
    ],
    [
      "restic",
      "preparationIntent",
      "prepared",
      "published",
      "backup",
      "readbackVerifiedAt",
      "cloudReceipt",
      "deletion",
      "reviewCode",
    ],
  );
  const intent = archiveCopyIntent(
    {
      role: row.role,
      clientReceiptId: row.clientReceiptId,
      archiveObjectId: row.archiveObjectId,
      objectName: row.objectName,
      archiveIdentityFingerprint: row.archiveIdentityFingerprint,
      archiveProfileFingerprint: row.archiveProfileFingerprint,
      recipientFingerprint: row.recipientFingerprint,
      repositoryKeyDomainFingerprint: row.repositoryKeyDomainFingerprint,
      storageFailureDomainFingerprint: row.storageFailureDomainFingerprint,
      ...(row.restic === undefined ? {} : { restic: row.restic }),
    },
    role,
  );
  const result: ArchiveCopyRecord = { ...intent };
  if (row.preparationIntent !== undefined) {
    const preparationIntent = object(row.preparationIntent);
    exact(preparationIntent, ["tempName"]);
    result.preparationIntent = {
      tempName: string(preparationIntent.tempName, 48, OPAQUE_NAME),
    };
  }
  if (row.prepared !== undefined) result.prepared = prepared(row.prepared);
  if (row.published !== undefined) result.published = published(row.published);
  if (row.backup !== undefined) result.backup = backup(row.backup);
  if (row.readbackVerifiedAt !== undefined)
    result.readbackVerifiedAt = integer(row.readbackVerifiedAt);
  if (row.cloudReceipt !== undefined) {
    const receipt = object(row.cloudReceipt);
    exact(receipt, ["receiptId", "requestDigest", "recordedAt"]);
    result.cloudReceipt = {
      receiptId: id(receipt.receiptId),
      requestDigest: sha(receipt.requestDigest),
      recordedAt: integer(receipt.recordedAt),
    };
  }
  if (row.deletion !== undefined) result.deletion = deletion(row.deletion);
  if (row.reviewCode !== undefined) {
    const code = string(row.reviewCode, 64, SAFE_CODE);
    if (
      ![
        "ambiguous_recovery",
        "identity_conflict",
        "replacement_detected",
        "delete_failed",
      ].includes(code)
    )
      fail("catalog_invalid");
    result.reviewCode = code as ArchiveCopyRecord["reviewCode"];
  }
  if (
    result.prepared &&
    (!result.preparationIntent ||
      result.prepared.tempName !== result.preparationIntent.tempName)
  )
    fail("catalog_invalid");
  if (result.published && !result.prepared) fail("catalog_invalid");
  if (result.backup && (role !== "independent_backup" || !result.published))
    fail("catalog_invalid");
  if (
    (role === "primary" && result.published !== undefined) !==
      (role === "primary" && result.readbackVerifiedAt !== undefined) ||
    (role === "independent_backup" && result.backup !== undefined) !==
      (role === "independent_backup" && result.readbackVerifiedAt !== undefined)
  )
    fail("catalog_invalid");
  if (result.cloudReceipt && !result.published) fail("catalog_invalid");
  if (result.deletion && !result.published) fail("catalog_invalid");
  if (
    result.deletion?.state === "complete" &&
    (role === "independent_backup") !== (result.deletion.backup !== undefined)
  )
    fail("catalog_invalid");
  return result;
}

function copyPair(value: unknown) {
  const row = object(value);
  exact(row, ["primary", "independent_backup"]);
  const primary = archiveCopy(row.primary, "primary");
  const independent_backup = archiveCopy(
    row.independent_backup,
    "independent_backup",
  );
  if (
    primary.recipientFingerprint === independent_backup.recipientFingerprint ||
    primary.archiveIdentityFingerprint ===
      independent_backup.archiveIdentityFingerprint ||
    primary.repositoryKeyDomainFingerprint ===
      independent_backup.repositoryKeyDomainFingerprint ||
    primary.storageFailureDomainFingerprint ===
      independent_backup.storageFailureDomainFingerprint
  )
    fail("catalog_invalid");
  return { primary, independent_backup };
}

function originalCopies(value: unknown, provider: boolean) {
  const row = object(value);
  if (provider) {
    exact(row, ["primary"]);
    return { primary: archiveCopy(row.primary, "primary") } as {
      primary: ArchiveCopyRecord;
      independent_backup: never;
    };
  }
  return copyPair(row);
}

function providerOriginal(value: unknown) {
  const row = object(value);
  exact(row, ["clientReferenceId", "bindingId", "locator"], ["verified"]);
  const result: NonNullable<OriginalCatalogRow["providerOriginal"]> = {
    clientReferenceId: uuid(row.clientReferenceId),
    bindingId: uuid(row.bindingId),
    locator: archiveCopy(row.locator, "independent_backup"),
  };
  if (row.verified !== undefined) {
    const verified = object(row.verified);
    exact(verified, [
      "providerAccountIdHash",
      "providerRootDirectoryIdHash",
      "providerFileIdHash",
      "providerRevision",
      "providerContentHash",
      "sourceContentHash",
      "sourceByteLength",
      "verifiedAt",
      "manifestFingerprint",
      "manifestByteLength",
    ]);
    result.verified = {
      providerAccountIdHash: sha(verified.providerAccountIdHash),
      providerRootDirectoryIdHash: sha(verified.providerRootDirectoryIdHash),
      providerFileIdHash: sha(verified.providerFileIdHash),
      providerRevision: string(
        verified.providerRevision,
        128,
        /^[\x21-\x7e]+$/,
      ),
      providerContentHash: sha(verified.providerContentHash),
      sourceContentHash: sha(verified.sourceContentHash),
      sourceByteLength: integer(verified.sourceByteLength, 1, 64 * 1024 * 1024),
      verifiedAt: integer(verified.verifiedAt),
      manifestFingerprint: sha(verified.manifestFingerprint),
      manifestByteLength: integer(verified.manifestByteLength, 1, 32 * 1024),
    };
  }
  return result;
}

function durableParserOutput(value: unknown): DurableParserOutput {
  const row = object(value);
  exact(row, [
    "outputId",
    "outputRoot",
    "outputDirectory",
    "sourceSha256",
    "rawArtifact",
    "normalizedBundle",
    "parserFingerprint",
    "extractionConfigurationFingerprint",
    "extractionFingerprint",
    "modelManifestSha256",
    "pageCount",
  ]);
  const raw = object(row.rawArtifact);
  const bundle = object(row.normalizedBundle);
  exact(raw, [
    "opaqueName",
    "device",
    "inode",
    "sha256",
    "byteLength",
    "mediaType",
  ]);
  exact(bundle, [
    "opaqueName",
    "device",
    "inode",
    "sha256",
    "byteLength",
    "mediaType",
  ]);
  if (
    raw.mediaType !== "application/vnd.docling+json" ||
    bundle.mediaType !== "application/json"
  )
    fail("catalog_invalid");
  return {
    outputId: uuid(row.outputId),
    outputRoot: directoryIdentity(row.outputRoot),
    outputDirectory: directoryIdentity(row.outputDirectory),
    sourceSha256: sha(row.sourceSha256),
    rawArtifact: {
      ...localFile({
        opaqueName: raw.opaqueName,
        device: raw.device,
        inode: raw.inode,
        sha256: raw.sha256,
        byteLength: raw.byteLength,
      }),
      mediaType: "application/vnd.docling+json",
    },
    normalizedBundle: {
      ...localFile({
        opaqueName: bundle.opaqueName,
        device: bundle.device,
        inode: bundle.inode,
        sha256: bundle.sha256,
        byteLength: bundle.byteLength,
      }),
      mediaType: "application/json",
    },
    parserFingerprint: sha(row.parserFingerprint),
    extractionConfigurationFingerprint: sha(
      row.extractionConfigurationFingerprint,
    ),
    extractionFingerprint: sha(row.extractionFingerprint),
    modelManifestSha256: sha(row.modelManifestSha256),
    pageCount: integer(row.pageCount, 1, 64),
  };
}

function originalRow(value: unknown): OriginalCatalogRow {
  const row = object(value);
  exact(
    row,
    [
      "originalCatalogId",
      "sourceExternalId",
      "origin",
      "copies",
      "createdAt",
      "rowRevision",
      "updatedAt",
    ],
    ["cloud", "providerOriginal"],
  );
  const origin = object(row.origin);
  exact(origin, [
    "scanId",
    "observationEpoch",
    "sha256",
    "byteLength",
    "mediaType",
  ]);
  if (origin.mediaType !== "application/pdf") fail("catalog_invalid");
  const provider =
    row.providerOriginal === undefined
      ? undefined
      : providerOriginal(row.providerOriginal);
  const result: OriginalCatalogRow = {
    originalCatalogId: uuid(row.originalCatalogId),
    sourceExternalId: uuid(row.sourceExternalId),
    origin: {
      scanId: id(origin.scanId),
      observationEpoch: integer(origin.observationEpoch),
      sha256: sha(origin.sha256),
      byteLength: integer(origin.byteLength, 1, 16 * 1024 * 1024),
      mediaType: "application/pdf",
    },
    copies: originalCopies(row.copies, provider !== undefined),
    ...(provider === undefined ? {} : { providerOriginal: provider }),
    createdAt: integer(row.createdAt),
    rowRevision: integer(row.rowRevision, 1),
    updatedAt: integer(row.updatedAt),
  };
  if (row.cloud !== undefined) {
    const cloud = object(row.cloud);
    exact(
      cloud,
      ["sourceItemId", "sourceRevisionId", "primaryReceiptId", "admittedAt"],
      provider === undefined
        ? ["backupReceiptId"]
        : ["providerReferenceId", "providerBindingEpoch"],
    );
    const base = {
      sourceItemId: id(cloud.sourceItemId),
      sourceRevisionId: id(cloud.sourceRevisionId),
      primaryReceiptId: id(cloud.primaryReceiptId),
      admittedAt: integer(cloud.admittedAt),
    };
    result.cloud =
      provider === undefined
        ? { ...base, backupReceiptId: id(cloud.backupReceiptId) }
        : {
            ...base,
            providerReferenceId: id(cloud.providerReferenceId),
            providerBindingEpoch: integer(cloud.providerBindingEpoch),
          };
  }
  return result;
}

function processingRow(value: unknown): ProcessingCatalogRow {
  const row = object(value);
  exact(
    row,
    [
      "processingCatalogId",
      "originalCatalogId",
      "currentObservation",
      "fingerprints",
      "captureIntent",
      "parserIntent",
      "spoolIntent",
      "copies",
      "createdAt",
      "rowRevision",
      "updatedAt",
    ],
    [
      "capture",
      "parserOutput",
      "spoolPrepared",
      "spool",
      "cloud",
      "activation",
    ],
  );
  const current = object(row.currentObservation);
  exact(current, ["scanId", "observationEpoch", "processingEpoch"]);
  const fingerprints = object(row.fingerprints);
  exact(fingerprints, [
    "parserFingerprint",
    "extractionConfigurationFingerprint",
    "discoveryProfileFingerprint",
    "processingPolicyFingerprint",
    "correctionFingerprint",
  ]);
  const parserIntent = object(row.parserIntent);
  exact(parserIntent, [
    "outputId",
    "outputRoot",
    "outputDirectory",
    "parserArtifactClientId",
  ]);
  const spoolIntent = object(row.spoolIntent);
  exact(spoolIntent, ["spoolId", "root"]);
  const captureIntent = object(row.captureIntent);
  exact(captureIntent, ["captureId", "directory"]);
  const result: ProcessingCatalogRow = {
    processingCatalogId: uuid(row.processingCatalogId),
    originalCatalogId: uuid(row.originalCatalogId),
    currentObservation: {
      scanId: id(current.scanId),
      observationEpoch: integer(current.observationEpoch),
      processingEpoch: integer(current.processingEpoch),
    },
    fingerprints: {
      parserFingerprint: sha(fingerprints.parserFingerprint),
      extractionConfigurationFingerprint: sha(
        fingerprints.extractionConfigurationFingerprint,
      ),
      discoveryProfileFingerprint: sha(
        fingerprints.discoveryProfileFingerprint,
      ),
      processingPolicyFingerprint: sha(
        fingerprints.processingPolicyFingerprint,
      ),
      correctionFingerprint: sha(fingerprints.correctionFingerprint),
    },
    captureIntent: {
      captureId: uuid(captureIntent.captureId),
      directory: directoryIdentity(captureIntent.directory),
    },
    parserIntent: {
      outputId: uuid(parserIntent.outputId),
      outputRoot: directoryIdentity(parserIntent.outputRoot),
      outputDirectory: directoryIdentity(parserIntent.outputDirectory),
      parserArtifactClientId: uuid(parserIntent.parserArtifactClientId),
    },
    spoolIntent: {
      spoolId: uuid(spoolIntent.spoolId),
      root: directoryIdentity(spoolIntent.root),
    },
    copies: copyPair(row.copies),
    createdAt: integer(row.createdAt),
    rowRevision: integer(row.rowRevision, 1),
    updatedAt: integer(row.updatedAt),
  };
  if (row.capture !== undefined) {
    const capture = object(row.capture);
    exact(capture, [
      "opaqueName",
      "device",
      "inode",
      "sha256",
      "byteLength",
      "sourceModifiedAt",
    ]);
    result.capture = {
      ...localFile({
        opaqueName: capture.opaqueName,
        device: capture.device,
        inode: capture.inode,
        sha256: capture.sha256,
        byteLength: capture.byteLength,
      }),
      sourceModifiedAt: integer(capture.sourceModifiedAt),
    };
  }
  if (row.parserOutput !== undefined)
    result.parserOutput = durableParserOutput(row.parserOutput);
  if (row.spoolPrepared !== undefined)
    result.spoolPrepared = localFile(row.spoolPrepared);
  if (row.spool !== undefined) result.spool = localFile(row.spool);
  if (row.cloud !== undefined) {
    const cloud = object(row.cloud);
    exact(cloud, [
      "sourceItemId",
      "sourceRevisionId",
      "parserArtifactId",
      "sourceTextVersionId",
      "processingGenerationId",
      "ingestJobId",
      "processingFingerprint",
      "admissionRequestDigest",
      "admittedAt",
    ]);
    result.cloud = {
      sourceItemId: id(cloud.sourceItemId),
      sourceRevisionId: id(cloud.sourceRevisionId),
      parserArtifactId: id(cloud.parserArtifactId),
      sourceTextVersionId: id(cloud.sourceTextVersionId),
      processingGenerationId: id(cloud.processingGenerationId),
      ingestJobId: id(cloud.ingestJobId),
      processingFingerprint: sha(cloud.processingFingerprint),
      admissionRequestDigest: sha(cloud.admissionRequestDigest),
      admittedAt: integer(cloud.admittedAt),
    };
  }
  if (row.activation !== undefined) {
    const activation = object(row.activation);
    exact(
      activation,
      [
        "requestId",
        "requestDigest",
        "jobId",
        "processingGenerationId",
        "state",
        "activatedAt",
        "reused",
      ],
      ["previousGenerationId"],
    );
    if (activation.state !== "ready" || typeof activation.reused !== "boolean")
      fail("catalog_invalid");
    result.activation = {
      requestId: id(activation.requestId),
      requestDigest: sha(activation.requestDigest),
      jobId: id(activation.jobId),
      processingGenerationId: id(activation.processingGenerationId),
      state: "ready",
      activatedAt: integer(activation.activatedAt),
      reused: activation.reused,
      ...(activation.previousGenerationId === undefined
        ? {}
        : { previousGenerationId: id(activation.previousGenerationId) }),
    };
  }
  return result;
}

function parseSnapshot(value: unknown, authorityDigest: string) {
  const row = object(normalizeJson(value));
  exact(
    row,
    ["version", "revision", "authorityDigest", "originals", "processings"],
    ["boundaryRelocations"],
  );
  if (
    row.version !== 1 ||
    row.authorityDigest !== authorityDigest ||
    !Array.isArray(row.originals) ||
    !Array.isArray(row.processings) ||
    row.originals.length > MAX_ORIGINALS ||
    row.processings.length > MAX_PROCESSINGS ||
    (row.boundaryRelocations !== undefined &&
      (!Array.isArray(row.boundaryRelocations) ||
        row.boundaryRelocations.length > MAX_BOUNDARY_RELOCATIONS))
  )
    fail("catalog_invalid");
  const snapshot: ArchiveCatalogSnapshot = {
    version: 1,
    revision: integer(row.revision),
    authorityDigest,
    originals: row.originals.map(originalRow),
    processings: row.processings.map(processingRow),
    boundaryRelocations:
      row.boundaryRelocations === undefined
        ? []
        : row.boundaryRelocations.map(boundaryRelocation),
  };
  const originalIds = new Set<string>();
  const processingIds = new Set<string>();
  const originalIdentities = new Set<string>();
  const processingIdentities = new Set<string>();
  const stableIds = new Set<string>();
  const objectNames = new Set<string>();
  for (const original of snapshot.originals) {
    if (originalIds.has(original.originalCatalogId)) fail("catalog_invalid");
    originalIds.add(original.originalCatalogId);
    const originalIdentity = JSON.stringify([
      original.sourceExternalId,
      original.origin.sha256,
      original.origin.byteLength,
      original.origin.mediaType,
    ]);
    if (originalIdentities.has(originalIdentity)) fail("catalog_invalid");
    originalIdentities.add(originalIdentity);
    for (const copy of Object.values(original.copies)) {
      for (const candidate of [copy.clientReceiptId, copy.archiveObjectId]) {
        if (stableIds.has(candidate)) fail("catalog_invalid");
        stableIds.add(candidate);
      }
      if (objectNames.has(copy.objectName)) fail("catalog_invalid");
      objectNames.add(copy.objectName);
    }
  }
  for (const processing of snapshot.processings) {
    if (
      processingIds.has(processing.processingCatalogId) ||
      !originalIds.has(processing.originalCatalogId)
    )
      fail("catalog_invalid");
    processingIds.add(processing.processingCatalogId);
    const processingIdentity = JSON.stringify([
      processing.originalCatalogId,
      processing.currentObservation,
      processing.fingerprints,
    ]);
    if (processingIdentities.has(processingIdentity)) fail("catalog_invalid");
    processingIdentities.add(processingIdentity);
    for (const candidate of [
      processing.parserIntent.parserArtifactClientId,
      processing.parserIntent.outputId,
      processing.spoolIntent.spoolId,
    ]) {
      if (stableIds.has(candidate)) fail("catalog_invalid");
      stableIds.add(candidate);
    }
    for (const copy of Object.values(processing.copies)) {
      for (const candidate of [copy.clientReceiptId, copy.archiveObjectId]) {
        if (stableIds.has(candidate)) fail("catalog_invalid");
        stableIds.add(candidate);
      }
      if (objectNames.has(copy.objectName)) fail("catalog_invalid");
      objectNames.add(copy.objectName);
    }
  }
  const relocationIds = new Set<string>();
  const oldBoundaries = new Set<string>();
  const newBoundaries = new Set<string>();
  for (const relocation of snapshot.boundaryRelocations) {
    if (
      relocationIds.has(relocation.relocationId) ||
      oldBoundaries.has(JSON.stringify(relocation.oldBoundary)) ||
      newBoundaries.has(JSON.stringify(relocation.newBoundary)) ||
      oldBoundaries.has(JSON.stringify(relocation.newBoundary)) ||
      newBoundaries.has(JSON.stringify(relocation.oldBoundary))
    )
      fail("catalog_invalid");
    relocationIds.add(relocation.relocationId);
    oldBoundaries.add(JSON.stringify(relocation.oldBoundary));
    newBoundaries.add(JSON.stringify(relocation.newBoundary));
    const copies = snapshotCopies(snapshot);
    for (const artifact of relocation.artifacts) {
      if (
        copies.filter((copy) =>
          copyMatchesRelocationArtifact(
            copy,
            relocation.oldBoundary,
            artifact,
          ),
        ).length !== 1
      )
        fail("catalog_invalid");
    }
  }
  return snapshot;
}

function uid(): number {
  const value = process.getuid?.();
  if (value === undefined) fail("unsafe_store");
  return value;
}

function assertDirectory(stats: Stats): void {
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    stats.uid !== uid() ||
    (stats.mode & 0o777) !== DIRECTORY_MODE
  )
    fail("unsafe_store");
}

function assertFile(stats: Stats): void {
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.nlink !== 1 ||
    stats.uid !== uid() ||
    (stats.mode & 0o777) !== FILE_MODE
  )
    fail("unsafe_store");
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function authorityDigest(journal: Journal<JsonValue, JsonValue>): string {
  const binding = journal.binding;
  return createHash("sha256")
    .update(
      JSON.stringify([
        binding.protocolVersion,
        binding.endpoint,
        binding.spaceId,
        binding.sourceAccountId,
      ]),
      "utf8",
    )
    .digest("hex");
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRemoteBoundary(
  value: ResticBackupResult["boundary"] | undefined,
): value is RemoteBackupBoundary {
  return (
    value !== undefined &&
    "backend" in value &&
    value.backend === "rclone_dropbox_v1"
  );
}

function relocationArtifactForCopy(
  copy: ArchiveCopyRecord,
  boundary: RemoteBackupBoundary,
): ArchiveBoundaryRelocationArtifact | undefined {
  if (
    !copy.backup ||
    !isRemoteBoundary(copy.backup.boundary) ||
    !equal(copy.backup.boundary, boundary) ||
    copy.deletion?.state === "complete"
  )
    return undefined;
  if (copy.deletion?.state === "pending") fail("invalid_transition");
  return {
    snapshotId: copy.backup.snapshotId,
    objectName: copy.backup.objectName,
    ciphertextSha256: copy.backup.ciphertext.sha256,
    ciphertextByteLength: copy.backup.ciphertext.byteLength,
  };
}

function copyMatchesRelocationArtifact(
  copy: ArchiveCopyRecord,
  boundary: RemoteBackupBoundary,
  artifact: ArchiveBoundaryRelocationArtifact,
): boolean {
  return (
    copy.backup !== undefined &&
    isRemoteBoundary(copy.backup.boundary) &&
    equal(copy.backup.boundary, boundary) &&
    copy.backup.snapshotId === artifact.snapshotId &&
    copy.backup.objectName === artifact.objectName &&
    copy.backup.ciphertext.sha256 === artifact.ciphertextSha256 &&
    copy.backup.ciphertext.byteLength === artifact.ciphertextByteLength
  );
}

function snapshotCopies(snapshot: ArchiveCatalogSnapshot): ArchiveCopyRecord[] {
  return [
    ...snapshot.originals.flatMap((original) => [
      ...Object.values(original.copies),
      ...(original.providerOriginal === undefined
        ? []
        : [original.providerOriginal.locator]),
    ]),
    ...snapshot.processings.flatMap((processing) =>
      Object.values(processing.copies),
    ),
  ];
}

function artifactOrder(
  left: ArchiveBoundaryRelocationArtifact,
  right: ArchiveBoundaryRelocationArtifact,
): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

type StoredCatalog = {
  value: unknown;
  identity: { device: number; inode: number; size: number; sha256: string };
};

const openCatalogs = new WeakMap<
  Journal<JsonValue, JsonValue>,
  Promise<ArchiveCatalog>
>();

export class ArchiveCatalog {
  private snapshot: ArchiveCatalogSnapshot;
  private poisoned = false;
  private busy = false;
  private storedIdentity?: StoredCatalog["identity"];

  private constructor(
    private readonly journal: Journal<JsonValue, JsonValue>,
    private readonly directory: DirectoryIdentity,
    snapshot: ArchiveCatalogSnapshot,
  ) {
    this.snapshot = snapshot;
  }

  static async open(args: {
    journal: Journal<JsonValue, JsonValue>;
  }): Promise<ArchiveCatalog> {
    const existing = openCatalogs.get(args.journal);
    if (existing) return await existing;
    const opening = ArchiveCatalog.openOnce(args);
    openCatalogs.set(args.journal, opening);
    return await opening;
  }

  private static async openOnce(args: {
    journal: Journal<JsonValue, JsonValue>;
  }): Promise<ArchiveCatalog> {
    args.journal.checkpoint;
    const directoryPath = args.journal.directory;
    const directoryStats = await lstat(directoryPath).catch(() =>
      fail("unsafe_store"),
    );
    assertDirectory(directoryStats);
    if ((await realpath(directoryPath).catch(() => "")) !== directoryPath)
      fail("unsafe_store");
    const directory = {
      path: directoryPath,
      device: directoryStats.dev,
      inode: directoryStats.ino,
    };
    const digest = authorityDigest(args.journal);
    const catalog = new ArchiveCatalog(args.journal, directory, {
      version: 1,
      revision: 0,
      authorityDigest: digest,
      originals: [],
      processings: [],
      boundaryRelocations: [],
    });
    await catalog.enter(async () => {
      await catalog.cleanTemps();
      const stored = await catalog.read();
      if (stored === undefined) await catalog.persist(catalog.snapshot);
      else {
        catalog.snapshot = parseSnapshot(stored.value, digest);
        catalog.storedIdentity = stored.identity;
      }
    });
    return catalog;
  }

  private assertUsable(): void {
    if (this.poisoned) fail("durability_failed");
    this.journal.checkpoint;
  }

  private async recheckDirectory(): Promise<void> {
    const stats = await lstat(this.directory.path).catch(() =>
      fail("unsafe_store"),
    );
    assertDirectory(stats);
    if (
      stats.dev !== this.directory.device ||
      stats.ino !== this.directory.inode ||
      (await realpath(this.directory.path).catch(() => "")) !==
        this.directory.path
    )
      fail("unsafe_store");
  }

  private async enter<T>(operation: () => Promise<T>): Promise<T> {
    this.assertUsable();
    if (this.busy) fail("invalid_transition");
    this.busy = true;
    try {
      await this.recheckDirectory();
      const result = await operation();
      await this.recheckDirectory();
      return result;
    } finally {
      this.busy = false;
    }
  }

  private async countEntries(): Promise<number> {
    const entries = await opendir(this.directory.path).catch(() =>
      fail("unsafe_store"),
    );
    let count = 0;
    try {
      for await (const _entry of entries) {
        count += 1;
        if (count > MAX_DIRECTORY_ENTRIES) fail("catalog_capacity_exceeded");
      }
    } finally {
      await entries.close().catch(() => undefined);
    }
    return count;
  }

  private async cleanTemps(): Promise<void> {
    const entries = await opendir(this.directory.path).catch(() =>
      fail("unsafe_store"),
    );
    let count = 0;
    let changed = false;
    try {
      for await (const entry of entries) {
        count += 1;
        if (count > MAX_DIRECTORY_ENTRIES) fail("catalog_capacity_exceeded");
        if (!TEMP_FILE.test(entry.name)) continue;
        const path = join(this.directory.path, entry.name);
        const stats = await lstat(path).catch(() => fail("unsafe_store"));
        assertFile(stats);
        await this.recheckDirectory();
        const current = await lstat(path).catch(() => fail("unsafe_store"));
        assertFile(current);
        if (current.dev !== stats.dev || current.ino !== stats.ino)
          fail("unsafe_store");
        await unlink(path).catch(() => fail("unsafe_store"));
        changed = true;
      }
    } finally {
      await entries.close().catch(() => undefined);
    }
    if (changed) await fsyncDirectory(this.directory.path);
  }

  private async read(): Promise<StoredCatalog | undefined> {
    if (
      typeof constants.O_NOFOLLOW !== "number" ||
      typeof constants.O_NONBLOCK !== "number"
    )
      fail("unsafe_store");
    const path = join(this.directory.path, CATALOG_FILE);
    let handle;
    try {
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      fail("unsafe_store");
    }
    try {
      const before = await handle.stat();
      assertFile(before);
      if (before.size < 1 || before.size > MAX_CATALOG_BYTES)
        fail("catalog_capacity_exceeded");
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (read.bytesRead === 0) fail("catalog_invalid");
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      const pathStats = await lstat(path).catch(() => fail("unsafe_store"));
      assertFile(after);
      assertFile(pathStats);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        after.dev !== pathStats.dev ||
        after.ino !== pathStats.ino
      )
        fail("unsafe_store");
      try {
        const value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        return {
          value,
          identity: {
            device: after.dev,
            inode: after.ino,
            size: after.size,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        };
      } catch {
        fail("catalog_invalid");
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async persist(next: ArchiveCatalogSnapshot): Promise<void> {
    let encoded: Buffer;
    try {
      encoded = Buffer.from(JSON.stringify(normalizeJson(next)), "utf8");
    } catch (error) {
      if (error instanceof ArchiveCatalogError) throw error;
      fail("catalog_invalid");
    }
    if (encoded.length < 1 || encoded.length > MAX_CATALOG_BYTES)
      fail("catalog_capacity_exceeded");
    const entryCount = await this.countEntries();
    const temp = join(
      this.directory.path,
      `.${CATALOG_FILE}.${randomUUID()}.tmp`,
    );
    const target = join(this.directory.path, CATALOG_FILE);
    const targetExists = await lstat(target)
      .then(() => true)
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        fail("unsafe_store");
      });
    if (!targetExists && entryCount >= MAX_DIRECTORY_ENTRIES)
      fail("catalog_capacity_exceeded");
    let renamed = false;
    let tempIdentity: { device: number; inode: number } | undefined;
    try {
      await this.recheckDirectory();
      const current = await this.read();
      if (this.storedIdentity === undefined) {
        if (current !== undefined) fail("catalog_conflict");
      } else if (
        current === undefined ||
        !equal(current.identity, this.storedIdentity) ||
        !equal(
          parseSnapshot(current.value, this.snapshot.authorityDigest),
          this.snapshot,
        )
      )
        fail("catalog_conflict");
      const handle = await open(temp, "wx", FILE_MODE);
      try {
        const created = await handle.stat();
        assertFile(created);
        tempIdentity = { device: created.dev, inode: created.ino };
        await handle.writeFile(encoded);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.recheckDirectory();
      const tempCurrent = await lstat(temp).catch(() => fail("unsafe_store"));
      assertFile(tempCurrent);
      if (
        tempIdentity === undefined ||
        tempCurrent.dev !== tempIdentity.device ||
        tempCurrent.ino !== tempIdentity.inode
      )
        fail("unsafe_store");
      const beforeRename = await this.read();
      if (this.storedIdentity === undefined) {
        if (beforeRename !== undefined) fail("catalog_conflict");
      } else if (
        beforeRename === undefined ||
        !equal(beforeRename.identity, this.storedIdentity)
      )
        fail("catalog_conflict");
      await rename(temp, target);
      renamed = true;
      await fsyncDirectory(this.directory.path);
      await this.recheckDirectory();
      const stored = await this.read();
      if (stored === undefined) fail("durability_failed");
      const parsed = parseSnapshot(stored.value, next.authorityDigest);
      if (!equal(parsed, next)) fail("durability_failed");
      this.storedIdentity = stored.identity;
    } catch {
      this.poisoned = true;
      if (!renamed && tempIdentity) {
        const current = await lstat(temp).catch(() => null);
        const directory = await lstat(this.directory.path).catch(() => null);
        if (
          current?.isFile() &&
          current.dev === tempIdentity.device &&
          current.ino === tempIdentity.inode &&
          directory?.dev === this.directory.device &&
          directory.ino === this.directory.inode
        )
          await unlink(temp).catch(() => undefined);
      }
      fail("durability_failed");
    }
  }

  get revision(): number {
    this.assertUsable();
    return this.snapshot.revision;
  }

  listOriginals(): OriginalCatalogRow[] {
    this.assertUsable();
    return structuredClone(this.snapshot.originals);
  }

  listProcessings(): ProcessingCatalogRow[] {
    this.assertUsable();
    return structuredClone(this.snapshot.processings);
  }

  /**
   * Snapshot the complete still-live remote inventory while the exact journal
   * session and durable catalog bytes remain held and unchanged.
   */
  async snapshotRemoteBoundaryForRelocation(args: {
    expectedJournal: Journal<JsonValue, JsonValue>;
    oldBoundary: RemoteBackupBoundary;
    newBoundary: RemoteBackupBoundary;
  }): Promise<ArchiveBoundaryRelocationPreparation> {
    return await this.enter(async () => {
      if (this.journal !== args.expectedJournal) fail("catalog_conflict");
      const current = await this.read();
      if (
        current === undefined ||
        this.storedIdentity === undefined ||
        !equal(current.identity, this.storedIdentity) ||
        !equal(
          parseSnapshot(current.value, this.snapshot.authorityDigest),
          this.snapshot,
        )
      )
        fail("catalog_conflict");
      const repositoryId = sha(args.oldBoundary.repositoryId);
      const oldBoundary = remoteBoundary(args.oldBoundary, repositoryId);
      const newBoundary = remoteBoundary(args.newBoundary, repositoryId);
      if (
        newBoundary.rootPath === oldBoundary.rootPath ||
        !equal(oldBoundary, {
          ...newBoundary,
          rootPath: oldBoundary.rootPath,
        }) ||
        this.snapshot.boundaryRelocations.some(
          (relocation) =>
            equal(relocation.oldBoundary, oldBoundary) ||
            equal(relocation.newBoundary, newBoundary) ||
            equal(relocation.oldBoundary, newBoundary) ||
            equal(relocation.newBoundary, oldBoundary),
        )
      )
        fail("catalog_conflict");
      const artifacts: ArchiveBoundaryRelocationArtifact[] = [];
      const artifactBindings: ArchiveBoundaryRelocationArtifactBinding[] = [];
      const collect = (
        copy: ArchiveCopyRecord,
        kind: ArchiveBoundaryRelocationArtifactBinding["kind"],
        catalogId: string,
      ) => {
        const artifact = relocationArtifactForCopy(copy, oldBoundary);
        if (!artifact) return;
        if (!copy.published) fail("invalid_transition");
        artifacts.push(artifact);
        artifactBindings.push({
          kind,
          catalogId,
          ...artifact,
          plaintextSha256: copy.published.source.sha256,
          plaintextByteLength: copy.published.source.byteLength,
        });
      };
      for (const original of this.snapshot.originals) {
        const backup = original.copies.independent_backup;
        if (backup)
          collect(backup, "original_backup", original.originalCatalogId);
        if (original.providerOriginal)
          collect(
            original.providerOriginal.locator,
            "provider_locator",
            original.originalCatalogId,
          );
      }
      for (const processing of this.snapshot.processings) {
        collect(
          processing.copies.independent_backup,
          "parser_backup",
          processing.processingCatalogId,
        );
      }
      artifacts.sort(artifactOrder);
      artifactBindings.sort((left, right) =>
        JSON.stringify([
          left.snapshotId,
          left.objectName,
          left.kind,
          left.catalogId,
        ]).localeCompare(
          JSON.stringify([
            right.snapshotId,
            right.objectName,
            right.kind,
            right.catalogId,
          ]),
        ),
      );
      return {
        authorityDigest: this.snapshot.authorityDigest,
        catalogRevision: this.snapshot.revision,
        oldBoundary: structuredClone(oldBoundary),
        artifacts: structuredClone(artifacts),
        artifactBindings: structuredClone(artifactBindings),
      };
    });
  }

  /**
   * Records one verified physical root-path relocation without rewriting any
   * historical archive receipt. The supplied inventory must be the complete
   * set of still-live catalog objects at the old boundary.
   */
  async recordBoundaryRelocation(args: {
    relocationId: string;
    oldBoundary: RemoteBackupBoundary;
    newBoundary: RemoteBackupBoundary;
    artifacts: ArchiveBoundaryRelocationArtifact[];
    verifiedAt: number;
  }): Promise<ArchiveBoundaryRelocation> {
    return await this.enter(async () => {
      let candidate: ArchiveBoundaryRelocation;
      try {
        candidate = assertRootPathOnlyBoundaryRelocation(args);
      } catch (error) {
        if (error instanceof ArchiveBoundaryRelocationError)
          fail("invalid_input");
        throw error;
      }
      const sameId = this.snapshot.boundaryRelocations.find(
        (relocation) => relocation.relocationId === candidate.relocationId,
      );
      if (sameId) {
        if (equal(sameId, candidate)) return structuredClone(sameId);
        fail("catalog_conflict");
      }
      if (
        this.snapshot.boundaryRelocations.some(
          (relocation) =>
            equal(relocation.oldBoundary, candidate.oldBoundary) ||
            equal(relocation.newBoundary, candidate.newBoundary) ||
            equal(relocation.oldBoundary, candidate.newBoundary) ||
            equal(relocation.newBoundary, candidate.oldBoundary),
        )
      )
        fail("catalog_conflict");
      if (
        this.snapshot.boundaryRelocations.length >= MAX_BOUNDARY_RELOCATIONS
      )
        fail("catalog_capacity_exceeded");

      const catalogArtifacts: ArchiveBoundaryRelocationArtifact[] = [];
      for (const original of this.snapshot.originals) {
        for (const copy of Object.values(original.copies)) {
          const artifact = relocationArtifactForCopy(
            copy,
            candidate.oldBoundary,
          );
          if (artifact) catalogArtifacts.push(artifact);
        }
        if (original.providerOriginal) {
          const artifact = relocationArtifactForCopy(
            original.providerOriginal.locator,
            candidate.oldBoundary,
          );
          if (artifact) catalogArtifacts.push(artifact);
        }
      }
      for (const processing of this.snapshot.processings) {
        for (const copy of Object.values(processing.copies)) {
          const artifact = relocationArtifactForCopy(
            copy,
            candidate.oldBoundary,
          );
          if (artifact) catalogArtifacts.push(artifact);
        }
      }
      catalogArtifacts.sort(artifactOrder);
      if (!equal(catalogArtifacts, candidate.artifacts))
        fail("catalog_conflict");

      const next = parseSnapshot(
        {
          ...this.snapshot,
          revision: this.snapshot.revision + 1,
          boundaryRelocations: [
            ...this.snapshot.boundaryRelocations,
            candidate,
          ],
        },
        this.snapshot.authorityDigest,
      );
      await this.persist(next);
      this.snapshot = next;
      return structuredClone(candidate);
    });
  }

  resolvesBoundaryRelocation(args: {
    oldBoundary: RemoteBackupBoundary;
    newBoundary: RemoteBackupBoundary;
    artifact: ArchiveBoundaryRelocationArtifact;
  }): boolean {
    this.assertUsable();
    const matches = this.snapshot.boundaryRelocations.filter((relocation) =>
      relocationAuthorizesArtifact({ relocation, ...args }),
    );
    if (matches.length > 1) fail("catalog_conflict");
    return matches.length === 1;
  }

  async requireBoundaryRelocation(relocationId: string): Promise<{
    relocation: ArchiveBoundaryRelocation;
    catalogRevision: number;
  }> {
    return await this.enter(async () => {
      const current = await this.read();
      if (
        current === undefined ||
        this.storedIdentity === undefined ||
        !equal(current.identity, this.storedIdentity) ||
        !equal(
          parseSnapshot(current.value, this.snapshot.authorityDigest),
          this.snapshot,
        )
      )
        fail("catalog_conflict");
      const key = uuid(relocationId);
      const relocation = this.snapshot.boundaryRelocations.find(
        (candidate) => candidate.relocationId === key,
      );
      if (!relocation) fail("catalog_not_found");
      return {
        relocation: structuredClone(relocation),
        catalogRevision: this.snapshot.revision,
      };
    });
  }

  requireProcessingActivation(catalogId: string) {
    this.assertUsable();
    const key = uuid(catalogId);
    const row = this.snapshot.processings.find(
      (entry) => entry.processingCatalogId === key,
    );
    if (!row) fail("catalog_not_found");
    if (!row.activation) fail("invalid_transition");
    return structuredClone(row.activation);
  }

  findOriginalExact(
    identity: OriginalReuseIdentity,
  ): OriginalCatalogRow | undefined {
    this.assertUsable();
    const validated = {
      sourceExternalId: uuid(identity.sourceExternalId),
      sha256: sha(identity.sha256),
      byteLength: integer(identity.byteLength, 1, 16 * 1024 * 1024),
      mediaType:
        identity.mediaType === "application/pdf"
          ? ("application/pdf" as const)
          : fail("invalid_input"),
    };
    const matches = this.snapshot.originals.filter(
      (row) =>
        row.sourceExternalId === validated.sourceExternalId &&
        row.origin.sha256 === validated.sha256 &&
        row.origin.byteLength === validated.byteLength &&
        row.origin.mediaType === validated.mediaType,
    );
    if (matches.length > 1) fail("catalog_conflict");
    return matches[0] === undefined ? undefined : structuredClone(matches[0]);
  }

  findProcessingExact(
    identity: Pick<
      ProcessingCatalogIdentity,
      "originalCatalogId" | "currentObservation" | "fingerprints"
    >,
  ): ProcessingCatalogRow | undefined {
    this.assertUsable();
    const current = object(identity.currentObservation);
    exact(current, ["scanId", "observationEpoch", "processingEpoch"]);
    const fingerprints = object(identity.fingerprints);
    exact(fingerprints, [
      "parserFingerprint",
      "extractionConfigurationFingerprint",
      "discoveryProfileFingerprint",
      "processingPolicyFingerprint",
      "correctionFingerprint",
    ]);
    const probe = {
      originalCatalogId: uuid(identity.originalCatalogId),
      currentObservation: {
        scanId: id(current.scanId),
        observationEpoch: integer(current.observationEpoch),
        processingEpoch: integer(current.processingEpoch),
      },
      fingerprints: {
        parserFingerprint: sha(fingerprints.parserFingerprint),
        extractionConfigurationFingerprint: sha(
          fingerprints.extractionConfigurationFingerprint,
        ),
        discoveryProfileFingerprint: sha(
          fingerprints.discoveryProfileFingerprint,
        ),
        processingPolicyFingerprint: sha(
          fingerprints.processingPolicyFingerprint,
        ),
        correctionFingerprint: sha(fingerprints.correctionFingerprint),
      },
    };
    const matches = this.snapshot.processings.filter(
      (row) =>
        row.originalCatalogId === probe.originalCatalogId &&
        equal(row.currentObservation, probe.currentObservation) &&
        equal(row.fingerprints, probe.fingerprints),
    );
    if (matches.length > 1) fail("catalog_conflict");
    return matches[0] === undefined ? undefined : structuredClone(matches[0]);
  }

  async createOriginalIntent(
    identity: OriginalCatalogIdentity,
  ): Promise<OriginalCatalogRow> {
    return await this.enter(async () => {
      const candidate = originalRow({
        ...identity,
        rowRevision: 1,
        updatedAt: identity.createdAt,
      });
      const sameId = this.snapshot.originals.find(
        (row) => row.originalCatalogId === candidate.originalCatalogId,
      );
      if (sameId) {
        if (equal(sameId, candidate)) return structuredClone(sameId);
        fail("catalog_conflict");
      }
      const reuse = this.findOriginalExact({
        sourceExternalId: candidate.sourceExternalId,
        sha256: candidate.origin.sha256,
        byteLength: candidate.origin.byteLength,
        mediaType: candidate.origin.mediaType,
      });
      if (reuse) return reuse;
      if (this.snapshot.originals.length >= MAX_ORIGINALS)
        fail("catalog_capacity_exceeded");
      return await this.appendOriginal(candidate);
    });
  }

  async createProcessingIntent(
    identity: ProcessingCatalogIdentity,
  ): Promise<ProcessingCatalogRow> {
    return await this.enter(async () => {
      const candidate = processingRow({
        ...identity,
        rowRevision: 1,
        updatedAt: identity.createdAt,
      });
      if (
        !this.snapshot.originals.some(
          (row) => row.originalCatalogId === candidate.originalCatalogId,
        )
      )
        fail("catalog_not_found");
      const sameId = this.snapshot.processings.find(
        (row) => row.processingCatalogId === candidate.processingCatalogId,
      );
      if (sameId) {
        if (equal(sameId, candidate)) return structuredClone(sameId);
        fail("catalog_conflict");
      }
      const exactExisting = this.snapshot.processings.find(
        (row) =>
          row.originalCatalogId === candidate.originalCatalogId &&
          equal(row.currentObservation, candidate.currentObservation) &&
          equal(row.fingerprints, candidate.fingerprints),
      );
      if (exactExisting) return structuredClone(exactExisting);
      if (this.snapshot.processings.length >= MAX_PROCESSINGS)
        fail("catalog_capacity_exceeded");
      return await this.appendProcessing(candidate);
    });
  }

  private async appendOriginal(row: OriginalCatalogRow) {
    const next = parseSnapshot(
      {
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        originals: [...this.snapshot.originals, row],
      },
      this.snapshot.authorityDigest,
    );
    await this.persist(next);
    this.snapshot = next;
    return structuredClone(row);
  }

  private async appendProcessing(row: ProcessingCatalogRow) {
    const next = parseSnapshot(
      {
        ...this.snapshot,
        revision: this.snapshot.revision + 1,
        processings: [...this.snapshot.processings, row],
      },
      this.snapshot.authorityDigest,
    );
    await this.persist(next);
    this.snapshot = next;
    return structuredClone(row);
  }

  private async updateRow(
    subject: ArchiveSubject,
    catalogId: string,
    expectedRevision: number,
    update: (row: OriginalCatalogRow | ProcessingCatalogRow) => void,
  ) {
    return await this.enter(async () => {
      const key = uuid(catalogId);
      const revision = integer(expectedRevision, 1);
      const rows =
        subject === "original_bytes"
          ? this.snapshot.originals
          : this.snapshot.processings;
      const index = rows.findIndex((row) =>
        subject === "original_bytes"
          ? (row as OriginalCatalogRow).originalCatalogId === key
          : (row as ProcessingCatalogRow).processingCatalogId === key,
      );
      if (index < 0) fail("catalog_not_found");
      const row = structuredClone(rows[index]!);
      if (revision > row.rowRevision) fail("catalog_conflict");
      update(row);
      if (equal(row, rows[index])) return structuredClone(row);
      if (revision !== row.rowRevision) fail("catalog_conflict");
      row.rowRevision += 1;
      row.updatedAt = Date.now();
      const next = structuredClone(this.snapshot);
      if (subject === "original_bytes")
        next.originals[index] = row as OriginalCatalogRow;
      else next.processings[index] = row as ProcessingCatalogRow;
      next.revision += 1;
      const parsed = parseSnapshot(next, this.snapshot.authorityDigest);
      await this.persist(parsed);
      this.snapshot = parsed;
      return structuredClone(row);
    });
  }

  async recordCapture(args: {
    catalogId: string;
    expectedRevision: number;
    capture: LocalFileIdentity & {
      sourceModifiedAt: number;
      directory: { device: number; inode: number };
    };
  }): Promise<ProcessingCatalogRow> {
    return (await this.updateRow(
      "parser_output",
      args.catalogId,
      args.expectedRevision,
      (value) => {
        const row = value as ProcessingCatalogRow;
        const capture = {
          ...localFile({
            opaqueName: args.capture.opaqueName,
            device: args.capture.device,
            inode: args.capture.inode,
            sha256: args.capture.sha256,
            byteLength: args.capture.byteLength,
          }),
          sourceModifiedAt: integer(args.capture.sourceModifiedAt),
        };
        if (capture.opaqueName !== row.captureIntent.captureId)
          fail("catalog_conflict");
        const original = this.snapshot.originals.find(
          (entry) => entry.originalCatalogId === row.originalCatalogId,
        );
        if (
          !original ||
          !equal(
            directoryIdentity(args.capture.directory),
            row.captureIntent.directory,
          ) ||
          capture.sha256 !== original.origin.sha256 ||
          capture.byteLength !== original.origin.byteLength
        )
          fail("catalog_conflict");
        if (row.capture && !equal(row.capture, capture))
          fail("catalog_conflict");
        row.capture = capture;
      },
    )) as ProcessingCatalogRow;
  }

  async recordParserOutput(args: {
    catalogId: string;
    expectedRevision: number;
    output: DurableParserOutput;
  }): Promise<ProcessingCatalogRow> {
    return (await this.updateRow(
      "parser_output",
      args.catalogId,
      args.expectedRevision,
      (value) => {
        const row = value as ProcessingCatalogRow;
        const output = durableParserOutput(args.output);
        const original = this.snapshot.originals.find(
          (entry) => entry.originalCatalogId === row.originalCatalogId,
        );
        if (
          !original ||
          output.outputId !== row.parserIntent.outputId ||
          !equal(output.outputRoot, row.parserIntent.outputRoot) ||
          !equal(output.outputDirectory, row.parserIntent.outputDirectory) ||
          output.sourceSha256 !== original.origin.sha256 ||
          output.parserFingerprint !== row.fingerprints.parserFingerprint ||
          output.extractionConfigurationFingerprint !==
            row.fingerprints.extractionConfigurationFingerprint
        )
          fail("catalog_conflict");
        if (row.parserOutput && !equal(row.parserOutput, output))
          fail("catalog_conflict");
        row.parserOutput = output;
      },
    )) as ProcessingCatalogRow;
  }

  async recordSpool(args: {
    catalogId: string;
    expectedRevision: number;
    spool: LocalFileIdentity;
  }): Promise<ProcessingCatalogRow> {
    return (await this.updateRow(
      "parser_output",
      args.catalogId,
      args.expectedRevision,
      (value) => {
        const row = value as ProcessingCatalogRow;
        const spool = localFile(args.spool);
        if (
          spool.opaqueName !== `${row.spoolIntent.spoolId}.json` ||
          !row.parserOutput ||
          spool.sha256 !== row.parserOutput.normalizedBundle.sha256 ||
          spool.byteLength !== row.parserOutput.normalizedBundle.byteLength
        )
          fail("catalog_conflict");
        if (row.spool && !equal(row.spool, spool)) fail("catalog_conflict");
        if (
          row.spoolPrepared &&
          (row.spoolPrepared.device !== spool.device ||
            row.spoolPrepared.inode !== spool.inode ||
            row.spoolPrepared.sha256 !== spool.sha256 ||
            row.spoolPrepared.byteLength !== spool.byteLength)
        )
          fail("catalog_conflict");
        row.spool = spool;
      },
    )) as ProcessingCatalogRow;
  }

  async recordSpoolPrepared(args: {
    catalogId: string;
    expectedRevision: number;
    prepared: LocalFileIdentity;
  }): Promise<ProcessingCatalogRow> {
    return (await this.updateRow(
      "parser_output",
      args.catalogId,
      args.expectedRevision,
      (value) => {
        const row = value as ProcessingCatalogRow;
        const prepared = localFile(args.prepared);
        if (
          !prepared.opaqueName.startsWith(`.${row.spoolIntent.spoolId}.`) ||
          !prepared.opaqueName.endsWith(".tmp") ||
          !row.parserOutput ||
          prepared.sha256 !== row.parserOutput.normalizedBundle.sha256 ||
          prepared.byteLength !== row.parserOutput.normalizedBundle.byteLength
        )
          fail("catalog_conflict");
        if (row.spoolPrepared && !equal(row.spoolPrepared, prepared))
          fail("catalog_conflict");
        row.spoolPrepared = prepared;
      },
    )) as ProcessingCatalogRow;
  }

  async recordArchivePrepared(args: {
    subject: ArchiveSubject;
    catalogId: string;
    expectedRevision: number;
    role: "primary" | "independent_backup";
    prepared: Omit<PreparedAgeObject, "tempPath"> & { tempName: string };
  }) {
    return await this.updateCopy(args, (copy, row) => {
      const value = prepared(args.prepared);
      const expectedSource =
        args.subject === "original_bytes"
          ? (row as OriginalCatalogRow).origin
          : (row as ProcessingCatalogRow).parserOutput?.rawArtifact;
      if (
        !copy.preparationIntent ||
        value.tempName !== copy.preparationIntent.tempName ||
        !expectedSource ||
        value.source.sha256 !== expectedSource.sha256 ||
        value.source.byteLength !== expectedSource.byteLength
      )
        fail("catalog_conflict");
      if (copy.prepared && !equal(copy.prepared, value))
        fail("catalog_conflict");
      copy.prepared = value;
    });
  }

  async recordArchivePreparationIntent(args: {
    subject: ArchiveSubject;
    catalogId: string;
    expectedRevision: number;
    role: "primary" | "independent_backup";
    tempName: string;
  }) {
    return await this.updateCopy(args, (copy) => {
      const value = { tempName: string(args.tempName, 48, OPAQUE_NAME) };
      if (
        value.tempName !== `${copy.archiveObjectId}.tmp` ||
        value.tempName === copy.objectName
      )
        fail("catalog_conflict");
      if (copy.preparationIntent && !equal(copy.preparationIntent, value))
        fail("catalog_conflict");
      if (copy.prepared && copy.prepared.tempName !== value.tempName)
        fail("catalog_conflict");
      copy.preparationIntent = value;
    });
  }

  async recordArchivePublished(args: {
    subject: ArchiveSubject;
    catalogId: string;
    expectedRevision: number;
    role: "primary" | "independent_backup";
    published: Omit<PublishedAgeObject, "objectPath">;
    readbackVerifiedAt?: number;
  }) {
    return await this.updateCopy(args, (copy) => {
      const value = published(args.published);
      if (!copy.prepared) fail("invalid_transition");
      if (
        !equal(value.source, copy.prepared.source) ||
        !equal(value.ciphertext, copy.prepared.ciphertext) ||
        value.ciphertextDevice !== copy.prepared.ciphertextDevice ||
        value.ciphertextInode !== copy.prepared.ciphertextInode
      )
        fail("catalog_conflict");
      if (copy.published && !equal(copy.published, value))
        fail("catalog_conflict");
      if ((copy.role === "primary") !== (args.readbackVerifiedAt !== undefined))
        fail("catalog_invalid");
      if (copy.role === "primary") {
        const verifiedAt = integer(args.readbackVerifiedAt);
        if (
          copy.readbackVerifiedAt !== undefined &&
          copy.readbackVerifiedAt !== verifiedAt
        )
          fail("catalog_conflict");
        copy.readbackVerifiedAt = verifiedAt;
      }
      copy.published = value;
    });
  }

  async recordResticBackup(args: {
    subject: ArchiveSubject;
    catalogId: string;
    expectedRevision: number;
    role: "independent_backup";
    backup: ResticBackupResult | RecoveredResticBackup;
    readbackVerifiedAt: number;
  }) {
    return await this.updateCopy(args, (copy) => {
      const value = backup(args.backup);
      if (!copy.published || !copy.restic) fail("invalid_transition");
      if (
        value.operationId !== copy.restic.operationId ||
        value.objectName !== copy.objectName ||
        value.repositoryId !== copy.restic.repositoryId ||
        !equal(value.ciphertext, copy.published.ciphertext)
      )
        fail("catalog_conflict");
      if (copy.backup && !equal(copy.backup, value)) fail("catalog_conflict");
      const verifiedAt = integer(args.readbackVerifiedAt);
      if (
        copy.readbackVerifiedAt !== undefined &&
        copy.readbackVerifiedAt !== verifiedAt
      )
        fail("catalog_conflict");
      copy.backup = value;
      copy.readbackVerifiedAt = verifiedAt;
    });
  }

  async recordCloudReceipt(args: {
    subject: ArchiveSubject;
    catalogId: string;
    expectedRevision: number;
    role: "primary" | "independent_backup";
    receiptId: string;
    requestDigest: string;
    recordedAt: number;
  }) {
    return await this.updateCopy(args, (copy) => {
      if (
        !copy.published ||
        (copy.role === "independent_backup" && !copy.backup)
      )
        fail("invalid_transition");
      const value = {
        receiptId: id(args.receiptId),
        requestDigest: sha(args.requestDigest),
        recordedAt: integer(args.recordedAt),
      };
      if (copy.cloudReceipt && !equal(copy.cloudReceipt, value))
        fail("catalog_conflict");
      copy.cloudReceipt = value;
    });
  }

  private async updateCopy(
    args: {
      subject: ArchiveSubject;
      catalogId: string;
      expectedRevision: number;
      role: "primary" | "independent_backup";
    },
    update: (
      copy: ArchiveCopyRecord,
      row: OriginalCatalogRow | ProcessingCatalogRow,
    ) => void,
  ) {
    return await this.updateRow(
      args.subject,
      args.catalogId,
      args.expectedRevision,
      (row) => update(row.copies[args.role], row),
    );
  }

  async recordOriginalCloud(args: {
    catalogId: string;
    expectedRevision: number;
    cloud: NonNullable<OriginalCatalogRow["cloud"]>;
  }): Promise<OriginalCatalogRow> {
    return (await this.updateRow(
      "original_bytes",
      args.catalogId,
      args.expectedRevision,
      (value) => {
        const row = value as OriginalCatalogRow;
        const cloud = originalRow({
          ...row,
          cloud: args.cloud,
        }).cloud!;
        if (!row.copies.primary.cloudReceipt) fail("invalid_transition");
        if (
          cloud.primaryReceiptId !== row.copies.primary.cloudReceipt.receiptId
        )
          fail("catalog_conflict");
        if (row.providerOriginal === undefined) {
          if (
            !row.copies.independent_backup.cloudReceipt ||
            !("backupReceiptId" in cloud) ||
            cloud.backupReceiptId !==
              row.copies.independent_backup.cloudReceipt.receiptId
          )
            fail("catalog_conflict");
        } else if (
          !("providerReferenceId" in cloud) ||
          !row.providerOriginal.verified ||
          !row.providerOriginal.locator.backup
        )
          fail("invalid_transition");
        if (row.cloud && !equal(row.cloud, cloud)) fail("catalog_conflict");
        row.cloud = cloud;
      },
    )) as OriginalCatalogRow;
  }

  async recordProviderVerified(args: {
    catalogId: string;
    expectedRevision: number;
    verified: NonNullable<
      NonNullable<OriginalCatalogRow["providerOriginal"]>["verified"]
    >;
  }): Promise<OriginalCatalogRow> {
    return (await this.updateRow(
      "original_bytes",
      args.catalogId,
      args.expectedRevision,
      (value) => {
        const row = value as OriginalCatalogRow;
        if (
          !row.providerOriginal ||
          args.verified.sourceContentHash !== row.origin.sha256 ||
          args.verified.sourceByteLength !== row.origin.byteLength
        )
          fail("catalog_conflict");
        const parsed = providerOriginal({
          ...row.providerOriginal,
          verified: args.verified,
        }).verified!;
        if (
          row.providerOriginal.verified &&
          !equal(row.providerOriginal.verified, parsed)
        )
          fail("catalog_conflict");
        row.providerOriginal.verified = parsed;
      },
    )) as OriginalCatalogRow;
  }

  async updateProviderLocator(args: {
    catalogId: string;
    expectedRevision: number;
    update: (copy: ArchiveCopyRecord) => void;
  }): Promise<OriginalCatalogRow> {
    return (await this.updateRow(
      "original_bytes",
      args.catalogId,
      args.expectedRevision,
      (value) => {
        const row = value as OriginalCatalogRow;
        if (!row.providerOriginal) fail("invalid_transition");
        args.update(row.providerOriginal.locator);
        row.providerOriginal = providerOriginal(row.providerOriginal);
      },
    )) as OriginalCatalogRow;
  }

  async recordProcessingCloud(args: {
    catalogId: string;
    expectedRevision: number;
    cloud: NonNullable<ProcessingCatalogRow["cloud"]>;
  }): Promise<ProcessingCatalogRow> {
    return (await this.updateRow(
      "parser_output",
      args.catalogId,
      args.expectedRevision,
      (value) => {
        const row = value as ProcessingCatalogRow;
        const cloud = processingRow({ ...row, cloud: args.cloud }).cloud!;
        if (
          !row.spool ||
          !row.copies.primary.cloudReceipt ||
          !row.copies.independent_backup.cloudReceipt
        )
          fail("invalid_transition");
        if (row.cloud && !equal(row.cloud, cloud)) fail("catalog_conflict");
        row.cloud = cloud;
      },
    )) as ProcessingCatalogRow;
  }

  async recordActivation(args: {
    catalogId: string;
    expectedRevision: number;
    activation: NonNullable<ProcessingCatalogRow["activation"]>;
  }): Promise<ProcessingCatalogRow> {
    return (await this.updateRow(
      "parser_output",
      args.catalogId,
      args.expectedRevision,
      (value) => {
        const row = value as ProcessingCatalogRow;
        if (!row.cloud) fail("invalid_transition");
        const activation = processingRow({
          ...row,
          activation: args.activation,
        }).activation!;
        if (
          activation.jobId !== row.cloud.ingestJobId ||
          activation.processingGenerationId !== row.cloud.processingGenerationId
        )
          fail("catalog_conflict");
        if (row.activation && !equal(row.activation, activation))
          fail("catalog_conflict");
        row.activation = activation;
      },
    )) as ProcessingCatalogRow;
  }

  async planDeletion(args: {
    subject: ArchiveSubject;
    catalogId: string;
    expectedRevision: number;
    role: "primary" | "independent_backup";
    deletionId: string;
    reason: "forget" | "verified_orphan";
    plannedAt: number;
    forgetEpoch?: number;
    receiptRequestDigest?: string;
  }) {
    return await this.updateCopy(args, (copy) => {
      if (!copy.published) fail("invalid_transition");
      const value = deletion({
        state: "pending",
        deletionId: args.deletionId,
        reason: args.reason,
        plannedAt: args.plannedAt,
        ...(args.forgetEpoch === undefined
          ? {}
          : { forgetEpoch: args.forgetEpoch }),
        ...(args.receiptRequestDigest === undefined
          ? {}
          : { receiptRequestDigest: args.receiptRequestDigest }),
      });
      if (copy.deletion && !equal(copy.deletion, value))
        fail("catalog_conflict");
      copy.deletion = value;
    });
  }

  nextDeletionTarget(
    subject: ArchiveSubject,
    catalogId: string,
  ): ArchiveDeletionTarget | undefined {
    this.assertUsable();
    const rows =
      subject === "original_bytes"
        ? this.snapshot.originals
        : this.snapshot.processings;
    const row = rows.find((entry) =>
      subject === "original_bytes"
        ? (entry as OriginalCatalogRow).originalCatalogId === catalogId
        : (entry as ProcessingCatalogRow).processingCatalogId === catalogId,
    );
    if (!row) fail("catalog_not_found");
    for (const role of ["primary", "independent_backup"] as const) {
      const copy = row.copies[role];
      if (
        copy.deletion?.state !== "pending" ||
        !copy.prepared ||
        !copy.published
      )
        continue;
      return {
        catalogId,
        subject,
        role,
        expectedRowRevision: row.rowRevision,
        deletionId: copy.deletion.deletionId,
        reason: copy.deletion.reason,
        ...(copy.deletion.forgetEpoch === undefined
          ? {}
          : { forgetEpoch: copy.deletion.forgetEpoch }),
        clientReceiptId: copy.clientReceiptId,
        archiveIdentityFingerprint: copy.archiveIdentityFingerprint,
        archiveObjectId: copy.archiveObjectId,
        objectName: copy.objectName,
        ciphertextSha256: copy.published.ciphertext.sha256,
        ciphertextByteLength: copy.published.ciphertext.byteLength,
        ciphertextDevice: copy.published.ciphertextDevice,
        ciphertextInode: copy.published.ciphertextInode,
        archiveDirectoryDevice: copy.prepared.archiveDirectoryDevice,
        archiveDirectoryInode: copy.prepared.archiveDirectoryInode,
        ...(copy.cloudReceipt === undefined
          ? {}
          : {
              cloudReceiptId: copy.cloudReceipt.receiptId,
            }),
        ...(copy.deletion.receiptRequestDigest === undefined
          ? {}
          : { receiptRequestDigest: copy.deletion.receiptRequestDigest }),
        ...(copy.restic === undefined
          ? {}
          : {
              operationId: copy.restic.operationId,
              host: copy.restic.host,
            }),
        ...(copy.restic === undefined
          ? {}
          : { repositoryId: copy.restic.repositoryId }),
        ...(copy.backup === undefined
          ? {}
          : { snapshotId: copy.backup.snapshotId }),
      };
    }
    return undefined;
  }

  async recordDeletionResult(args: {
    subject: ArchiveSubject;
    catalogId: string;
    expectedRevision: number;
    role: "primary" | "independent_backup";
    deletionId: string;
    forgetEpoch?: number;
    completedAt: number;
    object: "deleted" | "already_missing";
    backup?: "deleted" | "already_missing";
  }) {
    return await this.updateCopy(args, (copy) => {
      if (!copy.deletion) fail("invalid_transition");
      if (
        copy.deletion.deletionId !== uuid(args.deletionId) ||
        copy.deletion.forgetEpoch !== args.forgetEpoch ||
        (copy.role === "independent_backup") !== (args.backup !== undefined)
      )
        fail("catalog_conflict");
      const value = deletion({
        ...copy.deletion,
        state: "complete",
        completedAt: args.completedAt,
        object: args.object,
        ...(args.backup === undefined ? {} : { backup: args.backup }),
      });
      if (copy.deletion.state === "complete") {
        if (!equal(copy.deletion, value)) fail("catalog_conflict");
        return;
      }
      copy.deletion = value;
    });
  }

  async markReview(args: {
    subject: ArchiveSubject;
    catalogId: string;
    expectedRevision: number;
    role: "primary" | "independent_backup";
    code: NonNullable<ArchiveCopyRecord["reviewCode"]>;
  }) {
    return await this.updateCopy(args, (copy) => {
      const code = string(args.code, 64, SAFE_CODE) as NonNullable<
        ArchiveCopyRecord["reviewCode"]
      >;
      if (copy.reviewCode && copy.reviewCode !== code) fail("catalog_conflict");
      copy.reviewCode = code;
    });
  }
}

export async function openArchiveCatalog<
  C extends JsonValue,
  R extends JsonValue,
>(args: { journal: Journal<C, R> }): Promise<ArchiveCatalog> {
  return await ArchiveCatalog.open({
    journal: args.journal as unknown as Journal<JsonValue, JsonValue>,
  });
}
