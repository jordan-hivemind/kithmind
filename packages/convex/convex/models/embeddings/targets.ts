import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { sha256Hex } from "../ingestion/hash";
import {
  CARD_TARGET_EVENT_KEY,
  chunkTargetsOptedIn,
  composeCardTargetInput,
  spaceEmbedsAllChunks,
} from "./cardTargets";

/**
 * Durable, resumable target bookkeeping for the embedding index.
 *
 * `embeddingTargets` holds one row per eligible target per space and the space
 * state holds the transactional counters those rows are summarised by. Nothing
 * here is read by a retrieval path: the reader cutover is a later PR.
 */

/** Design ceiling from the index-capacity plan. No page bound may preclude it. */
export const EMBEDDING_TARGET_CAPACITY_CEILING = 50_000;

/** Per-stage page bounds, sized from the plan's read and write budgets. */
export const EMBEDDING_THOUGHT_SCAN_PAGE = 64;
export const EMBEDDING_CHUNK_SCAN_PAGE = 128;
/** Plan section 1.4: a card row is ~2 KiB of text, so 128 per page. */
export const EMBEDDING_CARD_SCAN_PAGE = 128;
export const EMBEDDING_TARGET_PAGE = 128;

/** A space row stays small: active plus retired fingerprints, never a history. */
const MAX_COVERED_FINGERPRINTS = 16;

export type EmbeddingTargetKind = "thought" | "chunk" | "card";

export type EmbeddingKindCounts = {
  thought: number;
  chunk: number;
  card: number;
};

export const ZERO_KIND_COUNTS: EmbeddingKindCounts = {
  thought: 0,
  chunk: 0,
  card: 0,
};

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

/**
 * I2: the generation-free vector scope. A pure function of space, fingerprint
 * and target kind, with the space first so one equality comparison still
 * isolates a space.
 */
export function embeddingVectorScopeV2(input: {
  spaceId: Id<"spaces"> | string;
  fingerprint: string;
  targetKind: EmbeddingTargetKind;
}): string {
  return JSON.stringify([
    "embedding-vector-scope-v2",
    String(input.spaceId),
    input.fingerprint,
    input.targetKind,
  ]);
}

export function isCurrentThought(thought: Doc<"thoughts">): boolean {
  return (
    thought.memoryStatus === undefined || thought.memoryStatus === "current"
  );
}

// ---------------------------------------------------------------------------
// Counter deltas
// ---------------------------------------------------------------------------

/**
 * Signed counter changes accumulated while a page runs, then written once.
 * Every delta is committed in the same transaction as the rows that caused it,
 * which is what I4 requires.
 */
export type EmbeddingCounterDelta = {
  eligible: EmbeddingKindCounts;
  covered: Map<string, EmbeddingKindCounts>;
  /** P2-6f: thoughts that left the current bucket in this transaction. */
  history: HistoricalThoughtCounts;
};

export type HistoricalThoughtCounts = { superseded: number; retracted: number };

export const ZERO_HISTORICAL_COUNTS: HistoricalThoughtCounts = {
  superseded: 0,
  retracted: 0,
};

export function emptyCounterDelta(): EmbeddingCounterDelta {
  return {
    eligible: { ...ZERO_KIND_COUNTS },
    covered: new Map(),
    history: { ...ZERO_HISTORICAL_COUNTS },
  };
}

export function addHistoryDelta(
  delta: EmbeddingCounterDelta,
  bucket: keyof HistoricalThoughtCounts,
  amount: number,
): void {
  delta.history[bucket] += amount;
}

export function addEligibleDelta(
  delta: EmbeddingCounterDelta,
  kind: EmbeddingTargetKind,
  amount: number,
): void {
  delta.eligible[kind] += amount;
}

export function addCoveredDelta(
  delta: EmbeddingCounterDelta,
  fingerprint: string,
  kind: EmbeddingTargetKind,
  amount: number,
): void {
  const counts = delta.covered.get(fingerprint) ?? { ...ZERO_KIND_COUNTS };
  counts[kind] += amount;
  delta.covered.set(fingerprint, counts);
}

function counterDeltaIsEmpty(delta: EmbeddingCounterDelta): boolean {
  const eligibleChanged = (Object.values(delta.eligible) as number[]).some(
    (value) => value !== 0,
  );
  if (eligibleChanged) return false;
  if (delta.history.superseded !== 0 || delta.history.retracted !== 0) {
    return false;
  }
  for (const counts of delta.covered.values()) {
    if ((Object.values(counts) as number[]).some((value) => value !== 0)) {
      return false;
    }
  }
  return true;
}

function eligibleChanged(delta: EmbeddingCounterDelta): boolean {
  return (Object.values(delta.eligible) as number[]).some(
    (value) => value !== 0,
  );
}

function addKindCounts(
  base: EmbeddingKindCounts,
  addend: EmbeddingKindCounts,
): EmbeddingKindCounts {
  const sum = {
    thought: base.thought + addend.thought,
    chunk: base.chunk + addend.chunk,
    card: base.card + addend.card,
  };
  for (const [kind, value] of Object.entries(sum)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Embedding ${kind} counter went out of range`);
    }
  }
  return sum;
}

function addHistoricalCounts(
  base: HistoricalThoughtCounts,
  addend: HistoricalThoughtCounts,
): HistoricalThoughtCounts {
  const sum = {
    superseded: base.superseded + addend.superseded,
    retracted: base.retracted + addend.retracted,
  };
  for (const [bucket, value] of Object.entries(sum)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Historical ${bucket} thought counter went out of range`);
    }
  }
  return sum;
}

export function coveredCountsFor(
  state: Doc<"spaceEmbeddingStates">,
  fingerprint: string,
): EmbeddingKindCounts {
  const row = state.coveredCounts?.find(
    (entry) => entry.fingerprint === fingerprint,
  );
  return row ? { ...row.counts } : { ...ZERO_KIND_COUNTS };
}

/**
 * True once a space's counters have been seeded by a target backfill and one
 * full audit has confirmed them, which is I5's watermark. Until then an
 * eligibility write keeps the legacy whole-space derive, so a space that has
 * never run the backfill behaves exactly as it did before P2-6c. P2-6g runs
 * the backfill everywhere and P2-6d deletes the legacy branch.
 */
export function usesTargetCounters(
  state: Doc<"spaceEmbeddingStates">,
): boolean {
  return state.eligibleCounts !== undefined && state.lastAuditAt !== undefined;
}

export type SpaceEmbeddingCoverage = {
  spaceId: Id<"spaces">;
  status: "unknown" | "complete" | "incomplete";
  fingerprint?: string;
  eligible?: EmbeddingKindCounts;
  covered?: EmbeddingKindCounts;
  drift: boolean;
  lastAuditAt?: number;
};

export type SpaceCounterReport = {
  coverage: SpaceEmbeddingCoverage;
  /**
   * Lifecycle counts, or null for a space whose counters were never seeded.
   * `current` is the eligible thought counter: a thought target is eligible
   * exactly when its thought is lifecycle-current.
   */
  thoughtCounts: {
    current: number;
    superseded: number;
    retracted: number;
  } | null;
};

/**
 * P2-6f: everything the stats surfaces report about a space, from one row.
 * No thought row, no target row and no vector row is read here.
 */
export async function readSpaceCounters(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
): Promise<SpaceCounterReport> {
  const state = await ctx.db
    .query("spaceEmbeddingStates")
    .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
    .unique();
  const drift = state?.counterDrift === true;
  if (!state || !usesTargetCounters(state)) {
    return {
      coverage: { spaceId, status: "unknown", drift },
      thoughtCounts: null,
    };
  }
  const eligible = state.eligibleCounts ?? { ...ZERO_KIND_COUNTS };
  const fingerprint = state.activeFingerprint;
  const covered = fingerprint
    ? coveredCountsFor(state, fingerprint)
    : { ...ZERO_KIND_COUNTS };
  // Card targets carry no vector until the card model lands, so they are not
  // part of the completeness test yet.
  const complete =
    fingerprint !== undefined &&
    !drift &&
    covered.thought === eligible.thought &&
    covered.chunk === eligible.chunk;
  const history = state.historicalThoughtCounts;
  return {
    coverage: {
      spaceId,
      status: complete ? "complete" : "incomplete",
      ...(fingerprint === undefined ? {} : { fingerprint }),
      eligible,
      covered,
      drift,
      ...(state.lastAuditAt === undefined
        ? {}
        : { lastAuditAt: state.lastAuditAt }),
    },
    thoughtCounts: history
      ? {
          current: eligible.thought,
          superseded: history.superseded,
          retracted: history.retracted,
        }
      : null,
  };
}

/**
 * Mirrors the counters onto the active generation row. This is the O(1)
 * replacement for the whole-space derive that used to refresh those counts on
 * every eligibility write: the reader still reads the generation row until the
 * P2-6d cutover, so the row has to stay accurate, but it no longer costs a
 * scan. `manifestHash` is deliberately left alone; section 5 of the plan
 * records that it stops being recomputable once the single-transaction scan is
 * gone and becomes audit evidence only.
 */
async function refreshActiveGenerationCounts(
  ctx: MutationCtx,
  stateId: Id<"spaceEmbeddingStates">,
): Promise<void> {
  const state = await ctx.db.get(stateId);
  if (!state || !usesTargetCounters(state)) return;
  const generationId = state.activeEmbeddingGenerationId;
  if (!generationId || !state.activeFingerprint) return;
  const generation = await ctx.db.get(generationId);
  if (
    !generation ||
    generation.spaceId !== state.spaceId ||
    generation.state !== "active" ||
    generation.fingerprint !== state.activeFingerprint
  ) {
    return;
  }
  const eligible = state.eligibleCounts ?? ZERO_KIND_COUNTS;
  const covered = coveredCountsFor(state, state.activeFingerprint);
  await ctx.db.patch(generation._id, {
    expectedThoughtCount: eligible.thought,
    expectedChunkCount: eligible.chunk,
    completedThoughtCount: covered.thought,
    completedChunkCount: covered.chunk,
    coverageInvalid: false,
    thoughtCoverageInvalid: false,
    chunkCoverageInvalid: false,
  });
}

/** Writes an accumulated delta onto the space state in one patch. */
export async function commitCounterDelta(
  ctx: MutationCtx,
  state: Doc<"spaceEmbeddingStates">,
  delta: EmbeddingCounterDelta,
  now: number,
): Promise<void> {
  if (counterDeltaIsEmpty(delta)) return;
  const patch: Partial<Doc<"spaceEmbeddingStates">> = {};
  if (eligibleChanged(delta)) {
    patch.eligibleCounts = addKindCounts(
      state.eligibleCounts ?? ZERO_KIND_COUNTS,
      delta.eligible,
    );
    patch.lastEligibilityChangeAt = now;
  }
  if (delta.covered.size > 0) {
    const covered = new Map(
      (state.coveredCounts ?? []).map((entry) => [
        entry.fingerprint,
        entry.counts,
      ]),
    );
    for (const [fingerprint, counts] of delta.covered) {
      covered.set(
        fingerprint,
        addKindCounts(covered.get(fingerprint) ?? ZERO_KIND_COUNTS, counts),
      );
    }
    if (covered.size > MAX_COVERED_FINGERPRINTS) {
      throw new Error(
        "Embedding covered counters exceed their fingerprint cap",
      );
    }
    patch.coveredCounts = [...covered].map(([fingerprint, counts]) => ({
      fingerprint,
      counts,
    }));
  }
  // Only a counted space carries history counts. A space that has never run a
  // scan keeps them absent, and `get_stats` falls back to its bounded scan
  // there rather than reporting a counter that started life at zero.
  if (
    state.historicalThoughtCounts !== undefined &&
    (delta.history.superseded !== 0 || delta.history.retracted !== 0)
  ) {
    patch.historicalThoughtCounts = addHistoricalCounts(
      state.historicalThoughtCounts,
      delta.history,
    );
  }
  await ctx.db.patch(state._id, patch);
  await refreshActiveGenerationCounts(ctx, state._id);
}

// ---------------------------------------------------------------------------
// Target rows
// ---------------------------------------------------------------------------

export async function findEmbeddingTarget(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
  targetKind: EmbeddingTargetKind,
  targetId: string,
): Promise<Doc<"embeddingTargets"> | null> {
  const rows = await ctx.db
    .query("embeddingTargets")
    .withIndex("by_space_kind_target", (q) =>
      q
        .eq("spaceId", spaceId)
        .eq("targetKind", targetKind)
        .eq("targetId", targetId),
    )
    .take(2);
  if (rows.length > 1) throw new Error("Duplicate embedding target row");
  return rows[0] ?? null;
}

/**
 * Creates or refreshes the row for an eligible target. A changed `inputHash`
 * drops the coverage marker, because the vector that covered the old text no
 * longer covers this target.
 */
export async function upsertEligibleTarget(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    targetKind: EmbeddingTargetKind;
    targetId: string;
    inputHash: string;
    processingGenerationId?: Id<"processingGenerations">;
    now: number;
  },
  delta: EmbeddingCounterDelta,
): Promise<"created" | "changed" | "unchanged"> {
  const existing = await findEmbeddingTarget(
    ctx,
    input.spaceId,
    input.targetKind,
    input.targetId,
  );
  if (!existing) {
    await ctx.db.insert("embeddingTargets", {
      spaceId: input.spaceId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      inputHash: input.inputHash,
      ...(input.processingGenerationId
        ? { processingGenerationId: input.processingGenerationId }
        : {}),
      state: "eligible",
      updatedAt: input.now,
    });
    addEligibleDelta(delta, input.targetKind, 1);
    return "created";
  }
  const hashChanged = existing.inputHash !== input.inputHash;
  const parentChanged =
    existing.processingGenerationId !== input.processingGenerationId;
  const wasRetired = existing.state === "retired";
  if (!hashChanged && !parentChanged && !wasRetired) {
    // Touching the row is what lets the scan sweep find rows it never visited.
    await ctx.db.patch(existing._id, { updatedAt: input.now });
    return "unchanged";
  }
  if (wasRetired) addEligibleDelta(delta, input.targetKind, 1);
  const dropsCoverage = hashChanged || parentChanged || wasRetired;
  if (dropsCoverage && existing.coveredFingerprint) {
    addCoveredDelta(delta, existing.coveredFingerprint, input.targetKind, -1);
  }
  await ctx.db.patch(existing._id, {
    inputHash: input.inputHash,
    processingGenerationId: input.processingGenerationId,
    state: "eligible",
    coveredFingerprint: dropsCoverage ? undefined : existing.coveredFingerprint,
    updatedAt: input.now,
  });
  return wasRetired ? "created" : "changed";
}

/**
 * Seeds the target table and the counters from a whole-space manifest that has
 * just been validated in full, in the same transaction that activates it.
 *
 * It runs only for a space that has never been counted, which is exactly a
 * space with no target rows, so it cannot double count. It is what lets an
 * empty-space capture bootstrap and a profile transition leave behind a
 * counted space without a separate backfill run; a space that was already
 * active before P2-6ab still needs the P2-6g backfill.
 */
export async function seedTargetsFromManifest(
  ctx: MutationCtx,
  state: Doc<"spaceEmbeddingStates">,
  fingerprint: string,
  targets: ReadonlyArray<{
    kind: "thought" | "chunk";
    targetId: string;
    inputHash: string;
    processingGenerationId?: Id<"processingGenerations">;
  }>,
  now: number,
): Promise<boolean> {
  if (state.eligibleCounts !== undefined) return false;
  const eligible = { ...ZERO_KIND_COUNTS };
  for (const target of targets) {
    await ctx.db.insert("embeddingTargets", {
      spaceId: state.spaceId,
      targetKind: target.kind,
      targetId: target.targetId,
      inputHash: target.inputHash,
      ...(target.processingGenerationId
        ? { processingGenerationId: target.processingGenerationId }
        : {}),
      state: "eligible",
      coveredFingerprint: fingerprint,
      updatedAt: now,
    });
    eligible[target.kind] += 1;
  }
  await ctx.db.patch(state._id, {
    eligibleCounts: eligible,
    coveredCounts: [
      ...(state.coveredCounts ?? []).filter(
        (entry) => entry.fingerprint !== fingerprint,
      ),
      { fingerprint, counts: { ...eligible } },
    ],
    counterDrift: false,
    lastAuditAt: now,
    lastEligibilityChangeAt: now,
  });
  return true;
}

export async function retireEmbeddingTarget(
  ctx: MutationCtx,
  row: Doc<"embeddingTargets">,
  now: number,
  delta: EmbeddingCounterDelta,
): Promise<void> {
  if (row.state === "retired") return;
  addEligibleDelta(delta, row.targetKind, -1);
  if (row.coveredFingerprint) {
    addCoveredDelta(delta, row.coveredFingerprint, row.targetKind, -1);
  }
  await ctx.db.patch(row._id, {
    state: "retired",
    coveredFingerprint: undefined,
    updatedAt: now,
  });
}

/**
 * I4, covered half: called from the transaction that inserted or deleted the
 * vector, never from a later reconciliation of its own.
 */
export async function setTargetCoverage(
  ctx: MutationCtx,
  row: Doc<"embeddingTargets">,
  fingerprint: string | undefined,
  now: number,
  delta: EmbeddingCounterDelta,
): Promise<boolean> {
  if (row.coveredFingerprint === fingerprint) return false;
  if (row.coveredFingerprint) {
    addCoveredDelta(delta, row.coveredFingerprint, row.targetKind, -1);
  }
  if (fingerprint) addCoveredDelta(delta, fingerprint, row.targetKind, 1);
  await ctx.db.patch(row._id, {
    coveredFingerprint: fingerprint,
    updatedAt: now,
  });
  return true;
}

/**
 * Maintains the coverage marker and counters for a vector write or delete.
 * A space with no target rows yet is untouched, so this is dormant until the
 * backfill has seeded the table.
 */
export async function recordVectorCoverageChange(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    targetKind: EmbeddingTargetKind;
    targetId: string;
    fingerprint: string;
    inputHash: string;
    covered: boolean;
    now: number;
  },
): Promise<void> {
  const row = await findEmbeddingTarget(
    ctx,
    input.spaceId,
    input.targetKind,
    input.targetId,
  );
  if (!row || row.state !== "eligible") return;
  if (input.covered && row.inputHash !== input.inputHash) return;
  if (!input.covered && row.coveredFingerprint !== input.fingerprint) return;
  const state = await ctx.db
    .query("spaceEmbeddingStates")
    .withIndex("by_spaceId", (q) => q.eq("spaceId", input.spaceId))
    .unique();
  if (!state) return;
  // The marker is single valued, so only the active fingerprint may claim it.
  // A generation staged under a new fingerprint would otherwise take the
  // marker from the live index and report the active profile as uncovered,
  // which section 3.4 point 2 says a staged build must never do. Its own
  // coverage is established by a build job under that fingerprint.
  if (
    input.covered &&
    state.activeFingerprint !== undefined &&
    state.activeFingerprint !== input.fingerprint
  ) {
    return;
  }
  const delta = emptyCounterDelta();
  await setTargetCoverage(
    ctx,
    row,
    input.covered ? input.fingerprint : undefined,
    input.now,
    delta,
  );
  await commitCounterDelta(ctx, state, delta, input.now);
}

// ---------------------------------------------------------------------------
// P2-6c: per-target eligibility writes
// ---------------------------------------------------------------------------

/**
 * The targets one eligibility write touched. A caller names what it changed,
 * never the space: a thought by id, and a set of chunks by the processing
 * generation that owns them, which is the unit a document publish or retire
 * moves. Eligibility itself is re-read from the live rows rather than asserted
 * by the caller, so a replay of the same write is a no-op and a caller cannot
 * mislabel a target.
 */
export type EmbeddingEligibilityTouch = {
  thoughtIds?: Id<"thoughts">[];
  processingGenerationIds?: Id<"processingGenerations">[];
  /** P2-70j: the items whose generic card target this write changed. */
  sourceItemIds?: Id<"sourceItems">[];
};

/** A supersede transition carries at most one new and ten previous memories. */
const MAX_TOUCHED_THOUGHTS = 32;
/** A publish touches the new generation and the one it replaces. */
const MAX_TOUCHED_GENERATIONS = 4;
/** A card publication or a forget touches exactly one item. */
const MAX_TOUCHED_SOURCE_ITEMS = 4;
/** Matches the activation chunk bound in the provenance model. */
const MAX_TOUCHED_GENERATION_CHUNKS = 256;

/** Rows the provider fill still owes under a fingerprint, one page at a time. */
export const EMBEDDING_FILL_PAGE = 32;

async function markThoughtTarget(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
  thoughtId: Id<"thoughts">,
  now: number,
  delta: EmbeddingCounterDelta,
): Promise<void> {
  const thought = await ctx.db.get(thoughtId);
  const eligible =
    thought !== null &&
    thought.spaceId === spaceId &&
    isCurrentThought(thought);
  if (eligible) {
    await upsertEligibleTarget(
      ctx,
      {
        spaceId,
        targetKind: "thought",
        targetId: String(thoughtId),
        inputHash: await sha256Hex(thought.content),
        now,
      },
      delta,
    );
    return;
  }
  const row = await findEmbeddingTarget(
    ctx,
    spaceId,
    "thought",
    String(thoughtId),
  );
  if (!row) return;
  // I4 for the stats counters (P2-6f): a thought leaves the current bucket
  // exactly when its eligible target is retired for a non-current status, and
  // that transition is one-way, so this is the only increment the counts need.
  // ponytail: a revive would double count. No path returns a superseded or
  // retracted memory to current; add a decrement here if one ever does.
  if (
    row.state === "eligible" &&
    thought !== null &&
    thought.spaceId === spaceId &&
    (thought.memoryStatus === "superseded" ||
      thought.memoryStatus === "retracted")
  ) {
    addHistoryDelta(delta, thought.memoryStatus, 1);
  }
  await retireEmbeddingTarget(ctx, row, now, delta);
}

/**
 * P2-70j: the generic card target of one source item. Its identity is the
 * card `events` row, which survives re-extraction, so an unchanged card keeps
 * its vector across card generations (I3). The row carries no
 * `processingGenerationId` for exactly that reason: a new card generation
 * over unchanged text must not drop coverage.
 */
async function markCardTarget(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
  sourceItemId: Id<"sourceItems">,
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
        targetId: String(composed.eventId),
        inputHash: await sha256Hex(composed.text),
        now,
      },
      delta,
    );
    return;
  }
  // Abandoned, superseded by a generation that is no longer active, or
  // forgotten. The event id is still the target id, so the row is found
  // without the card generation that wrote it.
  const event = await ctx.db
    .query("events")
    .withIndex("by_sourceItemId_and_eventKey", (q) =>
      q.eq("sourceItemId", sourceItemId).eq("eventKey", CARD_TARGET_EVENT_KEY),
    )
    .unique();
  if (!event || event.spaceId !== spaceId) return;
  const row = await findEmbeddingTarget(ctx, spaceId, "card", String(event._id));
  if (row) await retireEmbeddingTarget(ctx, row, now, delta);
}

async function markGenerationChunkTargets(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
  state: Doc<"spaceEmbeddingStates">,
  processingGenerationId: Id<"processingGenerations">,
  now: number,
  delta: EmbeddingCounterDelta,
): Promise<void> {
  const generation = await ctx.db.get(processingGenerationId);
  if (!generation || generation.spaceId !== spaceId) return;
  const item = await ctx.db.get(generation.sourceItemId);
  // Section 8.2: a chunk is an embedding target only under the opt-in. The
  // chunk row itself is untouched and stays keyword-indexed either way.
  const account = item ? await ctx.db.get(item.sourceAccountId) : null;
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
    item.spaceId === spaceId &&
    item.lifecycle !== "forgetting" &&
    item.lifecycle !== "forgotten" &&
    item.activeGenerationId === generation._id;
  const chunks = await ctx.db
    .query("chunks")
    .withIndex("by_processingGenerationId", (q) =>
      q.eq("processingGenerationId", processingGenerationId),
    )
    .take(MAX_TOUCHED_GENERATION_CHUNKS + 1);
  if (chunks.length > MAX_TOUCHED_GENERATION_CHUNKS) {
    throw new Error("Touched processing generation exceeds its chunk bound");
  }
  for (const chunk of chunks) {
    if (chunk.spaceId !== spaceId) {
      throw new Error("Touched chunk belongs to another space");
    }
    if (generationIsLive && chunk.publicationState === "active") {
      await upsertEligibleTarget(
        ctx,
        {
          spaceId,
          targetKind: "chunk",
          targetId: String(chunk._id),
          inputHash: await sha256Hex(chunk.text),
          processingGenerationId,
          now,
        },
        delta,
      );
      continue;
    }
    const row = await findEmbeddingTarget(
      ctx,
      spaceId,
      "chunk",
      String(chunk._id),
    );
    if (row) await retireEmbeddingTarget(ctx, row, now, delta);
  }
}

/**
 * I3 and I4 for an ordinary write: the targets this transaction touched are
 * upserted or retired and their counter deltas are committed here, in the same
 * transaction. Nothing reads the rest of the space.
 */
export async function applyEligibilityTouch(
  ctx: MutationCtx,
  state: Doc<"spaceEmbeddingStates">,
  touch: EmbeddingEligibilityTouch,
  now: number,
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
    await markThoughtTarget(ctx, state.spaceId, thoughtId, now, delta);
  }
  for (const generationId of generationIds) {
    await markGenerationChunkTargets(
      ctx,
      state.spaceId,
      state,
      generationId,
      now,
      delta,
    );
  }
  for (const sourceItemId of sourceItemIds) {
    await markCardTarget(ctx, state.spaceId, sourceItemId, now, delta);
  }
  await commitCounterDelta(ctx, state, delta, now);
}

/**
 * One page of the targets a fingerprint still owes. An eligible row with no
 * coverage marker is exactly an owed target, so this index page is the whole
 * query: covering a target removes it from the page, which is why the provider
 * fill in `fill.ts` needs no cursor and why replaying it writes nothing twice.
 */
export async function owedTargetsPage(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
  limit: number = EMBEDDING_FILL_PAGE,
): Promise<Doc<"embeddingTargets">[]> {
  return await ctx.db
    .query("embeddingTargets")
    .withIndex("by_space_state_and_coveredFingerprint", (q) =>
      q
        .eq("spaceId", spaceId)
        .eq("state", "eligible")
        .eq("coveredFingerprint", undefined),
    )
    .take(Math.min(Math.max(limit, 1), EMBEDDING_FILL_PAGE));
}

// ---------------------------------------------------------------------------
// Chunk eligibility, shared with the legacy whole-space manifest
// ---------------------------------------------------------------------------

export type ChunkTargetCaches = {
  documents: Map<string, Doc<"documents"> | null>;
  generations: Map<string, Doc<"processingGenerations"> | null>;
  items: Map<string, Doc<"sourceItems"> | null>;
  accounts: Map<string, Doc<"sourceAccounts"> | null>;
  revisions: Map<string, Doc<"sourceRevisions"> | null>;
  textVersions: Map<string, Doc<"sourceTextVersions"> | null>;
};

export function newChunkTargetCaches(): ChunkTargetCaches {
  return {
    documents: new Map(),
    generations: new Map(),
    items: new Map(),
    accounts: new Map(),
    revisions: new Map(),
    textVersions: new Map(),
  };
}

/**
 * Validates an active chunk's whole parent chain. Returns null when the chunk
 * belongs to a forgotten source item, which is a skip rather than a fault.
 */
export async function resolveActiveChunkTarget(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
  chunk: Doc<"chunks">,
  caches: ChunkTargetCaches,
): Promise<{
  processingGenerationId: Id<"processingGenerations">;
  /** Section 8.2: whether this chunk's item carries the full-chunk opt-in. */
  optedIn: boolean;
} | null> {
  let document = caches.documents.get(chunk.documentId);
  if (document === undefined) {
    document = await ctx.db.get(chunk.documentId);
    caches.documents.set(chunk.documentId, document);
  }
  let generation = caches.generations.get(chunk.processingGenerationId);
  if (generation === undefined) {
    generation = await ctx.db.get(chunk.processingGenerationId);
    caches.generations.set(chunk.processingGenerationId, generation);
  }
  const itemId = generation?.sourceItemId;
  let item = itemId ? caches.items.get(itemId) : null;
  if (itemId && item === undefined) {
    item = await ctx.db.get(itemId);
    caches.items.set(itemId, item);
  }
  const accountId = generation?.sourceAccountId;
  let account = accountId ? caches.accounts.get(accountId) : null;
  if (accountId && account === undefined) {
    account = await ctx.db.get(accountId);
    caches.accounts.set(accountId, account);
  }
  const revisionId = generation?.sourceRevisionId;
  let revision = revisionId ? caches.revisions.get(revisionId) : null;
  if (revisionId && revision === undefined) {
    revision = await ctx.db.get(revisionId);
    caches.revisions.set(revisionId, revision);
  }
  const textVersionId = generation?.sourceTextVersionId;
  let textVersion = textVersionId
    ? caches.textVersions.get(textVersionId)
    : null;
  if (textVersionId && textVersion === undefined) {
    textVersion = await ctx.db.get(textVersionId);
    caches.textVersions.set(textVersionId, textVersion);
  }
  if (
    !document ||
    !generation ||
    !item ||
    !account ||
    !revision ||
    !textVersion ||
    document.spaceId !== spaceId ||
    document.processingGenerationId !== generation._id ||
    document.sourceItemId !== item._id ||
    document.sourceRevisionId !== generation.sourceRevisionId ||
    document.sourceTextVersionId !== generation.sourceTextVersionId ||
    document.publicationState !== "active" ||
    generation.spaceId !== spaceId ||
    generation.state !== "ready" ||
    generation.sourceAccountId !== item.sourceAccountId ||
    account.spaceId !== spaceId ||
    revision.spaceId !== spaceId ||
    revision.sourceItemId !== item._id ||
    textVersion.spaceId !== spaceId ||
    textVersion.sourceRevisionId !== revision._id ||
    !textVersion.evidenceSealed ||
    item.spaceId !== spaceId
  ) {
    throw new Error("Active chunk has an invalid processing parent chain");
  }
  if (item.lifecycle === "forgetting" || item.lifecycle === "forgotten") {
    return null;
  }
  if (item.activeGenerationId !== generation._id) {
    throw new Error(
      "Active chunk is not in its source item's active generation",
    );
  }
  if (item.activeRevisionId !== revision._id) {
    throw new Error("Active chunk is not in its source item's active revision");
  }
  return {
    processingGenerationId: generation._id,
    optedIn: chunkTargetsOptedIn(item, account),
  };
}

// ---------------------------------------------------------------------------
// Paged build
// ---------------------------------------------------------------------------

type ScanStage = "thoughts" | "chunks" | "cards" | "sweep";

type ScanCursor = { stage: ScanStage; cursor: string | null };

function encodeScanCursor(value: ScanCursor): string {
  return JSON.stringify([value.stage, value.cursor]);
}

function decodeScanCursor(value: string | null): ScanCursor {
  if (value === null) return { stage: "thoughts", cursor: null };
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    (parsed[0] !== "thoughts" &&
      parsed[0] !== "chunks" &&
      parsed[0] !== "cards" &&
      parsed[0] !== "sweep")
  ) {
    throw new Error("Embedding build cursor is malformed");
  }
  const inner = parsed[1];
  if (inner !== null && typeof inner !== "string") {
    throw new Error("Embedding build cursor is malformed");
  }
  return { stage: parsed[0], cursor: inner };
}

export type BuildPageResult = {
  accepted: boolean;
  phase: Doc<"embeddingBuildJobs">["phase"];
  cursor: string | null;
  pageIndex: number;
  scanned: number;
  filled: number;
  retired: number;
  isDone: boolean;
  counterDrift: boolean;
};

function pageResult(
  job: Doc<"embeddingBuildJobs">,
  overrides: Partial<BuildPageResult> = {},
): BuildPageResult {
  return {
    accepted: true,
    phase: job.phase,
    cursor: job.cursor,
    pageIndex: job.pageIndex,
    scanned: 0,
    filled: 0,
    retired: 0,
    isDone: job.phase === "done" || job.phase === "abandoned",
    counterDrift: false,
    ...overrides,
  };
}

async function requireSpaceState(
  ctx: MutationCtx,
  spaceId: Id<"spaces">,
): Promise<Doc<"spaceEmbeddingStates">> {
  const state = await ctx.db
    .query("spaceEmbeddingStates")
    .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
    .unique();
  if (!state) throw new Error("Space embedding state not found");
  return state;
}

async function runScanPage(
  ctx: MutationCtx,
  job: Doc<"embeddingBuildJobs">,
  batchSize: number,
  now: number,
): Promise<{ cursor: string | null; scanned: number; retired: number }> {
  let state = await requireSpaceState(ctx, job.spaceId);
  if (state.eligibleCounts === undefined) {
    // Seeding the counters at zero is what marks the space as counted. An
    // empty space would otherwise finish a build with absent counters and
    // keep taking the legacy derive forever.
    await ctx.db.patch(state._id, { eligibleCounts: { ...ZERO_KIND_COUNTS } });
  }
  const delta = emptyCounterDelta();
  const position = decodeScanCursor(job.cursor);
  let scanned = 0;
  let retired = 0;
  let next: ScanCursor;

  if (position.stage === "thoughts") {
    if (position.cursor === null) {
      // The thought stage visits every thought in the space exactly once, so
      // it is the one place that can count the historical buckets. Restarting
      // the stage restarts the count.
      state = {
        ...state,
        historicalThoughtCounts: { ...ZERO_HISTORICAL_COUNTS },
      };
      await ctx.db.patch(state._id, {
        historicalThoughtCounts: { ...ZERO_HISTORICAL_COUNTS },
      });
    }
    const page = await ctx.db
      .query("thoughts")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", job.spaceId))
      .paginate({
        cursor: position.cursor,
        numItems: Math.min(batchSize, EMBEDDING_THOUGHT_SCAN_PAGE),
      });
    for (const thought of page.page) {
      if (!isCurrentThought(thought)) {
        if (
          thought.memoryStatus === "superseded" ||
          thought.memoryStatus === "retracted"
        ) {
          addHistoryDelta(delta, thought.memoryStatus, 1);
        }
        continue;
      }
      scanned += 1;
      await upsertEligibleTarget(
        ctx,
        {
          spaceId: job.spaceId,
          targetKind: "thought",
          targetId: String(thought._id),
          inputHash: await sha256Hex(thought.content),
          now,
        },
        delta,
      );
    }
    next = page.isDone
      ? { stage: "chunks", cursor: null }
      : { stage: "thoughts", cursor: page.continueCursor };
  } else if (position.stage === "chunks") {
    const page = await ctx.db
      .query("chunks")
      .withIndex("by_spaceId_and_publicationState", (q) =>
        q.eq("spaceId", job.spaceId).eq("publicationState", "active"),
      )
      .paginate({
        cursor: position.cursor,
        numItems: Math.min(batchSize, EMBEDDING_CHUNK_SCAN_PAGE),
      });
    const caches = newChunkTargetCaches();
    const embedsAllChunks = spaceEmbedsAllChunks(state);
    for (const chunk of page.page) {
      const resolved = await resolveActiveChunkTarget(
        ctx,
        job.spaceId,
        chunk,
        caches,
      );
      if (!resolved) continue;
      // Section 8.2. An ineligible chunk is simply not upserted; the sweep
      // stage retires whatever row it used to have, so a policy flip
      // converges in one rerun of the same build.
      if (!embedsAllChunks && !resolved.optedIn) continue;
      scanned += 1;
      await upsertEligibleTarget(
        ctx,
        {
          spaceId: job.spaceId,
          targetKind: "chunk",
          targetId: String(chunk._id),
          inputHash: await sha256Hex(chunk.text),
          processingGenerationId: resolved.processingGenerationId,
          now,
        },
        delta,
      );
    }
    next = page.isDone
      ? { stage: "cards", cursor: null }
      : { stage: "chunks", cursor: page.continueCursor };
  } else if (position.stage === "cards") {
    // One target per generic card event. The event is the stable identity, so
    // this page never depends on which card generation published it.
    const page = await ctx.db
      .query("events")
      .withIndex("by_spaceId", (q) => q.eq("spaceId", job.spaceId))
      .paginate({
        cursor: position.cursor,
        numItems: Math.min(batchSize, EMBEDDING_CARD_SCAN_PAGE),
      });
    for (const event of page.page) {
      if (event.eventKey !== CARD_TARGET_EVENT_KEY) continue;
      const composed = await composeCardTargetInput(
        ctx,
        job.spaceId,
        event.sourceItemId,
        event,
      );
      if (!composed) continue;
      scanned += 1;
      await upsertEligibleTarget(
        ctx,
        {
          spaceId: job.spaceId,
          targetKind: "card",
          targetId: String(event._id),
          inputHash: await sha256Hex(composed.text),
          now,
        },
        delta,
      );
    }
    next = page.isDone
      ? { stage: "sweep", cursor: null }
      : { stage: "cards", cursor: page.continueCursor };
  } else {
    // Anything still eligible that this run never touched is gone from the
    // live set; retiring it is what makes a rerun converge.
    const page = await ctx.db
      .query("embeddingTargets")
      .withIndex("by_space_and_state", (q) =>
        q.eq("spaceId", job.spaceId).eq("state", "eligible"),
      )
      .paginate({
        cursor: position.cursor,
        numItems: Math.min(batchSize, EMBEDDING_TARGET_PAGE),
      });
    for (const row of page.page) {
      if (row.updatedAt >= job.startedAt) continue;
      await retireEmbeddingTarget(ctx, row, now, delta);
      retired += 1;
    }
    next = page.isDone
      ? { stage: "sweep", cursor: null }
      : { stage: "sweep", cursor: page.continueCursor };
    if (page.isDone) {
      await commitCounterDelta(ctx, state, delta, now);
      return { cursor: null, scanned, retired };
    }
  }

  await commitCounterDelta(ctx, state, delta, now);
  return { cursor: encodeScanCursor(next), scanned, retired };
}

/** Finds the vector that covers exactly this target text under a fingerprint. */
async function findCoveringVector(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    fingerprint: string;
    row: Doc<"embeddingTargets">;
  },
): Promise<Doc<"embeddingVectors"> | null> {
  const { row } = input;
  if (row.targetKind === "card") return null;
  const thoughtId =
    row.targetKind === "thought"
      ? ctx.db.normalizeId("thoughts", row.targetId)
      : null;
  const chunkId =
    row.targetKind === "chunk"
      ? ctx.db.normalizeId("chunks", row.targetId)
      : null;
  if (!thoughtId && !chunkId) return null;
  const candidates = thoughtId
    ? await ctx.db
        .query("embeddingVectors")
        .withIndex("by_thoughtId", (q) => q.eq("thoughtId", thoughtId))
        .take(8)
    : await ctx.db
        .query("embeddingVectors")
        .withIndex("by_chunkId", (q) => q.eq("chunkId", chunkId!))
        .take(8);
  return (
    candidates.find(
      (candidate) =>
        candidate.spaceId === input.spaceId &&
        candidate.embeddingFingerprint === input.fingerprint &&
        candidate.targetKind === row.targetKind &&
        candidate.inputHash === row.inputHash,
    ) ?? null
  );
}

async function runFillPage(
  ctx: MutationCtx,
  job: Doc<"embeddingBuildJobs">,
  batchSize: number,
  now: number,
): Promise<{ cursor: string | null; filled: number }> {
  const state = await requireSpaceState(ctx, job.spaceId);
  const delta = emptyCounterDelta();
  const page = await ctx.db
    .query("embeddingTargets")
    .withIndex("by_space_and_state", (q) =>
      q.eq("spaceId", job.spaceId).eq("state", "eligible"),
    )
    .paginate({
      cursor: job.cursor,
      numItems: Math.min(batchSize, EMBEDDING_TARGET_PAGE),
    });
  let filled = 0;
  for (const row of page.page) {
    if (row.coveredFingerprint === job.fingerprint) continue;
    const vector = await findCoveringVector(ctx, {
      spaceId: job.spaceId,
      fingerprint: job.fingerprint,
      row,
    });
    if (!vector) {
      // A marker naming another fingerprint is not coverage of this build.
      // Clearing it is what puts the row back on the owed index, so the
      // provider fill can find it without scanning the space.
      if (row.coveredFingerprint !== undefined) {
        await setTargetCoverage(ctx, row, undefined, now, delta);
      }
      continue;
    }
    await setTargetCoverage(ctx, row, job.fingerprint, now, delta);
    filled += 1;
  }
  await commitCounterDelta(ctx, state, delta, now);
  return { cursor: page.isDone ? null : page.continueCursor, filled };
}

async function runAuditPage(
  ctx: MutationCtx,
  job: Doc<"embeddingBuildJobs">,
  batchSize: number,
): Promise<{
  cursor: string | null;
  scanned: number;
  eligible: EmbeddingKindCounts;
  covered: EmbeddingKindCounts;
}> {
  const page = await ctx.db
    .query("embeddingTargets")
    .withIndex("by_space_kind_target", (q) => q.eq("spaceId", job.spaceId))
    .paginate({
      cursor: job.cursor,
      numItems: Math.min(batchSize, EMBEDDING_TARGET_PAGE),
    });
  const eligible = { ...ZERO_KIND_COUNTS };
  const covered = { ...ZERO_KIND_COUNTS };
  for (const row of page.page) {
    if (row.state !== "eligible") continue;
    eligible[row.targetKind] += 1;
    if (row.coveredFingerprint === job.fingerprint) {
      covered[row.targetKind] += 1;
    }
  }
  return {
    cursor: page.isDone ? null : page.continueCursor,
    scanned: page.page.length,
    eligible,
    covered,
  };
}

function sameCounts(
  left: EmbeddingKindCounts,
  right: EmbeddingKindCounts,
): boolean {
  return (
    left.thought === right.thought &&
    left.chunk === right.chunk &&
    left.card === right.card
  );
}

/**
 * Runs one page of a build under compare-and-set on the stored cursor. A
 * caller passing anything other than the stored cursor is refused and gets the
 * stored cursor back, so a duplicate or late call never writes twice.
 */
export async function runEmbeddingBuildPage(
  ctx: MutationCtx,
  input: {
    jobId: Id<"embeddingBuildJobs">;
    cursor: string | null;
    batchSize?: number;
    now: number;
  },
): Promise<BuildPageResult> {
  const job = await ctx.db.get(input.jobId);
  if (!job) throw new Error("Embedding build job not found");
  if (job.phase === "done" || job.phase === "abandoned") {
    return pageResult(job, { isDone: true });
  }
  if ((job.cursor ?? null) !== (input.cursor ?? null)) {
    return pageResult(job, { accepted: false, isDone: false });
  }
  const batchSize = Math.min(
    Math.max(input.batchSize ?? EMBEDDING_TARGET_PAGE, 1),
    EMBEDDING_TARGET_PAGE,
  );

  if (job.phase === "scan") {
    const result = await runScanPage(ctx, job, batchSize, input.now);
    const done = result.cursor === null;
    await ctx.db.patch(job._id, {
      phase: done ? "fill" : "scan",
      cursor: result.cursor,
      pageIndex: job.pageIndex + 1,
      scannedCount: job.scannedCount + result.scanned,
      retiredCount: job.retiredCount + result.retired,
      updatedAt: input.now,
    });
    return pageResult(job, {
      phase: done ? "fill" : "scan",
      cursor: result.cursor,
      pageIndex: job.pageIndex + 1,
      scanned: result.scanned,
      retired: result.retired,
      isDone: false,
    });
  }

  if (job.phase === "fill") {
    const result = await runFillPage(ctx, job, batchSize, input.now);
    const done = result.cursor === null;
    await ctx.db.patch(job._id, {
      phase: done ? "audit" : "fill",
      cursor: result.cursor,
      pageIndex: job.pageIndex + 1,
      filledCount: job.filledCount + result.filled,
      ...(done
        ? {
            auditEligibleCounts: { ...ZERO_KIND_COUNTS },
            auditCoveredCounts: { ...ZERO_KIND_COUNTS },
          }
        : {}),
      updatedAt: input.now,
    });
    return pageResult(job, {
      phase: done ? "audit" : "fill",
      cursor: result.cursor,
      pageIndex: job.pageIndex + 1,
      filled: result.filled,
      isDone: false,
    });
  }

  const result = await runAuditPage(ctx, job, batchSize);
  const eligible = addKindCounts(
    job.auditEligibleCounts ?? ZERO_KIND_COUNTS,
    result.eligible,
  );
  const covered = addKindCounts(
    job.auditCoveredCounts ?? ZERO_KIND_COUNTS,
    result.covered,
  );
  const done = result.cursor === null;
  let drift = false;
  if (done) {
    const state = await requireSpaceState(ctx, job.spaceId);
    drift =
      !sameCounts(state.eligibleCounts ?? ZERO_KIND_COUNTS, eligible) ||
      !sameCounts(coveredCountsFor(state, job.fingerprint), covered);
    await ctx.db.patch(state._id, {
      counterDrift: drift,
      lastAuditAt: input.now,
    });
  }
  await ctx.db.patch(job._id, {
    phase: done ? "done" : "audit",
    cursor: result.cursor,
    pageIndex: job.pageIndex + 1,
    auditEligibleCounts: eligible,
    auditCoveredCounts: covered,
    updatedAt: input.now,
  });
  return pageResult(job, {
    phase: done ? "done" : "audit",
    cursor: result.cursor,
    pageIndex: job.pageIndex + 1,
    scanned: result.scanned,
    isDone: done,
    counterDrift: drift,
  });
}

/**
 * Recounts the target table and compares it with the stored counters. The
 * recount reads target rows only, so it stays inside one transaction at the
 * production corpus size and reports incompleteness instead of guessing.
 */
export async function auditEmbeddingCounters(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    fingerprint: string;
    maxRows?: number;
    repair?: boolean;
    now: number;
  },
): Promise<{
  complete: boolean;
  scanned: number;
  counterDrift: boolean;
  recountedEligible: EmbeddingKindCounts;
  recountedCovered: EmbeddingKindCounts;
  storedEligible: EmbeddingKindCounts;
  storedCovered: EmbeddingKindCounts;
  repaired: boolean;
}> {
  const state = await requireSpaceState(ctx, input.spaceId);
  const maxRows = Math.min(Math.max(input.maxRows ?? 2048, 1), 4096);
  const rows = await ctx.db
    .query("embeddingTargets")
    .withIndex("by_space_kind_target", (q) => q.eq("spaceId", input.spaceId))
    .take(maxRows + 1);
  const complete = rows.length <= maxRows;
  const eligible = { ...ZERO_KIND_COUNTS };
  const covered = { ...ZERO_KIND_COUNTS };
  for (const row of rows.slice(0, maxRows)) {
    if (row.state !== "eligible") continue;
    eligible[row.targetKind] += 1;
    if (row.coveredFingerprint === input.fingerprint) {
      covered[row.targetKind] += 1;
    }
  }
  const storedEligible = state.eligibleCounts ?? { ...ZERO_KIND_COUNTS };
  const storedCovered = coveredCountsFor(state, input.fingerprint);
  const drift =
    complete &&
    (!sameCounts(storedEligible, eligible) ||
      !sameCounts(storedCovered, covered));
  let repaired = false;
  if (complete) {
    const patch: Partial<Doc<"spaceEmbeddingStates">> = {
      counterDrift: drift,
      lastAuditAt: input.now,
    };
    if (drift && input.repair) {
      const others = (state.coveredCounts ?? []).filter(
        (entry) => entry.fingerprint !== input.fingerprint,
      );
      patch.eligibleCounts = eligible;
      patch.coveredCounts = [
        ...others,
        { fingerprint: input.fingerprint, counts: covered },
      ];
      patch.counterDrift = false;
      repaired = true;
    }
    await ctx.db.patch(state._id, patch);
  }
  return {
    complete,
    scanned: Math.min(rows.length, maxRows),
    counterDrift: drift,
    recountedEligible: eligible,
    recountedCovered: covered,
    storedEligible,
    storedCovered,
    repaired,
  };
}
