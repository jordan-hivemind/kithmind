"use client";

// Sign out against `POST /api/auth/sign-out`.
//
// The route revokes the session row and returns the clearing cookie, so what
// this has to do afterwards is only about the browser: leave the authenticated
// tree, and discard the router cache, or the previously rendered server
// components would still be on screen after the session that produced them is
// gone.
//
// It navigates to `/sign-in` even when the request fails. The cookie may or may
// not have been cleared, but the session may well have been revoked before the
// failure, and leaving someone on a dashboard they can no longer load is worse
// than sending them to a sign-in page they can.

import { useRouter } from "next/navigation";
import { useState } from "react";

import { AuthenticatedNav } from "./authenticated-nav";

export function KithSignOutNav({ canAdmin = false }: { canAdmin?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <AuthenticatedNav
      pending={pending}
      canAdmin={canAdmin}
      onSignOut={() => {
        setPending(true);
        void (async () => {
          try {
            await fetch("/api/auth/sign-out", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
          } finally {
            router.replace("/sign-in");
            router.refresh();
          }
        })();
      }}
    />
  );
}
