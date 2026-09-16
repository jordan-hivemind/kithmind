// The database half of narrative capture's admission gate: what the gate reads
// before it asks, and what it writes once it has an answer.
//
// Ported from packages/convex/convex/models/thoughts/actions.ts
// (`captureThought`) and models/facts/private.ts (`searchCoveringFacts`). Three
// functions, each a database function with its own tests:
//
//   * `searchCaptureCandidates` -- the current, semantically similar memories
//     the classifier compares against.
//   * `searchCoveringFacts` -- the structured facts that already cover the
//     subject, because structured storage owns the predicates it records and
//     the gate cannot call content new without seeing them.
//   * `applyCaptureDecision` -- one decision in, one outcome out, in one
//     transaction.
//
// Every one of them takes an already-authorized `spaceId` (writes) or
// `spaceIds` set (reads), which is this package's convention and, here, also
// the space boundary of the gate itself: the candidate and covering-fact reads
// run over the destination space alone, so nothing from another space is ever
// put in front of the classifier, and `parseThoughtAnalysis` then refuses any
// cited id that was not in that set.
//
// ## What differs from the Convex original, and why
//
// 1. No vector is written and none is re-requested. `insertOneAuthorized` and
//    `transitionMemoryAuthorized` took an `embedding` and stored it inline;
//    P2-39g2 decided that a PostgreSQL capture marks its target eligible and
//    lets `../embeddings/fill.ts` cover it (see `./thoughts.ts`'s module
//    comment), because one ported mutation is one transaction on one client
//    and that client may not be held across a provider call. So
//    `canReuseEmbedding` and the second embedding request the SUPERSEDE branch
//    made for a differing `replacementContent` have nothing to serve and are
//    not ported.
//
//    The honest cost of that is recorded here rather than hidden: a space's
//    thought index reports `thoughtStatus: "unavailable"` while eligible and
//    covered counts disagree, and `searchThoughtVectorCandidates` is strict
//    about it (I9), so between a capture and the next fill this gate sees no
//    vector candidates. Duplicate and supersede detection is therefore only as
//    fresh as the fill. The covering-fact leg is keyword-based and is
//    unaffected.
//
// 2. The SUPERSEDE/RETRACT fallback is a precheck, not a `catch`. Convex
//    wrapped the transition in `try`/`catch` and fell back to ADD when it
//    threw. A failed statement aborts a PostgreSQL transaction outright
//    (SQLSTATE 25P02), so catching around one and carrying on is not
//    available. `transitionMemory` refuses for exactly one reason before it
//    writes anything -- a previous memory that is missing, in another space or
//    no longer current -- so that condition is checked first, with a read, and
//    the fallback to ADD happens on the same terms. All or nothing, as the
//    original: one unusable citation makes the whole transition fall back.
//
// 3. `setCoreStatus` on the NOOP branch is the only write that branch makes,
//    as it was on Convex.
//
// Everything a client can observe is unchanged: the six dispositions, every
// `operationSummary` string, the metadata on each branch, and the rule that
// ASK, SKIP and an unusable answer store nothing.

import {
  searchFacts,
  searchThoughtVectorCandidates,
} from "../embeddings/search.js";
import { getActiveTargets } from "../embeddings/targets.js";
import type { IdentityCtx } from "../identity/db.js";
import { KITH_ID } from "../ids.js";
import {
  fallbackThoughtMetadata,
  type ThoughtAnalysis,
} from "./captureAdmission.js";
import {
  MAX_CANDIDATES,
  SIMILARITY_THRESHOLD,
  type CaptureClassifierCandidate,
  type CaptureCoveringFact,
} from "./captureClassifier.js";
import { isCurrentMemory } from "./lifecycle.js";
import {
  captureThought,
  getThoughtById,
  getThoughtsByIds,
  setCoreStatus,
  transitionMemory,
  type MemorySourceType,
  type ThoughtMetadata,
} from "./thoughts.js";

/** `COVERAGE_CANDIDATES` in models/facts/private.ts. */
export const COVERING_FACT_CANDIDATES = 5;

/**
 * The current facts that already cover the subject of `query`.
 *
 * Ported from `searchCoveringFacts`. The Convex original re-derived its space
 * set from a principal because it was its own query on its own snapshot; here
 * the caller resolves the destination once and passes it, which is what keeps
 * the gate's reads and its write on one space.
 */
export async function searchCoveringFacts(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  query: string,
  limit: number = COVERING_FACT_CANDIDATES,
): Promise<CaptureCoveringFact[]> {
  if (spaceIds.length === 0) return [];
  const facts = await searchFacts(ctx, spaceIds, query, { limit });
  return facts.map((fact) => ({ id: fact.id, statement: fact.statement }));
}

/**
 * The classification candidates for one capture: current memories of the
 * destination space whose vectors are near `vector`.
 *
 * `captureThought`'s own scan, with the parts PostgreSQL already does folded
 * in. Convex ran `ctx.vectorSearch` at limit 256, kept rows scoring at least
 * `SIMILARITY_THRESHOLD`, resolved them against the target table, read the
 * thoughts, dropped anything not current or not in this space, and took
 * `MAX_CANDIDATES`. `searchThoughtVectorCandidates` is the resolve, the
 * ownership recheck and the current filter in one statement per space, so what
 * remains here is the threshold, the two slices and the hydration.
 *
 * `cap` is `MAX_CANDIDATES * 5`, the original's own intermediate bound. A
 * smaller scan than Convex's 256 returns the same set: rows arrive in score
 * order and only the best ten survive.
 *
 * `includeHistorical` is set on both reads and the lifecycle filter is applied
 * here instead, because the original's candidate filter was
 * `isCurrentMemory(doc.memoryStatus)` and nothing else. The two helpers'
 * default is a *retrieval* filter, which also drops a current memory whose
 * business-time window has lapsed; that memory is still something the gate
 * must compare against, and the prompt is given its `validFrom`/`validTo` so
 * the model can weigh it. Their historical mode drops the window but would let
 * a superseded row through, so the status test is restated below.
 */
export async function searchCaptureCandidates(
  ctx: IdentityCtx,
  spaceId: string,
  vector: readonly number[],
): Promise<CaptureClassifierCandidate[]> {
  const targets = await getActiveTargets(ctx, [spaceId]);
  if (targets.length === 0) return [];
  const scored = await searchThoughtVectorCandidates(ctx, targets, vector, {
    cap: MAX_CANDIDATES * 5,
    includeHistorical: true,
  });
  const ranked = scored
    .filter((candidate) => candidate.similarity >= SIMILARITY_THRESHOLD)
    .map((candidate) => candidate.thoughtId);
  const hydrated = (
    await getThoughtsByIds(ctx, [spaceId], ranked, { includeHistorical: true })
  ).filter((thought) => isCurrentMemory(thought.memoryStatus));
  return hydrated.slice(0, MAX_CANDIDATES).map((thought) => ({
    id: thought.id,
    content: thought.content,
    metadata: {
      type: thought.metadata.type,
      topics: thought.metadata.topics,
      people: thought.metadata.people,
      summary: thought.metadata.summary,
    },
    createdAt: thought.createdAt,
    ...(thought.validFrom === undefined ? {} : { validFrom: thought.validFrom }),
    ...(thought.validTo === undefined ? {} : { validTo: thought.validTo }),
  }));
}

export type CaptureDisposition =
  | "stored"
  | "duplicate"
  | "superseded"
  | "corrected"
  | "needs_confirmation"
  | "skipped";

export type CaptureOutcome = {
  thoughtId?: string;
  metadata: ThoughtMetadata;
  disposition: CaptureDisposition;
  operationSummary?: string;
};

export type CaptureDecisionInput = {
  /** Already normalized by `normalizeCaptureContent`. */
  content: string;
  /** The classifier's answer, or `null` when it had none. */
  analysis: ThoughtAnalysis | null;
  /** The facts the classifier was shown, so a cited fact id resolves. */
  coveringFacts: readonly CaptureCoveringFact[];
  sourceType: MemorySourceType;
  sourceRef?: string;
  observedAt?: number;
  batchId?: string;
  validFrom?: number;
  validTo?: number;
  isCore?: boolean;
};

/** The provenance every branch that stores a row carries, assembled once. */
function storedArgs(
  input: CaptureDecisionInput,
  content: string,
  metadata: ThoughtMetadata,
) {
  return {
    content,
    metadata,
    ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
    ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
    ...(input.isCore === undefined ? {} : { isCore: input.isCore }),
    sourceType: input.sourceType,
    ...(input.sourceRef === undefined
      ? {}
      : { sourceRef: input.sourceRef.trim() }),
    ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }),
    ...(input.batchId === undefined ? {} : { batchId: input.batchId.trim() }),
    confidence: 1,
  };
}

/** `SUPERSEDE`'s and `RETRACT`'s summary lines, kept word for word. */
function transitionSummary(
  action: "SUPERSEDE" | "RETRACT",
  count: number,
): string {
  return action === "SUPERSEDE"
    ? "Stored the new current memory and preserved " +
        count +
        (count === 1
          ? " previous memory as historical"
          : " previous memories as historical")
    : "Stored the correction and marked " +
        count +
        (count === 1
          ? " previous memory as inaccurate"
          : " previous memories as inaccurate");
}

/**
 * Whether every cited memory is still one this transition may retire. See note
 * 2 in the module comment: this is `transitionMemory`'s own refusal, asked as
 * a read first, because a fallback cannot be built on a caught SQL error.
 */
async function transitionableIds(
  ctx: IdentityCtx,
  spaceId: string,
  ids: readonly string[],
): Promise<string[] | null> {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.length > 10) return null;
  for (const id of unique) {
    if (!KITH_ID.test(id)) return null;
    const previous = await getThoughtById(ctx, id);
    if (
      !previous ||
      previous.spaceId !== spaceId ||
      !isCurrentMemory(previous.memoryStatus)
    ) {
      return null;
    }
  }
  return unique;
}

/**
 * Applies one classifier decision to one already-authorized destination space.
 *
 * The branch order is `captureThought`'s: unusable answer, then ASK and SKIP,
 * then NOOP, then SUPERSEDE and RETRACT, then ADD -- and NOOP and a failed
 * transition both fall through to ADD with fallback metadata, exactly as the
 * original's `classification = null` and its `catch` did.
 */
export async function applyCaptureDecision(
  ctx: IdentityCtx,
  userId: string,
  spaceId: string,
  input: CaptureDecisionInput,
): Promise<CaptureOutcome> {
  const analysis = input.analysis;
  let classification = analysis?.classification ?? null;

  // Fail closed. A capture whose admission check did not run is not a capture
  // that may be stored on the gate's silence.
  if (!classification || !analysis) {
    return {
      metadata: fallbackThoughtMetadata(input.content),
      disposition: "needs_confirmation",
      operationSummary:
        "Memory was not stored because the admission check was unavailable",
    };
  }

  if (classification.action === "ASK" || classification.action === "SKIP") {
    return {
      metadata: analysis.metadata,
      disposition:
        classification.action === "ASK" ? "needs_confirmation" : "skipped",
      operationSummary:
        classification.action === "ASK"
          ? `Memory was not stored: ${classification.reason}`
          : `Memory was skipped: ${classification.reason}`,
    };
  }

  if (classification.action === "NOOP") {
    const citedId = classification.relatedThoughtIds[0];
    // The cited id may name a fact rather than a thought: both were offered to
    // the classifier, so both are citable. Check the facts first, before the
    // id reaches a read that expects a thought.
    const coveringFact = input.coveringFacts.find(
      (fact) => fact.id === citedId,
    );
    if (coveringFact) {
      return {
        metadata: analysis.metadata,
        disposition: "duplicate",
        operationSummary: `Already recorded as a structured fact: ${coveringFact.statement}`,
      };
    }
    const existing =
      citedId && KITH_ID.test(citedId)
        ? await getThoughtById(ctx, citedId)
        : null;
    if (
      existing &&
      existing.spaceId === spaceId &&
      isCurrentMemory(existing.memoryStatus)
    ) {
      if (input.isCore !== undefined) {
        await setCoreStatus(ctx, spaceId, existing.id, input.isCore);
      }
      return {
        thoughtId: existing.id,
        metadata: existing.metadata,
        disposition: "duplicate",
        operationSummary:
          input.isCore === undefined
            ? "Thought already captured — no changes made"
            : "Thought already captured — core status updated",
      };
    }
    classification = null;
  }

  if (
    classification &&
    (classification.action === "SUPERSEDE" ||
      classification.action === "RETRACT") &&
    classification.replacementContent
  ) {
    const action = classification.action;
    const previousIds = await transitionableIds(
      ctx,
      spaceId,
      classification.relatedThoughtIds,
    );
    if (previousIds) {
      const thoughtId = await transitionMemory(
        ctx,
        userId,
        spaceId,
        storedArgs(input, classification.replacementContent, analysis.metadata),
        previousIds,
        action === "SUPERSEDE" ? "superseded" : "retracted",
        classification.reason,
        ctx.now,
      );
      return {
        thoughtId,
        metadata: analysis.metadata,
        disposition: action === "SUPERSEDE" ? "superseded" : "corrected",
        operationSummary: transitionSummary(action, previousIds.length),
      };
    }
    // The citations no longer name memories this space may retire. Convex fell
    // back to ADD here and so does this.
  }

  const metadata: ThoughtMetadata =
    classification?.action === "ADD"
      ? analysis.metadata
      : fallbackThoughtMetadata(input.content);
  const thoughtId = await captureThought(
    ctx,
    userId,
    spaceId,
    storedArgs(input, input.content, metadata),
  );
  return { thoughtId, metadata, disposition: "stored" };
}
