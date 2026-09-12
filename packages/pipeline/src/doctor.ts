import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import {
  journalBindingForConfig,
  loadPipelineConfig,
  requireCredential,
} from "./config.js";
import {
  discoverFiles,
  discoverSourceObservations,
  FilesystemFailure,
  type SafeRoot,
} from "./filesystem.js";
import { inspectJournalReadOnly } from "./journal.js";
import type { JournalInspection } from "./journalTypes.js";
import { journalCodec } from "./runner.js";
import { parseWorkerResponse } from "./transport.js";
import {
  parseDiagnosticsStatus,
  type DiagnosticsStatus,
} from "./diagnostics.js";
import type {
  PipelineConfig,
  WorkerErrorCode,
  WorkerResponse,
  WorkerTransport,
} from "./types.js";

const ROOT_CHECK_DEADLINE_MS = 30_000;
const STATUS_DEADLINE_MS = 30_000;
const MAX_STATUS_BYTES = 512 * 1024;
const WORKER_ERROR_CODES = new Set<WorkerErrorCode>([
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

type State = "ready" | "degraded" | "blocked";
type CheckState = "pass" | "warn" | "fail";

export type ConfigCheck = {
  id: "config";
  state: CheckState;
  code: "valid" | "invalid_config";
};
export type CredentialCheck = {
  id: "credential";
  state: CheckState;
  code:
    | "authorized"
    | "missing_credential"
    | "not_authenticated"
    | "not_authorized"
    | "authorization_unverified"
    | "not_checked";
};
export type DeploymentCheck = {
  id: "deployment";
  state: CheckState;
  code:
    "available" | "deployment_unavailable" | "source_mismatch" | "not_checked";
};
export type RootsCheck = {
  id: "roots";
  state: CheckState;
  code:
    | "safe"
    | "root_missing"
    | "root_permission_denied"
    | "root_unreadable"
    | "root_unsupported"
    | "root_empty_file"
    | "root_capacity_exceeded"
    | "root_scan_interrupted"
    | "root_unstable"
    | "root_overlap"
    | "journal_overlap"
    | "root_check_failed"
    | "not_checked";
};
export type JournalCheck = {
  id: "journal";
  state: CheckState;
  code:
    | "not_initialized"
    | "safe"
    | "contended"
    | "recovery_pending"
    | "credential_rebind_pending"
    | "credential_recovery_required"
    | "credential_comparison_unavailable"
    | "manual_recovery_required"
    | "unsupported_platform"
    | "invalid_directory"
    | "invalid_permissions"
    | "invalid_state"
    | "binding_mismatch"
    | "capacity_exceeded"
    | "unsafe"
    | "not_checked";
};
export type HeartbeatCheck = {
  id: "heartbeat";
  state: CheckState;
  code:
    | "current"
    | "not_configured"
    | "awaiting_heartbeat"
    | "overdue"
    | "missing_worker"
    | "unavailable";
};

export type DoctorCheck =
  | ConfigCheck
  | CredentialCheck
  | DeploymentCheck
  | RootsCheck
  | JournalCheck
  | HeartbeatCheck;

export type ProcessingCounts = {
  items: {
    ready: number;
    pending: number;
    failed: number;
    needsReview: number;
    explicitGap: number;
    unavailable: number;
    ignoredForgotten: number;
  };
  unresolvedEntries: {
    needsReview: number;
    ignoredForgotten: number;
  };
};

export type DoctorSource = {
  enumeration:
    | "not_started"
    | "in_progress"
    | "complete"
    | "needs_review"
    | "failed"
    | "unavailable";
  processing:
    "not_assessed" | "assessing" | "complete" | "incomplete" | "unavailable";
  recordCoverage: "not_established";
  counts?: ProcessingCounts;
  warnings: Array<"assessment_stale" | "record_coverage_not_established">;
};

export type DoctorResult = {
  version: 2;
  state: State;
  checks: [
    ConfigCheck,
    CredentialCheck,
    DeploymentCheck,
    HeartbeatCheck,
    RootsCheck,
    JournalCheck,
  ];
  source: DoctorSource;
  capabilities: { embeddings: "unverified"; daemon: "unverified" };
};

type StatusEnumeration =
  | { state: "never" }
  | { state: "in_progress"; scanId: string }
  | { state: "complete"; completedAt: number; scanId?: string }
  | { state: "needs_review"; scanId: string; completedAt?: number }
  | {
      state: "failed";
      scanId?: string;
      completedAt?: number;
      failureCode?: string;
    };

type StatusProcessing =
  | { state: "not_assessed" }
  | { state: "assessing"; assessmentId: string; startedAt: number }
  | {
      state: "complete" | "incomplete";
      assessmentId: string;
      scanId: string;
      inventoryEpoch: number;
      manifestVersion: number;
      completedAt: number;
      counts: ProcessingCounts;
    };

type SourceStatus = {
  operation: "source.status";
  sourceAccountId: string;
  inventoryEpoch: number;
  completedInventoryEpoch: number;
  manifestVersion: number;
  enumeration: StatusEnumeration;
  processing: StatusProcessing;
  recordCoverage: "not_established";
};

export type DoctorAdapters = {
  inspectRoots?: (config: PipelineConfig) => Promise<void>;
  inspectJournal?: (
    config: PipelineConfig,
    credential?: string,
  ) => Promise<JournalInspection>;
  diagnosticDeadlineMs?: number;
};

class RootDiagnosticFailure extends Error {
  constructor(readonly code: RootsCheck["code"]) {
    super(code);
  }
}

function unavailableSource(): DoctorSource {
  return {
    enumeration: "unavailable",
    processing: "unavailable",
    recordCoverage: "not_established",
    warnings: ["record_coverage_not_established"],
  };
}

function resultState(checks: readonly DoctorCheck[]): State {
  if (checks.some((check) => check.state === "fail")) return "blocked";
  if (checks.some((check) => check.state === "warn")) return "degraded";
  return "ready";
}

function result(
  checks: DoctorResult["checks"],
  source = unavailableSource(),
): DoctorResult {
  return {
    version: 2,
    state: resultState(checks),
    checks,
    source,
    capabilities: { embeddings: "unverified", daemon: "unverified" },
  };
}

export function invalidConfigDoctorResult(): DoctorResult {
  return result([
    { id: "config", state: "fail", code: "invalid_config" },
    { id: "credential", state: "warn", code: "not_checked" },
    { id: "deployment", state: "warn", code: "not_checked" },
    { id: "heartbeat", state: "warn", code: "unavailable" },
    { id: "roots", state: "warn", code: "not_checked" },
    { id: "journal", state: "warn", code: "not_checked" },
  ]);
}

function heartbeatCheck(status: DiagnosticsStatus): HeartbeatCheck {
  if (status.watcher.state === "not_configured")
    return { id: "heartbeat", state: "warn", code: "not_configured" };
  if (status.watcher.state === "awaiting_heartbeat")
    return { id: "heartbeat", state: "warn", code: "awaiting_heartbeat" };
  if (status.incident.state === "open")
    return { id: "heartbeat", state: "fail", code: "missing_worker" };
  return status.watcher.state === "current"
    ? { id: "heartbeat", state: "pass", code: "current" }
    : { id: "heartbeat", state: "warn", code: "overdue" };
}

async function diagnosticStatus(
  config: PipelineConfig,
  transport: WorkerTransport,
  deadlineMs = STATUS_DEADLINE_MS,
): Promise<HeartbeatCheck> {
  try {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new Error();
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let response: WorkerResponse;
    try {
      response = await Promise.race([
        transport.call(
          {
            protocolVersion: 1,
            operation: "diagnostics.status",
            spaceId: config.spaceId,
            sourceAccountId: config.sourceAccountId,
          },
          controller.signal,
        ),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("diagnostics status timed out"));
          }, deadlineMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    const parsed = parseDiagnosticsStatus(response);
    if (parsed.sourceAccountId !== config.sourceAccountId)
      return { id: "heartbeat", state: "warn", code: "unavailable" };
    return heartbeatCheck(parsed);
  } catch {
    return { id: "heartbeat", state: "warn", code: "unavailable" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeWorkerError(value: unknown): WorkerErrorCode | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !("error" in value)
  ) {
    return undefined;
  }
  const error = value.error;
  if (
    !isRecord(error) ||
    Object.keys(error).length !== 1 ||
    typeof error.code !== "string" ||
    !WORKER_ERROR_CODES.has(error.code as WorkerErrorCode)
  ) {
    return undefined;
  }
  return error.code as WorkerErrorCode;
}

function strictStatus(value: WorkerResponse): SourceStatus {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("invalid status response");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATUS_BYTES) {
    throw new Error("invalid status response");
  }
  const parsed = parseWorkerResponse(serialized, "source.status");
  if ("error" in parsed) throw new Error("invalid status response");
  const status = parsed as SourceStatus;
  if (status.processing.state === "complete") {
    const { items, unresolvedEntries } = status.processing.counts;
    if (
      items.pending !== 0 ||
      items.failed !== 0 ||
      items.needsReview !== 0 ||
      items.explicitGap !== 0 ||
      items.unavailable !== 0 ||
      unresolvedEntries.needsReview !== 0
    ) {
      throw new Error("invalid status response");
    }
  }
  return status;
}

function sourceResult(value: SourceStatus): DoctorSource {
  const currentEnumeration =
    value.enumeration.state === "complete" &&
    value.completedInventoryEpoch === value.inventoryEpoch;
  let enumeration: DoctorSource["enumeration"];
  switch (value.enumeration.state) {
    case "never":
      enumeration = "not_started";
      break;
    case "in_progress":
      enumeration = "in_progress";
      break;
    case "complete":
      enumeration = currentEnumeration ? "complete" : "in_progress";
      break;
    case "needs_review":
      enumeration = "needs_review";
      break;
    case "failed":
      enumeration = "failed";
      break;
  }

  const warnings: DoctorSource["warnings"] = [
    "record_coverage_not_established",
  ];
  const processing = value.processing;
  if (processing.state === "not_assessed") {
    return {
      enumeration,
      processing: "not_assessed",
      recordCoverage: "not_established",
      warnings,
    };
  }
  if (processing.state === "assessing") {
    return {
      enumeration,
      processing: "assessing",
      recordCoverage: "not_established",
      warnings,
    };
  }

  const scanMatches =
    value.enumeration.state === "complete" &&
    (value.enumeration.scanId === undefined ||
      processing.scanId === value.enumeration.scanId);
  const current =
    currentEnumeration &&
    scanMatches &&
    processing.inventoryEpoch === value.inventoryEpoch &&
    processing.manifestVersion === value.manifestVersion;
  if (!current) {
    warnings.unshift("assessment_stale");
    return {
      enumeration,
      processing: "incomplete",
      recordCoverage: "not_established",
      warnings,
    };
  }
  return {
    enumeration,
    processing: processing.state,
    recordCoverage: "not_established",
    counts: processing.counts,
    warnings,
  };
}

async function beforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new RootDiagnosticFailure("root_scan_interrupted");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new RootDiagnosticFailure("root_scan_interrupted")),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function contains(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

async function futureCanonicalPath(
  path: string,
  deadline: number,
): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  for (let depth = 0; depth < 256; depth += 1) {
    try {
      await beforeDeadline(lstat(current), deadline);
      const parent = await beforeDeadline(realpath(current), deadline);
      return resolve(parent, ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) {
        throw new RootDiagnosticFailure("root_check_failed");
      }
      suffix.unshift(current.slice(parent.length + (parent === sep ? 0 : 1)));
      current = parent;
    }
  }
  throw new RootDiagnosticFailure("root_check_failed");
}

async function inspectRoots(config: PipelineConfig): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new RootDiagnosticFailure("root_unsupported");
  const deadline = Date.now() + ROOT_CHECK_DEADLINE_MS;
  const roots: SafeRoot[] = await Promise.all(
    config.roots.map(async (root) => {
      const entry = await beforeDeadline(lstat(root.path), deadline);
      if (
        entry.isSymbolicLink() ||
        !entry.isDirectory() ||
        entry.uid !== uid ||
        (entry.mode & 0o022) !== 0
      ) {
        throw new RootDiagnosticFailure("root_permission_denied");
      }
      const canonicalPath = await beforeDeadline(realpath(root.path), deadline);
      const canonicalEntry = await beforeDeadline(
        lstat(canonicalPath),
        deadline,
      );
      if (
        canonicalEntry.isSymbolicLink() ||
        !canonicalEntry.isDirectory() ||
        canonicalEntry.uid !== uid ||
        (canonicalEntry.mode & 0o022) !== 0
      ) {
        throw new RootDiagnosticFailure("root_permission_denied");
      }
      if (
        entry.dev !== canonicalEntry.dev ||
        entry.ino !== canonicalEntry.ino
      ) {
        throw new RootDiagnosticFailure("root_unstable");
      }
      return {
        ...root,
        canonicalPath,
        device: canonicalEntry.dev,
        inode: canonicalEntry.ino,
      };
    }),
  );
  for (let first = 0; first < roots.length; first += 1) {
    for (let second = first + 1; second < roots.length; second += 1) {
      const a = roots[first]!;
      const b = roots[second]!;
      if (
        contains(a.canonicalPath, b.canonicalPath) ||
        contains(b.canonicalPath, a.canonicalPath)
      ) {
        throw new RootDiagnosticFailure("root_overlap");
      }
    }
  }
  const journal = await futureCanonicalPath(config.journalDir, deadline);
  if (
    roots.some(
      (root) =>
        contains(root.canonicalPath, journal) ||
        contains(journal, root.canonicalPath),
    )
  ) {
    throw new RootDiagnosticFailure("journal_overlap");
  }
  if (config.pdfDocQa) await discoverSourceObservations(config, roots);
  else await discoverFiles(config, roots);
}

function rootFailureCode(error: unknown): RootsCheck["code"] {
  if (error instanceof RootDiagnosticFailure) return error.code;
  if (error instanceof FilesystemFailure) {
    switch (error.code) {
      case "empty":
        return "root_empty_file";
      case "oversized":
        return "root_capacity_exceeded";
      case "permission_denied":
      case "unreadable":
        return "root_unreadable";
      case "unsupported":
      case "encrypted":
        return "root_unsupported";
      case "enumeration_interrupted":
        return "root_scan_interrupted";
      case "unstable":
        return "root_unstable";
    }
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "root_missing";
  if (code === "EACCES" || code === "EPERM") {
    return "root_permission_denied";
  }
  return "root_check_failed";
}

async function rootCheck(
  config: PipelineConfig,
  adapter = inspectRoots,
): Promise<RootsCheck> {
  try {
    await adapter(config);
    return { id: "roots", state: "pass", code: "safe" };
  } catch (error) {
    return { id: "roots", state: "fail", code: rootFailureCode(error) };
  }
}

async function journalInspection(
  config: PipelineConfig,
  credential?: string,
): Promise<JournalInspection> {
  return inspectJournalReadOnly({
    directory: config.journalDir,
    binding: journalBindingForConfig(config),
    codec: journalCodec,
    ...(credential === undefined
      ? {}
      : { credentialForComparison: credential }),
  });
}

function journalResult(inspection: JournalInspection): JournalCheck {
  if (inspection.state === "not_initialized") {
    return { id: "journal", state: "pass", code: "not_initialized" };
  }
  if (inspection.state === "contended") {
    return { id: "journal", state: "warn", code: "contended" };
  }
  if (inspection.state === "unsafe") {
    return { id: "journal", state: "fail", code: inspection.code };
  }
  if (inspection.manualRecoveryRequired) {
    return {
      id: "journal",
      state: "fail",
      code: "manual_recovery_required",
    };
  }
  if (inspection.credentialBinding === "changed_active") {
    return {
      id: "journal",
      state: "fail",
      code: "credential_recovery_required",
    };
  }
  const active =
    inspection.pending ||
    inspection.cachedResult ||
    inspection.credentialSessionActive ||
    inspection.recoveryArtifactCount > 0 ||
    inspection.activity === "scan" ||
    inspection.activity === "processing" ||
    inspection.activity === "assessment";
  if (active && inspection.credentialBinding === "unverified") {
    return {
      id: "journal",
      state: "fail",
      code: "credential_comparison_unavailable",
    };
  }
  if (active) {
    return { id: "journal", state: "warn", code: "recovery_pending" };
  }
  if (inspection.credentialBinding === "changed_quiescent") {
    return {
      id: "journal",
      state: "warn",
      code: "credential_rebind_pending",
    };
  }
  return { id: "journal", state: "pass", code: "safe" };
}

async function inspectJournal(
  config: PipelineConfig,
  credential: string | undefined,
  adapter = journalInspection,
): Promise<JournalCheck> {
  try {
    return journalResult(await adapter(config, credential));
  } catch {
    return { id: "journal", state: "fail", code: "unsafe" };
  }
}

async function remoteChecks(
  config: PipelineConfig,
  transport: WorkerTransport | undefined,
  credential: string | undefined,
  diagnosticDeadlineMs?: number,
): Promise<{
  credential: CredentialCheck;
  deployment: DeploymentCheck;
  source: DoctorSource;
  heartbeat: HeartbeatCheck;
}> {
  if (credential === undefined || transport === undefined) {
    return {
      credential: {
        id: "credential",
        state: "fail",
        code: "missing_credential",
      },
      deployment: { id: "deployment", state: "warn", code: "not_checked" },
      source: unavailableSource(),
      heartbeat: { id: "heartbeat", state: "warn", code: "unavailable" },
    };
  }
  const heartbeat = diagnosticStatus(config, transport, diagnosticDeadlineMs);
  let response: WorkerResponse;
  try {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      response = await Promise.race([
        transport.call(
          {
            protocolVersion: 1,
            operation: "source.status",
            spaceId: config.spaceId,
            sourceAccountId: config.sourceAccountId,
          },
          controller.signal,
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("source status timed out"));
          }, STATUS_DEADLINE_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch {
    return {
      credential: {
        id: "credential",
        state: "warn",
        code: "authorization_unverified",
      },
      deployment: {
        id: "deployment",
        state: "fail",
        code: "deployment_unavailable",
      },
      source: unavailableSource(),
      heartbeat: await heartbeat,
    };
  }

  const error = safeWorkerError(response);
  if (error === "not_authenticated" || error === "not_authorized") {
    return {
      credential: { id: "credential", state: "fail", code: error },
      deployment: { id: "deployment", state: "pass", code: "available" },
      source: unavailableSource(),
      heartbeat: await heartbeat,
    };
  }
  if (error !== undefined) {
    return {
      credential: {
        id: "credential",
        state: "warn",
        code: "authorization_unverified",
      },
      deployment: {
        id: "deployment",
        state: "fail",
        code: "deployment_unavailable",
      },
      source: unavailableSource(),
      heartbeat: await heartbeat,
    };
  }

  let status: SourceStatus;
  try {
    status = strictStatus(response);
  } catch {
    return {
      credential: {
        id: "credential",
        state: "warn",
        code: "authorization_unverified",
      },
      deployment: {
        id: "deployment",
        state: "fail",
        code: "deployment_unavailable",
      },
      source: unavailableSource(),
      heartbeat: await heartbeat,
    };
  }
  if (status.sourceAccountId !== config.sourceAccountId) {
    return {
      credential: {
        id: "credential",
        state: "warn",
        code: "authorization_unverified",
      },
      deployment: {
        id: "deployment",
        state: "fail",
        code: "source_mismatch",
      },
      source: unavailableSource(),
      heartbeat: await heartbeat,
    };
  }
  return {
    credential: { id: "credential", state: "pass", code: "authorized" },
    deployment: { id: "deployment", state: "pass", code: "available" },
    source: sourceResult(status),
    heartbeat: await heartbeat,
  };
}

export async function doctor(
  config: PipelineConfig,
  transport: WorkerTransport | undefined,
  credential: string | undefined,
  adapters: DoctorAdapters = {},
): Promise<DoctorResult> {
  const [remote, roots, journal] = await Promise.all([
    remoteChecks(config, transport, credential, adapters.diagnosticDeadlineMs),
    rootCheck(config, adapters.inspectRoots),
    inspectJournal(config, credential, adapters.inspectJournal),
  ]);
  return result(
    [
      { id: "config", state: "pass", code: "valid" },
      remote.credential,
      remote.deployment,
      remote.heartbeat,
      roots,
      journal,
    ],
    remote.source,
  );
}

export async function doctorFromConfig(
  config: PipelineConfig,
  makeTransport: (credential: string) => WorkerTransport,
  adapters: DoctorAdapters = {},
): Promise<DoctorResult> {
  let credential: string | undefined;
  try {
    credential = requireCredential(config);
  } catch {
    credential = undefined;
  }
  let transport: WorkerTransport | undefined;
  if (credential !== undefined) {
    try {
      transport = makeTransport(credential);
    } catch {
      transport = {
        call: async () => {
          throw new Error("transport unavailable");
        },
      };
    }
  }
  return doctor(config, transport, credential, adapters);
}

export async function doctorFromPath(
  configPath: string,
  makeTransport: (
    config: PipelineConfig,
    credential: string,
  ) => WorkerTransport,
  adapters: DoctorAdapters = {},
): Promise<DoctorResult> {
  let config: PipelineConfig;
  try {
    config = await loadPipelineConfig(configPath);
  } catch {
    return invalidConfigDoctorResult();
  }
  return doctorFromConfig(
    config,
    (credential) => makeTransport(config, credential),
    adapters,
  );
}

export function formatDoctorResult(value: DoctorResult): string {
  return [
    `doctor: ${value.state}`,
    ...value.checks.map((check) => `${check.id}: ${check.state} ${check.code}`),
    `source: enumeration=${value.source.enumeration} processing=${value.source.processing} recordCoverage=${value.source.recordCoverage}`,
    `capabilities: embeddings=${value.capabilities.embeddings} daemon=${value.capabilities.daemon}`,
  ].join("\n");
}
