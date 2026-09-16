// P2-39g2: the target rows, and the per-write eligibility path that maintains
// them.
//
// Ported from the write half of `models/embeddings/targets.ts`
// (`upsertEligibleTarget`, `retireEmbeddingTarget`, `setTargetCoverage`,
// `recordVectorCoverageChange`, `applyEligibilityTouch` with its three mark
// helpers, `seedTargetsFromManifest`, `owedTargetsPage`) and the two entry
// points `models/embeddings/model.ts` exposes to a write path
// (`markEligibilityTargets`, `bumpEmbeddingEligibilityEpoch`).
//
// The shape is I3 and I4 for an ordinary write: a caller names the targets its
// transaction touched -- a thought by id, a set of chunks by the processing
// generation that owns them, an item by its generic card -- and this upserts or
// retires exactly those, accumulates their counter deltas, and commits them in
// the same transaction. Nothing reads the rest of the space. Eligibility is
// re-read from the live rows rather than asserted by the caller, so a replay of
// the same write is a no-op and a caller cannot mislabel a target.
//
// `touchWorkerPublicationEmbedding` in `src/workers/publication.ts` maintains
// the same rows for a worker publish and is deliberately left as it is: it runs
// on `WorkerCtx` under the worker protocol's `scan_conflict` failure contract
// rather than on `IdentityCtx`, and its two call sites are covered by
// `test/workerFoundation.test.mjs` and `test/workerHttp.test.mjs`. The two
// agree on the rows and the deltas -- the same upsert-or-retire rule, the same
// `covered_fingerprint` drop on a changed hash, the same epoch bump -- and
// `test/embeddingLifecycle.test.mjs` asserts that agreement rather than
// asserting one implementation twice. Folding one into the other would mean
// either giving this module the worker's failure contract or giving the worker
// this module's, and neither is a change this slice can make without touching
// the protocol tests it must leave passing.

import { at, exec, row, rows, type IdentityCtx } from "../identity/db.js";
import { newKithId } from "../ids.js";
import { sha256Utf8 } from "../provenance/sql.js";
import {
  CARD_TARGET_EVENT_KEY,
  chunkTargetsOptedIn,
  composeCardTargetInput,
} from "./cardTargets.js";
import {
  loadSourceAccount,
  loadSourceItem,
  type ChunkRow,
} from "./chunkTargets.js";
import type { EmbeddingTargetKind } from "./scope.js";
import {
  addCoveredDelta,
  addEligibleDelta,
  addHistoryDelta,
  commitCounterDelta,
  countOf,
  coveredCountList,
  emptyCounterDelta,
  ensureSpaceEmbeddingState,
  spaceEmbedsAllChunks,
  uniqueSpaceState,
  type EmbeddingCounterDelta,
  type SpaceEmbeddingStateRow,
} from "./state.js";
import {
  findEmbeddingTarget,
  usesTargetCounters,
  type EmbeddingTargetRow,
} from "./targets.js";

/** Design ceiling from the index-capacity plan. No page bound may preclude it. */
export const EMBEDDING_TARGET_CAPACITY_CEILING = 50_000;

/** Rows the provider fill still owes under a fingerprint, one page at a time. */
export const EMBEDDING_FILL_PAGE = 32;

/** A supersede transition carries at most one new and ten previous memories. */
const MAX_TOUCHED_THOUGHTS = 32;
/** A publish touches the new generation and the one it replaces. */
const MAX_TOUCHED_GENERATIONS = 4;
/** A card publication or a forget touches exactly one item. */
const MAX_TOUCHED_SOURCE_ITEMS = 4;
/** Matches the activation chunk bound in the provenance model. */
const MAX_TOUCHED_GENERATION_CHUNKS = 256;

export const EMBEDDING_TARGET_COLUMNS = `id, space_id, target_kind, target_id,
  input_hash, processing_generation_id, state, covered_fingerprint, updated_at`;

/** The target row, with the two columns the read side does not need. */
export type EmbeddingTargetWriteRow = EmbeddingTargetRow & {
  processing_generation_id: string | null;
  updated_at: Date | null;
};

/** Ported from `isCurrentThought`: absent and `current` are the same thing. */
export function isCurrentThought(thought: {
  memory_status: string | null;
}): boolean {
  return thought.memory_status === null || thought.memory_status === "current";
}

async function lockedTarget(
  ctx: IdentityCtx,
  spaceId: string,
  targetKind: EmbeddingTargetKind,
  targetId: string,
): Promise<EmbeddingTargetWriteRow | null> {
  const found = await rows<EmbeddingTargetWriteRow>(
    ctx,
    `SELECT ${EMBEDDING_TARGET_COLUMNS} FROM kith.embedding_targets
      WHERE space_id = $1 AND target_kind = $2 AND target_id = $3
      ORDER BY created_at, id LIMIT 2 FOR UPDATE`,
    [spaceId, targetKind, targetId],
  );
  if (found.length > 1) throw new Error("Duplicate embedding target row");
  return found[0] ?? null;
}

/**
 * Creates or refreshes the row for an eligible target. A changed `inputHash`
 * drops the coverage marker, because the vector that covered the old text no
 * longer covers this target.
 */
export async function upsertEligibleTarget(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    targetKind: EmbeddingTargetKind;
    targetId: string;
    inputHash: string;
    processingGenerationId?: string | null;
    now?: number;
  },
  delta: EmbeddingCounterDelta,
): Promise<"created" | "changed" | "unchanged"> {
  const now = input.now ?? ctx.now;
  const parent = input.processingGenerationId ?? null;
  const existing = await lockedTarget(
    ctx,
    input.spaceId,
    input.targetKind,
    input.targetId,
  );
  if (!existing) {
    await exec(
      ctx,
      `INSERT INTO kith.embedding_targets
         (id, space_id, created_at, target_kind, target_id, input_hash,
          processing_generation_id, state, updated_at)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, 'eligible', $7)`,
      [
        newKithId(),
        input.spaceId,
        input.targetKind,
        input.targetId,
        input.inputHash,
        parent,
        at(now),
      ],
    );
    addEligibleDelta(delta, input.targetKind, 1);
    return "created";
  }
  const hashChanged = existing.input_hash !== input.inputHash;
  const parentChanged = existing.processing_generation_id !== parent;
  const wasRetired = existing.state === "retired";
  if (!hashChanged && !parentChanged && !wasRetired) {
    // Touching the row is what lets the scan sweep find rows it never visited.
    await exec(
      ctx,
      "UPDATE kith.embedding_targets SET updated_at = $2 WHERE id = $1",
      [existing.id, at(now)],
    );
    return "unchanged";
  }
  if (wasRetired) addEligibleDelta(delta, input.targetKind, 1);
  const dropsCoverage = hashChanged || parentChanged || wasRetired;
  if (dropsCoverage && existing.covered_fingerprint) {
    addCoveredDelta(delta, existing.covered_fingerprint, input.targetKind, -1);
  }
  await exec(
    ctx,
    `UPDATE kith.embedding_targets
        SET input_hash = $2, processing_generation_id = $3, state = 'eligible',
            covered_fingerprint = $4, updated_at = $5
      WHERE id = $1`,
    [
      existing.id,
      input.inputHash,
      parent,
      dropsCoverage ? null : existing.covered_fingerprint,
      at(now),
    ],
  );
  return wasRetired ? "created" : "changed";
}

export async function retireEmbeddingTarget(
  ctx: IdentityCtx,
  record: EmbeddingTargetWriteRow,
  now: number,
  delta: EmbeddingCounterDelta,
): Promise<void> {
  if (record.state === "retired") return;
  const kind = assertTargetKind(record.target_kind);
  addEligibleDelta(delta, kind, -1);
  if (record.covered_fingerprint) {
    addCoveredDelta(delta, record.covered_fingerprint, kind, -1);
  }
  await exec(
    ctx,
    `UPDATE kith.embedding_targets
        SET state = 'retired', covered_fingerprint = NULL, updated_at = $2
      WHERE id = $1`,
    [record.id, at(now)],
  );
}

export function assertTargetKind(value: string | null): EmbeddingTargetKind {
  if (value !== "thought" && value !== "chunk" && value !== "card") {
    throw new Error("Embedding target kind is invalid");
  }
  return value;
}

/**
 * I4, covered half: called from the transaction that inserted or deleted the
 * vector, never from a later reconciliation of its own.
 */
export async function setTargetCoverage(
  ctx: IdentityCtx,
  record: EmbeddingTargetWriteRow,
  fingerprint: string | null,
  now: number,
  delta: EmbeddingCounterDelta,
): Promise<boolean> {
  if ((record.covered_fingerprint ?? null) === fingerprint) return false;
  const kind = assertTargetKind(record.target_kind);
  if (record.covered_fingerprint) {
    addCoveredDelta(delta, record.covered_fingerprint, kind, -1);
  }
  if (fingerprint) addCoveredDelta(delta, fingerprint, kind, 1);
  await exec(
    ctx,
    `UPDATE kith.embedding_targets
        SET covered_fingerprint = $2, updated_at = $3 WHERE id = $1`,
    [record.id, fingerprint, at(now)],
  );
  return true;
}

/**
 * Maintains the coverage marker and counters for a vector write or delete. A
 * space with no target rows yet is untouched, so this is dormant until a build
 * has seeded the table.
 */
export async function recordVectorCoverageChange(
  ctx: IdentityCtx,
  input: {
    spaceId: string;
    targetKind: EmbeddingTargetKind;
    targetId: string;
    fingerprint: string;
    inputHash: string;
    covered: boolean;
    now?: number;
  },
): Promise<void> {
  const now = input.now ?? ctx.now;
  const record = await lockedTarget(
    ctx,
    input.spaceId,
    input.targetKind,
    input.targetId,
  );
  if (!record || record.state !== "eligible") return;
  if (input.covered && record.input_hash !== input.inputHash) return;
  if (!input.covered && record.covered_fingerprint !== input.fingerprint) {
    return;
  }
  const state = await uniqueSpaceState(ctx, input.spaceId, true);
  if (!state) return;
  // The marker is single valued, so only the active fingerprint may claim it.
  // A generation staged under a new fingerprint would otherwise take the
  // marker from the live index and report the active profile as uncovered,
  // which section 3.4 point 2 says a staged build must never do. Its own
  // coverage is established by a build job under that fingerprint.
  if (
    input.covered &&
    state.active_fingerprint !== null &&
    state.active_fingerprint !== input.fingerprint
  ) {
    return;
  }
  const delta = emptyCounterDelta();
  await setTargetCoverage(
    ctx,
    record,
    input.covered ? input.fingerprint : null,
    now,
    delta,
  );
  await commitCounterDelta(ctx, state, delta, now);
}

// ---------------------------------------------------------------------------
// Per-write eligibility
// ---------------------------------------------------------------------------

/**
 * The targets one eligibility write touched, named by what the caller changed
 * rather than by the space.
 */
export type EmbeddingEligibilityTouch = {
  thoughtIds?: readonly string[];
  processingGenerationIds?: readonly string[];
  /** The items whose generic card target this write changed. */
  sourceItemIds?: readonly string[];
};

async function markThoughtTarget(
  ctx: IdentityCtx,
  spaceId: string,
  thoughtId: string,
  now: number,
  delta: EmbeddingCounterDelta,
): Promise<void> {
  const thought = await row<{
    id: string;
    space_id: string;
    content: string;
    memory_status: string | null;
  }>(
    ctx,
    "SELECT id, space_id, content, memory_status FROM kith.thoughts WHERE id = $1",
    [thoughtId],
  );
  const eligible =
    thought !== null &&
    thought.space_id === spaceId &&
    isCurrentThought(thought);
  if (eligible) {
    await upsertEligibleTarget(
      ctx,
      {
        spaceId,
        targetKind: "thought",
        targetId: thoughtId,
        inputHash: await sha256Utf8(thought!.content),
        now,
      },
      delta,
    );
    return;
  }
  const record = await lockedTarget(ctx, spaceId, "thought", thoughtId);
  if (!record) return;
  // I4 for the stats counters: a thought leaves the current bucket exactly
  // when its eligible target is retired for a non-current status, and that
  // transition is one-way, so this is the only increment the counts need.
  // A revive would double count; no path returns a superseded or retracted
  // memory to current, and a decrement belongs here if one ever does.
  if (
    record.state === "eligible" &&
    thought !== null &&
    thought.space_id === spaceId &&
    (thought.memory_status === "superseded" ||
      thought.memory_status === "retracted")
  ) {
    addHistoryDelta(delta, thought.memory_status, 1);
  }
  await retireEmbeddingTarget(ctx, record, now, delta);
}

/**
 * The generic card target of one source item. Its identity is the card
 * `events` row, which survives re-extraction, so an unchanged card keeps its
 * vector across card generations (I3). The row carries no
 * `processing_generation_id` for exactly that reason.
 */
async function markCardTarget(
  ctx: IdentityCtx,
  spaceId: string,
  sourceItemId: string,
  now: number,
  delta: EmbeddingCounterDelta,
): Promise<void> {
  const composed = await composeCardTargetInput(ctx, spaceId, sourceItemId);
  if (composed) {
    await upsertEligibleTarget(
      ctx,
      {
        spaceId,
        targetKind: "card",
        targetId: composed.eventId,
        inputHash: await sha256Utf8(composed.text),
        now,
      },
      delta,
    );
    return;
  }
  // Abandoned, superseded by a generation that is no longer active, or
  // forgotten. The event id is still the target id, so the row is found
  // without the card generation that wrote it.
  const found = await rows<{ id: string; space_id: string }>(
    ctx,
    `SELECT id, space_id FROM kith.events
      WHERE source_item_id = $1 AND event_key = $2 LIMIT 2`,
    [sourceItemId, CARD_TARGET_EVENT_KEY],
  );
  if (found.length > 1) throw new Error("Card event identity is not unique");
  const event = found[0];
  if (!event || event.space_id !== spaceId) return;
  const record = await lockedTarget(ctx, spaceId, "card", event.id);
  if (record) await retireEmbeddingTarget(ctx, record, now, delta);
}

async function markGenerationChunkTargets(
  ctx: IdentityCtx,
  spaceId: string,
  state: SpaceEmbeddingStateRow,
  processingGenerationId: string,
  now: number,
  delta: EmbeddingCounterDelta,
): Promise<void> {
  const generation = await row<{
    id: string;
    space_id: string;
    source_item_id: string | null;
    state: string | null;
  }>(
    ctx,
    `SELECT id, space_id, source_item_id, state
       FROM kith.processing_generations WHERE id = $1`,
    [processingGenerationId],
  );
  if (!generation || generation.space_id !== spaceId) return;
  const item = generation.source_item_id
    ? await loadSourceItem(ctx, generation.source_item_id)
    : null;
  // Section 8.2: a chunk is an embedding target only under the opt-in. The
  // chunk row itself is untouched and stays keyword-indexed either way.
  const account = item?.source_account_id
    ? await loadSourceAccount(ctx, item.source_account_id)
    : null;
  const chunksEligible =
    spaceEmbedsAllChunks(state) ||
    (item !== null && chunkTargetsOptedIn(item, account));
  // The same chain `resolveActiveChunkTarget` validates, read once for the
  // whole generation instead of once per chunk, and without its assertions:
  // a generation this write just deactivated is expected to fail these.
  const generationIsLive =
    chunksEligible &&
    generation.state === "ready" &&
    item !== null &&
    item.space_id === spaceId &&
    item.lifecycle !== "forgetting" &&
    item.lifecycle !== "forgotten" &&
    item.active_generation_id === generation.id;
  const chunks = await rows<ChunkRow>(
    ctx,
    `SELECT id, space_id, processing_generation_id, document_id, text,
            publication_state
       FROM kith.chunks WHERE processing_generation_id = $1
      ORDER BY created_at, id LIMIT $2`,
    [processingGenerationId, MAX_TOUCHED_GENERATION_CHUNKS + 1],
  );
  if (chunks.length > MAX_TOUCHED_GENERATION_CHUNKS) {
    throw new Error("Touched processing generation exceeds its chunk bound");
  }
  for (const chunk of chunks) {
    if (chunk.space_id !== spaceId) {
      throw new Error("Touched chunk belongs to another space");
    }
    if (generationIsLive && chunk.publication_state === "active") {
      await upsertEligibleTarget(
        ctx,
        {
          spaceId,
          targetKind: "chunk",
          targetId: chunk.id,
          inputHash: await sha256Utf8(chunk.text ?? ""),
          processingGenerationId,
          now,
        },
        delta,
      );
      continue;
    }
    const record = await lockedTarget(ctx, spaceId, "chunk", chunk.id);
    if (record) await retireEmbeddingTarget(ctx, record, now, delta);
  }
}

/**
 * I3 and I4 for an ordinary write: the targets this transaction touched are
 * upserted or retired and their counter deltas are committed here, in the same
 * transaction. Nothing reads the rest of the space.
 */
export async function applyEligibilityTouch(
  ctx: IdentityCtx,
  state: SpaceEmbeddingStateRow,
  touch: EmbeddingEligibilityTouch,
  now: number = ctx.now,
): Promise<void> {
  const thoughtIds = [...new Set(touch.thoughtIds ?? [])];
  const generationIds = [...new Set(touch.processingGenerationIds ?? [])];
  const sourceItemIds = [...new Set(touch.sourceItemIds ?? [])];
  if (thoughtIds.length > MAX_TOUCHED_THOUGHTS) {
    throw new Error("Eligibility write touches too many thoughts");
  }
  if (generationIds.length > MAX_TOUCHED_GENERATIONS) {
    throw new Error(
      "Eligibility write touches too many processing generations",
    );
  }
  if (sourceItemIds.length > MAX_TOUCHED_SOURCE_ITEMS) {
    throw new Error("Eligibility write touches too many source items");
  }
  if (
    thoughtIds.length === 0 &&
    generationIds.length === 0 &&
    sourceItemIds.length === 0
  ) {
    return;
  }
  const delta = emptyCounterDelta();
  for (const thoughtId of thoughtIds) {
    await markThoughtTarget(ctx, state.space_id, thoughtId, now, delta);
  }
  for (const generationId of generationIds) {
    await markGenerationChunkTargets(
      ctx,
      state.space_id,
      state,
      generationId,
      now,
      delta,
    );
  }
  for (const sourceItemId of sourceItemIds) {
    await markCardTarget(ctx, state.space_id, sourceItemId, now, delta);
  }
  await commitCounterDelta(ctx, state, delta, now);
}

/**
 * Marks the targets a write touched without bumping the epoch. Use it when the
 * transaction has to mark a target eligible *before* inserting its vector, so
 * the insert finds a row to mark covered; the epoch bump then follows the
 * insert as it always has. A space whose counters are not seeded is untouched.
 */
export async function markEligibilityTargets(
  ctx: IdentityCtx,
  spaceId: string,
  touch: EmbeddingEligibilityTouch,
): Promise<boolean> {
  const state = await ensureSpaceEmbeddingState(ctx, spaceId);
  if (!usesTargetCounters(state)) return false;
  await applyEligibilityTouch(ctx, state, touch, ctx.now);
  return true;
}

/**
 * Call after an eligibility-changing write, in the same transaction, naming the
 * targets the write touched. On a counted space this upserts or retires exactly
 * those targets, applies their counter deltas and mirrors the counters onto the
 * active generation row. It reads the touched targets and one state row, never
 * the space.
 */
export async function bumpEmbeddingEligibilityEpoch(
  ctx: IdentityCtx,
  spaceId: string,
  touch?: EmbeddingEligibilityTouch,
): Promise<number> {
  const state = await ensureSpaceEmbeddingState(ctx, spaceId);
  const nextEpoch = countOf(state.eligibility_epoch, "Eligibility epoch") + 1;
  if (!Number.isSafeInteger(nextEpoch)) {
    throw new Error("Embedding eligibility epoch is exhausted");
  }
  await exec(
    ctx,
    "UPDATE kith.space_embedding_states SET eligibility_epoch = $2 WHERE id = $1",
    [state.id, nextEpoch],
  );
  if (usesTargetCounters(state)) {
    await applyEligibilityTouch(ctx, state, touch ?? {}, ctx.now);
  }
  if (state.active_embedding_generation_id) {
    const generation = await row<{
      id: string;
      space_id: string;
      state: string | null;
    }>(
      ctx,
      "SELECT id, space_id, state FROM kith.embedding_generations WHERE id = $1",
      [state.active_embedding_generation_id],
    );
    if (
      !generation ||
      generation.state !== "active" ||
      generation.space_id !== spaceId
    ) {
      throw new Error("Active embedding generation pointer is invalid");
    }
    await exec(
      ctx,
      "UPDATE kith.embedding_generations SET eligibility_epoch = $2 WHERE id = $1",
      [generation.id, nextEpoch],
    );
  }
  return nextEpoch;
}

/**
 * Seeds the target table and the counters from a whole-space manifest that has
 * just been validated in full, in the same transaction that activates it.
 *
 * It runs only for a space that has never been counted, which is exactly a
 * space with no target rows, so it cannot double count. It is what lets an
 * empty-space capture bootstrap and a profile transition leave behind a counted
 * space without a separate backfill run.
 */
export async function seedTargetsFromManifest(
  ctx: IdentityCtx,
  state: SpaceEmbeddingStateRow,
  fingerprint: string,
  targets: ReadonlyArray<{
    kind: "thought" | "chunk";
    targetId: string;
    inputHash: string;
    processingGenerationId?: string;
  }>,
  now: number,
): Promise<boolean> {
  if (state.eligible_counts !== null && state.eligible_counts !== undefined) {
    return false;
  }
  const eligible = { thought: 0, chunk: 0, card: 0 };
  for (const target of targets) {
    await exec(
      ctx,
      `INSERT INTO kith.embedding_targets
         (id, space_id, created_at, target_kind, target_id, input_hash,
          processing_generation_id, state, covered_fingerprint, updated_at)
       VALUES ($1, $2, transaction_timestamp(), $3, $4, $5, $6, 'eligible', $7, $8)`,
      [
        newKithId(),
        state.space_id,
        target.kind,
        target.targetId,
        target.inputHash,
        target.processingGenerationId ?? null,
        fingerprint,
        at(now),
      ],
    );
    eligible[target.kind] += 1;
  }
  const covered = [
    ...coveredCountList(state.covered_counts).filter(
      (entry) => entry.fingerprint !== fingerprint,
    ),
    { fingerprint, counts: { ...eligible } },
  ];
  await exec(
    ctx,
    `UPDATE kith.space_embedding_states
        SET eligible_counts = $2::jsonb, covered_counts = $3::jsonb,
            counter_drift = false, last_audit_at = $4,
            last_eligibility_change_at = $4
      WHERE id = $1`,
    [state.id, JSON.stringify(eligible), JSON.stringify(covered), at(now)],
  );
  return true;
}

/**
 * One page of the targets a fingerprint still owes. An eligible row with no
 * coverage marker is exactly an owed target, so this index page is the whole
 * query: covering a target removes it from the page, which is why the provider
 * fill needs no cursor and why replaying it writes nothing twice.
 */
export async function owedTargetsPage(
  ctx: IdentityCtx,
  spaceId: string,
  limit: number = EMBEDDING_FILL_PAGE,
): Promise<EmbeddingTargetWriteRow[]> {
  return await rows<EmbeddingTargetWriteRow>(
    ctx,
    `SELECT ${EMBEDDING_TARGET_COLUMNS} FROM kith.embedding_targets
      WHERE space_id = $1 AND state = 'eligible' AND covered_fingerprint IS NULL
      ORDER BY created_at, id LIMIT $2`,
    [spaceId, Math.min(Math.max(limit, 1), EMBEDDING_FILL_PAGE)],
  );
}

/** The write-side read of one target row, without a lock. */
export async function findEmbeddingTargetRow(
  ctx: IdentityCtx,
  spaceId: string,
  targetKind: EmbeddingTargetKind,
  targetId: string,
): Promise<EmbeddingTargetWriteRow | null> {
  const found = await rows<EmbeddingTargetWriteRow>(
    ctx,
    `SELECT ${EMBEDDING_TARGET_COLUMNS} FROM kith.embedding_targets
      WHERE space_id = $1 AND target_kind = $2 AND target_id = $3 LIMIT 2`,
    [spaceId, targetKind, targetId],
  );
  if (found.length > 1) throw new Error("Duplicate embedding target row");
  return found[0] ?? null;
}

export { findEmbeddingTarget, lockedTarget };
