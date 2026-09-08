export const AGE_VERSION = "v1.3.2" as const;
export const RESTIC_VERSION = "0.19.1" as const;
export const RCLONE_VERSION = "v1.74.4" as const;

export type Sha256File = {
  sha256: string;
  byteLength: number;
};

export type ArchiveToolPaths = {
  ageBinary: string;
  resticBinary: string;
};

export type ArchiveCommandLimits = {
  deadlineMs: number;
  maxOutputBytes: number;
  maxSourceBytes: number;
  maxCipherBytes: number;
};

export const DEFAULT_ARCHIVE_COMMAND_LIMITS: ArchiveCommandLimits = {
  deadlineMs: 5 * 60_000,
  maxOutputBytes: 512 * 1024,
  maxSourceBytes: 64 * 1024 * 1024,
  maxCipherBytes: 66 * 1024 * 1024,
};

export type PasswordCommand = {
  executable: string;
  /** Arguments are process-visible selectors and must never contain a secret. */
  publicArgs?: readonly string[];
};

export type ArchiveCommandFailureCode =
  | "invalid_input"
  | "unsafe_path"
  | "unsupported_platform"
  | "tool_version_mismatch"
  | "process_failed"
  | "process_timeout"
  | "output_limit_exceeded"
  | "source_changed"
  | "digest_mismatch"
  | "destination_exists"
  | "backup_not_independent"
  | "not_found"
  | "invalid_tool_result"
  | "readback_failed";

export type ArchiveToolVersions = {
  age: typeof AGE_VERSION;
  restic: typeof RESTIC_VERSION;
};

export type RcloneDropboxRepository = {
  kind: "rclone_dropbox_v1";
  remoteName: string;
  rootPath: string;
  rcloneBinary: string;
  configPath: string;
  configIdentityFingerprint: string;
  expectedRootDirectoryIdHash: string;
};

export type ResticRepositoryLocation =
  | { repositoryPath: string; repository?: never }
  | { repositoryPath?: never; repository: RcloneDropboxRepository };

export type ResticRepositoryIdentity = {
  repositoryId: string;
  repositoryVersion: 2;
};

export type PreparedAgeObject = {
  state: "prepared";
  tempPath: string;
  source: Sha256File;
  ciphertext: Sha256File;
  /** Durable no-clobber publication identity for crash recovery. */
  ciphertextDevice: number;
  ciphertextInode: number;
  /** Trusted archive directory identity captured with the prepared object. */
  archiveDirectoryDevice: number;
  archiveDirectoryInode: number;
  ageVersion: typeof AGE_VERSION;
};

export type PublishedAgeObject = {
  state: "published";
  objectPath: string;
  source: Sha256File;
  ciphertext: Sha256File;
  /** Copied from the durable prepared publication intent. */
  ciphertextDevice: number;
  ciphertextInode: number;
  ageVersion: typeof AGE_VERSION;
};

export type EncryptAgeObjectInput = {
  ageBinary: string;
  sourcePath: string;
  tempOutputPath: string;
  recipient: string;
  expectedSource: Sha256File;
  limits?: ArchiveCommandLimits;
};

export type LocalBackupBoundary = {
  mode: "synthetic" | "independent_backup";
  readiness: "synthetic_only" | "different_device_unverified";
  primaryDevice: number;
  backupDevice: number;
};

export type RemoteBackupBoundary = {
  mode: "independent_backup";
  readiness: "remote_repository_verified";
  backend: "rclone_dropbox_v1";
  remoteName: string;
  rootPath: string;
  rootDirectoryIdHash: string;
  configIdentityFingerprint: string;
  repositoryId: string;
  resticVersion: typeof RESTIC_VERSION;
  rcloneVersion: typeof RCLONE_VERSION;
};

export type ResticBackupResult = {
  operationId: string;
  snapshotId: string;
  objectName: string;
  ciphertext: Sha256File;
  resticVersion: typeof RESTIC_VERSION;
  repositoryId: string;
  verification: "destination_ciphertext_readback";
  boundary: LocalBackupBoundary | RemoteBackupBoundary;
};

export type ResticReadbackResult = {
  snapshotId: string;
  objectName: string;
  ciphertext: Sha256File;
  resticVersion: typeof RESTIC_VERSION;
  repositoryId: string;
  verification: "destination_ciphertext_readback";
};

export type ReadbackResticObjectInput = ResticRepositoryLocation & {
  resticBinary: string;
  expectedRepositoryId: string;
  passwordCommand: PasswordCommand;
  snapshotId: string;
  objectName: string;
  expectedCiphertext: Sha256File;
  limits?: ArchiveCommandLimits;
};

export type BackupResticObjectInput = ResticRepositoryLocation & {
  resticBinary: string;
  expectedRepositoryId: string;
  passwordCommand: PasswordCommand;
  operationId: string;
  host: string;
  ciphertextPath: string;
  expectedCiphertext: Sha256File;
  primaryArchiveRoot: string;
  backupMode: "synthetic" | "independent_backup";
  limits?: ArchiveCommandLimits;
};

export type RecoverResticBackupInput = ResticRepositoryLocation & {
  resticBinary: string;
  expectedRepositoryId: string;
  passwordCommand: PasswordCommand;
  operationId: string;
  host: string;
  objectName: string;
  expectedCiphertext: Sha256File;
  limits?: ArchiveCommandLimits;
};

export type RecoveredResticBackup = {
  operationId: string;
  snapshotId: string;
  matchingSnapshotCount: number;
  objectName: string;
  ciphertext: Sha256File;
  resticVersion: typeof RESTIC_VERSION;
  repositoryId: string;
  verification: "destination_ciphertext_readback";
  boundary?: RemoteBackupBoundary;
};

export type RemovePublishedAgeObjectInput = {
  objectPath: string;
  expectedDirectory: {
    device: number;
    inode: number;
  };
  expectedFile: {
    device: number;
    inode: number;
    sha256: string;
    byteLength: number;
  };
  limits?: ArchiveCommandLimits;
};

export type RemovePublishedAgeObjectResult = {
  outcome: "deleted" | "already_missing";
  verification: "exact_path_absence";
};

export type ForgetResticBackupInput = ResticRepositoryLocation & {
  resticBinary: string;
  expectedRepositoryId: string;
  passwordCommand: PasswordCommand;
  operationId: string;
  host: string;
  snapshotId: string;
  objectName: string;
  expectedCiphertext: Sha256File;
  limits?: ArchiveCommandLimits;
};

export type ForgetResticBackupResult = {
  outcome: "deleted" | "already_missing";
  snapshotId: string;
  repositoryId: string;
  verification: "snapshot_absence_after_forget_prune";
};
