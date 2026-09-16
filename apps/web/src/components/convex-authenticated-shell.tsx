"use client";

// The Convex authentication gate, exactly as `app/(authenticated)/layout.tsx`
// has always rendered it, moved into its own file so that layout can become a
// server component and pick a surface.
//
// Nothing in here changed. Under `KITH_POSTGRES_SURFACE=convex` this is what
// renders, and i1 must be observably identical in that mode. It is deleted in
// i5 with the rest of the Convex UI.

import { useAuthActions } from "@convex-dev/auth/react";
import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";

import { AuthenticatedNav } from "./authenticated-nav";

function ConvexNav() {
  const { signOut } = useAuthActions();
  return <AuthenticatedNav onSignOut={() => void signOut()} />;
}

export function ConvexAuthenticatedShell({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <AuthLoading>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: 48,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          Loading...
        </div>
      </AuthLoading>
      <Unauthenticated>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: 48,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          Redirecting to sign in...
        </div>
      </Unauthenticated>
      <Authenticated>
        <ConvexNav />
        <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
          {children}
        </main>
      </Authenticated>
    </>
  );
}
