"use client";

// The navigation bar, with the sign-out control taken as a prop.
//
// One copy of the markup, two ways to sign out: Convex Auth's `signOut()` under
// the old surface, and a `POST /api/auth/sign-out` under the new one. Keeping
// the bar itself in one place is what stops the two surfaces from drifting into
// two different dashboards during the slices where both exist.

import Link from "next/link";

export function AuthenticatedNav({
  onSignOut,
  pending = false,
}: {
  onSignOut: () => void;
  pending?: boolean;
}) {
  return (
    <nav
      style={{
        display: "flex",
        gap: 16,
        padding: "12px 24px",
        borderBottom: "1px solid #eee",
        alignItems: "center",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <strong>Kith Mind</strong>
      <Link href="/">Dashboard</Link>
      <Link href="/browse">Browse</Link>
      <Link href="/settings">Settings</Link>
      <Link href="/spaces">Spaces</Link>
      <Link href="/getting-started">Getting Started</Link>
      <div style={{ marginLeft: "auto" }}>
        <button
          onClick={onSignOut}
          disabled={pending}
          style={{ cursor: "pointer" }}
        >
          {pending ? "Signing out..." : "Sign Out"}
        </button>
      </div>
    </nav>
  );
}
