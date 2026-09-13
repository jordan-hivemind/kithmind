// The port of `models/spaces/public.ts`, `private.ts` and `mcpQueries.ts`.
//
// Thin on purpose: every decision is in `./authorization.ts` and these are the
// entry points P2-39i repoints onto, with the same names and the same argument
// shapes as the Convex functions they replace. The one thing worth noticing is
// what the list functions do *not* do: they never take a space id from a caller
// and read it. `listSpaces` starts from the principal's own memberships, and the
// only path that accepts a caller-supplied space is
// `listAuthorizedReadSpaceIds`, which passes it through `requireSpaceAccess`
// before it is used for anything.

import {
  ensurePersonalSpace,
  getAuthorizedReadSpaceIds,
  getSpace,
  requireSpaceAccess,
  resolveWriteSpace,
  type Principal,
  type PrincipalRef,
  type SpaceRole,
} from "./authorization.js";
import { exec, row, rows, type IdentityCtx } from "./db.js";

export type ListedSpace = {
  spaceId: string;
  name: string;
  kind: "personal" | "shared";
  role: SpaceRole;
};

/** `models/spaces/public.ts` `ensurePersonal`. */
export async function ensurePersonal(
  ctx: IdentityCtx,
  args: { principal: Principal | PrincipalRef },
): Promise<{ personalSpaceId: string }> {
  return {
    personalSpaceId: await ensurePersonalSpace(ctx, args.principal.userId),
  };
}

/**
 * `models/spaces/public.ts` `list`, and the space half of
 * `models/spaces/mcpQueries.ts` `list`.
 *
 * The MCP version also returns per-space embedding coverage. That counter lives
 * in the embedding tables P2-39g owns, so this returns the space and the role and
 * that row composes the coverage on top; the authorization half is identical and
 * is not duplicated.
 */
export async function listSpaces(
  ctx: IdentityCtx,
  args: { principal: Principal | PrincipalRef },
): Promise<ListedSpace[]> {
  const spaceIds = await getAuthorizedReadSpaceIds(ctx, args.principal);
  const listed: ListedSpace[] = [];
  for (const spaceId of spaceIds) {
    const memberships = await rows<{ role: SpaceRole }>(
      ctx,
      `SELECT role FROM kith.space_members
         WHERE space_id = $1 AND user_id = $2 LIMIT 2`,
      [spaceId, args.principal.userId],
    );
    // One membership or none. `getAuthorizedReadSpaceIds` already denied the
    // duplicate case; this is the MCP query's own `memberships.length === 1`
    // filter, kept so the two surfaces cannot disagree.
    if (memberships.length !== 1) continue;
    const space = await getSpace(ctx, spaceId);
    if (!space) continue;
    listed.push({
      spaceId,
      name: space.name,
      kind: space.kind,
      role: memberships[0]!.role,
    });
  }
  return listed.sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.spaceId.localeCompare(right.spaceId),
  );
}

/** `models/spaces/public.ts` `getSettings`. */
export async function getSettings(
  ctx: IdentityCtx,
  args: { principal: Principal | PrincipalRef },
): Promise<{ personalSpaceId: string; defaultWriteSpaceId: string | null }> {
  const settings = await row<{
    personal_space_id: string;
    default_write_space_id: string | null;
  }>(
    ctx,
    `SELECT personal_space_id, default_write_space_id
       FROM kith.user_space_settings WHERE user_id = $1`,
    [args.principal.userId],
  );
  if (!settings) throw new Error("Personal space is not configured");
  return {
    personalSpaceId: settings.personal_space_id,
    defaultWriteSpaceId: settings.default_write_space_id,
  };
}

/** `models/spaces/public.ts` `setDefaultWriteSpace`. */
export async function setDefaultWriteSpace(
  ctx: IdentityCtx,
  args: { principal: Principal; spaceId?: string | null },
): Promise<void> {
  await ensurePersonalSpace(ctx, args.principal.userId);
  if (args.spaceId) {
    // The write capability, not read: a default write destination the caller
    // cannot write to would fail later, somewhere less obvious.
    await requireSpaceAccess(ctx, args.principal, args.spaceId, "write");
  }
  const settings = await row<{ id: string }>(
    ctx,
    "SELECT id FROM kith.user_space_settings WHERE user_id = $1",
    [args.principal.userId],
  );
  if (!settings) throw new Error("Personal space is not configured");
  await exec(
    ctx,
    "UPDATE kith.user_space_settings SET default_write_space_id = $2 WHERE id = $1",
    [settings.id, args.spaceId ?? null],
  );
}

/** `models/spaces/private.ts` `authorize`. */
export async function authorize(
  ctx: IdentityCtx,
  args: {
    principal: PrincipalRef;
    spaceId: string;
    operation: "read" | "write" | "ingest";
  },
): Promise<{ role: SpaceRole }> {
  const membership = await requireSpaceAccess(
    ctx,
    args.principal,
    args.spaceId,
    args.operation,
  );
  return { role: membership.role };
}

/** `models/spaces/private.ts` `listAuthorizedReadSpaceIds`. */
export async function listAuthorizedReadSpaceIds(
  ctx: IdentityCtx,
  args: { principal: PrincipalRef; spaceIds?: readonly string[] },
): Promise<string[]> {
  return await getAuthorizedReadSpaceIds(ctx, args.principal, args.spaceIds);
}

/** `models/spaces/private.ts` `resolveWriteDestination`. */
export async function resolveWriteDestination(
  ctx: IdentityCtx,
  args: { principal: PrincipalRef; spaceId?: string },
): Promise<string> {
  return await resolveWriteSpace(ctx, args.principal, args.spaceId);
}

// `models/spaces/people.ts` is not ported here. Every function in it reads or
// writes `kith.entities`, including `setMemberPerson`, which has to load the
// person entity and check its kind, its user and its space before it may touch
// `space_members.person_entity_id`. That table is P2-39h's, and a half port that
// skipped those three checks would be the wrong shape to hand that row. The
// column and its index are in this row's DDL; the module lands with entities.
