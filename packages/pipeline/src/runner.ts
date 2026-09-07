import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";

import {
  canonicalRoots,
  discoverFiles,
  FilesystemFailure,
  readUtf8File,
  toFsUri,
  type SafeRoot,
} from "./filesystem.js";
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
  type FilePlan,
  type InventoryIdentity,
  type JobLease,
  type RunnerCheckpoint,
} from "./runnerState.js";
import { parseWorkerResponse } from "./transport.js";
import type {
  DiscoveryFile,
  IdentityBinding,
  PipelineConfig,
  PipelineRunResult,
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
class PipelineWorkerError extends Error {
  constructor(readonly code: string) {
    super("Pipeline worker operation failed");
  }
}

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

function samePlan(file: DiscoveryFile, plan: FilePlan): boolean {
  return (
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
        | "discovery_admit";
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
    published: 0,
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
  constructor(
    private readonly config: PipelineConfig,
    private readonly journal: Journal<RunnerCheckpoint, JsonValue>,
    private readonly transport: WorkerTransport,
  ) {}

  private async sourceStatus(): Promise<Record<string, unknown>> {
    return object(
      await this.transport.call(request(this.config, "source.status")),
      "source.status",
    );
  }

  private validatePendingBody(
    operation: JournalOperation,
    body: Record<string, unknown>,
  ): void {
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
          connectorVersion: "p2-8-text-v1",
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
          entries: checkpoint.files.slice(offset, offset + 4).map((plan) => ({
            ...(checkpoint.mode === "identity_recovery" ||
            plan.externalId === undefined
              ? {}
              : { externalId: plan.externalId }),
            uri: toFsUri(plan.rootAlias, plan.relativePath),
            title: basename(plan.relativePath),
            sourceModifiedAt: plan.sourceModifiedAt,
            content: {
              status: "ready",
              sha256: plan.sha256,
              byteLength: plan.byteLength,
            },
          })),
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
    ) => RunnerCheckpoint,
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
      this.validatePendingBody(operation, parsed as Record<string, unknown>);
    }
    const sendExact = async (
      requestBody: string,
      exactOperation: JournalOperation,
    ): Promise<unknown> => {
      if (exactOperation !== operation) {
        throw new PipelineWorkerError("journal_phase_conflict");
      }
      const parsed = JSON.parse(requestBody) as Record<string, unknown>;
      this.validatePendingBody(exactOperation, parsed);
      return await this.transport.call(parsed);
    };
    const nextCheckpoint = ({
      checkpoint,
      result,
    }: ReplayContext<
      RunnerCheckpoint,
      JsonValue
    >): CheckpointTransition<RunnerCheckpoint> => {
      const next = transition(checkpoint, asWorkerResponse(result));
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
    const discovered = await discoverFiles(this.config, roots);
    const plans = discovered.map(filePlan);
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
          connectorVersion: "p2-8-text-v1",
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
          return code === "rate_limited"
            ? current
            : plannedTerminal(current, code);
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
          return code === "rate_limited"
            ? current
            : scanTerminal(current, "failed", code, true);
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
          entries: pagePlans.map((plan) => ({
            ...(checkpoint.mode === "identity_recovery" ||
            plan.externalId === undefined
              ? {}
              : { externalId: plan.externalId }),
            uri: toFsUri(plan.rootAlias, plan.relativePath),
            title: basename(plan.relativePath),
            sourceModifiedAt: plan.sourceModifiedAt,
            content: {
              status: "ready",
              sha256: plan.sha256,
              byteLength: plan.byteLength,
            },
          })),
        }),
      (current, response) => {
        if (current.phase !== "append") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return code === "rate_limited"
            ? current
            : scanTerminal(current, "failed", code, true);
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
      const current = await discoverFiles(this.config, roots);
      health = sameSnapshot(current, checkpoint.files)
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
          return code === "rate_limited"
            ? current
            : scanTerminal(current, "failed", code, true);
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
      (current, response) => {
        if (current.phase !== "reconcile") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return code === "rate_limited"
            ? current
            : scanTerminal(current, "failed", code, true);
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
          return code === "rate_limited"
            ? current
            : scanTerminal(current, "failed", code, true);
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
            published: 0,
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
      if (!plan) {
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
          return code === "rate_limited"
            ? current
            : scanTerminal(current, "failed", code, true);
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
          return code === "rate_limited"
            ? current
            : processingTerminal(current, "failed", code, undefined, true);
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
            : code === "rate_limited"
              ? current
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
          return code === "rate_limited"
            ? current
            : processingTerminal(current, "failed", code, undefined, true);
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
          return code === "rate_limited"
            ? current
            : processingTerminal(current, "failed", code, undefined, true);
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
            : code === "rate_limited"
              ? current
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
          return code === "rate_limited"
            ? current
            : processingTerminal(current, "failed", code, undefined, true);
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
          return code === "rate_limited"
            ? current
            : processingTerminal(
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

  async run(): Promise<PipelineRunResult> {
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
    }
    throw new PipelineWorkerError("worker_step_limit");
  }

  async runSafely(): Promise<PipelineRunResult> {
    try {
      return await this.run();
    } catch (error) {
      return {
        state: "failed",
        code:
          error instanceof FilesystemFailure ||
          error instanceof PipelineWorkerError
            ? error.code
            : "worker_failed",
      };
    }
  }
}
