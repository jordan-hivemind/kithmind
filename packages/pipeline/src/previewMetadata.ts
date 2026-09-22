import { createHash } from "node:crypto";

import type { ArchivedWorkIdentity } from "@repo/worker-protocol";
import type {
  TriageDocumentKind,
  TriagePreviewDeclaration,
  TriageUncertaintyCode,
} from "@repo/worker-protocol/request";

import type { DocumentPreviewResult } from "./parserProcess.js";

const CLASSIFIER_VERSION = "bounded-native-heading-v2";
const AUTOMATIC_POLICY_VERSION = "automatic-preview-policy-v1";

export const AUTOMATIC_PREVIEW_POLICY_SHA256 = createHash("sha256")
  .update(AUTOMATIC_POLICY_VERSION)
  .digest("hex");

export type AutomaticPreviewRoute = "deep_priority" | "metadata_only" | "defer";

function previewText(preview: DocumentPreviewResult): string {
  return preview.unitTexts.join("\n").normalize("NFKC").toLowerCase();
}

function taxHeading(text: string): boolean {
  return /(?:^|\n)\s*(?:(?:u\.?s\.?)\s+)?(?:form\s+(?:1040(?:-sr)?|1041|1065|1120(?:-s)?|990)\b|schedule\s+k-1\b|(?:individual|corporation|partnership|estate|trust)\s+income\s+tax\s+return\b)/m.test(
    text,
  );
}

function bulkTradeHistory(text: string): boolean {
  const excluded =
    /\b(?:1099|tax reporting statement|account statement|portfolio statement|holdings|positions)\b/.test(
      text,
    );
  const positive =
    /\b(?:trade history|all[- ]trades|(?:history|report|summary|listing) of (?:all )?trades|trades report)\b/.test(
      text,
    );
  return /\bmorgan stanley\b/.test(text) && positive && !excluded;
}

function classifyPdf(preview: DocumentPreviewResult): {
  documentKind: TriageDocumentKind;
  confidence: number | null;
  title?: string;
} {
  const text = previewText(preview);
  if (taxHeading(text)) {
    const title = /schedule\s+k-1\s*\(\s*form\s+1065\s*\)/.test(text)
      ? "Schedule K-1 (Form 1065)"
      : /(?:^|\n)\s*(?:(?:u\.?s\.?)\s+)?form\s+1040(?:-sr)?\b/m.test(text)
        ? "Form 1040"
        : undefined;
    return {
      documentKind: "tax_return",
      confidence: 0.95,
      ...(title ? { title } : {}),
    };
  }
  if (
    /\b(?:account|portfolio|brokerage|bank)\s+statement\b/.test(text) ||
    /\bstatement\s+period\b/.test(text)
  )
    return { documentKind: "financial_statement", confidence: 0.9 };
  if (/\b(?:receipt|invoice)\b/.test(text) && /\btotal\b/.test(text))
    return { documentKind: "receipt", confidence: 0.8 };
  if (/^\s*dear\b/m.test(text) || /\bsincerely\b/.test(text))
    return { documentKind: "letter", confidence: 0.75 };
  return { documentKind: "unknown", confidence: null };
}

/** Converts bounded executor output into provisional metadata, never facts. */
export function previewDeclaration(
  preview: DocumentPreviewResult,
): TriagePreviewDeclaration {
  const uncertaintyCodes: TriageUncertaintyCode[] = [];
  if (preview.unitStates.includes("image_only"))
    uncertaintyCodes.push("image_only");
  if (
    preview.unitStates.length > 0 &&
    preview.unitStates.some((state) => state !== "text_available")
  )
    uncertaintyCodes.push("insufficient_text");
  const classified =
    preview.mediaType === "application/pdf"
      ? classifyPdf(preview)
      : { documentKind: "spreadsheet" as const, confidence: 1 };
  const text = previewText(preview);
  const bulkHistory =
    preview.mediaType === "application/pdf" && bulkTradeHistory(text);
  const tradeConfirmation =
    preview.mediaType === "application/pdf" &&
    /\btrade confirmation\b/.test(text) &&
    !bulkHistory;
  if (
    classified.documentKind === "unknown" &&
    preview.unitStates.includes("text_available")
  )
    uncertaintyCodes.push("type_ambiguous");
  return {
    previewFingerprint: createHash("sha256")
      .update("kithmind-triage-preview:v2\0")
      .update(
        JSON.stringify([
          preview.method,
          preview.methodFingerprint,
          preview.inspectedOriginalUnits,
          CLASSIFIER_VERSION,
        ]),
      )
      .digest("hex"),
    previewMethod: preview.method,
    sourceFormat:
      preview.mediaType === "application/pdf" ? "pdf" : "spreadsheet",
    sourceUnitCount: preview.sourceUnitCount,
    inspectedOriginalUnits: preview.inspectedOriginalUnits,
    provisionalMetadata: {
      documentKind:
        bulkHistory || tradeConfirmation ? "other" : classified.documentKind,
      ...(bulkHistory
        ? { title: "Brokerage trade history" }
        : tradeConfirmation
          ? { title: "Trade confirmation" }
          : classified.title
            ? { title: classified.title }
            : {}),
      ...(uncertaintyCodes.length === 0 ? {} : { uncertaintyCodes }),
    },
    confidence: bulkHistory || tradeConfirmation ? 0.9 : classified.confidence,
  };
}

/** The only automatic deep route in v1 is a positive tax-form heading. */
export function automaticPreviewRoute(
  preview: TriagePreviewDeclaration,
): AutomaticPreviewRoute {
  if (
    preview.provisionalMetadata.documentKind === "tax_return" &&
    (preview.provisionalMetadata.title === "Form 1040" ||
      preview.provisionalMetadata.title === "Schedule K-1 (Form 1065)") &&
    preview.confidence !== null &&
    preview.confidence >= 0.9
  )
    return "deep_priority";
  if (
    preview.provisionalMetadata.title === "Brokerage trade history" ||
    preview.provisionalMetadata.title === "Trade confirmation"
  )
    return "metadata_only";
  return "defer";
}

export function stablePreviewRequestId(
  identity: ArchivedWorkIdentity,
  preview: TriagePreviewDeclaration,
): string {
  const bytes = createHash("sha256")
    .update("kithmind-selected-preview-request:v1\0")
    .update(JSON.stringify([identity, preview]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
