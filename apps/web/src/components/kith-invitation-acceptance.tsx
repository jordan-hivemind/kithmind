"use client";

// The PostgreSQL invitation acceptance page.
//
// `app/invite/page.tsx` is a server component: it reads the session with
// `currentWebPrincipal()` (one read-only transaction, the session checked
// inside it) and passes down only whether anyone is signed in. This
// component's only job is the part a server component cannot do -- read the
// token out of the browser's address fragment, which never reaches the
// server -- and post it to `/api/kith/family/invitations/accept`, which
// reloads the session for itself rather than trusting this prop for the
// actual accept.

import Link from "next/link";
import { useEffect, useState } from "react";

import { authButtonClass, AuthCard, linkClass } from "@/components/ui/controls";

export function KithInvitationAcceptance({ signedIn }: { signedIn: boolean }) {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [fragment, setFragment] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const value = window.location.hash.slice(1);
    setToken(value || null);
    setFragment(window.location.hash);
  }, []);

  async function accept() {
    if (!token) return;
    setError("");
    setSubmitting(true);
    try {
      const response = await fetch("/api/kith/family/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(
          body?.error === "Not authenticated"
            ? "Sign in and try again."
            : "This invitation could not be accepted. Ask the owner for a new link if it expired.",
        );
        return;
      }
      setStatus(
        "Your acceptance is pending the space owner’s approval. They will confirm the account that accepted this invitation.",
      );
    } catch {
      setError(
        "This invitation could not be accepted. Ask the owner for a new link if it expired.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const signInHref = "/sign-in?returnTo=%2Finvite";
  const signUpHref = "/sign-up?returnTo=%2Finvite";

  return (
    <AuthCard title="Family space invitation">
      {token === undefined ? (
        <p className="text-xs text-gray-600">Loading invitation...</p>
      ) : token === null ? (
        <p role="alert" className="text-xs text-red-700">
          This invitation link is missing its secret. Ask the space owner for a
          new link.
        </p>
      ) : !signedIn ? (
        <>
          <p className="mb-3 text-xs text-gray-700">
            Sign in or create an account to accept this invitation. The secret
            stays in this browser address fragment.
          </p>
          <p className="text-xs">
            <a href={`${signInHref}${fragment}`} className={linkClass}>
              Sign in
            </a>
            {" · "}
            <a href={`${signUpHref}${fragment}`} className={linkClass}>
              Create account
            </a>
          </p>
        </>
      ) : status ? (
        <>
          <p role="status" className="mb-3 text-xs text-gray-700">
            {status}
          </p>
          <Link href="/spaces" className={`${linkClass} text-xs`}>
            Go to spaces
          </Link>
        </>
      ) : (
        <>
          <p className="mb-3 text-xs text-gray-700">
            Accepting this link records your account for the owner to review.
            It does not grant access until they approve it.
          </p>
          {error && (
            <p role="alert" className="mb-3 text-xs text-red-700">
              {error}
            </p>
          )}
          <button
            type="button"
            disabled={submitting}
            onClick={() => void accept()}
            className={authButtonClass}
          >
            {submitting ? "Accepting..." : "Accept invitation"}
          </button>
        </>
      )}
    </AuthCard>
  );
}
