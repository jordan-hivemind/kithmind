// The port of `models/oauth/*`: the authorization-code exchange for MCP clients.
//
// The flow is unchanged and deliberately awkward, so the shape is worth restating
// before the code. A grant lives on the `api_keys` row itself, in an
// `oauth_lifecycle` of `preparing` then `pending` then gone, which is what makes
// "the key exists but authenticates nothing yet" representable: every credential
// path refuses a key whose lifecycle is not null.
//
//   1. `beginAuthorizationGrant` writes a `preparing` key and hands back a
//      binding seed. The key cannot be used: its lifecycle is set.
//   2. The caller encrypts the code and `finalizeAuthorizationGrant` moves the
//      key to `pending`, checking that the code hash and the binding hash match
//      the seed it issued. A stale nonce or a changed expiry is refused.
//   3. `activateAuthorizationGrant` is the exchange. It clears the lifecycle,
//      which is the moment the key becomes a credential, and writes a receipt
//      keyed by code hash so a replay is detected.
//   4. A replay with a receipt that binds to the same key, user, request and
//      binding hash returns `replayed` and deletes the key. Anything that does
//      not bind exactly is `invalid_grant`.
//
// What changed with the port: the exchange used to arrive as an ES256 JWT the web
// app minted and Convex verified through `auth.config.ts`. Section 1.5 deletes
// that bridge -- there is no second backend to authenticate to -- so
// `requireOAuthExchangeIdentity` now takes the same fields as arguments and runs
// the same checks on them, minus the two (issuer, `oauthPurpose`) that existed
// only to keep two JWT audiences apart. The hash-shape checks, the key/user
// binding and the live-user check all stay, because those are what actually
// authorize the exchange.

import { randomBytes } from "node:crypto";

import { sha256 as sha256Hex } from "../hash.js";
import { KITH_ID, newKithId } from "../ids.js";
import {
  getApiKey,
  requireSpaceAccess,
  userExists,
  webPrincipal,
  hasNoOAuthLifecycle,
  type ApiKeyRecord,
  type Capability,
  type Principal,
} from "./authorization.js";
import {
  validateApiKeyName,
  validateApiKeyScopes,
  generateApiKeyMaterial,
} from "./apiKeys.js";
import { at, exec, row, rows, type IdentityCtx } from "./db.js";
import { errorThrower, hasErrorCode, IdentityError } from "./errors.js";

const GRANT_LIFETIME_MS = 5 * 60 * 1000;
const PREPARATION_LIFETIME_MS = 30 * 1000;
const MAX_LIVE_GRANTS_PER_USER = 20;
const MAX_AUTHORIZATION_CODE_LIFETIME_MS = 10 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{64}$/;
const ENCRYPTED_CODE = /^obac1\.[A-Za-z0-9_-]+$/;

export const OAUTH_ERROR_MESSAGES = {
  not_authenticated: "Sign in to authorize an MCP client.",
  invalid_input: "The OAuth authorization request is invalid.",
  grant_not_found: "The OAuth authorization grant is no longer available.",
  grant_expired: "The OAuth authorization grant has expired.",
  grant_preparing: "The OAuth authorization grant is still being prepared.",
  grant_consumed:
    "Start a fresh authorization request to reconnect this client.",
  grant_limit_reached: "Too many OAuth authorization grants are pending.",
  authorization_revoked: "The selected access is no longer available.",
} as const;

export type OAuthErrorCode = keyof typeof OAUTH_ERROR_MESSAGES;

// Explicitly annotated, not inferred: TypeScript only treats a call as
// never-returning -- and so only narrows what follows it -- when the callee is a
// name with a declared type.
export const oauthError: (code: OAuthErrorCode) => never =
  errorThrower(OAUTH_ERROR_MESSAGES);

/** Whether `error` is one of this module's typed errors. */
export function isOAuthError(error: unknown): boolean {
  return hasErrorCode(error, OAUTH_ERROR_MESSAGES);
}

function invalidGrant(): never {
  throw new IdentityError(
    "Authorization code is invalid or was already used.",
    {
      code: "invalid_grant",
      message: "Authorization code is invalid or was already used.",
    },
  );
}

function invalidOAuthState(): never {
  throw new IdentityError("OAuth authorization state is invalid.", {
    code: "invalid_oauth_state",
    message: "OAuth authorization state is invalid.",
  });
}

/** A `preparing` key with every field that state requires, and none it forbids. */
export function isPreparingOAuthKey(key: ApiKeyRecord): boolean {
  return (
    key.oauthLifecycle === "preparing" &&
    key.oauthRequestHash !== null &&
    key.oauthCodeHash === null &&
    key.oauthBindingHash === null &&
    key.oauthBindingSeedHash !== null &&
    key.oauthEncryptedCode === null &&
    key.oauthGrantExpiresAt !== null &&
    key.oauthPreparationExpiresAt !== null &&
    Number.isSafeInteger(key.oauthGrantExpiresAt) &&
    Number.isSafeInteger(key.oauthPreparationExpiresAt) &&
    key.oauthPreparationNonce !== null &&
    key.oauthGrantExpiresAt > 0 &&
    key.oauthPreparationExpiresAt > 0 &&
    key.oauthPreparationExpiresAt <= key.oauthGrantExpiresAt &&
    HASH.test(key.oauthRequestHash) &&
    HASH.test(key.oauthBindingSeedHash) &&
    HASH.test(key.oauthPreparationNonce)
  );
}

/** A `pending` key: finalized, awaiting the exchange. */
export function isPendingOAuthKey(key: ApiKeyRecord): boolean {
  return (
    key.oauthLifecycle === "pending" &&
    key.oauthRequestHash !== null &&
    key.oauthCodeHash !== null &&
    key.oauthBindingHash !== null &&
    key.oauthBindingSeedHash !== null &&
    key.oauthEncryptedCode !== null &&
    ENCRYPTED_CODE.test(key.oauthEncryptedCode) &&
    key.oauthEncryptedCode.length <= 8192 &&
    key.oauthGrantExpiresAt !== null &&
    Number.isSafeInteger(key.oauthGrantExpiresAt) &&
    key.oauthGrantExpiresAt > 0 &&
    key.oauthPreparationExpiresAt === null &&
    key.oauthPreparationNonce === null &&
    HASH.test(key.oauthRequestHash) &&
    HASH.test(key.oauthCodeHash) &&
    HASH.test(key.oauthBindingHash) &&
    HASH.test(key.oauthBindingSeedHash)
  );
}

function requireBoundedString(
  value: string,
  maximum: number,
  allowEmpty = false,
): void {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.trim()) ||
    value.length > maximum ||
    new TextDecoder().decode(new TextEncoder().encode(value)) !== value
  ) {
    oauthError("invalid_input");
  }
}

export type ConsentArgs = {
  clientId: string;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
  scope: "open-brain";
  state?: string;
  name: string;
  capabilities: readonly Capability[];
  spaceIds: readonly string[];
};

/**
 * The exact bytes a consent decision hashes to.
 *
 * Every field the user was shown is in here and the order is fixed, so the same
 * consent produces the same `requestHash` and a different one cannot be replayed
 * against it. `ingest` is refused outright: an OAuth client may be granted read
 * and write, never the capability that can reach a source account.
 */
export function canonicalConsent(args: ConsentArgs): string {
  requireBoundedString(args.clientId, 8192);
  requireBoundedString(args.redirectUri, 2048);
  requireBoundedString(args.resource, 2048);
  requireBoundedString(args.codeChallenge, 43);
  requireBoundedString(args.state ?? "", 1024, true);
  if (!/^[A-Za-z0-9_-]{43}$/.test(args.codeChallenge)) {
    oauthError("invalid_input");
  }
  if (
    args.capabilities.some((capability) => capability === "ingest") ||
    args.capabilities.length > 2
  ) {
    oauthError("invalid_input");
  }
  return JSON.stringify({
    version: "oauth-consent-v1",
    clientId: args.clientId,
    redirectUri: args.redirectUri,
    resource: args.resource,
    codeChallenge: args.codeChallenge,
    scope: args.scope,
    state: args.state ?? null,
    name: args.name,
    capabilities: [...args.capabilities].sort(),
    spaceIds: [...args.spaceIds].map(String).sort(),
  });
}

function randomNonce(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Re-validates the scopes already written on a grant.
 *
 * Called at every later step rather than once at the start: membership can be
 * removed between consent and exchange, and an authorization that was valid when
 * the user clicked must not complete after it stops being valid.
 */
async function validateStoredScopes(
  ctx: IdentityCtx,
  principal: Principal,
  key: ApiKeyRecord,
): Promise<void> {
  try {
    await validateApiKeyScopes(
      ctx,
      principal,
      key.capabilities ?? [],
      key.spaceIds,
      key.sourceAccountIds,
    );
  } catch {
    oauthError("authorization_revoked");
  }
}

export type BeginResult =
  | {
      status: "issued";
      keyId: string;
      userId: string;
      rawKey: string;
      requestHash: string;
      bindingSeedHash: string;
      preparationNonce: string;
      grantExpiresAt: number;
    }
  | {
      status: "pending";
      keyId: string;
      encryptedCode: string;
      grantExpiresAt: number;
    }
  | { status: "preparing"; retryAfterMs: number }
  | { status: "consumed" };

/** `models/oauth/web.ts` `beginAuthorizationGrant`. */
export async function beginAuthorizationGrant(
  ctx: IdentityCtx,
  args: ConsentArgs & { principal: Principal },
): Promise<BeginResult> {
  const { principal } = args;
  if (
    args.spaceIds.length === 0 ||
    args.spaceIds.length > 100 ||
    new Set(args.spaceIds).size !== args.spaceIds.length
  ) {
    oauthError("invalid_input");
  }
  // The replacement for `db.normalizeId`: the shape check, not an existence
  // check. Whether the space is reachable is `validateApiKeyScopes`' answer.
  const spaceIds = args.spaceIds.map((rawId) => {
    if (
      typeof rawId !== "string" ||
      !rawId.trim() ||
      rawId.length > 128 ||
      !KITH_ID.test(rawId)
    ) {
      oauthError("invalid_input");
    }
    return rawId;
  });
  try {
    validateApiKeyName(args.name);
    await validateApiKeyScopes(ctx, principal, args.capabilities, spaceIds, []);
  } catch (error) {
    // Convex rethrows any `ConvexError` here and converts everything else. A
    // typed error is one the client is meant to see (`invalid_input` from the
    // name check, the read denial from the space check); an untyped one is a
    // scope failure, and the user is told the access is gone rather than why.
    if (error instanceof IdentityError && error.data !== undefined) throw error;
    oauthError("authorization_revoked");
  }
  const requestHash = sha256Hex(canonicalConsent({ ...args, spaceIds }));
  const now = ctx.now;

  const consumed = await rows<{ id: string; expires_at: Date }>(
    ctx,
    `SELECT id, expires_at FROM kith.consumed_oauth_codes
       WHERE user_id = $1 AND request_hash = $2 LIMIT 2`,
    [principal.userId, requestHash],
  );
  if (consumed.length > 1) invalidOAuthState();
  const receipt = consumed[0];
  if (receipt && receipt.expires_at.getTime() > now) {
    return { status: "consumed" };
  }
  if (receipt) {
    await exec(ctx, "DELETE FROM kith.consumed_oauth_codes WHERE id = $1", [
      receipt.id,
    ]);
  }

  const matches = await rows<{ id: string }>(
    ctx,
    `SELECT id FROM kith.api_keys
       WHERE user_id = $1 AND oauth_request_hash = $2 LIMIT 2`,
    [principal.userId, requestHash],
  );
  if (matches.length > 1) invalidOAuthState();
  const existing = matches[0] ? await getApiKey(ctx, matches[0].id) : null;
  if (
    existing &&
    isPendingOAuthKey(existing) &&
    existing.oauthGrantExpiresAt! > now
  ) {
    await validateStoredScopes(ctx, principal, existing);
    return {
      status: "pending",
      keyId: existing.id,
      encryptedCode: existing.oauthEncryptedCode!,
      grantExpiresAt: existing.oauthGrantExpiresAt!,
    };
  }
  if (
    existing &&
    isPreparingOAuthKey(existing) &&
    existing.oauthGrantExpiresAt! > now &&
    existing.oauthPreparationExpiresAt! > now
  ) {
    return {
      status: "preparing",
      retryAfterMs: existing.oauthPreparationExpiresAt! - now,
    };
  }
  if (existing) {
    await exec(ctx, "DELETE FROM kith.api_keys WHERE id = $1", [existing.id]);
  }

  const live = await rows<{ oauth_lifecycle: string }>(
    ctx,
    `SELECT oauth_lifecycle FROM kith.api_keys
       WHERE user_id = $1 AND oauth_lifecycle IS NOT NULL
         AND oauth_grant_expires_at > $2
       LIMIT $3`,
    [principal.userId, at(now), MAX_LIVE_GRANTS_PER_USER + 1],
  );
  if (live.length >= MAX_LIVE_GRANTS_PER_USER) {
    oauthError("grant_limit_reached");
  }

  const { rawKey, keyHash } = generateApiKeyMaterial();
  const grantExpiresAt = now + GRANT_LIFETIME_MS;
  const preparationNonce = randomNonce();
  const keyId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.api_keys
       (id, user_id, key_hash, key_prefix, name, capabilities, oauth_lifecycle,
        oauth_request_hash, oauth_binding_seed_hash, oauth_grant_expires_at,
        oauth_preparation_expires_at, oauth_preparation_nonce)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'preparing', $7, $8, $9, $10, $11)`,
    [
      keyId,
      principal.userId,
      keyHash,
      rawKey.slice(0, 11),
      args.name,
      JSON.stringify([...args.capabilities]),
      requestHash,
      // Replaced below, once the seed can be computed over the key's own id.
      "pending",
      at(grantExpiresAt),
      at(now + PREPARATION_LIFETIME_MS),
      preparationNonce,
    ],
  );
  for (const spaceId of spaceIds) {
    await exec(
      ctx,
      `INSERT INTO kith.api_key_spaces (id, api_key_id, space_id) VALUES ($1, $2, $3)`,
      [newKithId(), keyId, spaceId],
    );
  }
  const bindingSeedHash = sha256Hex(
    JSON.stringify({
      version: "oauth-binding-seed-v1",
      userId: String(principal.userId),
      apiKeyId: String(keyId),
      requestHash,
      keyHash,
      clientId: args.clientId,
      redirectUri: args.redirectUri,
      resource: args.resource,
      codeChallenge: args.codeChallenge,
      scope: args.scope,
    }),
  );
  await exec(
    ctx,
    "UPDATE kith.api_keys SET oauth_binding_seed_hash = $2 WHERE id = $1",
    [keyId, bindingSeedHash],
  );
  return {
    status: "issued",
    keyId,
    userId: principal.userId,
    rawKey,
    requestHash,
    bindingSeedHash,
    preparationNonce,
    grantExpiresAt,
  };
}

/** `models/oauth/web.ts` `finalizeAuthorizationGrant`. */
export async function finalizeAuthorizationGrant(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    keyId: string;
    requestHash: string;
    preparationNonce: string;
    encryptedCode: string;
    codeHash: string;
    bindingHash: string;
    grantExpiresAt: number;
  },
): Promise<void> {
  const { principal } = args;
  if (
    !HASH.test(args.requestHash) ||
    !NONCE.test(args.preparationNonce) ||
    !HASH.test(args.codeHash) ||
    !HASH.test(args.bindingHash) ||
    !ENCRYPTED_CODE.test(args.encryptedCode) ||
    args.encryptedCode.length > 8192
  ) {
    oauthError("invalid_input");
  }
  const key = await getApiKey(ctx, args.keyId);
  if (
    !key ||
    key.userId !== principal.userId ||
    !isPreparingOAuthKey(key) ||
    key.oauthRequestHash !== args.requestHash ||
    key.oauthPreparationNonce !== args.preparationNonce
  ) {
    oauthError("grant_not_found");
  }
  const now = ctx.now;
  if (
    key.oauthGrantExpiresAt! <= now ||
    key.oauthPreparationExpiresAt! <= now ||
    args.grantExpiresAt !== key.oauthGrantExpiresAt
  ) {
    oauthError("grant_expired");
  }
  if (sha256Hex(args.encryptedCode) !== args.codeHash) {
    oauthError("invalid_input");
  }
  const expectedBindingHash = sha256Hex(
    `oauth-binding-v1\0${key.oauthBindingSeedHash}\0${args.codeHash}`,
  );
  if (expectedBindingHash !== args.bindingHash) oauthError("invalid_input");
  await validateStoredScopes(ctx, principal, key);
  await exec(
    ctx,
    `UPDATE kith.api_keys
       SET oauth_lifecycle = 'pending', oauth_code_hash = $2,
           oauth_binding_hash = $3, oauth_encrypted_code = $4,
           oauth_preparation_expires_at = NULL, oauth_preparation_nonce = NULL
       WHERE id = $1`,
    [key.id, args.codeHash, args.bindingHash, args.encryptedCode],
  );
}

/** `models/oauth/web.ts` `abandonAuthorizationGrant`. Silent by design. */
export async function abandonAuthorizationGrant(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    keyId: string;
    requestHash: string;
    preparationNonce: string;
  },
): Promise<void> {
  const key = await getApiKey(ctx, args.keyId).catch(() => null);
  if (
    key &&
    key.userId === args.principal.userId &&
    isPreparingOAuthKey(key) &&
    key.oauthRequestHash === args.requestHash &&
    key.oauthPreparationNonce === args.preparationNonce
  ) {
    await exec(ctx, "DELETE FROM kith.api_keys WHERE id = $1", [key.id]);
  }
}

export type OAuthExchangeIdentity = {
  userId: string;
  key: ApiKeyRecord;
  codeHash: string;
  keyHash: string;
  bindingHash: string;
  requestHash: string;
};

/**
 * `lib/mcpAuth.ts` `requireOAuthExchangeIdentity`, as arguments rather than a JWT.
 *
 * The two dropped checks were `identity.issuer === MCP_JWT_ISSUER` and
 * `oauthPurpose === "authorization_code_exchange"`, which existed to keep the
 * exchange audience apart from the ordinary MCP audience. There is no token and no
 * audience now; the token endpoint calls this directly. Everything that actually
 * authorizes the exchange stays: four hash shapes, the key exists, the key belongs
 * to the named user, and the user row is still there.
 */
export async function requireOAuthExchangeIdentity(
  ctx: IdentityCtx,
  args: {
    apiKeyId: string;
    userId: string;
    codeHash: string;
    keyHash: string;
    bindingHash: string;
    requestHash: string;
  },
): Promise<OAuthExchangeIdentity> {
  if (
    typeof args.apiKeyId !== "string" ||
    typeof args.userId !== "string" ||
    !KITH_ID.test(args.apiKeyId) ||
    !KITH_ID.test(args.userId) ||
    !HASH.test(args.codeHash) ||
    !HASH.test(args.keyHash) ||
    !HASH.test(args.bindingHash) ||
    !HASH.test(args.requestHash)
  ) {
    throw new IdentityError("Not authenticated");
  }
  const key = await getApiKey(ctx, args.apiKeyId);
  if (
    !key ||
    key.userId !== args.userId ||
    !(await userExists(ctx, args.userId))
  ) {
    throw new IdentityError("Not authenticated");
  }
  return {
    userId: args.userId,
    key,
    codeHash: args.codeHash,
    keyHash: args.keyHash,
    bindingHash: args.bindingHash,
    requestHash: args.requestHash,
  };
}

/** `models/oauth/mcpMutations.ts` `activateAuthorizationGrant`. */
export async function activateAuthorizationGrant(
  ctx: IdentityCtx,
  args: {
    apiKeyId: string;
    userId: string;
    codeHash: string;
    keyHash: string;
    bindingHash: string;
    requestHash: string;
    expiresAt: number;
  },
): Promise<{ status: "activated" | "replayed" }> {
  const exchange = await requireOAuthExchangeIdentity(ctx, args);
  const now = ctx.now;
  if (
    !HASH.test(args.codeHash) ||
    !HASH.test(args.keyHash) ||
    !HASH.test(args.bindingHash) ||
    !HASH.test(args.requestHash) ||
    args.codeHash !== exchange.codeHash ||
    args.keyHash !== exchange.keyHash ||
    args.keyHash !== exchange.key.keyHash ||
    args.bindingHash !== exchange.bindingHash ||
    args.requestHash !== exchange.requestHash ||
    !Number.isSafeInteger(args.expiresAt) ||
    args.expiresAt <= now ||
    args.expiresAt > now + MAX_AUTHORIZATION_CODE_LIFETIME_MS
  ) {
    invalidGrant();
  }

  const existing = await rows<{
    id: string;
    api_key_id: string | null;
    user_id: string;
    request_hash: string | null;
    binding_hash: string | null;
    key_hash: string | null;
  }>(
    ctx,
    `SELECT id, api_key_id, user_id, request_hash, binding_hash, key_hash
       FROM kith.consumed_oauth_codes WHERE code_hash = $1 LIMIT 2`,
    [args.codeHash],
  );
  if (existing.length > 1) invalidGrant();
  const receipt = existing[0];
  if (receipt) {
    const safelyBound =
      receipt.api_key_id === exchange.key.id &&
      receipt.user_id === exchange.userId &&
      receipt.request_hash === args.requestHash &&
      receipt.binding_hash === args.bindingHash &&
      receipt.key_hash === exchange.key.keyHash;
    if (!safelyBound) invalidGrant();
    // A second exchange of the same code means the code leaked. The key that was
    // activated by the first exchange is deleted rather than left live.
    if (hasNoOAuthLifecycle(exchange.key)) {
      await exec(ctx, "DELETE FROM kith.api_keys WHERE id = $1", [
        exchange.key.id,
      ]);
    }
    return { status: "replayed" };
  }

  const key = exchange.key;
  if (
    !isPendingOAuthKey(key) ||
    key.oauthCodeHash !== args.codeHash ||
    key.oauthBindingHash !== args.bindingHash ||
    key.oauthRequestHash !== args.requestHash ||
    key.oauthGrantExpiresAt !== args.expiresAt ||
    key.oauthGrantExpiresAt <= now ||
    key.capabilities === null ||
    key.capabilities.length === 0 ||
    key.capabilities.length > 2 ||
    key.spaceIds.length === 0 ||
    key.spaceIds.length > 100 ||
    key.sourceAccountIds.length > 0
  ) {
    invalidGrant();
  }
  if (
    key.capabilities!.some(
      (capability) => capability !== "read" && capability !== "write",
    ) ||
    new Set(key.capabilities!).size !== key.capabilities!.length ||
    new Set(key.spaceIds).size !== key.spaceIds.length
  ) {
    invalidGrant();
  }
  // The user's own authority, not the half-built key's: the question is whether
  // the person can still read every space the grant names, right now.
  const principal = webPrincipal(exchange.userId);
  try {
    for (const spaceId of key.spaceIds) {
      await requireSpaceAccess(ctx, principal, spaceId, "read");
    }
  } catch {
    invalidGrant();
  }

  await exec(
    ctx,
    `INSERT INTO kith.consumed_oauth_codes
       (id, user_id, api_key_id, request_hash, code_hash, binding_hash, key_hash,
        expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      newKithId(),
      exchange.userId,
      key.id,
      args.requestHash,
      args.codeHash,
      args.bindingHash,
      key.keyHash,
      at(args.expiresAt),
    ],
  );
  await exec(
    ctx,
    `UPDATE kith.api_keys
       SET oauth_lifecycle = NULL, oauth_request_hash = NULL,
           oauth_code_hash = NULL, oauth_binding_hash = NULL,
           oauth_binding_seed_hash = NULL, oauth_encrypted_code = NULL,
           oauth_grant_expires_at = NULL, oauth_preparation_expires_at = NULL,
           oauth_preparation_nonce = NULL, last_used_at = $2
       WHERE id = $1`,
    [key.id, at(now)],
  );
  return { status: "activated" };
}

/** `models/oauth/cleanup.ts` `removeExpired`. */
export async function removeExpired(
  ctx: IdentityCtx,
  args: { limit?: number } = {},
): Promise<{ deleted: number; hasMore: boolean }> {
  const limit = args.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("OAuth cleanup limit is invalid");
  }
  const now = at(ctx.now);
  let deleted = 0;
  let hasMore = false;

  for (const lifecycle of ["pending", "preparing"] as const) {
    if (deleted >= limit) break;
    const remaining = limit - deleted;
    const doomed = await rows<{ id: string }>(
      ctx,
      `SELECT id FROM kith.api_keys
         WHERE oauth_lifecycle = $1 AND oauth_grant_expires_at < $2
         LIMIT $3`,
      [lifecycle, now, remaining + 1],
    );
    hasMore ||= doomed.length > remaining;
    for (const { id } of doomed.slice(0, remaining)) {
      await exec(ctx, "DELETE FROM kith.api_keys WHERE id = $1", [id]);
      deleted += 1;
    }
  }

  if (deleted < limit) {
    const remaining = limit - deleted;
    const receipts = await rows<{ id: string }>(
      ctx,
      `SELECT id FROM kith.consumed_oauth_codes WHERE expires_at < $1 LIMIT $2`,
      [now, remaining + 1],
    );
    hasMore ||= receipts.length > remaining;
    for (const { id } of receipts.slice(0, remaining)) {
      await exec(ctx, "DELETE FROM kith.consumed_oauth_codes WHERE id = $1", [
        id,
      ]);
      deleted += 1;
    }
  }
  return { deleted, hasMore: hasMore || deleted === limit };
}

/**
 * `models/apiKeys/migrations.ts` `auditOAuthLifecycle`, as a single scan.
 *
 * The Convex version paged because a mutation had a read budget; there is no such
 * budget here, so it takes a bound instead and reports what it found.
 */
export async function auditOAuthLifecycle(
  ctx: IdentityCtx,
  args: { limit?: number } = {},
): Promise<{ examined: number; invalid: { id: string; reason: string }[] }> {
  const limit = Math.min(Math.max(args.limit ?? 500, 1), 5000);
  const ids = await rows<{ id: string }>(
    ctx,
    "SELECT id FROM kith.api_keys ORDER BY created_at, id LIMIT $1",
    [limit],
  );
  const invalid: { id: string; reason: string }[] = [];
  for (const { id } of ids) {
    const key = await getApiKey(ctx, id);
    if (!key) continue;
    const structurallyValid =
      hasNoOAuthLifecycle(key) ||
      isPreparingOAuthKey(key) ||
      isPendingOAuthKey(key);
    const hashesValid = [
      key.oauthRequestHash,
      key.oauthCodeHash,
      key.oauthBindingHash,
      key.oauthBindingSeedHash,
      key.oauthPreparationNonce,
    ]
      .filter((value): value is string => value !== null)
      .every((value) => HASH.test(value));
    const encryptedCodeValid =
      key.oauthEncryptedCode === null ||
      (key.oauthEncryptedCode.startsWith("obac1.") &&
        key.oauthEncryptedCode.length <= 8192);
    if (!structurallyValid || !hashesValid || !encryptedCodeValid) {
      invalid.push({ id, reason: "invalid OAuth lifecycle fields" });
    }
  }
  return { examined: ids.length, invalid };
}

/** One row read, exported so a caller can check a grant without a wide select. */
export async function grantLifecycle(
  ctx: IdentityCtx,
  keyId: string,
): Promise<"preparing" | "pending" | null> {
  const record = await row<{ oauth_lifecycle: string | null }>(
    ctx,
    "SELECT oauth_lifecycle FROM kith.api_keys WHERE id = $1",
    [keyId],
  );
  return (record?.oauth_lifecycle as "preparing" | "pending") ?? null;
}
