import { Suspense } from "react";

import { KithAuthForm } from "@/components/kith-auth-form";

export default function SignInPage() {
  return (
    <Suspense fallback={<p>Loading...</p>}>
      <KithAuthForm mode="signIn" />
    </Suspense>
  );
}
