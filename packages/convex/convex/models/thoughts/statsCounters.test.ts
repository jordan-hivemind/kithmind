import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { _computeSpaceStats } from "./model";

/**
 * P2-6f. Stats read the space counters, not the thought rows. The counters are
 * seeded here to values the rows cannot produce, so a reported number that
 * matches the counters is proof the query never counted a row.
 */
const mcpIssuer = "https://brain.example.test";
const embedding = Array.from({ length: 1536 }, () => 0);
const fingerprint = "fingerprint-under-test";

const metadata = (summary: string) => ({
  type: "reference" as const,
  topics: ["target"],
  people: ["Synthetic Person"],
  actionItems: [],
  summary,
});

async function seed(options: { counted: boolean; thoughts?: number }) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Synthetic owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Synthetic personal",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    await ctx.db.insert("userSpaceSettings", {
      userId,
      personalSpaceId: spaceId,
    });
    const thoughtIds: Id<"thoughts">[] = [];
    for (let index = 0; index < (options.thoughts ?? 3); index += 1) {
      thoughtIds.push(
        await ctx.db.insert("thoughts", {
          userId,
          spaceId,
          content: `synthetic memory ${index}`,
          embedding,
          metadata: metadata(`synthetic memory ${index}`),
          memoryStatus: "current" as const,
        }),
      );
    }
    await ctx.db.insert("spaceEmbeddingStates", {
      spaceId,
      eligibilityEpoch: 0,
      ...(options.counted
        ? {
            activeFingerprint: fingerprint,
            // Deliberately unequal to the rows above and to each other.
            eligibleCounts: { thought: 4_000, chunk: 900, card: 0 },
            coveredCounts: [
              {
                fingerprint,
                counts: { thought: 4_000, chunk: 850, card: 0 },
              },
            ],
            historicalThoughtCounts: { superseded: 700, retracted: 25 },
            counterDrift: false,
            lastAuditAt: 1_700_000_000_000,
          }
        : {}),
    });
    const keyId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "k".repeat(64),
      keyPrefix: "ob_stats",
      name: "stats",
      capabilities: ["read"],
      spaceIds: [spaceId],
    });
    return { userId, spaceId, keyId, thoughtIds };
  });
  return { t, ...ids };
}

describe("stats read counters, not thought rows", () => {
  const originalIssuer = process.env.MCP_JWT_ISSUER;

  beforeEach(() => {
    process.env.MCP_JWT_ISSUER = mcpIssuer;
  });

  afterEach(() => {
    if (originalIssuer === undefined) delete process.env.MCP_JWT_ISSUER;
    else process.env.MCP_JWT_ISSUER = originalIssuer;
  });

  test("a counted space reports counts and coverage from its counters", async () => {
    const seeded = await seed({ counted: true });
    const caller = seeded.t.withIdentity({
      issuer: mcpIssuer,
      subject: seeded.userId,
      apiKeyId: seeded.keyId,
    });

    const stats = await caller.query(
      api.models.thoughts.mcpQueries.getStats,
      {},
    );
    expect(stats.totalThoughts).toBe(4_000);
    expect(stats.historicalThoughts).toBe(700);
    expect(stats.retractedThoughts).toBe(25);
    expect(stats.coverage).toEqual([
      {
        spaceId: seeded.spaceId,
        status: "incomplete",
        fingerprint,
        eligible: { thought: 4_000, chunk: 900, card: 0 },
        covered: { thought: 4_000, chunk: 850, card: 0 },
        drift: false,
        lastAuditAt: 1_700_000_000_000,
      },
    ]);
    // The digest still scans, so it sees the three rows the space really holds.
    expect(stats.byType).toEqual([{ type: "reference", count: 3 }]);
    expect(stats.partial).toBe(false);
  });

  test("an unseeded space reports coverage unknown and counts from its rows", async () => {
    const seeded = await seed({ counted: false });
    const caller = seeded.t.withIdentity({
      issuer: mcpIssuer,
      subject: seeded.userId,
      apiKeyId: seeded.keyId,
    });

    const stats = await caller.query(
      api.models.thoughts.mcpQueries.getStats,
      {},
    );
    expect(stats.coverage).toEqual([
      { spaceId: seeded.spaceId, status: "unknown", drift: false },
    ]);
    expect(stats.totalThoughts).toBe(3);
    expect(stats.partial).toBe(false);
  });

  test("a counted space keeps its counts when the digest bound binds", async () => {
    const seeded = await seed({ counted: true });
    const bounded = await seeded.t.run((ctx) =>
      _computeSpaceStats(ctx, [seeded.spaceId], { maxDigestRows: 2 }),
    );
    expect(bounded.partial).toBe(true);
    expect(bounded.byType).toEqual([{ type: "reference", count: 2 }]);
    expect(bounded.totalThoughts).toBe(4_000);
    expect(bounded.historicalThoughts).toBe(700);
  });

  test("list_spaces reports coverage from one state row per space", async () => {
    const counted = await seed({ counted: true });
    const countedSpaces = await counted.t
      .withIdentity({
        issuer: mcpIssuer,
        subject: counted.userId,
        apiKeyId: counted.keyId,
      })
      .query(api.models.spaces.mcpQueries.list, {});
    expect(countedSpaces).toHaveLength(1);
    expect(countedSpaces[0]!.coverage).toMatchObject({
      status: "incomplete",
      fingerprint,
      eligible: { thought: 4_000, chunk: 900, card: 0 },
      covered: { thought: 4_000, chunk: 850, card: 0 },
      drift: false,
    });

    const unseeded = await seed({ counted: false });
    const unseededSpaces = await unseeded.t
      .withIdentity({
        issuer: mcpIssuer,
        subject: unseeded.userId,
        apiKeyId: unseeded.keyId,
      })
      .query(api.models.spaces.mcpQueries.list, {});
    expect(unseededSpaces[0]!.coverage).toEqual({
      spaceId: unseeded.spaceId,
      status: "unknown",
      drift: false,
    });
  });

  test("drift and equal counters decide the reported coverage status", async () => {
    const seeded = await seed({ counted: true });
    await seeded.t.run(async (ctx) => {
      const state = await ctx.db
        .query("spaceEmbeddingStates")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .unique();
      await ctx.db.patch(state!._id, {
        coveredCounts: [
          { fingerprint, counts: { thought: 4_000, chunk: 900, card: 0 } },
        ],
      });
    });
    const complete = await seeded.t.run((ctx) =>
      _computeSpaceStats(ctx, [seeded.spaceId]),
    );
    expect(complete.coverage[0]!.status).toBe("complete");

    await seeded.t.run(async (ctx) => {
      const state = await ctx.db
        .query("spaceEmbeddingStates")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .unique();
      await ctx.db.patch(state!._id, { counterDrift: true });
    });
    const drifted = await seeded.t.run((ctx) =>
      _computeSpaceStats(ctx, [seeded.spaceId]),
    );
    expect(drifted.coverage[0]).toMatchObject({
      status: "incomplete",
      drift: true,
    });
  });
});
