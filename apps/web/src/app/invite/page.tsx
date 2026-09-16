// The invite page, now a server component that picks a surface.
//
// `/invite` is a public route in both modes -- an invited account is not
// signed in yet -- so under `postgres` this reads the session itself with
// `currentWebPrincipal()` (one read-only transaction) rather than relying on
// the `(authenticated)` layout, which this route sits outside of.

import { ConvexInvitationAcceptance } from "@/components/convex-invitation-acceptance";
import { KithInvitationAcceptance } from "@/components/kith-invitation-acceptance";
import { currentWebPrincipal } from "@/lib/kith/server-session";
import { kithPostgresSurface } from "@/lib/kith/surface";

export default async function InvitePage() {
  if (kithPostgresSurface() !== "postgres") return <ConvexInvitationAcceptance />;

  const principal = await currentWebPrincipal();
  return <KithInvitationAcceptance signedIn={principal !== null} />;
}
