import { Suspense } from "react";

import { AuthForm } from "@/components/auth-form";

export default function SignInPage() {
  return (
    <Suspense fallback={<p>Loading...</p>}>
      <AuthForm mode="signIn" />
    </Suspense>
  );
}
