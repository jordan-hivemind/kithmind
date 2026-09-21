import type { FinanceReviewItem } from "@repo/finance-archive";
import { describe, expect, test } from "vitest";

import {
  financeReviewActionSchema,
  financeReviewCanAct,
  financeReviewProblem,
  financeReviewResolution,
} from "./finance-reviews";

function item(
  kind: string,
  actionKinds: FinanceReviewItem["guidance"]["actionKinds"],
  status: FinanceReviewItem["status"] = "open",
): FinanceReviewItem {
  return {
    id: `review-${kind}`,
    kind,
    accountId: null,
    institutionId: null,
    sourceDocumentId: null,
    sourceLocator: null,
    rawValue: null,
    reason: "Synthetic review reason",
    reasonCode: null,
    status,
    resolvedAt: null,
    resolutionNote: null,
    matchedInstrumentId: null,
    occurrenceCount: null,
    lastSeenDocumentId: null,
    guidance: {
      category: actionKinds.length === 1 ? "external_action" : "repair",
      summary: "Synthetic summary",
      nextAction: "Synthetic next action",
      actionKinds,
    },
  };
}

describe("finance review presentation", () => {
  test.each([
    ["weak_instrument_match", "Verify a security match", "Confirm security"],
    ["unknown_account_key", "Choose the right account", "Choose account"],
    [
      "cash_on_noncash_activity",
      "Check a withheld cash amount",
      "Confirm safeguard",
    ],
    [
      "quantity_on_nonquantity_activity",
      "Check a withheld quantity",
      "Confirm safeguard",
    ],
    [
      "ambiguous_market_value",
      "Check a withheld market value",
      "Confirm safeguard",
    ],
    [
      "ambiguous_total_value",
      "Check a withheld account value",
      "Confirm safeguard",
    ],
    [
      "duplicate_holding_removed",
      "Confirm a duplicate holding removal",
      "Confirm safeguard",
    ],
    [
      "document_unparsed",
      "Document could not be read",
      "Resolution not yet supported",
    ],
    [
      "balance_cash_conflict",
      "Conflicting cash balances",
      "Resolution not yet supported",
    ],
    [
      "undeclared_activity_type",
      "Unknown activity type",
      "Resolution not yet supported",
    ],
    [
      "retention_dropped_fields",
      "Source fields were not retained",
      "Resolution not yet supported",
    ],
    ["future_review", "future review", "Resolution not yet supported"],
  ])(
    "maps %s to plain language and its supported resolution",
    (kind, problem, resolution) => {
      const actions =
        kind === "weak_instrument_match"
          ? (["confirm_instrument_match", "dismiss"] as const)
          : kind === "unknown_account_key"
            ? (["map_account_key", "dismiss"] as const)
            : [
                  "cash_on_noncash_activity",
                  "quantity_on_nonquantity_activity",
                  "ambiguous_market_value",
                  "ambiguous_total_value",
                  "duplicate_holding_removed",
                ].includes(kind)
              ? (["acknowledge_safeguard", "dismiss"] as const)
              : (["dismiss"] as const);
      const review = item(kind, actions);
      expect(financeReviewProblem(review)).toBe(problem);
      expect(financeReviewResolution(review)).toBe(resolution);
    },
  );

  test("closed items expose no action and retain their outcome", () => {
    const dismissed = item("document_unparsed", ["dismiss"], "dismissed");
    expect(financeReviewCanAct(dismissed, "dismiss")).toBe(false);
    expect(financeReviewResolution(dismissed)).toBe("Not needed");
    expect(
      financeReviewResolution({
        ...dismissed,
        resolutionNote: "dismissed: Not enough information to resolve safely",
      }),
    ).toBe("Not enough information");
  });
});

describe("finance review action input", () => {
  test("accepts only the service's type-specific actions", () => {
    expect(
      financeReviewActionSchema.safeParse({
        kind: "confirm_instrument_match",
        reviewItemId: "review-1",
        matchedInstrumentId: "instrument-1",
      }).success,
    ).toBe(true);
    expect(
      financeReviewActionSchema.safeParse({
        kind: "correct_amount",
        reviewItemId: "review-1",
        amount: "12.34",
      }).success,
    ).toBe(false);
  });

  test("dismissal requires an explicit outcome note", () => {
    expect(
      financeReviewActionSchema.safeParse({
        kind: "dismiss",
        reviewItemId: "review-1",
        note: "Not enough information to resolve safely",
      }).success,
    ).toBe(true);
    expect(
      financeReviewActionSchema.safeParse({
        kind: "dismiss",
        reviewItemId: "review-1",
        note: "   ",
      }).success,
    ).toBe(false);
  });
});
