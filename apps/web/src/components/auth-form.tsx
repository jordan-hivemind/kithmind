"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type AuthMode = "signIn" | "signUp";

function inviteReturnPath(searchParams: URLSearchParams) {
  return searchParams.get("returnTo") === "/invite" ? "/invite" : null;
}

export function AuthForm({ mode }: { mode: AuthMode }) {
  const { signIn } = useAuthActions();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [fragment, setFragment] = useState("");
  const returnPath = inviteReturnPath(searchParams);
  const alternateMode = mode === "signIn" ? "sign-up" : "sign-in";

  useEffect(() => {
    setFragment(window.location.hash);
  }, []);

  const alternateHref = returnPath
    ? `/${alternateMode}?returnTo=%2Finvite${fragment}`
    : `/${alternateMode}`;

  return (
    <div
      style={{
        maxWidth: 400,
        margin: "100px auto",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>
        {mode === "signIn" ? "Sign in to Kith Mind" : "Create your Kith Mind"}
      </h1>
      {returnPath && (
        <p>You will return to your invitation after you sign in.</p>
      )}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          setLoading(true);
          const formData = new FormData(event.currentTarget);
          try {
            await signIn("password", formData);
            if (returnPath)
              router.replace(`${returnPath}${window.location.hash}`);
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
          <label htmlFor="email" style={{ display: "block", marginBottom: 4 }}>
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
          />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label
            htmlFor="password"
            style={{ display: "block", marginBottom: 4 }}
          >
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={mode === "signUp" ? 8 : undefined}
            autoComplete={
              mode === "signIn" ? "current-password" : "new-password"
            }
            style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
          />
        </div>
        <input type="hidden" name="flow" value={mode} />
        {error && (
          <p role="alert" style={{ color: "#b42318" }}>
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={loading}
          style={{ width: "100%", padding: 10, cursor: "pointer" }}
        >
          {loading
            ? mode === "signIn"
              ? "Signing in..."
              : "Creating account..."
            : mode === "signIn"
              ? "Sign in"
              : "Create account"}
        </button>
      </form>
      <p style={{ marginTop: 16, textAlign: "center" }}>
        {mode === "signIn"
          ? "Don't have an account?"
          : "Already have an account?"}{" "}
        <a href={alternateHref} style={{ color: "#0070f3" }}>
          {mode === "signIn" ? "Sign up" : "Sign in"}
        </a>
      </p>
    </div>
  );
}
