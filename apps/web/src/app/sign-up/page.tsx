import { Suspense } from "react";

import { AuthForm } from "@/components/auth-form";

export default function SignUpPage() {
  return (
    <Suspense fallback={<p>Loading...</p>}>
      <AuthForm mode="signUp" />
    </Suspense>
  );
}
