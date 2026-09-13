// Ported unchanged from packages/convex/convex/models/thoughts/memoryLifecycle.ts.
//
// Facts and thoughts share one lifecycle rule (`docs/plans/2026-09-06-architecture.md`
// section 3.3: current facts and thoughts are authoritative by default, history
// on request), so it lives here once and both `facts.ts` and `thoughts.ts`
// import it, exactly as Convex's `models/facts/model.ts` imported this file
// rather than restating the rule. `parseMemoryClassification` and the
// LLM-classification types (`MemoryAction`, `MemoryClassification`) are not
// ported: they parse an LLM's free-text output into a transition decision, which
// is a P2-39i concern (the caller that has an LLM in the loop), not a Postgres
// data-access concern.

export type MemoryStatus = "current" | "superseded" | "retracted";

export type MemoryValidity = {
  validFrom?: number;
  validTo?: number;
};

export function isCurrentMemory(status: MemoryStatus | undefined | null): boolean {
  return status === undefined || status === null || status === "current";
}

/**
 * Returns whether a lifecycle-current memory is effective at `at` in business
 * time. Validity windows are half-open: validFrom is inclusive and validTo is
 * exclusive. Legacy memories without validity metadata remain active.
 */
export function isMemoryActive(
  memory: MemoryValidity & { memoryStatus?: MemoryStatus | null },
  at: number = Date.now(),
): boolean {
  return (
    isCurrentMemory(memory.memoryStatus) &&
    (memory.validFrom === undefined || memory.validFrom <= at) &&
    (memory.validTo === undefined || at < memory.validTo)
  );
}

/**
 * Returns whether a memory may be returned by a read.
 *
 * A superseded memory was true once, so it is a legitimate answer to an
 * explicitly historical question. A retracted memory was never true, and
 * presenting it as prior history misrepresents a correction as a change. It is
 * therefore withheld in both modes.
 *
 * A historical read deliberately ignores the business-time window, so it also
 * returns memories that are expired or not yet effective. That is not the same
 * exception retracted memories are denied: a scheduled or lapsed memory states
 * something accurate about a different point in time, whereas a retracted one
 * states something that was never accurate at any point. Callers receive
 * `validFrom` and `validTo` and can present the distinction.
 */
export function isMemoryRetrievable(
  memory: MemoryValidity & { memoryStatus?: MemoryStatus | null },
  includeHistorical: boolean | undefined,
  at: number = Date.now(),
): boolean {
  if (memory.memoryStatus === "retracted") return false;
  return includeHistorical === true || isMemoryActive(memory, at);
}

/**
 * Validates a business-time interval without conflating it with recording
 * time. Open intervals are allowed; a closed interval must have positive
 * duration.
 */
export function assertValidMemoryValidity({
  validFrom,
  validTo,
}: MemoryValidity): void {
  if (
    (validFrom !== undefined && !Number.isFinite(validFrom)) ||
    (validTo !== undefined && !Number.isFinite(validTo)) ||
    (validFrom !== undefined && validTo !== undefined && validFrom >= validTo)
  ) {
    throw new Error("Invalid memory validity interval");
  }
}

/**
 * Returns the end of an older open interval when an explicitly supplied new
 * start makes that closure safe. This must only be used for supersessions,
 * never retractions (an inaccurate claim was not formerly true).
 */
export function safeSupersededValidTo(
  previous: MemoryValidity,
  newValidFrom: number | undefined,
): number | undefined {
  if (
    newValidFrom === undefined ||
    !Number.isFinite(newValidFrom) ||
    previous.validTo !== undefined ||
    (previous.validFrom !== undefined && previous.validFrom >= newValidFrom)
  ) {
    return undefined;
  }
  return newValidFrom;
}
