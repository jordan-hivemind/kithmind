import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";

import { api, internal } from "../../_generated/api";
import schema from "../../schema";
import { modules } from "../../test.setup";

type TestBackend = ReturnType<typeof convexTest>;

const issuer = "https://brain.example.test";
const embedding = Array.from({ length: 1536 }, () => 0);
const metadata = {
  type: "person_note" as const,
  topics: ["identity"],
  people: [],
  actionItems: [],
  summary: "Core identity fact",
};

async function createPersonalUser(t: TestBackend) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Personal",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    await ctx.db.insert("userSpaceSettings", {
      userId,
      personalSpaceId: spaceId,
    });
    return { userId, spaceId };
  });
}

describe("core memories", () => {
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

  test("returns a bounded current core set for only the authenticated account", async () => {
    const t = convexTest(schema, modules);
    const {
      ownerId,
      otherId,
      ownerSpaceId,
      otherSpaceId,
      ownerKeyId,
      otherKeyId,
    } = await t.run(async (ctx) => {
      const create = async (label: string) => {
        const userId = await ctx.db.insert("users", {});
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
        const keyId = await ctx.db.insert("apiKeys", {
          userId,
          keyHash: label.repeat(64).slice(0, 64),
          keyPrefix: `ob_${label}`,
          name: label,
          capabilities: ["read"],
          spaceIds: [spaceId],
        });
        return { userId, spaceId, keyId };
      };
      const owner = await create("o");
      const other = await create("x");
      return {
        ownerId: owner.userId,
        otherId: other.userId,
        ownerSpaceId: owner.spaceId,
        otherSpaceId: other.spaceId,
        ownerKeyId: owner.keyId,
        otherKeyId: other.keyId,
      };
    });
    await t.run(async (ctx) => {
      for (let index = 0; index < 30; index++) {
        await ctx.db.insert("thoughts", {
          userId: ownerId,
          spaceId: ownerSpaceId,
          content: `Owner core memory ${index}`,
          embedding,
          metadata,
          isCore: true,
          memoryStatus: "current",
        });
      }
      await ctx.db.insert("thoughts", {
        userId: ownerId,
        spaceId: ownerSpaceId,
        content: "Owner non-core memory",
        embedding,
        metadata,
        isCore: false,
      });
      await ctx.db.insert("thoughts", {
        userId: ownerId,
        spaceId: ownerSpaceId,
        content: "Owner expired core memory",
        embedding,
        metadata,
        isCore: true,
        validTo: Date.now() - 60_000,
      });
      await ctx.db.insert("thoughts", {
        userId: ownerId,
        spaceId: ownerSpaceId,
        content: "Owner future core memory",
        embedding,
        metadata,
        isCore: true,
        memoryStatus: "current",
        validFrom: Date.now() + 60_000,
      });
      await ctx.db.insert("thoughts", {
        userId: ownerId,
        spaceId: ownerSpaceId,
        content: "Owner historical core memory",
        embedding,
        metadata,
        isCore: true,
        memoryStatus: "superseded",
      });
      await ctx.db.insert("thoughts", {
        userId: otherId,
        spaceId: otherSpaceId,
        content: "Other account core memory",
        embedding,
        metadata,
        isCore: true,
        memoryStatus: "current",
      });
      // These are newer than the retrievable core set. The previous fixed
      // 250-candidate window returned nothing once enough history accumulated.
      for (let index = 0; index < 260; index += 1) {
        await ctx.db.insert("thoughts", {
          userId: ownerId,
          spaceId: ownerSpaceId,
          content: `Owner retracted core memory ${index}`,
          embedding,
          metadata,
          isCore: true,
          memoryStatus: "retracted",
        });
      }
    });

    const owner = t.withIdentity({
      issuer,
      subject: ownerId,
      apiKeyId: ownerKeyId,
    });
    const other = t.withIdentity({
      issuer,
      subject: otherId,
      apiKeyId: otherKeyId,
    });
    await expect(
      t.query(api.models.thoughts.mcpQueries.listCore, {}),
    ).rejects.toThrow("Not authenticated");
    const ownerResults = await owner.query(
      api.models.thoughts.mcpQueries.listCore,
      { limit: 100 },
    );
    const otherResults = await other.query(
      api.models.thoughts.mcpQueries.listCore,
      {},
    );

    expect(ownerResults).toHaveLength(25);
    expect(
      ownerResults.every(
        (memory) =>
          memory.userId === ownerId &&
          memory.isCore === true &&
          memory.memoryStatus === "current" &&
          memory.content.startsWith("Owner core memory"),
      ),
    ).toBe(true);
    expect(otherResults.map((memory) => memory.content)).toEqual([
      "Other account core memory",
    ]);
    await expect(
      owner.query(api.models.thoughts.mcpQueries.listCore, { limit: 0 }),
    ).rejects.toThrow("Core memory limit must be a positive integer");
  });

  test("inherits core status across transitions unless explicitly overridden", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const originalId = await t.mutation(
      internal.models.thoughts.private.insertOne,
      {
        userId,
        content: "A durable core fact",
        embedding,
        metadata,
        isCore: true,
      },
    );
    const nonCoreId = await t.mutation(
      internal.models.thoughts.private.insertOne,
      {
        userId,
        content: "A related non-core fact",
        embedding,
        metadata,
        isCore: false,
      },
    );

    const inheritedId = await t.mutation(
      internal.models.thoughts.private.transitionMemory,
      {
        userId,
        content: "An updated durable core fact",
        embedding,
        metadata,
        previousIds: [originalId, nonCoreId],
        previousStatus: "superseded",
        reason: "The core fact changed",
        transitionedAt: Date.now(),
      },
    );
    const explicitlyNonCoreId = await t.mutation(
      internal.models.thoughts.private.transitionMemory,
      {
        userId,
        content: "The fact no longer belongs in always-on context",
        embedding,
        metadata,
        previousIds: [inheritedId],
        previousStatus: "superseded",
        reason: "The user explicitly removed core status",
        transitionedAt: Date.now(),
        isCore: false,
      },
    );

    const [inherited, explicitlyNonCore] = await t.run(async (ctx) => [
      await ctx.db.get(inheritedId),
      await ctx.db.get(explicitlyNonCoreId),
    ]);
    expect(inherited?.isCore).toBe(true);
    expect(explicitlyNonCore?.isCore).toBe(false);
  });

  test("prevents cross-account core updates and transitions without partial writes", async () => {
    const t = convexTest(schema, modules);
    const owner = await createPersonalUser(t);
    const other = await createPersonalUser(t);
    const ownerId = owner.userId;
    const otherId = other.userId;
    const [ownerMemoryId, otherMemoryId] = await t.run(async (ctx) => [
      await ctx.db.insert("thoughts", {
        userId: ownerId,
        spaceId: owner.spaceId,
        content: "Owner core memory",
        embedding,
        metadata,
        isCore: true,
      }),
      await ctx.db.insert("thoughts", {
        userId: otherId,
        spaceId: other.spaceId,
        content: "Other memory",
        embedding,
        metadata,
        isCore: false,
      }),
    ]);

    await expect(
      t.mutation(internal.models.thoughts.private.setCoreStatus, {
        userId: ownerId,
        id: otherMemoryId,
        isCore: true,
      }),
    ).rejects.toThrow("Current memory not found");
    await expect(
      t.mutation(internal.models.thoughts.private.transitionMemory, {
        userId: ownerId,
        content: "Invalid cross-account replacement",
        embedding,
        metadata,
        previousIds: [ownerMemoryId, otherMemoryId],
        previousStatus: "superseded",
        reason: "Must not cross account boundaries",
        transitionedAt: Date.now(),
      }),
    ).rejects.toThrow("Previous memory is unavailable");

    const thoughts = await t.run((ctx) => ctx.db.query("thoughts").collect());
    expect(thoughts).toHaveLength(2);
    expect(
      thoughts.find((memory) => memory._id === ownerMemoryId)?.isCore,
    ).toBe(true);
    expect(
      thoughts.find((memory) => memory._id === otherMemoryId)?.isCore,
    ).toBe(false);
    expect(thoughts.every((memory) => memory.supersededBy === undefined)).toBe(
      true,
    );
  });
});
