// Turning a bearer token into an MCP identity.
//
// Section 3.1 of the web and MCP surface plan: one transaction against
// `identity.authenticateApiKey`. i7b deleted the Convex leg and the JWT the old
// one minted on the way back.
//
// `/api/mcp` consumes `{ userId, keyId }` and nothing else, and
// `{ userId, credentialId: keyId }` is exactly the `PrincipalRef` the per-call
// reload in `principal.ts` takes.
//
// Every failure returns `null` and none of them is distinguishable in the
// response. That is the rule `identity.authenticateApiKey` states for itself --
// "the caller is an authentication route and every failure it can distinguish is
// a failure it can leak" -- and this function must not widen it. A revoked key,
// a key in the middle of an OAuth grant, a key whose user was deleted and a
// bearer that was never a key all produce the same 401 with the same body. A
// legacy row with no capabilities is refused here too, because
// `principalFromApiKey` throws on it.
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
// `/api/ingest` and `/api/worker` use this function too, as of row i4: a
// credential resolved against `kith.api_keys` authorizes work on kith data, and
// there is one way in.

import { withKithTransaction } from "@repo/kith-store";
import {
  authenticateApiKey as authenticateKithApiKey,
  identityCtx,
} from "@repo/kith-store/identity";

import { kithPool } from "@/lib/kith/pool";

export type McpIdentity = { userId: string; keyId: string };

/**
 * One `SERIALIZABLE` transaction, one service call.
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
  return await authenticateThroughPostgres(authHeader.slice(7));
}
