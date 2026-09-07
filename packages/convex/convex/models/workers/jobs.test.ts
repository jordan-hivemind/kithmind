import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { replaceRevokedActorAndRequeueFromWeb } from "../ingestion/model";
import { admitDiscoveryUtf8, reserveDiscoveryWork } from "./discovery";
import {
  activateProcessingJob,
  beginProcessingStage,
  completeProcessingStage,
  failProcessingJob,
  renewProcessingJob,
  reserveProcessingJobs,
  stageProcessingChunkBatch,
  stageProcessingDocument,
  stageProcessingPage,
  stageProcessingSpanBatch,
  stageProcessingText,
  WORKER_JOB_LEASE_MS,
} from "./jobs";
import {
  appendWorkerScanPage,
  beginWorkerScan,
  reconcileWorkerScan,
  sealWorkerScan,
} from "./model";
import { parseWorkerRequest, type FsDiscoveryEntry } from "./protocol";

const UUID_A = "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139";
const TEXT = "alpha beta";
const TEXT_HASH =
  "1a989ea86150171c687b0727f218eedbb94c4665a7da9b0add1bf5de607f2bf1";
const OTHER_TEXT = "bravo text";
const OTHER_TEXT_HASH =
  "f91b03ffb0920bf9d97800141fcb133762d21aacaf0128b8046b01779249384f";

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Worker owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Synthetic processing space",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "fs",
      accountId: "synthetic-processing-fs",
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

type Fixture = Awaited<ReturnType<typeof fixture>>;

function source(f: Fixture) {
  return {
    protocolVersion: 1 as const,
    spaceId: f.spaceId,
    sourceAccountId: f.sourceAccountId,
  };
}

function readyEntry(
  externalId = UUID_A,
  uri = "fs://documents/a.txt",
  title = "A",
): FsDiscoveryEntry {
  return {
    externalId,
    uri,
    title,
    docType: "text",
    sourceModifiedAt: 100,
    content: { status: "ready", sha256: TEXT_HASH, byteLength: 10 },
  };
}

async function completeScan(
  f: Fixture,
  args: {
    suffix: string;
    expectedInventoryEpoch: number;
    entries: FsDiscoveryEntry[];
    now: number;
  },
) {
  const beginRequest = parseWorkerRequest({
    ...source(f),
    operation: "scan.begin",
    requestId: `begin-${args.suffix}`,
    watcherId: "watcher-1",
    connectorVersion: "fs-v1",
    mode: "normal",
    expectedInventoryEpoch: args.expectedInventoryEpoch,
  });
  if (beginRequest.operation !== "scan.begin") throw new Error("bad request");
  const scan = await f.t.run((ctx) =>
    beginWorkerScan(ctx, f.principal, beginRequest, args.now),
  );
  const pages = Array.from(
    { length: Math.ceil(args.entries.length / 4) },
    (_, ordinal) => args.entries.slice(ordinal * 4, ordinal * 4 + 4),
  );
  for (const [ordinal, entries] of pages.entries()) {
    const appendRequest = parseWorkerRequest({
      ...source(f),
      operation: "scan.appendPage",
      scanId: scan.scanId,
      requestId: `page-${args.suffix}-${ordinal}`,
      ordinal,
      entries,
    });
    if (appendRequest.operation !== "scan.appendPage") {
      throw new Error("bad request");
    }
    await f.t.run((ctx) =>
      appendWorkerScanPage(
        ctx,
        f.principal,
        appendRequest,
        args.now + 1 + ordinal,
      ),
    );
  }
  const sealRequest = parseWorkerRequest({
    ...source(f),
    operation: "scan.seal",
    scanId: scan.scanId,
    requestId: `seal-${args.suffix}`,
    expectedPageCount: pages.length,
    health: { status: "healthy" },
  });
  if (sealRequest.operation !== "scan.seal") throw new Error("bad request");
  await f.t.run((ctx) =>
    sealWorkerScan(ctx, f.principal, sealRequest, args.now + 1 + pages.length),
  );
  const reconcileRequest = parseWorkerRequest({
    ...source(f),
    operation: "scan.reconcile",
    scanId: scan.scanId,
    requestId: `reconcile-${args.suffix}`,
    expectedInventoryEpoch: scan.inventoryEpoch,
    ordinal: 0,
    maxItems: 50,
  });
  if (reconcileRequest.operation !== "scan.reconcile") {
    throw new Error("bad request");
  }
  await f.t.run((ctx) =>
    reconcileWorkerScan(
      ctx,
      f.principal,
      reconcileRequest,
      args.now + 2 + pages.length,
    ),
  );
  return scan;
}

async function admitAll(f: Fixture, count = 1, now = 2_000, text = TEXT) {
  const reserveRequest = parseWorkerRequest({
    ...source(f),
    operation: "discovery.reserve",
    requestId: `discovery-reserve-${now}`,
    maxItems: count,
  });
  if (reserveRequest.operation !== "discovery.reserve") {
    throw new Error("bad request");
  }
  const reserved = await f.t.run((ctx) =>
    reserveDiscoveryWork(
      ctx,
      f.principal,
      reserveRequest,
      Array.from({ length: count }, (_, index) =>
        String(index + 1).padStart(64, "0"),
      ),
      now,
    ),
  );
  const admitted = [];
  for (const [index, target] of reserved.targets.entries()) {
    const request = parseWorkerRequest({
      ...source(f),
      operation: "discovery.admitUtf8",
      requestId: `discovery-admit-${now}-${index}`,
      workId: target.workId,
      leaseEpoch: target.leaseEpoch,
      leaseToken: target.leaseToken,
      text,
    });
    if (request.operation !== "discovery.admitUtf8") {
      throw new Error("bad request");
    }
    admitted.push(
      await f.t.run((ctx) =>
        admitDiscoveryUtf8(ctx, f.principal, request, now + 1),
      ),
    );
  }
  return admitted;
}

async function reserveJobs(
  f: Fixture,
  requestId = "jobs-reserve-1",
  maxItems = 1,
  now = 3_000,
  principal = f.principal,
) {
  const request = parseWorkerRequest({
    ...source(f),
    operation: "jobs.reserve",
    requestId,
    maxItems,
  });
  if (request.operation !== "jobs.reserve") throw new Error("bad request");
  return await f.t.run((ctx) =>
    reserveProcessingJobs(
      ctx,
      principal,
      request,
      Array.from({ length: maxItems }, (_, index) =>
        String(index + 10).padStart(64, "0"),
      ),
      now,
    ),
  );
}

function leaseRequest(
  f: Fixture,
  target: Awaited<ReturnType<typeof reserveJobs>>["targets"][number],
  operation: "jobs.renew" | "jobs.stageUtf8" | "jobs.activate",
  requestId: string,
) {
  const request = parseWorkerRequest({
    ...source(f),
    operation,
    requestId,
    jobId: target.jobId,
    leaseEpoch: target.leaseEpoch,
    leaseToken: target.leaseToken,
  });
  if (
    request.operation !== "jobs.renew" &&
    request.operation !== "jobs.stageUtf8" &&
    request.operation !== "jobs.activate"
  ) {
    throw new Error("bad request");
  }
  return request;
}

async function stageAll(
  f: Fixture,
  target: Awaited<ReturnType<typeof reserveJobs>>["targets"][number],
  requestId: string,
  now: number,
) {
  const request = leaseRequest(f, target, "jobs.stageUtf8", requestId);
  if (request.operation !== "jobs.stageUtf8") throw new Error("bad request");
  const begun = await f.t.run((ctx) =>
    beginProcessingStage(ctx, f.principal, request, now),
  );
  if (begun.state === "completed") return begun.result;
  await f.t.run((ctx) =>
    stageProcessingText(ctx, f.principal, request, now + 1),
  );
  await f.t.run((ctx) =>
    stageProcessingPage(ctx, f.principal, request, now + 2),
  );
  let offset = 0;
  while (offset < begun.chunkCount) {
    const page = await f.t.run((ctx) =>
      stageProcessingSpanBatch(ctx, f.principal, request, offset, now + 3),
    );
    offset = page.nextOffset;
  }
  await f.t.run((ctx) =>
    stageProcessingDocument(ctx, f.principal, request, now + 4),
  );
  offset = 0;
  while (offset < begun.chunkCount) {
    const page = await f.t.run((ctx) =>
      stageProcessingChunkBatch(ctx, f.principal, request, offset, now + 5),
    );
    offset = page.nextOffset;
  }
  return await f.t.run((ctx) =>
    completeProcessingStage(ctx, f.principal, request, now + 6),
  );
}

describe("filesystem worker processing jobs", () => {
  test("reserves, renews, stages, and activates with exact lost-response replay", async () => {
    const f = await fixture();
    await completeScan(f, {
      suffix: "initial",
      expectedInventoryEpoch: 0,
      entries: [readyEntry()],
      now: 1_000,
    });
    await admitAll(f);

    const firstReservation = await reserveJobs(f);
    expect(firstReservation).toMatchObject({
      operation: "jobs.reserve",
      expiresAt: 3_000 + WORKER_JOB_LEASE_MS,
      reused: false,
      targets: [
        {
          state: "processing",
          leaseEpoch: 1,
          leaseExpiresAt: 3_000 + WORKER_JOB_LEASE_MS,
        },
      ],
    });
    expect(await reserveJobs(f)).toEqual({
      ...firstReservation,
      reused: true,
    });
    const target = firstReservation.targets[0]!;

    const renewRequest = leaseRequest(f, target, "jobs.renew", "jobs-renew-1");
    if (renewRequest.operation !== "jobs.renew") throw new Error("bad request");
    const renewed = await f.t.run((ctx) =>
      renewProcessingJob(ctx, f.principal, renewRequest, 3_100),
    );
    expect(renewed).toMatchObject({
      state: "processing",
      leaseExpiresAt: 3_100 + WORKER_JOB_LEASE_MS,
      reused: false,
    });
    expect(
      await f.t.run((ctx) =>
        renewProcessingJob(ctx, f.principal, renewRequest, 3_101),
      ),
    ).toEqual({ ...renewed, reused: true });

    const stageRequest = leaseRequest(
      f,
      target,
      "jobs.stageUtf8",
      "jobs-stage-1",
    );
    if (stageRequest.operation !== "jobs.stageUtf8")
      throw new Error("bad request");
    const intent = await f.t.run((ctx) =>
      beginProcessingStage(ctx, f.principal, stageRequest, 3_200),
    );
    expect(intent).toEqual({ state: "pending", chunkCount: 1 });
    const beforeWrites = await f.t.run(async (ctx) => ({
      receipts: await ctx.db
        .query("workerOperationReceipts")
        .withIndex("by_sourceAccountId_and_operation_and_requestId", (q) =>
          q
            .eq("sourceAccountId", f.sourceAccountId)
            .eq("operation", "job_stage_utf8")
            .eq("requestId", "jobs-stage-1"),
        )
        .collect(),
      textVersions: await ctx.db.query("sourceTextVersions").collect(),
    }));
    expect(beforeWrites.receipts).toMatchObject([{ phase: "pending" }]);
    expect(beforeWrites.textVersions).toHaveLength(0);

    const staged = await stageAll(f, target, "jobs-stage-1", 3_200);
    expect(staged).toMatchObject({
      state: "staged",
      actualPageCount: 1,
      actualEvidenceSpanCount: 1,
      actualDocumentCount: 1,
      actualChunkCount: 1,
    });
    expect(await stageAll(f, target, "jobs-stage-1", 3_210)).toEqual({
      ...staged,
      reused: true,
    });
    const generation = await f.t.run(async (ctx) => {
      const job = await ctx.db.get(
        ctx.db.normalizeId("ingestJobs", target.jobId)!,
      );
      return job ? await ctx.db.get(job.processingGenerationId) : null;
    });
    if (!generation) throw new Error("missing staged generation");
    await f.t.run((ctx) =>
      ctx.db.patch(generation._id, {
        expectedChunkCount: generation.expectedChunkCount + 1,
      }),
    );
    await expect(
      f.t.run((ctx) =>
        beginProcessingStage(ctx, f.principal, stageRequest, 3_211),
      ),
    ).rejects.toMatchObject({ data: { code: "scan_conflict" } });
    await f.t.run((ctx) =>
      ctx.db.patch(generation._id, {
        expectedChunkCount: generation.expectedChunkCount,
      }),
    );

    const activateRequest = leaseRequest(
      f,
      target,
      "jobs.activate",
      "jobs-activate-1",
    );
    if (activateRequest.operation !== "jobs.activate") {
      throw new Error("bad request");
    }
    const activated = await f.t.run((ctx) =>
      activateProcessingJob(ctx, f.principal, activateRequest, 3_300),
    );
    expect(activated).toMatchObject({ state: "ready", reused: false });
    expect(
      await f.t.run((ctx) =>
        activateProcessingJob(ctx, f.principal, activateRequest, 3_301),
      ),
    ).toEqual({ ...activated, reused: true });

    const stored = await f.t.run(async (ctx) => {
      const jobId = ctx.db.normalizeId("ingestJobs", target.jobId)!;
      const job = await ctx.db.get(jobId);
      return {
        job,
        item: job ? await ctx.db.get(job.sourceItemId) : null,
        documents: await ctx.db.query("documents").collect(),
        chunks: await ctx.db.query("chunks").collect(),
      };
    });
    expect(stored.job).toMatchObject({ state: "ready" });
    expect(stored.job?.workerLeaseOwnerCredentialId).toBeUndefined();
    expect(stored.item?.activeGenerationId).toBe(
      stored.job?.processingGenerationId,
    );
    expect(stored.documents).toMatchObject([
      { title: "A", docType: "text", publicationState: "active" },
    ]);
    expect(stored.chunks).toMatchObject([
      { text: TEXT, publicationState: "active" },
    ]);
  });

  test("binds a lease to one credential and makes stale failure replay inert", async () => {
    const f = await fixture();
    await completeScan(f, {
      suffix: "failure",
      expectedInventoryEpoch: 0,
      entries: [readyEntry()],
      now: 1_000,
    });
    await admitAll(f);
    const target = (await reserveJobs(f)).targets[0]!;
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
    const renewRequest = leaseRequest(
      f,
      target,
      "jobs.renew",
      "cross-credential-renew",
    );
    if (renewRequest.operation !== "jobs.renew") throw new Error("bad request");
    await expect(
      f.t.run((ctx) =>
        renewProcessingJob(
          ctx,
          { userId: f.userId, credentialId: alternateCredentialId },
          renewRequest,
          3_100,
        ),
      ),
    ).rejects.toMatchObject({ data: { code: "lease_conflict" } });

    const failRequest = parseWorkerRequest({
      ...source(f),
      operation: "jobs.fail",
      requestId: "jobs-fail-1",
      jobId: target.jobId,
      leaseEpoch: target.leaseEpoch,
      leaseToken: target.leaseToken,
      failureCode: "worker_interrupted",
    });
    if (failRequest.operation !== "jobs.fail") throw new Error("bad request");
    const failed = await f.t.run((ctx) =>
      failProcessingJob(ctx, f.principal, failRequest, 100_000),
    );
    expect(failed).toMatchObject({
      state: "failed",
      retryable: true,
      reused: false,
    });
    if (failed.nextAttemptAt === undefined) {
      throw new Error("retryable failure omitted nextAttemptAt");
    }
    const firstNextAttemptAt = failed.nextAttemptAt;
    expect(
      await f.t.run((ctx) =>
        failProcessingJob(ctx, f.principal, failRequest, 100_001),
      ),
    ).toEqual({ ...failed, reused: true });

    const reclaimed = await reserveJobs(
      f,
      "jobs-reserve-after-failure",
      1,
      firstNextAttemptAt,
    );
    expect(reclaimed.targets[0]).toMatchObject({
      state: "processing",
      leaseEpoch: 2,
    });
    await expect(
      f.t.run((ctx) =>
        failProcessingJob(
          ctx,
          f.principal,
          failRequest,
          firstNextAttemptAt + 1,
        ),
      ),
    ).rejects.toMatchObject({ data: { code: "stale_observation" } });

    const secondFailRequest = parseWorkerRequest({
      ...source(f),
      operation: "jobs.fail",
      requestId: "jobs-fail-2",
      jobId: reclaimed.targets[0]!.jobId,
      leaseEpoch: reclaimed.targets[0]!.leaseEpoch,
      leaseToken: reclaimed.targets[0]!.leaseToken,
      failureCode: "worker_interrupted",
    });
    if (secondFailRequest.operation !== "jobs.fail") {
      throw new Error("bad request");
    }
    const secondFailed = await f.t.run((ctx) =>
      failProcessingJob(
        ctx,
        f.principal,
        secondFailRequest,
        firstNextAttemptAt + 1,
      ),
    );
    expect(secondFailed.nextAttemptAt).not.toBe(firstNextAttemptAt);
    await f.t.run((ctx) =>
      ctx.db.patch(
        ctx.db.normalizeId("ingestJobs", reclaimed.targets[0]!.jobId)!,
        { nextAttemptAt: firstNextAttemptAt },
      ),
    );
    await expect(
      f.t.run((ctx) =>
        failProcessingJob(
          ctx,
          f.principal,
          failRequest,
          firstNextAttemptAt + 2,
        ),
      ),
    ).rejects.toMatchObject({ data: { code: "stale_observation" } });
  });

  test("stops a pending stage on rebind and preserves immutable document metadata", async () => {
    const f = await fixture();
    await completeScan(f, {
      suffix: "rebind-initial",
      expectedInventoryEpoch: 0,
      entries: [readyEntry()],
      now: 1_000,
    });
    await admitAll(f);
    const firstTarget = (await reserveJobs(f)).targets[0]!;
    const firstRequest = leaseRequest(
      f,
      firstTarget,
      "jobs.stageUtf8",
      "stage-before-rebind",
    );
    if (firstRequest.operation !== "jobs.stageUtf8")
      throw new Error("bad request");
    await f.t.run((ctx) =>
      beginProcessingStage(ctx, f.principal, firstRequest, 3_100),
    );
    await f.t.run((ctx) =>
      stageProcessingText(ctx, f.principal, firstRequest, 3_101),
    );
    await f.t.run((ctx) =>
      stageProcessingPage(ctx, f.principal, firstRequest, 3_102),
    );
    await f.t.run((ctx) =>
      stageProcessingSpanBatch(ctx, f.principal, firstRequest, 0, 3_103),
    );
    await f.t.run((ctx) =>
      stageProcessingDocument(ctx, f.principal, firstRequest, 3_104),
    );

    await completeScan(f, {
      suffix: "rebind-new",
      expectedInventoryEpoch: 1,
      entries: [readyEntry(UUID_A, "fs://documents/renamed.txt", "Renamed")],
      now: 4_000,
    });
    await expect(
      f.t.run((ctx) =>
        stageProcessingChunkBatch(ctx, f.principal, firstRequest, 0, 4_100),
      ),
    ).rejects.toMatchObject({ data: { code: "stale_observation" } });

    const secondTarget = (
      await reserveJobs(f, "jobs-reserve-after-rebind", 1, 4_200)
    ).targets[0]!;
    const staged = await stageAll(f, secondTarget, "stage-after-rebind", 4_300);
    expect(staged.state).toBe("staged");
    const documents = await f.t.run((ctx) =>
      ctx.db.query("documents").collect(),
    );
    expect(documents).toMatchObject([{ title: "A", docType: "text" }]);
  });

  test("recovers A-gap-A after partial staging without publishing the old generation", async () => {
    const f = await fixture();
    await completeScan(f, {
      suffix: "a-gap-a-initial",
      expectedInventoryEpoch: 0,
      entries: [readyEntry()],
      now: 1_000,
    });
    const firstAdmission = (await admitAll(f))[0]!;
    const firstTarget = (await reserveJobs(f)).targets[0]!;
    const firstRequest = leaseRequest(
      f,
      firstTarget,
      "jobs.stageUtf8",
      "stage-before-gap",
    );
    if (firstRequest.operation !== "jobs.stageUtf8") {
      throw new Error("bad request");
    }
    await f.t.run((ctx) =>
      beginProcessingStage(ctx, f.principal, firstRequest, 3_100),
    );
    await f.t.run((ctx) =>
      stageProcessingText(ctx, f.principal, firstRequest, 3_101),
    );
    await f.t.run((ctx) =>
      stageProcessingPage(ctx, f.principal, firstRequest, 3_102),
    );
    await f.t.run((ctx) =>
      stageProcessingSpanBatch(ctx, f.principal, firstRequest, 0, 3_103),
    );
    const partial = await f.t.run(async (ctx) => ({
      textVersions: await ctx.db.query("sourceTextVersions").collect(),
      pages: await ctx.db.query("sourcePages").collect(),
      spans: await ctx.db.query("evidenceSpans").collect(),
    }));
    expect(partial.textVersions).toHaveLength(1);
    expect(partial.pages).toHaveLength(1);
    expect(partial.spans).toHaveLength(1);

    await completeScan(f, {
      suffix: "a-gap-a-gap",
      expectedInventoryEpoch: 1,
      entries: [
        {
          ...readyEntry(),
          content: { status: "gap", code: "unreadable" },
        },
      ],
      now: 4_000,
    });
    const prunedGap = await f.t.run(async (ctx) => {
      const gapEntry = await ctx.db
        .query("workerScanEntries")
        .withIndex("by_sourceAccountId_and_state", (q) =>
          q.eq("sourceAccountId", f.sourceAccountId).eq("state", "gap"),
        )
        .unique();
      if (!gapEntry) throw new Error("missing gap entry");
      const gapPageId = gapEntry.scanPageId;
      await ctx.db.delete(gapEntry._id);
      await ctx.db.delete(gapPageId);
      return { entryId: gapEntry._id, pageId: gapPageId };
    });
    const prunedRows = await f.t.run(async (ctx) => ({
      entry: await ctx.db.get(prunedGap.entryId),
      page: await ctx.db.get(prunedGap.pageId),
    }));
    expect(prunedRows).toEqual({ entry: null, page: null });
    await expect(
      f.t.run((ctx) =>
        stageProcessingDocument(ctx, f.principal, firstRequest, 4_100),
      ),
    ).rejects.toMatchObject({ data: { code: "stale_observation" } });

    await completeScan(f, {
      suffix: "a-gap-a-unadmitted-return",
      expectedInventoryEpoch: 2,
      entries: [readyEntry()],
      now: 5_000,
    });
    const unadmittedReturn = await f.t.run(async (ctx) => {
      const rows = await ctx.db.query("workerDiscoveryWork").collect();
      return rows.sort((a, b) => b.processingEpoch - a.processingEpoch)[0];
    });
    expect(unadmittedReturn).toMatchObject({
      state: "queued",
      processingEpoch: 2,
    });
    expect(unadmittedReturn?.ingestJobId).toBeUndefined();

    await completeScan(f, {
      suffix: "a-gap-a-second-gap",
      expectedInventoryEpoch: 3,
      entries: [
        {
          ...readyEntry(),
          content: { status: "gap", code: "unreadable" },
        },
      ],
      now: 6_000,
    });
    await completeScan(f, {
      suffix: "a-gap-a-final-return",
      expectedInventoryEpoch: 4,
      entries: [readyEntry()],
      now: 7_000,
    });
    const secondAdmission = (await admitAll(f, 1, 8_000))[0]!;
    expect(secondAdmission.sourceRevisionId).toBe(
      firstAdmission.sourceRevisionId,
    );
    expect(secondAdmission.processingGenerationId).not.toBe(
      firstAdmission.processingGenerationId,
    );
    expect(secondAdmission.desiredProcessingEpoch).toBe(
      firstAdmission.desiredProcessingEpoch + 1,
    );

    const secondTarget = (
      await reserveJobs(f, "jobs-reserve-after-gap", 1, 9_000)
    ).targets[0]!;
    await stageAll(f, secondTarget, "stage-after-gap", 9_100);
    const activateRequest = leaseRequest(
      f,
      secondTarget,
      "jobs.activate",
      "activate-after-gap",
    );
    if (activateRequest.operation !== "jobs.activate") {
      throw new Error("bad request");
    }
    await f.t.run((ctx) =>
      activateProcessingJob(ctx, f.principal, activateRequest, 9_200),
    );

    const recovered = await f.t.run(async (ctx) => {
      const item = await ctx.db.get(
        ctx.db.normalizeId("sourceItems", secondAdmission.sourceItemId)!,
      );
      return {
        item,
        firstGeneration: await ctx.db.get(
          ctx.db.normalizeId(
            "processingGenerations",
            firstAdmission.processingGenerationId,
          )!,
        ),
        secondGeneration: await ctx.db.get(
          ctx.db.normalizeId(
            "processingGenerations",
            secondAdmission.processingGenerationId,
          )!,
        ),
        textVersions: await ctx.db.query("sourceTextVersions").collect(),
        pages: await ctx.db.query("sourcePages").collect(),
        spans: await ctx.db.query("evidenceSpans").collect(),
        documents: await ctx.db.query("documents").collect(),
        chunks: await ctx.db.query("chunks").collect(),
      };
    });
    expect(recovered.textVersions.map((row) => row._id)).toEqual([
      partial.textVersions[0]!._id,
    ]);
    expect(recovered.pages.map((row) => row._id)).toEqual([
      partial.pages[0]!._id,
    ]);
    expect(recovered.spans.map((row) => row._id)).toEqual([
      partial.spans[0]!._id,
    ]);
    expect(recovered.firstGeneration?.state).toBe("obsolete_generation");
    expect(recovered.secondGeneration?.state).toBe("ready");
    expect(recovered.item?.activeGenerationId).toBe(
      recovered.secondGeneration?._id,
    );
    expect(recovered.documents).toMatchObject([
      {
        processingGenerationId: recovered.secondGeneration?._id,
        publicationState: "active",
      },
    ]);
    expect(recovered.chunks).toMatchObject([
      {
        processingGenerationId: recovered.secondGeneration?._id,
        publicationState: "active",
      },
    ]);
  });

  test("does not mistake an older active revision for a newer interrupted correction", async () => {
    const f = await fixture();
    await completeScan(f, {
      suffix: "active-a-initial",
      expectedInventoryEpoch: 0,
      entries: [readyEntry()],
      now: 1_000,
    });
    const firstAdmission = (await admitAll(f))[0]!;
    const firstTarget = (await reserveJobs(f)).targets[0]!;
    await stageAll(f, firstTarget, "stage-active-a", 3_100);
    const firstActivate = leaseRequest(
      f,
      firstTarget,
      "jobs.activate",
      "activate-active-a",
    );
    if (firstActivate.operation !== "jobs.activate") {
      throw new Error("bad request");
    }
    await f.t.run((ctx) =>
      activateProcessingJob(ctx, f.principal, firstActivate, 3_200),
    );

    await completeScan(f, {
      suffix: "active-a-partial-b",
      expectedInventoryEpoch: 1,
      entries: [
        {
          ...readyEntry(),
          content: {
            status: "ready",
            sha256: OTHER_TEXT_HASH,
            byteLength: OTHER_TEXT.length,
          },
        },
      ],
      now: 4_000,
    });
    const secondAdmission = (await admitAll(f, 1, 5_000, OTHER_TEXT))[0]!;
    const secondTarget = (
      await reserveJobs(f, "jobs-reserve-partial-b", 1, 6_000)
    ).targets[0]!;
    const secondStage = leaseRequest(
      f,
      secondTarget,
      "jobs.stageUtf8",
      "stage-partial-b",
    );
    if (secondStage.operation !== "jobs.stageUtf8") {
      throw new Error("bad request");
    }
    await f.t.run((ctx) =>
      beginProcessingStage(ctx, f.principal, secondStage, 6_100),
    );
    await f.t.run((ctx) =>
      stageProcessingText(ctx, f.principal, secondStage, 6_101),
    );

    await completeScan(f, {
      suffix: "active-a-final-return",
      expectedInventoryEpoch: 2,
      entries: [readyEntry()],
      now: 7_000,
    });
    await expect(
      f.t.run((ctx) =>
        stageProcessingPage(ctx, f.principal, secondStage, 7_100),
      ),
    ).rejects.toMatchObject({ data: { code: "stale_observation" } });
    const thirdAdmission = (await admitAll(f, 1, 8_000))[0]!;
    expect(thirdAdmission.sourceRevisionId).toBe(
      firstAdmission.sourceRevisionId,
    );
    expect(thirdAdmission.processingGenerationId).not.toBe(
      firstAdmission.processingGenerationId,
    );
    expect(thirdAdmission.processingGenerationId).not.toBe(
      secondAdmission.processingGenerationId,
    );
    expect(thirdAdmission.desiredProcessingEpoch).toBe(
      secondAdmission.desiredProcessingEpoch + 1,
    );
  });

  test("isolates worker eligibility from legacy jobs and quarantines a corrupt prefix", async () => {
    const f = await fixture();
    const secondUuid = `${UUID_A.slice(0, -1)}8`;
    await completeScan(f, {
      suffix: "two-items",
      expectedInventoryEpoch: 0,
      entries: [
        readyEntry(UUID_A, "fs://documents/a.txt", "A"),
        readyEntry(secondUuid, "fs://documents/b.txt", "B"),
      ],
      now: 1_000,
    });
    const admitted = await admitAll(f, 2);
    await f.t.run(async (ctx) => {
      const firstJobId = ctx.db.normalizeId(
        "ingestJobs",
        admitted[0]!.ingestJobId,
      )!;
      const firstJob = await ctx.db.get(firstJobId);
      if (!firstJob) throw new Error("missing first job");
      await ctx.db.patch(firstJob._id, { leaseEpoch: -1 });

      const legacyItemId = await ctx.db.insert("sourceItems", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        externalIdHash: "e".repeat(64),
        externalId: "legacy",
        lifecycle: "available",
        originalLinkAvailable: true,
        desiredProcessingEpoch: 0,
      });
      const legacyRevisionId = await ctx.db.insert("sourceRevisions", {
        spaceId: f.spaceId,
        sourceItemId: legacyItemId,
        contentHash: TEXT_HASH,
        byteLength: 10,
        mediaType: "text/plain; charset=utf-8",
        inlineText: TEXT,
        capturedAt: 1,
        userId: f.userId,
      });
      const legacyGenerationId = await ctx.db.insert("processingGenerations", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        sourceItemId: legacyItemId,
        sourceRevisionId: legacyRevisionId,
        processingFingerprint: "legacy",
        extractionFingerprint: "legacy",
        extractorFingerprint: "legacy",
        recordSchemaFingerprint: "legacy",
        normalizationFingerprint: "legacy",
        chunkerFingerprint: "legacy",
        correctionRevision: "legacy",
        desiredProcessingEpoch: 0,
        state: "queued",
        expectedPageCount: 0,
        expectedEvidenceSpanCount: 0,
        expectedDocumentCount: 0,
        expectedChunkCount: 0,
        embeddingStatus: "unavailable",
      });
      await ctx.db.insert("ingestJobs", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        sourceItemId: legacyItemId,
        sourceRevisionId: legacyRevisionId,
        processingGenerationId: legacyGenerationId,
        admittedByUserId: f.userId,
        actorUserId: f.userId,
        desiredProcessingEpoch: 0,
        state: "queued",
        attempts: 0,
        leaseEpoch: 0,
        nextAttemptAt: 0,
      });
    });

    const reserved = await reserveJobs(f, "jobs-reserve-corrupt-prefix", 1);
    expect(reserved.targets).toHaveLength(1);
    expect(reserved.targets[0]?.jobId).toBe(admitted[1]?.ingestJobId);
    const states = await f.t.run(async (ctx) => ({
      first: await ctx.db.get(
        ctx.db.normalizeId("ingestJobs", admitted[0]!.ingestJobId)!,
      ),
      legacy: (await ctx.db.query("ingestJobs").collect()).find(
        (job) => job.workerManaged !== true,
      ),
    }));
    expect(states.first?.state).toBe("needs_review");
    expect(states.legacy?.state).toBe("queued");
  });

  test("rejects web actor replacement for worker-linked jobs", async () => {
    const f = await fixture();
    await completeScan(f, {
      suffix: "web-actor-replacement",
      expectedInventoryEpoch: 0,
      entries: [readyEntry()],
      now: 1_000,
    });
    const admitted = (await admitAll(f))[0]!;
    const unauthorizedUserId = await f.t.run((ctx) =>
      ctx.db.insert("users", { name: "Unauthorized web user" }),
    );
    await expect(
      f.t.run((ctx) =>
        replaceRevokedActorAndRequeueFromWeb(ctx, {
          principal: { userId: unauthorizedUserId },
          jobId: ctx.db.normalizeId("ingestJobs", admitted.ingestJobId)!,
          now: 3_000,
        }),
      ),
    ).rejects.toThrow("Source account not found");
    await expect(
      f.t.run((ctx) =>
        replaceRevokedActorAndRequeueFromWeb(ctx, {
          principal: { userId: f.userId },
          jobId: ctx.db.normalizeId("ingestJobs", admitted.ingestJobId)!,
          now: 3_000,
        }),
      ),
    ).rejects.toThrow(
      "Worker-linked ingest jobs require provenance-preserving recovery",
    );
  });

  test("clears a full nonretryable failed prefix across bounded reservations", async () => {
    const f = await fixture();
    const entries = Array.from({ length: 13 }, (_, index) =>
      readyEntry(
        `${UUID_A.slice(0, -2)}${index.toString(16).padStart(2, "0")}`,
        `fs://documents/prefix-${index}.txt`,
        `Prefix ${index}`,
      ),
    );
    await completeScan(f, {
      suffix: "failed-prefix",
      expectedInventoryEpoch: 0,
      entries,
      now: 1_000,
    });
    await admitAll(f, 4, 2_000);
    await admitAll(f, 4, 2_010);
    await admitAll(f, 4, 2_020);
    await admitAll(f, 1, 2_030);
    await f.t.run(async (ctx) => {
      const jobs = (await ctx.db.query("ingestJobs").collect())
        .filter((job) => job.workerManaged === true)
        .sort(
          (left, right) =>
            left._creationTime - right._creationTime ||
            left._id.localeCompare(right._id),
        );
      if (jobs.length !== 13) throw new Error("missing failed-prefix jobs");
      for (const [index, job] of jobs.entries()) {
        const retryable = index === jobs.length - 1;
        await ctx.db.patch(job._id, {
          state: "failed",
          nextAttemptAt: 0,
          ...(index === 0
            ? {
                leaseToken: "a".repeat(64),
                leaseExpiresAt: 999_999,
                workerLeaseOwnerCredentialId: f.credentialId,
              }
            : {}),
          error: {
            code: "synthetic_failure",
            message: "Synthetic failed-prefix row",
            retryable,
            at: 2_500,
          },
        });
        await ctx.db.patch(job.processingGenerationId, { state: "failed" });
      }
    });

    const first = await reserveJobs(f, "jobs-reserve-failed-prefix-1");
    expect(first.targets).toHaveLength(0);
    const firstStates = await f.t.run((ctx) =>
      ctx.db.query("ingestJobs").collect(),
    );
    expect(
      firstStates.filter((job) => job.state === "needs_review"),
    ).toHaveLength(12);
    expect(firstStates.filter((job) => job.state === "failed")).toHaveLength(1);

    const second = await reserveJobs(
      f,
      "jobs-reserve-failed-prefix-2",
      1,
      3_001,
    );
    expect(second.targets).toMatchObject([
      { state: "processing", leaseEpoch: 1 },
    ]);
  });

  test("reclaims an expired staged job without replaying an older lease", async () => {
    const f = await fixture();
    await completeScan(f, {
      suffix: "expired-staged",
      expectedInventoryEpoch: 0,
      entries: [readyEntry()],
      now: 1_000,
    });
    await admitAll(f);
    const firstTarget = (await reserveJobs(f)).targets[0]!;
    const firstStageRequest = leaseRequest(
      f,
      firstTarget,
      "jobs.stageUtf8",
      "stage-before-expiry",
    );
    if (firstStageRequest.operation !== "jobs.stageUtf8") {
      throw new Error("bad request");
    }
    await stageAll(f, firstTarget, "stage-before-expiry", 3_100);

    const reclaimed = await reserveJobs(
      f,
      "jobs-reserve-expired-staged",
      1,
      firstTarget.leaseExpiresAt,
    );
    expect(reclaimed.targets).toMatchObject([
      {
        jobId: firstTarget.jobId,
        state: "staged",
        leaseEpoch: firstTarget.leaseEpoch + 1,
        leaseExpiresAt: firstTarget.leaseExpiresAt + WORKER_JOB_LEASE_MS,
      },
    ]);
    await expect(
      f.t.run((ctx) =>
        beginProcessingStage(
          ctx,
          f.principal,
          firstStageRequest,
          firstTarget.leaseExpiresAt + 1,
        ),
      ),
    ).rejects.toMatchObject({ data: { code: "lease_conflict" } });

    const secondTarget = reclaimed.targets[0]!;
    const activateRequest = leaseRequest(
      f,
      secondTarget,
      "jobs.activate",
      "activate-reclaimed-staged",
    );
    if (activateRequest.operation !== "jobs.activate") {
      throw new Error("bad request");
    }
    await expect(
      f.t.run((ctx) =>
        activateProcessingJob(
          ctx,
          f.principal,
          activateRequest,
          firstTarget.leaseExpiresAt + 1,
        ),
      ),
    ).resolves.toMatchObject({ state: "ready", reused: false });
  });

  test("quarantines revoked reservation candidates while staged writes fail closed", async () => {
    const queued = await fixture();
    const secondUuid = `${UUID_A.slice(0, -1)}8`;
    await completeScan(queued, {
      suffix: "revoked-before-reserve",
      expectedInventoryEpoch: 0,
      entries: [
        readyEntry(),
        readyEntry(secondUuid, "fs://documents/b.txt", "B"),
      ],
      now: 1_000,
    });
    const admitted = await admitAll(queued, 2);
    const revokedCredentialId = await queued.t.run((ctx) =>
      ctx.db.insert("apiKeys", {
        userId: queued.userId,
        keyHash: "e".repeat(64),
        keyPrefix: "revoked-original",
        name: "Revoked original worker",
        capabilities: ["ingest"],
        spaceIds: [queued.spaceId],
        sourceAccountIds: [queued.sourceAccountId],
      }),
    );
    const revokedJobId = await queued.t.run(async (ctx) => {
      const jobs = (await ctx.db.query("ingestJobs").collect()).sort(
        (left, right) =>
          left._creationTime - right._creationTime ||
          left._id.localeCompare(right._id),
      );
      const job = jobs[0];
      if (!job?.workerDiscoveryWorkId) throw new Error("missing worker job");
      await ctx.db.patch(job.workerDiscoveryWorkId, {
        actorCredentialId: revokedCredentialId,
      });
      await ctx.db.patch(job._id, {
        actorCredentialId: revokedCredentialId,
        admittedByCredentialId: revokedCredentialId,
      });
      await ctx.db.delete(revokedCredentialId);
      return job._id;
    });
    const queuedReservation = await reserveJobs(
      queued,
      "jobs-reserve-revoked-original",
      1,
    );
    expect(queuedReservation.targets).toHaveLength(1);
    expect(queuedReservation.targets[0]?.jobId).not.toBe(revokedJobId);
    const queuedStates = await queued.t.run(async (ctx) => ({
      revoked: await ctx.db.get(revokedJobId),
      valid: await ctx.db.get(
        ctx.db.normalizeId("ingestJobs", admitted[1]!.ingestJobId)!,
      ),
    }));
    expect(queuedStates.revoked?.state).toBe("needs_review");
    expect(queuedStates.valid?.state).toBe("processing");

    const staged = await fixture();
    await completeScan(staged, {
      suffix: "revoked-during-stage",
      expectedInventoryEpoch: 0,
      entries: [readyEntry()],
      now: 1_000,
    });
    await admitAll(staged);
    const stagedAlternateCredentialId = await staged.t.run((ctx) =>
      ctx.db.insert("apiKeys", {
        userId: staged.userId,
        keyHash: "f".repeat(64),
        keyPrefix: "stage-alternate",
        name: "Stage alternate worker",
        capabilities: ["ingest"],
        spaceIds: [staged.spaceId],
        sourceAccountIds: [staged.sourceAccountId],
      }),
    );
    const stagedAlternate = {
      userId: staged.userId,
      credentialId: stagedAlternateCredentialId,
    };
    const target = (
      await reserveJobs(
        staged,
        "jobs-reserve-stage-alternate",
        1,
        3_000,
        stagedAlternate,
      )
    ).targets[0]!;
    const stageRequest = leaseRequest(
      staged,
      target,
      "jobs.stageUtf8",
      "stage-revoked-original",
    );
    if (stageRequest.operation !== "jobs.stageUtf8") {
      throw new Error("bad request");
    }
    await staged.t.run((ctx) =>
      beginProcessingStage(ctx, stagedAlternate, stageRequest, 3_100),
    );
    await staged.t.run((ctx) => ctx.db.delete(staged.credentialId));
    await expect(
      staged.t.run((ctx) =>
        stageProcessingText(ctx, stagedAlternate, stageRequest, 3_101),
      ),
    ).rejects.toMatchObject({ data: { code: "not_authorized" } });
    const rows = await staged.t.run(async (ctx) => ({
      textVersions: await ctx.db.query("sourceTextVersions").collect(),
      receipt: await ctx.db
        .query("workerOperationReceipts")
        .withIndex("by_sourceAccountId_and_operation_and_requestId", (q) =>
          q
            .eq("sourceAccountId", staged.sourceAccountId)
            .eq("operation", "job_stage_utf8")
            .eq("requestId", "stage-revoked-original"),
        )
        .unique(),
    }));
    expect(rows.textVersions).toHaveLength(0);
    expect(rows.receipt?.phase).toBe("pending");
  });

  test("validates the server processing fingerprint and expected counts before stage intent", async () => {
    const f = await fixture();
    await completeScan(f, {
      suffix: "invalid-stage-plan",
      expectedInventoryEpoch: 0,
      entries: [readyEntry()],
      now: 1_000,
    });
    const admitted = await admitAll(f);
    const target = (await reserveJobs(f)).targets[0]!;
    const generationId = f.t.run((ctx) =>
      Promise.resolve(
        ctx.db.normalizeId(
          "processingGenerations",
          admitted[0]!.processingGenerationId,
        )!,
      ),
    );
    const resolvedGenerationId = await generationId;
    const original = await f.t.run((ctx) => ctx.db.get(resolvedGenerationId));
    if (!original) throw new Error("missing generation");

    await f.t.run((ctx) =>
      ctx.db.patch(resolvedGenerationId, {
        processingFingerprint: "0".repeat(64),
      }),
    );
    const fingerprintRequest = leaseRequest(
      f,
      target,
      "jobs.stageUtf8",
      "stage-invalid-fingerprint",
    );
    if (fingerprintRequest.operation !== "jobs.stageUtf8") {
      throw new Error("bad request");
    }
    await expect(
      f.t.run((ctx) =>
        beginProcessingStage(ctx, f.principal, fingerprintRequest, 3_100),
      ),
    ).rejects.toMatchObject({ data: { code: "scan_conflict" } });

    await f.t.run((ctx) =>
      ctx.db.patch(resolvedGenerationId, {
        processingFingerprint: original.processingFingerprint,
        expectedChunkCount: original.expectedChunkCount + 1,
      }),
    );
    const countRequest = leaseRequest(
      f,
      target,
      "jobs.stageUtf8",
      "stage-invalid-count",
    );
    if (countRequest.operation !== "jobs.stageUtf8") {
      throw new Error("bad request");
    }
    await expect(
      f.t.run((ctx) =>
        beginProcessingStage(ctx, f.principal, countRequest, 3_101),
      ),
    ).rejects.toMatchObject({ data: { code: "scan_conflict" } });
    const receipts = await f.t.run((ctx) =>
      ctx.db.query("workerOperationReceipts").collect(),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.operation).toBe("discovery_admit_utf8");
  });

  test("revalidates the server processing plan before every staged write", async () => {
    const f = await fixture();
    await completeScan(f, {
      suffix: "changed-plan-after-intent",
      expectedInventoryEpoch: 0,
      entries: [readyEntry()],
      now: 1_000,
    });
    const admitted = await admitAll(f);
    const target = (await reserveJobs(f)).targets[0]!;
    const request = leaseRequest(
      f,
      target,
      "jobs.stageUtf8",
      "stage-changed-plan-after-intent",
    );
    if (request.operation !== "jobs.stageUtf8") throw new Error("bad request");
    await f.t.run((ctx) =>
      beginProcessingStage(ctx, f.principal, request, 3_100),
    );
    await f.t.run((ctx) =>
      ctx.db.patch(
        ctx.db.normalizeId(
          "processingGenerations",
          admitted[0]!.processingGenerationId,
        )!,
        { expectedChunkCount: 2 },
      ),
    );

    await expect(
      f.t.run((ctx) => stageProcessingText(ctx, f.principal, request, 3_101)),
    ).rejects.toMatchObject({ data: { code: "scan_conflict" } });
    const textVersions = await f.t.run((ctx) =>
      ctx.db.query("sourceTextVersions").collect(),
    );
    expect(textVersions).toHaveLength(0);
  });
});
