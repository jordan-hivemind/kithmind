import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import type { PrincipalRef } from "../../lib/spaces";
import { MAX_JOB_ATTEMPTS } from "../ingestion/limits";
import {
  activateGeneration,
  claimJob,
  failJob,
  renewJobLease,
} from "../ingestion/model";
import {
  insertParsedChunks,
  insertParsedDocuments,
  insertParsedEvidence,
  insertParsedPages,
  sealParsedPayload,
} from "../provenance/parsedStaging";
import { sha256Utf8 } from "../provenance/model";
import { requireWorkerSourceAccount } from "./auth";
import {
  requireBinaryGate,
  validateAdmittedArchiveChain,
} from "./archivedDiscovery";
import {
  requireCurrentDiscovery,
  WORKER_OPERATION_RECEIPT_MS,
} from "./discovery";
import { workerProtocolError, workerProtocolErrorCode } from "./errors";
import { WORKER_JOB_LEASE_MS } from "./jobs";
import { consumeWorkerMutationRateLimit } from "./rateLimit";
import type {
  WorkerParsedFailResult,
  WorkerParsedActivateResult,
  WorkerParsedRenewResult,
  WorkerParsedReserveResult,
  WorkerParsedStageBatchResult,
  WorkerParsedStageBeginResult,
  WorkerParsedStageSealResult,
  WorkerRequest,
} from "./protocol";

const CANDIDATE_TAKE = 12;
const CANDIDATE_INSPECTION_LIMIT = 16;
const RETRY_BACKOFF_CAP_MS = 60 * 60 * 1000;

type LoadedSource = Awaited<ReturnType<typeof requireWorkerSourceAccount>>;
type ParsedJob = {
  source: LoadedSource;
  current: Awaited<ReturnType<typeof requireCurrentDiscovery>>;
  job: Doc<"ingestJobs">;
  generation: Doc<"processingGenerations">;
  revision: Doc<"sourceRevisions">;
  artifact: Doc<"sourceParserArtifacts">;
  text: Doc<"sourceTextVersions">;
};

type ParsedLeaseRequest = Extract<
  WorkerRequest,
  {
    operation:
      | "jobs.renewParsed"
      | "jobs.failParsed"
      | "jobs.stageParsedBegin"
      | "jobs.stageParsedBatch"
      | "jobs.stageParsedSeal"
      | "jobs.activateParsed";
  }
>;

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw workerProtocolError("scan_conflict");
  return value;
}

async function digest(domain: string, value: unknown) {
  return sha256Utf8(`${domain}\0${JSON.stringify(value)}`);
}

function normalizeJobId(ctx: MutationCtx, value: string): Id<"ingestJobs"> {
  const id = ctx.db.normalizeId("ingestJobs", value);
  if (!id) throw workerProtocolError("invalid_request");
  return id;
}

async function loadParsedJob(
  ctx: MutationCtx,
  source: LoadedSource,
  id: Id<"ingestJobs">,
): Promise<ParsedJob> {
  requireBinaryGate(source);
  const job = await ctx.db.get(id);
  if (
    !job ||
    job.spaceId !== source.spaceId ||
    job.sourceAccountId !== source.account._id ||
    job.workerManaged !== true ||
    job.workerProcessingMode !== "parsed_pages_v1" ||
    !job.workerDiscoveryWorkId ||
    !Number.isSafeInteger(job.leaseEpoch) ||
    job.leaseEpoch < 0 ||
    !Number.isSafeInteger(job.attempts) ||
    job.attempts < 0
  )
    throw workerProtocolError("not_found");
  const current = await requireCurrentDiscovery(
    ctx,
    source,
    job.workerDiscoveryWorkId,
  );
  const generation = await ctx.db.get(job.processingGenerationId);
  if (
    !generation ||
    !generation.sourceTextVersionId ||
    !generation.parserArtifactId ||
    !generation.archiveSetDigest
  )
    throw workerProtocolError("scan_conflict");
  await validateAdmittedArchiveChain(ctx, source, current, {
    sourceRevisionId: job.sourceRevisionId,
    parserArtifactId: generation.parserArtifactId,
    sourceTextVersionId: generation.sourceTextVersionId,
    processingGenerationId: generation._id,
    ingestJobId: job._id,
    desiredProcessingEpoch: job.desiredProcessingEpoch,
    archiveSetDigest: generation.archiveSetDigest,
  });
  const [revision, artifact, text] = await Promise.all([
    ctx.db.get(job.sourceRevisionId),
    ctx.db.get(generation.parserArtifactId),
    ctx.db.get(generation.sourceTextVersionId),
  ]);
  if (!revision || !artifact || !text)
    throw workerProtocolError("scan_conflict");
  return { source, current, job, generation, revision, artifact, text };
}

function requireLease(
  loaded: ParsedJob,
  request: ParsedLeaseRequest,
  now: number,
): void {
  const { job, source } = loaded;
  if (
    (job.state !== "processing" && job.state !== "staged") ||
    job.workerLeaseOwnerCredentialId !== source.principal.credentialId ||
    job.leaseEpoch !== request.leaseEpoch ||
    job.leaseToken !== request.leaseToken ||
    !Number.isSafeInteger(job.leaseExpiresAt) ||
    job.leaseExpiresAt! <= now
  )
    throw workerProtocolError("lease_conflict");
}

function target(
  loaded: ParsedJob,
): WorkerParsedReserveResult["targets"][number] {
  const { job, current } = loaded;
  if (
    (job.state !== "processing" && job.state !== "staged") ||
    !job.leaseToken ||
    !Number.isSafeInteger(job.leaseExpiresAt)
  )
    throw workerProtocolError("scan_conflict");
  return {
    jobId: job._id,
    workId: current.work._id,
    sourceItemId: job.sourceItemId,
    observationEpoch: current.work.observationEpoch,
    processingEpoch: current.work.processingEpoch,
    state: job.state,
    leaseEpoch: job.leaseEpoch,
    leaseToken: job.leaseToken,
    leaseExpiresAt: job.leaseExpiresAt!,
  };
}

async function candidates(
  ctx: MutationCtx,
  sourceAccountId: Id<"sourceAccounts">,
  now: number,
) {
  const next = "by_source_mode_worker_state_next" as const;
  const lease = "by_source_mode_worker_state_lease" as const;
  const rows = await Promise.all([
    ctx.db
      .query("ingestJobs")
      .withIndex(next, (q) =>
        q
          .eq("sourceAccountId", sourceAccountId)
          .eq("workerProcessingMode", "parsed_pages_v1")
          .eq("workerManaged", true)
          .eq("state", "queued")
          .eq("nextAttemptAt", undefined),
      )
      .take(CANDIDATE_TAKE),
    ctx.db
      .query("ingestJobs")
      .withIndex(next, (q) =>
        q
          .eq("sourceAccountId", sourceAccountId)
          .eq("workerProcessingMode", "parsed_pages_v1")
          .eq("workerManaged", true)
          .eq("state", "failed")
          .gt("nextAttemptAt", undefined)
          .lte("nextAttemptAt", now),
      )
      .take(CANDIDATE_TAKE),
    ctx.db
      .query("ingestJobs")
      .withIndex(lease, (q) =>
        q
          .eq("sourceAccountId", sourceAccountId)
          .eq("workerProcessingMode", "parsed_pages_v1")
          .eq("workerManaged", true)
          .eq("state", "processing")
          .lte("leaseExpiresAt", now),
      )
      .take(CANDIDATE_TAKE),
    ctx.db
      .query("ingestJobs")
      .withIndex(lease, (q) =>
        q
          .eq("sourceAccountId", sourceAccountId)
          .eq("workerProcessingMode", "parsed_pages_v1")
          .eq("workerManaged", true)
          .eq("state", "staged")
          .lte("leaseExpiresAt", now),
      )
      .take(CANDIDATE_TAKE),
  ]);
  const unique = new Map<string, Doc<"ingestJobs">>();
  for (const row of rows.flat()) unique.set(row._id, row);
  return [...unique.values()].sort(
    (a, b) => a._creationTime - b._creationTime || a._id.localeCompare(b._id),
  );
}

async function quarantine(ctx: MutationCtx, job: Doc<"ingestJobs">) {
  await ctx.db.patch(job._id, {
    state: "needs_review",
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    workerLeaseOwnerCredentialId: undefined,
    nextAttemptAt: undefined,
  });
  const generation = await ctx.db.get(job.processingGenerationId);
  if (
    generation &&
    generation.spaceId === job.spaceId &&
    generation.sourceAccountId === job.sourceAccountId &&
    generation.sourceItemId === job.sourceItemId &&
    generation.sourceRevisionId === job.sourceRevisionId &&
    generation.state !== "ready"
  )
    await ctx.db.patch(generation._id, { state: "needs_review" });
}

export async function reserveParsedJobs(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.reserveParsed" }>,
  tokens: string[],
  now: number,
): Promise<WorkerParsedReserveResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  if (
    tokens.length < request.maxItems ||
    tokens
      .slice(0, request.maxItems)
      .some((token) => !/^[0-9a-f]{64}$/.test(token))
  )
    throw workerProtocolError("invalid_request");
  let requestedJobId: Id<"ingestJobs"> | undefined;
  let requestedJob: Doc<"ingestJobs"> | undefined;
  if (request.jobId !== undefined) {
    requestedJobId = normalizeJobId(ctx, request.jobId);
    requestedJob = (await ctx.db.get(requestedJobId)) ?? undefined;
    if (
      !requestedJob ||
      requestedJob.spaceId !== source.spaceId ||
      requestedJob.sourceAccountId !== source.account._id
    ) {
      throw workerProtocolError("not_found");
    }
  }
  const requestDigest =
    requestedJobId === undefined
      ? await digest("worker-jobs-reserve-parsed:v1", [
          source.account._id,
          request.requestId,
          request.maxItems,
        ])
      : await digest("worker-jobs-reserve-parsed-exact:v1", [
          source.account._id,
          request.requestId,
          request.maxItems,
          requestedJobId,
        ]);
  const matches = await ctx.db
    .query("workerReservationReceipts")
    .withIndex("by_sourceAccountId_and_kind_and_requestId", (q) =>
      q
        .eq("sourceAccountId", source.account._id)
        .eq("kind", "parsed_processing")
        .eq("requestId", request.requestId),
    )
    .take(2);
  if (matches.length > 1) throw workerProtocolError("scan_conflict");
  if (matches[0]) {
    const receipt = matches[0];
    if (
      receipt.spaceId !== source.spaceId ||
      receipt.actorUserId !== source.principal.userId ||
      receipt.actorCredentialId !== source.principal.credentialId
    )
      throw workerProtocolError("not_found");
    if (receipt.requestDigest !== requestDigest)
      throw workerProtocolError("request_conflict");
    if (receipt.expiresAt <= now)
      throw workerProtocolError("reservation_expired");
    const rows = await ctx.db
      .query("workerReservationTargets")
      .withIndex("by_receiptId_and_ordinal", (q) =>
        q.eq("receiptId", receipt._id),
      )
      .take(request.maxItems + 1);
    if (rows.length !== receipt.targetCount)
      throw workerProtocolError("scan_conflict");
    if (requestedJobId !== undefined && receipt.targetCount > 1)
      throw workerProtocolError("scan_conflict");
    const targets = [] as WorkerParsedReserveResult["targets"];
    for (const row of rows) {
      if (
        !row.ingestJobId ||
        (requestedJobId !== undefined && row.ingestJobId !== requestedJobId) ||
        row.discoveryWorkId ||
        row.spaceId !== source.spaceId ||
        row.sourceAccountId !== source.account._id ||
        row.leaseExpiresAt !== receipt.expiresAt
      )
        throw workerProtocolError("scan_conflict");
      const loaded = await loadParsedJob(ctx, source, row.ingestJobId);
      if (
        loaded.job.leaseEpoch !== row.leaseEpoch ||
        loaded.job.leaseToken !== row.leaseToken ||
        loaded.job.leaseExpiresAt !== row.leaseExpiresAt ||
        loaded.job.workerLeaseOwnerCredentialId !==
          source.principal.credentialId
      )
        throw workerProtocolError("reservation_expired");
      targets.push(target(loaded));
    }
    return {
      operation: "jobs.reserveParsed",
      receiptId: receipt._id,
      expiresAt: receipt.expiresAt,
      reused: true,
      targets,
    };
  }
  if (
    (source.account.inventoryEpoch ?? 0) !==
    (source.account.completedInventoryEpoch ?? 0)
  )
    throw workerProtocolError("scan_not_ready");
  await consumeWorkerMutationRateLimit(ctx, source, now);
  let candidateRows: Doc<"ingestJobs">[];
  if (requestedJob !== undefined) {
    candidateRows = [requestedJob];
  } else {
    candidateRows = (await candidates(ctx, source.account._id, now)).slice(
      0,
      CANDIDATE_INSPECTION_LIMIT,
    );
  }
  const claimed: ParsedJob[] = [];
  for (const candidate of candidateRows) {
    if (claimed.length >= request.maxItems) break;
    let loaded: ParsedJob | undefined;
    try {
      loaded = await loadParsedJob(ctx, source, candidate._id);
      const unleased =
        candidate.leaseToken === undefined &&
        candidate.leaseExpiresAt === undefined &&
        candidate.workerLeaseOwnerCredentialId === undefined;
      const expired =
        (candidate.state === "processing" || candidate.state === "staged") &&
        !!candidate.leaseToken &&
        Number.isSafeInteger(candidate.leaseExpiresAt) &&
        candidate.leaseExpiresAt! <= now &&
        !!candidate.workerLeaseOwnerCredentialId;
      const eligible =
        ((candidate.state === "queued" ||
          (candidate.state === "failed" &&
            candidate.error?.retryable === true &&
            candidate.nextAttemptAt !== undefined &&
            candidate.nextAttemptAt <= now)) &&
          unleased) ||
        expired;
      const activeLease =
        (candidate.state === "processing" || candidate.state === "staged") &&
        !!candidate.leaseToken &&
        Number.isSafeInteger(candidate.leaseExpiresAt) &&
        candidate.leaseExpiresAt! > now &&
        !!candidate.workerLeaseOwnerCredentialId;
      const deferredRetry =
        candidate.state === "failed" &&
        candidate.error?.retryable === true &&
        Number.isSafeInteger(candidate.nextAttemptAt) &&
        candidate.nextAttemptAt! > now &&
        unleased;
      const terminal =
        candidate.state === "ready" ||
        candidate.state === "needs_review" ||
        candidate.state === "obsolete_generation" ||
        (candidate.state === "failed" && candidate.error?.retryable !== true);
      if (
        requestedJobId !== undefined &&
        (terminal ||
          ((activeLease || deferredRetry) &&
            candidate.attempts < MAX_JOB_ATTEMPTS &&
            candidate.leaseEpoch < Number.MAX_SAFE_INTEGER))
      ) {
        continue;
      }
      if (
        !eligible ||
        candidate.attempts >= MAX_JOB_ATTEMPTS ||
        candidate.leaseEpoch >= Number.MAX_SAFE_INTEGER
      ) {
        await quarantine(ctx, candidate);
        continue;
      }
      const result = await claimJob(ctx, {
        principal: source.principal,
        jobId: candidate._id,
        leaseToken: tokens[claimed.length]!,
        leaseDurationMs: WORKER_JOB_LEASE_MS,
        now,
      });
      if (
        result.state === "obsolete_generation" ||
        result.leaseExpiresAt === undefined
      )
        throw workerProtocolError("stale_observation");
      await ctx.db.patch(candidate._id, {
        workerLeaseOwnerCredentialId: source.principal.credentialId,
      });
      claimed.push(await loadParsedJob(ctx, source, candidate._id));
    } catch (error) {
      const code = workerProtocolErrorCode(error);
      if (
        !code ||
        ![
          "not_authorized",
          "not_found",
          "scan_conflict",
          "stale_observation",
          "source_unavailable",
        ].includes(code)
      )
        throw error;
      await quarantine(ctx, loaded?.job ?? candidate);
    }
  }
  const expiresAt = safeAdd(now, WORKER_JOB_LEASE_MS);
  const receiptId = await ctx.db.insert("workerReservationReceipts", {
    spaceId: source.spaceId,
    sourceAccountId: source.account._id,
    kind: "parsed_processing",
    requestId: request.requestId,
    requestDigest,
    actorUserId: source.principal.userId,
    actorCredentialId: source.principal.credentialId,
    targetCount: claimed.length,
    createdAt: now,
    expiresAt,
    retireAt: safeAdd(now, WORKER_OPERATION_RECEIPT_MS),
  });
  for (let ordinal = 0; ordinal < claimed.length; ordinal += 1) {
    const row = target(claimed[ordinal]!);
    await ctx.db.insert("workerReservationTargets", {
      spaceId: source.spaceId,
      sourceAccountId: source.account._id,
      sourceItemId: claimed[ordinal]!.job.sourceItemId,
      receiptId,
      ordinal,
      ingestJobId: claimed[ordinal]!.job._id,
      leaseEpoch: row.leaseEpoch,
      leaseToken: row.leaseToken,
      leaseExpiresAt: row.leaseExpiresAt,
    });
  }
  return {
    operation: "jobs.reserveParsed",
    receiptId,
    expiresAt,
    reused: false,
    targets: claimed.map(target),
  };
}

type BinaryOperation = Doc<"workerBinaryOperationReceipts">["operation"];

async function operationIdentity(
  ctx: MutationCtx,
  source: LoadedSource,
  request: ParsedLeaseRequest,
  operation: BinaryOperation,
  now: number,
) {
  const jobId = normalizeJobId(ctx, request.jobId);
  const leaseTokenHash = await sha256Utf8(request.leaseToken);
  const requestDigest = await digest(`worker-${operation}:v1`, [
    source.account._id,
    request.requestId,
    jobId,
    request.leaseEpoch,
    leaseTokenHash,
    request,
  ]);
  const matches = await ctx.db
    .query("workerBinaryOperationReceipts")
    .withIndex("by_source_operation_request", (q) =>
      q
        .eq("sourceAccountId", source.account._id)
        .eq("operation", operation)
        .eq("requestId", request.requestId),
    )
    .take(2);
  if (matches.length > 1) throw workerProtocolError("scan_conflict");
  const prior = matches[0];
  if (
    prior &&
    (prior.spaceId !== source.spaceId ||
      prior.actorUserId !== source.principal.userId ||
      prior.actorCredentialId !== source.principal.credentialId)
  )
    throw workerProtocolError("not_found");
  if (
    prior &&
    (prior.requestDigest !== requestDigest ||
      prior.ingestJobId !== jobId ||
      prior.leaseEpoch !== request.leaseEpoch ||
      prior.leaseTokenHash !== leaseTokenHash)
  )
    throw workerProtocolError("request_conflict");
  if (prior && prior.retireAt <= now)
    throw workerProtocolError("reservation_expired");
  return { jobId, leaseTokenHash, requestDigest, prior };
}

function receiptBase(
  source: LoadedSource,
  loaded: ParsedJob,
  identity: Awaited<ReturnType<typeof operationIdentity>>,
  operation: BinaryOperation,
  request: ParsedLeaseRequest,
  now: number,
) {
  return {
    spaceId: source.spaceId,
    sourceAccountId: source.account._id,
    sourceItemId: loaded.job.sourceItemId,
    discoveryWorkId: loaded.current.work._id,
    operation,
    phase: "pending" as const,
    requestId: request.requestId,
    requestDigest: identity.requestDigest,
    actorUserId: source.principal.userId,
    actorCredentialId: source.principal.credentialId,
    leaseEpoch: request.leaseEpoch,
    leaseTokenHash: identity.leaseTokenHash,
    leaseExpiresAtAtRequest: loaded.job.leaseExpiresAt,
    sourceRevisionId: loaded.revision._id,
    parserArtifactId: loaded.artifact._id,
    sourceTextVersionId: loaded.text._id,
    processingGenerationId: loaded.generation._id,
    ingestJobId: loaded.job._id,
    desiredProcessingEpoch: loaded.job.desiredProcessingEpoch,
    archiveSetDigest: loaded.generation.archiveSetDigest,
    createdAt: now,
    retireAt: safeAdd(now, WORKER_OPERATION_RECEIPT_MS),
  };
}

function validateReceiptParents(
  loaded: ParsedJob,
  receipt: Doc<"workerBinaryOperationReceipts">,
) {
  if (
    receipt.sourceItemId !== loaded.job.sourceItemId ||
    receipt.discoveryWorkId !== loaded.current.work._id ||
    receipt.sourceRevisionId !== loaded.revision._id ||
    receipt.parserArtifactId !== loaded.artifact._id ||
    receipt.sourceTextVersionId !== loaded.text._id ||
    receipt.processingGenerationId !== loaded.generation._id ||
    receipt.ingestJobId !== loaded.job._id ||
    receipt.desiredProcessingEpoch !== loaded.job.desiredProcessingEpoch ||
    receipt.archiveSetDigest !== loaded.generation.archiveSetDigest
  )
    throw workerProtocolError("stale_observation");
}

export async function renewParsedJob(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.renewParsed" }>,
  now: number,
): Promise<WorkerParsedRenewResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const identity = await operationIdentity(
    ctx,
    source,
    request,
    "job_renew_parsed",
    now,
  );
  if (identity.prior) {
    const loaded = await loadParsedJob(ctx, source, identity.jobId);
    validateReceiptParents(loaded, identity.prior);
    if (
      identity.prior.phase !== "completed" ||
      (identity.prior.resultState !== "processing" &&
        identity.prior.resultState !== "staged") ||
      identity.prior.resultLeaseExpiresAt !== loaded.job.leaseExpiresAt
    )
      throw workerProtocolError("lease_conflict");
    return {
      operation: "jobs.renewParsed",
      jobId: loaded.job._id,
      state: identity.prior.resultState,
      leaseExpiresAt: identity.prior.resultLeaseExpiresAt!,
      reused: true,
    };
  }
  const loaded = await loadParsedJob(ctx, source, identity.jobId);
  requireLease(loaded, request, now);
  await consumeWorkerMutationRateLimit(ctx, source, now);
  const receiptId = await ctx.db.insert(
    "workerBinaryOperationReceipts",
    receiptBase(source, loaded, identity, "job_renew_parsed", request, now),
  );
  const result = await renewJobLease(ctx, {
    principal: source.principal,
    jobId: loaded.job._id,
    leaseEpoch: request.leaseEpoch,
    leaseToken: request.leaseToken,
    leaseDurationMs: WORKER_JOB_LEASE_MS,
    now,
  });
  if (
    result.state === "obsolete_generation" ||
    result.leaseExpiresAt === undefined
  )
    throw workerProtocolError("stale_observation");
  await ctx.db.patch(receiptId, {
    phase: "completed",
    resultState: result.state,
    resultLeaseExpiresAt: result.leaseExpiresAt,
  });
  return {
    operation: "jobs.renewParsed",
    jobId: loaded.job._id,
    state: result.state,
    leaseExpiresAt: result.leaseExpiresAt,
    reused: false,
  };
}

const FAILURE_POLICY = {
  worker_interrupted: {
    message: "The worker stopped before processing completed",
    retryable: true,
    needsReview: false,
    delay: 30_000,
  },
  worker_resource_exhausted: {
    message: "The worker exhausted a bounded processing resource",
    retryable: true,
    needsReview: false,
    delay: 300_000,
  },
  source_bytes_invalid: {
    message: "The retained source bytes no longer match their manifest",
    retryable: false,
    needsReview: true,
    delay: 0,
  },
  staging_invalid: {
    message: "The staged document payload failed server validation",
    retryable: false,
    needsReview: true,
    delay: 0,
  },
} as const;

export async function failParsedJob(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.failParsed" }>,
  now: number,
): Promise<WorkerParsedFailResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const identity = await operationIdentity(
    ctx,
    source,
    request,
    "job_fail_parsed",
    now,
  );
  if (identity.prior) {
    const loaded = await loadParsedJob(ctx, source, identity.jobId);
    validateReceiptParents(loaded, identity.prior);
    const receipt = identity.prior;
    if (
      receipt.phase !== "completed" ||
      (receipt.resultState !== "failed" &&
        receipt.resultState !== "needs_review" &&
        receipt.resultState !== "obsolete_generation") ||
      receipt.resultFailureCode !== request.failureCode ||
      receipt.resultFailureAt !== loaded.job.error?.at ||
      receipt.resultState !== loaded.job.state
    )
      throw workerProtocolError("stale_observation");
    if (receipt.resultRetryable === undefined)
      throw workerProtocolError("scan_conflict");
    return {
      operation: "jobs.failParsed",
      jobId: loaded.job._id,
      state: receipt.resultState,
      retryable: receipt.resultRetryable,
      ...(receipt.resultNextAttemptAt === undefined
        ? {}
        : { nextAttemptAt: receipt.resultNextAttemptAt }),
      failureCode: request.failureCode,
      reused: true,
    };
  }
  const loaded = await loadParsedJob(ctx, source, identity.jobId);
  requireLease(loaded, request, now);
  await consumeWorkerMutationRateLimit(ctx, source, now);
  const receiptId = await ctx.db.insert(
    "workerBinaryOperationReceipts",
    receiptBase(source, loaded, identity, "job_fail_parsed", request, now),
  );
  const policy = FAILURE_POLICY[request.failureCode];
  const needsReview =
    policy.needsReview || loaded.job.attempts >= MAX_JOB_ATTEMPTS;
  const retryable = policy.retryable && !needsReview;
  const nextAttemptAt = retryable
    ? safeAdd(
        now,
        Math.min(
          RETRY_BACKOFF_CAP_MS,
          policy.delay *
            2 ** Math.min(Math.max(loaded.job.attempts - 1, 0), 10),
        ),
      )
    : undefined;
  const result = await failJob(ctx, {
    principal: source.principal,
    jobId: loaded.job._id,
    leaseEpoch: request.leaseEpoch,
    leaseToken: request.leaseToken,
    now,
    code: request.failureCode,
    message: policy.message,
    retryable,
    ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
    needsReview,
  });
  if (
    result.state !== "failed" &&
    result.state !== "needs_review" &&
    result.state !== "obsolete_generation"
  )
    throw workerProtocolError("scan_conflict");
  const resultRetryable = result.retryable ?? false;
  await ctx.db.patch(receiptId, {
    phase: "completed",
    resultState: result.state,
    resultRetryable,
    resultNextAttemptAt: nextAttemptAt,
    resultFailureCode: request.failureCode,
    resultFailureAt: now,
  });
  return {
    operation: "jobs.failParsed",
    jobId: loaded.job._id,
    state: result.state,
    retryable: resultRetryable,
    ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
    failureCode: request.failureCode,
    reused: false,
  };
}

function stagePhaseCount(
  stage: Doc<"workerParsedStages">,
  phase: "pages" | "evidence" | "documents" | "chunks",
) {
  return phase === "pages"
    ? stage.expectedPageCount
    : phase === "evidence"
      ? stage.expectedEvidenceSpanCount
      : phase === "documents"
        ? stage.expectedDocumentCount
        : stage.expectedChunkCount;
}
function nextPhase(phase: "pages" | "evidence" | "documents" | "chunks") {
  return phase === "pages"
    ? ("evidence" as const)
    : phase === "evidence"
      ? ("documents" as const)
      : phase === "documents"
        ? ("chunks" as const)
        : ("seal" as const);
}

async function loadStage(ctx: MutationCtx, loaded: ParsedJob, value: string) {
  const id = ctx.db.normalizeId("workerParsedStages", value);
  const stage = id ? await ctx.db.get(id) : null;
  if (
    !stage ||
    stage.spaceId !== loaded.source.spaceId ||
    stage.sourceAccountId !== loaded.source.account._id ||
    stage.sourceItemId !== loaded.job.sourceItemId ||
    stage.discoveryWorkId !== loaded.current.work._id ||
    stage.ingestJobId !== loaded.job._id ||
    stage.processingGenerationId !== loaded.generation._id ||
    stage.sourceRevisionId !== loaded.revision._id ||
    stage.sourceTextVersionId !== loaded.text._id ||
    stage.parserArtifactId !== loaded.artifact._id ||
    stage.archiveSetDigest !== loaded.generation.archiveSetDigest ||
    stage.normalizedBundleDigest !== loaded.generation.normalizedBundleDigest
  )
    throw workerProtocolError("scan_conflict");
  return stage;
}

function requireStageDeclaration(
  loaded: ParsedJob,
  request: Extract<WorkerRequest, { operation: "jobs.stageParsedBegin" }>,
) {
  if (
    loaded.text.extractionFingerprint !== request.extractionFingerprint ||
    loaded.text.mappingManifestHash !== request.mappingManifestHash ||
    loaded.generation.normalizedBundleDigest !==
      request.normalizedBundleDigest ||
    loaded.generation.expectedPageCount !== request.expectedPageCount ||
    loaded.generation.expectedEvidenceSpanCount !==
      request.expectedEvidenceSpanCount ||
    loaded.generation.expectedDocumentCount !== request.expectedDocumentCount ||
    loaded.generation.expectedChunkCount !== request.expectedChunkCount
  )
    throw workerProtocolError("scan_conflict");
}

function requireStageMatchesDeclaration(
  stage: Doc<"workerParsedStages">,
  request: Extract<WorkerRequest, { operation: "jobs.stageParsedBegin" }>,
) {
  if (
    stage.normalizedBundleDigest !== request.normalizedBundleDigest ||
    stage.mappingManifestHash !== request.mappingManifestHash ||
    stage.expectedPageCount !== request.expectedPageCount ||
    stage.expectedEvidenceSpanCount !== request.expectedEvidenceSpanCount ||
    stage.expectedDocumentCount !== request.expectedDocumentCount ||
    stage.expectedChunkCount !== request.expectedChunkCount
  )
    throw workerProtocolError("request_conflict");
}

function requireStageLifecycle(
  loaded: ParsedJob,
  stage: Doc<"workerParsedStages">,
) {
  const sealed = stage.phase === "staged";
  if (
    (sealed &&
      (loaded.job.state !== "staged" ||
        loaded.generation.state !== "staged" ||
        loaded.text.evidenceSealed !== true ||
        stage.payloadManifestId !== loaded.generation.payloadManifestId)) ||
    (!sealed &&
      (loaded.job.state !== "processing" ||
        loaded.generation.state !== "processing" ||
        loaded.text.evidenceSealed))
  )
    throw workerProtocolError("scan_conflict");
}

function requireUnreclaimedStageReceipt(
  loaded: ParsedJob,
  receipt: Doc<"workerBinaryOperationReceipts">,
  request: Extract<
    ParsedLeaseRequest,
    {
      operation:
        | "jobs.stageParsedBegin"
        | "jobs.stageParsedBatch"
        | "jobs.stageParsedSeal";
    }
  >,
) {
  if (
    loaded.job.leaseEpoch !== request.leaseEpoch ||
    loaded.job.leaseToken !== request.leaseToken ||
    loaded.job.leaseExpiresAt !== receipt.leaseExpiresAtAtRequest ||
    loaded.job.workerLeaseOwnerCredentialId !==
      loaded.source.principal.credentialId
  )
    throw workerProtocolError("stale_observation");
}

export async function beginParsedStage(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.stageParsedBegin" }>,
  now: number,
): Promise<WorkerParsedStageBeginResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const identity = await operationIdentity(
    ctx,
    source,
    request,
    "job_stage_parsed_begin",
    now,
  );
  const loaded = await loadParsedJob(ctx, source, identity.jobId);
  requireStageDeclaration(loaded, request);
  if (identity.prior) {
    validateReceiptParents(loaded, identity.prior);
    requireUnreclaimedStageReceipt(loaded, identity.prior, request);
    if (identity.prior.phase !== "completed" || !identity.prior.stageId)
      throw workerProtocolError("scan_conflict");
    const stage = await loadStage(ctx, loaded, identity.prior.stageId);
    requireStageMatchesDeclaration(stage, request);
    requireStageLifecycle(loaded, stage);
    if (
      stage.phase !== identity.prior.stagePhase ||
      stage.nextOrdinal !== identity.prior.stageOrdinal
    )
      throw workerProtocolError("stale_observation");
    return {
      operation: "jobs.stageParsedBegin",
      jobId: loaded.job._id,
      stageId: stage._id,
      phase: stage.phase,
      nextOrdinal: stage.nextOrdinal,
      reused: true,
    };
  }
  const existing = await ctx.db
    .query("workerParsedStages")
    .withIndex("by_processingGenerationId", (q) =>
      q.eq("processingGenerationId", loaded.generation._id),
    )
    .take(2);
  if (existing.length > 1) throw workerProtocolError("scan_conflict");
  requireLease(loaded, request, now);
  if (existing[0]) {
    const stage = await loadStage(ctx, loaded, existing[0]._id);
    requireStageMatchesDeclaration(stage, request);
    requireStageLifecycle(loaded, stage);
    await consumeWorkerMutationRateLimit(ctx, source, now);
    const receiptId = await ctx.db.insert(
      "workerBinaryOperationReceipts",
      receiptBase(
        source,
        loaded,
        identity,
        "job_stage_parsed_begin",
        request,
        now,
      ),
    );
    await ctx.db.patch(receiptId, {
      phase: "completed",
      stageId: stage._id,
      stagePhase: stage.phase,
      stageOrdinal: stage.nextOrdinal,
    });
    return {
      operation: "jobs.stageParsedBegin",
      jobId: loaded.job._id,
      stageId: stage._id,
      phase: stage.phase,
      nextOrdinal: stage.nextOrdinal,
      reused: true,
    };
  }
  if (
    loaded.job.state !== "processing" ||
    loaded.generation.state !== "processing" ||
    loaded.text.evidenceSealed
  )
    throw workerProtocolError("scan_conflict");
  await consumeWorkerMutationRateLimit(ctx, source, now);
  const receiptId = await ctx.db.insert(
    "workerBinaryOperationReceipts",
    receiptBase(
      source,
      loaded,
      identity,
      "job_stage_parsed_begin",
      request,
      now,
    ),
  );
  const stageId = await ctx.db.insert("workerParsedStages", {
    spaceId: source.spaceId,
    sourceAccountId: source.account._id,
    sourceItemId: loaded.job.sourceItemId,
    discoveryWorkId: loaded.current.work._id,
    ingestJobId: loaded.job._id,
    processingGenerationId: loaded.generation._id,
    sourceRevisionId: loaded.revision._id,
    sourceTextVersionId: loaded.text._id,
    parserArtifactId: loaded.artifact._id,
    archiveSetDigest: loaded.generation.archiveSetDigest!,
    normalizedBundleDigest: request.normalizedBundleDigest,
    mappingManifestHash: request.mappingManifestHash,
    phase: "pages",
    nextOrdinal: 0,
    expectedPageCount: request.expectedPageCount,
    expectedEvidenceSpanCount: request.expectedEvidenceSpanCount,
    expectedDocumentCount: request.expectedDocumentCount,
    expectedChunkCount: request.expectedChunkCount,
    acceptedPageCount: 0,
    acceptedEvidenceSpanCount: 0,
    acceptedDocumentCount: 0,
    acceptedChunkCount: 0,
    pageIds: [],
    evidenceSpanIds: [],
    documentIds: [],
    chunkIds: [],
    pageBytes: 0,
    evidenceBytes: 0,
    documentBytes: 0,
    chunkBytes: 0,
    createdAt: now,
    updatedAt: now,
    retireAt: safeAdd(now, WORKER_OPERATION_RECEIPT_MS),
  });
  await ctx.db.patch(receiptId, {
    phase: "completed",
    stageId,
    stagePhase: "pages",
    stageOrdinal: 0,
  });
  return {
    operation: "jobs.stageParsedBegin",
    jobId: loaded.job._id,
    stageId,
    phase: "pages",
    nextOrdinal: 0,
    reused: false,
  };
}

export async function stageParsedBatch(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.stageParsedBatch" }>,
  now: number,
): Promise<WorkerParsedStageBatchResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const identity = await operationIdentity(
    ctx,
    source,
    request,
    "job_stage_parsed_batch",
    now,
  );
  const loaded = await loadParsedJob(ctx, source, identity.jobId);
  const stage = await loadStage(ctx, loaded, request.stageId);
  requireStageLifecycle(loaded, stage);
  if (identity.prior) {
    validateReceiptParents(loaded, identity.prior);
    requireUnreclaimedStageReceipt(loaded, identity.prior, request);
    if (
      identity.prior.phase !== "completed" ||
      identity.prior.stageId !== stage._id ||
      identity.prior.resultStagePhase !== stage.phase ||
      identity.prior.stageOrdinal !== stage.nextOrdinal ||
      identity.prior.stageAcceptedCount === undefined
    )
      throw workerProtocolError("stale_observation");
    return {
      operation: "jobs.stageParsedBatch",
      jobId: loaded.job._id,
      stageId: stage._id,
      committedPhase: request.phase,
      phase: stage.phase as Exclude<typeof stage.phase, "staged">,
      nextOrdinal: stage.nextOrdinal,
      acceptedCount: identity.prior.stageAcceptedCount,
      reused: true,
    };
  }
  requireLease(loaded, request, now);
  if (
    stage.phase !== request.phase ||
    stage.nextOrdinal !== request.ordinal ||
    request.rows.length >
      stagePhaseCount(stage, request.phase) - request.ordinal
  )
    throw workerProtocolError("scan_conflict");
  await consumeWorkerMutationRateLimit(ctx, source, now);
  const receiptId = await ctx.db.insert("workerBinaryOperationReceipts", {
    ...receiptBase(
      source,
      loaded,
      identity,
      "job_stage_parsed_batch",
      request,
      now,
    ),
    stageId: stage._id,
    stagePhase: request.phase,
    stageOrdinal: request.ordinal,
  });
  let added: { ids: string[]; bytes: number };
  if (request.phase === "pages")
    added = await insertParsedPages(ctx, stage, request.rows as never);
  else if (request.phase === "evidence")
    added = await insertParsedEvidence(ctx, stage, request.rows as never);
  else if (request.phase === "documents")
    added = await insertParsedDocuments(ctx, stage, request.rows as never);
  else added = await insertParsedChunks(ctx, stage, request.rows as never);
  const accepted = request.ordinal + request.rows.length;
  const phase =
    accepted === stagePhaseCount(stage, request.phase)
      ? nextPhase(request.phase)
      : request.phase;
  const nextOrdinal = phase === request.phase ? accepted : 0;
  const patch: Record<string, unknown> = { phase, nextOrdinal, updatedAt: now };
  if (request.phase === "pages")
    Object.assign(patch, {
      acceptedPageCount: accepted,
      pageIds: [...stage.pageIds, ...added.ids],
      pageBytes: safeAdd(stage.pageBytes, added.bytes),
    });
  else if (request.phase === "evidence")
    Object.assign(patch, {
      acceptedEvidenceSpanCount: accepted,
      evidenceSpanIds: [...stage.evidenceSpanIds, ...added.ids],
      evidenceBytes: safeAdd(stage.evidenceBytes, added.bytes),
    });
  else if (request.phase === "documents")
    Object.assign(patch, {
      acceptedDocumentCount: accepted,
      documentIds: [...stage.documentIds, ...added.ids],
      documentBytes: safeAdd(stage.documentBytes, added.bytes),
    });
  else
    Object.assign(patch, {
      acceptedChunkCount: accepted,
      chunkIds: [...stage.chunkIds, ...added.ids],
      chunkBytes: safeAdd(stage.chunkBytes, added.bytes),
    });
  await ctx.db.patch(stage._id, patch);
  await ctx.db.patch(receiptId, {
    phase: "completed",
    resultStagePhase: phase,
    stageOrdinal: nextOrdinal,
    stageAcceptedCount: request.rows.length,
  });
  return {
    operation: "jobs.stageParsedBatch",
    jobId: loaded.job._id,
    stageId: stage._id,
    committedPhase: request.phase,
    phase,
    nextOrdinal,
    acceptedCount: request.rows.length,
    reused: false,
  };
}

export async function sealParsedStage(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.stageParsedSeal" }>,
  now: number,
): Promise<WorkerParsedStageSealResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const identity = await operationIdentity(
    ctx,
    source,
    request,
    "job_stage_parsed_seal",
    now,
  );
  const loaded = await loadParsedJob(ctx, source, identity.jobId);
  const stage = await loadStage(ctx, loaded, request.stageId);
  requireStageLifecycle(loaded, stage);
  if (request.normalizedBundleDigest !== stage.normalizedBundleDigest)
    throw workerProtocolError("request_conflict");
  if (identity.prior) {
    validateReceiptParents(loaded, identity.prior);
    requireUnreclaimedStageReceipt(loaded, identity.prior, request);
    if (
      identity.prior.phase !== "completed" ||
      !identity.prior.payloadManifestId ||
      stage.phase !== "staged" ||
      stage.payloadManifestId !== identity.prior.payloadManifestId
    )
      throw workerProtocolError("stale_observation");
    return {
      operation: "jobs.stageParsedSeal",
      jobId: loaded.job._id,
      stageId: stage._id,
      payloadManifestId: identity.prior.payloadManifestId,
      state: "staged",
      actualPageCount: stage.acceptedPageCount,
      actualEvidenceSpanCount: stage.acceptedEvidenceSpanCount,
      actualDocumentCount: stage.acceptedDocumentCount,
      actualChunkCount: stage.acceptedChunkCount,
      reused: true,
    };
  }
  requireLease(loaded, request, now);
  if (stage.phase !== "seal" || stage.nextOrdinal !== 0)
    throw workerProtocolError("scan_conflict");
  await consumeWorkerMutationRateLimit(ctx, source, now);
  const receiptId = await ctx.db.insert("workerBinaryOperationReceipts", {
    ...receiptBase(
      source,
      loaded,
      identity,
      "job_stage_parsed_seal",
      request,
      now,
    ),
    stageId: stage._id,
    stagePhase: "seal",
    stageOrdinal: 0,
  });
  const sealed = await sealParsedPayload(ctx, stage, now);
  await ctx.db.patch(receiptId, {
    phase: "completed",
    resultState: "staged",
    payloadManifestId: sealed.manifestId,
    stagePhase: "staged",
  });
  return {
    operation: "jobs.stageParsedSeal",
    jobId: loaded.job._id,
    stageId: stage._id,
    payloadManifestId: sealed.manifestId,
    state: "staged",
    actualPageCount: sealed.pageCount,
    actualEvidenceSpanCount: sealed.evidenceSpanCount,
    actualDocumentCount: sealed.documentCount,
    actualChunkCount: sealed.chunkCount,
    reused: false,
  };
}

export async function activateParsedJob(
  ctx: MutationCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.activateParsed" }>,
  now: number,
): Promise<WorkerParsedActivateResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const identity = await operationIdentity(
    ctx,
    source,
    request,
    "job_activate_parsed",
    now,
  );
  if (identity.prior) {
    const loaded = await loadParsedJob(ctx, source, identity.jobId);
    validateReceiptParents(loaded, identity.prior);
    if (
      identity.prior.phase !== "completed" ||
      identity.prior.resultState !== "ready" ||
      identity.prior.resultActivatedAt === undefined ||
      loaded.job.state !== "ready" ||
      loaded.generation.state !== "ready" ||
      loaded.current.item.activeGenerationId !== loaded.generation._id ||
      loaded.generation.activatedAt !== identity.prior.resultActivatedAt
    )
      throw workerProtocolError("stale_observation");
    return {
      operation: "jobs.activateParsed",
      jobId: loaded.job._id,
      state: "ready",
      activatedAt: identity.prior.resultActivatedAt,
      ...(identity.prior.resultPreviousGenerationId === undefined
        ? {}
        : { previousGenerationId: identity.prior.resultPreviousGenerationId }),
      reused: true,
    };
  }
  const loaded = await loadParsedJob(ctx, source, identity.jobId);
  requireLease(loaded, request, now);
  if (
    loaded.job.state !== "staged" ||
    loaded.generation.state !== "staged" ||
    !loaded.generation.payloadManifestId
  )
    throw workerProtocolError("scan_conflict");
  await consumeWorkerMutationRateLimit(ctx, source, now);
  const receiptId = await ctx.db.insert(
    "workerBinaryOperationReceipts",
    receiptBase(source, loaded, identity, "job_activate_parsed", request, now),
  );
  let activated: Awaited<ReturnType<typeof activateGeneration>>;
  try {
    activated = await activateGeneration(ctx, {
      principal: source.principal,
      jobId: loaded.job._id,
      leaseEpoch: request.leaseEpoch,
      leaseToken: request.leaseToken,
      now,
    });
  } catch {
    throw workerProtocolError("scan_conflict");
  }
  if (activated.state !== "ready")
    throw workerProtocolError("stale_observation");
  await ctx.db.patch(receiptId, {
    phase: "completed",
    resultState: "ready",
    resultActivatedAt: activated.activatedAt,
    resultPreviousGenerationId: activated.previousGenerationId,
  });
  return {
    operation: "jobs.activateParsed",
    jobId: loaded.job._id,
    state: "ready",
    activatedAt: activated.activatedAt,
    ...(activated.previousGenerationId === undefined
      ? {}
      : { previousGenerationId: activated.previousGenerationId }),
    reused: false,
  };
}
