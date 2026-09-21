import type {
  BinaryMediaType,
  BinaryParserOutputMediaType,
} from "@repo/worker-protocol";

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
    /**
     * P2-104d. The receipt names bytes another row archived. A processing
     * generation whose extraction configuration changed re-parses to the same
     * raw conversion, so it selects the existing parser artifact and the
     * archive copies already bound to it rather than writing a second copy of
     * identical bytes. This row therefore holds a receipt and no object,
     * which is why `published` may be absent here and only here.
     */
    reused?: true;
  };
  deletion?: ArchiveDeletion;
  reviewCode?:
    | "ambiguous_recovery"
    | "identity_conflict"
    | "replacement_detected"
    | "delete_failed";
};

/**
 * P2-31d. Records that an admission receipt the authoritative server does not
 * hold was cleared, so a row left looking never admitted can still be told
 * apart from one that never was. It carries no ids: the receipt it replaces
 * named a deployment that no longer serves this account.
 *
 * P2-31f: `by` separates a clear a pass made for itself from one an operator
 * asked for, because the safety limits on the automatic route read these notes
 * back. A note without it was written before the distinction existed.
 */
export type ReceiptReconcileNote = {
  code: "original_receipt_unknown_to_server";
  clearedAt: number;
  by?: "pass" | "operator";
};

/**
 * P2-31f. One parked item, recorded on the original catalog row. It carries a
 * closed-enum code and nothing that could name a file: no path, no title, no
 * bytes.
 *
 * `runnerCapability` fingerprints the parking build's handling of these codes,
 * so a build that handles one differently releases every marker it meets
 * automatically. `attempts` counts every automatic retry this row has spent,
 * across codes rather than per code, so a document that alternates between two
 * conditions still reaches the cap instead of retrying forever.
 */
export type AdmissionBlock = {
  code: AdmissionBlockCode;
  blockedAt: number;
  runnerCapability: string;
  attempts: number;
};

/** See `ADMISSION_BLOCK_CODES` in `archiveCatalog.ts` for the closed list. */
export type AdmissionBlockCode =
  | "archive_catalog_revision_conflict"
  | "catalog_conflict"
  | "original_receipt_revision_conflict"
  | "original_receipt_unknown_to_server"
  | "provider_original_reference_already_bound"
  | "receipt_clear_refused_by_safety_limit"
  | "provider_verification_stale_review_required";

export type OriginalCatalogIdentity = {
  originalCatalogId: string;
  sourceExternalId: string;
  origin: {
    scanId: string;
    observationEpoch: number;
    sha256: string;
    byteLength: number;
    /** P2-70i3: the binary class of the original bytes. */
    mediaType: BinaryMediaType;
  };
  copies:
    | { primary: ArchiveCopyIntent; independent_backup: ArchiveCopyIntent }
    | { primary: ArchiveCopyIntent; independent_backup?: never }
    | { primary?: never; independent_backup?: never };
  providerOriginal?: ProviderOriginalCatalog;
  createdAt: number;
};

export type OriginalCatalogRow = Omit<OriginalCatalogIdentity, "copies"> & {
  rowRevision: number;
  copies:
    | { primary: ArchiveCopyRecord; independent_backup: ArchiveCopyRecord }
    | { primary: ArchiveCopyRecord; independent_backup?: never }
    | { primary?: never; independent_backup?: never };
  providerOriginal?: ProviderOriginalCatalog;
  cloud?: {
    sourceItemId: string;
    sourceRevisionId: string;
    admittedAt: number;
  } & (
    | {
        primaryReceiptId: string;
        backupReceiptId: string;
        providerReferenceId?: never;
        providerBindingEpoch?: never;
      }
    | {
        primaryReceiptId?: string;
        backupReceiptId?: never;
        providerReferenceId: string;
        providerBindingEpoch: number;
      }
  );
  /**
   * P2-31f: every clear of this row's receipt, oldest first, rather than only
   * the first one. A repeat clear used to leave no trace, which is exactly
   * what the automatic route's safety limits have to be able to see. A legacy
   * single note reads back as a one-element list.
   */
  receiptReconcile?: ReceiptReconcileNote[];
  /** P2-31f: set while this document is parked; absent means it is not. */
  admissionBlock?: AdmissionBlock;
  updatedAt: number;
};

type ProviderOriginalVerified = {
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

export type ProviderOriginalCatalog = {
  clientReferenceId: string;
  bindingId: string;
  verified?: ProviderOriginalVerified;
} & (
  | {
      /** Absent on legacy persisted rows; those rows are v1. */
      referenceVersion?: "provider_original_v1";
      locator: ArchiveCopyRecord;
    }
  | {
      referenceVersion: "provider_original_v2";
      locator?: never;
      /** Preserved evidence from an interrupted v1 run. Never executed. */
      legacyPrimary?: ArchiveCopyRecord;
      legacyLocator?: ArchiveCopyRecord;
    }
);

export type OriginalReuseIdentity = {
  sourceExternalId: string;
  sha256: string;
  byteLength: number;
  mediaType: BinaryMediaType;
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
    independent_backup?: ArchiveCopyIntent;
  };
  createdAt: number;
};

export type DurableParserOutput = {
  outputId: string;
  outputRoot: LocalDirectoryIdentity;
  outputDirectory: LocalDirectoryIdentity;
  sourceSha256: string;
  rawArtifact: LocalFileIdentity & {
    /** The parser output media type of the class that produced it. */
    mediaType: BinaryParserOutputMediaType;
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
    independent_backup?: ArchiveCopyRecord;
  };
  /** Preserved evidence from an interrupted provider v1 run. Never executed. */
  legacyIndependentBackup?: ArchiveCopyRecord;
  capture?: LocalFileIdentity & { sourceModifiedAt: number };
  parserOutput?: DurableParserOutput;
  spoolPrepared?: LocalFileIdentity;
  spool?: LocalFileIdentity;
  /**
   * A bounded count of local parser failures for this exact row (content +
   * parser fingerprints), recorded when `runCapturedPdfParser` raises a
   * document-level failure (conversion_failed, page_limit_exceeded,
   * bundle_too_large, conversion_output_invalid) instead of an
   * infrastructure one. `pdfNeedsArchivedWork` stops retrying once
   * `attempts` reaches the bound; a parser version bump changes
   * `fingerprints.parserFingerprint`, which yields a fresh row (and a fresh
   * count) automatically.
   */
  parseFailure?: { code: string; attempts: number; failedAt: number };
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
  receiptReconcile?: ReceiptReconcileNote[];
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

export type ArchiveBoundaryRelocationArtifactBinding =
  ArchiveBoundaryRelocationArtifact & {
    kind: "original_backup" | "provider_locator" | "parser_backup";
    catalogId: string;
    plaintextSha256: string;
    plaintextByteLength: number;
  };

export type ArchiveBoundaryRelocationPreparation = {
  authorityDigest: string;
  catalogRevision: number;
  oldBoundary: RemoteBackupBoundary;
  artifacts: ArchiveBoundaryRelocationArtifact[];
  artifactBindings: ArchiveBoundaryRelocationArtifactBinding[];
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
