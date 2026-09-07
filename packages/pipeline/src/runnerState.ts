import type { IdentityBinding, WorkerErrorCode } from "./types.js";

const MAX_FILES = 256;
const MAX_IDENTITIES = 4_096;
const MAX_PATH_BYTES = 2_048;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const ROOT_ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type FilePlan = {
  rootAlias: string;
  relativePath: string;
  sourceModifiedAt: number;
  sha256: string;
  byteLength: number;
  externalId?: string;
};

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
    } & ActiveScan)
  | ({
      version: 1;
      phase: "discovery_admit";
      round: number;
      targets: DiscoveryLease[];
      index: number;
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
    exact(
      row,
      ["rootAlias", "relativePath", "sourceModifiedAt", "sha256", "byteLength"],
      ["externalId"],
    );
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
    return {
      rootAlias,
      relativePath,
      sourceModifiedAt: integer(row.sourceModifiedAt),
      sha256: string(row.sha256, 64, HEX_64),
      byteLength: integer(row.byteLength, 1, 65_536),
      ...(externalId === undefined ? {} : { externalId }),
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
    exact(input, [...scanBaseFields, "round"]);
    return {
      version: 1,
      phase: "discovery_reserve",
      ...scanBase(input),
      round: integer(input.round, 0, 64),
    };
  }
  if (input.phase === "discovery_admit") {
    exact(input, [...scanBaseFields, "round", "targets", "index"]);
    const targets = discoveryLeases(input.targets);
    const index = integer(input.index, 0, targets.length);
    return {
      version: 1,
      phase: "discovery_admit",
      ...scanBase(input),
      round: integer(input.round, 0, 64),
      targets,
      index,
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
