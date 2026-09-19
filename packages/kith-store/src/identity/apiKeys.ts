// The port of `models/apiKeys/*` and of `lib/mcpAuth.ts`.
//
// The MCP credential model is unchanged (section 1.5: "same key and grant model
// in `kith.api_keys`. The route authenticates directly"), so the shapes below are
// the Convex ones and only the storage moved. Three things changed, all forced by
// the storage and none of them widening:
//
//   * `spaceIds` and `sourceAccountIds` were arrays on the row and are now the
//     two join tables P2-39b declares. A grant is a row, so a space that is
//     deleted takes the grant with it instead of leaving a dangling id in an
//     array.
//   * `authenticateKeyHash` was the one unauthenticated Convex action, because
//     the MCP gateway had to turn a key into a JWT. There is no JWT any more, so
//     it becomes `authenticateApiKey`, which returns the principal directly and
//     is called by the route rather than exposed as a function.
//   * `requireMcpPrincipal` took an identity minted from the key; it now takes
//     the key hash. Same checks in the same order, one hop shorter.
//
// `revoke` still deletes the row rather than flagging it. That is what makes the
// revoked-key denial immediate: the next request's reload finds nothing.

import { randomBytes } from "node:crypto";

import { sha256 as sha256Hex } from "../hash.js";
import { assertKithId, newKithId } from "../ids.js";
import {
  ensurePersonalSpace,
  getApiKey,
  getApiKeyByHash,
  getAuthorizedReadSpaceIds,
  hasNoOAuthLifecycle,
  principalFromApiKey,
  requireSpaceAccess,
  touchApiKey,
  userExists,
  type ApiKeyRecord,
  type Capability,
  type Principal,
} from "./authorization.js";
import { at, exec, row, rows, type IdentityCtx } from "./db.js";
import { IdentityError, notAuthenticated } from "./errors.js";
import type { SensitivityLevel } from "../sensitivity/model.js";

export type ApiKeySummary = {
  id: string;
  createdAt: number;
  keyPrefix: string;
  name: string;
  lastUsedAt: number | null;
  capabilities: readonly Capability[];
  spaceIds: readonly string[];
  maxSensitivity: SensitivityLevel;
  sourceAccountIds: readonly string[];
};

const MAX_KEYS = 100;
const MAX_GRANTS = 100;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function typedError(code: string, message: string): never {
  throw new IdentityError(message, { code, message });
}

function summarize(key: ApiKeyRecord): ApiKeySummary {
  if (key.capabilities === null) {
    typedError("invalid_api_key_state", "API key lifecycle data is invalid.");
  }
  return {
    id: key.id,
    createdAt: key.createdAt,
    keyPrefix: key.keyPrefix,
    name: key.name,
    lastUsedAt: key.lastUsedAt,
    capabilities: key.capabilities,
    spaceIds: key.spaceIds,
    maxSensitivity: key.maxSensitivity,
    sourceAccountIds: key.sourceAccountIds,
  };
}

/**
 * A fresh key and the hash that is stored for it.
 *
 * `ob_` plus 64 hex characters, and only the SHA-256 is kept, both unchanged: an
 * existing key must keep authenticating after cutover and an existing prefix must
 * keep matching what the dashboard shows.
 */
export function generateApiKeyMaterial(): { rawKey: string; keyHash: string } {
  const rawKey = `ob_${randomBytes(32).toString("hex")}`;
  return { rawKey, keyHash: sha256Hex(rawKey) };
}

export function validateApiKeyName(name: string): void {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 200 ||
    new TextDecoder().decode(new TextEncoder().encode(name)) !== name
  ) {
    typedError(
      "invalid_input",
      "API key name must contain 1 to 200 valid characters.",
    );
  }
}

/**
 * Every scope a key may carry has to be one the granting principal holds now.
 *
 * This is the function that stops a credential widening authority instead of
 * narrowing it, so it is checked on create and on update, and the OAuth flow
 * re-checks the stored scopes at every step rather than trusting what it wrote.
 */
export async function validateApiKeyScopes(
  ctx: IdentityCtx,
  principal: Principal,
  capabilities: readonly Capability[],
  spaceIds: readonly string[],
  sourceAccountIds: readonly string[],
): Promise<void> {
  if (
    !capabilities.length ||
    !spaceIds.length ||
    spaceIds.length > MAX_GRANTS ||
    sourceAccountIds.length > MAX_GRANTS
  ) {
    throw new Error("API keys require bounded capabilities and space scopes");
  }
  if (
    new Set(capabilities).size !== capabilities.length ||
    new Set(spaceIds).size !== spaceIds.length ||
    new Set(sourceAccountIds).size !== sourceAccountIds.length
  ) {
    throw new Error("API key scopes must be unique");
  }
  const hasIngest = capabilities.includes("ingest");
  const hasSources = sourceAccountIds.length > 0;
  if (hasIngest !== hasSources) {
    throw new Error(
      "Ingest capability requires explicit source accounts; other keys cannot grant them",
    );
  }
  await getAuthorizedReadSpaceIds(ctx, principal, spaceIds);
  for (const sourceAccountId of sourceAccountIds) {
    const account = await sourceAccount(ctx, sourceAccountId);
    if (!account || !account.enabled || !spaceIds.includes(account.spaceId)) {
      throw new Error("Source account not found");
    }
    await requireSpaceAccess(ctx, principal, account.spaceId, "ingest");
  }
}

/**
 * One source account. `kith.source_accounts` is P2-39d's table; this reads only
 * the two columns an ingest grant has to be checked against, because a key that
 * can reach a source account is the widest credential the system issues.
 */
async function sourceAccount(
  ctx: IdentityCtx,
  id: string,
): Promise<{ spaceId: string; enabled: boolean } | null> {
  const record = await row<{ space_id: string; enabled: boolean | null }>(
    ctx,
    "SELECT space_id, enabled FROM kith.source_accounts WHERE id = $1",
    [assertKithId(id, "invalid_source_account_id")],
  );
  return record
    ? { spaceId: record.space_id, enabled: record.enabled === true }
    : null;
}

async function replaceGrants(
  ctx: IdentityCtx,
  apiKeyId: string,
  spaceIds: readonly string[],
  sourceAccountIds: readonly string[],
): Promise<void> {
  await exec(ctx, "DELETE FROM kith.api_key_spaces WHERE api_key_id = $1", [
    apiKeyId,
  ]);
  await exec(
    ctx,
    "DELETE FROM kith.api_key_source_accounts WHERE api_key_id = $1",
    [apiKeyId],
  );
  for (const spaceId of spaceIds) {
    await exec(
      ctx,
      `INSERT INTO kith.api_key_spaces (id, api_key_id, space_id) VALUES ($1, $2, $3)`,
      [newKithId(), apiKeyId, assertKithId(spaceId, "invalid_space_id")],
    );
  }
  for (const sourceAccountId of sourceAccountIds) {
    await exec(
      ctx,
      `INSERT INTO kith.api_key_source_accounts (id, api_key_id, source_account_id)
         VALUES ($1, $2, $3)`,
      [
        newKithId(),
        apiKeyId,
        assertKithId(sourceAccountId, "invalid_source_account_id"),
      ],
    );
  }
}

/**
 * Deletes a key and detaches the consumed-code receipts that name it.
 *
 * Every path that removes a key goes through here -- `revoke` below,
 * `beginAuthorizationGrant`'s stale-grant delete, `abandonAuthorizationGrant`,
 * `removeExpired` and the revoked-key denial probe -- and the detach is why.
 * Convex had no referential integrity: deleting an `apiKeys`
 * document left `consumedOAuthCodes.apiKeyId` pointing at nothing, which was
 * harmless because the receipt only has to outlive the key. PostgreSQL has a
 * foreign key, it is `DEFERRABLE INITIALLY DEFERRED`, and so the delete succeeds
 * and the *commit* fails -- P2-39i2 found this from the token route, where the
 * replay branch could not commit the revocation RFC 6749 section 4.1.2 requires.
 *
 * The receipt is kept and its `api_key_id` is cleared rather than the receipt
 * being deleted with the key. That is what keeps the consent unusable for the
 * rest of the code's lifetime: `beginAuthorizationGrant` looks a receipt up by
 * user and request hash, not by key, so a receipt that disappeared with the key
 * would turn a leaked code into a reissued one.
 */
export async function deleteApiKey(
  ctx: IdentityCtx,
  id: string,
): Promise<void> {
  await exec(
    ctx,
    "UPDATE kith.consumed_oauth_codes SET api_key_id = NULL WHERE api_key_id = $1",
    [id],
  );
  await exec(ctx, "DELETE FROM kith.api_keys WHERE id = $1", [id]);
}

/** Active keys for one user. `models/apiKeys/model.ts` `_listByUser`. */
export async function listByUser(
  ctx: IdentityCtx,
  userId: string,
): Promise<ApiKeyRecord[]> {
  const ids = await rows<{ id: string }>(
    ctx,
    `SELECT id FROM kith.api_keys
       WHERE user_id = $1 AND oauth_lifecycle IS NULL
       ORDER BY created_at, id LIMIT $2`,
    [assertKithId(userId, "invalid_user_id"), MAX_KEYS + 1],
  );
  const keys: ApiKeyRecord[] = [];
  for (const { id } of ids) {
    const key = await getApiKey(ctx, id);
    if (key) keys.push(key);
  }
  return keys;
}

/** `models/apiKeys/public.ts` `list`. */
export async function list(
  ctx: IdentityCtx,
  args: { principal: Principal },
): Promise<ApiKeySummary[]> {
  const keys = await listByUser(ctx, args.principal.userId);
  if (keys.some((key) => !hasNoOAuthLifecycle(key))) {
    typedError("invalid_api_key_state", "API key lifecycle data is invalid.");
  }
  if (keys.length > MAX_KEYS) {
    typedError(
      "api_key_list_overflow",
      "Too many API keys to list. Use paginated key management.",
    );
  }
  return keys.map(summarize);
}

/**
 * `models/apiKeys/public.ts` `listPage`, as a keyset cursor.
 *
 * Section 2.3: Convex's `_creationTime` total order becomes a cursor over
 * `(created_at, id)`. The cursor is opaque to the caller either way, so the
 * dashboard's paging is a repoint rather than a redesign.
 */
export async function listPage(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    numItems: number;
    cursor?: string | null;
  },
): Promise<{
  page: ApiKeySummary[];
  isDone: boolean;
  continueCursor: string | null;
}> {
  const { numItems } = args;
  if (!Number.isInteger(numItems) || numItems < 1 || numItems > 50) {
    typedError("invalid_input", "Pagination size must be between 1 and 50.");
  }
  const after = decodeCursor(args.cursor);
  // `created_at::text`, not the driver's `Date`. A `timestamptz` has microsecond
  // resolution and a JavaScript `Date` has millisecond, so a cursor built from
  // `getTime()` rounds down and the next page re-reads the row it was supposed to
  // start after. Carrying the server's own text rendering and casting it straight
  // back keeps the comparison exact.
  const ids = await rows<{ id: string; created_at_text: string }>(
    ctx,
    `SELECT id, created_at::text AS created_at_text FROM kith.api_keys
       WHERE user_id = $1 AND oauth_lifecycle IS NULL
         AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3))
       ORDER BY created_at, id LIMIT $4`,
    [
      assertKithId(args.principal.userId, "invalid_user_id"),
      after?.createdAt ?? null,
      after?.id ?? null,
      numItems + 1,
    ],
  );
  const window = ids.slice(0, numItems);
  const page: ApiKeySummary[] = [];
  for (const record of window) {
    const key = await getApiKey(ctx, record.id);
    if (!key) continue;
    if (!hasNoOAuthLifecycle(key)) {
      typedError("invalid_api_key_state", "API key lifecycle data is invalid.");
    }
    page.push(summarize(key));
  }
  const last = window.at(-1);
  return {
    page,
    isDone: ids.length <= numItems,
    continueCursor:
      ids.length > numItems && last
        ? encodeCursor(last.created_at_text, last.id)
        : null,
  };
}

/** What a `timestamptz` renders as. Checked because the cursor is caller input. */
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), "utf8").toString(
    "base64url",
  );
}

function decodeCursor(
  cursor: string | null | undefined,
): { createdAt: string; id: string } | null {
  if (cursor === null || cursor === undefined || cursor === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    typedError("invalid_input", "Pagination cursor is invalid.");
  }
  // The cursor is opaque to the caller but it still arrives from one, so both
  // halves are validated before either reaches a statement.
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    !TIMESTAMP.test(parsed[0]) ||
    typeof parsed[1] !== "string"
  ) {
    typedError("invalid_input", "Pagination cursor is invalid.");
  }
  return { createdAt: parsed[0], id: assertKithId(parsed[1], "invalid_id") };
}

/**
 * `models/apiKeys/public.ts` `create`. Returns the raw key once; it is never
 * stored and never retrievable again.
 */
export async function create(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    name: string;
    capabilities: readonly Capability[];
    spaceIds: readonly string[];
    sourceAccountIds?: readonly string[];
    /** SENS-1. Absent is `restricted`: the key withholds nothing. */
    maxSensitivity?: SensitivityLevel;
  },
): Promise<{ id: string; rawKey: string }> {
  const { principal } = args;
  validateApiKeyName(args.name);
  await ensurePersonalSpace(ctx, principal.userId);
  await validateApiKeyScopes(
    ctx,
    principal,
    args.capabilities,
    args.spaceIds,
    args.sourceAccountIds ?? [],
  );

  const { rawKey, keyHash } = generateApiKeyMaterial();
  const id = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.api_keys
       (id, user_id, key_hash, key_prefix, name, capabilities, max_sensitivity)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      id,
      principal.userId,
      keyHash,
      rawKey.slice(0, 11),
      args.name,
      JSON.stringify([...args.capabilities]),
      args.maxSensitivity ?? "restricted",
    ],
  );
  await replaceGrants(ctx, id, args.spaceIds, args.sourceAccountIds ?? []);
  return { id, rawKey };
}

/** `models/apiKeys/public.ts` `update`. */
export async function update(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    id: string;
    name?: string;
    capabilities: readonly Capability[];
    spaceIds: readonly string[];
    sourceAccountIds?: readonly string[];
  },
): Promise<void> {
  const { principal } = args;
  if (args.name !== undefined) validateApiKeyName(args.name);
  await validateApiKeyScopes(
    ctx,
    principal,
    args.capabilities,
    args.spaceIds,
    args.sourceAccountIds ?? [],
  );
  const key = await getApiKey(ctx, args.id);
  if (!key || key.userId !== principal.userId || !hasNoOAuthLifecycle(key)) {
    throw new Error("API key not found");
  }
  await exec(
    ctx,
    `UPDATE kith.api_keys SET name = COALESCE($2, name), capabilities = $3::jsonb
       WHERE id = $1`,
    [args.id, args.name ?? null, JSON.stringify([...args.capabilities])],
  );
  await replaceGrants(ctx, args.id, args.spaceIds, args.sourceAccountIds ?? []);
}

/**
 * Change one key's sensitivity ceiling (SENS-1).
 *
 * Its own function rather than a field on `update`, because `update` replaces
 * the whole grant -- name, capabilities and spaces -- and the settings kebab
 * wants to change this one thing without restating the rest.
 *
 * THE SECURITY PROPERTY, and why it is enforced here rather than at the route:
 * a credential must never be able to raise its own ceiling, or the ceiling is
 * decorative. `/api/kith/*` authenticates from the session cookie only and has
 * no bearer path at all today, so the route is already safe -- but "already
 * safe" is a property of one file that a future route could get wrong. A web
 * session's principal has no `credentialId` (see `webPrincipal`), and every
 * API-key and OAuth principal has one, so refusing a principal that carries one
 * is exactly "owner session only", checked where every caller must pass.
 */
export async function setMaxSensitivity(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    id: string;
    maxSensitivity: SensitivityLevel;
  },
): Promise<void> {
  if (args.principal.credentialId !== undefined) {
    throw new IdentityError("API key not found", {
      code: "unauthorized",
      message: "API key not found",
    });
  }
  const key = await getApiKey(ctx, args.id);
  // The same conflation `revoke` uses: someone else's key, a missing key and
  // an in-flight OAuth key are all "not found", so this cannot enumerate keys.
  if (!key || key.userId !== args.principal.userId) {
    throw new Error("API key not found");
  }
  await exec(
    ctx,
    `UPDATE kith.api_keys SET max_sensitivity = $2 WHERE id = $1`,
    [args.id, args.maxSensitivity],
  );
}

/** `models/apiKeys/public.ts` `revoke`. The grant rows cascade with it. */
export async function revoke(
  ctx: IdentityCtx,
  args: { principal: Principal; id: string },
): Promise<void> {
  const key = await getApiKey(ctx, args.id);
  if (
    !key ||
    key.userId !== args.principal.userId ||
    !hasNoOAuthLifecycle(key)
  ) {
    throw new Error("API key not found");
  }
  await deleteApiKey(ctx, args.id);
}

/**
 * The MCP credential check: `lib/mcpAuth.ts` `requireMcpPrincipal`.
 *
 * Same order as today. The key is loaded by hash, an in-flight OAuth key is
 * refused, the user row must still exist, and `last_used_at` is touched only once
 * all of that passed, so a rejected attempt leaves no trace that it was close.
 */
export async function requireMcpPrincipal(
  ctx: IdentityCtx,
  args: { rawKey?: string; keyHash?: string },
): Promise<Principal> {
  const keyHash =
    args.keyHash ??
    (typeof args.rawKey === "string" ? sha256Hex(args.rawKey) : undefined);
  if (typeof keyHash !== "string" || !SHA256_HEX.test(keyHash)) {
    notAuthenticated();
  }
  const key = await getApiKeyByHash(ctx, keyHash);
  if (!key) notAuthenticated();
  if (!hasNoOAuthLifecycle(key)) notAuthenticated();
  if (!(await userExists(ctx, key.userId))) notAuthenticated();
  const principal = principalFromApiKey(key, key.userId);
  if (!(await touchApiKey(ctx, key.id))) notAuthenticated();
  return principal;
}

/**
 * The replacement for `models/apiKeys/mcpAuth.ts` `authenticateKeyHash`.
 *
 * That action existed only so the gateway could mint a JWT from a key hash.
 * Nothing mints a JWT now, so this returns the principal itself and is not
 * exposed as an unauthenticated function; the route calls it.
 *
 * Only a modelled denial becomes `null`. Everything else is rethrown, and the
 * difference is not cosmetic: this function runs inside `withKithTransaction`,
 * `requireMcpPrincipal` writes `last_used_at` on every success, and two
 * concurrent authentications with the same bearer therefore conflict on that one
 * row. A blanket `catch` swallowed the resulting SQLSTATE 40001 before the
 * retry loop above could see it, and the route answered 401 for a perfectly
 * valid key -- the second reviewer of P2-39i2 reproduced one identity and seven
 * nulls from eight concurrent calls. A statement timeout (57014) and a lock
 * timeout (55P03) failed the same way, as would an unreachable database.
 *
 * So the rule is: an authentication failure is a fact about the credential, and
 * nothing else may be dressed up as one. A caller that cannot be told apart from
 * a revoked key is a caller who is told to re-run the OAuth flow over an outage.
 *
 * `IdentityError` is every denial `requireMcpPrincipal` can raise, including the
 * legacy key with no capabilities. That one is an operator problem and stays
 * distinguishable in the log by its message and its typed code, but it is still
 * a fact about the credential, so the client gets the same `null` as everything
 * else. `identityAuthorization.test.mjs` asserts exactly that, which is why
 * `principalFromApiKey` raises an `IdentityError` for it rather than a bare one.
 */
export async function authenticateApiKey(
  ctx: IdentityCtx,
  args: { rawKey?: string; keyHash?: string },
): Promise<{ userId: string; keyId: string; principal: Principal } | null> {
  try {
    const principal = await requireMcpPrincipal(ctx, args);
    return {
      userId: principal.userId,
      keyId: principal.credentialId!,
      principal,
    };
  } catch (error) {
    // `null` rather than a throw, because the caller is an authentication route
    // and every failure it can distinguish is a failure it can leak.
    if (error instanceof IdentityError) return null;
    throw error;
  }
}

export type { ApiKeyRecord, Capability, Principal };
