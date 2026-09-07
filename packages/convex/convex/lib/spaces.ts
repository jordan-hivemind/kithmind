import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

import {
  insertMissingPersonalSpaceRecords,
  inspectPersonalSpace,
} from "../models/spaces/model";

export type Capability = "read" | "write" | "ingest";
export type SpaceOperation = Capability;
export type SpaceRole = "owner" | "editor" | "reader";

/**
 * An authorization snapshot. Arrays keep the value safe to pass through
 * Convex actions. Callers must reload a PrincipalRef before a later database
 * operation instead of trusting this snapshot after a key or role change.
 */
export type Principal = {
  userId: Id<"users">;
  credentialId?: Id<"apiKeys">;
  capabilities: readonly Capability[];
  credentialSpaceIds?: readonly Id<"spaces">[];
  credentialSourceAccountIds?: readonly Id<"sourceAccounts">[];
};

export type PrincipalRef = {
  userId: Id<"users">;
  credentialId?: Id<"apiKeys">;
};

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

const ALL_CAPABILITIES: readonly Capability[] = ["read", "write", "ingest"];
const MAX_AUTHORIZED_SPACES = 100;

export function webPrincipal(userId: Id<"users">): Principal {
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

function isFullyScopedKey(key: Doc<"apiKeys">): key is Doc<"apiKeys"> & {
  capabilities: Capability[];
  spaceIds: Id<"spaces">[];
} {
  return key.capabilities !== undefined && key.spaceIds !== undefined;
}

export function principalFromApiKey(
  key: Doc<"apiKeys">,
  expectedUserId?: Id<"users">,
): Principal {
  if (expectedUserId !== undefined && key.userId !== expectedUserId) {
    throw new Error("Not authenticated");
  }
  if (!isFullyScopedKey(key)) {
    throw new Error("API key migration required");
  }
  return {
    userId: key.userId,
    credentialId: key._id,
    capabilities: unique(key.capabilities),
    credentialSpaceIds: unique(key.spaceIds),
    credentialSourceAccountIds: unique(key.sourceAccountIds ?? []),
  };
}

/** Reloads mutable API-key grants for a final query or mutation. */
export async function reloadPrincipal(
  ctx: ReadCtx,
  ref: PrincipalRef,
): Promise<Principal> {
  if (!(await ctx.db.get(ref.userId))) throw new Error("Not authenticated");
  if (!ref.credentialId) return webPrincipal(ref.userId);
  const key = await ctx.db.get(ref.credentialId);
  if (!key) throw new Error("Not authenticated");
  return principalFromApiKey(key, ref.userId);
}

function acceptsRole(role: SpaceRole, operation: SpaceOperation): boolean {
  return operation === "read" || role === "owner" || role === "editor";
}

function hasCredentialGrant(
  principal: Principal,
  spaceId: Id<"spaces">,
  operation: SpaceOperation,
): boolean {
  if (!principal.capabilities.includes(operation)) return false;
  return (
    principal.credentialSpaceIds === undefined ||
    principal.credentialSpaceIds.includes(spaceId)
  );
}

async function currentPrincipal(
  ctx: ReadCtx,
  principalOrRef: Principal | PrincipalRef,
): Promise<Principal> {
  return await reloadPrincipal(
    ctx,
    "capabilities" in principalOrRef
      ? principalRef(principalOrRef)
      : principalOrRef,
  );
}

/**
 * Enforces the user's current membership and, for API keys, the current
 * capability and exact space grant. All failures use one non-enumerating
 * error shape.
 */
export async function requireSpaceAccess(
  ctx: ReadCtx,
  principalOrRef: Principal | PrincipalRef,
  spaceId: Id<"spaces">,
  operation: SpaceOperation,
): Promise<Doc<"spaceMembers">> {
  const principal = await currentPrincipal(ctx, principalOrRef);
  if (!hasCredentialGrant(principal, spaceId, operation)) {
    throw new Error("Space not found");
  }

  const memberships = await ctx.db
    .query("spaceMembers")
    .withIndex("by_spaceId_and_userId", (q) =>
      q.eq("spaceId", spaceId).eq("userId", principal.userId),
    )
    .take(2);
  if (
    memberships.length !== 1 ||
    !acceptsRole(memberships[0]!.role, operation)
  ) {
    throw new Error("Space not found");
  }

  const space = await ctx.db.get(spaceId);
  if (!space) throw new Error("Space not found");
  return memberships[0]!;
}

/**
 * Returns all readable spaces, or validates and de-duplicates an explicit
 * filter. Explicit inaccessible and unknown IDs are deliberately identical.
 */
export async function getAuthorizedReadSpaceIds(
  ctx: ReadCtx,
  principalOrRef: Principal | PrincipalRef,
  explicitSpaceIds?: readonly Id<"spaces">[],
): Promise<Id<"spaces">[]> {
  const principal = await currentPrincipal(ctx, principalOrRef);
  if (!principal.capabilities.includes("read")) {
    throw new Error("Space not found");
  }

  if (explicitSpaceIds && explicitSpaceIds.length > 0) {
    if (explicitSpaceIds.length > MAX_AUTHORIZED_SPACES) {
      throw new Error("Space filter is too large");
    }
    const requested = unique(explicitSpaceIds);
    await Promise.all(
      requested.map((spaceId) =>
        requireSpaceAccess(ctx, principal, spaceId, "read"),
      ),
    );
    return requested;
  }

  const memberships = await ctx.db
    .query("spaceMembers")
    .withIndex("by_userId", (q) => q.eq("userId", principal.userId))
    .take(MAX_AUTHORIZED_SPACES + 1);
  if (memberships.length > MAX_AUTHORIZED_SPACES) {
    throw new Error("Too many space memberships");
  }
  const scoped = principal.credentialSpaceIds
    ? new Set(principal.credentialSpaceIds)
    : undefined;
  const membershipCounts = new Map<Id<"spaces">, number>();
  for (const membership of memberships) {
    membershipCounts.set(
      membership.spaceId,
      (membershipCounts.get(membership.spaceId) ?? 0) + 1,
    );
  }
  const ids = [...membershipCounts]
    .filter(
      ([spaceId, count]) =>
        count === 1 && (scoped === undefined || scoped.has(spaceId)),
    )
    .map(([spaceId]) => spaceId);
  const authorized = await Promise.all(
    ids.map(async (spaceId) => {
      try {
        await requireSpaceAccess(ctx, principal, spaceId, "read");
        return spaceId;
      } catch {
        return null;
      }
    }),
  );
  return authorized.filter((spaceId) => spaceId !== null);
}

/** Creates a user's personal space, membership, and settings atomically. */
export async function ensurePersonalSpace(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<Id<"spaces">> {
  if (!(await ctx.db.get(userId))) throw new Error("Not authenticated");
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
  ctx: MutationCtx,
  principalOrRef: Principal | PrincipalRef,
  explicitSpaceId?: Id<"spaces">,
): Promise<Id<"spaces">> {
  const principal = await currentPrincipal(ctx, principalOrRef);
  const personalSpaceId = await ensurePersonalSpace(ctx, principal.userId);

  if (explicitSpaceId) {
    await requireSpaceAccess(ctx, principal, explicitSpaceId, "write");
    return explicitSpaceId;
  }

  const settings = await ctx.db
    .query("userSpaceSettings")
    .withIndex("by_userId", (q) => q.eq("userId", principal.userId))
    .unique();
  const configured = settings?.defaultWriteSpaceId;
  if (configured) {
    try {
      await requireSpaceAccess(ctx, principal, configured, "write");
    } catch {
      throw new Error("Default write space is not available");
    }
    return configured;
  }

  await requireSpaceAccess(ctx, principal, personalSpaceId, "write");
  return personalSpaceId;
}
