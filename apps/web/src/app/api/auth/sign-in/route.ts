// `POST /api/auth/sign-in`. Section 2.2 of the web and MCP surface plan.
//
// One transaction: `identity.signIn`, then `identity.ensurePersonalSpace`. Both
// inside the same `withKithTransaction`, so a sign-in that opens a session
// without the space records it needs, or the reverse, is not a state this can
// reach.

import { withKithTransaction } from "@repo/kith-store";
import {
  ensurePersonalSpace,
  identityCtx,
  sessionCookie,
  signIn,
} from "@repo/kith-store/identity";

import {
  authFailure,
  limiterUnavailable,
  noContent,
  problem,
  readCredentials,
  readJsonBody,
  tooManyAttempts,
} from "@/lib/kith/auth-route";
import { checkAuthRateLimit } from "@/lib/kith/durable-rate-limit";
import { kithPool } from "@/lib/kith/pool";
import { kithSessionConfig } from "@/lib/kith/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const credentials = body === null ? null : readCredentials(body);
  if (credentials === null) return problem(400, "Invalid request");

  // The limiter runs before the credential check and in its own transaction
  // (`checkAuthRateLimit`, under `postgres`), so a denied or failed attempt
  // never reaches `signIn` below. `"unavailable"` fails closed: a database
  // outage must refuse the attempt, not wave it through.
  const outcome = await checkAuthRateLimit(request, credentials.email);
  if (outcome.kind === "unavailable") return limiterUnavailable();
  if (outcome.kind === "denied") {
    return tooManyAttempts(outcome.retryAfterSeconds);
  }

  try {
    const config = kithSessionConfig();
    const opened = await withKithTransaction(kithPool(), async (client) => {
      const ctx = identityCtx(client);
      const session = await signIn(ctx, {
        email: credentials.email,
        password: credentials.password,
      });
      // An account migrated from Convex may predate personal spaces, so this is
      // not redundant with the same call in sign-up: it is the repair path for
      // a user whose records were never created.
      await ensurePersonalSpace(ctx, session.userId);
      return session;
    });
    return noContent(sessionCookie(config, opened.token, opened.expiresAt));
  } catch (error) {
    return authFailure(error);
  }
}
