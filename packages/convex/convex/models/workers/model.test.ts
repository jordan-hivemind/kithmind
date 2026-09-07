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
import { parseWorkerRequest, type FsDiscoveryEntry } from "./protocol";
import { FS_TEXT_PROFILE } from "./profile";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const UUID_A = "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139";

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
