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
} from "@/components/authorize-request";
import {
  buttonStyle,
  containerStyle,
  inputStyle,
} from "@/components/authorize-styles";
import {
  type GrantableSpace,
  type KeyCapability,
  SpaceGrantChoices,
} from "@/components/space-grant-choices";

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

  const request = readAuthorizeRequest(searchParams);
  if (!request) {
    return (
      <div style={containerStyle}>
        <h1>Open Brain</h1>
        <p style={{ color: "#dc2626" }}>
          Missing OAuth parameters. Please start the authorization flow from
          your MCP client.
        </p>
      </div>
    );
  }

  async function handleAuthorize() {
    if (!request) return;
    setError("");
    setLoading(true);
    try {
      window.location.assign(
        await submitConsent(request, { spaceIds, capabilities }),
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Authorization failed");
      setLoading(false);
    }
  }

  if (spaces === null) {
    return (
      <div style={containerStyle}>
        <h1>Open Brain</h1>
        <p style={{ color: "#666", marginTop: 0 }}>
          {mode === "signIn"
            ? "Sign in to authorize this MCP client."
            : "Create an account to authorize this MCP client."}
        </p>
        <form
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
          <div style={{ marginBottom: 12 }}>
            <label
              htmlFor="email"
              style={{ display: "block", marginBottom: 4, fontWeight: 500 }}
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              style={inputStyle}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label
              htmlFor="password"
              style={{ display: "block", marginBottom: 4, fontWeight: 500 }}
            >
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
              style={inputStyle}
            />
          </div>
          {error && <p style={{ color: "#dc2626" }}>{error}</p>}
          <button type="submit" disabled={loading} style={buttonStyle}>
            {loading
              ? mode === "signIn"
                ? "Signing in..."
                : "Creating account..."
              : mode === "signIn"
                ? "Sign In"
                : "Sign Up"}
          </button>
        </form>
        <p style={{ marginTop: 16, textAlign: "center", color: "#666" }}>
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
            style={{ color: "#0070f3" }}
          >
            {mode === "signIn" ? "Sign up" : "Sign in"}
          </a>
        </p>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <h1>Open Brain</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
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
      />
      {error && <p style={{ color: "#dc2626" }}>{error}</p>}
      <button
        onClick={handleAuthorize}
        disabled={loading || !spaceIds.length || !capabilities.length}
        style={buttonStyle}
      >
        {loading ? "Authorizing..." : "Authorize"}
      </button>
    </div>
  );
}
