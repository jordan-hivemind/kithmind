// `POST /api/auth/sign-up`. Section 2.2 of the web and MCP surface plan.
//
// One transaction: `identity.signUp`, then `identity.ensurePersonalSpace`. The
// second call is idempotent and is kept because the plan names it; `signUp`
// creates the personal space records itself, which is the P2-39i fix for the
// defect where its doc comment claimed them and the function did not.
//
// An existing account produces the same `Invalid credentials` the sign-in route
// gives for a wrong password, which is what stops this being an
// account-existence oracle. The library raises it; the route only has to avoid
// widening it.

import { withKithTransaction } from "@repo/kith-store";
import {
  ensurePersonalSpace,
  identityCtx,
  sessionCookie,
  signUp,
} from "@repo/kith-store/identity";

import {
  authFailure,
  noContent,
  problem,
  readCredentials,
  readJsonBody,
  tooManyAttempts,
} from "@/lib/kith/auth-route";
import { kithPool } from "@/lib/kith/pool";
import { authRateLimiter, clientAddress } from "@/lib/kith/rate-limit";
import { kithSessionConfig } from "@/lib/kith/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const credentials = body === null ? null : readCredentials(body);
  if (credentials === null) return problem(400, "Invalid request");

  const decision = authRateLimiter().check({
    address: clientAddress(request),
    account: credentials.email,
  });
  if (!decision.allowed) return tooManyAttempts(decision.retryAfterSeconds);

  try {
    const config = kithSessionConfig();
    const opened = await withKithTransaction(kithPool(), async (client) => {
      const ctx = identityCtx(client);
      const created = await signUp(ctx, {
        email: credentials.email,
        password: credentials.password,
        ...(credentials.name === undefined ? {} : { name: credentials.name }),
      });
      await ensurePersonalSpace(ctx, created.userId);
      return created;
    });
    return noContent(sessionCookie(config, opened.token, opened.expiresAt));
  } catch (error) {
    return authFailure(error);
  }
}
