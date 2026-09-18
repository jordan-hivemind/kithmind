import { Suspense } from "react";

import { KithAuthForm } from "@/components/kith-auth-form";

export default function SignUpPage() {
  return (
    <Suspense fallback={<p>Loading...</p>}>
      <KithAuthForm mode="signUp" />
    </Suspense>
  );
}
