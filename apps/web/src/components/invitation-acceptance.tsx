"use client";

import { useConvexAuth, useMutation } from "convex/react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { familyApi } from "@/lib/family-api";

export function InvitationAcceptance() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const acceptInvitation = useMutation(familyApi.acceptInvitation);
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
      await acceptInvitation({ token });
      setStatus(
        "Your acceptance is pending the space owner’s approval. They will confirm the account that accepted this invitation.",
      );
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && "data" in cause) {
        const data = cause.data;
        if (
          typeof data === "object" &&
          data !== null &&
          "message" in data &&
          typeof data.message === "string"
        ) {
          setError(data.message);
          return;
        }
      }
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
    <main
      style={{
        maxWidth: 560,
        margin: "100px auto",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>Family space invitation</h1>
      {token === undefined ? (
        <p>Loading invitation...</p>
      ) : token === null ? (
        <p role="alert">
          This invitation link is missing its secret. Ask the space owner for a
          new link.
        </p>
      ) : isLoading ? (
        <p>Checking your account...</p>
      ) : !isAuthenticated ? (
        <>
          <p>
            Sign in or create an account to accept this invitation. The secret
            stays in this browser address fragment.
          </p>
          <p>
            <a href={`${signInHref}${fragment}`}>Sign in</a>
            {" · "}
            <a href={`${signUpHref}${fragment}`}>Create account</a>
          </p>
        </>
      ) : status ? (
        <>
          <p role="status">{status}</p>
          <Link href="/spaces">Go to spaces</Link>
        </>
      ) : (
        <>
          <p>
            Accepting this link records your account for the owner to review. It
            does not grant access until they approve it.
          </p>
          {error && (
            <p role="alert" style={{ color: "#b42318" }}>
              {error}
            </p>
          )}
          <button
            type="button"
            disabled={submitting}
            onClick={() => void accept()}
            style={{ padding: "8px 14px", cursor: "pointer" }}
          >
            {submitting ? "Accepting..." : "Accept invitation"}
          </button>
        </>
      )}
    </main>
  );
}
