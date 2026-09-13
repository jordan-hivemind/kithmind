import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  admitArchivedDiscovery,
  artifactBoundExtractionFingerprint,
  failArchivedDiscovery,
  lookupArchivedAdmission,
  preflightArchivedDiscovery,
  reserveArchivedDiscovery,
} from "./archivedDiscovery";
import { reserveDiscoveryWork } from "./discovery";
import { reserveProcessingJobs } from "./jobs";
import { parseWorkerRequest } from "./protocol";
import {
  activateParsedJob,
  beginParsedStage,
  renewParsedJob,
  reserveParsedJobs,
  sealParsedStage,
  stageParsedBatch,
} from "./parsedJobs";
import { digestParsedMappingManifest } from "./parsedProtocol";
import {
  advanceProcessingAssessment,
  beginProcessingAssessment,
} from "./assessment";
import {
  beginSourceItemForget,
  deleteSourceItemProvenanceBatch,
  sha256Utf8,
} from "../provenance/model";
import { verifySealedParsedPayload } from "../provenance/parsedStaging";
import { providerOriginalReferenceFingerprint } from "../provenance/providerOriginals";
import { getDocument } from "../documents/model";
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
    const externalId = "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139";
    const externalIdHash = await sha256Utf8(externalId);
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
    const uri = "fs://documents/synthetic.pdf";
    const uriDigest = await sha256Utf8(
      `worker-fs-uri:v1\0${JSON.stringify([sourceAccountId, uri])}`,
    );
    const processingIdentityDigest = await sha256Utf8(
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
    const inventoryMetadataDigest = await sha256Utf8(
      `worker-fs-binary-inventory-metadata:v1\0${JSON.stringify([
        externalIdHash,
        uriDigest,
        "Synthetic PDF",
        "pdf",
        20,
        "ready_binary_v1",
        RAW_HASH,
        1_024,
        "pdf_docqa_v1",
      ])}`,
    );
    const sourceItemId = await ctx.db.insert("sourceItems", {
      spaceId,
      sourceAccountId,
      externalIdHash,
      externalId,
      title: "Synthetic PDF",
      docType: "pdf",
      uri,
      lifecycle: "available",
      originalLinkAvailable: true,
      desiredProcessingEpoch: 0,
      workerObservationEpoch: 1,
      workerProcessingEpoch: 1,
      workerInventoryMetadataDigest: inventoryMetadataDigest,
      workerProcessingIdentityDigest: processingIdentityDigest,
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
      externalIdHash,
      uriDigest,
      inventoryMetadataDigest,
      processingIdentityDigest,
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
      uri,
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

function providerOriginal(sourceContentHash = RAW_HASH) {
  return {
    referenceVersion: "provider_original_v1" as const,
    providerKind: "dropbox_v1" as const,
    clientReferenceId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c149",
    sourceContentHash,
    sourceByteLength: 1_024,
    providerAccountIdHash: "4".repeat(64),
    providerRootDirectoryIdHash: "5".repeat(64),
    providerFileIdHash: "6".repeat(64),
    providerRevision: "015f00feed",
    providerContentHash: "7".repeat(64),
    verifiedAt: 105,
    locatorBundle: {
      bindingId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c148",
      manifestFingerprint: "8".repeat(64),
      recipientFingerprint: "9".repeat(64),
      repositoryKeyDomainFingerprint: "a".repeat(64),
      repositoryId: "b".repeat(64),
      snapshotId: "c".repeat(64),
      objectName: "provider-locator.json.age",
      ciphertextHash: "d".repeat(64),
      ciphertextByteLength: 512,
      readbackVerifiedAt: 106,
    },
    createdAt: 100,
  };
}

async function admitParsedFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  declaration: {
    textHash: string;
    byteLength: number;
    utf16Length: number;
    mappingManifestHash: string;
  },
) {
  const extractionFingerprint = await artifactBoundExtractionFingerprint(
    PROFILE.parserFingerprint,
    OUTPUT_HASH,
    PROFILE.extractionConfigurationFingerprint,
  );
  const reserve = parseWorkerRequest({
    ...base(f),
    operation: "discovery.reserveArchived",
    requestId: "reserve-parsed",
    identity: identity(f),
  });
  if (reserve.operation !== "discovery.reserveArchived")
    throw new Error("bad reserve");
  const leased = await f.t.run((ctx) =>
    reserveArchivedDiscovery(ctx, f.principal, reserve, "a".repeat(64), 100),
  );
  const admit = parseWorkerRequest({
    ...base(f),
    operation: "discovery.admitArchived",
    requestId: "admit-parsed",
    workId: leased.workId,
    leaseEpoch: leased.leaseEpoch,
    leaseToken: leased.leaseToken,
    parserArtifact: {
      kind: "create",
      clientArtifactId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c140",
      outputHash: OUTPUT_HASH,
      outputByteLength: 2048,
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
      ...declaration,
      pageCount: 1,
      normalizedBundleDigest: BUNDLE_HASH,
      expectedEvidenceSpanCount: 1,
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
    },
  });
  if (admit.operation !== "discovery.admitArchived")
    throw new Error("bad admit");
  return {
    admitted: await f.t.run((ctx) =>
      admitArchivedDiscovery(ctx, f.principal, admit, 110),
    ),
    extractionFingerprint,
  };
}

describe("archived discovery admission", () => {
  test("provider reference fingerprint is independent of locator object insertion order", async () => {
    const declaration = providerOriginal();
    const reordered = {
      ...declaration,
      locatorBundle: {
        objectName: declaration.locatorBundle.objectName,
        snapshotId: declaration.locatorBundle.snapshotId,
        bindingId: declaration.locatorBundle.bindingId,
        ciphertextByteLength:
          declaration.locatorBundle.ciphertextByteLength,
        repositoryId: declaration.locatorBundle.repositoryId,
        readbackVerifiedAt: declaration.locatorBundle.readbackVerifiedAt,
        recipientFingerprint: declaration.locatorBundle.recipientFingerprint,
        ciphertextHash: declaration.locatorBundle.ciphertextHash,
        manifestFingerprint: declaration.locatorBundle.manifestFingerprint,
        repositoryKeyDomainFingerprint:
          declaration.locatorBundle.repositoryKeyDomainFingerprint,
      },
    };
    await expect(
      providerOriginalReferenceFingerprint(reordered),
    ).resolves.toBe(await providerOriginalReferenceFingerprint(declaration));
  });

  test("admits and replays an exact provider original without a duplicate backup", async () => {
    const f = await fixture();
    const extractionFingerprint = await artifactBoundExtractionFingerprint(
      PROFILE.parserFingerprint,
      OUTPUT_HASH,
      PROFILE.extractionConfigurationFingerprint,
    );
    const reserve = parseWorkerRequest({
      ...base(f),
      operation: "discovery.reserveArchived",
      requestId: "reserve-provider",
      identity: identity(f),
    });
    if (reserve.operation !== "discovery.reserveArchived")
      throw new Error("bad reserve");
    const leased = await f.t.run((ctx) =>
      reserveArchivedDiscovery(ctx, f.principal, reserve, "a".repeat(64), 100),
    );
    const body = {
      ...base(f),
      operation: "discovery.admitArchived" as const,
      requestId: "admit-provider",
      workId: leased.workId,
      leaseEpoch: leased.leaseEpoch,
      leaseToken: leased.leaseToken,
      parserArtifact: {
        kind: "create" as const,
        clientArtifactId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c140",
        outputHash: OUTPUT_HASH,
        outputByteLength: 2_048,
        outputMediaType: "application/vnd.docling+json" as const,
        createdAt: 100,
      },
      archives: [
        archive("original_bytes", "primary", 1),
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
      providerOriginal: providerOriginal(),
    };
    expect(() =>
      parseWorkerRequest({
        ...body,
        archives: [
          ...body.archives,
          archive("original_bytes", "independent_backup", 2),
        ],
      }),
    ).toThrow();
    const wrongSource = parseWorkerRequest({
      ...body,
      requestId: "admit-provider-wrong-source",
      providerOriginal: providerOriginal("0".repeat(64)),
    });
    if (wrongSource.operation !== "discovery.admitArchived")
      throw new Error("bad provider request");
    await expect(
      f.t.run((ctx) =>
        admitArchivedDiscovery(ctx, f.principal, wrongSource, 110),
      ),
    ).rejects.toThrow();
    for (const [requestId, declaration, now] of [
      [
        "admit-provider-stale",
        {
          ...providerOriginal(),
          createdAt: 1,
          verifiedAt: 1,
          locatorBundle: {
            ...providerOriginal().locatorBundle,
            readbackVerifiedAt: 1,
          },
        },
        700_002,
      ],
      [
        "admit-provider-future",
        {
          ...providerOriginal(),
          verifiedAt: 300_111,
          locatorBundle: {
            ...providerOriginal().locatorBundle,
            readbackVerifiedAt: 300_111,
          },
        },
        110,
      ],
    ] as const) {
      const invalid = parseWorkerRequest({
        ...body,
        requestId,
        providerOriginal: declaration,
      });
      if (invalid.operation !== "discovery.admitArchived")
        throw new Error("bad provider request");
      await expect(
        f.t.run((ctx) =>
          admitArchivedDiscovery(ctx, f.principal, invalid, now),
        ),
      ).rejects.toThrow();
    }
    const request = parseWorkerRequest(body);
    if (request.operation !== "discovery.admitArchived")
      throw new Error("bad provider request");
    const admitted = await f.t.run((ctx) =>
      admitArchivedDiscovery(ctx, f.principal, request, 110),
    );
    expect(admitted).toMatchObject({
      originalPrimaryBindingEpoch: 0,
      originalProviderBindingEpoch: 0,
      parserPrimaryBindingEpoch: 0,
      parserBackupBindingEpoch: 0,
      reused: false,
    });
    expect(admitted).not.toHaveProperty("originalBackupReceiptId");
    await expect(
      f.t.run((ctx) =>
        admitArchivedDiscovery(ctx, f.principal, request, 700_001),
      ),
    ).resolves.toEqual({ ...admitted, reused: true });
    const rows = await f.t.run(async (ctx) => ({
      receipts: await ctx.db.query("sourceArtifactArchiveReceipts").collect(),
      references: await ctx.db
        .query("sourceProviderOriginalReferences")
        .collect(),
      generations: await ctx.db.query("processingGenerations").collect(),
    }));
    expect(rows.receipts).toHaveLength(3);
    expect(rows.references).toHaveLength(1);
    expect(rows.generations[0]).toMatchObject({
      originalProviderReferenceId: rows.references[0]!._id,
      originalProviderBindingEpoch: 0,
    });
    expect(rows.generations[0]).not.toHaveProperty("originalBackupReceiptId");
  });

  test("reserves one exact parsed job without touching unrelated or cross-source jobs", async () => {
    const f = await fixture();
    const admitted = await admitParsedFixture(f, {
      textHash: TEXT_HASH,
      byteLength: 16,
      utf16Length: 16,
      mappingManifestHash: MAPPING_HASH,
    });
    const { unrelatedId, foreignId, foreignStateBefore } = await f.t.run(
      async (ctx) => {
        const desiredJobId = ctx.db.normalizeId(
          "ingestJobs",
          admitted.admitted.ingestJobId,
        )!;
        const desired = (await ctx.db.get(desiredJobId))!;
        const {
          _id: _desiredId,
          _creationTime: _desiredCreationTime,
          ...desiredFields
        } = desired;
        const unrelatedId = await ctx.db.insert("ingestJobs", {
          ...desiredFields,
          state: "queued",
          attempts: 0,
          leaseEpoch: 0,
          nextAttemptAt: undefined,
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          workerLeaseOwnerCredentialId: undefined,
        });
        const foreignUserId = await ctx.db.insert("users", {
          name: "Other binary owner",
        });
        const foreignSpaceId = await ctx.db.insert("spaces", {
          kind: "shared",
          name: "Other binary space",
          createdBy: foreignUserId,
        });
        const foreignSourceId = await ctx.db.insert("sourceAccounts", {
          spaceId: foreignSpaceId,
          connector: "fs",
          accountId: "foreign-binary-test",
          name: "Foreign binary test",
          enabled: true,
          cursorVersion: 0,
          freshnessMs: 60_000,
          inventoryEpoch: 1,
          completedInventoryEpoch: 1,
          manifestVersion: 1,
          workerAssessmentEpoch: 0,
          createdBy: foreignUserId,
        });
        const foreignId = await ctx.db.insert("ingestJobs", {
          ...desiredFields,
          spaceId: foreignSpaceId,
          sourceAccountId: foreignSourceId,
          state: "queued",
          attempts: 0,
          leaseEpoch: 0,
          nextAttemptAt: undefined,
          leaseToken: undefined,
          leaseExpiresAt: undefined,
          workerLeaseOwnerCredentialId: undefined,
        });
        return {
          unrelatedId,
          foreignId,
          foreignStateBefore: await ctx.db.get(foreignId),
        };
      },
    );
    const exact = parseWorkerRequest({
      ...base(f),
      operation: "jobs.reserveParsed",
      requestId: "reserve-exact-parsed",
      maxItems: 1,
      jobId: admitted.admitted.ingestJobId,
    });
    if (exact.operation !== "jobs.reserveParsed")
      throw new Error("bad exact reserve");
    await expect(
      f.t.run((ctx) =>
        reserveParsedJobs(ctx, f.principal, exact, ["f".repeat(64)], 120),
      ),
    ).resolves.toMatchObject({
      targets: [{ jobId: admitted.admitted.ingestJobId }],
    });
    await expect(
      f.t.run(async (ctx) => (await ctx.db.get(unrelatedId))!.state),
    ).resolves.toBe("queued");

    const terminalBefore = await f.t.run(async (ctx) => {
      const jobId = ctx.db.normalizeId(
        "ingestJobs",
        admitted.admitted.ingestJobId,
      )!;
      const job = (await ctx.db.get(jobId))!;
      await ctx.db.patch(job.processingGenerationId, { state: "ready" });
      await ctx.db.patch(jobId, {
        state: "ready",
        attempts: Number.MAX_SAFE_INTEGER,
        leaseEpoch: Number.MAX_SAFE_INTEGER,
      });
      return await ctx.db.get(jobId);
    });
    const exactTerminal = parseWorkerRequest({
      ...base(f),
      operation: "jobs.reserveParsed",
      requestId: "reserve-exact-terminal-parsed",
      maxItems: 1,
      jobId: admitted.admitted.ingestJobId,
    });
    if (exactTerminal.operation !== "jobs.reserveParsed")
      throw new Error("bad exact terminal reserve");
    await expect(
      f.t.run((ctx) =>
        reserveParsedJobs(
          ctx,
          f.principal,
          exactTerminal,
          ["d".repeat(64)],
          121,
        ),
      ),
    ).resolves.toMatchObject({ targets: [] });
    await expect(
      f.t.run(async (ctx) => {
        const jobId = ctx.db.normalizeId(
          "ingestJobs",
          admitted.admitted.ingestJobId,
        )!;
        return await ctx.db.get(jobId);
      }),
    ).resolves.toEqual(terminalBefore);

    const crossSource = parseWorkerRequest({
      ...base(f),
      operation: "jobs.reserveParsed",
      requestId: "reserve-cross-source-parsed",
      maxItems: 1,
      jobId: foreignId,
    });
    if (crossSource.operation !== "jobs.reserveParsed")
      throw new Error("bad cross-source reserve");
    const rateLimitBefore = await f.t.run(async (ctx) =>
      ctx.db.query("workerProtocolRateLimits").collect(),
    );
    await expect(
      f.t.run((ctx) =>
        reserveParsedJobs(ctx, f.principal, crossSource, ["e".repeat(64)], 122),
      ),
    ).rejects.toThrow();
    await expect(
      f.t.run(async (ctx) => await ctx.db.get(foreignId)),
    ).resolves.toEqual(foreignStateBefore);
    await expect(
      f.t.run(async (ctx) =>
        ctx.db.query("workerProtocolRateLimits").collect(),
      ),
    ).resolves.toEqual(rateLimitBefore);
  });

  test("stages, seals, and activates a parsed payload with exact replay fences", async () => {
    const f = await fixture();
    const text = "Hello😀";
    const textHash = await sha256Utf8(text);
    const pages = [{ ordinal: 0, start: 0, end: text.length, text, textHash }];
    const evidence = [
      {
        ordinal: 0,
        pageOrdinal: 0,
        start: 0,
        end: text.length,
        quoteHash: textHash,
        locator: {
          kind: "parser_page_v1" as const,
          pageNumber: 1,
          pageTextHash: textHash,
        },
      },
    ];
    const mappingManifestHash = await digestParsedMappingManifest(
      pages,
      evidence,
    );
    const admitted = await admitParsedFixture(f, {
      textHash,
      byteLength: new TextEncoder().encode(text).byteLength,
      utf16Length: text.length,
      mappingManifestHash,
    });
    const reserve = parseWorkerRequest({
      ...base(f),
      operation: "jobs.reserveParsed",
      requestId: "jobs-reserve-parsed",
      maxItems: 1,
    });
    if (reserve.operation !== "jobs.reserveParsed")
      throw new Error("bad job reserve");
    const reserved = await f.t.run((ctx) =>
      reserveParsedJobs(ctx, f.principal, reserve, ["b".repeat(64)], 120),
    );
    expect(reserved.targets).toHaveLength(1);
    let lease = reserved.targets[0]!;
    const begin = parseWorkerRequest({
      ...base(f),
      operation: "jobs.stageParsedBegin",
      requestId: "stage-begin",
      jobId: lease.jobId,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
      extractionFingerprint: admitted.extractionFingerprint,
      mappingManifestHash,
      normalizedBundleDigest: BUNDLE_HASH,
      expectedPageCount: 1,
      expectedEvidenceSpanCount: 1,
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
    });
    if (begin.operation !== "jobs.stageParsedBegin")
      throw new Error("bad begin");
    let begun = await f.t.run((ctx) =>
      beginParsedStage(ctx, f.principal, begin, 121),
    );
    const reserveAfterLostBegin = parseWorkerRequest({
      ...base(f),
      operation: "jobs.reserveParsed",
      requestId: "jobs-reserve-after-lost-begin",
      maxItems: 1,
    });
    if (reserveAfterLostBegin.operation !== "jobs.reserveParsed")
      throw new Error("bad recovery reserve");
    const recoveredLease = await f.t.run((ctx) =>
      reserveParsedJobs(
        ctx,
        f.principal,
        reserveAfterLostBegin,
        ["c".repeat(64)],
        300_121,
      ),
    );
    lease = recoveredLease.targets[0]!;
    const discoverBegin = parseWorkerRequest({
      ...begin,
      requestId: "stage-begin-after-lost-result",
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
    });
    if (discoverBegin.operation !== "jobs.stageParsedBegin")
      throw new Error("bad recovery begin");
    const discovered = await f.t.run((ctx) =>
      beginParsedStage(ctx, f.principal, discoverBegin, 300_122),
    );
    expect(discovered).toMatchObject({
      stageId: begun.stageId,
      phase: "pages",
      nextOrdinal: 0,
      reused: true,
    });
    begun = discovered;
    let operationNow = 300_123;
    const batch = async (
      requestId: string,
      phase: "pages" | "evidence" | "documents" | "chunks",
      rows: unknown[],
    ) => {
      const request = parseWorkerRequest({
        ...base(f),
        operation: "jobs.stageParsedBatch",
        requestId,
        jobId: lease.jobId,
        leaseEpoch: lease.leaseEpoch,
        leaseToken: lease.leaseToken,
        stageId: begun.stageId,
        phase,
        ordinal: 0,
        rows,
      });
      if (request.operation !== "jobs.stageParsedBatch")
        throw new Error("bad batch");
      return {
        request,
        result: await f.t.run((ctx) =>
          stageParsedBatch(ctx, f.principal, request, operationNow++),
        ),
      };
    };
    const pageBatch = await batch("stage-pages", "pages", pages);
    expect(pageBatch.result.phase).toBe("evidence");
    await expect(
      f.t.run((ctx) =>
        stageParsedBatch(ctx, f.principal, pageBatch.request, 600_122),
      ),
    ).resolves.toMatchObject({ reused: true, phase: "evidence" });
    const reserveAfterLostBatch = parseWorkerRequest({
      ...base(f),
      operation: "jobs.reserveParsed",
      requestId: "jobs-reserve-after-lost-batch",
      maxItems: 1,
    });
    if (reserveAfterLostBatch.operation !== "jobs.reserveParsed")
      throw new Error("bad second recovery reserve");
    const secondRecoveredLease = await f.t.run((ctx) =>
      reserveParsedJobs(
        ctx,
        f.principal,
        reserveAfterLostBatch,
        ["d".repeat(64)],
        600_123,
      ),
    );
    lease = secondRecoveredLease.targets[0]!;
    const discoverAfterBatch = parseWorkerRequest({
      ...begin,
      requestId: "stage-begin-after-lost-batch",
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
    });
    if (discoverAfterBatch.operation !== "jobs.stageParsedBegin")
      throw new Error("bad second recovery begin");
    begun = await f.t.run((ctx) =>
      beginParsedStage(ctx, f.principal, discoverAfterBatch, 600_124),
    );
    expect(begun).toMatchObject({
      stageId: discovered.stageId,
      phase: "evidence",
      nextOrdinal: 0,
      reused: true,
    });
    await expect(
      f.t.run((ctx) =>
        stageParsedBatch(ctx, f.principal, pageBatch.request, 600_125),
      ),
    ).rejects.toThrow();
    operationNow = 600_126;
    const mismatchedPageHash = parseWorkerRequest({
      ...base(f),
      operation: "jobs.stageParsedBatch",
      requestId: "stage-evidence-wrong-page-hash",
      jobId: lease.jobId,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
      stageId: begun.stageId,
      phase: "evidence",
      ordinal: 0,
      rows: [
        {
          ...evidence[0],
          locator: { ...evidence[0]!.locator, pageTextHash: "f".repeat(64) },
        },
      ],
    });
    if (mismatchedPageHash.operation !== "jobs.stageParsedBatch")
      throw new Error("bad mismatched page hash batch");
    await expect(
      f.t.run((ctx) =>
        stageParsedBatch(ctx, f.principal, mismatchedPageHash, operationNow++),
      ),
    ).rejects.toThrow();
    const evidenceBatch = await batch("stage-evidence", "evidence", evidence);
    const renew = parseWorkerRequest({
      ...base(f),
      operation: "jobs.renewParsed",
      requestId: "renew-after-stage-batch",
      jobId: lease.jobId,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
    });
    if (renew.operation !== "jobs.renewParsed") throw new Error("bad renew");
    await expect(
      f.t.run((ctx) => renewParsedJob(ctx, f.principal, renew, 600_128)),
    ).resolves.toMatchObject({ state: "processing", reused: false });
    await expect(
      f.t.run((ctx) =>
        stageParsedBatch(ctx, f.principal, evidenceBatch.request, 600_129),
      ),
    ).rejects.toThrow();
    operationNow = 600_130;
    await batch("stage-documents", "documents", [
      {
        documentKey: "document:0",
        title: "Synthetic",
        docType: "pdf",
        capturedAt: 20,
        evidence: [{ pageOrdinal: 0, evidenceOrdinal: 0 }],
      },
    ]);
    await batch("stage-chunks", "chunks", [
      {
        documentKey: "document:0",
        ordinal: 0,
        start: 0,
        end: text.length,
        text,
        evidence: [{ pageOrdinal: 0, evidenceOrdinal: 0 }],
      },
    ]);
    const seal = parseWorkerRequest({
      ...base(f),
      operation: "jobs.stageParsedSeal",
      requestId: "stage-seal",
      jobId: lease.jobId,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
      stageId: begun.stageId,
      normalizedBundleDigest: BUNDLE_HASH,
    });
    if (seal.operation !== "jobs.stageParsedSeal") throw new Error("bad seal");
    const sealed = await f.t.run((ctx) =>
      sealParsedStage(ctx, f.principal, seal, 600_140),
    );
    expect(sealed).toMatchObject({
      state: "staged",
      actualPageCount: 1,
      actualEvidenceSpanCount: 1,
      actualDocumentCount: 1,
      actualChunkCount: 1,
    });
    await expect(
      f.t.run((ctx) => sealParsedStage(ctx, f.principal, seal, 900_129)),
    ).resolves.toMatchObject({ reused: true, state: "staged" });
    const reserveAfterLostSeal = parseWorkerRequest({
      ...base(f),
      operation: "jobs.reserveParsed",
      requestId: "jobs-reserve-after-lost-seal",
      maxItems: 1,
    });
    if (reserveAfterLostSeal.operation !== "jobs.reserveParsed")
      throw new Error("bad staged recovery reserve");
    const stagedLease = await f.t.run((ctx) =>
      reserveParsedJobs(
        ctx,
        f.principal,
        reserveAfterLostSeal,
        ["e".repeat(64)],
        900_130,
      ),
    );
    lease = stagedLease.targets[0]!;
    const discoverAfterSeal = parseWorkerRequest({
      ...begin,
      requestId: "stage-begin-after-lost-seal",
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
    });
    if (discoverAfterSeal.operation !== "jobs.stageParsedBegin")
      throw new Error("bad staged recovery begin");
    await expect(
      f.t.run((ctx) =>
        beginParsedStage(ctx, f.principal, discoverAfterSeal, 900_131),
      ),
    ).resolves.toMatchObject({
      stageId: begun.stageId,
      phase: "staged",
      nextOrdinal: 0,
      reused: true,
    });
    const activate = parseWorkerRequest({
      ...base(f),
      operation: "jobs.activateParsed",
      requestId: "activate-parsed",
      jobId: lease.jobId,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
    });
    if (activate.operation !== "jobs.activateParsed")
      throw new Error("bad activate");
    const stagedGraph = await f.t.run(async (ctx) => ({
      generation: (await ctx.db.query("processingGenerations").first())!,
      document: (await ctx.db.query("documents").first())!,
      chunk: (await ctx.db.query("chunks").first())!,
      span: (await ctx.db.query("evidenceSpans").first())!,
    }));
    const hiddenDocumentId = await f.t.run((ctx) =>
      ctx.db.insert("documents", {
        spaceId: stagedGraph.document.spaceId,
        processingGenerationId: stagedGraph.document.processingGenerationId,
        sourceItemId: stagedGraph.document.sourceItemId,
        sourceRevisionId: stagedGraph.document.sourceRevisionId,
        sourceTextVersionId: stagedGraph.document.sourceTextVersionId,
        documentKey: "hidden-document",
        title: "Hidden",
        docType: "pdf",
        capturedAt: 20,
        evidenceSpanIds: [stagedGraph.span._id],
        publicationState: "staged",
      }),
    );
    await expect(
      f.t.run((ctx) => activateParsedJob(ctx, f.principal, activate, 900_132)),
    ).rejects.toThrow();
    await f.t.run((ctx) => ctx.db.delete(hiddenDocumentId));
    const hiddenChunkId = await f.t.run((ctx) =>
      ctx.db.insert("chunks", {
        spaceId: stagedGraph.chunk.spaceId,
        processingGenerationId: stagedGraph.chunk.processingGenerationId,
        documentId: stagedGraph.chunk.documentId,
        ordinal: 1,
        sourceTextVersionId: stagedGraph.chunk.sourceTextVersionId,
        start: stagedGraph.chunk.start,
        end: stagedGraph.chunk.end,
        text: stagedGraph.chunk.text,
        evidenceSpanIds: stagedGraph.chunk.evidenceSpanIds,
        publicationState: "staged",
      }),
    );
    await expect(
      f.t.run((ctx) => activateParsedJob(ctx, f.principal, activate, 900_133)),
    ).rejects.toThrow();
    await f.t.run((ctx) => ctx.db.delete(hiddenChunkId));
    const hiddenRecords = await f.t.run(async (ctx) => {
      const entityId = await ctx.db.insert("entities", {
        userId: f.userId,
        spaceId: f.spaceId,
        key: "hidden-entity",
        kind: "person",
        canonicalName: "Hidden Entity",
        normalizedName: "hidden entity",
        aliases: [],
        normalizedAliases: [],
      });
      const eventId = await ctx.db.insert("events", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        sourceItemId: f.sourceItemId,
        eventKey: "hidden-event",
        createdBy: f.userId,
      });
      const eventVersionId = await ctx.db.insert("eventVersions", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        sourceItemId: f.sourceItemId,
        sourceRevisionId: stagedGraph.document.sourceRevisionId,
        sourceTextVersionId: stagedGraph.document.sourceTextVersionId,
        processingGenerationId: stagedGraph.generation._id,
        eventId,
        entityId,
        eventType: "lab_panel",
        schemaVersion: 1,
        occurrence: { precision: "unknown" },
        fieldEvidence: {
          occurrence: [stagedGraph.span._id],
          entity: [stagedGraph.span._id],
          eventType: [stagedGraph.span._id],
        },
        userId: f.userId,
      });
      const observationId = await ctx.db.insert("observations", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        sourceItemId: f.sourceItemId,
        sourceRevisionId: stagedGraph.document.sourceRevisionId,
        sourceTextVersionId: stagedGraph.document.sourceTextVersionId,
        processingGenerationId: stagedGraph.generation._id,
        eventId,
        eventVersionId,
        entityId,
        eventType: "lab_panel",
        occurrence: { precision: "unknown" },
        observationKey: "hidden-observation",
        observationType: "hidden",
        schemaVersion: 1,
        value: { type: "text", value: "hidden" },
        valueEvidence: [stagedGraph.span._id],
        userId: f.userId,
      });
      return { eventVersionId, observationId };
    });
    await expect(
      f.t.run((ctx) => activateParsedJob(ctx, f.principal, activate, 900_134)),
    ).rejects.toThrow();
    await f.t.run((ctx) => ctx.db.delete(hiddenRecords.eventVersionId));
    await expect(
      f.t.run((ctx) => activateParsedJob(ctx, f.principal, activate, 900_135)),
    ).rejects.toThrow();
    await f.t.run((ctx) => ctx.db.delete(hiddenRecords.observationId));
    await expect(
      f.t.run((ctx) => activateParsedJob(ctx, f.principal, activate, 900_136)),
    ).resolves.toMatchObject({ state: "ready", reused: false });
    const assessBegin = parseWorkerRequest({
      ...base(f),
      operation: "processing.assessBegin",
      requestId: "assess-parsed",
      scanId: f.scanId,
      expectedInventoryEpoch: 1,
      expectedManifestVersion: 1,
    });
    if (assessBegin.operation !== "processing.assessBegin")
      throw new Error("bad assessment begin");
    const assessment = await f.t.run((ctx) =>
      beginProcessingAssessment(ctx, f.principal, assessBegin, 1_000_145),
    );
    let assessed:
      Awaited<ReturnType<typeof advanceProcessingAssessment>> | undefined;
    for (let ordinal = 0; ordinal < 3; ordinal += 1) {
      const page = parseWorkerRequest({
        ...base(f),
        operation: "processing.assessPage",
        requestId: `assess-page-${ordinal}`,
        assessmentId: assessment.assessmentId,
        ordinal,
        maxItems: 1,
      });
      if (page.operation !== "processing.assessPage")
        throw new Error("bad assessment page");
      assessed = await f.t.run((ctx) =>
        advanceProcessingAssessment(
          ctx,
          f.principal,
          page,
          1_000_146 + ordinal,
        ),
      );
      if (assessed.state !== "running") break;
    }
    expect(assessed).toMatchObject({
      state: "complete",
      counts: { items: { ready: 1 } },
    });
    const documentId = await f.t.run(
      async (ctx) => (await ctx.db.query("documents").first())!._id,
    );
    await expect(
      f.t.run((ctx) => getDocument(ctx, [f.spaceId], documentId)),
    ).resolves.toMatchObject({
      contentHashAuthority: "worker_asserted",
      textHashAuthority: "server_verified_retained_text",
      originalRecovery: {
        kind: "archive_pair_v1",
        primary: true,
        independentBackup: true,
      },
    });
    const textVersionId = stagedGraph.document.sourceTextVersionId;
    await f.t.run((ctx) =>
      ctx.db.patch(textVersionId, { textHashAuthority: undefined }),
    );
    await expect(
      f.t.run((ctx) => getDocument(ctx, [f.spaceId], documentId)),
    ).resolves.toBeNull();
    await f.t.run((ctx) =>
      ctx.db.patch(textVersionId, {
        textHashAuthority: "server_verified_retained_text",
      }),
    );
    await f.t.run(async (ctx) => {
      await ctx.db.patch(stagedGraph.generation._id, {
        deactivatedAt: 1_000_149,
      });
      await ctx.db.patch(documentId, { publicationState: "historical" });
      await ctx.db.patch(stagedGraph.chunk._id, {
        publicationState: "historical",
      });
    });
    await expect(
      f.t.run(async (ctx) =>
        verifySealedParsedPayload(
          ctx,
          (await ctx.db.get(stagedGraph.generation._id))!,
        ),
      ),
    ).resolves.toMatchObject({ actualDocumentCount: 1, actualChunkCount: 1 });
    await f.t.run((ctx) =>
      beginSourceItemForget(ctx, {
        spaceId: f.spaceId,
        sourceItemId: f.sourceItemId,
        forgottenAt: 1_000_150,
        forgottenBy: f.userId,
      }),
    );
    await expect(
      f.t.run((ctx) => getDocument(ctx, [f.spaceId], documentId)),
    ).resolves.toBeNull();
    await expect(
      f.t.run((ctx) =>
        deleteSourceItemProvenanceBatch(ctx, {
          spaceId: f.spaceId,
          sourceItemId: f.sourceItemId,
        }),
      ),
    ).resolves.toEqual({
      deleted: 0,
      phase: "archive_cleanup_required",
      done: false,
    });
  });
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
    const receiptId = (
      subjectKind: "original_bytes" | "parser_output",
      copyRole: "primary" | "independent_backup",
    ) =>
      rows.receipts.find(
        (row) => row.subjectKind === subjectKind && row.copyRole === copyRole,
      )?._id;
    expect(admitted).toMatchObject({
      originalPrimaryReceiptId: receiptId("original_bytes", "primary"),
      originalPrimaryBindingEpoch: 0,
      originalBackupReceiptId: receiptId(
        "original_bytes",
        "independent_backup",
      ),
      originalBackupBindingEpoch: 0,
      parserPrimaryReceiptId: receiptId("parser_output", "primary"),
      parserPrimaryBindingEpoch: 0,
      parserBackupReceiptId: receiptId("parser_output", "independent_backup"),
      parserBackupBindingEpoch: 0,
    });
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

  async function seedInventoryRow(f: Awaited<ReturnType<typeof fixture>>) {
    return await f.t.run((ctx) =>
      ctx.db.insert("sourceInventory", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        sourceItemId: f.sourceItemId,
        identityKeyHash: "archived-fixture-identity",
        relativePath: "synthetic.pdf",
        folderPath: "",
        fileName: "synthetic.pdf",
        modifiedAt: 20,
        contentIndexed: false,
        exclusionReason: "extraction_pending" as const,
        firstSeenScanId: f.scanId,
        lastSeenScanId: f.scanId,
      }),
    );
  }

  test("a document-level parser failure marks the file parse_failed with its failure class (P2-75b)", async () => {
    const f = await fixture();
    const inventoryId = await seedInventoryRow(f);
    const request = parseWorkerRequest({
      ...base(f),
      operation: "discovery.failArchived",
      requestId: "fail-1",
      identity: identity(f),
      failureCode: "conversion_failed",
    });
    if (request.operation !== "discovery.failArchived") {
      throw new Error("bad fail request");
    }
    const result = await f.t.run((ctx) =>
      failArchivedDiscovery(ctx, f.principal, request, 100),
    );
    expect(result).toMatchObject({
      sourceItemId: f.sourceItemId,
      workId: f.workId,
      state: "failed",
      retryable: true,
      failureCode: "conversion_failed",
    });
    // The pipeline never got far enough to admit this file, so there is no
    // ingestJobs row for jobs.fail / jobs.failParsed to have marked this
    // through; discovery.failArchived is the only path that can.
    expect(
      await f.t.run((ctx) => ctx.db.get(inventoryId)),
    ).toMatchObject({
      exclusionReason: "parse_failed",
      exclusionDetail: "conversion_failed",
    });
    const work = await f.t.run((ctx) => ctx.db.get(f.workId));
    expect(work).toMatchObject({
      state: "failed",
      attempts: 1,
      failureCode: "conversion_failed",
      retryable: true,
    });
    expect(work?.leaseToken).toBeUndefined();
    // P2-80g: a retryable row names the instant it is next eligible. Clearing
    // it left a row that `validDiscoveryWorkRuntimeState` rejects, which made
    // every later processing assessment stale (`detail_unavailable`), and hid
    // the row from `dueDiscoveryCandidates`.
    expect(work?.nextAttemptAt).toBe(100);
    // A failed-but-retryable row is exactly what discovery.reserveArchived
    // already accepts reclaiming, so a later scan's retry is not blocked.
    const reserve = parseWorkerRequest({
      ...base(f),
      operation: "discovery.reserveArchived",
      requestId: "reserve-after-fail",
      identity: identity(f),
    });
    if (reserve.operation !== "discovery.reserveArchived") {
      throw new Error("bad reserve request");
    }
    await expect(
      f.t.run((ctx) =>
        reserveArchivedDiscovery(ctx, f.principal, reserve, "f".repeat(64), 101),
      ),
    ).resolves.toMatchObject({ workId: f.workId, reused: false });
  });

  test("reaching the discovery attempt bound stops offering the work as retryable", async () => {
    const f = await fixture();
    await seedInventoryRow(f);
    await f.t.run((ctx) =>
      ctx.db.patch(f.workId, {
        attempts: 7,
        nextAttemptAt: undefined,
      }),
    );
    const request = parseWorkerRequest({
      ...base(f),
      operation: "discovery.failArchived",
      requestId: "fail-final",
      identity: identity(f),
      failureCode: "bundle_too_large",
    });
    if (request.operation !== "discovery.failArchived") {
      throw new Error("bad fail request");
    }
    const result = await f.t.run((ctx) =>
      failArchivedDiscovery(ctx, f.principal, request, 100),
    );
    expect(result.retryable).toBe(false);
    const reserve = parseWorkerRequest({
      ...base(f),
      operation: "discovery.reserveArchived",
      requestId: "reserve-after-bound",
      identity: identity(f),
    });
    if (reserve.operation !== "discovery.reserveArchived") {
      throw new Error("bad reserve request");
    }
    await expect(
      f.t.run((ctx) =>
        reserveArchivedDiscovery(
          ctx,
          f.principal,
          reserve,
          "g".repeat(64),
          101,
        ),
      ),
    ).rejects.toThrow();
  });

  // P2-80g: the client's parse budget (MAX_PARSE_ATTEMPTS, 2) is smaller than
  // the server's attempt bound (8). Without this the two caps disagreed: a
  // document the client had already given up on stayed `retryable` for six
  // more passes, each one re-queueing it, reporting the same deterministic
  // failure, and bumping `attempts` by one.
  test("an exhausted client report settles the work row on the first pass", async () => {
    const f = await fixture();
    await seedInventoryRow(f);
    const request = parseWorkerRequest({
      ...base(f),
      operation: "discovery.failArchived",
      requestId: "fail-exhausted",
      identity: identity(f),
      failureCode: "conversion_failed",
      exhausted: true,
    });
    if (request.operation !== "discovery.failArchived") {
      throw new Error("bad fail request");
    }
    const result = await f.t.run((ctx) =>
      failArchivedDiscovery(ctx, f.principal, request, 100),
    );
    expect(result.retryable).toBe(false);
    const work = await f.t.run((ctx) => ctx.db.get(f.workId));
    expect(work).toMatchObject({ state: "failed", attempts: 1 });
    expect(work?.retryable).toBe(false);
    expect(work?.nextAttemptAt).toBeUndefined();
    const reserve = parseWorkerRequest({
      ...base(f),
      operation: "discovery.reserveArchived",
      requestId: "reserve-after-exhausted",
      identity: identity(f),
    });
    if (reserve.operation !== "discovery.reserveArchived") {
      throw new Error("bad reserve request");
    }
    await expect(
      f.t.run((ctx) =>
        reserveArchivedDiscovery(
          ctx,
          f.principal,
          reserve,
          "h".repeat(64),
          101,
        ),
      ),
    ).rejects.toThrow();
  });
});
