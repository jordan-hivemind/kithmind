import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

const mcpIssuer = "https://brain.example.test";
const sessionIssuer = "https://brain.example.test/convex";

describe("web session boundary", () => {
  const originalIssuer = process.env.MCP_JWT_ISSUER;

  beforeEach(() => {
    process.env.MCP_JWT_ISSUER = mcpIssuer;
  });

  afterEach(() => {
    if (originalIssuer === undefined) {
      delete process.env.MCP_JWT_ISSUER;
    } else {
      process.env.MCP_JWT_ISSUER = originalIssuer;
    }
  });

  test("rejects unauthenticated callers", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.query(api.models.thoughts.public.getStats, {}),
    ).rejects.toThrow("Not authenticated");
  });

  test("accepts a dashboard session identity", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const session = t.withIdentity({ issuer: sessionIssuer, subject: userId });

    const stats = await session.query(api.models.thoughts.public.getStats, {});
    expect(stats.totalThoughts).toBe(0);
  });

  test("refuses MCP-issued identities on the dashboard surface", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    // A token minted by the MCP gateway from an API key. getAuthUserId would
    // accept it because it only reads `subject`; requireWebUserId must not.
    const mcp = t.withIdentity({ issuer: mcpIssuer, subject: userId });

    await expect(
      mcp.query(api.models.thoughts.public.getStats, {}),
    ).rejects.toThrow("Not authenticated");

    await expect(
      mcp.mutation(api.models.apiKeys.public.create, {
        name: "escalated",
        capabilities: ["read", "write"],
        spaceIds: [],
      }),
    ).rejects.toThrow("Not authenticated");
  });

  test("rejects dashboard sessions after the user is deleted", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const session = t.withIdentity({ issuer: sessionIssuer, subject: userId });

    await t.run((ctx) => ctx.db.delete(userId));

    await expect(
      session.query(api.models.lists.public.getLists, {}),
    ).rejects.toThrow("Not authenticated");
    await expect(
      session.query(api.models.reports.public.listReports, {}),
    ).rejects.toThrow("Not authenticated");
  });

  test("rejects cross-owner list children", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { name: "Owner" });
      const otherId = await ctx.db.insert("users", { name: "Other" });
      const ownerListId = await ctx.db.insert("lists", {
        userId: ownerId,
        name: "Owner list",
        pinned: false,
      });
      const otherListId = await ctx.db.insert("lists", {
        userId: otherId,
        name: "Other list",
        pinned: false,
      });
      const ownerItemId = await ctx.db.insert("listItems", {
        userId: ownerId,
        listId: ownerListId,
        title: "Owned item",
        status: "open",
        position: 1,
      });
      await ctx.db.insert("listItems", {
        userId: otherId,
        listId: ownerListId,
        title: "Cross-owner child",
        status: "done",
        position: 2,
      });
      const crossLinkedOwnerItemId = await ctx.db.insert("listItems", {
        userId: ownerId,
        listId: otherListId,
        title: "Wrong parent",
        status: "open",
        position: 1,
      });
      return {
        ownerId,
        ownerListId,
        ownerItemId,
        crossLinkedOwnerItemId,
      };
    });
    const owner = t.withIdentity({
      issuer: sessionIssuer,
      subject: seeded.ownerId,
    });

    const lists = await owner.query(api.models.lists.public.getLists, {});
    expect(lists).toHaveLength(1);
    expect(lists[0]?.counts).toEqual({ total: 1, open: 1, done: 0 });
    const list = await owner.query(api.models.lists.public.getList, {
      listId: seeded.ownerListId,
      includeCompleted: true,
    });
    expect(list.items.map((item) => item._id)).toEqual([seeded.ownerItemId]);

    await expect(
      owner.mutation(api.models.lists.public.updateListItem, {
        itemId: seeded.crossLinkedOwnerItemId,
        title: "Denied update",
      }),
    ).rejects.toThrow("Item not found");
    await expect(
      owner.mutation(api.models.lists.public.deleteListItem, {
        itemId: seeded.crossLinkedOwnerItemId,
      }),
    ).rejects.toThrow("Item not found");
    expect(
      await t.run((ctx) => ctx.db.get(seeded.crossLinkedOwnerItemId)),
    ).toMatchObject({ title: "Wrong parent" });
  });

  test("rejects cross-owner report children", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { name: "Owner" });
      const otherId = await ctx.db.insert("users", { name: "Other" });
      const insertReport = (userId: typeof ownerId) =>
        ctx.db.insert("reports", {
          userId,
          startDate: "2026-09-01",
          endDate: "2026-09-02",
          sessionsAnalyzed: 1,
          totalPrompts: 2,
          totalToolCalls: 3,
          projectsActive: [],
          modelUsage: {},
        });
      const ownerReportId = await insertReport(ownerId);
      const otherReportId = await insertReport(otherId);
      const insertInsight = (
        reportId: typeof ownerReportId,
        userId: typeof ownerId,
        observation: string,
      ) =>
        ctx.db.insert("insights", {
          reportId,
          userId,
          category: "productivity",
          observation,
          recommendation: "Recommendation",
          evidence: "Evidence",
          status: "new",
        });
      const ownerInsightId = await insertInsight(
        ownerReportId,
        ownerId,
        "Owned insight",
      );
      await insertInsight(ownerReportId, otherId, "Cross-owner child");
      const crossLinkedOwnerInsightId = await insertInsight(
        otherReportId,
        ownerId,
        "Wrong parent",
      );
      return {
        ownerId,
        ownerReportId,
        otherReportId,
        ownerInsightId,
        crossLinkedOwnerInsightId,
      };
    });
    const owner = t.withIdentity({
      issuer: sessionIssuer,
      subject: seeded.ownerId,
    });

    const insights = await owner.query(
      api.models.reports.public.listInsightsByReport,
      { reportId: seeded.ownerReportId },
    );
    expect(insights.map((insight) => insight._id)).toEqual([
      seeded.ownerInsightId,
    ]);
    const unresolved = await owner.query(
      api.models.reports.public.listUnresolvedInsights,
      {},
    );
    expect(unresolved.map((insight) => insight._id)).toEqual([
      seeded.ownerInsightId,
    ]);
    const allInsights = await owner.query(
      api.models.reports.public.listAllInsights,
      {},
    );
    expect(allInsights.map((insight) => insight._id)).toEqual([
      seeded.ownerInsightId,
    ]);

    await expect(
      owner.mutation(api.models.reports.public.updateInsightStatus, {
        insightId: seeded.crossLinkedOwnerInsightId,
        status: "done",
      }),
    ).rejects.toThrow("Insight not found");
    await expect(
      owner.mutation(api.models.reports.public.deleteInsight, {
        insightId: seeded.crossLinkedOwnerInsightId,
      }),
    ).rejects.toThrow("Insight not found");
    expect(
      await t.run((ctx) => ctx.db.get(seeded.crossLinkedOwnerInsightId)),
    ).toMatchObject({ status: "new" });
    await owner.mutation(
      api.models.reports.public.clearAllInsightsAndReports,
      {},
    );
    expect(
      await t.run((ctx) => ctx.db.get(seeded.crossLinkedOwnerInsightId)),
    ).toMatchObject({ status: "new" });
    expect(
      await t.run((ctx) => ctx.db.get(seeded.otherReportId)),
    ).not.toBeNull();
  });
});
