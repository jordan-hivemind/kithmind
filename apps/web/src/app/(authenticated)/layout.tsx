// The authenticated shell.
//
// The session is read here, on the server, and an unauthenticated request is
// redirected rather than shown a client-side "Redirecting to sign in..." while
// the page below it is already in the bundle. This is also the layer that
// satisfies section 7's rule: the middleware checked a MAC, and this checks the
// session row, in its own transaction, against the live user.

import { redirect } from "next/navigation";

import { KithSignOutNav } from "@/components/kith-sign-out";
import { currentWebPrincipal } from "@/lib/kith/server-session";

// Nothing in this segment is prerendered: every page under it reads the
// session and its own rows, which need `KITH_SESSION_SECRET` and a database at
// request time. Until i7b the build-time render took each page's Convex branch
// and touched neither, so a prerender succeeded by rendering the wrong thing.
export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
