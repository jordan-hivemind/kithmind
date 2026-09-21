import {
  isBinaryParserProfileId,
  type BinaryParserProfileId,
} from "@repo/worker-protocol";
import {
  MAX_WORKER_SCAN_ENTRIES,
  MAX_WORKER_SCAN_PAGES,
} from "@repo/worker-protocol/request";

import type { IdentityBinding, WorkerErrorCode } from "./types.js";

/**
 * ADM-4c: the checkpoint's plan bound, raised from 256 to the scan manifest's
 * own ceiling so three watched folders fit in one pass. A plan carries seven
 * 64-hex fingerprints, so 1024 of them is about 940 KiB of checkpoint; see
 * `MAX_CHECKPOINT_BYTES` in journal.ts, which was raised with it.
 */
const MAX_FILES = MAX_WORKER_SCAN_ENTRIES;
const MAX_IDENTITIES = 4_096;
/**
 * ADM-4c. Identity bindings are bounded separately from file plans: the list
 * is every item this journal remembers, which outlives the files currently on
 * disk. Removing a watched root leaves its items here until the server has
 * retired them, and that must not refuse the journal.
 */
export const MAX_IDENTITY_BINDINGS = MAX_IDENTITIES;
/**
 * ADM-4c review. The scan page ordinal was bounded by a hardcoded 64, the old
 * `MAX_WORKER_SCAN_PAGES`. Raising the protocol ceiling without this made a
 * scan past 256 files write a checkpoint its own validator refused, mid-pass.
 * `round` and `reservationRound` below are different counters with their own
 * bounds and are deliberately left alone.
 */
const MAX_PATH_BYTES = 2_048;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const ROOT_ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** ADM-4a. A provider's opaque file id, e.g. Dropbox's `id:...`. */
const PROVIDER_FILE_ID = /^[A-Za-z0-9:._-]{1,256}$/;

type PlanLocation = {
  rootAlias: string;
  relativePath: string;
  sourceModifiedAt: number;
  externalId?: string;
  /** ADM-4a. See `IdentityBinding.providerFileId`. Never sent to the server. */
  providerFileId?: string;
};

/** Untagged UTF-8 plans are retained for every existing version-1 journal. */
export type Utf8FilePlan = PlanLocation & {
  sha256: string;
  byteLength: number;
};

/**
 * The archived-binary lane's plan, for any class in `BINARY_CLASSES`.
 *
 * P2-70i3: `parserProfileId` is the class, and `kind` stays `"pdf"` because it
 * is the tag every version-1 journal already wrote for this lane. Renaming it
 * would make a resumed journal unreadable for no gain: the class is the field
 * beside it, and nothing reads `kind` for more than "this is the binary lane,
 * not UTF-8 and not a gap".
 */
export type PdfFilePlan = PlanLocation & {
  kind: "pdf";
  sha256: string;
  byteLength: number;
  parserProfileId: BinaryParserProfileId;
  parserFingerprint: string;
  extractionConfigurationFingerprint: string;
  extractorFingerprint: string;
  recordSchemaFingerprint: string;
  normalizationFingerprint: string;
  chunkerFingerprint: string;
  correctionRevision: string;
  sourceItemId?: string;
  observationEpoch?: number;
  processingEpoch?: number;
  discoveryState?: "queued" | "unchanged";
  // P2-77: carried through from `PdfDiscoveryFile` so a resumed journal
  // reproduces the same admitted-with-restriction plan a fresh scan would.
  permissionsRestricted?: boolean;
  encryptionRevision?: number;
};

export type GapFilePlan = PlanLocation & {
  kind: "gap";
  code: "empty" | "oversized" | "unsupported" | "encrypted" | "not_downloaded";
};

export type FilePlan = Utf8FilePlan | PdfFilePlan | GapFilePlan;

export type InventoryIdentity = {
  sourceItemId: string;
  externalId: string;
};

export type DiscoveryLease = {
  workId: string;
  sourceItemId: string;
  observationEpoch: number;
  processingEpoch: number;
  leaseEpoch: number;
  leaseToken: string;
  leaseExpiresAt: number;
  uri: string;
  contentHash: string;
  byteLength: number;
};

export type JobLease = {
  jobId: string;
  workId: string;
  sourceItemId: string;
  observationEpoch: number;
  processingEpoch: number;
  state: "processing" | "staged";
  leaseEpoch: number;
  leaseToken: string;
  leaseExpiresAt: number;
};

/**
 * P2-104d. Archive receipts this document reuses instead of declaring its own,
 * as `discovery.lookupArchivedAdmission` reported them. The backup pair is
 * absent for an original whose independent copy is a provider reference.
 */
export type ArchiveReceiptReuse = {
  primaryReceiptId?: string;
  primaryBindingEpoch?: number;
  backupReceiptId?: string;
  backupBindingEpoch?: number;
  /**
   * P2-104e. The provider original reference the server reports bound to
   * these bytes, which stands where the backup receipt would. Admission
   * selects it rather than declaring the reference a second time.
   */
  providerReferenceId?: string;
  providerBindingEpoch?: number;
  providerReferenceVersion?: "provider_original_v2";
};

/**
 * The same, plus the parser artifact those receipts belong to. Both copies are
 * required here: the server offers a parser artifact for reuse only when both
 * of its archive copies are currently bound.
 */
export type ParserArtifactReuse = ArchiveReceiptReuse & {
  parserArtifactId: string;
};

export type ArchivedDiscoveryLease = Omit<
  DiscoveryLease,
  "uri" | "contentHash" | "byteLength"
>;

export type ArchivedStep =
  | "intent"
  | "preflight"
  | "lookup_original"
  | "capture"
  | "original_archive"
  | "parse"
  | "spool"
  | "lookup_processing"
  | "parser_archive"
  | "reserve"
  | "admit"
  | "parsed_reserve"
  | "parsed_renew"
  | "parsed_begin"
  | "parsed_batch"
  | "parsed_seal"
  | "parsed_activate"
  | "cleanup";

type PlannedScan = {
  mode: "normal" | "identity_recovery";
  expectedInventoryEpoch: number;
  files: FilePlan[];
  missingBindings: IdentityBinding[];
};

type ActiveScan = Omit<PlannedScan, "expectedInventoryEpoch"> & {
  scanId: string;
  inventoryEpoch: number;
  manifestVersion: number;
};

type ProcessingRun = {
  scanId: string;
  scanned: number;
  published: number;
  bindings: IdentityBinding[];
};

type ArchivedRun = ActiveScan & {
  pdfIndex: number;
  step: ArchivedStep;
  reservationRound: number;
  archivedPublished: number;
  countPublication?: boolean;
  originalCatalogId?: string;
  expectedOriginalRevision?: number;
  processingCatalogId?: string;
  expectedProcessingRevision?: number;
  preflightAction?:
    | "initial"
    | "original_primary_publish"
    | "original_backup_publish"
    | "original_backup_snapshot"
    | "parser_primary_publish"
    | "parser_backup_publish"
    | "parser_backup_snapshot"
    | "provider_verify"
    | "provider_locator_prepare"
    | "provider_locator_publish"
    | "provider_locator_snapshot";
  /**
   * P2-31c. Set once a pass has asked the server whether it knows this row's
   * admission receipt, so the question is asked at most once per cycle.
   */
  receiptChecked?: boolean;
  /**
   * P2-104d. Set while this document is to reuse a parser artifact the server
   * already holds, rather than archive its parser output and create one.
   * Re-derived from `discovery.lookupArchivedAdmission` on every pass that
   * reaches `lookup_processing`, so it is state, not a decision to remember.
   */
  parserReuse?: ParserArtifactReuse;
  /**
   * P2-104d. Set while this document's original bytes are already admitted:
   * the receipts over them are immutable and bound to the admission that
   * created them, so a second processing generation has to select them rather
   * than declare them again.
   */
  originalReuse?: ArchiveReceiptReuse;
  discoveryLease?: ArchivedDiscoveryLease;
  jobLease?: JobLease;
  resumeStep?:
    "parsed_begin" | "parsed_batch" | "parsed_seal" | "parsed_activate";
  stageId?: string;
  stagePhase?:
    "pages" | "evidence" | "documents" | "chunks" | "seal" | "staged";
  stageOrdinal?: number;
  priorityReceipt?: {
    version: 1;
    manifestSha256: string;
    reason: "active_goal" | "code_acceptance" | "explicit_user_request";
    selectedCount: number;
    selectedIdentitySha256: string;
  };
  providerV2Transition?: {
    version: 1;
    previousConfigSha256: string;
    proposedConfigSha256: string;
    transitionedAt: number;
  };
};

export type RunnerCheckpoint =
  | { version: 1; phase: "idle" }
  | {
      version: 1;
      phase: "terminal";
      outcome: "complete" | "incomplete" | "failed";
      credentialSessionActive: boolean;
      bindings: IdentityBinding[];
      scanned: number;
      published: number;
      code?: string;
      scanId?: string;
      assessmentId?: string;
    }
  | ({ version: 1; phase: "scan_begin" } & PlannedScan)
  | ({
      version: 1;
      phase: "inventory";
      cursor: string | null;
      pageCount: number;
      itemCount: number;
      identities: InventoryIdentity[];
    } & ActiveScan)
  | ({
      version: 1;
      phase: "append";
      nextOrdinal: number;
      identities: InventoryIdentity[];
      reviewSeen: boolean;
    } & ActiveScan)
  | ({
      version: 1;
      phase: "seal_check";
      nextOrdinal: number;
      reviewSeen: boolean;
    } & ActiveScan)
  | ({
      version: 1;
      phase: "seal";
      nextOrdinal: number;
      reviewSeen: boolean;
      health: { status: "healthy" } | { status: "failed"; code: string };
    } & ActiveScan)
  | ({
      version: 1;
      phase: "reconcile";
      ordinal: number;
      reviewSeen: boolean;
    } & ActiveScan)
  | ({
      version: 1;
      phase: "discovery_reserve";
      round: number;
      archivedPublished?: number;
    } & ActiveScan)
  | ({ version: 1; phase: "archived" } & ArchivedRun)
  | ({
      version: 1;
      phase: "discovery_admit";
      round: number;
      targets: DiscoveryLease[];
      index: number;
      archivedPublished?: number;
    } & ActiveScan)
  | ({ version: 1; phase: "jobs_reserve"; round: number } & ProcessingRun)
  | ({
      version: 1;
      phase: "jobs_renew" | "jobs_stage" | "jobs_activate";
      round: number;
      jobs: JobLease[];
      index: number;
    } & ProcessingRun)
  | ({
      version: 1;
      phase: "jobs_fail";
      round: number;
      jobs: JobLease[];
      index: number;
      failureCode: "staging_invalid";
    } & ProcessingRun)
  | ({ version: 1; phase: "assess_status" } & ProcessingRun)
  | ({
      version: 1;
      phase: "assess_begin";
      expectedInventoryEpoch: number;
      expectedManifestVersion: number;
    } & ProcessingRun)
  | ({
      version: 1;
      phase: "assess_page";
      assessmentId: string;
      ordinal: number;
      pageCount: number;
    } & ProcessingRun);

function fail(): never {
  throw new Error("Pipeline journal checkpoint is invalid");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    fail();
  }
}

function string(
  value: unknown,
  maximumBytes = 8_192,
  pattern?: RegExp,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    fail();
  }
  return value;
}

function id(value: unknown): string {
  return string(value, 256, ID);
}

function integer(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    fail();
  }
  return value as number;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}

function bindings(value: unknown): IdentityBinding[] {
  if (!Array.isArray(value) || value.length > MAX_IDENTITY_BINDINGS) fail();
  const paths = new Set<string>();
  const externalIds = new Set<string>();
  const owners = new Map<string, number>();
  const parsed = value.map((raw) => {
    const row = object(raw);
    // ADM-4a: `providerFileId` is optional, so a journal written before it
    // existed parses unchanged and is upgraded in place on the next pass.
    exact(row, ["rootAlias", "relativePath", "externalId"], ["providerFileId"]);
    const rootAlias = string(row.rootAlias, 64, ROOT_ALIAS);
    const relativePath = string(row.relativePath, MAX_PATH_BYTES);
    const externalId = string(row.externalId, 36, UUID);
    const providerFileId =
      row.providerFileId === undefined
        ? undefined
        : string(row.providerFileId, 256, PROVIDER_FILE_ID);
    const key = `${rootAlias}\0${relativePath}`;
    if (paths.has(key) || externalIds.has(externalId)) fail();
    paths.add(key);
    externalIds.add(externalId);
    if (providerFileId !== undefined) {
      owners.set(providerFileId, (owners.get(providerFileId) ?? 0) + 1);
    }
    return {
      rootAlias,
      relativePath,
      externalId,
      ...(providerFileId === undefined ? {} : { providerFileId }),
    };
  });
  // ADM-4a: two bindings naming one provider file is a contradiction, but it is
  // not a reason to refuse the journal. A refusal here would wedge the worker
  // on every pass with nothing but a hand edit to clear it, which is exactly
  // what a durable journal must never require. Dropping the id from both
  // leaves two ordinary path-keyed bindings, and the next pass re-resolves
  // them. Path and external id uniqueness still fail closed: those are the
  // identity itself.
  return parsed.map((binding) =>
    binding.providerFileId !== undefined &&
    owners.get(binding.providerFileId)! > 1
      ? {
          rootAlias: binding.rootAlias,
          relativePath: binding.relativePath,
          externalId: binding.externalId,
        }
      : binding,
  );
}

function files(value: unknown): FilePlan[] {
  if (!Array.isArray(value) || value.length > MAX_FILES) fail();
  const paths = new Set<string>();
  const externalIds = new Set<string>();
  return value.map((raw) => {
    const row = object(raw);
    const kind = row.kind;
    const required = ["rootAlias", "relativePath", "sourceModifiedAt"];
    if (kind === undefined) {
      exact(
        row,
        [...required, "sha256", "byteLength"],
        ["externalId", "providerFileId"],
      );
    } else if (kind === "pdf") {
      exact(
        row,
        [
          ...required,
          "kind",
          "sha256",
          "byteLength",
          "parserProfileId",
          "parserFingerprint",
          "extractionConfigurationFingerprint",
          "extractorFingerprint",
          "recordSchemaFingerprint",
          "normalizationFingerprint",
          "chunkerFingerprint",
          "correctionRevision",
        ],
        [
          "externalId",
          "providerFileId",
          "sourceItemId",
          "observationEpoch",
          "processingEpoch",
          "discoveryState",
          "permissionsRestricted",
          "encryptionRevision",
        ],
      );
    } else if (kind === "gap") {
      exact(
        row,
        [...required, "kind", "code"],
        ["externalId", "providerFileId"],
      );
    } else fail();
    const rootAlias = string(row.rootAlias, 64, ROOT_ALIAS);
    const relativePath = string(row.relativePath, MAX_PATH_BYTES);
    const key = `${rootAlias}\0${relativePath}`;
    if (paths.has(key)) fail();
    paths.add(key);
    const externalId =
      row.externalId === undefined
        ? undefined
        : string(row.externalId, 36, UUID);
    if (externalId !== undefined) {
      if (externalIds.has(externalId)) fail();
      externalIds.add(externalId);
    }
    const location = {
      rootAlias,
      relativePath,
      sourceModifiedAt: integer(row.sourceModifiedAt),
      ...(externalId === undefined ? {} : { externalId }),
      ...(row.providerFileId === undefined
        ? {}
        : {
            providerFileId: string(row.providerFileId, 256, PROVIDER_FILE_ID),
          }),
    };
    if (kind === undefined) {
      return {
        ...location,
        sha256: string(row.sha256, 64, HEX_64),
        byteLength: integer(row.byteLength, 1, 65_536),
      };
    }
    if (kind === "gap") {
      if (
        row.code !== "empty" &&
        row.code !== "oversized" &&
        row.code !== "unsupported" &&
        row.code !== "encrypted" &&
        row.code !== "not_downloaded"
      )
        fail();
      return { ...location, kind: "gap" as const, code: row.code };
    }
    if (!isBinaryParserProfileId(row.parserProfileId)) fail();
    const sourceItemId =
      row.sourceItemId === undefined ? undefined : id(row.sourceItemId);
    const observationEpoch =
      row.observationEpoch === undefined
        ? undefined
        : integer(row.observationEpoch);
    const processingEpoch =
      row.processingEpoch === undefined
        ? undefined
        : integer(row.processingEpoch);
    const discoveryState =
      row.discoveryState === undefined
        ? undefined
        : row.discoveryState === "queued" || row.discoveryState === "unchanged"
          ? row.discoveryState
          : fail();
    const encryptionRevision =
      row.encryptionRevision === undefined
        ? undefined
        : integer(row.encryptionRevision, 2, 6);
    const permissionsRestricted =
      row.permissionsRestricted === undefined
        ? undefined
        : boolean(row.permissionsRestricted);
    if (
      (permissionsRestricted === undefined) !==
      (encryptionRevision === undefined)
    )
      fail();
    if (
      (sourceItemId === undefined ||
        observationEpoch === undefined ||
        processingEpoch === undefined) &&
      (sourceItemId !== undefined ||
        observationEpoch !== undefined ||
        processingEpoch !== undefined)
    )
      fail();
    return {
      ...location,
      kind: "pdf" as const,
      sha256: string(row.sha256, 64, HEX_64),
      byteLength: integer(row.byteLength, 1, 16 * 1024 * 1024),
      parserProfileId: row.parserProfileId,
      parserFingerprint: string(row.parserFingerprint, 64, HEX_64),
      extractionConfigurationFingerprint: string(
        row.extractionConfigurationFingerprint,
        64,
        HEX_64,
      ),
      extractorFingerprint: string(row.extractorFingerprint, 1_024),
      recordSchemaFingerprint: string(row.recordSchemaFingerprint, 1_024),
      normalizationFingerprint: string(row.normalizationFingerprint, 1_024),
      chunkerFingerprint: string(row.chunkerFingerprint, 1_024),
      correctionRevision: string(row.correctionRevision, 1_024),
      ...(sourceItemId === undefined
        ? {}
        : { sourceItemId, observationEpoch, processingEpoch }),
      ...(discoveryState === undefined ? {} : { discoveryState }),
      ...(permissionsRestricted === undefined
        ? {}
        : { permissionsRestricted, encryptionRevision }),
    };
  });
}

function identities(value: unknown): InventoryIdentity[] {
  if (!Array.isArray(value) || value.length > MAX_IDENTITIES) fail();
  const sourceItems = new Set<string>();
  const externalIds = new Set<string>();
  return value.map((raw) => {
    const row = object(raw);
    exact(row, ["sourceItemId", "externalId"]);
    const sourceItemId = id(row.sourceItemId);
    if (sourceItems.has(sourceItemId)) fail();
    sourceItems.add(sourceItemId);
    const externalId = string(row.externalId, 36, UUID);
    if (externalIds.has(externalId)) fail();
    externalIds.add(externalId);
    return { sourceItemId, externalId };
  });
}

function discoveryLeases(value: unknown): DiscoveryLease[] {
  if (!Array.isArray(value) || value.length > 4) fail();
  const workIds = new Set<string>();
  return value.map((raw) => {
    const row = object(raw);
    exact(row, [
      "workId",
      "sourceItemId",
      "observationEpoch",
      "processingEpoch",
      "leaseEpoch",
      "leaseToken",
      "leaseExpiresAt",
      "uri",
      "contentHash",
      "byteLength",
    ]);
    const workId = id(row.workId);
    if (workIds.has(workId)) fail();
    workIds.add(workId);
    return {
      workId,
      sourceItemId: id(row.sourceItemId),
      observationEpoch: integer(row.observationEpoch),
      processingEpoch: integer(row.processingEpoch),
      leaseEpoch: integer(row.leaseEpoch, 1),
      leaseToken: string(row.leaseToken, 64, HEX_64),
      leaseExpiresAt: integer(row.leaseExpiresAt, 1),
      uri: string(row.uri, 2_048),
      contentHash: string(row.contentHash, 64, HEX_64),
      byteLength: integer(row.byteLength, 1, 65_536),
    };
  });
}

function jobLeases(value: unknown): JobLease[] {
  if (!Array.isArray(value) || value.length > 4) fail();
  const jobIds = new Set<string>();
  return value.map((raw) => {
    const row = object(raw);
    exact(row, [
      "jobId",
      "workId",
      "sourceItemId",
      "observationEpoch",
      "processingEpoch",
      "state",
      "leaseEpoch",
      "leaseToken",
      "leaseExpiresAt",
    ]);
    if (row.state !== "processing" && row.state !== "staged") fail();
    const jobId = id(row.jobId);
    if (jobIds.has(jobId)) fail();
    jobIds.add(jobId);
    return {
      jobId,
      workId: id(row.workId),
      sourceItemId: id(row.sourceItemId),
      observationEpoch: integer(row.observationEpoch),
      processingEpoch: integer(row.processingEpoch),
      state: row.state,
      leaseEpoch: integer(row.leaseEpoch, 1),
      leaseToken: string(row.leaseToken, 64, HEX_64),
      leaseExpiresAt: integer(row.leaseExpiresAt, 1),
    };
  });
}

function archivedDiscoveryLease(value: unknown): ArchivedDiscoveryLease {
  const row = object(value);
  exact(row, [
    "workId",
    "sourceItemId",
    "observationEpoch",
    "processingEpoch",
    "leaseEpoch",
    "leaseToken",
    "leaseExpiresAt",
  ]);
  return {
    workId: id(row.workId),
    sourceItemId: id(row.sourceItemId),
    observationEpoch: integer(row.observationEpoch),
    processingEpoch: integer(row.processingEpoch),
    leaseEpoch: integer(row.leaseEpoch, 1),
    leaseToken: string(row.leaseToken, 64, HEX_64),
    leaseExpiresAt: integer(row.leaseExpiresAt, 1),
  };
}

function archiveReceiptReuse(value: unknown): ArchiveReceiptReuse {
  const row = object(value);
  exact(
    row,
    [],
    [
      "primaryReceiptId",
      "primaryBindingEpoch",
      "backupReceiptId",
      "backupBindingEpoch",
      "providerReferenceId",
      "providerBindingEpoch",
      "providerReferenceVersion",
    ],
  );
  if (
    (row.primaryReceiptId === undefined) !==
      (row.primaryBindingEpoch === undefined) ||
    (row.backupReceiptId === undefined) !==
      (row.backupBindingEpoch === undefined) ||
    (row.providerReferenceId === undefined) !==
      (row.providerBindingEpoch === undefined) ||
    (row.backupReceiptId !== undefined && row.providerReferenceId !== undefined) ||
    (row.providerReferenceVersion !== undefined &&
      (row.providerReferenceVersion !== "provider_original_v2" ||
        row.providerReferenceId === undefined ||
        row.primaryReceiptId !== undefined)) ||
    (row.primaryReceiptId === undefined && row.providerReferenceId === undefined) ||
    (row.backupReceiptId !== undefined && row.primaryReceiptId === undefined)
  )
    fail();
  return {
    ...(row.primaryReceiptId === undefined
      ? {}
      : {
          primaryReceiptId: id(row.primaryReceiptId),
          primaryBindingEpoch: integer(row.primaryBindingEpoch),
        }),
    ...(row.backupReceiptId === undefined
      ? {}
      : {
          backupReceiptId: id(row.backupReceiptId),
          backupBindingEpoch: integer(row.backupBindingEpoch),
        }),
    ...(row.providerReferenceId === undefined
      ? {}
      : {
          providerReferenceId: id(row.providerReferenceId),
          providerBindingEpoch: integer(row.providerBindingEpoch),
          ...(row.providerReferenceVersion === undefined
            ? {}
            : { providerReferenceVersion: "provider_original_v2" as const }),
        }),
  };
}

function parserArtifactReuse(value: unknown): ParserArtifactReuse {
  const row = object(value);
  const { parserArtifactId, ...receipts } = row;
  const copies = archiveReceiptReuse(receipts);
  if (
    copies.primaryReceiptId === undefined ||
    copies.providerReferenceId !== undefined
  )
    fail();
  return {
    parserArtifactId: id(parserArtifactId),
    ...copies,
  };
}

function priorityReceipt(
  value: unknown,
): NonNullable<ArchivedRun["priorityReceipt"]> {
  const row = object(value);
  exact(row, [
    "version",
    "manifestSha256",
    "reason",
    "selectedCount",
    "selectedIdentitySha256",
  ]);
  if (
    row.version !== 1 ||
    (row.reason !== "active_goal" &&
      row.reason !== "code_acceptance" &&
      row.reason !== "explicit_user_request")
  )
    fail();
  return {
    version: 1,
    manifestSha256: string(row.manifestSha256, 64, HEX_64),
    reason: row.reason,
    selectedCount: integer(row.selectedCount, 1, MAX_FILES),
    selectedIdentitySha256: string(row.selectedIdentitySha256, 64, HEX_64),
  };
}

const scanBaseFields = [
  "version",
  "phase",
  "mode",
  "scanId",
  "inventoryEpoch",
  "manifestVersion",
  "files",
  "missingBindings",
] as const;
const processingFields = [
  "version",
  "phase",
  "scanId",
  "scanned",
  "published",
  "bindings",
] as const;

function scanBase(input: Record<string, unknown>): ActiveScan {
  if (input.mode !== "normal" && input.mode !== "identity_recovery") fail();
  return {
    mode: input.mode,
    scanId: id(input.scanId),
    inventoryEpoch: integer(input.inventoryEpoch),
    manifestVersion: integer(input.manifestVersion),
    files: files(input.files),
    missingBindings: bindings(input.missingBindings),
  };
}

function processing(input: Record<string, unknown>): ProcessingRun {
  return {
    scanId: id(input.scanId),
    scanned: integer(input.scanned, 0, MAX_FILES),
    published: integer(input.published, 0, MAX_FILES),
    bindings: bindings(input.bindings),
  };
}

export function parseRunnerCheckpoint(value: unknown): RunnerCheckpoint {
  const input = object(value);
  if (input.version !== 1 || typeof input.phase !== "string") fail();
  if (input.phase === "idle") {
    exact(input, ["version", "phase"]);
    return { version: 1, phase: "idle" };
  }
  if (input.phase === "terminal") {
    exact(
      input,
      [
        "version",
        "phase",
        "outcome",
        "credentialSessionActive",
        "bindings",
        "scanned",
        "published",
      ],
      ["code", "scanId", "assessmentId"],
    );
    if (
      input.outcome !== "complete" &&
      input.outcome !== "incomplete" &&
      input.outcome !== "failed"
    ) {
      fail();
    }
    return {
      version: 1,
      phase: "terminal",
      outcome: input.outcome,
      credentialSessionActive: boolean(input.credentialSessionActive),
      bindings: bindings(input.bindings),
      scanned: integer(input.scanned, 0, MAX_FILES),
      published: integer(input.published, 0, MAX_FILES),
      ...(input.code === undefined ? {} : { code: string(input.code, 64) }),
      ...(input.scanId === undefined ? {} : { scanId: id(input.scanId) }),
      ...(input.assessmentId === undefined
        ? {}
        : { assessmentId: id(input.assessmentId) }),
    };
  }
  if (input.phase === "scan_begin") {
    exact(input, [
      "version",
      "phase",
      "mode",
      "expectedInventoryEpoch",
      "files",
      "missingBindings",
    ]);
    if (input.mode !== "normal" && input.mode !== "identity_recovery") fail();
    return {
      version: 1,
      phase: "scan_begin",
      mode: input.mode,
      expectedInventoryEpoch: integer(input.expectedInventoryEpoch),
      files: files(input.files),
      missingBindings: bindings(input.missingBindings),
    };
  }
  if (input.phase === "inventory") {
    exact(input, [
      ...scanBaseFields,
      "cursor",
      "pageCount",
      "itemCount",
      "identities",
    ]);
    const base = scanBase(input);
    if (base.mode !== "identity_recovery") fail();
    return {
      version: 1,
      phase: "inventory",
      ...base,
      cursor: input.cursor === null ? null : string(input.cursor, 8_192),
      pageCount: integer(input.pageCount, 0, 128),
      itemCount: integer(input.itemCount, 0, MAX_IDENTITIES),
      identities: identities(input.identities),
    };
  }
  if (input.phase === "append") {
    exact(input, [
      ...scanBaseFields,
      "nextOrdinal",
      "identities",
      "reviewSeen",
    ]);
    return {
      version: 1,
      phase: "append",
      ...scanBase(input),
      nextOrdinal: integer(input.nextOrdinal, 0, MAX_WORKER_SCAN_PAGES),
      identities: identities(input.identities),
      reviewSeen: boolean(input.reviewSeen),
    };
  }
  if (input.phase === "seal_check") {
    exact(input, [...scanBaseFields, "nextOrdinal", "reviewSeen"]);
    return {
      version: 1,
      phase: "seal_check",
      ...scanBase(input),
      nextOrdinal: integer(input.nextOrdinal, 0, MAX_WORKER_SCAN_PAGES),
      reviewSeen: boolean(input.reviewSeen),
    };
  }
  if (input.phase === "seal") {
    exact(input, [...scanBaseFields, "nextOrdinal", "reviewSeen", "health"]);
    const health = object(input.health);
    if (health.status === "healthy") exact(health, ["status"]);
    else if (health.status === "failed") {
      exact(health, ["status", "code"]);
      string(health.code, 64);
    } else fail();
    return {
      version: 1,
      phase: "seal",
      ...scanBase(input),
      nextOrdinal: integer(input.nextOrdinal, 0, MAX_WORKER_SCAN_PAGES),
      reviewSeen: boolean(input.reviewSeen),
      health:
        health.status === "healthy"
          ? { status: "healthy" }
          : { status: "failed", code: health.code as string },
    };
  }
  if (input.phase === "reconcile") {
    exact(input, [...scanBaseFields, "ordinal", "reviewSeen"]);
    return {
      version: 1,
      phase: "reconcile",
      ...scanBase(input),
      ordinal: integer(input.ordinal, 0, 255),
      reviewSeen: boolean(input.reviewSeen),
    };
  }
  if (input.phase === "discovery_reserve") {
    exact(input, [...scanBaseFields, "round"], ["archivedPublished"]);
    return {
      version: 1,
      phase: "discovery_reserve",
      ...scanBase(input),
      round: integer(input.round, 0, 64),
      ...(input.archivedPublished === undefined
        ? {}
        : {
            archivedPublished: integer(input.archivedPublished, 0, MAX_FILES),
          }),
    };
  }
  if (input.phase === "archived") {
    exact(
      input,
      [
        ...scanBaseFields,
        "pdfIndex",
        "step",
        "reservationRound",
        "archivedPublished",
      ],
      [
        "countPublication",
        "originalCatalogId",
        "expectedOriginalRevision",
        "processingCatalogId",
        "expectedProcessingRevision",
        "preflightAction",
        "receiptChecked",
        "parserReuse",
        "originalReuse",
        "discoveryLease",
        "jobLease",
        "resumeStep",
        "stageId",
        "stagePhase",
        "stageOrdinal",
        "priorityReceipt",
        "providerV2Transition",
      ],
    );
    const steps: ArchivedStep[] = [
      "intent",
      "preflight",
      "lookup_original",
      "capture",
      "original_archive",
      "parse",
      "spool",
      "lookup_processing",
      "parser_archive",
      "reserve",
      "admit",
      "parsed_reserve",
      "parsed_renew",
      "parsed_begin",
      "parsed_batch",
      "parsed_seal",
      "parsed_activate",
      "cleanup",
    ];
    if (!steps.includes(input.step as ArchivedStep)) fail();
    const result: Extract<RunnerCheckpoint, { phase: "archived" }> = {
      version: 1,
      phase: "archived",
      ...scanBase(input),
      pdfIndex: integer(input.pdfIndex, 0, MAX_FILES - 1),
      step: input.step as ArchivedStep,
      reservationRound: integer(input.reservationRound, 0, 64),
      archivedPublished: integer(input.archivedPublished, 0, MAX_FILES),
      ...(input.countPublication === undefined
        ? {}
        : { countPublication: boolean(input.countPublication) }),
      ...(input.originalCatalogId === undefined
        ? {}
        : { originalCatalogId: string(input.originalCatalogId, 36, UUID) }),
      ...(input.expectedOriginalRevision === undefined
        ? {}
        : {
            expectedOriginalRevision: integer(
              input.expectedOriginalRevision,
              1,
            ),
          }),
      ...(input.processingCatalogId === undefined
        ? {}
        : {
            processingCatalogId: string(input.processingCatalogId, 36, UUID),
          }),
      ...(input.expectedProcessingRevision === undefined
        ? {}
        : {
            expectedProcessingRevision: integer(
              input.expectedProcessingRevision,
              1,
            ),
          }),
      ...(input.preflightAction === undefined
        ? {}
        : {
            preflightAction:
              input.preflightAction === "initial" ||
              input.preflightAction === "original_primary_publish" ||
              input.preflightAction === "original_backup_publish" ||
              input.preflightAction === "original_backup_snapshot" ||
              input.preflightAction === "parser_primary_publish" ||
              input.preflightAction === "parser_backup_publish" ||
              input.preflightAction === "parser_backup_snapshot" ||
              input.preflightAction === "provider_verify" ||
              input.preflightAction === "provider_locator_prepare" ||
              input.preflightAction === "provider_locator_publish" ||
              input.preflightAction === "provider_locator_snapshot"
                ? input.preflightAction
                : fail(),
          }),
      ...(input.receiptChecked === undefined
        ? {}
        : { receiptChecked: boolean(input.receiptChecked) }),
      ...(input.parserReuse === undefined
        ? {}
        : { parserReuse: parserArtifactReuse(input.parserReuse) }),
      ...(input.originalReuse === undefined
        ? {}
        : { originalReuse: archiveReceiptReuse(input.originalReuse) }),
      ...(input.discoveryLease === undefined
        ? {}
        : { discoveryLease: archivedDiscoveryLease(input.discoveryLease) }),
      ...(input.jobLease === undefined
        ? {}
        : { jobLease: jobLeases([input.jobLease])[0]! }),
      ...(input.resumeStep === undefined
        ? {}
        : {
            resumeStep:
              input.resumeStep === "parsed_begin" ||
              input.resumeStep === "parsed_batch" ||
              input.resumeStep === "parsed_seal" ||
              input.resumeStep === "parsed_activate"
                ? input.resumeStep
                : fail(),
          }),
      ...(input.stageId === undefined ? {} : { stageId: id(input.stageId) }),
      ...(input.stagePhase === undefined
        ? {}
        : {
            stagePhase:
              input.stagePhase === "pages" ||
              input.stagePhase === "evidence" ||
              input.stagePhase === "documents" ||
              input.stagePhase === "chunks" ||
              input.stagePhase === "seal" ||
              input.stagePhase === "staged"
                ? input.stagePhase
                : fail(),
          }),
      ...(input.stageOrdinal === undefined
        ? {}
        : { stageOrdinal: integer(input.stageOrdinal) }),
      ...(input.priorityReceipt === undefined
        ? {}
        : { priorityReceipt: priorityReceipt(input.priorityReceipt) }),
      ...(input.providerV2Transition === undefined
        ? {}
        : {
            providerV2Transition: (() => {
              const receipt = object(input.providerV2Transition);
              exact(receipt, [
                "version",
                "previousConfigSha256",
                "proposedConfigSha256",
                "transitionedAt",
              ]);
              if (receipt.version !== 1) fail();
              return {
                version: 1 as const,
                previousConfigSha256: string(
                  receipt.previousConfigSha256,
                  64,
                  HEX_64,
                ),
                proposedConfigSha256: string(
                  receipt.proposedConfigSha256,
                  64,
                  HEX_64,
                ),
                transitionedAt: integer(receipt.transitionedAt),
              };
            })(),
          }),
    };
    const catalogFieldCount = [
      result.originalCatalogId,
      result.expectedOriginalRevision,
      result.processingCatalogId,
      result.expectedProcessingRevision,
    ].filter((value) => value !== undefined).length;
    if (
      (result.step === "intent" && catalogFieldCount !== 0) ||
      (result.step !== "intent" && catalogFieldCount !== 4)
    )
      fail();
    if (
      (result.stageId === undefined) !== (result.stagePhase === undefined) ||
      (result.stageId === undefined) !== (result.stageOrdinal === undefined)
    )
      fail();
    if (
      result.step === "parsed_renew" &&
      (!result.jobLease || !result.resumeStep)
    )
      fail();
    if (
      (result.step === "preflight") !==
      (result.preflightAction !== undefined)
    )
      fail();
    return result;
  }
  if (input.phase === "discovery_admit") {
    exact(
      input,
      [...scanBaseFields, "round", "targets", "index"],
      ["archivedPublished"],
    );
    const targets = discoveryLeases(input.targets);
    const index = integer(input.index, 0, targets.length);
    return {
      version: 1,
      phase: "discovery_admit",
      ...scanBase(input),
      round: integer(input.round, 0, 64),
      targets,
      index,
      ...(input.archivedPublished === undefined
        ? {}
        : {
            archivedPublished: integer(input.archivedPublished, 0, MAX_FILES),
          }),
    };
  }
  if (input.phase === "jobs_reserve") {
    exact(input, [...processingFields, "round"]);
    return {
      version: 1,
      phase: "jobs_reserve",
      ...processing(input),
      round: integer(input.round, 0, 64),
    };
  }
  if (
    input.phase === "jobs_renew" ||
    input.phase === "jobs_stage" ||
    input.phase === "jobs_activate"
  ) {
    exact(input, [...processingFields, "round", "jobs", "index"]);
    const jobs = jobLeases(input.jobs);
    return {
      version: 1,
      phase: input.phase,
      ...processing(input),
      round: integer(input.round, 0, 64),
      jobs,
      index: integer(input.index, 0, jobs.length),
    };
  }
  if (input.phase === "jobs_fail") {
    exact(input, [
      ...processingFields,
      "round",
      "jobs",
      "index",
      "failureCode",
    ]);
    if (input.failureCode !== "staging_invalid") fail();
    const jobs = jobLeases(input.jobs);
    return {
      version: 1,
      phase: "jobs_fail",
      ...processing(input),
      round: integer(input.round, 0, 64),
      jobs,
      index: integer(input.index, 0, jobs.length),
      failureCode: "staging_invalid",
    };
  }
  if (input.phase === "assess_status") {
    exact(input, processingFields);
    return { version: 1, phase: "assess_status", ...processing(input) };
  }
  if (input.phase === "assess_begin") {
    exact(input, [
      ...processingFields,
      "expectedInventoryEpoch",
      "expectedManifestVersion",
    ]);
    return {
      version: 1,
      phase: "assess_begin",
      ...processing(input),
      expectedInventoryEpoch: integer(input.expectedInventoryEpoch),
      expectedManifestVersion: integer(input.expectedManifestVersion),
    };
  }
  if (input.phase === "assess_page") {
    exact(input, [...processingFields, "assessmentId", "ordinal", "pageCount"]);
    return {
      version: 1,
      phase: "assess_page",
      ...processing(input),
      assessmentId: id(input.assessmentId),
      ordinal: integer(input.ordinal),
      pageCount: integer(input.pageCount, 0, MAX_IDENTITIES),
    };
  }
  fail();
}

export function workerErrorCode(value: unknown): WorkerErrorCode {
  const candidate = string(value, 64) as WorkerErrorCode;
  const allowed = new Set<WorkerErrorCode>([
    "not_authenticated",
    "not_authorized",
    "invalid_request",
    "not_found",
    "source_unavailable",
    "request_conflict",
    "scan_conflict",
    "scan_not_ready",
    "identity_review_required",
    "rate_limited",
    "reservation_expired",
    "stale_observation",
    "desired_processing_epoch_conflict",
    "lease_conflict",
  ]);
  if (!allowed.has(candidate)) fail();
  return candidate;
}
