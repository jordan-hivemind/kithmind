import type { BinaryMediaType } from "@repo/worker-protocol";

export type GapCode =
  | "empty"
  | "enumeration_interrupted"
  | "oversized"
  | "permission_denied"
  | "unreadable"
  | "unstable"
  | "unsupported"
  | "encrypted"
  | "not_downloaded";

export type RootConfig = {
  alias: string;
  path: string;
  includeFiles?: string[];
};
export type PdfDocQaProfile = {
  parserProfileId: "pdf_docqa_v1";
  parserFingerprint: string;
  extractionConfigurationFingerprint: string;
  extractorFingerprint: string;
  recordSchemaFingerprint: string;
  normalizationFingerprint: string;
  chunkerFingerprint: string;
  correctionRevision: string;
};

export type PdfDocQaArchiveIdentity = {
  archiveProfileFingerprint: string;
  archiveIdentityFingerprint: string;
  recipientFingerprint: string;
  repositoryKeyDomainFingerprint: string;
  storageFailureDomainFingerprint: string;
};

/**
 * ADM-4c. One watched root bound to one provider folder. The account-level
 * fields live on `PdfDocQaProviderOriginal` because one Dropbox account, one
 * refresh credential and one binding registry serve every root.
 */
export type PdfDocQaProviderRoot = {
  rootAlias: string;
  providerRootDirectoryId: string;
  providerRootDirectoryIdHash: string;
};

/**
 * ADM-4c. A watched root with no entry here is archived exactly as it would be
 * with `providerOriginal` absent: both archive copies are the pipeline's own,
 * and no provider binding is created. That is not an error, so nothing may
 * throw `provider_original_root_mismatch` for it.
 *
 * `parseConfig` also accepts the pre-ADM-4c shape, which carried `rootAlias`,
 * `providerRootDirectoryId` and `providerRootDirectoryIdHash` beside the
 * account fields, and normalizes it to a one-element `roots`. The owner's
 * existing config file therefore needs no edit.
 */
export type PdfDocQaProviderOriginal = {
  providerAccountIdHash: string;
  refreshPath: string;
  registryDirectory: string;
  roots: PdfDocQaProviderRoot[];
};

export type PdfDocQaConfig = {
  captureDirectory: string;
  parserOutputRoot: string;
  spoolDirectory: string;
  parser: {
    pythonExecutable: string;
    expectedPythonSha256: string;
    launcherPath: string;
    expectedLauncherSha256: string;
    packageRoot: string;
    modelAssetsPath: string;
    modelLockPath: string;
    expectedModelLockSha256: string;
    tableStructure?: "on" | "off";
    tableStructureBypass?: Record<string, number[]>;
  };
  profile: PdfDocQaProfile;
  providerOriginal?: PdfDocQaProviderOriginal;
  archive: {
    ageBinary: string;
    primary: PdfDocQaArchiveIdentity & { directory: string; recipient: string };
    independentBackup: PdfDocQaArchiveIdentity & {
      directory: string;
      recipient: string;
      resticBinary: string;
      expectedRepositoryId: string;
      passwordCommand: { executable: string; publicArgs?: string[] };
      host: string;
    } & (
        | { repositoryPath: string; repository?: never }
        | {
            repositoryPath?: never;
            repository: {
              kind: "rclone_dropbox_v1";
              remoteName: string;
              rootPath: string;
              rcloneBinary: string;
              configPath: string;
              configIdentityFingerprint: string;
              expectedRootDirectoryIdHash: string;
            };
          }
      );
  };
};

export type PipelineConfig = {
  protocolVersion: 1;
  endpoint: string;
  spaceId: string;
  sourceAccountId: string;
  credentialEnv: string;
  roots: RootConfig[];
  journalDir: string;
  hostAffinity?: string;
  watchIntervalMs: number;
  maxFiles: number;
  maxDepth: number;
  maxFileBytes: number;
  /** Minimum delay, in ms, between consecutive `processing.assessPage`
   * mutations. Lets a bounded backfill pace itself under the server's
   * per-worker mutation rate limit instead of bouncing off it. Omitting
   * this field applies `DEFAULT_ASSESSMENT_PACING_MS` (see runner.ts); pass
   * `0` explicitly to disable pacing. */
  assessmentPacingMs?: number;
  pdfDocQa?: PdfDocQaConfig;
};

export type DiscoveryFile = {
  rootAlias: string;
  relativePath: string;
  uri: string;
  sourceModifiedAt: number;
  sha256: string;
  byteLength: number;
  text: string;
};

/** A binary source observation is only a local descriptor. It carries no proof
 * that the configured parser profile has been prepared or is safe to use.
 *
 * P2-70i3: the descriptor covers every class in `BINARY_CLASSES`, not only
 * PDF. `mediaType` is the class: media types are one to one with classes, so
 * no second field can disagree with it. The observation kind stays `pdf`
 * because it is the binary lane's tag in a durable resume recipe, and renaming
 * it would reject recipes that are already written. */
export type PdfDiscoveryFile = Omit<DiscoveryFile, "text"> & {
  mediaType: BinaryMediaType;
  // P2-77: set when the file's only encryption is a permissions
  // restriction whose empty user password validated against the standard
  // security handler (owner decision 2026-09-12: admit these rather than
  // exclude them). `encryptionRevision` is the handler revision (2-6) that
  // validated. Absent for an unencrypted PDF.
  permissionsRestricted?: boolean;
  encryptionRevision?: number;
};

export type DiscoveryGap = Pick<
  DiscoveryFile,
  "rootAlias" | "relativePath" | "uri" | "sourceModifiedAt"
> & {
  code: "empty" | "oversized" | "unsupported" | "encrypted" | "not_downloaded";
};

export type SourceObservation =
  | { kind: "utf8"; file: DiscoveryFile }
  | { kind: "pdf"; file: PdfDiscoveryFile }
  | { kind: "gap"; gap: DiscoveryGap };

export type IdentityBinding = {
  rootAlias: string;
  relativePath: string;
  externalId: string;
  /**
   * ADM-4a. The provider's stable file id, when one is known. It is what the
   * item is remembered by: a renamed or moved file keeps its external id
   * because this does not change. The path stays the fallback, for a root with
   * no provider, a file the provider does not know yet, and every journal
   * written before this field existed.
   */
  providerFileId?: string;
};

export type PipelineRunResult = {
  state: "complete" | "incomplete" | "failed";
  code?: string;
  scanned?: number;
  published?: number;
  /**
   * P2-31f. Documents held back by a per-item admission condition. All three
   * are absent when nothing is parked, so a healthy pass reads exactly as it
   * did before and a `complete` pass carrying them is "healthy with parked
   * items": a monitor alerts on the count, the codes, or the age.
   */
  parked?: number;
  /**
   * Of those, the ones nothing will free on their own: a code with no
   * automatic recovery, or retries already spent. Any at all ends the pass
   * `incomplete` with code `items_need_attention`, and so with a nonzero exit.
   */
  parkedEscalated?: number;
  parkedCodes?: string[];
  parkedOldestAgeMs?: number;
  /** P2-31f: receipts `run --operator-clear` retired in this pass. */
  operatorClears?: number;
};

export type WorkerErrorCode =
  | "not_authenticated"
  | "not_authorized"
  | "invalid_request"
  | "not_found"
  | "source_unavailable"
  | "request_conflict"
  | "scan_conflict"
  | "scan_not_ready"
  | "identity_review_required"
  | "rate_limited"
  | "reservation_expired"
  | "stale_observation"
  | "desired_processing_epoch_conflict"
  | "lease_conflict";
export type WorkerError = { error: { code: WorkerErrorCode } };
export type WorkerResponse = Record<string, unknown> | WorkerError;

export interface WorkerTransport {
  call(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkerResponse>;
}
