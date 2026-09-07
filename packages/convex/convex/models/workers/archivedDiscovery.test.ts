import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  admitArchivedDiscovery,
  artifactBoundExtractionFingerprint,
  lookupArchivedAdmission,
  preflightArchivedDiscovery,
  reserveArchivedDiscovery,
} from "./archivedDiscovery";
import { reserveDiscoveryWork } from "./discovery";
import { reserveProcessingJobs } from "./jobs";
import { parseWorkerRequest } from "./protocol";
import { sha256Utf8 } from "../provenance/model";
import {
  appendWorkerScanPage,
  beginWorkerScan,
  reconcileWorkerScan,
  sealWorkerScan,
} from "./model";

const RAW_HASH = "a".repeat(64);
const OUTPUT_HASH = "b".repeat(64);
const TEXT_HASH = "c".repeat(64);
const BUNDLE_HASH = "d".repeat(64);
const MAPPING_HASH = "e".repeat(64);
const PROCESSING_DIGEST = "f".repeat(64);
const PROFILE = {
  parserFingerprint: "1".repeat(64),
  extractionConfigurationFingerprint: "3".repeat(64),
  extractorFingerprint: "docling-document-qa:v1",
  recordSchemaFingerprint: "no-records:v1",
  normalizationFingerprint: "docling-pages:v1",
  chunkerFingerprint: "page-aware:v1",
  correctionRevision: "correction:1",
};

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Binary owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Binary test",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "fs",
      accountId: "binary-test",
      name: "Binary test",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      inventoryEpoch: 1,
      completedInventoryEpoch: 1,
      manifestVersion: 1,
      binaryProfileId: "pdf_docqa_v1",
      binaryProfileAuditDigest: "1".repeat(64),
      binaryProfileEnabledAt: 10,
      workerAssessmentEpoch: 0,
      createdBy: userId,
    });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "2".repeat(64),
      keyPrefix: "worker",
      name: "Binary worker",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    const sourceItemId = await ctx.db.insert("sourceItems", {
      spaceId,
      sourceAccountId,
      externalIdHash: "3".repeat(64),
      externalId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139",
      title: "Synthetic PDF",
      docType: "pdf",
      uri: "fs://documents/synthetic.pdf",
      lifecycle: "available",
      originalLinkAvailable: true,
      desiredProcessingEpoch: 0,
      workerObservationEpoch: 1,
      workerProcessingEpoch: 1,
      workerInventoryMetadataDigest: "4".repeat(64),
      workerProcessingIdentityDigest: PROCESSING_DIGEST,
      workerContentHash: RAW_HASH,
      workerSourceModifiedAt: 20,
      workerProfileId: "pdf_docqa_v1",
      workerLastSeenInventoryEpoch: 1,
    });
    const scanId = await ctx.db.insert("workerSourceScans", {
      spaceId,
      sourceAccountId,
      requestId: "scan-1",
      requestDigest: "5".repeat(64),
      watcherId: "watcher",
      connectorVersion: "test",
      mode: "normal",
      inventoryEpoch: 1,
      manifestVersionAtBegin: 0,
      actorUserId: userId,
      actorCredentialId: credentialId,
      state: "enumerated",
      nextPageOrdinal: 1,
      inventoryDone: true,
      pageCount: 1,
      entryCount: 1,
      changedCount: 1,
      gapCount: 0,
      reviewCount: 0,
      manifestVersionAtSeal: 1,
      reconcileManifestVersion: 1,
      nextReconcileOrdinal: 1,
      startedAt: 10,
      sealedAt: 20,
      completedAt: 30,
      expiresAt: 1_000_000,
      retireAt: 2_000_000,
    });
    const pageId = await ctx.db.insert("workerScanPages", {
      spaceId,
      sourceAccountId,
      scanId,
      ordinal: 0,
      requestId: "page-1",
      requestDigest: "6".repeat(64),
      entryCount: 1,
      createdAt: 20,
      retireAt: 2_000_000,
    });
    const placeholderEntryId = await ctx.db.insert("workerScanEntries", {
      spaceId,
      sourceAccountId,
      scanId,
      scanPageId: pageId,
      sourceItemId,
      identityKeyHash: "7".repeat(64),
      externalIdHash: "3".repeat(64),
      uriDigest: "8".repeat(64),
      inventoryMetadataDigest: "4".repeat(64),
      processingIdentityDigest: PROCESSING_DIGEST,
      contentHash: RAW_HASH,
      byteLength: 1_024,
      contentRepresentation: "archived_binary_v1",
      binaryParserProfileId: "pdf_docqa_v1",
      binaryMediaType: "application/pdf",
      ...PROFILE,
      sourceModifiedAt: 20,
      observationEpoch: 1,
      processingEpoch: 1,
      state: "queued",
      observedAt: 20,
      retireAt: 2_000_000,
    });
    const workId = await ctx.db.insert("workerDiscoveryWork", {
      spaceId,
      sourceAccountId,
      sourceItemId,
      scanId,
      scanEntryId: placeholderEntryId,
      observationEpoch: 1,
      processingEpoch: 1,
      expectedDesiredProcessingEpoch: 0,
      state: "queued",
      contentHash: RAW_HASH,
      byteLength: 1_024,
      capturedAt: 20,
      sourceModifiedAt: 20,
      mediaType: "application/pdf",
      profileId: "pdf_docqa_v1",
      contentRepresentation: "archived_binary_v1",
      ...PROFILE,
      extractionFingerprint: "artifact-bound-extraction:v1",
      title: "Synthetic PDF",
      docType: "pdf",
      uri: "fs://documents/synthetic.pdf",
      actorUserId: userId,
      actorCredentialId: credentialId,
      attempts: 0,
      leaseEpoch: 0,
      nextAttemptAt: 100,
      createdAt: 20,
      retireAt: 2_000_000,
    });
    await ctx.db.patch(placeholderEntryId, { discoveryWorkId: workId });
    return {
      userId,
      spaceId,
      sourceAccountId,
      credentialId,
      sourceItemId,
      scanId,
      workId,
    };
  });
  return {
    t,
    ...ids,
    principal: { userId: ids.userId, credentialId: ids.credentialId },
  };
}

function base(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    protocolVersion: 1 as const,
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
  };
}

function identity(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    sourceItemId: f.sourceItemId,
    scanId: f.scanId,
    observationEpoch: 1,
    processingEpoch: 1,
    contentHash: RAW_HASH,
    byteLength: 1_024,
    mediaType: "application/pdf" as const,
    parserProfileId: "pdf_docqa_v1" as const,
    ...PROFILE,
  };
}

function archive(
  kind: "original_bytes" | "parser_output",
  role: "primary" | "independent_backup",
  offset: number,
) {
  const hex = ((offset % 14) + 1).toString(16);
  return {
    kind: "create" as const,
    subjectKind: kind,
    copyRole: role,
    clientReceiptId: `01890a5d-ac96-7cc4-bb7e-6f4f5ca5c1${50 + offset}`,
    archiveProfileFingerprint: hex.repeat(64),
    archiveIdentityFingerprint: ((offset + 2) % 15).toString(16).repeat(64),
    recipientFingerprint: ((offset + 3) % 15).toString(16).repeat(64),
    repositoryKeyDomainFingerprint: ((offset + 4) % 15).toString(16).repeat(64),
    storageFailureDomainFingerprint: ((offset + 5) % 15)
      .toString(16)
      .repeat(64),
    archiveObjectId: `01890a5d-ac96-7cc4-bb7e-6f4f5ca5c1${60 + offset}`,
    ciphertextHash: ((offset + 6) % 15).toString(16).repeat(64),
    ciphertextByteLength: kind === "original_bytes" ? 1_100 : 2_100,
    createdAt: 200 + offset,
    readbackVerifiedAt: 210 + offset,
  };
}

describe("archived discovery admission", () => {
  test("matches the parser adapter artifact-bound extraction vector", async () => {
    await expect(
      artifactBoundExtractionFingerprint(
        "1".repeat(64),
        "2".repeat(64),
        "3".repeat(64),
      ),
    ).resolves.toBe(
      "1317bec934444929bd672b3c59398d1656e66d500a8208713027690d926256fd",
    );
  });

  test("persists the full pre-parse identity and advances work for a correction", async () => {
    const f = await fixture();
    const scanOnce = async (
      expectedInventoryEpoch: number,
      correctionRevision: string,
      suffix: string,
    ) => {
      const beginRequest = parseWorkerRequest({
        ...base(f),
        operation: "scan.begin",
        requestId: `begin-${suffix}`,
        watcherId: "binary-watcher",
        connectorVersion: "binary-v1",
        mode: "normal",
        expectedInventoryEpoch,
      });
      if (beginRequest.operation !== "scan.begin") throw new Error("bad begin");
      const scan = await f.t.run((ctx) =>
        beginWorkerScan(
          ctx,
          f.principal,
          beginRequest,
          1_000 + expectedInventoryEpoch,
        ),
      );
      const appendRequest = parseWorkerRequest({
        ...base(f),
        operation: "scan.appendPage",
        scanId: scan.scanId,
        requestId: `page-${suffix}`,
        ordinal: 0,
        entries: [
          {
            externalId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c199",
            uri: "fs://documents/new.pdf",
            title: "New PDF",
            docType: "pdf",
            sourceModifiedAt: 100,
            content: {
              status: "ready_binary_v1",
              sha256: "9".repeat(64),
              byteLength: 2_048,
              mediaType: "application/pdf",
              parserProfileId: "pdf_docqa_v1",
              ...PROFILE,
              correctionRevision,
            },
          },
        ],
      });
      if (appendRequest.operation !== "scan.appendPage")
        throw new Error("bad append");
      const appended = await f.t.run((ctx) =>
        appendWorkerScanPage(
          ctx,
          f.principal,
          appendRequest,
          1_100 + expectedInventoryEpoch,
        ),
      );
      const sealRequest = parseWorkerRequest({
        ...base(f),
        operation: "scan.seal",
        scanId: scan.scanId,
        requestId: `seal-${suffix}`,
        expectedPageCount: 1,
        health: { status: "healthy" },
      });
      if (sealRequest.operation !== "scan.seal") throw new Error("bad seal");
      await f.t.run((ctx) =>
        sealWorkerScan(
          ctx,
          f.principal,
          sealRequest,
          1_200 + expectedInventoryEpoch,
        ),
      );
      const reconcileRequest = parseWorkerRequest({
        ...base(f),
        operation: "scan.reconcile",
        scanId: scan.scanId,
        requestId: `reconcile-${suffix}`,
        expectedInventoryEpoch: scan.inventoryEpoch,
        ordinal: 0,
        maxItems: 50,
      });
      if (reconcileRequest.operation !== "scan.reconcile")
        throw new Error("bad reconcile");
      await f.t.run((ctx) =>
        reconcileWorkerScan(
          ctx,
          f.principal,
          reconcileRequest,
          1_300 + expectedInventoryEpoch,
        ),
      );
      return appended.entries[0]!;
    };
    const first = await scanOnce(1, "correction:1", "one");
    const second = await scanOnce(2, "correction:2", "two");
    expect(first.processingEpoch).toBe(1);
    expect(second.processingEpoch).toBe(2);
    const externalHash = await sha256Utf8(
      "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c199",
    );
    const latest = await f.t.run(async (ctx) => {
      const item = await ctx.db
        .query("sourceItems")
        .withIndex("by_sourceAccountId_and_externalIdHash", (q) =>
          q
            .eq("sourceAccountId", f.sourceAccountId)
            .eq("externalIdHash", externalHash),
        )
        .unique();
      if (!item) throw new Error("missing corrected item");
      return await ctx.db
        .query("workerDiscoveryWork")
        .withIndex("by_sourceItemId_and_observationEpoch", (q) =>
          q.eq("sourceItemId", item._id).eq("observationEpoch", 1),
        )
        .collect();
    });
    expect(latest.find((work) => work.processingEpoch === 2)).toMatchObject({
      contentRepresentation: "archived_binary_v1",
      parserFingerprint: PROFILE.parserFingerprint,
      extractionConfigurationFingerprint:
        PROFILE.extractionConfigurationFingerprint,
      correctionRevision: "correction:2",
    });
  });

  test("resolves exact work, replays reservation, admits atomically, and stays out of legacy queues", async () => {
    const f = await fixture();
    const extractionFingerprint = await sha256Utf8(
      `kith-parsed-extraction:v1\0${JSON.stringify([
        PROFILE.parserFingerprint,
        OUTPUT_HASH,
        PROFILE.extractionConfigurationFingerprint,
      ])}`,
    );
    const preflight = parseWorkerRequest({
      ...base(f),
      operation: "discovery.preflightArchived",
      requestId: "preflight-1",
      identity: identity(f),
      archiveIntentDigest: "9".repeat(64),
    });
    if (preflight.operation !== "discovery.preflightArchived")
      throw new Error("bad preflight");
    await expect(
      f.t.run((ctx) =>
        preflightArchivedDiscovery(ctx, f.principal, preflight, 100),
      ),
    ).resolves.toMatchObject({
      workId: f.workId,
      expectedDesiredProcessingEpoch: 0,
    });

    const reserve = parseWorkerRequest({
      ...base(f),
      operation: "discovery.reserveArchived",
      requestId: "reserve-1",
      identity: identity(f),
    });
    if (reserve.operation !== "discovery.reserveArchived")
      throw new Error("bad reserve");
    const first = await f.t.run((ctx) =>
      reserveArchivedDiscovery(ctx, f.principal, reserve, "a".repeat(64), 100),
    );
    const replay = await f.t.run((ctx) =>
      reserveArchivedDiscovery(ctx, f.principal, reserve, "b".repeat(64), 101),
    );
    expect(replay).toEqual({ ...first, reused: true });

    const legacyReserve = parseWorkerRequest({
      ...base(f),
      operation: "discovery.reserve",
      requestId: "legacy-reserve",
      maxItems: 1,
    });
    if (legacyReserve.operation !== "discovery.reserve")
      throw new Error("bad legacy reserve");
    await expect(
      f.t.run((ctx) =>
        reserveDiscoveryWork(
          ctx,
          f.principal,
          legacyReserve,
          ["f".repeat(64)],
          102,
        ),
      ),
    ).resolves.toMatchObject({ targets: [] });

    const request = parseWorkerRequest({
      ...base(f),
      operation: "discovery.admitArchived",
      requestId: "admit-1",
      workId: first.workId,
      leaseEpoch: first.leaseEpoch,
      leaseToken: first.leaseToken,
      parserArtifact: {
        kind: "create",
        clientArtifactId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c140",
        outputHash: OUTPUT_HASH,
        outputByteLength: 2_048,
        outputMediaType: "application/vnd.docling+json",
        createdAt: 200,
      },
      archives: [
        archive("original_bytes", "primary", 1),
        archive("original_bytes", "independent_backup", 2),
        archive("parser_output", "primary", 3),
        archive("parser_output", "independent_backup", 4),
      ],
      parsedText: {
        extractionFingerprint,
        textHash: TEXT_HASH,
        byteLength: 512,
        utf16Length: 500,
        pageCount: 2,
        mappingManifestHash: MAPPING_HASH,
        normalizedBundleDigest: BUNDLE_HASH,
        expectedEvidenceSpanCount: 2,
        expectedDocumentCount: 1,
        expectedChunkCount: 2,
      },
    });
    if (request.operation !== "discovery.admitArchived")
      throw new Error("bad admission");
    if (request.parserArtifact.kind !== "create")
      throw new Error("bad parser artifact");
    expect(() =>
      parseWorkerRequest({
        ...request,
        parsedText: { ...request.parsedText, expectedDocumentCount: 17 },
      }),
    ).toThrow();
    const wrongExtraction = parseWorkerRequest({
      ...request,
      requestId: "admit-wrong-extraction",
      parsedText: {
        ...request.parsedText,
        extractionFingerprint: "0".repeat(64),
      },
    });
    if (wrongExtraction.operation !== "discovery.admitArchived") {
      throw new Error("bad wrong-extraction request");
    }
    await expect(
      f.t.run((ctx) =>
        admitArchivedDiscovery(ctx, f.principal, wrongExtraction, 109),
      ),
    ).rejects.toThrow();
    expect(
      await f.t.run((ctx) => ctx.db.query("sourceRevisions").collect()),
    ).toEqual([]);
    const admitted = await f.t.run((ctx) =>
      admitArchivedDiscovery(ctx, f.principal, request, 110),
    );
    const admittedReplay = await f.t.run((ctx) =>
      admitArchivedDiscovery(ctx, f.principal, request, 111),
    );
    expect(admittedReplay).toEqual({ ...admitted, reused: true });
    const rows = await f.t.run(async (ctx) => ({
      revisions: await ctx.db.query("sourceRevisions").collect(),
      artifacts: await ctx.db.query("sourceParserArtifacts").collect(),
      receipts: await ctx.db.query("sourceArtifactArchiveReceipts").collect(),
      bindings: await ctx.db.query("sourceArtifactArchiveBindings").collect(),
      text: await ctx.db.query("sourceTextVersions").collect(),
      generations: await ctx.db.query("processingGenerations").collect(),
      jobs: await ctx.db.query("ingestJobs").collect(),
    }));
    expect(rows.revisions).toHaveLength(1);
    expect(rows.artifacts).toHaveLength(1);
    expect(rows.receipts).toHaveLength(4);
    expect(rows.bindings).toHaveLength(4);
    expect(rows.text[0]).toMatchObject({
      representation: "parsed_pages_v1",
      evidenceSealed: false,
    });
    expect(rows.generations[0]).toMatchObject({
      normalizedBundleDigest: BUNDLE_HASH,
      state: "queued",
    });
    expect(rows.jobs[0]).toMatchObject({
      workerProcessingMode: "parsed_pages_v1",
      state: "queued",
    });

    const lookup = parseWorkerRequest({
      ...base(f),
      operation: "discovery.lookupArchivedAdmission",
      requestId: "lookup-1",
      identity: identity(f),
      lookup: {
        mode: "processing",
        clientArtifactId: request.parserArtifact.clientArtifactId,
        parserOutputHash: request.parserArtifact.outputHash,
        parserOutputByteLength: request.parserArtifact.outputByteLength,
        parserOutputMediaType: request.parserArtifact.outputMediaType,
        parsedText: request.parsedText,
      },
    });
    if (lookup.operation !== "discovery.lookupArchivedAdmission") {
      throw new Error("bad lookup");
    }
    await expect(
      f.t.run((ctx) => lookupArchivedAdmission(ctx, f.principal, lookup)),
    ).resolves.toMatchObject({
      found: true,
      processingGenerationId: admitted.processingGenerationId,
      ingestJobId: admitted.ingestJobId,
    });

    const otherSourceAccountId = await f.t.run((ctx) =>
      ctx.db.insert("sourceAccounts", {
        spaceId: f.spaceId,
        connector: "fs",
        accountId: "other-binary-test",
        name: "Other binary test",
        enabled: true,
        cursorVersion: 0,
        freshnessMs: 60_000,
        createdBy: f.userId,
      }),
    );
    await f.t.run((ctx) =>
      ctx.db.patch(rows.jobs[0]!._id, {
        sourceAccountId: otherSourceAccountId,
      }),
    );
    await expect(
      f.t.run((ctx) => lookupArchivedAdmission(ctx, f.principal, lookup)),
    ).rejects.toThrow();
    await f.t.run((ctx) =>
      ctx.db.patch(rows.jobs[0]!._id, {
        sourceAccountId: f.sourceAccountId,
      }),
    );
    await f.t.run((ctx) =>
      ctx.db.patch(f.sourceItemId, { desiredProcessingEpoch: 2 }),
    );
    await expect(
      f.t.run((ctx) => lookupArchivedAdmission(ctx, f.principal, lookup)),
    ).rejects.toThrow();
    await f.t.run((ctx) =>
      ctx.db.patch(f.sourceItemId, { desiredProcessingEpoch: 1 }),
    );

    const jobsReserve = parseWorkerRequest({
      ...base(f),
      operation: "jobs.reserve",
      requestId: "legacy-jobs",
      maxItems: 1,
    });
    if (jobsReserve.operation !== "jobs.reserve")
      throw new Error("bad jobs reserve");
    await expect(
      f.t.run((ctx) =>
        reserveProcessingJobs(
          ctx,
          f.principal,
          jobsReserve,
          ["e".repeat(64)],
          112,
        ),
      ),
    ).resolves.toMatchObject({ targets: [] });

    const changedBody = parseWorkerRequest({
      ...request,
      parsedText: { ...request.parsedText, textHash: "0".repeat(64) },
    });
    if (changedBody.operation !== "discovery.admitArchived") {
      throw new Error("bad changed-body request");
    }
    await expect(
      f.t.run((ctx) =>
        admitArchivedDiscovery(ctx, f.principal, changedBody, 113),
      ),
    ).rejects.toThrow();

    await f.t.run(async (ctx) => {
      const binding = await ctx.db
        .query("sourceArtifactArchiveBindings")
        .withIndex("by_receiptId", (q) =>
          q.eq("receiptId", rows.generations[0]!.originalPrimaryReceiptId!),
        )
        .unique();
      if (!binding) throw new Error("missing binding");
      await ctx.db.patch(binding._id, { bindingEpoch: 1 });
    });
    await expect(
      f.t.run((ctx) => lookupArchivedAdmission(ctx, f.principal, lookup)),
    ).rejects.toThrow();
    await expect(
      f.t.run((ctx) => admitArchivedDiscovery(ctx, f.principal, request, 114)),
    ).rejects.toThrow();

    const binaryProcessingDigest = await sha256Utf8(
      `worker-fs-binary-processing-identity:v1\0${JSON.stringify([
        RAW_HASH,
        "application/pdf",
        "pdf_docqa_v1",
        PROFILE.parserFingerprint,
        PROFILE.extractionConfigurationFingerprint,
        PROFILE.extractorFingerprint,
        PROFILE.recordSchemaFingerprint,
        PROFILE.normalizationFingerprint,
        PROFILE.chunkerFingerprint,
        PROFILE.correctionRevision,
      ])}`,
    );
    const sourceExternalIdHash = await sha256Utf8(
      "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139",
    );
    await f.t.run(async (ctx) => {
      await ctx.db.patch(rows.generations[0]!._id, { state: "ready" });
      await ctx.db.patch(rows.jobs[0]!._id, { state: "ready" });
      await ctx.db.patch(f.sourceItemId, {
        activeRevisionId: rows.revisions[0]!._id,
        activeGenerationId: rows.generations[0]!._id,
        externalIdHash: sourceExternalIdHash,
        workerProcessingIdentityDigest: binaryProcessingDigest,
      });
    });
    const scanBinary = async (
      expectedInventoryEpoch: number,
      suffix: string,
      correctionRevision: string,
    ) => {
      const beginRequest = parseWorkerRequest({
        ...base(f),
        operation: "scan.begin",
        requestId: `active-begin-${suffix}`,
        watcherId: "binary-watcher",
        connectorVersion: "binary-v1",
        mode: "normal",
        expectedInventoryEpoch,
      });
      if (beginRequest.operation !== "scan.begin") throw new Error("bad begin");
      const scan = await f.t.run((ctx) =>
        beginWorkerScan(
          ctx,
          f.principal,
          beginRequest,
          300 + expectedInventoryEpoch,
        ),
      );
      const appendRequest = parseWorkerRequest({
        ...base(f),
        operation: "scan.appendPage",
        scanId: scan.scanId,
        requestId: `active-page-${suffix}`,
        ordinal: 0,
        entries: [
          {
            externalId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139",
            uri: "fs://documents/synthetic.pdf",
            title: "Synthetic PDF",
            docType: "pdf",
            sourceModifiedAt: 20,
            content: {
              status: "ready_binary_v1",
              sha256: RAW_HASH,
              byteLength: 1_024,
              mediaType: "application/pdf",
              parserProfileId: "pdf_docqa_v1",
              ...PROFILE,
              correctionRevision,
            },
          },
        ],
      });
      if (appendRequest.operation !== "scan.appendPage") {
        throw new Error("bad append");
      }
      const appended = await f.t.run((ctx) =>
        appendWorkerScanPage(
          ctx,
          f.principal,
          appendRequest,
          310 + expectedInventoryEpoch,
        ),
      );
      const sealRequest = parseWorkerRequest({
        ...base(f),
        operation: "scan.seal",
        scanId: scan.scanId,
        requestId: `active-seal-${suffix}`,
        expectedPageCount: 1,
        health: { status: "healthy" },
      });
      if (sealRequest.operation !== "scan.seal") throw new Error("bad seal");
      await f.t.run((ctx) =>
        sealWorkerScan(
          ctx,
          f.principal,
          sealRequest,
          320 + expectedInventoryEpoch,
        ),
      );
      const reconcileRequest = parseWorkerRequest({
        ...base(f),
        operation: "scan.reconcile",
        scanId: scan.scanId,
        requestId: `active-reconcile-${suffix}`,
        expectedInventoryEpoch: scan.inventoryEpoch,
        ordinal: 0,
        maxItems: 50,
      });
      if (reconcileRequest.operation !== "scan.reconcile") {
        throw new Error("bad reconcile");
      }
      await f.t.run((ctx) =>
        reconcileWorkerScan(
          ctx,
          f.principal,
          reconcileRequest,
          330 + expectedInventoryEpoch,
        ),
      );
      return appended.entries[0]!;
    };
    await expect(scanBinary(1, "same", "correction:1")).resolves.toMatchObject({
      state: "unchanged",
      processingEpoch: 1,
    });
    await expect(
      scanBinary(2, "correction", "correction:2"),
    ).resolves.toMatchObject({
      state: "queued",
      processingEpoch: 2,
    });
  });

  test("rejects unknown binary markers and absent source gates without writes", async () => {
    expect(() =>
      parseWorkerRequest({
        protocolVersion: 1,
        operation: "scan.appendPage",
        spaceId: "space",
        sourceAccountId: "source",
        scanId: "scan",
        requestId: "page",
        ordinal: 0,
        entries: [
          {
            externalId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139",
            uri: "fs://documents/a.pdf",
            sourceModifiedAt: 1,
            content: {
              status: "ready_binary_v2",
              sha256: RAW_HASH,
              byteLength: 1,
            },
          },
        ],
      }),
    ).toThrow();
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.patch(f.sourceAccountId, {
        binaryProfileId: undefined,
        binaryProfileAuditDigest: undefined,
        binaryProfileEnabledAt: undefined,
      }),
    );
    const request = parseWorkerRequest({
      ...base(f),
      operation: "discovery.preflightArchived",
      requestId: "preflight",
      identity: identity(f),
      archiveIntentDigest: "9".repeat(64),
    });
    if (request.operation !== "discovery.preflightArchived")
      throw new Error("bad preflight");
    await expect(
      f.t.run((ctx) =>
        preflightArchivedDiscovery(ctx, f.principal, request, 100),
      ),
    ).rejects.toThrow();
    expect(
      await f.t.run((ctx) => ctx.db.query("sourceRevisions").collect()),
    ).toEqual([]);
  });

  test("denies a revoked executing credential before archive identity reads", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.delete(f.credentialId));
    const request = parseWorkerRequest({
      ...base(f),
      operation: "discovery.preflightArchived",
      requestId: "revoked-preflight",
      identity: identity(f),
      archiveIntentDigest: "9".repeat(64),
    });
    if (request.operation !== "discovery.preflightArchived") {
      throw new Error("bad preflight");
    }
    await expect(
      f.t.run((ctx) =>
        preflightArchivedDiscovery(ctx, f.principal, request, 100),
      ),
    ).rejects.toThrow();
    expect(
      await f.t.run((ctx) =>
        ctx.db.query("sourceArtifactArchiveReceipts").collect(),
      ),
    ).toEqual([]);
  });
});
