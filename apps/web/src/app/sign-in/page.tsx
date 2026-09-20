import { Suspense } from "react";

import { KithAuthForm } from "@/components/kith-auth-form";
import { googleOAuthEnabled } from "@/lib/kith/google-oauth";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <Suspense
      fallback={<p className="p-6 text-xs text-gray-600">Loading...</p>}
    >
      <KithAuthForm mode="signIn" googleOAuthEnabled={googleOAuthEnabled()} />
    </Suspense>
  );
}
