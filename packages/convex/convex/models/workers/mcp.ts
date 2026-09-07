import { internal } from "../../_generated/api";
import { action } from "../../_generated/server";
import { requireMcpPrincipal } from "../../lib/mcpAuth";
import { principalRef } from "../../lib/spaces";
import { v } from "convex/values";

import { rethrowWorkerProtocolError } from "./errors";
import { parseWorkerRequest, type WorkerResult } from "./protocol";

const scanState = v.union(
  v.literal("open"),
  v.literal("sealed"),
  v.literal("reconciling"),
  v.literal("enumerated"),
  v.literal("needs_review"),
  v.literal("failed"),
);

const workerResultValidator = v.union(
  v.object({
    operation: v.literal("source.status"),
    sourceAccountId: v.string(),
    inventoryEpoch: v.number(),
    completedInventoryEpoch: v.number(),
    manifestVersion: v.number(),
    enumeration: v.union(
      v.object({ state: v.literal("never") }),
      v.object({ state: v.literal("in_progress"), scanId: v.string() }),
      v.object({
        state: v.literal("complete"),
        scanId: v.optional(v.string()),
        completedAt: v.number(),
      }),
      v.object({
        state: v.literal("needs_review"),
        scanId: v.string(),
        completedAt: v.optional(v.number()),
      }),
      v.object({
        state: v.literal("failed"),
        scanId: v.optional(v.string()),
        completedAt: v.optional(v.number()),
        failureCode: v.optional(
          v.union(
            v.literal("empty"),
            v.literal("enumeration_interrupted"),
            v.literal("oversized"),
            v.literal("permission_denied"),
            v.literal("unreadable"),
            v.literal("unstable"),
            v.literal("unsupported"),
          ),
        ),
      }),
    ),
    processing: v.object({ state: v.literal("not_assessed") }),
    recordCoverage: v.literal("not_established"),
  }),
  v.object({
    operation: v.literal("source.inventoryPage"),
    page: v.array(
      v.union(
        v.object({
          lifecycle: v.union(v.literal("available"), v.literal("unavailable")),
          sourceItemId: v.string(),
          externalId: v.string(),
          uri: v.optional(v.string()),
          observationEpoch: v.number(),
          processingEpoch: v.number(),
          inventoryMetadataDigest: v.optional(v.string()),
        }),
        v.object({
          lifecycle: v.literal("tombstone"),
          externalIdHash: v.string(),
          uriAliasDigests: v.array(v.string()),
        }),
      ),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  v.object({
    operation: v.literal("scan.begin"),
    scanId: v.string(),
    inventoryEpoch: v.number(),
    manifestVersion: v.number(),
    state: scanState,
    reused: v.boolean(),
  }),
  v.object({
    operation: v.literal("scan.appendPage"),
    scanId: v.string(),
    ordinal: v.number(),
    reused: v.boolean(),
    entries: v.array(
      v.object({
        state: v.union(
          v.literal("unchanged"),
          v.literal("queued"),
          v.literal("gap"),
          v.literal("ignored_forgotten"),
          v.literal("needs_review"),
        ),
        sourceItemId: v.optional(v.string()),
        observationEpoch: v.optional(v.number()),
        processingEpoch: v.optional(v.number()),
      }),
    ),
  }),
  v.object({
    operation: v.literal("scan.seal"),
    scanId: v.string(),
    state: v.union(
      v.literal("sealed"),
      v.literal("needs_review"),
      v.literal("failed"),
    ),
    reused: v.boolean(),
  }),
  v.object({
    operation: v.literal("scan.reconcile"),
    scanId: v.string(),
    state: v.union(
      v.literal("reconciling"),
      v.literal("enumerated"),
      v.literal("needs_review"),
    ),
    inspected: v.number(),
    unavailable: v.number(),
    done: v.boolean(),
    reused: v.boolean(),
  }),
  v.object({
    operation: v.literal("discovery.reserve"),
    receiptId: v.string(),
    expiresAt: v.number(),
    reused: v.boolean(),
    targets: v.array(
      v.object({
        workId: v.string(),
        sourceItemId: v.string(),
        observationEpoch: v.number(),
        processingEpoch: v.number(),
        leaseEpoch: v.number(),
        leaseToken: v.string(),
        leaseExpiresAt: v.number(),
        uri: v.string(),
        contentHash: v.string(),
        byteLength: v.number(),
      }),
    ),
  }),
  v.object({
    operation: v.literal("discovery.admitUtf8"),
    workId: v.string(),
    sourceItemId: v.string(),
    sourceRevisionId: v.string(),
    processingGenerationId: v.string(),
    ingestJobId: v.string(),
    desiredProcessingEpoch: v.number(),
    state: v.literal("admitted"),
    reused: v.boolean(),
  }),
  v.object({
    operation: v.literal("jobs.reserve"),
    receiptId: v.string(),
    expiresAt: v.number(),
    reused: v.boolean(),
    targets: v.array(
      v.object({
        jobId: v.string(),
        workId: v.string(),
        sourceItemId: v.string(),
        observationEpoch: v.number(),
        processingEpoch: v.number(),
        state: v.union(v.literal("processing"), v.literal("staged")),
        leaseEpoch: v.number(),
        leaseToken: v.string(),
        leaseExpiresAt: v.number(),
      }),
    ),
  }),
  v.object({
    operation: v.literal("jobs.renew"),
    jobId: v.string(),
    state: v.union(v.literal("processing"), v.literal("staged")),
    leaseExpiresAt: v.number(),
    reused: v.boolean(),
  }),
  v.object({
    operation: v.literal("jobs.stageUtf8"),
    jobId: v.string(),
    state: v.literal("staged"),
    actualPageCount: v.number(),
    actualEvidenceSpanCount: v.number(),
    actualDocumentCount: v.number(),
    actualChunkCount: v.number(),
    reused: v.boolean(),
  }),
  v.object({
    operation: v.literal("jobs.activate"),
    jobId: v.string(),
    state: v.literal("ready"),
    activatedAt: v.number(),
    previousGenerationId: v.optional(v.string()),
    reused: v.boolean(),
  }),
  v.object({
    operation: v.literal("jobs.fail"),
    jobId: v.string(),
    state: v.union(
      v.literal("failed"),
      v.literal("needs_review"),
      v.literal("obsolete_generation"),
    ),
    retryable: v.boolean(),
    nextAttemptAt: v.optional(v.number()),
    failureCode: v.union(
      v.literal("worker_interrupted"),
      v.literal("worker_resource_exhausted"),
      v.literal("source_bytes_invalid"),
      v.literal("staging_invalid"),
    ),
    reused: v.boolean(),
  }),
);

function randomLeaseTokens(count: number): string[] {
  return Array.from({ length: count }, () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });
}

export const dispatch = action({
  args: { request: v.any() },
  returns: workerResultValidator,
  handler: async (ctx, args): Promise<WorkerResult> => {
    try {
      const request = parseWorkerRequest(args.request);
      const principal = principalRef(await requireMcpPrincipal(ctx));
      switch (request.operation) {
        case "source.status":
          return await ctx.runQuery(
            internal.models.workers.private.sourceStatus,
            {
              principal,
              request,
              now: Date.now(),
            },
          );
        case "source.inventoryPage":
          return await ctx.runMutation(
            internal.models.workers.private.sourceInventoryPage,
            { principal, request },
          );
        case "scan.begin":
          return await ctx.runMutation(
            internal.models.workers.private.scanBegin,
            {
              principal,
              request,
            },
          );
        case "scan.appendPage":
          return await ctx.runMutation(
            internal.models.workers.private.scanAppendPage,
            { principal, request },
          );
        case "scan.seal":
          return await ctx.runMutation(
            internal.models.workers.private.scanSeal,
            {
              principal,
              request,
            },
          );
        case "scan.reconcile":
          return await ctx.runMutation(
            internal.models.workers.private.scanReconcile,
            { principal, request },
          );
        case "discovery.reserve":
          return await ctx.runMutation(
            internal.models.workers.private.discoveryReserve,
            {
              principal,
              request,
              tokens: randomLeaseTokens(request.maxItems),
            },
          );
        case "discovery.admitUtf8":
          return await ctx.runMutation(
            internal.models.workers.private.discoveryAdmitUtf8,
            { principal, request },
          );
        case "jobs.reserve":
          return await ctx.runMutation(
            internal.models.workers.private.jobsReserve,
            {
              principal,
              request,
              tokens: randomLeaseTokens(request.maxItems),
            },
          );
        case "jobs.renew":
          return await ctx.runMutation(
            internal.models.workers.private.jobsRenew,
            { principal, request },
          );
        case "jobs.stageUtf8": {
          const begun = await ctx.runMutation(
            internal.models.workers.private.jobsStageBegin,
            { principal, request },
          );
          if (begun.state === "completed") return begun.result;
          await ctx.runMutation(internal.models.workers.private.jobsStageText, {
            principal,
            request,
          });
          await ctx.runMutation(internal.models.workers.private.jobsStagePage, {
            principal,
            request,
          });
          let spanOffset = 0;
          while (spanOffset < begun.chunkCount) {
            const batch = await ctx.runMutation(
              internal.models.workers.private.jobsStageSpans,
              { principal, request, offset: spanOffset },
            );
            if (batch.nextOffset <= spanOffset) {
              throw new Error("Worker span staging made no progress");
            }
            spanOffset = batch.nextOffset;
          }
          await ctx.runMutation(
            internal.models.workers.private.jobsStageDocument,
            { principal, request },
          );
          let chunkOffset = 0;
          while (chunkOffset < begun.chunkCount) {
            const batch = await ctx.runMutation(
              internal.models.workers.private.jobsStageChunks,
              { principal, request, offset: chunkOffset },
            );
            if (batch.nextOffset <= chunkOffset) {
              throw new Error("Worker chunk staging made no progress");
            }
            chunkOffset = batch.nextOffset;
          }
          return await ctx.runMutation(
            internal.models.workers.private.jobsStageComplete,
            { principal, request },
          );
        }
        case "jobs.activate":
          return await ctx.runMutation(
            internal.models.workers.private.jobsActivate,
            { principal, request },
          );
        case "jobs.fail":
          return await ctx.runMutation(
            internal.models.workers.private.jobsFail,
            { principal, request },
          );
      }
    } catch (error) {
      rethrowWorkerProtocolError(error);
    }
  },
});
