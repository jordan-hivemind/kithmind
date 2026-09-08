import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

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
  deleteThoughtEmbeddingVectors,
  deriveEmbeddingManifest,
  embeddingVectorSearchScope,
  getActiveEmbeddingTarget,
  insertThoughtEmbedding,
  stageEmbeddingGeneration,
} from "./model";

const baselineProfile: EmbeddingProfile = {
  protocol: "openai-embeddings-v1",
  providerId: "openai",
  model: "text-embedding-3-small",
  modelRevision: "legacy-openai-small-1536-v1",
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

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Synthetic owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Synthetic personal",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const thoughtId = await ctx.db.insert("thoughts", {
      userId,
      spaceId,
      content: "The stable synthetic memory",
      embedding: Array.from(
        { length: BASELINE_EMBEDDING_DIMENSIONS },
        (_, index) => index / BASELINE_EMBEDDING_DIMENSIONS,
      ),
      metadata,
      memoryStatus: "current",
    });
    return { userId, spaceId, thoughtId };
  });
  return { t, ...ids };
}

describe("embedding generations", () => {
  test("fails closed when one thought and 256 active chunks exceed the bounded manifest", async () => {
    const seeded = await seed();
    await seeded.t.run(async (ctx) => {
      const sourceAccountId = await ctx.db.insert("sourceAccounts", {
        spaceId: seeded.spaceId,
        connector: "synthetic",
        accountId: "large-pdf",
        name: "Synthetic source",
        enabled: true,
        cursorVersion: 0,
        freshnessMs: 60_000,
        createdBy: seeded.userId,
      });
      const sourceItemId = await ctx.db.insert("sourceItems", {
        spaceId: seeded.spaceId,
        sourceAccountId,
        externalIdHash: "large-pdf-hash",
        externalId: "large-pdf",
        lifecycle: "available",
        originalLinkAvailable: false,
        desiredProcessingEpoch: 1,
      });
      const sourceRevisionId = await ctx.db.insert("sourceRevisions", {
        spaceId: seeded.spaceId,
        sourceItemId,
        contentHash: "content-hash",
        byteLength: 1,
        mediaType: "text/plain",
        inlineText: "x",
        capturedAt: 1,
        userId: seeded.userId,
      });
      const sourceTextVersionId = await ctx.db.insert("sourceTextVersions", {
        spaceId: seeded.spaceId,
        sourceRevisionId,
        extractionFingerprint: "extract-v1",
        text: "x",
        textHash: "text-hash",
        byteLength: 1,
        evidenceSealed: true,
      });
      const processingGenerationId = await ctx.db.insert(
        "processingGenerations",
        {
          spaceId: seeded.spaceId,
          sourceAccountId,
          sourceItemId,
          sourceRevisionId,
          sourceTextVersionId,
          processingFingerprint: "processing-v1",
          extractionFingerprint: "extract-v1",
          extractorFingerprint: "extractor-v1",
          recordSchemaFingerprint: "schema-v1",
          normalizationFingerprint: "normalization-v1",
          chunkerFingerprint: "chunker-v1",
          correctionRevision: "0",
          desiredProcessingEpoch: 1,
          state: "ready",
          expectedPageCount: 1,
          expectedEvidenceSpanCount: 0,
          expectedDocumentCount: 1,
          expectedChunkCount: 256,
          actualPageCount: 1,
          actualEvidenceSpanCount: 0,
          actualDocumentCount: 1,
          actualChunkCount: 256,
          embeddingStatus: "unavailable",
          activatedAt: 2,
        },
      );
      const documentId = await ctx.db.insert("documents", {
        spaceId: seeded.spaceId,
        processingGenerationId,
        sourceItemId,
        sourceRevisionId,
        sourceTextVersionId,
        documentKey: "main",
        title: "Synthetic large PDF",
        docType: "pdf",
        capturedAt: 1,
        evidenceSpanIds: [],
        publicationState: "active",
      });
      for (let ordinal = 0; ordinal < 256; ordinal += 1) {
        await ctx.db.insert("chunks", {
          spaceId: seeded.spaceId,
          processingGenerationId,
          documentId,
          ordinal,
          text: "x",
          evidenceSpanIds: [],
          publicationState: "active",
        });
      }
      await ctx.db.patch(sourceItemId, {
        desiredRevisionId: sourceRevisionId,
        activeRevisionId: sourceRevisionId,
        activeGenerationId: processingGenerationId,
      });
    });
    await expect(
      seeded.t.run((ctx) => deriveEmbeddingManifest(ctx, seeded.spaceId)),
    ).rejects.toThrow("global row budget");
  });

  test("copies an existing vector into a staged generation and activates atomically", async () => {
    const seeded = await seed();
    const fingerprint = await fingerprintEmbeddingConfig(baselineProfile);
    const generation = await seeded.t.run((ctx) =>
      createEmbeddingGeneration(ctx, {
        spaceId: seeded.spaceId,
        profile: baselineProfile,
        fingerprint,
        createdAt: 1,
      }),
    );
    const original = await seeded.t.run((ctx) => ctx.db.get(seeded.thoughtId));
    await seeded.t.run((ctx) =>
      insertThoughtEmbedding(ctx, {
        spaceId: seeded.spaceId,
        thoughtId: seeded.thoughtId,
        embeddingGenerationId: generation._id,
        fingerprint,
        inputText: original!.content,
        vector: original!.embedding,
        bumpEligibility: false,
      }),
    );
    await seeded.t.run((ctx) =>
      stageEmbeddingGeneration(ctx, {
        embeddingGenerationId: generation._id,
        stagedAt: 2,
      }),
    );
    await seeded.t.run((ctx) =>
      activateEmbeddingGeneration(ctx, {
        embeddingGenerationId: generation._id,
        activatedAt: 3,
      }),
    );

    const result = await seeded.t.run(async (ctx) => ({
      active: await getActiveEmbeddingTarget(ctx, seeded.spaceId),
      original: await ctx.db.get(seeded.thoughtId),
      vectors: await ctx.db.query("embeddingVectors").collect(),
    }));
    expect(result.active).toMatchObject({
      embeddingGenerationId: generation._id,
      fingerprint,
      thoughtStatus: "ready",
      chunkStatus: "ready",
    });
    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0]).toMatchObject({
      thoughtId: seeded.thoughtId,
      embeddingFingerprint: fingerprint,
      searchScope: embeddingVectorSearchScope({
        spaceId: seeded.spaceId,
        fingerprint,
        embeddingGenerationId: generation._id,
        targetKind: "thought",
      }),
    });
    expect(result.vectors[0]!.embedding).toEqual(result.original!.embedding);
  });

  test("keeps the prior generation active when a replacement is incomplete", async () => {
    const seeded = await seed();
    const baselineFingerprint =
      await fingerprintEmbeddingConfig(baselineProfile);
    const baseline = await seeded.t.run((ctx) =>
      createEmbeddingGeneration(ctx, {
        spaceId: seeded.spaceId,
        profile: baselineProfile,
        fingerprint: baselineFingerprint,
        createdAt: 1,
      }),
    );
    const thought = await seeded.t.run((ctx) => ctx.db.get(seeded.thoughtId));
    await seeded.t.run(async (ctx) => {
      await insertThoughtEmbedding(ctx, {
        spaceId: seeded.spaceId,
        thoughtId: seeded.thoughtId,
        embeddingGenerationId: baseline._id,
        fingerprint: baselineFingerprint,
        inputText: thought!.content,
        vector: thought!.embedding,
        bumpEligibility: false,
      });
      await stageEmbeddingGeneration(ctx, {
        embeddingGenerationId: baseline._id,
        stagedAt: 2,
      });
      await activateEmbeddingGeneration(ctx, {
        embeddingGenerationId: baseline._id,
        activatedAt: 3,
      });
    });

    const replacementProfile = {
      ...baselineProfile,
      modelRevision: "synthetic-declared-revision-v2",
    };
    const replacementFingerprint =
      await fingerprintEmbeddingConfig(replacementProfile);
    const replacement = await seeded.t.run((ctx) =>
      createEmbeddingGeneration(ctx, {
        spaceId: seeded.spaceId,
        profile: replacementProfile,
        fingerprint: replacementFingerprint,
        createdAt: 4,
      }),
    );
    await expect(
      seeded.t.run((ctx) =>
        stageEmbeddingGeneration(ctx, {
          embeddingGenerationId: replacement._id,
          stagedAt: 5,
        }),
      ),
    ).rejects.toThrow("missing eligible target vectors");
    expect(
      await seeded.t.run((ctx) =>
        getActiveEmbeddingTarget(ctx, seeded.spaceId),
      ),
    ).toMatchObject({ embeddingGenerationId: baseline._id });
  });

  test("invalidates staging on an eligibility change and makes missing active coverage unavailable", async () => {
    const seeded = await seed();
    const fingerprint = await fingerprintEmbeddingConfig(baselineProfile);
    const baseline = await seeded.t.run((ctx) =>
      createEmbeddingGeneration(ctx, {
        spaceId: seeded.spaceId,
        profile: baselineProfile,
        fingerprint,
        createdAt: 1,
      }),
    );
    const thought = await seeded.t.run((ctx) => ctx.db.get(seeded.thoughtId));
    await seeded.t.run(async (ctx) => {
      await insertThoughtEmbedding(ctx, {
        spaceId: seeded.spaceId,
        thoughtId: seeded.thoughtId,
        embeddingGenerationId: baseline._id,
        fingerprint,
        inputText: thought!.content,
        vector: thought!.embedding,
        bumpEligibility: false,
      });
      await stageEmbeddingGeneration(ctx, {
        embeddingGenerationId: baseline._id,
        stagedAt: 2,
      });
      await activateEmbeddingGeneration(ctx, {
        embeddingGenerationId: baseline._id,
        activatedAt: 3,
      });
    });
    const replacementProfile = {
      ...baselineProfile,
      modelRevision: "synthetic-declared-revision-v2",
    };
    const replacementFingerprint =
      await fingerprintEmbeddingConfig(replacementProfile);
    const replacement = await seeded.t.run((ctx) =>
      createEmbeddingGeneration(ctx, {
        spaceId: seeded.spaceId,
        profile: replacementProfile,
        fingerprint: replacementFingerprint,
        createdAt: 4,
      }),
    );

    await seeded.t.run(async (ctx) => {
      await ctx.db.insert("thoughts", {
        userId: seeded.userId,
        spaceId: seeded.spaceId,
        content: "A new unembedded synthetic memory",
        embedding: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0.5),
        metadata,
        memoryStatus: "current",
      });
      await bumpEmbeddingEligibilityEpoch(ctx, seeded.spaceId);
    });
    await expect(
      seeded.t.run((ctx) =>
        stageEmbeddingGeneration(ctx, {
          embeddingGenerationId: replacement._id,
          stagedAt: 5,
        }),
      ),
    ).rejects.toThrow("eligibility changed");
    expect(
      await seeded.t.run((ctx) =>
        getActiveEmbeddingTarget(ctx, seeded.spaceId),
      ),
    ).toMatchObject({
      embeddingGenerationId: baseline._id,
      thoughtStatus: "unavailable",
    });
  });

  test("deletes vector history in bounded resumable batches", async () => {
    const seeded = await seed();
    await seeded.t.run(async (ctx) => {
      for (let index = 0; index < 30; index += 1) {
        const generationId = await ctx.db.insert("embeddingGenerations", {
          spaceId: seeded.spaceId,
          embeddingProfileId: await ctx.db.insert("embeddingProfiles", {
            fingerprint: `synthetic-${index}`,
            ...baselineProfile,
            modelRevision: `synthetic-${index}`,
            createdAt: index,
          }),
          fingerprint: `synthetic-${index}`,
          state: "retired",
          eligibilityEpoch: 0,
          manifestHash: `manifest-${index}`,
          expectedThoughtCount: 1,
          expectedChunkCount: 0,
          completedThoughtCount: 1,
          completedChunkCount: 0,
          createdAt: index,
        });
        await ctx.db.insert("embeddingVectors", {
          spaceId: seeded.spaceId,
          embeddingGenerationId: generationId,
          embeddingFingerprint: `synthetic-${index}`,
          targetKind: "thought",
          thoughtId: seeded.thoughtId,
          searchScope: `synthetic-scope-${index}`,
          inputHash: `synthetic-input-${index}`,
          embedding: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(index),
        });
      }
    });
    expect(
      await seeded.t.run((ctx) =>
        deleteThoughtEmbeddingVectors(ctx, {
          spaceId: seeded.spaceId,
          thoughtId: seeded.thoughtId,
        }),
      ),
    ).toEqual({ deleted: 25, done: false });
    expect(
      await seeded.t.run((ctx) =>
        deleteThoughtEmbeddingVectors(ctx, {
          spaceId: seeded.spaceId,
          thoughtId: seeded.thoughtId,
        }),
      ),
    ).toEqual({ deleted: 5, done: true });
  });
});
