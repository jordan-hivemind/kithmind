import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

export const RECORD_QUERY_SESSION_TTL_MS = 15 * 60 * 1_000;
export const MAX_ACTIVE_RECORD_QUERY_SESSIONS = 16;
export const MAX_QUERY_SESSION_CLEANUP_ROWS = 64;

type RecordQueryOperation = "observation_history" | "list_events" | "sum_money";

type RecordQueryConsistency = "snapshot" | "current";

export type RecordQueryCursorTuple = {
  occurrenceDate: string;
  occurrencePrecision: "date" | "datetime";
  occurrenceInstant?: number;
  sortKey: string;
  stableId: string;
};

export type CurrencyTotal = { currency: string; amount: string };

function requireFinite(value: number, name: string) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

function requireSafeClock(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
}

function requireNonnegativeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
}

async function getUniqueQuerySpaceState(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
) {
  const rows = await ctx.db
    .query("recordQuerySpaceState")
    .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
    .take(2);
  if (rows.length > 1) throw new Error("Duplicate record query space state");
  return rows[0];
}

async function getUniqueProcessingState(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
) {
  const rows = await ctx.db
    .query("spaceProcessingState")
    .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
    .take(2);
  if (rows.length > 1) throw new Error("Duplicate space processing state");
  return rows[0];
}

export async function getRecordQueryEpochs(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
  now: number,
) {
  requireSafeClock(now, "now");
  const [queryState, processingState] = await Promise.all([
    getUniqueQuerySpaceState(ctx, spaceId),
    getUniqueProcessingState(ctx, spaceId),
  ]);
  return {
    visibilityEpoch: queryState?.visibilityEpoch ?? 0,
    activationEpoch: processingState?.activationEpoch ?? 0,
    snapshotAt: Math.max(
      now,
      processingState?.activatedAt ?? now,
      queryState?.snapshotClock ?? now,
    ),
  };
}

/**
 * Reserves a snapshot boundary. Activation must use
 * `nextRecordActivationTime` so a later publication cannot share it.
 */
export async function beginRecordQuerySnapshot(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
  now: number,
) {
  const epochs = await getRecordQueryEpochs(ctx, spaceId, now);
  const state = await getUniqueQuerySpaceState(ctx, spaceId);
  if (state) {
    if (state.snapshotClock !== epochs.snapshotAt) {
      await ctx.db.patch(state._id, {
        snapshotClock: epochs.snapshotAt,
        updatedAt: now,
      });
    }
  } else {
    await ctx.db.insert("recordQuerySpaceState", {
      spaceId,
      visibilityEpoch: 0,
      snapshotClock: epochs.snapshotAt,
      updatedAt: now,
    });
  }
  return epochs;
}

/** Returns a publication time strictly after every reserved query snapshot. */
export async function nextRecordActivationTime(
  ctx: MutationCtx,
  args: {
    spaceId: Id<"spaces">;
    now: number;
    previousActivatedAt?: number;
  },
) {
  requireSafeClock(args.now, "now");
  if (args.previousActivatedAt !== undefined) {
    requireSafeClock(args.previousActivatedAt, "previousActivatedAt");
  }
  const state = await getUniqueQuerySpaceState(ctx, args.spaceId);
  const activatedAt = Math.max(
    args.now,
    (args.previousActivatedAt ?? args.now - 1) + 1,
    (state?.snapshotClock ?? args.now - 1) + 1,
  );
  requireSafeClock(activatedAt, "activatedAt");
  return activatedAt;
}

/**
 * Bumps the separate visibility epoch before forget cleanup. Existing exact
 * accumulators become unusable in the same transaction even if their rows
 * require later bounded cleanup.
 */
export async function invalidateRecordQueriesForForget(
  ctx: MutationCtx,
  args: { spaceId: Id<"spaces">; now: number },
) {
  requireFinite(args.now, "now");
  if (!(await ctx.db.get(args.spaceId))) throw new Error("Space not found");
  const state = await getUniqueQuerySpaceState(ctx, args.spaceId);
  const visibilityEpoch = (state?.visibilityEpoch ?? 0) + 1;
  if (!Number.isSafeInteger(visibilityEpoch)) {
    throw new Error("Record query visibility epoch exhausted");
  }
  if (state) {
    await ctx.db.patch(state._id, { visibilityEpoch, updatedAt: args.now });
  } else {
    await ctx.db.insert("recordQuerySpaceState", {
      spaceId: args.spaceId,
      visibilityEpoch,
      snapshotClock: args.now,
      updatedAt: args.now,
    });
  }
  return { visibilityEpoch };
}

/** Deletes one bounded page of all query sessions in a forgotten space. */
export async function purgeRecordQuerySessionsForSpaceBatch(
  ctx: MutationCtx,
  args: { spaceId: Id<"spaces">; limit?: number },
) {
  const limit = Math.min(
    args.limit ?? MAX_QUERY_SESSION_CLEANUP_ROWS,
    MAX_QUERY_SESSION_CLEANUP_ROWS,
  );
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Query session cleanup limit is invalid");
  }
  const state = await getUniqueQuerySpaceState(ctx, args.spaceId);
  if (!state || state.visibilityEpoch === 0) {
    return { deleted: 0, done: true };
  }
  const rows = await ctx.db
    .query("recordQuerySessions")
    .withIndex("by_space_visibility_expires", (q) =>
      q
        .eq("spaceId", args.spaceId)
        .lt("visibilityEpoch", state.visibilityEpoch),
    )
    .take(limit + 1);
  for (const row of rows.slice(0, limit)) await ctx.db.delete(row._id);
  return { deleted: Math.min(rows.length, limit), done: rows.length <= limit };
}

export async function deleteExpiredRecordQuerySessions(
  ctx: MutationCtx,
  args: { userId: Id<"users">; spaceId: Id<"spaces">; now: number },
) {
  requireFinite(args.now, "now");
  const rows = await ctx.db
    .query("recordQuerySessions")
    .withIndex("by_user_space_expires", (q) =>
      q
        .eq("userId", args.userId)
        .eq("spaceId", args.spaceId)
        .lte("expiresAt", args.now),
    )
    .take(MAX_QUERY_SESSION_CLEANUP_ROWS);
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

export async function createRecordQuerySession(
  ctx: MutationCtx,
  args: {
    spaceId: Id<"spaces">;
    userId: Id<"users">;
    credentialId?: Id<"apiKeys">;
    membershipId: Id<"spaceMembers">;
    authorizationSignature: string;
    operation: RecordQueryOperation;
    consistency: RecordQueryConsistency;
    normalizedFilter: string;
    sourceAccountIds: Id<"sourceAccounts">[];
    snapshotAt: number;
    activationEpoch: number;
    visibilityEpoch: number;
    lastTuple: RecordQueryCursorTuple;
    totals: CurrencyTotal[];
    invalidRows: number;
    ambiguousTimeRows: number;
    unsupportedValueRows: number;
    readOverflow: boolean;
    processedRows: number;
    now: number;
  },
): Promise<Id<"recordQuerySessions">> {
  requireFinite(args.now, "now");
  requireFinite(args.snapshotAt, "snapshotAt");
  requireNonnegativeInteger(args.activationEpoch, "activationEpoch");
  requireNonnegativeInteger(args.visibilityEpoch, "visibilityEpoch");
  requireNonnegativeInteger(args.processedRows, "processedRows");
  requireNonnegativeInteger(args.invalidRows, "invalidRows");
  requireNonnegativeInteger(args.ambiguousTimeRows, "ambiguousTimeRows");
  requireNonnegativeInteger(args.unsupportedValueRows, "unsupportedValueRows");
  await deleteExpiredRecordQuerySessions(ctx, args);
  const active = await ctx.db
    .query("recordQuerySessions")
    .withIndex("by_user_space_expires", (q) =>
      q.eq("userId", args.userId).eq("spaceId", args.spaceId),
    )
    .filter((q) => q.gt(q.field("expiresAt"), args.now))
    .take(MAX_ACTIVE_RECORD_QUERY_SESSIONS + 1);
  if (active.length >= MAX_ACTIVE_RECORD_QUERY_SESSIONS) {
    throw new Error("Too many active record query sessions");
  }
  const expiresAt = args.now + RECORD_QUERY_SESSION_TTL_MS;
  return await ctx.db.insert("recordQuerySessions", {
    spaceId: args.spaceId,
    userId: args.userId,
    ...(args.credentialId ? { credentialId: args.credentialId } : {}),
    membershipId: args.membershipId,
    authorizationSignature: args.authorizationSignature,
    operation: args.operation,
    consistency: args.consistency,
    normalizedFilter: args.normalizedFilter,
    sourceAccountIds: args.sourceAccountIds,
    snapshotAt: args.snapshotAt,
    activationEpoch: args.activationEpoch,
    visibilityEpoch: args.visibilityEpoch,
    lastOccurrenceDate: args.lastTuple.occurrenceDate,
    lastOccurrencePrecision: args.lastTuple.occurrencePrecision,
    ...(args.lastTuple.occurrenceInstant === undefined
      ? {}
      : { lastOccurrenceInstant: args.lastTuple.occurrenceInstant }),
    lastSortKey: args.lastTuple.sortKey,
    lastStableId: args.lastTuple.stableId,
    totals: args.totals,
    invalidRows: args.invalidRows,
    ambiguousTimeRows: args.ambiguousTimeRows,
    unsupportedValueRows: args.unsupportedValueRows,
    readOverflow: args.readOverflow,
    processedRows: args.processedRows,
    createdAt: args.now,
    updatedAt: args.now,
    expiresAt,
  });
}

/**
 * Advances by replacing the old cursor ID with a new immutable cursor ID.
 * Retrying a consumed cursor fails explicitly, so response loss can require a
 * restart but can never skip a page or double-add an accumulator.
 */
export async function advanceRecordQuerySession(
  ctx: MutationCtx,
  session: Doc<"recordQuerySessions">,
  args: {
    lastTuple: RecordQueryCursorTuple;
    totals: CurrencyTotal[];
    invalidRows: number;
    ambiguousTimeRows: number;
    unsupportedValueRows: number;
    readOverflow: boolean;
    processedRows: number;
    now: number;
  },
) {
  requireFinite(args.now, "now");
  requireNonnegativeInteger(args.processedRows, "processedRows");
  requireNonnegativeInteger(args.invalidRows, "invalidRows");
  requireNonnegativeInteger(args.ambiguousTimeRows, "ambiguousTimeRows");
  requireNonnegativeInteger(args.unsupportedValueRows, "unsupportedValueRows");
  if (args.now >= session.expiresAt) {
    await ctx.db.delete(session._id);
    throw new Error("Record query cursor expired; restart the query");
  }
  const nextId = await ctx.db.insert("recordQuerySessions", {
    spaceId: session.spaceId,
    userId: session.userId,
    ...(session.credentialId ? { credentialId: session.credentialId } : {}),
    membershipId: session.membershipId,
    authorizationSignature: session.authorizationSignature,
    operation: session.operation,
    consistency: session.consistency,
    normalizedFilter: session.normalizedFilter,
    sourceAccountIds: session.sourceAccountIds,
    snapshotAt: session.snapshotAt,
    activationEpoch: session.activationEpoch,
    visibilityEpoch: session.visibilityEpoch,
    lastOccurrenceDate: args.lastTuple.occurrenceDate,
    lastOccurrencePrecision: args.lastTuple.occurrencePrecision,
    ...(args.lastTuple.occurrenceInstant === undefined
      ? {}
      : { lastOccurrenceInstant: args.lastTuple.occurrenceInstant }),
    lastSortKey: args.lastTuple.sortKey,
    lastStableId: args.lastTuple.stableId,
    totals: args.totals,
    invalidRows: args.invalidRows,
    ambiguousTimeRows: args.ambiguousTimeRows,
    unsupportedValueRows: args.unsupportedValueRows,
    readOverflow: args.readOverflow,
    processedRows: args.processedRows,
    createdAt: session.createdAt,
    updatedAt: args.now,
    expiresAt: session.expiresAt,
  });
  await ctx.db.delete(session._id);
  return nextId;
}

export async function consumeRecordQuerySession(
  ctx: MutationCtx,
  sessionId: Id<"recordQuerySessions">,
) {
  await ctx.db.delete(sessionId);
}
