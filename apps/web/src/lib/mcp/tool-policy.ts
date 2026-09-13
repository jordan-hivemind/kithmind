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

/**
 * MCP annotations are risk hints for the host, not permission grants. Keep this
 * map exhaustive so new tools cannot silently inherit the protocol's
 * pessimistic defaults.
 */
export const MCP_TOOL_ANNOTATIONS = {
  [MCP_TOOL_NAMES.ingestUrl]: idempotentAdditive,
  [MCP_TOOL_NAMES.queryRecords]: readOnly,
  [MCP_TOOL_NAMES.searchDocuments]: readOnly,
  [MCP_TOOL_NAMES.getDocument]: readOnly,
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
] as const;

export type McpToolProfile = "memory" | "full";

/**
 * Default to the complete surface. Narrowing has to stay an explicit opt-in
 * rather than an upgrade-time surprise, because it can remove tools that
 * connected clients and the bundled plugin skills already call. Since the
 * lists and insights tools were retired (P2-39l) the memory profile happens to
 * cover every registered tool, and narrowing is a no-op until a tool outside
 * memory and documents is added.
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
