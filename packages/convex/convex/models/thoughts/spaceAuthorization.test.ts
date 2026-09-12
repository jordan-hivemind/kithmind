import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";

import { api, internal } from "../../_generated/api";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { _computeSpaceStats } from "./model";

const mcpIssuer = "https://brain.example.test";
const sessionIssuer = "https://brain.example.test/convex";
const embedding = Array.from({ length: 1536 }, () => 0);
const metadata = (
  summary: string,
  type: "idea" | "reference" = "reference",
) => ({
  type,
  topics: summary.includes("target") ? ["target"] : ["other"],
  people: [],
  actionItems: [],
  summary,
});

describe("thought space authorization", () => {
  const originalIssuer = process.env.MCP_JWT_ISSUER;

  beforeEach(() => {
    process.env.MCP_JWT_ISSUER = mcpIssuer;
  });

  afterEach(() => {
    if (originalIssuer === undefined) delete process.env.MCP_JWT_ISSUER;
    else process.env.MCP_JWT_ISSUER = originalIssuer;
  });

  test("reads every authorized space globally without crossing private spaces", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", { name: "Owner" });
      const memberId = await ctx.db.insert("users", { name: "Member" });
      const createPersonal = async (userId: typeof ownerId) => {
        const spaceId = await ctx.db.insert("spaces", {
          kind: "personal",
          name: "Personal",
          createdBy: userId,
        });
        await ctx.db.insert("spaceMembers", {
          spaceId,
          userId,
          role: "owner",
        });
        await ctx.db.insert("userSpaceSettings", {
          userId,
          personalSpaceId: spaceId,
        });
        return spaceId;
      };
      const ownerPersonal = await createPersonal(ownerId);
      const memberPersonal = await createPersonal(memberId);
      const sharedSpaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Family",
        createdBy: ownerId,
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: sharedSpaceId,
        userId: ownerId,
        role: "owner",
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: sharedSpaceId,
        userId: memberId,
        role: "editor",
      });
      const insert = async (
        userId: typeof ownerId,
        spaceId: typeof sharedSpaceId,
        summary: string,
        type: "idea" | "reference" = "reference",
      ) =>
        await ctx.db.insert("thoughts", {
          userId,
          spaceId,
          content: summary,
          embedding,
          metadata: metadata(summary, type),
          memoryStatus: "current",
        });
      const ownerPrivateId = await insert(
        ownerId,
        ownerPersonal,
        "owner private target",
      );
      const sharedId = await insert(
        ownerId,
        sharedSpaceId,
        "shared family target",
      );
      await insert(memberId, memberPersonal, "member private target");
      const olderTargetIdeaId = await insert(
        ownerId,
        sharedSpaceId,
        "older target idea",
        "idea",
      );
      await insert(memberId, sharedSpaceId, "newer unrelated", "idea");
      return {
        memberId,
        ownerPersonal,
        memberPersonal,
        sharedSpaceId,
        ownerPrivateId,
        sharedId,
        olderTargetIdeaId,
      };
    });
    const member = t.withIdentity({
      issuer: sessionIssuer,
      subject: seeded.memberId,
    });

    const visible = await member.query(api.models.thoughts.public.listRecent, {
      limit: 20,
    });
    expect(visible.map((row) => row._id)).toContain(seeded.sharedId);
    expect(visible.map((row) => row._id)).not.toContain(seeded.ownerPrivateId);
    expect(visible.find((row) => row._id === seeded.sharedId)).toMatchObject({
      userId: expect.any(String),
      spaceId: seeded.sharedSpaceId,
    });

    const filtered = await member.query(api.models.thoughts.public.listRecent, {
      limit: 1,
      type: "idea",
      topic: "target",
      spaceIds: [seeded.sharedSpaceId],
    });
    expect(filtered.map((row) => row._id)).toEqual([seeded.olderTargetIdeaId]);

    await expect(
      member.query(api.models.thoughts.public.listRecent, {
        spaceIds: [seeded.ownerPersonal],
      }),
    ).rejects.toThrow("Space not found");
    const stats = await member.query(api.models.thoughts.public.getStats, {});
    expect(stats.totalThoughts).toBe(4);
    // The scan bound now labels the result partial instead of failing the
    // read, and it still never leaves the authorized spaces.
    const bounded = await t.run((ctx) =>
      _computeSpaceStats(ctx, [seeded.memberPersonal, seeded.sharedSpaceId], {
        maxScanRows: 3,
      }),
    );
    expect(bounded.partial).toBe(true);
    expect(bounded.coverage.map((row) => row.spaceId)).toEqual([
      seeded.memberPersonal,
      seeded.sharedSpaceId,
    ]);
  });

  test("direct ID and timeline hydration obey live key space scopes", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const otherId = await ctx.db.insert("users", {});
      const createPersonal = async (owner: typeof userId) => {
        const spaceId = await ctx.db.insert("spaces", {
          kind: "personal",
          name: "Personal",
          createdBy: owner,
        });
        await ctx.db.insert("spaceMembers", {
          spaceId,
          userId: owner,
          role: "owner",
        });
        await ctx.db.insert("userSpaceSettings", {
          userId: owner,
          personalSpaceId: spaceId,
        });
        return spaceId;
      };
      const personalSpaceId = await createPersonal(userId);
      const otherSpaceId = await createPersonal(otherId);
      const insert = async (
        owner: typeof userId,
        spaceId: typeof personalSpaceId,
        content: string,
      ) =>
        await ctx.db.insert("thoughts", {
          userId: owner,
          spaceId,
          content,
          embedding,
          metadata: metadata(content),
        });
      const visibleId = await insert(userId, personalSpaceId, "visible");
      const hiddenId = await insert(otherId, otherSpaceId, "hidden");
      const candidateIds = [];
      for (let index = 0; index < 120; index += 1) {
        candidateIds.push(
          await insert(userId, personalSpaceId, `candidate ${index}`),
        );
      }
      const keyId = await ctx.db.insert("apiKeys", {
        userId,
        keyHash: "k".repeat(64),
        keyPrefix: "ob_scope",
        name: "scope",
        capabilities: ["read"],
        spaceIds: [personalSpaceId],
      });
      return {
        userId,
        personalSpaceId,
        otherSpaceId,
        visibleId,
        hiddenId,
        candidateIds,
        keyId,
      };
    });
    const caller = t.withIdentity({
      issuer: mcpIssuer,
      subject: seeded.userId,
      apiKeyId: seeded.keyId,
    });

    const rows = await caller.action(api.models.thoughts.mcpActions.getByIds, {
      ids: [seeded.hiddenId, seeded.visibleId],
    });
    expect(rows.map((row) => row._id)).toEqual([seeded.visibleId]);
    const hydratedCandidates = await t.query(
      internal.models.thoughts.private.getByIdsAuthorized,
      {
        principal: { userId: seeded.userId, credentialId: seeded.keyId },
        ids: seeded.candidateIds,
      },
    );
    expect(hydratedCandidates).toHaveLength(120);
    await expect(
      caller.action(api.models.thoughts.mcpActions.getByIds, {
        ids: seeded.candidateIds,
      }),
    ).rejects.toThrow("Too many thought IDs");
    await expect(
      caller.action(api.models.thoughts.mcpActions.timeline, {
        seedId: seeded.hiddenId,
      }),
    ).rejects.toThrow("Seed thought not found");
    await expect(
      caller.action(api.models.thoughts.mcpActions.getByIds, {
        ids: [seeded.visibleId],
        spaceIds: [seeded.otherSpaceId],
      }),
    ).rejects.toThrow("Space not found");

    await t.run((ctx) => ctx.db.delete(seeded.keyId));
    await expect(
      caller.action(api.models.thoughts.mcpActions.getByIds, {
        ids: [seeded.visibleId],
      }),
    ).rejects.toThrow("Not authenticated");
    await expect(
      t.mutation(internal.models.thoughts.private.insertOneAuthorized, {
        principal: { userId: seeded.userId, credentialId: seeded.keyId },
        spaceId: seeded.personalSpaceId,
        content: "Must not write after revocation",
        embedding,
        metadata: metadata("Must not write after revocation"),
      }),
    ).rejects.toThrow("Not authenticated");
  });

  test("shared writes use role authorization and keep audit authors separate", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const ownerId = await ctx.db.insert("users", {});
      const editorId = await ctx.db.insert("users", {});
      const readerId = await ctx.db.insert("users", {});
      const sharedSpaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Family",
        createdBy: ownerId,
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: sharedSpaceId,
        userId: ownerId,
        role: "owner",
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: sharedSpaceId,
        userId: editorId,
        role: "editor",
      });
      await ctx.db.insert("spaceMembers", {
        spaceId: sharedSpaceId,
        userId: readerId,
        role: "reader",
      });
      const previousId = await ctx.db.insert("thoughts", {
        userId: ownerId,
        spaceId: sharedSpaceId,
        content: "Shared old value",
        embedding,
        metadata: metadata("Shared old value"),
        memoryStatus: "current",
      });
      return { ownerId, editorId, readerId, sharedSpaceId, previousId };
    });

    const replacementId = await t.mutation(
      internal.models.thoughts.private.transitionMemoryAuthorized,
      {
        principal: { userId: seeded.editorId },
        spaceId: seeded.sharedSpaceId,
        content: "Shared new value",
        embedding,
        metadata: metadata("Shared new value"),
        previousIds: [seeded.previousId],
        previousStatus: "superseded",
        reason: "Updated by another family editor",
        transitionedAt: Date.now(),
      },
    );
    expect(await t.run((ctx) => ctx.db.get(replacementId))).toMatchObject({
      userId: seeded.editorId,
      spaceId: seeded.sharedSpaceId,
      supersedes: [seeded.previousId],
    });

    const reader = t.withIdentity({
      issuer: sessionIssuer,
      subject: seeded.readerId,
    });
    await expect(
      reader.action(api.models.thoughts.publicActions.capture, {
        content: "Reader cannot change shared memory",
        spaceId: seeded.sharedSpaceId,
      }),
    ).rejects.toThrow("Space not found");
  });
});
