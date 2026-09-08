import type {
  PreparedAgeObject,
  PublishedAgeObject,
  RecoveredResticBackup,
  RemoteBackupBoundary,
  ResticBackupResult,
} from "./archiveTypes.js";

export type LocalDirectoryIdentity = {
  device: number;
  inode: number;
};

export type LocalFileIdentity = {
  opaqueName: string;
  device: number;
  inode: number;
  sha256: string;
  byteLength: number;
};

export type ArchiveCopyRole = "primary" | "independent_backup";
export type ArchiveSubject = "original_bytes" | "parser_output";

export type ArchiveCopyIntent = {
  role: ArchiveCopyRole;
  clientReceiptId: string;
  archiveObjectId: string;
  objectName: string;
  archiveIdentityFingerprint: string;
  archiveProfileFingerprint: string;
  recipientFingerprint: string;
  repositoryKeyDomainFingerprint: string;
  storageFailureDomainFingerprint: string;
  restic?: {
    operationId: string;
    host: string;
    repositoryId: string;
  };
};

export type ArchiveDeletion =
  | {
      state: "pending";
      deletionId: string;
      reason: "forget" | "verified_orphan";
      plannedAt: number;
      forgetEpoch?: number;
      receiptRequestDigest?: string;
    }
  | {
      state: "complete";
      deletionId: string;
      reason: "forget" | "verified_orphan";
      plannedAt: number;
      completedAt: number;
      object: "deleted" | "already_missing";
      backup?: "deleted" | "already_missing";
      forgetEpoch?: number;
      receiptRequestDigest?: string;
    };

export type ArchiveCopyRecord = ArchiveCopyIntent & {
  preparationIntent?: { tempName: string };
  prepared?: Omit<PreparedAgeObject, "tempPath"> & { tempName: string };
  published?: Omit<PublishedAgeObject, "objectPath">;
  backup?: ResticBackupResult | RecoveredResticBackup;
  /** Immutable time of the role's required destination readback. */
  readbackVerifiedAt?: number;
  cloudReceipt?: {
    receiptId: string;
    /** Digest of the local archived admission/lookup HTTP request. */
    requestDigest: string;
    recordedAt: number;
  };
  deletion?: ArchiveDeletion;
  reviewCode?:
    | "ambiguous_recovery"
    | "identity_conflict"
    | "replacement_detected"
    | "delete_failed";
};

export type OriginalCatalogIdentity = {
  originalCatalogId: string;
  sourceExternalId: string;
  origin: {
    scanId: string;
    observationEpoch: number;
    sha256: string;
    byteLength: number;
    mediaType: "application/pdf";
  };
  copies:
    | { primary: ArchiveCopyIntent; independent_backup: ArchiveCopyIntent }
    | { primary: ArchiveCopyIntent; independent_backup: never };
  providerOriginal?: ProviderOriginalCatalog;
  createdAt: number;
};

export type OriginalCatalogRow = Omit<OriginalCatalogIdentity, "copies"> & {
  rowRevision: number;
  copies:
    | { primary: ArchiveCopyRecord; independent_backup: ArchiveCopyRecord }
    | { primary: ArchiveCopyRecord; independent_backup: never };
  providerOriginal?: ProviderOriginalCatalog;
  cloud?: {
    sourceItemId: string;
    sourceRevisionId: string;
    primaryReceiptId: string;
    admittedAt: number;
  } & (
    | {
        backupReceiptId: string;
        providerReferenceId?: never;
        providerBindingEpoch?: never;
      }
    | {
        backupReceiptId?: never;
        providerReferenceId: string;
        providerBindingEpoch: number;
      }
  );
  updatedAt: number;
};

export type ProviderOriginalCatalog = {
  clientReferenceId: string;
  bindingId: string;
  locator: ArchiveCopyRecord;
  verified?: {
    providerAccountIdHash: string;
    providerRootDirectoryIdHash: string;
    providerFileIdHash: string;
    providerRevision: string;
    providerContentHash: string;
    sourceContentHash: string;
    sourceByteLength: number;
    verifiedAt: number;
    manifestFingerprint: string;
    manifestByteLength: number;
  };
};

export type OriginalReuseIdentity = {
  sourceExternalId: string;
  sha256: string;
  byteLength: number;
  mediaType: "application/pdf";
};

export type ProcessingCatalogIdentity = {
  processingCatalogId: string;
  originalCatalogId: string;
  currentObservation: {
    scanId: string;
    observationEpoch: number;
    processingEpoch: number;
  };
  fingerprints: {
    parserFingerprint: string;
    extractionConfigurationFingerprint: string;
    discoveryProfileFingerprint: string;
    processingPolicyFingerprint: string;
    correctionFingerprint: string;
  };
  captureIntent: {
    captureId: string;
    directory: LocalDirectoryIdentity;
  };
  parserIntent: {
    outputId: string;
    outputRoot: LocalDirectoryIdentity;
    outputDirectory: LocalDirectoryIdentity;
    parserArtifactClientId: string;
  };
  spoolIntent: {
    spoolId: string;
    root: LocalDirectoryIdentity;
  };
  copies: {
    primary: ArchiveCopyIntent;
    independent_backup: ArchiveCopyIntent;
  };
  createdAt: number;
};

export type DurableParserOutput = {
  outputId: string;
  outputRoot: LocalDirectoryIdentity;
  outputDirectory: LocalDirectoryIdentity;
  sourceSha256: string;
  rawArtifact: LocalFileIdentity & {
    mediaType: "application/vnd.docling+json";
  };
  normalizedBundle: LocalFileIdentity & { mediaType: "application/json" };
  parserFingerprint: string;
  extractionConfigurationFingerprint: string;
  extractionFingerprint: string;
  modelManifestSha256: string;
  pageCount: number;
};

export type ProcessingCatalogRow = Omit<ProcessingCatalogIdentity, "copies"> & {
  rowRevision: number;
  copies: {
    primary: ArchiveCopyRecord;
    independent_backup: ArchiveCopyRecord;
  };
  capture?: LocalFileIdentity & { sourceModifiedAt: number };
  parserOutput?: DurableParserOutput;
  spoolPrepared?: LocalFileIdentity;
  spool?: LocalFileIdentity;
  cloud?: {
    sourceItemId: string;
    sourceRevisionId: string;
    parserArtifactId: string;
    sourceTextVersionId: string;
    processingGenerationId: string;
    ingestJobId: string;
    processingFingerprint: string;
    admissionRequestDigest: string;
    admittedAt: number;
  };
  activation?: {
    requestId: string;
    requestDigest: string;
    jobId: string;
    processingGenerationId: string;
    state: "ready";
    activatedAt: number;
    reused: boolean;
    previousGenerationId?: string;
  };
  updatedAt: number;
};

export type ArchiveDeletionTarget = {
  catalogId: string;
  subject: ArchiveSubject;
  role: ArchiveCopyRole;
  expectedRowRevision: number;
  deletionId: string;
  reason: "forget" | "verified_orphan";
  forgetEpoch?: number;
  clientReceiptId: string;
  archiveIdentityFingerprint: string;
  archiveObjectId: string;
  objectName: string;
  ciphertextSha256: string;
  ciphertextByteLength: number;
  ciphertextDevice: number;
  ciphertextInode: number;
  archiveDirectoryDevice: number;
  archiveDirectoryInode: number;
  cloudReceiptId?: string;
  receiptRequestDigest?: string;
  operationId?: string;
  host?: string;
  repositoryId?: string;
  snapshotId?: string;
};

export type ArchiveBoundaryRelocationArtifact = {
  snapshotId: string;
  objectName: string;
  ciphertextSha256: string;
  ciphertextByteLength: number;
};

/**
 * Append-only authority for resolving an exact historical remote boundary
 * after a provider metadata move. Historical copy receipts remain unchanged.
 */
export type ArchiveBoundaryRelocation = {
  relocationId: string;
  oldBoundary: RemoteBackupBoundary;
  newBoundary: RemoteBackupBoundary;
  artifacts: ArchiveBoundaryRelocationArtifact[];
  verifiedAt: number;
};

export type ArchiveCatalogSnapshot = {
  version: 1;
  revision: number;
  authorityDigest: string;
  originals: OriginalCatalogRow[];
  processings: ProcessingCatalogRow[];
  boundaryRelocations: ArchiveBoundaryRelocation[];
};
