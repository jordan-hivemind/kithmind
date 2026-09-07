import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api, internal } from "../../_generated/api";
import {
  BASELINE_EMBEDDING_DIMENSIONS,
  fingerprintEmbeddingConfig,
  type EmbeddingProfile,
} from "../../lib/embeddingProvider";
import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  activateEmbeddingGeneration,
  createEmbeddingGeneration,
  getActiveEmbeddingTarget,
  insertChunkEmbedding,
  stageEmbeddingGeneration,
} from "../embeddings/model";

const pipeline = internal.models.ingestion.private;
const embedding = Array(BASELINE_EMBEDDING_DIMENSIONS).fill(0.25);

function profile(modelRevision: string): EmbeddingProfile {
  return {
    protocol: "openai-embeddings-v1",
    providerId: "synthetic-provider",
    model: "synthetic-model",
    modelRevision,
    dimensions: BASELINE_EMBEDDING_DIMENSIONS,
    normalization: "none-v1",
    preprocessing: "none-v1",
  };
}

test("registered processing functions replace canonical vectors, preserve retired history, and forget without resurrection", async () => {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Synthetic integration owner" }),
  );
  const session = t.withIdentity({
    subject: userId,
    issuer: "https://synthetic.example/convex",
  });
  const sourceAccountId = await session.mutation(
    api.models.sourceAccounts.public.create,
    {
      connector: "synthetic",
      accountId: "integration",
      name: "Synthetic documents",
    },
  );
  const principal = { userId };

  async function publish(input: {
    requestId: string;
    expectedDesiredProcessingEpoch: number;
    text: string;
    capturedAt: number;
  }) {
    const admissionInput = {
      principal,
      sourceAccountId,
      requestId: input.requestId,
      expectedDesiredProcessingEpoch: input.expectedDesiredProcessingEpoch,
      source: {
        externalId: "synthetic-service",
        title: "Synthetic service",
        docType: "service",
        capturedAt: input.capturedAt,
        mediaType: "text/plain",
        inlineText: input.text,
        uri: "file:///synthetic/service.txt",
      },
      processing: {
        extractionFingerprint: "plain-v1",
        extractorFingerprint: "generic-v1",
        recordSchemaFingerprint: "document-v1",
        normalizationFingerprint: "none-v1",
        chunkerFingerprint: "single-v1",
        correctionRevision: "0",
        expectedPageCount: 1,
        expectedEvidenceSpanCount: 1,
        expectedDocumentCount: 1,
        expectedChunkCount: 1,
      },
    };
    const admitted = await t.mutation(pipeline.admit, admissionInput);
    const leaseToken = `lease-${input.requestId}`;
    const claim = await t.mutation(pipeline.claim, {
      principal,
      jobId: admitted.ingestJobId,
      leaseToken,
      leaseDurationMs: 60_000,
    });
    if (!("leaseEpoch" in claim)) throw new Error("Expected a lease");
    const lease = {
      principal,
      jobId: admitted.ingestJobId,
      leaseToken,
      leaseEpoch: claim.leaseEpoch,
    };
    await t.mutation(pipeline.createTextVersion, {
      ...lease,
      text: input.text,
    });
    const stagedPages = await t.mutation(pipeline.stagePages, {
      ...lease,
      pages: [
        { ordinal: 0, start: 0, end: input.text.length, text: input.text },
      ],
    });
    if (!("ids" in stagedPages)) throw new Error("Expected staged pages");
    const stagedSpans = await t.mutation(pipeline.stageEvidenceSpans, {
      ...lease,
      spans: [
        {
          sourcePageId: stagedPages.ids[0]!._id,
          ordinal: 0,
          start: 0,
          end: input.text.length,
        },
      ],
    });
    if (!("ids" in stagedSpans)) throw new Error("Expected staged evidence");
    const evidenceSpanIds = stagedSpans.ids.map((span) => span._id);
    const stagedDocuments = await t.mutation(pipeline.stageDocuments, {
      ...lease,
      documents: [
        {
          documentKey: "service",
          title: "Synthetic service",
          docType: "service",
          capturedAt: input.capturedAt,
          evidenceSpanIds,
        },
      ],
    });
    if (!("ids" in stagedDocuments)) {
      throw new Error("Expected staged documents");
    }
    const documentId = stagedDocuments.ids[0]!._id;
    const stagedChunks = await t.mutation(pipeline.stageChunks, {
      ...lease,
      chunks: [{ documentId, ordinal: 0, text: input.text, evidenceSpanIds }],
    });
    if (!("ids" in stagedChunks)) throw new Error("Expected staged chunks");
    const chunkId = stagedChunks.ids[0]!._id;
    expect(
      await session.query(api.models.documents.public.get, { documentId }),
    ).toBeNull();
    await t.mutation(pipeline.stage, lease);
    await t.mutation(pipeline.activate, lease);
    return { admitted, admissionInput, documentId, chunkId };
  }

  const firstText = "Synthetic oil service on 2026-08-15.";
  const first = await publish({
    requestId: "synthetic-request-1",
    expectedDesiredProcessingEpoch: 0,
    text: firstText,
    capturedAt: 1000,
  });
  const firstDocument = await session.query(api.models.documents.public.get, {
    documentId: first.documentId,
  });
  expect(firstDocument).toMatchObject({
    documentId: first.documentId,
    retainedTextAvailable: true,
    contentStatus: "ready",
    historical: false,
  });
  expect(firstDocument!.pages[0]!.evidence[0]!.quote).toBe(firstText);
  expect(
    (
      await session.query(api.models.documents.public.search, { query: "oil" })
    ).results.map((row) => row.documentId),
  ).toEqual([first.documentId]);
  expect(await t.mutation(pipeline.admit, first.admissionInput)).toMatchObject({
    ingestJobId: first.admitted.ingestJobId,
  });

  const spaceId = await t.run(async (ctx) => {
    const account = await ctx.db.get(sourceAccountId);
    if (!account) throw new Error("Expected source account");
    return account.spaceId;
  });
  const generations = await t.run(async (ctx) => {
    const oldProfile = profile("synthetic-v1");
    const oldFingerprint = await fingerprintEmbeddingConfig(oldProfile);
    const oldGeneration = await createEmbeddingGeneration(ctx, {
      spaceId,
      profile: oldProfile,
      fingerprint: oldFingerprint,
      createdAt: 1,
    });
    const retiredVectorId = await insertChunkEmbedding(ctx, {
      spaceId,
      chunkId: first.chunkId,
      embeddingGenerationId: oldGeneration._id,
      fingerprint: oldFingerprint,
      inputText: firstText,
      vector: embedding,
    });
    await stageEmbeddingGeneration(ctx, {
      embeddingGenerationId: oldGeneration._id,
      stagedAt: 2,
    });
    await activateEmbeddingGeneration(ctx, {
      embeddingGenerationId: oldGeneration._id,
      activatedAt: 3,
    });

    const activeProfile = profile("synthetic-v2");
    const activeFingerprint = await fingerprintEmbeddingConfig(activeProfile);
    const activeGeneration = await createEmbeddingGeneration(ctx, {
      spaceId,
      profile: activeProfile,
      fingerprint: activeFingerprint,
      createdAt: 4,
    });
    const activeOldChunkVectorId = await insertChunkEmbedding(ctx, {
      spaceId,
      chunkId: first.chunkId,
      embeddingGenerationId: activeGeneration._id,
      fingerprint: activeFingerprint,
      inputText: firstText,
      vector: embedding,
    });
    await stageEmbeddingGeneration(ctx, {
      embeddingGenerationId: activeGeneration._id,
      stagedAt: 5,
    });
    await activateEmbeddingGeneration(ctx, {
      embeddingGenerationId: activeGeneration._id,
      expectedPreviousGenerationId: oldGeneration._id,
      activatedAt: 6,
    });
    return {
      oldGenerationId: oldGeneration._id,
      retiredVectorId,
      activeGenerationId: activeGeneration._id,
      activeFingerprint,
      activeOldChunkVectorId,
    };
  });

  const replacementText = "Synthetic oil service moved to 2026-09-20.";
  const replacement = await publish({
    requestId: "synthetic-request-2",
    expectedDesiredProcessingEpoch: 1,
    text: replacementText,
    capturedAt: 2000,
  });
  const afterReplacement = await t.run(async (ctx) => ({
    activeOldVector: await ctx.db.get(generations.activeOldChunkVectorId),
    retiredVector: await ctx.db.get(generations.retiredVectorId),
    activeTarget: await getActiveEmbeddingTarget(ctx, spaceId),
  }));
  expect(afterReplacement.activeOldVector).toBeNull();
  expect(afterReplacement.retiredVector).toMatchObject({
    embeddingGenerationId: generations.oldGenerationId,
    chunkId: first.chunkId,
  });
  expect(afterReplacement.activeTarget?.chunkStatus).toBe("unavailable");
  expect(
    await session.query(api.models.documents.public.get, {
      documentId: first.documentId,
      includeHistorical: true,
    }),
  ).toMatchObject({ historical: true, retainedTextAvailable: true });

  await t.run(async (ctx) => {
    await insertChunkEmbedding(ctx, {
      spaceId,
      chunkId: replacement.chunkId,
      embeddingGenerationId: generations.activeGenerationId,
      fingerprint: generations.activeFingerprint,
      inputText: replacementText,
      vector: embedding,
    });
  });
  expect(
    await t.run((ctx) => getActiveEmbeddingTarget(ctx, spaceId)),
  ).toMatchObject({ chunkStatus: "ready" });

  await t.mutation(pipeline.markUnavailable, {
    principal,
    sourceItemId: first.admitted.sourceItemId,
  });
  expect(
    await session.query(api.models.documents.public.get, {
      documentId: replacement.documentId,
    }),
  ).toMatchObject({
    retainedTextAvailable: true,
    originalLinkAvailable: false,
  });
  await t.mutation(pipeline.beginForget, {
    principal,
    sourceItemId: first.admitted.sourceItemId,
  });
  expect(
    await session.query(api.models.documents.public.get, {
      documentId: first.documentId,
      includeHistorical: true,
    }),
  ).toBeNull();
  let done = false;
  for (let i = 0; i < 30 && !done; i++) {
    const result = await t.mutation(pipeline.continueForget, {
      principal,
      sourceItemId: first.admitted.sourceItemId,
    });
    expect(result.deleted).toBeLessThanOrEqual(25);
    done = result.done;
  }
  expect(done).toBe(true);
  expect(
    await t.run((ctx) => getActiveEmbeddingTarget(ctx, spaceId)),
  ).toMatchObject({ chunkStatus: "ready" });
  expect(
    await t.run(async (ctx) => ({
      retiredVector: await ctx.db.get(generations.retiredVectorId),
      activeVectors: await ctx.db
        .query("embeddingVectors")
        .withIndex("by_embeddingGenerationId", (q) =>
          q.eq("embeddingGenerationId", generations.activeGenerationId),
        )
        .collect(),
    })),
  ).toEqual({ retiredVector: null, activeVectors: [] });
  await expect(
    t.mutation(pipeline.admit, first.admissionInput),
  ).rejects.toThrow(/forgotten/);
  expect(
    (await session.query(api.models.documents.public.search, { query: "oil" }))
      .results,
  ).toEqual([]);
  const tombstone = await t.run((ctx) =>
    ctx.db.get(first.admitted.sourceItemId),
  );
  expect(tombstone).toMatchObject({ lifecycle: "forgotten" });
  expect(tombstone!.externalId).toBeUndefined();
  expect(tombstone!.uri).toBeUndefined();
});
