import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  admitDiscoveryUtf8,
  MAX_WORKER_DISCOVERY_ATTEMPTS,
  reserveDiscoveryWork,
} from "./discovery";
import {
  appendWorkerScanPage,
  beginWorkerScan,
  reconcileWorkerScan,
  sealWorkerScan,
} from "./model";
import {
  backfillManagedJobsPage,
  requeueFailedDiscoveryWorkPage,
  restoreSealedDocTypesPage,
} from "./migrations";

async function legacyAdmission() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Synthetic migration owner",
    });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Migration",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "fs",
      accountId: "synthetic-migration",
      name: "Migration",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60000,
      createdBy: userId,
    });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "a".repeat(64),
      keyPrefix: "migration",
      name: "Migration",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    const principal = { userId, credentialId };
    const common = { protocolVersion: 1 as const, spaceId, sourceAccountId };
    const scan = await beginWorkerScan(
      ctx,
      principal,
      {
        ...common,
        operation: "scan.begin",
        requestId: "begin",
        watcherId: "migration",
        connectorVersion: "v1",
        mode: "normal",
        expectedInventoryEpoch: 0,
      },
      100,
    );
    await appendWorkerScanPage(
      ctx,
      principal,
      {
        ...common,
        operation: "scan.appendPage",
        requestId: "page",
        scanId: scan.scanId,
        ordinal: 0,
        entries: [
          {
            externalId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139",
            uri: "fs://synthetic/migration.txt",
            sourceModifiedAt: 100,
            content: {
              status: "ready",
              byteLength: 10,
              sha256:
                "1a989ea86150171c687b0727f218eedbb94c4665a7da9b0add1bf5de607f2bf1",
            },
          },
        ],
      },
      101,
    );
    await sealWorkerScan(
      ctx,
      principal,
      {
        ...common,
        operation: "scan.seal",
        requestId: "seal",
        scanId: scan.scanId,
        expectedPageCount: 1,
        health: { status: "healthy" },
      },
      102,
    );
    await reconcileWorkerScan(
      ctx,
      principal,
      {
        ...common,
        operation: "scan.reconcile",
        requestId: "reconcile",
        scanId: scan.scanId,
        expectedInventoryEpoch: 1,
        ordinal: 0,
        maxItems: 50,
      },
      103,
    );
    const reserved = await reserveDiscoveryWork(
      ctx,
      principal,
      {
        ...common,
        operation: "discovery.reserve",
        requestId: "reserve",
        maxItems: 1,
      },
      ["b".repeat(64)],
      104,
    );
    const target = reserved.targets[0]!;
    const admitted = await admitDiscoveryUtf8(
      ctx,
      principal,
      {
        ...common,
        operation: "discovery.admitUtf8",
        requestId: "admit",
        workId: target.workId,
        leaseEpoch: target.leaseEpoch,
        leaseToken: target.leaseToken,
        text: "alpha beta",
      },
      105,
    );
    const jobId = ctx.db.normalizeId("ingestJobs", admitted.ingestJobId)!;
    await ctx.db.patch(jobId, {
      workerManaged: undefined,
      nextAttemptAt: undefined,
    });
    return { jobId, credentialId };
  });
  return { t, ...ids };
}

describe("B1 worker job upgrade", () => {
  it("dry-runs, paginates past legacy jobs, upgrades valid admission once, and blocks mismatched links", async () => {
    const { t, jobId } = await legacyAdmission();
    const before = await t.run(async (ctx) => {
      const job = (await ctx.db.get(jobId))!;
      const { _id, _creationTime, ...fields } = job;
      await ctx.db.insert("ingestJobs", {
        ...fields,
        workerDiscoveryWorkId: undefined,
        workerObservationEpoch: undefined,
      });
      await ctx.db.insert("ingestJobs", fields);
      return await ctx.db.query("ingestJobs").collect();
    });
    const dry = await t.run((ctx) =>
      backfillManagedJobsPage(ctx, {
        cursor: null,
        maxItems: 10,
        dryRun: true,
      }),
    );
    expect(dry).toMatchObject({
      eligible: 1,
      updated: 0,
      blocked: 1,
      skipped: 1,
      isDone: true,
    });
    expect(await t.run((ctx) => ctx.db.query("ingestJobs").collect())).toEqual(
      before,
    );
    let cursor: string | null = null;
    let total = 0;
    for (let page = 0; page < 4; page += 1) {
      const result = await t.run((ctx) =>
        backfillManagedJobsPage(ctx, { cursor, maxItems: 1, dryRun: false }),
      );
      total += result.updated;
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    expect(total).toBe(1);
    const after = await t.run((ctx) => ctx.db.query("ingestJobs").collect());
    expect(after.map((row) => row._id)).toEqual(before.map((row) => row._id));
    for (const row of after) {
      const original = before.find((value) => value._id === row._id)!;
      if (row._id === jobId)
        expect(row).toEqual({
          ...original,
          workerManaged: true,
          nextAttemptAt: 101,
        });
      else expect(row).toEqual(original);
    }
    const rerun = await t.run((ctx) =>
      backfillManagedJobsPage(ctx, {
        cursor: null,
        maxItems: 10,
        dryRun: false,
      }),
    );
    expect(rerun).toMatchObject({
      eligible: 0,
      updated: 0,
      blocked: 1,
      skipped: 2,
    });
  });

  it("blocks dangling lease ownership without changing it and permits a rebind due marker", async () => {
    const { t, jobId, credentialId } = await legacyAdmission();
    await t.run(async (ctx) => {
      const job = (await ctx.db.get(jobId))!;
      await ctx.db.patch(jobId, { workerLeaseOwnerCredentialId: credentialId });
      // B1 metadata-only rebinding retained a due marker on admitted work.
      await ctx.db.patch(job.workerDiscoveryWorkId!, { nextAttemptAt: 104 });
    });
    const before = await t.run((ctx) => ctx.db.get(jobId));
    expect(
      await t.run((ctx) =>
        backfillManagedJobsPage(ctx, {
          cursor: null,
          maxItems: 10,
          dryRun: false,
        }),
      ),
    ).toMatchObject({ eligible: 0, updated: 0, blocked: 1 });
    expect(await t.run((ctx) => ctx.db.get(jobId))).toEqual(before);
    await t.run((ctx) =>
      ctx.db.patch(jobId, { workerLeaseOwnerCredentialId: undefined }),
    );
    expect(
      await t.run((ctx) =>
        backfillManagedJobsPage(ctx, {
          cursor: null,
          maxItems: 10,
          dryRun: false,
        }),
      ),
    ).toMatchObject({ eligible: 1, updated: 1, blocked: 0 });
    const work = await t.run(async (ctx) =>
      ctx.db.get((await ctx.db.get(jobId))!.workerDiscoveryWorkId!),
    );
    expect(work?.nextAttemptAt).toBe(104);
  });

  it("does not repair a revoked actor or accept an oversized page", async () => {
    const { t, jobId, credentialId } = await legacyAdmission();
    await t.run((ctx) => ctx.db.delete(credentialId));
    const result = await t.run((ctx) =>
      backfillManagedJobsPage(ctx, {
        cursor: null,
        maxItems: 10,
        dryRun: false,
      }),
    );
    expect(result).toMatchObject({ eligible: 0, updated: 0, blocked: 1 });
    expect(
      (await t.run((ctx) => ctx.db.get(jobId)))?.workerManaged,
    ).toBeUndefined();
    await expect(
      t.run((ctx) =>
        backfillManagedJobsPage(ctx, {
          cursor: null,
          maxItems: 11,
          dryRun: false,
        }),
      ),
    ).rejects.toThrow("Invalid migration page bounds");
  });
});

async function requeueFixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Requeue owner",
    });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Requeue",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "a".repeat(64),
      keyPrefix: "requeue",
      name: "Requeue worker",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [],
    });

    const makeAccount = async (accountId: string) =>
      ctx.db.insert("sourceAccounts", {
        spaceId,
        connector: "fs",
        accountId,
        name: accountId,
        enabled: true,
        cursorVersion: 0,
        freshnessMs: 60_000,
        createdBy: userId,
      });
    const sourceAccountId = await makeAccount("requeue-target");
    const otherSourceAccountId = await makeAccount("requeue-other");

    const makeWork = async (
      accountId: Id<"sourceAccounts">,
      options: { state: "failed" | "needs_review"; attempts: number },
    ) => {
      const sourceItemId = await ctx.db.insert("sourceItems", {
        spaceId,
        sourceAccountId: accountId,
        externalIdHash: crypto.randomUUID(),
        lifecycle: "available",
        originalLinkAvailable: true,
        desiredProcessingEpoch: 1,
      });
      const scanId = await ctx.db.insert("workerSourceScans", {
        spaceId,
        sourceAccountId: accountId,
        requestId: crypto.randomUUID(),
        requestDigest: "c".repeat(64),
        watcherId: "requeue",
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
        sourceAccountId: accountId,
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
        sourceAccountId: accountId,
        scanId,
        scanPageId: pageId,
        sourceItemId,
        identityKeyHash: crypto.randomUUID(),
        uriDigest: "f".repeat(64),
        inventoryMetadataDigest: "1".repeat(64),
        sourceModifiedAt: 0,
        state: "needs_review",
        observedAt: 0,
        retireAt: 0,
      });
      return ctx.db.insert("workerDiscoveryWork", {
        spaceId,
        sourceAccountId: accountId,
        sourceItemId,
        scanId,
        scanEntryId: entryId,
        observationEpoch: 1,
        processingEpoch: 1,
        state: options.state,
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
        uri: "fs://requeue.pdf",
        actorUserId: userId,
        actorCredentialId: credentialId,
        attempts: options.attempts,
        leaseEpoch: 1,
        ...(options.state === "failed"
          ? { failureCode: "conversion_failed", retryable: false }
          : {}),
        createdAt: 0,
        retireAt: 2_000_000,
      });
    };

    const belowLimitFailed = await makeWork(sourceAccountId, {
      state: "failed",
      attempts: MAX_WORKER_DISCOVERY_ATTEMPTS - 1,
    });
    const belowLimitNeedsReview = await makeWork(sourceAccountId, {
      state: "needs_review",
      attempts: 1,
    });
    const atLimitFailed = await makeWork(sourceAccountId, {
      state: "failed",
      attempts: MAX_WORKER_DISCOVERY_ATTEMPTS,
    });
    const otherAccountFailed = await makeWork(otherSourceAccountId, {
      state: "failed",
      attempts: 0,
    });

    return {
      sourceAccountId,
      otherSourceAccountId,
      belowLimitFailed,
      belowLimitNeedsReview,
      atLimitFailed,
      otherAccountFailed,
    };
  });
  return { t, ...ids };
}

describe("requeueFailedDiscoveryWork", () => {
  it("requeues failed/needs_review rows under the attempt limit, skips rows at the limit, and never crosses source accounts", async () => {
    const {
      t,
      sourceAccountId,
      belowLimitFailed,
      belowLimitNeedsReview,
      atLimitFailed,
      otherAccountFailed,
    } = await requeueFixture();

    const dry = await t.run((ctx) =>
      requeueFailedDiscoveryWorkPage(ctx, {
        sourceAccountId,
        dryRun: true,
        limit: 50,
        now: 500,
      }),
    );
    expect(dry).toEqual({
      examined: 3,
      requeued: 2,
      skippedAttemptLimit: 1,
      byPriorState: { failed: 2, needs_review: 1 },
    });
    // Dry run changes nothing.
    for (const id of [belowLimitFailed, belowLimitNeedsReview, atLimitFailed]) {
      const row = await t.run((ctx) => ctx.db.get(id));
      expect(row?.state).not.toBe("queued");
    }

    const result = await t.run((ctx) =>
      requeueFailedDiscoveryWorkPage(ctx, {
        sourceAccountId,
        dryRun: false,
        limit: 50,
        now: 500,
      }),
    );
    expect(result).toEqual({
      examined: 3,
      requeued: 2,
      skippedAttemptLimit: 1,
      byPriorState: { failed: 2, needs_review: 1 },
    });

    const requeuedFailed = await t.run((ctx) => ctx.db.get(belowLimitFailed));
    expect(requeuedFailed).toMatchObject({
      state: "queued",
      nextAttemptAt: 500,
      attempts: MAX_WORKER_DISCOVERY_ATTEMPTS - 1,
    });
    expect(requeuedFailed?.leaseToken).toBeUndefined();
    expect(requeuedFailed?.leaseOwnerCredentialId).toBeUndefined();
    expect(requeuedFailed?.leaseExpiresAt).toBeUndefined();
    expect(requeuedFailed?.retryable).toBeUndefined();
    expect(requeuedFailed?.failureCode).toBeUndefined();

    const requeuedNeedsReview = await t.run((ctx) =>
      ctx.db.get(belowLimitNeedsReview),
    );
    expect(requeuedNeedsReview).toMatchObject({
      state: "queued",
      nextAttemptAt: 500,
    });

    // At the attempt limit: left alone.
    const stillFailed = await t.run((ctx) => ctx.db.get(atLimitFailed));
    expect(stillFailed).toMatchObject({
      state: "failed",
      attempts: MAX_WORKER_DISCOVERY_ATTEMPTS,
    });

    // Another source account's failed row is untouched.
    const otherRow = await t.run((ctx) => ctx.db.get(otherAccountFailed));
    expect(otherRow).toMatchObject({ state: "failed", attempts: 0 });

    // Idempotent: nothing left to requeue for this source account now.
    const rerun = await t.run((ctx) =>
      requeueFailedDiscoveryWorkPage(ctx, {
        sourceAccountId,
        dryRun: false,
        limit: 50,
        now: 600,
      }),
    );
    expect(rerun).toEqual({
      examined: 1,
      requeued: 0,
      skippedAttemptLimit: 1,
      byPriorState: { failed: 1, needs_review: 0 },
    });
  });

  it("rejects an out-of-range limit", async () => {
    const { t, sourceAccountId } = await requeueFixture();
    await expect(
      t.run((ctx) =>
        requeueFailedDiscoveryWorkPage(ctx, {
          sourceAccountId,
          dryRun: true,
          limit: 501,
          now: 0,
        }),
      ),
    ).rejects.toThrow("Invalid requeue page bounds");
  });
});

/**
 * The pre-P2-80i state of one card document: the sealed document row carries
 * the accepted `card_kind` the card lane patched onto it, and the card version
 * still records the parser's own type.
 */
async function patchedDocTypeFixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Card owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Cards",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const entityId = await ctx.db.insert("entities", {
      userId,
      spaceId,
      key: "person:card-subject",
      kind: "person",
      canonicalName: "Synthetic Subject",
      normalizedName: "synthetic subject",
      aliases: [],
      normalizedAliases: [],
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "fs",
      accountId: "cards",
      name: "cards",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: userId,
      subjectEntityId: entityId,
    });
    const sourceItemId = await ctx.db.insert("sourceItems", {
      spaceId,
      sourceAccountId,
      externalIdHash: "a".repeat(64),
      docType: "pdf",
      lifecycle: "available",
      originalLinkAvailable: true,
      desiredProcessingEpoch: 1,
    });
    const sourceRevisionId = await ctx.db.insert("sourceRevisions", {
      spaceId,
      sourceItemId,
      contentHash: "b".repeat(64),
      byteLength: 4,
      mediaType: "text/plain",
      inlineText: "text",
      capturedAt: 1_700_000_000_000,
      userId,
    });
    const sourceTextVersionId = await ctx.db.insert("sourceTextVersions", {
      spaceId,
      sourceRevisionId,
      extractionFingerprint: "plain:v1",
      text: "text",
      textHash: "c".repeat(64),
      byteLength: 4,
      evidenceSealed: true,
    });
    const generation = {
      spaceId,
      sourceAccountId,
      sourceItemId,
      sourceRevisionId,
      sourceTextVersionId,
      extractionFingerprint: "plain:v1",
      extractorFingerprint: "synthetic:v1",
      recordSchemaFingerprint: "records:v1",
      normalizationFingerprint: "exact:v1",
      chunkerFingerprint: "none:v1",
      correctionRevision: "one",
      desiredProcessingEpoch: 1,
      state: "ready" as const,
      expectedPageCount: 0,
      expectedEvidenceSpanCount: 0,
      expectedDocumentCount: 1,
      expectedChunkCount: 0,
      expectedEventCount: 0,
      expectedObservationCount: 0,
      embeddingStatus: "unavailable" as const,
      activatedAt: 100,
    };
    const textGenerationId = await ctx.db.insert("processingGenerations", {
      ...generation,
      processingFingerprint: "text:v1",
    });
    const cardGenerationId = await ctx.db.insert("processingGenerations", {
      ...generation,
      processingFingerprint: "card:v1",
      cardGeneration: true,
      expectedDocumentCount: 0,
      expectedEventCount: 1,
    });
    // The defect: the sealed row carries the card kind, not the parser's type.
    const documentId = await ctx.db.insert("documents", {
      spaceId,
      processingGenerationId: textGenerationId,
      sourceItemId,
      sourceRevisionId,
      sourceTextVersionId,
      documentKey: "main",
      title: "Synthetic document",
      docType: "contract",
      capturedAt: 1_700_000_000_000,
      evidenceSpanIds: [],
      publicationState: "active",
    });
    const eventId = await ctx.db.insert("events", {
      spaceId,
      sourceAccountId,
      sourceItemId,
      eventKey: "card:document_card",
      createdBy: userId,
    });
    const eventVersionId = await ctx.db.insert("eventVersions", {
      spaceId,
      sourceAccountId,
      sourceItemId,
      sourceRevisionId,
      sourceTextVersionId,
      processingGenerationId: cardGenerationId,
      eventId,
      entityId,
      eventType: "document_card",
      schemaVersion: 1,
      occurrence: { precision: "unknown" },
      fieldEvidence: { occurrence: [], entity: [], eventType: [] },
      docTypePatch: [
        {
          documentId,
          previousDocType: "pdf",
          appliedDocType: "contract",
        },
      ],
      userId,
    });
    await ctx.db.patch(sourceItemId, {
      desiredRevisionId: sourceRevisionId,
      activeRevisionId: sourceRevisionId,
      activeGenerationId: textGenerationId,
      activeCardGenerationId: cardGenerationId,
    });
    return { documentId, sourceItemId, eventVersionId };
  });
  return { t, ids };
}

describe("restoreSealedDocTypes", () => {
  it("restores the sealed document type, moves the card kind to the item and is idempotent", async () => {
    const { t, ids } = await patchedDocTypeFixture();
    const dry = await t.run((ctx) =>
      restoreSealedDocTypesPage(ctx, {
        cursor: null,
        maxItems: 25,
        dryRun: true,
      }),
    );
    expect(dry).toMatchObject({
      dryRun: true,
      patchedVersions: 1,
      documentsRestored: 1,
      itemsOverlaid: 1,
      skippedNotInEffect: 0,
      isDone: true,
    });
    await expect(
      t.run(async (ctx) => (await ctx.db.get(ids.documentId))!.docType),
    ).resolves.toBe("contract");

    const applied = await t.run((ctx) =>
      restoreSealedDocTypesPage(ctx, {
        cursor: null,
        maxItems: 25,
        dryRun: false,
      }),
    );
    expect(applied).toMatchObject({
      dryRun: false,
      patchedVersions: 1,
      documentsRestored: 1,
      itemsOverlaid: 1,
      skippedNotInEffect: 0,
      isDone: true,
    });
    const state = await t.run(async (ctx) => ({
      document: (await ctx.db.get(ids.documentId))!,
      item: (await ctx.db.get(ids.sourceItemId))!,
    }));
    // The parser's type is back on the row the payload manifest digested, and
    // the card kind now reaches reads through the item overlay.
    expect(state.document.docType).toBe("pdf");
    expect(state.item.cardDocType).toBe("contract");

    const again = await t.run((ctx) =>
      restoreSealedDocTypesPage(ctx, {
        cursor: null,
        maxItems: 25,
        dryRun: false,
      }),
    );
    expect(again).toMatchObject({
      patchedVersions: 1,
      documentsRestored: 0,
      itemsOverlaid: 0,
      skippedNotInEffect: 1,
      isDone: true,
    });
    await expect(
      t.run(async (ctx) => (await ctx.db.get(ids.documentId))!.docType),
    ).resolves.toBe("pdf");
  });

  it("rejects page bounds it cannot page with", async () => {
    const { t } = await patchedDocTypeFixture();
    await expect(
      t.run((ctx) =>
        restoreSealedDocTypesPage(ctx, {
          cursor: null,
          maxItems: 0,
          dryRun: true,
        }),
      ),
    ).rejects.toThrow("Invalid migration page bounds");
  });
});
