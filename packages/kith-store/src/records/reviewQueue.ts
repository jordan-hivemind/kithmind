// Ported from packages/convex/convex/models/records/reviewQueue.ts (P2-39i3).
//
// Section 1.5 of docs/plans/2026-09-16-web-mcp-postgres-surface.md listed this
// as owed by nobody and assigned it here, because `list_review_queue` is one of
// the 14 read tools i3 moves onto PostgreSQL and nothing in this package
// answered it.
//
// The Convex original's shape is kept exactly: counts are always present, one
// named class's rows are paged, and an unauthorized or unknown
// `sourceAccountId` reads as an empty, non-enumerating result. The five bounded
// scans keep `MAX_REVIEW_COUNT_ROWS`, so a count that hit the bound still says
// `truncated: true` rather than silently under-reporting.
//
// Two mechanical differences from the Convex text, both forced by the store:
//
//   * Convex's `.paginate()` cursor becomes the same base64url keyset cursor
//     over `(created_at, id)` that `documents/inventory.ts` uses. Both are
//     opaque to the caller; neither is portable to the other surface, which is
//     what an opaque cursor means.
//   * `created_at` is the row's insert time and `created_at_field` is the
//     domain's own `createdAt` (see `workers/rows.ts` for the convention).
//     A projected row reports `created_at_field`, which is what the Convex
//     document's `createdAt` was; the keyset orders on `created_at`, which is
//     what Convex's own `_creationTime` cursor ordered on.
//
// `spaceIds` must already be the caller's membership-checked authorized set
// (`getAuthorizedReadSpaceIds`). This function never resolves a space of its
// own, and the account lookup carries the set, so an account in another space
// is indistinguishable from one that does not exist.

import type { ClientBase, QueryResultRow } from "pg";

import { projectInventoryRow } from "../documents/inventory.js";
import {
  camelizeSourceInventory,
  type SourceInventoryExclusionReason,
  type SourceInventoryRow,
} from "../provenance/rows.js";
import { spacePredicate } from "../spaces.js";
import type { RecordEventType } from "./model.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/** The same bounded, honest aggregate bound the Convex original used. */
const MAX_REVIEW_COUNT_ROWS = 256;

export const REVIEW_QUEUE_CLASSES = [
  "skipped_by_type",
  "field_dropped",
  "card_gate_failed",
  "duplicate_group",
  "entity_binding_needed",
  "queue_status",
] as const;

export type ReviewQueueClass = (typeof REVIEW_QUEUE_CLASSES)[number];

export type ReviewQueueListArgs = {
  sourceAccountId: string;
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
type EntityBindingNeededCounts = BoundedCounts & {
  unresolved: number;
  ambiguous: number;
};

export type QueueStatusSummary = {
  kind: RecordEventType;
  phase: string;
  extractedCount: number;
  gateFailedCount: number;
  skippedCount: number;
  documentsProcessedToday: number;
  dailyDocumentBudget: number;
  documentsProcessedThisWeek: number;
  weeklyDocumentBudget: number;
  costMicroUsdThisWeek: number;
  weeklyCostBudgetMicroUsd: number;
  pauseReason: string | undefined;
  resumeAt: number | undefined;
};

export type ReviewQueueCounts = {
  skippedByType: SkippedByTypeCounts;
  fieldDropped: FieldDroppedCounts;
  cardGateFailed: CardGateFailedCounts;
  duplicateGroup: BoundedCounts;
  entityBindingNeeded: EntityBindingNeededCounts;
  queueStatus: QueueStatusSummary[];
};

export type ReviewQueuePage = {
  rows: unknown[];
  cursor: string | undefined;
  isDone: boolean;
  counts: ReviewQueueCounts;
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

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return value;
}

function count(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function epochMs(value: unknown): number | undefined {
  return value instanceof Date ? value.getTime() : undefined;
}

/** The keyset cursor `documents/inventory.ts` already uses, kept identical. */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify([createdAt.toISOString(), id]),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(cursor: string): [Date, string] {
  const [createdAtIso, id] = JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf8"),
  ) as [string, string];
  const createdAt = new Date(createdAtIso);
  if (Number.isNaN(createdAt.getTime()) || typeof id !== "string") {
    throw new Error("Invalid cursor");
  }
  return [createdAt, id];
}

async function keysetPage(
  client: ClientBase,
  sql: string,
  values: readonly unknown[],
  cursor: string | undefined,
  limit: number,
): Promise<{
  rows: QueryResultRow[];
  cursor: string | undefined;
  isDone: boolean;
}> {
  const bound = [...values];
  let clause = "";
  if (cursor !== undefined) {
    const [createdAt, id] = decodeCursor(cursor);
    clause = ` AND (created_at, id) > ($${bound.length + 1}, $${bound.length + 2})`;
    bound.push(createdAt, id);
  }
  const page = (
    await client.query<QueryResultRow>(
      `${sql}${clause} ORDER BY created_at, id LIMIT ${limit + 1}`,
      bound,
    )
  ).rows;
  const isDone = page.length <= limit;
  const rows = page.slice(0, limit);
  const last = rows[rows.length - 1];
  return {
    rows,
    cursor:
      isDone || !last
        ? undefined
        : encodeCursor(last.created_at as Date, last.id as string),
    isDone,
  };
}

/** Section 7's `skipped_by_type`: every inventory row carrying an exclusion. */
const SKIPPED_INVENTORY_SQL = `SELECT * FROM kith.source_inventory
   WHERE space_id = $1 AND source_account_id = $2 AND exclusion_reason IS NOT NULL`;

async function skippedByTypeCounts(
  client: ClientBase,
  spaceId: string,
  sourceAccountId: string,
): Promise<SkippedByTypeCounts> {
  const rows = (
    await client.query<QueryResultRow>(
      `SELECT exclusion_reason FROM kith.source_inventory
        WHERE space_id = $1 AND source_account_id = $2
          AND exclusion_reason IS NOT NULL
        LIMIT ${MAX_REVIEW_COUNT_ROWS + 1}`,
      [spaceId, sourceAccountId],
    )
  ).rows;
  const truncated = rows.length > MAX_REVIEW_COUNT_ROWS;
  const counted = rows.slice(0, MAX_REVIEW_COUNT_ROWS);
  const byExclusionReason: Partial<
    Record<SourceInventoryExclusionReason, number>
  > = {};
  for (const row of counted) {
    const reason = row.exclusion_reason as SourceInventoryExclusionReason;
    byExclusionReason[reason] = (byExclusionReason[reason] ?? 0) + 1;
  }
  return { total: counted.length, byExclusionReason, truncated };
}

/**
 * Inventory rows carrying a `duplicate_group_id`, grouped and kept only where
 * two or more rows share one. A file with a merely unique content hash is
 * never reported as a "duplicate group" of one. Ported unchanged, including
 * the member ordering that makes the offset cursor stable across pages.
 */
async function duplicateGroups(
  client: ClientBase,
  spaceId: string,
  sourceAccountId: string,
): Promise<{
  members: SourceInventoryRow[];
  groupCount: number;
  truncated: boolean;
}> {
  const rows = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.source_inventory
        WHERE space_id = $1 AND source_account_id = $2
          AND duplicate_group_id IS NOT NULL
        LIMIT ${MAX_REVIEW_COUNT_ROWS + 1}`,
      [spaceId, sourceAccountId],
    )
  ).rows;
  const truncated = rows.length > MAX_REVIEW_COUNT_ROWS;
  const counted = rows
    .slice(0, MAX_REVIEW_COUNT_ROWS)
    .map((row) => camelizeSourceInventory(row));
  const byGroup = new Map<string, SourceInventoryRow[]>();
  for (const row of counted) {
    const key = row.duplicateGroupId!;
    const list = byGroup.get(key);
    if (list) list.push(row);
    else byGroup.set(key, [row]);
  }
  let groupCount = 0;
  const members: SourceInventoryRow[] = [];
  for (const list of byGroup.values()) {
    if (list.length < 2) continue;
    groupCount += 1;
    members.push(...list);
  }
  members.sort((left, right) => {
    if (left.duplicateGroupId !== right.duplicateGroupId) {
      return left.duplicateGroupId! < right.duplicateGroupId! ? -1 : 1;
    }
    return left.id < right.id ? -1 : 1;
  });
  return { members, groupCount, truncated };
}

/**
 * A cursor over an in-memory, already-bounded array: duplicate group members
 * are derived by grouping, not read straight off one index, so they page with
 * a plain offset. Ported unchanged.
 */
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

/**
 * One bounded scan of this account's `card_field_drops`, split by `kind`.
 * Dropped fields are counted by their gate failure `code`; gate failures are
 * counted by `record_kind`, so a gate failing for one document type is visible
 * without reading any field value.
 */
async function dropCounts(
  client: ClientBase,
  spaceId: string,
  sourceAccountId: string,
): Promise<{
  fieldDropped: FieldDroppedCounts;
  cardGateFailed: CardGateFailedCounts;
}> {
  const rows = (
    await client.query<QueryResultRow>(
      `SELECT kind, code, record_kind FROM kith.card_field_drops
        WHERE space_id = $1 AND source_account_id = $2
        LIMIT ${MAX_REVIEW_COUNT_ROWS + 1}`,
      [spaceId, sourceAccountId],
    )
  ).rows;
  const truncated = rows.length > MAX_REVIEW_COUNT_ROWS;
  const counted = rows.slice(0, MAX_REVIEW_COUNT_ROWS);
  const byCode: Partial<Record<string, number>> = {};
  const byRecordKind: Partial<Record<RecordEventType, number>> = {};
  let fieldDroppedTotal = 0;
  let cardGateFailedTotal = 0;
  for (const row of counted) {
    if (row.kind === "field_dropped") {
      fieldDroppedTotal += 1;
      const code = row.code as string;
      byCode[code] = (byCode[code] ?? 0) + 1;
    } else {
      cardGateFailedTotal += 1;
      const kind = row.record_kind as RecordEventType;
      byRecordKind[kind] = (byRecordKind[kind] ?? 0) + 1;
    }
  }
  return {
    fieldDropped: { total: fieldDroppedTotal, byCode, truncated },
    cardGateFailed: { total: cardGateFailedTotal, byRecordKind, truncated },
  };
}

/**
 * Pending `card_entity_bindings` rows: an accepted card field whose literal
 * name matched zero, or two or more, entities. A resolved row is an audit
 * note, not queued work, so it is never counted here.
 */
const PENDING_BINDING_SQL = `SELECT * FROM kith.card_entity_bindings
   WHERE space_id = $1 AND source_account_id = $2 AND status = 'pending'`;

async function entityBindingCounts(
  client: ClientBase,
  spaceId: string,
  sourceAccountId: string,
): Promise<EntityBindingNeededCounts> {
  const rows = (
    await client.query<QueryResultRow>(
      `SELECT candidate_count FROM kith.card_entity_bindings
        WHERE space_id = $1 AND source_account_id = $2 AND status = 'pending'
        LIMIT ${MAX_REVIEW_COUNT_ROWS + 1}`,
      [spaceId, sourceAccountId],
    )
  ).rows;
  const truncated = rows.length > MAX_REVIEW_COUNT_ROWS;
  const counted = rows.slice(0, MAX_REVIEW_COUNT_ROWS);
  let unresolved = 0;
  let ambiguous = 0;
  for (const row of counted) {
    if (count(row.candidate_count) === 0) unresolved += 1;
    else ambiguous += 1;
  }
  return { total: counted.length, unresolved, ambiguous, truncated };
}

/** The literal name, the candidate count and the card reference: what a
 * person needs to decide, and no other value from the document. */
function projectBindingRow(row: QueryResultRow) {
  return {
    bindingId: row.id as string,
    sourceItemId: row.source_item_id as string,
    eventId: row.event_id as string,
    observationId: row.observation_id as string,
    recordKind: row.record_kind as RecordEventType,
    fieldKey: row.field_key as string,
    literalName: row.literal_name as string,
    candidateCount: count(row.candidate_count),
    createdAt: epochMs(row.created_at_field),
  };
}

/** A `card_field_drops` row, never the value it refused: a document
 * reference, the field name and the closed gate failure code only. */
function projectDropRow(row: QueryResultRow) {
  return {
    dropId: row.id as string,
    sourceItemId: row.source_item_id as string,
    processingGenerationId: row.processing_generation_id as string,
    recordKind: row.record_kind as RecordEventType,
    kind: row.kind as "field_dropped" | "card_gate_failed",
    fieldKey: row.field_key as string,
    code: row.code as string,
    createdAt: epochMs(row.created_at_field),
  };
}

/**
 * One `card_extraction_queue_states` row per card kind started in this space.
 * Not scoped to a source account: the queue state has no per-account
 * dimension, so a source account's summary is its space's summary. Counts and
 * a phase only, capped at the closed set of card kinds, so no bound or cursor
 * is needed.
 */
async function queueStatusSummary(
  client: ClientBase,
  spaceId: string,
): Promise<QueueStatusSummary[]> {
  const rows = (
    await client.query<QueryResultRow>(
      `SELECT * FROM kith.card_extraction_queue_states
        WHERE space_id = $1 ORDER BY kind, id`,
      [spaceId],
    )
  ).rows;
  return rows.map((row) => ({
    kind: row.kind as RecordEventType,
    phase: row.phase as string,
    extractedCount: count(row.extracted_count),
    gateFailedCount: count(row.gate_failed_count),
    skippedCount: count(row.skipped_count),
    documentsProcessedToday: count(row.documents_processed_today),
    dailyDocumentBudget: count(row.daily_document_budget),
    documentsProcessedThisWeek: count(row.documents_processed_this_week),
    weeklyDocumentBudget: count(row.weekly_document_budget),
    costMicroUsdThisWeek: count(row.cost_micro_usd_this_week),
    weeklyCostBudgetMicroUsd: count(row.weekly_cost_budget_micro_usd),
    pauseReason: (row.pause_reason as string | null) ?? undefined,
    resumeAt: epochMs(row.resume_at),
  }));
}

async function detailPage(
  client: ClientBase,
  spaceId: string,
  sourceAccountId: string,
  cls: ReviewQueueClass,
  cursor: string | undefined,
  limit: number,
): Promise<{ rows: unknown[]; cursor: string | undefined; isDone: boolean }> {
  switch (cls) {
    case "skipped_by_type": {
      const page = await keysetPage(
        client,
        SKIPPED_INVENTORY_SQL,
        [spaceId, sourceAccountId],
        cursor,
        limit,
      );
      return {
        ...page,
        rows: page.rows.map((row) =>
          projectInventoryRow(camelizeSourceInventory(row)),
        ),
      };
    }
    case "duplicate_group": {
      const { members } = await duplicateGroups(
        client,
        spaceId,
        sourceAccountId,
      );
      const page = paginateArray(members, cursor, limit);
      return { ...page, rows: page.rows.map(projectInventoryRow) };
    }
    case "field_dropped":
    case "card_gate_failed": {
      const page = await keysetPage(
        client,
        `SELECT * FROM kith.card_field_drops
           WHERE space_id = $1 AND source_account_id = $2 AND kind = $3`,
        [spaceId, sourceAccountId, cls],
        cursor,
        limit,
      );
      return { ...page, rows: page.rows.map(projectDropRow) };
    }
    case "entity_binding_needed": {
      const page = await keysetPage(
        client,
        PENDING_BINDING_SQL,
        [spaceId, sourceAccountId],
        cursor,
        limit,
      );
      return { ...page, rows: page.rows.map(projectBindingRow) };
    }
    case "queue_status": {
      // No per-file rows: the full (small) summary is always one page.
      return {
        rows: await queueStatusSummary(client, spaceId),
        cursor: undefined,
        isDone: true,
      };
    }
  }
}

/**
 * Space-scoped review queue read.
 *
 * `authorizedSpaceIds` must already be the caller's membership-checked
 * authorized set. An empty set, an unauthorized account and an unknown account
 * all read as the same empty result, so the tool cannot be used to enumerate
 * source accounts in spaces the credential cannot read.
 */
export async function listReviewQueue(
  client: ClientBase,
  authorizedSpaceIds: readonly string[],
  args: ReviewQueueListArgs,
): Promise<ReviewQueuePage> {
  const limit = boundedLimit(args.limit);
  if (authorizedSpaceIds.length === 0) {
    return { rows: [], cursor: undefined, isDone: true, counts: emptyCounts() };
  }
  const predicate = spacePredicate(authorizedSpaceIds, 1);
  const account = (
    await client.query<QueryResultRow>(
      `SELECT id, space_id FROM kith.source_accounts
        WHERE id = $2 AND ${predicate.sql}`,
      [predicate.value, args.sourceAccountId],
    )
  ).rows[0];
  if (!account) {
    return { rows: [], cursor: undefined, isDone: true, counts: emptyCounts() };
  }
  const spaceId = account.space_id as string;
  const accountId = account.id as string;

  // One checked-out client runs these in sequence: `pg` rejects concurrent
  // `query()` calls on one connection, so the Convex `Promise.all` becomes an
  // explicit read order. They are all inside the caller's one transaction, so
  // the counts and the page still come from one snapshot.
  const skippedByType = await skippedByTypeCounts(client, spaceId, accountId);
  const drops = await dropCounts(client, spaceId, accountId);
  const duplicateGroupResult = await duplicateGroups(
    client,
    spaceId,
    accountId,
  );
  const entityBindingNeeded = await entityBindingCounts(
    client,
    spaceId,
    accountId,
  );
  const queueStatus = await queueStatusSummary(client, spaceId);

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
    client,
    spaceId,
    accountId,
    args.class,
    args.cursor,
    limit,
  );
  return { ...page, counts };
}
