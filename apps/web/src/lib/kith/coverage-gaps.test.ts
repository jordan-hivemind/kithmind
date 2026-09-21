import { describe, expect, test } from "vitest";

import {
  coverageGapReasonCopy,
  coverageGapView,
} from "@/lib/kith/coverage-gaps";

const gap = {
  id: "gap_1",
  spaceId: "space_1",
  sourceAccountId: "source_1",
  sourceName: "Morgan Stanley",
  connector: "filesystem",
  accountId: "Brokerage 1234",
  recordType: "statement",
  entityId: null,
  entityName: null,
  expectedFrom: Date.UTC(2025, 2, 1),
  expectedTo: Date.UTC(2025, 5, 1),
  observedFrom: Date.UTC(2025, 0, 1),
  observedTo: Date.UTC(2025, 2, 1),
  lastEnumeratedAt: Date.UTC(2025, 5, 2),
  reason: "missing_statement",
  detectedAt: Date.UTC(2025, 5, 3),
};

describe("coverage gap copy", () => {
  test("maps known reason codes and gives every unknown code readable copy", () => {
    expect(coverageGapReasonCopy("missing_statement")).toBe(
      "An expected statement was not found.",
    );
    expect(coverageGapReasonCopy("provider_window_closed")).toBe(
      "The source reported: provider window closed.",
    );
    expect(coverageGapReasonCopy("Provider omitted one panel")).toBe(
      "Provider omitted one panel.",
    );
  });

  test("builds the required description, ranges, consequence and evidence", () => {
    expect(coverageGapView(gap)).toMatchObject({
      description:
        "No Morgan Stanley statements found for 3-1-2025 to 6-1-2025.",
      dataType: "Statement",
      source: "Morgan Stanley",
      account: "Brokerage 1234",
      expectedRange: "3-1-2025 to 6-1-2025",
      observedRange: "1-1-2025 to 3-1-2025",
      reasonCopy: "An expected statement was not found.",
      consequence: "Statement-based totals for this period may be incomplete.",
      expectationEvidence:
        "The source inventory was checked on 6-2-2025 and covers 1-1-2025 to 3-1-2025.",
    });
  });
});
