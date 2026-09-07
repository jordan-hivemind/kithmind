import { ConvexError } from "convex/values";

const INLINE_INGEST_ERROR_CODES = [
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

export type InlineIngestErrorData = {
  type: "inline_ingest_error";
  code: InlineIngestErrorCode;
};

const inlineIngestErrorCodes = new Set<string>(INLINE_INGEST_ERROR_CODES);

export function parseInlineIngestErrorData(
  value: unknown,
): InlineIngestErrorData | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("type" in value) ||
    value.type !== "inline_ingest_error" ||
    !("code" in value) ||
    typeof value.code !== "string" ||
    !inlineIngestErrorCodes.has(value.code)
  ) {
    return undefined;
  }
  return {
    type: "inline_ingest_error",
    code: value.code as InlineIngestErrorCode,
  };
}

function errorData(error: unknown): unknown {
  return typeof error === "object" && error !== null && "data" in error
    ? error.data
    : undefined;
}

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

export function inlineIngestErrorCode(
  error: unknown,
): InlineIngestErrorCode | undefined {
  const structured = parseInlineIngestErrorData(errorData(error));
  if (structured) return structured.code;

  const message = error instanceof Error ? error.message : "";
  if (message === "Not authenticated") return "not_authenticated";
  if (message === "Source account not found") {
    return "source_account_not_found";
  }
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
  if (message === "Ingest rate limit exceeded") {
    return "ingest_rate_limited";
  }
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

export function toInlineIngestConvexError(
  error: unknown,
): ConvexError<InlineIngestErrorData> | undefined {
  const code = inlineIngestErrorCode(error);
  return code
    ? new ConvexError({ type: "inline_ingest_error", code })
    : undefined;
}

export function rethrowInlineIngestError(error: unknown): never {
  throw toInlineIngestConvexError(error) ?? error;
}
