// Turning a bearer token into an MCP identity, on either surface.
//
// Section 3.1 of the web and MCP surface plan. Under `convex` this is what it
// always was: hash the key in the route and ask the one unauthenticated Convex
// action to resolve it. Under `postgres` it is one transaction against
// `identity.authenticateApiKey`, and no JWT is minted on the way back.
//
// The return shape is identical in both modes, on purpose. `/api/mcp` consumes
// `{ userId, keyId }` and nothing else, so the surface switch is invisible above
// this function, and `{ userId, credentialId: keyId }` is exactly the
// `PrincipalRef` the per-call reload in `principal.ts` takes.
//
// Every failure returns `null` and none of them is distinguishable in the
// response. That is the rule `identity.authenticateApiKey` states for itself --
// "the caller is an authentication route and every failure it can distinguish is
// a failure it can leak" -- and this function must not widen it. A revoked key,
// a key in the middle of an OAuth grant, a key whose user was deleted and a
// bearer that was never a key all produce the same 401 with the same body.
//
// Parity with the Convex action, check by check:
//
// | Denial                     | Convex                                                      | PostgreSQL                                                 |
// | -------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
// | Malformed bearer           | No `Bearer ` prefix, or a hash that matches no row          | Same prefix check, then `SHA256_HEX` shape, then no row    |
// | Revoked key                | `_findByHash` finds nothing; revoke deletes the row         | `getApiKeyByHash` finds nothing, for the same reason       |
// | `preparing` or `pending`   | `hasNoOAuthLifecycle` in `findByHash` and `updateLastUsed`  | `hasNoOAuthLifecycle` in `requireMcpPrincipal`             |
// | Deleted user               | `ctx.db.get(key.userId)` in both internal functions         | `userExists`, then again inside `touchApiKey`              |
// | Touch refused mid-request  | `updateLastUsed` returns false, action returns null         | `touchApiKey` returns false, `requireMcpPrincipal` denies  |
//
// One difference, and it denies rather than admits: a legacy row with no
// capabilities is refused here at authentication, because `principalFromApiKey`
// throws on it. The Convex action returned an identity for such a key and the
// tool call then failed in `requireMcpPrincipal`. Same outcome, one hop earlier,
// and nothing that was refused before is admitted now.
//
// An unmodelled failure is not caught, and that is load bearing rather than
// tidy. `requireMcpPrincipal` writes `last_used_at` on every success, so two
// concurrent calls with one valid bearer contend on one row under
// `SERIALIZABLE`; the store used to swallow the resulting SQLSTATE 40001 into
// `null` and this route answered 401 for a perfectly good key. Now the 40001
// reaches `withKithTransaction`'s retry loop, and a statement timeout, a lock
// timeout or an unreachable database reach the caller, which turns them into
// 503 `authentication_unavailable`. A 401 for an outage would tell a client its
// credential is bad and send it back through the OAuth flow.
//
// `/api/ingest` and `/api/worker` use this function too, as of row i4. i2 had
// pinned them to Convex with a second authenticator that ignored the flag,
// because a credential resolved against `kith.api_keys` must not authorize work
// on Convex data. i4 moves each route's work and its authentication together, so
// the pin and the second authenticator are gone and there is one way in again.

import { api } from "@repo/db/convex/_generated/api";
import { withKithTransaction } from "@repo/kith-store";
import {
  authenticateApiKey as authenticateKithApiKey,
  identityCtx,
} from "@repo/kith-store/identity";
import { ConvexHttpClient } from "convex/browser";

import { kithPool } from "@/lib/kith/pool";
import { kithPostgresSurface } from "@/lib/kith/surface";

export type McpIdentity = { userId: string; keyId: string };

function getConvex() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
  return new ConvexHttpClient(url);
}

/** SHA-256 of the raw key, hex, computed with the Web Crypto API. */
async function hashRawKey(rawKey: string): Promise<string> {
  const data = new TextEncoder().encode(rawKey);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The Convex surface: the key hash goes out, an identity comes back. */
async function authenticateThroughConvex(
  rawKey: string,
): Promise<McpIdentity | null> {
  const keyHash = await hashRawKey(rawKey);
  const result = await getConvex().action(
    api.models.apiKeys.mcpAuth.authenticateKeyHash,
    { keyHash },
  );
  return result ? { userId: result.userId, keyId: result.keyId } : null;
}

/**
 * The PostgreSQL surface: one `SERIALIZABLE` transaction, one service call.
 *
 * The raw key is handed to the store rather than hashed here, so there is one
 * implementation of the hash on this path and not two that could disagree about
 * encoding.
 */
async function authenticateThroughPostgres(
  rawKey: string,
): Promise<McpIdentity | null> {
  const result = await withKithTransaction(kithPool(), (client) =>
    authenticateKithApiKey(identityCtx(client), { rawKey }),
  );
  return result ? { userId: result.userId, keyId: result.keyId } : null;
}

export async function authenticateApiKey(
  authHeader: string | null,
): Promise<McpIdentity | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const rawKey = authHeader.slice(7);

  return kithPostgresSurface() === "postgres"
    ? await authenticateThroughPostgres(rawKey)
    : await authenticateThroughConvex(rawKey);
}
