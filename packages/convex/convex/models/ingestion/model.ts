import {
  MAX_EVENTS_PER_GENERATION,
  MAX_OBSERVATIONS_PER_GENERATION,
  stageRecordBatch,
  validateGenerationRecords,
  deleteSourceItemRecordsBatch,
} from "../records/model";
import type { StagedEventRecord } from "../records/validators";
import {
  nextRecordActivationTime,
  purgeRecordQuerySessionsForSpaceBatch,
} from "../records/querySessions";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { requireSourceAccountAccess } from "../../lib/sourceAuth";
import type { PrincipalRef } from "../../lib/spaces";
import {
  bumpEmbeddingEligibilityEpoch,
  getActiveEmbeddingTarget,
} from "../embeddings/model";
import {
  activateSourceItemGeneration,
  beginSourceItemForget,
  createOrGetRevision,
  createOrGetSourceItem,
  createOrGetTextVersion,
  deleteSourceItemProvenanceBatch,
  finalizeSourceItemTombstone,
  markSourceItemUnavailable,
  MAX_CHUNK_TEXT_UTF8_BYTES,
  MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES,
  refreshAvailableSourceItem,
  setDesiredSourceRevision,
  setSourceItemFailure,
  sha256Utf8,
  stageChunks,
  stageDocuments,
  stageEvidenceSpans,
  stagePages,
} from "../provenance/model";
import {
  parseSourceTextRepresentation,
  requireInlineSourceRevision,
  requireInlineSourceTextVersion,
} from "../provenance/representations";
import {
  MAX_PARSED_CHUNKS,
  verifySealedParsedPayload,
} from "../provenance/parsedStaging";
import { boundedDocumentSize, PayloadReadBudget } from "./payloadBudget";
import {
  digestDecodedAdmissionEnvelope,
  digestProcessingConfiguration,
  utf8ByteLength,
} from "./hash";
import {
  MAX_CHUNKS,
  MAX_CURSOR_DISCOVERIES,
  MAX_DOCUMENTS,
  MAX_ERROR_CODE_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_EVIDENCE_SPANS,
  MAX_EXTERNAL_ID_LENGTH,
  MAX_FINGERPRINT_LENGTH,
  MAX_INLINE_TEXT_BYTES,
  MAX_JOB_ATTEMPTS,
  MAX_LEASE_MS,
  MAX_LEASE_TOKEN_LENGTH,
  MAX_METADATA_LENGTH,
  MAX_PAGES,
  MAX_REQUEST_ID_LENGTH,
  MAX_STAGE_ROWS,
  MAX_STAGE_TEXT_BYTES,
  requireBoundedString,
  requireIntegerInRange,
} from "./limits";

type ProcessingConfiguration = {
  extractionFingerprint: string;
  extractorFingerprint: string;
  recordSchemaFingerprint: string;
  normalizationFingerprint: string;
  chunkerFingerprint: string;
  correctionRevision: string;
};

export type AdmissionInput = {
  principal: PrincipalRef;
  sourceAccountId: Id<"sourceAccounts">;
  requestId: string;
  expectedDesiredProcessingEpoch: number;
  source: {
    externalId: string;
    title?: string;
    docType?: string;
    uri?: string;
    capturedAt: number;
    mediaType: string;
    inlineText: string;
  };
  processing: ProcessingConfiguration & {
    expectedPageCount: number;
    expectedEvidenceSpanCount: number;
    expectedDocumentCount: number;
    expectedChunkCount: number;
    expectedEventCount?: number;
    expectedObservationCount?: number;
  };
};

export type AdmissionResult = {
  sourceItemId: Id<"sourceItems">;
  sourceRevisionId: Id<"sourceRevisions">;
  processingGenerationId: Id<"processingGenerations">;
  ingestJobId: Id<"ingestJobs">;
  state: Doc<"ingestJobs">["state"];
  reused: boolean;
};

export async function advanceSourceAssessmentEpoch(
  ctx: MutationCtx,
  sourceAccountId: Id<"sourceAccounts">,
): Promise<number> {
  const account = await ctx.db.get(sourceAccountId);
  if (!account) throw new Error("Source account not found");
  const current = account.workerAssessmentEpoch ?? 0;
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new Error("Invalid source assessment epoch");
  }
  const next = current + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error("Source assessment epoch exhausted");
  }
  await ctx.db.patch(account._id, { workerAssessmentEpoch: next });
  return next;
}

function assertAdmissionBounds(input: AdmissionInput): void {
  requireBoundedString("requestId", input.requestId, MAX_REQUEST_ID_LENGTH);
  requireBoundedString(
    "source.externalId",
    input.source.externalId,
    MAX_EXTERNAL_ID_LENGTH,
  );
  requireBoundedString(
    "source.mediaType",
    input.source.mediaType,
    MAX_METADATA_LENGTH,
  );
  for (const [name, value] of [
    ["source.title", input.source.title],
    ["source.docType", input.source.docType],
    ["source.uri", input.source.uri],
  ] as const) {
    if (value !== undefined)
      requireBoundedString(name, value, MAX_METADATA_LENGTH);
  }
  if (!Number.isFinite(input.source.capturedAt)) {
    throw new Error("source.capturedAt is invalid");
  }
  if (utf8ByteLength(input.source.inlineText) > MAX_INLINE_TEXT_BYTES) {
    throw new Error("source.inlineText exceeds the supported byte limit");
  }
  for (const [name, value] of Object.entries(input.processing).filter(
    ([name]) => name.endsWith("Fingerprint") || name === "correctionRevision",
  )) {
    requireBoundedString(name, value as string, MAX_FINGERPRINT_LENGTH);
  }
  requireIntegerInRange(
    "expectedDesiredProcessingEpoch",
    input.expectedDesiredProcessingEpoch,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  requireIntegerInRange(
    "expectedPageCount",
    input.processing.expectedPageCount,
    0,
    MAX_PAGES,
  );
  requireIntegerInRange(
    "expectedEvidenceSpanCount",
    input.processing.expectedEvidenceSpanCount,
    0,
    MAX_EVIDENCE_SPANS,
  );
  requireIntegerInRange(
    "expectedDocumentCount",
    input.processing.expectedDocumentCount,
    0,
    MAX_DOCUMENTS,
  );
  requireIntegerInRange(
    "expectedChunkCount",
    input.processing.expectedChunkCount,
    0,
    MAX_CHUNKS,
  );
  requireIntegerInRange(
    "expectedEventCount",
    input.processing.expectedEventCount ?? 0,
    0,
    MAX_EVENTS_PER_GENERATION,
  );
  requireIntegerInRange(
    "expectedObservationCount",
    input.processing.expectedObservationCount ?? 0,
    0,
    MAX_OBSERVATIONS_PER_GENERATION,
  );
}

function admissionResult(
  receipt: Doc<"ingestRequests">,
  job: Doc<"ingestJobs">,
  reused: boolean,
): AdmissionResult {
  return {
    sourceItemId: receipt.sourceItemId,
    sourceRevisionId: receipt.sourceRevisionId,
    processingGenerationId: receipt.processingGenerationId,
    ingestJobId: receipt.ingestJobId,
    state: job.state,
    reused,
  };
}

/** Trusted mutation primitive. The caller must pass a PrincipalRef, never grants. */
export async function admitSourceRevision(
  ctx: MutationCtx,
  input: AdmissionInput,
): Promise<AdmissionResult> {
  assertAdmissionBounds(input);
  const account = await requireSourceAccountAccess(
    ctx,
    input.principal,
    input.sourceAccountId,
    "ingest",
  );
  const requestDigest = await digestDecodedAdmissionEnvelope({
    sourceAccountId: input.sourceAccountId,
    expectedDesiredProcessingEpoch: input.expectedDesiredProcessingEpoch,
    ...input.source,
    ...input.processing,
  });
  const item = await createOrGetSourceItem(ctx, {
    spaceId: account.spaceId,
    sourceAccountId: account._id,
    externalId: input.source.externalId,
    title: input.source.title,
    docType: input.source.docType,
    uri: input.source.uri,
  });
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    throw new Error("Source item is not available for admission");
  }
  const metadataChangesAssessment =
    item.lifecycle !== "available" ||
    item.title !== input.source.title ||
    item.docType !== input.source.docType ||
    item.uri !== input.source.uri ||
    item.originalLinkAvailable !== (input.source.uri !== undefined);

  const priorReceipts = await ctx.db
    .query("ingestRequests")
    .withIndex("by_sourceAccountId_and_requestId", (q) =>
      q
        .eq("sourceAccountId", input.sourceAccountId)
        .eq("requestId", input.requestId),
    )
    .take(2);
  if (priorReceipts.length > 1)
    throw new Error("Duplicate ingest request identity");
  const prior = priorReceipts[0];
  if (prior) {
    if (prior.requestDigest !== requestDigest) {
      throw new Error("requestId conflicts with a different request");
    }
    const job = await ctx.db.get(prior.ingestJobId);
    if (!job) throw new Error("Ingest receipt is incomplete");
    return admissionResult(prior, job, true);
  }

  if (item.desiredProcessingEpoch !== input.expectedDesiredProcessingEpoch) {
    throw new Error("Desired processing epoch conflict");
  }
  await refreshAvailableSourceItem(ctx, {
    spaceId: account.spaceId,
    sourceItemId: item._id,
    title: input.source.title,
    docType: input.source.docType,
    uri: input.source.uri,
  });
  const contentHash = await sha256Utf8(input.source.inlineText);
  const matchingRevisions = await ctx.db
    .query("sourceRevisions")
    .withIndex("by_sourceItemId_and_contentHash", (q) =>
      q.eq("sourceItemId", item._id).eq("contentHash", contentHash),
    )
    .take(2);
  if (matchingRevisions.length > 1) {
    throw new Error("Duplicate source revision identity");
  }
  const priorRevision = matchingRevisions[0];
  if (
    priorRevision &&
    (priorRevision.spaceId !== account.spaceId ||
      priorRevision.inlineText !== input.source.inlineText ||
      priorRevision.contentHash !== contentHash)
  ) {
    throw new Error("Source revision hash collision or damaged content");
  }
  // Revision identity is item + exact byte hash. A later observation of the
  // same bytes retains the first immutable capture metadata; its new actor is
  // still recorded on the request receipt.
  const revision =
    priorRevision ??
    (await createOrGetRevision(ctx, {
      spaceId: account.spaceId,
      sourceItemId: item._id,
      mediaType: input.source.mediaType,
      inlineText: input.source.inlineText,
      capturedAt: input.source.capturedAt,
      userId: input.principal.userId,
    }));
  const processingFingerprint = await digestProcessingConfiguration(
    input.processing,
  );
  const generations = await ctx.db
    .query("processingGenerations")
    .withIndex("by_sourceRevisionId_and_processingFingerprint", (q) =>
      q
        .eq("sourceRevisionId", revision._id)
        .eq("processingFingerprint", processingFingerprint),
    )
    .take(2);
  if (generations.length > 1) {
    throw new Error("Duplicate processing generation identity");
  }
  const existingGeneration = generations[0];
  if (existingGeneration) {
    if (
      existingGeneration.spaceId !== account.spaceId ||
      existingGeneration.sourceAccountId !== account._id ||
      existingGeneration.sourceItemId !== item._id ||
      existingGeneration.expectedPageCount !==
        input.processing.expectedPageCount ||
      existingGeneration.expectedEvidenceSpanCount !==
        input.processing.expectedEvidenceSpanCount ||
      existingGeneration.expectedDocumentCount !==
        input.processing.expectedDocumentCount ||
      existingGeneration.expectedChunkCount !==
        input.processing.expectedChunkCount ||
      (existingGeneration.expectedEventCount ?? 0) !==
        (input.processing.expectedEventCount ?? 0) ||
      (existingGeneration.expectedObservationCount ?? 0) !==
        (input.processing.expectedObservationCount ?? 0)
    ) {
      throw new Error(
        "Processing generation manifest conflicts with prior work",
      );
    }
    if (
      item.desiredRevisionId !== revision._id ||
      item.desiredProcessingEpoch !== existingGeneration.desiredProcessingEpoch
    ) {
      throw new Error(
        "Processing configuration was already used; increment correctionRevision",
      );
    }
    const jobs = await ctx.db
      .query("ingestJobs")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", existingGeneration._id),
      )
      .take(2);
    if (jobs.length !== 1)
      throw new Error("Processing generation job is invalid");
    const job = jobs[0]!;
    if (metadataChangesAssessment) {
      await advanceSourceAssessmentEpoch(ctx, account._id);
    }
    const receiptId = await ctx.db.insert("ingestRequests", {
      spaceId: account.spaceId,
      sourceAccountId: account._id,
      requestId: input.requestId,
      requestDigest,
      sourceItemId: item._id,
      sourceRevisionId: revision._id,
      processingGenerationId: existingGeneration._id,
      ingestJobId: job._id,
      actorUserId: input.principal.userId,
      ...(input.principal.credentialId
        ? { actorCredentialId: input.principal.credentialId }
        : {}),
    });
    const receipt = await ctx.db.get(receiptId);
    if (!receipt) throw new Error("Failed to create ingest receipt");
    return admissionResult(receipt, job, true);
  }

  const desiredProcessingEpoch = item.desiredProcessingEpoch + 1;
  await setDesiredSourceRevision(ctx, {
    spaceId: account.spaceId,
    sourceItemId: item._id,
    desiredRevisionId: revision._id,
    expectedDesiredProcessingEpoch: input.expectedDesiredProcessingEpoch,
  });
  await advanceSourceAssessmentEpoch(ctx, account._id);
  const processingGenerationId = await ctx.db.insert("processingGenerations", {
    spaceId: account.spaceId,
    sourceAccountId: account._id,
    sourceItemId: item._id,
    sourceRevisionId: revision._id,
    processingFingerprint,
    extractionFingerprint: input.processing.extractionFingerprint,
    extractorFingerprint: input.processing.extractorFingerprint,
    recordSchemaFingerprint: input.processing.recordSchemaFingerprint,
    normalizationFingerprint: input.processing.normalizationFingerprint,
    chunkerFingerprint: input.processing.chunkerFingerprint,
    correctionRevision: input.processing.correctionRevision,
    desiredProcessingEpoch,
    state: "queued",
    expectedPageCount: input.processing.expectedPageCount,
    expectedEvidenceSpanCount: input.processing.expectedEvidenceSpanCount,
    expectedDocumentCount: input.processing.expectedDocumentCount,
    expectedChunkCount: input.processing.expectedChunkCount,
    expectedEventCount: input.processing.expectedEventCount ?? 0,
    expectedObservationCount: input.processing.expectedObservationCount ?? 0,
    embeddingStatus: "unavailable",
  });
  const ingestJobId = await ctx.db.insert("ingestJobs", {
    spaceId: account.spaceId,
    sourceAccountId: account._id,
    sourceItemId: item._id,
    sourceRevisionId: revision._id,
    processingGenerationId,
    admittedByUserId: input.principal.userId,
    ...(input.principal.credentialId
      ? { admittedByCredentialId: input.principal.credentialId }
      : {}),
    actorUserId: input.principal.userId,
    ...(input.principal.credentialId
      ? { actorCredentialId: input.principal.credentialId }
      : {}),
    desiredProcessingEpoch,
    state: "queued",
    attempts: 0,
    leaseEpoch: 0,
  });
  const receiptId = await ctx.db.insert("ingestRequests", {
    spaceId: account.spaceId,
    sourceAccountId: account._id,
    requestId: input.requestId,
    requestDigest,
    sourceItemId: item._id,
    sourceRevisionId: revision._id,
    processingGenerationId,
    ingestJobId,
    actorUserId: input.principal.userId,
    ...(input.principal.credentialId
      ? { actorCredentialId: input.principal.credentialId }
      : {}),
  });
  const [receipt, job] = await Promise.all([
    ctx.db.get(receiptId),
    ctx.db.get(ingestJobId),
  ]);
  if (!receipt || !job) throw new Error("Failed to create ingest work");
  return admissionResult(receipt, job, false);
}

async function authorizeJobOperation(
  ctx: MutationCtx,
  executingPrincipal: PrincipalRef,
  job: Doc<"ingestJobs">,
): Promise<void> {
  const account = await requireSourceAccountAccess(
    ctx,
    executingPrincipal,
    job.sourceAccountId,
    "ingest",
  );
  await requireSourceAccountAccess(
    ctx,
    {
      userId: job.actorUserId,
      ...(job.actorCredentialId ? { credentialId: job.actorCredentialId } : {}),
    },
    job.sourceAccountId,
    "ingest",
  );
  await validateJobParentChain(ctx, job, account.spaceId);
}

async function validateJobParentChain(
  ctx: MutationCtx,
  job: Doc<"ingestJobs">,
  authorizedSpaceId: Id<"spaces">,
): Promise<void> {
  const [item, revision, generation] = await Promise.all([
    ctx.db.get(job.sourceItemId),
    ctx.db.get(job.sourceRevisionId),
    ctx.db.get(job.processingGenerationId),
  ]);
  if (
    authorizedSpaceId !== job.spaceId ||
    !item ||
    item.spaceId !== job.spaceId ||
    item.sourceAccountId !== job.sourceAccountId ||
    !revision ||
    revision.spaceId !== job.spaceId ||
    revision.sourceItemId !== job.sourceItemId ||
    !generation ||
    generation.spaceId !== job.spaceId ||
    generation.sourceAccountId !== job.sourceAccountId ||
    generation.sourceItemId !== job.sourceItemId ||
    generation.sourceRevisionId !== job.sourceRevisionId ||
    generation._id !== job.processingGenerationId ||
    generation.desiredProcessingEpoch !== job.desiredProcessingEpoch
  ) {
    throw new Error("Ingest job parent chain is invalid");
  }
}

async function loadAuthorizedJob(
  ctx: MutationCtx,
  principal: PrincipalRef,
  jobId: Id<"ingestJobs">,
): Promise<Doc<"ingestJobs">> {
  const job = await ctx.db.get(jobId);
  if (!job) throw new Error("Ingest job not found");
  await authorizeJobOperation(ctx, principal, job);
  return job;
}

async function markObsolete(
  ctx: MutationCtx,
  job: Doc<"ingestJobs">,
): Promise<"obsolete_generation"> {
  await ctx.db.patch(job._id, {
    state: "obsolete_generation",
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    workerLeaseOwnerCredentialId: undefined,
    nextAttemptAt: undefined,
    error: undefined,
  });
  const generation = await ctx.db.get(job.processingGenerationId);
  if (generation && generation.state !== "ready") {
    await ctx.db.patch(generation._id, { state: "obsolete_generation" });
  }
  return "obsolete_generation";
}

async function desiredStillMatches(
  ctx: MutationCtx,
  job: Doc<"ingestJobs">,
): Promise<boolean> {
  const item = await ctx.db.get(job.sourceItemId);
  return Boolean(
    item &&
    item.lifecycle !== "forgetting" &&
    item.lifecycle !== "forgotten" &&
    item.desiredRevisionId === job.sourceRevisionId &&
    item.desiredProcessingEpoch === job.desiredProcessingEpoch,
  );
}

function assertLease(
  job: Doc<"ingestJobs">,
  leaseEpoch: number,
  leaseToken: string,
  now: number,
): void {
  requireBoundedString("leaseToken", leaseToken, MAX_LEASE_TOKEN_LENGTH);
  if (
    job.leaseEpoch !== leaseEpoch ||
    job.leaseToken !== leaseToken ||
    job.leaseExpiresAt === undefined ||
    job.leaseExpiresAt <= now
  ) {
    throw new Error("Worker lease is not current");
  }
}

export async function claimJob(
  ctx: MutationCtx,
  args: {
    principal: PrincipalRef;
    jobId: Id<"ingestJobs">;
    leaseToken: string;
    leaseDurationMs: number;
    now: number;
  },
): Promise<{
  state: "processing" | "staged" | "obsolete_generation";
  leaseEpoch: number;
  leaseExpiresAt?: number;
}> {
  requireBoundedString("leaseToken", args.leaseToken, MAX_LEASE_TOKEN_LENGTH);
  requireIntegerInRange(
    "leaseDurationMs",
    args.leaseDurationMs,
    1,
    MAX_LEASE_MS,
  );
  const job = await loadAuthorizedJob(ctx, args.principal, args.jobId);
  if (job.state === "ready" || job.state === "obsolete_generation") {
    throw new Error("Ingest job cannot be claimed");
  }
  if (!(await desiredStillMatches(ctx, job))) {
    return {
      state: await markObsolete(ctx, job),
      leaseEpoch: job.leaseEpoch,
    };
  }
  if (job.state === "needs_review") {
    throw new Error("Ingest job requires explicit review requeue");
  }
  if (job.attempts >= MAX_JOB_ATTEMPTS) {
    throw new Error("Ingest job attempt limit reached");
  }
  if (
    job.leaseExpiresAt !== undefined &&
    job.leaseExpiresAt > args.now &&
    job.leaseToken !== undefined
  ) {
    throw new Error("Ingest job is already leased");
  }
  if (job.state === "failed" && (job.nextAttemptAt ?? Infinity) > args.now) {
    throw new Error("Ingest job is not eligible for retry yet");
  }
  const state = job.state === "staged" ? "staged" : "processing";
  const leaseEpoch = job.leaseEpoch + 1;
  const leaseExpiresAt = args.now + args.leaseDurationMs;
  await ctx.db.patch(job._id, {
    state,
    attempts: job.attempts + 1,
    leaseEpoch,
    leaseToken: args.leaseToken,
    leaseExpiresAt,
    nextAttemptAt: undefined,
    error: undefined,
  });
  await ctx.db.patch(job.processingGenerationId, { state });
  return { state, leaseEpoch, leaseExpiresAt };
}

export async function renewJobLease(
  ctx: MutationCtx,
  args: {
    principal: PrincipalRef;
    jobId: Id<"ingestJobs">;
    leaseEpoch: number;
    leaseToken: string;
    leaseDurationMs: number;
    now: number;
  },
) {
  requireIntegerInRange(
    "leaseDurationMs",
    args.leaseDurationMs,
    1,
    MAX_LEASE_MS,
  );
  const job = await loadAuthorizedJob(ctx, args.principal, args.jobId);
  assertLease(job, args.leaseEpoch, args.leaseToken, args.now);
  if (job.state !== "processing" && job.state !== "staged") {
    throw new Error("Ingest job is not renewable");
  }
  if (!(await desiredStillMatches(ctx, job))) {
    return { state: await markObsolete(ctx, job) };
  }
  const leaseExpiresAt = args.now + args.leaseDurationMs;
  await ctx.db.patch(job._id, { leaseExpiresAt });
  return { state: job.state, leaseExpiresAt };
}

async function loadLeasedGeneration(
  ctx: MutationCtx,
  args: {
    principal: PrincipalRef;
    jobId: Id<"ingestJobs">;
    leaseEpoch: number;
    leaseToken: string;
    now: number;
  },
) {
  const job = await loadAuthorizedJob(ctx, args.principal, args.jobId);
  assertLease(job, args.leaseEpoch, args.leaseToken, args.now);
  if (job.state !== "processing" && job.state !== "staged") {
    throw new Error("Ingest job is not writable");
  }
  if (!(await desiredStillMatches(ctx, job))) {
    await markObsolete(ctx, job);
    return { state: "obsolete_generation" as const };
  }
  const generation = await ctx.db.get(job.processingGenerationId);
  if (!generation) throw new Error("Processing generation not found");
  return { state: job.state, job, generation };
}

function requireLegacyStaging(
  loaded: Exclude<
    Awaited<ReturnType<typeof loadLeasedGeneration>>,
    { state: "obsolete_generation" }
  >,
) {
  if (
    loaded.job.workerProcessingMode === "parsed_pages_v1" ||
    loaded.generation.parserArtifactId !== undefined
  ) {
    throw new Error("Parsed generations require parsed staging operations");
  }
}

export async function createGenerationTextVersion(
  ctx: MutationCtx,
  args: {
    principal: PrincipalRef;
    jobId: Id<"ingestJobs">;
    leaseEpoch: number;
    leaseToken: string;
    now: number;
    text: string;
  },
) {
  const loaded = await loadLeasedGeneration(ctx, args);
  if (loaded.state === "obsolete_generation") return loaded;
  requireLegacyStaging(loaded);
  if (utf8ByteLength(args.text) > MAX_INLINE_TEXT_BYTES) {
    throw new Error("text exceeds the supported byte limit");
  }
  const textVersion = await createOrGetTextVersion(ctx, {
    spaceId: loaded.generation.spaceId,
    sourceRevisionId: loaded.generation.sourceRevisionId,
    extractionFingerprint: loaded.generation.extractionFingerprint,
    text: args.text,
  });
  if (
    loaded.generation.sourceTextVersionId !== undefined &&
    loaded.generation.sourceTextVersionId !== textVersion._id
  ) {
    throw new Error("Processing generation text version conflict");
  }
  if (loaded.generation.sourceTextVersionId === undefined) {
    await ctx.db.patch(loaded.generation._id, {
      sourceTextVersionId: textVersion._id,
    });
  }
  return { state: loaded.state, sourceTextVersionId: textVersion._id };
}

export async function stageGenerationPages(
  ctx: MutationCtx,
  args: {
    principal: PrincipalRef;
    jobId: Id<"ingestJobs">;
    leaseEpoch: number;
    leaseToken: string;
    now: number;
    pages: Array<{ ordinal: number; start: number; end: number; text: string }>;
  },
) {
  const loaded = await loadLeasedGeneration(ctx, args);
  if (loaded.state === "obsolete_generation") return loaded;
  requireLegacyStaging(loaded);
  if (!loaded.generation.sourceTextVersionId) {
    throw new Error("Processing generation has no text version");
  }
  assertStageBatch(args.pages.map((page) => page.text));
  const ids = await stagePages(ctx, {
    spaceId: loaded.generation.spaceId,
    sourceTextVersionId: loaded.generation.sourceTextVersionId,
    pages: args.pages,
  });
  return { state: loaded.state, ids };
}

type EvidenceLocator = Doc<"evidenceSpans">["locator"];

export async function stageGenerationEvidenceSpans(
  ctx: MutationCtx,
  args: {
    principal: PrincipalRef;
    jobId: Id<"ingestJobs">;
    leaseEpoch: number;
    leaseToken: string;
    now: number;
    spans: Array<{
      sourcePageId: Id<"sourcePages">;
      ordinal: number;
      start: number;
      end: number;
      locator?: EvidenceLocator;
    }>;
  },
) {
  const loaded = await loadLeasedGeneration(ctx, args);
  if (loaded.state === "obsolete_generation") return loaded;
  requireLegacyStaging(loaded);
  if (!loaded.generation.sourceTextVersionId) {
    throw new Error("Processing generation has no text version");
  }
  assertStageBatch([], args.spans.length);
  const ids = await stageEvidenceSpans(ctx, {
    spaceId: loaded.generation.spaceId,
    sourceRevisionId: loaded.generation.sourceRevisionId,
    sourceTextVersionId: loaded.generation.sourceTextVersionId,
    spans: args.spans,
  });
  return { state: loaded.state, ids };
}

export async function stageGenerationDocuments(
  ctx: MutationCtx,
  args: {
    principal: PrincipalRef;
    jobId: Id<"ingestJobs">;
    leaseEpoch: number;
    leaseToken: string;
    now: number;
    documents: Array<{
      documentKey: string;
      title: string;
      docType: string;
      capturedAt: number;
      evidenceSpanIds: Id<"evidenceSpans">[];
    }>;
  },
) {
  const loaded = await loadLeasedGeneration(ctx, args);
  if (loaded.state === "obsolete_generation") return loaded;
  requireLegacyStaging(loaded);
  if (!loaded.generation.sourceTextVersionId) {
    throw new Error("Processing generation has no text version");
  }
  assertStageBatch(
    args.documents.flatMap((document) => [
      document.documentKey,
      document.title,
      document.docType,
    ]),
    args.documents.length,
  );
  const ids = await stageDocuments(ctx, {
    spaceId: loaded.generation.spaceId,
    processingGenerationId: loaded.generation._id,
    sourceItemId: loaded.generation.sourceItemId,
    sourceRevisionId: loaded.generation.sourceRevisionId,
    sourceTextVersionId: loaded.generation.sourceTextVersionId,
    documents: args.documents,
  });
  return { state: loaded.state, ids };
}

export async function stageGenerationChunks(
  ctx: MutationCtx,
  args: {
    principal: PrincipalRef;
    jobId: Id<"ingestJobs">;
    leaseEpoch: number;
    leaseToken: string;
    now: number;
    chunks: Array<{
      documentId: Id<"documents">;
      ordinal: number;
      text: string;
      evidenceSpanIds: Id<"evidenceSpans">[];
    }>;
  },
) {
  const loaded = await loadLeasedGeneration(ctx, args);
  if (loaded.state === "obsolete_generation") return loaded;
  requireLegacyStaging(loaded);
  assertStageBatch(args.chunks.map((chunk) => chunk.text));
  const ids = await stageChunks(ctx, {
    spaceId: loaded.generation.spaceId,
    processingGenerationId: loaded.generation._id,
    chunks: args.chunks,
  });
  return { state: loaded.state, ids };
}

/** Typed records inherit the worker lease and live source authorization. */
export async function stageGenerationRecords(
  ctx: MutationCtx,
  args: {
    principal: PrincipalRef;
    jobId: Id<"ingestJobs">;
    leaseEpoch: number;
    leaseToken: string;
    now: number;
    records: StagedEventRecord[];
  },
) {
  const loaded = await loadLeasedGeneration(ctx, args);
  if (loaded.state === "obsolete_generation") return loaded;
  requireLegacyStaging(loaded);
  const result = await stageRecordBatch(ctx, {
    spaceId: loaded.generation.spaceId,
    processingGenerationId: loaded.generation._id,
    userId: args.principal.userId,
    records: args.records,
  });
  return { state: loaded.state, ...result };
}

function assertStageBatch(text: string[], rowCount = text.length): void {
  if (rowCount > MAX_STAGE_ROWS) throw new Error("Staging row limit exceeded");
  const bytes = text.reduce((sum, value) => sum + utf8ByteLength(value), 0);
  if (bytes > MAX_STAGE_TEXT_BYTES) {
    throw new Error("Staging text byte limit exceeded");
  }
}

function assertExactOrdinals(
  values: number[],
  expectedCount: number,
  label: string,
): void {
  const sorted = [...values].sort((a, b) => a - b);
  if (
    sorted.length !== expectedCount ||
    sorted.some((value, index) => value !== index)
  ) {
    throw new Error(`${label} ordinals are incomplete`);
  }
}

async function verifyGenerationPayload(
  ctx: MutationCtx,
  generation: Doc<"processingGenerations">,
  parsedBudget?: PayloadReadBudget,
) {
  if (!generation.sourceTextVersionId) {
    throw new Error("Processing generation has no text version");
  }
  const [textVersion, revision] = await Promise.all([
    ctx.db.get(generation.sourceTextVersionId),
    ctx.db.get(generation.sourceRevisionId),
  ]);
  if (
    !textVersion ||
    textVersion.spaceId !== generation.spaceId ||
    textVersion.sourceRevisionId !== generation.sourceRevisionId ||
    !revision ||
    revision.spaceId !== generation.spaceId ||
    revision.sourceItemId !== generation.sourceItemId
  ) {
    throw new Error("Processing generation text parent chain is invalid");
  }
  const textRepresentation = parseSourceTextRepresentation(textVersion);
  if (textRepresentation.kind === "parsed_pages_v1") {
    return await verifySealedParsedPayload(ctx, generation, parsedBudget);
  }
  const [pages, spans, documents, chunks] = await Promise.all([
    ctx.db
      .query("sourcePages")
      .withIndex("by_sourceTextVersionId", (q) =>
        q.eq("sourceTextVersionId", generation.sourceTextVersionId!),
      )
      .take(MAX_PAGES + 1),
    ctx.db
      .query("evidenceSpans")
      .withIndex("by_sourceTextVersionId", (q) =>
        q.eq("sourceTextVersionId", generation.sourceTextVersionId!),
      )
      .take(MAX_EVIDENCE_SPANS + 1),
    ctx.db
      .query("documents")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", generation._id),
      )
      .take(MAX_DOCUMENTS + 1),
    ctx.db
      .query("chunks")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", generation._id),
      )
      .take(MAX_CHUNKS + 1),
  ]);
  const inlineRevision = requireInlineSourceRevision(revision);
  const inlineTextVersion = requireInlineSourceTextVersion(textVersion);
  if (
    revision.byteLength !== utf8ByteLength(inlineRevision.text) ||
    (await sha256Utf8(inlineRevision.text)) !== revision.contentHash
  ) {
    throw new Error("Source revision length or content hash is invalid");
  }
  if (
    textVersion.byteLength !== utf8ByteLength(inlineTextVersion.text) ||
    (await sha256Utf8(inlineTextVersion.text)) !== textVersion.textHash
  ) {
    throw new Error("Source text version length or hash is invalid");
  }
  if (
    pages.length > MAX_PAGES ||
    spans.length > MAX_EVIDENCE_SPANS ||
    documents.length > MAX_DOCUMENTS ||
    chunks.length > MAX_CHUNKS
  ) {
    throw new Error("Processing generation payload exceeds supported limits");
  }
  if (
    pages.length !== generation.expectedPageCount ||
    spans.length !== generation.expectedEvidenceSpanCount ||
    documents.length !== generation.expectedDocumentCount ||
    chunks.length !== generation.expectedChunkCount
  ) {
    throw new Error("Processing generation counts are incomplete");
  }
  assertExactOrdinals(
    pages.map((page) => page.ordinal),
    generation.expectedPageCount,
    "Page",
  );
  const orderedPages = [...pages].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  let pageCursor = 0;
  for (const page of orderedPages) {
    if (
      page.start !== pageCursor ||
      page.end < page.start ||
      splitsSurrogatePair(inlineTextVersion.text, page.start) ||
      splitsSurrogatePair(inlineTextVersion.text, page.end) ||
      inlineTextVersion.text.slice(page.start, page.end) !== page.text ||
      (await sha256Utf8(page.text)) !== page.textHash
    ) {
      throw new Error("Page text coverage or hash is invalid");
    }
    pageCursor = page.end;
  }
  if (pageCursor !== inlineTextVersion.text.length) {
    throw new Error("Pages do not exactly cover the source text version");
  }
  const spanIds = new Set(spans.map((span) => span._id));
  for (const page of pages) {
    if (page.spaceId !== generation.spaceId) {
      throw new Error("Page crosses processing generation space");
    }
  }
  const spanOrdinals = new Map<Id<"sourcePages">, number[]>();
  const pagesById = new Map(pages.map((page) => [page._id, page]));
  for (const span of spans) {
    const page = pagesById.get(span.sourcePageId);
    if (
      span.spaceId !== generation.spaceId ||
      span.sourceRevisionId !== generation.sourceRevisionId ||
      span.sourceTextVersionId !== generation.sourceTextVersionId ||
      !page
    ) {
      throw new Error("Evidence span crosses processing generation parents");
    }
    if (
      span.start < 0 ||
      span.end <= span.start ||
      span.end > page.text.length ||
      splitsSurrogatePair(page.text, span.start) ||
      splitsSurrogatePair(page.text, span.end) ||
      (await sha256Utf8(page.text.slice(span.start, span.end))) !==
        span.quoteHash
    ) {
      throw new Error("Evidence span offsets or quote hash are invalid");
    }
    const ordinals = spanOrdinals.get(span.sourcePageId) ?? [];
    ordinals.push(span.ordinal);
    spanOrdinals.set(span.sourcePageId, ordinals);
  }
  for (const ordinals of spanOrdinals.values()) {
    assertExactOrdinals(ordinals, ordinals.length, "Evidence span");
  }
  const documentKeys = new Set<string>();
  for (const document of documents) {
    if (
      document.spaceId !== generation.spaceId ||
      document.sourceItemId !== generation.sourceItemId ||
      document.sourceRevisionId !== generation.sourceRevisionId ||
      document.sourceTextVersionId !== generation.sourceTextVersionId ||
      document.publicationState !== "staged" ||
      documentKeys.has(document.documentKey) ||
      new Set(document.evidenceSpanIds).size !==
        document.evidenceSpanIds.length ||
      document.evidenceSpanIds.some((id) => !spanIds.has(id))
    ) {
      throw new Error("Document crosses processing generation parents");
    }
    documentKeys.add(document.documentKey);
  }
  const chunkOrdinals = new Map<Id<"documents">, number[]>();
  for (const chunk of chunks) {
    const document = documents.find((row) => row._id === chunk.documentId);
    if (
      chunk.spaceId !== generation.spaceId ||
      chunk.processingGenerationId !== generation._id ||
      chunk.publicationState !== "staged" ||
      !document ||
      new Set(chunk.evidenceSpanIds).size !== chunk.evidenceSpanIds.length ||
      chunk.evidenceSpanIds.some(
        (id) => !spanIds.has(id) || !document.evidenceSpanIds.includes(id),
      ) ||
      utf8ByteLength(chunk.text) > MAX_CHUNK_TEXT_UTF8_BYTES
    ) {
      throw new Error("Chunk crosses processing generation parents");
    }
    const ordinals = chunkOrdinals.get(chunk.documentId) ?? [];
    ordinals.push(chunk.ordinal);
    chunkOrdinals.set(chunk.documentId, ordinals);
  }
  if (
    chunks.reduce((total, chunk) => total + utf8ByteLength(chunk.text), 0) >
    MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES
  ) {
    throw new Error("Generation chunk text exceeds the supported byte limit");
  }
  for (const document of documents) {
    const ordinals = chunkOrdinals.get(document._id) ?? [];
    assertExactOrdinals(ordinals, ordinals.length, "Chunk");
  }
  const records = await validateGenerationRecords(ctx, {
    spaceId: generation.spaceId,
    processingGenerationId: generation._id,
    expectedEventCount: generation.expectedEventCount ?? 0,
    expectedObservationCount: generation.expectedObservationCount ?? 0,
  });
  return {
    actualEventCount: records.eventVersions.length,
    actualObservationCount: records.observations.length,
    actualPageCount: pages.length,
    actualEvidenceSpanCount: spans.length,
    actualDocumentCount: documents.length,
    actualChunkCount: chunks.length,
  };
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return (
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
  );
}

export async function stageGeneration(
  ctx: MutationCtx,
  args: {
    principal: PrincipalRef;
    jobId: Id<"ingestJobs">;
    leaseEpoch: number;
    leaseToken: string;
    now: number;
  },
) {
  const loaded = await loadLeasedGeneration(ctx, args);
  if (loaded.state === "obsolete_generation") return loaded;
  requireLegacyStaging(loaded);
  const counts = await verifyGenerationPayload(ctx, loaded.generation);
  await ctx.db.patch(loaded.generation._id, { state: "staged", ...counts });
  await ctx.db.patch(loaded.job._id, { state: "staged" });
  return { state: "staged" as const, ...counts };
}

export async function failJob(
  ctx: MutationCtx,
  args: {
    principal: PrincipalRef;
    jobId: Id<"ingestJobs">;
    leaseEpoch: number;
    leaseToken: string;
    now: number;
    code: string;
    message: string;
    retryable: boolean;
    nextAttemptAt?: number;
    needsReview?: boolean;
  },
) {
  requireBoundedString("error.code", args.code, MAX_ERROR_CODE_LENGTH);
  requireBoundedString("error.message", args.message, MAX_ERROR_MESSAGE_LENGTH);
  const job = await loadAuthorizedJob(ctx, args.principal, args.jobId);
  assertLease(job, args.leaseEpoch, args.leaseToken, args.now);
  if (!(await desiredStillMatches(ctx, job))) {
    return { state: await markObsolete(ctx, job) };
  }
  if (args.retryable && args.nextAttemptAt === undefined) {
    throw new Error("Retryable failure requires nextAttemptAt");
  }
  if (
    args.nextAttemptAt !== undefined &&
    (!Number.isFinite(args.nextAttemptAt) || args.nextAttemptAt < args.now)
  ) {
    throw new Error("nextAttemptAt is invalid");
  }
  const retryable =
    !args.needsReview && args.retryable && job.attempts < MAX_JOB_ATTEMPTS;
  const state = args.needsReview ? "needs_review" : "failed";
  const error = {
    code: args.code,
    message: args.message,
    retryable,
    at: args.now,
  };
  await ctx.db.patch(job._id, {
    state,
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    workerLeaseOwnerCredentialId: undefined,
    nextAttemptAt: retryable ? args.nextAttemptAt : undefined,
    error,
  });
  await ctx.db.patch(job.processingGenerationId, { state });
  await setSourceItemFailure(ctx, {
    spaceId: job.spaceId,
    sourceItemId: job.sourceItemId,
    code: args.code,
    message: args.message,
    at: args.now,
  });
  return { state, retryable };
}

export async function requeueJob(
  ctx: MutationCtx,
  args: {
    principal: PrincipalRef;
    jobId: Id<"ingestJobs">;
    now: number;
  },
) {
  const job = await loadAuthorizedJob(ctx, args.principal, args.jobId);
  if (job.state === "ready" || job.state === "obsolete_generation") {
    throw new Error("Ingest job is not requeueable");
  }
  if (!(await desiredStillMatches(ctx, job))) {
    return { state: await markObsolete(ctx, job) };
  }
  if (job.state === "queued") return { state: "queued" as const };
  if (job.state !== "failed" && job.state !== "needs_review") {
    throw new Error("Ingest job is not requeueable");
  }
  if (job.attempts >= MAX_JOB_ATTEMPTS) {
    throw new Error("Ingest job attempt limit reached");
  }
  await ctx.db.patch(job._id, {
    state: "queued",
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    workerLeaseOwnerCredentialId: undefined,
    nextAttemptAt: args.now,
    error: undefined,
  });
  await ctx.db.patch(job.processingGenerationId, { state: "queued" });
  await resetInlineWorkForRequeue(ctx, job._id, args.now);
  return { state: "queued" as const };
}

async function resetInlineWorkForRequeue(
  ctx: MutationCtx,
  ingestJobId: Id<"ingestJobs">,
  now: number,
): Promise<void> {
  const rows = await ctx.db
    .query("inlineWork")
    .withIndex("by_ingestJobId", (q) => q.eq("ingestJobId", ingestJobId))
    .take(2);
  if (rows.length > 1) throw new Error("Inline work identity is invalid");
  if (rows[0]) {
    await ctx.db.patch(rows[0]._id, {
      state: "queued",
      nextAttemptAt: now,
      lastErrorCode: undefined,
      updatedAt: now,
    });
  }
}

/**
 * Explicit web-only recovery when the original API key is revoked. A regular
 * worker/requeue path never replaces the actor implicitly.
 */
export async function replaceRevokedActorAndRequeueFromWeb(
  ctx: MutationCtx,
  args: { principal: PrincipalRef; jobId: Id<"ingestJobs">; now: number },
) {
  if (args.principal.credentialId !== undefined) {
    throw new Error("Actor replacement requires a web session");
  }
  const job = await ctx.db.get(args.jobId);
  if (!job) throw new Error("Ingest job not found");
  const account = await requireSourceAccountAccess(
    ctx,
    args.principal,
    job.sourceAccountId,
    "ingest",
  );
  await validateJobParentChain(ctx, job, account.spaceId);
  if (job.workerDiscoveryWorkId !== undefined) {
    throw new Error(
      "Worker-linked ingest jobs require provenance-preserving recovery",
    );
  }
  if (job.state === "ready" || job.state === "obsolete_generation") {
    throw new Error("Ingest job is not eligible for actor replacement");
  }
  if (
    job.leaseExpiresAt !== undefined &&
    job.leaseExpiresAt > args.now &&
    job.leaseToken !== undefined
  ) {
    throw new Error("Ingest job lease must expire before actor replacement");
  }
  let originalActorStillAuthorized = true;
  try {
    await requireSourceAccountAccess(
      ctx,
      {
        userId: job.actorUserId,
        ...(job.actorCredentialId
          ? { credentialId: job.actorCredentialId }
          : {}),
      },
      job.sourceAccountId,
      "ingest",
    );
  } catch {
    originalActorStillAuthorized = false;
  }
  if (originalActorStillAuthorized) {
    throw new Error("Original ingest actor is still authorized");
  }
  if (!(await desiredStillMatches(ctx, job))) {
    return { state: await markObsolete(ctx, job) };
  }
  const state = job.state === "staged" ? "staged" : "queued";
  await ctx.db.patch(job._id, {
    actorUserId: args.principal.userId,
    actorCredentialId: undefined,
    actorReplacedAt: args.now,
    actorReplacedBy: args.principal.userId,
    state,
    nextAttemptAt: args.now,
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    error: undefined,
  });
  await ctx.db.patch(job.processingGenerationId, { state });
  await resetInlineWorkForRequeue(ctx, job._id, args.now);
  return { state };
}

export async function activateGeneration(
  ctx: MutationCtx,
  args: {
    principal: PrincipalRef;
    jobId: Id<"ingestJobs">;
    leaseEpoch: number;
    leaseToken: string;
    now: number;
  },
) {
  if (!Number.isFinite(args.now) || args.now < 0) {
    throw new Error("Activation time is invalid");
  }
  const loaded = await loadLeasedGeneration(ctx, args);
  if (loaded.state === "obsolete_generation") return loaded;
  if (loaded.job.state !== "staged" || loaded.generation.state !== "staged") {
    throw new Error("Processing generation is not staged");
  }
  const parsedBudget =
    loaded.generation.parserArtifactId === undefined
      ? undefined
      : new PayloadReadBudget(ctx);
  const counts = await verifyGenerationPayload(
    ctx,
    loaded.generation,
    parsedBudget,
  );
  if (
    loaded.generation.actualPageCount !== counts.actualPageCount ||
    loaded.generation.actualEvidenceSpanCount !==
      counts.actualEvidenceSpanCount ||
    loaded.generation.actualDocumentCount !== counts.actualDocumentCount ||
    loaded.generation.actualChunkCount !== counts.actualChunkCount ||
    (loaded.generation.actualEventCount ?? 0) !== counts.actualEventCount ||
    (loaded.generation.actualObservationCount ?? 0) !==
      counts.actualObservationCount
  ) {
    throw new Error("Staged generation counts changed before activation");
  }
  const item = await ctx.db.get(loaded.job.sourceItemId);
  if (
    !item ||
    item.lifecycle !== "available" ||
    item.desiredRevisionId !== loaded.job.sourceRevisionId ||
    item.desiredProcessingEpoch !== loaded.job.desiredProcessingEpoch
  ) {
    return { state: await markObsolete(ctx, loaded.job) };
  }
  const previousGenerationId = item.activeGenerationId;
  let previousGeneration: Doc<"processingGenerations"> | null = null;
  let previousChunks: Doc<"chunks">[] = [];
  const embeddingTarget = await getActiveEmbeddingTarget(
    ctx,
    loaded.job.spaceId,
  );
  if (previousGenerationId && previousGenerationId !== loaded.generation._id) {
    previousGeneration = await ctx.db.get(previousGenerationId);
    if (
      !previousGeneration ||
      previousGeneration.spaceId !== loaded.job.spaceId
    )
      throw new Error("Previous generation is invalid");
    if (embeddingTarget) {
      const previousChunkLimit = previousGeneration.parserArtifactId
        ? MAX_PARSED_CHUNKS
        : MAX_CHUNKS;
      if (parsedBudget) {
        await parsedBudget.finish();
        for await (const row of ctx.db
          .query("chunks")
          .withIndex("by_processingGenerationId", (q) =>
            q.eq("processingGenerationId", previousGenerationId),
          )) {
          boundedDocumentSize(row, 24 * 1024);
          if (previousChunks.length >= previousChunkLimit)
            throw new Error("Previous generation exceeds its chunk bound");
          previousChunks.push(row);
          await parsedBudget.finish();
        }
      } else {
        previousChunks = await ctx.db
          .query("chunks")
          .withIndex("by_processingGenerationId", (q) =>
            q.eq("processingGenerationId", previousGenerationId),
          )
          .take(previousChunkLimit + 1);
      }
      if (previousChunks.length > previousChunkLimit)
        throw new Error("Previous generation exceeds its chunk bound");
    }
  }
  await activateSourceItemGeneration(ctx, {
    spaceId: loaded.job.spaceId,
    sourceItemId: loaded.job.sourceItemId,
    sourceRevisionId: loaded.job.sourceRevisionId,
    processingGenerationId: loaded.generation._id,
    expectedPreviousGenerationId: previousGenerationId,
    expectedDesiredProcessingEpoch: loaded.job.desiredProcessingEpoch,
    ...(parsedBudget && "verifiedDocuments" in counts
      ? {
          verifiedPayload: {
            documents: counts.verifiedDocuments,
            chunks: counts.verifiedChunks,
          },
          payloadReadBudget: {
            measureRow: (row: Record<string, unknown>, maximumBytes: number) =>
              boundedDocumentSize(row as never, maximumBytes),
            finish: () => parsedBudget.finish(),
          },
        }
      : {}),
  });

  const activationState = await ctx.db
    .query("spaceProcessingState")
    .withIndex("by_spaceId", (q) => q.eq("spaceId", loaded.job.spaceId))
    .take(2);
  if (activationState.length > 1) {
    throw new Error("Space processing state is not unique");
  }
  const priorState = activationState[0];
  const activatedAt = await nextRecordActivationTime(ctx, {
    spaceId: loaded.job.spaceId,
    now: args.now,
    previousActivatedAt: priorState?.activatedAt,
  });
  if (priorState) {
    await ctx.db.patch(priorState._id, {
      activationEpoch: priorState.activationEpoch + 1,
      activatedAt,
    });
  } else {
    await ctx.db.insert("spaceProcessingState", {
      spaceId: loaded.job.spaceId,
      activationEpoch: 1,
      activatedAt,
    });
  }
  if (previousGenerationId && previousGenerationId !== loaded.generation._id) {
    await ctx.db.patch(previousGeneration!._id, { deactivatedAt: activatedAt });
    if (embeddingTarget) {
      // Historical text remains readable. Only obsolete vectors in the current
      // embedding generation are removed; retired profile generations survive.
      for (const chunk of previousChunks) {
        if (chunk.spaceId !== loaded.job.spaceId) {
          throw new Error("Previous chunk has an invalid space");
        }
        const vectors = await ctx.db
          .query("embeddingVectors")
          .withIndex("by_generation_and_chunkId", (q) =>
            q
              .eq(
                "embeddingGenerationId",
                embeddingTarget.embeddingGenerationId,
              )
              .eq("chunkId", chunk._id),
          )
          .take(2);
        if (parsedBudget) await parsedBudget.finish();
        if (vectors.length > 1)
          throw new Error("Duplicate active chunk vector");
        for (const vector of vectors) {
          if (
            vector.spaceId !== loaded.job.spaceId ||
            vector.targetKind !== "chunk" ||
            vector.processingGenerationId !== previousGenerationId ||
            vector.embeddingFingerprint !== embeddingTarget.fingerprint
          ) {
            throw new Error("Previous chunk vector has invalid parents");
          }
          await ctx.db.delete(vector._id);
        }
      }
    }
  }
  await ctx.db.patch(loaded.generation._id, {
    state: "ready",
    activatedAt,
  });
  await ctx.db.patch(loaded.job._id, {
    state: "ready",
    leaseToken: undefined,
    leaseExpiresAt: undefined,
    workerLeaseOwnerCredentialId: undefined,
    nextAttemptAt: undefined,
    error: undefined,
  });
  const account = await ctx.db.get(loaded.job.sourceAccountId);
  if (!account || account.spaceId !== loaded.job.spaceId) {
    throw new Error("Source account changed before activation");
  }
  await ctx.db.patch(account._id, {
    lastProcessedAt: Math.max(account.lastProcessedAt ?? 0, activatedAt),
  });
  await bumpEmbeddingEligibilityEpoch(ctx, loaded.job.spaceId);
  if (parsedBudget) await parsedBudget.finish();
  return {
    state: "ready" as const,
    activatedAt,
    previousGenerationId,
  };
}

export async function markSourceUnavailable(
  ctx: MutationCtx,
  args: { principal: PrincipalRef; sourceItemId: Id<"sourceItems"> },
) {
  const item = await ctx.db.get(args.sourceItemId);
  if (!item) throw new Error("Source item not found");
  const account = await requireSourceAccountAccess(
    ctx,
    args.principal,
    item.sourceAccountId,
    "ingest",
  );
  if (account.spaceId !== item.spaceId)
    throw new Error("Source item not found");
  const changesAssessment = item.lifecycle !== "unavailable";
  await markSourceItemUnavailable(ctx, {
    spaceId: item.spaceId,
    sourceItemId: item._id,
  });
  if (changesAssessment) {
    await advanceSourceAssessmentEpoch(ctx, account._id);
  }
  return { lifecycle: "unavailable" as const };
}

/** Explicit web operation: hiding the item and invalidating leases is atomic. */
export async function beginForgetFromWeb(
  ctx: MutationCtx,
  args: {
    principal: PrincipalRef;
    sourceItemId: Id<"sourceItems">;
    now: number;
  },
) {
  if (args.principal.credentialId !== undefined) {
    throw new Error("Forget requires a web session");
  }
  const item = await ctx.db.get(args.sourceItemId);
  if (!item) throw new Error("Source item not found");
  const account = await requireSourceAccountAccess(
    ctx,
    args.principal,
    item.sourceAccountId,
    "write",
  );
  if (account.spaceId !== item.spaceId)
    throw new Error("Source item not found");
  if (item.lifecycle === "forgotten") {
    return {
      lifecycle: "forgotten" as const,
      desiredProcessingEpoch: item.desiredProcessingEpoch,
    };
  }
  if (item.lifecycle === "forgetting") {
    return {
      lifecycle: "forgetting" as const,
      desiredProcessingEpoch: item.desiredProcessingEpoch,
    };
  }
  const desiredProcessingEpoch = await beginSourceItemForget(ctx, {
    spaceId: item.spaceId,
    sourceItemId: item._id,
    forgottenAt: args.now,
    forgottenBy: args.principal.userId,
  });
  if (account.connector === "fs") {
    await ctx.db.patch(item._id, {
      workerObservationEpoch: (item.workerObservationEpoch ?? 0) + 1,
    });
  }
  await ctx.db.patch(account._id, {
    coverageInvalidatedAt: Math.max(
      args.now,
      (account.coverageInvalidatedAt ?? 0) + 1,
    ),
    ...(account.connector === "fs"
      ? { manifestVersion: (account.manifestVersion ?? 0) + 1 }
      : {}),
  });
  await advanceSourceAssessmentEpoch(ctx, account._id);
  await bumpEmbeddingEligibilityEpoch(ctx, item.spaceId);
  return { lifecycle: "forgetting" as const, desiredProcessingEpoch };
}

async function eraseWorkerScanEntry(
  ctx: MutationCtx,
  item: Doc<"sourceItems">,
  entry: Doc<"workerScanEntries">,
): Promise<void> {
  if (
    entry.spaceId !== item.spaceId ||
    entry.sourceAccountId !== item.sourceAccountId
  ) {
    throw new Error("Worker scan entry parent chain is invalid");
  }
  const page = await ctx.db.get(entry.scanPageId);
  if (page) {
    if (
      page.spaceId !== item.spaceId ||
      page.sourceAccountId !== item.sourceAccountId ||
      page.scanId !== entry.scanId
    ) {
      throw new Error("Worker scan page parent chain is invalid");
    }
    // A page digest includes every entry's original metadata. A mixed page
    // loses its replay receipt when any constituent item is forgotten.
    await ctx.db.patch(page._id, {
      requestDigest: undefined,
      redactedAt: item.forgottenAt ?? Date.now(),
    });
  }
  await ctx.db.delete(entry._id);
}

/**
 * Deletes at most 25 rows per call and is safe to resume after a crash. The
 * item remains hidden for the entire workflow.
 */
export async function continueForgetFromWeb(
  ctx: MutationCtx,
  args: { principal: PrincipalRef; sourceItemId: Id<"sourceItems"> },
): Promise<{ phase: string; deleted: number; done: boolean }> {
  if (args.principal.credentialId !== undefined) {
    throw new Error("Forget requires a web session");
  }
  const item = await ctx.db.get(args.sourceItemId);
  if (!item) throw new Error("Source item not found");
  const account = await requireSourceAccountAccess(
    ctx,
    args.principal,
    item.sourceAccountId,
    "write",
  );
  if (account.spaceId !== item.spaceId)
    throw new Error("Source item not found");
  if (item.lifecycle === "forgotten") {
    return { phase: "complete", deleted: 0, done: true };
  }
  if (item.lifecycle !== "forgetting") {
    throw new Error("Source item is not being forgotten");
  }

  const sessions = await purgeRecordQuerySessionsForSpaceBatch(ctx, {
    spaceId: item.spaceId,
    limit: MAX_STAGE_ROWS,
  });
  if (sessions.deleted > 0 || !sessions.done) {
    return { phase: "recordQuerySessions", ...sessions, done: false };
  }
  const inlineWork = await ctx.db
    .query("inlineWork")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(MAX_STAGE_ROWS);
  for (const work of inlineWork) await ctx.db.delete(work._id);
  if (inlineWork.length > 0) {
    return { phase: "inlineWork", deleted: inlineWork.length, done: false };
  }
  const workerOperationReceipts = await ctx.db
    .query("workerOperationReceipts")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(MAX_STAGE_ROWS);
  for (const receipt of workerOperationReceipts) {
    if (
      receipt.spaceId !== item.spaceId ||
      receipt.sourceAccountId !== item.sourceAccountId
    ) {
      throw new Error("Worker operation receipt parent chain is invalid");
    }
    await ctx.db.delete(receipt._id);
  }
  if (workerOperationReceipts.length > 0) {
    return {
      phase: "workerOperationReceipts",
      deleted: workerOperationReceipts.length,
      done: false,
    };
  }
  const workerReservationTargets = await ctx.db
    .query("workerReservationTargets")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(MAX_STAGE_ROWS);
  for (const target of workerReservationTargets) {
    if (
      target.spaceId !== item.spaceId ||
      target.sourceAccountId !== item.sourceAccountId
    ) {
      throw new Error("Worker reservation target parent chain is invalid");
    }
    const receipt = await ctx.db.get(target.receiptId);
    if (receipt) {
      if (
        receipt.spaceId !== item.spaceId ||
        receipt.sourceAccountId !== item.sourceAccountId
      ) {
        throw new Error("Worker reservation receipt parent chain is invalid");
      }
      // Shared receipts cannot replay a partial target list after forgetting.
      // Other items keep their independent leases until normal expiry.
      await ctx.db.patch(receipt._id, {
        invalidatedAt: receipt.invalidatedAt ?? Date.now(),
      });
    }
    await ctx.db.delete(target._id);
  }
  if (workerReservationTargets.length > 0) {
    return {
      phase: "workerReservationTargets",
      deleted: workerReservationTargets.length,
      done: false,
    };
  }
  const workerDiscoveryWork = await ctx.db
    .query("workerDiscoveryWork")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(MAX_STAGE_ROWS);
  for (const work of workerDiscoveryWork) {
    if (
      work.spaceId !== item.spaceId ||
      work.sourceAccountId !== item.sourceAccountId
    ) {
      throw new Error("Worker discovery parent chain is invalid");
    }
    await ctx.db.delete(work._id);
  }
  if (workerDiscoveryWork.length > 0) {
    return {
      phase: "workerDiscoveryWork",
      deleted: workerDiscoveryWork.length,
      done: false,
    };
  }
  const workerScanEntries = await ctx.db
    .query("workerScanEntries")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(MAX_STAGE_ROWS);
  for (const entry of workerScanEntries)
    await eraseWorkerScanEntry(ctx, item, entry);
  if (workerScanEntries.length > 0) {
    return {
      phase: "workerScanEntries",
      deleted: workerScanEntries.length,
      done: false,
    };
  }
  const aliases = await ctx.db
    .query("sourceAliasDigests")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(9);
  if (aliases.length > 8) {
    throw new Error("Source item URI alias state is invalid");
  }
  const unresolvedEntries: Array<Doc<"workerScanEntries">> = [];
  for (const alias of aliases) {
    const matches = await ctx.db
      .query("workerScanEntries")
      .withIndex("by_sourceAccountId_and_uriDigest_and_sourceItemId", (q) =>
        q
          .eq("sourceAccountId", item.sourceAccountId)
          .eq("uriDigest", alias.digest)
          .eq("sourceItemId", undefined),
      )
      .take(MAX_STAGE_ROWS - unresolvedEntries.length);
    unresolvedEntries.push(...matches);
    if (unresolvedEntries.length >= MAX_STAGE_ROWS) break;
  }
  for (const entry of unresolvedEntries)
    await eraseWorkerScanEntry(ctx, item, entry);
  if (unresolvedEntries.length > 0) {
    return {
      phase: "workerUnresolvedAliases",
      deleted: unresolvedEntries.length,
      done: false,
    };
  }
  const ambiguousAliases: Array<Doc<"workerScanEntries">> = [];
  for (const alias of aliases) {
    const matches = await ctx.db
      .query("workerScanEntries")
      .withIndex("by_sourceAccountId_and_uriDigest_and_state", (q) =>
        q
          .eq("sourceAccountId", item.sourceAccountId)
          .eq("uriDigest", alias.digest)
          .eq("state", "needs_review"),
      )
      .take(MAX_STAGE_ROWS - ambiguousAliases.length);
    ambiguousAliases.push(...matches);
    if (ambiguousAliases.length >= MAX_STAGE_ROWS) break;
  }
  for (const entry of ambiguousAliases)
    await eraseWorkerScanEntry(ctx, item, entry);
  if (ambiguousAliases.length > 0) {
    return {
      phase: "workerAmbiguousAliases",
      deleted: ambiguousAliases.length,
      done: false,
    };
  }
  const unresolvedIdentities = await ctx.db
    .query("workerScanEntries")
    .withIndex("by_sourceAccountId_and_externalIdHash_and_sourceItemId", (q) =>
      q
        .eq("sourceAccountId", item.sourceAccountId)
        .eq("externalIdHash", item.externalIdHash)
        .eq("sourceItemId", undefined),
    )
    .take(MAX_STAGE_ROWS);
  for (const entry of unresolvedIdentities)
    await eraseWorkerScanEntry(ctx, item, entry);
  if (unresolvedIdentities.length > 0) {
    return {
      phase: "workerUnresolvedIdentities",
      deleted: unresolvedIdentities.length,
      done: false,
    };
  }
  const fetchRequests = await ctx.db
    .query("sourceFetchRequests")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(MAX_STAGE_ROWS);
  for (const request of fetchRequests) await ctx.db.delete(request._id);
  if (fetchRequests.length > 0) {
    return {
      phase: "sourceFetchRequests",
      deleted: fetchRequests.length,
      done: false,
    };
  }
  const receipts = await ctx.db
    .query("ingestRequests")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(MAX_STAGE_ROWS);
  for (const receipt of receipts) await ctx.db.delete(receipt._id);
  if (receipts.length > 0) {
    return { phase: "ingestRequests", deleted: receipts.length, done: false };
  }
  const jobs = await ctx.db
    .query("ingestJobs")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(MAX_STAGE_ROWS);
  for (const job of jobs) await ctx.db.delete(job._id);
  if (jobs.length > 0) {
    return { phase: "ingestJobs", deleted: jobs.length, done: false };
  }
  const records = await deleteSourceItemRecordsBatch(ctx, {
    spaceId: item.spaceId,
    sourceItemId: item._id,
    limit: MAX_STAGE_ROWS,
  });
  if (records.deleted > 0 || !records.done) {
    return { phase: "records", ...records, done: false };
  }
  const provenance = await deleteSourceItemProvenanceBatch(ctx, {
    spaceId: item.spaceId,
    sourceItemId: item._id,
    limit: MAX_STAGE_ROWS,
  });
  if (!provenance.done) return provenance;

  const generations = await ctx.db
    .query("processingGenerations")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(MAX_STAGE_ROWS);
  for (const generation of generations) await ctx.db.delete(generation._id);
  if (generations.length > 0) {
    return {
      phase: "processingGenerations",
      deleted: generations.length,
      done: false,
    };
  }
  if (
    item.archiveDeletionForgetEpoch !== item.desiredProcessingEpoch ||
    !Number.isSafeInteger(item.archiveDeletionReceiptCount) ||
    (item.archiveDeletionReceiptCount ?? -1) < 0 ||
    !Number.isSafeInteger(item.archiveDeletionCompletedAt) ||
    (item.archiveDeletionCompletedAt ?? -1) < 0
  ) {
    throw new Error("Archive deletion summary is incomplete");
  }
  const archiveDeletionAcks = await ctx.db
    .query("sourceArtifactDeletionAcks")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
    .take(MAX_STAGE_ROWS);
  for (const ack of archiveDeletionAcks) {
    if (
      ack.spaceId !== item.spaceId ||
      ack.sourceAccountId !== item.sourceAccountId ||
      ack.forgetEpoch !== item.desiredProcessingEpoch
    )
      throw new Error("Archive deletion acknowledgement parent is invalid");
    await ctx.db.delete(ack._id);
  }
  if (archiveDeletionAcks.length > 0) {
    return {
      phase: "archiveDeletionAcks",
      deleted: archiveDeletionAcks.length,
      done: false,
    };
  }
  await finalizeSourceItemTombstone(ctx, {
    spaceId: item.spaceId,
    sourceItemId: item._id,
  });
  await bumpEmbeddingEligibilityEpoch(ctx, item.spaceId);
  return { phase: "complete", deleted: 0, done: true };
}

export async function advanceCursorAndEnqueue(
  ctx: MutationCtx,
  args: {
    principal: PrincipalRef;
    sourceAccountId: Id<"sourceAccounts">;
    expectedCursorVersion: number;
    nextCursor?: string;
    enumeratedAt: number;
    discoveries: Array<Omit<AdmissionInput, "principal" | "sourceAccountId">>;
  },
) {
  requireIntegerInRange(
    "expectedCursorVersion",
    args.expectedCursorVersion,
    0,
    Number.MAX_SAFE_INTEGER - 1,
  );
  if (args.discoveries.length > MAX_CURSOR_DISCOVERIES) {
    throw new Error("Cursor page exceeds the discovery limit");
  }
  if (args.nextCursor !== undefined) {
    requireBoundedString("nextCursor", args.nextCursor, 8_192, true);
  }
  if (!Number.isFinite(args.enumeratedAt) || args.enumeratedAt < 0) {
    throw new Error("enumeratedAt is invalid");
  }
  const account = await requireSourceAccountAccess(
    ctx,
    args.principal,
    args.sourceAccountId,
    "ingest",
  );
  if (account.cursorVersion !== args.expectedCursorVersion) {
    throw new Error("Source cursor version conflict");
  }
  const results: AdmissionResult[] = [];
  for (const discovery of args.discoveries) {
    results.push(
      await admitSourceRevision(ctx, {
        ...discovery,
        principal: args.principal,
        sourceAccountId: args.sourceAccountId,
      }),
    );
  }
  await ctx.db.patch(account._id, {
    cursor: args.nextCursor,
    cursorVersion: account.cursorVersion + 1,
    lastEnumeratedAt: args.enumeratedAt,
  });
  return { cursorVersion: account.cursorVersion + 1, results };
}
