// The OAuth consent page, now a server component that picks a surface.
//
// Under `KITH_POSTGRES_SURFACE=convex` it renders exactly what it always did,
// moved verbatim into `ConvexAuthorizeFlow`: the Convex auth gates, the inline
// sign-in form and the Convex-backed picker. i2 must be observably unchanged in
// that mode, because it lands before i5 moves the pages and `main` deploys.
//
// Under `postgres` the session is read here, on the server, in its own
// transaction, together with the spaces it may grant. The flow below is handed
// that list or `null`; it has no query and no auth gate of its own, so a client
// component cannot decide it is authenticated.
//
// The page stays public in the middleware's matcher in both modes. It has to be:
// an MCP client sends the user here before they have signed in, and a redirect
// to `/sign-in` would drop the authorization request in the query string.

import { headers } from "next/headers";
import { Suspense } from "react";

import { containerStyle } from "@/components/authorize-styles";
import { ConvexAuthorizeFlow } from "@/components/convex-authorize-flow";
import { KithAuthorizeFlow } from "@/components/kith-authorize-flow";
import { kithPostgresSurface } from "@/lib/kith/surface";
import { consentSpaces } from "@/lib/mcp/consent-spaces";

export const dynamic = "force-dynamic";

function Loading() {
  return (
    <div style={containerStyle}>
      <h1>Open Brain</h1>
      <p style={{ color: "#666" }}>Loading...</p>
    </div>
  );
}

export default async function AuthorizePage() {
  if (kithPostgresSurface() !== "postgres") {
    return (
      <Suspense fallback={<Loading />}>
        <ConvexAuthorizeFlow />
      </Suspense>
    );
  }

  const spaces = await consentSpaces((await headers()).get("cookie"));
  return (
    <Suspense fallback={<Loading />}>
      <KithAuthorizeFlow spaces={spaces} />
    </Suspense>
  );
}
