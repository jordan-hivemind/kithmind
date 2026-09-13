import type {
  WorkerParsedActivateResult,
  WorkerParsedFailResult,
  WorkerParsedRenewResult,
  WorkerParsedReserveResult,
  WorkerParsedStageBatchResult,
  WorkerParsedStageBeginResult,
  WorkerParsedStageSealResult,
  WorkerRequest,
} from "@repo/worker-protocol/request";
import type { PrincipalRef } from "../identity/authorization.js";

import {
  clearInventoryParseFailed,
  markInventoryParseFailed,
} from "../documents/inventory.js";
import { ProofError } from "../errors.js";
import { sha256Hex } from "../ingestion/inline.js";
import {
  activateSourceItemGeneration,
  camelizeProcessingGeneration,
  camelizeSourceParserArtifact,
  camelizeSourceRevision,
  camelizeSourceTextVersion,
  camelizeWorkerParsedStage,
  insertParsedChunks,
  insertParsedDocuments,
  insertParsedEvidence,
  insertParsedPages,
  sealParsedPayload,
  setSourceItemFailure,
  verifySealedParsedPayload,
  type ProcessingGenerationRow,
  type SourceParserArtifactRow,
  type SourceRevisionRow,
  type SourceTextVersionRow,
  type WorkerParsedStageRow,
} from "../provenance/index.js";
import { newKithId, KITH_ID } from "../ids.js";
import { validateGenerationRecords } from "../records/model.js";
import { requireWorkerSourceAccount, type LoadedWorkerSource } from "./auth.js";
import {
  validateAdmittedArchiveChain,
  requireBinaryGate,
} from "./archivedDiscovery.js";
import { at, digest, exec, nowPlus, row, rows, type WorkerCtx } from "./db.js";
import {
  requireCurrentDiscovery,
  WORKER_OPERATION_RECEIPT_MS,
  type CurrentDiscovery,
} from "./discovery.js";
import { workerProtocolError, workerProtocolErrorCode } from "./errors.js";
import { MAX_WORKER_JOB_ATTEMPTS, WORKER_JOB_LEASE_MS } from "./jobs.js";
import { consumeWorkerMutationRateLimit } from "./rateLimit.js";
import {
  nextWorkerActivation,
  recordWorkerActivation,
  touchWorkerPublicationEmbedding,
} from "./publication.js";
import {
  camelizeIngestJob,
  camelizeReservationReceipt,
  camelizeReservationTarget,
  type IngestJobRow,
} from "./rows.js";

const CANDIDATE_INSPECTION_LIMIT = 16;
const RETRY_BACKOFF_CAP_MS = 60 * 60 * 1_000;

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0)
    workerProtocolError("scan_conflict");
  return value;
}

function isTransactionAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  return code === "40001" || code === "40P01";
}

function rethrowParsedMutationError(error: unknown): never {
  if (isTransactionAbort(error)) throw error;
  if (error instanceof ProofError) {
    if (error.code === "invalid_request")
      workerProtocolError("invalid_request");
    if (error.code === "scan_conflict") workerProtocolError("scan_conflict");
    if (error.code === "request_conflict")
      workerProtocolError("request_conflict");
  }
  throw error;
}

type ParsedJob = {
  source: LoadedWorkerSource;
  current: CurrentDiscovery;
  job: IngestJobRow;
  generation: ProcessingGenerationRow;
  revision: SourceRevisionRow;
  artifact: SourceParserArtifactRow;
  text: SourceTextVersionRow;
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

type BinaryOperation =
  | "job_renew_parsed"
  | "job_fail_parsed"
  | "job_stage_parsed_begin"
  | "job_stage_parsed_batch"
  | "job_stage_parsed_seal"
  | "job_activate_parsed";

type BinaryReceipt = {
  id: string;
  spaceId: string;
  sourceAccountId: string;
  sourceItemId: string;
  discoveryWorkId: string;
  operation: BinaryOperation;
  phase: "pending" | "completed";
  requestId: string;
  requestDigest: string;
  actorUserId: string;
  actorCredentialId: string;
  leaseEpoch: number;
  leaseTokenHash: string;
  leaseExpiresAtAtRequest: Date | null;
  sourceRevisionId: string | null;
  parserArtifactId: string | null;
  sourceTextVersionId: string | null;
  processingGenerationId: string | null;
  ingestJobId: string | null;
  desiredProcessingEpoch: number | null;
  archiveSetDigest: string | null;
  stageId: string | null;
  stagePhase: string | null;
  stageOrdinal: number | null;
  stageAcceptedCount: number | null;
  resultState: string | null;
  resultLeaseExpiresAt: Date | null;
  resultNextAttemptAt: Date | null;
  resultRetryable: boolean | null;
  resultFailureCode: string | null;
  resultFailureAt: Date | null;
  resultStagePhase: string | null;
  resultActivatedAt: Date | null;
  resultPreviousGenerationId: string | null;
  payloadManifestId: string | null;
  retireAt: Date;
};

function binaryReceipt(raw: Record<string, unknown>): BinaryReceipt {
  const value = Object.fromEntries(
    Object.entries(raw).map(([key, field]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      field,
    ]),
  ) as unknown as BinaryReceipt;
  for (const name of [
    "leaseEpoch",
    "desiredProcessingEpoch",
    "stageOrdinal",
    "stageAcceptedCount",
  ] as const) {
    if (value[name] !== null)
      (value[name] as number | null) = Number(value[name]);
  }
  return value;
}

async function loadParsedJob(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  id: string,
): Promise<ParsedJob> {
  requireBinaryGate(source);
  const jobRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.ingest_jobs WHERE id = $1 FOR UPDATE",
    [id],
  );
  const job = jobRaw ? camelizeIngestJob(jobRaw) : null;
  if (
    !job ||
    job.spaceId !== source.spaceId ||
    job.sourceAccountId !== source.account.id ||
    job.workerManaged !== true ||
    job.workerProcessingMode !== "parsed_pages_v1" ||
    !job.workerDiscoveryWorkId ||
    !Number.isSafeInteger(job.leaseEpoch) ||
    job.leaseEpoch < 0 ||
    !Number.isSafeInteger(job.attempts) ||
    job.attempts < 0
  )
    workerProtocolError("not_found");
  const current = await requireCurrentDiscovery(
    ctx,
    source,
    job.workerDiscoveryWorkId,
  );
  const generationRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.processing_generations WHERE id = $1",
    [job.processingGenerationId],
  );
  const generation = generationRaw
    ? camelizeProcessingGeneration(generationRaw)
    : null;
  if (
    !generation ||
    !generation.sourceTextVersionId ||
    !generation.parserArtifactId ||
    !generation.archiveSetDigest ||
    generation.desiredProcessingEpoch === null
  )
    workerProtocolError("scan_conflict");
  await validateAdmittedArchiveChain(ctx, source, current, {
    sourceRevisionId: job.sourceRevisionId,
    parserArtifactId: generation.parserArtifactId,
    sourceTextVersionId: generation.sourceTextVersionId,
    processingGenerationId: generation.id,
    ingestJobId: job.id,
    desiredProcessingEpoch: job.desiredProcessingEpoch,
    archiveSetDigest: generation.archiveSetDigest,
  });
  const revisionRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_revisions WHERE id = $1",
    [job.sourceRevisionId],
  );
  const artifactRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_parser_artifacts WHERE id = $1",
    [generation.parserArtifactId],
  );
  const textRaw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_text_versions WHERE id = $1",
    [generation.sourceTextVersionId],
  );
  if (!revisionRaw || !artifactRaw || !textRaw)
    workerProtocolError("scan_conflict");
  return {
    source,
    current,
    job,
    generation,
    revision: camelizeSourceRevision(revisionRaw),
    artifact: camelizeSourceParserArtifact(artifactRaw),
    text: camelizeSourceTextVersion(textRaw),
  };
}

function requireLease(
  loaded: ParsedJob,
  request: ParsedLeaseRequest,
  now: number,
): void {
  if (
    (loaded.job.state !== "processing" && loaded.job.state !== "staged") ||
    loaded.job.workerLeaseOwnerCredentialId !==
      loaded.source.principal.credentialId ||
    loaded.job.leaseEpoch !== request.leaseEpoch ||
    loaded.job.leaseToken !== request.leaseToken ||
    !loaded.job.leaseExpiresAt ||
    loaded.job.leaseExpiresAt.getTime() <= now
  )
    workerProtocolError("lease_conflict");
}

function target(
  loaded: ParsedJob,
): WorkerParsedReserveResult["targets"][number] {
  const { job, current } = loaded;
  if (
    (job.state !== "processing" && job.state !== "staged") ||
    !job.leaseToken ||
    !job.leaseExpiresAt
  )
    workerProtocolError("scan_conflict");
  return {
    jobId: job.id,
    workId: current.work.id,
    sourceItemId: job.sourceItemId,
    observationEpoch: current.work.observationEpoch,
    processingEpoch: current.work.processingEpoch,
    state: job.state,
    leaseEpoch: job.leaseEpoch,
    leaseToken: job.leaseToken,
    leaseExpiresAt: job.leaseExpiresAt.getTime(),
  };
}

async function quarantine(ctx: WorkerCtx, job: IngestJobRow): Promise<void> {
  await exec(
    ctx,
    `UPDATE kith.ingest_jobs SET state = 'needs_review', lease_token = NULL,
     lease_expires_at = NULL, worker_lease_owner_credential_id = NULL,
     next_attempt_at = NULL WHERE id = $1`,
    [job.id],
  );
  await exec(
    ctx,
    `UPDATE kith.processing_generations SET state = 'needs_review'
     WHERE id = $1 AND state <> 'ready'`,
    [job.processingGenerationId],
  );
}

export async function reserveParsedJobs(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.reserveParsed" }>,
  tokens: string[],
): Promise<WorkerParsedReserveResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  if (
    tokens.length < request.maxItems ||
    tokens
      .slice(0, request.maxItems)
      .some((token) => !/^[0-9a-f]{64}$/.test(token)) ||
    (request.jobId !== undefined && !KITH_ID.test(request.jobId))
  )
    workerProtocolError("invalid_request");
  let requestedJob: IngestJobRow | null = null;
  if (request.jobId !== undefined) {
    const raw = await row<Record<string, unknown>>(
      ctx,
      "SELECT * FROM kith.ingest_jobs WHERE id = $1",
      [request.jobId],
    );
    requestedJob = raw ? camelizeIngestJob(raw) : null;
    if (
      !requestedJob ||
      requestedJob.spaceId !== source.spaceId ||
      requestedJob.sourceAccountId !== source.account.id
    )
      workerProtocolError("not_found");
  }
  const requestDigest = await digest(
    request.jobId === undefined
      ? "worker-jobs-reserve-parsed:v1"
      : "worker-jobs-reserve-parsed-exact:v1",
    request.jobId === undefined
      ? [source.account.id, request.requestId, request.maxItems]
      : [source.account.id, request.requestId, request.maxItems, request.jobId],
  );
  const receipts = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.worker_reservation_receipts
       WHERE source_account_id = $1 AND kind = 'parsed_processing'
         AND request_id = $2 ORDER BY created_at, id LIMIT 2`,
      [source.account.id, request.requestId],
    )
  ).map(camelizeReservationReceipt);
  if (receipts.length > 1) workerProtocolError("scan_conflict");
  if (receipts[0]) {
    const receipt = receipts[0];
    if (
      receipt.spaceId !== source.spaceId ||
      receipt.actorUserId !== source.principal.userId ||
      receipt.actorCredentialId !== source.principal.credentialId
    )
      workerProtocolError("not_found");
    if (receipt.requestDigest !== requestDigest)
      workerProtocolError("request_conflict");
    if (receipt.expiresAt.getTime() <= ctx.now)
      workerProtocolError("reservation_expired");
    const saved = (
      await rows<Record<string, unknown>>(
        ctx,
        `SELECT * FROM kith.worker_reservation_targets
         WHERE receipt_id = $1 ORDER BY ordinal LIMIT $2`,
        [receipt.id, request.maxItems + 1],
      )
    ).map(camelizeReservationTarget);
    if (
      saved.length !== receipt.targetCount ||
      (request.jobId !== undefined && receipt.targetCount > 1)
    )
      workerProtocolError("scan_conflict");
    const targets: WorkerParsedReserveResult["targets"] = [];
    for (const savedTarget of saved) {
      if (
        !savedTarget.ingestJobId ||
        savedTarget.discoveryWorkId !== null ||
        (request.jobId !== undefined &&
          savedTarget.ingestJobId !== request.jobId) ||
        savedTarget.spaceId !== source.spaceId ||
        savedTarget.sourceAccountId !== source.account.id ||
        savedTarget.leaseExpiresAt.getTime() !== receipt.expiresAt.getTime()
      )
        workerProtocolError("scan_conflict");
      const loaded = await loadParsedJob(ctx, source, savedTarget.ingestJobId);
      if (
        loaded.job.leaseEpoch !== savedTarget.leaseEpoch ||
        loaded.job.leaseToken !== savedTarget.leaseToken ||
        loaded.job.leaseExpiresAt?.getTime() !==
          savedTarget.leaseExpiresAt.getTime() ||
        loaded.job.workerLeaseOwnerCredentialId !==
          source.principal.credentialId
      )
        workerProtocolError("reservation_expired");
      targets.push(target(loaded));
    }
    return {
      operation: "jobs.reserveParsed",
      receiptId: receipt.id,
      expiresAt: receipt.expiresAt.getTime(),
      reused: true,
      targets,
    };
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
  let candidates: IngestJobRow[];
  if (requestedJob) {
    candidates = [requestedJob];
  } else {
    candidates = (
      await rows<Record<string, unknown>>(
        ctx,
        `SELECT * FROM kith.ingest_jobs WHERE source_account_id = $1
         AND worker_processing_mode = 'parsed_pages_v1' AND worker_managed = true
         AND (state = 'queued'
           OR (state = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= $2)
           OR (state IN ('processing','staged') AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= $2))
         ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $3`,
        [source.account.id, at(ctx.now), CANDIDATE_INSPECTION_LIMIT],
      )
    ).map(camelizeIngestJob);
  }
  const claimed: ParsedJob[] = [];
  for (const candidate of candidates) {
    if (claimed.length >= request.maxItems) break;
    let loaded: ParsedJob | undefined;
    try {
      loaded = await loadParsedJob(ctx, source, candidate.id);
      const unleased =
        candidate.leaseToken === null &&
        candidate.leaseExpiresAt === null &&
        candidate.workerLeaseOwnerCredentialId === null;
      const expired =
        (candidate.state === "processing" || candidate.state === "staged") &&
        Boolean(candidate.leaseToken) &&
        Boolean(candidate.leaseExpiresAt) &&
        candidate.leaseExpiresAt!.getTime() <= ctx.now &&
        Boolean(candidate.workerLeaseOwnerCredentialId);
      const eligible =
        ((candidate.state === "queued" ||
          (candidate.state === "failed" &&
            candidate.error?.retryable === true &&
            candidate.nextAttemptAt !== null &&
            candidate.nextAttemptAt.getTime() <= ctx.now)) &&
          unleased) ||
        expired;
      const activeOrDeferred =
        ((candidate.state === "processing" || candidate.state === "staged") &&
          candidate.leaseExpiresAt !== null &&
          candidate.leaseExpiresAt.getTime() > ctx.now) ||
        (candidate.state === "failed" &&
          candidate.error?.retryable === true &&
          candidate.nextAttemptAt !== null &&
          candidate.nextAttemptAt.getTime() > ctx.now);
      const terminal =
        candidate.state === "ready" ||
        candidate.state === "needs_review" ||
        candidate.state === "obsolete_generation" ||
        (candidate.state === "failed" && candidate.error?.retryable !== true);
      if (
        request.jobId !== undefined &&
        (terminal ||
          (activeOrDeferred &&
            candidate.attempts < MAX_WORKER_JOB_ATTEMPTS &&
            candidate.leaseEpoch < Number.MAX_SAFE_INTEGER))
      )
        continue;
      if (
        !eligible ||
        candidate.attempts >= MAX_WORKER_JOB_ATTEMPTS ||
        candidate.leaseEpoch >= Number.MAX_SAFE_INTEGER
      ) {
        await quarantine(ctx, candidate);
        continue;
      }
      if (
        loaded.current.item.lifecycle !== "available" ||
        loaded.current.item.desiredRevisionId !== candidate.sourceRevisionId ||
        loaded.current.item.desiredProcessingEpoch !==
          candidate.desiredProcessingEpoch
      ) {
        await exec(
          ctx,
          `UPDATE kith.ingest_jobs SET state = 'obsolete_generation',
           lease_token = NULL, lease_expires_at = NULL,
           worker_lease_owner_credential_id = NULL, next_attempt_at = NULL,
           error = NULL WHERE id = $1`,
          [candidate.id],
        );
        await exec(
          ctx,
          `UPDATE kith.processing_generations SET state = 'obsolete_generation'
           WHERE id = $1 AND state <> 'ready'`,
          [candidate.processingGenerationId],
        );
        continue;
      }
      const state = candidate.state === "staged" ? "staged" : "processing";
      const leaseEpoch = candidate.leaseEpoch + 1;
      const expiresAt = nowPlus(ctx.now, WORKER_JOB_LEASE_MS);
      await exec(
        ctx,
        `UPDATE kith.ingest_jobs SET state = $1, attempts = attempts + 1,
         lease_epoch = $2, lease_token = $3, lease_expires_at = $4,
         worker_lease_owner_credential_id = $5, next_attempt_at = NULL
         WHERE id = $6`,
        [
          state,
          leaseEpoch,
          tokens[claimed.length]!,
          at(expiresAt),
          source.principal.credentialId,
          candidate.id,
        ],
      );
      await exec(
        ctx,
        "UPDATE kith.processing_generations SET state = $1 WHERE id = $2",
        [state, candidate.processingGenerationId],
      );
      claimed.push(await loadParsedJob(ctx, source, candidate.id));
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
  const expiresAt = nowPlus(ctx.now, WORKER_JOB_LEASE_MS);
  const receiptId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.worker_reservation_receipts
     (id, space_id, created_at, source_account_id, kind, request_id,
      request_digest, actor_user_id, actor_credential_id, target_count,
      created_at_field, expires_at, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,'parsed_processing',$4,$5,$6,$7,
      $8,$9,$10,$11)`,
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
    const claimedTarget = target(claimed[ordinal]!);
    await exec(
      ctx,
      `INSERT INTO kith.worker_reservation_targets
       (id, space_id, created_at, source_account_id, source_item_id,
        receipt_id, ordinal, ingest_job_id, lease_epoch, lease_token,
        lease_expires_at)
       VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        newKithId(),
        source.spaceId,
        source.account.id,
        claimed[ordinal]!.job.sourceItemId,
        receiptId,
        ordinal,
        claimed[ordinal]!.job.id,
        claimedTarget.leaseEpoch,
        claimedTarget.leaseToken,
        at(claimedTarget.leaseExpiresAt),
      ],
    );
  }
  return {
    operation: "jobs.reserveParsed",
    receiptId,
    expiresAt,
    reused: false,
    targets: claimed.map(target),
  };
}

async function operationIdentity(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  request: ParsedLeaseRequest,
  operation: BinaryOperation,
): Promise<{
  jobId: string;
  leaseTokenHash: string;
  requestDigest: string;
  prior: BinaryReceipt | undefined;
}> {
  if (!KITH_ID.test(request.jobId)) workerProtocolError("invalid_request");
  const leaseTokenHash = await sha256Hex(request.leaseToken);
  const requestDigest = await digest(`worker-${operation}:v1`, [
    source.account.id,
    request.requestId,
    request.jobId,
    request.leaseEpoch,
    leaseTokenHash,
    request,
  ]);
  const matches = (
    await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.worker_binary_operation_receipts
       WHERE source_account_id = $1 AND operation = $2 AND request_id = $3
       ORDER BY created_at, id LIMIT 2`,
      [source.account.id, operation, request.requestId],
    )
  ).map(binaryReceipt);
  if (matches.length > 1) workerProtocolError("scan_conflict");
  const prior = matches[0];
  if (
    prior &&
    (prior.spaceId !== source.spaceId ||
      prior.actorUserId !== source.principal.userId ||
      prior.actorCredentialId !== source.principal.credentialId)
  )
    workerProtocolError("not_found");
  if (
    prior &&
    (prior.requestDigest !== requestDigest ||
      prior.ingestJobId !== request.jobId ||
      prior.leaseEpoch !== request.leaseEpoch ||
      prior.leaseTokenHash !== leaseTokenHash)
  )
    workerProtocolError("request_conflict");
  if (prior && prior.retireAt.getTime() <= ctx.now)
    workerProtocolError("reservation_expired");
  return {
    jobId: request.jobId,
    leaseTokenHash,
    requestDigest,
    prior,
  };
}

function validateReceiptParents(
  loaded: ParsedJob,
  receipt: BinaryReceipt,
): void {
  if (
    receipt.sourceItemId !== loaded.job.sourceItemId ||
    receipt.discoveryWorkId !== loaded.current.work.id ||
    receipt.sourceRevisionId !== loaded.revision.id ||
    receipt.parserArtifactId !== loaded.artifact.id ||
    receipt.sourceTextVersionId !== loaded.text.id ||
    receipt.processingGenerationId !== loaded.generation.id ||
    receipt.ingestJobId !== loaded.job.id ||
    receipt.desiredProcessingEpoch !== loaded.job.desiredProcessingEpoch ||
    receipt.archiveSetDigest !== loaded.generation.archiveSetDigest
  )
    workerProtocolError("stale_observation");
}

async function insertBinaryReceipt(
  ctx: WorkerCtx,
  source: LoadedWorkerSource,
  loaded: ParsedJob,
  identity: Awaited<ReturnType<typeof operationIdentity>>,
  operation: BinaryOperation,
  request: ParsedLeaseRequest,
  stage?: {
    stageId: string;
    stagePhase: string;
    stageOrdinal: number;
  },
): Promise<string> {
  const id = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.worker_binary_operation_receipts
     (id, space_id, created_at, source_account_id, source_item_id,
      discovery_work_id, operation, phase, request_id, request_digest,
      actor_user_id, actor_credential_id, lease_epoch, lease_token_hash,
      lease_expires_at_at_request, source_revision_id, parser_artifact_id,
      source_text_version_id, processing_generation_id, ingest_job_id,
      desired_processing_epoch, archive_set_digest, stage_id, stage_phase,
      stage_ordinal, created_at_field, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,'pending',$7,$8,$9,$10,
      $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
    [
      id,
      source.spaceId,
      source.account.id,
      loaded.job.sourceItemId,
      loaded.current.work.id,
      operation,
      request.requestId,
      identity.requestDigest,
      source.principal.userId,
      source.principal.credentialId,
      request.leaseEpoch,
      identity.leaseTokenHash,
      loaded.job.leaseExpiresAt,
      loaded.revision.id,
      loaded.artifact.id,
      loaded.text.id,
      loaded.generation.id,
      loaded.job.id,
      loaded.job.desiredProcessingEpoch,
      loaded.generation.archiveSetDigest,
      stage?.stageId ?? null,
      stage?.stagePhase ?? null,
      stage?.stageOrdinal ?? null,
      at(ctx.now),
      at(nowPlus(ctx.now, WORKER_OPERATION_RECEIPT_MS)),
    ],
  );
  return id;
}

export async function renewParsedJob(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.renewParsed" }>,
): Promise<WorkerParsedRenewResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const identity = await operationIdentity(
    ctx,
    source,
    request,
    "job_renew_parsed",
  );
  if (identity.prior) {
    const loaded = await loadParsedJob(ctx, source, identity.jobId);
    validateReceiptParents(loaded, identity.prior);
    if (
      identity.prior.phase !== "completed" ||
      (identity.prior.resultState !== "processing" &&
        identity.prior.resultState !== "staged") ||
      identity.prior.resultLeaseExpiresAt === null ||
      identity.prior.resultLeaseExpiresAt?.getTime() !==
        loaded.job.leaseExpiresAt?.getTime()
    )
      workerProtocolError("lease_conflict");
    return {
      operation: "jobs.renewParsed",
      jobId: loaded.job.id,
      state: identity.prior.resultState,
      leaseExpiresAt: identity.prior.resultLeaseExpiresAt.getTime(),
      reused: true,
    };
  }
  const loaded = await loadParsedJob(ctx, source, identity.jobId);
  requireLease(loaded, request, ctx.now);
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const receiptId = await insertBinaryReceipt(
    ctx,
    source,
    loaded,
    identity,
    "job_renew_parsed",
    request,
  );
  const leaseExpiresAt = nowPlus(ctx.now, WORKER_JOB_LEASE_MS);
  await exec(
    ctx,
    "UPDATE kith.ingest_jobs SET lease_expires_at = $1 WHERE id = $2",
    [at(leaseExpiresAt), loaded.job.id],
  );
  await exec(
    ctx,
    `UPDATE kith.worker_binary_operation_receipts SET phase = 'completed',
     result_state = $1, result_lease_expires_at = $2 WHERE id = $3`,
    [loaded.job.state, at(leaseExpiresAt), receiptId],
  );
  return {
    operation: "jobs.renewParsed",
    jobId: loaded.job.id,
    state: loaded.job.state as "processing" | "staged",
    leaseExpiresAt,
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
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.failParsed" }>,
): Promise<WorkerParsedFailResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const identity = await operationIdentity(
    ctx,
    source,
    request,
    "job_fail_parsed",
  );
  if (identity.prior) {
    const loaded = await loadParsedJob(ctx, source, identity.jobId);
    validateReceiptParents(loaded, identity.prior);
    const prior = identity.prior;
    if (
      prior.phase !== "completed" ||
      (prior.resultState !== "failed" &&
        prior.resultState !== "needs_review" &&
        prior.resultState !== "obsolete_generation") ||
      prior.resultFailureCode !== request.failureCode ||
      prior.resultFailureAt?.getTime() !== loaded.job.error?.at ||
      prior.resultState !== loaded.job.state ||
      prior.resultRetryable === null
    )
      workerProtocolError("stale_observation");
    return {
      operation: "jobs.failParsed",
      jobId: loaded.job.id,
      state: prior.resultState,
      retryable: prior.resultRetryable,
      ...(prior.resultNextAttemptAt
        ? { nextAttemptAt: prior.resultNextAttemptAt.getTime() }
        : {}),
      failureCode: request.failureCode,
      reused: true,
    };
  }
  const loaded = await loadParsedJob(ctx, source, identity.jobId);
  requireLease(loaded, request, ctx.now);
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const receiptId = await insertBinaryReceipt(
    ctx,
    source,
    loaded,
    identity,
    "job_fail_parsed",
    request,
  );
  const policy = FAILURE_POLICY[request.failureCode];
  const needsReview =
    policy.needsReview || loaded.job.attempts >= MAX_WORKER_JOB_ATTEMPTS;
  const retryable = policy.retryable && !needsReview;
  const nextAttemptAt = retryable
    ? nowPlus(
        ctx.now,
        Math.min(
          RETRY_BACKOFF_CAP_MS,
          policy.delay *
            2 ** Math.min(Math.max(loaded.job.attempts - 1, 0), 10),
        ),
      )
    : undefined;
  const stale =
    loaded.current.item.lifecycle !== "available" ||
    loaded.current.item.desiredRevisionId !== loaded.job.sourceRevisionId ||
    loaded.current.item.desiredProcessingEpoch !==
      loaded.job.desiredProcessingEpoch;
  const state = stale
    ? "obsolete_generation"
    : needsReview
      ? "needs_review"
      : "failed";
  const resultRetryable = stale ? false : retryable;
  const error = {
    code: request.failureCode,
    message: policy.message,
    retryable: resultRetryable,
    at: ctx.now,
  };
  await exec(
    ctx,
    `UPDATE kith.ingest_jobs SET state = $1, lease_token = NULL,
     lease_expires_at = NULL, worker_lease_owner_credential_id = NULL,
     next_attempt_at = $2, error = $3 WHERE id = $4`,
    [state, at(nextAttemptAt), JSON.stringify(error), loaded.job.id],
  );
  await exec(
    ctx,
    `UPDATE kith.processing_generations SET state = $1
     WHERE id = $2 AND state <> 'ready'`,
    [state, loaded.generation.id],
  );
  if (!stale) {
    await setSourceItemFailure(ctx.client, {
      spaceId: source.spaceId,
      sourceItemId: loaded.current.item.id,
      code: request.failureCode,
      message: policy.message,
      at: at(ctx.now)!,
    });
    if (!retryable)
      await markInventoryParseFailed(ctx.client, {
        sourceItemId: loaded.current.item.id,
        failureClass: request.failureCode,
      });
  }
  await exec(
    ctx,
    `UPDATE kith.worker_binary_operation_receipts SET phase = 'completed',
     result_state = $1, result_retryable = $2, result_next_attempt_at = $3,
     result_failure_code = $4, result_failure_at = $5 WHERE id = $6`,
    [
      state,
      resultRetryable,
      at(nextAttemptAt),
      request.failureCode,
      at(ctx.now),
      receiptId,
    ],
  );
  return {
    operation: "jobs.failParsed",
    jobId: loaded.job.id,
    state,
    retryable: resultRetryable,
    ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
    failureCode: request.failureCode,
    reused: false,
  };
}

function stagePhaseCount(
  stage: WorkerParsedStageRow,
  phase: "pages" | "evidence" | "documents" | "chunks",
): number {
  return phase === "pages"
    ? stage.expectedPageCount
    : phase === "evidence"
      ? stage.expectedEvidenceSpanCount
      : phase === "documents"
        ? stage.expectedDocumentCount
        : stage.expectedChunkCount;
}

function nextPhase(
  phase: "pages" | "evidence" | "documents" | "chunks",
): "evidence" | "documents" | "chunks" | "seal" {
  return phase === "pages"
    ? "evidence"
    : phase === "evidence"
      ? "documents"
      : phase === "documents"
        ? "chunks"
        : "seal";
}

async function loadStage(
  ctx: WorkerCtx,
  loaded: ParsedJob,
  id: string,
): Promise<WorkerParsedStageRow> {
  if (!KITH_ID.test(id)) workerProtocolError("invalid_request");
  const raw = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.worker_parsed_stages WHERE id = $1 FOR UPDATE",
    [id],
  );
  const stage = raw ? camelizeWorkerParsedStage(raw) : null;
  if (
    !stage ||
    stage.spaceId !== loaded.source.spaceId ||
    stage.sourceAccountId !== loaded.source.account.id ||
    stage.sourceItemId !== loaded.job.sourceItemId ||
    stage.discoveryWorkId !== loaded.current.work.id ||
    stage.ingestJobId !== loaded.job.id ||
    stage.processingGenerationId !== loaded.generation.id ||
    stage.sourceRevisionId !== loaded.revision.id ||
    stage.sourceTextVersionId !== loaded.text.id ||
    stage.parserArtifactId !== loaded.artifact.id ||
    stage.archiveSetDigest !== loaded.generation.archiveSetDigest ||
    stage.normalizedBundleDigest !== loaded.generation.normalizedBundleDigest
  )
    workerProtocolError("scan_conflict");
  return stage;
}

function requireStageDeclaration(
  loaded: ParsedJob,
  request: Extract<WorkerRequest, { operation: "jobs.stageParsedBegin" }>,
): void {
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
    workerProtocolError("scan_conflict");
}

function requireStageMatchesDeclaration(
  stage: WorkerParsedStageRow,
  request: Extract<WorkerRequest, { operation: "jobs.stageParsedBegin" }>,
): void {
  if (
    stage.normalizedBundleDigest !== request.normalizedBundleDigest ||
    stage.mappingManifestHash !== request.mappingManifestHash ||
    stage.expectedPageCount !== request.expectedPageCount ||
    stage.expectedEvidenceSpanCount !== request.expectedEvidenceSpanCount ||
    stage.expectedDocumentCount !== request.expectedDocumentCount ||
    stage.expectedChunkCount !== request.expectedChunkCount
  )
    workerProtocolError("request_conflict");
}

function requireStageLifecycle(
  loaded: ParsedJob,
  stage: WorkerParsedStageRow,
): void {
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
    workerProtocolError("scan_conflict");
}

function requireUnreclaimedStageReceipt(
  loaded: ParsedJob,
  receipt: BinaryReceipt,
  request: Extract<
    ParsedLeaseRequest,
    {
      operation:
        | "jobs.stageParsedBegin"
        | "jobs.stageParsedBatch"
        | "jobs.stageParsedSeal";
    }
  >,
): void {
  if (
    loaded.job.leaseEpoch !== request.leaseEpoch ||
    loaded.job.leaseToken !== request.leaseToken ||
    loaded.job.leaseExpiresAt?.getTime() !==
      receipt.leaseExpiresAtAtRequest?.getTime() ||
    loaded.job.workerLeaseOwnerCredentialId !==
      loaded.source.principal.credentialId
  )
    workerProtocolError("stale_observation");
}

export async function beginParsedStage(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.stageParsedBegin" }>,
): Promise<WorkerParsedStageBeginResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const identity = await operationIdentity(
    ctx,
    source,
    request,
    "job_stage_parsed_begin",
  );
  const loaded = await loadParsedJob(ctx, source, identity.jobId);
  requireStageDeclaration(loaded, request);
  if (identity.prior) {
    validateReceiptParents(loaded, identity.prior);
    requireUnreclaimedStageReceipt(loaded, identity.prior, request);
    if (identity.prior.phase !== "completed" || !identity.prior.stageId)
      workerProtocolError("scan_conflict");
    const stage = await loadStage(ctx, loaded, identity.prior.stageId);
    requireStageMatchesDeclaration(stage, request);
    requireStageLifecycle(loaded, stage);
    if (
      stage.phase !== identity.prior.stagePhase ||
      stage.nextOrdinal !== identity.prior.stageOrdinal
    )
      workerProtocolError("stale_observation");
    return {
      operation: "jobs.stageParsedBegin",
      jobId: loaded.job.id,
      stageId: stage.id,
      phase: stage.phase as WorkerParsedStageBeginResult["phase"],
      nextOrdinal: stage.nextOrdinal,
      reused: true,
    };
  }
  const existingRows = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.worker_parsed_stages
     WHERE processing_generation_id = $1 ORDER BY created_at, id LIMIT 2
     FOR UPDATE`,
    [loaded.generation.id],
  );
  if (existingRows.length > 1) workerProtocolError("scan_conflict");
  requireLease(loaded, request, ctx.now);
  if (existingRows[0]) {
    const stage = await loadStage(ctx, loaded, String(existingRows[0].id));
    requireStageMatchesDeclaration(stage, request);
    requireStageLifecycle(loaded, stage);
    await consumeWorkerMutationRateLimit(
      ctx,
      source.principal.credentialId,
      source.account.id,
    );
    const receiptId = await insertBinaryReceipt(
      ctx,
      source,
      loaded,
      identity,
      "job_stage_parsed_begin",
      request,
    );
    await exec(
      ctx,
      `UPDATE kith.worker_binary_operation_receipts SET phase = 'completed',
       stage_id = $1, stage_phase = $2, stage_ordinal = $3 WHERE id = $4`,
      [stage.id, stage.phase, stage.nextOrdinal, receiptId],
    );
    return {
      operation: "jobs.stageParsedBegin",
      jobId: loaded.job.id,
      stageId: stage.id,
      phase: stage.phase as WorkerParsedStageBeginResult["phase"],
      nextOrdinal: stage.nextOrdinal,
      reused: true,
    };
  }
  if (
    loaded.job.state !== "processing" ||
    loaded.generation.state !== "processing" ||
    loaded.text.evidenceSealed
  )
    workerProtocolError("scan_conflict");
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const receiptId = await insertBinaryReceipt(
    ctx,
    source,
    loaded,
    identity,
    "job_stage_parsed_begin",
    request,
  );
  const stageId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.worker_parsed_stages
     (id, space_id, created_at, source_account_id, source_item_id,
      discovery_work_id, ingest_job_id, processing_generation_id,
      source_revision_id, source_text_version_id, parser_artifact_id,
      archive_set_digest, normalized_bundle_digest, mapping_manifest_hash,
      phase, next_ordinal, expected_page_count,
      expected_evidence_span_count, expected_document_count,
      expected_chunk_count, accepted_page_count,
      accepted_evidence_span_count, accepted_document_count,
      accepted_chunk_count, page_ids, evidence_span_ids, document_ids,
      chunk_ids, page_bytes, evidence_bytes, document_bytes, chunk_bytes,
      created_at_field, updated_at, retire_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
      $13,'pages',0,$14,$15,$16,$17,0,0,0,0,'[]','[]','[]','[]',0,0,0,0,
      $18,$18,$19)`,
    [
      stageId,
      source.spaceId,
      source.account.id,
      loaded.job.sourceItemId,
      loaded.current.work.id,
      loaded.job.id,
      loaded.generation.id,
      loaded.revision.id,
      loaded.text.id,
      loaded.artifact.id,
      loaded.generation.archiveSetDigest,
      request.normalizedBundleDigest,
      request.mappingManifestHash,
      request.expectedPageCount,
      request.expectedEvidenceSpanCount,
      request.expectedDocumentCount,
      request.expectedChunkCount,
      at(ctx.now),
      at(nowPlus(ctx.now, WORKER_OPERATION_RECEIPT_MS)),
    ],
  );
  await exec(
    ctx,
    `UPDATE kith.worker_binary_operation_receipts SET phase = 'completed',
     stage_id = $1, stage_phase = 'pages', stage_ordinal = 0 WHERE id = $2`,
    [stageId, receiptId],
  );
  return {
    operation: "jobs.stageParsedBegin",
    jobId: loaded.job.id,
    stageId,
    phase: "pages",
    nextOrdinal: 0,
    reused: false,
  };
}

export async function stageParsedBatch(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.stageParsedBatch" }>,
): Promise<WorkerParsedStageBatchResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const identity = await operationIdentity(
    ctx,
    source,
    request,
    "job_stage_parsed_batch",
  );
  const loaded = await loadParsedJob(ctx, source, identity.jobId);
  const stage = await loadStage(ctx, loaded, request.stageId);
  requireStageLifecycle(loaded, stage);
  if (identity.prior) {
    validateReceiptParents(loaded, identity.prior);
    requireUnreclaimedStageReceipt(loaded, identity.prior, request);
    if (
      identity.prior.phase !== "completed" ||
      identity.prior.stageId !== stage.id ||
      identity.prior.resultStagePhase !== stage.phase ||
      identity.prior.stageOrdinal !== stage.nextOrdinal ||
      identity.prior.stageAcceptedCount === null
    )
      workerProtocolError("stale_observation");
    return {
      operation: "jobs.stageParsedBatch",
      jobId: loaded.job.id,
      stageId: stage.id,
      committedPhase: request.phase,
      phase: stage.phase as WorkerParsedStageBatchResult["phase"],
      nextOrdinal: stage.nextOrdinal,
      acceptedCount: identity.prior.stageAcceptedCount,
      reused: true,
    };
  }
  requireLease(loaded, request, ctx.now);
  if (
    stage.phase !== request.phase ||
    stage.nextOrdinal !== request.ordinal ||
    request.rows.length >
      stagePhaseCount(stage, request.phase) - request.ordinal
  )
    workerProtocolError("scan_conflict");
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const receiptId = await insertBinaryReceipt(
    ctx,
    source,
    loaded,
    identity,
    "job_stage_parsed_batch",
    request,
    {
      stageId: stage.id,
      stagePhase: request.phase,
      stageOrdinal: request.ordinal,
    },
  );
  let added: { ids: string[]; bytes: number };
  try {
    if (request.phase === "pages")
      added = await insertParsedPages(ctx.client, stage, request.rows as never);
    else if (request.phase === "evidence")
      added = await insertParsedEvidence(
        ctx.client,
        stage,
        request.rows as never,
      );
    else if (request.phase === "documents")
      added = await insertParsedDocuments(
        ctx.client,
        stage,
        request.rows as never,
      );
    else
      added = await insertParsedChunks(
        ctx.client,
        stage,
        request.rows as never,
      );
  } catch (error) {
    rethrowParsedMutationError(error);
  }
  const accepted = request.ordinal + request.rows.length;
  const phase =
    accepted === stagePhaseCount(stage, request.phase)
      ? nextPhase(request.phase)
      : request.phase;
  const nextOrdinal = phase === request.phase ? accepted : 0;
  const ids =
    request.phase === "pages"
      ? [...stage.pageIds, ...added.ids]
      : request.phase === "evidence"
        ? [...stage.evidenceSpanIds, ...added.ids]
        : request.phase === "documents"
          ? [...stage.documentIds, ...added.ids]
          : [...stage.chunkIds, ...added.ids];
  const countColumn =
    request.phase === "pages"
      ? "accepted_page_count"
      : request.phase === "evidence"
        ? "accepted_evidence_span_count"
        : request.phase === "documents"
          ? "accepted_document_count"
          : "accepted_chunk_count";
  const idsColumn =
    request.phase === "pages"
      ? "page_ids"
      : request.phase === "evidence"
        ? "evidence_span_ids"
        : request.phase === "documents"
          ? "document_ids"
          : "chunk_ids";
  const bytesColumn =
    request.phase === "pages"
      ? "page_bytes"
      : request.phase === "evidence"
        ? "evidence_bytes"
        : request.phase === "documents"
          ? "document_bytes"
          : "chunk_bytes";
  const priorBytes =
    request.phase === "pages"
      ? stage.pageBytes
      : request.phase === "evidence"
        ? stage.evidenceBytes
        : request.phase === "documents"
          ? stage.documentBytes
          : stage.chunkBytes;
  await exec(
    ctx,
    `UPDATE kith.worker_parsed_stages SET phase = $1, next_ordinal = $2,
     updated_at = $3, ${countColumn} = $4, ${idsColumn} = $5,
     ${bytesColumn} = $6 WHERE id = $7`,
    [
      phase,
      nextOrdinal,
      at(ctx.now),
      accepted,
      JSON.stringify(ids),
      safeAdd(priorBytes, added.bytes),
      stage.id,
    ],
  );
  await exec(
    ctx,
    `UPDATE kith.worker_binary_operation_receipts SET phase = 'completed',
     result_stage_phase = $1, stage_ordinal = $2,
     stage_accepted_count = $3 WHERE id = $4`,
    [phase, nextOrdinal, request.rows.length, receiptId],
  );
  return {
    operation: "jobs.stageParsedBatch",
    jobId: loaded.job.id,
    stageId: stage.id,
    committedPhase: request.phase,
    phase,
    nextOrdinal,
    acceptedCount: request.rows.length,
    reused: false,
  };
}

export async function sealParsedStage(
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.stageParsedSeal" }>,
): Promise<WorkerParsedStageSealResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const identity = await operationIdentity(
    ctx,
    source,
    request,
    "job_stage_parsed_seal",
  );
  const loaded = await loadParsedJob(ctx, source, identity.jobId);
  const stage = await loadStage(ctx, loaded, request.stageId);
  requireStageLifecycle(loaded, stage);
  if (request.normalizedBundleDigest !== stage.normalizedBundleDigest)
    workerProtocolError("request_conflict");
  if (identity.prior) {
    validateReceiptParents(loaded, identity.prior);
    requireUnreclaimedStageReceipt(loaded, identity.prior, request);
    if (
      identity.prior.phase !== "completed" ||
      !identity.prior.payloadManifestId ||
      stage.phase !== "staged" ||
      stage.payloadManifestId !== identity.prior.payloadManifestId
    )
      workerProtocolError("stale_observation");
    return {
      operation: "jobs.stageParsedSeal",
      jobId: loaded.job.id,
      stageId: stage.id,
      payloadManifestId: identity.prior.payloadManifestId,
      state: "staged",
      actualPageCount: stage.acceptedPageCount,
      actualEvidenceSpanCount: stage.acceptedEvidenceSpanCount,
      actualDocumentCount: stage.acceptedDocumentCount,
      actualChunkCount: stage.acceptedChunkCount,
      reused: true,
    };
  }
  requireLease(loaded, request, ctx.now);
  if (stage.phase !== "seal" || stage.nextOrdinal !== 0)
    workerProtocolError("scan_conflict");
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const receiptId = await insertBinaryReceipt(
    ctx,
    source,
    loaded,
    identity,
    "job_stage_parsed_seal",
    request,
    { stageId: stage.id, stagePhase: "seal", stageOrdinal: 0 },
  );
  let sealed: Awaited<ReturnType<typeof sealParsedPayload>>;
  try {
    sealed = await sealParsedPayload(ctx.client, stage, at(ctx.now)!);
  } catch (error) {
    rethrowParsedMutationError(error);
  }
  await exec(
    ctx,
    `UPDATE kith.worker_binary_operation_receipts SET phase = 'completed',
     result_state = 'staged', payload_manifest_id = $1,
     stage_phase = 'staged' WHERE id = $2`,
    [sealed.manifestId, receiptId],
  );
  return {
    operation: "jobs.stageParsedSeal",
    jobId: loaded.job.id,
    stageId: stage.id,
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
  ctx: WorkerCtx,
  principal: PrincipalRef,
  request: Extract<WorkerRequest, { operation: "jobs.activateParsed" }>,
): Promise<WorkerParsedActivateResult> {
  const source = await requireWorkerSourceAccount(ctx, principal, request);
  requireBinaryGate(source);
  const identity = await operationIdentity(
    ctx,
    source,
    request,
    "job_activate_parsed",
  );
  if (identity.prior) {
    const loaded = await loadParsedJob(ctx, source, identity.jobId);
    validateReceiptParents(loaded, identity.prior);
    if (
      identity.prior.phase !== "completed" ||
      identity.prior.resultState !== "ready" ||
      !identity.prior.resultActivatedAt ||
      loaded.job.state !== "ready" ||
      loaded.generation.state !== "ready" ||
      loaded.current.item.activeGenerationId !== loaded.generation.id ||
      loaded.generation.activatedAt?.getTime() !==
        identity.prior.resultActivatedAt.getTime()
    )
      workerProtocolError("stale_observation");
    return {
      operation: "jobs.activateParsed",
      jobId: loaded.job.id,
      state: "ready",
      activatedAt: identity.prior.resultActivatedAt.getTime(),
      ...(identity.prior.resultPreviousGenerationId
        ? { previousGenerationId: identity.prior.resultPreviousGenerationId }
        : {}),
      reused: true,
    };
  }
  const loaded = await loadParsedJob(ctx, source, identity.jobId);
  requireLease(loaded, request, ctx.now);
  if (
    loaded.job.state !== "staged" ||
    loaded.generation.state !== "staged" ||
    !loaded.generation.payloadManifestId
  )
    workerProtocolError("scan_conflict");
  await consumeWorkerMutationRateLimit(
    ctx,
    source.principal.credentialId,
    source.account.id,
  );
  const receiptId = await insertBinaryReceipt(
    ctx,
    source,
    loaded,
    identity,
    "job_activate_parsed",
    request,
  );
  try {
    const records = await validateGenerationRecords(ctx.client, {
      spaceId: source.spaceId,
      processingGenerationId: loaded.generation.id,
      expectedEventCount: loaded.generation.expectedEventCount ?? 0,
      expectedObservationCount: loaded.generation.expectedObservationCount ?? 0,
    });
    const verified = await verifySealedParsedPayload(
      ctx.client,
      loaded.generation,
    );
    if (
      verified.actualPageCount !== loaded.generation.actualPageCount ||
      verified.actualEvidenceSpanCount !==
        loaded.generation.actualEvidenceSpanCount ||
      verified.actualDocumentCount !== loaded.generation.actualDocumentCount ||
      verified.actualChunkCount !== loaded.generation.actualChunkCount ||
      verified.actualEventCount !== (loaded.generation.actualEventCount ?? 0) ||
      verified.actualObservationCount !==
        (loaded.generation.actualObservationCount ?? 0) ||
      records.eventVersions.length !== verified.actualEventCount ||
      records.observations.length !== verified.actualObservationCount
    )
      workerProtocolError("scan_conflict");
  } catch (error) {
    if (!isTransactionAbort(error) && !(error instanceof ProofError)) {
      workerProtocolError("scan_conflict");
    }
    rethrowParsedMutationError(error);
  }
  let previousGenerationId: string | undefined;
  try {
    ({ previousGenerationId } = await activateSourceItemGeneration(ctx.client, {
      spaceId: source.spaceId,
      sourceItemId: loaded.current.item.id,
      sourceRevisionId: loaded.revision.id,
      processingGenerationId: loaded.generation.id,
      ...(loaded.current.item.activeGenerationId
        ? {
            expectedPreviousGenerationId:
              loaded.current.item.activeGenerationId,
          }
        : {}),
      expectedDesiredProcessingEpoch: loaded.job.desiredProcessingEpoch,
    }));
  } catch (error) {
    if (isTransactionAbort(error)) throw error;
    workerProtocolError("scan_conflict");
  }
  const activation = await nextWorkerActivation(ctx, source.spaceId);
  await recordWorkerActivation(ctx, source.spaceId, activation);
  if (previousGenerationId && previousGenerationId !== loaded.generation.id)
    await exec(
      ctx,
      "UPDATE kith.processing_generations SET deactivated_at = $1 WHERE id = $2",
      [at(activation.activatedAt), previousGenerationId],
    );
  await exec(
    ctx,
    `UPDATE kith.processing_generations SET state = 'ready', activated_at = $1
     WHERE id = $2`,
    [at(activation.activatedAt), loaded.generation.id],
  );
  await exec(
    ctx,
    `UPDATE kith.ingest_jobs SET state = 'ready', lease_token = NULL,
     lease_expires_at = NULL, worker_lease_owner_credential_id = NULL,
     next_attempt_at = NULL, error = NULL WHERE id = $1`,
    [loaded.job.id],
  );
  await clearInventoryParseFailed(ctx.client, {
    sourceItemId: loaded.current.item.id,
  });
  await exec(
    ctx,
    `UPDATE kith.source_inventory SET content_indexed = true,
     exclusion_reason = NULL, exclusion_detail = NULL
     WHERE source_item_id = $1`,
    [loaded.current.item.id],
  );
  await exec(
    ctx,
    `UPDATE kith.source_accounts SET last_processed_at =
     GREATEST(COALESCE(last_processed_at, $1), $1) WHERE id = $2`,
    [at(activation.activatedAt), source.account.id],
  );
  await touchWorkerPublicationEmbedding(ctx, {
    spaceId: source.spaceId,
    sourceItemId: loaded.current.item.id,
    sourceAccountId: source.account.id,
    processingGenerationId: loaded.generation.id,
    ...(previousGenerationId ? { previousGenerationId } : {}),
  });
  await exec(
    ctx,
    `UPDATE kith.worker_binary_operation_receipts SET phase = 'completed',
     result_state = 'ready', result_activated_at = $1,
     result_previous_generation_id = $2 WHERE id = $3`,
    [at(activation.activatedAt), previousGenerationId ?? null, receiptId],
  );
  return {
    operation: "jobs.activateParsed",
    jobId: loaded.job.id,
    state: "ready",
    activatedAt: activation.activatedAt,
    ...(previousGenerationId ? { previousGenerationId } : {}),
    reused: false,
  };
}
