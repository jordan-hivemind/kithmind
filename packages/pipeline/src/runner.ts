import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  MAX_PARSED_PAGE_BATCH,
  MAX_PARSED_REQUEST_BYTES,
  MAX_PARSED_ROW_BATCH,
  assertParsedRequestSize,
  type ArchivedWorkIdentity,
  type ParsedStagePhase,
} from "@repo/worker-protocol";

import {
  ArchiveCommandError,
  backupResticObject,
  encryptAgeObject,
  probeArchiveTools,
  probeResticRepository,
  publishAgeObject,
  recoverPublishedAgeObject,
  recoverResticBackup,
} from "./archiveCommands.js";
import type {
  PreparedAgeObject,
  PublishedAgeObject,
  RecoveredResticBackup,
  ResticBackupResult,
} from "./archiveTypes.js";
import {
  MAX_PARSE_ATTEMPTS,
  openArchiveCatalog,
  type ArchiveCatalog,
} from "./archiveCatalog.js";
import type {
  ArchiveCopyIntent,
  ArchiveCopyRole,
  ArchiveSubject,
  DurableParserOutput,
  OriginalCatalogRow,
  ProcessingCatalogRow,
} from "./archiveCatalogTypes.js";
import {
  createArchiveReceiptSelection,
  createParserArtifactSelection,
  digestArchiveIntent,
  parsedTextDeclaration,
} from "./archivedRequestMapping.js";
import {
  capturePdfFile,
  inspectCapturedPdf,
  removeCapturedPdfExact,
  type CapturedPdf,
} from "./captureStore.js";
import { verifyDropboxOriginal } from "./dropboxOriginal.js";
import {
  loadProviderBinding,
  persistProviderBinding,
} from "./providerRegistry.js";

import {
  canonicalRoots,
  discoverFiles,
  discoverSourceObservations,
  FilesystemFailure,
  readUtf8File,
  toFsUri,
  type SafeRoot,
} from "./filesystem.js";
import {
  createParserProfileWorkDirectory,
  inspectCapturedPdfParserOutput,
  inspectParserOutputIntent,
  preparePdfDocQaProfile,
  reclaimStaleParserOutputDirectory,
  removeParserProfileWorkDirectoryExact,
  removeParserOutputExact,
  runCapturedPdfParser,
  ParserProcessError,
  type DurableParserOutputArtifacts,
  type ParserOutputIntent,
  type PreparedPdfDocQaProfile,
} from "./parserProcess.js";
import { mapParsedBundle } from "./parsedBundleMapping.js";
import {
  inspectNormalizedBundleSpool,
  inspectSpoolRoot,
  prepareNormalizedBundleSpool,
  recoverNormalizedBundleSpool,
  removeNormalizedBundleSpoolExact,
} from "./spoolStore.js";
import { Journal } from "./journal.js";
import {
  runJournaledCall,
  resumePendingCall,
  type ReplayContext,
} from "./replay.js";
import type {
  CheckpointTransition,
  JournalCodec,
  JournalOperation,
  JsonValue,
} from "./journalTypes.js";
import {
  parseRunnerCheckpoint,
  workerErrorCode,
  type DiscoveryLease,
  type ArchivedStep,
  type FilePlan,
  type GapFilePlan,
  type InventoryIdentity,
  type JobLease,
  type RunnerCheckpoint,
  type PdfFilePlan,
  type Utf8FilePlan,
} from "./runnerState.js";
import { parseWorkerResponse } from "./transport.js";
import type {
  DiscoveryFile,
  IdentityBinding,
  PipelineConfig,
  PipelineRunResult,
  SourceObservation,
  WorkerErrorCode,
  WorkerResponse,
  WorkerTransport,
} from "./types.js";

const MAX_INVENTORY_PAGES = 128;
const MAX_INVENTORY_ITEMS = 4_096;
const MAX_RECONCILE_PAGES = 256;
const MAX_RESERVATION_ROUNDS = 64;
const MAX_ASSESSMENT_PAGES = 4_096;
const LEASE_SAFETY_MARGIN_MS = 30_000;
const MAX_ARCHIVED_RESERVATION_ROUNDS = 64;

/**
 * Mirrors `WORKER_MUTATION_RATE_WINDOW_MS` in
 * packages/convex/convex/models/workers/rateLimit.ts. The worker protocol
 * error carries only a `code` today, not a retry-after hint, so a
 * rate-limited mutation always backs off against this fixed window.
 *
 * ponytail: if the server ever starts returning a retry hint on
 * `rate_limited`, prefer it over this constant in `rateLimitBackoffMs`.
 */
const WORKER_MUTATION_RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ATTEMPTS = 8;

type RateLimitBackoff = { windowMs: number; maxAttempts: number };
const DEFAULT_RATE_LIMIT_BACKOFF: RateLimitBackoff = {
  windowMs: WORKER_MUTATION_RATE_WINDOW_MS,
  maxAttempts: RATE_LIMIT_MAX_ATTEMPTS,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff whose `maxAttempts` waits sum to ~`windowMs`. */
function rateLimitBackoffMs(
  attempt: number,
  { windowMs, maxAttempts }: RateLimitBackoff,
): number {
  const shares = 2 ** maxAttempts - 1;
  return Math.max(1, Math.round((windowMs * 2 ** (attempt - 1)) / shares));
}

const SAFE_PARSER_FAILURE_CODES = new Set([
  "unsupported_platform",
  "invalid_input",
  "unsafe_path",
  "executable_mismatch",
  "model_lock_mismatch",
  "destination_exists",
  "sandbox_failed",
  "network_not_denied",
  "process_escape_not_denied",
  "process_timeout",
  "cpu_limit_exceeded",
  "monitor_failed",
  "monitored_rss_exceeded",
  "process_count_exceeded",
  "output_limit_exceeded",
  "conversion_failed",
  "output_invalid",
  "execution_prerequisite_missing",
  "input_digest_mismatch",
  "invalid_opaque_name",
  "runtime_mismatch",
  "model_assets_invalid",
  "conversion_output_invalid",
  "page_limit_exceeded",
  "retained_text_too_large",
  "lossless_output_too_large",
  "bundle_too_large",
] as const);

/**
 * The subset of `SAFE_PARSER_FAILURE_CODES` that describes a property of
 * the document being parsed rather than the parser's execution environment.
 * `driveArchivedParse` catches these and records a bounded per-document
 * failure (see `recordArchivedParseFailure`) instead of ending the run; the
 * remaining `SAFE_PARSER_FAILURE_CODES` (sandbox, resource, and executable
 * problems) stay run-fatal because they are not specific to one file.
 */
const DOCUMENT_PARSER_FAILURE_CODES = new Set<string>([
  "conversion_failed",
  "conversion_output_invalid",
  "page_limit_exceeded",
  "bundle_too_large",
]);

type ArchivedCheckpoint = Extract<RunnerCheckpoint, { phase: "archived" }>;

function stableUuid(...parts: readonly unknown[]): string {
  const bytes = createHash("sha256")
    .update("kithmind-pdf-runner-id:v1\0")
    .update(JSON.stringify(parts))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha256Json(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function archivedIdentity(
  checkpoint: ArchivedCheckpoint,
  plan: PdfFilePlan,
): ArchivedWorkIdentity {
  if (
    plan.sourceItemId === undefined ||
    plan.observationEpoch === undefined ||
    plan.processingEpoch === undefined
  ) {
    throw new PipelineWorkerError("archived_parent_missing");
  }
  return {
    sourceItemId: plan.sourceItemId,
    scanId: checkpoint.scanId,
    observationEpoch: plan.observationEpoch,
    processingEpoch: plan.processingEpoch,
    contentHash: plan.sha256,
    byteLength: plan.byteLength,
    mediaType: "application/pdf",
    parserProfileId: plan.parserProfileId,
    parserFingerprint: plan.parserFingerprint,
    extractionConfigurationFingerprint: plan.extractionConfigurationFingerprint,
    extractorFingerprint: plan.extractorFingerprint,
    recordSchemaFingerprint: plan.recordSchemaFingerprint,
    normalizationFingerprint: plan.normalizationFingerprint,
    chunkerFingerprint: plan.chunkerFingerprint,
    correctionRevision: plan.correctionRevision,
  };
}

function archivedBase(
  checkpoint: ArchivedCheckpoint,
  updates: Partial<ArchivedCheckpoint> = {},
): ArchivedCheckpoint {
  return { ...checkpoint, ...updates, version: 1, phase: "archived" };
}

function captureFromRows(
  config: NonNullable<PipelineConfig["pdfDocQa"]>,
  original: OriginalCatalogRow,
  processing: ProcessingCatalogRow,
): CapturedPdf {
  if (!processing.capture) throw new PipelineWorkerError("capture_missing");
  return {
    version: 1,
    captureId: processing.captureIntent.captureId,
    captureDirectory: {
      path: config.captureDirectory,
      ...processing.captureIntent.directory,
    },
    path: join(
      config.captureDirectory,
      `${processing.captureIntent.captureId}.pdf`,
    ),
    sha256: original.origin.sha256,
    byteLength: original.origin.byteLength,
    sourceModifiedAt: processing.capture.sourceModifiedAt,
    device: processing.capture.device,
    inode: processing.capture.inode,
  };
}

export function captureCatalogRecord(capture: CapturedPdf): NonNullable<
  ProcessingCatalogRow["capture"]
> & {
  directory: { device: number; inode: number };
} {
  return {
    opaqueName: capture.captureId,
    device: capture.device,
    inode: capture.inode,
    sha256: capture.sha256,
    byteLength: capture.byteLength,
    sourceModifiedAt: capture.sourceModifiedAt,
    directory: {
      device: capture.captureDirectory.device,
      inode: capture.captureDirectory.inode,
    },
  };
}

export function parserOutputIntentCore(
  intent: ProcessingCatalogRow["parserIntent"],
): ParserOutputIntent {
  return {
    outputId: intent.outputId,
    outputRoot: intent.outputRoot,
    outputDirectory: intent.outputDirectory,
  };
}

export function parserOutputCatalogRecord(
  artifacts: DurableParserOutputArtifacts,
): DurableParserOutput {
  const { path: rawPath, ...rawArtifact } = artifacts.rawArtifact;
  const { path: bundlePath, ...normalizedBundle } = artifacts.normalizedBundle;
  return {
    ...artifacts,
    rawArtifact: {
      ...rawArtifact,
      opaqueName: basename(rawPath),
      mediaType: "application/vnd.docling+json",
    },
    normalizedBundle: {
      ...normalizedBundle,
      opaqueName: basename(bundlePath),
      mediaType: "application/json",
    },
  };
}

export function preparedArchiveCatalogRecord(prepared: PreparedAgeObject) {
  const { tempPath, ...record } = prepared;
  return { ...record, tempName: basename(tempPath) };
}

export function publishedArchiveCatalogRecord(published: PublishedAgeObject) {
  const { objectPath: _objectPath, ...record } = published;
  return record;
}

async function privateDirectoryIdentity(path: string) {
  const before = await lstat(path);
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  ) {
    throw new PipelineWorkerError("protected_directory_invalid");
  }
  return { device: before.dev, inode: before.ino };
}
class PipelineWorkerError extends Error {
  constructor(readonly code: string) {
    super("Pipeline worker operation failed");
  }
}

class PipelineRetryableError extends PipelineWorkerError {}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function asWorkerResponse(value: JsonValue): WorkerResponse {
  return value as WorkerResponse;
}

function isWorkerError(value: WorkerResponse): value is {
  error: { code: WorkerErrorCode };
} {
  return (
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "code" in value.error
  );
}

function object(
  value: WorkerResponse,
  operation: string,
): Record<string, unknown> {
  if (isWorkerError(value)) throw new PipelineWorkerError(value.error.code);
  if (value.operation !== operation) {
    throw new PipelineWorkerError("worker_failed");
  }
  return value;
}

function success(value: WorkerResponse): Record<string, unknown> | undefined {
  return isWorkerError(value) ? undefined : value;
}

function errorCode(value: WorkerResponse): WorkerErrorCode | undefined {
  return isWorkerError(value) ? value.error.code : undefined;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PipelineWorkerError(`${label}_invalid`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PipelineWorkerError(`${label}_invalid`);
  }
  return value as number;
}

function records(value: unknown, label: string): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) => !entry || typeof entry !== "object" || Array.isArray(entry),
    )
  ) {
    throw new PipelineWorkerError(`${label}_invalid`);
  }
  return value as Record<string, unknown>[];
}

function request(
  config: PipelineConfig,
  operation: JournalOperation | "source.status",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocolVersion: 1,
    operation,
    spaceId: config.spaceId,
    sourceAccountId: config.sourceAccountId,
    ...extra,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
    .join(",")}}`;
}

function equalJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function checkpointActive(checkpoint: RunnerCheckpoint): boolean {
  return checkpoint.phase === "terminal"
    ? checkpoint.credentialSessionActive
    : checkpoint.phase !== "idle";
}

function parseDurableResult(
  operation: JournalOperation,
  value: unknown,
): JsonValue {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "error" in value
  ) {
    const root = value as Record<string, unknown>;
    if (Object.keys(root).length !== 1) {
      throw new Error("safe error shape is invalid");
    }
    const nested = root.error;
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      throw new Error("safe error shape is invalid");
    }
    const row = nested as Record<string, unknown>;
    if (Object.keys(row).length !== 1 || !("code" in row)) {
      throw new Error("safe error shape is invalid");
    }
    return { error: { code: workerErrorCode(row.code) } };
  }
  return json(parseWorkerResponse(JSON.stringify(value), operation));
}

export const initialCheckpoint: RunnerCheckpoint = {
  version: 1,
  phase: "idle",
};

export const journalCodec: JournalCodec<RunnerCheckpoint, JsonValue> = {
  parseCheckpoint: parseRunnerCheckpoint,
  parseResult: parseDurableResult,
};

function fileKey(value: { rootAlias: string; relativePath: string }): string {
  return `${value.rootAlias}\0${value.relativePath}`;
}

function filePlan(file: DiscoveryFile): FilePlan {
  return {
    rootAlias: file.rootAlias,
    relativePath: file.relativePath,
    sourceModifiedAt: file.sourceModifiedAt,
    sha256: file.sha256,
    byteLength: file.byteLength,
  };
}

function observationPlan(
  observation: SourceObservation,
  config: NonNullable<PipelineConfig["pdfDocQa"]>,
): FilePlan {
  if (observation.kind === "utf8") return filePlan(observation.file);
  if (observation.kind === "gap") {
    return {
      rootAlias: observation.gap.rootAlias,
      relativePath: observation.gap.relativePath,
      sourceModifiedAt: observation.gap.sourceModifiedAt,
      kind: "gap",
      code: observation.gap.code,
    };
  }
  return {
    rootAlias: observation.file.rootAlias,
    relativePath: observation.file.relativePath,
    sourceModifiedAt: observation.file.sourceModifiedAt,
    kind: "pdf",
    sha256: observation.file.sha256,
    byteLength: observation.file.byteLength,
    parserProfileId: config.profile.parserProfileId,
    parserFingerprint: config.profile.parserFingerprint,
    extractionConfigurationFingerprint:
      config.profile.extractionConfigurationFingerprint,
    extractorFingerprint: config.profile.extractorFingerprint,
    recordSchemaFingerprint: config.profile.recordSchemaFingerprint,
    normalizationFingerprint: config.profile.normalizationFingerprint,
    chunkerFingerprint: config.profile.chunkerFingerprint,
    correctionRevision: config.profile.correctionRevision,
  };
}

function isUtf8Plan(plan: FilePlan): plan is Utf8FilePlan {
  return !isPdfPlan(plan) && !isGapPlan(plan);
}

function isPdfPlan(plan: FilePlan): plan is PdfFilePlan {
  return "kind" in plan && plan.kind === "pdf";
}

function isGapPlan(plan: FilePlan): plan is GapFilePlan {
  return "kind" in plan && plan.kind === "gap";
}

function scanEntry(
  plan: FilePlan,
  mode: "normal" | "identity_recovery",
): Record<string, unknown> {
  const entry = {
    ...(mode === "identity_recovery" || plan.externalId === undefined
      ? {}
      : { externalId: plan.externalId }),
    uri: toFsUri(plan.rootAlias, plan.relativePath),
    title: basename(plan.relativePath),
    sourceModifiedAt: plan.sourceModifiedAt,
  };
  if (isPdfPlan(plan)) {
    return {
      ...entry,
      content: {
        status: "ready_binary_v1",
        sha256: plan.sha256,
        byteLength: plan.byteLength,
        mediaType: "application/pdf",
        parserProfileId: plan.parserProfileId,
        parserFingerprint: plan.parserFingerprint,
        extractionConfigurationFingerprint:
          plan.extractionConfigurationFingerprint,
        extractorFingerprint: plan.extractorFingerprint,
        recordSchemaFingerprint: plan.recordSchemaFingerprint,
        normalizationFingerprint: plan.normalizationFingerprint,
        chunkerFingerprint: plan.chunkerFingerprint,
        correctionRevision: plan.correctionRevision,
      },
    };
  }
  if (isGapPlan(plan)) {
    return { ...entry, content: { status: "gap", code: plan.code } };
  }
  if (!isUtf8Plan(plan)) {
    throw new PipelineWorkerError("scan_plan_invalid");
  }
  return {
    ...entry,
    content: {
      status: "ready",
      sha256: plan.sha256,
      byteLength: plan.byteLength,
    },
  };
}

function samePlan(file: DiscoveryFile, plan: FilePlan): boolean {
  return (
    isUtf8Plan(plan) &&
    file.rootAlias === plan.rootAlias &&
    file.relativePath === plan.relativePath &&
    file.sourceModifiedAt === plan.sourceModifiedAt &&
    file.sha256 === plan.sha256 &&
    file.byteLength === plan.byteLength &&
    file.uri === toFsUri(plan.rootAlias, plan.relativePath)
  );
}

function sameSnapshot(files: DiscoveryFile[], plans: FilePlan[]): boolean {
  return (
    files.length === plans.length &&
    files.every((file, index) => {
      const plan = plans[index];
      return plan !== undefined && samePlan(file, plan);
    })
  );
}

function sameObservationPlan(
  observation: SourceObservation,
  plan: FilePlan,
  config: NonNullable<PipelineConfig["pdfDocQa"]>,
): boolean {
  const current = observationPlan(observation, config);
  const observedPlan = { ...plan } as Record<string, unknown>;
  for (const field of [
    "externalId",
    "sourceItemId",
    "observationEpoch",
    "processingEpoch",
    "discoveryState",
  ]) {
    delete observedPlan[field];
  }
  return equalJson(current, observedPlan);
}

function bindingsFromScan(checkpoint: {
  files: FilePlan[];
  missingBindings: IdentityBinding[];
}): IdentityBinding[] {
  const byExternalId = new Map<string, IdentityBinding>();
  for (const binding of checkpoint.missingBindings) {
    byExternalId.set(binding.externalId, binding);
  }
  for (const file of checkpoint.files) {
    if (!file.externalId) continue;
    byExternalId.set(file.externalId, {
      rootAlias: file.rootAlias,
      relativePath: file.relativePath,
      externalId: file.externalId,
    });
  }
  const result = [...byExternalId.values()].sort((left, right) =>
    Buffer.compare(Buffer.from(fileKey(left)), Buffer.from(fileKey(right))),
  );
  if (result.length > 256) {
    throw new PipelineWorkerError("identity_capacity_exceeded");
  }
  const paths = new Set<string>();
  for (const binding of result) {
    const key = fileKey(binding);
    if (paths.has(key)) {
      throw new PipelineWorkerError("identity_binding_conflict");
    }
    paths.add(key);
  }
  return result;
}

function plannedTerminal(
  checkpoint: Extract<RunnerCheckpoint, { phase: "scan_begin" }>,
  code: string,
): RunnerCheckpoint {
  return {
    version: 1,
    phase: "terminal",
    outcome: "failed",
    credentialSessionActive: true,
    code,
    scanned: checkpoint.files.length,
    published: 0,
    bindings: bindingsFromScan(checkpoint),
  };
}

function stickyTerminal(checkpoint: RunnerCheckpoint): boolean {
  return (
    checkpoint.phase === "terminal" && checkpoint.code === "request_conflict"
  );
}

function scanTerminal(
  checkpoint: Extract<
    RunnerCheckpoint,
    {
      phase:
        | "inventory"
        | "append"
        | "seal_check"
        | "seal"
        | "reconcile"
        | "discovery_reserve"
        | "discovery_admit"
        | "archived";
    }
  >,
  outcome: "complete" | "incomplete" | "failed",
  code: string,
  credentialSessionActive = false,
): RunnerCheckpoint {
  return {
    version: 1,
    phase: "terminal",
    outcome,
    credentialSessionActive,
    code,
    scanId: checkpoint.scanId,
    scanned: checkpoint.files.length,
    published:
      "archivedPublished" in checkpoint &&
      typeof checkpoint.archivedPublished === "number"
        ? checkpoint.archivedPublished
        : 0,
    bindings: bindingsFromScan(checkpoint),
  };
}

function processingTerminal(
  checkpoint: Extract<
    RunnerCheckpoint,
    {
      phase:
        | "jobs_reserve"
        | "jobs_renew"
        | "jobs_stage"
        | "jobs_activate"
        | "jobs_fail"
        | "assess_status"
        | "assess_begin"
        | "assess_page";
    }
  >,
  outcome: "complete" | "incomplete" | "failed",
  code: string | undefined,
  assessmentId?: string,
  credentialSessionActive = false,
): RunnerCheckpoint {
  return {
    version: 1,
    phase: "terminal",
    outcome,
    credentialSessionActive,
    ...(code === undefined ? {} : { code }),
    scanId: checkpoint.scanId,
    scanned: checkpoint.scanned,
    published: checkpoint.published,
    bindings: checkpoint.bindings,
    ...(assessmentId === undefined ? {} : { assessmentId }),
  };
}

function processingBase(checkpoint: {
  scanId: string;
  scanned: number;
  published: number;
  bindings: IdentityBinding[];
}) {
  return {
    scanId: checkpoint.scanId,
    scanned: checkpoint.scanned,
    published: checkpoint.published,
    bindings: checkpoint.bindings,
  };
}

function activeScanBase(checkpoint: {
  mode: "normal" | "identity_recovery";
  scanId: string;
  inventoryEpoch: number;
  manifestVersion: number;
  files: FilePlan[];
  missingBindings: IdentityBinding[];
}) {
  return {
    mode: checkpoint.mode,
    scanId: checkpoint.scanId,
    inventoryEpoch: checkpoint.inventoryEpoch,
    manifestVersion: checkpoint.manifestVersion,
    files: checkpoint.files,
    missingBindings: checkpoint.missingBindings,
  };
}

function afterJob(
  checkpoint: Extract<
    RunnerCheckpoint,
    { phase: "jobs_renew" | "jobs_stage" | "jobs_activate" | "jobs_fail" }
  >,
  published: number,
): RunnerCheckpoint {
  const nextIndex = checkpoint.index + 1;
  if (nextIndex < checkpoint.jobs.length) {
    return {
      version: 1,
      phase: "jobs_renew",
      ...processingBase({ ...checkpoint, published }),
      round: checkpoint.round,
      jobs: checkpoint.jobs,
      index: nextIndex,
    };
  }
  return {
    version: 1,
    phase: "jobs_reserve",
    ...processingBase({ ...checkpoint, published }),
    round: checkpoint.round + 1,
  };
}

function afterDiscoveryTarget(
  checkpoint: Extract<RunnerCheckpoint, { phase: "discovery_admit" }>,
): RunnerCheckpoint {
  const nextIndex = checkpoint.index + 1;
  return nextIndex < checkpoint.targets.length
    ? { ...checkpoint, index: nextIndex }
    : {
        version: 1,
        phase: "discovery_reserve",
        ...activeScanBase(checkpoint),
        round: checkpoint.round + 1,
        ...(checkpoint.archivedPublished === undefined
          ? {}
          : { archivedPublished: checkpoint.archivedPublished }),
      };
}

function resultFromTerminal(
  checkpoint: Extract<RunnerCheckpoint, { phase: "terminal" }>,
): PipelineRunResult {
  return {
    state: checkpoint.outcome,
    ...(checkpoint.code === undefined ? {} : { code: checkpoint.code }),
    scanned: checkpoint.scanned,
    published: checkpoint.published,
  };
}

export class PipelineRunner {
  private preparedPdfProfile: PreparedPdfDocQaProfile | undefined;
  private archiveCatalog: ArchiveCatalog | undefined;

  constructor(
    private readonly config: PipelineConfig,
    private readonly journal: Journal<RunnerCheckpoint, JsonValue>,
    private readonly transport: WorkerTransport,
    private readonly rateLimitBackoff: RateLimitBackoff = DEFAULT_RATE_LIMIT_BACKOFF,
  ) {}

  /**
   * Sends a worker mutation and, on a `rate_limited` response, waits with
   * bounded exponential backoff (spanning the server's mutation rate-limit
   * window) and retries before giving the caller a final answer. This is
   * the single place that handles `rate_limited`; every driver phase below
   * just treats a `rate_limited` response the same as any other terminal
   * error code, because by the time one reaches them, retries here are
   * already exhausted.
   */
  private async callWithRateLimitBackoff(
    body: Record<string, unknown>,
  ): Promise<WorkerResponse> {
    let response = await this.transport.call(body);
    for (
      let attempt = 1;
      errorCode(response) === "rate_limited" &&
      attempt < this.rateLimitBackoff.maxAttempts;
      attempt += 1
    ) {
      const waitMs = rateLimitBackoffMs(attempt, this.rateLimitBackoff);
      console.warn(
        `[pipeline] worker mutation rate limited (attempt ${attempt}/${this.rateLimitBackoff.maxAttempts}); retrying in ${waitMs}ms`,
      );
      await sleep(waitMs);
      response = await this.transport.call(body);
    }
    if (errorCode(response) === "rate_limited") {
      console.warn(
        `[pipeline] worker mutation still rate limited after ${this.rateLimitBackoff.maxAttempts} attempts; failing this run. The journal records a terminal outcome, and the next invocation resumes the pass normally.`,
      );
    }
    return response;
  }

  private requirePdfConfig(): NonNullable<PipelineConfig["pdfDocQa"]> {
    if (!this.config.pdfDocQa) {
      throw new PipelineWorkerError("pdf_profile_missing");
    }
    return this.config.pdfDocQa;
  }

  private requireCatalog(): ArchiveCatalog {
    if (!this.archiveCatalog) {
      throw new PipelineWorkerError("archive_catalog_missing");
    }
    return this.archiveCatalog;
  }

  private archivedPlan(checkpoint: ArchivedCheckpoint): PdfFilePlan {
    const plan = checkpoint.files[checkpoint.pdfIndex];
    if (!plan || !isPdfPlan(plan)) {
      throw new PipelineWorkerError("archived_plan_missing");
    }
    return plan;
  }

  private archivedRows(checkpoint: ArchivedCheckpoint): {
    original: OriginalCatalogRow;
    processing: ProcessingCatalogRow;
  } {
    if (!checkpoint.originalCatalogId || !checkpoint.processingCatalogId) {
      throw new PipelineWorkerError("archive_catalog_reference_missing");
    }
    const original = this.requireCatalog()
      .listOriginals()
      .find((row) => row.originalCatalogId === checkpoint.originalCatalogId);
    const processing = this.requireCatalog()
      .listProcessings()
      .find(
        (row) => row.processingCatalogId === checkpoint.processingCatalogId,
      );
    if (!original || !processing) {
      throw new PipelineWorkerError("archive_catalog_reference_missing");
    }
    if (
      original.rowRevision < (checkpoint.expectedOriginalRevision ?? 1) ||
      processing.rowRevision < (checkpoint.expectedProcessingRevision ?? 1)
    ) {
      throw new PipelineWorkerError("archive_catalog_revision_conflict");
    }
    return { original, processing };
  }

  private copyIntent(
    subject: ArchiveSubject,
    role: ArchiveCopyRole,
    seed: string,
  ) {
    const pdf = this.requirePdfConfig();
    const configured =
      role === "primary" ? pdf.archive.primary : pdf.archive.independentBackup;
    const archiveObjectId = stableUuid(seed, subject, role, "object");
    return {
      role,
      clientReceiptId: stableUuid(seed, subject, role, "receipt"),
      archiveObjectId,
      objectName: `${archiveObjectId}.age`,
      archiveIdentityFingerprint: configured.archiveIdentityFingerprint,
      archiveProfileFingerprint: configured.archiveProfileFingerprint,
      recipientFingerprint: configured.recipientFingerprint,
      repositoryKeyDomainFingerprint: configured.repositoryKeyDomainFingerprint,
      storageFailureDomainFingerprint:
        configured.storageFailureDomainFingerprint,
      ...(role === "independent_backup"
        ? {
            restic: {
              operationId: stableUuid(seed, subject, role, "restic"),
              host: pdf.archive.independentBackup.host,
              repositoryId: pdf.archive.independentBackup.expectedRepositoryId,
            },
          }
        : {}),
    };
  }

  private processingFingerprints(plan: PdfFilePlan) {
    return {
      parserFingerprint: plan.parserFingerprint,
      extractionConfigurationFingerprint:
        plan.extractionConfigurationFingerprint,
      discoveryProfileFingerprint: sha256Json([
        plan.parserProfileId,
        plan.extractorFingerprint,
        plan.recordSchemaFingerprint,
        plan.normalizationFingerprint,
        plan.chunkerFingerprint,
      ]),
      processingPolicyFingerprint: sha256Json([
        plan.extractionConfigurationFingerprint,
        plan.chunkerFingerprint,
      ]),
      correctionFingerprint: createHash("sha256")
        .update(plan.correctionRevision, "utf8")
        .digest("hex"),
    };
  }

  private matchingProcessingRows(plan: PdfFilePlan): ProcessingCatalogRow[] {
    if (
      !plan.externalId ||
      plan.observationEpoch === undefined ||
      plan.processingEpoch === undefined
    ) {
      return [];
    }
    const original = this.requireCatalog().findOriginalExact({
      sourceExternalId: plan.externalId,
      sha256: plan.sha256,
      byteLength: plan.byteLength,
      mediaType: "application/pdf",
    });
    if (!original) return [];
    const fingerprints = this.processingFingerprints(plan);
    return this.requireCatalog()
      .listProcessings()
      .filter(
        (row) =>
          row.originalCatalogId === original.originalCatalogId &&
          row.currentObservation.observationEpoch === plan.observationEpoch &&
          row.currentObservation.processingEpoch === plan.processingEpoch &&
          equalJson(row.fingerprints, fingerprints),
      );
  }

  private async processingArtifactsPresent(
    processing: ProcessingCatalogRow,
  ): Promise<boolean> {
    if (!processing.capture || !processing.parserOutput || !processing.spool) {
      return false;
    }
    const pdf = this.requirePdfConfig();
    const candidates = [
      join(pdf.captureDirectory, `${processing.captureIntent.captureId}.pdf`),
      join(pdf.parserOutputRoot, processing.parserIntent.outputId),
      join(pdf.spoolDirectory, processing.spool.opaqueName),
    ];
    for (const path of candidates) {
      const present = await lstat(path)
        .then(() => true)
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          return true;
        });
      if (present) return true;
    }
    return false;
  }

  private async pdfNeedsArchivedWork(plan: PdfFilePlan): Promise<boolean> {
    if (plan.discoveryState === "queued") return true;
    if (plan.discoveryState !== "unchanged") return false;
    const matches = this.matchingProcessingRows(plan);
    if (matches.length > 1) {
      throw new PipelineWorkerError("archive_catalog_revision_conflict");
    }
    if (matches[0]?.activation) {
      return await this.processingArtifactsPresent(matches[0]);
    }
    // A document that has already exhausted its bounded local parser
    // attempts (see `recordArchivedParseFailure`) stays `parse_failed`
    // rather than being retried on every future pass; a parser version
    // bump changes `fingerprints.parserFingerprint`, which lands on a fresh
    // row (no `parseFailure`) and lifts this gate automatically.
    if ((matches[0]?.parseFailure?.attempts ?? 0) >= MAX_PARSE_ATTEMPTS) {
      return false;
    }
    return true;
  }

  private async nextPdfWorkIndex(
    files: FilePlan[],
    start: number,
  ): Promise<number> {
    for (let index = start; index < files.length; index += 1) {
      const plan = files[index];
      if (plan && isPdfPlan(plan) && (await this.pdfNeedsArchivedWork(plan))) {
        return index;
      }
    }
    return -1;
  }

  private async createArchivedIntents(
    checkpoint: ArchivedCheckpoint,
  ): Promise<ArchivedCheckpoint> {
    const catalog = this.requireCatalog();
    const pdf = this.requirePdfConfig();
    const plan = this.archivedPlan(checkpoint);
    const identity = archivedIdentity(checkpoint, plan);
    if (!plan.externalId) {
      throw new PipelineWorkerError("archived_external_id_missing");
    }
    const originalSeed = stableUuid(
      plan.externalId,
      plan.sha256,
      plan.byteLength,
      "original",
    );
    let original = catalog.findOriginalExact({
      sourceExternalId: plan.externalId,
      sha256: plan.sha256,
      byteLength: plan.byteLength,
      mediaType: "application/pdf",
    });
    if (!original) {
      const provider = pdf.providerOriginal;
      original = await catalog.createOriginalIntent({
        originalCatalogId: originalSeed,
        sourceExternalId: plan.externalId,
        origin: {
          scanId: checkpoint.scanId,
          observationEpoch: identity.observationEpoch,
          sha256: plan.sha256,
          byteLength: plan.byteLength,
          mediaType: "application/pdf",
        },
        copies:
          provider === undefined
            ? {
                primary: this.copyIntent(
                  "original_bytes",
                  "primary",
                  originalSeed,
                ),
                independent_backup: this.copyIntent(
                  "original_bytes",
                  "independent_backup",
                  originalSeed,
                ),
              }
            : ({
                primary: this.copyIntent(
                  "original_bytes",
                  "primary",
                  originalSeed,
                ),
              } as { primary: ArchiveCopyIntent; independent_backup: never }),
        ...(provider === undefined
          ? {}
          : {
              providerOriginal: {
                clientReferenceId: stableUuid(
                  originalSeed,
                  "provider-reference",
                ),
                bindingId: stableUuid(originalSeed, "provider-binding"),
                locator: this.copyIntent(
                  "parser_output",
                  "independent_backup",
                  stableUuid(originalSeed, "provider-locator"),
                ),
              },
            }),
        createdAt: plan.sourceModifiedAt,
      });
    }
    const fingerprints = this.processingFingerprints(plan);
    const processingProbe = {
      originalCatalogId: original.originalCatalogId,
      currentObservation: {
        scanId: checkpoint.scanId,
        observationEpoch: identity.observationEpoch,
        processingEpoch: identity.processingEpoch,
      },
      fingerprints,
    };
    let processing = catalog.findProcessingExact(processingProbe);
    if (!processing && plan.discoveryState === "unchanged") {
      const prior = this.matchingProcessingRows(plan);
      if (prior.length > 1) {
        throw new PipelineWorkerError("archive_catalog_revision_conflict");
      }
      processing = prior[0];
    }
    if (!processing) {
      const processingId = stableUuid(
        original.originalCatalogId,
        processingProbe.currentObservation,
        fingerprints,
        "processing",
      );
      const outputId = stableUuid(processingId, "parser-output");
      const outputPath = join(pdf.parserOutputRoot, outputId);
      await mkdir(outputPath, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const [captureDirectory, outputRoot, outputDirectory, spoolRoot] =
        await Promise.all([
          privateDirectoryIdentity(pdf.captureDirectory),
          privateDirectoryIdentity(pdf.parserOutputRoot),
          privateDirectoryIdentity(outputPath),
          inspectSpoolRoot(pdf.spoolDirectory),
        ]);
      processing = await catalog.createProcessingIntent({
        processingCatalogId: processingId,
        ...processingProbe,
        captureIntent: {
          captureId: stableUuid(processingId, "capture"),
          directory: captureDirectory,
        },
        parserIntent: {
          outputId,
          outputRoot,
          outputDirectory,
          parserArtifactClientId: stableUuid(processingId, "parser-artifact"),
        },
        spoolIntent: {
          spoolId: stableUuid(processingId, "spool"),
          root: spoolRoot,
        },
        copies: {
          primary: this.copyIntent("parser_output", "primary", processingId),
          independent_backup: this.copyIntent(
            "parser_output",
            "independent_backup",
            processingId,
          ),
        },
        createdAt: plan.sourceModifiedAt,
      });
    }
    return archivedBase(checkpoint, {
      step: processing.activation ? "cleanup" : "preflight",
      preflightAction: processing.activation ? undefined : "initial",
      countPublication: processing.activation ? false : true,
      originalCatalogId: original.originalCatalogId,
      expectedOriginalRevision: original.rowRevision,
      processingCatalogId: processing.processingCatalogId,
      expectedProcessingRevision: processing.rowRevision,
    });
  }

  private async sourceStatus(): Promise<Record<string, unknown>> {
    return object(
      await this.transport.call(request(this.config, "source.status")),
      "source.status",
    );
  }

  private async preparePdfProfile(): Promise<void> {
    const pdf = this.config.pdfDocQa;
    if (pdf === undefined) return;
    const work = await createParserProfileWorkDirectory({
      workRoot: pdf.parserOutputRoot,
      workId: randomUUID(),
    });
    try {
      const prepared = await preparePdfDocQaProfile({
        ...pdf.parser,
        workRoot: pdf.parserOutputRoot,
        work,
      });
      if (
        prepared.parserFingerprint !== pdf.profile.parserFingerprint ||
        prepared.extractionConfigurationFingerprint !==
          pdf.profile.extractionConfigurationFingerprint
      ) {
        throw new PipelineWorkerError("parser_profile_mismatch");
      }
      this.preparedPdfProfile = prepared;
    } finally {
      await removeParserProfileWorkDirectoryExact({
        workRoot: pdf.parserOutputRoot,
        intent: work,
      });
    }
  }

  private async discoverPlans(roots: SafeRoot[]): Promise<FilePlan[]> {
    if (this.config.pdfDocQa === undefined) {
      return (await discoverFiles(this.config, roots)).map(filePlan);
    }
    if (this.preparedPdfProfile === undefined) {
      throw new PipelineWorkerError("parser_profile_unverified");
    }
    return (await discoverSourceObservations(this.config, roots)).map(
      (observation) => observationPlan(observation, this.config.pdfDocQa!),
    );
  }

  private async sameDiscoveredSnapshot(
    roots: SafeRoot[],
    plans: FilePlan[],
  ): Promise<boolean> {
    if (this.config.pdfDocQa === undefined) {
      return sameSnapshot(await discoverFiles(this.config, roots), plans);
    }
    if (this.preparedPdfProfile === undefined) {
      throw new PipelineWorkerError("parser_profile_unverified");
    }
    const observations = await discoverSourceObservations(this.config, roots);
    return (
      observations.length === plans.length &&
      observations.every((observation, index) => {
        const plan = plans[index];
        return (
          plan !== undefined &&
          sameObservationPlan(observation, plan, this.config.pdfDocQa!)
        );
      })
    );
  }

  private async validatePendingBody(
    operation: JournalOperation,
    body: Record<string, unknown>,
  ): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    const requestId = text(body.requestId, "request_id");
    let expected: Record<string, unknown>;
    switch (operation) {
      case "scan.begin": {
        if (checkpoint.phase !== "scan_begin") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          requestId,
          watcherId: `pipeline-${this.config.sourceAccountId.slice(0, 64)}`,
          connectorVersion:
            this.config.pdfDocQa === undefined ? "p2-8-text-v1" : "p2-9-pdf-v1",
          ...(this.config.hostAffinity
            ? { hostAffinity: this.config.hostAffinity }
            : {}),
          mode: checkpoint.mode,
          expectedInventoryEpoch: checkpoint.expectedInventoryEpoch,
        });
        break;
      }
      case "source.inventoryPage": {
        if (checkpoint.phase !== "inventory") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          scanId: checkpoint.scanId,
          requestId,
          expectedInventoryEpoch: checkpoint.inventoryEpoch,
          expectedManifestVersion: checkpoint.manifestVersion,
          paginationOpts: { cursor: checkpoint.cursor, numItems: 50 },
        });
        break;
      }
      case "scan.appendPage": {
        if (checkpoint.phase !== "append") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const offset = checkpoint.nextOrdinal * 4;
        expected = request(this.config, operation, {
          scanId: checkpoint.scanId,
          requestId,
          ordinal: checkpoint.nextOrdinal,
          entries: checkpoint.files
            .slice(offset, offset + 4)
            .map((plan) => scanEntry(plan, checkpoint.mode)),
        });
        break;
      }
      case "scan.seal": {
        if (checkpoint.phase !== "seal") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          scanId: checkpoint.scanId,
          requestId,
          expectedPageCount: checkpoint.nextOrdinal,
          health: checkpoint.health,
        });
        break;
      }
      case "scan.reconcile": {
        if (checkpoint.phase !== "reconcile") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          scanId: checkpoint.scanId,
          requestId,
          expectedInventoryEpoch: checkpoint.inventoryEpoch,
          ordinal: checkpoint.ordinal,
          maxItems: 50,
        });
        break;
      }
      case "discovery.reserve": {
        if (checkpoint.phase !== "discovery_reserve") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, { requestId, maxItems: 4 });
        break;
      }
      case "discovery.admitUtf8": {
        if (checkpoint.phase !== "discovery_admit") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const target = checkpoint.targets[checkpoint.index];
        if (!target || typeof body.text !== "string") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const plan = checkpoint.files.find(
          (candidate) =>
            toFsUri(candidate.rootAlias, candidate.relativePath) === target.uri,
        );
        if (
          !plan ||
          !isUtf8Plan(plan) ||
          plan.sha256 !== target.contentHash ||
          plan.byteLength !== target.byteLength
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const encoded = Buffer.from(body.text, "utf8");
        if (
          encoded.toString("utf8") !== body.text ||
          encoded.byteLength !== target.byteLength ||
          createHash("sha256").update(encoded).digest("hex") !==
            target.contentHash
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          requestId,
          workId: target.workId,
          leaseEpoch: target.leaseEpoch,
          leaseToken: target.leaseToken,
          text: body.text,
        });
        break;
      }
      case "jobs.reserve": {
        if (checkpoint.phase !== "jobs_reserve") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, { requestId, maxItems: 4 });
        break;
      }
      case "jobs.renew":
      case "jobs.stageUtf8":
      case "jobs.activate": {
        if (
          checkpoint.phase !== "jobs_renew" &&
          checkpoint.phase !== "jobs_stage" &&
          checkpoint.phase !== "jobs_activate"
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const expectedOperation =
          checkpoint.phase === "jobs_renew"
            ? "jobs.renew"
            : checkpoint.phase === "jobs_stage"
              ? "jobs.stageUtf8"
              : "jobs.activate";
        if (operation !== expectedOperation) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const job = checkpoint.jobs[checkpoint.index];
        if (!job) throw new PipelineWorkerError("journal_phase_conflict");
        expected = request(this.config, operation, {
          requestId,
          jobId: job.jobId,
          leaseEpoch: job.leaseEpoch,
          leaseToken: job.leaseToken,
        });
        break;
      }
      case "jobs.fail": {
        if (checkpoint.phase !== "jobs_fail") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const job = checkpoint.jobs[checkpoint.index];
        if (!job) throw new PipelineWorkerError("journal_phase_conflict");
        expected = request(this.config, operation, {
          requestId,
          jobId: job.jobId,
          leaseEpoch: job.leaseEpoch,
          leaseToken: job.leaseToken,
          failureCode: checkpoint.failureCode,
        });
        break;
      }
      case "processing.assessBegin": {
        if (checkpoint.phase !== "assess_begin") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          requestId,
          scanId: checkpoint.scanId,
          expectedInventoryEpoch: checkpoint.expectedInventoryEpoch,
          expectedManifestVersion: checkpoint.expectedManifestVersion,
        });
        break;
      }
      case "processing.assessPage": {
        if (checkpoint.phase !== "assess_page") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          requestId,
          assessmentId: checkpoint.assessmentId,
          ordinal: checkpoint.ordinal,
          maxItems: 1,
        });
        break;
      }
      case "discovery.preflightArchived": {
        if (checkpoint.phase !== "archived") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const plan = this.archivedPlan(checkpoint);
        if (checkpoint.step !== "preflight") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const rows = this.archivedRows(checkpoint);
        const identity = archivedIdentity(checkpoint, plan);
        expected = request(this.config, operation, {
          requestId,
          identity,
          archiveIntentDigest: digestArchiveIntent({
            identity,
            original: rows.original,
            processing: rows.processing,
          }),
        });
        break;
      }
      case "discovery.lookupArchivedAdmission": {
        if (checkpoint.phase !== "archived") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const identity = archivedIdentity(
          checkpoint,
          this.archivedPlan(checkpoint),
        );
        if (checkpoint.step === "lookup_original") {
          expected = request(this.config, operation, {
            requestId,
            identity,
            lookup: { mode: "original" },
          });
          break;
        }
        if (checkpoint.step !== "lookup_processing") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const mapped = await this.mappedProcessing(checkpoint);
        const output = mapped.processing.parserOutput!;
        expected = request(this.config, operation, {
          requestId,
          identity,
          lookup: {
            mode: "processing",
            clientArtifactId:
              mapped.processing.parserIntent.parserArtifactClientId,
            parserOutputHash: output.rawArtifact.sha256,
            parserOutputByteLength: output.rawArtifact.byteLength,
            parserOutputMediaType: "application/vnd.docling+json",
            parsedText: mapped.declaration,
          },
        });
        break;
      }
      case "discovery.reserveArchived": {
        if (checkpoint.phase !== "archived" || checkpoint.step !== "reserve") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          requestId,
          identity: archivedIdentity(checkpoint, this.archivedPlan(checkpoint)),
        });
        break;
      }
      case "discovery.admitArchived": {
        if (checkpoint.phase !== "archived" || checkpoint.step !== "admit") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const lease = checkpoint.discoveryLease;
        if (!lease) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const mapped = await this.mappedProcessing(checkpoint);
        const providerOriginal = mapped.original.providerOriginal
          ? this.providerDeclaration(mapped.original, false)
          : undefined;
        expected = request(this.config, operation, {
          requestId,
          workId: lease.workId,
          leaseEpoch: lease.leaseEpoch,
          leaseToken: lease.leaseToken,
          parserArtifact: createParserArtifactSelection(mapped.processing),
          archives: [
            createArchiveReceiptSelection(
              "original_bytes",
              mapped.original,
              "primary",
            ),
            ...(providerOriginal === undefined
              ? [
                  createArchiveReceiptSelection(
                    "original_bytes",
                    mapped.original,
                    "independent_backup",
                  ),
                ]
              : []),
            createArchiveReceiptSelection(
              "parser_output",
              mapped.processing,
              "primary",
            ),
            createArchiveReceiptSelection(
              "parser_output",
              mapped.processing,
              "independent_backup",
            ),
          ],
          ...(providerOriginal === undefined ? {} : { providerOriginal }),
          parsedText: mapped.declaration,
        });
        break;
      }
      case "jobs.reserveParsed": {
        if (
          checkpoint.phase !== "archived" ||
          checkpoint.step !== "parsed_reserve"
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const { processing } = this.archivedRows(checkpoint);
        if (!processing.cloud) {
          throw new PipelineWorkerError("admission_missing");
        }
        expected = request(this.config, operation, {
          requestId,
          maxItems: 1,
          jobId: processing.cloud.ingestJobId,
        });
        break;
      }
      case "jobs.renewParsed": {
        if (
          checkpoint.phase !== "archived" ||
          checkpoint.step !== "parsed_renew" ||
          !checkpoint.jobLease
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          requestId,
          jobId: checkpoint.jobLease.jobId,
          leaseEpoch: checkpoint.jobLease.leaseEpoch,
          leaseToken: checkpoint.jobLease.leaseToken,
        });
        break;
      }
      case "jobs.stageParsedBegin": {
        if (
          checkpoint.phase !== "archived" ||
          checkpoint.step !== "parsed_begin" ||
          !checkpoint.jobLease
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const mapped = await this.mappedProcessing(checkpoint);
        const declaration = mapped.declaration;
        expected = request(this.config, operation, {
          requestId,
          jobId: checkpoint.jobLease.jobId,
          leaseEpoch: checkpoint.jobLease.leaseEpoch,
          leaseToken: checkpoint.jobLease.leaseToken,
          extractionFingerprint: declaration.extractionFingerprint,
          mappingManifestHash: declaration.mappingManifestHash,
          normalizedBundleDigest: declaration.normalizedBundleDigest,
          expectedPageCount: declaration.pageCount,
          expectedEvidenceSpanCount: declaration.expectedEvidenceSpanCount,
          expectedDocumentCount: declaration.expectedDocumentCount,
          expectedChunkCount: declaration.expectedChunkCount,
        });
        break;
      }
      case "jobs.stageParsedBatch": {
        if (checkpoint.phase !== "archived" || !checkpoint.jobLease) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        if (checkpoint.step !== "parsed_batch") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const mapped = await this.mappedProcessing(checkpoint);
        expected = this.parsedBatchBody(checkpoint, mapped.mapping, requestId);
        assertParsedRequestSize(expected);
        break;
      }
      case "jobs.stageParsedSeal": {
        if (
          checkpoint.phase !== "archived" ||
          checkpoint.step !== "parsed_seal" ||
          !checkpoint.jobLease
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const mapped = await this.mappedProcessing(checkpoint);
        expected = request(this.config, operation, {
          requestId,
          jobId: checkpoint.jobLease.jobId,
          leaseEpoch: checkpoint.jobLease.leaseEpoch,
          leaseToken: checkpoint.jobLease.leaseToken,
          stageId: checkpoint.stageId,
          normalizedBundleDigest: mapped.declaration.normalizedBundleDigest,
        });
        break;
      }
      case "jobs.activateParsed": {
        if (
          checkpoint.phase !== "archived" ||
          checkpoint.step !== "parsed_activate" ||
          !checkpoint.jobLease
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          requestId,
          jobId: checkpoint.jobLease.jobId,
          leaseEpoch: checkpoint.jobLease.leaseEpoch,
          leaseToken: checkpoint.jobLease.leaseToken,
        });
        break;
      }
      case "jobs.failParsed": {
        throw new PipelineWorkerError("journal_phase_conflict");
      }
      default:
        throw new PipelineWorkerError("journal_phase_conflict");
    }
    if (!equalJson(body, expected)) {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
  }

  private async mutation(
    operation: JournalOperation,
    body: () => Record<string, unknown>,
    transition: (
      checkpoint: RunnerCheckpoint,
      result: WorkerResponse,
      pending: {
        requestId: string;
        requestBody: string;
        requestDigest: string;
        receivedAt: number;
      },
    ) => RunnerCheckpoint | Promise<RunnerCheckpoint>,
  ): Promise<WorkerResponse> {
    const pending = this.journal.pending;
    if (pending && pending.operation !== operation) {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    if (pending) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(pending.requestBody);
      } catch {
        throw new PipelineWorkerError("journal_phase_conflict");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new PipelineWorkerError("journal_phase_conflict");
      }
      await this.validatePendingBody(
        operation,
        parsed as Record<string, unknown>,
      );
    }
    const sendExact = async (
      requestBody: string,
      exactOperation: JournalOperation,
    ): Promise<unknown> => {
      if (exactOperation !== operation) {
        throw new PipelineWorkerError("journal_phase_conflict");
      }
      const parsed = JSON.parse(requestBody) as Record<string, unknown>;
      await this.validatePendingBody(exactOperation, parsed);
      return await this.callWithRateLimitBackoff(parsed);
    };
    const nextCheckpoint = async ({
      checkpoint,
      pending,
      result,
    }: ReplayContext<RunnerCheckpoint, JsonValue>): Promise<
      CheckpointTransition<RunnerCheckpoint>
    > => {
      const next = await transition(checkpoint, asWorkerResponse(result), {
        requestId: pending.requestId,
        requestBody: pending.requestBody,
        requestDigest: pending.requestDigest,
        receivedAt: pending.result?.receivedAt ?? Date.now(),
      });
      return {
        checkpoint: next,
        credentialSessionActive: checkpointActive(next),
      };
    };
    const handlers = { sendExact, nextCheckpoint, now: Date.now };
    let result: JsonValue;
    if (pending) result = await resumePendingCall(this.journal, handlers);
    else {
      const plannedBody = body();
      result = await runJournaledCall(
        this.journal,
        {
          operation,
          requestId: text(plannedBody.requestId, "request_id"),
          requestBody: JSON.stringify(plannedBody),
          createdAt: Date.now(),
        },
        handlers,
      );
    }
    return asWorkerResponse(result);
  }

  private async startCycle(
    roots: SafeRoot[],
    status: Record<string, unknown>,
  ): Promise<void> {
    const prior =
      this.journal.checkpoint.phase === "terminal"
        ? this.journal.checkpoint.bindings
        : [];
    const plans = await this.discoverPlans(roots);
    const byPath = new Map(prior.map((binding) => [fileKey(binding), binding]));
    const currentPaths = new Set(plans.map(fileKey));
    const missingBindings = prior.filter(
      (binding) => !currentPaths.has(fileKey(binding)),
    );
    const unmatched = plans.filter((plan) => !byPath.has(fileKey(plan)));
    const enumeration = status.enumeration as { state?: unknown } | undefined;
    const newSource =
      this.journal.checkpoint.phase === "idle" &&
      enumeration?.state === "never";
    const recovery =
      !newSource &&
      (this.journal.checkpoint.phase === "idle" ||
        (this.journal.checkpoint.phase === "terminal" &&
          this.journal.checkpoint.code === "identity_review_required") ||
        (missingBindings.length > 0 && unmatched.length > 0));
    for (const plan of plans) {
      const retained = byPath.get(fileKey(plan))?.externalId;
      if (retained !== undefined || !recovery) {
        plan.externalId = retained ?? randomUUID();
      }
    }
    if (plans.length + missingBindings.length > 256) {
      throw new FilesystemFailure(
        "oversized",
        "identity binding capacity exceeded",
      );
    }
    await this.journal.transitionCheckpoint({
      checkpoint: {
        version: 1,
        phase: "scan_begin",
        mode: recovery ? "identity_recovery" : "normal",
        expectedInventoryEpoch: integer(
          status.inventoryEpoch,
          "inventory_epoch",
        ),
        files: plans,
        missingBindings,
      },
      credentialSessionActive: true,
    });
  }

  private async driveScanBegin(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "scan_begin") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const result = await this.mutation(
      "scan.begin",
      () =>
        request(this.config, "scan.begin", {
          requestId: randomUUID(),
          watcherId: `pipeline-${this.config.sourceAccountId.slice(0, 64)}`,
          connectorVersion:
            this.config.pdfDocQa === undefined ? "p2-8-text-v1" : "p2-9-pdf-v1",
          ...(this.config.hostAffinity
            ? { hostAffinity: this.config.hostAffinity }
            : {}),
          mode: checkpoint.mode,
          expectedInventoryEpoch: checkpoint.expectedInventoryEpoch,
        }),
      (current, response) => {
        if (current.phase !== "scan_begin") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return plannedTerminal(current, code);
        }
        const scanId = text(value.scanId, "scan_id");
        if (value.state !== "open") {
          return {
            ...plannedTerminal(
              current,
              value.state === "needs_review"
                ? "identity_review_required"
                : "scan_advanced",
            ),
            outcome: value.state === "failed" ? "failed" : "incomplete",
            scanId,
          };
        }
        const inventoryEpoch = integer(value.inventoryEpoch, "inventory_epoch");
        const manifestVersion = integer(
          value.manifestVersion,
          "manifest_version",
        );
        const base = {
          mode: current.mode,
          scanId,
          inventoryEpoch,
          manifestVersion,
          files: current.files,
          missingBindings: current.missingBindings,
        };
        return current.mode === "identity_recovery"
          ? {
              version: 1,
              phase: "inventory",
              ...base,
              cursor: null,
              pageCount: 0,
              itemCount: 0,
              identities: [],
            }
          : {
              version: 1,
              phase: "append",
              ...base,
              nextOrdinal: 0,
              identities: [],
              reviewSeen: false,
            };
      },
    );
    if (errorCode(result)) throw new PipelineWorkerError(errorCode(result)!);
  }

  private async driveInventory(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "inventory") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const result = await this.mutation(
      "source.inventoryPage",
      () =>
        request(this.config, "source.inventoryPage", {
          scanId: checkpoint.scanId,
          requestId: randomUUID(),
          expectedInventoryEpoch: checkpoint.inventoryEpoch,
          expectedManifestVersion: checkpoint.manifestVersion,
          paginationOpts: { cursor: checkpoint.cursor, numItems: 50 },
        }),
      (current, response) => {
        if (current.phase !== "inventory") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return scanTerminal(current, "failed", code, true);
        }
        const page = records(value.page, "inventory_page");
        const nextPageCount = current.pageCount + 1;
        const nextItemCount = current.itemCount + page.length;
        if (
          nextPageCount > MAX_INVENTORY_PAGES ||
          nextItemCount > MAX_INVENTORY_ITEMS
        ) {
          return scanTerminal(
            current,
            "incomplete",
            "inventory_capacity_exceeded",
            true,
          );
        }
        const identities = new Map(
          current.identities.map((row) => [row.sourceItemId, row.externalId]),
        );
        for (const row of page) {
          if (row.lifecycle === "tombstone") continue;
          const sourceItemId = text(row.sourceItemId, "source_item_id");
          const externalId = text(row.externalId, "external_id");
          const existing = identities.get(sourceItemId);
          if (existing !== undefined && existing !== externalId) {
            throw new PipelineWorkerError("inventory_identity_conflict");
          }
          identities.set(sourceItemId, externalId);
        }
        if (identities.size > MAX_INVENTORY_ITEMS) {
          return scanTerminal(
            current,
            "incomplete",
            "inventory_capacity_exceeded",
            true,
          );
        }
        const nextIdentities: InventoryIdentity[] = [...identities].map(
          ([sourceItemId, externalId]) => ({ sourceItemId, externalId }),
        );
        if (value.isDone === true) {
          return {
            version: 1,
            phase: "append",
            ...activeScanBase(current),
            nextOrdinal: 0,
            identities: nextIdentities,
            reviewSeen: false,
          };
        }
        if (nextPageCount >= MAX_INVENTORY_PAGES) {
          return scanTerminal(
            current,
            "incomplete",
            "inventory_capacity_exceeded",
            true,
          );
        }
        const cursor = text(value.continueCursor, "inventory_cursor");
        if (cursor === current.cursor) {
          throw new PipelineWorkerError("inventory_cursor_conflict");
        }
        return {
          ...current,
          cursor,
          pageCount: nextPageCount,
          itemCount: nextItemCount,
          identities: nextIdentities,
        };
      },
    );
    if (errorCode(result)) throw new PipelineWorkerError(errorCode(result)!);
  }

  private async driveAppend(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "append") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const offset = checkpoint.nextOrdinal * 4;
    if (offset >= checkpoint.files.length) {
      await this.journal.transitionCheckpoint({
        checkpoint: {
          version: 1,
          phase: "seal_check",
          ...activeScanBase(checkpoint),
          nextOrdinal: checkpoint.nextOrdinal,
          reviewSeen: checkpoint.reviewSeen,
        },
        credentialSessionActive: true,
      });
      return;
    }
    const pagePlans = checkpoint.files.slice(offset, offset + 4);
    const result = await this.mutation(
      "scan.appendPage",
      () =>
        request(this.config, "scan.appendPage", {
          scanId: checkpoint.scanId,
          requestId: randomUUID(),
          ordinal: checkpoint.nextOrdinal,
          entries: pagePlans.map((plan) => scanEntry(plan, checkpoint.mode)),
        }),
      (current, response) => {
        if (current.phase !== "append") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return scanTerminal(current, "failed", code, true);
        }
        if (
          value.scanId !== current.scanId ||
          value.ordinal !== current.nextOrdinal
        ) {
          throw new PipelineWorkerError("scan_append_parent_conflict");
        }
        const output = records(value.entries, "append_entries");
        const input = current.files.slice(
          current.nextOrdinal * 4,
          current.nextOrdinal * 4 + 4,
        );
        if (output.length !== input.length) {
          throw new PipelineWorkerError("scan_append_count_conflict");
        }
        const identityMap = new Map(
          current.identities.map((row) => [row.sourceItemId, row.externalId]),
        );
        const files = current.files.map((plan) => ({ ...plan }));
        let reviewSeen = current.reviewSeen;
        for (let index = 0; index < output.length; index += 1) {
          const row = output[index]!;
          const plan = files[current.nextOrdinal * 4 + index]!;
          if (isPdfPlan(plan)) {
            if (row.state !== "queued" && row.state !== "unchanged") {
              delete plan.sourceItemId;
              delete plan.observationEpoch;
              delete plan.processingEpoch;
              delete plan.discoveryState;
            } else {
              const sourceItemId = row.sourceItemId;
              const observationEpoch = row.observationEpoch;
              const processingEpoch = row.processingEpoch;
              if (
                typeof sourceItemId !== "string" ||
                !Number.isSafeInteger(observationEpoch) ||
                !Number.isSafeInteger(processingEpoch)
              ) {
                throw new PipelineWorkerError("archived_append_parent_missing");
              }
              plan.sourceItemId = sourceItemId;
              plan.observationEpoch = observationEpoch as number;
              plan.processingEpoch = processingEpoch as number;
              plan.discoveryState = row.state;
            }
          }
          if (row.state === "needs_review") {
            reviewSeen = true;
            delete plan.externalId;
          }
          if (
            current.mode === "identity_recovery" &&
            (row.state === "unchanged" ||
              row.state === "queued" ||
              row.state === "gap")
          ) {
            const sourceItemId = text(row.sourceItemId, "source_item_id");
            const externalId = identityMap.get(sourceItemId);
            if (!externalId) {
              throw new PipelineWorkerError("inventory_identity_missing");
            }
            if (
              plan.externalId !== undefined &&
              plan.externalId !== externalId
            ) {
              throw new PipelineWorkerError("inventory_identity_conflict");
            }
            plan.externalId = externalId;
          } else if (current.mode === "identity_recovery") {
            delete plan.externalId;
          }
        }
        const nextOrdinal = current.nextOrdinal + 1;
        if (nextOrdinal * 4 >= current.files.length) {
          return {
            version: 1,
            phase: "seal_check",
            ...activeScanBase({ ...current, files }),
            nextOrdinal,
            reviewSeen,
          };
        }
        return {
          ...current,
          files,
          nextOrdinal,
          reviewSeen,
        };
      },
    );
    const code = errorCode(result);
    if (code && this.journal.checkpoint.phase === "append") {
      throw new PipelineWorkerError(code);
    }
  }

  private async driveSealCheck(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "seal_check") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    let health: { status: "healthy" } | { status: "failed"; code: string };
    try {
      const roots = await canonicalRoots(this.config);
      health = (await this.sameDiscoveredSnapshot(roots, checkpoint.files))
        ? { status: "healthy" }
        : { status: "failed", code: "unstable" };
    } catch (error) {
      health = {
        status: "failed",
        code: error instanceof FilesystemFailure ? error.code : "unreadable",
      };
    }
    await this.journal.transitionCheckpoint({
      checkpoint: {
        version: 1,
        phase: "seal",
        ...activeScanBase(checkpoint),
        nextOrdinal: checkpoint.nextOrdinal,
        reviewSeen: checkpoint.reviewSeen,
        health,
      },
      credentialSessionActive: true,
    });
  }

  private async driveSeal(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "seal") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const result = await this.mutation(
      "scan.seal",
      () =>
        request(this.config, "scan.seal", {
          scanId: checkpoint.scanId,
          requestId: randomUUID(),
          expectedPageCount: checkpoint.nextOrdinal,
          health: checkpoint.health,
        }),
      (current, response) => {
        if (current.phase !== "seal") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return scanTerminal(current, "failed", code, true);
        }
        if (value.scanId !== current.scanId) {
          throw new PipelineWorkerError("scan_seal_parent_conflict");
        }
        if (current.health.status === "failed") {
          return scanTerminal(current, "failed", current.health.code, false);
        }
        if (value.state === "needs_review") {
          return scanTerminal(
            current,
            "incomplete",
            "identity_review_required",
          );
        }
        if (value.state !== "sealed") {
          return scanTerminal(current, "failed", "scan_failed");
        }
        return {
          version: 1,
          phase: "reconcile",
          ...activeScanBase(current),
          ordinal: 0,
          reviewSeen: current.reviewSeen,
        };
      },
    );
    const code = errorCode(result);
    if (code && this.journal.checkpoint.phase === "seal") {
      throw new PipelineWorkerError(code);
    }
  }

  private async driveReconcile(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "reconcile") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const result = await this.mutation(
      "scan.reconcile",
      () =>
        request(this.config, "scan.reconcile", {
          scanId: checkpoint.scanId,
          requestId: randomUUID(),
          expectedInventoryEpoch: checkpoint.inventoryEpoch,
          ordinal: checkpoint.ordinal,
          maxItems: 50,
        }),
      async (current, response) => {
        if (current.phase !== "reconcile") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return scanTerminal(current, "failed", code, true);
        }
        if (value.scanId !== current.scanId) {
          throw new PipelineWorkerError("reconcile_parent_conflict");
        }
        if (value.done === true) {
          if (value.state === "needs_review") {
            return scanTerminal(
              current,
              "incomplete",
              "identity_review_required",
            );
          }
          if (value.state !== "enumerated") {
            throw new PipelineWorkerError("reconcile_state_invalid");
          }
          const pdfIndex = await this.nextPdfWorkIndex(current.files, 0);
          if (pdfIndex >= 0) {
            return {
              version: 1,
              phase: "archived",
              ...activeScanBase(current),
              pdfIndex,
              step: "intent",
              reservationRound: 0,
              archivedPublished: 0,
            };
          }
          return {
            version: 1,
            phase: "discovery_reserve",
            ...activeScanBase(current),
            round: 0,
          };
        }
        if (current.ordinal + 1 >= MAX_RECONCILE_PAGES) {
          return scanTerminal(
            current,
            "incomplete",
            "reconcile_capacity_exceeded",
            true,
          );
        }
        return { ...current, ordinal: current.ordinal + 1 };
      },
    );
    const code = errorCode(result);
    if (code && this.journal.checkpoint.phase === "reconcile") {
      throw new PipelineWorkerError(code);
    }
  }

  private async driveDiscoveryReserve(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "discovery_reserve") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const result = await this.mutation(
      "discovery.reserve",
      () =>
        request(this.config, "discovery.reserve", {
          requestId: randomUUID(),
          maxItems: 4,
        }),
      (current, response) => {
        if (current.phase !== "discovery_reserve") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return scanTerminal(current, "failed", code, true);
        }
        const targets = records(
          value.targets,
          "discovery_targets",
        ) as unknown as DiscoveryLease[];
        if (targets.length === 0) {
          return {
            version: 1,
            phase: "jobs_reserve",
            scanId: current.scanId,
            scanned: current.files.length,
            published: current.archivedPublished ?? 0,
            bindings: bindingsFromScan(current),
            round: 0,
          };
        }
        if (current.round >= MAX_RESERVATION_ROUNDS) {
          return scanTerminal(
            current,
            "incomplete",
            "discovery_capacity_exceeded",
            true,
          );
        }
        return {
          version: 1,
          phase: "discovery_admit",
          ...activeScanBase(current),
          round: current.round,
          targets,
          index: 0,
          ...(current.archivedPublished === undefined
            ? {}
            : { archivedPublished: current.archivedPublished }),
        };
      },
    );
    if (errorCode(result)) throw new PipelineWorkerError(errorCode(result)!);
  }

  private findRoot(roots: SafeRoot[], alias: string): SafeRoot {
    const root = roots.find((candidate) => candidate.alias === alias);
    if (!root) throw new PipelineWorkerError("root_alias_missing");
    return root;
  }

  private async driveDiscoveryAdmit(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "discovery_admit") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    if (checkpoint.index >= checkpoint.targets.length) {
      await this.journal.transitionCheckpoint({
        checkpoint: {
          version: 1,
          phase: "discovery_reserve",
          ...activeScanBase(checkpoint),
          round: checkpoint.round + 1,
        },
        credentialSessionActive: true,
      });
      return;
    }
    const target = checkpoint.targets[checkpoint.index]!;
    const plan = checkpoint.files.find(
      (candidate) =>
        toFsUri(candidate.rootAlias, candidate.relativePath) === target.uri,
    );
    let currentFile: DiscoveryFile | undefined;
    if (!this.journal.pending) {
      if (target.leaseExpiresAt <= Date.now() + LEASE_SAFETY_MARGIN_MS) {
        await this.journal.transitionCheckpoint({
          checkpoint: afterDiscoveryTarget(checkpoint),
          credentialSessionActive: true,
        });
        return;
      }
      if (!plan || !isUtf8Plan(plan)) {
        await this.journal.transitionCheckpoint({
          checkpoint: scanTerminal(
            checkpoint,
            "failed",
            "stale_observation",
            true,
          ),
          credentialSessionActive: true,
        });
        return;
      }
      const roots = await canonicalRoots(this.config);
      currentFile = await readUtf8File(
        this.findRoot(roots, plan.rootAlias),
        plan.relativePath,
        this.config.maxFileBytes,
      );
      if (
        !samePlan(currentFile, plan) ||
        currentFile.sha256 !== target.contentHash ||
        currentFile.byteLength !== target.byteLength
      ) {
        await this.journal.transitionCheckpoint({
          checkpoint: scanTerminal(
            checkpoint,
            "failed",
            "stale_observation",
            true,
          ),
          credentialSessionActive: true,
        });
        return;
      }
    }
    const result = await this.mutation(
      "discovery.admitUtf8",
      () =>
        request(this.config, "discovery.admitUtf8", {
          requestId: randomUUID(),
          workId: target.workId,
          leaseEpoch: target.leaseEpoch,
          leaseToken: target.leaseToken,
          text: currentFile!.text,
        }),
      (current, response) => {
        if (current.phase !== "discovery_admit") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          if (code === "reservation_expired" || code === "lease_conflict") {
            return afterDiscoveryTarget(current);
          }
          if (
            code === "stale_observation" ||
            code === "desired_processing_epoch_conflict"
          ) {
            return scanTerminal(current, "failed", code, true);
          }
          return scanTerminal(current, "failed", code, true);
        }
        const activeTarget = current.targets[current.index];
        if (
          !activeTarget ||
          value.workId !== activeTarget.workId ||
          value.sourceItemId !== activeTarget.sourceItemId ||
          value.desiredProcessingEpoch !== activeTarget.processingEpoch
        ) {
          throw new PipelineWorkerError("admission_parent_conflict");
        }
        return afterDiscoveryTarget(current);
      },
    );
    const code = errorCode(result);
    if (code && this.journal.checkpoint.phase === "discovery_admit") {
      throw new PipelineWorkerError(code);
    }
  }

  private archiveConfiguration(role: ArchiveCopyRole) {
    const pdf = this.requirePdfConfig();
    return role === "primary"
      ? pdf.archive.primary
      : pdf.archive.independentBackup;
  }

  private resticLocation(subject: ArchiveSubject) {
    const backup = this.requirePdfConfig().archive.independentBackup;
    if ("repository" in backup) {
      if (subject !== "parser_output") {
        throw new PipelineWorkerError("archive_remote_original_unsupported");
      }
      return { repository: backup.repository! };
    }
    return { repositoryPath: backup.repositoryPath };
  }

  private providerDeclaration(
    original: OriginalCatalogRow,
    requireFresh = true,
  ) {
    const provider = original.providerOriginal;
    const verified = provider?.verified;
    const locator = provider?.locator;
    if (
      !provider ||
      !verified ||
      !locator?.published ||
      !locator.backup ||
      locator.readbackVerifiedAt === undefined
    )
      throw new PipelineWorkerError("provider_original_not_durable");
    if (
      requireFresh &&
      (verified.verifiedAt < Date.now() - 9 * 60_000 ||
        verified.verifiedAt > Date.now() + 4 * 60_000 ||
        locator.readbackVerifiedAt < Date.now() - 9 * 60_000 ||
        locator.readbackVerifiedAt > Date.now() + 4 * 60_000)
    )
      throw new PipelineWorkerError(
        "provider_verification_stale_review_required",
      );
    return {
      referenceVersion: "provider_original_v1" as const,
      providerKind: "dropbox_v1" as const,
      clientReferenceId: provider.clientReferenceId,
      sourceContentHash: verified.sourceContentHash,
      sourceByteLength: verified.sourceByteLength,
      providerAccountIdHash: verified.providerAccountIdHash,
      providerRootDirectoryIdHash: verified.providerRootDirectoryIdHash,
      providerFileIdHash: verified.providerFileIdHash,
      providerRevision: verified.providerRevision,
      providerContentHash: verified.providerContentHash,
      verifiedAt: verified.verifiedAt,
      locatorBundle: {
        bindingId: provider.bindingId,
        manifestFingerprint: verified.manifestFingerprint,
        recipientFingerprint: locator.recipientFingerprint,
        repositoryKeyDomainFingerprint: locator.repositoryKeyDomainFingerprint,
        repositoryId: locator.backup.repositoryId,
        snapshotId: locator.backup.snapshotId,
        objectName: locator.objectName,
        ciphertextHash: locator.published.ciphertext.sha256,
        ciphertextByteLength: locator.published.ciphertext.byteLength,
        readbackVerifiedAt: locator.readbackVerifiedAt,
      },
      createdAt: original.createdAt,
    };
  }

  private preparedArchiveObject(
    row: OriginalCatalogRow | ProcessingCatalogRow,
    role: ArchiveCopyRole,
  ) {
    const copy = row.copies[role];
    if (!copy.prepared)
      throw new PipelineWorkerError("archive_prepare_missing");
    return {
      ...copy.prepared,
      tempPath: join(
        this.archiveConfiguration(role).directory,
        copy.prepared.tempName,
      ),
    };
  }

  private async recordArchiveAction(
    checkpoint: ArchivedCheckpoint,
    action: NonNullable<ArchivedCheckpoint["preflightAction"]>,
    recoveredBackup?: RecoveredResticBackup,
  ): Promise<RunnerCheckpoint> {
    if (action === "initial") {
      return archivedBase(checkpoint, {
        step: "lookup_original",
        preflightAction: undefined,
      });
    }
    if (action.startsWith("provider_")) {
      const { original, processing } = this.archivedRows(checkpoint);
      const capture = captureFromRows(
        this.requirePdfConfig(),
        original,
        processing,
      );
      return (await this.driveProviderOriginal(
        checkpoint,
        original,
        processing,
        capture.path,
        action,
      ))!;
    }
    const subject: ArchiveSubject = action.startsWith("original_")
      ? "original_bytes"
      : "parser_output";
    const role: ArchiveCopyRole = action.includes("primary")
      ? "primary"
      : "independent_backup";
    const snapshot = action.endsWith("snapshot");
    const { original, processing } = this.archivedRows(checkpoint);
    const row = subject === "original_bytes" ? original : processing;
    const copy = row.copies[role];
    const configured = this.archiveConfiguration(role);
    const prepared = this.preparedArchiveObject(row, role);
    const pdf = this.requirePdfConfig();
    let nextRow: OriginalCatalogRow | ProcessingCatalogRow;
    if (!snapshot) {
      const finalPath = join(configured.directory, copy.objectName);
      let published;
      if (copy.published) {
        await recoverPublishedAgeObject(prepared, finalPath);
        published = { ...copy.published, objectPath: finalPath };
      } else {
        try {
          published = await publishAgeObject(prepared, finalPath);
        } catch (error) {
          if (
            !(error instanceof ArchiveCommandError) ||
            error.code !== "destination_exists"
          ) {
            throw error;
          }
          await recoverPublishedAgeObject(prepared, finalPath);
          published = {
            state: "published" as const,
            objectPath: finalPath,
            source: prepared.source,
            ciphertext: prepared.ciphertext,
            ciphertextDevice: prepared.ciphertextDevice,
            ciphertextInode: prepared.ciphertextInode,
            ageVersion: prepared.ageVersion,
          };
        }
      }
      nextRow = await this.requireCatalog().recordArchivePublished({
        subject,
        catalogId:
          subject === "original_bytes"
            ? original.originalCatalogId
            : processing.processingCatalogId,
        expectedRevision: row.rowRevision,
        role,
        published: publishedArchiveCatalogRecord(published),
        ...(role === "primary"
          ? { readbackVerifiedAt: copy.readbackVerifiedAt ?? Date.now() }
          : {}),
      });
    } else {
      if (role !== "independent_backup" || !copy.published || !copy.restic) {
        throw new PipelineWorkerError("archive_backup_parent_missing");
      }
      let backup;
      if (copy.backup) {
        if (!recoveredBackup) {
          throw new PipelineWorkerError("archive_backup_recovery_missing");
        }
        for (const field of [
          "operationId",
          "snapshotId",
          "objectName",
          "resticVersion",
          "repositoryId",
          "verification",
        ] as const) {
          if (copy.backup[field] !== recoveredBackup[field]) {
            throw new PipelineWorkerError("archive_backup_recovery_conflict");
          }
        }
        if (!equalJson(copy.backup.ciphertext, recoveredBackup.ciphertext)) {
          throw new PipelineWorkerError("archive_backup_recovery_conflict");
        }
        const storedBoundary = copy.backup.boundary;
        if (
          storedBoundary !== undefined &&
          "backend" in storedBoundary &&
          recoveredBackup.boundary === undefined
        ) {
          throw new PipelineWorkerError("archive_backup_recovery_conflict");
        }
        if (recoveredBackup.boundary !== undefined) {
          const recoveredBoundary = recoveredBackup.boundary;
          const relocated =
            !equalJson(storedBoundary, recoveredBoundary) &&
            storedBoundary !== undefined &&
            "backend" in storedBoundary &&
            this.requireCatalog().resolvesBoundaryRelocation({
              oldBoundary: storedBoundary,
              newBoundary: recoveredBoundary,
              artifact: {
                snapshotId: copy.backup.snapshotId,
                objectName: copy.backup.objectName,
                ciphertextSha256: copy.backup.ciphertext.sha256,
                ciphertextByteLength: copy.backup.ciphertext.byteLength,
              },
            });
          if (!equalJson(storedBoundary, recoveredBoundary) && !relocated) {
            throw new PipelineWorkerError("archive_backup_recovery_conflict");
          }
        }
        backup = copy.backup;
      } else if (recoveredBackup) {
        backup = recoveredBackup;
      } else {
        backup = await backupResticObject({
          resticBinary: pdf.archive.independentBackup.resticBinary,
          ...this.resticLocation(subject),
          expectedRepositoryId: copy.restic.repositoryId,
          passwordCommand: pdf.archive.independentBackup.passwordCommand,
          operationId: copy.restic.operationId,
          host: copy.restic.host,
          ciphertextPath: join(configured.directory, copy.objectName),
          expectedCiphertext: copy.published.ciphertext,
          primaryArchiveRoot: pdf.archive.primary.directory,
          backupMode: "independent_backup",
        });
      }
      nextRow = await this.requireCatalog().recordResticBackup({
        subject,
        catalogId:
          subject === "original_bytes"
            ? original.originalCatalogId
            : processing.processingCatalogId,
        expectedRevision: row.rowRevision,
        role: "independent_backup",
        backup,
        readbackVerifiedAt: copy.readbackVerifiedAt ?? Date.now(),
      });
    }
    return archivedBase(checkpoint, {
      step:
        subject === "original_bytes" ? "original_archive" : "parser_archive",
      preflightAction: undefined,
      ...(subject === "original_bytes"
        ? { expectedOriginalRevision: nextRow.rowRevision }
        : { expectedProcessingRevision: nextRow.rowRevision }),
    });
  }

  private async driveArchivedPreflight(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (
      checkpoint.phase !== "archived" ||
      checkpoint.step !== "preflight" ||
      !checkpoint.preflightAction
    ) {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const rows = this.archivedRows(checkpoint);
    const identity = archivedIdentity(
      checkpoint,
      this.archivedPlan(checkpoint),
    );
    const intentDigest = digestArchiveIntent({
      identity,
      original: rows.original,
      processing: rows.processing,
    });
    let recoveredBackup: RecoveredResticBackup | undefined;
    if (checkpoint.preflightAction !== "initial") {
      const pdf = this.requirePdfConfig();
      await probeArchiveTools({
        ageBinary: pdf.archive.ageBinary,
        resticBinary: pdf.archive.independentBackup.resticBinary,
      });
      if (
        checkpoint.preflightAction.endsWith("snapshot") &&
        !checkpoint.preflightAction.startsWith("provider_")
      ) {
        const repository = await probeResticRepository({
          resticBinary: pdf.archive.independentBackup.resticBinary,
          ...this.resticLocation(
            checkpoint.preflightAction.startsWith("original_")
              ? "original_bytes"
              : "parser_output",
          ),
          passwordCommand: pdf.archive.independentBackup.passwordCommand,
        });
        if (
          repository.repositoryId !==
          pdf.archive.independentBackup.expectedRepositoryId
        ) {
          throw new PipelineWorkerError("archive_repository_conflict");
        }
        const { original, processing } = this.archivedRows(checkpoint);
        const subject = checkpoint.preflightAction.startsWith("original_")
          ? "original_bytes"
          : "parser_output";
        const row = subject === "original_bytes" ? original : processing;
        const copy = row.copies.independent_backup;
        if (!copy.published || !copy.restic) {
          throw new PipelineWorkerError("archive_backup_parent_missing");
        }
        try {
          recoveredBackup = await recoverResticBackup({
            resticBinary: pdf.archive.independentBackup.resticBinary,
            ...this.resticLocation(subject),
            expectedRepositoryId: copy.restic.repositoryId,
            passwordCommand: pdf.archive.independentBackup.passwordCommand,
            operationId: copy.restic.operationId,
            host: copy.restic.host,
            objectName: copy.objectName,
            expectedCiphertext: copy.published.ciphertext,
          });
        } catch (error) {
          if (
            !(error instanceof ArchiveCommandError) ||
            error.code !== "not_found"
          ) {
            throw error;
          }
        }
      }
    }
    const cached = this.journal.pending;
    if (
      cached?.operation === "discovery.preflightArchived" &&
      cached.result !== undefined
    ) {
      const parsedBody = JSON.parse(cached.requestBody) as Record<
        string,
        unknown
      >;
      await this.validatePendingBody("discovery.preflightArchived", parsedBody);
      const fresh = asWorkerResponse(
        parseDurableResult(
          "discovery.preflightArchived",
          await this.callWithRateLimitBackoff(parsedBody),
        ),
      );
      const freshError = errorCode(fresh);
      if (freshError) {
        await this.journal.commitResult({
          checkpoint: scanTerminal(checkpoint, "failed", freshError, true),
          credentialSessionActive: true,
        });
        return;
      }
      const freshValue = object(fresh, "discovery.preflightArchived");
      if (
        freshValue.sourceItemId !== identity.sourceItemId ||
        Number(freshValue.expectedDesiredProcessingEpoch) + 1 !==
          identity.processingEpoch ||
        freshValue.archiveIntentDigest !== parsedBody.archiveIntentDigest
      ) {
        throw new PipelineWorkerError("archived_preflight_parent_conflict");
      }
    }
    const result = await this.mutation(
      "discovery.preflightArchived",
      () =>
        request(this.config, "discovery.preflightArchived", {
          requestId: randomUUID(),
          identity,
          archiveIntentDigest: intentDigest,
        }),
      async (current, response, pending) => {
        if (current.phase !== "archived" || current.step !== "preflight") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "discovery.preflightArchived");
        const plan = this.archivedPlan(current);
        const pendingBody = JSON.parse(pending.requestBody) as Record<
          string,
          unknown
        >;
        if (
          value.sourceItemId !== plan.sourceItemId ||
          Number(value.expectedDesiredProcessingEpoch) + 1 !==
            plan.processingEpoch ||
          value.archiveIntentDigest !== pendingBody.archiveIntentDigest
        ) {
          throw new PipelineWorkerError("archived_preflight_parent_conflict");
        }
        return await this.recordArchiveAction(
          current,
          current.preflightAction!,
          recoveredBackup,
        );
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "preflight"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private async driveArchiveCopies(
    checkpoint: ArchivedCheckpoint,
    subject: ArchiveSubject,
  ): Promise<void> {
    const { original, processing } = this.archivedRows(checkpoint);
    const row = subject === "original_bytes" ? original : processing;
    const pdf = this.requirePdfConfig();
    const capture = captureFromRows(pdf, original, processing);
    const source =
      subject === "original_bytes"
        ? {
            path: capture.path,
            sha256: capture.sha256,
            byteLength: capture.byteLength,
          }
        : processing.parserOutput
          ? {
              path: join(
                pdf.parserOutputRoot,
                processing.parserIntent.outputId,
                processing.parserOutput.rawArtifact.opaqueName,
              ),
              sha256: processing.parserOutput.rawArtifact.sha256,
              byteLength: processing.parserOutput.rawArtifact.byteLength,
            }
          : undefined;
    if (!source) throw new PipelineWorkerError("parser_output_missing");
    const roles =
      subject === "original_bytes" && original.providerOriginal
        ? (["primary"] as const)
        : (["primary", "independent_backup"] as const);
    for (const role of roles) {
      const copy = row.copies[role];
      if (!copy.prepared) {
        const configured = this.archiveConfiguration(role);
        const catalogId =
          subject === "original_bytes"
            ? original.originalCatalogId
            : processing.processingCatalogId;
        if (!copy.preparationIntent) {
          const intended =
            await this.requireCatalog().recordArchivePreparationIntent({
              subject,
              catalogId,
              expectedRevision: row.rowRevision,
              role,
              tempName: `${copy.archiveObjectId}.tmp`,
            });
          await this.journal.transitionCheckpoint({
            checkpoint: archivedBase(checkpoint, {
              ...(subject === "original_bytes"
                ? { expectedOriginalRevision: intended.rowRevision }
                : { expectedProcessingRevision: intended.rowRevision }),
            }),
            credentialSessionActive: true,
          });
          return;
        }
        let prepared;
        try {
          prepared = await encryptAgeObject({
            ageBinary: pdf.archive.ageBinary,
            sourcePath: source.path,
            tempOutputPath: join(
              configured.directory,
              copy.preparationIntent.tempName,
            ),
            recipient: configured.recipient,
            expectedSource: {
              sha256: source.sha256,
              byteLength: source.byteLength,
            },
          });
        } catch (error) {
          if (
            !(error instanceof ArchiveCommandError) ||
            error.code !== "destination_exists"
          ) {
            throw error;
          }
          const reviewed = await this.requireCatalog().markReview({
            subject,
            catalogId:
              subject === "original_bytes"
                ? original.originalCatalogId
                : processing.processingCatalogId,
            expectedRevision: row.rowRevision,
            role,
            code: "replacement_detected",
          });
          const reviewedCheckpoint = archivedBase(checkpoint, {
            ...(subject === "original_bytes"
              ? { expectedOriginalRevision: reviewed.rowRevision }
              : { expectedProcessingRevision: reviewed.rowRevision }),
          });
          await this.journal.transitionCheckpoint({
            checkpoint: scanTerminal(
              reviewedCheckpoint,
              "incomplete",
              "archive_recovery_review_required",
            ),
            credentialSessionActive: false,
          });
          return;
        }
        const next = await this.requireCatalog().recordArchivePrepared({
          subject,
          catalogId,
          expectedRevision: row.rowRevision,
          role,
          prepared: preparedArchiveCatalogRecord(prepared),
        });
        await this.journal.transitionCheckpoint({
          checkpoint: archivedBase(checkpoint, {
            ...(subject === "original_bytes"
              ? { expectedOriginalRevision: next.rowRevision }
              : { expectedProcessingRevision: next.rowRevision }),
          }),
          credentialSessionActive: true,
        });
        return;
      }
      if (!copy.published) {
        await this.journal.transitionCheckpoint({
          checkpoint: archivedBase(checkpoint, {
            step: "preflight",
            preflightAction: `${subject === "original_bytes" ? "original" : "parser"}_${role === "primary" ? "primary" : "backup"}_publish`,
          }),
          credentialSessionActive: true,
        });
        return;
      }
      if (role === "independent_backup" && !copy.backup) {
        await this.journal.transitionCheckpoint({
          checkpoint: archivedBase(checkpoint, {
            step: "preflight",
            preflightAction: `${subject === "original_bytes" ? "original" : "parser"}_backup_snapshot`,
          }),
          credentialSessionActive: true,
        });
        return;
      }
    }
    if (subject === "parser_output" && original.providerOriginal) {
      await this.driveProviderOriginal(
        checkpoint,
        original,
        processing,
        capture.path,
      );
      return;
    }
    await this.journal.transitionCheckpoint({
      checkpoint: archivedBase(checkpoint, {
        step: subject === "original_bytes" ? "parse" : "reserve",
      }),
      credentialSessionActive: true,
    });
  }

  private async driveProviderOriginal(
    checkpoint: ArchivedCheckpoint,
    original: OriginalCatalogRow,
    processing: ProcessingCatalogRow,
    capturePath: string,
    authorizedAction?: NonNullable<ArchivedCheckpoint["preflightAction"]>,
  ): Promise<RunnerCheckpoint | void> {
    const pdf = this.requirePdfConfig();
    const provider = pdf.providerOriginal;
    const state = original.providerOriginal;
    if (!provider || !state || !("repository" in pdf.archive.independentBackup))
      throw new PipelineWorkerError("provider_original_configuration_missing");
    const remoteRepository = pdf.archive.independentBackup.repository!;
    const plan = this.archivedPlan(checkpoint);
    if (plan.rootAlias !== provider.rootAlias)
      throw new PipelineWorkerError("provider_original_root_mismatch");
    if (state.locator.reviewCode)
      throw new PipelineWorkerError(
        "provider_locator_recovery_review_required",
      );
    let loaded = await loadProviderBinding({
      registryDirectory: provider.registryDirectory,
      bindingId: state.bindingId,
    });
    const requiredAction = !state.verified
      ? "provider_verify"
      : !state.locator.prepared
        ? "provider_locator_prepare"
        : !state.locator.published
          ? "provider_locator_publish"
          : !state.locator.backup
            ? "provider_locator_snapshot"
            : undefined;
    if (authorizedAction === undefined) {
      if (requiredAction === undefined) {
        await this.journal.transitionCheckpoint({
          checkpoint: archivedBase(checkpoint, { step: "reserve" }),
          credentialSessionActive: true,
        });
      } else {
        await this.journal.transitionCheckpoint({
          checkpoint: archivedBase(checkpoint, {
            step: "preflight",
            preflightAction: requiredAction,
          }),
          credentialSessionActive: true,
        });
      }
      return;
    }
    if (authorizedAction !== requiredAction)
      throw new PipelineWorkerError("provider_action_conflict");
    if (!state.verified) {
      if (!loaded) {
        const verified = await verifyDropboxOriginal({
          credentials: {
            rcloneBinary: remoteRepository.rcloneBinary,
            configPath: remoteRepository.configPath,
            remoteName: remoteRepository.remoteName,
            configIdentityFingerprint:
              remoteRepository.configIdentityFingerprint,
          },
          refreshPath: provider.refreshPath,
          capturePath,
          sourceContentHash: original.origin.sha256,
          sourceByteLength: original.origin.byteLength,
          providerAccountIdHash: provider.providerAccountIdHash,
          providerRootDirectoryIdHash: provider.providerRootDirectoryIdHash,
          providerRootDirectoryId: provider.providerRootDirectoryId,
          relativePath: plan.relativePath,
          bindingId: state.bindingId,
        });
        const persisted = await persistProviderBinding({
          registryDirectory: provider.registryDirectory,
          verified,
        });
        loaded = { persisted, verified };
      }
      if (
        loaded.verified.metadata.providerAccountIdHash !==
          provider.providerAccountIdHash ||
        loaded.verified.metadata.providerRootDirectoryIdHash !==
          provider.providerRootDirectoryIdHash ||
        loaded.verified.metadata.sourceContentHash !== original.origin.sha256 ||
        loaded.verified.metadata.sourceByteLength !==
          original.origin.byteLength ||
        loaded.verified.binding.providerRootDirectoryId !==
          provider.providerRootDirectoryId ||
        loaded.verified.binding.relativePath !== plan.relativePath
      )
        throw new PipelineWorkerError("provider_locator_registry_conflict");
      const next = await this.requireCatalog().recordProviderVerified({
        catalogId: original.originalCatalogId,
        expectedRevision: original.rowRevision,
        verified: {
          providerAccountIdHash: loaded.verified.metadata.providerAccountIdHash,
          providerRootDirectoryIdHash:
            loaded.verified.metadata.providerRootDirectoryIdHash,
          providerFileIdHash: loaded.verified.metadata.providerFileIdHash,
          providerRevision: loaded.verified.metadata.providerRevision,
          providerContentHash: loaded.verified.metadata.providerContentHash,
          sourceContentHash: loaded.verified.metadata.sourceContentHash,
          sourceByteLength: loaded.verified.metadata.sourceByteLength,
          verifiedAt: loaded.verified.metadata.verifiedAt,
          manifestFingerprint: loaded.persisted.manifestFingerprint,
          manifestByteLength: loaded.persisted.manifestByteLength,
        },
      });
      return archivedBase(checkpoint, {
        step: "parser_archive",
        preflightAction: undefined,
        expectedOriginalRevision: next.rowRevision,
      });
    }
    if (
      !loaded ||
      loaded.persisted.manifestFingerprint !==
        state.verified.manifestFingerprint
    )
      throw new PipelineWorkerError("provider_locator_registry_missing");
    const copy = state.locator;
    const configured = pdf.archive.independentBackup;
    if (!copy.preparationIntent) {
      const next = await this.requireCatalog().updateProviderLocator({
        catalogId: original.originalCatalogId,
        expectedRevision: original.rowRevision,
        update: (value) => {
          value.preparationIntent = {
            tempName: `${value.archiveObjectId}.tmp`,
          };
        },
      });
      return archivedBase(checkpoint, {
        step: "parser_archive",
        preflightAction: undefined,
        expectedOriginalRevision: next.rowRevision,
      });
    }
    if (!copy.prepared) {
      let prepared;
      try {
        prepared = await encryptAgeObject({
          ageBinary: pdf.archive.ageBinary,
          sourcePath: loaded.persisted.manifestPath,
          tempOutputPath: join(
            configured.directory,
            copy.preparationIntent.tempName,
          ),
          recipient: configured.recipient,
          expectedSource: {
            sha256: state.verified.manifestFingerprint,
            byteLength: state.verified.manifestByteLength,
          },
        });
      } catch (error) {
        if (
          error instanceof ArchiveCommandError &&
          error.code === "destination_exists"
        ) {
          const reviewed = await this.requireCatalog().updateProviderLocator({
            catalogId: original.originalCatalogId,
            expectedRevision: original.rowRevision,
            update: (value) => {
              value.reviewCode = "replacement_detected";
            },
          });
          return scanTerminal(
            archivedBase(checkpoint, {
              expectedOriginalRevision: reviewed.rowRevision,
              preflightAction: undefined,
            }),
            "incomplete",
            "provider_locator_recovery_review_required",
          );
        }
        throw error;
      }
      const next = await this.requireCatalog().updateProviderLocator({
        catalogId: original.originalCatalogId,
        expectedRevision: original.rowRevision,
        update: (value) => {
          value.prepared = preparedArchiveCatalogRecord(prepared);
        },
      });
      return archivedBase(checkpoint, {
        step: "parser_archive",
        preflightAction: undefined,
        expectedOriginalRevision: next.rowRevision,
      });
    }
    const prepared = {
      ...copy.prepared,
      tempPath: join(configured.directory, copy.prepared.tempName),
    };
    if (!copy.published) {
      const finalPath = join(configured.directory, copy.objectName);
      let published;
      try {
        published = await publishAgeObject(prepared, finalPath);
      } catch (error) {
        if (
          !(error instanceof ArchiveCommandError) ||
          error.code !== "destination_exists"
        )
          throw error;
        await recoverPublishedAgeObject(prepared, finalPath);
        published = {
          state: "published" as const,
          objectPath: finalPath,
          source: prepared.source,
          ciphertext: prepared.ciphertext,
          ciphertextDevice: prepared.ciphertextDevice,
          ciphertextInode: prepared.ciphertextInode,
          ageVersion: prepared.ageVersion,
        };
      }
      const next = await this.requireCatalog().updateProviderLocator({
        catalogId: original.originalCatalogId,
        expectedRevision: original.rowRevision,
        update: (value) => {
          value.published = publishedArchiveCatalogRecord(published);
        },
      });
      return archivedBase(checkpoint, {
        step: "parser_archive",
        preflightAction: undefined,
        expectedOriginalRevision: next.rowRevision,
      });
    }
    if (!copy.backup) {
      const common = {
        resticBinary: configured.resticBinary,
        repository: remoteRepository,
        expectedRepositoryId: configured.expectedRepositoryId,
        passwordCommand: configured.passwordCommand,
        operationId: copy.restic!.operationId,
        host: copy.restic!.host,
        objectName: copy.objectName,
        expectedCiphertext: copy.published.ciphertext,
      };
      let backup: RecoveredResticBackup | ResticBackupResult | undefined;
      try {
        backup = await recoverResticBackup(common);
      } catch (error) {
        if (
          !(error instanceof ArchiveCommandError) ||
          error.code !== "not_found"
        )
          throw error;
      }
      backup ??= await backupResticObject({
        ...common,
        ciphertextPath: join(configured.directory, copy.objectName),
        primaryArchiveRoot: pdf.archive.primary.directory,
        backupMode: "independent_backup",
      });
      const next = await this.requireCatalog().updateProviderLocator({
        catalogId: original.originalCatalogId,
        expectedRevision: original.rowRevision,
        update: (value) => {
          value.backup = backup;
          value.readbackVerifiedAt = Date.now();
        },
      });
      return archivedBase(checkpoint, {
        step: "parser_archive",
        preflightAction: undefined,
        expectedOriginalRevision: next.rowRevision,
      });
    }
    return archivedBase(checkpoint, {
      step: "reserve",
      preflightAction: undefined,
    });
  }

  private async driveArchivedLookupOriginal(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (
      checkpoint.phase !== "archived" ||
      checkpoint.step !== "lookup_original"
    ) {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const identity = archivedIdentity(
      checkpoint,
      this.archivedPlan(checkpoint),
    );
    const result = await this.mutation(
      "discovery.lookupArchivedAdmission",
      () =>
        request(this.config, "discovery.lookupArchivedAdmission", {
          requestId: randomUUID(),
          identity,
          lookup: { mode: "original" },
        }),
      async (current, response, pending) => {
        if (
          current.phase !== "archived" ||
          current.step !== "lookup_original"
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "discovery.lookupArchivedAdmission");
        if (value.mode !== "original") {
          throw new PipelineWorkerError("archived_lookup_mode_conflict");
        }
        if (value.found !== true) {
          return archivedBase(current, { step: "capture" });
        }
        let { original } = this.archivedRows(current);
        const provider = original.providerOriginal !== undefined;
        const responseProvider = "originalProviderReferenceId" in value;
        if (provider !== responseProvider)
          throw new PipelineWorkerError("archived_recovery_branch_conflict");
        const originalReceipts = [
          ["primary", "originalPrimaryReceiptId"],
          ...(provider
            ? []
            : [["independent_backup", "originalBackupReceiptId"] as const]),
        ] as const;
        for (const [role, receiptField] of originalReceipts) {
          if (!original.copies[role].published) {
            throw new PipelineWorkerError(
              "archived_original_recovery_incomplete",
            );
          }
          if (!original.copies[role].cloudReceipt) {
            original = (await this.requireCatalog().recordCloudReceipt({
              subject: "original_bytes",
              catalogId: original.originalCatalogId,
              expectedRevision: original.rowRevision,
              role,
              receiptId: text(value[receiptField], "archive_receipt_id"),
              requestDigest: pending.requestDigest,
              recordedAt: pending.receivedAt,
            })) as OriginalCatalogRow;
          }
        }
        if (!original.cloud) {
          original = await this.requireCatalog().recordOriginalCloud({
            catalogId: original.originalCatalogId,
            expectedRevision: original.rowRevision,
            cloud: {
              sourceItemId: identity.sourceItemId,
              sourceRevisionId: text(
                value.sourceRevisionId,
                "source_revision_id",
              ),
              primaryReceiptId: original.copies.primary.cloudReceipt!.receiptId,
              ...(provider
                ? {
                    providerReferenceId: text(
                      value.originalProviderReferenceId,
                      "original_provider_reference_id",
                    ),
                    providerBindingEpoch: integer(
                      value.originalProviderBindingEpoch,
                      "original_provider_binding_epoch",
                    ),
                  }
                : {
                    backupReceiptId:
                      original.copies.independent_backup.cloudReceipt!
                        .receiptId,
                  }),
              admittedAt: pending.receivedAt,
            },
          });
        }
        return archivedBase(current, {
          step: "capture",
          expectedOriginalRevision: original.rowRevision,
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "lookup_original"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private async driveArchivedCapture(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "capture") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const pdf = this.requirePdfConfig();
    const plan = this.archivedPlan(checkpoint);
    const rows = this.archivedRows(checkpoint);
    let processing = rows.processing;
    if (processing.capture) {
      await inspectCapturedPdf({
        captureDirectory: pdf.captureDirectory,
        captureId: processing.captureIntent.captureId,
        expected: {
          sha256: rows.original.origin.sha256,
          byteLength: rows.original.origin.byteLength,
          sourceModifiedAt: processing.capture.sourceModifiedAt,
        },
        expectedDirectory: {
          path: pdf.captureDirectory,
          ...processing.captureIntent.directory,
        },
      });
    } else {
      const expected = {
        sha256: plan.sha256,
        byteLength: plan.byteLength,
        sourceModifiedAt: plan.sourceModifiedAt,
      };
      const capturePath = join(
        pdf.captureDirectory,
        `${processing.captureIntent.captureId}.pdf`,
      );
      const exists = await lstat(capturePath)
        .then(() => true)
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        });
      const capture = exists
        ? await inspectCapturedPdf({
            captureDirectory: pdf.captureDirectory,
            captureId: processing.captureIntent.captureId,
            expected,
            expectedDirectory: {
              path: pdf.captureDirectory,
              ...processing.captureIntent.directory,
            },
          })
        : await capturePdfFile({
            root: this.findRoot(
              await canonicalRoots(this.config),
              plan.rootAlias,
            ),
            relativePath: plan.relativePath,
            captureDirectory: pdf.captureDirectory,
            captureId: processing.captureIntent.captureId,
            expected,
          });
      processing = await this.requireCatalog().recordCapture({
        catalogId: processing.processingCatalogId,
        expectedRevision: processing.rowRevision,
        capture: captureCatalogRecord(capture),
      });
    }
    await this.journal.transitionCheckpoint({
      checkpoint: archivedBase(checkpoint, {
        step: rows.original.cloud ? "parse" : "original_archive",
        expectedProcessingRevision: processing.rowRevision,
      }),
      credentialSessionActive: true,
    });
  }

  private parserRecovery(
    original: OriginalCatalogRow,
    processing: ProcessingCatalogRow,
  ) {
    const pdf = this.requirePdfConfig();
    if (!this.preparedPdfProfile) {
      throw new PipelineWorkerError("parser_profile_unverified");
    }
    return {
      capture: captureFromRows(pdf, original, processing),
      outputRoot: pdf.parserOutputRoot,
      outputIntent: parserOutputIntentCore(processing.parserIntent),
      expectedParserFingerprint: processing.fingerprints.parserFingerprint,
      expectedExtractionConfigurationFingerprint:
        processing.fingerprints.extractionConfigurationFingerprint,
      expectedModelManifestSha256: this.preparedPdfProfile.modelManifestSha256,
    };
  }

  private async driveArchivedParse(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "parse") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const { original, processing: current } = this.archivedRows(checkpoint);
    const pdf = this.requirePdfConfig();
    let processing = current;
    if (processing.parserOutput) {
      await inspectCapturedPdfParserOutput(
        this.parserRecovery(original, processing),
      );
    } else {
      const intent = await inspectParserOutputIntent({
        outputRoot: pdf.parserOutputRoot,
        outputId: processing.parserIntent.outputId,
        requireEmpty: false,
      });
      if (!equalJson(intent, parserOutputIntentCore(processing.parserIntent))) {
        throw new PipelineWorkerError("parser_output_intent_conflict");
      }
      const outputDirectory = join(
        pdf.parserOutputRoot,
        processing.parserIntent.outputId,
      );
      const outputPresence = await Promise.all(
        ["lossless.json", "bundle.json"].map((name) =>
          lstat(join(outputDirectory, name))
            .then(() => true)
            .catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return false;
              throw error;
            }),
        ),
      );
      if (outputPresence[0] !== outputPresence[1]) {
        throw new PipelineWorkerError("parser_output_incomplete");
      }
      if (!outputPresence[0]) {
        // A run interrupted after the work directory was reserved but
        // before the parser wrote its evidence leaves only empty
        // `.home-<id>` / `.tmp-<id>` scaffolding behind. The work ID is
        // deterministic, so a resumed run re-targets that same directory;
        // clear the leftover scaffolding so `runCapturedPdfParser`'s
        // require-empty precondition holds. Evidence, and anything that
        // isn't empty known scaffolding, is left alone and still surfaces
        // as `destination_exists`.
        await reclaimStaleParserOutputDirectory({
          outputRoot: pdf.parserOutputRoot,
          outputIntent: intent,
        });
      }
      const output = outputPresence[0]
        ? await inspectCapturedPdfParserOutput(
            this.parserRecovery(original, processing),
          )
        : await runCapturedPdfParser({
            capture: captureFromRows(pdf, original, processing),
            outputDirectory,
            outputId: processing.parserIntent.outputId,
            ...pdf.parser,
          });
      processing = await this.requireCatalog().recordParserOutput({
        catalogId: processing.processingCatalogId,
        expectedRevision: processing.rowRevision,
        output: parserOutputCatalogRecord(output.artifacts),
      });
    }
    await this.journal.transitionCheckpoint({
      checkpoint: archivedBase(checkpoint, {
        step: "spool",
        expectedProcessingRevision: processing.rowRevision,
      }),
      credentialSessionActive: true,
    });
  }

  private async driveArchivedSpool(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "spool") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const { original, processing: current } = this.archivedRows(checkpoint);
    const pdf = this.requirePdfConfig();
    let processing = current;
    if (processing.spool) {
      await inspectNormalizedBundleSpool({
        spoolRoot: pdf.spoolDirectory,
        expectedRoot: processing.spoolIntent.root,
        spool: processing.spool,
        parserRecovery: this.parserRecovery(original, processing),
      });
    } else {
      if (!processing.parserOutput) {
        throw new PipelineWorkerError("parser_output_missing");
      }
      if (!processing.spoolPrepared) {
        const parserOutput = await inspectCapturedPdfParserOutput(
          this.parserRecovery(original, processing),
        );
        const prepared = await prepareNormalizedBundleSpool({
          spoolRoot: pdf.spoolDirectory,
          expectedRoot: processing.spoolIntent.root,
          spoolId: processing.spoolIntent.spoolId,
          parserOutput,
        });
        processing = await this.requireCatalog().recordSpoolPrepared({
          catalogId: processing.processingCatalogId,
          expectedRevision: processing.rowRevision,
          prepared,
        });
        await this.journal.transitionCheckpoint({
          checkpoint: archivedBase(checkpoint, {
            expectedProcessingRevision: processing.rowRevision,
          }),
          credentialSessionActive: true,
        });
        return;
      }
      const spool = await recoverNormalizedBundleSpool({
        spoolRoot: pdf.spoolDirectory,
        expectedRoot: processing.spoolIntent.root,
        spoolId: processing.spoolIntent.spoolId,
        prepared: processing.spoolPrepared,
      });
      processing = await this.requireCatalog().recordSpool({
        catalogId: processing.processingCatalogId,
        expectedRevision: processing.rowRevision,
        spool,
      });
    }
    await this.journal.transitionCheckpoint({
      checkpoint: archivedBase(checkpoint, {
        step: "lookup_processing",
        expectedProcessingRevision: processing.rowRevision,
      }),
      credentialSessionActive: true,
    });
  }

  private async mappedProcessing(checkpoint: ArchivedCheckpoint) {
    const { original, processing } = this.archivedRows(checkpoint);
    if (!processing.spool) throw new PipelineWorkerError("spool_missing");
    const pdf = this.requirePdfConfig();
    const validated = await inspectNormalizedBundleSpool({
      spoolRoot: pdf.spoolDirectory,
      expectedRoot: processing.spoolIntent.root,
      spool: processing.spool,
      parserRecovery: this.parserRecovery(original, processing),
    });
    const plan = this.archivedPlan(checkpoint);
    const mapping = await mapParsedBundle({
      ...validated,
      title: basename(plan.relativePath),
      capturedAt: plan.sourceModifiedAt,
      chunkingFingerprint: plan.chunkerFingerprint,
    });
    if (mapping.chunkingFingerprint !== plan.chunkerFingerprint) {
      throw new PipelineWorkerError("parsed_chunking_conflict");
    }
    return {
      original,
      processing,
      mapping,
      declaration: parsedTextDeclaration({ processing, mapping }),
    };
  }

  private async driveArchivedLookupProcessing(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (
      checkpoint.phase !== "archived" ||
      checkpoint.step !== "lookup_processing"
    ) {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const mapped = await this.mappedProcessing(checkpoint);
    const identity = archivedIdentity(
      checkpoint,
      this.archivedPlan(checkpoint),
    );
    const output = mapped.processing.parserOutput!;
    const result = await this.mutation(
      "discovery.lookupArchivedAdmission",
      () =>
        request(this.config, "discovery.lookupArchivedAdmission", {
          requestId: randomUUID(),
          identity,
          lookup: {
            mode: "processing",
            clientArtifactId:
              mapped.processing.parserIntent.parserArtifactClientId,
            parserOutputHash: output.rawArtifact.sha256,
            parserOutputByteLength: output.rawArtifact.byteLength,
            parserOutputMediaType: "application/vnd.docling+json",
            parsedText: mapped.declaration,
          },
        }),
      async (current, response, pending) => {
        if (
          current.phase !== "archived" ||
          current.step !== "lookup_processing"
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "discovery.lookupArchivedAdmission");
        if (value.mode !== "processing") {
          throw new PipelineWorkerError("archived_lookup_mode_conflict");
        }
        if (value.found !== true) {
          return archivedBase(current, { step: "parser_archive" });
        }
        if (value.desiredProcessingEpoch !== identity.processingEpoch) {
          throw new PipelineWorkerError("archived_lookup_parent_conflict");
        }
        let { original, processing } = this.archivedRows(current);
        const provider = original.providerOriginal !== undefined;
        const responseProvider = "originalProviderReferenceId" in value;
        if (provider !== responseProvider)
          throw new PipelineWorkerError("archived_recovery_branch_conflict");
        const receipts = [
          ["original_bytes", original, "primary", "originalPrimaryReceiptId"],
          ...(provider
            ? []
            : [
                [
                  "original_bytes",
                  original,
                  "independent_backup",
                  "originalBackupReceiptId",
                ] as const,
              ]),
          ["parser_output", processing, "primary", "parserPrimaryReceiptId"],
          [
            "parser_output",
            processing,
            "independent_backup",
            "parserBackupReceiptId",
          ],
        ] as const;
        for (const [subject, row, role, field] of receipts) {
          const live = subject === "original_bytes" ? original : processing;
          if (!live.copies[role].published) {
            throw new PipelineWorkerError("archived_receipt_parent_missing");
          }
          if (!live.copies[role].cloudReceipt) {
            const updated = await this.requireCatalog().recordCloudReceipt({
              subject,
              catalogId:
                subject === "original_bytes"
                  ? original.originalCatalogId
                  : processing.processingCatalogId,
              expectedRevision: live.rowRevision,
              role,
              receiptId: text(value[field], "archive_receipt_id"),
              requestDigest: pending.requestDigest,
              recordedAt: pending.receivedAt,
            });
            if (subject === "original_bytes") {
              original = updated as OriginalCatalogRow;
            } else {
              processing = updated as ProcessingCatalogRow;
            }
          }
          void row;
        }
        if (!original.cloud) {
          original = await this.requireCatalog().recordOriginalCloud({
            catalogId: original.originalCatalogId,
            expectedRevision: original.rowRevision,
            cloud: {
              sourceItemId: identity.sourceItemId,
              sourceRevisionId: text(
                value.sourceRevisionId,
                "source_revision_id",
              ),
              primaryReceiptId: original.copies.primary.cloudReceipt!.receiptId,
              ...(provider
                ? {
                    providerReferenceId: text(
                      value.originalProviderReferenceId,
                      "original_provider_reference_id",
                    ),
                    providerBindingEpoch: integer(
                      value.originalProviderBindingEpoch,
                      "original_provider_binding_epoch",
                    ),
                  }
                : {
                    backupReceiptId:
                      original.copies.independent_backup.cloudReceipt!
                        .receiptId,
                  }),
              admittedAt: pending.receivedAt,
            },
          });
        }
        if (!processing.cloud) {
          processing = await this.requireCatalog().recordProcessingCloud({
            catalogId: processing.processingCatalogId,
            expectedRevision: processing.rowRevision,
            cloud: {
              sourceItemId: identity.sourceItemId,
              sourceRevisionId: text(
                value.sourceRevisionId,
                "source_revision_id",
              ),
              parserArtifactId: text(
                value.parserArtifactId,
                "parser_artifact_id",
              ),
              sourceTextVersionId: text(
                value.sourceTextVersionId,
                "source_text_version_id",
              ),
              processingGenerationId: text(
                value.processingGenerationId,
                "processing_generation_id",
              ),
              ingestJobId: text(value.ingestJobId, "ingest_job_id"),
              processingFingerprint: output.extractionFingerprint,
              admissionRequestDigest: pending.requestDigest,
              admittedAt: pending.receivedAt,
            },
          });
        }
        return archivedBase(current, {
          step: processing.activation ? "cleanup" : "parsed_reserve",
          expectedOriginalRevision: original.rowRevision,
          expectedProcessingRevision: processing.rowRevision,
          reservationRound: 0,
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "lookup_processing"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private async driveArchivedReserve(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "reserve") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const identity = archivedIdentity(
      checkpoint,
      this.archivedPlan(checkpoint),
    );
    const result = await this.mutation(
      "discovery.reserveArchived",
      () =>
        request(this.config, "discovery.reserveArchived", {
          requestId: randomUUID(),
          identity,
        }),
      (current, response) => {
        if (current.phase !== "archived" || current.step !== "reserve") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "discovery.reserveArchived");
        if (
          value.sourceItemId !== identity.sourceItemId ||
          value.observationEpoch !== identity.observationEpoch ||
          value.processingEpoch !== identity.processingEpoch
        ) {
          throw new PipelineWorkerError("archived_reserve_parent_conflict");
        }
        return archivedBase(current, {
          step: "admit",
          discoveryLease: {
            workId: text(value.workId, "work_id"),
            sourceItemId: text(value.sourceItemId, "source_item_id"),
            observationEpoch: integer(
              value.observationEpoch,
              "observation_epoch",
            ),
            processingEpoch: integer(value.processingEpoch, "processing_epoch"),
            leaseEpoch: integer(value.leaseEpoch, "lease_epoch"),
            leaseToken: text(value.leaseToken, "lease_token"),
            leaseExpiresAt: integer(value.leaseExpiresAt, "lease_expires_at"),
          },
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "reserve"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private async driveArchivedAdmit(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "admit") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const lease = checkpoint.discoveryLease;
    if (!lease) throw new PipelineWorkerError("archived_lease_missing");
    if (
      !this.journal.pending &&
      lease.leaseExpiresAt <= Date.now() + LEASE_SAFETY_MARGIN_MS
    ) {
      await this.journal.transitionCheckpoint({
        checkpoint: archivedBase(checkpoint, {
          step: "reserve",
          discoveryLease: undefined,
        }),
        credentialSessionActive: true,
      });
      return;
    }
    const mapped = await this.mappedProcessing(checkpoint);
    const providerOriginal = mapped.original.providerOriginal
      ? this.providerDeclaration(
          mapped.original,
          this.journal.pending === undefined,
        )
      : undefined;
    const archives = [
      createArchiveReceiptSelection(
        "original_bytes",
        mapped.original,
        "primary",
      ),
      ...(providerOriginal === undefined
        ? [
            createArchiveReceiptSelection(
              "original_bytes",
              mapped.original,
              "independent_backup",
            ),
          ]
        : []),
      createArchiveReceiptSelection(
        "parser_output",
        mapped.processing,
        "primary",
      ),
      createArchiveReceiptSelection(
        "parser_output",
        mapped.processing,
        "independent_backup",
      ),
    ];
    const parserArtifact = createParserArtifactSelection(mapped.processing);
    const result = await this.mutation(
      "discovery.admitArchived",
      () =>
        request(this.config, "discovery.admitArchived", {
          requestId: randomUUID(),
          workId: lease.workId,
          leaseEpoch: lease.leaseEpoch,
          leaseToken: lease.leaseToken,
          parserArtifact,
          archives,
          ...(providerOriginal === undefined ? {} : { providerOriginal }),
          parsedText: mapped.declaration,
        }),
      async (current, response, pending) => {
        if (current.phase !== "archived" || current.step !== "admit") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code === "lease_conflict" || code === "reservation_expired") {
          return archivedBase(current, {
            step: "reserve",
            discoveryLease: undefined,
          });
        }
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "discovery.admitArchived");
        if (
          value.workId !== lease.workId ||
          value.sourceItemId !== lease.sourceItemId ||
          value.desiredProcessingEpoch !== lease.processingEpoch ||
          value.state !== "admitted"
        ) {
          throw new PipelineWorkerError("archived_admit_parent_conflict");
        }
        let { original, processing } = this.archivedRows(current);
        const responseProvider = "originalProviderReferenceId" in value;
        if ((providerOriginal !== undefined) !== responseProvider)
          throw new PipelineWorkerError("archived_recovery_branch_conflict");
        for (const [subject, role, receiptField] of [
          ["original_bytes", "primary", "originalPrimaryReceiptId"],
          ...(providerOriginal === undefined
            ? [
                [
                  "original_bytes",
                  "independent_backup",
                  "originalBackupReceiptId",
                ] as const,
              ]
            : []),
          ["parser_output", "primary", "parserPrimaryReceiptId"],
          ["parser_output", "independent_backup", "parserBackupReceiptId"],
        ] as const) {
          const live = subject === "original_bytes" ? original : processing;
          if (!live.copies[role].cloudReceipt) {
            const updated = await this.requireCatalog().recordCloudReceipt({
              subject,
              catalogId:
                subject === "original_bytes"
                  ? original.originalCatalogId
                  : processing.processingCatalogId,
              expectedRevision: live.rowRevision,
              role,
              receiptId: text(value[receiptField], receiptField),
              requestDigest: pending.requestDigest,
              recordedAt: pending.receivedAt,
            });
            if (subject === "original_bytes")
              original = updated as OriginalCatalogRow;
            else processing = updated as ProcessingCatalogRow;
          }
        }
        if (!original.cloud) {
          original = await this.requireCatalog().recordOriginalCloud({
            catalogId: original.originalCatalogId,
            expectedRevision: original.rowRevision,
            cloud: {
              sourceItemId: lease.sourceItemId,
              sourceRevisionId: text(
                value.sourceRevisionId,
                "source_revision_id",
              ),
              primaryReceiptId: original.copies.primary.cloudReceipt!.receiptId,
              ...(providerOriginal === undefined
                ? {
                    backupReceiptId:
                      original.copies.independent_backup.cloudReceipt!
                        .receiptId,
                  }
                : {
                    providerReferenceId: text(
                      value.originalProviderReferenceId,
                      "original_provider_reference_id",
                    ),
                    providerBindingEpoch: integer(
                      value.originalProviderBindingEpoch,
                      "original_provider_binding_epoch",
                    ),
                  }),
              admittedAt: pending.receivedAt,
            },
          });
        }
        if (!processing.cloud) {
          processing = await this.requireCatalog().recordProcessingCloud({
            catalogId: processing.processingCatalogId,
            expectedRevision: processing.rowRevision,
            cloud: {
              sourceItemId: lease.sourceItemId,
              sourceRevisionId: text(
                value.sourceRevisionId,
                "source_revision_id",
              ),
              parserArtifactId: text(
                value.parserArtifactId,
                "parser_artifact_id",
              ),
              sourceTextVersionId: text(
                value.sourceTextVersionId,
                "source_text_version_id",
              ),
              processingGenerationId: text(
                value.processingGenerationId,
                "processing_generation_id",
              ),
              ingestJobId: text(value.ingestJobId, "ingest_job_id"),
              processingFingerprint:
                mapped.processing.parserOutput!.extractionFingerprint,
              admissionRequestDigest: pending.requestDigest,
              admittedAt: pending.receivedAt,
            },
          });
        }
        return archivedBase(current, {
          step: "parsed_reserve",
          expectedOriginalRevision: original.rowRevision,
          expectedProcessingRevision: processing.rowRevision,
          discoveryLease: undefined,
          reservationRound: 0,
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "admit"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private async driveParsedReserve(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (
      checkpoint.phase !== "archived" ||
      checkpoint.step !== "parsed_reserve"
    ) {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const { processing } = this.archivedRows(checkpoint);
    if (!processing.cloud) throw new PipelineWorkerError("admission_missing");
    const cloud = processing.cloud;
    const result = await this.mutation(
      "jobs.reserveParsed",
      () =>
        request(this.config, "jobs.reserveParsed", {
          requestId: randomUUID(),
          maxItems: 1,
          jobId: cloud.ingestJobId,
        }),
      (current, response) => {
        if (current.phase !== "archived" || current.step !== "parsed_reserve") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "jobs.reserveParsed");
        const targets = records(
          value.targets,
          "parsed_targets",
        ) as unknown as JobLease[];
        const target = targets[0];
        if (!target) {
          if (current.reservationRound >= MAX_ARCHIVED_RESERVATION_ROUNDS) {
            throw new PipelineWorkerError("parsed_job_missing");
          }
          return archivedBase(current, {
            reservationRound: current.reservationRound + 1,
          });
        }
        if (
          targets.length !== 1 ||
          target.jobId !== cloud.ingestJobId ||
          target.sourceItemId !== cloud.sourceItemId ||
          target.observationEpoch !==
            processing.currentObservation.observationEpoch ||
          target.processingEpoch !==
            processing.currentObservation.processingEpoch
        ) {
          throw new PipelineWorkerError("parsed_job_parent_conflict");
        }
        return archivedBase(current, {
          step: "parsed_begin",
          jobLease: target,
          reservationRound: 0,
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "parsed_reserve"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
    if (
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "parsed_reserve"
    ) {
      throw new PipelineRetryableError("parsed_job_deferred");
    }
  }

  private parsedLeaseRecovery(
    checkpoint: ArchivedCheckpoint,
  ): ArchivedCheckpoint {
    return archivedBase(checkpoint, {
      step: "parsed_reserve",
      reservationRound: 0,
      jobLease: undefined,
      resumeStep: undefined,
      stageId: undefined,
      stagePhase: undefined,
      stageOrdinal: undefined,
    });
  }

  private async requireFreshParsedLease(
    checkpoint: ArchivedCheckpoint,
    resumeStep:
      "parsed_begin" | "parsed_batch" | "parsed_seal" | "parsed_activate",
  ): Promise<boolean> {
    const lease = checkpoint.jobLease;
    if (!lease) throw new PipelineWorkerError("parsed_lease_missing");
    if (
      !this.journal.pending &&
      lease.leaseExpiresAt <= Date.now() + LEASE_SAFETY_MARGIN_MS
    ) {
      await this.journal.transitionCheckpoint({
        checkpoint: archivedBase(checkpoint, {
          step: "parsed_renew",
          resumeStep,
        }),
        credentialSessionActive: true,
      });
      return false;
    }
    return true;
  }

  private async driveParsedRenew(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (
      checkpoint.phase !== "archived" ||
      checkpoint.step !== "parsed_renew" ||
      !checkpoint.jobLease ||
      !checkpoint.resumeStep
    ) {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const lease = checkpoint.jobLease;
    const result = await this.mutation(
      "jobs.renewParsed",
      () =>
        request(this.config, "jobs.renewParsed", {
          requestId: randomUUID(),
          jobId: lease.jobId,
          leaseEpoch: lease.leaseEpoch,
          leaseToken: lease.leaseToken,
        }),
      (current, response) => {
        if (
          current.phase !== "archived" ||
          current.step !== "parsed_renew" ||
          !current.jobLease ||
          !current.resumeStep
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code === "lease_conflict" || code === "reservation_expired") {
          return this.parsedLeaseRecovery(current);
        }
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "jobs.renewParsed");
        if (value.jobId !== current.jobLease.jobId) {
          throw new PipelineWorkerError("parsed_renew_parent_conflict");
        }
        return archivedBase(current, {
          step: current.resumeStep,
          jobLease: {
            ...current.jobLease,
            state: value.state as "processing" | "staged",
            leaseExpiresAt: integer(value.leaseExpiresAt, "lease_expires_at"),
          },
          resumeStep: undefined,
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "parsed_renew"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private async driveParsedBegin(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "parsed_begin") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    if (!(await this.requireFreshParsedLease(checkpoint, "parsed_begin")))
      return;
    const lease = checkpoint.jobLease!;
    const mapped = await this.mappedProcessing(checkpoint);
    const declaration = mapped.declaration;
    const result = await this.mutation(
      "jobs.stageParsedBegin",
      () =>
        request(this.config, "jobs.stageParsedBegin", {
          requestId: randomUUID(),
          jobId: lease.jobId,
          leaseEpoch: lease.leaseEpoch,
          leaseToken: lease.leaseToken,
          extractionFingerprint: declaration.extractionFingerprint,
          mappingManifestHash: declaration.mappingManifestHash,
          normalizedBundleDigest: declaration.normalizedBundleDigest,
          expectedPageCount: declaration.pageCount,
          expectedEvidenceSpanCount: declaration.expectedEvidenceSpanCount,
          expectedDocumentCount: declaration.expectedDocumentCount,
          expectedChunkCount: declaration.expectedChunkCount,
        }),
      (current, response) => {
        if (current.phase !== "archived" || current.step !== "parsed_begin") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code === "lease_conflict" || code === "reservation_expired") {
          return this.parsedLeaseRecovery(current);
        }
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "jobs.stageParsedBegin");
        if (value.jobId !== lease.jobId) {
          throw new PipelineWorkerError("parsed_stage_parent_conflict");
        }
        const phase = value.phase as ParsedStagePhase;
        return archivedBase(current, {
          step:
            phase === "staged"
              ? "parsed_activate"
              : phase === "seal"
                ? "parsed_seal"
                : "parsed_batch",
          stageId: text(value.stageId, "stage_id"),
          stagePhase: phase,
          stageOrdinal: integer(value.nextOrdinal, "stage_ordinal"),
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "parsed_begin"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private parsedRows(
    mapping: Awaited<ReturnType<PipelineRunner["mappedProcessing"]>>["mapping"],
    phase: "pages" | "evidence" | "documents" | "chunks",
  ) {
    return phase === "pages"
      ? mapping.pages
      : phase === "evidence"
        ? mapping.evidence
        : phase === "documents"
          ? mapping.documents
          : mapping.chunks;
  }

  private parsedBatchBody(
    checkpoint: ArchivedCheckpoint,
    mapping: Awaited<ReturnType<PipelineRunner["mappedProcessing"]>>["mapping"],
    requestId: string,
  ) {
    const lease = checkpoint.jobLease!;
    const phase = checkpoint.stagePhase;
    const ordinal = checkpoint.stageOrdinal;
    if (
      !checkpoint.stageId ||
      ordinal === undefined ||
      (phase !== "pages" &&
        phase !== "evidence" &&
        phase !== "documents" &&
        phase !== "chunks")
    ) {
      throw new PipelineWorkerError("parsed_stage_state_invalid");
    }
    const allRows = this.parsedRows(mapping, phase);
    const maximum =
      phase === "pages" ? MAX_PARSED_PAGE_BATCH : MAX_PARSED_ROW_BATCH;
    let rows = allRows.slice(ordinal, ordinal + maximum);
    while (rows.length) {
      const body = request(this.config, "jobs.stageParsedBatch", {
        requestId,
        jobId: lease.jobId,
        leaseEpoch: lease.leaseEpoch,
        leaseToken: lease.leaseToken,
        stageId: checkpoint.stageId,
        phase,
        ordinal,
        rows,
      });
      if (
        Buffer.byteLength(JSON.stringify(body), "utf8") <=
        MAX_PARSED_REQUEST_BYTES
      ) {
        assertParsedRequestSize(body);
        return body;
      }
      rows = rows.slice(0, -1);
    }
    throw new PipelineWorkerError("parsed_batch_too_large");
  }

  private async driveParsedBatch(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "parsed_batch") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    if (!(await this.requireFreshParsedLease(checkpoint, "parsed_batch")))
      return;
    const mapped = await this.mappedProcessing(checkpoint);
    const plannedRequestId = this.journal.pending?.requestId ?? randomUUID();
    const body = this.parsedBatchBody(
      checkpoint,
      mapped.mapping,
      plannedRequestId,
    );
    const submittedRows = body.rows as unknown[];
    const submittedPhase = body.phase;
    const result = await this.mutation(
      "jobs.stageParsedBatch",
      () => body,
      (current, response) => {
        if (current.phase !== "archived" || current.step !== "parsed_batch") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code === "lease_conflict" || code === "reservation_expired") {
          return this.parsedLeaseRecovery(current);
        }
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "jobs.stageParsedBatch");
        if (
          value.jobId !== current.jobLease?.jobId ||
          value.stageId !== current.stageId ||
          value.committedPhase !== submittedPhase ||
          value.acceptedCount !== submittedRows.length
        ) {
          throw new PipelineWorkerError("parsed_batch_parent_conflict");
        }
        const phase = value.phase as ParsedStagePhase;
        return archivedBase(current, {
          step: phase === "seal" ? "parsed_seal" : "parsed_batch",
          stagePhase: phase,
          stageOrdinal: integer(value.nextOrdinal, "stage_ordinal"),
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "parsed_batch"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private async driveParsedSeal(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "parsed_seal") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    if (!(await this.requireFreshParsedLease(checkpoint, "parsed_seal")))
      return;
    const mapped = await this.mappedProcessing(checkpoint);
    const lease = checkpoint.jobLease!;
    const result = await this.mutation(
      "jobs.stageParsedSeal",
      () =>
        request(this.config, "jobs.stageParsedSeal", {
          requestId: randomUUID(),
          jobId: lease.jobId,
          leaseEpoch: lease.leaseEpoch,
          leaseToken: lease.leaseToken,
          stageId: checkpoint.stageId,
          normalizedBundleDigest: mapped.declaration.normalizedBundleDigest,
        }),
      (current, response) => {
        if (current.phase !== "archived" || current.step !== "parsed_seal") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code === "lease_conflict" || code === "reservation_expired") {
          return this.parsedLeaseRecovery(current);
        }
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "jobs.stageParsedSeal");
        if (
          value.jobId !== lease.jobId ||
          value.stageId !== current.stageId ||
          value.state !== "staged" ||
          value.actualPageCount !== mapped.declaration.pageCount ||
          value.actualEvidenceSpanCount !==
            mapped.declaration.expectedEvidenceSpanCount ||
          value.actualDocumentCount !==
            mapped.declaration.expectedDocumentCount ||
          value.actualChunkCount !== mapped.declaration.expectedChunkCount
        ) {
          throw new PipelineWorkerError("parsed_seal_parent_conflict");
        }
        return archivedBase(current, {
          step: "parsed_activate",
          stagePhase: "staged",
          stageOrdinal: 0,
          jobLease: { ...lease, state: "staged" },
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "parsed_seal"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private async driveParsedActivate(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (
      checkpoint.phase !== "archived" ||
      checkpoint.step !== "parsed_activate"
    ) {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    if (!(await this.requireFreshParsedLease(checkpoint, "parsed_activate")))
      return;
    const lease = checkpoint.jobLease!;
    const result = await this.mutation(
      "jobs.activateParsed",
      () =>
        request(this.config, "jobs.activateParsed", {
          requestId: randomUUID(),
          jobId: lease.jobId,
          leaseEpoch: lease.leaseEpoch,
          leaseToken: lease.leaseToken,
        }),
      async (current, response, pending) => {
        if (
          current.phase !== "archived" ||
          current.step !== "parsed_activate"
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code === "lease_conflict" || code === "reservation_expired") {
          return this.parsedLeaseRecovery(current);
        }
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "jobs.activateParsed");
        const { processing } = this.archivedRows(current);
        if (
          !processing.cloud ||
          value.jobId !== processing.cloud.ingestJobId ||
          value.state !== "ready"
        ) {
          throw new PipelineWorkerError("parsed_activation_parent_conflict");
        }
        const updated = await this.requireCatalog().recordActivation({
          catalogId: processing.processingCatalogId,
          expectedRevision: processing.rowRevision,
          activation: {
            requestId: pending.requestId,
            requestDigest: pending.requestDigest,
            jobId: processing.cloud.ingestJobId,
            processingGenerationId: processing.cloud.processingGenerationId,
            state: "ready",
            activatedAt: integer(value.activatedAt, "activated_at"),
            reused: value.reused === true,
            ...(value.previousGenerationId === undefined
              ? {}
              : {
                  previousGenerationId: text(
                    value.previousGenerationId,
                    "previous_generation_id",
                  ),
                }),
          },
        });
        return archivedBase(current, {
          step: "cleanup",
          expectedProcessingRevision: updated.rowRevision,
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "parsed_activate"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private async driveArchivedCleanup(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "cleanup") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const { original, processing } = this.archivedRows(checkpoint);
    this.requireCatalog().requireProcessingActivation(
      processing.processingCatalogId,
    );
    const pdf = this.requirePdfConfig();
    if (!processing.spool || !processing.parserOutput || !processing.capture) {
      throw new PipelineWorkerError("cleanup_parent_missing");
    }
    await removeNormalizedBundleSpoolExact({
      spoolRoot: pdf.spoolDirectory,
      expectedRoot: processing.spoolIntent.root,
      spool: processing.spool,
    });
    await removeParserOutputExact({
      outputRoot: pdf.parserOutputRoot,
      outputIntent: parserOutputIntentCore(processing.parserIntent),
      artifacts: {
        ...processing.parserOutput,
        rawArtifact: {
          ...processing.parserOutput.rawArtifact,
          path: join(
            pdf.parserOutputRoot,
            processing.parserIntent.outputId,
            processing.parserOutput.rawArtifact.opaqueName,
          ),
        },
        normalizedBundle: {
          ...processing.parserOutput.normalizedBundle,
          path: join(
            pdf.parserOutputRoot,
            processing.parserIntent.outputId,
            processing.parserOutput.normalizedBundle.opaqueName,
          ),
        },
      },
    });
    await removeCapturedPdfExact(captureFromRows(pdf, original, processing));
    const nextPdf = await this.nextPdfWorkIndex(
      checkpoint.files,
      checkpoint.pdfIndex + 1,
    );
    const publicationIncrement = checkpoint.countPublication === false ? 0 : 1;
    if (nextPdf >= 0) {
      await this.journal.transitionCheckpoint({
        checkpoint: {
          version: 1,
          phase: "archived",
          ...activeScanBase(checkpoint),
          pdfIndex: nextPdf,
          step: "intent",
          reservationRound: 0,
          archivedPublished:
            checkpoint.archivedPublished + publicationIncrement,
        },
        credentialSessionActive: true,
      });
      return;
    }
    await this.journal.transitionCheckpoint({
      checkpoint: {
        version: 1,
        phase: "discovery_reserve",
        ...activeScanBase(checkpoint),
        round: 0,
        archivedPublished: checkpoint.archivedPublished + publicationIncrement,
      },
      credentialSessionActive: true,
    });
  }

  /**
   * A document-level parser failure (see `DOCUMENT_PARSER_FAILURE_CODES`)
   * raised while parsing this PDF: unlike an infrastructure failure, it does
   * not end the run. Records a bounded attempt against the local processing
   * catalog row (`ArchiveCatalog.recordParseFailure`) and moves on to the
   * next PDF exactly as `driveArchivedCleanup` does after a successful one,
   * except nothing was published, so `archivedPublished` is unchanged.
   */
  private async recordArchivedParseFailure(
    checkpoint: ArchivedCheckpoint,
    code: string,
  ): Promise<void> {
    if (checkpoint.phase !== "archived" || checkpoint.step !== "parse") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const { processing } = this.archivedRows(checkpoint);
    await this.requireCatalog().recordParseFailure({
      catalogId: processing.processingCatalogId,
      expectedRevision: processing.rowRevision,
      code,
      now: Date.now(),
    });
    await this.submitArchivedParseFailure(checkpoint, code);
    const nextPdf = await this.nextPdfWorkIndex(
      checkpoint.files,
      checkpoint.pdfIndex + 1,
    );
    if (nextPdf >= 0) {
      await this.journal.transitionCheckpoint({
        checkpoint: {
          version: 1,
          phase: "archived",
          ...activeScanBase(checkpoint),
          pdfIndex: nextPdf,
          step: "intent",
          reservationRound: 0,
          archivedPublished: checkpoint.archivedPublished,
        },
        credentialSessionActive: true,
      });
      return;
    }
    await this.journal.transitionCheckpoint({
      checkpoint: {
        version: 1,
        phase: "discovery_reserve",
        ...activeScanBase(checkpoint),
        round: 0,
        archivedPublished: checkpoint.archivedPublished,
      },
      credentialSessionActive: true,
    });
  }

  /**
   * Reports a document-level parse failure to the server so the file's
   * `sourceInventory` row is marked `parse_failed` with the failure class
   * (`discovery.failArchived`, the archived-flow counterpart of the
   * `jobs.fail` / `jobs.failParsed` path `failJob` already wires this for:
   * there is no ingestJobs row yet at this point, since admission happens
   * after a successful parse).
   *
   * ponytail: best-effort, not a correctness path. This does not go through
   * `this.mutation()`'s pending/replay durability, so a crash or transport
   * failure here can lose the report (or, rarely, double it on a later
   * retry) without affecting the run: the bounded local attempt count in
   * the archive catalog is what actually stops the pass from retrying this
   * document forever, and a lost report just leaves the inventory stale
   * until a later scan or a successful parse corrects it. Upgrade to a
   * durable replayed call if silent loss becomes a real problem.
   */
  private async submitArchivedParseFailure(
    checkpoint: ArchivedCheckpoint,
    code: string,
  ): Promise<void> {
    const identity = archivedIdentity(
      checkpoint,
      this.archivedPlan(checkpoint),
    );
    try {
      await this.transport.call({
        protocolVersion: 1,
        operation: "discovery.failArchived",
        spaceId: this.config.spaceId,
        sourceAccountId: this.config.sourceAccountId,
        requestId: randomUUID(),
        identity,
        failureCode: code,
      });
    } catch {
      // Swallowed: see the ponytail note above.
    }
  }

  private async driveJobsReserve(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "jobs_reserve") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const result = await this.mutation(
      "jobs.reserve",
      () =>
        request(this.config, "jobs.reserve", {
          requestId: randomUUID(),
          maxItems: 4,
        }),
      (current, response) => {
        if (current.phase !== "jobs_reserve") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return processingTerminal(current, "failed", code, undefined, true);
        }
        const jobs = records(
          value.targets,
          "job_targets",
        ) as unknown as JobLease[];
        if (jobs.length === 0) {
          return {
            version: 1,
            phase: "assess_status",
            ...processingBase(current),
          };
        }
        if (current.round >= MAX_RESERVATION_ROUNDS) {
          return processingTerminal(
            current,
            "incomplete",
            "job_capacity_exceeded",
            undefined,
            true,
          );
        }
        return {
          version: 1,
          phase: "jobs_renew",
          ...processingBase(current),
          round: current.round,
          jobs,
          index: 0,
        };
      },
    );
    if (errorCode(result)) throw new PipelineWorkerError(errorCode(result)!);
  }

  private async driveJobsRenew(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "jobs_renew") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const job = checkpoint.jobs[checkpoint.index];
    if (!job) throw new PipelineWorkerError("job_checkpoint_invalid");
    const result = await this.mutation(
      "jobs.renew",
      () =>
        request(this.config, "jobs.renew", {
          requestId: randomUUID(),
          jobId: job.jobId,
          leaseEpoch: job.leaseEpoch,
          leaseToken: job.leaseToken,
        }),
      (current, response) => {
        if (current.phase !== "jobs_renew") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const active = current.jobs[current.index];
        if (!active) throw new PipelineWorkerError("job_checkpoint_invalid");
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return code === "lease_conflict" || code === "reservation_expired"
            ? afterJob(current, current.published)
            : processingTerminal(current, "failed", code, undefined, true);
        }
        if (value.jobId !== active.jobId) {
          throw new PipelineWorkerError("job_parent_conflict");
        }
        const state =
          value.state === "staged"
            ? ("staged" as const)
            : ("processing" as const);
        const jobs = current.jobs.map((row, index) =>
          index === current.index
            ? {
                ...row,
                state,
                leaseExpiresAt: integer(
                  value.leaseExpiresAt,
                  "lease_expires_at",
                ),
              }
            : row,
        );
        return {
          ...current,
          phase: state === "staged" ? "jobs_activate" : "jobs_stage",
          jobs,
        };
      },
    );
    const code = errorCode(result);
    if (code && this.journal.checkpoint.phase === "jobs_renew") {
      throw new PipelineWorkerError(code);
    }
  }

  private async driveJobsStage(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "jobs_stage") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const job = checkpoint.jobs[checkpoint.index];
    if (!job) throw new PipelineWorkerError("job_checkpoint_invalid");
    if (
      !this.journal.pending &&
      job.leaseExpiresAt <= Date.now() + LEASE_SAFETY_MARGIN_MS
    ) {
      await this.journal.transitionCheckpoint({
        checkpoint: { ...checkpoint, phase: "jobs_renew" },
        credentialSessionActive: true,
      });
      return;
    }
    const result = await this.mutation(
      "jobs.stageUtf8",
      () =>
        request(this.config, "jobs.stageUtf8", {
          requestId: randomUUID(),
          jobId: job.jobId,
          leaseEpoch: job.leaseEpoch,
          leaseToken: job.leaseToken,
        }),
      (current, response) => {
        if (current.phase !== "jobs_stage") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const active = current.jobs[current.index];
        if (!active) throw new PipelineWorkerError("job_checkpoint_invalid");
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          if (code === "lease_conflict" || code === "reservation_expired") {
            return afterJob(current, current.published);
          }
          if (code === "scan_conflict") {
            return {
              ...current,
              phase: "jobs_fail",
              failureCode: "staging_invalid",
            };
          }
          return processingTerminal(current, "failed", code, undefined, true);
        }
        if (value.jobId !== active.jobId || value.state !== "staged") {
          throw new PipelineWorkerError("job_stage_conflict");
        }
        const jobs = current.jobs.map((row, index) =>
          index === current.index ? { ...row, state: "staged" as const } : row,
        );
        return { ...current, phase: "jobs_activate", jobs };
      },
    );
    const code = errorCode(result);
    if (code && this.journal.checkpoint.phase === "jobs_stage") {
      throw new PipelineWorkerError(code);
    }
  }

  private async driveJobsActivate(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "jobs_activate") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const job = checkpoint.jobs[checkpoint.index];
    if (!job) throw new PipelineWorkerError("job_checkpoint_invalid");
    if (
      !this.journal.pending &&
      job.leaseExpiresAt <= Date.now() + LEASE_SAFETY_MARGIN_MS
    ) {
      await this.journal.transitionCheckpoint({
        checkpoint: { ...checkpoint, phase: "jobs_renew" },
        credentialSessionActive: true,
      });
      return;
    }
    const result = await this.mutation(
      "jobs.activate",
      () =>
        request(this.config, "jobs.activate", {
          requestId: randomUUID(),
          jobId: job.jobId,
          leaseEpoch: job.leaseEpoch,
          leaseToken: job.leaseToken,
        }),
      (current, response) => {
        if (current.phase !== "jobs_activate") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const active = current.jobs[current.index];
        if (!active) throw new PipelineWorkerError("job_checkpoint_invalid");
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          if (code === "lease_conflict" || code === "reservation_expired") {
            return afterJob(current, current.published);
          }
          if (code === "scan_conflict") {
            return {
              ...current,
              phase: "jobs_fail",
              failureCode: "staging_invalid",
            };
          }
          return processingTerminal(current, "failed", code, undefined, true);
        }
        if (value.jobId !== active.jobId || value.state !== "ready") {
          throw new PipelineWorkerError("job_activation_conflict");
        }
        return afterJob(current, current.published + 1);
      },
    );
    const code = errorCode(result);
    if (code && this.journal.checkpoint.phase === "jobs_activate") {
      throw new PipelineWorkerError(code);
    }
  }

  private async driveJobsFail(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "jobs_fail") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const job = checkpoint.jobs[checkpoint.index];
    if (!job) throw new PipelineWorkerError("job_checkpoint_invalid");
    if (
      !this.journal.pending &&
      job.leaseExpiresAt <= Date.now() + LEASE_SAFETY_MARGIN_MS
    ) {
      await this.journal.transitionCheckpoint({
        checkpoint: afterJob(checkpoint, checkpoint.published),
        credentialSessionActive: true,
      });
      return;
    }
    const result = await this.mutation(
      "jobs.fail",
      () =>
        request(this.config, "jobs.fail", {
          requestId: randomUUID(),
          jobId: job.jobId,
          leaseEpoch: job.leaseEpoch,
          leaseToken: job.leaseToken,
          failureCode: checkpoint.failureCode,
        }),
      (current, response) => {
        if (current.phase !== "jobs_fail") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const active = current.jobs[current.index];
        if (!active) throw new PipelineWorkerError("job_checkpoint_invalid");
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return code === "lease_conflict" || code === "reservation_expired"
            ? afterJob(current, current.published)
            : processingTerminal(current, "failed", code, undefined, true);
        }
        if (value.jobId !== active.jobId) {
          throw new PipelineWorkerError("job_failure_parent_conflict");
        }
        return afterJob(current, current.published);
      },
    );
    const code = errorCode(result);
    if (code && this.journal.checkpoint.phase === "jobs_fail") {
      throw new PipelineWorkerError(code);
    }
  }

  private async driveAssessStatus(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "assess_status") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const status = await this.sourceStatus();
    const enumeration = status.enumeration as
      { state?: unknown; scanId?: unknown } | undefined;
    if (
      enumeration?.state !== "complete" ||
      (enumeration.scanId !== undefined &&
        enumeration.scanId !== checkpoint.scanId)
    ) {
      await this.journal.transitionCheckpoint({
        checkpoint: processingTerminal(
          checkpoint,
          "incomplete",
          "enumeration_not_complete",
        ),
        credentialSessionActive: false,
      });
      return;
    }
    await this.journal.transitionCheckpoint({
      checkpoint: {
        version: 1,
        phase: "assess_begin",
        ...processingBase(checkpoint),
        expectedInventoryEpoch: integer(
          status.inventoryEpoch,
          "inventory_epoch",
        ),
        expectedManifestVersion: integer(
          status.manifestVersion,
          "manifest_version",
        ),
      },
      credentialSessionActive: true,
    });
  }

  private async driveAssessBegin(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "assess_begin") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const result = await this.mutation(
      "processing.assessBegin",
      () =>
        request(this.config, "processing.assessBegin", {
          requestId: randomUUID(),
          scanId: checkpoint.scanId,
          expectedInventoryEpoch: checkpoint.expectedInventoryEpoch,
          expectedManifestVersion: checkpoint.expectedManifestVersion,
        }),
      (current, response) => {
        if (current.phase !== "assess_begin") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return processingTerminal(current, "failed", code, undefined, true);
        }
        if (
          value.scanId !== current.scanId ||
          value.inventoryEpoch !== current.expectedInventoryEpoch ||
          value.manifestVersion !== current.expectedManifestVersion
        ) {
          throw new PipelineWorkerError("assessment_parent_conflict");
        }
        const assessmentId = text(value.assessmentId, "assessment_id");
        if (value.state === "running") {
          return {
            version: 1,
            phase: "assess_page",
            ...processingBase(current),
            assessmentId,
            ordinal: integer(value.nextOrdinal, "assessment_ordinal"),
            pageCount: 0,
          };
        }
        if (value.state === "complete") {
          return processingTerminal(
            current,
            "complete",
            undefined,
            assessmentId,
          );
        }
        return processingTerminal(
          current,
          "incomplete",
          value.state === "stale"
            ? "assessment_stale"
            : "processing_incomplete",
          assessmentId,
        );
      },
    );
    if (errorCode(result)) throw new PipelineWorkerError(errorCode(result)!);
  }

  private async driveAssessPage(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "assess_page") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    if (checkpoint.pageCount > 0 && this.config.assessmentPacingMs) {
      await sleep(this.config.assessmentPacingMs);
    }
    const result = await this.mutation(
      "processing.assessPage",
      () =>
        request(this.config, "processing.assessPage", {
          requestId: randomUUID(),
          assessmentId: checkpoint.assessmentId,
          ordinal: checkpoint.ordinal,
          maxItems: 1,
        }),
      (current, response) => {
        if (current.phase !== "assess_page") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return processingTerminal(
            current,
            "incomplete",
            code,
            current.assessmentId,
            true,
          );
        }
        if (
          value.assessmentId !== current.assessmentId ||
          value.ordinal !== current.ordinal
        ) {
          throw new PipelineWorkerError("assessment_page_parent_conflict");
        }
        if (value.state === "running") {
          const nextOrdinal = integer(value.nextOrdinal, "assessment_ordinal");
          if (nextOrdinal !== current.ordinal + 1) {
            throw new PipelineWorkerError("assessment_ordinal_conflict");
          }
          if (current.pageCount + 1 >= MAX_ASSESSMENT_PAGES) {
            return processingTerminal(
              current,
              "incomplete",
              "assessment_capacity_exceeded",
              current.assessmentId,
              true,
            );
          }
          return {
            ...current,
            ordinal: nextOrdinal,
            pageCount: current.pageCount + 1,
          };
        }
        if (value.state === "complete") {
          return processingTerminal(
            current,
            "complete",
            undefined,
            current.assessmentId,
          );
        }
        return processingTerminal(
          current,
          "incomplete",
          value.state === "stale"
            ? "assessment_stale"
            : "processing_incomplete",
          current.assessmentId,
        );
      },
    );
    if (errorCode(result)) throw new PipelineWorkerError(errorCode(result)!);
  }

  private async driveArchived(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    switch (checkpoint.step) {
      case "intent": {
        const next = await this.createArchivedIntents(checkpoint);
        await this.journal.transitionCheckpoint({
          checkpoint: next,
          credentialSessionActive: true,
        });
        return;
      }
      case "preflight":
        return await this.driveArchivedPreflight();
      case "lookup_original":
        return await this.driveArchivedLookupOriginal();
      case "capture":
        return await this.driveArchivedCapture();
      case "original_archive":
        return await this.driveArchiveCopies(checkpoint, "original_bytes");
      case "parse":
        return await this.driveArchivedParse();
      case "spool":
        return await this.driveArchivedSpool();
      case "lookup_processing":
        return await this.driveArchivedLookupProcessing();
      case "parser_archive":
        return await this.driveArchiveCopies(checkpoint, "parser_output");
      case "reserve":
        return await this.driveArchivedReserve();
      case "admit":
        return await this.driveArchivedAdmit();
      case "parsed_reserve":
        return await this.driveParsedReserve();
      case "parsed_renew":
        return await this.driveParsedRenew();
      case "parsed_begin":
        return await this.driveParsedBegin();
      case "parsed_batch":
        return await this.driveParsedBatch();
      case "parsed_seal":
        return await this.driveParsedSeal();
      case "parsed_activate":
        return await this.driveParsedActivate();
      case "cleanup":
        return await this.driveArchivedCleanup();
    }
  }

  private async driveCheckpoint(): Promise<PipelineRunResult | undefined> {
    const checkpoint = this.journal.checkpoint;
    switch (checkpoint.phase) {
      case "idle":
        throw new PipelineWorkerError("journal_phase_conflict");
      case "terminal":
        return resultFromTerminal(checkpoint);
      case "scan_begin":
        await this.driveScanBegin();
        break;
      case "inventory":
        await this.driveInventory();
        break;
      case "append":
        await this.driveAppend();
        break;
      case "seal_check":
        await this.driveSealCheck();
        break;
      case "seal":
        await this.driveSeal();
        break;
      case "reconcile":
        await this.driveReconcile();
        break;
      case "discovery_reserve":
        await this.driveDiscoveryReserve();
        break;
      case "discovery_admit":
        await this.driveDiscoveryAdmit();
        break;
      case "archived":
        await this.driveArchived();
        break;
      case "jobs_reserve":
        await this.driveJobsReserve();
        break;
      case "jobs_renew":
        await this.driveJobsRenew();
        break;
      case "jobs_stage":
        await this.driveJobsStage();
        break;
      case "jobs_activate":
        await this.driveJobsActivate();
        break;
      case "jobs_fail":
        await this.driveJobsFail();
        break;
      case "assess_status":
        await this.driveAssessStatus();
        break;
      case "assess_begin":
        await this.driveAssessBegin();
        break;
      case "assess_page":
        await this.driveAssessPage();
        break;
    }
    return undefined;
  }

  async run(): Promise<PipelineRunResult> {
    await this.preparePdfProfile();
    if (this.config.pdfDocQa) {
      this.archiveCatalog = await openArchiveCatalog({ journal: this.journal });
    }
    if (this.journal.pending) {
      const replayed = await this.driveCheckpoint();
      if (replayed) return replayed;
      if (this.journal.checkpoint.phase === "terminal") {
        return resultFromTerminal(this.journal.checkpoint);
      }
    }
    const status = await this.sourceStatus();
    if (status.sourceAccountId !== this.config.sourceAccountId) {
      throw new PipelineWorkerError("source_mismatch");
    }
    if (this.journal.credentialStatus === "changed_quiescent") {
      await this.journal.acceptCredentialAfterAuthorizedStatus();
    }
    const startingCheckpoint = this.journal.checkpoint;
    if (
      startingCheckpoint.phase === "terminal" &&
      stickyTerminal(startingCheckpoint)
    ) {
      return resultFromTerminal(startingCheckpoint);
    }
    if (
      this.journal.checkpoint.phase === "idle" ||
      this.journal.checkpoint.phase === "terminal"
    ) {
      const roots = await canonicalRoots(this.config);
      await this.startCycle(roots, status);
    }

    for (let steps = 0; steps < 10_000; steps += 1) {
      let result: PipelineRunResult | undefined;
      try {
        result = await this.driveCheckpoint();
      } catch (error) {
        const checkpoint = this.journal.checkpoint;
        if (
          error instanceof ParserProcessError &&
          DOCUMENT_PARSER_FAILURE_CODES.has(error.code) &&
          checkpoint.phase === "archived" &&
          checkpoint.step === "parse"
        ) {
          await this.recordArchivedParseFailure(checkpoint, error.code);
          continue;
        }
        throw error;
      }
      if (result) return result;
    }
    throw new PipelineWorkerError("worker_step_limit");
  }

  async runSafely(): Promise<PipelineRunResult> {
    try {
      return await this.run();
    } catch (error) {
      return {
        state:
          error instanceof PipelineRetryableError ? "incomplete" : "failed",
        code:
          error instanceof FilesystemFailure ||
          error instanceof PipelineWorkerError
            ? error.code
            : error instanceof ParserProcessError &&
                SAFE_PARSER_FAILURE_CODES.has(error.code)
              ? error.code
              : "worker_failed",
      };
    }
  }
}
