// Ported from packages/convex/convex/models/thoughts/model.ts and the
// `*Authorized` internal functions of models/thoughts/private.ts.
//
// The embedding-target wiring is here as of P2-39g2: `captureThought` and
// `transitionMemory` call `markEligibilityTargets`,
// `bumpEmbeddingEligibilityEpoch` and `deleteActiveThoughtEmbeddingVectors`
// from `../embeddings/` at exactly the points `_insertOne` and
// `_transitionMemory` did.
//
// Two of the five calls the Convex originals make are deliberately absent, and
// both are the same decision. `insertThoughtEmbedding` and
// `requireActiveEmbeddingTarget` ran only on the branch where the caller
// handed capture a vector it had already obtained from the provider. That
// branch does not exist on PostgreSQL: one ported mutation is one
// `SERIALIZABLE` transaction on one checked-out client (section 2.4 of
// docs/plans/2026-09-12-postgres-consolidation.md), and holding that client
// and its snapshot open across an HTTP call to an embedding provider is not
// something a capture may do. So a capture marks its target eligible and
// bumps the epoch, and the target is owed until `../embeddings/fill.ts`
// covers it -- which is section 3.1 of the index-capacity plan's incremental
// admission, not a gap. Both functions are ported and exported from
// `../embeddings/write.ts`; the fill is what calls them.
//
// P2-39j2 closed the other half of that sentence. "Until the fill covers it"
// used to mean "until an operator ran the fill by hand", because nothing
// scheduled one. Both writes below now call `scheduleEmbeddingFill`
// (`../embeddings/fillWork.ts`) in their own transaction, so the job that
// covers the target commits with the write that owed it, and the daemon drains
// it on its next round.
//
// I9 is unaffected. It was never enforced by that branch for its own sake:
// `getActiveEmbeddingTarget` reports `thoughtStatus: "unavailable"` while
// covered and eligible thought counts disagree, and narrative capture reads
// that. An uncovered new thought makes the counts disagree, so the index
// reports itself incomplete until the fill catches up.
//
// `_computeSpaceStats` is still not ported: nothing in this package exports a
// stats read for its digest to serve. The half of it that belongs to the
// embedding index -- the per-space counters and the `list_spaces` coverage
// label, which is all it reads from `readSpaceCounters` -- is ported, as
// `readSpaceCounters` and `spaceEmbeddingCoverage` in
// `../embeddings/state.ts`.
//
// `_listByUser`/`_listCoreByUser` (a legacy userId-scoped read, from before
// the space model) are not ported: every read here goes through an
// already-authorized space set, matching `docs/plans/2026-09-06-architecture.md`
// section 3.1 ("Every read ... verifies the actual row's space").
//
// As in `facts.ts`, every function takes an already-authorized `spaceId`
// (writes) or `spaceIds` set (reads); space authorization is the caller's job.

import {
  bumpEmbeddingEligibilityEpoch,
  markEligibilityTargets,
} from "../embeddings/eligibility.js";
import { scheduleEmbeddingFill } from "../embeddings/fillWork.js";
import { getActiveEmbeddingTarget } from "../embeddings/targets.js";
import { deleteActiveThoughtEmbeddingVectors } from "../embeddings/write.js";
import { row, rows, exec, at, ms, type IdentityCtx } from "../identity/db.js";
import { assertKithId, KITH_ID, newKithId } from "../ids.js";
import {
  assertValidMemoryValidity,
  isCurrentMemory,
  isMemoryRetrievable,
  safeSupersededValidTo,
  type MemoryStatus,
} from "./lifecycle.js";

export const DEFAULT_CORE_MEMORY_LIMIT = 10;
export const MAX_CORE_MEMORY_LIMIT = 25;
export const DEFAULT_THOUGHT_LIMIT = 20;
export const MAX_THOUGHT_LIMIT = 100;
const MAX_FILTER_SCAN = 1_000;
const MAX_CANDIDATE_READS = 1_000;
const MAX_THOUGHT_HISTORY_LINKS = 10;

export type ThoughtType =
  | "decision"
  | "person_note"
  | "idea"
  | "meeting_note"
  | "task"
  | "reference";

export type MemorySourceType = "user_stated" | "user_confirmed" | "assistant_commitment";

export type ThoughtMetadata = {
  type: ThoughtType;
  topics: readonly string[];
  people: readonly string[];
  actionItems: readonly string[];
  summary: string;
};

export type Thought = {
  id: string;
  spaceId: string;
  userId: string;
  content: string;
  metadata: ThoughtMetadata;
  createdAt: number;
  updatedAt: number | undefined;
  isCore: boolean;
  validFrom: number | undefined;
  validTo: number | undefined;
  memoryStatus: MemoryStatus | undefined;
  supersededAt: number | undefined;
  supersededBy: string | null;
  supersedes: readonly string[];
  changeReason: string | null;
  sourceType: MemorySourceType | undefined;
  sourceRef: string | null;
  observedAt: number | undefined;
  batchId: string | null;
  confidence: number | undefined;
};

/** Exported for `./timeline.ts`, which reads the same rows. */
export type ThoughtRow = {
  id: string;
  space_id: string;
  created_at: Date;
  content: string;
  metadata: ThoughtMetadata;
  user_id: string;
  updated_at: Date | null;
  is_core: boolean | null;
  valid_from: Date | null;
  valid_to: Date | null;
  memory_status: MemoryStatus | null;
  superseded_at: Date | null;
  superseded_by: string | null;
  supersedes: string[] | null;
  change_reason: string | null;
  source_type: MemorySourceType | null;
  source_ref: string | null;
  observed_at: Date | null;
  batch_id: string | null;
  confidence: string | number | null;
};

/**
 * Shared with `./timeline.ts`, which reads the same rows through the same
 * hydration. A module seam, not part of the memory domain's public surface:
 * `./index.js` does not re-export it.
 */
export const THOUGHT_COLUMNS = `id, space_id, created_at, content, metadata, user_id, updated_at,
       is_core, valid_from, valid_to, memory_status, superseded_at, superseded_by,
       supersedes, change_reason, source_type, source_ref, observed_at, batch_id, confidence`;

function toThought(record: ThoughtRow): Thought {
  return {
    id: record.id,
    spaceId: record.space_id,
    userId: record.user_id,
    content: record.content,
    metadata: record.metadata,
    createdAt: ms(record.created_at)!,
    updatedAt: ms(record.updated_at) ?? undefined,
    isCore: record.is_core ?? false,
    validFrom: ms(record.valid_from) ?? undefined,
    validTo: ms(record.valid_to) ?? undefined,
    memoryStatus: record.memory_status ?? undefined,
    supersededAt: ms(record.superseded_at) ?? undefined,
    supersededBy: record.superseded_by,
    supersedes: record.supersedes ?? [],
    changeReason: record.change_reason,
    sourceType: record.source_type ?? undefined,
    sourceRef: record.source_ref,
    observedAt: ms(record.observed_at) ?? undefined,
    batchId: record.batch_id,
    confidence: record.confidence === null ? undefined : Number(record.confidence),
  };
}

/**
 * A migration/import can bypass the transition writer, so `supersedes` is
 * treated as untrusted on every read.  A corrupted link is not rendered: it
 * could otherwise disclose an id from another space and make a thought's
 * history falsely look complete.  This intentionally mirrors fact hydration.
 */
async function hydrateThought(ctx: IdentityCtx, record: ThoughtRow): Promise<Thought | null> {
  const links = record.supersedes ?? [];
  if (
    links.length > MAX_THOUGHT_HISTORY_LINKS ||
    new Set(links).size !== links.length ||
    links.some((id) => !KITH_ID.test(id))
  ) return null;
  const linked = [];
  for (const id of links) {
    linked.push(await row<{ space_id: string }>(ctx, "SELECT space_id FROM kith.thoughts WHERE id = $1", [id]));
  }
  if (linked.some((thought) => !thought || thought.space_id !== record.space_id)) return null;
  return toThought(record);
}

export async function hydrateThoughtRows(ctx: IdentityCtx, records: readonly ThoughtRow[]): Promise<Thought[]> {
  const hydrated = [];
  for (const record of records) {
    const thought = await hydrateThought(ctx, record);
    if (thought) hydrated.push(thought);
  }
  return hydrated;
}

export function boundedThoughtLimit(
  requestedLimit: number | undefined,
  defaultLimit: number = DEFAULT_THOUGHT_LIMIT,
): number {
  const limit = requestedLimit ?? defaultLimit;
  if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 1) {
    throw new Error("Thought limit must be a positive integer");
  }
  return Math.min(limit, MAX_THOUGHT_LIMIT);
}

function compareNewestFirst(left: { createdAt: number; id: string }, right: { createdAt: number; id: string }) {
  return right.createdAt - left.createdAt || left.id.localeCompare(right.id);
}

/** One thought row by id, unchecked against any space. Callers space-check. */
export async function getThoughtById(ctx: IdentityCtx, id: string): Promise<Thought | null> {
  const record = await row<ThoughtRow>(
    ctx,
    `SELECT ${THOUGHT_COLUMNS} FROM kith.thoughts WHERE id = $1`,
    [assertKithId(id, "invalid_thought_id")],
  );
  return record ? hydrateThought(ctx, record) : null;
}

/**
 * Ported from `getByIdAuthorized`/`getByIdsAuthorized`, folded into one bulk
 * read.
 *
 * The caller's id order is the result order. `getByIdsAuthorized` read
 * `args.ids.map((id) => ctx.db.get(id))` and returned that array filtered, so
 * its caller could hand it a ranked candidate list and get the ranking back;
 * `get_thoughts` is documented as taking ids "from a prior search_thoughts
 * call" and is the consumer that depends on it. One `id = ANY(...)` returns
 * heap order, so the order is restored here rather than left to the plan.
 */
export async function getThoughtsByAuthorizedIds(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  ids: readonly string[],
): Promise<Thought[]> {
  if (ids.length === 0) return [];
  if (ids.length > 256) throw new Error("Too many thought IDs");
  const authorized = new Set(spaceIds);
  const records = await rows<ThoughtRow>(
    ctx,
    `SELECT ${THOUGHT_COLUMNS} FROM kith.thoughts WHERE id = ANY($1::text[])`,
    [ids.map((id) => assertKithId(id, "invalid_thought_id"))],
  );
  const byId = new Map(
    (await hydrateThoughtRows(ctx, records)).map((thought) => [thought.id, thought]),
  );
  return ids
    .map((id) => byId.get(id))
    .filter((thought): thought is Thought => thought !== undefined)
    .filter((thought) => authorized.has(thought.spaceId));
}

export type ListBySpacesFilters = { type?: ThoughtType; topic?: string };

/**
 * Ported from `_listBySpaces`. `filters.topic` is a bounded in-memory scan
 * (Convex could not index into `metadata.topics`, an array field, either), so
 * it reads up to `MAX_FILTER_SCAN` candidates per space before filtering.
 */
export async function listBySpaces(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  requestedLimit: number | undefined,
  includeHistorical = false,
  filters?: ListBySpacesFilters,
): Promise<Thought[]> {
  const limit = boundedThoughtLimit(requestedLimit);
  const activeAt = new Date(ctx.now);
  const scanLimit = filters?.topic ? MAX_FILTER_SCAN + 1 : limit;

  const bySpace = [];
  for (const spaceId of spaceIds) {
      const values: unknown[] = [spaceId];
      let where = "space_id = $1";
      if (filters?.type) {
        values.push(filters.type);
        where += ` AND metadata ->> 'type' = $${values.length}`;
      }
      where += includeHistorical
        ? " AND memory_status IS DISTINCT FROM 'retracted'"
        : ` AND (memory_status IS NULL OR memory_status = 'current')
            AND (valid_from IS NULL OR valid_from <= $${values.length + 1})
            AND (valid_to IS NULL OR $${values.length + 1} < valid_to)`;
      if (!includeHistorical) values.push(activeAt);
      values.push(scanLimit);
      const sql = `SELECT ${THOUGHT_COLUMNS} FROM kith.thoughts
        WHERE ${where} ORDER BY created_at DESC, id ASC LIMIT $${values.length}`;
      const candidates = await hydrateThoughtRows(ctx, await rows<ThoughtRow>(ctx, sql, values));
      if (candidates.length > MAX_FILTER_SCAN) {
        throw new Error("Thought topic filter exceeds the bounded scan");
      }
    bySpace.push(
      filters?.topic
        ? candidates.filter((thought) => thought.metadata.topics.includes(filters.topic!))
        : candidates,
    );
  }
  return bySpace.flat().sort(compareNewestFirst).slice(0, limit);
}

/** Ported from `_listCoreBySpaces`. */
export async function listCoreBySpaces(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  requestedLimit: number | undefined,
): Promise<Thought[]> {
  const rawLimit = requestedLimit ?? DEFAULT_CORE_MEMORY_LIMIT;
  if (!Number.isFinite(rawLimit) || !Number.isInteger(rawLimit) || rawLimit < 1) {
    throw new Error("Core memory limit must be a positive integer");
  }
  const limit = Math.min(rawLimit, MAX_CORE_MEMORY_LIMIT);
  const activeAt = new Date(ctx.now);
  const bySpace = [];
  for (const spaceId of spaceIds) {
    bySpace.push(
      (await rows<ThoughtRow>(
        ctx,
        `SELECT ${THOUGHT_COLUMNS} FROM kith.thoughts
          WHERE space_id = $1 AND is_core IS TRUE
            AND (memory_status IS NULL OR memory_status = 'current')
            AND (valid_from IS NULL OR valid_from <= $2)
            AND (valid_to IS NULL OR $2 < valid_to)
          ORDER BY created_at DESC, id ASC LIMIT $3`,
        [spaceId, activeAt, limit],
      )),
    );
  }
  return (await hydrateThoughtRows(ctx, bySpace.flat())).sort(compareNewestFirst).slice(0, limit);
}

export type CaptureThoughtArgs = {
  content: string;
  metadata: ThoughtMetadata;
  isCore?: boolean;
  validFrom?: number;
  validTo?: number;
  sourceType?: MemorySourceType;
  sourceRef?: string;
  observedAt?: number;
  batchId?: string;
  confidence?: number;
};

/**
 * Ported from `_insertOne`/`insertOneAuthorized`. `spaceId` is already
 * authorized for write. No vector is written here (see the module comment);
 * the new thought is an eligible, uncovered target and the provider fill
 * covers it.
 */
export async function captureThought(
  ctx: IdentityCtx,
  userId: string,
  spaceId: string,
  args: CaptureThoughtArgs,
): Promise<string> {
  assertValidMemoryValidity(args);
  const id = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.thoughts
       (id, space_id, created_at, content, metadata, user_id, is_core, valid_from,
        valid_to, memory_status, source_type, source_ref, observed_at, batch_id, confidence)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, 'current', $10, $11, $12, $13, $14)`,
    [
      id,
      spaceId,
      new Date(ctx.now),
      args.content,
      JSON.stringify(args.metadata),
      userId,
      args.isCore ?? null,
      at(args.validFrom),
      at(args.validTo),
      args.sourceType ?? null,
      args.sourceRef ?? null,
      at(args.observedAt),
      args.batchId ?? null,
      args.confidence ?? null,
    ],
  );
  // `_insertOne`'s order, kept: the eligibility mark comes first so a vector
  // insert would find a target row to mark covered, and the epoch bump
  // follows. On a space whose counters are not seeded the mark is a no-op and
  // the bump is the whole of it, exactly as it was on Convex.
  const counted = await markEligibilityTargets(ctx, spaceId, {
    thoughtIds: [id],
  });
  await bumpEmbeddingEligibilityEpoch(ctx, spaceId, { thoughtIds: [id] });
  // P2-39j2. The target this capture just made eligible is uncovered, which is
  // exactly what makes `getActiveEmbeddingTarget` report
  // `thoughtStatus: "unavailable"` for the space. Queue the fill that covers
  // it, in this same transaction, so the job commits with the thought or not
  // at all. An uncounted space owes nothing and is skipped: its fill would
  // return on its first read page.
  if (counted) await scheduleEmbeddingFill(ctx, spaceId);
  return id;
}

/**
 * Ported from `_transitionMemory`/`transitionMemoryAuthorized`: writes a new
 * current thought that supersedes or retracts 1-10 previous ones, in the same
 * transaction as marking those previous rows superseded/retracted.
 */
export async function transitionMemory(
  ctx: IdentityCtx,
  userId: string,
  spaceId: string,
  args: CaptureThoughtArgs,
  previousIds: readonly string[],
  previousStatus: Exclude<MemoryStatus, "current">,
  reason: string,
  transitionedAt: number,
): Promise<string> {
  assertValidMemoryValidity(args);
  if (previousStatus !== "superseded" && previousStatus !== "retracted") {
    throw new Error("Memory transition status must be superseded or retracted");
  }
  const uniquePreviousIds = [...new Set(previousIds)];
  if (uniquePreviousIds.length === 0 || uniquePreviousIds.length > 10) {
    throw new Error("A memory transition requires 1-10 previous memories");
  }
  if (!reason.trim() || reason.length > 500 || !Number.isFinite(transitionedAt) || transitionedAt <= 0) {
    throw new Error("Invalid memory transition metadata");
  }

  const previousMemories = [];
  for (const id of uniquePreviousIds) previousMemories.push(await getThoughtById(ctx, id));
  for (const previous of previousMemories) {
    if (!previous || previous.spaceId !== spaceId || !isCurrentMemory(previous.memoryStatus)) {
      throw new Error("Previous memory is unavailable");
    }
  }

  const isCore = args.isCore ?? previousMemories.some((previous) => previous!.isCore);
  const newId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.thoughts
       (id, space_id, created_at, content, metadata, user_id, is_core, valid_from,
        valid_to, memory_status, supersedes, source_type, source_ref, observed_at,
        batch_id, confidence)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, 'current', $10::jsonb, $11, $12, $13, $14, $15)`,
    [
      newId,
      spaceId,
      new Date(ctx.now),
      args.content,
      JSON.stringify(args.metadata),
      userId,
      isCore,
      at(args.validFrom),
      at(args.validTo),
      JSON.stringify(uniquePreviousIds),
      args.sourceType ?? null,
      args.sourceRef ?? null,
      at(args.observedAt),
      args.batchId ?? null,
      args.confidence ?? null,
    ],
  );
  // `_transitionMemory`'s order: the new memory is marked eligible before the
  // previous ones are transitioned, so its target exists for the whole rest of
  // this transaction.
  const counted = await markEligibilityTargets(ctx, spaceId, {
    thoughtIds: [newId],
  });

  for (const previous of previousMemories) {
    const corrected = previousStatus === "retracted";
    const validTo = !corrected ? safeSupersededValidTo(previous!, args.validFrom) : undefined;
    await exec(
      ctx,
      `UPDATE kith.thoughts
          SET memory_status = $2, superseded_at = $3, superseded_by = $4, change_reason = $5,
              valid_from = $6, valid_to = $7
        WHERE id = $1`,
      [
        previous!.id,
        previousStatus,
        new Date(transitionedAt),
        newId,
        reason,
        corrected ? null : at(previous!.validFrom),
        corrected ? null : at(validTo ?? previous!.validTo),
      ],
    );
  }

  // The previous memories left the current bucket in the statements above, so
  // their vectors are no longer retrievable. `_transitionMemory` deleted them
  // before the epoch bump and only on a space with an active index; a space
  // with none has no vector to delete and the call would refuse.
  const active = await activeIndexForWrite(ctx, spaceId);
  if (active) {
    await deleteActiveThoughtEmbeddingVectors(ctx, {
      spaceId,
      embeddingGenerationId: active.embeddingGenerationId,
      fingerprint: active.fingerprint,
      thoughtIds: uniquePreviousIds,
    });
  }
  // Supersede and retract retire exactly the memories they transitioned, and
  // the new memory above is marked in the same transaction.
  await bumpEmbeddingEligibilityEpoch(ctx, spaceId, {
    thoughtIds: [newId, ...uniquePreviousIds],
  });
  // The new memory is an uncovered target for the same reason a capture's is,
  // and the vectors deleted above leave the space's counts disagreeing until
  // it is covered. Same transaction, same per-space key.
  if (counted) await scheduleEmbeddingFill(ctx, spaceId);

  return newId;
}

/**
 * The active index of a space, or null when it has none or its state is
 * damaged.
 *
 * `_transitionMemory` reached the delete only on the branch where the caller
 * had supplied a generation and fingerprint, which is precisely when the space
 * had an active index. Here the caller supplies neither, so the transition
 * reads the pointer itself and skips the delete when there is nothing to
 * delete. A damaged pointer is swallowed for the same reason the read side
 * swallows it: an unindexed or broken index must not make a memory transition
 * fail.
 */
async function activeIndexForWrite(
  ctx: IdentityCtx,
  spaceId: string,
): Promise<{ embeddingGenerationId: string; fingerprint: string } | null> {
  try {
    return await getActiveEmbeddingTarget(ctx, spaceId);
  } catch {
    return null;
  }
}

/**
 * Ported from `_setCoreStatus`/`setCoreStatusAuthorized`.
 *
 * No embedding call, because `_setCoreStatus` makes none. `is_core` is not
 * part of a thought's embedded text and it does not move the memory's
 * lifecycle, so nothing about the target it names changes: its `input_hash`
 * is the same, it is eligible before and after, and its vector still covers
 * it. Marking or bumping here would spend an epoch on a write that changed no
 * eligibility.
 */
export async function setCoreStatus(
  ctx: IdentityCtx,
  spaceId: string,
  id: string,
  isCore: boolean,
): Promise<void> {
  const memory = await getThoughtById(ctx, id);
  if (!memory || memory.spaceId !== spaceId || !isCurrentMemory(memory.memoryStatus)) {
    throw new Error("Current memory not found");
  }
  await exec(ctx, "UPDATE kith.thoughts SET is_core = $2 WHERE id = $1", [id, isCore]);
}

export type UpdateThoughtArgs = {
  content: string;
  type: ThoughtType;
  topics: readonly string[];
  people: readonly string[];
};

/**
 * Edits a thought through `transitionMemory`, the same supersession
 * mechanism `SUPERSEDE` captures use: the edit is stored as a new current
 * thought and this one is marked superseded, so its prior content stays in
 * history rather than being overwritten. `transitionMemory` already refreshes
 * the embedding target (marks the new thought eligible, deletes the old
 * thought's active vector, bumps the eligibility epoch, schedules a fill), so
 * nothing extra is needed here for that.
 *
 * Only the fields the edit form offers change. `actionItems` and `summary`
 * carry over from the edited thought untouched, and so does everything else
 * `transitionMemory`'s args accept but this form does not ask about --
 * `sourceType`, `sourceRef`, `observedAt`, `batchId`, `confidence`,
 * `validFrom`, `validTo` -- because leaving them off `transitionMemory`'s
 * call is not "unset", it is a fresh capture's own defaults: an edit would
 * silently drop the new row's link to whatever document or conversation the
 * thought came from and reopen a business-time window the owner had closed.
 * `isCore` is the one exception, and does not need carrying here: it already
 * carries over inside `transitionMemory` itself (the previous thought's own
 * value, since none is passed here), the way every other caller's does.
 */
export async function updateThought(
  ctx: IdentityCtx,
  userId: string,
  spaceId: string,
  id: string,
  args: UpdateThoughtArgs,
): Promise<string> {
  const previous = await getThoughtById(ctx, id);
  if (!previous || previous.spaceId !== spaceId || !isCurrentMemory(previous.memoryStatus)) {
    throw new Error("Current thought not found");
  }
  return transitionMemory(
    ctx,
    userId,
    spaceId,
    {
      content: args.content,
      metadata: {
        type: args.type,
        topics: args.topics,
        people: args.people,
        actionItems: previous.metadata.actionItems,
        summary: previous.metadata.summary,
      },
      ...(previous.sourceType === undefined ? {} : { sourceType: previous.sourceType }),
      ...(previous.sourceRef === null ? {} : { sourceRef: previous.sourceRef }),
      ...(previous.observedAt === undefined ? {} : { observedAt: previous.observedAt }),
      ...(previous.batchId === null ? {} : { batchId: previous.batchId }),
      ...(previous.confidence === undefined ? {} : { confidence: previous.confidence }),
      ...(previous.validFrom === undefined ? {} : { validFrom: previous.validFrom }),
      ...(previous.validTo === undefined ? {} : { validTo: previous.validTo }),
    },
    [id],
    "superseded",
    "Edited",
    ctx.now,
  );
}

/**
 * Soft-deletes a thought: marks it `retracted`, which `isMemoryRetrievable`
 * withholds everywhere -- current and historical alike, exactly like a
 * `transitionMemory` RETRACT's previous memory -- without erasing the row,
 * its content or its `supersedes` links.
 *
 * This is `transitionMemory`'s retract branch with the insert removed: a UI
 * delete has no replacement content to store, so there is no new thought to
 * mark eligible and nothing to schedule a fill for. What remains is exactly
 * what a RETRACT's previous-memory update does -- `memory_status`,
 * `superseded_at`, `change_reason`, `valid_from`/`valid_to` cleared -- plus
 * the same embedding-target cleanup: delete the active vector (if the space
 * has one) and bump the eligibility epoch so a stale target is not left
 * pointing at a memory that no longer exists.
 */
export async function deleteThought(
  ctx: IdentityCtx,
  spaceId: string,
  id: string,
  reason: string = "Deleted",
): Promise<void> {
  const thought = await getThoughtById(ctx, id);
  if (!thought || thought.spaceId !== spaceId || !isCurrentMemory(thought.memoryStatus)) {
    throw new Error("Current thought not found");
  }
  await exec(
    ctx,
    `UPDATE kith.thoughts
        SET memory_status = 'retracted', superseded_at = $2, change_reason = $3,
            valid_from = NULL, valid_to = NULL
      WHERE id = $1`,
    [id, new Date(ctx.now), reason],
  );
  const active = await activeIndexForWrite(ctx, spaceId);
  if (active) {
    await deleteActiveThoughtEmbeddingVectors(ctx, {
      spaceId,
      embeddingGenerationId: active.embeddingGenerationId,
      fingerprint: active.fingerprint,
      thoughtIds: [id],
    });
  }
  await bumpEmbeddingEligibilityEpoch(ctx, spaceId, { thoughtIds: [id] });
}

/**
 * The seam P2-39g1's text and vector legs plug into: given candidate thought
 * ids already ranked by whatever index produced them, authorize, filter by
 * retrievability (and optionally `type`), and return in the caller's order.
 * Ported from the intent of `hydrateHybridResultsAuthorized` and
 * `resolveThoughtVectorCandidatesAuthorized`. The embedding-target plumbing
 * those carried now lives beside the leg that needs it, in
 * `src/embeddings/search.ts`, where the candidate and the vector row it came
 * from are still in hand.
 */
export async function getThoughtsByIds(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  candidateIds: readonly string[],
  options: { type?: ThoughtType; includeHistorical?: boolean } = {},
): Promise<Thought[]> {
  if (candidateIds.length === 0) return [];
  if (candidateIds.length > MAX_CANDIDATE_READS) {
    throw new Error("Thought candidate read exceeds the read limit");
  }
  const authorized = new Set(spaceIds);
  const records = await rows<ThoughtRow>(
    ctx,
    `SELECT ${THOUGHT_COLUMNS} FROM kith.thoughts WHERE id = ANY($1::text[])`,
    [candidateIds.map((id) => assertKithId(id, "invalid_thought_id"))],
  );
  const byId = new Map((await hydrateThoughtRows(ctx, records)).map((thought) => [thought.id, thought]));
  const activeAt = ctx.now;
  return candidateIds
    .map((id) => byId.get(id))
    .filter((thought): thought is Thought => thought !== undefined)
    .filter((thought) => authorized.has(thought.spaceId))
    .filter((thought) => options.type === undefined || thought.metadata.type === options.type)
    .filter((thought) =>
      isMemoryRetrievable(
        { memoryStatus: thought.memoryStatus, validFrom: thought.validFrom, validTo: thought.validTo },
        options.includeHistorical,
        activeAt,
      ),
    );
}
