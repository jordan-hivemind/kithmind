// The admin panel shell: the left navigation of section 9 of
// docs/plans/2026-09-18-admin-panel-and-ingestion.md, in that order.
//
// The session check is the `(authenticated)` layout's above this one, and each
// page below reloads it for itself inside its own read transaction. This
// segment adds three things: the role gate, the query cache the live hook
// invalidates, and the navigation.
//
// The gate is owner-or-editor, not merely signed in. These screens show how
// the household's records are collected -- the watcher host's filesystem
// paths, the problems it reported, the source account ids -- which is
// operational detail a `reader` member is not entitled to. `getAdminSpaceIds`
// draws that line off the same `"write"` check every mutation uses, and a
// reader gets `notFound()` rather than a denial, so the panel's existence is
// not confirmed to someone who may not use it. The pages below do not lean on
// this: each one's data function applies the same narrowing for itself.
//
// A screen that has not been built yet is listed and disabled rather than
// hidden. The owner's decision was that "the UI must show a complete inventory
// so gaps are visible", and the navigation is the first place that is true.

import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { QueryProvider } from "@/components/query-provider";
import { loadAdminAccess } from "@/lib/kith/sources-data";

const SCREENS = [
  { href: "/admin/health", label: "Health", ready: true },
  { href: "/admin/sources", label: "Sources", ready: true },
  { href: "/admin/institutions", label: "Institutions", ready: true },
  { href: "/admin/coverage", label: "Coverage", ready: true },
  { href: "/admin/investments", label: "Investments", ready: false },
  { href: "/admin/types", label: "Types and fields", ready: false },
  { href: "/admin/corrections", label: "Corrections", ready: false },
] as const;

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const allowed = await loadAdminAccess((await headers()).get("cookie"));
  if (allowed === null) redirect("/sign-in");
  if (!allowed) notFound();

  return (
    <QueryProvider>
      <div className="flex min-h-[70vh] gap-6">
        <nav aria-label="Admin" className="w-44 shrink-0 border-r border-gray-200 pr-3">
          <ul className="flex flex-col gap-0.5 text-xs">
            {SCREENS.map((screen) =>
              screen.ready ? (
                <li key={screen.href}>
                  <Link
                    href={screen.href}
                    className="block rounded-tag px-2 py-1.5 text-gray-700 hover:bg-accent-50 hover:text-accent-700"
                  >
                    {screen.label}
                  </Link>
                </li>
              ) : (
                <li
                  key={screen.href}
                  aria-disabled="true"
                  className="block px-2 py-1.5 text-gray-300"
                >
                  {screen.label}
                </li>
              ),
            )}
          </ul>
        </nav>
        <section className="min-w-0 flex-1">{children}</section>
      </div>
    </QueryProvider>
  );
}
