"use client";

// The sign-in and sign-up form against `app/api/auth/`.
//
// JSON rather than the `FormData` a plain form post would send, because the
// routes accept `application/json` only: that content type is one a browser
// sends from script and not from a cross-site form, which is what keeps
// `SameSite=Lax` from being the only thing standing between another site's page
// and a sign-in attempt here.
//
// The response body is not read on failure. The routes return one message for an
// unknown account and a wrong password, and `AuthFormShell` shows the same two
// strings the Convex form always showed, so there is nothing here that could
// widen either.

import { useRouter } from "next/navigation";

import { AuthFormShell, type AuthMode } from "./auth-form-shell";

export function KithAuthForm({
  mode,
  googleOAuthEnabled,
}: {
  mode: AuthMode;
  googleOAuthEnabled: boolean;
}) {
  const router = useRouter();
  const path = mode === "signIn" ? "/api/auth/sign-in" : "/api/auth/sign-up";

  return (
    <AuthFormShell
      mode={mode}
      googleOAuthEnabled={googleOAuthEnabled}
      submit={async (formData, { returnPath, fragment }) => {
        const response = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: String(formData.get("email") ?? ""),
            password: String(formData.get("password") ?? ""),
          }),
        });
        if (!response.ok) throw new Error("sign_in_failed");
        // The session cookie is set; the server components rendered before it
        // was are still in the router cache, so discard them before navigating.
        router.refresh();
        if (returnPath === null) router.replace("/");
        else router.replace(`${returnPath}${fragment}`);
      }}
    />
  );
}
