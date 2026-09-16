// An admission failure, as the transport has to answer it.
//
// Ported from `models/ingestion/inlineErrors.ts`. The bounded text capture
// contract publishes a status table (400, 401, 403, 409, 413, 429) and the route
// cannot pick a row from it without knowing which refusal it is holding. Convex
// solved that by classifying the thrown message into a closed code set and
// wrapping it in a `ConvexError`; this keeps the classifier and drops the
// wrapper, because there is no second runtime to serialize across any more --
// the route imports this function directly.
//
// The strings matched here are the ones `input.ts`, `inlineWork.ts` and
// `../provenance/model.ts` actually throw. A message changed in one of those
// files without changing this one turns a 400 into a 500, which is why the
// inline ingestion test asserts the mapping rather than trusting it.

export const INLINE_INGEST_ERROR_CODES = [
  "not_authenticated",
  "source_account_not_found",
  "space_not_found",
  "default_ingest_space_unavailable",
  "invalid_request",
  "request_conflict",
  "desired_processing_epoch_conflict",
  "ingest_rate_limited",
  "source_item_unavailable",
] as const;

export type InlineIngestErrorCode = (typeof INLINE_INGEST_ERROR_CODES)[number];

function isInlineInputValidationMessage(message: string): boolean {
  return (
    /^(?:spaceId|requestId|expectedDesiredProcessingEpoch|source\.(?:connector|accountId|externalId|uri|capturedAt)|title|docType|Inline text) (?:is invalid|contains malformed UTF-16|must be an RFC3339 instant|is outside the supported limit|must not be empty or whitespace-only|contains an unpaired (?:high|low) surrogate)$/.test(
      message,
    ) ||
    /^Inline text exceeds the supported \d+(?:-byte| chunk) limit$/.test(
      message,
    )
  );
}

/**
 * The code `error` carries, or undefined when the failure is not one the
 * contract names -- in which case the route owes a 500 and must not invent a
 * friendlier status for a defect.
 */
export function inlineIngestErrorCode(
  error: unknown,
): InlineIngestErrorCode | undefined {
  const message = error instanceof Error ? error.message : "";
  if (message === "Not authenticated") return "not_authenticated";
  if (message === "Source account not found") return "source_account_not_found";
  if (message === "Space not found") return "space_not_found";
  if (message === "Default ingest space is not available") {
    return "default_ingest_space_unavailable";
  }
  if (message === "requestId conflicts with a different request") {
    return "request_conflict";
  }
  if (message === "Desired processing epoch conflict") {
    return "desired_processing_epoch_conflict";
  }
  if (message === "Ingest rate limit exceeded") return "ingest_rate_limited";
  if (
    message === "Source item is not available for admission" ||
    message === "Source item is forgetting" ||
    message === "Source item is forgotten"
  ) {
    return "source_item_unavailable";
  }
  if (isInlineInputValidationMessage(message)) return "invalid_request";
  return undefined;
}
