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

import { AdminShell } from "@/components/admin/admin-shell";
import { AttentionBadge } from "@/components/admin/attention-badge";
import { QueryProvider } from "@/components/query-provider";
import { loadAttentionCounts } from "@/lib/kith/attention-data";
import { loadAdminAccess } from "@/lib/kith/sources-data";

const SCREENS = [
  { href: "/admin/institutions", label: "Investment Accounts", ready: true },
  { href: "/admin/investments", label: "Private Investments", ready: true },
  { href: "/admin/sources", label: "Data Sources", ready: true },
  { href: "/admin/health", label: "System Health", ready: true },
  // ADM-8a: the corrections table widened into the single attention queue
  // (section 5 of docs/plans/2026-09-19-investment-document-matching.md),
  // so this screen replaces the earlier "Corrections" placeholder rather
  // than sitting beside it.
  { href: "/admin/attention", label: "Needs Attention", ready: true },
] as const;

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookie = (await headers()).get("cookie");
  const allowed = await loadAdminAccess(cookie);
  if (allowed === null) redirect("/sign-in");
  if (!allowed) notFound();
  const attentionCounts = await loadAttentionCounts(cookie);

  return (
    <QueryProvider>
      <AdminShell
        nav={
          <nav
            aria-label="Operations"
            className="border-b border-kith-border-subtle pb-3 md:h-full md:border-r md:border-b-0 md:pr-2 md:pb-0"
          >
            <ul className="flex flex-wrap gap-1 text-sm md:flex-col">
              {SCREENS.map((screen) =>
                screen.ready ? (
                  <li key={screen.href}>
                    <Link
                      href={screen.href}
                      className="flex items-center rounded-control px-3 py-2 text-kith-text-secondary hover:bg-accent-50 hover:text-accent-700"
                    >
                      {screen.label}
                      {screen.href === "/admin/attention" ? (
                        <AttentionBadge initial={attentionCounts} />
                      ) : null}
                    </Link>
                  </li>
                ) : (
                  <li
                    key={screen.href}
                    aria-disabled="true"
                    className="block px-3 py-2 text-kith-text-muted"
                  >
                    {screen.label}
                  </li>
                ),
              )}
            </ul>
          </nav>
        }
      >
        {children}
      </AdminShell>
    </QueryProvider>
  );
}
