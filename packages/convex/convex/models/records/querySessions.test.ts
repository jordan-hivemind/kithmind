import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import type { Id } from "../../_generated/dataModel";
import schema from "../../legacySchema";
import { modules } from "../../test.setup";
import {
  advanceRecordQuerySession,
  beginRecordQuerySnapshot,
  createRecordQuerySession,
  getRecordQueryEpochs,
  invalidateRecordQueriesForForget,
  nextRecordActivationTime,
  purgeRecordQuerySessionsForSpaceBatch,
} from "./querySessions";

async function seedScope() {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Synthetic owner" });
    const spaceId = await ctx.db.insert("spaces", {
      kind: "personal",
      name: "Synthetic records",
      createdBy: userId,
    });
    const membershipId = await ctx.db.insert("spaceMembers", {
      spaceId,
      userId,
      role: "owner",
    });
    const sourceAccountId = await ctx.db.insert("sourceAccounts", {
      spaceId,
      connector: "synthetic",
      accountId: "query-session",
      name: "Synthetic query source",
      enabled: true,
      cursorVersion: 1,
      freshnessMs: 60_000,
      createdBy: userId,
    });
    return { userId, spaceId, membershipId, sourceAccountId };
  });
  return { t, ...seeded };
}

function sessionArgs(seeded: {
  userId: Id<"users">;
  spaceId: Id<"spaces">;
  membershipId: Id<"spaceMembers">;
  sourceAccountId: Id<"sourceAccounts">;
}) {
  return {
    spaceId: seeded.spaceId,
    userId: seeded.userId,
    membershipId: seeded.membershipId,
    authorizationSignature: "synthetic-auth-signature",
    operation: "sum_money" as const,
    consistency: "snapshot" as const,
    normalizedFilter: '{"operation":"sum_money"}',
    sourceAccountIds: [seeded.sourceAccountId],
    snapshotAt: 100,
    activationEpoch: 0,
    visibilityEpoch: 0,
    lastTuple: {
      occurrenceDate: "2026-01-01",
      occurrencePrecision: "date" as const,
      sortKey: "2026-01-01|0|synthetic-stable-id",
      stableId: "synthetic-stable-id",
    },
    totals: [{ currency: "USD", amount: "1.25" }],
    invalidRows: 0,
    ambiguousTimeRows: 0,
    unsupportedValueRows: 0,
    readOverflow: false,
    processedRows: 1,
    now: 100,
  };
}

describe("record query sessions", () => {
  test("reserves a boundary strictly before a later same-clock activation", async () => {
    const seeded = await seedScope();
    const snapshot = await seeded.t.run((ctx) =>
      beginRecordQuerySnapshot(ctx, seeded.spaceId, 100),
    );
    expect(snapshot.snapshotAt).toBe(100);
    const repeated = await seeded.t.run((ctx) =>
      beginRecordQuerySnapshot(ctx, seeded.spaceId, 100),
    );
    expect(repeated.snapshotAt).toBe(100);
    const activatedAt = await seeded.t.run((ctx) =>
      nextRecordActivationTime(ctx, {
        spaceId: seeded.spaceId,
        now: 100,
      }),
    );
    expect(activatedAt).toBe(101);
  });

  test("forget invalidates old sessions and bounded purge preserves new ones", async () => {
    const seeded = await seedScope();
    const oldSession = await seeded.t.run((ctx) =>
      createRecordQuerySession(ctx, sessionArgs(seeded)),
    );
    await seeded.t.run((ctx) =>
      invalidateRecordQueriesForForget(ctx, {
        spaceId: seeded.spaceId,
        now: 200,
      }),
    );
    const epochs = await seeded.t.run((ctx) =>
      getRecordQueryEpochs(ctx, seeded.spaceId, 201),
    );
    const newSession = await seeded.t.run((ctx) =>
      createRecordQuerySession(ctx, {
        ...sessionArgs(seeded),
        visibilityEpoch: epochs.visibilityEpoch,
        snapshotAt: epochs.snapshotAt,
        now: 201,
      }),
    );
    const cleanup = await seeded.t.run((ctx) =>
      purgeRecordQuerySessionsForSpaceBatch(ctx, {
        spaceId: seeded.spaceId,
        limit: 25,
      }),
    );
    expect(cleanup).toEqual({ deleted: 1, done: true });
    await seeded.t.run(async (ctx) => {
      expect(await ctx.db.get(oldSession)).toBeNull();
      expect(await ctx.db.get(newSession)).not.toBeNull();
    });
  });

  test("advancing uses a new cursor and keeps the absolute expiry", async () => {
    const seeded = await seedScope();
    const firstId = await seeded.t.run((ctx) =>
      createRecordQuerySession(ctx, sessionArgs(seeded)),
    );
    const first = await seeded.t.run((ctx) => ctx.db.get(firstId));
    expect(first).not.toBeNull();
    const secondId = await seeded.t.run((ctx) =>
      advanceRecordQuerySession(ctx, first!, {
        lastTuple: {
          occurrenceDate: "2026-01-02",
          occurrencePrecision: "datetime",
          occurrenceInstant: 101,
          sortKey: "2026-01-02|1|101|next-stable-id",
          stableId: "next-stable-id",
        },
        totals: [{ currency: "USD", amount: "3.50" }],
        invalidRows: 0,
        ambiguousTimeRows: 0,
        unsupportedValueRows: 0,
        readOverflow: false,
        processedRows: 2,
        now: 150,
      }),
    );
    await seeded.t.run(async (ctx) => {
      expect(await ctx.db.get(firstId)).toBeNull();
      const second = await ctx.db.get(secondId);
      expect(second?.expiresAt).toBe(first?.expiresAt);
      expect(second?.createdAt).toBe(first?.createdAt);
    });
  });
});
