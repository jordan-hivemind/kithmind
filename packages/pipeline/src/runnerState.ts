import type { IdentityBinding, WorkerErrorCode } from "./types.js";

const MAX_FILES = 256;
const MAX_IDENTITIES = 4_096;
const MAX_PATH_BYTES = 2_048;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const ROOT_ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type PlanLocation = {
  rootAlias: string;
  relativePath: string;
  sourceModifiedAt: number;
  externalId?: string;
};

/** Untagged UTF-8 plans are retained for every existing version-1 journal. */
export type Utf8FilePlan = PlanLocation & {
  sha256: string;
  byteLength: number;
};

export type PdfFilePlan = PlanLocation & {
  kind: "pdf";
  sha256: string;
  byteLength: number;
  parserProfileId: "pdf_docqa_v1";
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
};

export type GapFilePlan = PlanLocation & {
  kind: "gap";
  code: "empty" | "oversized" | "unsupported";
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
  discoveryLease?: ArchivedDiscoveryLease;
  jobLease?: JobLease;
  resumeStep?:
    "parsed_begin" | "parsed_batch" | "parsed_seal" | "parsed_activate";
  stageId?: string;
  stagePhase?:
    "pages" | "evidence" | "documents" | "chunks" | "seal" | "staged";
  stageOrdinal?: number;
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
  if (!Array.isArray(value) || value.length > MAX_FILES) fail();
  const paths = new Set<string>();
  const externalIds = new Set<string>();
  return value.map((raw) => {
    const row = object(raw);
    exact(row, ["rootAlias", "relativePath", "externalId"]);
    const rootAlias = string(row.rootAlias, 64, ROOT_ALIAS);
    const relativePath = string(row.relativePath, MAX_PATH_BYTES);
    const externalId = string(row.externalId, 36, UUID);
    const key = `${rootAlias}\0${relativePath}`;
    if (paths.has(key) || externalIds.has(externalId)) fail();
    paths.add(key);
    externalIds.add(externalId);
    return { rootAlias, relativePath, externalId };
  });
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
      exact(row, [...required, "sha256", "byteLength"], ["externalId"]);
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
          "sourceItemId",
          "observationEpoch",
          "processingEpoch",
          "discoveryState",
        ],
      );
    } else if (kind === "gap") {
      exact(row, [...required, "kind", "code"], ["externalId"]);
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
        row.code !== "unsupported"
      )
        fail();
      return { ...location, kind: "gap" as const, code: row.code };
    }
    if (row.parserProfileId !== "pdf_docqa_v1") fail();
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
      parserProfileId: "pdf_docqa_v1" as const,
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
      nextOrdinal: integer(input.nextOrdinal, 0, 64),
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
      nextOrdinal: integer(input.nextOrdinal, 0, 64),
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
      nextOrdinal: integer(input.nextOrdinal, 0, 64),
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
        "discoveryLease",
        "jobLease",
        "resumeStep",
        "stageId",
        "stagePhase",
        "stageOrdinal",
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
