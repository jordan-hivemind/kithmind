"use client";

// The consent screen on the Convex surface. Moved here verbatim from
// `app/mcp/authorize/page.tsx` so that page can pick a surface, and unchanged in
// behavior: the same Convex auth gates, the same inline sign-in form, the same
// picker and the same redirect check. i7 deletes it.
//
// The parameter reading and the consent post moved to `authorize-request.ts` and
// the styles to `authorize-styles.ts`, both shared with the PostgreSQL flow, so
// that the two screens cannot drift while the flag decides between them.

import { useAuthActions } from "@convex-dev/auth/react";
import type { Id } from "@repo/db/convex/_generated/dataModel";
import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";
import { useSearchParams } from "next/navigation";
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
import type { KeyCapability } from "@/components/space-grant-choices";
import { SpaceGrantPicker } from "@/components/space-grant-picker";

export function ConvexAuthorizeFlow() {
  const searchParams = useSearchParams();
  const { signIn } = useAuthActions();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [spaceIds, setSpaceIds] = useState<Id<"spaces">[]>([]);
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

  return (
    <div style={containerStyle}>
      <h1>Open Brain</h1>

      <AuthLoading>
        <p style={{ color: "#666" }}>Loading...</p>
      </AuthLoading>

      <Unauthenticated>
        <p style={{ color: "#666", marginTop: 0 }}>
          {mode === "signIn"
            ? "Sign in to authorize this MCP client."
            : "Create an account to authorize this MCP client."}
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            setLoading(true);
            const formData = new FormData(e.currentTarget);
            try {
              await signIn("password", formData);
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
              {...(mode === "signUp" ? { minLength: 8 } : {})}
              style={inputStyle}
            />
          </div>
          <input type="hidden" name="flow" value={mode} />
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
          {mode === "signIn" ? (
            <>
              Don&apos;t have an account?{" "}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  if (loading) {
                    return;
                  }
                  setMode("signUp");
                  setError("");
                }}
                style={{ color: "#0070f3" }}
              >
                Sign up
              </a>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  if (loading) {
                    return;
                  }
                  setMode("signIn");
                  setError("");
                }}
                style={{ color: "#0070f3" }}
              >
                Sign in
              </a>
            </>
          )}
        </p>
      </Unauthenticated>

      <Authenticated>
        <p style={{ color: "#666", marginTop: 0 }}>
          Choose what this MCP client can access. After approval, you will
          return to <strong>{request.redirectDestination}</strong>.
        </p>
        <SpaceGrantPicker
          spaceIds={spaceIds}
          onSpaceIdsChange={setSpaceIds}
          capabilities={capabilities}
          onCapabilitiesChange={setCapabilities}
        />
        {error && <p style={{ color: "#dc2626" }}>{error}</p>}
        <button
          onClick={handleAuthorize}
          disabled={loading || !spaceIds.length || !capabilities.length}
          style={buttonStyle}
        >
          {loading ? "Authorizing..." : "Authorize"}
        </button>
      </Authenticated>
    </div>
  );
}
