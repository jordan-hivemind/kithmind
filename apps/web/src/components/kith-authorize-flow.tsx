"use client";

// The consent screen on the PostgreSQL surface.
//
// The difference from the Convex flow is where authority comes from, and only
// that. There is no client-side auth gate here: the page is a server component,
// it resolved the session against `kith.sessions` in its own transaction, and it
// either passed down the spaces the session may grant or passed down `null`.
// `null` is the only signal this component has that nobody is signed in, and it
// cannot manufacture the other case, because it has no query of its own.
//
// Signing in is an inline `POST` to `/api/auth/sign-in` followed by
// `router.refresh()`, rather than a redirect to `/sign-in`. The authorization
// request lives in this page's query string; navigating away from it and back
// would have to carry a client's redirect URI through a return parameter, which
// is a redirect the sign-in page would then have to be trusted not to follow.
// Refreshing in place keeps the request where it started.

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import {
  readAuthorizeRequest,
  submitConsent,
  submitDenial,
} from "@/components/authorize-request";
import {
  type GrantableSpace,
  type KeyCapability,
  type SensitivityChoice,
  SpaceGrantChoices,
} from "@/components/space-grant-choices";
import {
  authButtonClass,
  AuthCard,
  authInputClass,
  authSecondaryButtonClass,
  linkClass,
} from "@/components/ui/controls";

const allowedCapabilities: readonly KeyCapability[] = ["read", "write"];

export function KithAuthorizeFlow({
  spaces,
}: {
  /** The spaces this session may grant, or `null` when not signed in. */
  spaces: readonly GrantableSpace[] | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [spaceIds, setSpaceIds] = useState<string[]>([]);
  const [capabilities, setCapabilities] = useState<KeyCapability[]>(["read"]);
  // SENS-1. "Everything" is the default: approving a client narrows nothing
  // unless the owner reaches for the control and says so.
  const [maxSensitivity, setMaxSensitivity] =
    useState<SensitivityChoice>("restricted");

  const request = readAuthorizeRequest(searchParams);
  if (!request) {
    return (
      <AuthCard title="Open Brain">
        <p role="alert" className="text-xs text-red-700">
          Missing OAuth parameters. Please start the authorization flow from
          your MCP client.
        </p>
      </AuthCard>
    );
  }

  async function decide(deny: boolean) {
    if (!request) return;
    setError("");
    setLoading(true);
    try {
      window.location.assign(
        await (deny
          ? submitDenial(request)
          : submitConsent(request, {
              spaceIds,
              capabilities,
              maxSensitivity,
            })),
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Authorization failed");
      setLoading(false);
    }
  }

  if (spaces === null) {
    return (
      <AuthCard title="Open Brain">
        <p className="mb-3 text-xs text-gray-600">
          {mode === "signIn"
            ? "Sign in to authorize this MCP client."
            : "Create an account to authorize this MCP client."}
        </p>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            setLoading(true);
            const formData = new FormData(event.currentTarget);
            try {
              const response = await fetch(
                mode === "signIn" ? "/api/auth/sign-in" : "/api/auth/sign-up",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    email: String(formData.get("email") ?? ""),
                    password: String(formData.get("password") ?? ""),
                  }),
                },
              );
              // The body is not read. The routes give one message for an
              // unknown account and a wrong password, and this form shows the
              // same two strings the Convex one always showed.
              if (!response.ok) throw new Error("sign_in_failed");
              router.refresh();
            } catch {
              setError(
                mode === "signIn"
                  ? "Invalid email or password"
                  : "Could not create account. Try a different email.",
              );
            } finally {
              setLoading(false);
            }
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="email" className="text-xs font-medium text-gray-700">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className={authInputClass}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="password" className="text-xs font-medium text-gray-700">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete={
                mode === "signIn" ? "current-password" : "new-password"
              }
              {...(mode === "signUp" ? { minLength: 8 } : {})}
              className={authInputClass}
            />
          </div>
          {error && (
            <p role="alert" className="text-xs text-red-700">
              {error}
            </p>
          )}
          <button type="submit" disabled={loading} className={authButtonClass}>
            {loading
              ? mode === "signIn"
                ? "Signing in..."
                : "Creating account..."
              : mode === "signIn"
                ? "Sign In"
                : "Sign Up"}
          </button>
        </form>
        <p className="mt-4 text-center text-xs text-gray-600">
          {mode === "signIn"
            ? "Don't have an account? "
            : "Already have an account? "}
          <a
            href="#"
            onClick={(event) => {
              event.preventDefault();
              if (loading) return;
              setMode(mode === "signIn" ? "signUp" : "signIn");
              setError("");
            }}
            className={linkClass}
          >
            {mode === "signIn" ? "Sign up" : "Sign in"}
          </a>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Open Brain">
      <p className="text-xs text-gray-700">
        Choose what this MCP client can access. After approval, you will return
        to <strong>{request.redirectDestination}</strong>.
      </p>
      <SpaceGrantChoices
        spaces={spaces}
        error=""
        spaceIds={spaceIds}
        onSpaceIdsChange={setSpaceIds}
        capabilities={capabilities}
        onCapabilitiesChange={setCapabilities}
        allowedCapabilities={allowedCapabilities}
        maxSensitivity={maxSensitivity}
        onMaxSensitivityChange={setMaxSensitivity}
      />
      {error && (
        <p role="alert" className="mb-2 text-xs text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => decide(true)}
          disabled={loading}
          className={authSecondaryButtonClass}
        >
          Deny
        </button>
        <button
          type="button"
          onClick={() => decide(false)}
          disabled={loading || !spaceIds.length || !capabilities.length}
          className={authButtonClass}
        >
          {loading ? "Authorizing..." : "Authorize"}
        </button>
      </div>
    </AuthCard>
  );
}
