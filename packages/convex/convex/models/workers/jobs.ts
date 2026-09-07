import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import type { PrincipalRef } from "../../lib/spaces";
import { digestProcessingConfiguration } from "../ingestion/hash";
import { MAX_JOB_ATTEMPTS, MAX_STAGE_ROWS } from "../ingestion/limits";
import { planInlineText } from "../ingestion/inlineText";
import {
  activateGeneration,
  claimJob,
  createGenerationTextVersion,
  failJob,
  renewJobLease,
  stageGeneration,
  stageGenerationChunks,
  stageGenerationDocuments,
  stageGenerationEvidenceSpans,
  stageGenerationPages,
} from "../ingestion/model";
import { sha256Utf8 } from "../provenance/model";
import { requireWorkerSourceAccount } from "./auth";
import {
  requireCurrentDiscovery,
  validateAdmittedChain,
  type CurrentDiscovery,
  WORKER_OPERATION_RECEIPT_MS,
} from "./discovery";
import { workerProtocolError, workerProtocolErrorCode } from "./errors";
import { consumeWorkerMutationRateLimit } from "./model";
import type {
  WorkerJobActivateResult,
  WorkerJobFailResult,
  WorkerJobFailureCode,
  WorkerJobRenewResult,
  WorkerJobReserveResult,
  WorkerJobStageResult,
  WorkerRequest,
} from "./protocol";

export const WORKER_JOB_LEASE_MS = 5 * 60 * 1_000;
const PROCESSING_CANDIDATE_OVERFETCH = 12;
const PROCESSING_CANDIDATE_INSPECTION_LIMIT = 16;
const STAGE_DOCUMENT_KEY = "filesystem-document:0";
const RETRY_BACKOFF_CAP_MS = 60 * 60 * 1_000;

type LoadedWorkerSource = Awaited<
  ReturnType<typeof requireWorkerSourceAccount>
>;

type CurrentWorkerJob = CurrentDiscovery & {
  job: Doc<"ingestJobs">;
  revision: Doc<"sourceRevisions">;
  generation: Doc<"processingGenerations">;
};

type JobLeaseRequest = Extract<
  WorkerRequest,
  {
    operation: "jobs.renew" | "jobs.stageUtf8" | "jobs.activate" | "jobs.fail";
  }
>;

async function processingFingerprint(
  work: Doc<"workerDiscoveryWork">,
): Promise<string> {
  return digestProcessingConfiguration({
    extractionFingerprint: work.extractionFingerprint,
    extractorFingerprint: work.extractorFingerprint,
    recordSchemaFingerprint: work.recordSchemaFingerprint,
    normalizationFingerprint: work.normalizationFingerprint,
    chunkerFingerprint: work.chunkerFingerprint,
    correctionRevision: `filesystem-observation-v1:${work.processingEpoch}`,
  });
}

function safeAdd(now: number, duration: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, now + duration);
}

async function digest(domain: string, value: unknown): Promise<string> {
  return sha256Utf8(`${domain}\0${JSON.stringify(value)}`);
}

async function requestDigest(
  sourceAccountId: Id<"sourceAccounts">,
  request: JobLeaseRequest,
  jobId: Id<"ingestJobs">,
  leaseTokenHash: string,
): Promise<string> {
  return digest(`worker-${request.operation}:v1`, [
    sourceAccountId,
    request.requestId,
    jobId,
    request.leaseEpoch,
    leaseTokenHash,
    request.operation === "jobs.fail" ? request.failureCode : null,
  ]);
}

async function requireCurrentWorkerJob(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  jobId: Id<"ingestJobs">,
): Promise<CurrentWorkerJob> {
  const job = await ctx.db.get(jobId);
  if (
    !job ||
    job.spaceId !== source.spaceId ||
    job.sourceAccountId !== source.account._id ||
    job.workerManaged !== true ||
    job.workerDiscoveryWorkId === undefined
  ) {
    throw workerProtocolError("not_found");
  }
  if (
    !Number.isSafeInteger(job.leaseEpoch) ||
    job.leaseEpoch < 0 ||
    !Number.isSafeInteger(job.attempts) ||
    job.attempts < 0
  ) {
    throw workerProtocolError("scan_conflict");
  }
  const current = await requireCurrentDiscovery(
    ctx,
    source,
    job.workerDiscoveryWorkId,
  );
  if (
    current.work.state !== "admitted" ||
    current.work.ingestJobId !== job._id ||
    current.work.sourceRevisionId !== job.sourceRevisionId ||
    current.work.processingGenerationId !== job.processingGenerationId
  ) {
    throw workerProtocolError("stale_observation");
  }
  await validateAdmittedChain(
    ctx,
    current,
    {
      sourceRevisionId: job.sourceRevisionId,
      processingGenerationId: job.processingGenerationId,
      ingestJobId: job._id,
      desiredProcessingEpoch: job.desiredProcessingEpoch,
    },
    true,
  );
  const [revision, generation] = await Promise.all([
    ctx.db.get(job.sourceRevisionId),
    ctx.db.get(job.processingGenerationId),
  ]);
  if (!revision || !generation) throw workerProtocolError("scan_conflict");
  if (
    generation.processingFingerprint !==
    (await processingFingerprint(current.work))
  ) {
    throw workerProtocolError("scan_conflict");
  }
  return { ...current, job, revision, generation };
}

async function requireCurrentJobLease(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  jobId: Id<"ingestJobs">,
  leaseEpoch: number,
  leaseToken: string,
  now: number,
): Promise<CurrentWorkerJob> {
  const current = await requireCurrentWorkerJob(ctx, source, jobId);
  requireJobLease(current, source, leaseEpoch, leaseToken, now);
  return current;
}

function requireJobLease(
  current: CurrentWorkerJob,
  source: LoadedWorkerSource,
  leaseEpoch: number,
  leaseToken: string,
  now: number,
): void {
  if (
    (current.job.state !== "processing" && current.job.state !== "staged") ||
    current.job.workerLeaseOwnerCredentialId !==
      source.principal.credentialId ||
    current.job.leaseEpoch !== leaseEpoch ||
    current.job.leaseToken !== leaseToken ||
    current.job.leaseExpiresAt === undefined ||
    current.job.leaseExpiresAt <= now ||
    !Number.isSafeInteger(current.job.leaseEpoch) ||
    current.job.leaseEpoch < 0 ||
    !Number.isSafeInteger(current.job.attempts) ||
    current.job.attempts < 0
  ) {
    throw workerProtocolError("lease_conflict");
  }
}

function reservationTarget(
  current: CurrentWorkerJob,
): WorkerJobReserveResult["targets"][number] {
  const { job, work } = current;
  if (
    (job.state !== "processing" && job.state !== "staged") ||
    !job.leaseToken ||
    job.leaseExpiresAt === undefined
  ) {
    throw workerProtocolError("scan_conflict");
  }
  return {
    jobId: job._id,
    workId: work._id,
    sourceItemId: job.sourceItemId,
    observationEpoch: work.observationEpoch,
    processingEpoch: work.processingEpoch,
    state: job.state,
    leaseEpoch: job.leaseEpoch,
    leaseToken: job.leaseToken,
    leaseExpiresAt: job.leaseExpiresAt,
  };
}

async function replayProcessingReservation(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  receipt: Doc<"workerReservationReceipts">,
  now: number,
): Promise<WorkerJobReserveResult> {
  if (
    receipt.spaceId !== source.spaceId ||
    receipt.sourceAccountId !== source.account._id ||
    receipt.actorUserId !== source.principal.userId ||
    receipt.actorCredentialId !== source.principal.credentialId ||
    !Number.isSafeInteger(receipt.targetCount) ||
    receipt.targetCount < 0 ||
    receipt.targetCount > 4
  ) {
    throw workerProtocolError("not_found");
  }
  if (
    receipt.invalidatedAt !== undefined ||
    receipt.expiresAt <= now ||
    receipt.retireAt <= now
  ) {
    throw workerProtocolError("reservation_expired");
  }
  const rows = await ctx.db
    .query("workerReservationTargets")
    .withIndex("by_receiptId_and_ordinal", (q) =>
      q.eq("receiptId", receipt._id),
    )
    .take(5);
  if (rows.length !== receipt.targetCount) {
    throw workerProtocolError("reservation_expired");
  }
  const targets: WorkerJobReserveResult["targets"] = [];
  for (let ordinal = 0; ordinal < rows.length; ordinal += 1) {
    const row = rows[ordinal]!;
    if (
      row.ordinal !== ordinal ||
      row.spaceId !== source.spaceId ||
      row.sourceAccountId !== source.account._id ||
      row.discoveryWorkId !== undefined ||
      row.ingestJobId === undefined ||
      row.leaseExpiresAt !== receipt.expiresAt ||
      row.leaseExpiresAt <= now
    ) {
      throw workerProtocolError("reservation_expired");
    }
    const current = await requireCurrentWorkerJob(ctx, source, row.ingestJobId);
    if (
      current.job.sourceItemId !== row.sourceItemId ||
      current.job.workerLeaseOwnerCredentialId !==
        source.principal.credentialId ||
      current.job.leaseEpoch !== row.leaseEpoch ||
      current.job.leaseToken !== row.leaseToken ||
      current.job.leaseExpiresAt !== row.leaseExpiresAt ||
      (current.job.state !== "processing" && current.job.state !== "staged")
    ) {
      throw workerProtocolError("reservation_expired");
    }
    targets.push(reservationTarget(current));
  }
  return {
    operation: "jobs.reserve",
    receiptId: receipt._id,
    expiresAt: receipt.expiresAt,
    reused: true,
    targets,
  };
}

async function dueProcessingCandidates(
  ctx: MutationCtx,
  sourceAccountId: Id<"sourceAccounts">,
  now: number,
): Promise<Array<Doc<"ingestJobs">>> {
  const nextIndex = "by_source_worker_state_nextAttemptAt" as const;
  const leaseIndex = "by_source_worker_state_leaseExpiresAt" as const;
  const [
    queuedMissing,
    queued,
    failed,
    processingMissing,
    processing,
    stagedMissing,
    staged,
  ] = await Promise.all([
    ctx.db
      .query("ingestJobs")
      .withIndex(nextIndex, (q) =>
        q
          .eq("sourceAccountId", sourceAccountId)
          .eq("workerManaged", true)
          .eq("state", "queued")
          .eq("nextAttemptAt", undefined),
      )
      .take(PROCESSING_CANDIDATE_OVERFETCH),
    ctx.db
      .query("ingestJobs")
      .withIndex(nextIndex, (q) =>
        q
          .eq("sourceAccountId", sourceAccountId)
          .eq("workerManaged", true)
          .eq("state", "queued")
          .gt("nextAttemptAt", undefined)
          .lte("nextAttemptAt", now),
      )
      .take(PROCESSING_CANDIDATE_OVERFETCH),
    ctx.db
      .query("ingestJobs")
      .withIndex(nextIndex, (q) =>
        q
          .eq("sourceAccountId", sourceAccountId)
          .eq("workerManaged", true)
          .eq("state", "failed")
          .gt("nextAttemptAt", undefined)
          .lte("nextAttemptAt", now),
      )
      .take(PROCESSING_CANDIDATE_OVERFETCH),
    ctx.db
      .query("ingestJobs")
      .withIndex(leaseIndex, (q) =>
        q
          .eq("sourceAccountId", sourceAccountId)
          .eq("workerManaged", true)
          .eq("state", "processing")
          .eq("leaseExpiresAt", undefined),
      )
      .take(PROCESSING_CANDIDATE_OVERFETCH),
    ctx.db
      .query("ingestJobs")
      .withIndex(leaseIndex, (q) =>
        q
          .eq("sourceAccountId", sourceAccountId)
          .eq("workerManaged", true)
          .eq("state", "processing")
          .gt("leaseExpiresAt", undefined)
          .lte("leaseExpiresAt", now),
      )
      .take(PROCESSING_CANDIDATE_OVERFETCH),
    ctx.db
      .query("ingestJobs")
      .withIndex(leaseIndex, (q) =>
        q
          .eq("sourceAccountId", sourceAccountId)
          .eq("workerManaged", true)
          .eq("state", "staged")
          .eq("leaseExpiresAt", undefined),
      )
      .take(PROCESSING_CANDIDATE_OVERFETCH),
    ctx.db
      .query("ingestJobs")
      .withIndex(leaseIndex, (q) =>
        q
          .eq("sourceAccountId", sourceAccountId)
          .eq("workerManaged", true)
          .eq("state", "staged")
          .gt("leaseExpiresAt", undefined)
          .lte("leaseExpiresAt", now),
      )
      .take(PROCESSING_CANDIDATE_OVERFETCH),
  ]);
  const byId = new Map<string, Doc<"ingestJobs">>();
  for (const row of [
    ...queuedMissing,
    ...queued,
    ...failed,
    ...processingMissing,
    ...processing,
    ...stagedMissing,
    ...staged,
  ]) {
    const due =
      row.state === "queued" ||
      (row.state === "failed" &&
        row.nextAttemptAt !== undefined &&
        row.nextAttemptAt <= now) ||
      (row.state === "processing" &&
        (row.leaseExpiresAt === undefined || row.leaseExpiresAt <= now)) ||
      (row.state === "staged" &&
        (row.leaseExpiresAt === undefined || row.leaseExpiresAt <= now));
    if (due) byId.set(row._id, row);
  }
  return [...byId.values()].sort(
    (left, right) =>
      left._creationTime - right._creationTime ||
      left._id.localeCompare(right._id),
  );
}

async function quarantineCandidate(
  ctx: MutationCtx,
  job: Doc<"ingestJobs">,
): Promise<void> {
  await ctx.db.patch(job._id, {
    state: "needs_review",
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    workerLeaseOwnerCredentialId: undefined,
    nextAttemptAt: undefined,
  });
  const [generation, work] = await Promise.all([
    ctx.db.get(job.processingGenerationId),
    job.workerDiscoveryWorkId === undefined
      ? Promise.resolve(null)
      : ctx.db.get(job.workerDiscoveryWorkId),
  ]);
  if (
    generation &&
    work &&
    work.spaceId === job.spaceId &&
    work.sourceAccountId === job.sourceAccountId &&
    work.sourceItemId === job.sourceItemId &&
    work.ingestJobId === job._id &&
    work.sourceRevisionId === job.sourceRevisionId &&
    work.processingGenerationId === generation._id &&
    generation.spaceId === job.spaceId &&
    generation.sourceAccountId === job.sourceAccountId &&
    generation.sourceItemId === job.sourceItemId &&
    generation.sourceRevisionId === job.sourceRevisionId &&
    generation.state !== "ready"
  ) {
    await ctx.db.patch(generation._id, { state: "needs_review" });
  }
}

function hasInvalidReservationLeaseState(
  job: Doc<"ingestJobs">,
  now: number,
): boolean {
  if (job.state === "queued" || job.state === "failed") {
    return (
      job.leaseToken !== undefined ||
      job.leaseExpiresAt !== undefined ||
      job.workerLeaseOwnerCredentialId !== undefined
    );
  }
  if (job.state === "processing" || job.state === "staged") {
    return (
      !job.leaseToken ||
      job.leaseExpiresAt === undefined ||
      !Number.isSafeInteger(job.leaseExpiresAt) ||
      job.leaseExpiresAt < 0 ||
      job.leaseExpiresAt > now ||
      job.workerLeaseOwnerCredentialId === undefined
    );
  }
  return true;
}

export async function reserveProcessingJobs(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.reserve" }>,
  tokens: string[],
  now: number,
): Promise<WorkerJobReserveResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  if (tokens.length < request.maxItems) {
    throw workerProtocolError("invalid_request");
  }
  for (const token of tokens.slice(0, request.maxItems)) {
    if (!/^[0-9a-f]{64}$/.test(token)) {
      throw workerProtocolError("invalid_request");
    }
  }
  const digestValue = await digest("worker-jobs-reserve:v1", [
    source.account._id,
    request.requestId,
    request.maxItems,
  ]);
  const receipts = await ctx.db
    .query("workerReservationReceipts")
    .withIndex("by_sourceAccountId_and_kind_and_requestId", (q) =>
      q
        .eq("sourceAccountId", source.account._id)
        .eq("kind", "processing")
        .eq("requestId", request.requestId),
    )
    .take(2);
  if (receipts.length > 1) throw workerProtocolError("scan_conflict");
  if (receipts[0]) {
    if (receipts[0].requestDigest !== digestValue) {
      throw workerProtocolError("request_conflict");
    }
    return replayProcessingReservation(ctx, source, receipts[0], now);
  }
  if (
    (source.account.inventoryEpoch ?? 0) !==
    (source.account.completedInventoryEpoch ?? 0)
  ) {
    throw workerProtocolError("scan_not_ready");
  }
  await consumeWorkerMutationRateLimit(ctx, source, now);

  const candidates = await dueProcessingCandidates(
    ctx,
    source.account._id,
    now,
  );
  const claimed: CurrentWorkerJob[] = [];
  for (const candidate of candidates.slice(
    0,
    PROCESSING_CANDIDATE_INSPECTION_LIMIT,
  )) {
    if (claimed.length >= request.maxItems) break;
    if (
      candidate.spaceId !== source.spaceId ||
      candidate.sourceAccountId !== source.account._id
    ) {
      throw workerProtocolError("scan_conflict");
    }
    let current: CurrentWorkerJob | undefined;
    try {
      current = await requireCurrentWorkerJob(ctx, source, candidate._id);
      if (
        current.job.state !== candidate.state ||
        current.job.leaseEpoch !== candidate.leaseEpoch ||
        current.job.attempts !== candidate.attempts ||
        !Number.isSafeInteger(current.job.leaseEpoch) ||
        current.job.leaseEpoch < 0 ||
        !Number.isSafeInteger(current.job.attempts) ||
        current.job.attempts < 0 ||
        current.job.leaseEpoch >= Number.MAX_SAFE_INTEGER ||
        current.job.attempts >= MAX_JOB_ATTEMPTS ||
        hasInvalidReservationLeaseState(current.job, now) ||
        (current.job.state === "failed" &&
          current.job.error?.retryable !== true) ||
        (current.job.state === "failed" &&
          (current.job.nextAttemptAt === undefined ||
            current.job.nextAttemptAt > now))
      ) {
        await quarantineCandidate(ctx, current.job);
        continue;
      }
      let result: Awaited<ReturnType<typeof claimJob>>;
      try {
        result = await claimJob(ctx, {
          principal: source.principal,
          jobId: current.job._id,
          leaseToken: tokens[claimed.length]!,
          leaseDurationMs: WORKER_JOB_LEASE_MS,
          now,
        });
      } catch {
        throw workerProtocolError("lease_conflict");
      }
      if (
        result.state === "obsolete_generation" ||
        result.leaseExpiresAt === undefined
      ) {
        throw workerProtocolError("stale_observation");
      }
      await ctx.db.patch(current.job._id, {
        workerLeaseOwnerCredentialId: source.principal.credentialId,
      });
      const updated = await requireCurrentWorkerJob(
        ctx,
        source,
        current.job._id,
      );
      if (
        updated.job.state !== result.state ||
        updated.job.leaseEpoch !== result.leaseEpoch ||
        updated.job.leaseExpiresAt !== result.leaseExpiresAt ||
        updated.job.leaseToken !== tokens[claimed.length] ||
        updated.job.workerLeaseOwnerCredentialId !==
          source.principal.credentialId
      ) {
        throw workerProtocolError("scan_conflict");
      }
      claimed.push(updated);
    } catch (error) {
      const code = workerProtocolErrorCode(error);
      if (
        code !== "not_authorized" &&
        code !== "not_found" &&
        code !== "scan_conflict" &&
        code !== "stale_observation" &&
        code !== "source_unavailable"
      ) {
        throw error;
      }
      await quarantineCandidate(ctx, current?.job ?? candidate);
    }
  }

  const expiresAt = safeAdd(now, WORKER_JOB_LEASE_MS);
  const receiptId = await ctx.db.insert("workerReservationReceipts", {
    spaceId: source.spaceId,
    sourceAccountId: source.account._id,
    kind: "processing",
    requestId: request.requestId,
    requestDigest: digestValue,
    actorUserId: source.principal.userId,
    actorCredentialId: source.principal.credentialId,
    targetCount: claimed.length,
    createdAt: now,
    expiresAt,
    retireAt: safeAdd(now, WORKER_OPERATION_RECEIPT_MS),
  });
  for (let ordinal = 0; ordinal < claimed.length; ordinal += 1) {
    const current = claimed[ordinal]!;
    if (!current.job.leaseToken || current.job.leaseExpiresAt === undefined) {
      throw workerProtocolError("scan_conflict");
    }
    await ctx.db.insert("workerReservationTargets", {
      spaceId: source.spaceId,
      sourceAccountId: source.account._id,
      sourceItemId: current.item._id,
      receiptId,
      ordinal,
      ingestJobId: current.job._id,
      leaseEpoch: current.job.leaseEpoch,
      leaseToken: current.job.leaseToken,
      leaseExpiresAt: current.job.leaseExpiresAt,
    });
  }
  return {
    operation: "jobs.reserve",
    receiptId,
    expiresAt,
    reused: false,
    targets: claimed.map(reservationTarget),
  };
}

type JobOperation =
  "job_renew" | "job_stage_utf8" | "job_activate" | "job_fail";

function receiptOperation(request: JobLeaseRequest): JobOperation {
  switch (request.operation) {
    case "jobs.renew":
      return "job_renew";
    case "jobs.stageUtf8":
      return "job_stage_utf8";
    case "jobs.activate":
      return "job_activate";
    case "jobs.fail":
      return "job_fail";
  }
}

async function findOperationReceipt(
  ctx: MutationCtx,
  sourceAccountId: Id<"sourceAccounts">,
  operation: JobOperation,
  requestId: string,
): Promise<Doc<"workerOperationReceipts"> | undefined> {
  const matches = await ctx.db
    .query("workerOperationReceipts")
    .withIndex("by_sourceAccountId_and_operation_and_requestId", (q) =>
      q
        .eq("sourceAccountId", sourceAccountId)
        .eq("operation", operation)
        .eq("requestId", requestId),
    )
    .take(2);
  if (matches.length > 1) throw workerProtocolError("scan_conflict");
  return matches[0];
}

async function operationIdentity(
  ctx: MutationCtx,
  source: LoadedWorkerSource,
  request: JobLeaseRequest,
): Promise<{
  jobId: Id<"ingestJobs">;
  leaseTokenHash: string;
  requestDigest: string;
  operation: JobOperation;
}> {
  const jobId = ctx.db.normalizeId("ingestJobs", request.jobId);
  if (!jobId) throw workerProtocolError("invalid_request");
  const leaseTokenHash = await sha256Utf8(request.leaseToken);
  return {
    jobId,
    leaseTokenHash,
    requestDigest: await requestDigest(
      source.account._id,
      request,
      jobId,
      leaseTokenHash,
    ),
    operation: receiptOperation(request),
  };
}

function validateReceiptIdentity(
  source: LoadedWorkerSource,
  receipt: Doc<"workerOperationReceipts">,
  identity: Awaited<ReturnType<typeof operationIdentity>>,
  request: JobLeaseRequest,
  now: number,
): void {
  if (
    receipt.spaceId !== source.spaceId ||
    receipt.sourceAccountId !== source.account._id ||
    receipt.actorUserId !== source.principal.userId ||
    receipt.actorCredentialId !== source.principal.credentialId
  ) {
    throw workerProtocolError("not_found");
  }
  if (
    receipt.requestDigest !== identity.requestDigest ||
    receipt.ingestJobId !== identity.jobId ||
    receipt.leaseEpoch !== request.leaseEpoch ||
    receipt.leaseTokenHash !== identity.leaseTokenHash
  ) {
    throw workerProtocolError("request_conflict");
  }
  if (receipt.retireAt <= now) {
    throw workerProtocolError("reservation_expired");
  }
}

function validateReceiptParents(
  current: CurrentWorkerJob,
  receipt: Doc<"workerOperationReceipts">,
): void {
  if (
    receipt.sourceItemId !== current.item._id ||
    receipt.discoveryWorkId !== current.work._id ||
    receipt.sourceRevisionId !== current.revision._id ||
    receipt.processingGenerationId !== current.generation._id ||
    receipt.ingestJobId !== current.job._id ||
    receipt.desiredProcessingEpoch !== current.job.desiredProcessingEpoch
  ) {
    throw workerProtocolError("stale_observation");
  }
}

function operationReceiptBase(
  source: LoadedWorkerSource,
  current: CurrentWorkerJob,
  identity: Awaited<ReturnType<typeof operationIdentity>>,
  request: JobLeaseRequest,
  now: number,
) {
  return {
    spaceId: source.spaceId,
    sourceAccountId: source.account._id,
    sourceItemId: current.item._id,
    discoveryWorkId: current.work._id,
    operation: identity.operation,
    requestId: request.requestId,
    requestDigest: identity.requestDigest,
    actorUserId: source.principal.userId,
    actorCredentialId: source.principal.credentialId,
    leaseEpoch: request.leaseEpoch,
    leaseTokenHash: identity.leaseTokenHash,
    sourceRevisionId: current.revision._id,
    processingGenerationId: current.generation._id,
    ingestJobId: current.job._id,
    desiredProcessingEpoch: current.job.desiredProcessingEpoch,
    createdAt: now,
    retireAt: safeAdd(now, WORKER_OPERATION_RECEIPT_MS),
  };
}

function renewResult(
  receipt: Doc<"workerOperationReceipts">,
  reused: boolean,
): WorkerJobRenewResult {
  if (
    (receipt.resultState !== "processing" &&
      receipt.resultState !== "staged") ||
    receipt.resultLeaseExpiresAt === undefined
  ) {
    throw workerProtocolError("scan_conflict");
  }
  return {
    operation: "jobs.renew",
    jobId: receipt.ingestJobId,
    state: receipt.resultState,
    leaseExpiresAt: receipt.resultLeaseExpiresAt,
    reused,
  };
}

export async function renewProcessingJob(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.renew" }>,
  now: number,
): Promise<WorkerJobRenewResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const identity = await operationIdentity(ctx, source, request);
  const prior = await findOperationReceipt(
    ctx,
    source.account._id,
    identity.operation,
    request.requestId,
  );
  if (prior) {
    validateReceiptIdentity(source, prior, identity, request, now);
    if (prior.phase !== "completed") {
      throw workerProtocolError("scan_conflict");
    }
    const current = await requireCurrentJobLease(
      ctx,
      source,
      identity.jobId,
      request.leaseEpoch,
      request.leaseToken,
      now,
    );
    validateReceiptParents(current, prior);
    if (current.job.leaseExpiresAt !== prior.resultLeaseExpiresAt) {
      throw workerProtocolError("lease_conflict");
    }
    return renewResult(prior, true);
  }

  const current = await requireCurrentJobLease(
    ctx,
    source,
    identity.jobId,
    request.leaseEpoch,
    request.leaseToken,
    now,
  );
  await consumeWorkerMutationRateLimit(ctx, source, now);
  let renewed: Awaited<ReturnType<typeof renewJobLease>>;
  try {
    renewed = await renewJobLease(ctx, {
      principal: source.principal,
      jobId: current.job._id,
      leaseEpoch: request.leaseEpoch,
      leaseToken: request.leaseToken,
      leaseDurationMs: WORKER_JOB_LEASE_MS,
      now,
    });
  } catch {
    throw workerProtocolError("lease_conflict");
  }
  if (
    renewed.state === "obsolete_generation" ||
    renewed.leaseExpiresAt === undefined
  ) {
    throw workerProtocolError("stale_observation");
  }
  const receiptId = await ctx.db.insert("workerOperationReceipts", {
    ...operationReceiptBase(source, current, identity, request, now),
    phase: "completed",
    resultState: renewed.state,
    resultLeaseExpiresAt: renewed.leaseExpiresAt,
  });
  const receipt = await ctx.db.get(receiptId);
  if (!receipt) throw workerProtocolError("scan_conflict");
  return renewResult(receipt, false);
}

function stageResult(
  receipt: Doc<"workerOperationReceipts">,
  reused: boolean,
): WorkerJobStageResult {
  if (
    receipt.resultState !== "staged" ||
    receipt.resultActualPageCount === undefined ||
    receipt.resultActualEvidenceSpanCount === undefined ||
    receipt.resultActualDocumentCount === undefined ||
    receipt.resultActualChunkCount === undefined
  ) {
    throw workerProtocolError("scan_conflict");
  }
  return {
    operation: "jobs.stageUtf8",
    jobId: receipt.ingestJobId,
    state: "staged",
    actualPageCount: receipt.resultActualPageCount,
    actualEvidenceSpanCount: receipt.resultActualEvidenceSpanCount,
    actualDocumentCount: receipt.resultActualDocumentCount,
    actualChunkCount: receipt.resultActualChunkCount,
    reused,
  };
}

type StageIntent =
  | { state: "pending"; chunkCount: number }
  | { state: "completed"; result: WorkerJobStageResult };

async function requireStageReceipt(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.stageUtf8" }>,
  now: number,
): Promise<{
  source: LoadedWorkerSource;
  current: CurrentWorkerJob;
  receipt: Doc<"workerOperationReceipts">;
}> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const identity = await operationIdentity(ctx, source, request);
  const receipt = await findOperationReceipt(
    ctx,
    source.account._id,
    identity.operation,
    request.requestId,
  );
  if (!receipt) throw workerProtocolError("request_conflict");
  validateReceiptIdentity(source, receipt, identity, request, now);
  if (receipt.phase !== "pending")
    throw workerProtocolError("request_conflict");
  const current = await requireCurrentWorkerJob(ctx, source, identity.jobId);
  validateReceiptParents(current, receipt);
  requireJobLease(current, source, request.leaseEpoch, request.leaseToken, now);
  await planCurrentText(current);
  return { source, current, receipt };
}

async function planCurrentText(current: CurrentWorkerJob) {
  const plan = planInlineText(current.revision.inlineText);
  const expectedProcessingFingerprint = await processingFingerprint(
    current.work,
  );
  if (
    current.generation.processingFingerprint !==
      expectedProcessingFingerprint ||
    plan.chunkerFingerprint !== current.work.chunkerFingerprint ||
    plan.expectedPageCount !== current.generation.expectedPageCount ||
    plan.expectedEvidenceSpanCount !==
      current.generation.expectedEvidenceSpanCount ||
    plan.expectedDocumentCount !== current.generation.expectedDocumentCount ||
    plan.expectedChunkCount !== current.generation.expectedChunkCount ||
    plan.expectedEventCount !== (current.generation.expectedEventCount ?? 0) ||
    plan.expectedObservationCount !==
      (current.generation.expectedObservationCount ?? 0)
  ) {
    throw workerProtocolError("scan_conflict");
  }
  return plan;
}

export async function beginProcessingStage(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.stageUtf8" }>,
  now: number,
): Promise<StageIntent> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const identity = await operationIdentity(ctx, source, request);
  const prior = await findOperationReceipt(
    ctx,
    source.account._id,
    identity.operation,
    request.requestId,
  );
  if (prior) {
    validateReceiptIdentity(source, prior, identity, request, now);
    if (prior.phase === "completed") {
      const current = await requireCurrentWorkerJob(
        ctx,
        source,
        identity.jobId,
      );
      validateReceiptParents(current, prior);
      await planCurrentText(current);
      requireJobLease(
        current,
        source,
        request.leaseEpoch,
        request.leaseToken,
        now,
      );
      if (
        current.job.state !== "staged" ||
        current.generation.actualPageCount !== prior.resultActualPageCount ||
        current.generation.actualEvidenceSpanCount !==
          prior.resultActualEvidenceSpanCount ||
        current.generation.actualDocumentCount !==
          prior.resultActualDocumentCount ||
        current.generation.actualChunkCount !== prior.resultActualChunkCount
      ) {
        throw workerProtocolError("stale_observation");
      }
      return { state: "completed", result: stageResult(prior, true) };
    }
    if (prior.phase !== "pending") throw workerProtocolError("scan_conflict");
    const current = await requireCurrentWorkerJob(ctx, source, identity.jobId);
    validateReceiptParents(current, prior);
    requireJobLease(
      current,
      source,
      request.leaseEpoch,
      request.leaseToken,
      now,
    );
    return {
      state: "pending",
      chunkCount: (await planCurrentText(current)).chunks.length,
    };
  }

  const current = await requireCurrentJobLease(
    ctx,
    source,
    identity.jobId,
    request.leaseEpoch,
    request.leaseToken,
    now,
  );
  const plan = await planCurrentText(current);
  await consumeWorkerMutationRateLimit(ctx, source, now);
  await ctx.db.insert("workerOperationReceipts", {
    ...operationReceiptBase(source, current, identity, request, now),
    phase: "pending",
  });
  return { state: "pending", chunkCount: plan.chunks.length };
}

function leaseArgs(
  source: LoadedWorkerSource,
  current: CurrentWorkerJob,
  request: Extract<WorkerRequest, { operation: "jobs.stageUtf8" }>,
  now: number,
) {
  return {
    principal: source.principal,
    jobId: current.job._id,
    leaseEpoch: request.leaseEpoch,
    leaseToken: request.leaseToken,
    now,
  };
}

function requireStageState(value: { state: string }): void {
  if (value.state !== "processing" && value.state !== "staged") {
    throw workerProtocolError("stale_observation");
  }
}

export async function stageProcessingText(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.stageUtf8" }>,
  now: number,
): Promise<void> {
  const { source, current } = await requireStageReceipt(
    ctx,
    principal,
    request,
    now,
  );
  let result: Awaited<ReturnType<typeof createGenerationTextVersion>>;
  try {
    result = await createGenerationTextVersion(ctx, {
      ...leaseArgs(source, current, request, now),
      text: current.revision.inlineText,
    });
  } catch {
    throw workerProtocolError("scan_conflict");
  }
  requireStageState(result);
}

export async function stageProcessingPage(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.stageUtf8" }>,
  now: number,
): Promise<void> {
  const { source, current } = await requireStageReceipt(
    ctx,
    principal,
    request,
    now,
  );
  const plan = await planCurrentText(current);
  let result: Awaited<ReturnType<typeof stageGenerationPages>>;
  try {
    result = await stageGenerationPages(ctx, {
      ...leaseArgs(source, current, request, now),
      pages: [
        {
          ordinal: 0,
          start: 0,
          end: plan.text.length,
          text: plan.text,
        },
      ],
    });
  } catch {
    throw workerProtocolError("scan_conflict");
  }
  requireStageState(result);
}

async function requireStagedPage(
  ctx: MutationCtx,
  current: CurrentWorkerJob,
): Promise<Doc<"sourcePages">> {
  const sourceTextVersionId = current.generation.sourceTextVersionId;
  if (!sourceTextVersionId) throw workerProtocolError("scan_conflict");
  const pages = await ctx.db
    .query("sourcePages")
    .withIndex("by_sourceTextVersionId", (q) =>
      q.eq("sourceTextVersionId", sourceTextVersionId),
    )
    .take(2);
  const page = pages[0];
  if (
    pages.length !== 1 ||
    !page ||
    page.spaceId !== current.source.spaceId ||
    page.ordinal !== 0 ||
    page.start !== 0 ||
    page.end !== current.revision.inlineText.length ||
    page.text !== current.revision.inlineText
  ) {
    throw workerProtocolError("scan_conflict");
  }
  return page;
}

export async function stageProcessingSpanBatch(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.stageUtf8" }>,
  offset: number,
  now: number,
): Promise<{ nextOffset: number; done: boolean }> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw workerProtocolError("invalid_request");
  }
  const { source, current } = await requireStageReceipt(
    ctx,
    principal,
    request,
    now,
  );
  const [plan, page] = await Promise.all([
    planCurrentText(current),
    requireStagedPage(ctx, current),
  ]);
  if (offset > plan.chunks.length) throw workerProtocolError("scan_conflict");
  const batch = plan.chunks.slice(offset, offset + MAX_STAGE_ROWS);
  if (batch.length === 0 && offset !== plan.chunks.length) {
    throw workerProtocolError("scan_conflict");
  }
  let result: Awaited<ReturnType<typeof stageGenerationEvidenceSpans>>;
  try {
    result = await stageGenerationEvidenceSpans(ctx, {
      ...leaseArgs(source, current, request, now),
      spans: batch.map((chunk) => ({
        sourcePageId: page._id,
        ordinal: chunk.ordinal,
        start: chunk.start,
        end: chunk.end,
        locator: { kind: "page" as const, label: "Filesystem text" },
      })),
    });
  } catch {
    throw workerProtocolError("scan_conflict");
  }
  requireStageState(result);
  const nextOffset = offset + batch.length;
  return { nextOffset, done: nextOffset === plan.chunks.length };
}

async function stagedSpans(
  ctx: MutationCtx,
  current: CurrentWorkerJob,
  expectedCount: number,
): Promise<Array<Doc<"evidenceSpans">>> {
  const sourceTextVersionId = current.generation.sourceTextVersionId;
  if (!sourceTextVersionId) throw workerProtocolError("scan_conflict");
  const spans = await ctx.db
    .query("evidenceSpans")
    .withIndex("by_sourceTextVersionId", (q) =>
      q.eq("sourceTextVersionId", sourceTextVersionId),
    )
    .take(expectedCount + 1);
  const ordered = [...spans].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  if (
    ordered.length !== expectedCount ||
    ordered.some(
      (span, ordinal) =>
        span.ordinal !== ordinal ||
        span.spaceId !== current.source.spaceId ||
        span.sourceRevisionId !== current.revision._id ||
        span.sourceTextVersionId !== sourceTextVersionId,
    )
  ) {
    throw workerProtocolError("scan_conflict");
  }
  return ordered;
}

export async function stageProcessingDocument(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.stageUtf8" }>,
  now: number,
): Promise<void> {
  const { source, current } = await requireStageReceipt(
    ctx,
    principal,
    request,
    now,
  );
  const plan = await planCurrentText(current);
  const spans = await stagedSpans(ctx, current, plan.chunks.length);
  const matches = await ctx.db
    .query("documents")
    .withIndex("by_processingGenerationId_and_documentKey", (q) =>
      q
        .eq("processingGenerationId", current.generation._id)
        .eq("documentKey", STAGE_DOCUMENT_KEY),
    )
    .take(2);
  if (matches.length > 1) throw workerProtocolError("scan_conflict");
  const prior = matches[0];
  if (
    prior &&
    (prior.spaceId !== source.spaceId ||
      prior.sourceItemId !== current.item._id ||
      prior.sourceRevisionId !== current.revision._id ||
      prior.sourceTextVersionId !== current.generation.sourceTextVersionId)
  ) {
    throw workerProtocolError("scan_conflict");
  }
  let result: Awaited<ReturnType<typeof stageGenerationDocuments>>;
  try {
    result = await stageGenerationDocuments(ctx, {
      ...leaseArgs(source, current, request, now),
      documents: [
        {
          documentKey: STAGE_DOCUMENT_KEY,
          title: prior?.title ?? current.work.title ?? "Untitled",
          docType: prior?.docType ?? current.work.docType ?? "generic",
          capturedAt: prior?.capturedAt ?? current.work.capturedAt,
          evidenceSpanIds: spans.map((span) => span._id),
        },
      ],
    });
  } catch {
    throw workerProtocolError("scan_conflict");
  }
  requireStageState(result);
}

async function stagedDocument(
  ctx: MutationCtx,
  current: CurrentWorkerJob,
): Promise<Doc<"documents">> {
  const rows = await ctx.db
    .query("documents")
    .withIndex("by_processingGenerationId_and_documentKey", (q) =>
      q
        .eq("processingGenerationId", current.generation._id)
        .eq("documentKey", STAGE_DOCUMENT_KEY),
    )
    .take(2);
  const document = rows[0];
  if (
    rows.length !== 1 ||
    !document ||
    document.spaceId !== current.source.spaceId ||
    document.sourceItemId !== current.item._id ||
    document.sourceRevisionId !== current.revision._id ||
    document.sourceTextVersionId !== current.generation.sourceTextVersionId
  ) {
    throw workerProtocolError("scan_conflict");
  }
  return document;
}

export async function stageProcessingChunkBatch(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.stageUtf8" }>,
  offset: number,
  now: number,
): Promise<{ nextOffset: number; done: boolean }> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw workerProtocolError("invalid_request");
  }
  const { source, current } = await requireStageReceipt(
    ctx,
    principal,
    request,
    now,
  );
  const plan = await planCurrentText(current);
  if (offset > plan.chunks.length) throw workerProtocolError("scan_conflict");
  const [document, spans] = await Promise.all([
    stagedDocument(ctx, current),
    stagedSpans(ctx, current, plan.chunks.length),
  ]);
  const batch = plan.chunks.slice(offset, offset + MAX_STAGE_ROWS);
  if (batch.length === 0 && offset !== plan.chunks.length) {
    throw workerProtocolError("scan_conflict");
  }
  let result: Awaited<ReturnType<typeof stageGenerationChunks>>;
  try {
    result = await stageGenerationChunks(ctx, {
      ...leaseArgs(source, current, request, now),
      chunks: batch.map((chunk, index) => {
        const span = spans[offset + index];
        if (!span) throw workerProtocolError("scan_conflict");
        return {
          documentId: document._id,
          ordinal: chunk.ordinal,
          text: chunk.text,
          evidenceSpanIds: [span._id],
        };
      }),
    });
  } catch (error) {
    if (workerProtocolErrorCode(error)) throw error;
    throw workerProtocolError("scan_conflict");
  }
  requireStageState(result);
  const nextOffset = offset + batch.length;
  return { nextOffset, done: nextOffset === plan.chunks.length };
}

export async function completeProcessingStage(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.stageUtf8" }>,
  now: number,
): Promise<WorkerJobStageResult> {
  const { source, current, receipt } = await requireStageReceipt(
    ctx,
    principal,
    request,
    now,
  );
  let result: Awaited<ReturnType<typeof stageGeneration>>;
  try {
    result = await stageGeneration(
      ctx,
      leaseArgs(source, current, request, now),
    );
  } catch {
    throw workerProtocolError("scan_conflict");
  }
  if (result.state !== "staged") {
    throw workerProtocolError("stale_observation");
  }
  await ctx.db.patch(receipt._id, {
    phase: "completed",
    resultState: "staged",
    resultActualPageCount: result.actualPageCount,
    resultActualEvidenceSpanCount: result.actualEvidenceSpanCount,
    resultActualDocumentCount: result.actualDocumentCount,
    resultActualChunkCount: result.actualChunkCount,
  });
  const completed = await ctx.db.get(receipt._id);
  if (!completed) throw workerProtocolError("scan_conflict");
  return stageResult(completed, false);
}

function activationResult(
  receipt: Doc<"workerOperationReceipts">,
  reused: boolean,
): WorkerJobActivateResult {
  if (
    receipt.resultState !== "ready" ||
    receipt.resultActivatedAt === undefined
  ) {
    throw workerProtocolError("scan_conflict");
  }
  return {
    operation: "jobs.activate",
    jobId: receipt.ingestJobId,
    state: "ready",
    activatedAt: receipt.resultActivatedAt,
    ...(receipt.resultPreviousGenerationId === undefined
      ? {}
      : { previousGenerationId: receipt.resultPreviousGenerationId }),
    reused,
  };
}

export async function activateProcessingJob(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.activate" }>,
  now: number,
): Promise<WorkerJobActivateResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const identity = await operationIdentity(ctx, source, request);
  const prior = await findOperationReceipt(
    ctx,
    source.account._id,
    identity.operation,
    request.requestId,
  );
  if (prior) {
    validateReceiptIdentity(source, prior, identity, request, now);
    if (prior.phase !== "completed") throw workerProtocolError("scan_conflict");
    const current = await requireCurrentWorkerJob(ctx, source, identity.jobId);
    validateReceiptParents(current, prior);
    if (
      current.job.state !== "ready" ||
      current.generation.state !== "ready" ||
      current.item.activeGenerationId !== current.generation._id ||
      current.generation.activatedAt !== prior.resultActivatedAt
    ) {
      throw workerProtocolError("stale_observation");
    }
    return activationResult(prior, true);
  }

  const current = await requireCurrentJobLease(
    ctx,
    source,
    identity.jobId,
    request.leaseEpoch,
    request.leaseToken,
    now,
  );
  if (current.job.state !== "staged") {
    throw workerProtocolError("scan_conflict");
  }
  await consumeWorkerMutationRateLimit(ctx, source, now);
  let activated: Awaited<ReturnType<typeof activateGeneration>>;
  try {
    activated = await activateGeneration(ctx, {
      principal: source.principal,
      jobId: current.job._id,
      leaseEpoch: request.leaseEpoch,
      leaseToken: request.leaseToken,
      now,
    });
  } catch {
    throw workerProtocolError("scan_conflict");
  }
  if (activated.state !== "ready") {
    throw workerProtocolError("stale_observation");
  }
  const receiptId = await ctx.db.insert("workerOperationReceipts", {
    ...operationReceiptBase(source, current, identity, request, now),
    phase: "completed",
    resultState: "ready",
    resultActivatedAt: activated.activatedAt,
    ...(activated.previousGenerationId === undefined
      ? {}
      : { resultPreviousGenerationId: activated.previousGenerationId }),
  });
  const receipt = await ctx.db.get(receiptId);
  if (!receipt) throw workerProtocolError("scan_conflict");
  return activationResult(receipt, false);
}

const FAILURE_POLICY: Record<
  WorkerJobFailureCode,
  {
    message: string;
    retryable: boolean;
    needsReview: boolean;
    baseDelayMs: number;
  }
> = {
  worker_interrupted: {
    message: "The worker stopped before processing completed",
    retryable: true,
    needsReview: false,
    baseDelayMs: 30_000,
  },
  worker_resource_exhausted: {
    message: "The worker exhausted a bounded processing resource",
    retryable: true,
    needsReview: false,
    baseDelayMs: 5 * 60_000,
  },
  source_bytes_invalid: {
    message: "The retained source bytes no longer match their manifest",
    retryable: false,
    needsReview: true,
    baseDelayMs: 0,
  },
  staging_invalid: {
    message: "The staged document payload failed server validation",
    retryable: false,
    needsReview: true,
    baseDelayMs: 0,
  },
};

function failureResult(
  receipt: Doc<"workerOperationReceipts">,
  failureCode: WorkerJobFailureCode,
  reused: boolean,
): WorkerJobFailResult {
  if (
    (receipt.resultState !== "failed" &&
      receipt.resultState !== "needs_review" &&
      receipt.resultState !== "obsolete_generation") ||
    receipt.resultRetryable === undefined ||
    receipt.resultFailureCode !== failureCode ||
    receipt.resultFailureAt === undefined
  ) {
    throw workerProtocolError("scan_conflict");
  }
  return {
    operation: "jobs.fail",
    jobId: receipt.ingestJobId,
    state: receipt.resultState,
    retryable: receipt.resultRetryable,
    ...(receipt.resultNextAttemptAt === undefined
      ? {}
      : { nextAttemptAt: receipt.resultNextAttemptAt }),
    failureCode,
    reused,
  };
}

function retryAt(now: number, attempts: number, baseDelayMs: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 10);
  return safeAdd(
    now,
    Math.min(RETRY_BACKOFF_CAP_MS, baseDelayMs * 2 ** exponent),
  );
}

export async function failProcessingJob(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.fail" }>,
  now: number,
): Promise<WorkerJobFailResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const identity = await operationIdentity(ctx, source, request);
  const prior = await findOperationReceipt(
    ctx,
    source.account._id,
    identity.operation,
    request.requestId,
  );
  if (prior) {
    validateReceiptIdentity(source, prior, identity, request, now);
    if (prior.phase !== "completed") throw workerProtocolError("scan_conflict");
    const current = await requireCurrentWorkerJob(ctx, source, identity.jobId);
    validateReceiptParents(current, prior);
    if (
      current.job.state !== prior.resultState ||
      current.job.leaseEpoch !== prior.leaseEpoch ||
      current.job.error?.code !== request.failureCode ||
      current.job.error?.retryable !== prior.resultRetryable ||
      current.job.error?.at !== prior.resultFailureAt ||
      current.job.nextAttemptAt !== prior.resultNextAttemptAt
    ) {
      throw workerProtocolError("stale_observation");
    }
    return failureResult(prior, request.failureCode, true);
  }

  const current = await requireCurrentJobLease(
    ctx,
    source,
    identity.jobId,
    request.leaseEpoch,
    request.leaseToken,
    now,
  );
  const policy = FAILURE_POLICY[request.failureCode];
  const needsReview =
    policy.needsReview || current.job.attempts >= MAX_JOB_ATTEMPTS;
  const shouldRetry = policy.retryable && !needsReview;
  const nextAttemptAt = shouldRetry
    ? retryAt(now, current.job.attempts, policy.baseDelayMs)
    : undefined;
  await consumeWorkerMutationRateLimit(ctx, source, now);
  let failed: Awaited<ReturnType<typeof failJob>>;
  try {
    failed = await failJob(ctx, {
      principal: source.principal,
      jobId: current.job._id,
      leaseEpoch: request.leaseEpoch,
      leaseToken: request.leaseToken,
      now,
      code: request.failureCode,
      message: policy.message,
      retryable: shouldRetry,
      ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
      needsReview,
    });
  } catch {
    throw workerProtocolError("lease_conflict");
  }
  if (
    failed.state !== "failed" &&
    failed.state !== "needs_review" &&
    failed.state !== "obsolete_generation"
  ) {
    throw workerProtocolError("scan_conflict");
  }
  const receiptId = await ctx.db.insert("workerOperationReceipts", {
    ...operationReceiptBase(source, current, identity, request, now),
    phase: "completed",
    resultState: failed.state,
    resultRetryable:
      failed.state === "obsolete_generation" ? false : failed.retryable,
    ...(failed.state === "failed" &&
    failed.retryable &&
    nextAttemptAt !== undefined
      ? { resultNextAttemptAt: nextAttemptAt }
      : {}),
    resultFailureCode: request.failureCode,
    resultFailureAt: now,
  });
  const receipt = await ctx.db.get(receiptId);
  if (!receipt) throw workerProtocolError("scan_conflict");
  return failureResult(receipt, request.failureCode, false);
}
