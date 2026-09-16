// The inline ingestion pipeline: admission, lease, staged publication,
// activation, failure and recovery for text a caller already has.
//
// Ported from `models/ingestion/inlineWork.ts`, `inlineWorker.ts` and the parts
// of `models/ingestion/model.ts` the inline lane uses (`admitSourceRevision`,
// `claimJob`, `failJob`, `activateGeneration`). The worker-protocol lane got the
// same three model functions in `../workers/jobs.ts` (P2-39e); this is the other
// caller of the same tables, and it deliberately reuses the same staging and
// publication primitives rather than growing a second copy of them:
// `../provenance/model.ts` stages, `inspectGenerationPayload` verifies,
// `activateSourceItemGeneration` flips the pointer, and
// `../workers/publication.ts` owns the processing clock and the embedding
// eligibility the publish changes.
//
// Three shapes are worth naming before reading the code.
//
// 1. One transaction, one clock. Every function here takes an `InlineCtx`
//    (`{ client, now }`) already inside the caller's `SERIALIZABLE` transaction,
//    the convention `../workers/db.ts` sets for the whole port. Convex's
//    `inlineWorker.process` was an *action* calling seven separate mutations
//    because a Convex mutation has a 16 MiB/16,000-write budget; section 2.4
//    removes that limit, so staging and activation are one transaction here.
//    What that costs is the ability to catch a failure and still record it --
//    a failed statement aborts a Postgres transaction -- so the processing step
//    runs under a `SAVEPOINT` and records the failure after rolling back to it.
//    A serialization abort is rethrown instead: it is the transaction boundary's
//    to retry, not this function's to bury.
//
// 2. The daemon has no principal; the work row does. "Workers retain the
//    admitting actor's identity. Every processing mutation rechecks current
//    permissions." So `processInlineWork` takes no caller principal and instead
//    re-checks the actor recorded on the ingest job against *current* grants on
//    every attempt. Revoking that credential stops publication, and recovery
//    cannot silently replace it with an administrator.
//
// 3. `scheduler.runAfter` is a row. Convex's `admit` scheduled `process` five
//    seconds out as a fallback; here that is a `kith.deferred_work` row inserted
//    in the admission's own transaction (section 2.4: "committed together or not
//    at all"), keyed by the work row's id -- the same payload and dedupe key
//    `recoverInlineIngestion` in `../deferred/sweeps.ts` already writes, so the
//    fallback and the recovery sweep converge on one queued job rather than two.

import type { Pool } from "pg";

import {
  schedule,
  type DeferredCtx,
  type DeferredWorkRow,
} from "../deferred/core.js";
import {
  clearInventoryParseFailed,
  markInventoryParseFailed,
} from "../documents/inventory.js";
import { KITH_ID, newKithId } from "../ids.js";
import type { PrincipalRef } from "../identity/authorization.js";
import {
  activateSourceItemGeneration,
  createOrGetRevision,
  createOrGetSourceItem,
  createOrGetTextVersion,
  inspectGenerationPayload,
  refreshAvailableSourceItem,
  setDesiredSourceRevision,
  setSourceItemFailure,
  stageChunks,
  stageDocuments,
  stageEvidenceSpans,
  stagePages,
  MAX_STAGING_ROWS,
} from "../provenance/model.js";
import {
  camelizeProcessingGeneration,
  camelizeSourceItem,
  camelizeSourceRevision,
  type ProcessingGenerationRow,
  type SourceItemRow,
  type SourceRevisionRow,
} from "../provenance/rows.js";
import { requireInlineSourceRevision } from "../provenance/representations.js";
import { validateGenerationRecords } from "../records/model.js";
import { camelize } from "../provenance/sql.js";
import { withKithTransaction } from "../schema.js";
import { at, exec, row, rows, workerCtx } from "../workers/db.js";
import { isWorkerTransactionAbort } from "../workers/errors.js";
import {
  camelizeIngestJob,
  camelizeIngestRequest,
  type IngestJobRow,
} from "../workers/rows.js";
import {
  nextWorkerActivation,
  recordWorkerActivation,
  touchWorkerPublicationEmbedding,
} from "../workers/publication.js";
import {
  digestProcessingConfiguration,
  planInlineText,
  INLINE_EXTRACTION_FINGERPRINT,
  INLINE_EXTRACTOR_FINGERPRINT,
  INLINE_NORMALIZATION_FINGERPRINT,
  INLINE_RECORD_SCHEMA_FINGERPRINT,
} from "./inline.js";
import {
  consumeIngestAdmissionRateLimit,
  inlineAdmissionDigest,
  inlineAdmissionEnvelope,
  prepareInlineInput,
  requireSourceAccountAccess,
  resolveIngestSourceAccount,
  INLINE_MEDIA_TYPE,
  type InlineCtx,
  type InlineIngestInput,
  type PreparedInlineInput,
} from "./input.js";

export type { InlineCtx, InlineIngestInput };

/** The lease the inline lane takes, identical to the worker lane's
 * (`WORKER_JOB_LEASE_MS` in `../workers/jobs.ts`): one ingest job, one lease
 * shape, whichever lane claims it. */
export const INLINE_WORK_LEASE_MS = 5 * 60 * 1_000;
export const MAX_INLINE_JOB_ATTEMPTS = 8;
/** Convex's `INLINE_WORK_FALLBACK_DELAY_MS`: how long after admission the
 * deferred queue picks the work up if the admitting request did not process it
 * inline itself. */
export const INLINE_WORK_FALLBACK_DELAY_MS = 5_000;
export const INLINE_WORK_MAX_BACKOFF_MS = 60 * 60 * 1_000;
const INLINE_DOCUMENT_KEY = "inline-document:0";
const INLINE_EVIDENCE_LABEL = "Inline text";

export type InlineWorkState =
  | "queued"
  | "running"
  | "ready"
  | "needs_review"
  | "failed"
  | "obsolete_generation";

export type InlineWorkRow = {
  id: string;
  spaceId: string;
  createdAt: Date;
  sourceAccountId: string | null;
  sourceItemId: string | null;
  sourceRevisionId: string | null;
  processingGenerationId: string | null;
  ingestJobId: string | null;
  actorUserId: string | null;
  actorCredentialId: string | null;
  state: InlineWorkState;
  attempts: number;
  nextAttemptAt: Date | null;
  lastErrorCode: string | null;
  createdAtField: Date | null;
  updatedAt: Date | null;
};

function camelizeInlineWork(raw: Record<string, unknown>): InlineWorkRow {
  return camelize<InlineWorkRow>(raw, ["attempts"]);
}

export type InlineAdmissionResult = {
  sourceItemId: string;
  sourceRevisionId: string;
  processingGenerationId: string;
  ingestJobId: string;
  state: string;
  reused: boolean;
};

export type AdmitInlineWorkResult = {
  admission: InlineAdmissionResult;
  spaceId: string;
  workId: string;
  reused: boolean;
  /** True when this call created the work row, which is when the fallback
   * deferred job is scheduled. A replay creates nothing and schedules nothing. */
  newWork: boolean;
};

export type InlineIngestResult = {
  sourceItemId: string;
  sourceRevisionId: string;
  processingGenerationId: string;
  ingestJobId: string;
  documentId?: string;
  desiredProcessingEpoch: number;
  isActive: boolean;
  state: "ready" | "queued" | "needs_review" | "failed";
};

type InlineWorkPrincipal = { userId: string; credentialId: string };

function actorRef(job: IngestJobRow): PrincipalRef {
  return {
    userId: job.actorUserId,
    ...(job.actorCredentialId ? { credentialId: job.actorCredentialId } : {}),
  };
}

/**
 * Convex's `boundedErrorCode`. A failure is classified by what it says, not by
 * where it came from, and only three codes reach a row: an authorization that
 * has gone away, a payload the server will not accept, and everything else.
 */
export function inlineErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("authenticated") ||
    message.includes("Source account not found") ||
    message.includes("Space not found")
  ) {
    return "authorization_revoked";
  }
  if (
    message.includes("conflict") ||
    message.includes("invalid") ||
    message.includes("incomplete") ||
    message.includes("exceeds") ||
    message.includes("does not") ||
    message.includes("damaged")
  ) {
    return "invalid_staging";
  }
  return "inline_worker_error";
}

export function inlineRetryAt(attempts: number, now: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 6));
  return now + Math.min(60_000 * 2 ** exponent, INLINE_WORK_MAX_BACKOFF_MS);
}

function requireWorkId(workId: string): string {
  if (typeof workId !== "string" || !KITH_ID.test(workId)) {
    throw new Error("Inline work id is invalid");
  }
  return workId;
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

async function advanceSourceAssessmentEpoch(
  ctx: InlineCtx,
  spaceId: string,
  sourceAccountId: string,
): Promise<void> {
  const updated = await rows<{ id: string }>(
    ctx,
    `UPDATE kith.source_accounts
        SET worker_assessment_epoch = COALESCE(worker_assessment_epoch, 0) + 1
      WHERE id = $1 AND space_id = $2
      RETURNING id`,
    [sourceAccountId, spaceId],
  );
  if (updated.length !== 1) throw new Error("Source account not found");
}

async function insertIngestReceipt(
  ctx: InlineCtx,
  input: {
    spaceId: string;
    sourceAccountId: string;
    requestId: string;
    requestDigest: string;
    sourceItemId: string;
    sourceRevisionId: string;
    processingGenerationId: string;
    ingestJobId: string;
    principal: InlineWorkPrincipal;
  },
): Promise<void> {
  await exec(
    ctx,
    `INSERT INTO kith.ingest_requests
       (id, space_id, created_at, source_account_id, request_id, request_digest,
        source_item_id, source_revision_id, processing_generation_id, ingest_job_id,
        actor_user_id, actor_credential_id)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      newKithId(),
      input.spaceId,
      input.sourceAccountId,
      input.requestId,
      input.requestDigest,
      input.sourceItemId,
      input.sourceRevisionId,
      input.processingGenerationId,
      input.ingestJobId,
      input.principal.userId,
      input.principal.credentialId,
    ],
  );
}

async function loadJob(
  ctx: InlineCtx,
  spaceId: string,
  jobId: string,
): Promise<IngestJobRow | null> {
  const found = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.ingest_jobs WHERE id = $1 AND space_id = $2",
    [jobId, spaceId],
  );
  return found ? camelizeIngestJob(found) : null;
}

/**
 * `models/ingestion/model.ts` `admitSourceRevision`, restricted to the inline
 * lane's one media type and one chunker.
 *
 * The receipt is immutable and it is the whole idempotency story: a replayed
 * request id with the same arguments returns the first receipt's ids and writes
 * nothing, a replay with different arguments is a conflict, and only a request
 * that gets past both consumes a rate-limit slot.
 */
async function admitInlineSourceRevision(
  ctx: InlineCtx,
  input: {
    principal: InlineWorkPrincipal;
    spaceId: string;
    sourceAccountId: string;
    prepared: PreparedInlineInput;
    requestDigest: string;
    priorReceiptJobId: string | null;
  },
): Promise<InlineAdmissionResult> {
  const { prepared, spaceId } = input;
  const source = prepared.input.source;
  const item = await createOrGetSourceItem(ctx.client, {
    spaceId,
    sourceAccountId: input.sourceAccountId,
    externalId: source.externalId,
    title: prepared.input.title,
    docType: prepared.docType,
    ...(source.uri === undefined ? {} : { uri: source.uri }),
  });
  if (item.lifecycle !== "available") {
    throw new Error("Source item is not available for admission");
  }
  // Metadata the assessment epoch depends on: a title, doc type, URI or
  // lifecycle change is a new observation even when the bytes are identical.
  const metadataChangesAssessment =
    item.title !== prepared.input.title ||
    item.docType !== prepared.docType ||
    item.uri !== (source.uri ?? null) ||
    item.originalLinkAvailable !== (source.uri !== undefined);

  if (input.priorReceiptJobId !== null) {
    const priorRows = await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.ingest_requests
         WHERE space_id = $1 AND source_account_id = $2 AND request_id = $3
         ORDER BY created_at, id LIMIT 2`,
      [spaceId, input.sourceAccountId, prepared.input.requestId],
    );
    if (priorRows.length !== 1) {
      throw new Error("Duplicate ingest request identity");
    }
    const prior = camelizeIngestRequest(priorRows[0]!);
    const job = await loadJob(ctx, spaceId, prior.ingestJobId);
    if (!job) throw new Error("Ingest receipt is incomplete");
    return {
      sourceItemId: prior.sourceItemId,
      sourceRevisionId: prior.sourceRevisionId,
      processingGenerationId: prior.processingGenerationId,
      ingestJobId: prior.ingestJobId,
      state: job.state,
      reused: true,
    };
  }

  if (
    item.desiredProcessingEpoch !==
    prepared.input.expectedDesiredProcessingEpoch
  ) {
    throw new Error("Desired processing epoch conflict");
  }
  await refreshAvailableSourceItem(ctx.client, {
    spaceId,
    sourceItemId: item.id,
    title: prepared.input.title,
    docType: prepared.docType,
    ...(source.uri === undefined ? {} : { uri: source.uri }),
  });
  // Revision identity is item plus exact byte hash. A later observation of the
  // same bytes reuses the revision and keeps its first capture metadata; the
  // new actor is still recorded, on this request's own receipt.
  const revision = await createOrGetRevision(ctx.client, {
    spaceId,
    sourceItemId: item.id,
    mediaType: INLINE_MEDIA_TYPE,
    inlineText: prepared.input.text,
    capturedAt: new Date(prepared.capturedAt),
    userId: input.principal.userId,
  });
  const processingFingerprint = await digestProcessingConfiguration({
    extractionFingerprint: INLINE_EXTRACTION_FINGERPRINT,
    extractorFingerprint: INLINE_EXTRACTOR_FINGERPRINT,
    recordSchemaFingerprint: INLINE_RECORD_SCHEMA_FINGERPRINT,
    normalizationFingerprint: INLINE_NORMALIZATION_FINGERPRINT,
    chunkerFingerprint: prepared.plan.chunkerFingerprint,
    correctionRevision: `inline-epoch:${prepared.input.expectedDesiredProcessingEpoch}`,
  });
  const generationRows = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.processing_generations
       WHERE space_id = $1 AND source_revision_id = $2 AND processing_fingerprint = $3
       ORDER BY created_at, id LIMIT 2`,
    [spaceId, revision.id, processingFingerprint],
  );
  if (generationRows.length > 1) {
    throw new Error("Duplicate processing generation identity");
  }
  if (generationRows[0]) {
    const generation = camelizeProcessingGeneration(generationRows[0]);
    if (
      generation.sourceAccountId !== input.sourceAccountId ||
      generation.sourceItemId !== item.id ||
      generation.expectedPageCount !== prepared.plan.expectedPageCount ||
      generation.expectedEvidenceSpanCount !==
        prepared.plan.expectedEvidenceSpanCount ||
      generation.expectedDocumentCount !==
        prepared.plan.expectedDocumentCount ||
      generation.expectedChunkCount !== prepared.plan.expectedChunkCount ||
      (generation.expectedEventCount ?? 0) !== 0 ||
      (generation.expectedObservationCount ?? 0) !== 0
    ) {
      throw new Error(
        "Processing generation manifest conflicts with prior work",
      );
    }
    if (
      item.desiredRevisionId !== revision.id ||
      item.desiredProcessingEpoch !== generation.desiredProcessingEpoch
    ) {
      throw new Error(
        "Processing configuration was already used; increment correctionRevision",
      );
    }
    const jobRows = await rows<Record<string, unknown>>(
      ctx,
      `SELECT * FROM kith.ingest_jobs
         WHERE space_id = $1 AND processing_generation_id = $2
         ORDER BY created_at, id LIMIT 2`,
      [spaceId, generation.id],
    );
    if (jobRows.length !== 1) {
      throw new Error("Processing generation job is invalid");
    }
    const job = camelizeIngestJob(jobRows[0]!);
    if (metadataChangesAssessment) {
      await advanceSourceAssessmentEpoch(ctx, spaceId, input.sourceAccountId);
    }
    await insertIngestReceipt(ctx, {
      spaceId,
      sourceAccountId: input.sourceAccountId,
      requestId: prepared.input.requestId,
      requestDigest: input.requestDigest,
      sourceItemId: item.id,
      sourceRevisionId: revision.id,
      processingGenerationId: generation.id,
      ingestJobId: job.id,
      principal: input.principal,
    });
    return {
      sourceItemId: item.id,
      sourceRevisionId: revision.id,
      processingGenerationId: generation.id,
      ingestJobId: job.id,
      state: job.state,
      reused: true,
    };
  }

  let desiredProcessingEpoch: number;
  try {
    desiredProcessingEpoch = await setDesiredSourceRevision(ctx.client, {
      spaceId,
      sourceItemId: item.id,
      desiredRevisionId: revision.id,
      expectedDesiredProcessingEpoch:
        prepared.input.expectedDesiredProcessingEpoch,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("desired processing epoch conflict")
    ) {
      throw new Error("Desired processing epoch conflict");
    }
    throw error;
  }
  await advanceSourceAssessmentEpoch(ctx, spaceId, input.sourceAccountId);
  const processingGenerationId = newKithId();
  const ingestJobId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.processing_generations
       (id, space_id, created_at, source_account_id, source_item_id, source_revision_id,
        processing_fingerprint, extraction_fingerprint, extractor_fingerprint,
        record_schema_fingerprint, normalization_fingerprint, chunker_fingerprint,
        correction_revision, desired_processing_epoch, card_generation, state,
        expected_page_count, expected_evidence_span_count, expected_document_count,
        expected_chunk_count, expected_event_count, expected_observation_count,
        embedding_status)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             false,'queued',$14,$15,$16,$17,0,0,'unavailable')`,
    [
      processingGenerationId,
      spaceId,
      input.sourceAccountId,
      item.id,
      revision.id,
      processingFingerprint,
      INLINE_EXTRACTION_FINGERPRINT,
      INLINE_EXTRACTOR_FINGERPRINT,
      INLINE_RECORD_SCHEMA_FINGERPRINT,
      INLINE_NORMALIZATION_FINGERPRINT,
      prepared.plan.chunkerFingerprint,
      `inline-epoch:${prepared.input.expectedDesiredProcessingEpoch}`,
      desiredProcessingEpoch,
      prepared.plan.expectedPageCount,
      prepared.plan.expectedEvidenceSpanCount,
      prepared.plan.expectedDocumentCount,
      prepared.plan.expectedChunkCount,
    ],
  );
  // `worker_managed = false` is the fence between the two lanes.
  // `requireCurrentWorkerJob` (`../workers/jobs.ts`) refuses any job that is not
  // `worker_managed = true`, so a filesystem worker credential cannot claim,
  // stage, activate or fail an inline job even holding a valid lease token.
  await exec(
    ctx,
    `INSERT INTO kith.ingest_jobs
       (id, space_id, created_at, source_account_id, source_item_id, source_revision_id,
        processing_generation_id, admitted_by_user_id, admitted_by_credential_id,
        actor_user_id, actor_credential_id, desired_processing_epoch, state, attempts,
        lease_epoch, worker_managed, worker_processing_mode)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$7,$8,$9,'queued',0,0,false,NULL)`,
    [
      ingestJobId,
      spaceId,
      input.sourceAccountId,
      item.id,
      revision.id,
      processingGenerationId,
      input.principal.userId,
      input.principal.credentialId,
      desiredProcessingEpoch,
    ],
  );
  await insertIngestReceipt(ctx, {
    spaceId,
    sourceAccountId: input.sourceAccountId,
    requestId: prepared.input.requestId,
    requestDigest: input.requestDigest,
    sourceItemId: item.id,
    sourceRevisionId: revision.id,
    processingGenerationId,
    ingestJobId,
    principal: input.principal,
  });
  return {
    sourceItemId: item.id,
    sourceRevisionId: revision.id,
    processingGenerationId,
    ingestJobId,
    state: "queued",
    reused: false,
  };
}

async function createOrGetInlineWork(
  ctx: InlineCtx,
  input: {
    spaceId: string;
    admission: InlineAdmissionResult;
  },
): Promise<{ work: InlineWorkRow; created: boolean }> {
  const existing = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.inline_work
       WHERE space_id = $1 AND ingest_job_id = $2
       ORDER BY created_at, id LIMIT 2`,
    [input.spaceId, input.admission.ingestJobId],
  );
  if (existing.length > 1) throw new Error("Inline work identity is invalid");
  if (existing[0]) {
    const work = camelizeInlineWork(existing[0]);
    if (
      work.sourceItemId !== input.admission.sourceItemId ||
      work.sourceRevisionId !== input.admission.sourceRevisionId ||
      work.processingGenerationId !== input.admission.processingGenerationId
    ) {
      throw new Error("Inline work conflicts with its ingest receipt");
    }
    return { work, created: false };
  }
  const job = await loadJob(ctx, input.spaceId, input.admission.ingestJobId);
  if (!job) throw new Error("Ingest job not found");
  const state: InlineWorkState =
    job.state === "ready"
      ? "ready"
      : job.state === "needs_review"
        ? "needs_review"
        : job.state === "obsolete_generation"
          ? "obsolete_generation"
          : job.state === "failed" && job.error?.retryable !== true
            ? "failed"
            : "queued";
  const terminal = state === "ready" || state === "needs_review";
  const id = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.inline_work
       (id, space_id, created_at, source_account_id, source_item_id, source_revision_id,
        processing_generation_id, ingest_job_id, actor_user_id, actor_credential_id,
        state, attempts, next_attempt_at, created_at_field, updated_at)
     VALUES ($1,$2,transaction_timestamp(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
    [
      id,
      input.spaceId,
      job.sourceAccountId,
      job.sourceItemId,
      job.sourceRevisionId,
      job.processingGenerationId,
      job.id,
      job.actorUserId,
      job.actorCredentialId,
      state,
      job.attempts,
      terminal ? null : (job.nextAttemptAt ?? at(ctx.now)),
      at(ctx.now),
    ],
  );
  const created = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.inline_work WHERE id = $1 AND space_id = $2",
    [id, input.spaceId],
  );
  if (!created) throw new Error("Failed to create inline work");
  return { work: camelizeInlineWork(created), created: true };
}

/**
 * Atomic authorization, receipt conflict check, rate limiting, admission, work
 * row, and the fallback deferred job -- one transaction, the caller's.
 *
 * `models/ingestion/inlineWork.ts` `admitInlineWork` plus `inlineWorker.ts`
 * `admit`'s `scheduler.runAfter`, which is the `schedule` call at the end.
 */
export async function admitInlineWork(
  ctx: InlineCtx,
  args: { principal: PrincipalRef; input: InlineIngestInput },
): Promise<AdmitInlineWorkResult> {
  if (!args.principal?.credentialId) throw new Error("Not authenticated");
  const principal: InlineWorkPrincipal = {
    userId: args.principal.userId,
    credentialId: args.principal.credentialId,
  };
  const prepared = prepareInlineInput(args.input);
  const account = await resolveIngestSourceAccount(ctx, principal, {
    ...(args.input.spaceId === undefined
      ? {}
      : { spaceId: args.input.spaceId }),
    connector: args.input.source.connector,
    accountId: args.input.source.accountId,
  });
  const spaceId = account.spaceId;
  const envelope = inlineAdmissionEnvelope(account.id, prepared);
  const requestDigest = await inlineAdmissionDigest(envelope);
  const receipts = await rows<Record<string, unknown>>(
    ctx,
    `SELECT * FROM kith.ingest_requests
       WHERE space_id = $1 AND source_account_id = $2 AND request_id = $3
       ORDER BY created_at, id LIMIT 2`,
    [spaceId, account.id, prepared.input.requestId],
  );
  if (receipts.length > 1) throw new Error("Duplicate ingest request identity");
  const prior = receipts[0] ? camelizeIngestRequest(receipts[0]) : null;
  if (prior) {
    if (prior.requestDigest !== requestDigest) {
      throw new Error("requestId conflicts with a different request");
    }
  } else {
    // "Matching receipts exempt": only a request that is not a replay of one
    // already accepted consumes a slot, so an interrupted client can retry the
    // original request unchanged however many times it needs to.
    await consumeIngestAdmissionRateLimit(ctx, {
      credentialId: principal.credentialId,
      now: ctx.now,
    });
  }
  const admission = await admitInlineSourceRevision(ctx, {
    principal,
    spaceId,
    sourceAccountId: account.id,
    prepared,
    requestDigest,
    priorReceiptJobId: prior?.ingestJobId ?? null,
  });
  const { work, created } = await createOrGetInlineWork(ctx, {
    spaceId,
    admission,
  });
  if (created) {
    // Section 2.4's replacement for `ctx.scheduler.runAfter`: the queue row
    // commits with the admission or not at all. The dedupe key is the work
    // row's id, which is what `recoverInlineIngestion` uses too, so the
    // fallback and the recovery sweep can never queue the same work twice.
    await schedule(ctx, {
      kind: "inline_ingestion",
      spaceId,
      payload: { workId: work.id },
      dedupeKey: work.id,
      runAfter: ctx.now + INLINE_WORK_FALLBACK_DELAY_MS,
    });
  }
  return {
    admission,
    spaceId,
    workId: work.id,
    reused: admission.reused,
    newWork: created,
  };
}

// ---------------------------------------------------------------------------
// The work chain, the lease, and failure
// ---------------------------------------------------------------------------

type InlineWorkChain = {
  work: InlineWorkRow;
  job: IngestJobRow;
  item: SourceItemRow;
  revision: SourceRevisionRow;
  generation: ProcessingGenerationRow;
};

/**
 * Every parent of one work row, each read under the work row's own space
 * predicate and each checked against the others.
 *
 * The composite `UNIQUE (id, space_id)` and composite foreign keys make most of
 * this unrepresentable in the schema; the checks stay anyway because the work
 * row itself carries denormalized copies of four parent ids and a row written
 * before those constraints existed must be refused rather than processed.
 */
async function requireWorkChain(
  ctx: InlineCtx,
  workId: string,
): Promise<InlineWorkChain> {
  const rawWork = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.inline_work WHERE id = $1 FOR UPDATE",
    [requireWorkId(workId)],
  );
  if (!rawWork) throw new Error("Inline work not found");
  const work = camelizeInlineWork(rawWork);
  const spaceId = work.spaceId;
  if (
    !work.ingestJobId ||
    !work.sourceItemId ||
    !work.sourceRevisionId ||
    !work.processingGenerationId ||
    !work.sourceAccountId ||
    !work.actorUserId
  ) {
    throw new Error("Inline work parent chain is invalid");
  }
  const rawJob = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.ingest_jobs WHERE id = $1 AND space_id = $2 FOR UPDATE",
    [work.ingestJobId, spaceId],
  );
  const rawItem = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_items WHERE id = $1 AND space_id = $2",
    [work.sourceItemId, spaceId],
  );
  const rawRevision = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_revisions WHERE id = $1 AND space_id = $2",
    [work.sourceRevisionId, spaceId],
  );
  const rawGeneration = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.processing_generations WHERE id = $1 AND space_id = $2",
    [work.processingGenerationId, spaceId],
  );
  if (!rawJob || !rawItem || !rawRevision || !rawGeneration) {
    throw new Error("Inline work parent chain is invalid");
  }
  const job = camelizeIngestJob(rawJob);
  const item = camelizeSourceItem(rawItem);
  const revision = camelizeSourceRevision(rawRevision);
  const generation = camelizeProcessingGeneration(rawGeneration);
  if (
    job.sourceAccountId !== work.sourceAccountId ||
    job.sourceItemId !== work.sourceItemId ||
    job.sourceRevisionId !== work.sourceRevisionId ||
    job.processingGenerationId !== work.processingGenerationId ||
    job.workerManaged === true ||
    item.sourceAccountId !== work.sourceAccountId ||
    revision.sourceItemId !== work.sourceItemId ||
    generation.sourceAccountId !== work.sourceAccountId ||
    generation.sourceItemId !== work.sourceItemId ||
    generation.sourceRevisionId !== work.sourceRevisionId ||
    generation.desiredProcessingEpoch !== job.desiredProcessingEpoch
  ) {
    throw new Error("Inline work parent chain is invalid");
  }
  return { work, job, item, revision, generation };
}

async function patchWork(
  ctx: InlineCtx,
  work: InlineWorkRow,
  patch: {
    state: InlineWorkState;
    attempts?: number;
    nextAttemptAt?: number | null;
    lastErrorCode?: string | null;
  },
): Promise<void> {
  await exec(
    ctx,
    `UPDATE kith.inline_work
        SET state = $1, attempts = COALESCE($2, attempts),
            next_attempt_at = $3, last_error_code = $4, updated_at = $5
      WHERE id = $6 AND space_id = $7`,
    [
      patch.state,
      patch.attempts ?? null,
      at(patch.nextAttemptAt ?? null),
      patch.lastErrorCode === undefined
        ? work.lastErrorCode
        : patch.lastErrorCode,
      at(ctx.now),
      work.id,
      work.spaceId,
    ],
  );
}

/**
 * Convex's `markInlineAuthorizationRevoked`. An actor whose grant is gone stops
 * the work permanently rather than handing it to whichever credential happens
 * to be running the daemon: "A recovery process cannot silently replace it with
 * an administrator."
 */
async function markInlineAuthorizationRevoked(
  ctx: InlineCtx,
  chain: InlineWorkChain,
): Promise<void> {
  const { work, job, generation } = chain;
  if (job.state === "ready") {
    await patchWork(ctx, work, {
      state: "ready",
      nextAttemptAt: null,
      lastErrorCode: null,
    });
    return;
  }
  const error = {
    code: "authorization_revoked",
    message: "Inline ingest actor is no longer authorized",
    retryable: false,
    at: ctx.now,
  };
  await exec(
    ctx,
    `UPDATE kith.ingest_jobs
        SET state = 'failed', lease_token = NULL, lease_expires_at = NULL,
            worker_lease_owner_credential_id = NULL, next_attempt_at = NULL, error = $1
      WHERE id = $2 AND space_id = $3`,
    [JSON.stringify(error), job.id, work.spaceId],
  );
  await exec(
    ctx,
    "UPDATE kith.processing_generations SET state = 'failed' WHERE id = $1 AND space_id = $2 AND state <> 'ready'",
    [generation.id, work.spaceId],
  );
  await patchWork(ctx, work, {
    state: "failed",
    attempts: job.attempts,
    nextAttemptAt: null,
    lastErrorCode: error.code,
  });
}

export type ClaimInlineWorkResult =
  | {
      kind: "claimed";
      workId: string;
      spaceId: string;
      jobId: string;
      principal: PrincipalRef;
      leaseEpoch: number;
      leaseToken: string;
      alreadyStaged: boolean;
      text: string;
      title: string;
      docType: string;
      capturedAt: Date;
    }
  | { kind: "busy"; retryAt: number }
  | { kind: "terminal"; state: InlineWorkState }
  | { kind: "denied" };

/**
 * `models/ingestion/inlineWork.ts` `claimInlineWork`, with `claimJob`'s body
 * inlined for the one lane that reaches it.
 *
 * The lease is the ingest job's own: `lease_epoch` fences a stale worker's
 * writes, `lease_token` proves the holder, `lease_expires_at` is the database's
 * clock, and `attempts` is bounded at `MAX_INLINE_JOB_ATTEMPTS`. That is the
 * same shape `../workers/jobs.ts` claims a filesystem job with, on the same
 * columns, because it is the same table.
 */
export async function claimInlineWork(
  ctx: InlineCtx,
  args: { workId: string; leaseToken: string },
): Promise<ClaimInlineWorkResult> {
  if (
    typeof args.leaseToken !== "string" ||
    args.leaseToken.length === 0 ||
    args.leaseToken.length > 256
  ) {
    throw new Error("leaseToken is invalid");
  }
  const chain = await requireWorkChain(ctx, args.workId);
  const { work, job, item, revision } = chain;
  const spaceId = work.spaceId;

  if (
    job.state === "ready" ||
    job.state === "needs_review" ||
    job.state === "obsolete_generation" ||
    (job.state === "failed" && job.error?.retryable !== true)
  ) {
    const state: InlineWorkState =
      job.state === "ready"
        ? "ready"
        : job.state === "needs_review"
          ? "needs_review"
          : job.state === "obsolete_generation"
            ? "obsolete_generation"
            : "failed";
    if (work.state !== state) {
      await patchWork(ctx, work, { state, nextAttemptAt: null });
    }
    return { kind: "terminal", state };
  }
  if (
    job.leaseToken !== null &&
    job.leaseExpiresAt !== null &&
    job.leaseExpiresAt.getTime() > ctx.now
  ) {
    const retryAt = job.leaseExpiresAt.getTime();
    await patchWork(ctx, work, { state: "running", nextAttemptAt: retryAt });
    return { kind: "busy", retryAt };
  }
  if (
    job.state === "failed" &&
    job.error?.retryable === true &&
    job.nextAttemptAt !== null &&
    job.nextAttemptAt.getTime() > ctx.now
  ) {
    const retryAt = job.nextAttemptAt.getTime();
    await patchWork(ctx, work, { state: "failed", nextAttemptAt: retryAt });
    return { kind: "busy", retryAt };
  }

  try {
    // The recorded actor, re-checked now. Not the daemon, and not whoever
    // admitted some other job on the same account.
    await requireSourceAccountAccess(
      ctx,
      actorRef(job),
      work.sourceAccountId!,
      "ingest",
    );
  } catch (error) {
    if (isWorkerTransactionAbort(error)) throw error;
    if (inlineErrorCode(error) !== "authorization_revoked") throw error;
    await markInlineAuthorizationRevoked(ctx, chain);
    return { kind: "denied" };
  }

  // The desired revision and epoch are the fence: a newer correction admitted
  // while this job waited makes this generation obsolete, and obsolete work
  // must not publish over the newer one. Checked before the attempt limit, the
  // order `claimJob` uses, so a superseded job is retired rather than reviewed.
  if (
    item.lifecycle !== "available" ||
    item.desiredRevisionId !== job.sourceRevisionId ||
    item.desiredProcessingEpoch !== job.desiredProcessingEpoch
  ) {
    await markObsolete(ctx, spaceId, job);
    await patchWork(ctx, work, {
      state: "obsolete_generation",
      nextAttemptAt: null,
    });
    return { kind: "terminal", state: "obsolete_generation" };
  }

  if (job.attempts >= MAX_INLINE_JOB_ATTEMPTS) {
    const failure = {
      code: "inline_worker_attempts_exhausted",
      message: "Inline worker attempt limit reached",
      retryable: false,
      at: ctx.now,
    };
    await exec(
      ctx,
      `UPDATE kith.ingest_jobs
          SET state = 'needs_review', lease_token = NULL, lease_expires_at = NULL,
              worker_lease_owner_credential_id = NULL, next_attempt_at = NULL, error = $1
        WHERE id = $2 AND space_id = $3`,
      [JSON.stringify(failure), job.id, spaceId],
    );
    await exec(
      ctx,
      "UPDATE kith.processing_generations SET state = 'needs_review' WHERE id = $1 AND space_id = $2 AND state <> 'ready'",
      [job.processingGenerationId, spaceId],
    );
    await patchWork(ctx, work, {
      state: "needs_review",
      nextAttemptAt: null,
      lastErrorCode: failure.code,
    });
    return { kind: "terminal", state: "needs_review" };
  }

  const state = job.state === "staged" ? "staged" : "processing";
  const leaseEpoch = job.leaseEpoch + 1;
  const leaseExpiresAt = ctx.now + INLINE_WORK_LEASE_MS;
  await exec(
    ctx,
    `UPDATE kith.ingest_jobs
        SET state = $1, attempts = attempts + 1, lease_epoch = $2, lease_token = $3,
            lease_expires_at = $4, next_attempt_at = NULL, error = NULL
      WHERE id = $5 AND space_id = $6`,
    [state, leaseEpoch, args.leaseToken, at(leaseExpiresAt), job.id, spaceId],
  );
  await exec(
    ctx,
    "UPDATE kith.processing_generations SET state = $1 WHERE id = $2 AND space_id = $3",
    [state, job.processingGenerationId, spaceId],
  );
  await patchWork(ctx, work, {
    state: "running",
    attempts: leaseEpoch,
    nextAttemptAt: leaseExpiresAt,
    lastErrorCode: null,
  });
  return {
    kind: "claimed",
    workId: work.id,
    spaceId,
    jobId: job.id,
    principal: actorRef(job),
    leaseEpoch,
    leaseToken: args.leaseToken,
    alreadyStaged: state === "staged",
    text: requireInlineSourceRevision(revision).text,
    title: item.title ?? "Untitled",
    docType: item.docType ?? "generic",
    capturedAt: revision.capturedAt,
  };
}

async function markObsolete(
  ctx: InlineCtx,
  spaceId: string,
  job: IngestJobRow,
): Promise<void> {
  await exec(
    ctx,
    `UPDATE kith.ingest_jobs
        SET state = 'obsolete_generation', lease_token = NULL, lease_expires_at = NULL,
            worker_lease_owner_credential_id = NULL, next_attempt_at = NULL, error = NULL
      WHERE id = $1 AND space_id = $2`,
    [job.id, spaceId],
  );
  await exec(
    ctx,
    `UPDATE kith.processing_generations SET state = 'obsolete_generation'
      WHERE id = $1 AND space_id = $2 AND state <> 'ready'`,
    [job.processingGenerationId, spaceId],
  );
}

export type InlineFailureResult = {
  state: "ready" | "failed" | "needs_review" | "obsolete_generation" | "stale";
};

/**
 * `recordInlineWorkFailure` plus `failJob`. The classification decides
 * everything else: only `inline_worker_error` retries, `invalid_staging` goes
 * straight to `needs_review` for an operator, and an authorization failure
 * discovered here is recorded as a worker error rather than laundered into a
 * revocation the actor did not actually suffer.
 */
export async function recordInlineWorkFailure(
  ctx: InlineCtx,
  args: {
    workId: string;
    leaseEpoch: number;
    leaseToken: string;
    error: string;
  },
): Promise<InlineFailureResult> {
  const chain = await requireWorkChain(ctx, args.workId);
  const { work, job, item, generation } = chain;
  const spaceId = work.spaceId;
  if (job.state === "ready") {
    await patchWork(ctx, work, {
      state: "ready",
      nextAttemptAt: null,
      lastErrorCode: null,
    });
    return { state: "ready" };
  }
  const currentLease =
    job.leaseEpoch === args.leaseEpoch &&
    job.leaseToken === args.leaseToken &&
    job.leaseExpiresAt !== null &&
    job.leaseExpiresAt.getTime() > ctx.now;
  if (!currentLease) return { state: "stale" };

  const classified = inlineErrorCode(args.error);
  const code =
    classified === "authorization_revoked" ? "inline_worker_error" : classified;
  const needsReview =
    code === "invalid_staging" || job.attempts >= MAX_INLINE_JOB_ATTEMPTS;
  const retryable = code === "inline_worker_error" && !needsReview;
  const nextAttemptAt = retryable
    ? inlineRetryAt(job.attempts, ctx.now)
    : undefined;

  const stale =
    item.lifecycle !== "available" ||
    item.desiredRevisionId !== job.sourceRevisionId ||
    item.desiredProcessingEpoch !== job.desiredProcessingEpoch;
  if (stale) {
    await markObsolete(ctx, spaceId, job);
    await patchWork(ctx, work, {
      state: "obsolete_generation",
      attempts: job.attempts,
      nextAttemptAt: null,
      lastErrorCode: code,
    });
    return { state: "obsolete_generation" };
  }

  const state = needsReview ? "needs_review" : "failed";
  const error = {
    code,
    message: "Inline source processing failed",
    retryable,
    at: ctx.now,
  };
  await exec(
    ctx,
    `UPDATE kith.ingest_jobs
        SET state = $1, lease_token = NULL, lease_expires_at = NULL,
            worker_lease_owner_credential_id = NULL, next_attempt_at = $2, error = $3
      WHERE id = $4 AND space_id = $5`,
    [state, at(nextAttemptAt ?? null), JSON.stringify(error), job.id, spaceId],
  );
  await exec(
    ctx,
    "UPDATE kith.processing_generations SET state = $1 WHERE id = $2 AND space_id = $3 AND state <> 'ready'",
    [state, generation.id, spaceId],
  );
  await setSourceItemFailure(ctx.client, {
    spaceId,
    sourceItemId: job.sourceItemId,
    code,
    message: "Inline source processing failed",
    at: new Date(ctx.now),
  });
  if (!retryable) {
    await markInventoryParseFailed(ctx.client, {
      sourceItemId: job.sourceItemId,
      failureClass: code,
    });
  }
  await patchWork(ctx, work, {
    state,
    attempts: job.attempts,
    nextAttemptAt: retryable ? (nextAttemptAt ?? null) : null,
    lastErrorCode: code,
  });
  return { state };
}

/** `syncInlineWorkState`: the work row's state re-derived from its job, for the
 * paths that changed the job and must leave the row agreeing with it. */
export async function syncInlineWorkState(
  ctx: InlineCtx,
  args: { workId: string },
): Promise<{ state: InlineWorkState }> {
  const { work, job } = await requireWorkChain(ctx, args.workId);
  const state: InlineWorkState =
    job.state === "ready"
      ? "ready"
      : job.state === "needs_review"
        ? "needs_review"
        : job.state === "obsolete_generation"
          ? "obsolete_generation"
          : job.state === "failed"
            ? "failed"
            : job.state === "processing" || job.state === "staged"
              ? "running"
              : "queued";
  const nextAttemptAt =
    state === "running"
      ? (job.leaseExpiresAt?.getTime() ?? null)
      : state === "queued"
        ? (job.nextAttemptAt?.getTime() ?? ctx.now)
        : state === "failed" && job.error?.retryable === true
          ? (job.nextAttemptAt?.getTime() ?? null)
          : null;
  await patchWork(ctx, work, {
    state,
    nextAttemptAt,
    ...(state === "ready" ? { lastErrorCode: null } : {}),
  });
  return { state };
}

// ---------------------------------------------------------------------------
// Staged publication and activation
// ---------------------------------------------------------------------------

function batches<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    out.push(values.slice(offset, offset + size));
  }
  return out;
}

/**
 * One inline text becomes one text version, one page, one evidence span per
 * chunk, one document and one chunk per span -- through the same
 * `../provenance/model.ts` functions the worker lane stages with, in the same
 * 25-row batches (`MAX_STAGING_ROWS`), so the bounds the source processing
 * contract publishes are enforced in one place rather than two.
 */
async function stageInlineGeneration(
  ctx: InlineCtx,
  claimed: Extract<ClaimInlineWorkResult, { kind: "claimed" }>,
  chain: InlineWorkChain,
): Promise<void> {
  const { generation, revision, item } = chain;
  const spaceId = claimed.spaceId;
  const plan = planInlineText(claimed.text);
  const textVersion = await createOrGetTextVersion(ctx.client, {
    spaceId,
    sourceRevisionId: revision.id,
    extractionFingerprint: INLINE_EXTRACTION_FINGERPRINT,
    text: plan.text,
  });
  await exec(
    ctx,
    "UPDATE kith.processing_generations SET source_text_version_id = $1 WHERE id = $2 AND space_id = $3",
    [textVersion.id, generation.id, spaceId],
  );
  const pages = await stagePages(ctx.client, {
    spaceId,
    sourceTextVersionId: textVersion.id,
    pages: [{ ordinal: 0, start: 0, end: plan.text.length, text: plan.text }],
  });
  if (pages.length !== 1) throw new Error("Inline page staging is incomplete");
  const spanIds: string[] = [];
  for (const batch of batches(plan.chunks, MAX_STAGING_ROWS)) {
    const staged = await stageEvidenceSpans(ctx.client, {
      spaceId,
      sourceRevisionId: revision.id,
      sourceTextVersionId: textVersion.id,
      spans: batch.map((chunk) => ({
        sourcePageId: pages[0]!.id,
        ordinal: chunk.ordinal,
        start: chunk.start,
        end: chunk.end,
        locator: { kind: "page" as const, label: INLINE_EVIDENCE_LABEL },
      })),
    });
    spanIds.push(...staged.map((span) => span.id));
  }
  if (spanIds.length !== plan.chunks.length) {
    throw new Error("Inline chunk evidence is incomplete");
  }
  const documents = await stageDocuments(ctx.client, {
    spaceId,
    processingGenerationId: generation.id,
    sourceItemId: item.id,
    sourceRevisionId: revision.id,
    sourceTextVersionId: textVersion.id,
    documents: [
      {
        documentKey: INLINE_DOCUMENT_KEY,
        title: claimed.title,
        docType: claimed.docType,
        capturedAt: claimed.capturedAt,
        evidenceSpanIds: spanIds,
      },
    ],
  });
  if (documents.length !== 1) {
    throw new Error("Inline document staging is incomplete");
  }
  let chunkTotal = 0;
  for (const [batchIndex, batch] of batches(
    plan.chunks,
    MAX_STAGING_ROWS,
  ).entries()) {
    const staged = await stageChunks(ctx.client, {
      spaceId,
      processingGenerationId: generation.id,
      chunks: batch.map((chunk, index) => {
        const evidenceSpanId = spanIds[batchIndex * MAX_STAGING_ROWS + index];
        if (!evidenceSpanId) {
          throw new Error("Inline chunk evidence is incomplete");
        }
        return {
          documentId: documents[0]!.id,
          ordinal: chunk.ordinal,
          text: chunk.text,
          evidenceSpanIds: [evidenceSpanId],
        };
      }),
    });
    chunkTotal += staged.length;
  }
  if (
    pages.length !== generation.expectedPageCount ||
    spanIds.length !== generation.expectedEvidenceSpanCount ||
    documents.length !== generation.expectedDocumentCount ||
    chunkTotal !== generation.expectedChunkCount
  ) {
    throw new Error("Inline staging does not match the admitted manifest");
  }
  await exec(
    ctx,
    `UPDATE kith.processing_generations
        SET state = 'staged', actual_page_count = $1, actual_evidence_span_count = $2,
            actual_document_count = $3, actual_chunk_count = $4,
            actual_event_count = 0, actual_observation_count = 0
      WHERE id = $5 AND space_id = $6`,
    [
      pages.length,
      spanIds.length,
      documents.length,
      chunkTotal,
      generation.id,
      spaceId,
    ],
  );
  await exec(
    ctx,
    "UPDATE kith.ingest_jobs SET state = 'staged' WHERE id = $1 AND space_id = $2",
    [claimed.jobId, spaceId],
  );
}

/**
 * `models/ingestion/model.ts` `activateGeneration` for the inline lane, which is
 * deliberately the same publication path `activateProcessingJob`
 * (`../workers/jobs.ts`) takes: verify the staged payload against the manifest,
 * flip the active pointer in one statement, advance the space's processing
 * clock, close the replaced generation's interval, and hand the embedding index
 * the two generations whose eligibility just changed.
 */
async function activateInlineGeneration(
  ctx: InlineCtx,
  claimed: Extract<ClaimInlineWorkResult, { kind: "claimed" }>,
  chain: InlineWorkChain,
): Promise<void> {
  const spaceId = claimed.spaceId;
  const rawGeneration = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.processing_generations WHERE id = $1 AND space_id = $2",
    [chain.generation.id, spaceId],
  );
  if (!rawGeneration) throw new Error("Processing generation not found");
  const generation = camelizeProcessingGeneration(rawGeneration);
  if (generation.state !== "staged" || !generation.sourceTextVersionId) {
    throw new Error("Processing generation is not staged");
  }
  const rawItem = await row<Record<string, unknown>>(
    ctx,
    "SELECT * FROM kith.source_items WHERE id = $1 AND space_id = $2 FOR UPDATE",
    [chain.item.id, spaceId],
  );
  if (!rawItem) throw new Error("Inline work parent chain is invalid");
  const item = camelizeSourceItem(rawItem);
  const payload = await inspectGenerationPayload(ctx.client, {
    spaceId,
    processingGenerationId: generation.id,
    sourceTextVersionId: generation.sourceTextVersionId,
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
    counts.pages !== generation.actualPageCount ||
    counts.evidence !== generation.actualEvidenceSpanCount ||
    counts.documents !== generation.actualDocumentCount ||
    counts.chunks !== generation.actualChunkCount
  ) {
    throw new Error("Staged generation counts changed before activation");
  }
  const validated = await validateGenerationRecords(ctx.client, {
    spaceId,
    processingGenerationId: generation.id,
    expectedEventCount: 0,
    expectedObservationCount: 0,
  });
  if (
    validated.eventVersions.length !== 0 ||
    validated.observations.length !== 0
  ) {
    throw new Error("Inline generation must carry no typed records");
  }
  const { previousGenerationId } = await activateSourceItemGeneration(
    ctx.client,
    {
      spaceId,
      sourceItemId: item.id,
      sourceRevisionId: chain.revision.id,
      processingGenerationId: generation.id,
      ...(item.activeGenerationId === null
        ? {}
        : { expectedPreviousGenerationId: item.activeGenerationId }),
      expectedDesiredProcessingEpoch: chain.job.desiredProcessingEpoch,
    },
  );
  const activation = await nextWorkerActivation(ctx, spaceId);
  await recordWorkerActivation(ctx, spaceId, activation);
  const activatedAt = activation.activatedAt;
  if (previousGenerationId && previousGenerationId !== generation.id) {
    await exec(
      ctx,
      "UPDATE kith.processing_generations SET deactivated_at = $1 WHERE id = $2 AND space_id = $3",
      [at(activatedAt), previousGenerationId, spaceId],
    );
  }
  await exec(
    ctx,
    "UPDATE kith.processing_generations SET state = 'ready', activated_at = $1 WHERE id = $2 AND space_id = $3",
    [at(activatedAt), generation.id, spaceId],
  );
  await exec(
    ctx,
    `UPDATE kith.ingest_jobs
        SET state = 'ready', lease_token = NULL, lease_expires_at = NULL,
            worker_lease_owner_credential_id = NULL, next_attempt_at = NULL, error = NULL
      WHERE id = $1 AND space_id = $2`,
    [claimed.jobId, spaceId],
  );
  // A later job for the same source succeeded, so an earlier failure's
  // `parse_failed` mark no longer applies. A no-op when the source has no
  // inventory row, which every inline source has.
  await clearInventoryParseFailed(ctx.client, { sourceItemId: item.id });
  await exec(
    ctx,
    `UPDATE kith.source_accounts
        SET last_processed_at = GREATEST(COALESCE(last_processed_at, $1), $1)
      WHERE id = $2 AND space_id = $3`,
    [at(activatedAt), chain.job.sourceAccountId, spaceId],
  );
  // The chunks that just became active are owed vectors, and the replaced
  // generation's are not. Per-target, not a space scan.
  await touchWorkerPublicationEmbedding(ctx, {
    spaceId,
    sourceItemId: item.id,
    sourceAccountId: chain.job.sourceAccountId,
    processingGenerationId: generation.id,
    ...(previousGenerationId ? { previousGenerationId } : {}),
  });
}

export type ProcessInlineWorkResult = {
  state: "ready" | "queued" | "failed" | "needs_review" | "obsolete_generation";
};

/**
 * `models/ingestion/inlineWorker.ts` `process`: claim, stage, activate, or
 * record why not.
 *
 * The `SAVEPOINT` is the one structural difference from Convex's action. A
 * Convex action could call `recordFailure` in a *new* mutation after a staging
 * mutation threw; a Postgres transaction is aborted by its own failed
 * statement, so the failure would be unrecordable without either a second
 * transaction (which this function does not own -- its caller does) or a
 * savepoint to roll back to. The claim happens before the savepoint, so the
 * attempt and the recorded failure commit together whatever the outcome.
 */
export async function processInlineWork(
  ctx: InlineCtx,
  args: { workId: string; leaseToken?: string },
): Promise<ProcessInlineWorkResult> {
  const leaseToken = args.leaseToken ?? crypto.randomUUID();
  const claimed = await claimInlineWork(ctx, {
    workId: args.workId,
    leaseToken,
  });
  if (claimed.kind === "busy") return { state: "queued" };
  if (claimed.kind === "denied") return { state: "failed" };
  if (claimed.kind === "terminal") {
    return {
      state: claimed.state === "running" ? "queued" : claimed.state,
    };
  }

  let phase = "work chain";
  await exec(ctx, "SAVEPOINT inline_process");
  try {
    const chain = await requireWorkChain(ctx, args.workId);
    if (!chain.job.leaseToken || chain.job.leaseToken !== leaseToken) {
      throw new Error("Inline worker lease is not current");
    }
    if (!claimed.alreadyStaged) {
      phase = "staging";
      await stageInlineGeneration(ctx, claimed, chain);
    }
    phase = "activation";
    await activateInlineGeneration(ctx, claimed, chain);
    await exec(ctx, "RELEASE SAVEPOINT inline_process");
  } catch (error) {
    // A serialization abort belongs to `withKithTransaction`'s retry, not to
    // this job's failure record: rolling back to the savepoint would not save
    // a transaction Postgres has already decided to abort.
    if (isWorkerTransactionAbort(error)) throw error;
    await exec(ctx, "ROLLBACK TO SAVEPOINT inline_process");
    const message = error instanceof Error ? error.message : String(error);
    const failure = await recordInlineWorkFailure(ctx, {
      workId: args.workId,
      leaseEpoch: claimed.leaseEpoch,
      leaseToken: claimed.leaseToken,
      error: `${phase}: ${message}`,
    });
    return { state: failure.state === "stale" ? "failed" : failure.state };
  }
  await syncInlineWorkState(ctx, { workId: args.workId });
  return { state: "ready" };
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * `getInlineIngestResult`: what `/api/ingest` answers with. `queued` means
 * durable work remains, not that the source is searchable, which is why the
 * state is derived from the job and the work row together rather than from
 * whether a document row happens to exist.
 */
export async function getInlineIngestResult(
  ctx: InlineCtx,
  args: { principal: PrincipalRef; workId: string },
): Promise<InlineIngestResult> {
  const { work, job, item } = await requireWorkChain(ctx, args.workId);
  await requireSourceAccountAccess(
    ctx,
    args.principal,
    work.sourceAccountId!,
    "ingest",
  );
  const documents = await rows<{ id: string }>(
    ctx,
    `SELECT id FROM kith.documents
       WHERE space_id = $1 AND processing_generation_id = $2
         AND source_item_id = $3 AND source_revision_id = $4
       ORDER BY created_at, id LIMIT 2`,
    [
      work.spaceId,
      work.processingGenerationId,
      work.sourceItemId,
      work.sourceRevisionId,
    ],
  );
  if (documents.length > 1) throw new Error("Inline document count is invalid");
  const state: InlineIngestResult["state"] =
    job.state === "ready"
      ? "ready"
      : work.state === "needs_review" || job.state === "needs_review"
        ? "needs_review"
        : work.state === "failed" ||
            work.state === "obsolete_generation" ||
            job.state === "failed" ||
            job.state === "obsolete_generation"
          ? "failed"
          : "queued";
  return {
    sourceItemId: work.sourceItemId!,
    sourceRevisionId: work.sourceRevisionId!,
    processingGenerationId: work.processingGenerationId!,
    ingestJobId: work.ingestJobId!,
    ...(documents[0] ? { documentId: documents[0].id } : {}),
    desiredProcessingEpoch: item.desiredProcessingEpoch,
    isActive: item.activeGenerationId === work.processingGenerationId,
    state,
  };
}

// ---------------------------------------------------------------------------
// The deferred handler and the request-path composition
// ---------------------------------------------------------------------------

/**
 * The `inline_ingestion` handler `drain` runs. The payload shape is
 * `{ workId }`, which is what `recoverInlineIngestion`
 * (`../deferred/sweeps.ts`) writes and what `admitInlineWork` schedules: one
 * agreed shape, two producers.
 *
 * It returns normally for a work row that failed. A failure the pipeline
 * *recorded* is this job's completed outcome, not the queue's failure to run
 * it; the inline work row carries its own `next_attempt_at` and the recovery
 * sweep re-enqueues it. Throwing would double-count the retry, once in
 * `kith.deferred_work.attempts` and once in `kith.ingest_jobs.attempts`.
 */
export async function inlineIngestionHandler(
  ctx: DeferredCtx,
  payload: Record<string, unknown>,
  job: DeferredWorkRow,
): Promise<void> {
  const workId = payload.workId;
  if (typeof workId !== "string" || !KITH_ID.test(workId)) {
    throw new Error("inline_ingestion payload requires a workId");
  }
  const inline: InlineCtx = ctx;
  if (job.spaceId !== null) {
    const found = await row<{ id: string }>(
      inline,
      "SELECT id FROM kith.inline_work WHERE id = $1 AND space_id = $2",
      [workId, job.spaceId],
    );
    if (!found) {
      throw new Error("inline_ingestion work row is not in the job's space");
    }
  }
  await processInlineWork(inline, { workId });
}

/**
 * `models/ingestion/inlineMcp.ts` `ingest`: admit, process, answer. Three
 * transactions rather than one, because the claim's lease has to be visible to
 * anything else that might pick the work up, and because a processing failure
 * must survive the request that caused it.
 *
 * `/api/ingest` is the caller. It maps the result's `state` and any thrown
 * message to the statuses the bounded text capture contract publishes; see
 * `errors.ts` in this directory for that classification.
 */
export async function ingestInlineText(
  pool: Pool,
  principal: PrincipalRef,
  input: InlineIngestInput,
  now = Date.now(),
): Promise<InlineIngestResult> {
  const admitted = await withKithTransaction(pool, (client) =>
    admitInlineWork(workerCtx(client, now), { principal, input }),
  );
  await withKithTransaction(pool, (client) =>
    processInlineWork(workerCtx(client, Date.now()), {
      workId: admitted.workId,
    }),
  );
  return await withKithTransaction(pool, (client) =>
    getInlineIngestResult(workerCtx(client, Date.now()), {
      principal,
      workId: admitted.workId,
    }),
  );
}
