import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { admitDiscoveryUtf8, reserveDiscoveryWork } from "./discovery";
import {
  appendWorkerScanPage,
  beginWorkerScan,
  reconcileWorkerScan,
  sealWorkerScan,
} from "./model";
import { backfillManagedJobsPage } from "./migrations";

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
