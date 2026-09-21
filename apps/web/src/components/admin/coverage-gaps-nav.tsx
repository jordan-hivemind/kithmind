"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const VIEWS = [
  { href: "/admin/attention", label: "Queue" },
  { href: "/admin/attention/gaps", label: "Coverage gaps" },
] as const;

export function CoverageGapsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Needs Attention views" className="mb-4">
      <ul className="flex gap-1 border-b border-kith-border-subtle text-sm">
        {VIEWS.map((view) => {
          const current = pathname === view.href;
          return (
            <li key={view.href}>
              <Link
                href={view.href}
                aria-current={current ? "page" : undefined}
                className={`block border-b-2 px-3 py-2 font-medium ${
                  current
                    ? "border-kith-action text-accent-700"
                    : "border-transparent text-kith-text-secondary hover:text-accent-700"
                }`}
              >
                {view.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
