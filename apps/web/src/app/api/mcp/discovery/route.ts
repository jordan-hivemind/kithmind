import { createCorsHeaders, createCorsOptionsResponse } from "@/lib/mcp/cors";
import { getMcpPublicOrigin } from "@/lib/mcp/environment";
import { resolveEnabledMcpToolNames } from "@/lib/mcp/tool-policy";

const CORS_HEADERS = createCorsHeaders("GET, OPTIONS");

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return createCorsOptionsResponse(CORS_HEADERS);
}

export async function GET() {
  const baseUrl = getMcpPublicOrigin();

  return Response.json(
    {
      type: "mcp/server",
      name: "open-brain",
      description:
        "Authenticated personal knowledge, document and owner-data management for AI assistants, with on-demand domain help.",
      endpoint: `${baseUrl}/api/mcp`,
      capabilities: ["tools", "resources"],
      // Advertise only what this deployment's profile actually registers.
      tools: resolveEnabledMcpToolNames(),
      authentication: {
        type: "oauth2",
        metadata_url: `${baseUrl}/.well-known/oauth-authorization-server`,
      },
    },
    { headers: CORS_HEADERS },
  );
}
