/** AI client setup is limited to the current deployment's MCP endpoint. */
export function mcpEndpoint(origin: string): string {
  return `${origin}/api/mcp`;
}

export const AI_CONNECTION_HELP =
  "Add this endpoint as a custom MCP server in a client that supports MCP.";
