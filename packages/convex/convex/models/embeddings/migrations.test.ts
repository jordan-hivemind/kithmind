import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../_generated/api";
import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  BASELINE_EMBEDDING_DIMENSIONS,
  fingerprintEmbeddingConfig,
} from "../../lib/embeddingProvider";
import {
  bumpEmbeddingEligibilityEpoch,
  getActiveEmbeddingTarget,
  insertChunkEmbedding,
} from "./model";
import { BASELINE_EMBEDDING_PROFILE } from "./migrations";

const metadata = {
  type: "reference" as const,
  topics: [],
  people: [],
  actionItems: [],
  summary: "Synthetic memory",
};

async function seedThought() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Synthetic owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Synthetic personal",
      createdBy: userId,
    });
    const thoughtId = await ctx.db.insert("thoughts", {
      userId,
      spaceId,
      content: "A legacy vector must not change",
      embedding: Array.from(
        { length: BASELINE_EMBEDDING_DIMENSIONS },
        (_, index) => index / 10_000,
      ),
      metadata,
      memoryStatus: "current",
    });
    return { userId, spaceId, thoughtId };
  });
  return { t, ...ids };
}

async function seedActiveChunk(
  seeded: Awaited<ReturnType<typeof seedThought>>,
) {
  return await seeded.t.run(async (ctx) => {
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId: seeded.spaceId,
      connector: "synthetic",
      accountId: "baseline-block",
      name: "Synthetic source",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: seeded.userId,
    });
    const sourceItemId = await ctx.db.insert("sourceItems", {
      spaceId: seeded.spaceId,
      sourceAccountId,
      externalIdHash: "external-hash",
      externalId: "external-id",
      lifecycle: "available",
      originalLinkAvailable: false,
      desiredProcessingEpoch: 1,
    });
    const sourceRevisionId = await ctx.db.insert("sourceRevisions", {
      spaceId: seeded.spaceId,
      sourceItemId,
      contentHash: "content-hash",
      byteLength: 12,
      mediaType: "text/plain",
      inlineText: "chunk source",
      capturedAt: 1,
      userId: seeded.userId,
    });
    const sourceTextVersionId = await ctx.db.insert("sourceTextVersions", {
      spaceId: seeded.spaceId,
      sourceRevisionId,
      extractionFingerprint: "extract-v1",
      text: "chunk source",
      textHash: "text-hash",
      byteLength: 12,
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
        expectedChunkCount: 1,
        actualPageCount: 1,
        actualEvidenceSpanCount: 0,
        actualDocumentCount: 1,
        actualChunkCount: 1,
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
      title: "Synthetic document",
      docType: "note",
      capturedAt: 1,
      evidenceSpanIds: [],
      publicationState: "active",
    });
    const chunkId = await ctx.db.insert("chunks", {
      spaceId: seeded.spaceId,
      processingGenerationId,
      documentId,
      ordinal: 0,
      text: "chunk source",
      evidenceSpanIds: [],
      publicationState: "active",
    });
    await ctx.db.patch(sourceItemId, {
      desiredRevisionId: sourceRevisionId,
      activeRevisionId: sourceRevisionId,
      activeGenerationId: processingGenerationId,
    });
    return { processingGenerationId, chunkId };
  });
}

describe("baseline embedding migration", () => {
  test("dry-runs, copies exact vectors idempotently, activates, and audits equality", async () => {
    const seeded = await seedThought();
    const dryPrepare = await seeded.t.mutation(
      internal.models.embeddings.migrations.prepareBaselineGeneration,
      { spaceId: seeded.spaceId, dryRun: true, now: 1 },
    );
    expect(dryPrepare).toMatchObject({
      dryRun: true,
      blocked: false,
      eligibleThoughtCount: 1,
      eligibleChunkCount: 0,
      reused: false,
    });
    expect(
      await seeded.t.run((ctx) =>
        ctx.db.query("embeddingGenerations").collect(),
      ),
    ).toHaveLength(0);

    const prepared = await seeded.t.mutation(
      internal.models.embeddings.migrations.prepareBaselineGeneration,
      { spaceId: seeded.spaceId, now: 1 },
    );
    const embeddingGenerationId = prepared.embeddingGenerationId!;
    const dryCopy = await seeded.t.mutation(
      internal.models.embeddings.migrations.backfillBaselineThoughtVectors,
      {
        spaceId: seeded.spaceId,
        embeddingGenerationId,
        dryRun: true,
      },
    );
    expect(dryCopy).toMatchObject({
      scanned: 1,
      eligible: 1,
      needingBackfill: 1,
      copied: 0,
      invalid: 0,
      isDone: true,
    });
    const copied = await seeded.t.mutation(
      internal.models.embeddings.migrations.backfillBaselineThoughtVectors,
      { spaceId: seeded.spaceId, embeddingGenerationId },
    );
    expect(copied).toMatchObject({ copied: 1, invalid: 0 });
    const rerun = await seeded.t.mutation(
      internal.models.embeddings.migrations.backfillBaselineThoughtVectors,
      { spaceId: seeded.spaceId, embeddingGenerationId },
    );
    expect(rerun).toMatchObject({ copied: 0, needingBackfill: 0, invalid: 0 });

    await seeded.t.mutation(
      internal.models.embeddings.migrations.stageBaselineGeneration,
      { embeddingGenerationId, stagedAt: 2 },
    );
    await seeded.t.mutation(
      internal.models.embeddings.migrations.activateBaselineGeneration,
      { embeddingGenerationId, activatedAt: 3 },
    );
    const audit = await seeded.t.mutation(
      internal.models.embeddings.migrations.auditBaselineGeneration,
      { spaceId: seeded.spaceId, embeddingGenerationId },
    );
    expect(audit).toMatchObject({
      state: "active",
      active: true,
      fingerprintMatches: true,
      epochMatches: true,
      manifestMatches: true,
      expectedThoughtCount: 1,
      expectedChunkCount: 0,
      vectorThoughtCount: 1,
      vectorChunkCount: 0,
      missingTargets: 0,
      extraTargets: 0,
      duplicateTargets: 0,
      mismatchedTargets: 0,
      invalidVectors: 0,
    });

    await seeded.t.run((ctx) =>
      ctx.db.patch(seeded.thoughtId, {
        embedding: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0.75),
      }),
    );
    expect(
      await seeded.t.mutation(
        internal.models.embeddings.migrations.auditBaselineGeneration,
        { spaceId: seeded.spaceId, embeddingGenerationId },
      ),
    ).toMatchObject({ manifestMatches: false, mismatchedTargets: 1 });
  });

  test("refuses to claim complete baseline coverage for active chunks without legacy vectors", async () => {
    const seeded = await seedThought();
    const { processingGenerationId } = await seedActiveChunk(seeded);

    const result = await seeded.t.mutation(
      internal.models.embeddings.migrations.prepareBaselineGeneration,
      { spaceId: seeded.spaceId, now: 1 },
    );
    expect(result).toMatchObject({
      blocked: true,
      eligibleThoughtCount: 1,
      eligibleChunkCount: 1,
      reused: false,
    });
    expect(result.reason).toContain("rebuild");
    expect(
      await seeded.t.run((ctx) =>
        ctx.db.query("embeddingGenerations").collect(),
      ),
    ).toHaveLength(0);

    await seeded.t.run(async (ctx) => {
      const mismatchedAccountId = await ctx.db.insert("sourceAccounts", {
        spaceId: seeded.spaceId,
        connector: "synthetic",
        accountId: "mismatched-parent",
        name: "Mismatched source",
        enabled: true,
        cursorVersion: 0,
        freshnessMs: 60_000,
        createdBy: seeded.userId,
      });
      await ctx.db.patch(processingGenerationId, {
        sourceAccountId: mismatchedAccountId,
      });
    });
    await expect(
      seeded.t.mutation(
        internal.models.embeddings.migrations.prepareBaselineGeneration,
        { spaceId: seeded.spaceId, now: 2 },
      ),
    ).rejects.toThrow("invalid processing parent chain");
  });

  test("reconciles active chunk coverage when its canonical vector arrives", async () => {
    const seeded = await seedThought();
    const prepared = await seeded.t.mutation(
      internal.models.embeddings.migrations.prepareBaselineGeneration,
      { spaceId: seeded.spaceId, now: 1 },
    );
    const embeddingGenerationId = prepared.embeddingGenerationId!;
    await seeded.t.mutation(
      internal.models.embeddings.migrations.backfillBaselineThoughtVectors,
      { spaceId: seeded.spaceId, embeddingGenerationId },
    );
    await seeded.t.mutation(
      internal.models.embeddings.migrations.stageBaselineGeneration,
      { embeddingGenerationId, stagedAt: 2 },
    );
    await seeded.t.mutation(
      internal.models.embeddings.migrations.activateBaselineGeneration,
      { embeddingGenerationId, activatedAt: 3 },
    );
    const { chunkId } = await seedActiveChunk(seeded);

    const result = await seeded.t.run(async (ctx) => {
      await bumpEmbeddingEligibilityEpoch(ctx, seeded.spaceId);
      const pending = await getActiveEmbeddingTarget(ctx, seeded.spaceId);
      const generation = await ctx.db.get(embeddingGenerationId);
      const vectorId = await insertChunkEmbedding(ctx, {
        spaceId: seeded.spaceId,
        chunkId,
        embeddingGenerationId,
        fingerprint: generation!.fingerprint,
        inputText: "chunk source",
        vector: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0.25),
      });
      const ready = await getActiveEmbeddingTarget(ctx, seeded.spaceId);
      const stateAfterInsert = await ctx.db
        .query("spaceEmbeddingStates")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .unique();
      const reusedVectorId = await insertChunkEmbedding(ctx, {
        spaceId: seeded.spaceId,
        chunkId,
        embeddingGenerationId,
        fingerprint: generation!.fingerprint,
        inputText: "chunk source",
        vector: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0.25),
      });
      const stateAfterRetry = await ctx.db
        .query("spaceEmbeddingStates")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .unique();
      return {
        pending,
        ready,
        vectorId,
        reusedVectorId,
        epochAfterInsert: stateAfterInsert!.eligibilityEpoch,
        epochAfterRetry: stateAfterRetry!.eligibilityEpoch,
      };
    });
    expect(result.pending?.chunkStatus).toBe("unavailable");
    expect(result.ready?.chunkStatus).toBe("ready");
    expect(result.reusedVectorId).toBe(result.vectorId);
    expect(result.epochAfterRetry).toBe(result.epochAfterInsert);
  });

  test("reports an all-zero legacy placeholder as invalid instead of activating it", async () => {
    const seeded = await seedThought();
    await seeded.t.run((ctx) =>
      ctx.db.patch(seeded.thoughtId, {
        embedding: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0),
      }),
    );
    const prepared = await seeded.t.mutation(
      internal.models.embeddings.migrations.prepareBaselineGeneration,
      { spaceId: seeded.spaceId, now: 1 },
    );
    const result = await seeded.t.mutation(
      internal.models.embeddings.migrations.backfillBaselineThoughtVectors,
      {
        spaceId: seeded.spaceId,
        embeddingGenerationId: prepared.embeddingGenerationId!,
        dryRun: true,
      },
    );
    expect(result).toMatchObject({
      eligible: 1,
      needingBackfill: 0,
      copied: 0,
      invalid: 1,
    });
  });

  test("refuses legacy copying after a non-baseline profile even after switching back", async () => {
    const seeded = await seedThought();
    const baselineFingerprint = await fingerprintEmbeddingConfig(
      BASELINE_EMBEDDING_PROFILE,
    );
    const largeProfile = {
      ...BASELINE_EMBEDDING_PROFILE,
      model: "text-embedding-3-large",
      modelRevision: "synthetic-large-1536-v1",
    };
    const largeFingerprint = await fingerprintEmbeddingConfig(largeProfile);
    const stagingBaselineGenerationId = await seeded.t.run(async (ctx) => {
      const baselineProfileId = await ctx.db.insert("embeddingProfiles", {
        ...BASELINE_EMBEDDING_PROFILE,
        fingerprint: baselineFingerprint,
        createdAt: 1,
      });
      const largeProfileId = await ctx.db.insert("embeddingProfiles", {
        ...largeProfile,
        fingerprint: largeFingerprint,
        createdAt: 2,
      });
      await ctx.db.insert("embeddingGenerations", {
        spaceId: seeded.spaceId,
        embeddingProfileId: largeProfileId,
        fingerprint: largeFingerprint,
        state: "retired",
        eligibilityEpoch: 0,
        manifestHash: "large-manifest",
        expectedThoughtCount: 1,
        expectedChunkCount: 0,
        completedThoughtCount: 1,
        completedChunkCount: 0,
        createdAt: 2,
        stagedAt: 3,
        activatedAt: 4,
        deactivatedAt: 5,
      });
      const activeBaselineGenerationId = await ctx.db.insert(
        "embeddingGenerations",
        {
          spaceId: seeded.spaceId,
          embeddingProfileId: baselineProfileId,
          fingerprint: baselineFingerprint,
          state: "active",
          eligibilityEpoch: 0,
          manifestHash: "active-baseline-manifest",
          expectedThoughtCount: 1,
          expectedChunkCount: 0,
          completedThoughtCount: 1,
          completedChunkCount: 0,
          createdAt: 5,
          stagedAt: 6,
          activatedAt: 7,
        },
      );
      const stagingId = await ctx.db.insert("embeddingGenerations", {
        spaceId: seeded.spaceId,
        embeddingProfileId: baselineProfileId,
        fingerprint: baselineFingerprint,
        state: "staging",
        eligibilityEpoch: 0,
        manifestHash: "staging-baseline-manifest",
        expectedThoughtCount: 1,
        expectedChunkCount: 0,
        completedThoughtCount: 0,
        completedChunkCount: 0,
        createdAt: 8,
      });
      await ctx.db.insert("spaceEmbeddingStates", {
        spaceId: seeded.spaceId,
        eligibilityEpoch: 0,
        activeEmbeddingGenerationId: activeBaselineGenerationId,
        activeFingerprint: baselineFingerprint,
        activatedAt: 7,
      });
      return stagingId;
    });

    const prepared = await seeded.t.mutation(
      internal.models.embeddings.migrations.prepareBaselineGeneration,
      { spaceId: seeded.spaceId, dryRun: true, now: 9 },
    );
    expect(prepared).toMatchObject({
      dryRun: true,
      blocked: true,
      eligibleThoughtCount: 1,
      eligibleChunkCount: 0,
      reused: false,
    });
    expect(prepared.reason).toContain("non-baseline profile");

    await expect(
      seeded.t.mutation(
        internal.models.embeddings.migrations.backfillBaselineThoughtVectors,
        {
          spaceId: seeded.spaceId,
          embeddingGenerationId: stagingBaselineGenerationId,
        },
      ),
    ).rejects.toThrow("non-baseline profile");
    expect(
      await seeded.t.run((ctx) =>
        ctx.db
          .query("embeddingVectors")
          .withIndex("by_embeddingGenerationId", (q) =>
            q.eq("embeddingGenerationId", stagingBaselineGenerationId),
          )
          .collect(),
      ),
    ).toHaveLength(0);
  });

  test("fails closed when generation history exceeds the provenance bound", async () => {
    const seeded = await seedThought();
    const baselineFingerprint = await fingerprintEmbeddingConfig(
      BASELINE_EMBEDDING_PROFILE,
    );
    const largeProfile = {
      ...BASELINE_EMBEDDING_PROFILE,
      model: "text-embedding-3-large",
      modelRevision: "synthetic-large-1536-v1",
    };
    const largeFingerprint = await fingerprintEmbeddingConfig(largeProfile);
    await seeded.t.run(async (ctx) => {
      const baselineProfileId = await ctx.db.insert("embeddingProfiles", {
        ...BASELINE_EMBEDDING_PROFILE,
        fingerprint: baselineFingerprint,
        createdAt: 1,
      });
      const largeProfileId = await ctx.db.insert("embeddingProfiles", {
        ...largeProfile,
        fingerprint: largeFingerprint,
        createdAt: 2,
      });
      for (let index = 0; index < 256; index += 1) {
        await ctx.db.insert("embeddingGenerations", {
          spaceId: seeded.spaceId,
          embeddingProfileId: baselineProfileId,
          fingerprint: baselineFingerprint,
          state: "failed",
          eligibilityEpoch: 0,
          manifestHash: `baseline-${index}`,
          expectedThoughtCount: 1,
          expectedChunkCount: 0,
          completedThoughtCount: 0,
          completedChunkCount: 0,
          createdAt: index + 1,
        });
      }
      await ctx.db.insert("embeddingGenerations", {
        spaceId: seeded.spaceId,
        embeddingProfileId: largeProfileId,
        fingerprint: largeFingerprint,
        state: "failed",
        eligibilityEpoch: 0,
        manifestHash: "non-baseline-after-bound",
        expectedThoughtCount: 1,
        expectedChunkCount: 0,
        completedThoughtCount: 0,
        completedChunkCount: 0,
        createdAt: 257,
      });
    });

    const prepared = await seeded.t.mutation(
      internal.models.embeddings.migrations.prepareBaselineGeneration,
      { spaceId: seeded.spaceId, dryRun: true, now: 258 },
    );
    expect(prepared).toMatchObject({
      dryRun: true,
      blocked: true,
      eligibleThoughtCount: 1,
      eligibleChunkCount: 0,
      reused: false,
    });
    expect(prepared.reason).toContain("safety bound");
  });
});
