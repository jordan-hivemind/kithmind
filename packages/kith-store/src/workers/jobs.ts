import type {
  WorkerJobActivateResult,
  WorkerJobFailResult,
  WorkerJobFailureCode,
  WorkerJobRenewResult,
  WorkerJobReserveResult,
  WorkerJobStageResult,
  WorkerRequest,
} from "@repo/worker-protocol/request";
import type { PrincipalRef } from "../identity/authorization.js";

import {
  clearInventoryParseFailed,
  markInventoryParseFailed,
} from "../documents/inventory.js";
import {
  planInlineText,
  digestProcessingConfiguration,
  sha256Hex,
} from "../ingestion/inline.js";
import { newKithId, KITH_ID } from "../ids.js";
import {
  activateSourceItemGeneration,
  createOrGetTextVersion,
  inspectGenerationPayload,
  setSourceItemFailure,
  stageChunks,
  stageDocuments,
  stageEvidenceSpans,
  stagePages,
} from "../provenance/model.js";
import {
  camelizeProcessingGeneration,
  camelizeSourceRevision,
  type ProcessingGenerationRow,
  type SourceRevisionRow,
} from "../provenance/rows.js";
import { requireInlineSourceRevision } from "../provenance/representations.js";
import { requireWorkerSourceAccount, type LoadedWorkerSource } from "./auth.js";
import { at, digest, exec, nowPlus, row, rows, type WorkerCtx } from "./db.js";
import {
  requireCurrentDiscovery,
  validateAdmittedChain,
  WORKER_OPERATION_RECEIPT_MS,
  type CurrentDiscovery,
} from "./discovery.js";
import { workerProtocolError, workerProtocolErrorCode } from "./errors.js";
import {
  nextWorkerActivation,
  recordWorkerActivation,
  touchWorkerPublicationEmbedding,
} from "./publication.js";
import { consumeWorkerMutationRateLimit } from "./rateLimit.js";
import {
  camelizeIngestJob,
  camelizeOperationReceipt,
  camelizeReservationReceipt,
  camelizeReservationTarget,
  type IngestJobRow,
  type WorkerOperationReceiptRow,
  type WorkerReservationReceiptRow,
} from "./rows.js";

export const WORKER_JOB_LEASE_MS = 5 * 60 * 1_000;
export const MAX_WORKER_JOB_ATTEMPTS = 8;
const STAGE_DOCUMENT_KEY = "filesystem-document:0";
const RETRY_BACKOFF_CAP_MS = 60 * 60 * 1_000;

type CurrentWorkerJob = CurrentDiscovery & {
  job: IngestJobRow;
  revision: SourceRevisionRow;
  generation: ProcessingGenerationRow;
};

type JobLeaseRequest = Extract<
  WorkerRequest,
  { operation: "jobs.renew" | "jobs.stageUtf8" | "jobs.activate" | "jobs.fail" }
>;

type JobOperation =
  "job_renew" | "job_stage_utf8" | "job_activate" | "job_fail";

function isTransactionAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "40001" || error.code === "40P01")
  );
}

async function processingFingerprint(
  current: CurrentDiscovery,
): Promise<string> {
  return digestProcessingConfiguration({
    extractionFingerprint: current.work.extractionFingerprint,
    extractorFingerprint: current.work.extractorFingerprint,
    recordSchemaFingerprint: current.work.recordSchemaFingerprint,
    normalizationFingerprint: current.work.normalizationFingerprint,
    chunkerFingerprint: current.work.chunkerFingerprint,
    correctionRevision: `filesystem-observation-v1:${current.work.processingEpoch}`,
  });
}

export async function requireCurrentWorkerJob(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  jobId: string,
): Promise<CurrentWorkerJob> {
  if (!KITH_ID.test(jobId)) workerProtocolError("invalid_request");
  const rawJob = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.ingest_jobs WHERE id = $1 FOR UPDATE",
    [jobId],
  );
  if (!rawJob) workerProtocolError("not_found");
  const job = camelizeIngestJob(rawJob);
  if (
    job.spaceId !== source.spaceId ||
    job.sourceAccountId !== source.account.id ||
    job.workerManaged !== true ||
    job.workerDiscoveryWorkId === null ||
    job.workerProcessingMode !== null
  )
    workerProtocolError("not_found");
  if (
    !Number.isSafeInteger(job.leaseEpoch) ||
    job.leaseEpoch < 0 ||
    !Number.isSafeInteger(job.attempts) ||
    job.attempts < 0
  ) {
    workerProtocolError("scan_conflict");
  }
  const current = await requireCurrentDiscovery(
    ctx,
    source,
    job.workerDiscoveryWorkId,
  );
  if (
    current.work.state !== "admitted" ||
    current.work.ingestJobId !== job.id ||
    current.work.sourceRevisionId !== job.sourceRevisionId ||
    current.work.processingGenerationId !== job.processingGenerationId
  ) {
    workerProtocolError("stale_observation");
  }
  await validateAdmittedChain(
    ctx,
    current,
    {
      sourceRevisionId: job.sourceRevisionId,
      processingGenerationId: job.processingGenerationId,
      ingestJobId: job.id,
      desiredProcessingEpoch: job.desiredProcessingEpoch,
    },
    true,
  );
  const rawRevision = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_revisions WHERE id = $1",
    [job.sourceRevisionId],
  );
  const rawGeneration = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.processing_generations WHERE id = $1",
    [job.processingGenerationId],
  );
  if (!rawRevision || !rawGeneration) workerProtocolError("scan_conflict");
  const revision = camelizeSourceRevision(rawRevision);
  const generation = camelizeProcessingGeneration(rawGeneration);
  if (
    generation.processingFingerprint !== (await processingFingerprint(current))
  )
    workerProtocolError("scan_conflict");
  return { ...current, job, revision, generation };
}

function validLease(
  current: CurrentWorkerJob,
  source: LoadedWorkerSource,
  leaseEpoch: number,
  leaseToken: string,
  now: number,
): boolean {
  return (
    (current.job.state === "processing" || current.job.state === "staged") &&
    current.job.workerLeaseOwnerCredentialId ===
      source.principal.credentialId &&
    current.job.leaseEpoch === leaseEpoch &&
    current.job.leaseToken === leaseToken &&
    current.job.leaseExpiresAt instanceof Date &&
    current.job.leaseExpiresAt.getTime() > now
  );
}

export async function requireCurrentJobLease(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  jobId: string,
  leaseEpoch: number,
  leaseToken: string,
): Promise<CurrentWorkerJob> {
  const current = await requireCurrentWorkerJob(ctx, source, jobId);
  if (!validLease(current, source, leaseEpoch, leaseToken, ctx.now))
    workerProtocolError("lease_conflict");
  return current;
}

function reservationTarget(
  current: CurrentWorkerJob,
): WorkerJobReserveResult["targets"][number] {
  const { job, work } = current;
  if (
    (job.state !== "processing" && job.state !== "staged") ||
    !job.leaseToken ||
    !(job.leaseExpiresAt instanceof Date)
  )
    workerProtocolError("scan_conflict");
  return {
    jobId: job.id,
    workId: work.id,
    sourceItemId: job.sourceItemId,
    observationEpoch: work.observationEpoch,
    processingEpoch: work.processingEpoch,
    state: job.state,
    leaseEpoch: job.leaseEpoch,
    leaseToken: job.leaseToken,
    leaseExpiresAt: job.leaseExpiresAt.getTime(),
  };
}

async function replayReservation(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  receipt: WorkerReservationReceiptRow,
): Promise<WorkerJobReserveResult> {
  if (
    receipt.spaceId !== source.spaceId ||
    receipt.sourceAccountId !== source.account.id ||
    receipt.actorUserId !== source.principal.userId ||
    receipt.actorCredentialId !== source.principal.credentialId ||
    !Number.isSafeInteger(receipt.targetCount) ||
    receipt.targetCount < 0 ||
    receipt.targetCount > 4
  )
    workerProtocolError("not_found");
  if (
    receipt.invalidatedAt !== null ||
    receipt.expiresAt.getTime() <= ctx.now ||
    receipt.retireAt.getTime() <= ctx.now
  )
    workerProtocolError("reservation_expired");
  const targetRows = (
    await rows<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.worker_reservation_targets WHERE receipt_id = $1 ORDER BY ordinal LIMIT 5",
      [receipt.id],
    )
  ).map(camelizeReservationTarget);
  if (targetRows.length !== receipt.targetCount)
    workerProtocolError("reservation_expired");
  const targets: WorkerJobReserveResult["targets"] = [];
  for (let ordinal = 0; ordinal < targetRows.length; ordinal += 1) {
    const target = targetRows[ordinal]!;
    if (
      target.ordinal !== ordinal ||
      target.spaceId !== source.spaceId ||
      target.sourceAccountId !== source.account.id ||
      target.discoveryWorkId !== null ||
      target.ingestJobId === null ||
      target.leaseExpiresAt.getTime() !== receipt.expiresAt.getTime() ||
      target.leaseExpiresAt.getTime() <= ctx.now
    )
      workerProtocolError("reservation_expired");
    const current = await requireCurrentWorkerJob(
      ctx,
      source,
      target.ingestJobId,
    );
    if (
      current.job.sourceItemId !== target.sourceItemId ||
      current.job.workerLeaseOwnerCredentialId !==
        source.principal.credentialId ||
      current.job.leaseEpoch !== target.leaseEpoch ||
      current.job.leaseToken !== target.leaseToken ||
      current.job.leaseExpiresAt?.getTime() !==
        target.leaseExpiresAt.getTime() ||
      (current.job.state !== "processing" && current.job.state !== "staged")
    )
      workerProtocolError("reservation_expired");
    targets.push(reservationTarget(current));
  }
  return {
    operation: "jobs.reserve",
    receiptId: receipt.id,
    expiresAt: receipt.expiresAt.getTime(),
    reused: true,
    targets,
  };
}

async function quarantine(ctx: WorkerCtx, job: IngestJobRow): Promise<void> {
  await exec(
    ctx,
    `UPDATE kith.ingest_jobs SET state = 'needs_review', lease_token = NULL,
    lease_expires_at = NULL, worker_lease_owner_credential_id = NULL, next_attempt_at = NULL WHERE id = $1`,
    [job.id],
  );
  await exec(
    ctx,
    "UPDATE kith.processing_generations SET state = 'needs_review' WHERE id = $1 AND state <> 'ready'",
    [job.processingGenerationId],
  );
}

function leaseStateIsValid(job: IngestJobRow, now: number): boolean {
  if (job.state === "queued" || job.state === "failed")
    return (
      job.leaseToken === null &&
      job.leaseExpiresAt === null &&
      job.workerLeaseOwnerCredentialId === null
    );
  if (job.state === "processing" || job.state === "staged")
    return Boolean(
      job.leaseToken &&
      job.leaseExpiresAt &&
      job.leaseExpiresAt.getTime() <= now &&
      job.workerLeaseOwnerCredentialId,
    );
  return false;
}

export async function reserveProcessingJobs(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.reserve" }>,
  tokens: string[],
): Promise<WorkerJobReserveResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  if (
    tokens.length < request.maxItems ||
    tokens
      .slice(0, request.maxItems)
      .some((token) => !/^[0-9a-f]{64}$/.test(token))
  )
    workerProtocolError("invalid_request");
  const requestDigest = await digest("worker-jobs-reserve:v1", [
    source.account.id,
    request.requestId,
    request.maxItems,
  ]);
  const receipts = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.worker_reservation_receipts WHERE source_account_id = $1
      AND kind = 'processing' AND request_id = $2 ORDER BY created_at, id LIMIT 2`,
      [source.account.id, request.requestId],
    )
  ).map(camelizeReservationReceipt);
  if (receipts.length > 1) workerProtocolError("scan_conflict");
  if (receipts[0]) {
    if (receipts[0].requestDigest !== requestDigest)
      workerProtocolError("request_conflict");
    return replayReservation(ctx, source, receipts[0]);
  }
  if (
    (source.account.inventoryEpoch ?? 0) !==
    (source.account.completedInventoryEpoch ?? 0)
  )
    workerProtocolError("scan_not_ready");
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const candidates = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.ingest_jobs WHERE source_account_id = $1
      AND worker_managed = true AND worker_processing_mode IS NULL
      AND (state = 'queued' OR (state = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= $2)
        OR (state IN ('processing','staged') AND (lease_expires_at IS NULL OR lease_expires_at <= $2)))
      ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 16`,
      [source.account.id, at(ctx.now)],
    )
  ).map(camelizeIngestJob);
  const claimed: CurrentWorkerJob[] = [];
  for (const candidate of candidates) {
    if (claimed.length >= request.maxItems) break;
    let current: CurrentWorkerJob | undefined;
    try {
      current = await requireCurrentWorkerJob(ctx, source, candidate.id);
      if (
        current.job.state !== candidate.state ||
        current.job.leaseEpoch !== candidate.leaseEpoch ||
        current.job.attempts !== candidate.attempts ||
        current.job.leaseEpoch >= Number.MAX_SAFE_INTEGER ||
        current.job.attempts >= MAX_WORKER_JOB_ATTEMPTS ||
        !leaseStateIsValid(current.job, ctx.now) ||
        (current.job.state === "failed" &&
          (current.job.error?.retryable !== true ||
            !current.job.nextAttemptAt ||
            current.job.nextAttemptAt.getTime() > ctx.now))
      ) {
        await quarantine(ctx, current.job);
        continue;
      }
      if (
        current.item.lifecycle !== "available" ||
        current.item.desiredRevisionId !== current.job.sourceRevisionId ||
        current.item.desiredProcessingEpoch !==
          current.job.desiredProcessingEpoch
      ) {
        await exec(
          ctx,
          `UPDATE kith.ingest_jobs SET state = 'obsolete_generation', lease_token = NULL,
          lease_expires_at = NULL, worker_lease_owner_credential_id = NULL, next_attempt_at = NULL, error = NULL WHERE id = $1`,
          [current.job.id],
        );
        await exec(
          ctx,
          "UPDATE kith.processing_generations SET state = 'obsolete_generation' WHERE id = $1 AND state <> 'ready'",
          [current.generation.id],
        );
        continue;
      }
      const leaseEpoch = current.job.leaseEpoch + 1;
      const state = current.job.state === "staged" ? "staged" : "processing";
      const leaseExpiresAt = nowPlus(ctx.now, WORKER_JOB_LEASE_MS);
      await exec(
        ctx,
        `UPDATE kith.ingest_jobs SET state = $1, attempts = attempts + 1,
        lease_epoch = $2, lease_token = $3, lease_expires_at = $4,
        worker_lease_owner_credential_id = $5, next_attempt_at = NULL WHERE id = $6`,
        [
          state,
          leaseEpoch,
          tokens[claimed.length]!,
          at(leaseExpiresAt),
          source.principal.credentialId,
          current.job.id,
        ],
      );
      await exec(
        ctx,
        "UPDATE kith.processing_generations SET state = $1 WHERE id = $2",
        [state, current.generation.id],
      );
      claimed.push(await requireCurrentWorkerJob(ctx, source, current.job.id));
    } catch (error) {
      const code = workerProtocolErrorCode(error);
      if (
        ![
          "not_authorized",
          "not_found",
          "scan_conflict",
          "stale_observation",
          "source_unavailable",
        ].includes(code ?? "")
      )
        throw error;
      await quarantine(ctx, current?.job ?? candidate);
    }
  }
  const expiresAt = nowPlus(ctx.now, WORKER_JOB_LEASE_MS);
  const receiptId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.worker_reservation_receipts
    (id, space_id, created_at, source_account_id, kind, request_id, request_digest,
     actor_user_id, actor_credential_id, target_count, created_at_field, expires_at, retire_at)
    VALUES ($1,$2,transaction_timestamp(),$3,'processing',$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      receiptId,
      source.spaceId,
      source.account.id,
      request.requestId,
      requestDigest,
      source.principal.userId,
      source.principal.credentialId,
      claimed.length,
      at(ctx.now),
      at(expiresAt),
      at(nowPlus(ctx.now, WORKER_OPERATION_RECEIPT_MS)),
    ],
  );
  for (let ordinal = 0; ordinal < claimed.length; ordinal += 1) {
    const current = claimed[ordinal]!;
    if (!current.job.leaseToken || !current.job.leaseExpiresAt)
      workerProtocolError("scan_conflict");
    await exec(
      ctx,
      `INSERT INTO kith.worker_reservation_targets
      (id, space_id, created_at, source_account_id, source_item_id, receipt_id, ordinal,
       ingest_job_id, lease_epoch, lease_token, lease_expires_at)
      VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        newKithId(),
        source.spaceId,
        source.account.id,
        current.item.id,
        receiptId,
        ordinal,
        current.job.id,
        current.job.leaseEpoch,
        current.job.leaseToken,
        current.job.leaseExpiresAt,
      ],
    );
  }
  return {
    operation: "jobs.reserve",
    receiptId,
    expiresAt,
    reused: false,
    targets: claimed.map(reservationTarget),
  };
}

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

async function operationIdentity(
  source: LoadedWorkerSource,
  request: JobLeaseRequest,
) {
  if (!KITH_ID.test(request.jobId)) workerProtocolError("invalid_request");
  const leaseTokenHash = await sha256Hex(request.leaseToken);
  const operation = receiptOperation(request);
  return {
    jobId: request.jobId,
    leaseTokenHash,
    operation,
    requestDigest: await digest(`worker-${request.operation}:v1`, [
      source.account.id,
      request.requestId,
      request.jobId,
      request.leaseEpoch,
      leaseTokenHash,
      request.operation === "jobs.fail" ? request.failureCode : null,
    ]),
  };
}

async function findReceipt(
  ctx: WorkerCtx,
  sourceAccountId: string,
  operation: JobOperation,
  requestId: string,
): Promise<WorkerOperationReceiptRow | undefined> {
  const found = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.worker_operation_receipts WHERE source_account_id = $1
      AND operation = $2 AND request_id = $3 ORDER BY created_at, id LIMIT 2`,
      [sourceAccountId, operation, requestId],
    )
  ).map(camelizeOperationReceipt);
  if (found.length > 1) workerProtocolError("scan_conflict");
  return found[0];
}

function validateReceipt(
  source: LoadedWorkerSource,
  receipt: WorkerOperationReceiptRow,
  identity: Awaited<ReturnType<typeof operationIdentity>>,
  request: JobLeaseRequest,
  now: number,
): void {
  if (
    receipt.spaceId !== source.spaceId ||
    receipt.sourceAccountId !== source.account.id ||
    receipt.actorUserId !== source.principal.userId ||
    receipt.actorCredentialId !== source.principal.credentialId
  )
    workerProtocolError("not_found");
  if (receipt.phase !== "completed") workerProtocolError("scan_conflict");
  if (
    receipt.requestDigest !== identity.requestDigest ||
    receipt.ingestJobId !== identity.jobId ||
    receipt.leaseEpoch !== request.leaseEpoch ||
    receipt.leaseTokenHash !== identity.leaseTokenHash
  )
    workerProtocolError("request_conflict");
  if (receipt.retireAt.getTime() <= now)
    workerProtocolError("reservation_expired");
}

function validateReceiptParents(
  current: CurrentWorkerJob,
  receipt: WorkerOperationReceiptRow,
): void {
  if (
    receipt.sourceItemId !== current.item.id ||
    receipt.discoveryWorkId !== current.work.id ||
    receipt.sourceRevisionId !== current.revision.id ||
    receipt.processingGenerationId !== current.generation.id ||
    receipt.ingestJobId !== current.job.id ||
    receipt.desiredProcessingEpoch !== current.job.desiredProcessingEpoch
  )
    workerProtocolError("stale_observation");
}

async function insertReceipt(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  current: CurrentWorkerJob,
  identity: Awaited<ReturnType<typeof operationIdentity>>,
  request: JobLeaseRequest,
  result: {
    state: string;
    leaseExpiresAt?: number;
    activatedAt?: number;
    previousGenerationId?: string;
    actualPageCount?: number;
    actualEvidenceSpanCount?: number;
    actualDocumentCount?: number;
    actualChunkCount?: number;
    retryable?: boolean;
    nextAttemptAt?: number;
    failureCode?: string;
    failureAt?: number;
  },
): Promise<WorkerOperationReceiptRow> {
  const id = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.worker_operation_receipts
    (id, space_id, created_at, source_account_id, source_item_id, discovery_work_id,
     operation, phase, request_id, request_digest, actor_user_id, actor_credential_id,
     lease_epoch, lease_token_hash, source_revision_id, processing_generation_id,
     ingest_job_id, desired_processing_epoch, result_state, result_lease_expires_at,
     result_activated_at, result_previous_generation_id, result_actual_page_count,
     result_actual_evidence_span_count, result_actual_document_count,
     result_actual_chunk_count, result_retryable, result_next_attempt_at,
     result_failure_code, result_failure_at, created_at_field, retire_at)
    VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,'completed',$7,$8,$9,$10,$11,$12,
      $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
    [
      id,
      source.spaceId,
      source.account.id,
      current.item.id,
      current.work.id,
      identity.operation,
      request.requestId,
      identity.requestDigest,
      source.principal.userId,
      source.principal.credentialId,
      request.leaseEpoch,
      identity.leaseTokenHash,
      current.revision.id,
      current.generation.id,
      current.job.id,
      current.job.desiredProcessingEpoch,
      result.state,
      at(result.leaseExpiresAt),
      at(result.activatedAt),
      result.previousGenerationId ?? null,
      result.actualPageCount ?? null,
      result.actualEvidenceSpanCount ?? null,
      result.actualDocumentCount ?? null,
      result.actualChunkCount ?? null,
      result.retryable ?? null,
      at(result.nextAttemptAt),
      result.failureCode ?? null,
      at(result.failureAt),
      at(ctx.now),
      at(nowPlus(ctx.now, WORKER_OPERATION_RECEIPT_MS)),
    ],
  );
  return camelizeOperationReceipt(
    (await row<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.worker_operation_receipts WHERE id = $1",
      [id],
    )) ?? workerProtocolError("scan_conflict"),
  );
}

function renewResult(
  receipt: WorkerOperationReceiptRow,
  reused: boolean,
): WorkerJobRenewResult {
  if (
    (receipt.resultState !== "processing" &&
      receipt.resultState !== "staged") ||
    !receipt.resultLeaseExpiresAt ||
    !receipt.ingestJobId
  )
    workerProtocolError("scan_conflict");
  return {
    operation: "jobs.renew",
    jobId: receipt.ingestJobId,
    state: receipt.resultState,
    leaseExpiresAt: receipt.resultLeaseExpiresAt.getTime(),
    reused,
  };
}

export async function renewProcessingJob(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.renew" }>,
): Promise<WorkerJobRenewResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const identity = await operationIdentity(source, request);
  const prior = await findReceipt(
    ctx,
    source.account.id,
    identity.operation,
    request.requestId,
  );
  if (prior) {
    validateReceipt(source, prior, identity, request, ctx.now);
    const current = await requireCurrentJobLease(
      ctx,
      source,
      identity.jobId,
      request.leaseEpoch,
      request.leaseToken,
    );
    validateReceiptParents(current, prior);
    if (
      current.job.leaseExpiresAt?.getTime() !==
      prior.resultLeaseExpiresAt?.getTime()
    )
      workerProtocolError("lease_conflict");
    return renewResult(prior, true);
  }
  const current = await requireCurrentJobLease(
    ctx,
    source,
    identity.jobId,
    request.leaseEpoch,
    request.leaseToken,
  );
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const leaseExpiresAt = nowPlus(ctx.now, WORKER_JOB_LEASE_MS);
  await exec(
    ctx,
    "UPDATE kith.ingest_jobs SET lease_expires_at = $1 WHERE id = $2",
    [at(leaseExpiresAt), current.job.id],
  );
  const receipt = await insertReceipt(ctx, source, current, identity, request, {
    state: current.job.state,
    leaseExpiresAt,
  });
  return renewResult(receipt, false);
}

async function planCurrentText(current: CurrentWorkerJob) {
  let text: string;
  try {
    text = requireInlineSourceRevision(current.revision).text;
  } catch {
    workerProtocolError("scan_conflict");
  }
  const plan = planInlineText(text!);
  if (
    current.generation.processingFingerprint !==
      (await processingFingerprint(current)) ||
    plan.chunkerFingerprint !== current.work.chunkerFingerprint ||
    plan.expectedPageCount !== current.generation.expectedPageCount ||
    plan.expectedEvidenceSpanCount !==
      current.generation.expectedEvidenceSpanCount ||
    plan.expectedDocumentCount !== current.generation.expectedDocumentCount ||
    plan.expectedChunkCount !== current.generation.expectedChunkCount ||
    plan.expectedEventCount !== (current.generation.expectedEventCount ?? 0) ||
    plan.expectedObservationCount !==
      (current.generation.expectedObservationCount ?? 0)
  )
    workerProtocolError("scan_conflict");
  return plan;
}

function stageResult(
  receipt: WorkerOperationReceiptRow,
  reused: boolean,
): WorkerJobStageResult {
  if (
    receipt.resultState !== "staged" ||
    !receipt.ingestJobId ||
    receipt.resultActualPageCount === null ||
    receipt.resultActualEvidenceSpanCount === null ||
    receipt.resultActualDocumentCount === null ||
    receipt.resultActualChunkCount === null
  )
    workerProtocolError("scan_conflict");
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

export async function stageProcessingUtf8(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.stageUtf8" }>,
): Promise<WorkerJobStageResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const identity = await operationIdentity(source, request);
  const prior = await findReceipt(
    ctx,
    source.account.id,
    identity.operation,
    request.requestId,
  );
  if (prior) {
    validateReceipt(source, prior, identity, request, ctx.now);
    const current = await requireCurrentWorkerJob(ctx, source, identity.jobId);
    validateReceiptParents(current, prior);
    if (
      current.job.state !== "staged" ||
      current.generation.state !== "staged" ||
      current.generation.actualPageCount !== prior.resultActualPageCount ||
      current.generation.actualEvidenceSpanCount !==
        prior.resultActualEvidenceSpanCount ||
      current.generation.actualDocumentCount !==
        prior.resultActualDocumentCount ||
      current.generation.actualChunkCount !== prior.resultActualChunkCount
    )
      workerProtocolError("stale_observation");
    return stageResult(prior, true);
  }
  const current = await requireCurrentJobLease(
    ctx,
    source,
    identity.jobId,
    request.leaseEpoch,
    request.leaseToken,
  );
  if (current.job.state !== "processing") workerProtocolError("scan_conflict");
  const plan = await planCurrentText(current);
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  try {
    const textVersion = await createOrGetTextVersion(ctx.client, {
      spaceId: source.spaceId,
      sourceRevisionId: current.revision.id,
      extractionFingerprint: current.work.extractionFingerprint,
      text: plan.text,
    });
    await exec(
      ctx,
      "UPDATE kith.processing_generations SET source_text_version_id = $1 WHERE id = $2",
      [textVersion.id, current.generation.id],
    );
    const pages = await stagePages(ctx.client, {
      spaceId: source.spaceId,
      sourceTextVersionId: textVersion.id,
      pages: [{ ordinal: 0, start: 0, end: plan.text.length, text: plan.text }],
    });
    if (pages.length !== 1) workerProtocolError("scan_conflict");
    const spans = await stageEvidenceSpans(ctx.client, {
      spaceId: source.spaceId,
      sourceRevisionId: current.revision.id,
      sourceTextVersionId: textVersion.id,
      spans: plan.chunks.map((chunk) => ({
        sourcePageId: pages[0]!.id,
        ordinal: chunk.ordinal,
        start: chunk.start,
        end: chunk.end,
        locator: { kind: "page", label: "Filesystem text" },
      })),
    });
    const documents = await stageDocuments(ctx.client, {
      spaceId: source.spaceId,
      processingGenerationId: current.generation.id,
      sourceItemId: current.item.id,
      sourceRevisionId: current.revision.id,
      sourceTextVersionId: textVersion.id,
      documents: [
        {
          documentKey: STAGE_DOCUMENT_KEY,
          title: current.work.title ?? "Untitled",
          docType: current.work.docType ?? "generic",
          capturedAt: current.work.capturedAt,
          evidenceSpanIds: spans.map((span) => span.id),
        },
      ],
    });
    if (documents.length !== 1 || spans.length !== plan.chunks.length)
      workerProtocolError("scan_conflict");
    const chunks = await stageChunks(ctx.client, {
      spaceId: source.spaceId,
      processingGenerationId: current.generation.id,
      chunks: plan.chunks.map((chunk, index) => ({
        documentId: documents[0]!.id,
        ordinal: chunk.ordinal,
        text: chunk.text,
        evidenceSpanIds: [spans[index]!.id],
      })),
    });
    const counts = {
      actualPageCount: pages.length,
      actualEvidenceSpanCount: spans.length,
      actualDocumentCount: documents.length,
      actualChunkCount: chunks.length,
    };
    if (
      counts.actualPageCount !== current.generation.expectedPageCount ||
      counts.actualEvidenceSpanCount !==
        current.generation.expectedEvidenceSpanCount ||
      counts.actualDocumentCount !== current.generation.expectedDocumentCount ||
      counts.actualChunkCount !== current.generation.expectedChunkCount
    )
      workerProtocolError("scan_conflict");
    await exec(
      ctx,
      `UPDATE kith.processing_generations SET state = 'staged', actual_page_count = $1,
      actual_evidence_span_count = $2, actual_document_count = $3, actual_chunk_count = $4,
      actual_event_count = 0, actual_observation_count = 0 WHERE id = $5`,
      [
        counts.actualPageCount,
        counts.actualEvidenceSpanCount,
        counts.actualDocumentCount,
        counts.actualChunkCount,
        current.generation.id,
      ],
    );
    await exec(
      ctx,
      "UPDATE kith.ingest_jobs SET state = 'staged' WHERE id = $1",
      [current.job.id],
    );
    const receipt = await insertReceipt(
      ctx,
      source,
      current,
      identity,
      request,
      { state: "staged", ...counts },
    );
    return stageResult(receipt, false);
  } catch (error) {
    if (isTransactionAbort(error)) throw error;
    if (workerProtocolErrorCode(error)) throw error;
    workerProtocolError("scan_conflict");
  }
}

function activationResult(
  receipt: WorkerOperationReceiptRow,
  reused: boolean,
): WorkerJobActivateResult {
  if (
    receipt.resultState !== "ready" ||
    !receipt.resultActivatedAt ||
    !receipt.ingestJobId
  )
    workerProtocolError("scan_conflict");
  return {
    operation: "jobs.activate",
    jobId: receipt.ingestJobId,
    state: "ready",
    activatedAt: receipt.resultActivatedAt.getTime(),
    ...(receipt.resultPreviousGenerationId === null
      ? {}
      : { previousGenerationId: receipt.resultPreviousGenerationId }),
    reused,
  };
}

export async function activateProcessingJob(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.activate" }>,
): Promise<WorkerJobActivateResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const identity = await operationIdentity(source, request);
  const prior = await findReceipt(
    ctx,
    source.account.id,
    identity.operation,
    request.requestId,
  );
  if (prior) {
    validateReceipt(source, prior, identity, request, ctx.now);
    const current = await requireCurrentWorkerJob(ctx, source, identity.jobId);
    validateReceiptParents(current, prior);
    if (
      current.job.state !== "ready" ||
      current.generation.state !== "ready" ||
      current.item.activeGenerationId !== current.generation.id ||
      current.generation.activatedAt?.getTime() !==
        prior.resultActivatedAt?.getTime()
    )
      workerProtocolError("stale_observation");
    return activationResult(prior, true);
  }
  const current = await requireCurrentJobLease(
    ctx,
    source,
    identity.jobId,
    request.leaseEpoch,
    request.leaseToken,
  );
  if (
    current.job.state !== "staged" ||
    current.generation.state !== "staged" ||
    !current.generation.sourceTextVersionId
  )
    workerProtocolError("scan_conflict");
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const payload = await inspectGenerationPayload(ctx.client, {
    spaceId: source.spaceId,
    processingGenerationId: current.generation.id,
    sourceTextVersionId: current.generation.sourceTextVersionId,
    expectedPublicationState: "staged",
  });
  const counts = {
    pages: payload.pageOrdinals.length,
    evidence: payload.evidenceSpanOrdinalsByPage.reduce(
      (sum, group) => sum + group.ordinals.length,
      0,
    ),
    documents: payload.documentKeys.length,
    chunks: payload.chunkOrdinalsByDocument.reduce(
      (sum, group) => sum + group.ordinals.length,
      0,
    ),
  };
  if (
    counts.pages !== current.generation.actualPageCount ||
    counts.evidence !== current.generation.actualEvidenceSpanCount ||
    counts.documents !== current.generation.actualDocumentCount ||
    counts.chunks !== current.generation.actualChunkCount
  )
    workerProtocolError("scan_conflict");
  let previousGenerationId: string | undefined;
  try {
    ({ previousGenerationId } = await activateSourceItemGeneration(ctx.client, {
      spaceId: source.spaceId,
      sourceItemId: current.item.id,
      sourceRevisionId: current.revision.id,
      processingGenerationId: current.generation.id,
      ...(current.item.activeGenerationId === null
        ? {}
        : { expectedPreviousGenerationId: current.item.activeGenerationId }),
      expectedDesiredProcessingEpoch: current.job.desiredProcessingEpoch,
    }));
  } catch (error) {
    if (isTransactionAbort(error)) throw error;
    workerProtocolError("scan_conflict");
  }
  const activation = await nextWorkerActivation(ctx, source.spaceId);
  await recordWorkerActivation(ctx, source.spaceId, activation);
  const activatedAt = activation.activatedAt;
  if (previousGenerationId && previousGenerationId !== current.generation.id)
    await exec(
      ctx,
      "UPDATE kith.processing_generations SET deactivated_at = $1 WHERE id = $2",
      [at(activatedAt), previousGenerationId],
    );
  await exec(
    ctx,
    "UPDATE kith.processing_generations SET state = 'ready', activated_at = $1 WHERE id = $2",
    [at(activatedAt), current.generation.id],
  );
  await exec(
    ctx,
    `UPDATE kith.ingest_jobs SET state = 'ready', lease_token = NULL, lease_expires_at = NULL,
    worker_lease_owner_credential_id = NULL, next_attempt_at = NULL, error = NULL WHERE id = $1`,
    [current.job.id],
  );
  await clearInventoryParseFailed(ctx.client, {
    sourceItemId: current.item.id,
  });
  await exec(
    ctx,
    "UPDATE kith.source_inventory SET content_indexed = true, exclusion_reason = NULL, exclusion_detail = NULL WHERE source_item_id = $1",
    [current.item.id],
  );
  await exec(
    ctx,
    "UPDATE kith.source_accounts SET last_processed_at = GREATEST(COALESCE(last_processed_at, $1), $1) WHERE id = $2",
    [at(activatedAt), source.account.id],
  );
  await touchWorkerPublicationEmbedding(ctx, {
    spaceId: source.spaceId,
    sourceItemId: current.item.id,
    sourceAccountId: source.account.id,
    processingGenerationId: current.generation.id,
    ...(previousGenerationId ? { previousGenerationId } : {}),
  });
  const receipt = await insertReceipt(ctx, source, current, identity, request, {
    state: "ready",
    activatedAt,
    ...(previousGenerationId ? { previousGenerationId } : {}),
  });
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

function retryAt(now: number, attempts: number, baseDelayMs: number): number {
  return nowPlus(
    now,
    Math.min(
      RETRY_BACKOFF_CAP_MS,
      baseDelayMs * 2 ** Math.min(Math.max(attempts - 1, 0), 10),
    ),
  );
}

function failureResult(
  receipt: WorkerOperationReceiptRow,
  failureCode: WorkerJobFailureCode,
  reused: boolean,
): WorkerJobFailResult {
  if (
    (receipt.resultState !== "failed" &&
      receipt.resultState !== "needs_review" &&
      receipt.resultState !== "obsolete_generation") ||
    receipt.resultRetryable === null ||
    receipt.resultFailureCode !== failureCode ||
    !receipt.resultFailureAt ||
    !receipt.ingestJobId
  )
    workerProtocolError("scan_conflict");
  return {
    operation: "jobs.fail",
    jobId: receipt.ingestJobId,
    state: receipt.resultState,
    retryable: receipt.resultRetryable,
    ...(receipt.resultNextAttemptAt === null
      ? {}
      : { nextAttemptAt: receipt.resultNextAttemptAt.getTime() }),
    failureCode,
    reused,
  };
}

export async function failProcessingJob(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.fail" }>,
): Promise<WorkerJobFailResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  const identity = await operationIdentity(source, request);
  const prior = await findReceipt(
    ctx,
    source.account.id,
    identity.operation,
    request.requestId,
  );
  if (prior) {
    validateReceipt(source, prior, identity, request, ctx.now);
    const current = await requireCurrentWorkerJob(ctx, source, identity.jobId);
    validateReceiptParents(current, prior);
    if (
      current.job.state !== prior.resultState ||
      current.job.error?.code !== request.failureCode ||
      current.job.error?.retryable !== prior.resultRetryable ||
      current.job.nextAttemptAt?.getTime() !==
        prior.resultNextAttemptAt?.getTime()
    )
      workerProtocolError("stale_observation");
    return failureResult(prior, request.failureCode, true);
  }
  const current = await requireCurrentJobLease(
    ctx,
    source,
    identity.jobId,
    request.leaseEpoch,
    request.leaseToken,
  );
  const policy = FAILURE_POLICY[request.failureCode];
  const needsReview =
    policy.needsReview || current.job.attempts >= MAX_WORKER_JOB_ATTEMPTS;
  const retryable = policy.retryable && !needsReview;
  const nextAttemptAt = retryable
    ? retryAt(ctx.now, current.job.attempts, policy.baseDelayMs)
    : undefined;
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const stale =
    current.item.lifecycle !== "available" ||
    current.item.desiredRevisionId !== current.job.sourceRevisionId ||
    current.item.desiredProcessingEpoch !== current.job.desiredProcessingEpoch;
  const state = stale
    ? "obsolete_generation"
    : needsReview
      ? "needs_review"
      : "failed";
  const error = {
    code: request.failureCode,
    message: policy.message,
    at: ctx.now,
    retryable: stale ? false : retryable,
  };
  await exec(
    ctx,
    `UPDATE kith.ingest_jobs SET state = $1, lease_token = NULL, lease_expires_at = NULL,
    worker_lease_owner_credential_id = NULL, next_attempt_at = $2, error = $3 WHERE id = $4`,
    [state, at(nextAttemptAt), JSON.stringify(error), current.job.id],
  );
  await exec(
    ctx,
    "UPDATE kith.processing_generations SET state = $1 WHERE id = $2 AND state <> 'ready'",
    [state, current.generation.id],
  );
  if (!stale) {
    await setSourceItemFailure(ctx.client, {
      spaceId: source.spaceId,
      sourceItemId: current.item.id,
      code: request.failureCode,
      message: policy.message,
      at: new Date(ctx.now),
    });
    if (!retryable)
      await markInventoryParseFailed(ctx.client, {
        sourceItemId: current.item.id,
        failureClass: request.failureCode,
      });
  }
  const receipt = await insertReceipt(ctx, source, current, identity, request, {
    state,
    retryable: stale ? false : retryable,
    ...(nextAttemptAt ? { nextAttemptAt } : {}),
    failureCode: request.failureCode,
    failureAt: ctx.now,
  });
  return failureResult(receipt, request.failureCode, false);
}
