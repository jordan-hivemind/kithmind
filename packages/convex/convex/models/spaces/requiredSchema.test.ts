import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../../schema";
import { modules } from "../../test.setup";

const metadata = {
  type: "reference" as const,
  topics: [],
  people: [],
  actionItems: [],
  summary: "Synthetic required-schema fixture",
};

describe("required ownership and key grants", () => {
  test("rejects content without a spaceId", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const spaceId = await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Personal",
        createdBy: userId,
      });
      const entityId = await ctx.db.insert("entities", {
        userId,
        spaceId,
        key: "person:alex",
        kind: "person",
        canonicalName: "Alex",
        normalizedName: "alex",
        aliases: [],
        normalizedAliases: [],
      });
      return { entityId, userId };
    });

    await expect(
      t.run(async (ctx) => {
        // @ts-expect-error Deliberately exercise the runtime schema boundary.
        await ctx.db.insert("entities", {
          userId: seeded.userId,
          key: "person:missing-space",
          kind: "person",
          canonicalName: "Missing Space",
          normalizedName: "missing space",
          aliases: [],
          normalizedAliases: [],
        });
      }),
    ).rejects.toThrow(/spaceId/);

    await expect(
      t.run(async (ctx) => {
        // @ts-expect-error Deliberately exercise the runtime schema boundary.
        await ctx.db.insert("facts", {
          userId: seeded.userId,
          subjectEntityId: seeded.entityId,
          predicate: "synthetic_predicate",
          value: { type: "text", value: "Synthetic value" },
          statement: "Synthetic statement.",
          searchText: "synthetic statement",
          sourceType: "user_stated",
          confidence: 1,
          status: "current",
        });
      }),
    ).rejects.toThrow(/spaceId/);

    await expect(
      t.run(async (ctx) => {
        // @ts-expect-error Deliberately exercise the runtime schema boundary.
        await ctx.db.insert("thoughts", {
          userId: seeded.userId,
          content: "Synthetic thought without ownership",
          embedding: Array(1536).fill(0),
          metadata,
        });
      }),
    ).rejects.toThrow(/spaceId/);
  });

  test("rejects API keys without explicit capabilities or space scopes", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const spaceId = await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Personal",
        createdBy: userId,
      });
      return { spaceId, userId };
    });

    await expect(
      t.run(async (ctx) => {
        // @ts-expect-error Deliberately exercise the runtime schema boundary.
        await ctx.db.insert("apiKeys", {
          userId: seeded.userId,
          keyHash: "a".repeat(64),
          keyPrefix: "ob_missing_capabilities",
          name: "Missing capabilities",
          spaceIds: [seeded.spaceId],
        });
      }),
    ).rejects.toThrow(/capabilities/);

    await expect(
      t.run(async (ctx) => {
        // @ts-expect-error Deliberately exercise the runtime schema boundary.
        await ctx.db.insert("apiKeys", {
          userId: seeded.userId,
          keyHash: "b".repeat(64),
          keyPrefix: "ob_missing_scopes",
          name: "Missing scopes",
          capabilities: ["read"],
        });
      }),
    ).rejects.toThrow(/spaceIds/);
  });
});
