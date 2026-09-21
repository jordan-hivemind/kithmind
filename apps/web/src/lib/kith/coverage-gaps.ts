import type { coverage } from "@repo/kith-store";

import { label, shortDate, tableDateTime } from "@/lib/kith/format";

const REASON_COPY: Readonly<Record<string, string>> = {
  enumeration_incomplete: "The source scan did not finish.",
  historical_range_unverified: "The source has not verified this historical period.",
  missing_period: "The expected period was not found in the source.",
  missing_statement: "An expected statement was not found.",
  processing_failed: "The source item could not be processed.",
  provider_omission: "The provider omitted expected records.",
  skipped_item: "A discovered source item was skipped.",
  source_gap: "The source did not provide records for the expected period.",
};

const CONSEQUENCE_COPY: Readonly<Record<string, string>> = {
  fee: "Fee totals and period summaries may be incomplete.",
  fees: "Fee totals and period summaries may be incomplete.",
  financial_statement: "Financial totals for this period may be incomplete.",
  lab: "Health-history answers may miss results from this period.",
  medical: "Health-history answers may miss records from this period.",
  statement: "Statement-based totals for this period may be incomplete.",
  tax: "Tax-record answers for this period may be incomplete.",
  vehicle_service: "Vehicle service history may be incomplete.",
};

function sentence(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") return "The source reported an unspecified coverage condition.";
  return `${trimmed[0]!.toUpperCase()}${trimmed.slice(1)}${/[.!?]$/.test(trimmed) ? "" : "."}`;
}

export function coverageGapReasonCopy(reason: string): string {
  const known = REASON_COPY[reason];
  if (known !== undefined) return known;
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(reason)) {
    return `The source reported: ${label(reason).toLowerCase()}.`;
  }
  return sentence(reason);
}

function recordLabel(recordType: string): string {
  const normalized = label(recordType).toLowerCase();
  if (normalized.endsWith("statement")) return `${normalized}s`;
  if (normalized.endsWith("record") || normalized.endsWith("records")) {
    return normalized.endsWith("s") ? normalized : `${normalized}s`;
  }
  return `${normalized} records`;
}

export function coverageGapRange(
  from: number | null,
  to: number | null,
): string {
  if (from === null || to === null) return "Range not recorded";
  return `${shortDate(from)} to ${shortDate(to)}`;
}

function sourceLabel(gap: coverage.CoverageGapListItem): string {
  return gap.sourceName.trim() || label(gap.connector) || "Configured source";
}

export type CoverageGapView = coverage.CoverageGapListItem & {
  description: string;
  dataType: string;
  source: string;
  account: string;
  expectedRange: string;
  observedRange: string;
  reasonCopy: string;
  consequence: string;
  expectationEvidence: string;
  detected: string;
};

export function coverageGapView(
  gap: coverage.CoverageGapListItem,
): CoverageGapView {
  const source = sourceLabel(gap);
  const expectedRange = coverageGapRange(gap.expectedFrom, gap.expectedTo);
  const observedRange = coverageGapRange(gap.observedFrom, gap.observedTo);
  const type = recordLabel(gap.recordType);
  const consequence =
    CONSEQUENCE_COPY[gap.recordType] ??
    `Answers about ${label(gap.recordType).toLowerCase()} may be incomplete.`;
  const expectationEvidence =
    gap.lastEnumeratedAt === null
      ? `Coverage reconciliation detected this condition on ${shortDate(gap.detectedAt)}.`
      : `The source inventory was checked on ${shortDate(gap.lastEnumeratedAt)} and covers ${observedRange.toLowerCase()}.`;
  return {
    ...gap,
    description:
      gap.expectedFrom === null
        ? `${source} is missing expected ${type}.`
        : `No ${source} ${type} found for ${expectedRange.toLowerCase()}.`,
    dataType: label(gap.recordType),
    source,
    account: gap.accountId.trim() || "Account not recorded",
    expectedRange,
    observedRange,
    reasonCopy: coverageGapReasonCopy(gap.reason),
    consequence,
    expectationEvidence,
    detected: tableDateTime(gap.detectedAt),
  };
}
