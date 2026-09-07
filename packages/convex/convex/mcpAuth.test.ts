import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";

import { api } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

const issuer = "https://brain.example.test";

describe("MCP account isolation", () => {
  const originalIssuer = process.env.MCP_JWT_ISSUER;

  beforeEach(() => {
    process.env.MCP_JWT_ISSUER = issuer;
  });

  afterEach(() => {
    if (originalIssuer === undefined) {
      delete process.env.MCP_JWT_ISSUER;
    } else {
      process.env.MCP_JWT_ISSUER = originalIssuer;
    }
  });

  test("rejects missing, untrusted, deleted, and subject-mismatched credentials", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.query(api.models.lists.mcpQueries.getLists, {}),
    ).rejects.toThrow("Not authenticated");

    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const personalSpaceId = await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Personal",
        createdBy: userId,
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: personalSpaceId,
        userId,
        role: "owner",
      });
      await ctx.db.insert("userSpaceSettings", { userId, personalSpaceId });
      const keyId = await ctx.db.insert("apiKeys", {
        userId,
        keyHash: "1".repeat(64),
        keyPrefix: "ob_valid",
        name: "valid",
        capabilities: ["read", "write"],
        spaceIds: [personalSpaceId],
      });
      const otherId = await ctx.db.insert("users", {});
      return { userId, keyId, otherId };
    });

    const untrusted = t.withIdentity({
      issuer: "https://attacker.example.test",
      subject: seeded.userId,
      apiKeyId: seeded.keyId,
    });
    await expect(
      untrusted.query(api.models.lists.mcpQueries.getLists, {}),
    ).rejects.toThrow("Not authenticated");

    const mismatched = t.withIdentity({
      issuer,
      subject: seeded.otherId,
      apiKeyId: seeded.keyId,
    });
    await expect(
      mismatched.query(api.models.lists.mcpQueries.getLists, {}),
    ).rejects.toThrow("Not authenticated");

    await t.run((ctx) => ctx.db.delete(seeded.keyId));
    const deleted = t.withIdentity({
      issuer,
      subject: seeded.userId,
      apiKeyId: seeded.keyId,
    });
    await expect(
      deleted.query(api.models.lists.mcpQueries.getLists, {}),
    ).rejects.toThrow("Not authenticated");
  });

  test("uses the signed subject and prevents cross-account reads", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const create = async (name: string) => {
        const userId = await ctx.db.insert("users", { name });
        const personalSpaceId = await ctx.db.insert("spaces", {
          kind: "personal",
          name: "Personal",
          createdBy: userId,
        });
        await ctx.db.insert("spaceMembers", {
          spaceId: personalSpaceId,
          userId,
          role: "owner",
        });
        await ctx.db.insert("userSpaceSettings", { userId, personalSpaceId });
        const keyId = await ctx.db.insert("apiKeys", {
          userId,
          keyHash: name.repeat(64).slice(0, 64),
          keyPrefix: `ob_${name}`,
          name,
          capabilities: ["read", "write"],
          spaceIds: [personalSpaceId],
        });
        return { userId, keyId };
      };
      return { owner: await create("a"), other: await create("b") };
    });
    const owner = t.withIdentity({
      issuer,
      subject: seeded.owner.userId,
      apiKeyId: seeded.owner.keyId,
    });
    const other = t.withIdentity({
      issuer,
      subject: seeded.other.userId,
      apiKeyId: seeded.other.keyId,
    });

    const created = await owner.mutation(
      api.models.lists.mcpActions.createList,
      {
        name: "Private",
        pinned: false,
      },
    );
    await expect(
      other.query(api.models.lists.mcpQueries.getList, {
        listId: created.listId,
      }),
    ).rejects.toThrow("List not found");
    expect(
      await owner.query(api.models.lists.mcpQueries.getList, {
        listId: created.listId,
      }),
    ).toMatchObject({ name: "Private" });
  });

  test("requires personal read/write grants for retained private features", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const personalSpaceId = await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Personal",
        createdBy: userId,
      });
      const sharedSpaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Family",
        createdBy: userId,
      });
      for (const spaceId of [personalSpaceId, sharedSpaceId]) {
        await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
      }
      await ctx.db.insert("userSpaceSettings", { userId, personalSpaceId });
      const createKey = async (
        name: string,
        capabilities: Array<"read" | "write">,
        spaceIds: (typeof personalSpaceId)[],
      ) =>
        await ctx.db.insert("apiKeys", {
          userId,
          keyHash: name.repeat(64).slice(0, 64),
          keyPrefix: `ob_${name}`,
          name,
          capabilities,
          spaceIds,
        });
      return {
        userId,
        readKey: await createKey("r", ["read"], [personalSpaceId]),
        writeKey: await createKey("w", ["write"], [personalSpaceId]),
        sharedKey: await createKey("s", ["read", "write"], [sharedSpaceId]),
      };
    });
    const asKey = (keyId: typeof seeded.readKey) =>
      t.withIdentity({ issuer, subject: seeded.userId, apiKeyId: keyId });
    const readOnly = asKey(seeded.readKey);
    const writeOnly = asKey(seeded.writeKey);
    const sharedOnly = asKey(seeded.sharedKey);

    await expect(
      readOnly.mutation(api.models.lists.mcpActions.createList, {
        name: "Denied",
        pinned: false,
      }),
    ).rejects.toThrow("Not authorized");
    await expect(
      readOnly.action(api.models.reports.mcpActions.createReport, {
        startDate: "2026-09-01",
        endDate: "2026-09-02",
        sessionsAnalyzed: 1,
        totalPrompts: 2,
        totalToolCalls: 3,
        projectsActive: [],
        modelUsage: {},
        insights: [],
      }),
    ).rejects.toThrow("Space not found");
    await expect(
      writeOnly.query(api.models.lists.mcpQueries.getLists, {}),
    ).rejects.toThrow("Not authorized");
    await expect(
      writeOnly.action(api.models.thoughts.mcpActions.capture, {
        content: "A grounded memory",
        sourceType: "user_stated",
      }),
    ).rejects.toThrow("Thought capture requires read and write capabilities");
    await expect(
      sharedOnly.query(api.models.lists.mcpQueries.getLists, {}),
    ).rejects.toThrow("Not authorized");
    await expect(
      sharedOnly.query(api.models.reports.mcpQueries.listInsights, {}),
    ).rejects.toThrow("Not authorized");
    await expect(
      sharedOnly.mutation(api.models.lists.mcpActions.createList, {
        name: "Denied",
        pinned: false,
      }),
    ).rejects.toThrow("Not authorized");

    const report = await writeOnly.action(
      api.models.reports.mcpActions.createReport,
      {
        startDate: "2026-09-01",
        endDate: "2026-09-02",
        sessionsAnalyzed: 1,
        totalPrompts: 2,
        totalToolCalls: 3,
        projectsActive: [],
        modelUsage: {},
        insights: [],
      },
    );
    expect(report.insightIds).toEqual([]);
  });

  test("checks ownership before deleting an insight", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const create = async (name: string) => {
        const userId = await ctx.db.insert("users", {});
        const personalSpaceId = await ctx.db.insert("spaces", {
          kind: "personal",
          name: "Personal",
          createdBy: userId,
        });
        await ctx.db.insert("spaceMembers", {
          spaceId: personalSpaceId,
          userId,
          role: "owner",
        });
        await ctx.db.insert("userSpaceSettings", { userId, personalSpaceId });
        const keyId = await ctx.db.insert("apiKeys", {
          userId,
          keyHash: name.repeat(64).slice(0, 64),
          keyPrefix: `ob_${name}`,
          name,
          capabilities: ["read", "write"],
          spaceIds: [personalSpaceId],
        });
        return { userId, keyId };
      };
      const owner = await create("o");
      const other = await create("x");
      const reportId = await ctx.db.insert("reports", {
        userId: owner.userId,
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        sessionsAnalyzed: 1,
        totalPrompts: 1,
        totalToolCalls: 1,
        projectsActive: [],
        modelUsage: {},
      });
      const insightId = await ctx.db.insert("insights", {
        reportId,
        userId: owner.userId,
        category: "productivity",
        observation: "A private observation",
        recommendation: "Keep it private",
        evidence: "Private evidence",
        status: "new",
      });
      const otherReportId = await ctx.db.insert("reports", {
        userId: other.userId,
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        sessionsAnalyzed: 1,
        totalPrompts: 1,
        totalToolCalls: 1,
        projectsActive: [],
        modelUsage: {},
      });
      const crossLinkedInsightId = await ctx.db.insert("insights", {
        reportId: otherReportId,
        userId: owner.userId,
        category: "productivity",
        observation: "Wrong parent",
        recommendation: "Reject the mutation",
        evidence: "Cross-owner fixture",
        status: "new",
      });
      return { owner, other, insightId, crossLinkedInsightId };
    });
    const owner = t.withIdentity({
      issuer,
      subject: seeded.owner.userId,
      apiKeyId: seeded.owner.keyId,
    });
    const other = t.withIdentity({
      issuer,
      subject: seeded.other.userId,
      apiKeyId: seeded.other.keyId,
    });
    const ownerInsights = await owner.query(
      api.models.reports.mcpQueries.listInsights,
      {},
    );
    expect(ownerInsights.map((insight) => insight._id)).toEqual([
      seeded.insightId,
    ]);
    await expect(
      owner.mutation(api.models.reports.mcpMutations.deleteInsight, {
        insightId: seeded.crossLinkedInsightId,
      }),
    ).rejects.toThrow("Insight not found");
    await expect(
      other.mutation(api.models.reports.mcpMutations.deleteInsight, {
        insightId: seeded.insightId,
      }),
    ).rejects.toThrow("Insight not found");
    await owner.mutation(api.models.reports.mcpMutations.deleteInsight, {
      insightId: seeded.insightId,
    });
    expect(await t.run((ctx) => ctx.db.get(seeded.insightId))).toBeNull();
    expect(
      await t.run((ctx) => ctx.db.get(seeded.crossLinkedInsightId)),
    ).not.toBeNull();
  });

  test("activates a pending OAuth key once and revokes it on validated replay", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const sharedSpaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Family",
        createdBy: userId,
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: sharedSpaceId,
        userId,
        role: "reader",
      });
      const keyId = await ctx.db.insert("apiKeys", {
        userId,
        keyHash: "c".repeat(64),
        keyPrefix: "ob_code",
        name: "read shared",
        capabilities: ["read"],
        spaceIds: [sharedSpaceId],
        sourceAccountIds: [],
        oauthLifecycle: "pending",
        oauthRequestHash: "b".repeat(64),
        oauthCodeHash: "a".repeat(64),
        oauthBindingHash: "d".repeat(64),
        oauthBindingSeedHash: "e".repeat(64),
        oauthEncryptedCode: "obac1.synthetic",
        oauthGrantExpiresAt: Date.now() + 5 * 60 * 1000,
      });
      return { userId, keyId };
    });
    const caller = t.withIdentity({
      issuer,
      subject: seeded.userId,
      apiKeyId: seeded.keyId,
      oauthPurpose: "authorization_code_exchange",
      oauthKeyHash: "c".repeat(64),
      oauthCodeHash: "a".repeat(64),
      oauthBindingHash: "d".repeat(64),
      oauthRequestHash: "b".repeat(64),
    });
    const codeHash = "a".repeat(64);
    const expiresAt = await t.run(
      async (ctx) => (await ctx.db.get(seeded.keyId))!.oauthGrantExpiresAt!,
    );
    expect(
      await caller.mutation(
        api.models.oauth.mcpMutations.activateAuthorizationGrant,
        {
          codeHash,
          keyHash: "c".repeat(64),
          bindingHash: "d".repeat(64),
          requestHash: "b".repeat(64),
          expiresAt,
        },
      ),
    ).toEqual({ status: "activated" });
    expect(
      await caller.mutation(
        api.models.oauth.mcpMutations.activateAuthorizationGrant,
        {
          codeHash,
          keyHash: "c".repeat(64),
          bindingHash: "d".repeat(64),
          requestHash: "b".repeat(64),
          expiresAt,
        },
      ),
    ).toEqual({ status: "replayed" });
    expect(await t.run((ctx) => ctx.db.get(seeded.keyId))).toBeNull();
  });
});
