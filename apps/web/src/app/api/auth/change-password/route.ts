// `POST /api/auth/change-password`. Section 2.2 of the web and MCP surface plan.
//
// One transaction: `identity.requireWebSession`, then `identity.changePassword`.
// The session is re-read from the cookie inside this transaction rather than
// trusted from the middleware, which is the section 7 checklist's rule and the
// reason the middleware is allowed to be a MAC check with no database behind it.
//
// The caller keeps the session they are changing the password from and every
// other session is revoked. That is `keepSessionId`, and it is why this route
// needs the session row and not just the principal: a password change that
// signed the owner out of the tab they changed it in would train them to
// re-enter the new password immediately, and a password change that kept
// everything would not end the session an attacker already had.
//
// The current session's token is not rotated. It is already bound to the user
// and not to the password, it was presented with this request rather than
// replayed, and every other token it could be confused with has just been
// revoked.

import { withKithTransaction } from "@repo/kith-store";
import {
  changePassword,
  identityCtx,
  requireWebSession,
} from "@repo/kith-store/identity";

import {
  authFailure,
  noContent,
  problem,
  readJsonBody,
} from "@/lib/kith/auth-route";
import { kithPool } from "@/lib/kith/pool";
import { kithSessionConfig } from "@/lib/kith/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request);
  const email = body === null ? undefined : text(body.email);
  const currentPassword = body === null ? undefined : text(body.currentPassword);
  const newPassword = body === null ? undefined : text(body.newPassword);
  if (
    email === undefined ||
    currentPassword === undefined ||
    newPassword === undefined
  ) {
    return problem(400, "Invalid request");
  }

  try {
    const config = kithSessionConfig();
    await withKithTransaction(kithPool(), async (client) => {
      const ctx = identityCtx(client);
      const { principal, session } = await requireWebSession(ctx, {
        config,
        cookieHeader: request.headers.get("cookie"),
        touch: true,
      });
      await changePassword(ctx, {
        userId: principal.userId,
        email,
        currentPassword,
        newPassword,
        keepSessionId: session.id,
      });
    });
    return noContent();
  } catch (error) {
    return authFailure(error);
  }
}
