// The port of `packages/convex/convex/lib/spaces.ts`.
//
// This file is the boundary. Section 2.5 defers row level security, so nothing
// below the typed service surface re-checks a space; every read and write in the
// port either goes through `requireSpaceAccess` for one space or through
// `getAuthorizedReadSpaceIds` plus `spacePredicate` for a set. The Convex
// semantics are reproduced decision for decision, including the ones that look
// redundant, because each one is a denial that a test asserts:
//
//   * A credential is reloaded from the database before every decision. A
//     `Principal` is a snapshot and a snapshot can outlive the grant it
//     describes; `reloadPrincipal` is what makes a revoked key lose access
//     within one request rather than at the end of a session.
//   * The user row is re-read too, so a deleted user's retained credential is
//     refused even though the key row is still there.
//   * Capability and space grant are intersected with live membership. A key
//     scoped to a space the user has since left grants nothing.
//   * Exactly one membership row must match. Zero denies and two also deny: a
//     duplicate membership is a data defect, and a defect must not be resolved
//     in the caller's favour.
//   * The space row is loaded last and its absence denies, so a membership that
//     outlived its space is not access.
//   * Every failure is the same words. `Space not found` whether the space is
//     missing, the membership is gone, the role is too low or the credential was
//     never granted it, so a caller cannot enumerate spaces by watching which
//     error comes back.

import { assertKithId, newKithId } from "../ids.js";
import { spacePredicate } from "../spaces.js";
import { at, exec, ms, row, rows, type IdentityCtx } from "./db.js";
import {
  notAuthenticated,
  rethrowSpaceReadError,
  spaceNotFound,
  spaceReadNotFound,
} from "./errors.js";

export type Capability = "read" | "write" | "ingest";
export type SpaceOperation = Capability;
export type SpaceRole = "owner" | "editor" | "reader";

/**
 * An authorization snapshot. Callers must reload a `PrincipalRef` before a later
 * database operation instead of trusting this snapshot after a key or role
 * change; every function here that takes one does exactly that.
 */
export type Principal = {
  userId: string;
  credentialId?: string;
  capabilities: readonly Capability[];
  credentialSpaceIds?: readonly string[];
  credentialSourceAccountIds?: readonly string[];
};

export type PrincipalRef = {
  userId: string;
  credentialId?: string;
};

export type SpaceMember = {
  id: string;
  spaceId: string;
  userId: string;
  role: SpaceRole;
  personEntityId: string | null;
};

export type Space = {
  id: string;
  kind: "personal" | "shared";
  name: string;
  createdBy: string;
  createdAt: number;
};

const ALL_CAPABILITIES: readonly Capability[] = ["read", "write", "ingest"];
const MAX_AUTHORIZED_SPACES = 100;

const CAPABILITIES = new Set<string>(ALL_CAPABILITIES);
const ROLES = new Set<string>(["owner", "editor", "reader"]);

/** A web session's principal: the user's own authority, unnarrowed. */
export function webPrincipal(userId: string): Principal {
  return { userId, capabilities: ALL_CAPABILITIES };
}

export function principalRef(principal: Principal): PrincipalRef {
  return {
    userId: principal.userId,
    ...(principal.credentialId ? { credentialId: principal.credentialId } : {}),
  };
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

type MemberRow = {
  id: string;
  space_id: string;
  user_id: string;
  role: string;
  person_entity_id: string | null;
};

function toMember(record: MemberRow): SpaceMember {
  // A role outside the three is not a role. The column has a CHECK, so this can
  // only fire on a row written before that constraint existed, and denying is
  // the only safe reading of it.
  if (!ROLES.has(record.role)) spaceNotFound();
  return {
    id: record.id,
    spaceId: record.space_id,
    userId: record.user_id,
    role: record.role as SpaceRole,
    personEntityId: record.person_entity_id,
  };
}

/** Whether the user row still exists. Every credential check starts here. */
export async function userExists(
  ctx: IdentityCtx,
  userId: string,
): Promise<boolean> {
  return (
    (await row<{ id: string }>(ctx, "SELECT id FROM kith.users WHERE id = $1", [
      assertKithId(userId, "invalid_user_id"),
    ])) !== null
  );
}

export type ApiKeyRecord = {
  id: string;
  userId: string;
  keyHash: string;
  keyPrefix: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** null is a legacy unmigrated key, which is refused, not widened. */
  capabilities: readonly Capability[] | null;
  spaceIds: readonly string[];
  sourceAccountIds: readonly string[];
  oauthLifecycle: "preparing" | "pending" | null;
  oauthRequestHash: string | null;
  oauthCodeHash: string | null;
  oauthBindingHash: string | null;
  oauthBindingSeedHash: string | null;
  oauthEncryptedCode: string | null;
  oauthGrantExpiresAt: number | null;
  oauthPreparationExpiresAt: number | null;
  oauthPreparationNonce: string | null;
};

type ApiKeyRow = {
  id: string;
  user_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
  capabilities: unknown;
  space_ids: string[] | null;
  source_account_ids: string[] | null;
  oauth_lifecycle: string | null;
  oauth_request_hash: string | null;
  oauth_code_hash: string | null;
  oauth_binding_hash: string | null;
  oauth_binding_seed_hash: string | null;
  oauth_encrypted_code: string | null;
  oauth_grant_expires_at: Date | null;
  oauth_preparation_expires_at: Date | null;
  oauth_preparation_nonce: string | null;
};

/**
 * `apiKeys` plus its two grant tables, as one row.
 *
 * The grants are child tables here rather than the arrays Convex held, so they
 * are aggregated back into arrays in SQL. `ORDER BY` inside the aggregate keeps
 * the value stable across reads, which matters because it is hashed into the
 * OAuth consent record.
 *
 * The `::text` casts are load bearing. These columns are the `kith.kith_id`
 * domain, and an array of a domain type comes back from the driver as the raw
 * `{a,b}` literal rather than a parsed array, because the driver has no parser
 * registered for that OID. A grant list that is silently a string instead of an
 * array is the worst possible failure here: `includes` on it still returns a
 * boolean, so the space check would quietly answer from substrings.
 */
const API_KEY_SELECT = `
  SELECT k.id, k.user_id, k.key_hash, k.key_prefix, k.name, k.created_at,
         k.last_used_at, k.capabilities,
         (SELECT array_agg(s.space_id::text ORDER BY s.space_id)
            FROM kith.api_key_spaces s WHERE s.api_key_id = k.id) AS space_ids,
         (SELECT array_agg(a.source_account_id::text ORDER BY a.source_account_id)
            FROM kith.api_key_source_accounts a WHERE a.api_key_id = k.id)
           AS source_account_ids,
         k.oauth_lifecycle, k.oauth_request_hash, k.oauth_code_hash,
         k.oauth_binding_hash, k.oauth_binding_seed_hash, k.oauth_encrypted_code,
         k.oauth_grant_expires_at, k.oauth_preparation_expires_at,
         k.oauth_preparation_nonce
    FROM kith.api_keys k`;

export function toApiKey(record: ApiKeyRow): ApiKeyRecord {
  // `capabilities` is jsonb and may be null (legacy) but must otherwise be an
  // array of the three known strings. Anything else is refused rather than
  // filtered: a capability this build does not recognise is not a capability it
  // may drop and carry on.
  let capabilities: Capability[] | null = null;
  if (record.capabilities !== null && record.capabilities !== undefined) {
    if (
      !Array.isArray(record.capabilities) ||
      record.capabilities.some((value) => !CAPABILITIES.has(value as string))
    ) {
      notAuthenticated();
    }
    capabilities = record.capabilities as Capability[];
  }
  // The guard for the `::text` casts above. A grant list that arrived as
  // anything but an array or null is refused rather than used, because
  // `includes` on a string answers from substrings and would widen the grant.
  for (const grants of [record.space_ids, record.source_account_ids]) {
    if (grants !== null && !Array.isArray(grants)) notAuthenticated();
  }
  return {
    id: record.id,
    userId: record.user_id,
    keyHash: record.key_hash,
    keyPrefix: record.key_prefix,
    name: record.name,
    createdAt: ms(record.created_at)!,
    lastUsedAt: ms(record.last_used_at),
    capabilities,
    spaceIds: record.space_ids ?? [],
    sourceAccountIds: record.source_account_ids ?? [],
    oauthLifecycle: (record.oauth_lifecycle as "preparing" | "pending") ?? null,
    oauthRequestHash: record.oauth_request_hash,
    oauthCodeHash: record.oauth_code_hash,
    oauthBindingHash: record.oauth_binding_hash,
    oauthBindingSeedHash: record.oauth_binding_seed_hash,
    oauthEncryptedCode: record.oauth_encrypted_code,
    oauthGrantExpiresAt: ms(record.oauth_grant_expires_at),
    oauthPreparationExpiresAt: ms(record.oauth_preparation_expires_at),
    oauthPreparationNonce: record.oauth_preparation_nonce,
  };
}

/** One key by id, grants included, or null. */
export async function getApiKey(
  ctx: IdentityCtx,
  id: string,
): Promise<ApiKeyRecord | null> {
  const record = await row<ApiKeyRow>(
    ctx,
    `${API_KEY_SELECT} WHERE k.id = $1`,
    [assertKithId(id, "invalid_api_key_id")],
  );
  return record ? toApiKey(record) : null;
}

/** One key by the hash of the presented secret, grants included, or null. */
export async function getApiKeyByHash(
  ctx: IdentityCtx,
  keyHash: string,
): Promise<ApiKeyRecord | null> {
  if (!/^[0-9a-f]{64}$/.test(keyHash)) return null;
  const record = await row<ApiKeyRow>(
    ctx,
    `${API_KEY_SELECT} WHERE k.key_hash = $1`,
    [keyHash],
  );
  return record ? toApiKey(record) : null;
}

/** A key with no OAuth lifecycle fields at all: an ordinary, usable key. */
export function hasNoOAuthLifecycle(key: ApiKeyRecord): boolean {
  return (
    key.oauthLifecycle === null &&
    key.oauthRequestHash === null &&
    key.oauthCodeHash === null &&
    key.oauthBindingHash === null &&
    key.oauthBindingSeedHash === null &&
    key.oauthEncryptedCode === null &&
    key.oauthGrantExpiresAt === null &&
    key.oauthPreparationExpiresAt === null &&
    key.oauthPreparationNonce === null
  );
}

/**
 * The principal a credential grants.
 *
 * An in-flight OAuth key is not a credential: it exists so a code can be
 * exchanged for it, and until that exchange completes it authenticates nothing.
 * A key with no capabilities is a legacy row and is refused with a distinguishable
 * message, because it is an operator problem rather than an authentication one.
 */
export function principalFromApiKey(
  key: ApiKeyRecord,
  expectedUserId?: string,
): Principal {
  if (expectedUserId !== undefined && key.userId !== expectedUserId) {
    notAuthenticated();
  }
  if (!hasNoOAuthLifecycle(key)) notAuthenticated();
  if (key.capabilities === null) {
    throw new Error("API key migration required");
  }
  return {
    userId: key.userId,
    credentialId: key.id,
    capabilities: unique(key.capabilities),
    credentialSpaceIds: unique(key.spaceIds),
    credentialSourceAccountIds: unique(key.sourceAccountIds),
  };
}

/** Reloads mutable API-key grants for a final query or mutation. */
export async function reloadPrincipal(
  ctx: IdentityCtx,
  ref: PrincipalRef,
): Promise<Principal> {
  if (!(await userExists(ctx, ref.userId))) notAuthenticated();
  if (!ref.credentialId) return webPrincipal(ref.userId);
  const key = await getApiKey(ctx, ref.credentialId);
  if (!key) notAuthenticated();
  return principalFromApiKey(key, ref.userId);
}

function acceptsRole(role: SpaceRole, operation: SpaceOperation): boolean {
  return operation === "read" || role === "owner" || role === "editor";
}

function hasCredentialGrant(
  principal: Principal,
  spaceId: string,
  operation: SpaceOperation,
): boolean {
  if (!principal.capabilities.includes(operation)) return false;
  return (
    principal.credentialSpaceIds === undefined ||
    principal.credentialSpaceIds.includes(spaceId)
  );
}

async function currentPrincipal(
  ctx: IdentityCtx,
  principalOrRef: Principal | PrincipalRef,
): Promise<Principal> {
  return await reloadPrincipal(
    ctx,
    "capabilities" in principalOrRef
      ? principalRef(principalOrRef)
      : principalOrRef,
  );
}

/** One space by id, or null. */
export async function getSpace(
  ctx: IdentityCtx,
  spaceId: string,
): Promise<Space | null> {
  const record = await row<{
    id: string;
    kind: string;
    name: string;
    created_by: string;
    created_at: Date;
  }>(
    ctx,
    "SELECT id, kind, name, created_by, created_at FROM kith.spaces WHERE id = $1",
    [assertKithId(spaceId, "invalid_space_id")],
  );
  if (!record) return null;
  if (record.kind !== "personal" && record.kind !== "shared") return null;
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    createdBy: record.created_by,
    createdAt: ms(record.created_at)!,
  };
}

/**
 * Enforces the user's current membership and, for API keys, the current
 * capability and exact space grant. All failures use one non-enumerating error
 * shape.
 */
export async function requireSpaceAccess(
  ctx: IdentityCtx,
  principalOrRef: Principal | PrincipalRef,
  spaceId: string,
  operation: SpaceOperation,
): Promise<SpaceMember> {
  const principal = await currentPrincipal(ctx, principalOrRef);
  if (!hasCredentialGrant(principal, spaceId, operation)) spaceNotFound();

  // Two rows, not one: the second row is what tells a duplicate membership from
  // a single one, and a duplicate must deny rather than pick a winner.
  const memberships = (
    await rows<MemberRow>(
      ctx,
      `SELECT id, space_id, user_id, role, person_entity_id
         FROM kith.space_members WHERE space_id = $1 AND user_id = $2 LIMIT 2`,
      [
        assertKithId(spaceId, "invalid_space_id"),
        assertKithId(principal.userId, "invalid_user_id"),
      ],
    )
  ).map(toMember);
  if (
    memberships.length !== 1 ||
    !acceptsRole(memberships[0]!.role, operation)
  ) {
    spaceNotFound();
  }

  if (!(await getSpace(ctx, spaceId))) spaceNotFound();
  return memberships[0]!;
}

/**
 * Returns all readable spaces, or validates and de-duplicates an explicit
 * filter. Explicit inaccessible and unknown ids are deliberately identical.
 */
export async function getAuthorizedReadSpaceIds(
  ctx: IdentityCtx,
  principalOrRef: Principal | PrincipalRef,
  explicitSpaceIds?: readonly string[],
): Promise<string[]> {
  const principal = await currentPrincipal(ctx, principalOrRef);
  if (!principal.capabilities.includes("read")) spaceReadNotFound();

  if (explicitSpaceIds && explicitSpaceIds.length > 0) {
    if (explicitSpaceIds.length > MAX_AUTHORIZED_SPACES) {
      throw new Error("Space filter is too large");
    }
    const requested = unique(explicitSpaceIds);
    try {
      for (const spaceId of requested) {
        await requireSpaceAccess(ctx, principal, spaceId, "read");
      }
    } catch (error) {
      rethrowSpaceReadError(error);
    }
    return requested;
  }

  const memberships = await rows<{ space_id: string }>(
    ctx,
    `SELECT space_id FROM kith.space_members WHERE user_id = $1 LIMIT $2`,
    [
      assertKithId(principal.userId, "invalid_user_id"),
      MAX_AUTHORIZED_SPACES + 1,
    ],
  );
  if (memberships.length > MAX_AUTHORIZED_SPACES) {
    throw new Error("Too many space memberships");
  }
  const scoped = principal.credentialSpaceIds
    ? new Set(principal.credentialSpaceIds)
    : undefined;
  const membershipCounts = new Map<string, number>();
  for (const membership of memberships) {
    membershipCounts.set(
      membership.space_id,
      (membershipCounts.get(membership.space_id) ?? 0) + 1,
    );
  }
  const ids = [...membershipCounts]
    .filter(
      ([spaceId, count]) =>
        count === 1 && (scoped === undefined || scoped.has(spaceId)),
    )
    .map(([spaceId]) => spaceId);
  const authorized: string[] = [];
  for (const spaceId of ids) {
    try {
      await requireSpaceAccess(ctx, principal, spaceId, "read");
      authorized.push(spaceId);
    } catch {
      // A space this principal cannot read is absent from the result, not an
      // error: the caller asked for what it may read.
    }
  }
  return authorized;
}

/**
 * The `space_id = ANY($n)` predicate for a principal's readable spaces.
 *
 * The pairing the plan's section 2.5 asks for, in one call: resolve the
 * authorized set once per request, then carry it on every statement. An empty
 * set throws rather than returning a predicate that matches nothing, so a
 * caller cannot mistake "authorized for no space" for "no rows".
 */
export async function authorizedSpacePredicate(
  ctx: IdentityCtx,
  principalOrRef: Principal | PrincipalRef,
  parameterIndex: number,
  options: { explicitSpaceIds?: readonly string[]; column?: string } = {},
): Promise<{ sql: string; value: readonly string[] }> {
  const spaceIds = await getAuthorizedReadSpaceIds(
    ctx,
    principalOrRef,
    options.explicitSpaceIds,
  );
  if (spaceIds.length === 0) spaceReadNotFound();
  return spacePredicate(spaceIds, parameterIndex, options.column);
}

export type PersonalSpaceInspection = {
  personalSpace: Space | null;
  membership: SpaceMember | null;
  settings: {
    id: string;
    personalSpaceId: string;
    defaultWriteSpaceId: string | null;
  } | null;
  issues: string[];
};

/**
 * Reads a user's personal-space records without assuming they are well formed.
 * Migration inputs may contain duplicates, so diagnostics stay readable instead
 * of throwing before an operator can identify the rows.
 */
export async function inspectPersonalSpace(
  ctx: IdentityCtx,
  userId: string,
): Promise<PersonalSpaceInspection> {
  const id = assertKithId(userId, "invalid_user_id");
  const personalSpaces = await rows<{
    id: string;
    kind: string;
    name: string;
    created_by: string;
    created_at: Date;
  }>(
    ctx,
    `SELECT id, kind, name, created_by, created_at FROM kith.spaces
      WHERE created_by = $1 AND kind = 'personal' LIMIT 2`,
    [id],
  );
  const settingsRows = await rows<{
    id: string;
    personal_space_id: string;
    default_write_space_id: string | null;
  }>(
    ctx,
    `SELECT id, personal_space_id, default_write_space_id
       FROM kith.user_space_settings WHERE user_id = $1 LIMIT 2`,
    [id],
  );

  const issues: string[] = [];
  if (personalSpaces.length > 1) issues.push("duplicate personal spaces");
  if (settingsRows.length > 1) issues.push("duplicate user space settings");

  const first = personalSpaces.length === 1 ? personalSpaces[0]! : null;
  const personalSpace: Space | null = first
    ? {
        id: first.id,
        kind: first.kind as "personal" | "shared",
        name: first.name,
        createdBy: first.created_by,
        createdAt: ms(first.created_at)!,
      }
    : null;
  const settingsRecord = settingsRows.length === 1 ? settingsRows[0]! : null;
  const settings = settingsRecord
    ? {
        id: settingsRecord.id,
        personalSpaceId: settingsRecord.personal_space_id,
        defaultWriteSpaceId: settingsRecord.default_write_space_id,
      }
    : null;

  if (!personalSpace) {
    if (settings) issues.push("settings reference a missing personal space");
    return { personalSpace, membership: null, settings, issues };
  }

  if (settings && settings.personalSpaceId !== personalSpace.id) {
    issues.push("settings reference a foreign personal space");
  }

  const ownMemberships = await rows<MemberRow>(
    ctx,
    `SELECT id, space_id, user_id, role, person_entity_id FROM kith.space_members
      WHERE space_id = $1 AND user_id = $2 LIMIT 2`,
    [personalSpace.id, id],
  );
  const allMemberships = await rows<MemberRow>(
    ctx,
    `SELECT id, space_id, user_id, role, person_entity_id FROM kith.space_members
      WHERE space_id = $1 LIMIT 2`,
    [personalSpace.id],
  );

  if (ownMemberships.length > 1) {
    issues.push("duplicate personal-space memberships");
  }
  if (allMemberships.some((member) => member.user_id !== id)) {
    issues.push("personal space has a foreign member");
  } else if (allMemberships.length > 1) {
    issues.push("personal space has duplicate memberships");
  }

  const membership =
    ownMemberships.length === 1 ? toMember(ownMemberships[0]!) : null;
  if (membership && membership.role !== "owner") {
    issues.push("personal-space membership is not owner");
  }

  if (membership?.personEntityId) {
    // `kith.entities` is P2-39h's domain, but the column that points into it is
    // this row's, so the check that a personal space's person link is the
    // member's own person and not someone else's is made here.
    const person = await personEntity(ctx, membership.personEntityId);
    if (!person) {
      issues.push("personal-space member links a missing person entity");
    } else if (
      person.kind !== "person" ||
      person.userId !== id ||
      (person.spaceId !== null && person.spaceId !== personalSpace.id)
    ) {
      issues.push("personal-space member links a foreign person entity");
    }
  }

  return { personalSpace, membership, settings, issues };
}

/** One entity row. `kith.entities` is P2-39h's table; only this column reads it. */
async function personEntity(
  ctx: IdentityCtx,
  entityId: string,
): Promise<{
  kind: string;
  userId: string | null;
  spaceId: string | null;
} | null> {
  const record = await row<{
    kind: string | null;
    user_id: string | null;
    space_id: string | null;
  }>(ctx, "SELECT kind, user_id, space_id FROM kith.entities WHERE id = $1", [
    assertKithId(entityId, "invalid_entity_id"),
  ]);
  return record
    ? {
        kind: record.kind ?? "",
        userId: record.user_id,
        spaceId: record.space_id,
      }
    : null;
}

export function isPersonalSpaceReady(
  inspection: PersonalSpaceInspection,
): boolean {
  return (
    inspection.issues.length === 0 &&
    inspection.personalSpace !== null &&
    inspection.membership?.role === "owner" &&
    inspection.settings?.personalSpaceId === inspection.personalSpace.id
  );
}

export async function insertMissingPersonalSpaceRecords(
  ctx: IdentityCtx,
  userId: string,
  inspection: PersonalSpaceInspection,
): Promise<string> {
  let personalSpaceId = inspection.personalSpace?.id;
  if (!personalSpaceId) {
    personalSpaceId = newKithId();
    await exec(
      ctx,
      `INSERT INTO kith.spaces (id, kind, name, created_by)
         VALUES ($1, 'personal', 'Personal', $2)`,
      [personalSpaceId, userId],
    );
  }
  if (!inspection.membership) {
    await exec(
      ctx,
      `INSERT INTO kith.space_members (id, space_id, user_id, role)
         VALUES ($1, $2, $3, 'owner')`,
      [newKithId(), personalSpaceId, userId],
    );
  }
  if (!inspection.settings) {
    await exec(
      ctx,
      `INSERT INTO kith.user_space_settings (id, user_id, personal_space_id)
         VALUES ($1, $2, $3)`,
      [newKithId(), userId, personalSpaceId],
    );
  }
  return personalSpaceId;
}

/** Creates a user's personal space, membership, and settings atomically. */
export async function ensurePersonalSpace(
  ctx: IdentityCtx,
  userId: string,
): Promise<string> {
  if (!(await userExists(ctx, userId))) notAuthenticated();
  const inspection = await inspectPersonalSpace(ctx, userId);
  if (inspection.issues.length > 0) {
    throw new Error(
      `Personal space is invalid: ${inspection.issues.join("; ")}`,
    );
  }
  return await insertMissingPersonalSpaceRecords(ctx, userId, inspection);
}

/** Resolves explicit, configured-default, then personal write destination. */
export async function resolveWriteSpace(
  ctx: IdentityCtx,
  principalOrRef: Principal | PrincipalRef,
  explicitSpaceId?: string,
): Promise<string> {
  const principal = await currentPrincipal(ctx, principalOrRef);
  const personalSpaceId = await ensurePersonalSpace(ctx, principal.userId);

  if (explicitSpaceId) {
    await requireSpaceAccess(ctx, principal, explicitSpaceId, "write");
    return explicitSpaceId;
  }

  const settings = await row<{ default_write_space_id: string | null }>(
    ctx,
    "SELECT default_write_space_id FROM kith.user_space_settings WHERE user_id = $1",
    [principal.userId],
  );
  const configured = settings?.default_write_space_id;
  if (configured) {
    try {
      await requireSpaceAccess(ctx, principal, configured, "write");
    } catch {
      // Named rather than silently falling back to the personal space: a write
      // that lands somewhere the caller did not configure is worse than a
      // refusal it can see.
      throw new Error("Default write space is not available");
    }
    return configured;
  }

  await requireSpaceAccess(ctx, principal, personalSpaceId, "write");
  return personalSpaceId;
}

/** Touches `last_used_at`. Used by the MCP authenticator, as Convex does. */
export async function touchApiKey(
  ctx: IdentityCtx,
  id: string,
): Promise<boolean> {
  const key = await getApiKey(ctx, id);
  if (
    !key ||
    !hasNoOAuthLifecycle(key) ||
    !(await userExists(ctx, key.userId))
  ) {
    return false;
  }
  await exec(ctx, "UPDATE kith.api_keys SET last_used_at = $2 WHERE id = $1", [
    id,
    at(ctx.now),
  ]);
  return true;
}
