// The MCP endpoint. One authentication per request, on either surface.
//
// The invariant this route exists to hold is the same in both modes: the server
// is built from the credential that authenticated, and from nothing in the body.
// The transport parses the body after this function has already decided who the
// caller is, so a JSON-RPC payload naming a user, a key or a principal changes
// nothing. `authenticateApiKey` reads one header and no body at all.
//
// Under `convex` the validated key is bound to a short-lived Convex identity,
// which is what the 17 tools authenticate with until i3 and i4 port them.
//
// Under `postgres` nothing is minted. The route keeps `{ userId, credentialId }`
// -- a `PrincipalRef`, which carries no authority -- and hands the server a
// loader that reads the credential again inside each call's own transaction.
// Section 3.3: a key revoked between two tool calls denies on the second.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { kithPostgresSurface } from "@/lib/kith/surface";
import { authenticateApiKey } from "@/lib/mcp/auth";
import { createConvexMcpToken } from "@/lib/mcp/convex-auth";
import { createCorsHeaders, createCorsOptionsResponse } from "@/lib/mcp/cors";
import { getMcpPublicOrigin } from "@/lib/mcp/environment";
import { mcpPrincipalLoader } from "@/lib/mcp/principal";
import { createMcpServer, type McpServerCredential } from "@/lib/mcp/server";

// `pg` does not run on the edge runtime, and under `postgres` this route reaches
// it through the principal loader. Stated rather than left to the default.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS_HEADERS: Record<string, string> = createCorsHeaders(
  "POST, OPTIONS",
  {
    exposeHeaders: "WWW-Authenticate, Allow",
  },
);

export async function OPTIONS() {
  return createCorsOptionsResponse(CORS_HEADERS);
}

export async function POST(req: Request) {
  // Authenticate via API key (Bearer token from OAuth flow or direct)
  const auth = await authenticateApiKey(req.headers.get("authorization"));
  if (!auth) {
    const baseUrl = getMcpPublicOrigin();
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="open-brain"`,
      },
    });
  }

  const credential: McpServerCredential =
    kithPostgresSurface() === "postgres"
      ? {
          surface: "postgres",
          withPrincipal: mcpPrincipalLoader({
            userId: auth.userId,
            credentialId: auth.keyId,
          }),
        }
      : {
          // Bind the validated API key to a short-lived Convex identity. Convex
          // functions derive ownership from this token, never from caller input.
          surface: "convex",
          convexAuthToken: await createConvexMcpToken(auth),
        };

  // Finance continuations belong to this authenticated user and credential.
  // Another key for the same user cannot replay them. Neither ID is supplied
  // by the caller, and authentication runs again on every request.
  const server = createMcpServer(credential, `${auth.userId}:${auth.keyId}`);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);

  // Let the transport handle the request, then add CORS headers
  const response = await transport.handleRequest(req);
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function GET() {
  return new Response(
    JSON.stringify({
      error: "Method Not Allowed",
      message: "This is an MCP endpoint. Use POST with a valid MCP client.",
    }),
    {
      status: 405,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json",
        Allow: "POST, OPTIONS",
      },
    },
  );
}

export async function DELETE() {
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      Allow: "POST, OPTIONS",
    },
  });
}
