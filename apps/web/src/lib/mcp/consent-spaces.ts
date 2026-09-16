// What the consent screen is allowed to offer, read on the server.
//
// The Convex picker did this with two hooks: an `ensurePersonal` mutation, then
// a `list` query once it resolved. Both run here instead, on one client inside
// one transaction, which is also what removes the ordering the hooks had to
// arrange -- a list read before the personal space exists cannot be observed if
// the two statements share a transaction.
//
// `withKithTransaction` rather than `withKithReadTransaction` because
// `ensurePersonalSpace` writes when the records are missing, and the server
// refuses a write under `READ ONLY` with SQLSTATE 25006.
//
// `null` means "not signed in" and only that. A database failure is rethrown, so
// a consent screen never renders a sign-in form because the database was
// unreachable: that would ask the owner for a password to fix an outage.

import { withKithTransaction } from "@repo/kith-store";
import {
  ensurePersonalSpace,
  identityCtx,
  IdentityError,
  type ListedSpace,
  listSpaces,
  requireWebPrincipal,
} from "@repo/kith-store/identity";

import { kithPool } from "@/lib/kith/pool";
import { kithSessionConfig } from "@/lib/kith/session";

/**
 * The spaces this session may grant, or null when the cookie authenticates
 * nobody.
 *
 * The list is the caller's own memberships, never a space id taken from the
 * request: `listSpaces` starts from `getAuthorizedReadSpaceIds`, so what the
 * screen can offer is bounded by what the person can actually read now.
 */
export async function consentSpaces(
  cookieHeader: string | null,
): Promise<ListedSpace[] | null> {
  const config = kithSessionConfig();
  try {
    return await withKithTransaction(kithPool(), async (client) => {
      const ctx = identityCtx(client);
      const principal = await requireWebPrincipal(ctx, {
        config,
        cookieHeader,
        touch: true,
      });
      await ensurePersonalSpace(ctx, principal.userId);
      return await listSpaces(ctx, { principal });
    });
  } catch (error) {
    if (error instanceof IdentityError) return null;
    throw error;
  }
}
