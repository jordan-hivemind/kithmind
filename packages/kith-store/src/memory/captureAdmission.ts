// The provider-free half of narrative capture's admission gate.
//
// Ported from packages/convex/convex/models/thoughts/memoryAnalysis.ts and the
// classification half of models/thoughts/memoryLifecycle.ts that `lifecycle.ts`
// deliberately left behind ("`parseMemoryClassification` and the
// LLM-classification types are not ported: they parse an LLM's free-text output
// into a transition decision, which is a P2-39i concern"). P2-39i is here: the
// capture gate on PostgreSQL is the caller that has a model in the loop, so the
// parser lives beside the gate rather than in the lifecycle rules both facts
// and thoughts share.
//
// Everything in this file is pure. Nothing reads `process.env`, opens a
// transaction or calls a provider: it is text in, a decision or metadata out,
// which is what lets `./capture.ts` apply a decision inside one transaction and
// lets a test state a decision without standing up a model.
//
// Byte-identical where it is observable. `normalizeCaptureContent`'s bound and
// message, every `preflightNarrativeAdmission` regex and reason string, the
// metadata caps (3 topics, 10 people, 10 action items, 240-character summary,
// 160-character fallback summary) and the classification normalization rules
// are unchanged, because the two surfaces answer the same tool and a client
// cannot tell which one served it.
//
// Why they moved rather than being imported. The MCP write tools reached
// `normalizeCaptureContent`, `preflightNarrativeAdmission` and
// `fallbackThoughtMetadata` through
// `@repo/db/convex/models/thoughts/memoryAnalysis`, and row i7 deletes
// `@repo/db` from the web dependency tree. Deleting an import is a mechanical
// change that no test fails on, so the content bound and the derived-age
// refusal would have gone quietly with it: `capture_thought` would have
// accepted an unbounded body and stored a derived age. A refusal that can be
// removed by a dependency cleanup is not a refusal. It lives in the package
// that owns the capture now, and `test/captureAdmission.test.mjs` is the
// ported unit test that pins the three regular expressions and the four
// thresholds, which are the gate rather than an implementation of it.

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

export const MEMORY_ACTIONS = [
  "ADD",
  "NOOP",
  "SUPERSEDE",
  "RETRACT",
  "ASK",
  "SKIP",
] as const;

export type MemoryAction = (typeof MEMORY_ACTIONS)[number];

export type MemoryClassification = {
  action: MemoryAction;
  relatedThoughtIds: string[];
  reason: string;
  replacementContent?: string;
};

/** One classifier answer: what to do, and the metadata for what gets stored. */
export type ThoughtAnalysis = {
  classification: MemoryClassification;
  metadata: CaptureThoughtMetadata;
};

export type NarrativePreflightDecision = {
  action: "ASK" | "SKIP";
  reason: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deduplicated, trimmed, 200-characters-per-item, capped at `limit` items.
 * Exported for `updateThought`'s web route (`api/kith/thoughts/[id]`), which
 * bounds an edit's `topics`/`people` the same way a capture's metadata
 * always has (3 topics, 10 people -- see `normalizeThoughtMetadata`) rather
 * than inventing a second, looser rule for the same two fields.
 */
export function uniqueStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 200))
        .filter(Boolean),
    ),
  ].slice(0, limit);
}

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

export function normalizeThoughtMetadata(
  value: unknown,
  storedContent: string,
): CaptureThoughtMetadata {
  const fallback = fallbackThoughtMetadata(storedContent);
  if (!isRecord(value)) return fallback;

  const type = THOUGHT_TYPES.includes(value.type as CaptureThoughtType)
    ? (value.type as CaptureThoughtType)
    : fallback.type;
  const summary =
    typeof value.summary === "string" && value.summary.trim()
      ? value.summary.trim().slice(0, 240)
      : fallback.summary;

  return {
    type,
    topics: uniqueStrings(value.topics, 3),
    people: uniqueStrings(value.people, 10),
    actionItems: uniqueStrings(value.actionItems, 10),
    summary,
  };
}

/**
 * The rules an answer has to satisfy before it is a decision.
 *
 * Two of them are the whole reason this is not `JSON.parse`. Every cited id is
 * intersected with the candidate set the caller supplied, so a model cannot
 * name a thought this capture never looked at -- which on PostgreSQL is also
 * the space boundary, because the candidate set is gathered from the
 * destination space alone. And `SUPERSEDE`/`RETRACT` without a replacement, or
 * `NOOP` without a citation, are rejected rather than coerced, because either
 * would retire a memory with nothing put in its place.
 */
function normalizeClassification(
  value: unknown,
  candidateIds: ReadonlySet<string>,
): MemoryClassification | null {
  if (
    !isRecord(value) ||
    !MEMORY_ACTIONS.includes(value.action as MemoryAction)
  ) {
    return null;
  }

  const action = value.action as MemoryAction;
  const reason =
    typeof value.reason === "string" ? value.reason.trim().slice(0, 500) : "";
  if (!reason) return null;

  const rawIds = Array.isArray(value.relatedThoughtIds)
    ? value.relatedThoughtIds
    : [];
  const relatedThoughtIds = [
    ...new Set(
      rawIds.filter(
        (id): id is string => typeof id === "string" && candidateIds.has(id),
      ),
    ),
  ];

  if (action === "ADD" || action === "ASK" || action === "SKIP") {
    return { action, relatedThoughtIds: [], reason };
  }

  if (action === "NOOP") {
    if (relatedThoughtIds.length === 0) return null;
    return { action, relatedThoughtIds: [relatedThoughtIds[0]!], reason };
  }

  const replacementContent =
    typeof value.replacementContent === "string"
      ? value.replacementContent.trim()
      : "";
  if (relatedThoughtIds.length === 0 || !replacementContent) return null;

  return { action, relatedThoughtIds, reason, replacementContent };
}

export function parseMemoryClassification(
  text: string,
  candidateIds: Iterable<string>,
): MemoryClassification | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    return normalizeClassification(
      JSON.parse(jsonMatch[0]) as unknown,
      new Set(candidateIds),
    );
  } catch {
    return null;
  }
}

/**
 * One model answer to one decision plus the metadata for the content that
 * would actually be stored: the replacement on a transition, the new content
 * otherwise. `null` means the answer was not usable, which the gate treats
 * exactly as a provider outage.
 */
export function parseThoughtAnalysis(
  text: string,
  candidateIds: Iterable<string>,
  newContent: string,
): ThoughtAnalysis | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  const classification = parseMemoryClassification(
    JSON.stringify(value),
    candidateIds,
  );
  if (!classification) return null;

  const storedContent =
    classification.action === "SUPERSEDE" || classification.action === "RETRACT"
      ? classification.replacementContent!
      : newContent;

  return {
    classification,
    metadata: normalizeThoughtMetadata(value.metadata, storedContent),
  };
}
