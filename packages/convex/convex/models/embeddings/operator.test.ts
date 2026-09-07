import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../_generated/api";
import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  BASELINE_EMBEDDING_DIMENSIONS,
  fingerprintEmbeddingConfig,
  type EmbeddingProfile,
} from "../../lib/embeddingProvider";
import {
  activateEmbeddingGeneration,
  bumpEmbeddingEligibilityEpoch,
  createEmbeddingGeneration,
  insertThoughtEmbedding,
  stageEmbeddingGeneration,
} from "./model";

const profile: EmbeddingProfile = {
  protocol: "openai-embeddings-v1",
  providerId: "synthetic-provider",
  model: "synthetic-model",
  modelRevision: "synthetic-v1",
  dimensions: BASELINE_EMBEDDING_DIMENSIONS,
  normalization: "none-v1",
  preprocessing: "none-v1",
};

const metadata = {
  type: "reference" as const,
  topics: [],
  people: [],
  actionItems: [],
  summary: "Synthetic memory",
};

// Runtime references are dynamic. The generated declaration is refreshed by
// Convex after this new module is added.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const operator = (internal as any).models.embeddings.operator;

describe("registered embedding generation workflow", () => {
  test("rejects bad batches and incomplete flips, then atomically replaces the active generation", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const [userId, otherUserId] = await Promise.all([
        ctx.db.insert("users", { name: "Synthetic owner" }),
        ctx.db.insert("users", { name: "Synthetic outsider" }),
      ]);
      const [spaceId, otherSpaceId] = await Promise.all([
        ctx.db.insert("spaces", {
          kind: "personal",
          name: "Synthetic personal",
          createdBy: userId,
        }),
        ctx.db.insert("spaces", {
          kind: "personal",
          name: "Synthetic other",
          createdBy: otherUserId,
        }),
      ]);
      const [thoughtId, otherThoughtId] = await Promise.all([
        ctx.db.insert("thoughts", {
          userId,
          spaceId,
          content: "First synthetic target",
          embedding: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0.1),
          metadata,
          memoryStatus: "current",
        }),
        ctx.db.insert("thoughts", {
          userId: otherUserId,
          spaceId: otherSpaceId,
          content: "Out-of-manifest target",
          embedding: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0.2),
          metadata,
          memoryStatus: "current",
        }),
      ]);
      return { userId, spaceId, thoughtId, otherThoughtId };
    });

    const oldFingerprint = await fingerprintEmbeddingConfig(profile);
    const oldGeneration = await t.run((ctx) =>
      createEmbeddingGeneration(ctx, {
        spaceId: seeded.spaceId,
        profile,
        fingerprint: oldFingerprint,
        createdAt: 1,
      }),
    );
    await t.run(async (ctx) => {
      await insertThoughtEmbedding(ctx, {
        spaceId: seeded.spaceId,
        thoughtId: seeded.thoughtId,
        embeddingGenerationId: oldGeneration._id,
        fingerprint: oldFingerprint,
        inputText: "First synthetic target",
        vector: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0.1),
        bumpEligibility: false,
      });
      await stageEmbeddingGeneration(ctx, {
        embeddingGenerationId: oldGeneration._id,
        stagedAt: 2,
      });
      await activateEmbeddingGeneration(ctx, {
        embeddingGenerationId: oldGeneration._id,
        activatedAt: 3,
      });
    });

    const replacementProfile = { ...profile, modelRevision: "synthetic-v2" };
    const replacementFingerprint =
      await fingerprintEmbeddingConfig(replacementProfile);
    const created = await t.mutation(operator.createGeneration, {
      spaceId: seeded.spaceId,
      profile: replacementProfile,
      fingerprint: replacementFingerprint,
      createdAt: 4,
    });
    const manifest = await t.query(operator.getStagingManifest, {
      embeddingGenerationId: created.embeddingGenerationId,
    });
    expect(manifest.inputs).toMatchObject([
      { targetKind: "thought", thoughtId: seeded.thoughtId },
    ]);

    await expect(
      t.mutation(operator.stageVectorBatch, {
        embeddingGenerationId: created.embeddingGenerationId,
        fingerprint: "wrong-fingerprint",
        vectors: [
          {
            targetKind: "thought",
            thoughtId: seeded.thoughtId,
            vector: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0.3),
          },
        ],
      }),
    ).rejects.toThrow("fingerprint does not match");
    await expect(
      t.mutation(operator.stageVectorBatch, {
        embeddingGenerationId: created.embeddingGenerationId,
        fingerprint: replacementFingerprint,
        vectors: [
          {
            targetKind: "thought",
            thoughtId: seeded.otherThoughtId,
            vector: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0.3),
          },
        ],
      }),
    ).rejects.toThrow("outside the staged manifest");
    await expect(
      t.mutation(operator.stageVectorBatch, {
        embeddingGenerationId: created.embeddingGenerationId,
        fingerprint: replacementFingerprint,
        vectors: [
          {
            targetKind: "thought",
            thoughtId: seeded.thoughtId,
            vector: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0),
          },
        ],
      }),
    ).rejects.toThrow("must not be all zero");
    await expect(
      t.mutation(operator.stageGeneration, {
        embeddingGenerationId: created.embeddingGenerationId,
        stagedAt: 5,
      }),
    ).rejects.toThrow("missing eligible target vectors");
    await expect(
      t.mutation(operator.activateGeneration, {
        embeddingGenerationId: created.embeddingGenerationId,
        expectedPreviousGenerationId: oldGeneration._id,
        activatedAt: 6,
      }),
    ).rejects.toThrow("Only a staged embedding generation can activate");

    await t.mutation(operator.stageVectorBatch, {
      embeddingGenerationId: created.embeddingGenerationId,
      fingerprint: replacementFingerprint,
      vectors: [
        {
          targetKind: "thought",
          thoughtId: seeded.thoughtId,
          vector: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0.3),
        },
      ],
    });
    await expect(
      t.mutation(operator.stageGeneration, {
        embeddingGenerationId: created.embeddingGenerationId,
        stagedAt: 3,
      }),
    ).rejects.toThrow("staging time precedes generation creation");
    await t.mutation(operator.stageGeneration, {
      embeddingGenerationId: created.embeddingGenerationId,
      stagedAt: 7,
    });
    await expect(
      t.mutation(operator.activateGeneration, {
        embeddingGenerationId: created.embeddingGenerationId,
        expectedPreviousGenerationId: oldGeneration._id,
        activatedAt: 6,
      }),
    ).rejects.toThrow("activation time is not monotonic");
    await t.mutation(operator.activateGeneration, {
      embeddingGenerationId: created.embeddingGenerationId,
      expectedPreviousGenerationId: oldGeneration._id,
      activatedAt: 8,
    });
    const flipped = await t.run(async (ctx) => ({
      old: await ctx.db.get(oldGeneration._id),
      replacement: await ctx.db.get(created.embeddingGenerationId),
      state: await ctx.db
        .query("spaceEmbeddingStates")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .unique(),
      oldVectors: await ctx.db
        .query("embeddingVectors")
        .withIndex("by_embeddingGenerationId", (q) =>
          q.eq("embeddingGenerationId", oldGeneration._id),
        )
        .collect(),
    }));
    expect(flipped.old).toMatchObject({ state: "retired", deactivatedAt: 8 });
    expect(flipped.replacement).toMatchObject({
      state: "active",
      activatedAt: 8,
    });
    expect(flipped.state).toMatchObject({
      activeEmbeddingGenerationId: created.embeddingGenerationId,
      activeFingerprint: replacementFingerprint,
    });
    expect(flipped.oldVectors).toHaveLength(1);

    const thirdProfile = { ...profile, modelRevision: "synthetic-v3" };
    const thirdFingerprint = await fingerprintEmbeddingConfig(thirdProfile);
    const third = await t.mutation(operator.createGeneration, {
      spaceId: seeded.spaceId,
      profile: thirdProfile,
      fingerprint: thirdFingerprint,
      createdAt: 9,
    });
    await t.mutation(operator.stageVectorBatch, {
      embeddingGenerationId: third.embeddingGenerationId,
      fingerprint: thirdFingerprint,
      vectors: [
        {
          targetKind: "thought",
          thoughtId: seeded.thoughtId,
          vector: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0.4),
        },
      ],
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("thoughts", {
        userId: seeded.userId,
        spaceId: seeded.spaceId,
        content: "Eligibility changed after the staged vector batch",
        embedding: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0.5),
        metadata,
        memoryStatus: "current",
      });
      await bumpEmbeddingEligibilityEpoch(ctx, seeded.spaceId);
    });
    await expect(
      t.mutation(operator.stageGeneration, {
        embeddingGenerationId: third.embeddingGenerationId,
        stagedAt: 10,
      }),
    ).rejects.toThrow("eligibility changed");
    const afterBlockedFlip = await t.run((ctx) =>
      ctx.db
        .query("spaceEmbeddingStates")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .unique(),
    );
    expect(afterBlockedFlip?.activeEmbeddingGenerationId).toBe(
      created.embeddingGenerationId,
    );
  });
});
