import type {
  FinanceReviewAction,
  FinanceReviewActionOutcome,
  FinanceReviewItem,
} from "@repo/finance-archive";
import { z } from "zod";

export type FinanceReviewPage = {
  items: readonly FinanceReviewItem[];
  nextCursor: string | null;
};

export type FinanceReviewMutationResult = {
  outcome: FinanceReviewActionOutcome;
};

const note = z.string().trim().max(500).optional();

export const financeReviewActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("confirm_instrument_match"),
      reviewItemId: z.string().min(1),
      matchedInstrumentId: z.string().min(1),
      note,
    })
    .strict(),
  z
    .object({
      kind: z.literal("map_account_key"),
      reviewItemId: z.string().min(1),
      targetAccountId: z.string().min(1),
      aliasKind: z.enum(["api_key", "statement_number"]),
      note,
    })
    .strict(),
  z
    .object({
      kind: z.literal("acknowledge_safeguard"),
      reviewItemId: z.string().min(1),
      note,
    })
    .strict(),
  z
    .object({
      kind: z.literal("dismiss"),
      reviewItemId: z.string().min(1),
      note: z.string().trim().min(1).max(500),
    })
    .strict(),
]);

export type FinanceReviewActionInput = z.infer<
  typeof financeReviewActionSchema
>;

const PROBLEM_LABELS: Readonly<Record<string, string>> = {
  weak_instrument_match: "Verify a security match",
  unknown_account_key: "Choose the right account",
  cash_on_noncash_activity: "Check a withheld cash amount",
  quantity_on_nonquantity_activity: "Check a withheld quantity",
  ambiguous_market_value: "Check a withheld market value",
  ambiguous_total_value: "Check a withheld account value",
  duplicate_holding_removed: "Confirm a duplicate holding removal",
  document_unparsed: "Document could not be read",
  balance_cash_conflict: "Conflicting cash balances",
  undeclared_activity_type: "Unknown activity type",
  retention_dropped_fields: "Source fields were not retained",
};

export function humanizeFinanceReview(value: string): string {
  return value.replaceAll("_", " ");
}

export function financeReviewProblem(item: FinanceReviewItem): string {
  return PROBLEM_LABELS[item.kind] ?? humanizeFinanceReview(item.kind);
}

export function financeReviewResolution(item: FinanceReviewItem): string {
  if (item.status === "dismissed") {
    return item.resolutionNote?.toLowerCase().includes("not enough information")
      ? "Not enough information"
      : "Not needed";
  }
  if (item.status === "resolved") return "Resolved";
  if (item.guidance.actionKinds.includes("confirm_instrument_match")) {
    return "Confirm security";
  }
  if (item.guidance.actionKinds.includes("map_account_key")) {
    return "Choose account";
  }
  if (item.guidance.actionKinds.includes("acknowledge_safeguard")) {
    return "Confirm safeguard";
  }
  return "Resolution not yet supported";
}

export function financeReviewCanAct(
  item: FinanceReviewItem,
  kind: FinanceReviewAction["kind"],
): boolean {
  return item.status === "open" && item.guidance.actionKinds.includes(kind);
}
