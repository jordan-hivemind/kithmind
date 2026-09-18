// The invite page.
//
// `/invite` is a public route -- an invited account is not signed in yet -- so
// this reads the session itself with `currentWebPrincipal()` (one read-only
// transaction) rather than relying on the `(authenticated)` layout, which this
// route sits outside of.

import { KithInvitationAcceptance } from "@/components/kith-invitation-acceptance";
import { currentWebPrincipal } from "@/lib/kith/server-session";

// Never prerendered: it reads the session, which needs `KITH_SESSION_SECRET`
// and a database at request time. Until i7b the build-time render took the
// Convex branch and touched neither. Same declaration, same reason, as
// `app/mcp/authorize/page.tsx`.
export const dynamic = "force-dynamic";

export default async function InvitePage() {
  const principal = await currentWebPrincipal();
  return <KithInvitationAcceptance signedIn={principal !== null} />;
}
