// The authenticated shell: the one navigation bar over every signed-in page,
// the admin panel included, and the query cache and toasts the pages below use.
//
// The session is read here, on the server, and an unauthenticated request is
// redirected rather than shown a client-side "Redirecting to sign in..." while
// the page below it is already in the bundle. This is also the layer that
// satisfies section 7's rule: the middleware checked a MAC, and this checks the
// session row, in its own transaction, against the live user.
//
// `loadAdminAccess` only decides whether the navigation shows the Admin link.
// The admin layout makes the same check for itself and refuses a reader.

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { KithSignOutNav } from "@/components/kith-sign-out";
import { QueryProvider } from "@/components/query-provider";
import { ToastProvider } from "@/components/ui/toast";
import { currentWebPrincipal } from "@/lib/kith/server-session";
import { loadAdminAccess } from "@/lib/kith/sources-data";

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
  const canAdmin =
    (await loadAdminAccess((await headers()).get("cookie"))) === true;

  return (
    <QueryProvider>
      <ToastProvider>
        <KithSignOutNav canAdmin={canAdmin} />
        <main className="mx-auto w-full max-w-7xl px-6 py-5 text-sm text-gray-900">
          {children}
        </main>
      </ToastProvider>
    </QueryProvider>
  );
}
