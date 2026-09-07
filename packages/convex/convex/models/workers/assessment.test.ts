import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "../../_generated/dataModel";
import { api } from "../../_generated/api";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { admitSourceRevision, markSourceUnavailable } from "../ingestion/model";
import { digestProcessingConfiguration } from "../ingestion/hash";
import { planInlineText } from "../ingestion/inlineText";
import { sha256Utf8 } from "../provenance/model";
import {
  advanceProcessingAssessment,
  beginProcessingAssessment,
  isAssessmentSnapshotCurrent,
} from "./assessment";
import { getWorkerSourceStatus } from "./model";
import { FS_TEXT_PROFILE } from "./profile";
import { parseWorkerRequest, type WorkerRequest } from "./protocol";

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Assessment owner" });
    const otherUserId = await ctx.db.insert("users", {
      name: "Second assessor",
    });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Assessment space",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    await ctx.db.insert("spaceMembers", {
      spaceId,
      userId: otherUserId,
      role: "editor",
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "fs",
      accountId: "assessment-fs",
      name: "Assessment filesystem",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      inventoryEpoch: 1,
      completedInventoryEpoch: 1,
      manifestVersion: 1,
      coverageInvalidatedAt: 10,
      lastEnumeratedAt: 100,
      workerAssessmentEpoch: 0,
      createdBy: userId,
    });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "a".repeat(64),
      keyPrefix: "assessment-a",
      name: "Assessment A",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    const otherCredentialId = await ctx.db.insert("apiKeys", {
      userId: otherUserId,
      keyHash: "b".repeat(64),
      keyPrefix: "assessment-b",
      name: "Assessment B",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    return {
      userId,
      otherUserId,
      spaceId,
      sourceAccountId,
      credentialId,
      otherCredentialId,
    };
  });
  return {
    t,
    ...ids,
    principal: { userId: ids.userId, credentialId: ids.credentialId },
    otherPrincipal: {
      userId: ids.otherUserId,
      credentialId: ids.otherCredentialId,
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function seedTerminalScan(
  f: Fixture,
  args: {
    state?: "enumerated" | "needs_review";
    gapItem?: boolean;
    actorCredentialId?: Id<"apiKeys">;
    actorUserId?: Id<"users">;
  } = {},
) {
  return await f.t.run(async (ctx) => {
    let sourceItemId: Id<"sourceItems"> | undefined;
    if (args.gapItem) {
      sourceItemId = await ctx.db.insert("sourceItems", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        externalIdHash: "e".repeat(64),
        externalId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139",
        title: "Gap item",
        docType: "text",
        uri: "fs://gap.txt",
        lifecycle: "available",
        originalLinkAvailable: true,
        desiredProcessingEpoch: 0,
        workerObservationEpoch: 1,
        workerProcessingEpoch: 0,
        workerInventoryMetadataDigest: "i".repeat(64),
        workerSourceModifiedAt: 20,
        workerLastSeenInventoryEpoch: 1,
      });
    }
    const scanId = await ctx.db.insert("workerSourceScans", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      requestId: "seed-scan",
      requestDigest: "d".repeat(64),
      watcherId: "watcher",
      connectorVersion: "fs-v1",
      mode: "normal",
      inventoryEpoch: 1,
      manifestVersionAtBegin: 1,
      actorUserId: args.actorUserId ?? f.userId,
      actorCredentialId: args.actorCredentialId ?? f.credentialId,
      state: args.state ?? "enumerated",
      nextPageOrdinal: args.gapItem ? 1 : 0,
      inventoryDone: true,
      pageCount: args.gapItem ? 1 : 0,
      entryCount: args.gapItem ? 1 : 0,
      changedCount: 0,
      gapCount: args.gapItem ? 1 : 0,
      reviewCount: 0,
      manifestVersionAtSeal: 1,
      reconcileManifestVersion: 1,
      nextReconcileOrdinal: 1,
      startedAt: 50,
      sealedAt: 80,
      completedAt: 100,
      expiresAt: 10_000,
      retireAt: 100_000,
    });
    if (sourceItemId) {
      const scanPageId = await ctx.db.insert("workerScanPages", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        scanId,
        ordinal: 0,
        requestId: "seed-page",
        requestDigest: "p".repeat(64),
        entryCount: 1,
        createdAt: 60,
        retireAt: 100_000,
      });
      await ctx.db.insert("workerScanEntries", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        scanId,
        scanPageId,
        sourceItemId,
        identityKeyHash: "k".repeat(64),
        externalIdHash: "e".repeat(64),
        uriDigest: "u".repeat(64),
        inventoryMetadataDigest: "i".repeat(64),
        sourceModifiedAt: 20,
        observationEpoch: 1,
        processingEpoch: 0,
        state: "gap",
        issueCode: "unreadable",
        observedAt: 60,
        retireAt: 100_000,
      });
    }
    if ((args.state ?? "enumerated") === "needs_review") {
      await ctx.db.patch(f.sourceAccountId, { completedInventoryEpoch: 0 });
    }
    return { scanId, sourceItemId };
  });
}

async function seedMixedAssessmentScan(f: Fixture) {
  return await f.t.run(async (ctx) => {
    const gapItemId = await ctx.db.insert("sourceItems", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      externalIdHash: "1".repeat(64),
      externalId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139",
      title: "Gap",
      docType: "text",
      uri: "fs://gap.txt",
      lifecycle: "available",
      originalLinkAvailable: true,
      desiredProcessingEpoch: 0,
      workerObservationEpoch: 1,
      workerProcessingEpoch: 0,
      workerLastSeenInventoryEpoch: 1,
    });
    await ctx.db.insert("sourceItems", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      externalIdHash: "2".repeat(64),
      externalId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c140",
      title: "Unavailable",
      docType: "text",
      uri: "fs://unavailable.txt",
      lifecycle: "unavailable",
      originalLinkAvailable: true,
      desiredProcessingEpoch: 0,
      workerObservationEpoch: 1,
      workerProcessingEpoch: 0,
    });
    await ctx.db.insert("sourceItems", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      externalIdHash: "3".repeat(64),
      lifecycle: "forgotten",
      originalLinkAvailable: false,
      desiredProcessingEpoch: 1,
      forgottenAt: 70,
      forgottenBy: f.userId,
      workerObservationEpoch: 2,
      workerProcessingEpoch: 0,
    });
    const scanId = await ctx.db.insert("workerSourceScans", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      requestId: "mixed-scan",
      requestDigest: "m".repeat(64),
      watcherId: "watcher",
      connectorVersion: "fs-v1",
      mode: "normal",
      inventoryEpoch: 1,
      manifestVersionAtBegin: 1,
      actorUserId: f.userId,
      actorCredentialId: f.credentialId,
      state: "needs_review",
      nextPageOrdinal: 1,
      inventoryDone: true,
      pageCount: 1,
      entryCount: 2,
      changedCount: 0,
      gapCount: 1,
      reviewCount: 1,
      manifestVersionAtSeal: 1,
      reconcileManifestVersion: 1,
      nextReconcileOrdinal: 1,
      startedAt: 50,
      sealedAt: 80,
      completedAt: 100,
      expiresAt: 10_000,
      retireAt: 100_000,
    });
    const pageId = await ctx.db.insert("workerScanPages", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      scanId,
      ordinal: 0,
      requestId: "mixed-page",
      requestDigest: "n".repeat(64),
      entryCount: 2,
      createdAt: 80,
      retireAt: 100_000,
    });
    await ctx.db.insert("workerScanEntries", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      scanId,
      scanPageId: pageId,
      sourceItemId: gapItemId,
      identityKeyHash: "1".repeat(64),
      externalIdHash: "1".repeat(64),
      uriDigest: "u".repeat(64),
      inventoryMetadataDigest: "i".repeat(64),
      sourceModifiedAt: 20,
      observationEpoch: 1,
      processingEpoch: 0,
      state: "gap",
      issueCode: "unreadable",
      observedAt: 80,
      retireAt: 100_000,
    });
    await ctx.db.insert("workerScanEntries", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      scanId,
      scanPageId: pageId,
      identityKeyHash: "4".repeat(64),
      uriDigest: "v".repeat(64),
      inventoryMetadataDigest: "j".repeat(64),
      sourceModifiedAt: 20,
      state: "needs_review",
      issueCode: "identity_conflict",
      observedAt: 80,
      retireAt: 100_000,
    });
    await ctx.db.patch(f.sourceAccountId, { completedInventoryEpoch: 0 });
    return scanId;
  });
}

async function seedReadyMetadataRebind(
  f: Fixture,
  text = "alpha beta",
  pruneHistoricalDetail = false,
) {
  const externalId = "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139";
  const uri = "fs://ready.txt";
  const byteLength = new TextEncoder().encode(text).byteLength;
  const plan = planInlineText(text);
  const contentHash = await sha256Utf8(text);
  const externalIdHash = await sha256Utf8(externalId);
  const digest = async (domain: string, value: unknown) =>
    await sha256Utf8(`${domain}\0${JSON.stringify(value)}`);
  const uriDigest = await digest("worker-fs-uri:v1", [f.sourceAccountId, uri]);
  const processingIdentityDigest = await digest(
    "worker-fs-processing-identity:v1",
    [
      contentHash,
      FS_TEXT_PROFILE.mediaType,
      FS_TEXT_PROFILE.profileId,
      FS_TEXT_PROFILE.extractionFingerprint,
      FS_TEXT_PROFILE.extractorFingerprint,
      FS_TEXT_PROFILE.recordSchemaFingerprint,
      FS_TEXT_PROFILE.normalizationFingerprint,
      FS_TEXT_PROFILE.chunkerFingerprint,
    ],
  );
  const inventoryMetadataDigest = await digest(
    "worker-fs-inventory-metadata:v1",
    [
      externalIdHash,
      uriDigest,
      "Renamed",
      "text",
      20,
      "ready",
      contentHash,
      byteLength,
      null,
      FS_TEXT_PROFILE.profileId,
    ],
  );
  const processingFingerprint = await digestProcessingConfiguration({
    extractionFingerprint: FS_TEXT_PROFILE.extractionFingerprint,
    extractorFingerprint: FS_TEXT_PROFILE.extractorFingerprint,
    recordSchemaFingerprint: FS_TEXT_PROFILE.recordSchemaFingerprint,
    normalizationFingerprint: FS_TEXT_PROFILE.normalizationFingerprint,
    chunkerFingerprint: FS_TEXT_PROFILE.chunkerFingerprint,
    correctionRevision: "filesystem-observation-v1:1",
  });
  return await f.t.run(async (ctx) => {
    const itemId = await ctx.db.insert("sourceItems", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      externalIdHash,
      externalId,
      title: "Renamed",
      docType: "text",
      uri,
      lifecycle: "available",
      originalLinkAvailable: true,
      desiredProcessingEpoch: 1,
      workerObservationEpoch: 2,
      workerProcessingEpoch: 1,
      workerInventoryMetadataDigest: inventoryMetadataDigest,
      workerProcessingIdentityDigest: processingIdentityDigest,
      workerContentHash: contentHash,
      workerSourceModifiedAt: 20,
      workerProfileId: FS_TEXT_PROFILE.profileId,
      workerLastSeenInventoryEpoch: 1,
    });
    const revisionId = await ctx.db.insert("sourceRevisions", {
      spaceId: f.spaceId,
      sourceItemId: itemId,
      contentHash,
      byteLength,
      mediaType: FS_TEXT_PROFILE.mediaType,
      inlineText: text,
      capturedAt: 10,
      userId: f.userId,
    });
    const generationId = await ctx.db.insert("processingGenerations", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      sourceItemId: itemId,
      sourceRevisionId: revisionId,
      processingFingerprint,
      extractionFingerprint: FS_TEXT_PROFILE.extractionFingerprint,
      extractorFingerprint: FS_TEXT_PROFILE.extractorFingerprint,
      recordSchemaFingerprint: FS_TEXT_PROFILE.recordSchemaFingerprint,
      normalizationFingerprint: FS_TEXT_PROFILE.normalizationFingerprint,
      chunkerFingerprint: FS_TEXT_PROFILE.chunkerFingerprint,
      correctionRevision: "filesystem-observation-v1:1",
      desiredProcessingEpoch: 1,
      state: "ready",
      expectedPageCount: plan.expectedPageCount,
      expectedEvidenceSpanCount: plan.expectedEvidenceSpanCount,
      expectedDocumentCount: plan.expectedDocumentCount,
      expectedChunkCount: plan.expectedChunkCount,
      expectedEventCount: 0,
      expectedObservationCount: 0,
      actualPageCount: plan.expectedPageCount,
      actualEvidenceSpanCount: plan.expectedEvidenceSpanCount,
      actualDocumentCount: plan.expectedDocumentCount,
      actualChunkCount: plan.expectedChunkCount,
      actualEventCount: 0,
      actualObservationCount: 0,
      embeddingStatus: "unavailable",
      activatedAt: 90,
    });
    const oldScanId = await ctx.db.insert("workerSourceScans", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      requestId: "old-scan",
      requestDigest: "o".repeat(64),
      watcherId: "watcher",
      connectorVersion: "fs-v1",
      mode: "normal",
      inventoryEpoch: 0,
      manifestVersionAtBegin: 0,
      actorUserId: f.userId,
      actorCredentialId: f.credentialId,
      state: "enumerated",
      nextPageOrdinal: 1,
      inventoryDone: true,
      pageCount: 1,
      entryCount: 1,
      changedCount: 1,
      gapCount: 0,
      reviewCount: 0,
      manifestVersionAtSeal: 0,
      reconcileManifestVersion: 0,
      nextReconcileOrdinal: 1,
      startedAt: 1,
      sealedAt: 2,
      completedAt: 3,
      expiresAt: 10_000,
      retireAt: 100_000,
    });
    const oldPageId = await ctx.db.insert("workerScanPages", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      scanId: oldScanId,
      ordinal: 0,
      requestId: "old-page",
      requestDigest: "q".repeat(64),
      entryCount: 1,
      createdAt: 2,
      retireAt: 100_000,
    });
    const oldEntryId = await ctx.db.insert("workerScanEntries", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      scanId: oldScanId,
      scanPageId: oldPageId,
      sourceItemId: itemId,
      identityKeyHash: externalIdHash,
      externalIdHash,
      uriDigest,
      inventoryMetadataDigest,
      processingIdentityDigest,
      contentHash,
      byteLength,
      sourceModifiedAt: 10,
      observationEpoch: 1,
      processingEpoch: 1,
      state: "queued",
      observedAt: 2,
      retireAt: 100_000,
    });
    const workId = await ctx.db.insert("workerDiscoveryWork", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      sourceItemId: itemId,
      scanId: oldScanId,
      scanEntryId: oldEntryId,
      observationEpoch: 1,
      processingEpoch: 1,
      expectedDesiredProcessingEpoch: 0,
      state: "obsolete",
      contentHash,
      byteLength,
      capturedAt: 10,
      sourceModifiedAt: 10,
      mediaType: FS_TEXT_PROFILE.mediaType,
      profileId: FS_TEXT_PROFILE.profileId,
      extractionFingerprint: FS_TEXT_PROFILE.extractionFingerprint,
      extractorFingerprint: FS_TEXT_PROFILE.extractorFingerprint,
      recordSchemaFingerprint: FS_TEXT_PROFILE.recordSchemaFingerprint,
      normalizationFingerprint: FS_TEXT_PROFILE.normalizationFingerprint,
      chunkerFingerprint: FS_TEXT_PROFILE.chunkerFingerprint,
      title: "Original",
      docType: "text",
      uri,
      actorUserId: f.userId,
      actorCredentialId: f.credentialId,
      attempts: 1,
      leaseEpoch: 1,
      createdAt: 10,
      retireAt: 100_000,
    });
    const jobId = await ctx.db.insert("ingestJobs", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      sourceItemId: itemId,
      sourceRevisionId: revisionId,
      processingGenerationId: generationId,
      admittedByUserId: f.userId,
      admittedByCredentialId: f.credentialId,
      actorUserId: f.userId,
      actorCredentialId: f.credentialId,
      desiredProcessingEpoch: 1,
      state: "ready",
      attempts: 1,
      leaseEpoch: 1,
      workerManaged: true,
      workerDiscoveryWorkId: workId,
      workerObservationEpoch: 1,
    });
    await ctx.db.patch(workId, {
      ingestRequestId: "admit-old",
      ingestJobId: jobId,
      sourceRevisionId: revisionId,
      processingGenerationId: generationId,
    });
    await ctx.db.patch(oldEntryId, { discoveryWorkId: workId });
    await ctx.db.patch(itemId, {
      desiredRevisionId: revisionId,
      activeRevisionId: revisionId,
      activeGenerationId: generationId,
    });
    const scanId = await ctx.db.insert("workerSourceScans", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      requestId: "current-scan",
      requestDigest: "c".repeat(64),
      watcherId: "watcher",
      connectorVersion: "fs-v1",
      mode: "normal",
      inventoryEpoch: 1,
      manifestVersionAtBegin: 1,
      actorUserId: f.userId,
      actorCredentialId: f.credentialId,
      state: "enumerated",
      nextPageOrdinal: 1,
      inventoryDone: true,
      pageCount: 1,
      entryCount: 1,
      changedCount: 0,
      gapCount: 0,
      reviewCount: 0,
      manifestVersionAtSeal: 1,
      reconcileManifestVersion: 1,
      nextReconcileOrdinal: 1,
      startedAt: 50,
      sealedAt: 80,
      completedAt: 100,
      expiresAt: 10_000,
      retireAt: 100_000,
    });
    const pageId = await ctx.db.insert("workerScanPages", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      scanId,
      ordinal: 0,
      requestId: "current-page",
      requestDigest: "r".repeat(64),
      entryCount: 1,
      createdAt: 80,
      retireAt: 100_000,
    });
    await ctx.db.insert("workerScanEntries", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      scanId,
      scanPageId: pageId,
      sourceItemId: itemId,
      identityKeyHash: externalIdHash,
      externalIdHash,
      uriDigest,
      inventoryMetadataDigest,
      processingIdentityDigest,
      contentHash,
      byteLength,
      sourceModifiedAt: 20,
      observationEpoch: 2,
      processingEpoch: 1,
      state: "unchanged",
      observedAt: 80,
      retireAt: 100_000,
    });
    if (pruneHistoricalDetail) {
      await ctx.db.delete(workId);
      await ctx.db.delete(oldEntryId);
      await ctx.db.delete(oldPageId);
      await ctx.db.delete(oldScanId);
    }
    return scanId;
  });
}

async function seedPendingCurrent(f: Fixture) {
  const scanId = await seedReadyMetadataRebind(f);
  const ids = await f.t.run(async (ctx) => {
    const item = await ctx.db
      .query("sourceItems")
      .withIndex("by_sourceAccountId", (q) =>
        q.eq("sourceAccountId", f.sourceAccountId),
      )
      .unique();
    if (!item?.desiredRevisionId) throw new Error("missing item");
    const currentEntry = await ctx.db
      .query("workerScanEntries")
      .withIndex("by_scanId", (q) => q.eq("scanId", scanId))
      .unique();
    const work = await ctx.db
      .query("workerDiscoveryWork")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .unique();
    const job = await ctx.db
      .query("ingestJobs")
      .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
      .unique();
    if (!currentEntry || !work || !job) throw new Error("missing chain");
    await ctx.db.patch(currentEntry._id, {
      state: "queued",
      discoveryWorkId: work._id,
    });
    await ctx.db.patch(work._id, {
      scanId,
      scanEntryId: currentEntry._id,
      observationEpoch: 2,
      state: "admitted",
    });
    await ctx.db.patch(job._id, {
      state: "queued",
      workerObservationEpoch: 2,
      nextAttemptAt: 100,
    });
    await ctx.db.patch(job.processingGenerationId, { state: "queued" });
    await ctx.db.patch(item._id, {
      activeRevisionId: undefined,
      activeGenerationId: undefined,
    });
    await ctx.db.patch(scanId, { changedCount: 1 });
    await ctx.db.patch(f.sourceAccountId, { lastProcessedAt: 500 });
    return {
      itemId: item._id,
      revisionId: item.desiredRevisionId,
      generationId: job.processingGenerationId,
      jobId: job._id,
    };
  });
  return { scanId, ...ids };
}

function source(f: Fixture) {
  return {
    protocolVersion: 1 as const,
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
  };
}

function assessBeginRequest(f: Fixture, scanId: Id<"workerSourceScans">) {
  return namedAssessBeginRequest(f, scanId, "assessment-begin");
}

function namedAssessBeginRequest(
  f: Fixture,
  scanId: Id<"workerSourceScans">,
  requestId: string,
) {
  const request = parseWorkerRequest({
    ...source(f),
    operation: "processing.assessBegin",
    requestId,
    scanId,
    expectedInventoryEpoch: 1,
    expectedManifestVersion: 1,
  });
  if (request.operation !== "processing.assessBegin")
    throw new Error("bad request");
  return request;
}

function assessPageRequest(
  f: Fixture,
  assessmentId: string,
  ordinal: number,
): Extract<WorkerRequest, { operation: "processing.assessPage" }> {
  const request = parseWorkerRequest({
    ...source(f),
    operation: "processing.assessPage",
    requestId: `assessment-page-${ordinal}`,
    assessmentId,
    ordinal,
    maxItems: 1,
  });
  if (request.operation !== "processing.assessPage")
    throw new Error("bad request");
  return request;
}

async function completeAssessment(
  f: Fixture,
  scanId: Id<"workerSourceScans">,
  principal = f.principal,
  beginRequestId = "assessment-begin",
) {
  const begun = await f.t.run((ctx) =>
    beginProcessingAssessment(
      ctx,
      principal,
      namedAssessBeginRequest(f, scanId, beginRequestId),
      200,
    ),
  );
  let result;
  for (let ordinal = 0; ordinal < 5; ordinal += 1) {
    result = await f.t.run((ctx) =>
      advanceProcessingAssessment(
        ctx,
        principal,
        assessPageRequest(f, begun.assessmentId, ordinal),
        201 + ordinal,
      ),
    );
    if (result.state !== "running") break;
  }
  if (!result) throw new Error("assessment made no progress");
  return { begun, result };
}

describe("worker processing assessments", () => {
  test("paginates mixed item and unresolved detail exactly once", async () => {
    const f = await fixture();
    const scanId = await seedMixedAssessmentScan(f);
    const begun = await f.t.run((ctx) =>
      beginProcessingAssessment(
        ctx,
        f.principal,
        namedAssessBeginRequest(f, scanId, "mixed-assessment"),
        200,
      ),
    );
    const pages = [];
    for (let ordinal = 0; ordinal < 10; ordinal += 1) {
      const result = await f.t.run((ctx) =>
        advanceProcessingAssessment(
          ctx,
          f.principal,
          assessPageRequest(f, begun.assessmentId, ordinal),
          201 + ordinal,
        ),
      );
      pages.push(result);
      if (result.state !== "running") break;
    }
    const terminal = pages.at(-1)!;
    expect(pages.length).toBeGreaterThanOrEqual(4);
    expect(terminal).toMatchObject({
      state: "incomplete",
      counts: {
        items: {
          ready: 0,
          pending: 0,
          failed: 0,
          needsReview: 0,
          explicitGap: 1,
          unavailable: 1,
          ignoredForgotten: 1,
        },
        unresolvedEntries: { needsReview: 1, ignoredForgotten: 0 },
      },
    });
    const replay = await f.t.run((ctx) =>
      advanceProcessingAssessment(
        ctx,
        f.principal,
        assessPageRequest(f, begun.assessmentId, terminal.ordinal),
        300,
      ),
    );
    expect(replay).toEqual({ ...terminal, reused: true });
    const stored = await f.t.run(
      async (ctx) =>
        await ctx.db.get(
          ctx.db.normalizeId(
            "workerProcessingAssessments",
            begun.assessmentId,
          )!,
        ),
    );
    expect(stored?.accountedScanEntries).toBe(2);
    expect(stored?.nextOrdinal).toBe(pages.length);
  });

  test("completes an empty terminal scan, replays its last page, and publishes status", async () => {
    const f = await fixture();
    const { scanId } = await seedTerminalScan(f);
    const { begun, result } = await completeAssessment(f, scanId);
    expect(result).toMatchObject({
      state: "complete",
      phase: "done",
      counts: {
        items: { ready: 0, pending: 0, failed: 0, needsReview: 0 },
      },
    });
    const replay = await f.t.run((ctx) =>
      advanceProcessingAssessment(
        ctx,
        f.principal,
        assessPageRequest(f, begun.assessmentId, result.ordinal),
        300,
      ),
    );
    expect(replay).toEqual({ ...result, reused: true });
    const statusRequest = parseWorkerRequest({
      ...source(f),
      operation: "source.status",
    });
    if (statusRequest.operation !== "source.status")
      throw new Error("bad request");
    const status = await f.t.run((ctx) =>
      getWorkerSourceStatus(ctx, f.principal, statusRequest, 301),
    );
    expect(status.processing).toMatchObject({
      state: "complete",
      assessmentId: begun.assessmentId,
    });
    expect(
      await f.t.run(async (ctx) => {
        const sourceRow = (await ctx.db.get(f.sourceAccountId))!;
        const row = (await ctx.db.get(
          ctx.db.normalizeId(
            "workerProcessingAssessments",
            begun.assessmentId,
          )!,
        ))!;
        return isAssessmentSnapshotCurrent(sourceRow, row);
      }),
    ).toBe(true);
  });

  test("disable and re-enable cannot revive a completed snapshot or its terminal replay", async () => {
    const f = await fixture();
    const { scanId } = await seedTerminalScan(f);
    const beginRequest = assessBeginRequest(f, scanId);
    const { begun, result } = await completeAssessment(f, scanId);
    expect(result.state).toBe("complete");
    const web = f.t.withIdentity({
      issuer: "https://synthetic.example/convex",
      subject: f.userId,
    });
    await web.mutation(api.models.sourceAccounts.public.update, {
      sourceAccountId: f.sourceAccountId,
      enabled: false,
    });
    await web.mutation(api.models.sourceAccounts.public.update, {
      sourceAccountId: f.sourceAccountId,
      enabled: true,
    });
    const beginReplay = await f.t.run((ctx) =>
      beginProcessingAssessment(ctx, f.principal, beginRequest, 300),
    );
    expect(beginReplay).toMatchObject({
      state: "stale",
      staleReason: "source_changed",
      reused: true,
    });
    const terminalReplay = await f.t.run((ctx) =>
      advanceProcessingAssessment(
        ctx,
        f.principal,
        assessPageRequest(f, begun.assessmentId, result.ordinal),
        301,
      ),
    );
    expect(terminalReplay).toMatchObject({
      state: "stale",
      reused: true,
    });
    expect(terminalReplay).not.toHaveProperty("counts");
    const statusRequest = parseWorkerRequest({
      ...source(f),
      operation: "source.status",
    });
    if (statusRequest.operation !== "source.status")
      throw new Error("bad request");
    expect(
      (
        await f.t.run((ctx) =>
          getWorkerSourceStatus(ctx, f.principal, statusRequest, 302),
        )
      ).processing,
    ).toEqual({ state: "not_assessed" });
  });

  test("fails closed instead of replaying malformed running or terminal results", async () => {
    const terminalFixture = await fixture();
    const { scanId: terminalScanId } = await seedTerminalScan(terminalFixture);
    const terminal = await completeAssessment(terminalFixture, terminalScanId);
    await terminalFixture.t.run(async (ctx) => {
      const id = ctx.db.normalizeId(
        "workerProcessingAssessments",
        terminal.begun.assessmentId,
      )!;
      const row = (await ctx.db.get(id))!;
      await ctx.db.patch(id, {
        lastPageResult: {
          ...row.lastPageResult!,
          counts: {
            ...row.counts,
            items: { ...row.counts.items, ready: 1 },
          },
        },
      });
    });
    const terminalReplay = await terminalFixture.t.run((ctx) =>
      advanceProcessingAssessment(
        ctx,
        terminalFixture.principal,
        assessPageRequest(
          terminalFixture,
          terminal.begun.assessmentId,
          terminal.result.ordinal,
        ),
        300,
      ),
    );
    expect(terminalReplay).toMatchObject({
      state: "stale",
      staleReason: "detail_unavailable",
    });
    expect(terminalReplay).not.toHaveProperty("counts");

    const runningFixture = await fixture();
    const { scanId: runningScanId } = await seedTerminalScan(runningFixture);
    const begun = await runningFixture.t.run((ctx) =>
      beginProcessingAssessment(
        ctx,
        runningFixture.principal,
        assessBeginRequest(runningFixture, runningScanId),
        200,
      ),
    );
    const firstRequest = assessPageRequest(
      runningFixture,
      begun.assessmentId,
      0,
    );
    await runningFixture.t.run((ctx) =>
      advanceProcessingAssessment(
        ctx,
        runningFixture.principal,
        firstRequest,
        201,
      ),
    );
    await runningFixture.t.run(async (ctx) => {
      const id = ctx.db.normalizeId(
        "workerProcessingAssessments",
        begun.assessmentId,
      )!;
      const row = (await ctx.db.get(id))!;
      await ctx.db.patch(id, {
        lastPageResult: { ...row.lastPageResult!, counts: row.counts },
      });
    });
    expect(
      await runningFixture.t.run((ctx) =>
        advanceProcessingAssessment(
          ctx,
          runningFixture.principal,
          firstRequest,
          202,
        ),
      ),
    ).toMatchObject({
      state: "stale",
      staleReason: "detail_unavailable",
      reused: true,
    });
  });

  test("forces needs-review scans incomplete even when no detail rows remain", async () => {
    const f = await fixture();
    const { scanId } = await seedTerminalScan(f, { state: "needs_review" });
    const { result } = await completeAssessment(f, scanId);
    expect(result.state).toBe("incomplete");
  });

  test("allows a new authorized credential to assess a scan from a revoked scanner", async () => {
    const f = await fixture();
    const { scanId } = await seedTerminalScan(f, {
      actorUserId: f.userId,
      actorCredentialId: f.credentialId,
    });
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.credentialId, { sourceAccountIds: [] });
    });
    const { result } = await completeAssessment(f, scanId, f.otherPrincipal);
    expect(result.state).toBe("complete");
  });

  test("binds page progress to its source and executing credential", async () => {
    const f = await fixture();
    const { scanId } = await seedTerminalScan(f);
    const begun = await f.t.run((ctx) =>
      beginProcessingAssessment(
        ctx,
        f.principal,
        assessBeginRequest(f, scanId),
        200,
      ),
    );
    await expect(
      f.t.run((ctx) =>
        advanceProcessingAssessment(
          ctx,
          f.otherPrincipal,
          assessPageRequest(f, begun.assessmentId, 0),
          201,
        ),
      ),
    ).rejects.toThrow("not_found");
    const otherSourceAccountId = await f.t.run(async (ctx) => {
      const id = await ctx.db.insert("sourceAccounts", {
        spaceId: f.spaceId,
        connector: "fs",
        accountId: "other-assessment-fs",
        name: "Other assessment filesystem",
        enabled: true,
        cursorVersion: 0,
        freshnessMs: 60_000,
        createdBy: f.userId,
      });
      const credential = (await ctx.db.get(f.credentialId))!;
      await ctx.db.patch(f.credentialId, {
        sourceAccountIds: [...(credential.sourceAccountIds ?? []), id],
      });
      return id;
    });
    const crossSource = parseWorkerRequest({
      protocolVersion: 1,
      operation: "processing.assessPage",
      spaceId: f.spaceId,
      sourceAccountId: otherSourceAccountId,
      requestId: "cross-source-page",
      assessmentId: begun.assessmentId,
      ordinal: 0,
      maxItems: 1,
    });
    if (crossSource.operation !== "processing.assessPage")
      throw new Error("bad request");
    await expect(
      f.t.run((ctx) =>
        advanceProcessingAssessment(ctx, f.principal, crossSource, 202),
      ),
    ).rejects.toThrow("not_found");
    const firstRequest = assessPageRequest(f, begun.assessmentId, 0);
    await f.t.run((ctx) =>
      advanceProcessingAssessment(ctx, f.principal, firstRequest, 203),
    );
    const changedReplay = {
      ...firstRequest,
      ordinal: 1,
    };
    await expect(
      f.t.run((ctx) =>
        advanceProcessingAssessment(ctx, f.principal, changedReplay, 204),
      ),
    ).rejects.toThrow("request_conflict");
    const oldOrdinal = {
      ...firstRequest,
      requestId: "old-page-with-new-id",
    };
    await expect(
      f.t.run((ctx) =>
        advanceProcessingAssessment(ctx, f.principal, oldOrdinal, 205),
      ),
    ).rejects.toThrow("scan_not_ready");
    await f.t.run((ctx) =>
      ctx.db.patch(f.credentialId, { sourceAccountIds: [] }),
    );
    await expect(
      f.t.run((ctx) =>
        advanceProcessingAssessment(
          ctx,
          f.principal,
          assessPageRequest(f, begun.assessmentId, 1),
          206,
        ),
      ),
    ).rejects.toThrow("not_authorized");
    expect(
      await f.t.run(
        async (ctx) =>
          (
            await ctx.db.get(
              ctx.db.normalizeId(
                "workerProcessingAssessments",
                begun.assessmentId,
              )!,
            )
          )?.nextOrdinal,
      ),
    ).toBe(1);
  });

  test("rejects a cross-parent begin receipt without mutating it", async () => {
    const f = await fixture();
    const { scanId } = await seedTerminalScan(f);
    const request = assessBeginRequest(f, scanId);
    const begun = await f.t.run((ctx) =>
      beginProcessingAssessment(ctx, f.principal, request, 200),
    );
    const otherSpaceId = await f.t.run((ctx) =>
      ctx.db.insert("spaces", {
        kind: "shared",
        name: "Other",
        createdBy: f.userId,
      }),
    );
    await f.t.run((ctx) =>
      ctx.db.patch(
        ctx.db.normalizeId("workerProcessingAssessments", begun.assessmentId)!,
        { spaceId: otherSpaceId },
      ),
    );
    await expect(
      f.t.run((ctx) =>
        beginProcessingAssessment(ctx, f.principal, request, 201),
      ),
    ).rejects.toThrow("scan_conflict");
    expect(
      await f.t.run(
        async (ctx) =>
          (
            await ctx.db.get(
              ctx.db.normalizeId(
                "workerProcessingAssessments",
                begun.assessmentId,
              )!,
            )
          )?.state,
      ),
    ).toBe("running");
  });

  test("keeps a published generation ready across a metadata-only observation rebind", async () => {
    const f = await fixture();
    const scanId = await seedReadyMetadataRebind(f, "alpha beta", true);
    const { result } = await completeAssessment(f, scanId);
    expect(result).toMatchObject({
      state: "complete",
      counts: { items: { ready: 1, pending: 0, needsReview: 0 } },
    });
  });

  test("reports pending work, suppresses that snapshot after readiness, and completes a fresh assessment", async () => {
    const f = await fixture();
    const pending = await seedPendingCurrent(f);
    const first = await completeAssessment(
      f,
      pending.scanId,
      f.principal,
      "pending-assessment",
    );
    expect(first.result).toMatchObject({
      state: "incomplete",
      counts: { items: { pending: 1, ready: 0 } },
    });
    await f.t.run(async (ctx) => {
      await ctx.db.patch(pending.generationId, {
        state: "ready",
        activatedAt: 501,
      });
      await ctx.db.patch(pending.jobId, {
        state: "ready",
        nextAttemptAt: undefined,
      });
      await ctx.db.patch(pending.itemId, {
        activeRevisionId: pending.revisionId,
        activeGenerationId: pending.generationId,
      });
      await ctx.db.patch(f.sourceAccountId, { lastProcessedAt: 501 });
    });
    const statusRequest = parseWorkerRequest({
      ...source(f),
      operation: "source.status",
    });
    if (statusRequest.operation !== "source.status")
      throw new Error("bad request");
    expect(
      (
        await f.t.run((ctx) =>
          getWorkerSourceStatus(ctx, f.principal, statusRequest, 600),
        )
      ).processing,
    ).toEqual({ state: "not_assessed" });
    const fresh = await completeAssessment(
      f,
      pending.scanId,
      f.principal,
      "ready-assessment",
    );
    expect(fresh.result).toMatchObject({
      state: "complete",
      counts: { items: { ready: 1, pending: 0 } },
    });
  });

  test("classifies a revoked unfinished actor for review while retaining ready publication", async () => {
    const pendingFixture = await fixture();
    const pending = await seedPendingCurrent(pendingFixture);
    await pendingFixture.t.run((ctx) =>
      ctx.db.patch(pendingFixture.credentialId, { sourceAccountIds: [] }),
    );
    const pendingResult = await completeAssessment(
      pendingFixture,
      pending.scanId,
      pendingFixture.otherPrincipal,
      "revoked-pending-assessment",
    );
    expect(pendingResult.result).toMatchObject({
      state: "incomplete",
      counts: { items: { needsReview: 1, pending: 0 } },
    });

    const readyFixture = await fixture();
    const readyScanId = await seedReadyMetadataRebind(
      readyFixture,
      "alpha beta",
      true,
    );
    await readyFixture.t.run((ctx) =>
      ctx.db.patch(readyFixture.credentialId, { sourceAccountIds: [] }),
    );
    const readyResult = await completeAssessment(
      readyFixture,
      readyScanId,
      readyFixture.otherPrincipal,
      "revoked-ready-assessment",
    );
    expect(readyResult.result).toMatchObject({
      state: "complete",
      counts: { items: { ready: 1, needsReview: 0 } },
    });
  });

  test("assesses the maximum admitted UTF-8 revision within transaction headroom", async () => {
    const f = await fixture();
    const scanId = await seedReadyMetadataRebind(f, "x".repeat(65_536));
    const { result } = await completeAssessment(f, scanId);
    expect(result).toMatchObject({
      state: "complete",
      counts: { items: { ready: 1 } },
    });
  });

  test("fails closed on a near-limit legacy detail row", async () => {
    const f = await fixture();
    const { scanId, sourceItemId } = await seedTerminalScan(f, {
      gapItem: true,
    });
    if (!sourceItemId) throw new Error("missing item");
    await f.t.run((ctx) =>
      ctx.db.patch(sourceItemId, { title: "x".repeat(900_000) }),
    );
    const begun = await f.t.run((ctx) =>
      beginProcessingAssessment(
        ctx,
        f.principal,
        assessBeginRequest(f, scanId),
        200,
      ),
    );
    const result = await f.t.run((ctx) =>
      advanceProcessingAssessment(
        ctx,
        f.principal,
        assessPageRequest(f, begun.assessmentId, 0),
        201,
      ),
    );
    expect(result).toMatchObject({
      state: "stale",
      staleReason: "detail_unavailable",
    });
  });

  test("fails closed when current source modification time disagrees with its entry", async () => {
    const f = await fixture();
    const scanId = await seedReadyMetadataRebind(f);
    await f.t.run(async (ctx) => {
      const item = await ctx.db
        .query("sourceItems")
        .withIndex("by_sourceAccountId", (q) =>
          q.eq("sourceAccountId", f.sourceAccountId),
        )
        .unique();
      if (!item) throw new Error("missing item");
      await ctx.db.patch(item._id, { workerSourceModifiedAt: 19 });
    });
    const { result } = await completeAssessment(f, scanId);
    expect(result).toMatchObject({
      state: "stale",
      staleReason: "detail_unavailable",
    });
  });

  test("fails closed on missing detail, cross-parent detail, and unsafe counters", async () => {
    for (const corruption of ["missing", "cross_parent", "counter"] as const) {
      const f = await fixture();
      const { scanId, sourceItemId } = await seedTerminalScan(f, {
        gapItem: true,
      });
      if (!sourceItemId) throw new Error("missing item");
      const begun = await f.t.run((ctx) =>
        beginProcessingAssessment(
          ctx,
          f.principal,
          assessBeginRequest(f, scanId),
          200,
        ),
      );
      await f.t.run(async (ctx) => {
        const entry = await ctx.db
          .query("workerScanEntries")
          .withIndex("by_scanId_and_sourceItemId", (q) =>
            q.eq("scanId", scanId).eq("sourceItemId", sourceItemId),
          )
          .unique();
        if (!entry) throw new Error("missing entry");
        if (corruption === "missing") await ctx.db.delete(entry._id);
        if (corruption === "cross_parent") {
          const otherSpaceId = await ctx.db.insert("spaces", {
            kind: "shared",
            name: "Cross parent",
            createdBy: f.userId,
          });
          await ctx.db.patch(entry._id, { spaceId: otherSpaceId });
        }
        if (corruption === "counter") {
          const id = ctx.db.normalizeId(
            "workerProcessingAssessments",
            begun.assessmentId,
          )!;
          const assessment = (await ctx.db.get(id))!;
          await ctx.db.patch(id, {
            counts: {
              ...assessment.counts,
              items: {
                ...assessment.counts.items,
                explicitGap: Number.MAX_SAFE_INTEGER,
              },
            },
          });
        }
      });
      const result = await f.t.run((ctx) =>
        advanceProcessingAssessment(
          ctx,
          f.principal,
          assessPageRequest(f, begun.assessmentId, 0),
          201,
        ),
      );
      expect(result).toMatchObject({
        state: "stale",
        staleReason: "detail_unavailable",
      });
    }
  });

  test("a generic lifecycle write after item counting makes finalization and replays stale", async () => {
    const f = await fixture();
    const { scanId, sourceItemId } = await seedTerminalScan(f, {
      gapItem: true,
    });
    if (!sourceItemId) throw new Error("missing item");
    const request = assessBeginRequest(f, scanId);
    const begun = await f.t.run((ctx) =>
      beginProcessingAssessment(ctx, f.principal, request, 200),
    );
    const firstRequest = assessPageRequest(f, begun.assessmentId, 0);
    const first = await f.t.run((ctx) =>
      advanceProcessingAssessment(ctx, f.principal, firstRequest, 201),
    );
    expect(first).toMatchObject({
      state: "running",
      phase: "unresolved_entries",
    });
    await f.t.run((ctx) =>
      markSourceUnavailable(ctx, {
        principal: { userId: f.userId },
        sourceItemId,
      }),
    );
    const finalRequest = assessPageRequest(f, begun.assessmentId, 1);
    const stale = await f.t.run((ctx) =>
      advanceProcessingAssessment(ctx, f.principal, finalRequest, 202),
    );
    expect(stale).toMatchObject({
      state: "stale",
      staleReason: "source_changed",
    });
    expect(
      await f.t.run((ctx) =>
        advanceProcessingAssessment(ctx, f.principal, finalRequest, 203),
      ),
    ).toMatchObject({ state: "stale", reused: true });
    expect(
      await f.t.run((ctx) =>
        beginProcessingAssessment(ctx, f.principal, request, 204),
      ),
    ).toMatchObject({ state: "stale", reused: true });
    expect(
      await f.t.run((ctx) =>
        advanceProcessingAssessment(ctx, f.principal, finalRequest, 205),
      ),
    ).toMatchObject({ state: "stale", reused: true });
  });

  test("a generic new admission after item counting invalidates finalization", async () => {
    const f = await fixture();
    const { scanId } = await seedTerminalScan(f, { gapItem: true });
    const begun = await f.t.run((ctx) =>
      beginProcessingAssessment(
        ctx,
        f.principal,
        namedAssessBeginRequest(f, scanId, "generic-admission-assessment"),
        200,
      ),
    );
    await f.t.run((ctx) =>
      advanceProcessingAssessment(
        ctx,
        f.principal,
        assessPageRequest(f, begun.assessmentId, 0),
        201,
      ),
    );
    await f.t.run((ctx) =>
      admitSourceRevision(ctx, {
        principal: { userId: f.userId },
        sourceAccountId: f.sourceAccountId,
        requestId: "generic-new-item",
        expectedDesiredProcessingEpoch: 0,
        source: {
          externalId: "generic-new-item",
          title: "Generic item",
          docType: "text",
          uri: "fs://generic-new.txt",
          capturedAt: 202,
          mediaType: FS_TEXT_PROFILE.mediaType,
          inlineText: "new",
        },
        processing: {
          extractionFingerprint: FS_TEXT_PROFILE.extractionFingerprint,
          extractorFingerprint: FS_TEXT_PROFILE.extractorFingerprint,
          recordSchemaFingerprint: FS_TEXT_PROFILE.recordSchemaFingerprint,
          normalizationFingerprint: FS_TEXT_PROFILE.normalizationFingerprint,
          chunkerFingerprint: FS_TEXT_PROFILE.chunkerFingerprint,
          correctionRevision: "generic:v1",
          expectedPageCount: 1,
          expectedEvidenceSpanCount: 1,
          expectedDocumentCount: 1,
          expectedChunkCount: 1,
          expectedEventCount: 0,
          expectedObservationCount: 0,
        },
      }),
    );
    expect(
      await f.t.run((ctx) =>
        advanceProcessingAssessment(
          ctx,
          f.principal,
          assessPageRequest(f, begun.assessmentId, 1),
          203,
        ),
      ),
    ).toMatchObject({ state: "stale", staleReason: "source_changed" });
  });
});
