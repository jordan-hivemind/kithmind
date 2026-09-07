import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";

import {
  inlineIngestErrorCode,
  parseInlineIngestErrorData,
  rethrowInlineIngestError,
} from "./inlineErrors";

describe("inline ingest public errors", () => {
  test.each([
    ["Not authenticated", "not_authenticated"],
    ["Source account not found", "source_account_not_found"],
    ["Space not found", "space_not_found"],
    [
      "Default ingest space is not available",
      "default_ingest_space_unavailable",
    ],
    ["requestId conflicts with a different request", "request_conflict"],
    ["Desired processing epoch conflict", "desired_processing_epoch_conflict"],
    ["Ingest rate limit exceeded", "ingest_rate_limited"],
    ["Source item is not available for admission", "source_item_unavailable"],
    ["spaceId is invalid", "invalid_request"],
    ["source.accountId is invalid", "invalid_request"],
    [
      "expectedDesiredProcessingEpoch is outside the supported limit",
      "invalid_request",
    ],
    ["Inline text exceeds the supported 65536-byte limit", "invalid_request"],
  ])("classifies the safe message %s", (message, code) => {
    expect(inlineIngestErrorCode(new Error(message))).toBe(code);
  });

  test("preserves only allowlisted structured codes", () => {
    const error = new ConvexError({
      type: "inline_ingest_error",
      code: "request_conflict",
    });

    expect(inlineIngestErrorCode(error)).toBe("request_conflict");
    expect(
      parseInlineIngestErrorData({
        type: "inline_ingest_error",
        code: "internal_database_failure",
      }),
    ).toBeUndefined();
  });

  test("does not turn an unknown failure into public error data", () => {
    const failure = new Error("private database invariant failed");

    expect(() => rethrowInlineIngestError(failure)).toThrow(failure);
  });
});
