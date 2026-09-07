import { v } from "convex/values";

import { internalMutation } from "../../_generated/server";
import { principalRefValidator } from "../apiKeys/validators";
import { evidenceLocatorValidator } from "../provenance/validators";
import {
  activateGeneration,
  admitSourceRevision,
  advanceCursorAndEnqueue,
  beginForgetFromWeb,
  claimJob,
  continueForgetFromWeb,
  createGenerationTextVersion,
  failJob,
  markSourceUnavailable,
  renewJobLease,
  replaceRevokedActorAndRequeueFromWeb,
  requeueJob,
  stageGeneration,
  stageGenerationChunks,
  stageGenerationDocuments,
  stageGenerationEvidenceSpans,
  stageGenerationPages,
} from "./model";

const processingConfiguration = {
  extractionFingerprint: v.string(),
  extractorFingerprint: v.string(),
  recordSchemaFingerprint: v.string(),
  normalizationFingerprint: v.string(),
  chunkerFingerprint: v.string(),
  correctionRevision: v.string(),
};

const admissionFields = {
  requestId: v.string(),
  expectedDesiredProcessingEpoch: v.number(),
  source: v.object({
    externalId: v.string(),
    title: v.optional(v.string()),
    docType: v.optional(v.string()),
    uri: v.optional(v.string()),
    capturedAt: v.number(),
    mediaType: v.string(),
    inlineText: v.string(),
  }),
  processing: v.object({
    ...processingConfiguration,
    expectedPageCount: v.number(),
    expectedEvidenceSpanCount: v.number(),
    expectedDocumentCount: v.number(),
    expectedChunkCount: v.number(),
  }),
};

const leasedJobFields = {
  principal: principalRefValidator,
  jobId: v.id("ingestJobs"),
  leaseEpoch: v.number(),
  leaseToken: v.string(),
};

export const admit = internalMutation({
  args: {
    principal: principalRefValidator,
    sourceAccountId: v.id("sourceAccounts"),
    ...admissionFields,
  },
  handler: admitSourceRevision,
});

export const claim = internalMutation({
  args: {
    principal: principalRefValidator,
    jobId: v.id("ingestJobs"),
    leaseToken: v.string(),
    leaseDurationMs: v.number(),
  },
  handler: async (ctx, args) =>
    await claimJob(ctx, { ...args, now: Date.now() }),
});

export const renew = internalMutation({
  args: { ...leasedJobFields, leaseDurationMs: v.number() },
  handler: async (ctx, args) =>
    await renewJobLease(ctx, { ...args, now: Date.now() }),
});

export const createTextVersion = internalMutation({
  args: { ...leasedJobFields, text: v.string() },
  handler: async (ctx, args) =>
    await createGenerationTextVersion(ctx, { ...args, now: Date.now() }),
});

export const stagePages = internalMutation({
  args: {
    ...leasedJobFields,
    pages: v.array(
      v.object({
        ordinal: v.number(),
        start: v.number(),
        end: v.number(),
        text: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) =>
    await stageGenerationPages(ctx, { ...args, now: Date.now() }),
});

export const stageEvidenceSpans = internalMutation({
  args: {
    ...leasedJobFields,
    spans: v.array(
      v.object({
        sourcePageId: v.id("sourcePages"),
        ordinal: v.number(),
        start: v.number(),
        end: v.number(),
        locator: v.optional(evidenceLocatorValidator),
      }),
    ),
  },
  handler: async (ctx, args) =>
    await stageGenerationEvidenceSpans(ctx, { ...args, now: Date.now() }),
});

export const stageDocuments = internalMutation({
  args: {
    ...leasedJobFields,
    documents: v.array(
      v.object({
        documentKey: v.string(),
        title: v.string(),
        docType: v.string(),
        capturedAt: v.number(),
        evidenceSpanIds: v.array(v.id("evidenceSpans")),
      }),
    ),
  },
  handler: async (ctx, args) =>
    await stageGenerationDocuments(ctx, { ...args, now: Date.now() }),
});

export const stageChunks = internalMutation({
  args: {
    ...leasedJobFields,
    chunks: v.array(
      v.object({
        documentId: v.id("documents"),
        ordinal: v.number(),
        text: v.string(),
        evidenceSpanIds: v.array(v.id("evidenceSpans")),
      }),
    ),
  },
  handler: async (ctx, args) =>
    await stageGenerationChunks(ctx, { ...args, now: Date.now() }),
});

export const stage = internalMutation({
  args: leasedJobFields,
  handler: async (ctx, args) =>
    await stageGeneration(ctx, { ...args, now: Date.now() }),
});

export const activate = internalMutation({
  args: leasedJobFields,
  handler: async (ctx, args) =>
    await activateGeneration(ctx, { ...args, now: Date.now() }),
});

export const fail = internalMutation({
  args: {
    ...leasedJobFields,
    code: v.string(),
    message: v.string(),
    retryable: v.boolean(),
    nextAttemptAt: v.optional(v.number()),
    needsReview: v.optional(v.boolean()),
  },
  handler: async (ctx, args) =>
    await failJob(ctx, { ...args, now: Date.now() }),
});

export const requeue = internalMutation({
  args: {
    principal: principalRefValidator,
    jobId: v.id("ingestJobs"),
  },
  handler: async (ctx, args) =>
    await requeueJob(ctx, { ...args, now: Date.now() }),
});

export const replaceRevokedActorAndRequeue = internalMutation({
  args: {
    principal: principalRefValidator,
    jobId: v.id("ingestJobs"),
  },
  handler: async (ctx, args) =>
    await replaceRevokedActorAndRequeueFromWeb(ctx, {
      ...args,
      now: Date.now(),
    }),
});

export const markUnavailable = internalMutation({
  args: {
    principal: principalRefValidator,
    sourceItemId: v.id("sourceItems"),
  },
  handler: markSourceUnavailable,
});

export const beginForget = internalMutation({
  args: {
    principal: principalRefValidator,
    sourceItemId: v.id("sourceItems"),
  },
  handler: async (ctx, args) =>
    await beginForgetFromWeb(ctx, { ...args, now: Date.now() }),
});

export const continueForget = internalMutation({
  args: {
    principal: principalRefValidator,
    sourceItemId: v.id("sourceItems"),
  },
  handler: continueForgetFromWeb,
});

export const advanceCursor = internalMutation({
  args: {
    principal: principalRefValidator,
    sourceAccountId: v.id("sourceAccounts"),
    expectedCursorVersion: v.number(),
    nextCursor: v.optional(v.string()),
    enumeratedAt: v.number(),
    discoveries: v.array(v.object(admissionFields)),
  },
  handler: advanceCursorAndEnqueue,
});
