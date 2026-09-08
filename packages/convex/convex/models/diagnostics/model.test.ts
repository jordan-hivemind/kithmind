import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api } from "../../_generated/api";
import schema from "../../schema";
import { modules } from "../../test.setup";
import {
  diagnosticsSummary,
  recordWorkerHeartbeat,
  resetWorkerWatcher,
  sweepMissingWorkerHeartbeats,
  WORKER_HEARTBEAT_OVERDUE_MS,
  WORKER_HEARTBEAT_SWEEP_LIMIT,
} from "./model";

const WATCHER_A = "01890a5d-ac96-7cc4-8b7e-6f4f5ca5c139";
const WATCHER_B = "01890a5d-ac96-7cc4-9b7e-6f4f5ca5c140";
const WATCHER_C = "01890a5d-ac96-7cc4-ab7e-6f4f5ca5c141";
const REQUEST_A = "01890a5d-ac96-7cc4-bb7e-6f4f5ca5c142";
const REQUEST_B = "01890a5d-ac96-7cc4-8b7e-6f4f5ca5c143";

async function fixture() {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert("users", { name: "Synthetic owner" });
    const editorId = await ctx.db.insert("users", {
      name: "Synthetic editor",
    });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "shared",
      name: "Synthetic operations",
      createdBy: ownerId,
    });
    await ctx.db.insert("spaceMembers", {
      spaceId,
      userId: ownerId,
      role: "owner",
    });
    await ctx.db.insert("spaceMembers", {
      spaceId,
      userId: editorId,
      role: "editor",
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "fs",
      accountId: "synthetic-source",
      name: "Synthetic source",
      enabled: true,
      cursorVersion: 0,
      freshnessMs: 86_400_000,
      createdBy: ownerId,
    });
    const credentialId = await ctx.db.insert("apiKeys", {
      userId: ownerId,
      keyHash: "synthetic-heartbeat-key",
      keyPrefix: "ob_heart",
      name: "Synthetic heartbeat",
      capabilities: ["ingest"],
      spaceIds: [spaceId],
      sourceAccountIds: [sourceAccountId],
    });
    return {
      ownerId,
      editorId,
      spaceId,
      sourceAccountId,
      credentialId,
    };
  });
  const principal = {
    userId: seeded.ownerId,
    credentialId: seeded.credentialId,
  };
  const base = {
    protocolVersion: 1 as const,
    spaceId: seeded.spaceId,
    sourceAccountId: seeded.sourceAccountId,
  };
  return { t, ...seeded, principal, base };
}

function heartbeatRequest(
  base: Awaited<ReturnType<typeof fixture>>["base"],
  watcherId = WATCHER_A,
) {
  return {
    ...base,
    operation: "diagnostics.heartbeat" as const,
    watcherId,
    connectorVersion: "pipeline-1.0.0",
  };
}

describe("worker heartbeat diagnostics", () => {
  test("records liveness, coalesces rapid writes, opens one incident and resolves it", async () => {
    const f = await fixture();
    const initial = await f.t.run(async (ctx) => {
      const account = (await ctx.db.get(f.sourceAccountId))!;
      return await diagnosticsSummary(ctx, account, 1_000);
    });
    expect(initial).toMatchObject({
      watcher: { state: "not_configured" },
      incident: { state: "none" },
    });

    const first = await f.t.run((ctx) =>
      recordWorkerHeartbeat(ctx, f.principal, heartbeatRequest(f.base), 1_000),
    );
    expect(first).toEqual({
      operation: "diagnostics.heartbeat",
      sourceAccountId: f.sourceAccountId,
      watcherId: WATCHER_A,
      receivedAt: 1_000,
      nextExpectedAt: 1_000 + WORKER_HEARTBEAT_OVERDUE_MS,
    });

    const coalesced = await f.t.run((ctx) =>
      recordWorkerHeartbeat(ctx, f.principal, heartbeatRequest(f.base), 2_000),
    );
    expect(coalesced).toEqual(first);
    expect(
      await f.t.run((ctx) => ctx.db.query("workerWatcherStates").collect()),
    ).toHaveLength(1);

    const swept = await f.t.run((ctx) =>
      sweepMissingWorkerHeartbeats(ctx, 1_000 + WORKER_HEARTBEAT_OVERDUE_MS),
    );
    expect(swept).toEqual({ inspected: 1, opened: 1, observed: 0 });
    const overdue = await f.t.run(async (ctx) => {
      const account = (await ctx.db.get(f.sourceAccountId))!;
      return await diagnosticsSummary(
        ctx,
        account,
        1_000 + WORKER_HEARTBEAT_OVERDUE_MS,
      );
    });
    expect(overdue).toMatchObject({
      watcher: { state: "overdue", watcherId: WATCHER_A },
      incident: { state: "open", kind: "missing_worker" },
    });

    await f.t.run((ctx) =>
      recordWorkerHeartbeat(
        ctx,
        f.principal,
        heartbeatRequest(f.base),
        200_000,
      ),
    );
    const rows = await f.t.run(async (ctx) => ({
      watcher: await ctx.db.query("workerWatcherStates").unique(),
      incidents: await ctx.db.query("workerOperationalIncidents").collect(),
    }));
    expect(rows.watcher).toMatchObject({ lastSeenAt: 200_000 });
    expect(rows.incidents).toEqual([
      expect.objectContaining({ state: "resolved", resolvedAt: 200_000 }),
    ]);
  });

  test("rejects a competing watcher and does not share the ingestion mutation budget", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("workerProtocolRateLimits", {
        credentialId: f.credentialId,
        sourceAccountId: f.sourceAccountId,
        windowStartedAt: 1_000,
        count: 60,
      });
      await recordWorkerHeartbeat(
        ctx,
        f.principal,
        heartbeatRequest(f.base),
        2_000,
      );
    });
    await expect(
      f.t.run((ctx) =>
        recordWorkerHeartbeat(
          ctx,
          f.principal,
          heartbeatRequest(f.base, WATCHER_B),
          10_000,
        ),
      ),
    ).rejects.toMatchObject({
      data: { code: "identity_review_required" },
    });
    const rows = await f.t.run((ctx) =>
      ctx.db.query("workerWatcherStates").collect(),
    );
    expect(rows).toEqual([
      expect.objectContaining({ watcherId: WATCHER_A, lastSeenAt: 2_000 }),
    ]);
  });

  test("serializes concurrent first claims and same-watcher advances", async () => {
    const f = await fixture();
    const claims = await Promise.allSettled([
      f.t.run((ctx) =>
        recordWorkerHeartbeat(
          ctx,
          f.principal,
          heartbeatRequest(f.base, WATCHER_A),
          10_000,
        ),
      ),
      f.t.run((ctx) =>
        recordWorkerHeartbeat(
          ctx,
          f.principal,
          heartbeatRequest(f.base, WATCHER_B),
          10_000,
        ),
      ),
    ]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(
      1,
    );
    const claimed = await f.t.run((ctx) =>
      ctx.db.query("workerWatcherStates").unique(),
    );
    if (!claimed) throw new Error("expected a claimed watcher");

    await Promise.all([
      f.t.run((ctx) =>
        recordWorkerHeartbeat(
          ctx,
          f.principal,
          heartbeatRequest(f.base, claimed.watcherId),
          20_000,
        ),
      ),
      f.t.run((ctx) =>
        recordWorkerHeartbeat(
          ctx,
          f.principal,
          heartbeatRequest(f.base, claimed.watcherId),
          30_000,
        ),
      ),
    ]);
    expect(
      await f.t.run((ctx) => ctx.db.query("workerWatcherStates").unique()),
    ).toMatchObject({ lastSeenAt: 30_000 });
  });

  test("reloads exact source grants before every heartbeat write", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.delete(f.credentialId));
    await expect(
      f.t.run((ctx) =>
        recordWorkerHeartbeat(
          ctx,
          f.principal,
          heartbeatRequest(f.base),
          1_000,
        ),
      ),
    ).rejects.toMatchObject({ data: { code: "not_authorized" } });
    expect(
      await f.t.run((ctx) => ctx.db.query("workerWatcherStates").collect()),
    ).toEqual([]);
  });

  test("bounds each sweep and advances past a due prefix", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      for (let index = 0; index <= WORKER_HEARTBEAT_SWEEP_LIMIT; index += 1) {
        const sourceAccountId = await ctx.db.insert("sourceAccounts", {
          spaceId: f.spaceId,
          connector: "fs",
          accountId: `source-${index}`,
          name: `Source ${index}`,
          enabled: true,
          cursorVersion: 0,
          freshnessMs: 86_400_000,
          createdBy: f.ownerId,
        });
        await ctx.db.insert("workerWatcherStates", {
          spaceId: f.spaceId,
          sourceAccountId,
          watcherId: `01890a5d-ac96-7cc4-8b7e-${String(index).padStart(12, "0")}`,
          state: "active",
          connectorVersion: "pipeline-1",
          actorUserId: f.ownerId,
          actorCredentialId: f.credentialId,
          lastSeenAt: 1,
          nextExpectedAt: 1 + WORKER_HEARTBEAT_OVERDUE_MS,
          sweepAfter: 1 + WORKER_HEARTBEAT_OVERDUE_MS,
          createdAt: 1,
          updatedAt: 1,
        });
      }
    });
    expect(
      await f.t.run((ctx) =>
        sweepMissingWorkerHeartbeats(ctx, WORKER_HEARTBEAT_OVERDUE_MS + 1),
      ),
    ).toEqual({ inspected: 100, opened: 100, observed: 0 });
    expect(
      await f.t.run((ctx) =>
        sweepMissingWorkerHeartbeats(ctx, WORKER_HEARTBEAT_OVERDUE_MS + 1),
      ),
    ).toEqual({ inspected: 1, opened: 1, observed: 0 });
  });

  test("heartbeat and overdue sweep converge without a current open incident", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      recordWorkerHeartbeat(ctx, f.principal, heartbeatRequest(f.base), 1_000),
    );
    const deadline = 1_000 + WORKER_HEARTBEAT_OVERDUE_MS;
    await Promise.all([
      f.t.run((ctx) => sweepMissingWorkerHeartbeats(ctx, deadline)),
      f.t.run((ctx) =>
        recordWorkerHeartbeat(
          ctx,
          f.principal,
          heartbeatRequest(f.base),
          deadline,
        ),
      ),
    ]);
    const status = await f.t.run(async (ctx) =>
      diagnosticsSummary(ctx, (await ctx.db.get(f.sourceAccountId))!, deadline),
    );
    expect(status).toMatchObject({
      watcher: { state: "current" },
      incident: { state: "none" },
    });
  });
});

describe("owner watcher operations", () => {
  test("prebinds an awaiting watcher and makes exact replay observational", async () => {
    const f = await fixture();
    const account = await f.t.run((ctx) => ctx.db.get(f.sourceAccountId));
    if (!account) throw new Error("missing fixture source");
    const first = await f.t.run((ctx) =>
      resetWorkerWatcher(
        ctx,
        account,
        f.ownerId,
        {
          sourceAccountId: f.sourceAccountId,
          requestId: REQUEST_A,
          expectedWatcherId: null,
          nextWatcherId: WATCHER_B,
        },
        1_000,
      ),
    );
    expect(first).toMatchObject({ watcherId: WATCHER_B, reused: false });
    const awaiting = await f.t.run(async (ctx) =>
      diagnosticsSummary(ctx, (await ctx.db.get(f.sourceAccountId))!, 1_001),
    );
    expect(awaiting).toMatchObject({
      watcher: { state: "awaiting_heartbeat", watcherId: WATCHER_B },
      incident: { state: "none" },
    });
    const replay = await f.t.run((ctx) =>
      resetWorkerWatcher(
        ctx,
        account,
        f.ownerId,
        {
          sourceAccountId: f.sourceAccountId,
          requestId: REQUEST_A,
          expectedWatcherId: null,
          nextWatcherId: WATCHER_B,
        },
        2_000,
      ),
    );
    expect(replay).toEqual({ ...first, reused: true });

    await f.t.run((ctx) =>
      resetWorkerWatcher(
        ctx,
        account,
        f.ownerId,
        {
          sourceAccountId: f.sourceAccountId,
          requestId: REQUEST_B,
          expectedWatcherId: WATCHER_B,
          nextWatcherId: WATCHER_C,
        },
        3_000,
      ),
    );
    await expect(
      f.t.run((ctx) =>
        resetWorkerWatcher(
          ctx,
          account,
          f.ownerId,
          {
            sourceAccountId: f.sourceAccountId,
            requestId: REQUEST_A,
            expectedWatcherId: null,
            nextWatcherId: WATCHER_B,
          },
          4_000,
        ),
      ),
    ).rejects.toMatchObject({ data: { code: "request_conflict" } });
  });

  test("requires an owner and preserves disabled state across sweeps and re-enable", async () => {
    const f = await fixture();
    const owner = f.t.withIdentity({
      issuer: "https://synthetic.example/convex",
      subject: f.ownerId,
    });
    const editor = f.t.withIdentity({
      issuer: "https://synthetic.example/convex",
      subject: f.editorId,
    });
    const diagnosticsApi = api.models.diagnostics.public;
    await expect(
      editor.mutation(diagnosticsApi.resetWatcher, {
        sourceAccountId: f.sourceAccountId,
        requestId: REQUEST_A,
        expectedWatcherId: null,
        nextWatcherId: WATCHER_A,
      }),
    ).rejects.toMatchObject({ data: { code: "owner_required" } });

    await f.t.run((ctx) =>
      recordWorkerHeartbeat(ctx, f.principal, heartbeatRequest(f.base), 1_000),
    );
    await f.t.run((ctx) => sweepMissingWorkerHeartbeats(ctx, 181_000));
    await owner.mutation(api.models.sourceAccounts.public.update, {
      sourceAccountId: f.sourceAccountId,
      enabled: false,
    });
    const disabled = await owner.query(diagnosticsApi.status, {
      sourceAccountId: f.sourceAccountId,
    });
    expect(disabled).toMatchObject({
      source: "disabled",
      incident: { state: "none" },
    });
    expect(
      await f.t.run((ctx) => sweepMissingWorkerHeartbeats(ctx, 300_000)),
    ).toEqual({ inspected: 0, opened: 0, observed: 0 });
    await owner.mutation(api.models.sourceAccounts.public.update, {
      sourceAccountId: f.sourceAccountId,
      enabled: true,
    });
    expect(
      await f.t.run((ctx) => sweepMissingWorkerHeartbeats(ctx, Date.now())),
    ).toMatchObject({
      inspected: 1,
      opened: 1,
    });
    await f.t.run((ctx) =>
      recordWorkerHeartbeat(
        ctx,
        f.principal,
        heartbeatRequest(f.base),
        Date.now() + 1,
      ),
    );
    const current = await owner.query(diagnosticsApi.status, {
      sourceAccountId: f.sourceAccountId,
    });
    expect(current).toMatchObject({
      source: "enabled",
      watcher: { state: "current" },
      incident: { state: "none" },
    });
  });
});
