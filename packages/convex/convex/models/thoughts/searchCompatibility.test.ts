import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";

import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { fingerprintEmbeddingConfig } from "../../lib/embeddingProvider";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { sha256Hex } from "../ingestion/hash";
import { BASELINE_EMBEDDING_PROFILE } from "../embeddings/migrations";
import { embeddingVectorSearchScope } from "../embeddings/model";
import { embeddingVectorScopeV2 } from "../embeddings/targets";
import { compatibleSearchFingerprint } from "./actions";

const mcpIssuer = "https://brain.example.test";
const embedding = Array.from({ length: 1536 }, (_, index) =>
  index === 0 ? 1 : 0,
);

describe("thought vector compatibility", () => {
  test("requires every space to use one fingerprint", () => {
    const first = "space-a" as Id<"spaces">;
    const second = "space-b" as Id<"spaces">;
    const generationA = "generation-a" as Id<"embeddingGenerations">;
    const generationB = "generation-b" as Id<"embeddingGenerations">;

    expect(
      compatibleSearchFingerprint(
        [first, second],
        [
          {
            spaceId: first,
            embeddingGenerationId: generationA,
            fingerprint: "same",
          },
          {
            spaceId: second,
            embeddingGenerationId: generationB,
            fingerprint: "same",
          },
        ],
      ),
    ).toBe("same");
    expect(
      compatibleSearchFingerprint(
        [first, second],
        [
          {
            spaceId: first,
            embeddingGenerationId: generationA,
            fingerprint: "first",
          },
          {
            spaceId: second,
            embeddingGenerationId: generationB,
            fingerprint: "second",
          },
        ],
      ),
    ).toBeNull();
    expect(
      compatibleSearchFingerprint(
        [first, second],
        [
          {
            spaceId: first,
            embeddingGenerationId: generationA,
            fingerprint: "same",
          },
        ],
      ),
    ).toBeNull();
  });

  test.each([
    { label: "superseded", previousStatus: "superseded", compatible: true },
    { label: "retracted", previousStatus: "retracted", compatible: true },
    {
      label: "legacy superseded",
      previousStatus: "superseded",
      compatible: false,
    },
  ] as const)(
    "$label transition updates active-generation coverage",
    async ({ previousStatus, compatible }) => {
      const fingerprint = await fingerprintEmbeddingConfig(
        BASELINE_EMBEDDING_PROFILE,
      );
      const t = convexTest(schema, modules);
      const seeded = await t.run(async (ctx) => {
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
        const profileId = await ctx.db.insert("embeddingProfiles", {
          fingerprint,
          ...BASELINE_EMBEDDING_PROFILE,
          createdAt: 1,
        });
        const retiredGenerationId = await ctx.db.insert(
          "embeddingGenerations",
          {
            spaceId,
            embeddingProfileId: profileId,
            fingerprint,
            state: "retired",
            eligibilityEpoch: 0,
            manifestHash: "retired-manifest",
            expectedThoughtCount: 1,
            expectedChunkCount: 0,
            completedThoughtCount: 1,
            completedChunkCount: 0,
            createdAt: 1,
            stagedAt: 1,
            activatedAt: 1,
            deactivatedAt: 2,
          },
        );
        const activeGenerationId = await ctx.db.insert("embeddingGenerations", {
          spaceId,
          embeddingProfileId: profileId,
          fingerprint,
          state: "active",
          eligibilityEpoch: 0,
          manifestHash: "active-manifest",
          expectedThoughtCount: 1,
          expectedChunkCount: 0,
          completedThoughtCount: 1,
          completedChunkCount: 0,
          createdAt: 2,
          stagedAt: 2,
          activatedAt: 2,
        });
        const previousContent = "The original synthetic project state";
        const previousHash = await sha256Hex(previousContent);
        await ctx.db.insert("spaceEmbeddingStates", {
          spaceId,
          eligibilityEpoch: 0,
          activeEmbeddingGenerationId: activeGenerationId,
          activeFingerprint: fingerprint,
          activatedAt: 2,
          eligibleCounts: { thought: 1, chunk: 0, card: 0 },
          coveredCounts: [
            { fingerprint, counts: { thought: 1, chunk: 0, card: 0 } },
          ],
          counterDrift: false,
          lastAuditAt: 2,
        });
        const previousId = await ctx.db.insert("thoughts", {
          userId,
          spaceId,
          content: previousContent,
          embedding,
          metadata: {
            type: "reference",
            topics: ["project"],
            people: [],
            actionItems: [],
            summary: "Original state",
          },
          memoryStatus: "current",
        });
        await ctx.db.insert("embeddingTargets", {
          spaceId,
          targetKind: "thought",
          targetId: String(previousId),
          inputHash: previousHash,
          state: "eligible",
          coveredFingerprint: fingerprint,
          updatedAt: 2,
        });
        const insertStoredVector = async (
          embeddingGenerationId:
            typeof activeGenerationId | typeof retiredGenerationId,
        ) =>
          await ctx.db.insert("embeddingVectors", {
            spaceId,
            embeddingGenerationId,
            embeddingFingerprint: fingerprint,
            searchScope: embeddingVectorSearchScope({
              spaceId,
              embeddingGenerationId,
              fingerprint,
              targetKind: "thought",
            }),
            scopeV2: embeddingVectorScopeV2({
              spaceId,
              fingerprint,
              targetKind: "thought",
            }),
            targetKind: "thought",
            thoughtId: previousId,
            inputHash: previousHash,
            embedding,
          });
        const activeVectorId = await insertStoredVector(activeGenerationId);
        const retiredVectorId = await insertStoredVector(retiredGenerationId);
        return {
          userId,
          spaceId,
          previousId,
          activeGenerationId,
          retiredGenerationId,
          activeVectorId,
          retiredVectorId,
        };
      });

      const replacementId = await t.mutation(
        internal.models.thoughts.private.transitionMemoryAuthorized,
        {
          principal: { userId: seeded.userId },
          spaceId: seeded.spaceId,
          content: "The replacement synthetic project state",
          embedding,
          ...(compatible
            ? {
                embeddingGenerationId: seeded.activeGenerationId,
                embeddingFingerprint: fingerprint,
              }
            : {}),
          metadata: {
            type: "reference",
            topics: ["project"],
            people: [],
            actionItems: [],
            summary: "Replacement state",
          },
          previousIds: [seeded.previousId],
          previousStatus,
          reason: "Synthetic transition",
          transitionedAt: 3,
        },
      );

      const stored = await t.run(async (ctx) => ({
        previous: await ctx.db.get(seeded.previousId),
        activeGeneration: await ctx.db.get(seeded.activeGenerationId),
        activeVectors: await ctx.db
          .query("embeddingVectors")
          .withIndex("by_embeddingGenerationId", (q) =>
            q.eq("embeddingGenerationId", seeded.activeGenerationId),
          )
          .collect(),
        retiredVector: await ctx.db.get(seeded.retiredVectorId),
        removedActiveVector: await ctx.db.get(seeded.activeVectorId),
      }));
      expect(stored.previous?.memoryStatus).toBe(previousStatus);
      // The counters, not a whole-space derive, now carry the shortfall: a
      // legacy write leaves an eligible thought target its fingerprint does
      // not cover, and that is what the generation row mirrors.
      expect(stored.activeGeneration).toMatchObject({
        state: "active",
        expectedThoughtCount: 1,
        completedThoughtCount: compatible ? 1 : 0,
        thoughtCoverageInvalid: false,
      });
      expect(stored.activeVectors).toMatchObject(
        compatible
          ? [
              {
                thoughtId: replacementId,
                embeddingGenerationId: seeded.activeGenerationId,
              },
            ]
          : [
              {
                thoughtId: seeded.previousId,
                embeddingGenerationId: seeded.activeGenerationId,
              },
            ],
      );
      expect(stored.removedActiveVector === null).toBe(compatible);
      expect(stored.retiredVector).toMatchObject({
        thoughtId: seeded.previousId,
        embeddingGenerationId: seeded.retiredGenerationId,
      });
    },
  );

  test("rolls back capture when the active thought index is incomplete", async () => {
    const fingerprint = await fingerprintEmbeddingConfig(
      BASELINE_EMBEDDING_PROFILE,
    );
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const spaceId = await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Bounded",
        createdBy: userId,
      });
      await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
      const profileId = await ctx.db.insert("embeddingProfiles", {
        fingerprint,
        ...BASELINE_EMBEDDING_PROFILE,
        createdAt: 1,
      });
      const embeddingGenerationId = await ctx.db.insert(
        "embeddingGenerations",
        {
          spaceId,
          embeddingProfileId: profileId,
          fingerprint,
          state: "active",
          eligibilityEpoch: 0,
          manifestHash: "bounded-manifest",
          expectedThoughtCount: 1,
          expectedChunkCount: 0,
          completedThoughtCount: 0,
          completedChunkCount: 0,
          createdAt: 1,
          stagedAt: 1,
          activatedAt: 1,
        },
      );
      // One eligible thought target the active fingerprint does not cover.
      // I9 keeps narrative capture strict about exactly this shortfall.
      const uncoveredId = await ctx.db.insert("thoughts", {
        userId,
        spaceId,
        content: "An existing memory with no vector",
        embedding,
        metadata: {
          type: "reference",
          topics: [],
          people: [],
          actionItems: [],
          summary: "Uncovered",
        },
        memoryStatus: "current",
      });
      await ctx.db.insert("embeddingTargets", {
        spaceId,
        targetKind: "thought",
        targetId: String(uncoveredId),
        inputHash: await sha256Hex("An existing memory with no vector"),
        state: "eligible",
        updatedAt: 1,
      });
      await ctx.db.insert("spaceEmbeddingStates", {
        spaceId,
        eligibilityEpoch: 0,
        activeEmbeddingGenerationId: embeddingGenerationId,
        activeFingerprint: fingerprint,
        activatedAt: 1,
        eligibleCounts: { thought: 1, chunk: 0, card: 0 },
        coveredCounts: [
          { fingerprint, counts: { thought: 0, chunk: 0, card: 0 } },
        ],
        counterDrift: false,
        lastAuditAt: 1,
      });
      return { userId, spaceId, embeddingGenerationId };
    });

    await expect(
      t.mutation(internal.models.thoughts.private.insertOneAuthorized, {
        principal: { userId: seeded.userId },
        spaceId: seeded.spaceId,
        content: "The memory that cannot be admitted yet",
        embedding,
        embeddingGenerationId: seeded.embeddingGenerationId,
        embeddingFingerprint: fingerprint,
        metadata: {
          type: "reference",
          topics: [],
          people: [],
          actionItems: [],
          summary: "Incomplete index",
        },
      }),
    ).rejects.toThrow("requires a complete active thought embedding index");
    const after = await t.run(async (ctx) => ({
      thoughts: await ctx.db
        .query("thoughts")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .collect(),
      vectors: await ctx.db
        .query("embeddingVectors")
        .withIndex("by_embeddingGenerationId", (q) =>
          q.eq("embeddingGenerationId", seeded.embeddingGenerationId),
        )
        .collect(),
      targets: await ctx.db
        .query("embeddingTargets")
        .withIndex("by_space_and_state", (q) =>
          q.eq("spaceId", seeded.spaceId).eq("state", "eligible"),
        )
        .collect(),
    }));
    expect(after.thoughts).toHaveLength(1);
    expect(after.vectors).toHaveLength(0);
    expect(after.targets).toHaveLength(1);

    // A legacy write with no embedding identity still admits the memory and
    // reports the widened shortfall through the counters.
    await t.mutation(internal.models.thoughts.private.insertOneAuthorized, {
      principal: { userId: seeded.userId },
      spaceId: seeded.spaceId,
      content: "A trusted legacy write widens the coverage shortfall",
      embedding,
      metadata: {
        type: "reference",
        topics: [],
        people: [],
        actionItems: [],
        summary: "Legacy coverage shortfall",
      },
    });
    const invalidated = await t.run(async (ctx) => ({
      thoughts: await ctx.db
        .query("thoughts")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .collect(),
      generation: await ctx.db.get(seeded.embeddingGenerationId),
    }));
    expect(invalidated.thoughts).toHaveLength(2);
    expect(invalidated.generation).toMatchObject({
      expectedThoughtCount: 2,
      completedThoughtCount: 0,
    });
  });
});

describe("thought keyword fallback", () => {
  const originalIssuer = process.env.MCP_JWT_ISSUER;

  beforeEach(() => {
    process.env.MCP_JWT_ISSUER = mcpIssuer;
  });

  afterEach(() => {
    if (originalIssuer === undefined) delete process.env.MCP_JWT_ISSUER;
    else process.env.MCP_JWT_ISSUER = originalIssuer;
  });

  test("returns keyword and empty results with unavailable vector status", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
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
      const thoughtId = await ctx.db.insert("thoughts", {
        userId,
        spaceId,
        content: "The observatory opens before sunrise",
        embedding,
        metadata: {
          type: "reference",
          topics: ["observatory"],
          people: [],
          actionItems: [],
          summary: "Observatory schedule",
        },
        memoryStatus: "current",
      });
      const keyId = await ctx.db.insert("apiKeys", {
        userId,
        keyHash: "f".repeat(64),
        keyPrefix: "ob_fallback",
        name: "fallback",
        capabilities: ["read"],
        spaceIds: [spaceId],
      });
      return { userId, spaceId, thoughtId, keyId };
    });
    const caller = t.withIdentity({
      issuer: mcpIssuer,
      subject: seeded.userId,
      apiKeyId: seeded.keyId,
    });

    await expect(
      caller.action(api.models.thoughts.mcpActions.searchWithStatus, {
        query: "observatory",
      }),
    ).resolves.toMatchObject({
      vectorStatus: "unavailable",
      results: [{ _id: seeded.thoughtId }],
    });
    await expect(
      caller.action(api.models.thoughts.mcpActions.searchWithStatus, {
        query: "nonexistent-term",
      }),
    ).resolves.toEqual({ results: [], vectorStatus: "unavailable" });
  });
});

describe("empty-space capture bootstrap", () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalAnthropicKey === undefined)
      delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  });

  test("requires migration when an unprofiled space already has content", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("Embedding provider must not be called");
    });
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      const spaceId = await ctx.db.insert("spaces", {
        kind: "personal",
        name: "Personal",
        createdBy: id,
      });
      await ctx.db.insert("spaceMembers", {
        spaceId,
        userId: id,
        role: "owner",
      });
      await ctx.db.insert("userSpaceSettings", {
        userId: id,
        personalSpaceId: spaceId,
      });
      await ctx.db.insert("thoughts", {
        userId: id,
        spaceId,
        content: "Existing synthetic memory",
        embedding,
        metadata: {
          type: "reference",
          topics: [],
          people: [],
          actionItems: [],
          summary: "Existing synthetic memory",
        },
      });
      return id;
    });

    await expect(
      t.action(internal.models.thoughts.actions.captureThoughtTrustedPersonal, {
        userId,
        content: "A durable synthetic memory about migration behavior",
        sourceType: "user_stated",
      }),
    ).rejects.toThrow("requires an embedding migration");
  });

  test("creates the configured baseline generation and canonical vector", async () => {
    process.env.OPENAI_API_KEY = "synthetic-openai-key";
    process.env.ANTHROPIC_API_KEY = "synthetic-anthropic-key";
    const vector = Array.from({ length: 1536 }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/embeddings")) {
        return new Response(
          JSON.stringify({
            model: "text-embedding-3-small",
            data: [{ embedding: vector }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("api.anthropic.com")) {
        return new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  action: "ADD",
                  relatedThoughtIds: [],
                  reason: "Synthetic durable project context",
                  replacementContent: null,
                  metadata: {
                    type: "reference",
                    topics: ["migration"],
                    people: [],
                    actionItems: [],
                    summary: "The migration keeps retrieval available",
                  },
                }),
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected synthetic request: ${url}`);
    });

    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const captured = await t.action(
      internal.models.thoughts.actions.captureThoughtTrustedPersonal,
      {
        userId,
        content:
          "The migration strategy keeps semantic retrieval available while generations change.",
        sourceType: "user_stated",
      },
    );
    expect(captured.disposition).toBe("stored");

    const stored = await t.run(async (ctx) => {
      const thoughts = await ctx.db.query("thoughts").collect();
      const profiles = await ctx.db.query("embeddingProfiles").collect();
      const generations = await ctx.db.query("embeddingGenerations").collect();
      const vectors = await ctx.db.query("embeddingVectors").collect();
      return { thoughts, profiles, generations, vectors };
    });
    expect(stored.thoughts).toHaveLength(1);
    expect(stored.profiles).toMatchObject([
      {
        providerId: "openai",
        model: "text-embedding-3-small",
        modelRevision: "legacy-openai-small-1536-v1",
      },
    ]);
    expect(stored.generations).toMatchObject([
      {
        state: "active",
        expectedThoughtCount: 1,
        completedThoughtCount: 1,
      },
    ]);
    expect(stored.vectors).toMatchObject([
      {
        thoughtId: stored.thoughts[0]!._id,
        embeddingGenerationId: stored.generations[0]!._id,
        embeddingFingerprint: stored.profiles[0]!.fingerprint,
        targetKind: "thought",
        embedding: vector,
      },
    ]);
  });
});
