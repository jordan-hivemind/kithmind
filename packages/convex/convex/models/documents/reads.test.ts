import { createHash } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../../_generated/api";
import { beginForgetFromWeb, continueForgetFromWeb } from "../ingestion/model";
import {
  embeddingProfile,
  fingerprintEmbeddingConfig,
  loadEmbeddingConfig,
} from "../../lib/embeddingProvider";
import {
  activateEmbeddingGeneration,
  createEmbeddingGeneration,
  getActiveEmbeddingTarget,
  insertChunkEmbedding,
  stageEmbeddingGeneration,
} from "../embeddings/model";
import { inspectGenerationPayload } from "../provenance/model";
import {
  fuseDocumentCandidateRanks,
  getDocument,
  searchDocuments,
} from "./model";
import type { Id } from "../../_generated/dataModel";
import schema from "../../legacySchema";
import { modules } from "../../test.setup";

const mcpIssuer = "https://brain.example.test";
const webIssuer = "https://brain.example.test/convex";

test("document fusion favors strong semantic matches without overwhelming keyword agreement", () => {
  const semanticIds = [
    "semantic-only",
    ...Array.from({ length: 29 }, (_, index) => `semantic-filler-${index}`),
    "agreement-tail",
    "exact-keyword",
  ];
  const scores = fuseDocumentCandidateRanks(
    [
      { id: "keyword-only", rank: 0 },
      { id: "exact-keyword", rank: 1 },
      { id: "agreement-tail", rank: 128 },
    ],
    semanticIds.map((id, rank) => ({ id, rank })),
  );

  expect(scores.get("semantic-only")).toBeGreaterThan(
    scores.get("keyword-only")!,
  );
  expect(scores.get("semantic-only")).toBeGreaterThan(
    scores.get("agreement-tail")!,
  );
  expect(scores.get("exact-keyword")).toBeGreaterThan(
    scores.get("semantic-only")!,
  );
});

type Harness = ReturnType<typeof convexTest>;

async function seedIdentity(t: Harness) {
  return await t.run(async (ctx) => {
    const [userId, otherUserId] = await Promise.all([
      ctx.db.insert("users", { name: "Synthetic reader" }),
      ctx.db.insert("users", { name: "Synthetic other" }),
    ]);
    const [spaceId, otherSpaceId] = await Promise.all([
      ctx.db.insert("spaces", {
        kind: "personal",
        name: "Reader personal",
        createdBy: userId,
      }),
      ctx.db.insert("spaces", {
        kind: "personal",
        name: "Other personal",
        createdBy: otherUserId,
      }),
    ]);
    await Promise.all([
      ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" }),
      ctx.db.insert("spaceMembers", {
        spaceId: otherSpaceId,
        userId: otherUserId,
        role: "owner",
      }),
      ctx.db.insert("userSpaceSettings", { userId, personalSpaceId: spaceId }),
      ctx.db.insert("userSpaceSettings", {
        userId: otherUserId,
        personalSpaceId: otherSpaceId,
      }),
    ]);
    const [sourceAccountId, otherSourceAccountId] = await Promise.all([
      ctx.db.insert("sourceAccounts", {
        spaceId,
        connector: "synthetic",
        accountId: "reader",
        name: "Reader source",
        enabled: true,
        cursorVersion: 0,
        freshnessMs: 86_400_000,
        createdBy: userId,
      }),
      ctx.db.insert("sourceAccounts", {
        spaceId: otherSpaceId,
        connector: "synthetic",
        accountId: "other",
        name: "Other source",
        enabled: true,
        cursorVersion: 0,
        freshnessMs: 86_400_000,
        createdBy: otherUserId,
      }),
    ]);
    const keyId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "read-key-hash",
      keyPrefix: "ob_reader",
      name: "Reader key",
      capabilities: ["read"],
      spaceIds: [spaceId],
      sourceAccountIds: [],
    });
    return {
      userId,
      otherUserId,
      spaceId,
      otherSpaceId,
      sourceAccountId,
      otherSourceAccountId,
      keyId,
    };
  });
}

async function seedDocument(
  t: Harness,
  input: {
    spaceId: Id<"spaces">;
    sourceAccountId: Id<"sourceAccounts">;
    userId: Id<"users">;
    suffix: string;
    publicationState?: "staged" | "active" | "historical";
    lifecycle?: "available" | "unavailable" | "forgetting" | "forgotten";
    desiredEpoch?: number;
    generationEpoch?: number;
    chunkSpaceId?: Id<"spaces">;
    generationSourceAccountId?: Id<"sourceAccounts">;
    text?: string;
    chunkText?: string;
    extraChunkTexts?: string[];
    evidenceCount?: number;
    evidenceWholeText?: boolean;
  },
) {
  return await t.run(async (ctx) => {
    const publicationState = input.publicationState ?? "active";
    const lifecycle = input.lifecycle ?? "available";
    const text = input.text ?? `needle text ${input.suffix}`;
    const chunkText = input.chunkText ?? text;
    const evidenceCount = input.evidenceCount ?? 1;
    const evidenceEnd = input.evidenceWholeText ? text.length : 6;
    const chunkTexts = [chunkText, ...(input.extraChunkTexts ?? [])];
    const textBytes = new TextEncoder().encode(text).byteLength;
    const contentHash = createHash("sha256").update(text).digest("hex");
    const textHash = createHash("sha256").update(text).digest("hex");
    const pageTextHash = createHash("sha256").update(text).digest("hex");
    const itemId = await ctx.db.insert("sourceItems", {
      spaceId: input.spaceId,
      sourceAccountId: input.sourceAccountId,
      externalIdHash: `external-hash-${input.suffix}`,
      externalId: `external-${input.suffix}`,
      title: `Document ${input.suffix}`,
      docType: "note",
      uri: `file:///synthetic/${input.suffix}.txt`,
      lifecycle,
      originalLinkAvailable: lifecycle === "available",
      desiredProcessingEpoch: input.desiredEpoch ?? 1,
    });
    const revisionId = await ctx.db.insert("sourceRevisions", {
      spaceId: input.spaceId,
      sourceItemId: itemId,
      contentHash,
      byteLength: textBytes,
      mediaType: "text/plain",
      inlineText: text,
      capturedAt: 1_700_000_000_000,
      userId: input.userId,
    });
    const textVersionId = await ctx.db.insert("sourceTextVersions", {
      spaceId: input.spaceId,
      sourceRevisionId: revisionId,
      extractionFingerprint: `extract-${input.suffix}`,
      text,
      textHash,
      byteLength: textBytes,
      evidenceSealed: publicationState !== "staged",
    });
    const generationId = await ctx.db.insert("processingGenerations", {
      spaceId: input.spaceId,
      sourceAccountId: input.generationSourceAccountId ?? input.sourceAccountId,
      sourceItemId: itemId,
      sourceRevisionId: revisionId,
      sourceTextVersionId: textVersionId,
      processingFingerprint: `processing-${input.suffix}`,
      extractionFingerprint: `extract-${input.suffix}`,
      extractorFingerprint: "extractor-1",
      recordSchemaFingerprint: "records-1",
      normalizationFingerprint: "normalize-1",
      chunkerFingerprint: "chunker-1",
      correctionRevision: "0",
      desiredProcessingEpoch: input.generationEpoch ?? 1,
      state: publicationState === "staged" ? "staged" : "ready",
      expectedPageCount: 1,
      expectedEvidenceSpanCount: evidenceCount,
      expectedDocumentCount: 1,
      expectedChunkCount: chunkTexts.length,
      actualPageCount: 1,
      actualEvidenceSpanCount: evidenceCount,
      actualDocumentCount: 1,
      actualChunkCount: chunkTexts.length,
      embeddingStatus: "unavailable",
      ...(publicationState === "staged"
        ? {}
        : {
            activatedAt: 1_700_000_000_100,
            ...(publicationState === "historical"
              ? { deactivatedAt: 1_700_000_000_200 }
              : {}),
          }),
    });
    const pageId = await ctx.db.insert("sourcePages", {
      spaceId: input.spaceId,
      sourceTextVersionId: textVersionId,
      ordinal: 0,
      start: 0,
      end: text.length,
      text,
      textHash: pageTextHash,
    });
    const evidenceSpanIds: Id<"evidenceSpans">[] = [];
    const quoteHash = createHash("sha256")
      .update(text.slice(0, evidenceEnd))
      .digest("hex");
    for (let ordinal = 0; ordinal < evidenceCount; ordinal += 1) {
      evidenceSpanIds.push(
        await ctx.db.insert("evidenceSpans", {
          spaceId: input.spaceId,
          sourceRevisionId: revisionId,
          sourceTextVersionId: textVersionId,
          sourcePageId: pageId,
          ordinal,
          start: 0,
          end: evidenceEnd,
          quoteHash,
          locator: { kind: "page", label: "1" },
        }),
      );
    }
    const documentId = await ctx.db.insert("documents", {
      spaceId: input.spaceId,
      processingGenerationId: generationId,
      sourceItemId: itemId,
      sourceRevisionId: revisionId,
      sourceTextVersionId: textVersionId,
      documentKey: "main",
      title: `Document ${input.suffix}`,
      docType: "note",
      capturedAt: 1_700_000_000_000,
      evidenceSpanIds,
      publicationState,
    });
    const chunkIds = await Promise.all(
      chunkTexts.map((chunkText, ordinal) =>
        ctx.db.insert("chunks", {
          spaceId: input.chunkSpaceId ?? input.spaceId,
          processingGenerationId: generationId,
          documentId,
          ordinal,
          text: chunkText,
          evidenceSpanIds,
          publicationState,
        }),
      ),
    );
    await ctx.db.patch(itemId, {
      desiredRevisionId: revisionId,
      ...(publicationState === "active"
        ? { activeRevisionId: revisionId, activeGenerationId: generationId }
        : {}),
      ...(lifecycle === "forgotten"
        ? { forgottenAt: 1_700_000_000_300, forgottenBy: input.userId }
        : {}),
    });
    return {
      itemId,
      revisionId,
      textVersionId,
      generationId,
      pageId,
      evidenceSpanId: evidenceSpanIds[0]!,
      evidenceSpanIds,
      documentId,
      chunkId: chunkIds[0]!,
      chunkIds,
    };
  });
}

describe("document reads", () => {
  const originalIssuer = process.env.MCP_JWT_ISSUER;

  beforeEach(() => {
    process.env.MCP_JWT_ISSUER = mcpIssuer;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (originalIssuer === undefined) delete process.env.MCP_JWT_ISSUER;
    else process.env.MCP_JWT_ISSUER = originalIssuer;
  });

  test("scopes MCP search and observes key revocation", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedIdentity(t);
    const visible = await seedDocument(t, {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
      suffix: "visible",
    });
    await seedDocument(t, {
      spaceId: seeded.otherSpaceId,
      sourceAccountId: seeded.otherSourceAccountId,
      userId: seeded.otherUserId,
      suffix: "private",
    });
    const mcp = t.withIdentity({
      issuer: mcpIssuer,
      subject: seeded.userId,
      apiKeyId: seeded.keyId,
    });
    const result = await mcp.query(api.models.documents.mcpQueries.search, {
      query: "needle",
    });
    expect(result.results).toEqual([
      expect.objectContaining({ documentId: visible.documentId }),
    ]);
    await t.run((ctx) => ctx.db.delete(seeded.keyId));
    await expect(
      mcp.query(api.models.documents.mcpQueries.search, { query: "needle" }),
    ).rejects.toThrow("Not authenticated");
  });

  test("excludes staged, forgotten, mismatched-space and mismatched-account rows", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedIdentity(t);
    await seedDocument(t, {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
      suffix: "staged",
      publicationState: "staged",
    });
    await seedDocument(t, {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
      suffix: "forgotten",
      lifecycle: "forgotten",
    });
    await seedDocument(t, {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
      suffix: "bad-space",
      chunkSpaceId: seeded.otherSpaceId,
    });
    await seedDocument(t, {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
      suffix: "bad-account",
      generationSourceAccountId: seeded.otherSourceAccountId,
    });
    const web = t.withIdentity({ issuer: webIssuer, subject: seeded.userId });
    const result = await web.query(api.models.documents.public.search, {
      query: "needle",
    });
    expect(result.results).toEqual([]);
  });

  test("reads overlay the card's kind on the sealed document type", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedIdentity(t);
    const carded = await seedDocument(t, {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
      suffix: "carded",
    });
    // Section 4.2, P2-80i: card activation records the accepted `card_kind`
    // here, on the item, because `documents.docType` is inside the sealed
    // parsed payload's `documentDigest`. Reads overlay it so type filtering
    // and the card cannot disagree.
    await t.run((ctx) =>
      ctx.db.patch(carded.itemId, { cardDocType: "contract" }),
    );
    await expect(
      t.run((ctx) => getDocument(ctx, [seeded.spaceId], carded.documentId)),
    ).resolves.toMatchObject({ docType: "contract" });
    await expect(
      t.run((ctx) =>
        searchDocuments(ctx, [seeded.spaceId], {
          query: "needle",
          docType: "contract",
        }),
      ),
    ).resolves.toMatchObject({
      results: [
        expect.objectContaining({
          documentId: carded.documentId,
          docType: "contract",
        }),
      ],
    });
    // The parser's own type is no longer what the filter matches, and the row
    // the proof digests still carries it.
    await expect(
      t.run((ctx) =>
        searchDocuments(ctx, [seeded.spaceId], {
          query: "needle",
          docType: "note",
        }),
      ),
    ).resolves.toMatchObject({ results: [] });
    await expect(
      t.run(async (ctx) => (await ctx.db.get(carded.documentId))!.docType),
    ).resolves.toBe("note");
  });

  test("requires explicit historical access and labels same-revision reprocessing stale", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedIdentity(t);
    const historical = await seedDocument(t, {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
      suffix: "historical",
      publicationState: "historical",
    });
    const stale = await seedDocument(t, {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
      suffix: "stale",
      desiredEpoch: 2,
      generationEpoch: 1,
    });
    const web = t.withIdentity({ issuer: webIssuer, subject: seeded.userId });
    await expect(
      web.query(api.models.documents.public.get, {
        documentId: historical.documentId,
      }),
    ).resolves.toBeNull();
    const old = await web.query(api.models.documents.public.get, {
      documentId: historical.documentId,
      includeHistorical: true,
    });
    expect(old).toMatchObject({
      historical: true,
      contentStatus: "historical",
    });
    const current = await web.query(api.models.documents.public.get, {
      documentId: stale.documentId,
    });
    expect(current).toMatchObject({
      historical: false,
      contentStatus: "stale",
    });
  });

  test("semantic-only candidates do not receive a keyword vote", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedIdentity(t);
    const source = {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
    };
    const agreement = await seedDocument(t, {
      ...source,
      suffix: "agreement",
      text: "needle supporting evidence",
    });
    const semanticOnly = await seedDocument(t, {
      ...source,
      suffix: "semantic-only",
      text: "paraphrased supporting evidence",
    });
    const args = { query: "needle" };
    const keyword = await t.run((ctx) =>
      searchDocuments(ctx, [seeded.spaceId], args),
    );
    expect(keyword.results.map((result) => result.chunkId)).toEqual([
      agreement.chunkId,
    ]);
    const hybrid = await t.run((ctx) =>
      searchDocuments(ctx, [seeded.spaceId], args, {
        chunkIds: [semanticOnly.chunkId, agreement.chunkId],
        vectorStatus: "ready",
      }),
    );
    expect(hybrid.results.map((result) => result.chunkId)).toEqual([
      agreement.chunkId,
      semanticOnly.chunkId,
    ]);
  });

  test("a card candidate is a document-level hit carrying the card's summary and citations", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedIdentity(t);
    const source = {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
    };
    const keywordHit = await seedDocument(t, {
      ...source,
      suffix: "keyword",
      text: "needle supporting evidence",
    });
    // The card's document shares no keyword with the query, which is the
    // fifth question shape: find the document without recalling its words.
    const carded = await seedDocument(t, {
      ...source,
      suffix: "carded",
      text: "unrelated retained prose",
    });
    const cardGenerationId = await t.run((ctx) =>
      ctx.db.insert("processingGenerations", {
        spaceId: seeded.spaceId,
        sourceAccountId: seeded.sourceAccountId,
        sourceItemId: carded.itemId,
        sourceRevisionId: carded.revisionId,
        sourceTextVersionId: carded.textVersionId,
        processingFingerprint: "card-processing",
        extractionFingerprint: "extract-carded",
        extractorFingerprint: "extractor-1",
        recordSchemaFingerprint: "card-records-1",
        normalizationFingerprint: "normalize-1",
        chunkerFingerprint: "chunker-1",
        correctionRevision: "0",
        desiredProcessingEpoch: 1,
        cardGeneration: true,
        state: "ready",
        expectedPageCount: 0,
        expectedEvidenceSpanCount: 0,
        expectedDocumentCount: 0,
        expectedChunkCount: 0,
        expectedEventCount: 1,
        expectedObservationCount: 1,
        embeddingStatus: "unavailable",
        activatedAt: 1_700_000_000_400,
      }),
    );
    const args = { query: "needle" };
    const cardHit = {
      eventId: "synthetic" as unknown as Id<"events">,
      spaceId: seeded.spaceId,
      documentId: carded.documentId,
      cardGenerationId,
      summary: "a composed card summary for the carded document",
      evidenceSpanIds: carded.evidenceSpanIds,
    };

    const keywordOnly = await t.run((ctx) =>
      searchDocuments(ctx, [seeded.spaceId], args),
    );
    expect(keywordOnly.results.map((result) => result.documentId)).toEqual([
      keywordHit.documentId,
    ]);

    const hybrid = await t.run((ctx) =>
      searchDocuments(ctx, [seeded.spaceId], args, {
        chunkIds: [],
        cardHits: [cardHit],
        vectorStatus: "ready",
      }),
    );
    // The weighted fusion of PR89 puts a top semantic candidate above a
    // keyword-only one, and a card hit competes on that same curve.
    expect(hybrid.results.map((result) => result.documentId)).toEqual([
      carded.documentId,
      keywordHit.documentId,
    ]);
    const card = hybrid.results[0]!;
    // Document-level: no chunk row, the card summary as the passage, the card
    // generation as the evidence pointer.
    expect(card.chunkId).toBeUndefined();
    expect(card.snippet).toBe(cardHit.summary);
    expect(card.cardGenerationId).toBe(cardGenerationId);
    expect(card.cardEventId).toBe(cardHit.eventId);
    // Its citations resolve to the card's own evidence spans, over the same
    // sealed text version as the document.
    expect(card.citations.map((citation) => citation.evidenceSpanId)).toEqual(
      carded.evidenceSpanIds,
    );
    // The text generation still names the citation chain.
    expect(card.processingGenerationId).toBe(carded.generationId);
    expect(hybrid.vectorStatus).toBe("ready");
  });

  test("a card hit for a retired document is dropped rather than ranked", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedIdentity(t);
    const source = {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
    };
    const historical = await seedDocument(t, {
      ...source,
      suffix: "historical",
      text: "unrelated retained prose",
      publicationState: "historical",
    });
    const result = await t.run((ctx) =>
      searchDocuments(
        ctx,
        [seeded.spaceId],
        { query: "needle" },
        {
          chunkIds: [],
          cardHits: [
            {
              eventId: "synthetic" as unknown as Id<"events">,
              spaceId: seeded.spaceId,
              documentId: historical.documentId,
              cardGenerationId: historical.generationId,
              summary: "a card summary for a superseded document",
              evidenceSpanIds: historical.evidenceSpanIds,
            },
          ],
          vectorStatus: "ready",
        },
      ),
    );
    expect(result.results).toHaveLength(0);
  });

  test("does not let stale semantic IDs boost historical keyword candidates", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedIdentity(t);
    await seedDocument(t, {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
      suffix: "historical-fusion-first",
      publicationState: "historical",
    });
    await seedDocument(t, {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
      suffix: "historical-fusion-second",
      publicationState: "historical",
    });
    const args = {
      query: "needle",
      includeHistorical: true,
    };
    const keyword = await t.run((ctx) =>
      searchDocuments(ctx, [seeded.spaceId], args),
    );
    expect(keyword.results).toHaveLength(2);
    const staleSemanticId = keyword.results[1]!.chunkId!;

    const hybrid = await t.run((ctx) =>
      searchDocuments(ctx, [seeded.spaceId], args, {
        chunkIds: [staleSemanticId],
        vectorStatus: "ready",
      }),
    );

    expect(hybrid.results.map((result) => result.chunkId)).toEqual(
      keyword.results.map((result) => result.chunkId),
    );
  });

  test("returns retained evidence for unavailable originals and filters foreign evidence IDs", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedIdentity(t);
    const visible = await seedDocument(t, {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
      suffix: "unavailable",
      lifecycle: "unavailable",
    });
    const foreign = await seedDocument(t, {
      spaceId: seeded.otherSpaceId,
      sourceAccountId: seeded.otherSourceAccountId,
      userId: seeded.otherUserId,
      suffix: "foreign-evidence",
    });
    await t.run((ctx) =>
      ctx.db.patch(visible.documentId, {
        evidenceSpanIds: [visible.evidenceSpanId, foreign.evidenceSpanId],
      }),
    );
    const web = t.withIdentity({ issuer: webIssuer, subject: seeded.userId });
    const document = await web.query(api.models.documents.public.get, {
      documentId: visible.documentId,
    });
    expect(document).toMatchObject({
      sourceAvailability: "unavailable",
      originalLinkAvailable: false,
      retainedTextAvailable: true,
      originalUri: "file:///synthetic/unavailable.txt",
      evidenceSpanIds: [visible.evidenceSpanId],
      partial: true,
    });
    expect(document?.pages[0]?.evidence[0]).toMatchObject({
      evidenceSpanId: visible.evidenceSpanId,
      quote: "needle",
    });
  });

  test("bounds whole exact citation output across document and search reads", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedIdentity(t);
    const pageText = `needle "\nµ🙂\\${"x".repeat(65_000)}`;
    const chunkText = `needle ${"x".repeat(16_377)}`;
    const expectedQuoteHash = createHash("sha256")
      .update(pageText)
      .digest("hex");
    const first = await seedDocument(t, {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
      suffix: "large-0",
      text: pageText,
      chunkText,
      evidenceCount: 128,
      evidenceWholeText: true,
    });
    await expect(
      t.run((ctx) =>
        inspectGenerationPayload(ctx, {
          spaceId: seeded.spaceId,
          processingGenerationId: first.generationId,
          sourceTextVersionId: first.textVersionId,
          expectedPublicationState: "active",
        }),
      ),
    ).resolves.toMatchObject({ pageOrdinals: [0] });
    for (let index = 1; index < 25; index += 1) {
      await seedDocument(t, {
        spaceId: seeded.spaceId,
        sourceAccountId: seeded.sourceAccountId,
        userId: seeded.userId,
        suffix: `large-${index}`,
        text: pageText,
        chunkText,
        evidenceCount: 16,
        evidenceWholeText: true,
      });
    }
    const web = t.withIdentity({ issuer: webIssuer, subject: seeded.userId });
    const document = await web.query(api.models.documents.public.get, {
      documentId: first.documentId,
    });
    const search = await web.query(api.models.documents.public.search, {
      query: "needle",
      limit: 25,
    });
    const citationGroupBytes = (groups: unknown[][]) =>
      groups.reduce<number>(
        (total, group) =>
          total + new TextEncoder().encode(JSON.stringify(group)).byteLength,
        0,
      );
    const documentCitations =
      document?.pages.flatMap((page) => page.evidence) ?? [];
    const searchCitations = search.results.flatMap(
      (result) => result.citations,
    );

    expect(document?.partial).toBe(true);
    expect(documentCitations.length).toBeGreaterThan(0);
    expect(documentCitations.length).toBeLessThan(128);
    expect(citationGroupBytes([documentCitations])).toBeLessThanOrEqual(
      256 * 1024,
    );
    expect(search.results).toHaveLength(25);
    expect(search.partial).toBe(true);
    expect(search.results.some((result) => result.citationsTruncated)).toBe(
      true,
    );
    expect(
      search.results.some(
        (result) =>
          result.documentId !== first.documentId &&
          result.citationsTruncated &&
          result.citations.length < 16,
      ),
    ).toBe(true);
    expect(searchCitations.length).toBeLessThan(25 * 16);
    expect(
      citationGroupBytes(search.results.map((result) => result.citations)),
    ).toBeLessThanOrEqual(256 * 1024);
    for (const citation of [...documentCitations, ...searchCitations]) {
      expect(citation.quote).toBe(pageText);
      expect(citation.quoteHash).toBe(expectedQuoteHash);
    }
    expect(JSON.stringify(documentCitations[0])).toContain("\\n");
  });

  test("keeps small exact citations and existing completion flags", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedIdentity(t);
    const visible = await seedDocument(t, {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
      suffix: "small-output",
    });
    const web = t.withIdentity({ issuer: webIssuer, subject: seeded.userId });
    const document = await web.query(api.models.documents.public.get, {
      documentId: visible.documentId,
    });
    const search = await web.query(api.models.documents.public.search, {
      query: "needle",
    });
    expect(document).toMatchObject({ partial: false });
    expect(document?.pages[0]?.evidence).toEqual([
      expect.objectContaining({ quote: "needle" }),
    ]);
    expect(search).toMatchObject({ partial: false });
    expect(search.results[0]).toMatchObject({ citationsTruncated: false });
    expect(search.results[0]?.citations[0]).toMatchObject({ quote: "needle" });
  });

  test("keyword mode bypasses embedding fetch with ready vector targets", async () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-openai-key");
    for (const name of [
      "BRAIN_EMBED_ENDPOINT",
      "BRAIN_EMBED_PROVIDER_ID",
      "BRAIN_EMBED_MODEL",
      "BRAIN_EMBED_MODEL_REVISION",
      "BRAIN_EMBED_DIMENSIONS",
      "BRAIN_EMBED_API_KEY",
    ]) {
      vi.stubEnv(name, "");
    }
    const t = convexTest(schema, modules);
    const seeded = await seedIdentity(t);
    const visible = await seedDocument(t, {
      spaceId: seeded.spaceId,
      sourceAccountId: seeded.sourceAccountId,
      userId: seeded.userId,
      suffix: "keyword-provider-free",
    });
    const config = loadEmbeddingConfig({});
    const profile = embeddingProfile(config);
    const fingerprint = await fingerprintEmbeddingConfig(profile);
    await t.run(async (ctx) => {
      const generation = await createEmbeddingGeneration(ctx, {
        spaceId: seeded.spaceId,
        profile,
        fingerprint,
        createdAt: 1,
      });
      await insertChunkEmbedding(ctx, {
        spaceId: seeded.spaceId,
        chunkId: visible.chunkId,
        embeddingGenerationId: generation._id,
        fingerprint,
        inputText: "needle text keyword-provider-free",
        vector: Array(1536).fill(0.1),
      });
      await stageEmbeddingGeneration(ctx, {
        embeddingGenerationId: generation._id,
        stagedAt: 2,
      });
      await activateEmbeddingGeneration(ctx, {
        embeddingGenerationId: generation._id,
        activatedAt: 3,
      });
    });
    let embeddingFetches = 0;
    vi.stubGlobal("fetch", async () => {
      embeddingFetches += 1;
      throw new Error("Embedding provider must not be called");
    });
    const mcp = t.withIdentity({
      issuer: mcpIssuer,
      subject: seeded.userId,
      apiKeyId: seeded.keyId,
    });

    const result = await mcp.action(api.models.documents.mcpActions.search, {
      query: "needle",
      searchMode: "keyword",
    });

    expect(embeddingFetches).toBe(0);
    expect(result.vectorStatus).toBe("unavailable");
    expect(result.results).toEqual([
      expect.objectContaining({ documentId: visible.documentId }),
    ]);
  });
});

test("semantic document hydration preserves evidence and rechecks profile, source and credentials", async () => {
  const t = convexTest(schema, modules);
  const seeded = await seedIdentity(t);
  const visible = await seedDocument(t, {
    spaceId: seeded.spaceId,
    sourceAccountId: seeded.sourceAccountId,
    userId: seeded.userId,
    suffix: "semantic",
  });
  const config = loadEmbeddingConfig({});
  const profile = embeddingProfile(config);
  const fingerprint = await fingerprintEmbeddingConfig(profile);
  const canonical = await t.run(async (ctx) => {
    const generation = await createEmbeddingGeneration(ctx, {
      spaceId: seeded.spaceId,
      profile,
      fingerprint,
      createdAt: 1,
    });
    const vectorId = await insertChunkEmbedding(ctx, {
      spaceId: seeded.spaceId,
      chunkId: visible.chunkId,
      embeddingGenerationId: generation._id,
      fingerprint,
      inputText: "needle text semantic",
      vector: Array(1536).fill(0.1),
    });
    await stageEmbeddingGeneration(ctx, {
      embeddingGenerationId: generation._id,
      stagedAt: 2,
    });
    await activateEmbeddingGeneration(ctx, {
      embeddingGenerationId: generation._id,
      activatedAt: 3,
    });
    return { generationId: generation._id, vectorId };
  });
  const args = {
    principal: { userId: seeded.userId, credentialId: seeded.keyId },
    spaceIds: [seeded.spaceId],
    query: "unrelatedsynonym",
    targets: [
      {
        spaceId: seeded.spaceId,
        embeddingGenerationId: canonical.generationId,
        fingerprint,
      },
    ],
    embeddingVectorIds: [canonical.vectorId],
  };
  const result = await t.query(
    internal.models.documents.private.searchWithCandidates,
    args,
  );
  expect(result.vectorStatus).toBe("ready");
  expect(result.results.map((row) => row.documentId)).toEqual([
    visible.documentId,
  ]);
  expect(result.results[0]?.citations[0]?.quote).toBe("needle");
  const incompatible = await t.query(
    internal.models.documents.private.searchWithCandidates,
    {
      ...args,
      query: "needle",
      targets: [{ ...args.targets[0]!, fingerprint: "different" }],
    },
  );
  expect(incompatible.vectorStatus).toBe("unavailable");
  expect(incompatible.results.map((row) => row.documentId)).toEqual([
    visible.documentId,
  ]);
  const keywordOnly = await t.query(
    internal.models.documents.private.searchWithCandidates,
    {
      ...args,
      query: "needle",
      searchMode: "keyword",
    },
  );
  expect(keywordOnly.vectorStatus).toBe("unavailable");
  expect(keywordOnly.results.map((row) => row.documentId)).toEqual([
    visible.documentId,
  ]);
  await t.run((ctx) =>
    beginForgetFromWeb(ctx, {
      principal: { userId: seeded.userId },
      sourceItemId: visible.itemId,
      now: Date.now(),
    }),
  );
  expect(
    (
      await t.query(
        internal.models.documents.private.searchWithCandidates,
        args,
      )
    ).results,
  ).toEqual([]);
  let forgotten = false;
  for (let attempt = 0; attempt < 20 && !forgotten; attempt += 1) {
    const batch = await t.run((ctx) =>
      continueForgetFromWeb(ctx, {
        principal: { userId: seeded.userId },
        sourceItemId: visible.itemId,
      }),
    );
    expect(batch.deleted).toBeLessThanOrEqual(25);
    forgotten = batch.done;
  }
  expect(forgotten).toBe(true);
  // Forget retires the targets it removed, so coverage is complete again.
  const afterForget = await t.run((ctx) =>
    getActiveEmbeddingTarget(ctx, seeded.spaceId),
  );
  expect(afterForget!.chunkCoverage.covered).toBe(
    afterForget!.chunkCoverage.eligible,
  );
  expect(await t.run((ctx) => ctx.db.get(canonical.vectorId))).toBeNull();
  await t.run((ctx) => ctx.db.delete(seeded.keyId));
  await expect(
    t.query(internal.models.documents.private.searchWithCandidates, args),
  ).rejects.toThrow();
});

test("search keeps three ranked passages per document while preserving later documents", async () => {
  const t = convexTest(schema, modules);
  const seeded = await seedIdentity(t);
  const first = await seedDocument(t, {
    spaceId: seeded.spaceId,
    sourceAccountId: seeded.sourceAccountId,
    userId: seeded.userId,
    suffix: "passage-limit-first",
    extraChunkTexts: [
      "later passage one",
      "later passage two",
      "later passage three",
    ],
  });
  const second = await seedDocument(t, {
    spaceId: seeded.spaceId,
    sourceAccountId: seeded.sourceAccountId,
    userId: seeded.userId,
    suffix: "passage-limit-second",
  });
  const third = await seedDocument(t, {
    spaceId: seeded.spaceId,
    sourceAccountId: seeded.sourceAccountId,
    userId: seeded.userId,
    suffix: "passage-limit-third",
  });
  const config = loadEmbeddingConfig({});
  const profile = embeddingProfile(config);
  const fingerprint = await fingerprintEmbeddingConfig(profile);
  const vectors = await t.run(async (ctx) => {
    const generation = await createEmbeddingGeneration(ctx, {
      spaceId: seeded.spaceId,
      profile,
      fingerprint,
      createdAt: 1,
    });
    const vectorIds = [];
    for (const chunkId of [
      ...first.chunkIds,
      ...second.chunkIds,
      ...third.chunkIds,
    ]) {
      const chunk = await ctx.db.get(chunkId);
      if (!chunk) throw new Error("synthetic chunk missing");
      vectorIds.push(
        await insertChunkEmbedding(ctx, {
          spaceId: seeded.spaceId,
          chunkId,
          embeddingGenerationId: generation._id,
          fingerprint,
          inputText: chunk.text,
          vector: Array(1536).fill(0.1),
        }),
      );
    }
    await stageEmbeddingGeneration(ctx, {
      embeddingGenerationId: generation._id,
      stagedAt: 2,
    });
    await activateEmbeddingGeneration(ctx, {
      embeddingGenerationId: generation._id,
      activatedAt: 3,
    });
    return { generationId: generation._id, vectorIds };
  });
  const result = await t.query(
    internal.models.documents.private.searchWithCandidates,
    {
      principal: { userId: seeded.userId, credentialId: seeded.keyId },
      spaceIds: [seeded.spaceId],
      query: "unrelated semantic passage",
      limit: 4,
      targets: [
        {
          spaceId: seeded.spaceId,
          embeddingGenerationId: vectors.generationId,
          fingerprint,
        },
      ],
      embeddingVectorIds: vectors.vectorIds,
    },
  );
  expect(result.results).toHaveLength(4);
  expect(result.results.map((row) => row.chunkId)).toEqual([
    ...first.chunkIds.slice(0, 3),
    second.chunkId,
  ]);
  expect(
    result.results.filter((row) => row.documentId === first.documentId),
  ).toHaveLength(3);
  expect(result.results.some((row) => row.chunkId === first.chunkIds[3])).toBe(
    false,
  );
  expect(
    result.results.some((row) => row.documentId === second.documentId),
  ).toBe(true);
  expect(result.truncated).toBe(true);
});
