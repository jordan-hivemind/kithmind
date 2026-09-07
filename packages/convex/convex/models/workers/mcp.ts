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
);

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
      }
    } catch (error) {
      rethrowWorkerProtocolError(error);
    }
  },
});
