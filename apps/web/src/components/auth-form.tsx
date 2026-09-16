"use client";

// The Convex Auth sign-in and sign-up form. Unchanged behavior: the markup and
// the error strings moved into `AuthFormShell`, which both surfaces share, and
// what is left here is the one line that was Convex-specific.
//
// Deleted in i7 with the rest of the Convex client.

import { useAuthActions } from "@convex-dev/auth/react";

import { AuthFormShell, type AuthMode } from "./auth-form-shell";

export function AuthForm({ mode }: { mode: AuthMode }) {
  const { signIn } = useAuthActions();

  return (
    <AuthFormShell
      mode={mode}
      submit={async (formData) => {
        await signIn("password", formData);
      }}
    />
  );
}
