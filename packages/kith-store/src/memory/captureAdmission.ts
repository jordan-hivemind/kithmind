// The provider-free half of narrative capture's admission gate.
//
// Ported from `packages/convex/convex/models/thoughts/memoryAnalysis.ts`, and
// only the three functions that need no provider: the content bound, the
// deterministic preflight, and the metadata a capture stores when it has no
// analysis. The rest of that module -- `parseThoughtAnalysis`,
// `normalizeThoughtMetadata`, `canReuseEmbedding` -- belongs with the
// model-backed gate and is not ported here, because nothing on this side calls
// a classifier yet.
//
// Why they moved rather than being imported. The MCP write tools reached them
// through `@repo/db/convex/models/thoughts/memoryAnalysis`, and row i7 deletes
// `@repo/db` from the web dependency tree. Deleting an import is a mechanical
// change that no test fails on, so the content bound and the derived-age
// refusal would have gone quietly with it: `capture_thought` would have
// accepted an unbounded body and stored a derived age. A refusal that can be
// removed by a dependency cleanup is not a refusal. It lives in the package
// that owns the capture now.
//
// The bodies are byte-for-byte the Convex ones. The three regular expressions
// and the four thresholds are the gate, not an implementation of it, so a
// "tidier" rewrite here would silently change which captures are admitted.
// `test/captureAdmission.test.mjs` is the ported unit test that pins them.

export const MAX_CAPTURE_CONTENT_CHARS = 2_000;

export const THOUGHT_TYPES = [
  "decision",
  "person_note",
  "idea",
  "meeting_note",
  "task",
  "reference",
] as const;

export type CaptureThoughtType = (typeof THOUGHT_TYPES)[number];

/**
 * The stored metadata shape, with mutable arrays.
 *
 * `ThoughtMetadata` in `thoughts.ts` is the same shape with `readonly` arrays,
 * and a value of this type is assignable to it. The mutable spelling is kept
 * because this is what the Convex original returns and what the MCP tool hands
 * back to a client, which must not be a frozen view of the store's own row.
 */
export type CaptureThoughtMetadata = {
  type: CaptureThoughtType;
  topics: string[];
  people: string[];
  actionItems: string[];
  summary: string;
};

export type NarrativePreflightDecision = {
  action: "ASK" | "SKIP";
  reason: string;
};

/** Trims, and refuses an empty or oversized capture before any provider call. */
export function normalizeCaptureContent(content: string): string {
  const normalized = content.trim();
  if (!normalized || normalized.length > MAX_CAPTURE_CONTENT_CHARS) {
    throw new Error(
      `Memory content must contain 1-${MAX_CAPTURE_CONTENT_CHARS} characters`,
    );
  }
  return normalized;
}

/**
 * Rejects the clearest bad ingestion shapes before paying for embeddings or a
 * model admission call. The model still makes the nuanced durability decision;
 * this guard keeps known bootstrap failure modes deterministic.
 */
export function preflightNarrativeAdmission(
  content: string,
): NarrativePreflightDecision | null {
  const normalized = content.trim();
  const hasDerivedAge =
    /\bage\s*[:=]?\s*\d{1,3}\b/i.test(normalized) ||
    /\b\d{1,3}\s*(?:years?|yrs?)\s+old\b/i.test(normalized);
  if (hasDerivedAge) {
    const mostlyAgeClaim =
      Array.from(normalized).length <= 200 &&
      normalized.split(/[.!?](?:\s|$)/).filter(Boolean).length <= 2;
    return {
      action: mostlyAgeClaim ? "SKIP" : "ASK",
      reason: mostlyAgeClaim
        ? "Derived ages go stale; store an exact date_of_birth fact only when explicitly known"
        : "This bundle contains a derived age and must be atomized; omit the age or replace it with an explicitly known date_of_birth fact",
    };
  }

  const bulletCount = normalized
    .split("\n")
    .filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line)).length;
  const sentenceCount = normalized
    .split(/[.!?](?:\s|$)/)
    .map((sentence) => sentence.trim())
    .filter(Boolean).length;
  const broadHeading =
    /^(?:about me|my team|active projects|work patterns|personal profile|biography)\s*:/i.test(
      normalized,
    );
  if (
    Array.from(normalized).length > 1_200 ||
    bulletCount > 3 ||
    sentenceCount > 5 ||
    broadHeading
  ) {
    return {
      action: "ASK",
      reason:
        "This looks like a broad bucket or activity catalog; split it into atomic structured facts and coherent narrative memories before storage",
    };
  }
  return null;
}

/** What a capture stores when no classifier produced metadata for it. */
export function fallbackThoughtMetadata(
  content: string,
): CaptureThoughtMetadata {
  return {
    type: "reference",
    topics: [],
    people: [],
    actionItems: [],
    summary: content.trim().slice(0, 160),
  };
}
