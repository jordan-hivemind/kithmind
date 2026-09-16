// P2-39g2: the space's embedding state row, the profile row, and the counters
// every other write in this directory adds to.
//
// Ported from `models/embeddings/model.ts` (`ensureSpaceEmbeddingState`,
// `ensureEmbeddingProfile`) and `models/embeddings/targets.ts` (the counter
// delta type, `commitCounterDelta`, `refreshActiveGenerationCounts`,
// `readSpaceCounters`).
//
// The counters are I4: an eligible counter changes only in the transaction
// that changes eligibility, and a covered counter only in the transaction that
// inserts or deletes a vector. On Convex that fell out of a mutation being one
// transaction. Here it falls out of `withKithTransaction` being one
// `SERIALIZABLE` transaction, plus one thing Convex did not need: every write
// path reads the state row `FOR UPDATE` before it computes a delta, so the
// read that decides the delta and the update that applies it cannot straddle
// another writer's commit. `SERIALIZABLE` would abort one of the two anyway;
// the row lock makes the second one wait instead of burning a retry, which
// matters because a bulk fill is exactly the workload that would generate them.
//
// Counts are `numeric` columns (migration 004 copied the Convex `v.number()`
// shape) and node-pg hands a `numeric` back as a string, so every read of one
// goes through `countOf` rather than being trusted as a number.

import { exec, row, rows, at, type IdentityCtx } from "../identity/db.js";
import { newKithId } from "../ids.js";
import {
  fingerprintEmbeddingConfig,
  BASELINE_EMBEDDING_DIMENSIONS,
  type EmbeddingProfile,
} from "./provider.js";
import type { EmbeddingTargetKind } from "./scope.js";
import {
  coveredCountsFor,
  embeddingKindCounts,
  usesTargetCounters,
  uniqueSpaceState,
  ZERO_KIND_COUNTS,
  type EmbeddingKindCounts,
  type EmbeddingProfileRow,
  type SpaceEmbeddingStateRow,
} from "./targets.js";

export { uniqueSpaceState, ZERO_KIND_COUNTS };
export type { SpaceEmbeddingStateRow };

/** A space row stays small: active plus retired fingerprints, never a history. */
const MAX_COVERED_FINGERPRINTS = 16;

const MAX_PROFILE_VALUE_LENGTH = 200;

/** A space is looked up one at a time; this bounds a coverage composition. */
export const MAX_EMBEDDING_COVERAGE_SPACES = 32;

export type HistoricalThoughtCounts = { superseded: number; retracted: number };

export const ZERO_HISTORICAL_COUNTS: HistoricalThoughtCounts = {
  superseded: 0,
  retracted: 0,
};

/**
 * Signed counter changes accumulated while a page runs, then written once.
 * Every delta is committed in the same transaction as the rows that caused it,
 * which is what I4 requires.
 */
export type EmbeddingCounterDelta = {
  eligible: EmbeddingKindCounts;
  covered: Map<string, EmbeddingKindCounts>;
  /** Thoughts that left the current bucket in this transaction. */
  history: HistoricalThoughtCounts;
};

export function emptyCounterDelta(): EmbeddingCounterDelta {
  return {
    eligible: { ...ZERO_KIND_COUNTS },
    covered: new Map(),
    history: { ...ZERO_HISTORICAL_COUNTS },
  };
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

export function addHistoryDelta(
  delta: EmbeddingCounterDelta,
  bucket: keyof HistoricalThoughtCounts,
  amount: number,
): void {
  delta.history[bucket] += amount;
}

function counterDeltaIsEmpty(delta: EmbeddingCounterDelta): boolean {
  if (eligibleChanged(delta)) return false;
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

export function addKindCounts(
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

export function sameCounts(
  left: EmbeddingKindCounts,
  right: EmbeddingKindCounts,
): boolean {
  return (
    left.thought === right.thought &&
    left.chunk === right.chunk &&
    left.card === right.card
  );
}

/** A `numeric` column, which node-pg returns as a string. */
export function countOf(value: unknown, label: string): number {
  if (value === null || value === undefined) {
    throw new Error(`${label} is missing`);
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${label} is invalid`);
  }
  return count;
}

export function historicalCountsOf(value: unknown): HistoricalThoughtCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Historical thought counters are invalid");
  }
  const record = value as Record<string, unknown>;
  const read = (name: keyof HistoricalThoughtCounts) => {
    const entry = record[name];
    if (
      typeof entry !== "number" ||
      !Number.isSafeInteger(entry) ||
      entry < 0
    ) {
      throw new Error("Historical thought counters are invalid");
    }
    return entry;
  };
  return { superseded: read("superseded"), retracted: read("retracted") };
}

/** The stored covered list, as written. */
export type CoveredCount = {
  fingerprint: string;
  counts: EmbeddingKindCounts;
};

export function coveredCountList(value: unknown): CoveredCount[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Embedding counter is invalid");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Embedding counter is invalid");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.fingerprint !== "string" || !record.fingerprint) {
      throw new Error("Embedding counter is invalid");
    }
    return {
      fingerprint: record.fingerprint,
      counts: embeddingKindCounts(record.counts),
    };
  });
}

/** Section 8.2 of the document-card plan. NULL is `all_chunks`. */
export function spaceEmbedsAllChunks(state: {
  target_policy?: string | null;
}): boolean {
  return (state.target_policy ?? "all_chunks") === "all_chunks";
}

// ---------------------------------------------------------------------------
// The state row and the profile row
// ---------------------------------------------------------------------------

/**
 * Ported from `ensureSpaceEmbeddingState`. Locks the row it finds, or creates
 * one at epoch 0 and locks that, so the caller's delta is computed and applied
 * under one lock.
 */
export async function ensureSpaceEmbeddingState(
  ctx: IdentityCtx,
  spaceId: string,
): Promise<SpaceEmbeddingStateRow> {
  const space = await row<{ id: string }>(
    ctx,
    "SELECT id FROM kith.spaces WHERE id = $1",
    [spaceId],
  );
  if (!space) throw new Error("Embedding space not found");
  const existing = await uniqueSpaceState(ctx, spaceId, true);
  if (existing) return existing;
  await exec(
    ctx,
    `INSERT INTO kith.space_embedding_states
       (id, space_id, created_at, eligibility_epoch)
     VALUES ($1, $2, transaction_timestamp(), 0)`,
    [newKithId(), spaceId],
  );
  const created = await uniqueSpaceState(ctx, spaceId, true);
  if (!created) throw new Error("Space embedding state not found");
  return created;
}

function assertProfile(profile: EmbeddingProfile): void {
  for (const [name, value] of Object.entries(profile)) {
    if (name === "dimensions") continue;
    if (
      typeof value !== "string" ||
      !value ||
      value.length > MAX_PROFILE_VALUE_LENGTH
    ) {
      throw new Error(`Embedding profile ${name} is invalid`);
    }
  }
  if (profile.dimensions !== BASELINE_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding profile dimensions require a future index migration; expected ${BASELINE_EMBEDDING_DIMENSIONS}`,
    );
  }
}

function sameProfile(
  record: EmbeddingProfileRow,
  profile: EmbeddingProfile,
): boolean {
  return (
    record.protocol === profile.protocol &&
    record.provider_id === profile.providerId &&
    record.model === profile.model &&
    record.model_revision === profile.modelRevision &&
    Number(record.dimensions) === profile.dimensions &&
    record.normalization === profile.normalization &&
    record.preprocessing === profile.preprocessing
  );
}

const PROFILE_COLUMNS = `id, fingerprint, protocol, provider_id, model,
  model_revision, dimensions, normalization, preprocessing`;

/**
 * Ported from `ensureEmbeddingProfile`. Idempotent by fingerprint: the same
 * profile returns the same row, and a row whose fields disagree with the
 * fingerprint they are filed under is a collision or a damaged row, never a
 * value to carry forward.
 */
export async function ensureEmbeddingProfile(
  ctx: IdentityCtx,
  input: {
    profile: EmbeddingProfile;
    fingerprint: string;
    createdAt?: number;
  },
): Promise<EmbeddingProfileRow> {
  assertProfile(input.profile);
  const createdAt = input.createdAt ?? ctx.now;
  if (!Number.isFinite(createdAt) || createdAt < 0) {
    throw new Error(
      "Embedding profile creation time must be a non-negative finite timestamp",
    );
  }
  const calculated = await fingerprintEmbeddingConfig(input.profile);
  if (calculated !== input.fingerprint) {
    throw new Error(
      "Embedding profile fingerprint does not match its identity",
    );
  }
  const found = await rows<EmbeddingProfileRow>(
    ctx,
    `SELECT ${PROFILE_COLUMNS} FROM kith.embedding_profiles
      WHERE fingerprint = $1 LIMIT 2`,
    [input.fingerprint],
  );
  if (found.length > 1) {
    throw new Error("Duplicate embedding profile fingerprint");
  }
  const existing = found[0];
  if (existing) {
    if (!sameProfile(existing, input.profile)) {
      throw new Error("Embedding profile fingerprint collision or damaged row");
    }
    return existing;
  }
  const id = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.embedding_profiles
       (id, created_at, fingerprint, protocol, provider_id, model,
        model_revision, dimensions, normalization, preprocessing,
        created_at_field)
     VALUES ($1, transaction_timestamp(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      input.fingerprint,
      input.profile.protocol,
      input.profile.providerId,
      input.profile.model,
      input.profile.modelRevision,
      input.profile.dimensions,
      input.profile.normalization,
      input.profile.preprocessing,
      at(createdAt),
    ],
  );
  const created = await row<EmbeddingProfileRow>(
    ctx,
    `SELECT ${PROFILE_COLUMNS} FROM kith.embedding_profiles WHERE id = $1`,
    [id],
  );
  if (!created) throw new Error("Embedding profile not found");
  return created;
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

/**
 * Mirrors the counters onto the active generation row. This is the O(1)
 * replacement for the whole-space derive that used to refresh those counts on
 * every eligibility write. `manifest_hash` is deliberately left alone: section
 * 5 of the capacity plan records that it stops being recomputable once the
 * single-transaction scan is gone and becomes audit evidence only.
 */
async function refreshActiveGenerationCounts(
  ctx: IdentityCtx,
  stateId: string,
): Promise<void> {
  const state = await row<SpaceEmbeddingStateRow>(
    ctx,
    `SELECT id, space_id, active_embedding_generation_id, active_fingerprint,
            eligible_counts, covered_counts, counter_drift, last_audit_at
       FROM kith.space_embedding_states WHERE id = $1`,
    [stateId],
  );
  if (!state || !usesTargetCounters(state)) return;
  const generationId = state.active_embedding_generation_id;
  if (!generationId || !state.active_fingerprint) return;
  const generation = await row<{
    id: string;
    space_id: string;
    state: string | null;
    fingerprint: string | null;
  }>(
    ctx,
    `SELECT id, space_id, state, fingerprint FROM kith.embedding_generations
      WHERE id = $1`,
    [generationId],
  );
  if (
    !generation ||
    generation.space_id !== state.space_id ||
    generation.state !== "active" ||
    generation.fingerprint !== state.active_fingerprint
  ) {
    return;
  }
  const eligible = embeddingKindCounts(state.eligible_counts);
  const covered = coveredCountsFor(state, state.active_fingerprint);
  await exec(
    ctx,
    `UPDATE kith.embedding_generations
        SET expected_thought_count = $2, expected_chunk_count = $3,
            completed_thought_count = $4, completed_chunk_count = $5,
            coverage_invalid = false, thought_coverage_invalid = false,
            chunk_coverage_invalid = false
      WHERE id = $1`,
    [
      generation.id,
      eligible.thought,
      eligible.chunk,
      covered.thought,
      covered.chunk,
    ],
  );
}

/** Writes an accumulated delta onto the space state in one update. */
export async function commitCounterDelta(
  ctx: IdentityCtx,
  state: SpaceEmbeddingStateRow,
  delta: EmbeddingCounterDelta,
  now: number = ctx.now,
): Promise<void> {
  if (counterDeltaIsEmpty(delta)) return;
  const assignments: string[] = [];
  const values: unknown[] = [state.id];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  if (eligibleChanged(delta)) {
    const next = addKindCounts(
      state.eligible_counts === null || state.eligible_counts === undefined
        ? ZERO_KIND_COUNTS
        : embeddingKindCounts(state.eligible_counts),
      delta.eligible,
    );
    assignments.push(`eligible_counts = ${bind(JSON.stringify(next))}::jsonb`);
    assignments.push(`last_eligibility_change_at = ${bind(at(now))}`);
  }
  if (delta.covered.size > 0) {
    const covered = new Map(
      coveredCountList(state.covered_counts).map((entry) => [
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
    const list = [...covered].map(([fingerprint, counts]) => ({
      fingerprint,
      counts,
    }));
    assignments.push(`covered_counts = ${bind(JSON.stringify(list))}::jsonb`);
  }
  // Only a counted space carries history counts. A space that has never run a
  // scan keeps them absent, and the stats read falls back to its bounded scan
  // there rather than reporting a counter that started life at zero.
  if (
    state.historical_thought_counts !== null &&
    state.historical_thought_counts !== undefined &&
    (delta.history.superseded !== 0 || delta.history.retracted !== 0)
  ) {
    const next = addHistoricalCounts(
      historicalCountsOf(state.historical_thought_counts),
      delta.history,
    );
    assignments.push(
      `historical_thought_counts = ${bind(JSON.stringify(next))}::jsonb`,
    );
  }
  if (assignments.length === 0) return;
  await exec(
    ctx,
    `UPDATE kith.space_embedding_states SET ${assignments.join(", ")}
      WHERE id = $1`,
    values,
  );
  await refreshActiveGenerationCounts(ctx, state.id);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export type SpaceEmbeddingCoverage = {
  spaceId: string;
  /** `unknown` is a space whose counters have never been seeded and audited. */
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
 * Ported from `readSpaceCounters`: everything the stats surfaces report about a
 * space, from one row. No thought row, no target row and no vector row is read.
 */
export async function readSpaceCounters(
  ctx: IdentityCtx,
  spaceId: string,
): Promise<SpaceCounterReport> {
  const state = await uniqueSpaceState(ctx, spaceId);
  const drift = state?.counter_drift === true;
  if (!state || !usesTargetCounters(state)) {
    return {
      coverage: { spaceId, status: "unknown", drift },
      thoughtCounts: null,
    };
  }
  const eligible = embeddingKindCounts(state.eligible_counts);
  const fingerprint = state.active_fingerprint ?? undefined;
  const covered = fingerprint
    ? coveredCountsFor(state, fingerprint)
    : { ...ZERO_KIND_COUNTS };
  // Card targets are counted but are not part of the completeness test: the
  // reader reports a card shortfall through `partial` (I10), exactly as it
  // does a chunk one.
  const complete =
    fingerprint !== undefined &&
    !drift &&
    covered.thought === eligible.thought &&
    covered.chunk === eligible.chunk;
  const history =
    state.historical_thought_counts === null ||
    state.historical_thought_counts === undefined
      ? null
      : historicalCountsOf(state.historical_thought_counts);
  const lastAuditAt = state.last_audit_at?.getTime();
  return {
    coverage: {
      spaceId,
      status: complete ? "complete" : "incomplete",
      ...(fingerprint === undefined ? {} : { fingerprint }),
      eligible,
      covered,
      drift,
      ...(lastAuditAt === undefined ? {} : { lastAuditAt }),
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
 * The `list_spaces` coverage labels of section 6 of the capacity plan: one
 * space-state read per space, no vector read and no thought read.
 *
 * It is exported from here rather than composed inside the MCP row because
 * `src/identity/spaces.ts` is security-sensitive and the coverage label is not
 * an authorization decision. The caller passes the already-authorized space
 * ids and composes the returned rows into whatever shape its surface wants.
 */
export async function spaceEmbeddingCoverage(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
): Promise<SpaceEmbeddingCoverage[]> {
  if (spaceIds.length > MAX_EMBEDDING_COVERAGE_SPACES) {
    throw new Error("Embedding coverage lookup exceeds its space bound");
  }
  const found: SpaceEmbeddingCoverage[] = [];
  for (const spaceId of spaceIds) {
    try {
      found.push((await readSpaceCounters(ctx, spaceId)).coverage);
    } catch {
      // A damaged counter row labels its own space `unknown` and nothing
      // else, exactly as a damaged target disables its own space's vectors.
      found.push({ spaceId, status: "unknown", drift: false });
    }
  }
  return found;
}
