import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../../schema";
import { modules } from "../../test.setup";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  appendWorkerScanPage,
  beginWorkerScan,
  getWorkerInventoryPage,
  getWorkerSourceStatus,
  reconcileWorkerScan,
  sealWorkerScan,
} from "./model";
import { admitDiscoveryUtf8, reserveDiscoveryWork } from "./discovery";
import { parseWorkerRequest, type FsDiscoveryEntry } from "./protocol";
import { FS_TEXT_PROFILE } from "./profile";
import { beginForgetFromWeb, continueForgetFromWeb } from "../ingestion/model";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const UUID_A = "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139";
const DISCOVERY_TEXT = "alpha beta";
const DISCOVERY_TEXT_HASH =
  "1a989ea86150171c687b0727f218eedbb94c4665a7da9b0add1bf5de607f2bf1";

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Worker owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Synthetic worker space",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "fs",
      accountId: "synthetic-fs",
      name: "Synthetic filesystem",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: userId,
    });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "c".repeat(64),
      keyPrefix: "worker",
      name: "Synthetic worker",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    return { userId, spaceId, sourceAccountId, credentialId };
  });
  return {
    t,
    ...ids,
    principal: { userId: ids.userId, credentialId: ids.credentialId },
  };
}

function source(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    protocolVersion: 1 as const,
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
  };
}

function readyEntry(
  overrides: Partial<FsDiscoveryEntry> = {},
): FsDiscoveryEntry {
  return {
    externalId: UUID_A,
    uri: "fs://documents/a.txt",
    title: "A",
    docType: "text",
    sourceModifiedAt: 100,
    content: { status: "ready", sha256: HASH_A, byteLength: 10 },
    ...overrides,
  };
}

async function begin(
  f: Awaited<ReturnType<typeof fixture>>,
  requestId: string,
  expectedInventoryEpoch: number,
  mode: "normal" | "identity_recovery" = "normal",
  now = 1_000,
) {
  const request = parseWorkerRequest({
    ...source(f),
    operation: "scan.begin",
    requestId,
    watcherId: "watcher-1",
    connectorVersion: "fs-v1",
    mode,
    expectedInventoryEpoch,
  });
  if (request.operation !== "scan.begin") throw new Error("bad test request");
  return await f.t.run((ctx) =>
    beginWorkerScan(ctx, f.principal, request, now),
  );
}

async function append(
  f: Awaited<ReturnType<typeof fixture>>,
  scanId: string,
  requestId: string,
  entries: FsDiscoveryEntry[],
  now = 1_100,
  ordinal = 0,
) {
  const request = parseWorkerRequest({
    ...source(f),
    operation: "scan.appendPage",
    scanId,
    requestId,
    ordinal,
    entries,
  });
  if (request.operation !== "scan.appendPage") {
    throw new Error("bad test request");
  }
  return await f.t.run((ctx) =>
    appendWorkerScanPage(ctx, f.principal, request, now),
  );
}

async function markCurrentItemReady(
  f: Awaited<ReturnType<typeof fixture>>,
  contentHash = HASH_A,
) {
  return await f.t.run(async (ctx) => {
    const item = await ctx.db
      .query("sourceItems")
      .withIndex("by_sourceAccountId", (q) =>
        q.eq("sourceAccountId", f.sourceAccountId),
      )
      .unique();
    if (!item) throw new Error("missing source item");
    const revisionId = await ctx.db.insert("sourceRevisions", {
      spaceId: f.spaceId,
      sourceItemId: item._id,
      contentHash,
      byteLength: 10,
      mediaType: FS_TEXT_PROFILE.mediaType,
      inlineText: "synthetic",
      capturedAt: 1_000,
      userId: f.userId,
    });
    const generationId = await ctx.db.insert("processingGenerations", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      sourceItemId: item._id,
      sourceRevisionId: revisionId,
      processingFingerprint: "synthetic-fs-processing:v1",
      extractionFingerprint: FS_TEXT_PROFILE.extractionFingerprint,
      extractorFingerprint: FS_TEXT_PROFILE.extractorFingerprint,
      recordSchemaFingerprint: FS_TEXT_PROFILE.recordSchemaFingerprint,
      normalizationFingerprint: FS_TEXT_PROFILE.normalizationFingerprint,
      chunkerFingerprint: FS_TEXT_PROFILE.chunkerFingerprint,
      correctionRevision: "worker:1",
      desiredProcessingEpoch: 1,
      state: "ready",
      expectedPageCount: 1,
      expectedEvidenceSpanCount: 1,
      expectedDocumentCount: 1,
      expectedChunkCount: 1,
      embeddingStatus: "unavailable",
    });
    await ctx.db.patch(item._id, {
      activeRevisionId: revisionId,
      activeGenerationId: generationId,
    });
    return { itemId: item._id, revisionId, generationId };
  });
}

async function attachSyntheticJob(
  f: Awaited<ReturnType<typeof fixture>>,
  corrupt: "sourceRevisionId" | "processingGenerationId" | "state",
) {
  await f.t.run(async (ctx) => {
    const [item, work] = await Promise.all([
      ctx.db
        .query("sourceItems")
        .withIndex("by_sourceAccountId", (q) =>
          q.eq("sourceAccountId", f.sourceAccountId),
        )
        .unique(),
      ctx.db.query("workerDiscoveryWork").unique(),
    ]);
    if (!item || !work) throw new Error("missing worker state");
    const makeRevision = () =>
      ctx.db.insert("sourceRevisions", {
        spaceId: f.spaceId,
        sourceItemId: item._id,
        contentHash: HASH_A,
        byteLength: 10,
        mediaType: FS_TEXT_PROFILE.mediaType,
        inlineText: "synthetic",
        capturedAt: 1_000,
        userId: f.userId,
      });
    const sourceRevisionId = await makeRevision();
    const otherSourceRevisionId = await makeRevision();
    const makeGeneration = (revisionId: typeof sourceRevisionId) =>
      ctx.db.insert("processingGenerations", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        sourceItemId: item._id,
        sourceRevisionId: revisionId,
        processingFingerprint: "synthetic-fs-processing:v1",
        extractionFingerprint: FS_TEXT_PROFILE.extractionFingerprint,
        extractorFingerprint: FS_TEXT_PROFILE.extractorFingerprint,
        recordSchemaFingerprint: FS_TEXT_PROFILE.recordSchemaFingerprint,
        normalizationFingerprint: FS_TEXT_PROFILE.normalizationFingerprint,
        chunkerFingerprint: FS_TEXT_PROFILE.chunkerFingerprint,
        correctionRevision: "worker:1",
        desiredProcessingEpoch: 1,
        state: "processing" as const,
        expectedPageCount: 1,
        expectedEvidenceSpanCount: 1,
        expectedDocumentCount: 1,
        expectedChunkCount: 1,
        embeddingStatus: "unavailable" as const,
      });
    const processingGenerationId = await makeGeneration(sourceRevisionId);
    const otherProcessingGenerationId = await makeGeneration(
      otherSourceRevisionId,
    );
    const ingestJobId = await ctx.db.insert("ingestJobs", {
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
      sourceItemId: item._id,
      sourceRevisionId:
        corrupt === "sourceRevisionId"
          ? otherSourceRevisionId
          : sourceRevisionId,
      processingGenerationId:
        corrupt === "processingGenerationId"
          ? otherProcessingGenerationId
          : processingGenerationId,
      admittedByUserId: f.userId,
      admittedByCredentialId: f.credentialId,
      actorUserId: f.userId,
      actorCredentialId: f.credentialId,
      desiredProcessingEpoch: 1,
      state: "processing",
      attempts: 1,
      leaseEpoch: 1,
      workerDiscoveryWorkId: work._id,
      workerObservationEpoch: work.observationEpoch,
    });
    await ctx.db.patch(work._id, {
      state: "admitted",
      sourceRevisionId,
      processingGenerationId,
      ingestJobId,
    });
    if (corrupt === "state") {
      await ctx.db.patch(processingGenerationId, { state: "ready" });
    }
  });
}

async function seal(
  f: Awaited<ReturnType<typeof fixture>>,
  scanId: string,
  requestId: string,
  expectedPageCount: number,
  health: { status: "healthy" } | { status: "failed"; code: "unreadable" },
  now = 1_200,
) {
  const request = parseWorkerRequest({
    ...source(f),
    operation: "scan.seal",
    scanId,
    requestId,
    expectedPageCount,
    health,
  });
  if (request.operation !== "scan.seal") throw new Error("bad test request");
  return await f.t.run((ctx) => sealWorkerScan(ctx, f.principal, request, now));
}

async function reconcile(
  f: Awaited<ReturnType<typeof fixture>>,
  scanId: string,
  requestId: string,
  expectedInventoryEpoch: number,
  now = 1_300,
  ordinal = 0,
) {
  const request = parseWorkerRequest({
    ...source(f),
    operation: "scan.reconcile",
    scanId,
    requestId,
    expectedInventoryEpoch,
    ordinal,
    maxItems: 50,
  });
  if (request.operation !== "scan.reconcile") {
    throw new Error("bad test request");
  }
  return await f.t.run((ctx) =>
    reconcileWorkerScan(ctx, f.principal, request, now),
  );
}

async function completeInitialScan(f: Awaited<ReturnType<typeof fixture>>) {
  const scan = await begin(f, "begin-1", 0);
  await append(f, scan.scanId, "page-1", [readyEntry()]);
  await seal(f, scan.scanId, "seal-1", 1, { status: "healthy" });
  await reconcile(f, scan.scanId, "reconcile-1", scan.inventoryEpoch);
  return scan;
}

async function completeReservableScan(f: Awaited<ReturnType<typeof fixture>>) {
  const scan = await begin(f, "begin-reservable", 0);
  await append(f, scan.scanId, "page-reservable", [
    readyEntry({
      content: {
        status: "ready",
        sha256: DISCOVERY_TEXT_HASH,
        byteLength: 10,
      },
    }),
  ]);
  await seal(f, scan.scanId, "seal-reservable", 1, { status: "healthy" });
  await reconcile(f, scan.scanId, "reconcile-reservable", scan.inventoryEpoch);
  return scan;
}

async function reserve(
  f: Awaited<ReturnType<typeof fixture>>,
  principal = f.principal,
  requestId = "reserve-1",
  maxItems = 1,
  now = 2_000,
) {
  const request = parseWorkerRequest({
    ...source(f),
    operation: "discovery.reserve",
    requestId,
    maxItems,
  });
  if (request.operation !== "discovery.reserve") {
    throw new Error("bad test request");
  }
  return await f.t.run((ctx) =>
    reserveDiscoveryWork(
      ctx,
      principal,
      request,
      Array.from({ length: maxItems }, (_, index) =>
        String(index + 1).padStart(64, "0"),
      ),
      now,
    ),
  );
}

async function admit(
  f: Awaited<ReturnType<typeof fixture>>,
  target: Awaited<ReturnType<typeof reserve>>["targets"][number],
  overrides: {
    requestId?: string;
    text?: string;
    principal?: typeof f.principal;
  } = {},
  now = 2_100,
) {
  const request = parseWorkerRequest({
    ...source(f),
    operation: "discovery.admitUtf8",
    requestId: overrides.requestId ?? "admit-1",
    workId: target.workId,
    leaseEpoch: target.leaseEpoch,
    leaseToken: target.leaseToken,
    text: overrides.text ?? DISCOVERY_TEXT,
  });
  if (request.operation !== "discovery.admitUtf8") {
    throw new Error("bad test request");
  }
  return await f.t.run((ctx) =>
    admitDiscoveryUtf8(ctx, overrides.principal ?? f.principal, request, now),
  );
}

describe("filesystem worker scans", () => {
  test("uses exact receipts and allocates scan epochs even after failure", async () => {
    const f = await fixture();
    const first = await begin(f, "begin-1", 0);
    expect((await begin(f, "begin-1", 0)).reused).toBe(true);
    const page = await append(f, first.scanId, "page-1", [readyEntry()]);
    expect(page.entries[0]).toMatchObject({
      state: "queued",
      observationEpoch: 1,
      processingEpoch: 1,
    });
    expect(
      (await append(f, first.scanId, "page-1", [readyEntry()])).reused,
    ).toBe(true);
    await seal(f, first.scanId, "seal-failed", 1, {
      status: "failed",
      code: "unreadable",
    });

    const second = await begin(f, "begin-2", 1, "normal", 2_000);
    expect(second.inventoryEpoch).toBe(2);
    await seal(f, second.scanId, "seal-2", 0, { status: "healthy" }, 2_100);
    await reconcile(f, second.scanId, "reconcile-2", 2, 2_200);
    const item = await f.t.run((ctx) =>
      ctx.db
        .query("sourceItems")
        .withIndex("by_sourceAccountId", (q) =>
          q.eq("sourceAccountId", f.sourceAccountId),
        )
        .first(),
    );
    expect(item?.lifecycle).toBe("unavailable");
    expect(item?.workerLastSeenInventoryEpoch).toBe(1);
  });

  test("does not duplicate work for unchanged bytes and metadata", async () => {
    const f = await fixture();
    await completeInitialScan(f);
    const second = await begin(f, "begin-2", 1, "normal", 2_000);
    const page = await append(
      f,
      second.scanId,
      "page-2",
      [readyEntry()],
      2_100,
    );
    expect(page.entries[0]).toMatchObject({
      state: "queued",
      observationEpoch: 1,
      processingEpoch: 1,
    });
    const snapshot = await f.t.run(async (ctx) => ({
      items: await ctx.db.query("sourceItems").collect(),
      work: await ctx.db.query("workerDiscoveryWork").collect(),
    }));
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.work).toHaveLength(1);
  });

  test("prefers an exactly compatible active generation over lingering work", async () => {
    const f = await fixture();
    await completeInitialScan(f);
    await markCurrentItemReady(f);

    const scan = await begin(f, "begin-ready-repeat", 1, "normal", 2_000);
    const page = await append(
      f,
      scan.scanId,
      "page-ready-repeat",
      [readyEntry()],
      2_100,
    );
    expect(page.entries[0]?.state).toBe("unchanged");
    const work = await f.t.run((ctx) =>
      ctx.db.query("workerDiscoveryWork").collect(),
    );
    expect(work.map((row) => row.state)).toEqual(["obsolete"]);
  });

  test("does not mistake a different active revision for returned bytes", async () => {
    const f = await fixture();
    await completeInitialScan(f);
    await markCurrentItemReady(f);

    const changed = await begin(f, "begin-b", 1, "normal", 2_000);
    await append(
      f,
      changed.scanId,
      "page-b",
      [
        readyEntry({
          content: { status: "ready", sha256: HASH_B, byteLength: 10 },
        }),
      ],
      2_100,
    );
    await seal(f, changed.scanId, "seal-b", 1, {
      status: "failed",
      code: "unreadable",
    });

    const gapScan = await begin(f, "begin-b-gap", 2, "normal", 3_000);
    await append(
      f,
      gapScan.scanId,
      "page-b-gap",
      [readyEntry({ content: { status: "gap", code: "unreadable" } })],
      3_100,
    );
    await seal(f, gapScan.scanId, "seal-b-gap", 1, {
      status: "failed",
      code: "unreadable",
    });

    const returned = await begin(f, "begin-b-return", 3, "normal", 4_000);
    const page = await append(
      f,
      returned.scanId,
      "page-b-return",
      [
        readyEntry({
          content: { status: "ready", sha256: HASH_B, byteLength: 10 },
        }),
      ],
      4_100,
    );
    expect(page.entries[0]).toMatchObject({
      state: "queued",
      processingEpoch: 2,
    });
  });

  test("reports expired and pruned incomplete current scans as failed", async () => {
    const f = await fixture();
    await completeInitialScan(f);
    const active = await begin(f, "begin-expiring", 1, "normal", 2_000);
    const request = parseWorkerRequest({
      ...source(f),
      operation: "source.status",
    });
    if (request.operation !== "source.status") {
      throw new Error("bad test request");
    }
    const expired = await f.t.run((ctx) =>
      getWorkerSourceStatus(ctx, f.principal, request, 2_000 + 30 * 60 * 1_000),
    );
    expect(expired.enumeration).toMatchObject({
      state: "failed",
      scanId: active.scanId,
      failureCode: "enumeration_interrupted",
    });

    await f.t.run(async (ctx) => {
      const scanId = ctx.db.normalizeId("workerSourceScans", active.scanId);
      if (!scanId) throw new Error("invalid scan result");
      await ctx.db.delete(scanId);
      await ctx.db.patch(f.sourceAccountId, { activeWorkerScanId: undefined });
    });
    const pruned = await f.t.run((ctx) =>
      getWorkerSourceStatus(ctx, f.principal, request, 2_001),
    );
    expect(pruned.enumeration).toEqual({ state: "failed" });

    const priorIssuer = process.env.MCP_JWT_ISSUER;
    process.env.MCP_JWT_ISSUER = "https://synthetic.worker.test";
    try {
      const mcp = f.t.withIdentity({
        issuer: process.env.MCP_JWT_ISSUER,
        subject: f.userId,
        apiKeyId: f.credentialId,
      });
      const dispatched = await mcp.action(api.models.workers.mcp.dispatch, {
        request,
      });
      expect(dispatched).toMatchObject({
        operation: "source.status",
        enumeration: { state: "failed" },
      });
    } finally {
      if (priorIssuer === undefined) delete process.env.MCP_JWT_ISSUER;
      else process.env.MCP_JWT_ISSUER = priorIssuer;
    }
  });

  test("separates metadata observations from processing identity", async () => {
    const f = await fixture();
    await completeInitialScan(f);

    const renamed = await begin(f, "begin-rename", 1, "normal", 2_000);
    const renamePage = await append(
      f,
      renamed.scanId,
      "page-rename",
      [
        readyEntry({
          uri: "fs://documents/renamed.txt",
          sourceModifiedAt: 200,
        }),
      ],
      2_100,
    );
    expect(renamePage.entries[0]).toMatchObject({
      observationEpoch: 2,
      processingEpoch: 1,
    });
    await seal(
      f,
      renamed.scanId,
      "seal-rename",
      1,
      { status: "failed", code: "unreadable" },
      2_200,
    );

    const corrected = await begin(f, "begin-corrected", 2, "normal", 3_000);
    const correctionPage = await append(
      f,
      corrected.scanId,
      "page-corrected",
      [
        readyEntry({
          uri: "fs://documents/renamed.txt",
          sourceModifiedAt: 200,
          content: { status: "ready", sha256: HASH_B, byteLength: 10 },
        }),
      ],
      3_100,
    );
    expect(correctionPage.entries[0]).toMatchObject({
      observationEpoch: 3,
      processingEpoch: 2,
    });
  });

  test("binds recovery inventory to a live scan and recovers exact path", async () => {
    const f = await fixture();
    await completeInitialScan(f);
    const recovery = await begin(
      f,
      "begin-recovery",
      1,
      "identity_recovery",
      2_000,
    );
    const inventoryRequest = parseWorkerRequest({
      ...source(f),
      operation: "source.inventoryPage",
      scanId: recovery.scanId,
      requestId: "inventory-1",
      expectedInventoryEpoch: recovery.inventoryEpoch,
      expectedManifestVersion: recovery.manifestVersion,
      paginationOpts: { cursor: null, numItems: 50 },
    });
    if (inventoryRequest.operation !== "source.inventoryPage") {
      throw new Error("bad test request");
    }
    const first = await f.t.run((ctx) =>
      getWorkerInventoryPage(ctx, f.principal, inventoryRequest, 2_100),
    );
    const retried = await f.t.run((ctx) =>
      getWorkerInventoryPage(ctx, f.principal, inventoryRequest, 2_200),
    );
    expect(retried).toEqual(first);
    expect(first.page[0]).toMatchObject({
      lifecycle: "available",
      externalId: UUID_A,
      uri: "fs://documents/a.txt",
    });

    const recovered = await append(
      f,
      recovery.scanId,
      "recovery-page",
      [readyEntry({ externalId: undefined })],
      2_300,
    );
    expect(recovered.entries[0]).toMatchObject({
      sourceItemId:
        first.page[0]?.lifecycle === "available"
          ? first.page[0].sourceItemId
          : undefined,
      observationEpoch: 1,
      processingEpoch: 1,
    });
  });

  test("rejects expired recovery inventory without renewing the scan", async () => {
    const f = await fixture();
    await completeInitialScan(f);
    const recovery = await begin(
      f,
      "begin-recovery",
      1,
      "identity_recovery",
      2_000,
    );
    const request = parseWorkerRequest({
      ...source(f),
      operation: "source.inventoryPage",
      scanId: recovery.scanId,
      requestId: "inventory-expired",
      expectedInventoryEpoch: recovery.inventoryEpoch,
      expectedManifestVersion: recovery.manifestVersion,
      paginationOpts: { cursor: null, numItems: 50 },
    });
    if (request.operation !== "source.inventoryPage") {
      throw new Error("bad test request");
    }
    await expect(
      f.t.run((ctx) =>
        getWorkerInventoryPage(
          ctx,
          f.principal,
          request,
          2_000 + 30 * 60 * 1_000,
        ),
      ),
    ).rejects.toMatchObject({ data: { code: "scan_not_ready" } });
    const stored = await f.t.run((ctx) =>
      ctx.db.get(recovery.scanId as Id<"workerSourceScans">),
    );
    expect(stored?.inventoryCursor).toBeUndefined();
  });

  test("keeps processing identity across a gap and queues a fresh observation", async () => {
    const f = await fixture();
    await completeInitialScan(f);
    const gapScan = await begin(f, "begin-gap", 1, "normal", 2_000);
    const gap = await append(
      f,
      gapScan.scanId,
      "page-gap",
      [
        readyEntry({
          content: { status: "gap", code: "unreadable" },
        }),
      ],
      2_100,
    );
    expect(gap.entries[0]).toMatchObject({
      state: "gap",
      observationEpoch: 2,
      processingEpoch: 1,
    });
    await seal(f, gapScan.scanId, "seal-gap", 1, {
      status: "failed",
      code: "unreadable",
    });

    const returnedScan = await begin(f, "begin-return", 2, "normal", 3_000);
    const returned = await append(
      f,
      returnedScan.scanId,
      "page-return",
      [readyEntry()],
      3_100,
    );
    expect(returned.entries[0]).toMatchObject({
      state: "queued",
      observationEpoch: 3,
      processingEpoch: 1,
    });
    const work = await f.t.run((ctx) => {
      const sourceItemId = ctx.db.normalizeId(
        "sourceItems",
        returned.entries[0]!.sourceItemId!,
      );
      if (!sourceItemId) throw new Error("invalid source item result");
      return ctx.db
        .query("workerDiscoveryWork")
        .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", sourceItemId))
        .collect();
    });
    expect(work.map((row) => row.state)).toEqual(["obsolete", "queued"]);
  });

  test("fails closed when the URI alias cap is exhausted", async () => {
    const f = await fixture();
    await completeInitialScan(f);
    const item = await f.t.run((ctx) =>
      ctx.db
        .query("sourceItems")
        .withIndex("by_sourceAccountId", (q) =>
          q.eq("sourceAccountId", f.sourceAccountId),
        )
        .first(),
    );
    if (!item) throw new Error("missing item");
    await f.t.run(async (ctx) => {
      for (let index = 1; index < 8; index += 1) {
        await ctx.db.insert("sourceAliasDigests", {
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
          sourceItemId: item._id,
          kind: "uri",
          digest: String(index).padStart(64, "0"),
          firstSeenAt: 1_000,
          lastSeenAt: 1_000,
        });
      }
    });
    const scan = await begin(f, "begin-cap", 1, "normal", 2_000);
    const page = await append(
      f,
      scan.scanId,
      "page-cap",
      [readyEntry({ uri: "fs://documents/ninth-path.txt" })],
      2_100,
    );
    expect(page.entries[0]?.state).toBe("needs_review");
    const aliases = await f.t.run((ctx) =>
      ctx.db
        .query("sourceAliasDigests")
        .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", item._id))
        .collect(),
    );
    expect(aliases).toHaveLength(8);
  });

  test("fails closed on corrupt replay and discovery-work parents", async () => {
    const f = await fixture();
    const first = await begin(f, "begin-parent-check", 0);
    await append(f, first.scanId, "page-parent-check", [readyEntry()]);
    const entryId = await f.t.run(async (ctx) => {
      const entry = await ctx.db
        .query("workerScanEntries")
        .withIndex("by_scanId", (q) => {
          const scanId = ctx.db.normalizeId("workerSourceScans", first.scanId);
          if (!scanId) throw new Error("invalid scan result");
          return q.eq("scanId", scanId);
        })
        .unique();
      if (!entry) throw new Error("missing scan entry");
      const otherSpaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Corrupt parent",
        createdBy: f.userId,
      });
      await ctx.db.patch(entry._id, { spaceId: otherSpaceId });
      return entry._id;
    });
    await expect(
      append(f, first.scanId, "page-parent-check", [readyEntry()]),
    ).rejects.toMatchObject({ data: { code: "scan_conflict" } });

    await f.t.run(async (ctx) => {
      await ctx.db.patch(entryId, { spaceId: f.spaceId });
    });
    await seal(f, first.scanId, "seal-parent-check", 1, {
      status: "failed",
      code: "unreadable",
    });
    const second = await begin(f, "begin-work-parent", 1, "normal", 2_000);
    await f.t.run(async (ctx) => {
      const work = await ctx.db.query("workerDiscoveryWork").unique();
      if (!work) throw new Error("missing discovery work");
      const scanId = ctx.db.normalizeId("workerSourceScans", second.scanId);
      if (!scanId) throw new Error("invalid scan result");
      await ctx.db.patch(work._id, { scanId });
    });
    await expect(
      append(f, second.scanId, "page-work-parent", [readyEntry()], 2_100),
    ).rejects.toMatchObject({ data: { code: "scan_conflict" } });
  });

  test.each(["sourceRevisionId", "processingGenerationId", "state"] as const)(
    "fails closed before rebinding a job with a corrupt %s",
    async (field) => {
      const f = await fixture();
      await completeInitialScan(f);
      await attachSyntheticJob(f, field);
      const scan = await begin(f, `begin-corrupt-${field}`, 1, "normal", 2_000);
      await expect(
        append(
          f,
          scan.scanId,
          `page-corrupt-${field}`,
          [readyEntry({ sourceModifiedAt: 200 })],
          2_100,
        ),
      ).rejects.toMatchObject({ data: { code: "scan_conflict" } });
    },
  );

  test("live revocation and cross-source access fail closed", async () => {
    const f = await fixture();
    const scan = await begin(f, "begin-1", 0);
    const otherSourceId = await f.t.run((ctx) =>
      ctx.db.insert("sourceAccounts", {
        spaceId: f.spaceId,
        connector: "fs",
        accountId: "other-fs",
        name: "Other filesystem",
        enabled: true,
        cursorVersion: 0,
        freshnessMs: 60_000,
        createdBy: f.userId,
      }),
    );
    const crossRequest = parseWorkerRequest({
      ...source(f),
      sourceAccountId: otherSourceId,
      operation: "scan.appendPage",
      scanId: scan.scanId,
      requestId: "cross",
      ordinal: 0,
      entries: [readyEntry()],
    });
    if (crossRequest.operation !== "scan.appendPage") {
      throw new Error("bad test request");
    }
    await expect(
      f.t.run((ctx) =>
        appendWorkerScanPage(ctx, f.principal, crossRequest, 1_100),
      ),
    ).rejects.toMatchObject({ data: { code: "not_authorized" } });

    await f.t.run((ctx) => ctx.db.delete(f.credentialId));
    await expect(
      append(f, scan.scanId, "revoked", [readyEntry()]),
    ).rejects.toMatchObject({ data: { code: "not_authorized" } });
  });

  test("rate limits new mutations while exact receipts stay retryable", async () => {
    const f = await fixture();
    for (let index = 0; index < 30; index += 1) {
      const scan = await begin(
        f,
        `rate-begin-${index}`,
        index,
        "normal",
        1_000 + index,
      );
      const sealed = await seal(
        f,
        scan.scanId,
        `rate-seal-${index}`,
        0,
        { status: "failed", code: "unreadable" },
        1_000 + index,
      );
      expect(
        (
          await seal(
            f,
            scan.scanId,
            `rate-seal-${index}`,
            0,
            { status: "failed", code: "unreadable" },
            1_000 + index,
          )
        ).reused,
      ).toBe(true);
      expect(sealed.state).toBe("failed");
    }
    await expect(
      begin(f, "rate-overflow", 30, "normal", 1_100),
    ).rejects.toMatchObject({ data: { code: "rate_limited" } });
  });
});

describe("filesystem discovery reservation and admission", () => {
  test("public MCP dispatch returns only the B1 result contract", async () => {
    const f = await fixture();
    await completeReservableScan(f);
    const priorIssuer = process.env.MCP_JWT_ISSUER;
    process.env.MCP_JWT_ISSUER = "https://synthetic.worker.test";
    try {
      const mcp = f.t.withIdentity({
        issuer: process.env.MCP_JWT_ISSUER,
        subject: f.userId,
        apiKeyId: f.credentialId,
      });
      const reservation = await mcp.action(api.models.workers.mcp.dispatch, {
        request: {
          ...source(f),
          operation: "discovery.reserve",
          requestId: "public-reserve",
          maxItems: 1,
        },
      });
      if (reservation.operation !== "discovery.reserve") {
        throw new Error("unexpected reservation result");
      }
      expect(reservation.targets[0]?.leaseToken).toMatch(/^[0-9a-f]{64}$/);
      const target = reservation.targets[0]!;
      const admitted = await mcp.action(api.models.workers.mcp.dispatch, {
        request: {
          ...source(f),
          operation: "discovery.admitUtf8",
          requestId: "public-admit",
          workId: target.workId,
          leaseEpoch: target.leaseEpoch,
          leaseToken: target.leaseToken,
          text: DISCOVERY_TEXT,
        },
      });
      expect(admitted).toMatchObject({
        operation: "discovery.admitUtf8",
        state: "admitted",
        reused: false,
      });
    } finally {
      if (priorIssuer === undefined) delete process.env.MCP_JWT_ISSUER;
      else process.env.MCP_JWT_ISSUER = priorIssuer;
    }
  });

  test("reserves once and replays only to the same live credential", async () => {
    const f = await fixture();
    await completeReservableScan(f);
    const first = await reserve(f);
    expect(first).toMatchObject({
      operation: "discovery.reserve",
      reused: false,
      targets: [
        {
          observationEpoch: 1,
          processingEpoch: 1,
          leaseEpoch: 1,
          leaseToken: "1".padStart(64, "0"),
          contentHash: DISCOVERY_TEXT_HASH,
          byteLength: 10,
        },
      ],
    });
    expect((await reserve(f)).reused).toBe(true);
    const reservationState = await f.t.run(async (ctx) => ({
      rate: await ctx.db.query("workerProtocolRateLimits").unique(),
      receipt: await ctx.db.query("workerReservationReceipts").unique(),
    }));
    expect(reservationState.rate?.count).toBe(5);
    expect(reservationState.receipt?.targetCount).toBe(1);
    expect(reservationState.receipt?.retireAt).toBeGreaterThan(first.expiresAt);

    const alternateCredentialId = await f.t.run((ctx) =>
      ctx.db.insert("apiKeys", {
        userId: f.userId,
        keyHash: "d".repeat(64),
        keyPrefix: "alternate",
        name: "Alternate worker",
        capabilities: ["ingest"],
        spaceIds: [f.spaceId],
        sourceAccountIds: [f.sourceAccountId],
      }),
    );
    const alternate = {
      userId: f.userId,
      credentialId: alternateCredentialId,
    };
    await expect(reserve(f, alternate)).rejects.toMatchObject({
      data: { code: "not_found" },
    });
    await expect(
      admit(f, first.targets[0]!, { principal: alternate }),
    ).rejects.toMatchObject({ data: { code: "lease_conflict" } });
    await expect(
      reserve(f, f.principal, "reserve-1", 1, first.expiresAt),
    ).rejects.toMatchObject({ data: { code: "reservation_expired" } });
  });

  test("leaves due work queued while a newer scan is unfinished", async () => {
    const f = await fixture();
    await completeReservableScan(f);
    const newer = await begin(f, "begin-open", 1, "normal", 3_000);

    await expect(
      reserve(f, f.principal, "reserve-during-open", 1, 3_100),
    ).rejects.toMatchObject({ data: { code: "scan_not_ready" } });
    const workDuringScan = await f.t.run((ctx) =>
      ctx.db.query("workerDiscoveryWork").unique(),
    );
    expect(workDuringScan?.state).toBe("queued");

    await append(f, newer.scanId, "page-open", [
      readyEntry({
        content: {
          status: "ready",
          sha256: DISCOVERY_TEXT_HASH,
          byteLength: 10,
        },
      }),
    ]);
    await seal(f, newer.scanId, "seal-open", 1, { status: "healthy" }, 3_200);
    await reconcile(f, newer.scanId, "reconcile-open", 2, 3_300);
    const result = await reserve(
      f,
      f.principal,
      "reserve-after-open",
      1,
      3_400,
    );
    expect(result.targets).toHaveLength(1);
  });

  test("admits exact UTF-8 bytes atomically and replays a lost response", async () => {
    const f = await fixture();
    await completeReservableScan(f);
    const reservation = await reserve(f);
    const target = reservation.targets[0]!;
    const first = await admit(f, target);
    expect(first).toMatchObject({
      operation: "discovery.admitUtf8",
      state: "admitted",
      desiredProcessingEpoch: 1,
      reused: false,
    });
    const replay = await admit(f, target);
    expect(replay).toEqual({ ...first, reused: true });
    await expect(
      admit(f, target, { text: "alpha betb" }),
    ).rejects.toMatchObject({ data: { code: "request_conflict" } });

    const stored = await f.t.run(async (ctx) => ({
      revision: await ctx.db.get(
        ctx.db.normalizeId("sourceRevisions", first.sourceRevisionId)!,
      ),
      work: await ctx.db.get(
        ctx.db.normalizeId("workerDiscoveryWork", first.workId)!,
      ),
      job: await ctx.db.get(
        ctx.db.normalizeId("ingestJobs", first.ingestJobId)!,
      ),
      receipts: await ctx.db.query("workerOperationReceipts").collect(),
      rate: await ctx.db.query("workerProtocolRateLimits").unique(),
    }));
    expect(stored.revision?.inlineText).toBe(DISCOVERY_TEXT);
    expect(stored.work).toMatchObject({ state: "admitted" });
    expect(stored.work?.leaseToken).toBeUndefined();
    expect(stored.job).toMatchObject({
      workerDiscoveryWorkId: stored.work?._id,
      workerObservationEpoch: 1,
    });
    expect(stored.receipts).toHaveLength(1);
    expect(stored.rate?.count).toBe(6);

    await f.t.run(async (ctx) => {
      const jobId = ctx.db.normalizeId("ingestJobs", first.ingestJobId);
      if (!jobId) throw new Error("invalid admitted job");
      await ctx.db.patch(jobId, { workerObservationEpoch: 2 });
    });
    await expect(admit(f, target)).rejects.toMatchObject({
      data: { code: "scan_conflict" },
    });
  });

  test("rejects changed bytes and original-actor revocation", async () => {
    const hashMismatch = await fixture();
    await completeReservableScan(hashMismatch);
    const mismatchReservation = await reserve(hashMismatch);
    await expect(
      admit(hashMismatch, mismatchReservation.targets[0]!, {
        text: "alpha betb",
      }),
    ).rejects.toMatchObject({ data: { code: "stale_observation" } });

    const revoked = await fixture();
    await completeReservableScan(revoked);
    const alternateCredentialId = await revoked.t.run((ctx) =>
      ctx.db.insert("apiKeys", {
        userId: revoked.userId,
        keyHash: "e".repeat(64),
        keyPrefix: "alternate",
        name: "Alternate worker",
        capabilities: ["ingest"],
        spaceIds: [revoked.spaceId],
        sourceAccountIds: [revoked.sourceAccountId],
      }),
    );
    const alternate = {
      userId: revoked.userId,
      credentialId: alternateCredentialId,
    };
    const reservation = await reserve(revoked, alternate);
    await revoked.t.run((ctx) => ctx.db.delete(revoked.credentialId));
    await expect(
      admit(revoked, reservation.targets[0]!, { principal: alternate }),
    ).rejects.toMatchObject({ data: { code: "not_authorized" } });
  });

  test("fences a lease when a newer changed discovery commits", async () => {
    const f = await fixture();
    await completeReservableScan(f);
    const reservation = await reserve(f);
    const oldTarget = reservation.targets[0]!;

    const newer = await begin(f, "begin-newer", 1, "normal", 3_000);
    await append(
      f,
      newer.scanId,
      "page-newer",
      [
        readyEntry({
          content: { status: "ready", sha256: HASH_B, byteLength: 10 },
        }),
      ],
      3_100,
    );
    await seal(f, newer.scanId, "seal-newer", 1, { status: "healthy" }, 3_200);
    await reconcile(f, newer.scanId, "reconcile-newer", 2, 3_300);

    await expect(admit(f, oldTarget, {}, 3_400)).rejects.toMatchObject({
      data: { code: "stale_observation" },
    });
  });

  test("fences a lease on metadata-only rebinding without advancing processing", async () => {
    const f = await fixture();
    await completeReservableScan(f);
    const reservation = await reserve(f);
    const oldTarget = reservation.targets[0]!;

    const newer = await begin(f, "begin-retitled", 1, "normal", 3_000);
    const page = await append(
      f,
      newer.scanId,
      "page-retitled",
      [
        readyEntry({
          title: "Retitled",
          content: {
            status: "ready",
            sha256: DISCOVERY_TEXT_HASH,
            byteLength: 10,
          },
        }),
      ],
      3_100,
    );
    expect(page.entries[0]).toMatchObject({
      observationEpoch: 2,
      processingEpoch: 1,
      state: "queued",
    });
    await seal(
      f,
      newer.scanId,
      "seal-retitled",
      1,
      { status: "healthy" },
      3_200,
    );
    await reconcile(f, newer.scanId, "reconcile-retitled", 2, 3_300);

    await expect(admit(f, oldTarget, {}, 3_400)).rejects.toMatchObject({
      data: { code: "stale_observation" },
    });
    const next = await reserve(f, f.principal, "reserve-retitled", 1, 3_500);
    expect(next.targets[0]).toMatchObject({
      observationEpoch: 2,
      processingEpoch: 1,
    });
  });

  test("does not mutate a corrupt cross-space reservation candidate", async () => {
    const f = await fixture();
    await completeReservableScan(f);
    const corrupted = await f.t.run(async (ctx) => {
      const work = await ctx.db.query("workerDiscoveryWork").unique();
      if (!work) throw new Error("missing worker state");
      const otherSpaceId = await ctx.db.insert("spaces", {
        kind: "shared",
        name: "Other synthetic space",
        createdBy: f.userId,
      });
      await ctx.db.patch(work._id, { spaceId: otherSpaceId, attempts: 8 });
      return work._id;
    });

    await expect(reserve(f)).rejects.toMatchObject({
      data: { code: "scan_conflict" },
    });
    const after = await f.t.run((ctx) => ctx.db.get(corrupted));
    expect(after).toMatchObject({ state: "queued", attempts: 8 });
  });

  test("clears a full non-retryable failed prefix across bounded reservations", async () => {
    const f = await fixture();
    const scan = await begin(f, "begin-prefix", 0);
    const entries = Array.from({ length: 13 }, (_, index) =>
      readyEntry({
        externalId: `${UUID_A.slice(0, -2)}${index
          .toString(16)
          .padStart(2, "0")}`,
        uri: `fs://documents/${index}.txt`,
        content: {
          status: "ready",
          sha256: DISCOVERY_TEXT_HASH,
          byteLength: 10,
        },
      }),
    );
    for (let ordinal = 0; ordinal < 4; ordinal += 1) {
      await append(
        f,
        scan.scanId,
        `page-prefix-${ordinal}`,
        entries.slice(ordinal * 4, ordinal * 4 + 4),
        1_100 + ordinal,
        ordinal,
      );
    }
    await seal(f, scan.scanId, "seal-prefix", 4, { status: "healthy" });
    await reconcile(f, scan.scanId, "reconcile-prefix", 1);
    await f.t.run(async (ctx) => {
      const works = await ctx.db.query("workerDiscoveryWork").collect();
      if (works.length !== 13) throw new Error("missing prefix test work");
      for (const work of works) {
        const isLast = work.uri === "fs://documents/12.txt";
        await ctx.db.patch(work._id, {
          state: "failed",
          retryable: isLast,
          nextAttemptAt: isLast ? 2 : 1,
        });
      }
    });

    const first = await reserve(f, f.principal, "reserve-prefix-1");
    expect(first.targets).toHaveLength(0);
    const second = await reserve(f, f.principal, "reserve-prefix-2");
    expect(second.targets).toHaveLength(1);
    expect(second.targets[0]?.uri).toBe("fs://documents/12.txt");
    const states = await f.t.run(
      async (ctx) => await ctx.db.query("workerDiscoveryWork").collect(),
    );
    expect(states.filter((work) => work.state === "needs_review")).toHaveLength(
      12,
    );
  });

  test("forget scrubs admitted operation receipts and immutable history", async () => {
    const f = await fixture();
    await completeReservableScan(f);
    const reservation = await reserve(f);
    const admitted = await admit(f, reservation.targets[0]!);
    const sourceItemId = await f.t.run(async (ctx) => {
      const id = ctx.db.normalizeId("sourceItems", admitted.sourceItemId);
      if (!id) throw new Error("invalid admitted source item");
      return id;
    });
    await f.t.run((ctx) =>
      beginForgetFromWeb(ctx, {
        principal: { userId: f.userId },
        sourceItemId,
        now: 3_000,
      }),
    );
    for (let index = 0; index < 100; index += 1) {
      const result = await f.t.run((ctx) =>
        continueForgetFromWeb(ctx, {
          principal: { userId: f.userId },
          sourceItemId,
        }),
      );
      if (result.done) break;
      if (index === 99) throw new Error("forget did not complete");
    }
    const remaining = await f.t.run(async (ctx) => ({
      operationReceipts: await ctx.db
        .query("workerOperationReceipts")
        .collect(),
      work: await ctx.db.query("workerDiscoveryWork").collect(),
      revisions: await ctx.db.query("sourceRevisions").collect(),
      jobs: await ctx.db.query("ingestJobs").collect(),
      item: await ctx.db.get(sourceItemId),
    }));
    expect(remaining.operationReceipts).toHaveLength(0);
    expect(remaining.work).toHaveLength(0);
    expect(remaining.revisions).toHaveLength(0);
    expect(remaining.jobs).toHaveLength(0);
    expect(remaining.item?.lifecycle).toBe("forgotten");
  });
});
