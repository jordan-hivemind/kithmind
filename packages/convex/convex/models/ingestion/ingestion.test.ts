import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { beginRecordQuerySnapshot } from "../records/querySessions";
import type { StagedEventRecord } from "../records/validators";
import { modules } from "../../test.setup";
import {
  activateGeneration,
  admitSourceRevision,
  advanceCursorAndEnqueue,
  beginForgetFromWeb,
  claimJob,
  continueForgetFromWeb,
  createGenerationTextVersion,
  replaceRevokedActorAndRequeueFromWeb,
  stageGeneration,
  stageGenerationChunks,
  stageGenerationDocuments,
  stageGenerationEvidenceSpans,
  stageGenerationPages,
  stageGenerationRecords,
} from "./model";

const processing = {
  extractionFingerprint: "text/plain:v1",
  extractorFingerprint: "none:v1",
  recordSchemaFingerprint: "documents:v1",
  normalizationFingerprint: "none:v1",
  chunkerFingerprint: "whole:v1",
  correctionRevision: "0",
  expectedPageCount: 1,
  expectedEvidenceSpanCount: 1,
  expectedDocumentCount: 1,
  expectedChunkCount: 1,
};

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Ingest owner" });
    const workerUserId = await ctx.db.insert("users", { name: "Worker owner" });
    const outsiderId = await ctx.db.insert("users", { name: "Outsider" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Synthetic ingestion",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    await ctx.db.insert("spaceMembers", {
      spaceId,
      userId: workerUserId,
      role: "editor",
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "synthetic",
      accountId: "acct-1",
      name: "Synthetic account",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: userId,
    });
    const actorCredentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "a".repeat(64),
      keyPrefix: "actor",
      name: "Actor",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    const workerCredentialId = await ctx.db.insert("apiKeys", {
      userId: workerUserId,
      keyHash: "b".repeat(64),
      keyPrefix: "worker",
      name: "Worker",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    return {
      userId,
      workerUserId,
      outsiderId,
      spaceId,
      sourceAccountId,
      actorCredentialId,
      workerCredentialId,
    };
  });
  return { t, ...ids };
}

function admission(
  principal: { userId: Id<"users">; credentialId?: Id<"apiKeys"> },
  sourceAccountId: Id<"sourceAccounts">,
  overrides: {
    requestId?: string;
    expectedDesiredProcessingEpoch?: number;
    externalId?: string;
    text?: string;
    capturedAt?: number;
  } = {},
) {
  return {
    principal,
    sourceAccountId,
    requestId: overrides.requestId ?? "request-1",
    expectedDesiredProcessingEpoch:
      overrides.expectedDesiredProcessingEpoch ?? 0,
    source: {
      externalId: overrides.externalId ?? "source-1",
      title: "Synthetic source",
      docType: "note",
      uri: "synthetic://source-1",
      capturedAt: overrides.capturedAt ?? 1_000,
      mediaType: "text/plain",
      inlineText: overrides.text ?? "alpha beta",
    },
    processing,
  };
}

async function stageCompleteGeneration(
  t: ReturnType<typeof convexTest>,
  principal: { userId: Id<"users">; credentialId?: Id<"apiKeys"> },
  admitted: Awaited<ReturnType<typeof admitSourceRevision>>,
  token: string,
  claimAt = 1_100,
  markStaged = true,
) {
  const lease = await t.run((ctx) =>
    claimJob(ctx, {
      principal,
      jobId: admitted.ingestJobId,
      leaseToken: token,
      leaseDurationMs: 100,
      now: claimAt,
    }),
  );
  if (!("leaseEpoch" in lease)) throw new Error("Expected lease");
  const leaseArgs = {
    principal,
    jobId: admitted.ingestJobId,
    leaseEpoch: lease.leaseEpoch,
    leaseToken: token,
    now: claimAt + 1,
  };
  await t.run((ctx) =>
    createGenerationTextVersion(ctx, { ...leaseArgs, text: "alpha beta" }),
  );
  const pages = await t.run((ctx) =>
    stageGenerationPages(ctx, {
      ...leaseArgs,
      pages: [{ ordinal: 0, start: 0, end: 10, text: "alpha beta" }],
    }),
  );
  if (!("ids" in pages)) throw new Error("Expected pages");
  const spans = await t.run((ctx) =>
    stageGenerationEvidenceSpans(ctx, {
      ...leaseArgs,
      spans: [
        {
          sourcePageId: pages.ids[0]!._id,
          ordinal: 0,
          start: 0,
          end: 5,
          locator: { kind: "page" as const, label: "1" },
        },
      ],
    }),
  );
  if (!("ids" in spans)) throw new Error("Expected spans");
  const documents = await t.run((ctx) =>
    stageGenerationDocuments(ctx, {
      ...leaseArgs,
      documents: [
        {
          documentKey: "document-0",
          title: "Synthetic document",
          docType: "note",
          capturedAt: 1_000,
          evidenceSpanIds: [spans.ids[0]!._id],
        },
      ],
    }),
  );
  if (!("ids" in documents)) throw new Error("Expected documents");
  await t.run((ctx) =>
    stageGenerationChunks(ctx, {
      ...leaseArgs,
      chunks: [
        {
          documentId: documents.ids[0]!._id,
          ordinal: 0,
          text: "alpha beta",
          evidenceSpanIds: [spans.ids[0]!._id],
        },
      ],
    }),
  );
  if (markStaged) await t.run((ctx) => stageGeneration(ctx, leaseArgs));
  return leaseArgs;
}

describe("durable ingestion engine", () => {
  test("receipt retries precede CAS and canonical digests bind the CAS argument", async () => {
    const { t, userId, sourceAccountId } = await seed();
    const principal = { userId };
    const first = await t.run((ctx) =>
      admitSourceRevision(ctx, admission(principal, sourceAccountId)),
    );
    const retry = await t.run((ctx) =>
      admitSourceRevision(ctx, admission(principal, sourceAccountId)),
    );
    expect(retry).toMatchObject({
      sourceRevisionId: first.sourceRevisionId,
      ingestJobId: first.ingestJobId,
      reused: true,
    });
    await expect(
      t.run((ctx) =>
        admitSourceRevision(
          ctx,
          admission(principal, sourceAccountId, {
            expectedDesiredProcessingEpoch: 1,
          }),
        ),
      ),
    ).rejects.toThrow("requestId conflicts");

    const reobservation = await t.run((ctx) =>
      admitSourceRevision(
        ctx,
        admission(principal, sourceAccountId, {
          requestId: "request-2",
          expectedDesiredProcessingEpoch: 1,
          capturedAt: 2_000,
        }),
      ),
    );
    expect(reobservation.sourceRevisionId).toBe(first.sourceRevisionId);
    await expect(
      t.run((ctx) => {
        const changedManifest = admission(principal, sourceAccountId, {
          requestId: "request-3",
          expectedDesiredProcessingEpoch: 1,
        });
        return admitSourceRevision(ctx, {
          ...changedManifest,
          processing: {
            ...changedManifest.processing,
            expectedChunkCount: 2,
          },
        });
      }),
    ).rejects.toThrow("manifest conflicts");
    const counts = await t.run(async (ctx) => ({
      revisions: (await ctx.db.query("sourceRevisions").collect()).length,
      generations: (await ctx.db.query("processingGenerations").collect())
        .length,
      jobs: (await ctx.db.query("ingestJobs").collect()).length,
      receipts: (await ctx.db.query("ingestRequests").collect()).length,
    }));
    expect(counts).toEqual({
      revisions: 1,
      generations: 1,
      jobs: 1,
      receipts: 2,
    });
  });

  test("typed manifest counts preserve zero-count retries and reject changed identities", async () => {
    const { t, userId, sourceAccountId } = await seed();
    const original = admission({ userId }, sourceAccountId);
    const first = await t.run((ctx) => admitSourceRevision(ctx, original));
    const zeroCounts = {
      ...original,
      processing: {
        ...original.processing,
        expectedEventCount: 0,
        expectedObservationCount: 0,
      },
    };
    expect(
      await t.run((ctx) => admitSourceRevision(ctx, zeroCounts)),
    ).toMatchObject({
      reused: true,
      processingGenerationId: first.processingGenerationId,
    });
    const typed = {
      ...original,
      processing: {
        ...original.processing,
        expectedEventCount: 1,
        expectedObservationCount: 1,
      },
    };
    await expect(
      t.run((ctx) => admitSourceRevision(ctx, typed)),
    ).rejects.toThrow("requestId conflicts");
    await expect(
      t.run((ctx) =>
        admitSourceRevision(ctx, {
          ...typed,
          requestId: "typed-new-request",
          expectedDesiredProcessingEpoch: 1,
        }),
      ),
    ).rejects.toThrow("manifest conflicts");
    await expect(
      t.run((ctx) =>
        admitSourceRevision(ctx, {
          ...typed,
          processing: { ...typed.processing, expectedEventCount: 33 },
        }),
      ),
    ).rejects.toThrow("expectedEventCount");
  });

  test("typed publication checks counts and lease, reserves snapshots, and forget removes records", async () => {
    const { t, userId, spaceId, sourceAccountId } = await seed();
    const principal = { userId };
    const input = admission(principal, sourceAccountId);
    const admitted = await t.run((ctx) =>
      admitSourceRevision(ctx, {
        ...input,
        processing: {
          ...input.processing,
          expectedEventCount: 1,
          expectedObservationCount: 1,
        },
      }),
    );
    const lease = await stageCompleteGeneration(
      t,
      principal,
      admitted,
      "typed-lease",
      1_100,
      false,
    );
    await expect(t.run((ctx) => stageGeneration(ctx, lease))).rejects.toThrow(
      "event count mismatch",
    );
    const { entityId, evidenceId } = await t.run(async (ctx) => ({
      entityId: await ctx.db.insert("entities", {
        spaceId,
        userId,
        key: "synthetic-person",
        kind: "person",
        canonicalName: "Synthetic Person",
        normalizedName: "synthetic person",
        aliases: [],
        normalizedAliases: [],
      }),
      evidenceId: (await ctx.db.query("evidenceSpans").first())!._id,
    }));
    const records: StagedEventRecord[] = [
      {
        eventKey: "panel-1",
        entityId,
        eventType: "lab_panel",
        schemaVersion: 1,
        occurrence: { precision: "date", date: "2026-01-10" },
        fieldEvidence: {
          occurrence: [evidenceId],
          entity: [evidenceId],
          eventType: [evidenceId],
        },
        observations: [
          {
            observationKey: "glucose",
            observationType: "glucose",
            value: { type: "decimal", value: "090.00", unitCode: "mg/dL" },
            valueEvidence: [evidenceId],
          },
        ],
      },
    ];
    await expect(
      t.run((ctx) =>
        stageGenerationRecords(ctx, { ...lease, leaseToken: "wrong", records }),
      ),
    ).rejects.toThrow();
    const staged = await t.run((ctx) =>
      stageGenerationRecords(ctx, { ...lease, records }),
    );
    expect(staged).toMatchObject({
      insertedEventCount: 1,
      insertedObservationCount: 1,
    });
    expect(await t.run((ctx) => stageGeneration(ctx, lease))).toMatchObject({
      actualEventCount: 1,
      actualObservationCount: 1,
    });
    const snapshot = await t.run((ctx) =>
      beginRecordQuerySnapshot(ctx, spaceId, lease.now),
    );
    await t.run((ctx) => activateGeneration(ctx, lease));
    const generation = await t.run((ctx) =>
      ctx.db.get(admitted.processingGenerationId),
    );
    expect(generation?.activatedAt).toBe(snapshot.snapshotAt + 1);
    await t.run((ctx) =>
      beginForgetFromWeb(ctx, {
        principal,
        sourceItemId: admitted.sourceItemId,
        now: 1_200,
      }),
    );
    let done = false;
    for (let i = 0; i < 30 && !done; i++) {
      const page = await t.run((ctx) =>
        continueForgetFromWeb(ctx, {
          principal,
          sourceItemId: admitted.sourceItemId,
        }),
      );
      expect(page.deleted).toBeLessThanOrEqual(25);
      done = page.done;
    }
    expect(done).toBe(true);
    expect(
      await t.run(async (ctx) => ({
        event: await ctx.db.query("events").first(),
        version: await ctx.db.query("eventVersions").first(),
        observation: await ctx.db.query("observations").first(),
      })),
    ).toEqual({ event: null, version: null, observation: null });
  });

  test("expired workers are fenced and staged work survives a crash", async () => {
    const { t, userId, sourceAccountId } = await seed();
    const principal = { userId };
    const admitted = await t.run((ctx) =>
      admitSourceRevision(ctx, admission(principal, sourceAccountId)),
    );
    const first = await t.run((ctx) =>
      claimJob(ctx, {
        principal,
        jobId: admitted.ingestJobId,
        leaseToken: "lease-1",
        leaseDurationMs: 50,
        now: 1_100,
      }),
    );
    expect(first).toMatchObject({ state: "processing", leaseEpoch: 1 });
    await expect(
      t.run((ctx) =>
        claimJob(ctx, {
          principal,
          jobId: admitted.ingestJobId,
          leaseToken: "overlap",
          leaseDurationMs: 50,
          now: 1_120,
        }),
      ),
    ).rejects.toThrow("already leased");
    const second = await t.run((ctx) =>
      claimJob(ctx, {
        principal,
        jobId: admitted.ingestJobId,
        leaseToken: "lease-2",
        leaseDurationMs: 100,
        now: 1_151,
      }),
    );
    expect(second).toMatchObject({ leaseEpoch: 2 });
    await expect(
      t.run((ctx) =>
        createGenerationTextVersion(ctx, {
          principal,
          jobId: admitted.ingestJobId,
          leaseEpoch: 1,
          leaseToken: "lease-1",
          now: 1_152,
          text: "alpha beta",
        }),
      ),
    ).rejects.toThrow("lease is not current");

    const stagedLease = await stageCompleteGeneration(
      t,
      principal,
      admitted,
      "lease-3",
      1_252,
    );
    const recovered = await t.run((ctx) =>
      claimJob(ctx, {
        principal,
        jobId: admitted.ingestJobId,
        leaseToken: "lease-after-crash",
        leaseDurationMs: 100,
        now: stagedLease.now + 101,
      }),
    );
    expect(recovered).toMatchObject({ state: "staged", leaseEpoch: 4 });
    if (!("leaseEpoch" in recovered))
      throw new Error("Expected recovered lease");
    await t.run((ctx) =>
      activateGeneration(ctx, {
        principal,
        jobId: admitted.ingestJobId,
        leaseEpoch: recovered.leaseEpoch,
        leaseToken: "lease-after-crash",
        now: stagedLease.now + 102,
      }),
    );
    const published = await t.run(async (ctx) => ({
      item: await ctx.db.get(admitted.sourceItemId),
      generation: await ctx.db.get(admitted.processingGenerationId),
      documents: await ctx.db
        .query("documents")
        .withIndex("by_processingGenerationId", (q) =>
          q.eq("processingGenerationId", admitted.processingGenerationId),
        )
        .collect(),
      account: await ctx.db.get(sourceAccountId),
    }));
    expect(published.item?.activeGenerationId).toBe(
      admitted.processingGenerationId,
    );
    expect(published.generation?.state).toBe("ready");
    expect(published.documents[0]?.publicationState).toBe("active");
    expect(published.account?.lastProcessedAt).toBeDefined();
  });

  test("revocation blocks publication until explicit web actor replacement", async () => {
    const {
      t,
      userId,
      workerUserId,
      sourceAccountId,
      actorCredentialId,
      workerCredentialId,
    } = await seed();
    const actor = { userId, credentialId: actorCredentialId };
    const worker = { userId: workerUserId, credentialId: workerCredentialId };
    const admitted = await t.run((ctx) =>
      admitSourceRevision(ctx, admission(actor, sourceAccountId)),
    );
    const leaseArgs = await stageCompleteGeneration(
      t,
      worker,
      admitted,
      "worker-lease",
      2_000,
    );
    await t.run((ctx) => ctx.db.delete(actorCredentialId));
    await expect(
      t.run((ctx) => activateGeneration(ctx, leaseArgs)),
    ).rejects.toThrow("authenticated");
    await expect(
      t.run((ctx) =>
        replaceRevokedActorAndRequeueFromWeb(ctx, {
          principal: { userId },
          jobId: admitted.ingestJobId,
          now: 2_050,
        }),
      ),
    ).rejects.toThrow("lease must expire");
    const replacement = await t.run((ctx) =>
      replaceRevokedActorAndRequeueFromWeb(ctx, {
        principal: { userId },
        jobId: admitted.ingestJobId,
        now: 2_101,
      }),
    );
    expect(replacement.state).toBe("staged");
    const recovered = await t.run((ctx) =>
      claimJob(ctx, {
        principal: worker,
        jobId: admitted.ingestJobId,
        leaseToken: "replacement-lease",
        leaseDurationMs: 100,
        now: 2_102,
      }),
    );
    if (!("leaseEpoch" in recovered)) throw new Error("Expected lease");
    await t.run((ctx) =>
      activateGeneration(ctx, {
        principal: worker,
        jobId: admitted.ingestJobId,
        leaseEpoch: recovered.leaseEpoch,
        leaseToken: "replacement-lease",
        now: 2_103,
      }),
    );
    const job = await t.run((ctx) => ctx.db.get(admitted.ingestJobId));
    expect(job).toMatchObject({
      state: "ready",
      admittedByCredentialId: actorCredentialId,
      actorUserId: userId,
      actorReplacedBy: userId,
      actorReplacedAt: 2_101,
    });
    expect(job?.actorCredentialId).toBeUndefined();
  });

  test("an obsolete ready job cannot downgrade its published generation", async () => {
    const { t, userId, sourceAccountId } = await seed();
    const principal = { userId };
    const first = await t.run((ctx) =>
      admitSourceRevision(ctx, admission(principal, sourceAccountId)),
    );
    const leaseArgs = await stageCompleteGeneration(
      t,
      principal,
      first,
      "ready-lease",
      2_500,
    );
    await t.run((ctx) => activateGeneration(ctx, leaseArgs));
    await t.run((ctx) =>
      admitSourceRevision(
        ctx,
        admission(principal, sourceAccountId, {
          requestId: "replacement",
          expectedDesiredProcessingEpoch: 1,
          text: "changed bytes",
        }),
      ),
    );
    await expect(
      t.run((ctx) =>
        claimJob(ctx, {
          principal,
          jobId: first.ingestJobId,
          leaseToken: "must-not-claim",
          leaseDurationMs: 100,
          now: 2_600,
        }),
      ),
    ).rejects.toThrow("cannot be claimed");
    const preserved = await t.run(async (ctx) => ({
      item: await ctx.db.get(first.sourceItemId),
      generation: await ctx.db.get(first.processingGenerationId),
      job: await ctx.db.get(first.ingestJobId),
    }));
    expect(preserved.item?.activeGenerationId).toBe(
      first.processingGenerationId,
    );
    expect(preserved.generation?.state).toBe("ready");
    expect(preserved.generation?.deactivatedAt).toBeUndefined();
    expect(preserved.job?.state).toBe("ready");
  });

  test("final staging independently rehashes the immutable revision", async () => {
    const { t, userId, sourceAccountId } = await seed();
    const principal = { userId };
    const admitted = await t.run((ctx) =>
      admitSourceRevision(ctx, admission(principal, sourceAccountId)),
    );
    const leaseArgs = await stageCompleteGeneration(
      t,
      principal,
      admitted,
      "verification-lease",
      2_700,
      false,
    );
    await t.run((ctx) =>
      ctx.db.patch(admitted.sourceRevisionId, { contentHash: "0".repeat(64) }),
    );
    await expect(
      t.run((ctx) => stageGeneration(ctx, leaseArgs)),
    ).rejects.toThrow("content hash is invalid");
    const job = await t.run((ctx) => ctx.db.get(admitted.ingestJobId));
    expect(job?.state).toBe("processing");
  });

  test("cursor admission rolls back atomically and forget is hidden then bounded", async () => {
    const { t, userId, outsiderId, sourceAccountId, actorCredentialId } =
      await seed();
    const principal = { userId };
    const one = admission(principal, sourceAccountId, {
      requestId: "cursor-1",
      externalId: "cursor-source-1",
    });
    const invalid = admission(principal, sourceAccountId, {
      requestId: "cursor-2",
      externalId: "cursor-source-2",
      text: "x".repeat(65_537),
    });
    await expect(
      t.run((ctx) =>
        advanceCursorAndEnqueue(ctx, {
          principal,
          sourceAccountId,
          expectedCursorVersion: 0,
          nextCursor: "page-2",
          enumeratedAt: 3_000,
          discoveries: [
            {
              requestId: one.requestId,
              expectedDesiredProcessingEpoch: 0,
              source: one.source,
              processing: one.processing,
            },
            {
              requestId: invalid.requestId,
              expectedDesiredProcessingEpoch: 0,
              source: invalid.source,
              processing: invalid.processing,
            },
          ],
        }),
      ),
    ).rejects.toThrow("byte limit");
    const rolledBack = await t.run(async (ctx) => ({
      account: await ctx.db.get(sourceAccountId),
      items: (await ctx.db.query("sourceItems").collect()).length,
      jobs: (await ctx.db.query("ingestJobs").collect()).length,
    }));
    expect(rolledBack).toMatchObject({ items: 0, jobs: 0 });
    expect(rolledBack.account?.cursorVersion).toBe(0);

    const cursor = await t.run((ctx) =>
      advanceCursorAndEnqueue(ctx, {
        principal,
        sourceAccountId,
        expectedCursorVersion: 0,
        nextCursor: "page-2",
        enumeratedAt: 3_001,
        discoveries: [
          {
            requestId: one.requestId,
            expectedDesiredProcessingEpoch: 0,
            source: one.source,
            processing: one.processing,
          },
        ],
      }),
    );
    expect(cursor).toMatchObject({ cursorVersion: 1 });
    const admitted = cursor.results[0]!;
    const leaseArgs = await stageCompleteGeneration(
      t,
      principal,
      admitted,
      "forget-lease",
      3_100,
    );
    await t.run((ctx) => activateGeneration(ctx, leaseArgs));
    await t.run((ctx) =>
      beginForgetFromWeb(ctx, {
        principal,
        sourceItemId: admitted.sourceItemId,
        now: 3_200,
      }),
    );
    await t.run((ctx) =>
      beginForgetFromWeb(ctx, {
        principal,
        sourceItemId: admitted.sourceItemId,
        now: 9_999,
      }),
    );
    const hidden = await t.run(async (ctx) => ({
      item: await ctx.db.get(admitted.sourceItemId),
      account: await ctx.db.get(sourceAccountId),
    }));
    expect(hidden.item).toMatchObject({
      lifecycle: "forgetting",
    });
    expect(hidden.item?.activeRevisionId).toBeUndefined();
    expect(hidden.item?.activeGenerationId).toBeUndefined();
    expect(hidden.account?.coverageInvalidatedAt).toBe(3_200);
    await expect(
      t.run((ctx) =>
        continueForgetFromWeb(ctx, {
          principal: { userId: outsiderId },
          sourceItemId: admitted.sourceItemId,
        }),
      ),
    ).rejects.toThrow("Source account not found");

    await t.run(async (ctx) => {
      const item = (await ctx.db.get(admitted.sourceItemId))!;
      for (let index = 0; index < 30; index += 1) {
        await ctx.db.insert("sourceFetchRequests", {
          spaceId: item.spaceId,
          sourceAccountId,
          sourceItemId: item._id,
          actorUserId: userId,
          actorCredentialId,
          requestId: `pending-url-${index}`,
          requestDigest: `digest-${index}`,
          url: `https://example.com/${index}`,
          state: "queued",
          createdAt: 3000,
        });
      }
    });
    let cleanup = { phase: "start", deleted: 0, done: false };
    for (let attempt = 0; attempt < 20 && !cleanup.done; attempt += 1) {
      cleanup = await t.run((ctx) =>
        continueForgetFromWeb(ctx, {
          principal,
          sourceItemId: admitted.sourceItemId,
        }),
      );
      expect(cleanup.deleted).toBeLessThanOrEqual(25);
    }
    expect(cleanup.done).toBe(true);
    const forgotten = await t.run(async (ctx) => ({
      item: await ctx.db.get(admitted.sourceItemId),
      revisions: (await ctx.db.query("sourceRevisions").collect()).length,
      textVersions: (await ctx.db.query("sourceTextVersions").collect()).length,
      pages: (await ctx.db.query("sourcePages").collect()).length,
      spans: (await ctx.db.query("evidenceSpans").collect()).length,
      documents: (await ctx.db.query("documents").collect()).length,
      chunks: (await ctx.db.query("chunks").collect()).length,
      generations: (await ctx.db.query("processingGenerations").collect())
        .length,
      jobs: (await ctx.db.query("ingestJobs").collect()).length,
      receipts: (await ctx.db.query("ingestRequests").collect()).length,
      fetchRequests: (await ctx.db.query("sourceFetchRequests").collect())
        .length,
    }));
    expect(forgotten.item).toMatchObject({
      lifecycle: "forgotten",
    });
    expect(forgotten.item?.externalId).toBeUndefined();
    expect(forgotten.item?.title).toBeUndefined();
    expect(forgotten.item?.uri).toBeUndefined();
    expect({ ...forgotten, item: undefined }).toEqual({
      item: undefined,
      revisions: 0,
      textVersions: 0,
      pages: 0,
      spans: 0,
      documents: 0,
      chunks: 0,
      generations: 0,
      jobs: 0,
      receipts: 0,
      fetchRequests: 0,
    });
    await expect(
      t.run((ctx) =>
        continueForgetFromWeb(ctx, {
          principal: { userId: outsiderId },
          sourceItemId: admitted.sourceItemId,
        }),
      ),
    ).rejects.toThrow("Source account not found");
  });
});
