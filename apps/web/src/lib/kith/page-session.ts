// The one-transaction-per-page loader every ported page uses.
//
// Section 6 row i5: "each page's data comes from one withKithReadTransaction
// ... with the session checked inside it via requireWebPrincipal, never
// trusting the middleware alone." The layout above every `(authenticated)`
// page already calls `currentWebPrincipal()` with `touch: true` and redirects
// a null result, so the session's `last_used_at` is refreshed once per
// request there; this loader does not repeat that write; it cannot, because
// it runs inside a `READ ONLY` transaction, which is why `touch` is left at
// its default here. What it does repeat is the check itself: a page must not
// render its own data on the strength of having been let through the layout,
// so every loader below reloads the session from the cookie and denies for
// itself.
//
// `cookieHeader` is a parameter rather than a `headers()` call inside this
// function, the same shape `lib/mcp/consent-spaces.ts` uses. It is what makes
// every page loader built on this testable without a Next.js request
// context: a page's `page.tsx` reads the header once and passes it in, and a
// test does the same with a header it built itself.
//
// `null` means "not signed in" and only that, matching `currentWebPrincipal`
// and `consentSpaces`. An unmodelled failure -- the database being
// unreachable -- is rethrown rather than turned into a sign-in redirect: that
// would ask the owner for a password to fix an outage.
//
// The catch is scoped to `requireWebPrincipal` alone, not to the whole
// transaction. The second-model review of P2-39i5 found that catching every
// `IdentityError` from the whole block turned an authorization or state
// failure raised by `run` -- `invalid_api_key_state` from
// `listApiKeysPage`, for one -- into "not signed in", which signs a valid
// session out and sends it back through a redirect loop for a problem that
// has nothing to do with the session. Only `requireWebPrincipal`'s own
// "Not authenticated" may become `null`; everything `run` raises propagates.

import { withKithReadTransaction } from "@repo/kith-store";
import {
  type IdentityCtx,
  identityCtx,
  IdentityError,
  type Principal,
  requireWebPrincipal,
} from "@repo/kith-store/identity";

import { kithPool } from "@/lib/kith/pool";
import { kithSessionConfig } from "@/lib/kith/session";

export type PageSession = { ctx: IdentityCtx; principal: Principal };

/**
 * Runs `run` inside one `REPEATABLE READ READ ONLY` transaction with a freshly
 * reloaded principal, or returns `null` when the cookie authenticates nobody.
 */
export async function loadAuthenticatedPage<T>(
  cookieHeader: string | null,
  run: (session: PageSession) => Promise<T>,
): Promise<T | null> {
  const config = kithSessionConfig();
  return await withKithReadTransaction(kithPool(), async (client) => {
    const ctx = identityCtx(client);
    let principal: Principal;
    try {
      principal = await requireWebPrincipal(ctx, { config, cookieHeader });
    } catch (error) {
      if (error instanceof IdentityError && error.message === "Not authenticated") {
        return null;
      }
      throw error;
    }
    return await run({ ctx, principal });
  });
}
