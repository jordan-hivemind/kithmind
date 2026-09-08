import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import type { MutationCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { beginForgetFromWeb, continueForgetFromWeb } from "../ingestion/model";
import { finalizeSourceItemTombstone } from "../provenance/model";
import { repairForgottenProcessingStatePage } from "./migrations";

async function seed(
  options: {
    lifecycle?: "available" | "forgetting" | "forgotten";
    binaryReceiptCount?: number;
    includeStage?: boolean;
    includeManifest?: boolean;
    jobState?: "queued" | "processing" | "staged" | "ready" | "failed";
    retireAt?: number;
  },
  t = convexTest(schema, modules),
) {
  const ids = await t.run(async (ctx: MutationCtx) => {
    const userId = await ctx.db.insert("users", { name: "Cleanup owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Cleanup",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "fs",
      accountId: crypto.randomUUID(),
      name: "Cleanup source",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: userId,
    });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "a".repeat(64),
      keyPrefix: "cleanup",
      name: "Cleanup worker",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    const lifecycle = options.lifecycle ?? "available";
    const sourceItemId = await ctx.db.insert("sourceItems", {
      spaceId,
      sourceAccountId,
      externalIdHash: "b".repeat(64),
      lifecycle,
      originalLinkAvailable: lifecycle === "available",
      desiredProcessingEpoch: 1,
      ...(lifecycle === "forgetting" || lifecycle === "forgotten"
        ? {
            forgottenAt: 1,
            forgottenBy: userId,
            archiveDeletionForgetEpoch: 1,
            archiveDeletionReceiptCount: 0,
            archiveDeletionCompletedAt: 1,
          }
        : {}),
    });
    const scanId = await ctx.db.insert("workerSourceScans", {
      spaceId,
      sourceAccountId,
      requestId: crypto.randomUUID(),
      requestDigest: "c".repeat(64),
      watcherId: "cleanup",
      connectorVersion: "v1",
      mode: "normal",
      inventoryEpoch: 0,
      manifestVersionAtBegin: 0,
      actorUserId: userId,
      actorCredentialId: credentialId,
      state: "enumerated",
      nextPageOrdinal: 0,
      nextReconcileOrdinal: 0,
      inventoryDone: true,
      pageCount: 0,
      entryCount: 0,
      changedCount: 0,
      gapCount: 0,
      reviewCount: 0,
      startedAt: 0,
      completedAt: 0,
      expiresAt: 0,
      retireAt: 0,
    });
    const pageId = await ctx.db.insert("workerScanPages", {
      spaceId,
      sourceAccountId,
      scanId,
      ordinal: 0,
      requestId: crypto.randomUUID(),
      requestDigest: "d".repeat(64),
      entryCount: 1,
      createdAt: 0,
      retireAt: 0,
    });
    const entryId = await ctx.db.insert("workerScanEntries", {
      spaceId,
      sourceAccountId,
      scanId,
      scanPageId: pageId,
      sourceItemId,
      identityKeyHash: "e".repeat(64),
      uriDigest: "f".repeat(64),
      inventoryMetadataDigest: "1".repeat(64),
      sourceModifiedAt: 0,
      state: "queued",
      observedAt: 0,
      retireAt: 0,
    });
    const workId = await ctx.db.insert("workerDiscoveryWork", {
      spaceId,
      sourceAccountId,
      sourceItemId,
      scanId,
      scanEntryId: entryId,
      observationEpoch: 1,
      processingEpoch: 1,
      state: "admitted",
      contentHash: "2".repeat(64),
      byteLength: 1,
      capturedAt: 0,
      sourceModifiedAt: 0,
      mediaType: "application/pdf",
      profileId: "pdf_docqa_v1",
      contentRepresentation: "archived_binary_v1",
      extractionFingerprint: "3".repeat(64),
      extractorFingerprint: "4".repeat(64),
      recordSchemaFingerprint: "5".repeat(64),
      normalizationFingerprint: "6".repeat(64),
      chunkerFingerprint: "7".repeat(64),
      uri: "fs://cleanup.pdf",
      actorUserId: userId,
      actorCredentialId: credentialId,
      attempts: 0,
      leaseEpoch: 1,
      createdAt: 0,
      retireAt: 0,
    });
    const revisionId = await ctx.db.insert("sourceRevisions", {
      spaceId,
      sourceItemId,
      contentHash: "8".repeat(64),
      byteLength: 1,
      mediaType: "application/pdf",
      capturedAt: 0,
      userId,
    });
    const parserArtifactId = await ctx.db.insert("sourceParserArtifacts", {
      spaceId,
      sourceAccountId,
      sourceItemId,
      sourceRevisionId: revisionId,
      clientArtifactId: crypto.randomUUID(),
      parserFingerprint: "9".repeat(64),
      outputHash: "a".repeat(64),
      outputByteLength: 1,
      outputMediaType: "application/vnd.docling+json",
      hashAuthority: "worker_asserted",
      userId,
      actorCredentialId: credentialId,
      createdAt: 0,
    });
    const textVersionId = await ctx.db.insert("sourceTextVersions", {
      spaceId,
      sourceRevisionId: revisionId,
      extractionFingerprint: "b".repeat(64),
      representation: "parsed_pages_v1",
      textHash: "c".repeat(64),
      byteLength: 0,
      utf16Length: 0,
      pageCount: 0,
      mappingManifestHash: "d".repeat(64),
      parserArtifactId,
      evidenceSealed: true,
    });
    const generationId = await ctx.db.insert("processingGenerations", {
      spaceId,
      sourceAccountId,
      sourceItemId,
      sourceRevisionId: revisionId,
      sourceTextVersionId: textVersionId,
      parserArtifactId,
      processingFingerprint: "e".repeat(64),
      extractionFingerprint: "f".repeat(64),
      extractorFingerprint: "1".repeat(64),
      recordSchemaFingerprint: "2".repeat(64),
      normalizationFingerprint: "3".repeat(64),
      chunkerFingerprint: "4".repeat(64),
      correctionRevision: "v1",
      desiredProcessingEpoch: 1,
      state: options.jobState ?? "ready",
      expectedPageCount: 0,
      expectedEvidenceSpanCount: 0,
      expectedDocumentCount: 0,
      expectedChunkCount: 0,
      embeddingStatus: "ready",
    });
    const jobId = await ctx.db.insert("ingestJobs", {
      spaceId,
      sourceAccountId,
      sourceItemId,
      sourceRevisionId: revisionId,
      processingGenerationId: generationId,
      admittedByUserId: userId,
      admittedByCredentialId: credentialId,
      actorUserId: userId,
      actorCredentialId: credentialId,
      desiredProcessingEpoch: 1,
      state: options.jobState ?? "ready",
      attempts: 1,
      leaseEpoch: 1,
      workerManaged: true,
      workerDiscoveryWorkId: workId,
      workerObservationEpoch: 1,
      workerProcessingMode: "parsed_pages_v1",
    });
    await ctx.db.patch(workId, {
      ingestJobId: jobId,
      sourceRevisionId: revisionId,
      processingGenerationId: generationId,
    });
    let stageId;
    if (options.includeStage) {
      stageId = await ctx.db.insert("workerParsedStages", {
        spaceId,
        sourceAccountId,
        sourceItemId,
        discoveryWorkId: workId,
        ingestJobId: jobId,
        processingGenerationId: generationId,
        sourceRevisionId: revisionId,
        sourceTextVersionId: textVersionId,
        parserArtifactId,
        archiveSetDigest: "5".repeat(64),
        normalizedBundleDigest: "6".repeat(64),
        mappingManifestHash: "7".repeat(64),
        phase: "staged",
        nextOrdinal: 0,
        expectedPageCount: 0,
        expectedEvidenceSpanCount: 0,
        expectedDocumentCount: 0,
        expectedChunkCount: 0,
        acceptedPageCount: 0,
        acceptedEvidenceSpanCount: 0,
        acceptedDocumentCount: 0,
        acceptedChunkCount: 0,
        pageIds: [],
        evidenceSpanIds: [],
        documentIds: [],
        chunkIds: [],
        pageBytes: 0,
        evidenceBytes: 0,
        documentBytes: 0,
        chunkBytes: 0,
        createdAt: 0,
        updatedAt: 0,
        retireAt: options.retireAt ?? 0,
      });
    }
    if (options.includeManifest) {
      await ctx.db.insert("processingGenerationPayloadManifests", {
        spaceId,
        sourceAccountId,
        sourceItemId,
        sourceRevisionId: revisionId,
        sourceTextVersionId: textVersionId,
        parserArtifactId,
        processingGenerationId: generationId,
        archiveSetDigest: "5".repeat(64),
        normalizedBundleDigest: "6".repeat(64),
        mappingManifestHash: "7".repeat(64),
        pageIds: [],
        evidenceSpanIds: [],
        documentIds: [],
        chunkIds: [],
        pageCount: 0,
        evidenceSpanCount: 0,
        documentCount: 0,
        chunkCount: 0,
        pageBytes: 0,
        evidenceBytes: 0,
        documentBytes: 0,
        chunkBytes: 0,
        pageDigest: "8".repeat(64),
        evidenceDigest: "9".repeat(64),
        documentDigest: "a".repeat(64),
        chunkDigest: "b".repeat(64),
        retainedTextHash: "c".repeat(64),
        retainedTextUtf8Length: 0,
        retainedTextUtf16Length: 0,
        manifestVersion: "parsed_payload_v1",
        createdAt: 0,
      });
    }
    for (let index = 0; index < (options.binaryReceiptCount ?? 0); index += 1) {
      await ctx.db.insert("workerBinaryOperationReceipts", {
        spaceId,
        sourceAccountId,
        sourceItemId,
        discoveryWorkId: workId,
        operation: "job_stage_parsed_seal",
        phase: "completed",
        requestId: `receipt-${index}`,
        requestDigest: `${index}`.padStart(64, "0"),
        actorUserId: userId,
        actorCredentialId: credentialId,
        leaseEpoch: 1,
        leaseTokenHash: "d".repeat(64),
        sourceRevisionId: revisionId,
        parserArtifactId,
        sourceTextVersionId: textVersionId,
        processingGenerationId: generationId,
        ingestJobId: jobId,
        desiredProcessingEpoch: 1,
        ...(stageId ? { stageId } : {}),
        createdAt: 0,
        retireAt: options.retireAt ?? 0,
      });
    }
    return {
      userId,
      spaceId,
      sourceAccountId,
      sourceItemId,
      jobId,
      stageId,
    };
  });
  return { t, ...ids };
}

async function runForget(f: Awaited<ReturnType<typeof seed>>) {
  await f.t.run((ctx) =>
    beginForgetFromWeb(ctx, {
      principal: { userId: f.userId },
      sourceItemId: f.sourceItemId,
      now: 10,
    }),
  );
  const results: Array<{ phase: string; deleted: number; done: boolean }> = [];
  for (let index = 0; index < 40; index += 1) {
    const result = await f.t.run((ctx) =>
      continueForgetFromWeb(ctx, {
        principal: { userId: f.userId },
        sourceItemId: f.sourceItemId,
      }),
    );
    results.push(result);
    if (result.done) return results;
  }
  throw new Error("Forget did not complete");
}

describe("forgotten parsed processing cleanup", () => {
  test("full forget removes receipts, stages, and payload manifests", async () => {
    const f = await seed({
      binaryReceiptCount: 26,
      includeStage: true,
      includeManifest: true,
    });
    const results = await runForget(f);
    expect(results.map((result) => result.phase)).toEqual(
      expect.arrayContaining([
        "workerBinaryOperationReceipts",
        "workerParsedStages",
        "processingGenerationPayloadManifests",
      ]),
    );
    expect(
      results
        .filter((result) => result.phase === "workerBinaryOperationReceipts")
        .map((result) => result.deleted),
    ).toEqual([25, 1]);
    expect(results.every((result) => result.deleted <= 25)).toBe(true);
    await f.t.run(async (ctx) => {
      expect((await ctx.db.get(f.sourceItemId))?.lifecycle).toBe("forgotten");
      expect(
        await ctx.db.query("workerBinaryOperationReceipts").collect(),
      ).toEqual([]);
      expect(await ctx.db.query("workerParsedStages").collect()).toEqual([]);
      expect(
        await ctx.db.query("processingGenerationPayloadManifests").collect(),
      ).toEqual([]);
    });
  });

  test("repair is dry-run by default, bounded across tables, scoped, and resumable", async () => {
    const target = await seed({
      lifecycle: "forgotten",
      binaryReceiptCount: 26,
      includeStage: true,
      includeManifest: true,
    });
    const unrelated = await seed(
      {
        lifecycle: "forgotten",
        binaryReceiptCount: 1,
        includeStage: true,
        includeManifest: true,
      },
      target.t,
    );
    const beforeDefaultDryRun = await target.t.run(async (ctx) => ({
      receipts: await ctx.db
        .query("workerBinaryOperationReceipts")
        .withIndex("by_sourceItemId", (q) =>
          q.eq("sourceItemId", target.sourceItemId),
        )
        .collect(),
      stages: await ctx.db
        .query("workerParsedStages")
        .withIndex("by_sourceItemId", (q) =>
          q.eq("sourceItemId", target.sourceItemId),
        )
        .collect(),
      manifests: await ctx.db
        .query("processingGenerationPayloadManifests")
        .withIndex("by_sourceItemId", (q) =>
          q.eq("sourceItemId", target.sourceItemId),
        )
        .collect(),
    }));
    const dry = await target.t.mutation(
      internal.models.workers.migrations.repairForgottenProcessingState,
      { sourceItemId: target.sourceItemId },
    );
    expect(
      await target.t.run(async (ctx) => ({
        receipts: await ctx.db
          .query("workerBinaryOperationReceipts")
          .withIndex("by_sourceItemId", (q) =>
            q.eq("sourceItemId", target.sourceItemId),
          )
          .collect(),
        stages: await ctx.db
          .query("workerParsedStages")
          .withIndex("by_sourceItemId", (q) =>
            q.eq("sourceItemId", target.sourceItemId),
          )
          .collect(),
        manifests: await ctx.db
          .query("processingGenerationPayloadManifests")
          .withIndex("by_sourceItemId", (q) =>
            q.eq("sourceItemId", target.sourceItemId),
          )
          .collect(),
      })),
    ).toEqual(beforeDefaultDryRun);
    expect(dry).toMatchObject({
      dryRun: true,
      phase: "workerBinaryOperationReceipts",
      affected: 25,
      deleted: 0,
      done: false,
      counts: { workerBinaryOperationReceipts: 25 },
    });
    const malformedId = await target.t.run(async (ctx) => {
      const rows = await ctx.db
        .query("workerBinaryOperationReceipts")
        .withIndex("by_sourceItemId", (q) =>
          q.eq("sourceItemId", target.sourceItemId),
        )
        .take(2);
      const row = rows[1]!;
      await ctx.db.patch(row._id, {
        sourceAccountId: unrelated.sourceAccountId,
      });
      return row._id;
    });
    await expect(
      target.t.mutation(
        internal.models.workers.migrations.repairForgottenProcessingState,
        { sourceItemId: target.sourceItemId, dryRun: false },
      ),
    ).rejects.toThrow("Forgotten processing row parent chain is invalid");
    expect(
      await target.t.run((ctx) =>
        ctx.db
          .query("workerBinaryOperationReceipts")
          .withIndex("by_sourceItemId", (q) =>
            q.eq("sourceItemId", target.sourceItemId),
          )
          .collect(),
      ),
    ).toHaveLength(26);
    await target.t.run((ctx) =>
      ctx.db.patch(malformedId, { sourceAccountId: target.sourceAccountId }),
    );
    const first = await target.t.run((ctx) =>
      repairForgottenProcessingStatePage(ctx, {
        sourceItemId: target.sourceItemId,
        dryRun: false,
      }),
    );
    expect(first).toMatchObject({ affected: 25, deleted: 25, done: false });
    const second = await target.t.run((ctx) =>
      repairForgottenProcessingStatePage(ctx, {
        sourceItemId: target.sourceItemId,
        dryRun: false,
      }),
    );
    expect(second).toMatchObject({
      affected: 3,
      deleted: 3,
      done: true,
      counts: {
        workerBinaryOperationReceipts: 1,
        workerParsedStages: 1,
        processingGenerationPayloadManifests: 1,
      },
    });
    expect(
      await target.t.run((ctx) =>
        repairForgottenProcessingStatePage(ctx, {
          sourceItemId: target.sourceItemId,
          dryRun: false,
        }),
      ),
    ).toMatchObject({ phase: "complete", affected: 0, deleted: 0, done: true });
    await target.t.run(async (ctx) => {
      expect(
        await ctx.db
          .query("workerBinaryOperationReceipts")
          .withIndex("by_sourceItemId", (q) =>
            q.eq("sourceItemId", unrelated.sourceItemId),
          )
          .collect(),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("workerParsedStages")
          .withIndex("by_sourceItemId", (q) =>
            q.eq("sourceItemId", unrelated.sourceItemId),
          )
          .collect(),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("processingGenerationPayloadManifests")
          .withIndex("by_sourceItemId", (q) =>
            q.eq("sourceItemId", unrelated.sourceItemId),
          )
          .collect(),
      ).toHaveLength(1);
    });
  });

  test("the tombstone finalizer rejects each isolated residual table", async () => {
    for (const residual of ["receipt", "stage", "manifest"] as const) {
      const f = await seed({
        lifecycle: "forgetting",
        binaryReceiptCount: residual === "receipt" ? 1 : 0,
        includeStage: residual === "stage",
        includeManifest: residual === "manifest",
      });
      await f.t.run(async (ctx) => {
        for (const revision of await ctx.db.query("sourceRevisions").collect())
          await ctx.db.delete(revision._id);
        for (const generation of await ctx.db
          .query("processingGenerations")
          .collect())
          await ctx.db.delete(generation._id);
        for (const job of await ctx.db.query("ingestJobs").collect())
          await ctx.db.delete(job._id);
      });
      await expect(
        f.t.run((ctx) =>
          finalizeSourceItemTombstone(ctx, {
            spaceId: f.spaceId,
            sourceItemId: f.sourceItemId,
          }),
        ),
      ).rejects.toThrow("Source item provenance cleanup is incomplete");
    }
  });

  test("expired terminal stages wait for their latest receipt replay window", async () => {
    const future = Date.now() + 60_000;
    const f = await seed({
      binaryReceiptCount: 1,
      includeStage: true,
      includeManifest: true,
      jobState: "ready",
      retireAt: future,
    });
    await f.t.run((ctx) => ctx.db.patch(f.stageId!, { retireAt: 0 }));
    for (let index = 0; index < 25; index += 1)
      await f.t.mutation(internal.models.workers.cleanup.removeExpired, {});
    expect(await f.t.run((ctx) => ctx.db.get(f.stageId!))).not.toBeNull();
    await f.t.run(async (ctx) => {
      const receipt = (await ctx.db
        .query("workerBinaryOperationReceipts")
        .first())!;
      await ctx.db.patch(receipt._id, { retireAt: 0 });
    });
    for (let index = 0; index < 25; index += 1)
      await f.t.mutation(internal.models.workers.cleanup.removeExpired, {});
    expect(await f.t.run((ctx) => ctx.db.get(f.stageId!))).toBeNull();
    expect(
      await f.t.run((ctx) =>
        ctx.db.query("processingGenerationPayloadManifests").collect(),
      ),
    ).toHaveLength(1);
  });

  test("expired stages keep coherent live jobs and unknown parents", async () => {
    const live = await seed({ includeStage: true, jobState: "processing" });
    for (let index = 0; index < 25; index += 1)
      await live.t.mutation(internal.models.workers.cleanup.removeExpired, {});
    expect(await live.t.run((ctx) => ctx.db.get(live.stageId!))).not.toBeNull();
    await live.t.run((ctx) => ctx.db.delete(live.jobId));
    for (let index = 0; index < 25; index += 1)
      await live.t.mutation(internal.models.workers.cleanup.removeExpired, {});
    expect(await live.t.run((ctx) => ctx.db.get(live.stageId!))).not.toBeNull();
  });
});
