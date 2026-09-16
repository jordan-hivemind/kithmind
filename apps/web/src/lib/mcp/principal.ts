// The per-call principal, reloaded inside the call's own transaction.
//
// Section 3.3 of the web and MCP surface plan: "The server holds a
// `PrincipalRef`, not a `Principal`. Each tool call reloads it inside its own
// transaction through `currentPrincipal`, so a revoked key or a removed
// membership denies on the next call rather than at the end of the session."
//
// This is the seam that makes that possible. `/api/mcp` authenticates once and
// keeps only `{ userId, credentialId }`, which carries no authority of its own:
// it is two identifiers, and every capability, space grant and membership behind
// them is read again from the row. A tool that wants to do work asks for a
// session, gets one transaction and one freshly loaded `Principal`, and the
// transaction closes when the work does.
//
// Section 4.3's rule is the reason this hands out the `IdentityCtx` rather than
// only the principal: a call that needs several services must give all of them
// the same client, or the halves of one answer come from two snapshots. Opening
// a second transaction inside `run` is the mistake this shape exists to prevent.
//
// `readOnly` picks section 4.2's two shapes. Reads take
// `REPEATABLE READ READ ONLY`, which gets the snapshot without a serialization
// failure the caller would have to retry. Writes take `SERIALIZABLE` with the
// bounded retry `withKithTransaction` already implements, so `run` must be safe
// to execute more than once.

import { withKithReadTransaction, withKithTransaction } from "@repo/kith-store";
import {
  type IdentityCtx,
  identityCtx,
  type Principal,
  type PrincipalRef,
  reloadPrincipal,
  requireWebPrincipal,
} from "@repo/kith-store/identity";

import { kithPool } from "@/lib/kith/pool";
import { kithSessionConfig } from "@/lib/kith/session";

/** One transaction, one reloaded principal, one fixed `now`. */
export type McpPrincipalSession = {
  ctx: IdentityCtx;
  principal: Principal;
};

/**
 * Runs one unit of tool work with a live principal.
 *
 * Throws `IdentityError("Not authenticated")` when the credential stopped being
 * one between calls, which is the denial section 7 asks for: "Does a key revoked
 * between two tool calls deny on the second?"
 */
export type WithMcpPrincipal = <T>(
  run: (session: McpPrincipalSession) => Promise<T>,
  options?: { readOnly?: boolean },
) => Promise<T>;

/** Binds a reference to the pool. The reference is the only thing cached. */
export function mcpPrincipalLoader(ref: PrincipalRef): WithMcpPrincipal {
  return async (run, options = {}) => {
    const transaction = options.readOnly
      ? withKithReadTransaction
      : withKithTransaction;
    return await transaction(kithPool(), async (client) => {
      const ctx = identityCtx(client);
      const principal = await reloadPrincipal(ctx, ref);
      return await run({ ctx, principal });
    });
  };
}

/**
 * A web session's `WithMcpPrincipal`, i7a's sibling of `mcpPrincipalLoader`.
 *
 * `lib/kith/capture.ts`'s `captureThoughtFromWeb` (Quick Capture's gate) calls
 * `withPrincipal` up to three times per capture, each its own transaction, so
 * it cannot be handed a principal already loaded by an outer transaction --
 * that would mean two clients open for one capture, or a stale principal for
 * transactions 2 and 3. This binds the cookie header instead, the same way
 * `mcpPrincipalLoader` binds a `PrincipalRef`: it is the only thing cached,
 * and every call reloads the session fresh, so a session revoked between two
 * of the gate's transactions denies on the next one exactly as a revoked API
 * key does. No `touch: true`: the personal-space bootstrap and eight days of
 * this cookie's ten-year life are not affected by a capture skipping the
 * `last_used_at` refresh a page load already gives it.
 */
export function webPrincipalLoader(cookieHeader: string | null): WithMcpPrincipal {
  return async (run, options = {}) => {
    const config = kithSessionConfig();
    const transaction = options.readOnly
      ? withKithReadTransaction
      : withKithTransaction;
    return await transaction(kithPool(), async (client) => {
      const ctx = identityCtx(client);
      const principal = await requireWebPrincipal(ctx, { config, cookieHeader });
      return await run({ ctx, principal });
    });
  };
}
