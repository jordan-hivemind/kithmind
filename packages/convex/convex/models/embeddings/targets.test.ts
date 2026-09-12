import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  BASELINE_EMBEDDING_DIMENSIONS,
  fingerprintEmbeddingConfig,
} from "../../lib/embeddingProvider";
import { sha256Hex } from "../ingestion/hash";
import { insertChunkEmbedding, deleteChunkEmbeddingVectors } from "./model";
import { BASELINE_EMBEDDING_PROFILE } from "./migrations";
import { embeddingVectorScopeV2, ZERO_KIND_COUNTS } from "./targets";

const metadata = {
  type: "reference" as const,
  topics: [],
  people: [],
  actionItems: [],
  summary: "Synthetic memory",
};

const vector = Array.from(
  { length: BASELINE_EMBEDDING_DIMENSIONS },
  (_, index) => (index % 7) + 1,
);

type Seeded = Awaited<ReturnType<typeof seedSpace>>;

type BuildPage = {
  accepted: boolean;
  phase: string;
  cursor: string | null;
  scanned: number;
  isDone: boolean;
  counterDrift: boolean;
  scheduled: boolean;
};

async function seedSpace() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Synthetic owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Synthetic personal",
      createdBy: userId,
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "synthetic",
      accountId: "capacity",
      name: "Synthetic source",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: userId,
    });
    const sourceItemId = await ctx.db.insert("sourceItems", {
      spaceId,
      sourceAccountId,
      externalIdHash: "external-hash",
      externalId: "external-id",
      lifecycle: "available",
      originalLinkAvailable: false,
      desiredProcessingEpoch: 1,
    });
    const sourceRevisionId = await ctx.db.insert("sourceRevisions", {
      spaceId,
      sourceItemId,
      contentHash: "content-hash",
      byteLength: 12,
      mediaType: "text/plain",
      inlineText: "chunk source",
      capturedAt: 1,
      userId,
    });
    const sourceTextVersionId = await ctx.db.insert("sourceTextVersions", {
      spaceId,
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
        spaceId,
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
      spaceId,
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
    await ctx.db.patch(sourceItemId, {
      desiredRevisionId: sourceRevisionId,
      activeRevisionId: sourceRevisionId,
      activeGenerationId: processingGenerationId,
    });
    await ctx.db.insert("spaceEmbeddingStates", {
      spaceId,
      eligibilityEpoch: 0,
    });
    return { userId, spaceId, documentId, processingGenerationId };
  });
  return { t, ...ids };
}

async function addChunks(
  seeded: Seeded,
  count: number,
  offset = 0,
): Promise<Id<"chunks">[]> {
  const ids: Id<"chunks">[] = [];
  const pageSize = 500;
  for (let start = 0; start < count; start += pageSize) {
    const page = await seeded.t.run(async (ctx) => {
      const created: Id<"chunks">[] = [];
      for (let i = start; i < Math.min(start + pageSize, count); i += 1) {
        created.push(
          await ctx.db.insert("chunks", {
            spaceId: seeded.spaceId,
            processingGenerationId: seeded.processingGenerationId,
            documentId: seeded.documentId,
            ordinal: offset + i,
            text: `synthetic chunk ${offset + i}`,
            evidenceSpanIds: [],
            publicationState: "active",
          }),
        );
      }
      return created;
    });
    ids.push(...page);
  }
  return ids;
}

async function addThought(seeded: Seeded, content: string) {
  return await seeded.t.run((ctx) =>
    ctx.db.insert("thoughts", {
      userId: seeded.userId,
      spaceId: seeded.spaceId,
      content,
      embedding: vector,
      metadata,
      memoryStatus: "current" as const,
    }),
  );
}

/** Recomputes the counters straight from the target table. */
async function recount(seeded: Seeded, fingerprint: string) {
  return await seeded.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("embeddingTargets")
      .withIndex("by_space_kind_target", (q) => q.eq("spaceId", seeded.spaceId))
      .collect();
    const eligible = { ...ZERO_KIND_COUNTS };
    const covered = { ...ZERO_KIND_COUNTS };
    for (const row of rows) {
      if (row.state !== "eligible") continue;
      eligible[row.targetKind] += 1;
      if (row.coveredFingerprint === fingerprint) covered[row.targetKind] += 1;
    }
    return { eligible, covered, rows: rows.length };
  });
}

async function storedCounters(seeded: Seeded, fingerprint: string) {
  return await seeded.t.run(async (ctx) => {
    const state = await ctx.db
      .query("spaceEmbeddingStates")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
      .unique();
    return {
      eligible: state?.eligibleCounts ?? { ...ZERO_KIND_COUNTS },
      covered: state?.coveredCounts?.find(
        (entry) => entry.fingerprint === fingerprint,
      )?.counts ?? { ...ZERO_KIND_COUNTS },
      counterDrift: state?.counterDrift ?? false,
      lastAuditAt: state?.lastAuditAt,
    };
  });
}

/** Drives a job to completion one page at a time, like an operator would. */
async function drive(
  seeded: Seeded,
  jobId: Id<"embeddingBuildJobs">,
  options: { batchSize?: number; now?: number } = {},
) {
  let cursor: string | null = null;
  let pages = 0;
  let now = options.now ?? 1_000;
  const phases: string[] = [];
  for (;;) {
    const page: BuildPage = await seeded.t.mutation(
      internal.models.embeddings.migrations.runTargetBackfillPage,
      { jobId, cursor, batchSize: options.batchSize, now },
    );
    expect(page.accepted).toBe(true);
    phases.push(page.phase);
    cursor = page.cursor;
    pages += 1;
    now += 1;
    if (page.isDone) return { pages, phases, counterDrift: page.counterDrift };
    expect(pages).toBeLessThan(500);
  }
}

async function baselineFingerprint() {
  return await fingerprintEmbeddingConfig(BASELINE_EMBEDDING_PROFILE);
}

describe("embedding target table and resumable builder", () => {
  test("grows to 5,000 synthetic targets inside per-page budgets", async () => {
    const seeded = await seedSpace();
    const fingerprint = await baselineFingerprint();
    await addChunks(seeded, 5_000);

    const started = await seeded.t.mutation(
      internal.models.embeddings.migrations.startTargetBackfill,
      { spaceId: seeded.spaceId, fingerprint, dryRun: true, now: 1 },
    );
    expect(started).toMatchObject({ dryRun: true, existingTargetRows: 0 });
    expect(
      await seeded.t.run((ctx) => ctx.db.query("embeddingBuildJobs").collect()),
    ).toHaveLength(0);

    const job = await seeded.t.mutation(
      internal.models.embeddings.migrations.startTargetBackfill,
      { spaceId: seeded.spaceId, fingerprint, now: 1 },
    );
    const jobId = job.jobId!;
    const run = await drive(seeded, jobId, { batchSize: 128 });

    expect(run.phases).toContain("scan");
    expect(run.phases).toContain("fill");
    expect(run.phases).toContain("audit");
    expect(run.phases.at(-1)).toBe("done");
    // 5,000 chunks at 128 a page is at least 40 scan pages; page count is
    // evidence the build never tried the whole space in one transaction.
    expect(run.pages).toBeGreaterThan(40);
    expect(run.counterDrift).toBe(false);

    const stored = await storedCounters(seeded, fingerprint);
    const recounted = await recount(seeded, fingerprint);
    expect(stored.eligible).toEqual({ thought: 0, chunk: 5_000, card: 0 });
    expect(stored.eligible).toEqual(recounted.eligible);
    expect(stored.covered).toEqual(recounted.covered);
    expect(stored.counterDrift).toBe(false);

    // The one-shot audit is honest about a corpus it cannot finish in one
    // transaction; the paged audit phase above is the scalable path.
    const bounded = await seeded.t.mutation(
      internal.models.embeddings.migrations.auditSpaceCoverage,
      { spaceId: seeded.spaceId, fingerprint, maxRows: 1_000, now: 9 },
    );
    expect(bounded.complete).toBe(false);
  }, 120_000);

  test("resumes at every page boundary and refuses a stale cursor", async () => {
    const seeded = await seedSpace();
    const fingerprint = await baselineFingerprint();
    await addChunks(seeded, 200);
    await addThought(seeded, "a thought target");

    const job = await seeded.t.mutation(
      internal.models.embeddings.migrations.startTargetBackfill,
      { spaceId: seeded.spaceId, fingerprint, now: 1 },
    );
    const jobId = job.jobId!;

    let cursor: string | null = null;
    let previous: string | null = null;
    let now = 100;
    let boundaries = 0;
    for (;;) {
      const page: BuildPage = await seeded.t.mutation(
        internal.models.embeddings.migrations.runTargetBackfillPage,
        { jobId, cursor, batchSize: 32, now },
      );
      expect(page.accepted).toBe(true);
      boundaries += 1;

      // A duplicate call with the cursor of the page that just committed is
      // refused and writes nothing.
      if (previous !== null || cursor !== page.cursor) {
        const before = await seeded.t.run(async (ctx) => ({
          job: await ctx.db.get(jobId),
          targets: (
            await ctx.db
              .query("embeddingTargets")
              .withIndex("by_space_kind_target", (q) =>
                q.eq("spaceId", seeded.spaceId),
              )
              .collect()
          ).length,
          state: await ctx.db
            .query("spaceEmbeddingStates")
            .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
            .unique(),
        }));
        const stale: BuildPage = await seeded.t.mutation(
          internal.models.embeddings.migrations.runTargetBackfillPage,
          { jobId, cursor, batchSize: 32, now: now + 1 },
        );
        if (stale.cursor !== page.cursor) expect(stale.accepted).toBe(false);
        const after = await seeded.t.run(async (ctx) => ({
          job: await ctx.db.get(jobId),
          targets: (
            await ctx.db
              .query("embeddingTargets")
              .withIndex("by_space_kind_target", (q) =>
                q.eq("spaceId", seeded.spaceId),
              )
              .collect()
          ).length,
          state: await ctx.db
            .query("spaceEmbeddingStates")
            .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
            .unique(),
        }));
        if (stale.cursor !== page.cursor) expect(after).toEqual(before);
      }

      previous = cursor;
      cursor = page.cursor;
      now += 2;
      if (page.isDone) break;
    }
    expect(boundaries).toBeGreaterThan(6);

    const first = await storedCounters(seeded, fingerprint);
    expect(first.eligible).toEqual({ thought: 1, chunk: 200, card: 0 });
    expect(first.counterDrift).toBe(false);

    // A second complete run from scratch reaches the same final state.
    const second = await seeded.t.mutation(
      internal.models.embeddings.migrations.startTargetBackfill,
      { spaceId: seeded.spaceId, fingerprint, now: 500 },
    );
    expect(second.reused).toBe(false);
    await drive(seeded, second.jobId!, { batchSize: 32, now: 600 });
    expect(await storedCounters(seeded, fingerprint)).toMatchObject({
      eligible: first.eligible,
      counterDrift: false,
    });
    expect((await recount(seeded, fingerprint)).eligible).toEqual(
      first.eligible,
    );
  }, 60_000);

  test("start is idempotent while a job is open", async () => {
    const seeded = await seedSpace();
    const fingerprint = await baselineFingerprint();
    await addChunks(seeded, 10);
    const first = await seeded.t.mutation(
      internal.models.embeddings.migrations.startTargetBackfill,
      { spaceId: seeded.spaceId, fingerprint, now: 1 },
    );
    const second = await seeded.t.mutation(
      internal.models.embeddings.migrations.startTargetBackfill,
      { spaceId: seeded.spaceId, fingerprint, now: 2 },
    );
    expect(second).toMatchObject({ reused: true, jobId: first.jobId });
    expect(
      await seeded.t.run((ctx) => ctx.db.query("embeddingBuildJobs").collect()),
    ).toHaveLength(1);
  });

  test("counters stay exact across interleaved eligibility writes", async () => {
    const seeded = await seedSpace();
    const fingerprint = await baselineFingerprint();
    const chunkIds = await addChunks(seeded, 120);

    const job = await seeded.t.mutation(
      internal.models.embeddings.migrations.startTargetBackfill,
      { spaceId: seeded.spaceId, fingerprint, now: 1 },
    );
    const jobId = job.jobId!;

    // Interleave eligibility writes between pages of the running build.
    let cursor: string | null = null;
    let now = 10;
    let pages = 0;
    for (;;) {
      const page: BuildPage = await seeded.t.mutation(
        internal.models.embeddings.migrations.runTargetBackfillPage,
        { jobId, cursor, batchSize: 16, now },
      );
      cursor = page.cursor;
      now += 1;
      pages += 1;
      if (pages === 2) {
        await addChunks(seeded, 5, 1_000);
        await seeded.t.run(async (ctx) => {
          await ctx.db.patch(chunkIds[0]!, {
            publicationState: "historical" as const,
          });
        });
      }
      if (pages === 4) await addThought(seeded, "late thought");
      if (page.isDone) break;
    }

    // A second full run converges on the live set and retires what left it.
    const second = await seeded.t.mutation(
      internal.models.embeddings.migrations.startTargetBackfill,
      { spaceId: seeded.spaceId, fingerprint, now: 400 },
    );
    await drive(seeded, second.jobId!, { batchSize: 16, now: 500 });

    const stored = await storedCounters(seeded, fingerprint);
    const recounted = await recount(seeded, fingerprint);
    expect(stored.eligible).toEqual(recounted.eligible);
    expect(stored.eligible).toEqual({ thought: 1, chunk: 124, card: 0 });
    expect(stored.counterDrift).toBe(false);

    const audit = await seeded.t.mutation(
      internal.models.embeddings.migrations.auditSpaceCoverage,
      { spaceId: seeded.spaceId, fingerprint, now: 900 },
    );
    expect(audit).toMatchObject({ complete: true, counterDrift: false });
    expect(audit.recountedEligible).toEqual(stored.eligible);
  }, 60_000);

  test("audit detects a deliberately corrupted counter and can repair it", async () => {
    const seeded = await seedSpace();
    const fingerprint = await baselineFingerprint();
    await addChunks(seeded, 12);
    const job = await seeded.t.mutation(
      internal.models.embeddings.migrations.startTargetBackfill,
      { spaceId: seeded.spaceId, fingerprint, now: 1 },
    );
    await drive(seeded, job.jobId!, { batchSize: 8 });

    await seeded.t.run(async (ctx) => {
      const state = await ctx.db
        .query("spaceEmbeddingStates")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .unique();
      await ctx.db.patch(state!._id, {
        eligibleCounts: { thought: 0, chunk: 11, card: 0 },
      });
    });

    const detected = await seeded.t.mutation(
      internal.models.embeddings.migrations.auditSpaceCoverage,
      { spaceId: seeded.spaceId, fingerprint, now: 700 },
    );
    expect(detected).toMatchObject({
      complete: true,
      counterDrift: true,
      repaired: false,
    });
    expect(detected.recountedEligible).toEqual({
      thought: 0,
      chunk: 12,
      card: 0,
    });
    expect(detected.storedEligible).toEqual({ thought: 0, chunk: 11, card: 0 });
    expect((await storedCounters(seeded, fingerprint)).counterDrift).toBe(true);

    const repaired = await seeded.t.mutation(
      internal.models.embeddings.migrations.auditSpaceCoverage,
      { spaceId: seeded.spaceId, fingerprint, repair: true, now: 800 },
    );
    expect(repaired).toMatchObject({ counterDrift: true, repaired: true });
    expect(await storedCounters(seeded, fingerprint)).toMatchObject({
      counterDrift: false,
      eligible: { thought: 0, chunk: 12, card: 0 },
    });
  });

  test("a vector insert and delete move the covered counters in their own transaction", async () => {
    const seeded = await seedSpace();
    const fingerprint = await baselineFingerprint();
    const chunkIds = await addChunks(seeded, 3);
    const job = await seeded.t.mutation(
      internal.models.embeddings.migrations.startTargetBackfill,
      { spaceId: seeded.spaceId, fingerprint, now: 1 },
    );
    await drive(seeded, job.jobId!, { batchSize: 8 });
    expect((await storedCounters(seeded, fingerprint)).covered).toEqual({
      thought: 0,
      chunk: 0,
      card: 0,
    });

    const generationId = await seeded.t.run(async (ctx) => {
      const profileId = await ctx.db.insert("embeddingProfiles", {
        fingerprint,
        ...BASELINE_EMBEDDING_PROFILE,
        createdAt: 1,
      });
      return await ctx.db.insert("embeddingGenerations", {
        spaceId: seeded.spaceId,
        embeddingProfileId: profileId,
        fingerprint,
        state: "staging" as const,
        eligibilityEpoch: 0,
        manifestHash: "unused",
        expectedThoughtCount: 0,
        expectedChunkCount: 3,
        completedThoughtCount: 0,
        completedChunkCount: 0,
        createdAt: 1,
      });
    });

    await seeded.t.run(async (ctx) => {
      await insertChunkEmbedding(ctx, {
        spaceId: seeded.spaceId,
        chunkId: chunkIds[0]!,
        embeddingGenerationId: generationId,
        fingerprint,
        inputText: "synthetic chunk 0",
        vector,
      });
    });
    expect((await storedCounters(seeded, fingerprint)).covered).toEqual({
      thought: 0,
      chunk: 1,
      card: 0,
    });
    expect(
      await seeded.t.run(async (ctx) => {
        const row = await ctx.db
          .query("embeddingVectors")
          .withIndex("by_chunkId", (q) => q.eq("chunkId", chunkIds[0]!))
          .unique();
        return row?.scopeV2;
      }),
    ).toBe(
      embeddingVectorScopeV2({
        spaceId: seeded.spaceId,
        fingerprint,
        targetKind: "chunk",
      }),
    );

    await seeded.t.run(async (ctx) => {
      await deleteChunkEmbeddingVectors(ctx, {
        spaceId: seeded.spaceId,
        chunkId: chunkIds[0]!,
      });
    });
    expect((await storedCounters(seeded, fingerprint)).covered).toEqual({
      thought: 0,
      chunk: 0,
      card: 0,
    });

    const audit = await seeded.t.mutation(
      internal.models.embeddings.migrations.auditSpaceCoverage,
      { spaceId: seeded.spaceId, fingerprint, now: 900 },
    );
    expect(audit).toMatchObject({ counterDrift: false });
  });

  test("a changed target drops its coverage marker", async () => {
    const seeded = await seedSpace();
    const fingerprint = await baselineFingerprint();
    const chunkIds = await addChunks(seeded, 2);
    const first = await seeded.t.mutation(
      internal.models.embeddings.migrations.startTargetBackfill,
      { spaceId: seeded.spaceId, fingerprint, now: 1 },
    );
    await drive(seeded, first.jobId!, { batchSize: 8 });

    await seeded.t.run(async (ctx) => {
      const target = await ctx.db
        .query("embeddingTargets")
        .withIndex("by_space_kind_target", (q) =>
          q
            .eq("spaceId", seeded.spaceId)
            .eq("targetKind", "chunk")
            .eq("targetId", String(chunkIds[0]!)),
        )
        .unique();
      await ctx.db.patch(target!._id, { coveredFingerprint: fingerprint });
      const state = await ctx.db
        .query("spaceEmbeddingStates")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", seeded.spaceId))
        .unique();
      await ctx.db.patch(state!._id, {
        coveredCounts: [
          { fingerprint, counts: { thought: 0, chunk: 1, card: 0 } },
        ],
      });
      await ctx.db.patch(chunkIds[0]!, { text: "rewritten chunk text" });
    });

    const second = await seeded.t.mutation(
      internal.models.embeddings.migrations.startTargetBackfill,
      { spaceId: seeded.spaceId, fingerprint, now: 300 },
    );
    await drive(seeded, second.jobId!, { batchSize: 8, now: 400 });

    const stored = await storedCounters(seeded, fingerprint);
    expect(stored.covered).toEqual({ thought: 0, chunk: 0, card: 0 });
    expect(stored.counterDrift).toBe(false);
    expect(
      await seeded.t.run(async (ctx) => {
        const target = await ctx.db
          .query("embeddingTargets")
          .withIndex("by_space_kind_target", (q) =>
            q
              .eq("spaceId", seeded.spaceId)
              .eq("targetKind", "chunk")
              .eq("targetId", String(chunkIds[0]!)),
          )
          .unique();
        return {
          coveredFingerprint: target?.coveredFingerprint,
          inputHash: target?.inputHash,
        };
      }),
    ).toEqual({
      coveredFingerprint: undefined,
      inputHash: await sha256Hex("rewritten chunk text"),
    });
  });

  test("scopeV2 backfills existing vectors and is idempotent", async () => {
    const seeded = await seedSpace();
    const fingerprint = await baselineFingerprint();
    const chunkIds = await addChunks(seeded, 2);
    await seeded.t.run(async (ctx) => {
      for (const chunkId of chunkIds) {
        await ctx.db.insert("embeddingVectors", {
          spaceId: seeded.spaceId,
          embeddingGenerationId: (await ctx.db.insert("embeddingGenerations", {
            spaceId: seeded.spaceId,
            embeddingProfileId: await ctx.db.insert("embeddingProfiles", {
              fingerprint,
              ...BASELINE_EMBEDDING_PROFILE,
              createdAt: 1,
            }),
            fingerprint,
            state: "active" as const,
            eligibilityEpoch: 0,
            manifestHash: "unused",
            expectedThoughtCount: 0,
            expectedChunkCount: 0,
            completedThoughtCount: 0,
            completedChunkCount: 0,
            createdAt: 1,
          }))!,
          embeddingFingerprint: fingerprint,
          targetKind: "chunk" as const,
          searchScope: "legacy",
          chunkId,
          processingGenerationId: seeded.processingGenerationId,
          inputHash: "hash",
          embedding: vector,
        });
      }
    });

    const dry = await seeded.t.mutation(
      internal.models.embeddings.migrations.backfillVectorScopeV2,
      { spaceId: seeded.spaceId, dryRun: true },
    );
    expect(dry).toMatchObject({ scanned: 2, updated: 2, alreadySet: 0 });

    const run = await seeded.t.mutation(
      internal.models.embeddings.migrations.backfillVectorScopeV2,
      { spaceId: seeded.spaceId },
    );
    expect(run).toMatchObject({ updated: 2, isDone: true, cursor: null });

    const rerun = await seeded.t.mutation(
      internal.models.embeddings.migrations.backfillVectorScopeV2,
      { spaceId: seeded.spaceId },
    );
    expect(rerun).toMatchObject({ updated: 0, alreadySet: 2 });

    expect(
      await seeded.t.run(async (ctx) =>
        (await ctx.db.query("embeddingVectors").collect()).map(
          (row) => row.scopeV2,
        ),
      ),
    ).toEqual([
      embeddingVectorScopeV2({
        spaceId: seeded.spaceId,
        fingerprint,
        targetKind: "chunk",
      }),
      embeddingVectorScopeV2({
        spaceId: seeded.spaceId,
        fingerprint,
        targetKind: "chunk",
      }),
    ]);
  });

  test("an abandoned build stops and deletes nothing", async () => {
    const seeded = await seedSpace();
    const fingerprint = await baselineFingerprint();
    await addChunks(seeded, 20);
    const job = await seeded.t.mutation(
      internal.models.embeddings.migrations.startTargetBackfill,
      { spaceId: seeded.spaceId, fingerprint, now: 1 },
    );
    const jobId = job.jobId!;
    const thoughtPage = await seeded.t.mutation(
      internal.models.embeddings.migrations.runTargetBackfillPage,
      { jobId, cursor: null, batchSize: 4, now: 10 },
    );
    const page = await seeded.t.mutation(
      internal.models.embeddings.migrations.runTargetBackfillPage,
      { jobId, cursor: thoughtPage.cursor, batchSize: 4, now: 11 },
    );
    expect(page.scanned).toBe(4);
    const abandoned = await seeded.t.mutation(
      internal.models.embeddings.migrations.abandonTargetBackfill,
      { jobId, code: "operator", message: "stopped by hand", now: 20 },
    );
    expect(abandoned).toEqual({ phase: "abandoned", generationFailed: false });

    const afterwards = await seeded.t.mutation(
      internal.models.embeddings.migrations.runTargetBackfillPage,
      { jobId, cursor: page.cursor, batchSize: 4, now: 30 },
    );
    expect(afterwards).toMatchObject({ phase: "abandoned", isDone: true });

    // Abandoning is bookkeeping: the rows the build already wrote remain.
    expect((await recount(seeded, fingerprint)).rows).toBeGreaterThan(0);

    // A fresh job may then start for the same fingerprint.
    const restarted = await seeded.t.mutation(
      internal.models.embeddings.migrations.startTargetBackfill,
      { spaceId: seeded.spaceId, fingerprint, now: 40 },
    );
    expect(restarted.reused).toBe(false);
    await drive(seeded, restarted.jobId!, { batchSize: 8, now: 50 });
    expect((await storedCounters(seeded, fingerprint)).eligible).toEqual({
      thought: 0,
      chunk: 20,
      card: 0,
    });
  });

  test("auto-run schedules one successor at a time until the build is done", async () => {
    const seeded = await seedSpace();
    const fingerprint = await baselineFingerprint();
    await addChunks(seeded, 40);
    const job = await seeded.t.mutation(
      internal.models.embeddings.migrations.startTargetBackfill,
      { spaceId: seeded.spaceId, fingerprint, autoRun: true, now: 1 },
    );
    expect(
      await seeded.t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      ),
    ).toHaveLength(1);
    await seeded.t.finishAllScheduledFunctions(() => {});
    const stored = await storedCounters(seeded, fingerprint);
    expect(stored.eligible).toEqual({ thought: 0, chunk: 40, card: 0 });
    expect(stored.counterDrift).toBe(false);
    expect(
      await seeded.t.run(async (ctx) => (await ctx.db.get(job.jobId!))?.phase),
    ).toBe("done");
  }, 60_000);
});
