"use client";

// The sign-in and sign-up form, with the submit action taken as a prop.
//
// Two surfaces submit it -- Convex Auth's `signIn("password", formData)` and a
// `POST` to `/api/auth/sign-in` -- and a hook cannot be called conditionally, so
// the two callers are separate components. The markup, the error strings, the
// loading text and the invitation return path live here so that the surface
// switch cannot change what the owner sees.
//
// The error strings stay deliberately vague and identical to what this form has
// always shown. The routes already collapse an unknown account and a wrong
// password into one message; a form that said "no such account" would undo that
// at the last step.

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import {
  authButtonClass,
  AuthCard,
  authInputClass,
  linkClass,
} from "@/components/ui/controls";

export type AuthMode = "signIn" | "signUp";

export type AuthSubmit = (
  formData: FormData,
  context: { returnPath: string | null; fragment: string },
) => Promise<void>;

function inviteReturnPath(searchParams: URLSearchParams) {
  return searchParams.get("returnTo") === "/invite" ? "/invite" : null;
}

export function AuthFormShell({
  mode,
  submit,
}: {
  mode: AuthMode;
  submit: AuthSubmit;
}) {
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
    <AuthCard
      title={mode === "signIn" ? "Sign in to Kith Mind" : "Create your Kith Mind"}
    >
      {returnPath && (
        <p className="mb-3 text-xs text-gray-600">
          You will return to your invitation after you sign in.
        </p>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          setLoading(true);
          const formData = new FormData(event.currentTarget);
          try {
            await submit(formData, {
              returnPath,
              fragment: window.location.hash,
            });
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
            minLength={mode === "signUp" ? 8 : undefined}
            autoComplete={
              mode === "signIn" ? "current-password" : "new-password"
            }
            className={authInputClass}
          />
        </div>
        <input type="hidden" name="flow" value={mode} />
        {error && (
          <p role="alert" className="text-xs text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={loading}
          className={authButtonClass}
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
      <p className="mt-4 text-center text-xs text-gray-600">
        {mode === "signIn"
          ? "Don't have an account?"
          : "Already have an account?"}{" "}
        <a href={alternateHref} className={linkClass}>
          {mode === "signIn" ? "Sign up" : "Sign in"}
        </a>
      </p>
    </AuthCard>
  );
}
