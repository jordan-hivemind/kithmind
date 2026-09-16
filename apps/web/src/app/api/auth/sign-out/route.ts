// `POST /api/auth/sign-out`. Section 2.2 of the web and MCP surface plan.
//
// Logout is server side. `identity.signOut` sets `revoked_at` on the session row
// and then returns the cookie that clears it in the browser, in that order and
// not the other way round: a cleared cookie alone would leave a live token that
// anyone holding a copy could keep using, which is exactly the property section
// 2.4 has to be able to answer no to.
//
// Always 204, whether or not there was a session to end. A sign-out that
// reported "there was nothing to sign out of" would tell an unauthenticated
// caller whether a cookie it presented was real.

import { withKithTransaction } from "@repo/kith-store";
import { identityCtx, signOut } from "@repo/kith-store/identity";

import { authFailure, noContent } from "@/lib/kith/auth-route";
import { kithPool } from "@/lib/kith/pool";
import { kithSessionConfig } from "@/lib/kith/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const config = kithSessionConfig();
    const { setCookie } = await withKithTransaction(kithPool(), (client) =>
      signOut(identityCtx(client), {
        config,
        cookieHeader: request.headers.get("cookie"),
      }),
    );
    return noContent(setCookie);
  } catch (error) {
    return authFailure(error);
  }
}
