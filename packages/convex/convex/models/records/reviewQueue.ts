import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { projectInventoryRow } from "../documents/inventory";
import type { SourceInventoryExclusionReason } from "../documents/inventoryTables";
import type { ReviewQueueClass } from "./validators";
import type { RecordEventType } from "./validators";

/**
 * P2-70k, section 7 and section 12 of docs/plans/2026-09-12-document-cards.md:
 * "Every skipped file, dropped field and duplicate group is reachable from a
 * count." One space-scoped read serving the review surface's five classes,
 * mirroring `listInventory`'s shape (counts always present, one class's rows
 * paged when named) and its authorization (the caller's already-authorized
 * `spaceIds`, an unauthorized or unknown `sourceAccountId` reading as an
 * empty, non-enumerating result).
 */

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

// Bounded, honest aggregate: the same shape and bound `listInventory` uses
// for its exclusion-reason breakdown (section 2.6), applied here to the
// three classes with no bound of their own (a source account's admitted
// files and drop rows are not otherwise capped).
const MAX_REVIEW_COUNT_ROWS = 256;

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return value;
}

export type ReviewQueueListArgs = {
  sourceAccountId: Id<"sourceAccounts">;
  class?: ReviewQueueClass;
  cursor?: string;
  limit?: number;
};

type BoundedCounts = { total: number; truncated: boolean };
type SkippedByTypeCounts = BoundedCounts & {
  byExclusionReason: Partial<Record<SourceInventoryExclusionReason, number>>;
};
type FieldDroppedCounts = BoundedCounts & {
  byCode: Partial<Record<string, number>>;
};
type CardGateFailedCounts = BoundedCounts & {
  byRecordKind: Partial<Record<RecordEventType, number>>;
};

export type QueueStatusSummary = {
  kind: RecordEventType;
  phase: Doc<"cardExtractionQueueStates">["phase"];
  extractedCount: number;
  gateFailedCount: number;
  skippedCount: number;
  documentsProcessedToday: number;
  dailyDocumentBudget: number;
  documentsProcessedThisWeek: number;
  weeklyDocumentBudget: number;
  costMicroUsdThisWeek: number;
  weeklyCostBudgetMicroUsd: number;
  pauseReason: Doc<"cardExtractionQueueStates">["pauseReason"];
  resumeAt: number | undefined;
};

/** P2-70l, section 4.4: split by why the name did not bind, which is the
 * only thing that changes what a person has to do about it. */
type EntityBindingNeededCounts = BoundedCounts & {
  unresolved: number;
  ambiguous: number;
};

export type ReviewQueueCounts = {
  skippedByType: SkippedByTypeCounts;
  fieldDropped: FieldDroppedCounts;
  cardGateFailed: CardGateFailedCounts;
  duplicateGroup: BoundedCounts;
  entityBindingNeeded: EntityBindingNeededCounts;
  queueStatus: QueueStatusSummary[];
};

function emptyCounts(): ReviewQueueCounts {
  return {
    skippedByType: { total: 0, byExclusionReason: {}, truncated: false },
    fieldDropped: { total: 0, byCode: {}, truncated: false },
    cardGateFailed: { total: 0, byRecordKind: {}, truncated: false },
    duplicateGroup: { total: 0, truncated: false },
    entityBindingNeeded: {
      total: 0,
      unresolved: 0,
      ambiguous: 0,
      truncated: false,
    },
    queueStatus: [],
  };
}

/** Pending `cardEntityBindings` rows for one account: an accepted card field
 * whose literal name matched zero, or two or more, entities. A resolved row
 * is an audit note, not queued work, so it is never counted here. */
function pendingBindingQuery(
  ctx: Pick<QueryCtx, "db">,
  spaceId: Id<"spaces">,
  sourceAccountId: Id<"sourceAccounts">,
) {
  return ctx.db
    .query("cardEntityBindings")
    .withIndex("by_space_account_status", (q) =>
      q
        .eq("spaceId", spaceId)
        .eq("sourceAccountId", sourceAccountId)
        .eq("status", "pending"),
    );
}

async function entityBindingCounts(
  ctx: Pick<QueryCtx, "db">,
  spaceId: Id<"spaces">,
  sourceAccountId: Id<"sourceAccounts">,
): Promise<EntityBindingNeededCounts> {
  const rows = await pendingBindingQuery(ctx, spaceId, sourceAccountId).take(
    MAX_REVIEW_COUNT_ROWS + 1,
  );
  const truncated = rows.length > MAX_REVIEW_COUNT_ROWS;
  const counted = rows.slice(0, MAX_REVIEW_COUNT_ROWS);
  let unresolved = 0;
  let ambiguous = 0;
  for (const row of counted) {
    if (row.candidateCount === 0) unresolved += 1;
    else ambiguous += 1;
  }
  return { total: counted.length, unresolved, ambiguous, truncated };
}

/** The literal name, the candidate count and the card reference: what a
 * person needs to decide, and no other value from the document. */
function projectBindingRow(row: Doc<"cardEntityBindings">) {
  return {
    bindingId: row._id,
    sourceItemId: row.sourceItemId,
    eventId: row.eventId,
    observationId: row.observationId,
    recordKind: row.recordKind,
    fieldKey: row.fieldKey,
    literalName: row.literalName,
    candidateCount: row.candidateCount,
    createdAt: row.createdAt,
  };
}

/** Every `sourceInventory` row for this account that is not content indexed,
 * i.e. carries an exclusion reason. Section 7's `skipped_by_type` item. */
function skippedInventoryQuery(
  ctx: Pick<QueryCtx, "db">,
  spaceId: Id<"spaces">,
  sourceAccountId: Id<"sourceAccounts">,
) {
  return ctx.db
    .query("sourceInventory")
    .withIndex("by_space_account_folder", (q) =>
      q.eq("spaceId", spaceId).eq("sourceAccountId", sourceAccountId),
    )
    .filter((q) => q.neq(q.field("exclusionReason"), undefined));
}

async function skippedByTypeCounts(
  ctx: Pick<QueryCtx, "db">,
  spaceId: Id<"spaces">,
  sourceAccountId: Id<"sourceAccounts">,
): Promise<SkippedByTypeCounts> {
  const rows = await skippedInventoryQuery(ctx, spaceId, sourceAccountId).take(
    MAX_REVIEW_COUNT_ROWS + 1,
  );
  const truncated = rows.length > MAX_REVIEW_COUNT_ROWS;
  const counted = rows.slice(0, MAX_REVIEW_COUNT_ROWS);
  const byExclusionReason: Partial<Record<SourceInventoryExclusionReason, number>> =
    {};
  for (const row of counted) {
    const reason = row.exclusionReason!;
    byExclusionReason[reason] = (byExclusionReason[reason] ?? 0) + 1;
  }
  return { total: counted.length, byExclusionReason, truncated };
}

/**
 * `sourceInventory` rows carrying a `duplicateGroupId`. Section 2.2 sets that
 * field on every non-gap row, keyed by `(contentHash, byteLength)`, whether
 * or not another file shares it: it becomes a real duplicate group, with a
 * `duplicate_of` member, only when two or more rows land on the same value
 * (section 2.5, `reconcileDuplicateGroup`). This bounded scan groups by that
 * id and keeps only groups of size 2 or more, so a file with a merely unique
 * hash is never reported as a "duplicate group" of one.
 */
async function duplicateGroups(
  ctx: Pick<QueryCtx, "db">,
  spaceId: Id<"spaces">,
  sourceAccountId: Id<"sourceAccounts">,
): Promise<{ members: Doc<"sourceInventory">[]; groupCount: number; truncated: boolean }> {
  const rows = await ctx.db
    .query("sourceInventory")
    .withIndex("by_space_account_folder", (q) =>
      q.eq("spaceId", spaceId).eq("sourceAccountId", sourceAccountId),
    )
    .filter((q) => q.neq(q.field("duplicateGroupId"), undefined))
    .take(MAX_REVIEW_COUNT_ROWS + 1);
  const truncated = rows.length > MAX_REVIEW_COUNT_ROWS;
  const counted = rows.slice(0, MAX_REVIEW_COUNT_ROWS);
  const byGroup = new Map<string, Doc<"sourceInventory">[]>();
  for (const row of counted) {
    const key = row.duplicateGroupId!;
    const list = byGroup.get(key);
    if (list) {
      list.push(row);
    } else {
      byGroup.set(key, [row]);
    }
  }
  let groupCount = 0;
  const members: Doc<"sourceInventory">[] = [];
  for (const list of byGroup.values()) {
    if (list.length < 2) continue;
    groupCount += 1;
    members.push(...list);
  }
  // Deterministic order across pages: group together, newest group first,
  // stable within a group by row id.
  members.sort((left, right) => {
    if (left.duplicateGroupId !== right.duplicateGroupId) {
      return left.duplicateGroupId! < right.duplicateGroupId! ? -1 : 1;
    }
    return left._id < right._id ? -1 : 1;
  });
  return { members, groupCount, truncated };
}

/** A cursor over an in-memory, already-bounded array: `duplicate_group`'s
 * members are derived by grouping (section 2.5), not read straight off one
 * index, so they are paged with a plain offset rather than a native Convex
 * cursor. Still opaque to the caller, and still bounded by the same
 * `MAX_REVIEW_COUNT_ROWS` scan the count above used. */
function paginateArray<T>(
  items: readonly T[],
  cursor: string | undefined,
  limit: number,
): { rows: T[]; cursor: string | undefined; isDone: boolean } {
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Invalid cursor");
  }
  const rows = items.slice(offset, offset + limit);
  const nextOffset = offset + rows.length;
  const isDone = nextOffset >= items.length;
  return { rows, cursor: isDone ? undefined : String(nextOffset), isDone };
}

/** One bounded scan of this account's `cardFieldDrops`, split by `kind`
 * (section 7's `field_dropped` and `card_gate_failed` items). Dropped fields
 * are counted by their gate failure `code`; gate failures are counted by
 * `recordKind`, the card kind whose required field failed, so a gate that is
 * failing for one document type is visible without reading any field value. */
async function dropCounts(
  ctx: Pick<QueryCtx, "db">,
  spaceId: Id<"spaces">,
  sourceAccountId: Id<"sourceAccounts">,
): Promise<{ fieldDropped: FieldDroppedCounts; cardGateFailed: CardGateFailedCounts }> {
  const rows = await ctx.db
    .query("cardFieldDrops")
    .withIndex("by_space_account", (q) =>
      q.eq("spaceId", spaceId).eq("sourceAccountId", sourceAccountId),
    )
    .take(MAX_REVIEW_COUNT_ROWS + 1);
  const truncated = rows.length > MAX_REVIEW_COUNT_ROWS;
  const counted = rows.slice(0, MAX_REVIEW_COUNT_ROWS);
  const byCode: Partial<Record<string, number>> = {};
  const byRecordKind: Partial<Record<RecordEventType, number>> = {};
  let fieldDroppedTotal = 0;
  let cardGateFailedTotal = 0;
  for (const row of counted) {
    if (row.kind === "field_dropped") {
      fieldDroppedTotal += 1;
      byCode[row.code] = (byCode[row.code] ?? 0) + 1;
    } else {
      cardGateFailedTotal += 1;
      byRecordKind[row.recordKind] = (byRecordKind[row.recordKind] ?? 0) + 1;
    }
  }
  return {
    fieldDropped: { total: fieldDroppedTotal, byCode, truncated },
    cardGateFailed: { total: cardGateFailedTotal, byRecordKind, truncated },
  };
}

/** Section 6: one `cardExtractionQueueStates` row per card kind started in
 * this space. Not scoped to a source account: the queue state has no
 * per-account dimension (it batches over every admitted document in the
 * space, section 6), so a source account's summary is its space's summary.
 * Counts and a phase only, capped at the closed set of card kinds so no
 * bound or cursor is needed. */
async function queueStatusSummary(
  ctx: Pick<QueryCtx, "db">,
  spaceId: Id<"spaces">,
): Promise<QueueStatusSummary[]> {
  const rows = await ctx.db
    .query("cardExtractionQueueStates")
    .withIndex("by_space_and_kind", (q) => q.eq("spaceId", spaceId))
    .collect();
  return rows.map((row) => ({
    kind: row.kind,
    phase: row.phase,
    extractedCount: row.extractedCount,
    gateFailedCount: row.gateFailedCount,
    skippedCount: row.skippedCount,
    documentsProcessedToday: row.documentsProcessedToday,
    dailyDocumentBudget: row.dailyDocumentBudget,
    documentsProcessedThisWeek: row.documentsProcessedThisWeek,
    weeklyDocumentBudget: row.weeklyDocumentBudget,
    costMicroUsdThisWeek: row.costMicroUsdThisWeek,
    weeklyCostBudgetMicroUsd: row.weeklyCostBudgetMicroUsd,
    pauseReason: row.pauseReason,
    resumeAt: row.resumeAt,
  }));
}

/** A `cardFieldDrops` row, never the value it refused: a document reference,
 * the field name and the closed gate failure code only. */
function projectDropRow(row: Doc<"cardFieldDrops">) {
  return {
    dropId: row._id,
    sourceItemId: row.sourceItemId,
    processingGenerationId: row.processingGenerationId,
    recordKind: row.recordKind,
    kind: row.kind,
    fieldKey: row.fieldKey,
    code: row.code,
    createdAt: row.createdAt,
  };
}

type DetailPage = {
  rows: unknown[];
  cursor: string | undefined;
  isDone: boolean;
};

async function detailPage(
  ctx: Pick<QueryCtx, "db">,
  spaceId: Id<"spaces">,
  sourceAccountId: Id<"sourceAccounts">,
  cls: ReviewQueueClass,
  cursor: string | undefined,
  limit: number,
): Promise<DetailPage> {
  switch (cls) {
    case "skipped_by_type": {
      const page = await skippedInventoryQuery(ctx, spaceId, sourceAccountId).paginate(
        { cursor: cursor ?? null, numItems: limit },
      );
      return {
        rows: page.page.map(projectInventoryRow),
        cursor: page.isDone ? undefined : page.continueCursor,
        isDone: page.isDone,
      };
    }
    case "duplicate_group": {
      const { members } = await duplicateGroups(ctx, spaceId, sourceAccountId);
      const page = paginateArray(members, cursor, limit);
      return { ...page, rows: page.rows.map(projectInventoryRow) };
    }
    case "field_dropped":
    case "card_gate_failed": {
      const page = await ctx.db
        .query("cardFieldDrops")
        .withIndex("by_space_account", (q) =>
          q.eq("spaceId", spaceId).eq("sourceAccountId", sourceAccountId),
        )
        .filter((q) => q.eq(q.field("kind"), cls))
        .paginate({ cursor: cursor ?? null, numItems: limit });
      return {
        rows: page.page.map(projectDropRow),
        cursor: page.isDone ? undefined : page.continueCursor,
        isDone: page.isDone,
      };
    }
    case "entity_binding_needed": {
      const page = await pendingBindingQuery(
        ctx,
        spaceId,
        sourceAccountId,
      ).paginate({ cursor: cursor ?? null, numItems: limit });
      return {
        rows: page.page.map(projectBindingRow),
        cursor: page.isDone ? undefined : page.continueCursor,
        isDone: page.isDone,
      };
    }
    case "queue_status": {
      // No per-file rows: the full (small) summary is always one page.
      return {
        rows: await queueStatusSummary(ctx, spaceId),
        cursor: undefined,
        isDone: true,
      };
    }
  }
}

/**
 * Space-scoped review queue read. `spaceIds` must already be the caller's
 * membership-checked authorized set (from `getAuthorizedReadSpaceIds`), the
 * same convention `listInventory` uses; this function never trusts a
 * caller-supplied space on its own. An unauthorized or unknown
 * `sourceAccountId` reads as empty, the same non-enumerating behavior
 * `listInventory` uses for the same input shape.
 */
export async function listReviewQueue(
  ctx: Pick<QueryCtx, "db">,
  spaceIds: readonly Id<"spaces">[],
  args: ReviewQueueListArgs,
) {
  const limit = boundedLimit(args.limit);
  const authorized = new Set(spaceIds);
  const account = await ctx.db.get(args.sourceAccountId);
  if (!account || !authorized.has(account.spaceId)) {
    return {
      rows: [],
      cursor: undefined,
      isDone: true,
      counts: emptyCounts(),
    };
  }

  const [
    skippedByType,
    drops,
    duplicateGroupResult,
    entityBindingNeeded,
    queueStatus,
  ] = await Promise.all([
    skippedByTypeCounts(ctx, account.spaceId, account._id),
    dropCounts(ctx, account.spaceId, account._id),
    duplicateGroups(ctx, account.spaceId, account._id),
    entityBindingCounts(ctx, account.spaceId, account._id),
    queueStatusSummary(ctx, account.spaceId),
  ]);
  const counts: ReviewQueueCounts = {
    skippedByType,
    fieldDropped: drops.fieldDropped,
    cardGateFailed: drops.cardGateFailed,
    duplicateGroup: {
      total: duplicateGroupResult.groupCount,
      truncated: duplicateGroupResult.truncated,
    },
    entityBindingNeeded,
    queueStatus,
  };

  if (args.class === undefined) {
    return { rows: [], cursor: undefined, isDone: true, counts };
  }

  const page = await detailPage(
    ctx,
    account.spaceId,
    account._id,
    args.class,
    args.cursor,
    limit,
  );
  return { ...page, counts };
}
