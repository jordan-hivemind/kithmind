import { MCP_TOOL_NAME_LIST, MCP_TOOL_NAMES } from "@/lib/mcp/tools";

export type McpToolName = (typeof MCP_TOOL_NAMES)[keyof typeof MCP_TOOL_NAMES];

type McpToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies McpToolAnnotations;

const additive = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const satisfies McpToolAnnotations;

const idempotentAdditive = {
  ...additive,
  idempotentHint: true,
} as const satisfies McpToolAnnotations;

const managedWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const satisfies McpToolAnnotations;

const destructiveWrite = {
  ...managedWrite,
  destructiveHint: true,
} as const satisfies McpToolAnnotations;

/**
 * MCP annotations are risk hints for the host, not permission grants. Keep this
 * map exhaustive so new tools cannot silently inherit the protocol's
 * pessimistic defaults.
 *
 * One map, every surface. The i4 follow-up added a `mcpToolAnnotations(name,
 * surface)` seam so `capture_thought`'s `idempotentHint` could drop to false
 * under `postgres`, where the unported admission gate made a retried capture
 * store a second row. The gate is ported: a duplicate is NOOP on both surfaces,
 * the hint is true again, and the seam is gone rather than left as a
 * pass-through. If a hint ever stops being true on one surface it comes back;
 * what must not happen is this table being edited to make a surface-specific
 * claim, because section 3.3 of the web and MCP surface plan is explicit that
 * putting a permission in an annotation turns a hint into a grant.
 */
export const MCP_TOOL_ANNOTATIONS = {
  [MCP_TOOL_NAMES.ingestUrl]: idempotentAdditive,
  [MCP_TOOL_NAMES.queryRecords]: readOnly,
  [MCP_TOOL_NAMES.searchDocuments]: readOnly,
  [MCP_TOOL_NAMES.getDocument]: readOnly,
  [MCP_TOOL_NAMES.listDocumentSchemas]: readOnly,
  [MCP_TOOL_NAMES.getDocumentExtractionStatus]: readOnly,
  [MCP_TOOL_NAMES.listSources]: readOnly,
  [MCP_TOOL_NAMES.listInventory]: readOnly,
  [MCP_TOOL_NAMES.listReviewQueue]: readOnly,
  [MCP_TOOL_NAMES.listSpaces]: readOnly,
  [MCP_TOOL_NAMES.searchFacts]: readOnly,
  [MCP_TOOL_NAMES.rememberFact]: idempotentAdditive,
  [MCP_TOOL_NAMES.searchThoughts]: readOnly,
  [MCP_TOOL_NAMES.recallContext]: readOnly,
  [MCP_TOOL_NAMES.browseRecent]: readOnly,
  [MCP_TOOL_NAMES.getThoughts]: readOnly,
  [MCP_TOOL_NAMES.timelineThoughts]: readOnly,
  [MCP_TOOL_NAMES.getStats]: readOnly,
  [MCP_TOOL_NAMES.captureThought]: idempotentAdditive,
  [MCP_TOOL_NAMES.listInvestments]: readOnly,
  [MCP_TOOL_NAMES.getInvestment]: readOnly,
  [MCP_TOOL_NAMES.listTaxPayments]: readOnly,
  [MCP_TOOL_NAMES.getKithHelp]: readOnly,
  [MCP_TOOL_NAMES.getKithCapabilities]: readOnly,
  [MCP_TOOL_NAMES.listEntities]: readOnly,
  [MCP_TOOL_NAMES.listProfileFields]: readOnly,
  [MCP_TOOL_NAMES.getProfile]: readOnly,
  [MCP_TOOL_NAMES.manageProfileEntity]: managedWrite,
  [MCP_TOOL_NAMES.manageEntityAliases]: managedWrite,
  [MCP_TOOL_NAMES.manageInvestment]: managedWrite,
  [MCP_TOOL_NAMES.manageInvestmentEntry]: destructiveWrite,
  [MCP_TOOL_NAMES.manageTaxPayment]: idempotentAdditive,
  [MCP_TOOL_NAMES.listSupportingDocumentLinks]: readOnly,
  [MCP_TOOL_NAMES.manageSupportingDocumentLink]: managedWrite,
  [MCP_TOOL_NAMES.listAttention]: readOnly,
  [MCP_TOOL_NAMES.manageAttention]: managedWrite,
  [MCP_TOOL_NAMES.manageMemory]: destructiveWrite,
  [MCP_TOOL_NAMES.manageAccountDisplayOverride]: managedWrite,
  [MCP_TOOL_NAMES.correctExtractedValue]: managedWrite,
  [MCP_TOOL_NAMES.manageDocumentExtraction]: managedWrite,
  [MCP_TOOL_NAMES.listFinanceReviews]: readOnly,
  [MCP_TOOL_NAMES.getFinanceReview]: readOnly,
  [MCP_TOOL_NAMES.manageFinanceReview]: managedWrite,
  [MCP_TOOL_NAMES.listLedger]: readOnly,
  [MCP_TOOL_NAMES.listHoldings]: readOnly,
  [MCP_TOOL_NAMES.listHealthRecords]: readOnly,
  [MCP_TOOL_NAMES.getHealthDocument]: readOnly,
} as const satisfies Record<McpToolName, McpToolAnnotations>;

export const MCP_MEMORY_TOOL_NAMES = [
  MCP_TOOL_NAMES.ingestUrl,
  MCP_TOOL_NAMES.queryRecords,
  MCP_TOOL_NAMES.searchDocuments,
  MCP_TOOL_NAMES.getDocument,
  MCP_TOOL_NAMES.listSources,
  MCP_TOOL_NAMES.listInventory,
  MCP_TOOL_NAMES.listReviewQueue,
  MCP_TOOL_NAMES.listSpaces,
  MCP_TOOL_NAMES.searchFacts,
  MCP_TOOL_NAMES.rememberFact,
  MCP_TOOL_NAMES.searchThoughts,
  MCP_TOOL_NAMES.recallContext,
  MCP_TOOL_NAMES.browseRecent,
  MCP_TOOL_NAMES.getThoughts,
  MCP_TOOL_NAMES.timelineThoughts,
  MCP_TOOL_NAMES.getStats,
  MCP_TOOL_NAMES.captureThought,
  MCP_TOOL_NAMES.listInvestments,
  MCP_TOOL_NAMES.getInvestment,
  MCP_TOOL_NAMES.listTaxPayments,
  MCP_TOOL_NAMES.getKithHelp,
  MCP_TOOL_NAMES.getKithCapabilities,
  MCP_TOOL_NAMES.listProfileFields,
  MCP_TOOL_NAMES.getProfile,
] as const;

export type McpToolProfile = "memory" | "full";

/**
 * Default to the complete surface. Narrowing has to stay an explicit opt-in
 * rather than an upgrade-time surprise, because it can remove tools that
 * connected clients and the bundled plugin skills already call. The explicit
 * memory profile keeps recall, capture, investment reads and discovery, while
 * omitting the owner-management tools registered by the full profile.
 */
export function resolveMcpToolProfile(
  value = process.env.MCP_TOOL_PROFILE,
): McpToolProfile {
  if (value === undefined || value === "" || value === "full") {
    return "full";
  }
  if (value === "memory") {
    return "memory";
  }
  throw new Error('MCP_TOOL_PROFILE must be either "memory" or "full"');
}

/**
 * The tools actually registered under a profile. Discovery metadata and the
 * skill/tool drift check both read this so they cannot disagree with what the
 * server exposes.
 */
export function resolveEnabledMcpToolNames(
  profile: McpToolProfile = resolveMcpToolProfile(),
): readonly McpToolName[] {
  return profile === "memory" ? MCP_MEMORY_TOOL_NAMES : MCP_TOOL_NAME_LIST;
}
