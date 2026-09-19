// The OAuth consent page.
//
// The session is read here, on the server, in its own transaction, together
// with the spaces it may grant. The flow below is handed that list or `null`;
// it has no query and no auth gate of its own, so a client component cannot
// decide it is authenticated.
//
// The page stays public in the middleware's matcher. It has to be: an MCP
// client sends the user here before they have signed in, and a redirect to
// `/sign-in` would drop the authorization request in the query string.

import { headers } from "next/headers";
import { Suspense } from "react";

import { KithAuthorizeFlow } from "@/components/kith-authorize-flow";
import { AuthCard } from "@/components/ui/controls";
import { consentSpaces } from "@/lib/mcp/consent-spaces";

export const dynamic = "force-dynamic";

function Loading() {
  return (
    <AuthCard title="Open Brain">
      <p className="text-xs text-gray-600">Loading...</p>
    </AuthCard>
  );
}

export default async function AuthorizePage() {
  const spaces = await consentSpaces((await headers()).get("cookie"));
  return (
    <Suspense fallback={<Loading />}>
      <KithAuthorizeFlow spaces={spaces} />
    </Suspense>
  );
}
