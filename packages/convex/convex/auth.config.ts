// Deleted in P2-39i7, with the rest of the JWT bridge.
//
// Section 3.2 of `docs/plans/2026-09-16-web-mcp-postgres-surface.md` deletes this
// file together with `apps/web/src/lib/mcp/convex-auth.ts`, the JWKS route and
// the four `MCP_JWT_*` variables. i2 authenticates MCP against PostgreSQL and
// mints no token on that surface, but `KITH_POSTGRES_SURFACE` still defaults to
// `convex` and every unported page and tool needs this provider until i5 and i7.
//
// `MCP_JWT_ISSUER` is the old spelling of the gateway's public origin. The web
// app reads `MCP_PUBLIC_ORIGIN` first from i2 onward and falls back to this name
// under `convex`. This file is deliberately not changed to match: the Convex
// side of the bridge is three variables deep (`auth.config.ts`, `lib/mcpAuth.ts`
// and `lib/webAuth.ts`), the last two are security-sensitive files that section
// 1.6 assigns to i7 for deletion only, and renaming one of the three would let
// the issuer the gateway signs with and the issuer Convex verifies drift apart.
// So `MCP_JWT_ISSUER` stays the Convex-side name until the bridge is deleted,
// and `validateMcpEnvironment` refuses a deployment that sets the two names to
// different origins.

import type { AuthConfig } from "convex/server";

const mcpJwtIssuer = process.env.MCP_JWT_ISSUER;
const convexSiteUrl = process.env.CONVEX_SITE_URL;
if (!convexSiteUrl) {
  throw new Error("CONVEX_SITE_URL is not configured");
}

export default {
  providers: [
    {
      domain: convexSiteUrl,
      applicationID: "convex",
    },
    ...(mcpJwtIssuer
      ? [
          {
            type: "customJwt" as const,
            issuer: mcpJwtIssuer,
            applicationID: "ai-brain-convex-mcp",
            jwks: `${mcpJwtIssuer}/.well-known/mcp-jwks.json`,
            algorithm: "ES256" as const,
          },
        ]
      : []),
  ],
} satisfies AuthConfig;
