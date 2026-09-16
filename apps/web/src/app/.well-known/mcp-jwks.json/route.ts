// The verifier for the JWT bridge. Deleted in i7 with `lib/mcp/convex-auth.ts`.
//
// It stays in i2 for the same reason the signer does: under
// `KITH_POSTGRES_SURFACE=convex`, which is still the default, Convex fetches
// this document to verify every MCP identity token. Section 3.2 of the web and
// MCP surface plan names the deletion; row i7 performs it.

import { getPublicMcpJwk } from "@/lib/mcp/convex-auth";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { keys: [getPublicMcpJwk()] },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
