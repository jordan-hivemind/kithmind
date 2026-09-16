import { Suspense } from "react";

import { AuthForm } from "@/components/auth-form";
import { KithAuthForm } from "@/components/kith-auth-form";
import { kithPostgresSurface } from "@/lib/kith/surface";

export default function SignUpPage() {
  const postgres = kithPostgresSurface() === "postgres";
  return (
    <Suspense fallback={<p>Loading...</p>}>
      {postgres ? <KithAuthForm mode="signUp" /> : <AuthForm mode="signUp" />}
    </Suspense>
  );
}
