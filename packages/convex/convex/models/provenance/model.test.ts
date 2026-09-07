import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  activateSourceItemGeneration,
  beginSourceItemForget,
  createOrGetRevision,
  createOrGetSourceItem,
  createOrGetTextVersion,
  deleteSourceItemProvenanceBatch,
  finalizeSourceItemTombstone,
  inspectGenerationPayload,
  markSourceItemUnavailable,
  refreshAvailableSourceItem,
  setDesiredSourceRevision,
  stageChunks,
  stageDocuments,
  stageEvidenceSpans,
  stagePages,
} from "./model";

async function seedSpaceAndAccount(
  t: ReturnType<typeof convexTest>,
  suffix = "primary",
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: `Synthetic ${suffix}`,
      createdBy: userId,
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "manual",
      accountId: `synthetic-${suffix}`,
      name: `Synthetic ${suffix}`,
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: userId,
    });
    return { sourceAccountId, spaceId, userId };
  });
}

async function seedRevisionAndTextVersion(
  t: ReturnType<typeof convexTest>,
  text = "alpha😀beta",
) {
  const base = await seedSpaceAndAccount(t);
  return await t.run(async (ctx) => {
    const item = await createOrGetSourceItem(ctx, {
      spaceId: base.spaceId,
      sourceAccountId: base.sourceAccountId,
      externalId: "source://synthetic/😀",
      title: "Synthetic source",
      docType: "note",
      uri: "https://example.invalid/synthetic",
    });
    const revision = await createOrGetRevision(ctx, {
      spaceId: base.spaceId,
      sourceItemId: item._id,
      mediaType: "text/plain",
      inlineText: text,
      capturedAt: 1_700_000_000_000,
      userId: base.userId,
    });
    const textVersion = await createOrGetTextVersion(ctx, {
      spaceId: base.spaceId,
      sourceRevisionId: revision._id,
      extractionFingerprint: "plain-text:v1",
      text,
    });
    return { ...base, item, revision, textVersion };
  });
}

async function insertGeneration(
  t: ReturnType<typeof convexTest>,
  seeded: Awaited<ReturnType<typeof seedRevisionAndTextVersion>>,
  desiredProcessingEpoch: number,
  processingFingerprint = "process:v1",
) {
  return await t.run((ctx) =>
    ctx.db.insert("processingGenerations", {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      sourceItemId: seeded.item._id,
      sourceRevisionId: seeded.revision._id,
      sourceTextVersionId: seeded.textVersion._id,
      processingFingerprint,
      extractionFingerprint: "plain-text:v1",
      extractorFingerprint: "extractor:v1",
      recordSchemaFingerprint: "document:v1",
      normalizationFingerprint: "exact:v1",
      chunkerFingerprint: "fixed:v1",
      correctionRevision: "0",
      desiredProcessingEpoch,
      state: "staged",
      expectedPageCount: 1,
      expectedEvidenceSpanCount: 1,
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
      embeddingStatus: "unavailable",
    }),
  );
}

describe("immutable provenance", () => {
  test("hashes exact UTF-8 bytes and rejects conflicting immutable identities", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedRevisionAndTextVersion(t, "A😀\r\n");

    expect(seeded.item.externalIdHash).toBe(
      "7e9e7e020daf03164bb59d15dba5664adf1d6daf0a8617beaae31cd7c555d4fa",
    );
    expect(seeded.revision).toMatchObject({
      byteLength: 7,
      contentHash:
        "ed116a528005dbf107810ca7dad7291c00ef763b61f4f2b023124289f639d55d",
      inlineText: "A😀\r\n",
    });

    const retried = await t.run((ctx) =>
      createOrGetRevision(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.item._id,
        mediaType: "text/plain",
        inlineText: "A😀\r\n",
        capturedAt: 1_700_000_000_000,
        userId: seeded.userId,
      }),
    );
    expect(retried._id).toBe(seeded.revision._id);

    await expect(
      t.run((ctx) =>
        createOrGetRevision(ctx, {
          spaceId: seeded.spaceId,
          sourceItemId: seeded.item._id,
          mediaType: "text/plain",
          inlineText: "A😀\r\n",
          capturedAt: 1_700_000_000_001,
          userId: seeded.userId,
        }),
      ),
    ).rejects.toThrow("Conflicting immutable source revision");
  });

  test("validates exact UTF-16 page and evidence boundaries", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedRevisionAndTextVersion(t);

    const [page] = await t.run((ctx) =>
      stagePages(ctx, {
        spaceId: seeded.spaceId,
        sourceTextVersionId: seeded.textVersion._id,
        pages: [{ ordinal: 0, start: 0, end: 11, text: "alpha😀beta" }],
      }),
    );
    const [span] = await t.run((ctx) =>
      stageEvidenceSpans(ctx, {
        spaceId: seeded.spaceId,
        sourceRevisionId: seeded.revision._id,
        sourceTextVersionId: seeded.textVersion._id,
        spans: [{ sourcePageId: page!._id, ordinal: 0, start: 5, end: 7 }],
      }),
    );
    expect(span!.quoteHash).toBe(
      "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9",
    );

    await expect(
      t.run((ctx) =>
        stageEvidenceSpans(ctx, {
          spaceId: seeded.spaceId,
          sourceRevisionId: seeded.revision._id,
          sourceTextVersionId: seeded.textVersion._id,
          spans: [{ sourcePageId: page!._id, ordinal: 1, start: 6, end: 7 }],
        }),
      ),
    ).rejects.toThrow("splits a UTF-16 surrogate pair");

    await expect(
      t.run((ctx) =>
        stagePages(ctx, {
          spaceId: seeded.spaceId,
          sourceTextVersionId: seeded.textVersion._id,
          pages: [{ ordinal: 1, start: 0, end: 5, text: "wrong" }],
        }),
      ),
    ).rejects.toThrow("does not match");
  });

  test("rejects cross-space parent references", async () => {
    const t = convexTest(schema, modules);
    const first = await seedSpaceAndAccount(t, "first");
    const second = await seedSpaceAndAccount(t, "second");

    await expect(
      t.run((ctx) =>
        createOrGetSourceItem(ctx, {
          spaceId: second.spaceId,
          sourceAccountId: first.sourceAccountId,
          externalId: "cross-space",
        }),
      ),
    ).rejects.toThrow("Source account belongs to another space");
  });

  test("stages immutable generation payload and transitions publication atomically", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedRevisionAndTextVersion(t);
    const desiredEpoch = await t.run((ctx) =>
      setDesiredSourceRevision(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.item._id,
        desiredRevisionId: seeded.revision._id,
        expectedDesiredProcessingEpoch: 0,
      }),
    );
    const generationId = await insertGeneration(t, seeded, desiredEpoch);
    const [page] = await t.run((ctx) =>
      stagePages(ctx, {
        spaceId: seeded.spaceId,
        sourceTextVersionId: seeded.textVersion._id,
        pages: [{ ordinal: 0, start: 0, end: 11, text: "alpha😀beta" }],
      }),
    );
    const [span] = await t.run((ctx) =>
      stageEvidenceSpans(ctx, {
        spaceId: seeded.spaceId,
        sourceRevisionId: seeded.revision._id,
        sourceTextVersionId: seeded.textVersion._id,
        spans: [{ sourcePageId: page!._id, ordinal: 0, start: 0, end: 5 }],
      }),
    );
    const [document] = await t.run((ctx) =>
      stageDocuments(ctx, {
        spaceId: seeded.spaceId,
        processingGenerationId: generationId,
        sourceItemId: seeded.item._id,
        sourceRevisionId: seeded.revision._id,
        sourceTextVersionId: seeded.textVersion._id,
        documents: [
          {
            documentKey: "main",
            title: "Synthetic document",
            docType: "note",
            capturedAt: 1_700_000_000_000,
            evidenceSpanIds: [span!._id],
          },
        ],
      }),
    );
    const [chunk] = await t.run((ctx) =>
      stageChunks(ctx, {
        spaceId: seeded.spaceId,
        processingGenerationId: generationId,
        chunks: [
          {
            documentId: document!._id,
            ordinal: 0,
            text: "alpha",
            evidenceSpanIds: [span!._id],
          },
        ],
      }),
    );
    expect(document!.publicationState).toBe("staged");
    expect(chunk!.publicationState).toBe("staged");
    await expect(
      t.run((ctx) =>
        inspectGenerationPayload(ctx, {
          spaceId: seeded.spaceId,
          processingGenerationId: generationId,
          sourceTextVersionId: seeded.textVersion._id,
          expectedPublicationState: "staged",
        }),
      ),
    ).resolves.toMatchObject({ pageOrdinals: [0], documentKeys: ["main"] });

    await t.run((ctx) => ctx.db.patch(chunk!._id, { ordinal: 1 }));
    await expect(
      t.run((ctx) =>
        inspectGenerationPayload(ctx, {
          spaceId: seeded.spaceId,
          processingGenerationId: generationId,
          sourceTextVersionId: seeded.textVersion._id,
          expectedPublicationState: "staged",
        }),
      ),
    ).rejects.toThrow("chunk ordinals must be contiguous");
    await t.run((ctx) => ctx.db.patch(chunk!._id, { ordinal: 0 }));

    const duplicateDocumentId = await t.run((ctx) =>
      ctx.db.insert("documents", {
        spaceId: seeded.spaceId,
        processingGenerationId: generationId,
        sourceItemId: seeded.item._id,
        sourceRevisionId: seeded.revision._id,
        sourceTextVersionId: seeded.textVersion._id,
        documentKey: "main",
        title: "Duplicate synthetic document",
        docType: "note",
        capturedAt: 1_700_000_000_000,
        evidenceSpanIds: [span!._id],
        publicationState: "staged",
      }),
    );
    await expect(
      t.run((ctx) =>
        inspectGenerationPayload(ctx, {
          spaceId: seeded.spaceId,
          processingGenerationId: generationId,
          sourceTextVersionId: seeded.textVersion._id,
          expectedPublicationState: "staged",
        }),
      ),
    ).rejects.toThrow("document keys must be unique");
    await t.run((ctx) => ctx.db.delete(duplicateDocumentId));

    await t.run((ctx) =>
      activateSourceItemGeneration(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.item._id,
        sourceRevisionId: seeded.revision._id,
        processingGenerationId: generationId,
        expectedPreviousGenerationId: undefined,
        expectedDesiredProcessingEpoch: desiredEpoch,
      }),
    );
    const activated = await t.run(async (ctx) => ({
      item: await ctx.db.get(seeded.item._id),
      document: await ctx.db.get(document!._id),
      chunk: await ctx.db.get(chunk!._id),
    }));
    expect(activated.item?.activeGenerationId).toBe(generationId);
    expect(activated.document?.publicationState).toBe("active");
    expect(activated.chunk?.publicationState).toBe("active");
    expect(
      await t.run((ctx) => ctx.db.get(seeded.textVersion._id)),
    ).toMatchObject({ evidenceSealed: true });

    await expect(
      t.run((ctx) =>
        stagePages(ctx, {
          spaceId: seeded.spaceId,
          sourceTextVersionId: seeded.textVersion._id,
          pages: [{ ordinal: 1, start: 0, end: 0, text: "" }],
        }),
      ),
    ).rejects.toThrow("use a new extraction fingerprint");

    await expect(
      t.run((ctx) =>
        stageChunks(ctx, {
          spaceId: seeded.spaceId,
          processingGenerationId: generationId,
          chunks: [
            {
              documentId: document!._id,
              ordinal: 0,
              text: "changed",
              evidenceSpanIds: [span!._id],
            },
          ],
        }),
      ),
    ).rejects.toThrow("Conflicting immutable chunk");
  });

  test("keeps retries from resurrecting unavailable sources and erases forgotten identity text", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedRevisionAndTextVersion(t);
    await t.run((ctx) =>
      markSourceItemUnavailable(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.item._id,
      }),
    );
    const retried = await t.run((ctx) =>
      createOrGetSourceItem(ctx, {
        spaceId: seeded.spaceId,
        sourceAccountId: seeded.sourceAccountId,
        externalId: "source://synthetic/😀",
        title: "Retry title",
        uri: "https://example.invalid/retry",
      }),
    );
    expect(retried.lifecycle).toBe("unavailable");
    expect(retried.title).toBe("Synthetic source");

    await t.run((ctx) =>
      refreshAvailableSourceItem(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.item._id,
        title: "Rediscovered",
        uri: "https://example.invalid/rediscovered",
      }),
    );
    await t.run((ctx) =>
      beginSourceItemForget(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.item._id,
        forgottenAt: 1_700_000_001_000,
        forgottenBy: seeded.userId,
      }),
    );
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await t.run((ctx) =>
        deleteSourceItemProvenanceBatch(ctx, {
          spaceId: seeded.spaceId,
          sourceItemId: seeded.item._id,
        }),
      );
      if (result.done) break;
    }
    await t.run((ctx) =>
      finalizeSourceItemTombstone(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.item._id,
      }),
    );
    const tombstone = await t.run((ctx) => ctx.db.get(seeded.item._id));
    expect(tombstone).toMatchObject({
      lifecycle: "forgotten",
      externalIdHash:
        "7e9e7e020daf03164bb59d15dba5664adf1d6daf0a8617beaae31cd7c555d4fa",
      sourceAccountId: seeded.sourceAccountId,
      spaceId: seeded.spaceId,
      forgottenBy: seeded.userId,
    });
    expect(tombstone?.externalId).toBeUndefined();
    expect(tombstone?.title).toBeUndefined();
    expect(tombstone?.uri).toBeUndefined();

    await expect(
      t.run((ctx) =>
        createOrGetSourceItem(ctx, {
          spaceId: seeded.spaceId,
          sourceAccountId: seeded.sourceAccountId,
          externalId: "source://synthetic/😀",
        }),
      ),
    ).rejects.toThrow("Source item is forgotten");
  });

  test("enforces per-call and source byte limits explicitly", async () => {
    const t = convexTest(schema, modules);
    const base = await seedSpaceAndAccount(t);
    const item = await t.run((ctx) =>
      createOrGetSourceItem(ctx, {
        spaceId: base.spaceId,
        sourceAccountId: base.sourceAccountId,
        externalId: "bounded-source",
      }),
    );
    await expect(
      t.run((ctx) =>
        createOrGetRevision(ctx, {
          spaceId: base.spaceId,
          sourceItemId: item._id,
          mediaType: "text/plain",
          inlineText: "x".repeat(65_537),
          capturedAt: 1,
          userId: base.userId,
        }),
      ),
    ).rejects.toThrow("65536 UTF-8 bytes");

    const seeded = await seedRevisionAndTextVersion(t, "x".repeat(26));
    await expect(
      t.run((ctx) =>
        stagePages(ctx, {
          spaceId: seeded.spaceId,
          sourceTextVersionId: seeded.textVersion._id,
          pages: Array.from({ length: 26 }, (_, ordinal) => ({
            ordinal,
            start: ordinal,
            end: ordinal + 1,
            text: "x",
          })),
        }),
      ),
    ).rejects.toThrow("per-call row limit of 25");
  });

  test("enforces the aggregate generation chunk byte budget across calls", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedRevisionAndTextVersion(t, "x");
    const desiredEpoch = await t.run((ctx) =>
      setDesiredSourceRevision(ctx, {
        spaceId: seeded.spaceId,
        sourceItemId: seeded.item._id,
        desiredRevisionId: seeded.revision._id,
        expectedDesiredProcessingEpoch: 0,
      }),
    );
    const generationId = await insertGeneration(
      t,
      seeded,
      desiredEpoch,
      "chunk-budget:v1",
    );
    const [document] = await t.run((ctx) =>
      stageDocuments(ctx, {
        spaceId: seeded.spaceId,
        processingGenerationId: generationId,
        sourceItemId: seeded.item._id,
        sourceRevisionId: seeded.revision._id,
        sourceTextVersionId: seeded.textVersion._id,
        documents: [
          {
            documentKey: "budget",
            title: "Chunk budget",
            docType: "note",
            capturedAt: 1,
            evidenceSpanIds: [],
          },
        ],
      }),
    );
    for (const startOrdinal of [0, 8]) {
      await t.run((ctx) =>
        stageChunks(ctx, {
          spaceId: seeded.spaceId,
          processingGenerationId: generationId,
          chunks: Array.from({ length: 8 }, (_, offset) => ({
            documentId: document!._id,
            ordinal: startOrdinal + offset,
            text: "x".repeat(16 * 1_024),
            evidenceSpanIds: [],
          })),
        }),
      );
    }
    await expect(
      t.run((ctx) =>
        stageChunks(ctx, {
          spaceId: seeded.spaceId,
          processingGenerationId: generationId,
          chunks: [
            {
              documentId: document!._id,
              ordinal: 16,
              text: "x",
              evidenceSpanIds: [],
            },
          ],
        }),
      ),
    ).rejects.toThrow("262144 chunk text bytes");
  });
});
