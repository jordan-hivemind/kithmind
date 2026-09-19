"use client";

// The one navigation bar, over the app pages and the admin panel alike, with
// the sign-out control taken as a prop (`kith-sign-out.tsx` owns what signing
// out does).
//
// `canAdmin` comes from the `(authenticated)` layout's `loadAdminAccess`, the
// same owner-or-editor check the admin layout gates on. Hiding the link is
// presentation only: the admin layout still refuses a reader on its own.

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Button } from "@/components/ui/controls";

type NavLink = { href: string; label: string; section: string };

const LINKS: readonly NavLink[] = [
  { href: "/", label: "Dashboard", section: "/" },
  { href: "/browse", label: "Browse", section: "/browse" },
  { href: "/spaces", label: "Spaces", section: "/spaces" },
  { href: "/settings", label: "Settings", section: "/settings" },
];

const ADMIN: NavLink = { href: "/admin/sources", label: "Admin", section: "/admin" };

function isActive(pathname: string, section: string): boolean {
  return section === "/" ? pathname === "/" : pathname.startsWith(section);
}

export function AuthenticatedNav({
  onSignOut,
  pending = false,
  canAdmin = false,
}: {
  onSignOut: () => void;
  pending?: boolean;
  canAdmin?: boolean;
}) {
  const pathname = usePathname();
  const links = canAdmin ? [...LINKS, ADMIN] : LINKS;

  return (
    <header className="border-b border-gray-200 bg-white">
      <nav
        aria-label="Main"
        className="mx-auto flex h-11 max-w-7xl items-center gap-6 px-6 text-xs"
      >
        <Link href="/" className="text-sm font-semibold text-gray-900">
          Kith Mind
        </Link>
        <ul className="flex h-full items-stretch gap-4">
          {links.map((link) => {
            const active = isActive(pathname, link.section);
            return (
              <li key={link.href} className="flex">
                <Link
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center border-b-2 px-0.5 focus-visible:outline-2 focus-visible:outline-accent-600 ${
                    active
                      ? "border-accent-600 font-medium text-accent-700"
                      : "border-transparent text-gray-600 hover:text-gray-900"
                  }`}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="ml-auto">
          <Button onClick={onSignOut} disabled={pending}>
            {pending ? "Signing out..." : "Sign out"}
          </Button>
        </div>
      </nav>
    </header>
  );
}
