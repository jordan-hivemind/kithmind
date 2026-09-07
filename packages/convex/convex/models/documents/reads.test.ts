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
import type { Id } from "../../_generated/dataModel";
import schema from "../../legacySchema";
import { modules } from "../../test.setup";

const mcpIssuer = "https://brain.example.test";
const webIssuer = "https://brain.example.test/convex";

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
  },
) {
  return await t.run(async (ctx) => {
    const publicationState = input.publicationState ?? "active";
    const lifecycle = input.lifecycle ?? "available";
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
      contentHash: `content-hash-${input.suffix}`,
      byteLength: 24,
      mediaType: "text/plain",
      inlineText: `needle text ${input.suffix}`,
      capturedAt: 1_700_000_000_000,
      userId: input.userId,
    });
    const textVersionId = await ctx.db.insert("sourceTextVersions", {
      spaceId: input.spaceId,
      sourceRevisionId: revisionId,
      extractionFingerprint: `extract-${input.suffix}`,
      text: `needle text ${input.suffix}`,
      textHash: `text-hash-${input.suffix}`,
      byteLength: 24,
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
      expectedEvidenceSpanCount: 1,
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
      actualPageCount: 1,
      actualEvidenceSpanCount: 1,
      actualDocumentCount: 1,
      actualChunkCount: 1,
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
      end: `needle text ${input.suffix}`.length,
      text: `needle text ${input.suffix}`,
      textHash: `page-hash-${input.suffix}`,
    });
    const evidenceSpanId = await ctx.db.insert("evidenceSpans", {
      spaceId: input.spaceId,
      sourceRevisionId: revisionId,
      sourceTextVersionId: textVersionId,
      sourcePageId: pageId,
      ordinal: 0,
      start: 0,
      end: 6,
      quoteHash: `quote-hash-${input.suffix}`,
      locator: { kind: "page", label: "1" },
    });
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
      evidenceSpanIds: [evidenceSpanId],
      publicationState,
    });
    const chunkId = await ctx.db.insert("chunks", {
      spaceId: input.chunkSpaceId ?? input.spaceId,
      processingGenerationId: generationId,
      documentId,
      ordinal: 0,
      text: `needle text ${input.suffix}`,
      evidenceSpanIds: [evidenceSpanId],
      publicationState,
    });
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
      evidenceSpanId,
      documentId,
      chunkId,
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
    expect(result.results.map((row) => row.documentId)).toEqual([
      visible.documentId,
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
  expect(
    await t.run((ctx) => getActiveEmbeddingTarget(ctx, seeded.spaceId)),
  ).toMatchObject({ chunkStatus: "ready" });
  expect(await t.run((ctx) => ctx.db.get(canonical.vectorId))).toBeNull();
  await t.run((ctx) => ctx.db.delete(seeded.keyId));
  await expect(
    t.query(internal.models.documents.private.searchWithCandidates, args),
  ).rejects.toThrow();
});
