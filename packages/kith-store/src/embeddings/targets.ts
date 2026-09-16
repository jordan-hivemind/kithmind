// The read half of packages/convex/convex/models/embeddings/model.ts and
// models/embeddings/targets.ts: what the active embedding index of a space
// is, and whether a candidate's target is still eligible for it.
//
// Only the read half. Staging, activation, the fill driver, the audit and
// every counter write stay with the embedding build workstream; nothing here
// writes a row. `touchWorkerPublicationEmbedding` in
// `src/workers/publication.ts` already maintains eligibility and the covered
// counters on a publish, and this module deliberately does not duplicate any
// of it -- it only reads what that writer left.
//
// Every function takes an already-authorized `spaceIds` set, the same
// convention as `src/memory/` and `src/documents/`: authorization is the
// caller's job, and every statement still carries its own space predicate.
// That is why `getActiveTargets` here has no `principal` argument where
// `models/embeddings/private.ts:getActiveTargets` did.

import { row, rows, type IdentityCtx } from "../identity/db.js";
import {
  fingerprintEmbeddingConfig,
  type EmbeddingProfile,
} from "./provider.js";
import type { EmbeddingTargetKind } from "./scope.js";

/** A space is looked up one at a time; this bounds how many a read may name. */
export const MAX_EMBEDDING_TARGET_SPACES = 32;

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

/**
 * A space whose counters no target backfill has seeded has no source of truth
 * for coverage. It fails closed rather than reporting an empty index as a
 * complete one. Ported verbatim so an operator reads the same sentence here.
 */
export const UNSEEDED_EMBEDDING_COUNTERS_ERROR =
  "Embedding coverage counters are not seeded for this space; run the P2-6g target backfill (models/embeddings/migrations:startTargetBackfill) before semantic retrieval";

export type ActiveEmbeddingTarget = {
  spaceId: string;
  embeddingGenerationId: string;
  fingerprint: string;
  profile: EmbeddingProfile;
  /** I9: strict. Narrative capture needs a complete thought index. */
  thoughtStatus: "ready" | "unavailable";
  /**
   * D3 B and I10: chunk coverage is a reported ratio, never a reason to make
   * semantic retrieval unavailable. A shortfall reaches the caller through
   * the existing `partial` flag.
   */
  chunkCoverage: { eligible: number; covered: number };
};

export type SpaceEmbeddingStateRow = {
  id: string;
  space_id: string;
  active_embedding_generation_id: string | null;
  active_fingerprint: string | null;
  eligible_counts: unknown;
  covered_counts: unknown;
  counter_drift: boolean | null;
  last_audit_at: Date | null;
  /** The remaining columns the write side (P2-39g2) reads and patches. */
  eligibility_epoch?: string | number | null;
  target_policy?: string | null;
  counter_drift_reason?: string | null;
  historical_thought_counts?: unknown;
  activated_at?: Date | null;
  last_eligibility_change_at?: Date | null;
};

export type EmbeddingGenerationRow = {
  id: string;
  space_id: string;
  embedding_profile_id: string | null;
  fingerprint: string | null;
  state: string | null;
  deactivated_at: Date | null;
};

export type EmbeddingProfileRow = {
  id: string;
  fingerprint: string | null;
  protocol: string | null;
  provider_id: string | null;
  model: string | null;
  model_revision: string | null;
  dimensions: string | number | null;
  normalization: string | null;
  preprocessing: string | null;
};

export type EmbeddingTargetRow = {
  id: string;
  space_id: string;
  target_kind: string | null;
  target_id: string | null;
  input_hash: string | null;
  state: string | null;
  covered_fingerprint: string | null;
};

/** One counter, from a stored `jsonb` number. */
export function embeddingCountOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Embedding counter is invalid");
  }
  return value;
}

/**
 * The three named kinds, from a stored `jsonb` counter. Exported for the write
 * side (P2-39g2), which reads and adds to the same three numbers; a second
 * parser would be a second opinion about what a counter is.
 */
export function embeddingKindCounts(value: unknown): EmbeddingKindCounts {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Embedding counter is invalid");
  }
  const record = value as Record<string, unknown>;
  return {
    thought: embeddingCountOf(record.thought),
    chunk: embeddingCountOf(record.chunk),
    card: embeddingCountOf(record.card),
  };
}

/** Ported from `coveredCountsFor`. */
export function coveredCountsFor(
  state: { covered_counts: unknown },
  fingerprint: string,
): EmbeddingKindCounts {
  const covered = state.covered_counts;
  if (covered === null || covered === undefined) return { ...ZERO_KIND_COUNTS };
  if (!Array.isArray(covered)) throw new Error("Embedding counter is invalid");
  for (const entry of covered) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Embedding counter is invalid");
    }
    const record = entry as Record<string, unknown>;
    if (record.fingerprint === fingerprint) {
      return embeddingKindCounts(record.counts);
    }
  }
  return { ...ZERO_KIND_COUNTS };
}

/**
 * Ported from `usesTargetCounters`: true once a backfill seeded the counters
 * and one full audit confirmed them. `undefined` on a Convex document is
 * `NULL` on a column, so the two conditions read the same.
 */
export function usesTargetCounters(state: SpaceEmbeddingStateRow): boolean {
  return state.eligible_counts !== null && state.last_audit_at !== null;
}

export function profileFromRow(record: EmbeddingProfileRow): EmbeddingProfile {
  if (
    typeof record.protocol !== "string" ||
    typeof record.provider_id !== "string" ||
    typeof record.model !== "string" ||
    typeof record.model_revision !== "string" ||
    typeof record.normalization !== "string" ||
    typeof record.preprocessing !== "string" ||
    record.dimensions === null
  ) {
    throw new Error("Embedding generation profile is invalid");
  }
  return {
    protocol: record.protocol,
    providerId: record.provider_id,
    model: record.model,
    modelRevision: record.model_revision,
    // `dimensions` is migration 004's permissive `numeric`, which node-pg
    // hands back as a string. The profile field is a Convex `v.number()`.
    dimensions: Number(record.dimensions),
    normalization: record.normalization,
    preprocessing: record.preprocessing,
  };
}

/** Every column of the state row, named once. */
export const SPACE_EMBEDDING_STATE_COLUMNS = `id, space_id, eligibility_epoch,
  active_embedding_generation_id, active_fingerprint, activated_at,
  eligible_counts, covered_counts, target_policy, counter_drift,
  counter_drift_reason, historical_thought_counts, last_audit_at,
  last_eligibility_change_at`;

/**
 * Ported from `uniqueSpaceState`: a second row is a fault, not a tiebreak.
 *
 * Migration 016 made `(space_id)` unique, so the fault is now unreachable; the
 * `LIMIT 2` stays because a defensive read that costs one row is cheaper than
 * an argument about which guarantee is holding it up.
 *
 * `forUpdate` is what a write path passes: the counters are one row per space
 * and every eligibility write adds to them, so the read that decides the delta
 * and the update that applies it have to be the same row lock.
 */
export async function uniqueSpaceState(
  ctx: IdentityCtx,
  spaceId: string,
  forUpdate = false,
): Promise<SpaceEmbeddingStateRow | null> {
  const found = await rows<SpaceEmbeddingStateRow>(
    ctx,
    `SELECT ${SPACE_EMBEDDING_STATE_COLUMNS}
       FROM kith.space_embedding_states WHERE space_id = $1
      ORDER BY created_at, id LIMIT 2${forUpdate ? " FOR UPDATE" : ""}`,
    [spaceId],
  );
  if (found.length > 1) throw new Error("Duplicate space embedding state");
  return found[0] ?? null;
}

/** Ported from `requireGenerationProfile`. */
export async function requireGenerationProfile(
  ctx: IdentityCtx,
  generation: EmbeddingGenerationRow,
): Promise<EmbeddingProfile> {
  const record = generation.embedding_profile_id
    ? await row<EmbeddingProfileRow>(
        ctx,
        `SELECT id, fingerprint, protocol, provider_id, model, model_revision,
                dimensions, normalization, preprocessing
           FROM kith.embedding_profiles WHERE id = $1`,
        [generation.embedding_profile_id],
      )
    : null;
  if (!record || record.fingerprint !== generation.fingerprint) {
    throw new Error("Embedding generation profile is invalid");
  }
  const profile = profileFromRow(record);
  if ((await fingerprintEmbeddingConfig(profile)) !== generation.fingerprint) {
    throw new Error("Embedding generation profile is invalid");
  }
  return profile;
}

/**
 * Ported from `getActiveEmbeddingTarget`. `null` means the space has no
 * active index; a throw means the state it does have is inconsistent, which
 * the callers below turn into "vectors unavailable for this space" rather
 * than into a failed request.
 */
export async function getActiveEmbeddingTarget(
  ctx: IdentityCtx,
  spaceId: string,
): Promise<ActiveEmbeddingTarget | null> {
  const state = await uniqueSpaceState(ctx, spaceId);
  if (!state?.active_embedding_generation_id || !state.active_fingerprint) {
    return null;
  }
  const generation = await row<EmbeddingGenerationRow>(
    ctx,
    `SELECT id, space_id, embedding_profile_id, fingerprint, state, deactivated_at
       FROM kith.embedding_generations WHERE id = $1`,
    [state.active_embedding_generation_id],
  );
  if (
    !generation ||
    generation.space_id !== spaceId ||
    generation.state !== "active" ||
    generation.fingerprint !== state.active_fingerprint ||
    generation.deactivated_at !== null
  ) {
    throw new Error("Active embedding generation pointer is invalid");
  }
  const profile = await requireGenerationProfile(ctx, generation);
  // The counters are the only source of coverage truth (I4, I5). An unseeded
  // space fails closed.
  if (!usesTargetCounters(state)) {
    throw new Error(UNSEEDED_EMBEDDING_COUNTERS_ERROR);
  }
  const eligible = embeddingKindCounts(state.eligible_counts);
  const covered = coveredCountsFor(state, state.active_fingerprint);
  return {
    spaceId,
    embeddingGenerationId: generation.id,
    fingerprint: state.active_fingerprint,
    profile,
    // I9. The audit watermark of I5 gates activation, not retrieval: an
    // eligibility write would otherwise disable capture until an audit ran.
    thoughtStatus:
      state.counter_drift !== true && covered.thought === eligible.thought
        ? "ready"
        : "unavailable",
    chunkCoverage: { eligible: eligible.chunk, covered: covered.chunk },
  };
}

/**
 * Ported from `models/embeddings/private.ts:getActiveTargets`, minus its
 * principal argument (see the module comment). One damaged or unmigrated
 * space disables its own vectors for this request and nothing else: not the
 * other spaces, and never keyword retrieval.
 */
export async function getActiveTargets(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
): Promise<ActiveEmbeddingTarget[]> {
  if (spaceIds.length > MAX_EMBEDDING_TARGET_SPACES) {
    throw new Error("Embedding target lookup exceeds its space bound");
  }
  const found: ActiveEmbeddingTarget[] = [];
  for (const spaceId of spaceIds) {
    try {
      const target = await getActiveEmbeddingTarget(ctx, spaceId);
      if (target) found.push(target);
    } catch {
      // Deliberately swallowed, exactly as the Convex original does.
    }
  }
  return found;
}

/**
 * Ported verbatim from `models/thoughts/actions.ts`. The one fingerprint
 * every named space agrees on, or null when they do not agree, a space has no
 * active target, or a target is missing. Null is what turns the vector leg
 * off for the whole request rather than silently searching a subset.
 */
export function compatibleSearchFingerprint(
  spaceIds: readonly string[],
  targets: readonly { spaceId: string; fingerprint: string }[],
): string | null {
  if (spaceIds.length === 0 || targets.length !== spaceIds.length) return null;
  const bySpace = new Map(targets.map((target) => [target.spaceId, target]));
  if (bySpace.size !== spaceIds.length) return null;
  const fingerprint = bySpace.get(spaceIds[0]!)?.fingerprint;
  if (!fingerprint) return null;
  return spaceIds.every(
    (spaceId) => bySpace.get(spaceId)?.fingerprint === fingerprint,
  )
    ? fingerprint
    : null;
}

/** Ported from `findEmbeddingTarget`: a second row is a fault, not a tiebreak. */
export async function findEmbeddingTarget(
  ctx: IdentityCtx,
  spaceId: string,
  targetKind: EmbeddingTargetKind,
  targetId: string,
): Promise<EmbeddingTargetRow | null> {
  const found = await rows<EmbeddingTargetRow>(
    ctx,
    `SELECT id, space_id, target_kind, target_id, input_hash, state, covered_fingerprint
       FROM kith.embedding_targets
      WHERE space_id = $1 AND target_kind = $2 AND target_id = $3
      LIMIT 2`,
    [spaceId, targetKind, targetId],
  );
  if (found.length > 1) throw new Error("Duplicate embedding target row");
  return found[0] ?? null;
}
