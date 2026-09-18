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

/**
 * P2-100b. One awaited call each inside the archived-binary block of
 * `terminalReady`, so a throw names the loader that raised it rather than
 * landing in the catch-all `archive_chain_error`. Every stage below is a call
 * site in assessment.ts; adding a call there without a stage here leaves it
 * attributed to the fallback, which is the signal to add one.
 */
export const REASON_STAGES = [
  "row_parse_error:revision",
  "row_parse_error:generation",
  "row_parse_error:job",
  "row_parse_error:parser_artifact",
  "row_parse_error:text_version",
  "fingerprint_digest_error",
  "binding_load_error:original_bytes/primary",
  "binding_load_error:original_bytes/independent_backup",
  "binding_load_error:parser_output/primary",
  "binding_load_error:parser_output/independent_backup",
  // `loadProviderOriginalBinding` loads the reference itself, so a reference
  // fault reaches here as `provider_binding_load_error:provider_reference_*`.
  // `provider_reference_load_error` is the separate chain walk on the
  // provider leg, which `requireProviderOriginalReferenceChain` performs.
  "provider_binding_load_error",
  "provider_reference_load_error",
  "receipt_chain",
  "archive_independence",
  "archive_set_digest_error",
  "payload_verify_error",
] as const;

export type ReasonStage = (typeof REASON_STAGES)[number];

/**
 * The fixed literals the loaders in scope throw, mapped to a closed kind.
 *
 * `file` is asserted by the test against the real source, so a renamed or
 * deleted message cannot silently degrade to `unmapped_error`. Only the
 * literal is matched: the message is never recorded, and none of these
 * messages interpolate a row value (that is why they can be matched at all).
 */
export const LOADER_ERROR_MESSAGES: ReadonlyArray<{
  message: string;
  file: string;
  kind: string;
}> = [
  {
    message: "Archive binding identity is not unique",
    file: "src/provenance/archiveBindings.ts",
    kind: "archive_binding_not_unique",
  },
  {
    message: "Current archive binding is invalid",
    file: "src/provenance/archiveBindings.ts",
    kind: "archive_binding_invalid",
  },
  {
    message: "Archive binding conflicts with current selection",
    file: "src/provenance/archiveBindings.ts",
    kind: "archive_binding_conflict",
  },
  {
    message: "Archive binding epoch is not current",
    file: "src/provenance/archiveBindings.ts",
    kind: "archive_binding_epoch_stale",
  },
  {
    message: "Archive copies are not independently identified",
    file: "src/provenance/archiveBindings.ts",
    kind: "archive_copies_not_independent",
  },
  {
    message: "Provider original binding is not unique",
    file: "src/provenance/providerOriginals.ts",
    kind: "provider_binding_not_unique",
  },
  {
    message: "Provider original binding is invalid",
    file: "src/provenance/providerOriginals.ts",
    kind: "provider_binding_invalid",
  },
  {
    message: "Provider original binding verification is invalid",
    file: "src/provenance/providerOriginals.ts",
    kind: "provider_binding_verification_invalid",
  },
  {
    message: "Provider original binding parent is invalid",
    file: "src/provenance/providerOriginals.ts",
    kind: "provider_binding_parent_invalid",
  },
  {
    message: "Provider original reference is invalid",
    file: "src/provenance/providerOriginals.ts",
    kind: "provider_reference_invalid",
  },
  {
    message: "Provider original reference parent is invalid",
    file: "src/provenance/providerOriginals.ts",
    kind: "provider_reference_parent_invalid",
  },
  {
    message: "Provider original identity is not unique",
    file: "src/provenance/providerOriginals.ts",
    kind: "provider_identity_not_unique",
  },
  {
    message: "Provider original identity requires review",
    file: "src/provenance/providerOriginals.ts",
    kind: "provider_identity_review",
  },
  {
    message: "Provider original declaration is invalid",
    file: "src/provenance/providerOriginals.ts",
    kind: "provider_declaration_invalid",
  },
  {
    message: "Provider original verification is stale",
    file: "src/provenance/providerOriginals.ts",
    kind: "provider_verification_stale",
  },
  {
    message: "Conflicting immutable provider original reference",
    file: "src/provenance/providerOriginals.ts",
    kind: "provider_reference_conflict",
  },
];

/** Constructor names worth keeping. Anything else degrades to the fallback. */
const ERROR_CONSTRUCTORS = ["Error", "TypeError", "RangeError", "DatabaseError"];

/** A pg SQLSTATE, the only value read off a database error. */
const SQLSTATE = /^[0-9A-Za-z]{5}$/;

export const ERROR_KINDS = [
  ...WORKER_PROTOCOL_ERROR_CODES,
  ...LOADER_ERROR_MESSAGES.map((entry) => entry.kind),
  ...ERROR_CONSTRUCTORS,
  "unmapped_error",
];

const KINDS = new Set<string>(ERROR_KINDS);
const MESSAGE_KINDS = new Map(
  LOADER_ERROR_MESSAGES.map((entry) => [entry.message, entry.kind]),
);

/**
 * What kind of error this was, with nothing of what it said.
 *
 * Order matters: a coded error answers with its code, a known fixed literal
 * with its mapped kind, a database error with its SQLSTATE alone, and anything
 * else with its constructor name when that name is one of a closed few. No
 * message, column value, id or stack is ever read.
 */
export function errorKind(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && KINDS.has(code)) return code;
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string") {
    const mapped = MESSAGE_KINDS.get(message);
    if (mapped) return mapped;
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "DatabaseError" && typeof code === "string" && SQLSTATE.test(code))
    return `sqlstate:${code}`;
  const constructor = (error as { constructor?: { name?: unknown } } | null)
    ?.constructor?.name;
  return typeof constructor === "string" && ERROR_CONSTRUCTORS.includes(constructor)
    ? constructor
    : "unmapped_error";
}

/** `<stage>:<kind>`, both halves closed. */
export function stagedReason(stage: ReasonStage, error: unknown): NotReadyReason {
  return `${stage}:${errorKind(error)}` as NotReadyReason;
}

/**
 * A plain reason, or `<stage>:<kind>`. The template arm keeps a typo in a
 * plain reason a compile error while letting the kind be assembled at the
 * throw site; `isNotReadyReason` is the runtime check on what was stored.
 */
export type NotReadyReason =
  | (typeof NOT_READY_REASONS)[number]
  | `${ReasonStage}:${string}`;

const REASONS = new Set<string>(NOT_READY_REASONS);

/** The overflow key, and the cap that keeps one row's key set bounded. */
export const OTHER_REASON = "other";
export const MAX_REASON_KEYS = 32;

/**
 * Whether a key is one this build can have written: a plain reason, the
 * overflow key, or `<stage>:<kind>` with both halves from their closed sets
 * (a SQLSTATE kind is five alphanumerics and carries nothing else).
 */
export function isNotReadyReason(key: string): boolean {
  if (REASONS.has(key) || key === OTHER_REASON) return true;
  // A stage may itself contain a colon, so match by prefix rather than split.
  const stage = REASON_STAGES.find((candidate) =>
    key.startsWith(`${candidate}:`),
  );
  if (!stage) return false;
  const kind = key.slice(stage.length + 1);
  return (
    KINDS.has(kind) ||
    (kind.startsWith("sqlstate:") && SQLSTATE.test(kind.slice("sqlstate:".length)))
  );
}

/** A tally of reason to item count. Keys always satisfy `isNotReadyReason`. */
export type NotReadyReasons = Partial<Record<string, number>>;

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
    if (!isNotReadyReason(key)) continue;
    if (!Number.isSafeInteger(count) || (count as number) < 0) continue;
    if (Object.keys(reasons).length >= MAX_REASON_KEYS) continue;
    reasons[key] = count as number;
  }
  return reasons;
}

/**
 * Adds one to a reason's tally, folding into `other` once the row already
 * holds `MAX_REASON_KEYS` distinct keys. The cap is what keeps a stage/kind
 * key space (a SQLSTATE can be any of hundreds) from growing the row without
 * bound; in practice one pass reports a handful of reasons.
 */
export function incrementReason(
  reasons: NotReadyReasons,
  reason: NotReadyReason,
): NotReadyReasons {
  const key =
    reason in reasons || Object.keys(reasons).length < MAX_REASON_KEYS
      ? reason
      : OTHER_REASON;
  return { ...reasons, [key]: (reasons[key] ?? 0) + 1 };
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
