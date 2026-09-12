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
  markEligibilityTargets,
  resolveAuthorizedThoughtVectorCandidates,
  stageEmbeddingGeneration,
} from "./model";
import { embeddingVectorScopeV2 } from "./targets";
import { sha256Hex } from "../ingestion/hash";
import type { Doc, Id } from "../../_generated/dataModel";

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
});
