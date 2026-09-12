import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { openArchiveCatalog, type ArchiveCatalog } from "./archiveCatalog.js";
import {
  parseOwnerArchiveRelocationRecipe,
  relocationIntentFromRecipe,
} from "./archiveRelocationRecipe.js";
import { ArchiveRelocationSession } from "./archiveRelocationSession.js";
import { validateArchiveRelocationState } from "./archiveRelocationWorkflow.js";
import { loadPipelineConfig, parseConfig } from "./config.js";
import { parseHeartbeatResponse } from "./diagnostics.js";
import { doctor, type DoctorResult } from "./doctor.js";
import {
  canonicalRoots,
  discoverFiles,
  discoverSourceObservations,
  MAX_DISCOVERED_PDF_BYTES,
  toFsUri,
} from "./filesystem.js";
import { PipelineRunner } from "./runner.js";
import type { RunnerCheckpoint } from "./runnerState.js";
import { archiveCheckpointIsQuiescent } from "./journal.js";
import { HttpWorkerTransport, parseWorkerResponse } from "./transport.js";
import type { JsonValue } from "./journalTypes.js";
import type {
  PipelineConfig,
  PipelineRunResult,
  SourceObservation,
  WorkerResponse,
  WorkerTransport,
} from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BASELINE_OVERHEAD_BYTES = 1024 * 1024;
const CONNECTOR_VERSION = "kithmind-filesystem-worker-v1";

const ALLOWED_OPERATIONS = new Set([
  "source.status",
  "source.inventoryPage",
  "scan.begin",
  "scan.appendPage",
  "scan.seal",
  "scan.reconcile",
  "discovery.reserve",
  "jobs.reserve",
  "processing.assessBegin",
  "processing.assessPage",
  "diagnostics.status",
  "diagnostics.heartbeat",
]);

export type OwnerWatcherResetInput = Readonly<{
  sourceAccountId: string;
  requestId: string;
  expectedWatcherId: string;
  nextWatcherId: string;
}>;

export type OwnerWatcherResetResult = Readonly<{
  sourceAccountId: string;
  watcherId: string;
  reused: boolean;
  changedAt: number;
}>;

export type OwnerWatcherReset = (
  input: OwnerWatcherResetInput,
) => Promise<OwnerWatcherResetResult>;

export type ArchiveRelocationOwnerResumeProof = Readonly<{
  version: 1;
  recipeHash: string;
  workflowRelocationId: string;
  sourceAccountId: string;
  previousWatcherId: string;
  currentWatcherId: string;
  watcherReset: Readonly<{ reused: boolean; changedAt: number }>;
  filesystem: Readonly<{ observationCount: number; sha256: string }>;
  catalog: Readonly<{ revision: number; sha256: string }>;
  doctor: DoctorResult;
  scan: Readonly<{
    state: "complete";
    scanned: number;
    published: 0;
  }>;
  heartbeat: Readonly<{
    accepted: true;
    receivedAt: number;
    nextExpectedAt: number;
  }>;
  completedAt: number;
}>;

export type VerifyArchiveRelocationOwnerResumeInput = Readonly<{
  recipe: unknown;
  session: ArchiveRelocationSession<RunnerCheckpoint, JsonValue>;
  credential: string;
  filesystemBaseline: readonly SourceObservation[];
  ownerReset: OwnerWatcherReset;
}>;

export class ArchiveRelocationOwnerResumeError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "session_not_ready"
      | "baseline_changed"
      | "watcher_reset_failed"
      | "doctor_failed"
      | "unexpected_work"
      | "scan_failed"
      | "heartbeat_failed",
  ) {
    super(`Archive relocation owner resume failed: ${code}`);
    this.name = "ArchiveRelocationOwnerResumeError";
  }
}

function fail(code: ArchiveRelocationOwnerResumeError["code"]): never {
  throw new ArchiveRelocationOwnerResumeError(code);
}

function exactKeys(value: object, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    actual.some(
      (key) =>
        key === "__proto__" || key === "prototype" || key === "constructor",
    )
  )
    fail("invalid_input");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_input");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail("invalid_input");
  return value as Record<string, unknown>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateFileFields(
  row: Record<string, unknown>,
  config: PipelineConfig,
): void {
  if (
    typeof row.rootAlias !== "string" ||
    !config.roots.some((root) => root.alias === row.rootAlias) ||
    typeof row.relativePath !== "string" ||
    row.relativePath.length < 1 ||
    Buffer.byteLength(row.relativePath, "utf8") > 4_096 ||
    row.relativePath.startsWith("/") ||
    row.relativePath.includes("\\") ||
    row.relativePath
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    typeof row.uri !== "string" ||
    row.uri !== toFsUri(row.rootAlias, row.relativePath) ||
    !Number.isSafeInteger(row.sourceModifiedAt) ||
    (row.sourceModifiedAt as number) < 0
  )
    fail("invalid_input");
}

function frozenBaseline(
  value: readonly SourceObservation[],
  config: PipelineConfig,
): SourceObservation[] {
  if (!Array.isArray(value) || value.length > config.maxFiles)
    fail("invalid_input");
  let copy: SourceObservation[];
  try {
    copy = structuredClone(value) as SourceObservation[];
  } catch {
    fail("invalid_input");
  }
  const identities = new Set<string>();
  for (const entry of copy) {
    const outer = record(entry);
    if (outer.kind === "gap") {
      exactKeys(outer, ["kind", "gap"]);
      const gap = record(outer.gap);
      exactKeys(gap, [
        "rootAlias",
        "relativePath",
        "uri",
        "sourceModifiedAt",
        "code",
      ]);
      validateFileFields(gap, config);
      if (
        gap.code !== "empty" &&
        gap.code !== "oversized" &&
        gap.code !== "unsupported" &&
        gap.code !== "encrypted"
      )
        fail("invalid_input");
    } else if (outer.kind === "utf8" || outer.kind === "pdf") {
      exactKeys(outer, ["kind", "file"]);
      const file = record(outer.file);
      const fields = [
        "rootAlias",
        "relativePath",
        "uri",
        "sourceModifiedAt",
        "sha256",
        "byteLength",
        ...(outer.kind === "utf8" ? ["text"] : ["mediaType"]),
      ];
      exactKeys(file, fields);
      validateFileFields(file, config);
      if (
        typeof file.sha256 !== "string" ||
        !SHA256.test(file.sha256) ||
        !Number.isSafeInteger(file.byteLength) ||
        (file.byteLength as number) < 1 ||
        (file.byteLength as number) >
          (outer.kind === "pdf"
            ? MAX_DISCOVERED_PDF_BYTES
            : config.maxFileBytes)
      )
        fail("invalid_input");
      if (outer.kind === "utf8") {
        if (
          typeof file.text !== "string" ||
          Buffer.byteLength(file.text, "utf8") > (file.byteLength as number) ||
          Buffer.byteLength(file.text, "utf8") > config.maxFileBytes
        )
          fail("invalid_input");
      } else if (file.mediaType !== "application/pdf") {
        fail("invalid_input");
      }
    } else {
      fail("invalid_input");
    }
    const item = (outer.kind === "gap" ? outer.gap : outer.file) as Record<
      string,
      unknown
    >;
    const identity = `${item.rootAlias}\0${item.relativePath}`;
    if (identities.has(identity)) fail("invalid_input");
    identities.add(identity);
  }
  const encoded = Buffer.byteLength(JSON.stringify(copy), "utf8");
  if (
    encoded >
    config.maxFiles * config.maxFileBytes + MAX_BASELINE_OVERHEAD_BYTES
  )
    fail("invalid_input");
  return copy;
}

type CatalogSnapshot = Readonly<{
  revision: number;
  originals: ReturnType<ArchiveCatalog["listOriginals"]>;
  processings: ReturnType<ArchiveCatalog["listProcessings"]>;
  sha256: string;
}>;

async function catalogSnapshot(
  session: ArchiveRelocationSession<RunnerCheckpoint, JsonValue>,
): Promise<CatalogSnapshot> {
  const catalog = await openArchiveCatalog({ journal: session.journal });
  const value = {
    revision: catalog.revision,
    originals: catalog.listOriginals(),
    processings: catalog.listProcessings(),
  };
  return { ...value, sha256: digest(value) };
}

function validateCatalogSnapshot(value: CatalogSnapshot): void {
  if (
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.originals) ||
    !Array.isArray(value.processings) ||
    !SHA256.test(value.sha256) ||
    value.sha256 !==
      digest({
        revision: value.revision,
        originals: value.originals,
        processings: value.processings,
      })
  )
    fail("baseline_changed");
}

function validateOwnerReset(
  value: OwnerWatcherResetResult,
  sourceAccountId: string,
  watcherId: string,
): void {
  const row = record(value);
  exactKeys(row, ["sourceAccountId", "watcherId", "reused", "changedAt"]);
  if (
    row.sourceAccountId !== sourceAccountId ||
    row.watcherId !== watcherId ||
    typeof row.reused !== "boolean" ||
    !Number.isSafeInteger(row.changedAt) ||
    (row.changedAt as number) < 0
  )
    fail("watcher_reset_failed");
}

function doctorCheck(result: DoctorResult): void {
  const heartbeat = result.checks[3];
  if (
    result.version !== 2 ||
    result.state !== "degraded" ||
    result.checks.length !== 6 ||
    !isDeepStrictEqual(result.checks[0], {
      id: "config",
      state: "pass",
      code: "valid",
    }) ||
    !isDeepStrictEqual(result.checks[1], {
      id: "credential",
      state: "pass",
      code: "authorized",
    }) ||
    !isDeepStrictEqual(result.checks[2], {
      id: "deployment",
      state: "pass",
      code: "available",
    }) ||
    !isDeepStrictEqual(result.checks[4], {
      id: "roots",
      state: "pass",
      code: "safe",
    }) ||
    !isDeepStrictEqual(result.checks[5], {
      id: "journal",
      state: "warn",
      code: "contended",
    }) ||
    heartbeat?.id !== "heartbeat" ||
    !(
      (heartbeat.state === "pass" && heartbeat.code === "current") ||
      (heartbeat.state === "warn" &&
        (heartbeat.code === "awaiting_heartbeat" ||
          heartbeat.code === "overdue"))
    ) ||
    result.source.enumeration !== "complete" ||
    result.source.processing !== "complete" ||
    result.source.counts === undefined
  )
    fail("doctor_failed");
  const counts = result.source.counts;
  const numericCounts = [
    ...Object.values(counts.items),
    ...Object.values(counts.unresolvedEntries),
  ];
  if (
    numericCounts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    counts.items.pending !== 0 ||
    counts.items.failed !== 0 ||
    counts.items.needsReview !== 0 ||
    counts.items.explicitGap !== 0 ||
    counts.items.unavailable !== 0 ||
    counts.unresolvedEntries.needsReview !== 0
  )
    fail("doctor_failed");
}

class UnchangedScanTransport implements WorkerTransport {
  unexpectedWork:
    | {
        operation: "scan.appendPage" | "discovery.reserve" | "jobs.reserve";
        count: number;
      }
    | undefined;

  constructor(private readonly inner: WorkerTransport) {}

  async call(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkerResponse> {
    const operation = request.operation;
    if (this.unexpectedWork !== undefined) fail("unexpected_work");
    if (typeof operation !== "string" || !ALLOWED_OPERATIONS.has(operation))
      fail("unexpected_work");
    const response = await this.inner.call(request, signal);
    if (
      operation === "scan.appendPage" ||
      operation === "discovery.reserve" ||
      operation === "jobs.reserve"
    ) {
      let parsed: WorkerResponse;
      try {
        parsed = parseWorkerResponse(JSON.stringify(response), operation);
      } catch {
        fail("unexpected_work");
      }
      if (!("error" in parsed) && operation === "scan.appendPage") {
        const entries = parsed.entries;
        if (!Array.isArray(entries)) fail("unexpected_work");
        const changed = entries.filter(
          (entry) =>
            !!entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            (entry as { state?: unknown }).state !== "unchanged" &&
            (entry as { state?: unknown }).state !== "ignored_forgotten",
        ).length;
        if (changed > 0) {
          this.unexpectedWork = { operation, count: changed };
        }
      } else if (!("error" in parsed)) {
        const targets = parsed.targets;
        if (!Array.isArray(targets)) fail("unexpected_work");
        if (targets.length > 0) {
          this.unexpectedWork = { operation, count: targets.length };
        }
      }
    }
    return response;
  }
}

type ResumeAdapters = Readonly<{
  loadConfig: typeof loadPipelineConfig;
  observations: (config: PipelineConfig) => Promise<SourceObservation[]>;
  catalogSnapshot: typeof catalogSnapshot;
  transport: (config: PipelineConfig, credential: string) => WorkerTransport;
  doctor: typeof doctor;
  run: (
    config: PipelineConfig,
    session: ArchiveRelocationSession<RunnerCheckpoint, JsonValue>,
    transport: WorkerTransport,
  ) => Promise<PipelineRunResult>;
  now: () => number;
}>;

const DEFAULT_ADAPTERS: ResumeAdapters = {
  loadConfig: loadPipelineConfig,
  observations: async (config) => {
    const roots = await canonicalRoots(config);
    if (config.pdfDocQa) return discoverSourceObservations(config, roots);
    return (await discoverFiles(config, roots)).map((file) => ({
      kind: "utf8" as const,
      file,
    }));
  },
  catalogSnapshot,
  transport: (config, credential) =>
    new HttpWorkerTransport(config, credential),
  doctor,
  run: async (config, session, transport) =>
    new PipelineRunner(config, session.journal, transport).run(),
  now: Date.now,
};

async function verify(
  input: VerifyArchiveRelocationOwnerResumeInput,
  adapters: ResumeAdapters,
): Promise<ArchiveRelocationOwnerResumeProof> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("invalid_input");
  const recipe = parseOwnerArchiveRelocationRecipe(input.recipe);
  if (
    typeof input.credential !== "string" ||
    input.credential.length < 1 ||
    input.credential.length > 8_192 ||
    /[\x00-\x1f\x7f\s]/.test(input.credential) ||
    typeof input.ownerReset !== "function"
  )
    fail("invalid_input");
  let proposed: PipelineConfig;
  try {
    proposed = parseConfig(
      JSON.parse(recipe.body.localBindings.proposedConfigText) as unknown,
    );
  } catch {
    fail("invalid_input");
  }
  const actual = await adapters
    .loadConfig(recipe.body.localBindings.previousConfigPath)
    .catch(() => fail("session_not_ready"));
  if (!isDeepStrictEqual(actual, proposed)) fail("session_not_ready");
  const journal = input.session.journal;
  const checkpoint = journal.checkpoint;
  let rebound: Awaited<
    ReturnType<typeof journal.archiveRelocationRebindStatus>
  >;
  try {
    rebound = await journal.archiveRelocationRebindStatus({
      previousConfig: JSON.parse(
        recipe.body.localBindings.previousConfigText,
      ) as unknown,
      proposedConfig: JSON.parse(
        recipe.body.localBindings.proposedConfigText,
      ) as unknown,
    });
  } catch {
    fail("session_not_ready");
  }
  if (
    rebound.state !== "proposed" ||
    journal.directory !== proposed.journalDir ||
    journal.credentialStatus !== "current" ||
    journal.pending !== undefined ||
    !archiveCheckpointIsQuiescent(checkpoint) ||
    journal.watcherId === recipe.body.localBindings.previousWatcherId ||
    !UUID.test(journal.watcherId)
  )
    fail("session_not_ready");

  let relocationState;
  try {
    relocationState = validateArchiveRelocationState(
      await input.session.store.read(),
    );
  } catch {
    fail("session_not_ready");
  }
  if (
    relocationState === undefined ||
    relocationState.phase !== "rebound" ||
    !isDeepStrictEqual(
      relocationState.intent,
      relocationIntentFromRecipe(recipe),
    ) ||
    relocationState.newBoundary?.rootPath !==
      recipe.body.wholeRoot.newRootPath ||
    relocationState.verifiedAt === undefined
  )
    fail("session_not_ready");
  let persistedRelocation;
  try {
    persistedRelocation = await input.session.catalog.requireBoundaryRelocation(
      recipe.catalogRelocationId,
    );
  } catch {
    fail("session_not_ready");
  }
  const { verifiedAt, ...relocation } = persistedRelocation.relocation;
  if (
    verifiedAt !== relocationState.verifiedAt ||
    !isDeepStrictEqual(relocation, {
      relocationId: recipe.catalogRelocationId,
      oldBoundary: recipe.body.processing.oldBoundary,
      newBoundary: recipe.body.processing.newBoundary,
      artifacts: recipe.body.processing.artifacts,
    })
  )
    fail("session_not_ready");

  const baseline = frozenBaseline(input.filesystemBaseline, proposed);
  const beforeObservations = frozenBaseline(
    await adapters.observations(proposed),
    proposed,
  );
  if (!isDeepStrictEqual(beforeObservations, baseline))
    fail("baseline_changed");
  const beforeCatalog = await adapters.catalogSnapshot(input.session);
  validateCatalogSnapshot(beforeCatalog);

  const resetInput: OwnerWatcherResetInput = {
    sourceAccountId: proposed.sourceAccountId,
    requestId: recipe.watcherResetRequestId,
    expectedWatcherId: recipe.body.localBindings.previousWatcherId,
    nextWatcherId: journal.watcherId,
  };
  let reset: OwnerWatcherResetResult;
  try {
    reset = await input.ownerReset(resetInput);
    validateOwnerReset(reset, proposed.sourceAccountId, journal.watcherId);
  } catch (error) {
    if (
      error instanceof ArchiveRelocationOwnerResumeError &&
      error.code === "watcher_reset_failed"
    )
      throw error;
    fail("watcher_reset_failed");
  }

  const transport = new UnchangedScanTransport(
    adapters.transport(proposed, input.credential),
  );
  const doctorResult = await adapters
    .doctor(proposed, transport, input.credential)
    .catch(() => fail("doctor_failed"));
  doctorCheck(doctorResult);

  let scan: PipelineRunResult;
  try {
    scan = await adapters.run(proposed, input.session, transport);
  } catch {
    if (transport.unexpectedWork) fail("unexpected_work");
    fail("scan_failed");
  }
  if (transport.unexpectedWork) fail("unexpected_work");
  if (
    scan.state !== "complete" ||
    scan.code !== undefined ||
    !Number.isSafeInteger(scan.scanned) ||
    (scan.scanned as number) < 0 ||
    scan.scanned !== baseline.length ||
    scan.published !== 0
  )
    fail("scan_failed");
  const finalCheckpoint = journal.checkpoint;
  if (
    journal.pending !== undefined ||
    journal.credentialStatus !== "current" ||
    finalCheckpoint.phase !== "terminal" ||
    finalCheckpoint.outcome !== "complete" ||
    finalCheckpoint.credentialSessionActive !== false ||
    finalCheckpoint.scanned !== scan.scanned ||
    finalCheckpoint.published !== 0
  )
    fail("scan_failed");

  const afterObservations = frozenBaseline(
    await adapters.observations(proposed),
    proposed,
  );
  if (!isDeepStrictEqual(afterObservations, baseline)) fail("baseline_changed");
  const afterCatalog = await adapters.catalogSnapshot(input.session);
  validateCatalogSnapshot(afterCatalog);
  if (!isDeepStrictEqual(afterCatalog, beforeCatalog)) fail("baseline_changed");

  let heartbeat: WorkerResponse;
  try {
    heartbeat = await transport.call({
      protocolVersion: 1,
      operation: "diagnostics.heartbeat",
      spaceId: proposed.spaceId,
      sourceAccountId: proposed.sourceAccountId,
      watcherId: journal.watcherId,
      connectorVersion: CONNECTOR_VERSION,
    });
    parseHeartbeatResponse(
      heartbeat,
      proposed.sourceAccountId,
      journal.watcherId,
    );
  } catch {
    fail("heartbeat_failed");
  }
  const heartbeatRow = heartbeat as Record<string, unknown>;
  const completedAt = adapters.now();
  if (!Number.isSafeInteger(completedAt) || completedAt < 0)
    fail("invalid_input");
  return {
    version: 1,
    recipeHash: recipe.recipeHash,
    workflowRelocationId: recipe.workflowRelocationId,
    sourceAccountId: proposed.sourceAccountId,
    previousWatcherId: recipe.body.localBindings.previousWatcherId,
    currentWatcherId: journal.watcherId,
    watcherReset: { reused: reset.reused, changedAt: reset.changedAt },
    filesystem: { observationCount: baseline.length, sha256: digest(baseline) },
    catalog: {
      revision: beforeCatalog.revision,
      sha256: beforeCatalog.sha256,
    },
    doctor: doctorResult,
    scan: {
      state: "complete",
      scanned: scan.scanned,
      published: 0,
    },
    heartbeat: {
      accepted: true,
      receivedAt: heartbeatRow.receivedAt as number,
      nextExpectedAt: heartbeatRow.nextExpectedAt as number,
    },
    completedAt,
  };
}

export function verifyArchiveRelocationOwnerResume(
  input: VerifyArchiveRelocationOwnerResumeInput,
): Promise<ArchiveRelocationOwnerResumeProof> {
  return verify(input, DEFAULT_ADAPTERS);
}

/** @internal Synthetic test seam. Owner recovery must use the production entrypoint. */
export function __testOnlyVerifyArchiveRelocationOwnerResume(
  input: VerifyArchiveRelocationOwnerResumeInput,
  overrides: Partial<ResumeAdapters>,
): Promise<ArchiveRelocationOwnerResumeProof> {
  return verify(input, { ...DEFAULT_ADAPTERS, ...overrides });
}
