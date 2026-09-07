import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../legacySchema";
import { modules } from "../../test.setup";
import { calculateCoverage } from "./model";

type Harness = ReturnType<typeof convexTest>;

async function seedCoverageAccount(t: Harness) {
  return await t.run(async (ctx) => {
    const [userId, otherUserId] = await Promise.all([
      ctx.db.insert("users", { name: "Synthetic owner" }),
      ctx.db.insert("users", { name: "Synthetic other" }),
    ]);
    const [spaceId, otherSpaceId] = await Promise.all([
      ctx.db.insert("spaces", {
        kind: "personal",
        name: "Owner personal",
        createdBy: userId,
      }),
      ctx.db.insert("spaces", {
        kind: "personal",
        name: "Other personal",
        createdBy: otherUserId,
      }),
    ]);
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "synthetic",
      accountId: "coverage",
      name: "Coverage source",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 1_000,
      createdBy: userId,
    });
    const entityId = await ctx.db.insert("entities", {
      userId,
      spaceId,
      key: "person:synthetic",
      kind: "person",
      canonicalName: "Synthetic Person",
      normalizedName: "synthetic person",
      aliases: [],
      normalizedAliases: [],
    });
    const foreignEntityId = await ctx.db.insert("entities", {
      userId: otherUserId,
      spaceId: otherSpaceId,
      key: "person:foreign",
      kind: "person",
      canonicalName: "Foreign Person",
      normalizedName: "foreign person",
      aliases: [],
      normalizedAliases: [],
    });
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
    return {
      userId,
      spaceId,
      otherSpaceId,
      sourceAccountId,
      entityId,
      foreignEntityId,
    };
  });
}

async function insertCompleteWindow(
  t: Harness,
  input: {
    spaceId: Id<"spaces">;
    sourceAccountId: Id<"sourceAccounts">;
    from?: number;
    to?: number;
    at?: number;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("coverageWindows", {
      spaceId: input.spaceId,
      sourceAccountId: input.sourceAccountId,
      recordType: "lab_result",
      from: input.from ?? 0,
      to: input.to ?? 100,
      state: "complete",
      lastEnumeratedAt: input.at ?? 10_000,
      lastProcessedAt: input.at ?? 10_000,
      discoveredCount: 1,
      indexedCount: 1,
      skippedCount: 0,
    }),
  );
}

async function insertPendingJob(
  t: Harness,
  input: {
    userId: Id<"users">;
    spaceId: Id<"spaces">;
    sourceAccountId: Id<"sourceAccounts">;
  },
) {
  return await t.run(async (ctx) => {
    const sourceItemId = await ctx.db.insert("sourceItems", {
      spaceId: input.spaceId,
      sourceAccountId: input.sourceAccountId,
      externalIdHash: "pending-external",
      externalId: "pending",
      lifecycle: "available",
      originalLinkAvailable: false,
      desiredProcessingEpoch: 1,
    });
    const sourceRevisionId = await ctx.db.insert("sourceRevisions", {
      spaceId: input.spaceId,
      sourceItemId,
      contentHash: "pending-content",
      byteLength: 7,
      mediaType: "text/plain",
      inlineText: "pending",
      capturedAt: 10_000,
      userId: input.userId,
    });
    const generationId = await ctx.db.insert("processingGenerations", {
      spaceId: input.spaceId,
      sourceAccountId: input.sourceAccountId,
      sourceItemId,
      sourceRevisionId,
      processingFingerprint: "pending-processing",
      extractionFingerprint: "extract-1",
      extractorFingerprint: "extractor-1",
      recordSchemaFingerprint: "records-1",
      normalizationFingerprint: "normalize-1",
      chunkerFingerprint: "chunker-1",
      correctionRevision: "0",
      desiredProcessingEpoch: 1,
      state: "queued",
      expectedPageCount: 1,
      expectedEvidenceSpanCount: 1,
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
      embeddingStatus: "unavailable",
    });
    await ctx.db.patch(sourceItemId, {
      desiredRevisionId: sourceRevisionId,
    });
    await ctx.db.insert("ingestJobs", {
      spaceId: input.spaceId,
      sourceAccountId: input.sourceAccountId,
      sourceItemId,
      sourceRevisionId,
      processingGenerationId: generationId,
      admittedByUserId: input.userId,
      actorUserId: input.userId,
      desiredProcessingEpoch: 1,
      state: "queued",
      attempts: 0,
      leaseEpoch: 0,
    });
    return { sourceItemId, sourceRevisionId };
  });
}

describe("coverage calculation", () => {
  test("requires fresh complete windows and treats future timestamps as stale", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedCoverageAccount(t);
    const windowId = await insertCompleteWindow(t, seeded);
    const complete = await t.run((ctx) =>
      calculateCoverage(ctx, {
        sourceAccountIds: [seeded.sourceAccountId],
        recordType: "lab_result",
        from: 0,
        to: 100,
        asOf: 10_500,
      }),
    );
    expect(complete).toMatchObject({
      state: "complete",
      pendingJobs: 0,
      failedJobs: 0,
      overflow: false,
    });
    await t.run((ctx) =>
      ctx.db.patch(windowId, {
        lastEnumeratedAt: 11_000,
        lastProcessedAt: 11_000,
      }),
    );
    const futureDated = await t.run((ctx) =>
      calculateCoverage(ctx, {
        sourceAccountIds: [seeded.sourceAccountId],
        recordType: "lab_result",
        from: 0,
        to: 100,
        asOf: 10_500,
      }),
    );
    expect(futureDated.state).toBe("stale");
  });

  test("an entity-specific gap invalidates all-entity coverage", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedCoverageAccount(t);
    await insertCompleteWindow(t, seeded);
    await t.run((ctx) =>
      ctx.db.insert("coverageGaps", {
        spaceId: seeded.spaceId,
        sourceAccountId: seeded.sourceAccountId,
        recordType: "lab_result",
        entityId: seeded.entityId,
        from: 20,
        to: 30,
        reason: "Provider omitted one panel",
        detectedAt: 10_000,
        status: "open",
      }),
    );
    const coverage = await t.run((ctx) =>
      calculateCoverage(ctx, {
        sourceAccountIds: [seeded.sourceAccountId],
        recordType: "lab_result",
        from: 0,
        to: 100,
        asOf: 10_500,
      }),
    );
    expect(coverage.state).toBe("partial");
    expect(coverage.knownGaps).toEqual([
      expect.objectContaining({ reason: "Provider omitted one panel" }),
    ]);
  });

  test("a forget invalidation makes older complete windows stale", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedCoverageAccount(t);
    await insertCompleteWindow(t, seeded);
    await t.run((ctx) =>
      ctx.db.patch(seeded.sourceAccountId, { coverageInvalidatedAt: 10_001 }),
    );
    const coverage = await t.run((ctx) =>
      calculateCoverage(ctx, {
        sourceAccountIds: [seeded.sourceAccountId],
        recordType: "lab_result",
        from: 0,
        to: 100,
        asOf: 10_500,
      }),
    );
    expect(coverage.state).toBe("stale");
  });

  test("pending work blocks completeness and foreign-entity reasons are suppressed", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedCoverageAccount(t);
    await insertCompleteWindow(t, seeded);
    const currentJob = await insertPendingJob(t, seeded);
    await t.run(async (ctx) => {
      const oldRevisionId = await ctx.db.insert("sourceRevisions", {
        spaceId: seeded.spaceId,
        sourceItemId: currentJob.sourceItemId,
        contentHash: "old-content",
        byteLength: 3,
        mediaType: "text/plain",
        inlineText: "old",
        capturedAt: 9_000,
        userId: seeded.userId,
      });
      const oldGenerationId = await ctx.db.insert("processingGenerations", {
        spaceId: seeded.spaceId,
        sourceAccountId: seeded.sourceAccountId,
        sourceItemId: currentJob.sourceItemId,
        sourceRevisionId: oldRevisionId,
        processingFingerprint: "old-processing",
        extractionFingerprint: "old-extract",
        extractorFingerprint: "extractor-1",
        recordSchemaFingerprint: "records-1",
        normalizationFingerprint: "normalize-1",
        chunkerFingerprint: "chunker-1",
        correctionRevision: "0",
        desiredProcessingEpoch: 0,
        state: "failed",
        expectedPageCount: 1,
        expectedEvidenceSpanCount: 1,
        expectedDocumentCount: 1,
        expectedChunkCount: 1,
        embeddingStatus: "unavailable",
      });
      await ctx.db.insert("ingestJobs", {
        spaceId: seeded.spaceId,
        sourceAccountId: seeded.sourceAccountId,
        sourceItemId: currentJob.sourceItemId,
        sourceRevisionId: oldRevisionId,
        processingGenerationId: oldGenerationId,
        admittedByUserId: seeded.userId,
        actorUserId: seeded.userId,
        desiredProcessingEpoch: 0,
        state: "failed",
        attempts: 1,
        leaseEpoch: 1,
      });
    });
    await t.run((ctx) =>
      ctx.db.insert("coverageGaps", {
        spaceId: seeded.spaceId,
        sourceAccountId: seeded.sourceAccountId,
        recordType: "lab_result",
        entityId: seeded.foreignEntityId,
        reason: "private cross-space reason",
        detectedAt: 10_000,
        status: "open",
      }),
    );
    const coverage = await t.run((ctx) =>
      calculateCoverage(ctx, {
        sourceAccountIds: [seeded.sourceAccountId],
        recordType: "lab_result",
        from: 0,
        to: 100,
        asOf: 10_500,
      }),
    );
    expect(coverage).toMatchObject({
      state: "partial",
      pendingJobs: 1,
      failedJobs: 0,
    });
    expect(coverage.knownGaps).toEqual([]);
    const web = t.withIdentity({
      issuer: "https://brain.example.test/convex",
      subject: seeded.userId,
    });
    const sources = await web.query(api.models.documents.public.listSources, {
      sourceAccountId: seeded.sourceAccountId,
    });
    expect(sources.partial).toBe(true);
    expect(sources.sources[0]?.gaps).toEqual([]);
  });

  test("reports bounded overflow as partial instead of complete", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedCoverageAccount(t);
    await t.run(async (ctx) => {
      for (let index = 0; index < 129; index += 1) {
        await ctx.db.insert("coverageWindows", {
          spaceId: seeded.spaceId,
          sourceAccountId: seeded.sourceAccountId,
          recordType: "lab_result",
          from: index,
          to: index + 1,
          state: "complete",
          lastEnumeratedAt: 10_000,
          lastProcessedAt: 10_000,
          discoveredCount: 0,
          indexedCount: 0,
          skippedCount: 0,
        });
      }
    });
    const coverage = await t.run((ctx) =>
      calculateCoverage(ctx, {
        sourceAccountIds: [seeded.sourceAccountId],
        recordType: "lab_result",
        from: 0,
        to: 100,
        asOf: 10_500,
      }),
    );
    expect(coverage).toMatchObject({ state: "partial", overflow: true });
  });
});
