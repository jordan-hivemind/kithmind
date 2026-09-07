import { v } from "convex/values";

import type { Id } from "../../_generated/dataModel";
import { internalMutation, internalQuery } from "../../_generated/server";
import { inspectPersonalSpace, isPersonalSpaceReady } from "../spaces/model";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 200;
const MAX_DIAGNOSTICS = 25;

const diagnostic = v.object({ id: v.string(), reason: v.string() });
const result = v.object({
  examined: v.number(),
  changed: v.number(),
  wouldChange: v.number(),
  invalidCount: v.number(),
  invalids: v.array(diagnostic),
  blocked: v.boolean(),
  isDone: v.boolean(),
  cursor: v.union(v.string(), v.null()),
});

function boundedBatchSize(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_BATCH_SIZE);
}

export const backfillLegacyScopes = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  returns: result,
  handler: async (ctx, args) => {
    const page = await ctx.db.query("apiKeys").paginate({
      cursor: args.cursor ?? null,
      numItems: boundedBatchSize(args.batchSize),
    });
    let changed = 0;
    let wouldChange = 0;
    let invalidCount = 0;
    const invalids: Array<{ id: string; reason: string }> = [];
    const patches: Array<{
      id: Id<"apiKeys">;
      personalSpaceId: Id<"spaces">;
    }> = [];

    for (const key of page.page) {
      const hasCapabilities = key.capabilities !== undefined;
      const hasSpaces = key.spaceIds !== undefined;
      if (hasCapabilities && hasSpaces) continue;
      if (hasCapabilities !== hasSpaces) {
        invalidCount += 1;
        if (invalids.length < MAX_DIAGNOSTICS) {
          invalids.push({
            id: key._id,
            reason: "API key has only one of capabilities or spaceIds",
          });
        }
        continue;
      }

      const inspection = await inspectPersonalSpace(ctx, key.userId);
      if (!isPersonalSpaceReady(inspection)) {
        invalidCount += 1;
        if (invalids.length < MAX_DIAGNOSTICS) {
          invalids.push({
            id: key._id,
            reason:
              inspection.issues.join("; ") ||
              "personal-space setup is incomplete",
          });
        }
        continue;
      }

      wouldChange += 1;
      patches.push({
        id: key._id,
        personalSpaceId: inspection.personalSpace!._id,
      });
    }

    if (!args.dryRun && invalidCount > 0) {
      return {
        examined: page.page.length,
        changed: 0,
        wouldChange,
        invalidCount,
        invalids,
        blocked: true,
        isDone: false,
        cursor: args.cursor ?? null,
      };
    }

    if (!args.dryRun) {
      for (const patch of patches) {
        await ctx.db.patch(patch.id, {
          capabilities: ["read", "write"],
          spaceIds: [patch.personalSpaceId],
        });
        changed += 1;
      }
    }

    return {
      examined: page.page.length,
      changed,
      wouldChange,
      invalidCount,
      invalids,
      blocked: invalidCount > 0,
      isDone: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

export const auditScopes = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  returns: result,
  handler: async (ctx, args) => {
    const page = await ctx.db.query("apiKeys").paginate({
      cursor: args.cursor ?? null,
      numItems: boundedBatchSize(args.batchSize),
    });
    let invalidCount = 0;
    const invalids: Array<{ id: string; reason: string }> = [];
    for (const key of page.page) {
      const reasons: string[] = [];
      if (key.capabilities === undefined) reasons.push("missing capabilities");
      if (key.spaceIds === undefined) reasons.push("missing spaceIds");
      if (key.capabilities?.length === 0) reasons.push("empty capabilities");
      if (key.spaceIds?.length === 0) reasons.push("empty spaceIds");
      if (
        key.capabilities &&
        new Set(key.capabilities).size !== key.capabilities.length
      ) {
        reasons.push("duplicate capabilities");
      }
      if (key.spaceIds && new Set(key.spaceIds).size !== key.spaceIds.length) {
        reasons.push("duplicate spaceIds");
      }
      const sourceIds = key.sourceAccountIds ?? [];
      if (
        Boolean(key.capabilities?.includes("ingest")) !==
        sourceIds.length > 0
      )
        reasons.push("invalid ingest source grants");
      if (
        sourceIds.length > 100 ||
        new Set(sourceIds).size !== sourceIds.length
      )
        reasons.push("invalid source-account bounds or duplicates");
      for (const id of sourceIds.slice(0, 100)) {
        const account = await ctx.db.get(id);
        if (!account || !key.spaceIds?.includes(account.spaceId))
          reasons.push("source account outside key spaces or missing");
      }
      if (reasons.length > 0) {
        invalidCount += 1;
        if (invalids.length < MAX_DIAGNOSTICS) {
          invalids.push({ id: key._id, reason: reasons.join("; ") });
        }
      }
    }
    return {
      examined: page.page.length,
      changed: 0,
      wouldChange: 0,
      invalidCount,
      invalids,
      blocked: invalidCount > 0,
      isDone: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});
