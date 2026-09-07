import { query } from "../../_generated/server";
import { v } from "convex/values";

import { requireMcpPrincipal } from "../../lib/mcpAuth";
import { getAuthorizedReadSpaceIds } from "../../lib/spaces";
import { isFactActive } from "../facts/model";
import { isMemoryActive } from "./memoryLifecycle";
import {
  _listBySpaces,
  _listCoreBySpaces,
  _loadBoundedThoughtStatsRows,
} from "./model";
import {
  thoughtLifecycleFields,
  thoughtMetadata,
  thoughtType,
} from "./validators";

const result = v.object({
  _id: v.id("thoughts"),
  _creationTime: v.number(),
  content: v.string(),
  metadata: thoughtMetadata,
  userId: v.id("users"),
  spaceId: v.id("spaces"),
  updatedAt: v.optional(v.number()),
  ...thoughtLifecycleFields,
});

export const listByUser = query({
  args: {
    limit: v.optional(v.number()),
    includeHistorical: v.optional(v.boolean()),
    type: v.optional(thoughtType),
    topic: v.optional(v.string()),
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  returns: v.array(result),
  handler: async (ctx, args) => {
    const principal = await requireMcpPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    const rows = await _listBySpaces(
      ctx,
      spaceIds,
      args.limit,
      args.includeHistorical,
      { type: args.type, topic: args.topic },
    );
    return rows
      .filter((row) => row.spaceId !== undefined)
      .map(({ embedding: _embedding, ...row }) => ({
        ...row,
        spaceId: row.spaceId!,
      }));
  },
});

export const listCore = query({
  args: {
    limit: v.optional(v.number()),
    spaceIds: v.optional(v.array(v.id("spaces"))),
  },
  returns: v.array(result),
  handler: async (ctx, args) => {
    const principal = await requireMcpPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    const rows = await _listCoreBySpaces(ctx, spaceIds, args.limit);
    return rows
      .filter((row) => row.spaceId !== undefined)
      .map(({ embedding: _embedding, ...row }) => ({
        ...row,
        spaceId: row.spaceId!,
      }));
  },
});

export const getStats = query({
  args: { spaceIds: v.optional(v.array(v.id("spaces"))) },
  returns: v.object({
    totalThoughts: v.number(),
    totalFacts: v.number(),
    historicalThoughts: v.number(),
    historicalFacts: v.number(),
    retractedThoughts: v.number(),
    retractedFacts: v.number(),
    byType: v.array(v.object({ type: v.string(), count: v.number() })),
    topTopics: v.array(v.object({ topic: v.string(), count: v.number() })),
    topPeople: v.array(v.object({ person: v.string(), count: v.number() })),
  }),
  handler: async (ctx, args) => {
    const principal = await requireMcpPrincipal(ctx);
    const spaceIds = await getAuthorizedReadSpaceIds(
      ctx,
      principal,
      args.spaceIds,
    );
    const { thoughts: allThoughts, facts: allFacts } =
      await _loadBoundedThoughtStatsRows(ctx, spaceIds);
    const activeAt = Date.now();
    const currentThoughts = allThoughts.filter((thought) =>
      isMemoryActive(thought, activeAt),
    );
    const typeCounts = new Map<string, number>();
    const topicCounts = new Map<string, number>();
    const peopleCounts = new Map<string, number>();
    for (const thought of currentThoughts) {
      typeCounts.set(
        thought.metadata.type,
        (typeCounts.get(thought.metadata.type) ?? 0) + 1,
      );
      for (const topic of thought.metadata.topics) {
        topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
      }
      for (const person of thought.metadata.people) {
        peopleCounts.set(person, (peopleCounts.get(person) ?? 0) + 1);
      }
    }
    return {
      totalThoughts: currentThoughts.length,
      totalFacts: allFacts.filter((fact) => isFactActive(fact, activeAt))
        .length,
      historicalThoughts: allThoughts.filter(
        (thought) => thought.memoryStatus === "superseded",
      ).length,
      historicalFacts: allFacts.filter((fact) => fact.status === "superseded")
        .length,
      retractedThoughts: allThoughts.filter(
        (thought) => thought.memoryStatus === "retracted",
      ).length,
      retractedFacts: allFacts.filter((fact) => fact.status === "retracted")
        .length,
      byType: [...typeCounts.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
      topTopics: [...topicCounts.entries()]
        .map(([topic, count]) => ({ topic, count }))
        .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
        .slice(0, 10),
      topPeople: [...peopleCounts.entries()]
        .map(([person, count]) => ({ person, count }))
        .sort((a, b) => b.count - a.count || a.person.localeCompare(b.person))
        .slice(0, 10),
    };
  },
});
