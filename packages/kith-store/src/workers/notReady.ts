// Why an item was not terminal ready, as bounded counts.
//
// `terminalReady` answers a bare boolean over roughly sixty conditions, so an
// item that falls one condition short lands in `unavailable` (or `pending`)
// with nothing on the row saying which condition. After the Convex to
// Postgres cutover that cost a whole diagnosis pass: nine migrated documents
// went `unavailable` and the only way to ask why was to re-derive every check
// by hand. This records one closed-enum reason per not-ready item and stores
// the tally beside the existing counts.
//
// Diagnostic only. A reason never changes an item's bucket, never changes the
// complete/incomplete decision, and never reaches the worker protocol
// response (see `notReadyReasons` in assessment.ts: the tally rides in the
// `counts` jsonb column, which `normalizedCounts` rebuilds field by field, so
// the extra key is dropped on every read and on every response).
//
// PRIVACY: every code below is a fixed literal. Never interpolate a row value
// into one. No id, hash, digest, path, title, uri or epoch, ever. The
// assessment row is read by operators and copied into reports, so a reason
// must be safe to publish on its own.

import { WORKER_PROTOCOL_ERROR_CODES } from "@repo/worker-protocol/request";

export const NOT_READY_REASONS = [
  // Shared preconditions on the item and its scan entry.
  "item_state",
  "item_epoch_mismatch",
  "content_hash_mismatch",
  "revision_not_active",
  "epoch_not_integer",
  "detail_missing",
  // The one ingest job the generation must own.
  "job_count",
  "job_shape",
  "generation_shape",
  "revision_shape",
  "profile_mismatch",
  // Which of the seven processing fingerprints disagreed.
  "fingerprint_mismatch:parser",
  "fingerprint_mismatch:extraction",
  "fingerprint_mismatch:extractor",
  "fingerprint_mismatch:record_schema",
  "fingerprint_mismatch:normalization",
  "fingerprint_mismatch:chunker",
  "fingerprint_mismatch:correction",
  "fingerprint_mismatch:derived",
  "fingerprint_mismatch:inline",
  // The archived-binary chain.
  "archive_selection",
  "artifact_missing",
  "text_version_shape",
  "binding_missing:original/primary",
  "binding_missing:original/backup",
  "binding_missing:parser/primary",
  "binding_missing:parser/backup",
  "binding_missing:provider",
  "receipt_chain",
  "archive_independence",
  "archive_chain_error",
  "generation_receipt_mismatch",
  "archive_set_digest_mismatch",
  "sealed_payload_counts",
  // The inline chain.
  "inline_digest_mismatch",
  "inline_text_missing",
  "inline_text_rehash",
  "plan_counts",
  // A protocol error raised after the readiness check and swallowed into
  // `unavailable`, tagged with the code it carried.
  ...WORKER_PROTOCOL_ERROR_CODES.map(
    (code) => `protocol_error:${code}` as const,
  ),
] as const;

export type NotReadyReason = (typeof NOT_READY_REASONS)[number];

const REASONS = new Set<string>(NOT_READY_REASONS);

/** A tally of reason to item count. Keys are always from `NOT_READY_REASONS`. */
export type NotReadyReasons = Partial<Record<NotReadyReason, number>>;

/** Records at most one reason per item: the first condition that failed. */
export function reasonSink(): {
  note: (reason: NotReadyReason) => void;
  first: () => NotReadyReason | undefined;
} {
  let first: NotReadyReason | undefined;
  return {
    note: (reason) => {
      if (first === undefined) first = reason;
    },
    first: () => first,
  };
}

/**
 * The tally carried in an assessment's `counts` jsonb under `notReadyReasons`,
 * keeping only closed-enum keys with safe integer counts. Anything else is
 * dropped rather than refused: a reason is diagnostic, and a page must not
 * fail because a stale or hand-edited row held a key this build does not know.
 */
export function readNotReadyReasons(
  value: Record<string, unknown> | null,
): NotReadyReasons {
  const raw = value?.notReadyReasons;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const reasons: NotReadyReasons = {};
  for (const [key, count] of Object.entries(raw as Record<string, unknown>)) {
    if (!REASONS.has(key)) continue;
    if (!Number.isSafeInteger(count) || (count as number) < 0) continue;
    reasons[key as NotReadyReason] = count as number;
  }
  return reasons;
}

export function incrementReason(
  reasons: NotReadyReasons,
  reason: NotReadyReason,
): NotReadyReasons {
  return { ...reasons, [reason]: (reasons[reason] ?? 0) + 1 };
}

/**
 * The `counts` jsonb to store: the protocol-shaped counts plus the tally.
 * The tally is omitted when empty so a clean pass writes exactly what it
 * wrote before this change.
 */
export function countsWithReasons<T>(
  counts: T,
  reasons: NotReadyReasons,
): T | (T & { notReadyReasons: NotReadyReasons }) {
  return Object.keys(reasons).length === 0
    ? counts
    : { ...counts, notReadyReasons: reasons };
}
