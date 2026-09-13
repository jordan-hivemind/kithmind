// Ported from packages/convex/convex/models/thoughts/model.ts and the
// `*Authorized` internal functions of models/thoughts/private.ts, minus the
// embedding-target wiring: `_insertOne`/`_transitionMemory`'s calls into
// `../embeddings/model` (`insertThoughtEmbedding`, `markEligibilityTargets`,
// `bumpEmbeddingEligibilityEpoch`, `deleteActiveThoughtEmbeddingVectors`,
// `requireActiveEmbeddingTarget`) are P2-39g's column and index to add
// (section 2.7); `kith.thoughts` has no vector column yet (migration 004 did
// not create one), so nothing here writes one. `_computeSpaceStats` is not
// ported either: its digest reads `../embeddings/targets`' space counters,
// which do not exist on this side yet, so it stays with the row that adds
// them. `_listByUser`/`_listCoreByUser` (a legacy userId-scoped read, from
// before the space model) are not ported: every read here goes through an
// already-authorized space set, matching `docs/plans/2026-09-06-architecture.md`
// section 3.1 ("Every read ... verifies the actual row's space").
//
// As in `facts.ts`, every function takes an already-authorized `spaceId`
// (writes) or `spaceIds` set (reads); space authorization is the caller's job.

import { row, rows, exec, at, ms, type IdentityCtx } from "../identity/db.js";
import { assertKithId, newKithId } from "../ids.js";
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

type ThoughtRow = {
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

const THOUGHT_COLUMNS = `id, space_id, created_at, content, metadata, user_id, updated_at,
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
  return record ? toThought(record) : null;
}

/** Ported from `getByIdAuthorized`/`getByIdsAuthorized`, folded into one bulk read. */
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
  return records.map(toThought).filter((thought) => authorized.has(thought.spaceId));
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
        WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${values.length}`;
      const candidates = (await rows<ThoughtRow>(ctx, sql, values)).map(toThought);
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
          ORDER BY created_at DESC, id DESC LIMIT $3`,
        [spaceId, activeAt, limit],
      )).map(toThought),
    );
  }
  return bySpace.flat().sort(compareNewestFirst).slice(0, limit);
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
 * authorized for write. No embedding is written (see the module comment);
 * P2-39g's index build picks up an unindexed thought the same way it would
 * pick up any other backlog row.
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

  return newId;
}

/** Ported from `_setCoreStatus`/`setCoreStatusAuthorized`. */
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

/**
 * The seam P2-39g's text/vector index plugs into: given candidate thought ids
 * already ranked by whatever index produced them, authorize, filter by
 * retrievability (and optionally `type`), and return in the caller's order.
 * Ported from the intent of `hydrateHybridResultsAuthorized` and
 * `resolveThoughtVectorCandidatesAuthorized`, without the embedding-target
 * plumbing those carried (P2-39g's to add back for its own index kind).
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
  const byId = new Map(records.map((record) => [record.id, toThought(record)]));
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
