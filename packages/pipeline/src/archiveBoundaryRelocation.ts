import type {
  ArchiveBoundaryRelocation,
  ArchiveBoundaryRelocationArtifact,
} from "./archiveCatalogTypes.js";
import type { RemoteBackupBoundary } from "./archiveTypes.js";

const ROOT_PATH = /^[A-Za-z0-9 _.-]+(?:\/[A-Za-z0-9 _.-]+)+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class ArchiveBoundaryRelocationError extends Error {
  constructor(readonly code: "invalid_relocation" | "artifact_not_authorized") {
    super(`Archive boundary relocation failed: ${code}`);
    this.name = "ArchiveBoundaryRelocationError";
  }
}

function fail(code: ArchiveBoundaryRelocationError["code"]): never {
  throw new ArchiveBoundaryRelocationError(code);
}

function canonicalRootPath(value: string): boolean {
  return (
    value.length <= 512 &&
    ROOT_PATH.test(value) &&
    !/[:\\]/.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          part !== "." &&
          part !== ".." &&
          part.trim() === part,
      )
  );
}

function exactSameExceptRootPath(
  oldBoundary: RemoteBackupBoundary,
  newBoundary: RemoteBackupBoundary,
): boolean {
  return (
    oldBoundary.mode === "independent_backup" &&
    oldBoundary.readiness === "remote_repository_verified" &&
    oldBoundary.backend === "rclone_dropbox_v1" &&
    newBoundary.mode === oldBoundary.mode &&
    newBoundary.readiness === oldBoundary.readiness &&
    newBoundary.backend === oldBoundary.backend &&
    newBoundary.remoteName === oldBoundary.remoteName &&
    newBoundary.rootDirectoryIdHash === oldBoundary.rootDirectoryIdHash &&
    newBoundary.configIdentityFingerprint ===
      oldBoundary.configIdentityFingerprint &&
    newBoundary.repositoryId === oldBoundary.repositoryId &&
    newBoundary.resticVersion === oldBoundary.resticVersion &&
    newBoundary.rcloneVersion === oldBoundary.rcloneVersion &&
    canonicalRootPath(oldBoundary.rootPath) &&
    canonicalRootPath(newBoundary.rootPath) &&
    oldBoundary.rootPath !== newBoundary.rootPath
  );
}

export function assertRootPathOnlyBoundaryRelocation(input: {
  relocationId: string;
  oldBoundary: RemoteBackupBoundary;
  newBoundary: RemoteBackupBoundary;
  artifacts: readonly ArchiveBoundaryRelocationArtifact[];
  verifiedAt: number;
}): ArchiveBoundaryRelocation {
  if (
    !UUID.test(input.relocationId) ||
    !Number.isSafeInteger(input.verifiedAt) ||
    input.verifiedAt < 0 ||
    !exactSameExceptRootPath(input.oldBoundary, input.newBoundary) ||
    input.artifacts.length < 1 ||
    input.artifacts.length > 2_048
  )
    fail("invalid_relocation");
  const seen = new Set<string>();
  const artifacts = input.artifacts.map((artifact) => {
    if (
      !SHA256.test(artifact.snapshotId) ||
      !OBJECT_NAME.test(artifact.objectName) ||
      !SHA256.test(artifact.ciphertextSha256) ||
      !Number.isSafeInteger(artifact.ciphertextByteLength) ||
      artifact.ciphertextByteLength < 1 ||
      artifact.ciphertextByteLength > 64 * 1024 * 1024
    )
      fail("invalid_relocation");
    const key = JSON.stringify([
      artifact.snapshotId,
      artifact.objectName,
      artifact.ciphertextSha256,
      artifact.ciphertextByteLength,
    ]);
    if (seen.has(key)) fail("invalid_relocation");
    seen.add(key);
    return { ...artifact };
  });
  artifacts.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  return {
    relocationId: input.relocationId,
    oldBoundary: structuredClone(input.oldBoundary),
    newBoundary: structuredClone(input.newBoundary),
    artifacts,
    verifiedAt: input.verifiedAt,
  };
}

export function relocationAuthorizesArtifact(input: {
  relocation: ArchiveBoundaryRelocation;
  oldBoundary: RemoteBackupBoundary;
  newBoundary: RemoteBackupBoundary;
  artifact: ArchiveBoundaryRelocationArtifact;
}): boolean {
  const relocation = assertRootPathOnlyBoundaryRelocation(input.relocation);
  if (
    JSON.stringify(relocation.oldBoundary) !==
      JSON.stringify(input.oldBoundary) ||
    JSON.stringify(relocation.newBoundary) !==
      JSON.stringify(input.newBoundary)
  )
    return false;
  return relocation.artifacts.some(
    (artifact) => JSON.stringify(artifact) === JSON.stringify(input.artifact),
  );
}
