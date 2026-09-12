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
  deleteActiveThoughtEmbeddingVectors,
  deleteThoughtEmbeddingVectors,
  deriveEmbeddingManifest,
  embeddingVectorSearchScope,
  getActiveEmbeddingTarget,
  insertThoughtEmbedding,
  markEligibilityTargets,
  resolveAuthorizedThoughtVectorCandidates,
  stageEmbeddingGeneration,
} from "./model";
import { embeddingVectorScopeV2 } from "./targets";
import { sha256Hex } from "../ingestion/hash";
import type { Doc, Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";

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
    expect(result.active?.chunkCoverage).toEqual({ eligible: 0, covered: 0 });
    expect(result.active).toMatchObject({
      embeddingGenerationId: generation._id,
      fingerprint,
      thoughtStatus: "ready",
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
      const addedId = await ctx.db.insert("thoughts", {
        userId: seeded.userId,
        spaceId: seeded.spaceId,
        content: "A new unembedded synthetic memory",
        embedding: Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0.5),
        metadata,
        memoryStatus: "current",
      });
      // P2-6c: an eligibility write names the targets it touched. The
      // whole-space derive that used to find them is gone.
      await bumpEmbeddingEligibilityEpoch(ctx, seeded.spaceId, {
        thoughtIds: [addedId],
      });
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

/**
 * P2-6d reader cutover. The reader filters on `scopeV2`, which carries no
 * generation identity, so every guarantee that used to come from the filter
 * value now has to come from an invariant: I2 in the filter, I11 at the write
 * and I7 at hydration. These tests exercise the three of them directly.
 */
describe("reader cutover", () => {
  const otherProfile: EmbeddingProfile = {
    ...baselineProfile,
    modelRevision: "synthetic-second-profile-v1",
  };

  /** Brings a seeded space to an active generation with one covered thought. */
  async function activateWithThoughtVector(
    seeded: Awaited<ReturnType<typeof seed>>,
  ) {
    const fingerprint = await fingerprintEmbeddingConfig(baselineProfile);
    const generation = await seeded.t.run((ctx) =>
      createEmbeddingGeneration(ctx, {
        spaceId: seeded.spaceId,
        profile: baselineProfile,
        fingerprint,
        createdAt: 1,
      }),
    );
    const vectorId = await seeded.t.run(async (ctx) => {
      const thought = (await ctx.db.get(seeded.thoughtId))!;
      const id = await insertThoughtEmbedding(ctx, {
        spaceId: seeded.spaceId,
        thoughtId: seeded.thoughtId,
        embeddingGenerationId: generation._id,
        fingerprint,
        inputText: thought.content,
        vector: thought.embedding,
        bumpEligibility: false,
      });
      await stageEmbeddingGeneration(ctx, {
        embeddingGenerationId: generation._id,
        stagedAt: 2,
      });
      await activateEmbeddingGeneration(ctx, {
        embeddingGenerationId: generation._id,
        activatedAt: 3,
      });
      return id;
    });
    return { fingerprint, generationId: generation._id, vectorId };
  }

  /** A vector row written straight to the table, as a second profile leaves. */
  async function insertRawVector(
    seeded: Awaited<ReturnType<typeof seed>>,
    input: {
      fingerprint: string;
      inputHash: string;
      profile: EmbeddingProfile;
    },
  ) {
    return await seeded.t.run(async (ctx) => {
      const existing = await ctx.db
        .query("embeddingProfiles")
        .withIndex("by_fingerprint", (q) =>
          q.eq("fingerprint", input.fingerprint),
        )
        .unique();
      const profileId =
        existing?._id ??
        (await ctx.db.insert("embeddingProfiles", {
          fingerprint: input.fingerprint,
          ...input.profile,
          createdAt: 1,
        }));
      const generationId = await ctx.db.insert("embeddingGenerations", {
        spaceId: seeded.spaceId,
        embeddingProfileId: profileId,
        fingerprint: input.fingerprint,
        state: "staged" as const,
        eligibilityEpoch: 0,
        manifestHash: "synthetic",
        expectedThoughtCount: 1,
        expectedChunkCount: 0,
        completedThoughtCount: 1,
        completedChunkCount: 0,
        createdAt: 4,
        stagedAt: 5,
      });
      const thought = (await ctx.db.get(seeded.thoughtId))!;
      const vectorId = await ctx.db.insert("embeddingVectors", {
        spaceId: seeded.spaceId,
        embeddingGenerationId: generationId,
        embeddingFingerprint: input.fingerprint,
        targetKind: "thought" as const,
        searchScope: embeddingVectorSearchScope({
          spaceId: seeded.spaceId,
          fingerprint: input.fingerprint,
          embeddingGenerationId: generationId,
          targetKind: "thought",
        }),
        scopeV2: embeddingVectorScopeV2({
          spaceId: seeded.spaceId,
          fingerprint: input.fingerprint,
          targetKind: "thought",
        }),
        thoughtId: seeded.thoughtId,
        inputHash: input.inputHash,
        embedding: thought.embedding,
      });
      return { generationId, vectorId };
    });
  }

  async function hydrate(
    seeded: Awaited<ReturnType<typeof seed>>,
    fingerprint: string,
    ids: Id<"embeddingVectors">[],
  ) {
    return await seeded.t.run((ctx) =>
      resolveAuthorizedThoughtVectorCandidates(ctx, {
        principal: { userId: seeded.userId },
        targets: [{ spaceId: seeded.spaceId, fingerprint }],
        embeddingVectorIds: ids,
      }),
    );
  }

  async function spaceState(seeded: Awaited<ReturnType<typeof seed>>) {
    return (await seeded.t.run((ctx) =>
      ctx.db
        .query("spaceEmbeddingStates")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .unique(),
    )) as Doc<"spaceEmbeddingStates">;
  }

  test("returns only the active fingerprint and one candidate per target", async () => {
    const seeded = await seed();
    const active = await activateWithThoughtVector(seeded);
    const content = (await seeded.t.run((ctx) => ctx.db.get(seeded.thoughtId)))!
      .content;
    const inputHash = await sha256Hex(content);
    const otherFingerprint = await fingerprintEmbeddingConfig(otherProfile);
    // A real staged generation under a second profile, written through the
    // same insert path the transition driver uses.
    const staged = await seeded.t.run((ctx) =>
      createEmbeddingGeneration(ctx, {
        spaceId: seeded.spaceId,
        profile: otherProfile,
        fingerprint: otherFingerprint,
        createdAt: 4,
      }),
    );
    const secondVectorId = await seeded.t.run(async (ctx) => {
      const thought = (await ctx.db.get(seeded.thoughtId))!;
      return await insertThoughtEmbedding(ctx, {
        spaceId: seeded.spaceId,
        thoughtId: seeded.thoughtId,
        embeddingGenerationId: staged._id,
        fingerprint: otherFingerprint,
        inputText: thought.content,
        vector: thought.embedding,
        bumpEligibility: false,
      });
    });
    // A second row under the *active* fingerprint is what I11 forbids; the
    // per-request dedupe is the reader's backstop if one ever exists anyway.
    const duplicate = await insertRawVector(seeded, {
      fingerprint: active.fingerprint,
      inputHash,
      profile: baselineProfile,
    });

    // Staging a second profile must not take the coverage marker from the
    // live index: section 3.4 point 2.
    expect(
      await seeded.t.run((ctx) =>
        getActiveEmbeddingTarget(ctx, seeded.spaceId),
      ),
    ).toMatchObject({ thoughtStatus: "ready" });

    const resolved = await hydrate(seeded, active.fingerprint, [
      secondVectorId,
      duplicate.vectorId,
      active.vectorId,
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.embeddingVectorId).toBe(duplicate.vectorId);
    expect(await hydrate(seeded, active.fingerprint, [secondVectorId])).toEqual(
      [],
    );
  });

  test("drops every stale row when the active fingerprint flips", async () => {
    const seeded = await seed();
    const active = await activateWithThoughtVector(seeded);
    const content = (await seeded.t.run((ctx) => ctx.db.get(seeded.thoughtId)))!
      .content;
    const inputHash = await sha256Hex(content);
    const nextFingerprint = await fingerprintEmbeddingConfig(otherProfile);
    const next = await insertRawVector(seeded, {
      fingerprint: nextFingerprint,
      inputHash,
      profile: otherProfile,
    });

    // The flip a completed build under the new fingerprint would commit.
    await seeded.t.run(async (ctx) => {
      const state = await ctx.db
        .query("spaceEmbeddingStates")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .unique();
      await ctx.db.patch(next.generationId, {
        state: "active",
        activatedAt: 6,
      });
      await ctx.db.patch(active.generationId, {
        state: "retired",
        deactivatedAt: 6,
      });
      await ctx.db.patch(state!._id, {
        activeEmbeddingGenerationId: next.generationId,
        activeFingerprint: nextFingerprint,
        activatedAt: 6,
        coveredCounts: [
          {
            fingerprint: nextFingerprint,
            counts: { thought: 1, chunk: 0, card: 0 },
          },
        ],
      });
      const target = await ctx.db
        .query("embeddingTargets")
        .withIndex("by_space_kind_target", (q) =>
          q
            .eq("spaceId", seeded.spaceId)
            .eq("targetKind", "thought")
            .eq("targetId", String(seeded.thoughtId)),
        )
        .unique();
      await ctx.db.patch(target!._id, {
        coveredFingerprint: nextFingerprint,
      });
    });

    // The reader that read the state after the flip sees only the new profile,
    // and the row staged under the retired one is dropped rather than mixed.
    const resolved = await hydrate(seeded, nextFingerprint, [
      active.vectorId,
      next.vectorId,
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.embeddingVectorId).toBe(next.vectorId);
    // A reader that read the state before the flip degrades, never mixes.
    await expect(
      hydrate(seeded, active.fingerprint, [active.vectorId, next.vectorId]),
    ).rejects.toThrow("no longer active");
  });

  test("keeps exactly one row per target across repeated re-embeds, I11", async () => {
    const seeded = await seed();
    const active = await activateWithThoughtVector(seeded);
    const before = await spaceState(seeded);
    const staleHash = await sha256Hex("a superseded staging artifact");
    // A row the old transition driver could leave behind: same fingerprint,
    // same target, a different generation and a different input hash.
    await insertRawVector(seeded, {
      fingerprint: active.fingerprint,
      inputHash: staleHash,
      profile: baselineProfile,
    });

    for (const revision of ["First revision", "Second revision"]) {
      await seeded.t.run(async (ctx) => {
        await ctx.db.patch(seeded.thoughtId, { content: revision });
        await markEligibilityTargets(ctx, seeded.spaceId, {
          thoughtIds: [seeded.thoughtId],
        });
        const thought = (await ctx.db.get(seeded.thoughtId))!;
        await insertThoughtEmbedding(ctx, {
          spaceId: seeded.spaceId,
          thoughtId: seeded.thoughtId,
          embeddingGenerationId: active.generationId,
          fingerprint: active.fingerprint,
          inputText: thought.content,
          vector: thought.embedding,
          bumpEligibility: false,
        });
      });
      const rows = await seeded.t.run((ctx) =>
        ctx.db
          .query("embeddingVectors")
          .withIndex("by_thoughtId", (q) => q.eq("thoughtId", seeded.thoughtId))
          .collect(),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.inputHash).toBe(await sha256Hex(revision));
      expect(rows[0]!.scopeV2).toBe(
        embeddingVectorScopeV2({
          spaceId: seeded.spaceId,
          fingerprint: active.fingerprint,
          targetKind: "thought",
        }),
      );
    }
    // The covered counters net to zero across every swap.
    const after = await spaceState(seeded);
    expect(after.coveredCounts).toEqual(before.coveredCounts);
    expect(after.eligibleCounts).toEqual(before.eligibleCounts);
  });

  test("fails closed for a space whose counters were never seeded", async () => {
    const seeded = await seed();
    const active = await activateWithThoughtVector(seeded);
    await seeded.t.run(async (ctx) => {
      const state = await ctx.db
        .query("spaceEmbeddingStates")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .unique();
      await ctx.db.patch(state!._id, {
        eligibleCounts: undefined,
        coveredCounts: undefined,
        lastAuditAt: undefined,
      });
    });
    await expect(
      seeded.t.run((ctx) => getActiveEmbeddingTarget(ctx, seeded.spaceId)),
    ).rejects.toThrow("P2-6g target backfill");
    expect(active.vectorId).toBeDefined();
  });

  /**
   * P2-6e lite. P2-6d took the generation out of the vector filter, so rows an
   * earlier generation wrote under the same fingerprint share one `scopeV2` with
   * the active ones and are searchable beside them. I11 stops new ones; this is
   * the operator page that removes the ones already there.
   */
  describe("retired same-fingerprint vector cleanup", () => {
    async function cleanup(
      seeded: Awaited<ReturnType<typeof seed>>,
      args: { fingerprint?: string; batchSize?: number; dryRun?: boolean } = {},
    ) {
      return await seeded.t.mutation(
        internal.models.embeddings.migrations.deleteNonActiveGenerationVectors,
        { spaceId: seeded.spaceId, ...args },
      );
    }

    /** Every vector row the seeded thought holds, oldest first. */
    async function thoughtRows(seeded: Awaited<ReturnType<typeof seed>>) {
      return await seeded.t.run((ctx) =>
        ctx.db
          .query("embeddingVectors")
          .withIndex("by_thoughtId", (q) => q.eq("thoughtId", seeded.thoughtId))
          .collect(),
      );
    }

    async function counters(seeded: Awaited<ReturnType<typeof seed>>) {
      const state = (await seeded.t.run((ctx) =>
        ctx.db
          .query("spaceEmbeddingStates")
          .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
          .unique(),
      )) as Doc<"spaceEmbeddingStates">;
      return {
        eligibleCounts: state.eligibleCounts,
        coveredCounts: state.coveredCounts,
        counterDrift: state.counterDrift,
      };
    }

    test("deletes only the retired rows and leaves the counters alone", async () => {
      const seeded = await seed();
      const active = await activateWithThoughtVector(seeded);
      const content = (await seeded.t.run((ctx) =>
        ctx.db.get(seeded.thoughtId),
      ))!.content;
      const inputHash = await sha256Hex(content);
      // The production shape: a first generation under the same fingerprint,
      // retired, holding its own row for the same target and the same text.
      const retired = await insertRawVector(seeded, {
        fingerprint: active.fingerprint,
        inputHash,
        profile: baselineProfile,
      });
      // A row of a different fingerprint the operator did not name.
      const otherFingerprint = await fingerprintEmbeddingConfig(otherProfile);
      const other = await insertRawVector(seeded, {
        fingerprint: otherFingerprint,
        inputHash,
        profile: otherProfile,
      });
      await seeded.t.run(async (ctx) => {
        await ctx.db.patch(retired.generationId, {
          state: "retired",
          activatedAt: 5,
          deactivatedAt: 6,
        });
      });
      expect(await thoughtRows(seeded)).toHaveLength(3);
      const before = await counters(seeded);

      // Two rows of one target reach the reader; the dedupe hides the damage a
      // fixed candidate budget would take, which is why the rows must go.
      expect(
        await hydrate(seeded, active.fingerprint, [
          retired.vectorId,
          active.vectorId,
        ]),
      ).toHaveLength(1);

      const dry = await cleanup(seeded, { dryRun: true });
      expect(dry).toMatchObject({
        dryRun: true,
        fingerprint: active.fingerprint,
        activeEmbeddingGenerationId: active.generationId,
        scanned: 1,
        deleted: 0,
        duplicates: 1,
        soleRows: 0,
        coverageReleased: 0,
        remaining: false,
      });
      const dryTargeted = dry.generations.filter((row) => row.targeted);
      expect(dryTargeted).toMatchObject([
        {
          embeddingGenerationId: retired.generationId,
          fingerprint: active.fingerprint,
          state: "retired",
          isActive: false,
          pageRows: 1,
        },
      ]);
      expect(
        dry.generations.find(
          (row) => row.embeddingGenerationId === active.generationId,
        ),
      ).toMatchObject({ isActive: true, targeted: false, pageRows: 0 });
      // A dry run writes nothing.
      expect(await thoughtRows(seeded)).toHaveLength(3);
      expect(await counters(seeded)).toEqual(before);

      const run = await cleanup(seeded);
      expect(run).toMatchObject({
        dryRun: false,
        scanned: 1,
        deleted: 1,
        duplicates: 1,
        soleRows: 0,
        coverageReleased: 0,
        remaining: false,
      });

      const after = await thoughtRows(seeded);
      expect(after.map((row) => row._id).sort()).toEqual(
        [active.vectorId, other.vectorId].sort(),
      );
      // The row of the fingerprint the operator did not name is untouched.
      expect(
        after.find((row) => row.embeddingFingerprint === otherFingerprint),
      ).toBeDefined();
      // Deleting a duplicate must not decrement coverage for a target that still
      // has its active row.
      expect(await counters(seeded)).toEqual(before);
      expect(
        await seeded.t.run((ctx) =>
          getActiveEmbeddingTarget(ctx, seeded.spaceId),
        ),
      ).toMatchObject({ thoughtStatus: "ready" });

      // The reader now sees one row per target because only one exists.
      expect(
        await hydrate(seeded, active.fingerprint, [
          retired.vectorId,
          active.vectorId,
        ]),
      ).toMatchObject([{ embeddingVectorId: active.vectorId }]);

      // Rerunning is a no-op.
      expect(await cleanup(seeded)).toMatchObject({
        scanned: 0,
        deleted: 0,
        remaining: false,
      });
    });

    test("releases coverage once when the target keeps no active row", async () => {
      const seeded = await seed();
      const active = await activateWithThoughtVector(seeded);
      const content = (await seeded.t.run((ctx) =>
        ctx.db.get(seeded.thoughtId),
      ))!.content;
      const inputHash = await sha256Hex(content);
      const first = await insertRawVector(seeded, {
        fingerprint: active.fingerprint,
        inputHash,
        profile: baselineProfile,
      });
      const second = await insertRawVector(seeded, {
        fingerprint: active.fingerprint,
        inputHash,
        profile: baselineProfile,
      });
      // Drop the active generation's own row, so the target's only coverage is
      // the two rows this cleanup is about to remove.
      await seeded.t.run((ctx) => ctx.db.delete(active.vectorId));
      expect(first.vectorId).not.toBe(second.vectorId);

      const run = await cleanup(seeded);
      expect(run).toMatchObject({
        scanned: 2,
        deleted: 2,
        duplicates: 0,
        soleRows: 2,
        // Two sole rows, one marker: the second release is a no-op rather than a
        // second decrement, so the counter cannot go negative.
        coverageReleased: 2,
        remaining: false,
      });
      expect(await thoughtRows(seeded)).toHaveLength(0);
      const after = await counters(seeded);
      expect(after.coveredCounts).toEqual([
        {
          fingerprint: active.fingerprint,
          counts: { thought: 0, chunk: 0, card: 0 },
        },
      ]);
      expect(after.eligibleCounts).toEqual({ thought: 1, chunk: 0, card: 0 });
      expect(
        await seeded.t.run((ctx) =>
          getActiveEmbeddingTarget(ctx, seeded.spaceId),
        ),
      ).toMatchObject({ thoughtStatus: "unavailable" });
    });

    test("pages, and refuses a space with no active generation", async () => {
      const seeded = await seed();
      const active = await activateWithThoughtVector(seeded);
      const content = (await seeded.t.run((ctx) =>
        ctx.db.get(seeded.thoughtId),
      ))!.content;
      const inputHash = await sha256Hex(content);
      for (let index = 0; index < 3; index += 1) {
        await insertRawVector(seeded, {
          fingerprint: active.fingerprint,
          inputHash,
          profile: baselineProfile,
        });
      }
      const firstPage = await cleanup(seeded, { batchSize: 2 });
      expect(firstPage).toMatchObject({
        scanned: 2,
        deleted: 2,
        remaining: true,
      });
      const secondPage = await cleanup(seeded, { batchSize: 2 });
      expect(secondPage).toMatchObject({
        scanned: 1,
        deleted: 1,
        remaining: false,
      });
      expect(await thoughtRows(seeded)).toMatchObject([
        { _id: active.vectorId },
      ]);

      await seeded.t.run(async (ctx) => {
        const state = await ctx.db
          .query("spaceEmbeddingStates")
          .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
          .unique();
        await ctx.db.patch(state!._id, {
          activeEmbeddingGenerationId: undefined,
          activeFingerprint: undefined,
        });
      });
      await expect(cleanup(seeded)).rejects.toThrow(
        "no active embedding generation",
      );
    });
  });

  /**
   * P2-6e proper. Section 4 of the capacity plan: the active generation and
   * the most recently retired generation of another fingerprint stay, every
   * other generation's vectors go, and the generation rows themselves are
   * never deleted.
   */
  describe("historical generation cleanup", () => {
    async function cleanupGenerations(
      seeded: Awaited<ReturnType<typeof seed>>,
      args: {
        dryRun?: boolean;
        batchSize?: number;
        expectedActiveGenerationId?: Id<"embeddingGenerations">;
      } = {},
    ) {
      return await seeded.t.mutation(
        internal.models.embeddings.migrations.cleanupEmbeddingGenerations,
        { spaceId: seeded.spaceId, ...args },
      );
    }

    async function auditSpace(
      seeded: Awaited<ReturnType<typeof seed>>,
      fingerprint: string,
      now = 1_000,
    ) {
      return await seeded.t.mutation(
        internal.models.embeddings.migrations.auditSpaceCoverage,
        { spaceId: seeded.spaceId, fingerprint, now },
      );
    }

    async function vectorRows(seeded: Awaited<ReturnType<typeof seed>>) {
      return await seeded.t.run((ctx) =>
        ctx.db.query("embeddingVectors").collect(),
      );
    }

    async function generationStates(seeded: Awaited<ReturnType<typeof seed>>) {
      const rows = await seeded.t.run((ctx) =>
        ctx.db.query("embeddingGenerations").collect(),
      );
      return new Map(rows.map((row) => [row._id, row.state]));
    }

    async function counters(seeded: Awaited<ReturnType<typeof seed>>) {
      const state = await spaceState(seeded);
      return {
        eligibleCounts: state.eligibleCounts,
        coveredCounts: state.coveredCounts,
        counterDrift: state.counterDrift,
      };
    }

    /** The production shape: five generations across two fingerprints. */
    async function seedFiveGenerations() {
      const seeded = await seed();
      const active = await activateWithThoughtVector(seeded);
      const content = (await seeded.t.run((ctx) =>
        ctx.db.get(seeded.thoughtId),
      ))!.content;
      const inputHash = await sha256Hex(content);
      const otherFingerprint = await fingerprintEmbeddingConfig(otherProfile);
      // An older generation of the *active* fingerprint: the P2-6h class.
      const staleActive = await insertRawVector(seeded, {
        fingerprint: active.fingerprint,
        inputHash,
        profile: baselineProfile,
      });
      const oldRollback = await insertRawVector(seeded, {
        fingerprint: otherFingerprint,
        inputHash,
        profile: otherProfile,
      });
      const newestRollback = await insertRawVector(seeded, {
        fingerprint: otherFingerprint,
        inputHash,
        profile: otherProfile,
      });
      const failed = await insertRawVector(seeded, {
        fingerprint: otherFingerprint,
        inputHash,
        profile: otherProfile,
      });
      await seeded.t.run(async (ctx) => {
        await ctx.db.patch(staleActive.generationId, {
          state: "retired",
          activatedAt: 5,
          deactivatedAt: 6,
        });
        await ctx.db.patch(oldRollback.generationId, {
          state: "retired",
          activatedAt: 5,
          deactivatedAt: 7,
        });
        await ctx.db.patch(newestRollback.generationId, {
          state: "retired",
          activatedAt: 7,
          deactivatedAt: 8,
        });
        await ctx.db.patch(failed.generationId, {
          state: "failed",
          failureCode: "synthetic",
          failureMessage: "abandoned build",
          failedAt: 9,
        });
      });
      return {
        seeded,
        active,
        otherFingerprint,
        staleActive,
        oldRollback,
        newestRollback,
        failed,
      };
    }

    test("keeps the active generation and the newest retired fingerprint", async () => {
      const fixture = await seedFiveGenerations();
      const { seeded, active } = fixture;
      const before = await counters(seeded);

      const dry = await cleanupGenerations(seeded, { dryRun: true });
      expect(dry).toMatchObject({
        dryRun: true,
        activeFingerprint: active.fingerprint,
        activeEmbeddingGenerationId: active.generationId,
        retainedEmbeddingGenerationId: fixture.newestRollback.generationId,
        scanned: 3,
        deleted: 0,
        // Every row here belongs to a target that still holds its active row,
        // so none of them is anyone's only coverage.
        duplicates: 3,
        soleRows: 0,
        coverageReleased: 0,
        cleanedGenerations: 0,
        remaining: false,
      });
      const roles = new Map(
        dry.generations.map((row) => [row.embeddingGenerationId, row]),
      );
      expect(roles.get(active.generationId)).toMatchObject({
        role: "active",
        pageRows: 0,
      });
      expect(roles.get(fixture.newestRollback.generationId)).toMatchObject({
        role: "retained",
        state: "retired",
        pageRows: 0,
      });
      expect(roles.get(fixture.staleActive.generationId)).toMatchObject({
        role: "deletable",
        fingerprint: active.fingerprint,
        pageRows: 1,
        hasMoreRows: false,
        cleaned: false,
      });
      expect(roles.get(fixture.failed.generationId)).toMatchObject({
        role: "deletable",
        state: "failed",
        pageRows: 1,
      });
      // A dry run writes nothing.
      expect(await vectorRows(seeded)).toHaveLength(5);
      expect(await counters(seeded)).toEqual(before);

      const run = await cleanupGenerations(seeded);
      expect(run).toMatchObject({
        dryRun: false,
        scanned: 3,
        deleted: 3,
        duplicates: 3,
        soleRows: 0,
        coverageReleased: 0,
        // The failed generation keeps its state; only a retired one is marked.
        cleanedGenerations: 2,
        remaining: false,
      });

      const remaining = await vectorRows(seeded);
      expect(remaining.map((row) => row._id).sort()).toEqual(
        [active.vectorId, fixture.newestRollback.vectorId].sort(),
      );
      expect(await counters(seeded)).toEqual(before);
      const states = await generationStates(seeded);
      expect(states.size).toBe(5);
      expect(states.get(active.generationId)).toBe("active");
      expect(states.get(fixture.newestRollback.generationId)).toBe("retired");
      expect(states.get(fixture.staleActive.generationId)).toBe(
        "retired_cleaned",
      );
      expect(states.get(fixture.oldRollback.generationId)).toBe(
        "retired_cleaned",
      );
      expect(states.get(fixture.failed.generationId)).toBe("failed");

      // Rerunning finds nothing and changes nothing.
      expect(await cleanupGenerations(seeded)).toMatchObject({
        scanned: 0,
        deleted: 0,
        cleanedGenerations: 0,
        remaining: false,
      });
      expect(await counters(seeded)).toEqual(before);
    });

    test("pages without touching the active generation under interleaved writes", async () => {
      const seeded = await seed();
      const active = await activateWithThoughtVector(seeded);
      const content = (await seeded.t.run((ctx) =>
        ctx.db.get(seeded.thoughtId),
      ))!.content;
      const inputHash = await sha256Hex(content);
      const first = await insertRawVector(seeded, {
        fingerprint: active.fingerprint,
        inputHash,
        profile: baselineProfile,
      });
      const second = await insertRawVector(seeded, {
        fingerprint: active.fingerprint,
        inputHash,
        profile: baselineProfile,
      });
      await seeded.t.run(async (ctx) => {
        for (const generationId of [first.generationId, second.generationId]) {
          await ctx.db.patch(generationId, {
            state: "retired",
            activatedAt: 5,
            deactivatedAt: 6,
          });
        }
      });
      const activeRowsBefore = await seeded.t.run((ctx) =>
        ctx.db
          .query("embeddingVectors")
          .withIndex("by_embeddingGenerationId", (q) =>
            q.eq("embeddingGenerationId", active.generationId),
          )
          .collect(),
      );

      const page = await cleanupGenerations(seeded, { batchSize: 1 });
      expect(page).toMatchObject({ deleted: 1, remaining: true });

      // A capture lands in the active generation between the pages.
      const interleavedId = await seeded.t.run(async (ctx) => {
        const thoughtId = await ctx.db.insert("thoughts", {
          userId: seeded.userId,
          spaceId: seeded.spaceId,
          content: "A memory captured between cleanup pages",
          embedding: Array.from(
            { length: BASELINE_EMBEDDING_DIMENSIONS },
            (_, index) => (index % 5) + 1,
          ),
          metadata,
          memoryStatus: "current",
        });
        await markEligibilityTargets(ctx, seeded.spaceId, {
          thoughtIds: [thoughtId],
        });
        const thought = (await ctx.db.get(thoughtId))!;
        return await insertThoughtEmbedding(ctx, {
          spaceId: seeded.spaceId,
          thoughtId,
          embeddingGenerationId: active.generationId,
          fingerprint: active.fingerprint,
          inputText: thought.content,
          vector: thought.embedding,
          bumpEligibility: false,
        });
      });

      const last = await cleanupGenerations(seeded, {
        batchSize: 1,
        expectedActiveGenerationId: active.generationId,
      });
      expect(last).toMatchObject({ deleted: 1, remaining: false });

      const activeRowsAfter = await seeded.t.run((ctx) =>
        ctx.db
          .query("embeddingVectors")
          .withIndex("by_embeddingGenerationId", (q) =>
            q.eq("embeddingGenerationId", active.generationId),
          )
          .collect(),
      );
      expect(activeRowsAfter.map((row) => row._id).sort()).toEqual(
        [...activeRowsBefore.map((row) => row._id), interleavedId].sort(),
      );
      // Byte-identical, not merely present.
      for (const before of activeRowsBefore) {
        expect(activeRowsAfter.find((row) => row._id === before._id)).toEqual(
          before,
        );
      }

      // A caller that names a stale active pointer is refused outright.
      await expect(
        cleanupGenerations(seeded, {
          expectedActiveGenerationId: first.generationId,
        }),
      ).rejects.toThrow("Active embedding generation changed");
    });

    test("the audit flags a duplicate row and clears after the cleanup", async () => {
      const seeded = await seed();
      const active = await activateWithThoughtVector(seeded);
      const content = (await seeded.t.run((ctx) =>
        ctx.db.get(seeded.thoughtId),
      ))!.content;
      const inputHash = await sha256Hex(content);

      const clean = await auditSpace(seeded, active.fingerprint);
      expect(clean).toMatchObject({
        complete: true,
        counterDrift: false,
        duplicateTargets: 0,
        duplicateProbeScanned: 1,
        duplicateProbeComplete: true,
      });
      expect(clean.counterDriftReason).toBeUndefined();

      // The bug the reader cannot see: a second row for one target under the
      // active fingerprint, hidden from results by the per-target dedupe.
      const duplicate = await insertRawVector(seeded, {
        fingerprint: active.fingerprint,
        inputHash,
        profile: baselineProfile,
      });
      await seeded.t.run((ctx) =>
        ctx.db.patch(duplicate.generationId, {
          state: "retired",
          activatedAt: 5,
          deactivatedAt: 6,
        }),
      );
      const readerBefore = await hydrate(seeded, active.fingerprint, [
        duplicate.vectorId,
        active.vectorId,
      ]);
      expect(readerBefore).toHaveLength(1);

      const flagged = await auditSpace(seeded, active.fingerprint, 1_100);
      expect(flagged).toMatchObject({
        complete: true,
        counterDrift: true,
        counterDriftReason: "duplicate_active_fingerprint_rows",
        duplicateTargets: 1,
        duplicateProbeComplete: true,
      });
      // The counters themselves are exact: both rows cover one target once.
      expect(flagged.recountedEligible).toEqual(flagged.storedEligible);
      expect(flagged.recountedCovered).toEqual(flagged.storedCovered);
      expect((await spaceState(seeded)).counterDrift).toBe(true);

      const cleanup = await cleanupGenerations(seeded);
      expect(cleanup).toMatchObject({ deleted: 1, coverageReleased: 0 });

      const cleared = await auditSpace(seeded, active.fingerprint, 1_200);
      expect(cleared).toMatchObject({
        counterDrift: false,
        duplicateTargets: 0,
      });
      expect(cleared.counterDriftReason).toBeUndefined();
      expect((await spaceState(seeded)).counterDrift).toBe(false);

      // The reader returns the same memory before and after the cleanup.
      const readerAfter = await hydrate(seeded, active.fingerprint, [
        duplicate.vectorId,
        active.vectorId,
      ]);
      expect(readerAfter.map((row) => row.thoughtId)).toEqual(
        readerBefore.map((row) => row.thoughtId),
      );
      expect(readerAfter).toMatchObject([
        { embeddingVectorId: active.vectorId },
      ]);
    });

    test("a retirement removes the thought's rows in every generation, P2-6h", async () => {
      const seeded = await seed();
      const active = await activateWithThoughtVector(seeded);
      const content = (await seeded.t.run((ctx) =>
        ctx.db.get(seeded.thoughtId),
      ))!.content;
      const inputHash = await sha256Hex(content);
      const stale = await insertRawVector(seeded, {
        fingerprint: active.fingerprint,
        inputHash,
        profile: baselineProfile,
      });
      const otherFingerprint = await fingerprintEmbeddingConfig(otherProfile);
      const rollback = await insertRawVector(seeded, {
        fingerprint: otherFingerprint,
        inputHash,
        profile: otherProfile,
      });
      await seeded.t.run((ctx) =>
        ctx.db.patch(stale.generationId, {
          state: "retired",
          activatedAt: 5,
          deactivatedAt: 6,
        }),
      );

      await seeded.t.run((ctx) =>
        ctx.db.patch(seeded.thoughtId, { memoryStatus: "retracted" }),
      );
      const deleted = await seeded.t.run((ctx) =>
        deleteActiveThoughtEmbeddingVectors(ctx, {
          spaceId: seeded.spaceId,
          embeddingGenerationId: active.generationId,
          fingerprint: active.fingerprint,
          thoughtIds: [seeded.thoughtId],
        }),
      );
      // Both rows of the active fingerprint, not only the active generation's.
      expect(deleted).toBe(2);
      expect((await vectorRows(seeded)).map((row) => row._id)).toEqual([
        rollback.vectorId,
      ]);
      // One marker, one release: the counter cannot go negative.
      expect((await counters(seeded)).coveredCounts).toEqual([
        {
          fingerprint: active.fingerprint,
          counts: { thought: 0, chunk: 0, card: 0 },
        },
      ]);
    });
  });
});
