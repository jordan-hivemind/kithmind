import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../../_generated/api";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { beginForgetFromWeb, continueForgetFromWeb } from "../ingestion/model";
import { createOrGetSourceItem } from "../provenance/model";
import { appendWorkerScanPage, beginWorkerScan, sealWorkerScan } from "./model";
import { parseWorkerRequest } from "./protocol";

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Cleanup owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Cleanup space",
      createdBy: userId,
    });
    await ctx.db.insert("spaceMembers", { spaceId, userId, role: "owner" });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "fs",
      accountId: "cleanup-fs",
      name: "Cleanup filesystem",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 60_000,
      createdBy: userId,
    });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId,
      keyHash: "a".repeat(64),
      keyPrefix: "cleanup",
      name: "Cleanup key",
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

async function insertScan(
  t: Awaited<ReturnType<typeof fixture>>["t"],
  ids: Awaited<ReturnType<typeof fixture>>,
) {
  return await t.run((ctx) =>
    ctx.db.insert("workerSourceScans", {
      spaceId: ids.spaceId,
      sourceAccountId: ids.sourceAccountId,
      requestId: crypto.randomUUID(),
      requestDigest: "a".repeat(64),
      watcherId: "watcher",
      connectorVersion: "v1",
      mode: "normal",
      inventoryEpoch: 0,
      manifestVersionAtBegin: 0,
      actorUserId: ids.userId,
      actorCredentialId: ids.credentialId,
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
    }),
  );
}

describe("worker cleanup bounds", () => {
  test("round-robins past pinned pages while reaching another terminal scan phase", async () => {
    const f = await fixture();
    const scanId = await insertScan(f.t, f);
    const terminalScanId = await insertScan(f.t, f);
    await f.t.run(async (ctx) => {
      for (let index = 0; index < 26; index += 1) {
        const pageId = await ctx.db.insert("workerScanPages", {
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
          scanId,
          ordinal: index,
          requestId: `page-${index}`,
          requestDigest: "b".repeat(64),
          entryCount: index < 25 ? 1 : 0,
          createdAt: 0,
          retireAt: index,
        });
        if (index < 25)
          await ctx.db.insert("workerScanEntries", {
            spaceId: f.spaceId,
            sourceAccountId: f.sourceAccountId,
            scanId,
            scanPageId: pageId,
            identityKeyHash: `identity-${index}`,
            uriDigest: `uri-${index}`,
            inventoryMetadataDigest: `metadata-${index}`,
            sourceModifiedAt: 0,
            state: "unchanged",
            observedAt: 0,
            retireAt: 4_102_444_800_000,
          });
      }
    });
    const firstCycle = [];
    for (let index = 0; index < 19; index += 1) {
      firstCycle.push(
        await f.t.mutation(internal.models.workers.cleanup.removeExpired, {}),
      );
    }
    expect(firstCycle.every((result) => result.inspected <= 25)).toBe(true);
    await f.t.run(async (ctx) => {
      expect(await ctx.db.get(terminalScanId)).toBeNull();
      expect(await ctx.db.query("workerScanPages").collect()).toHaveLength(26);
    });

    const secondCycle = [];
    for (let index = 0; index < 19; index += 1) {
      secondCycle.push(
        await f.t.mutation(internal.models.workers.cleanup.removeExpired, {}),
      );
    }
    expect(secondCycle.every((result) => result.inspected <= 25)).toBe(true);
    await f.t.run(async (ctx) => {
      const pages = await ctx.db.query("workerScanPages").collect();
      const entries = await ctx.db.query("workerScanEntries").collect();
      expect(pages).toHaveLength(25);
      expect(entries).toHaveLength(25);
      expect(pages.every((page) => page.ordinal < 25)).toBe(true);
      expect(await ctx.db.get(terminalScanId)).toBeNull();
    });
  });

  test("forget removes an unresolved alias candidate after linked-prefix rows", async () => {
    const f = await fixture();
    const ids = await f.t.run(async (ctx) => {
      const target = await createOrGetSourceItem(ctx, {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        externalId: "target",
        uri: "fs://target",
      });
      const other = await createOrGetSourceItem(ctx, {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        externalId: "other",
        uri: "fs://other",
      });
      const scanId = await ctx.db.insert("workerSourceScans", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        requestId: "scan",
        requestDigest: "a".repeat(64),
        watcherId: "watcher",
        connectorVersion: "v1",
        mode: "normal",
        inventoryEpoch: 0,
        manifestVersionAtBegin: 0,
        actorUserId: f.userId,
        actorCredentialId: f.credentialId,
        state: "failed",
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
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        scanId,
        ordinal: 0,
        requestId: "page",
        requestDigest: "b".repeat(64),
        entryCount: 26,
        createdAt: 0,
        retireAt: 0,
      });
      const digest = "alias-digest";
      await ctx.db.insert("sourceAliasDigests", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        sourceItemId: target._id,
        kind: "uri",
        digest,
        firstSeenAt: 0,
        lastSeenAt: 0,
      });
      for (let index = 0; index < 25; index += 1)
        await ctx.db.insert("workerScanEntries", {
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
          scanId,
          scanPageId: pageId,
          sourceItemId: other._id,
          identityKeyHash: `linked-${index}`,
          uriDigest: digest,
          inventoryMetadataDigest: `meta-${index}`,
          sourceModifiedAt: 0,
          state: "unchanged",
          observedAt: 0,
          retireAt: 0,
        });
      const unresolvedId = await ctx.db.insert("workerScanEntries", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        scanId,
        scanPageId: pageId,
        identityKeyHash: "unresolved",
        uriDigest: digest,
        inventoryMetadataDigest: "meta-unresolved",
        sourceModifiedAt: 0,
        state: "needs_review",
        proposedUri: "fs://target/review",
        proposedTitle: "Target review candidate",
        observedAt: 0,
        retireAt: 0,
      });
      const unresolvedIdentityId = await ctx.db.insert("workerScanEntries", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        scanId,
        scanPageId: pageId,
        identityKeyHash: "unresolved-identity",
        externalIdHash: target.externalIdHash,
        uriDigest: "unaccepted-uri-digest",
        inventoryMetadataDigest: "meta-unresolved-identity",
        sourceModifiedAt: 0,
        state: "needs_review",
        proposedUri: "fs://target/unaccepted",
        proposedTitle: "Unaccepted identity candidate",
        observedAt: 0,
        retireAt: 0,
      });
      return {
        targetId: target._id,
        otherId: other._id,
        unresolvedId,
        unresolvedIdentityId,
        pageId,
      };
    });
    await f.t.run((ctx) =>
      beginForgetFromWeb(ctx, {
        principal: { userId: f.userId },
        sourceItemId: ids.targetId,
        now: 1,
      }),
    );
    const result = await f.t.run((ctx) =>
      continueForgetFromWeb(ctx, {
        principal: { userId: f.userId },
        sourceItemId: ids.targetId,
      }),
    );
    expect(result).toMatchObject({
      phase: "workerUnresolvedAliases",
      deleted: 1,
      done: false,
    });
    for (let index = 0; index < 20; index += 1) {
      const progress = await f.t.run((ctx) =>
        continueForgetFromWeb(ctx, {
          principal: { userId: f.userId },
          sourceItemId: ids.targetId,
        }),
      );
      if (progress.done) break;
    }
    await f.t.run(async (ctx) => {
      expect(await ctx.db.get(ids.unresolvedId)).toBeNull();
      expect(await ctx.db.get(ids.unresolvedIdentityId)).toBeNull();
      expect((await ctx.db.get(ids.targetId))?.lifecycle).toBe("forgotten");
      expect(await ctx.db.get(ids.otherId)).not.toBeNull();
      const page = await ctx.db.get(ids.pageId);
      expect(page?.requestDigest).toBeUndefined();
      expect(page?.redactedAt).toEqual(expect.any(Number));
      expect(
        (await ctx.db.query("workerScanEntries").collect()).filter(
          (row) => row.sourceItemId === ids.otherId,
        ),
      ).toHaveLength(25);
      expect(
        (await ctx.db.query("sourceAliasDigests").collect()).some(
          (row) => row.sourceItemId === ids.targetId,
        ),
      ).toBe(true);
    });
  });

  test("quarantines queued discovery work whose scan has failed", async () => {
    const f = await fixture();
    const source = {
      protocolVersion: 1 as const,
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
    };
    const beginRequest = parseWorkerRequest({
      ...source,
      operation: "scan.begin",
      requestId: "queued-work-begin",
      watcherId: "worker",
      connectorVersion: "v1",
      mode: "normal",
      expectedInventoryEpoch: 0,
    });
    if (beginRequest.operation !== "scan.begin") throw new Error("bad request");
    const scan = await f.t.run((ctx) =>
      beginWorkerScan(ctx, f.principal, beginRequest, 1),
    );
    const appendRequest = parseWorkerRequest({
      ...source,
      operation: "scan.appendPage",
      scanId: scan.scanId,
      requestId: "queued-work-page",
      ordinal: 0,
      entries: [
        {
          externalId: "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139",
          uri: "fs://synthetic/queued.txt",
          sourceModifiedAt: 1,
          content: { status: "ready", sha256: "c".repeat(64), byteLength: 7 },
        },
      ],
    });
    if (appendRequest.operation !== "scan.appendPage") {
      throw new Error("bad request");
    }
    await f.t.run((ctx) =>
      appendWorkerScanPage(ctx, f.principal, appendRequest, 2),
    );
    await f.t.run(async (ctx) => {
      const scanId = ctx.db.normalizeId("workerSourceScans", scan.scanId);
      if (!scanId) throw new Error("Invalid synthetic scan ID");
      await ctx.db.patch(scanId, {
        state: "failed",
        completedAt: 3,
        retireAt: 3,
      });
    });

    for (let index = 0; index < 19; index += 1) {
      await f.t.mutation(internal.models.workers.cleanup.removeExpired, {});
    }
    await f.t.run(async (ctx) => {
      const work = await ctx.db.query("workerDiscoveryWork").unique();
      expect(work).toMatchObject({ state: "needs_review" });
      expect(work?.leaseToken).toBeUndefined();
      expect(work?.leaseExpiresAt).toBeUndefined();
      expect(work?.nextAttemptAt).toBeUndefined();
    });

    await f.t.run(async (ctx) => {
      const work = await ctx.db.query("workerDiscoveryWork").unique();
      if (!work) throw new Error("Missing synthetic work");
      const entry = await ctx.db.get(work.scanEntryId);
      const scanId = ctx.db.normalizeId("workerSourceScans", scan.scanId);
      if (!entry || !scanId) throw new Error("Missing synthetic parent");
      await ctx.db.patch(scanId, { state: "enumerated" });
      await ctx.db.patch(entry._id, { discoveryWorkId: undefined });
      await ctx.db.patch(work._id, { state: "queued" });
    });
    for (let index = 0; index < 19; index += 1) {
      await f.t.mutation(internal.models.workers.cleanup.removeExpired, {});
    }
    await f.t.run(async (ctx) => {
      const work = await ctx.db.query("workerDiscoveryWork").unique();
      expect(work).toMatchObject({ state: "needs_review" });
    });
  });

  test("forget removes a real URI-alias and UUID conflict without removing B", async () => {
    const f = await fixture();
    const source = {
      protocolVersion: 1 as const,
      spaceId: f.spaceId,
      sourceAccountId: f.sourceAccountId,
    };
    const aId = "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c139";
    const bId = "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c140";
    const beginA = parseWorkerRequest({
      ...source,
      operation: "scan.begin",
      requestId: "alias-a-begin",
      watcherId: "worker",
      connectorVersion: "v1",
      mode: "normal",
      expectedInventoryEpoch: 0,
    });
    if (beginA.operation !== "scan.begin") throw new Error("bad request");
    const initialScan = await f.t.run((ctx) =>
      beginWorkerScan(ctx, f.principal, beginA, 1),
    );
    const initialPage = parseWorkerRequest({
      ...source,
      operation: "scan.appendPage",
      scanId: initialScan.scanId,
      requestId: "alias-a-page",
      ordinal: 0,
      entries: [
        {
          externalId: aId,
          uri: "fs://synthetic/a.txt",
          sourceModifiedAt: 1,
          content: { status: "ready", sha256: "a".repeat(64), byteLength: 7 },
        },
        {
          externalId: bId,
          uri: "fs://synthetic/b.txt",
          sourceModifiedAt: 1,
          content: { status: "ready", sha256: "b".repeat(64), byteLength: 7 },
        },
      ],
    });
    if (initialPage.operation !== "scan.appendPage") {
      throw new Error("bad request");
    }
    await f.t.run((ctx) =>
      appendWorkerScanPage(ctx, f.principal, initialPage, 2),
    );
    const seal = parseWorkerRequest({
      ...source,
      operation: "scan.seal",
      scanId: initialScan.scanId,
      requestId: "alias-a-seal",
      expectedPageCount: 1,
      health: { status: "failed", code: "unreadable" },
    });
    if (seal.operation !== "scan.seal") throw new Error("bad request");
    await f.t.run((ctx) => sealWorkerScan(ctx, f.principal, seal, 3));

    const beginConflict = parseWorkerRequest({
      ...source,
      operation: "scan.begin",
      requestId: "alias-conflict-begin",
      watcherId: "worker",
      connectorVersion: "v1",
      mode: "normal",
      expectedInventoryEpoch: 1,
    });
    if (beginConflict.operation !== "scan.begin") {
      throw new Error("bad request");
    }
    const conflictScan = await f.t.run((ctx) =>
      beginWorkerScan(ctx, f.principal, beginConflict, 4),
    );
    const conflictPage = parseWorkerRequest({
      ...source,
      operation: "scan.appendPage",
      scanId: conflictScan.scanId,
      requestId: "alias-conflict-page",
      ordinal: 0,
      entries: [
        {
          externalId: bId,
          uri: "fs://synthetic/a.txt",
          title: "B at A",
          sourceModifiedAt: 4,
          content: { status: "ready", sha256: "c".repeat(64), byteLength: 7 },
        },
      ],
    });
    if (conflictPage.operation !== "scan.appendPage") {
      throw new Error("bad request");
    }
    await f.t.run((ctx) =>
      appendWorkerScanPage(ctx, f.principal, conflictPage, 5),
    );
    const ids = await f.t.run(async (ctx) => {
      const items = await ctx.db.query("sourceItems").collect();
      const a = items.find((item) => item.externalId === aId);
      const b = items.find((item) => item.externalId === bId);
      const candidate = (
        await ctx.db.query("workerScanEntries").collect()
      ).find((entry) => entry.issueCode === "uri_alias_identity_conflict");
      const page = await ctx.db
        .query("workerScanPages")
        .withIndex("by_scanId_and_ordinal", (q) =>
          q
            .eq(
              "scanId",
              ctx.db.normalizeId("workerSourceScans", conflictScan.scanId)!,
            )
            .eq("ordinal", 0),
        )
        .unique();
      if (!a || !b || !candidate || !page)
        throw new Error("Missing conflict fixture");
      expect(candidate).toMatchObject({
        state: "needs_review",
        sourceItemId: b._id,
        proposedUri: "fs://synthetic/a.txt",
      });
      return {
        aId: a._id,
        bId: b._id,
        candidateId: candidate._id,
        pageId: page._id,
      };
    });
    await f.t.run((ctx) =>
      beginForgetFromWeb(ctx, {
        principal: { userId: f.userId },
        sourceItemId: ids.aId,
        now: 6,
      }),
    );
    const progress = [];
    for (let index = 0; index < 20; index += 1) {
      const result = await f.t.run((ctx) =>
        continueForgetFromWeb(ctx, {
          principal: { userId: f.userId },
          sourceItemId: ids.aId,
        }),
      );
      progress.push(result);
      if (result.done) break;
    }
    expect(progress).toContainEqual(
      expect.objectContaining({ phase: "workerAmbiguousAliases", deleted: 1 }),
    );
    await f.t.run(async (ctx) => {
      expect(await ctx.db.get(ids.candidateId)).toBeNull();
      expect((await ctx.db.get(ids.bId))?.lifecycle).toBe("available");
      expect(
        (await ctx.db.query("workerScanEntries").collect()).some(
          (entry) =>
            entry.sourceItemId === ids.bId && entry.state !== "needs_review",
        ),
      ).toBe(true);
      const page = await ctx.db.get(ids.pageId);
      expect(page?.requestDigest).toBeUndefined();
      expect(page?.redactedAt).toEqual(expect.any(Number));
    });
  });
});

describe("worker reservation receipt retention", () => {
  test("forget invalidates a mixed receipt without deleting another item's target", async () => {
    const f = await fixture();
    const ids = await f.t.run(async (ctx) => {
      const a = await createOrGetSourceItem(ctx, {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        externalId: "receipt-a",
        uri: "fs://synthetic/a.txt",
      });
      const b = await createOrGetSourceItem(ctx, {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        externalId: "receipt-b",
        uri: "fs://synthetic/b.txt",
      });
      const receiptId = await ctx.db.insert("workerReservationReceipts", {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        kind: "discovery",
        requestId: "shared-reservation",
        targetCount: 2,
        requestDigest: "a".repeat(64),
        actorUserId: f.userId,
        actorCredentialId: f.credentialId,
        createdAt: 0,
        expiresAt: 4_102_444_800_000,
        retireAt: 4_102_444_800_000,
      });
      const targetIds = [];
      for (const [ordinal, item] of [a, b].entries()) {
        targetIds.push(
          await ctx.db.insert("workerReservationTargets", {
            spaceId: f.spaceId,
            sourceAccountId: f.sourceAccountId,
            sourceItemId: item._id,
            receiptId,
            ordinal,
            leaseEpoch: 1,
            leaseToken: String(ordinal).repeat(64),
            leaseExpiresAt: 4_102_444_800_000,
          }),
        );
      }
      return { a: a._id, b: b._id, receiptId, targetIds };
    });
    await f.t.run((ctx) =>
      beginForgetFromWeb(ctx, {
        principal: { userId: f.userId },
        sourceItemId: ids.a,
        now: 1,
      }),
    );
    const first = await f.t.run((ctx) =>
      continueForgetFromWeb(ctx, {
        principal: { userId: f.userId },
        sourceItemId: ids.a,
      }),
    );
    expect(first).toMatchObject({
      phase: "workerReservationTargets",
      deleted: 1,
      done: false,
    });
    for (let i = 0; i < 20; i++) {
      const result = await f.t.run((ctx) =>
        continueForgetFromWeb(ctx, {
          principal: { userId: f.userId },
          sourceItemId: ids.a,
        }),
      );
      if (result.done) break;
    }
    await f.t.run(async (ctx) => {
      expect(await ctx.db.get(ids.a)).toMatchObject({ lifecycle: "forgotten" });
      expect(await ctx.db.get(ids.b)).toMatchObject({ lifecycle: "available" });
      expect(await ctx.db.get(ids.targetIds[0]!)).toBeNull();
      expect(await ctx.db.get(ids.targetIds[1]!)).toMatchObject({
        leaseEpoch: 1,
        leaseToken: "1".repeat(64),
      });
      expect(await ctx.db.get(ids.receiptId)).toMatchObject({
        invalidatedAt: expect.any(Number),
      });
    });
  });

  test("receipt cleanup passes a pinned prefix and preserves unexpired targets", async () => {
    const f = await fixture();
    const tailId = await f.t.run(async (ctx) => {
      const item = await createOrGetSourceItem(ctx, {
        spaceId: f.spaceId,
        sourceAccountId: f.sourceAccountId,
        externalId: "receipt-retention",
        uri: "fs://synthetic/retention.txt",
      });
      let lastId;
      for (let i = 0; i < 26; i++) {
        lastId = await ctx.db.insert("workerReservationReceipts", {
          spaceId: f.spaceId,
          sourceAccountId: f.sourceAccountId,
          kind: "discovery",
          requestId: `reservation-${i}`,
          targetCount: i < 25 ? 1 : 0,
          requestDigest: "a".repeat(64),
          actorUserId: f.userId,
          actorCredentialId: f.credentialId,
          createdAt: 0,
          expiresAt: 0,
          retireAt: i,
        });
        if (i < 25)
          await ctx.db.insert("workerReservationTargets", {
            spaceId: f.spaceId,
            sourceAccountId: f.sourceAccountId,
            sourceItemId: item._id,
            receiptId: lastId,
            ordinal: 0,
            leaseEpoch: 1,
            leaseToken: "a".repeat(64),
            leaseExpiresAt: 4_102_444_800_000,
          });
      }
      return lastId!;
    });
    for (let i = 0; i < 19; i++) {
      const result = await f.t.mutation(
        internal.models.workers.cleanup.removeExpired,
        {},
      );
      expect(result.inspected).toBeLessThanOrEqual(25);
    }
    await f.t.run(async (ctx) => {
      expect(await ctx.db.get(tailId)).not.toBeNull();
    });
    for (let i = 0; i < 19; i++) {
      const result = await f.t.mutation(
        internal.models.workers.cleanup.removeExpired,
        {},
      );
      expect(result.inspected).toBeLessThanOrEqual(25);
    }
    await f.t.run(async (ctx) => {
      expect(await ctx.db.get(tailId)).toBeNull();
      expect(
        await ctx.db.query("workerReservationTargets").collect(),
      ).toHaveLength(25);
      expect(
        await ctx.db.query("workerReservationReceipts").collect(),
      ).toHaveLength(25);
    });
  });
});

test("rate window cleanup preserves current limits and removes expired key state", async () => {
  const f = await fixture();
  const ids = await f.t.run(async (ctx) => {
    const retiredCredentialId = await ctx.db.insert("apiKeys", {
      userId: f.userId,
      keyHash: "b".repeat(64),
      keyPrefix: "retired",
      name: "Retired worker",
      capabilities: ["ingest"],
      spaceIds: [f.spaceId],
      sourceAccountIds: [f.sourceAccountId],
    });
    const expired = await ctx.db.insert("workerProtocolRateLimits", {
      credentialId: retiredCredentialId,
      sourceAccountId: f.sourceAccountId,
      windowStartedAt: 0,
      count: 60,
    });
    const live = await ctx.db.insert("workerProtocolRateLimits", {
      credentialId: f.credentialId,
      sourceAccountId: f.sourceAccountId,
      windowStartedAt: Date.now(),
      count: 60,
    });
    await ctx.db.delete(retiredCredentialId);
    return { expired, live };
  });
  for (let i = 0; i < 19; i++)
    await f.t.mutation(internal.models.workers.cleanup.removeExpired, {});
  await f.t.run(async (ctx) => {
    expect(await ctx.db.get(ids.expired)).toBeNull();
    expect(await ctx.db.get(ids.live)).toMatchObject({ count: 60 });
  });
});
