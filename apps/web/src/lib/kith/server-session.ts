// The session, read by a server component.
//
// Section 7's checklist: "Does every authenticated route call
// `requireWebPrincipal` inside its own transaction rather than trusting the
// middleware?" This is how a page does it. The middleware verified a MAC and
// nothing else, so a page that rendered on the strength of having been reached
// would render for a valid MAC over a revoked token.
//
// `withKithTransaction` rather than `withKithReadTransaction`, and that is the
// one thing here worth a second look. A read-only transaction would be the
// natural shape for a page, but `touch: true` refreshes
// `kith.sessions.last_used_at`, which is a write, and the server refuses a write
// under `READ ONLY` with SQLSTATE 25006. The refresh is throttled to one write
// per `SESSION_TOUCH_MIN_MS`, so almost every page load writes nothing and the
// transaction is a read that happens to be allowed to write. When i5 moves the
// pages onto real data, a page that reads rows should open its own
// `withKithReadTransaction` for them rather than widen this one.

import { withKithTransaction } from "@repo/kith-store";
import {
  identityCtx,
  IdentityError,
  type Principal,
  requireWebPrincipal,
} from "@repo/kith-store/identity";
import { headers } from "next/headers";

import { kithPool } from "@/lib/kith/pool";
import { kithSessionConfig } from "@/lib/kith/session";

/**
 * The authenticated caller, or null.
 *
 * Null for every modelled authentication failure and only those: an unmodelled
 * error, such as the database being unreachable, is rethrown rather than
 * rendered as "not signed in", because a redirect to `/sign-in` that the owner
 * cannot get past is a worse answer than an error page that says what broke.
 */
export async function currentWebPrincipal(): Promise<Principal | null> {
  const config = kithSessionConfig();
  const cookieHeader = (await headers()).get("cookie");
  try {
    return await withKithTransaction(kithPool(), (client) =>
      requireWebPrincipal(identityCtx(client), {
        config,
        cookieHeader,
        touch: true,
      }),
    );
  } catch (error) {
    if (error instanceof IdentityError) return null;
    throw error;
  }
}
