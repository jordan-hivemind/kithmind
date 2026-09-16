// The authenticated shell, now a server component that picks a surface.
//
// Under `KITH_POSTGRES_SURFACE=convex` it renders exactly what it always did:
// the Convex `AuthLoading`/`Unauthenticated`/`Authenticated` gates, moved
// verbatim into `ConvexAuthenticatedShell`. i1 must be observably unchanged in
// that mode, because it lands before i5 moves the pages and `main` deploys.
//
// Under `postgres` the session is read here, on the server, and an
// unauthenticated request is redirected rather than shown a client-side
// "Redirecting to sign in..." while the page below it is already in the bundle.
// This is also the layer that satisfies section 7's rule: the middleware checked
// a MAC, and this checks the session row, in its own transaction, against the
// live user.

import { redirect } from "next/navigation";

import { ConvexAuthenticatedShell } from "@/components/convex-authenticated-shell";
import { KithSignOutNav } from "@/components/kith-sign-out";
import { currentWebPrincipal } from "@/lib/kith/server-session";
import { kithPostgresSurface } from "@/lib/kith/surface";

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (kithPostgresSurface() !== "postgres") {
    return <ConvexAuthenticatedShell>{children}</ConvexAuthenticatedShell>;
  }

  if ((await currentWebPrincipal()) === null) redirect("/sign-in");

  return (
    <>
      <KithSignOutNav />
      <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
        {children}
      </main>
    </>
  );
}
