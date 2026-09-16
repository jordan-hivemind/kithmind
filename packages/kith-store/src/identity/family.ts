// The port of `models/family/*`: shared spaces, their members, and invitations.
//
// The invitation flow is two-sided on purpose and the port keeps both sides. An
// owner creates an invitation for an email address and gets a token back once; the
// invited account accepts it, which only moves the row to
// `pending_owner_approval`; a *different* owner then approves it, and only that
// step writes a membership. So the person who holds the link cannot make
// themselves a member, and the owner who sent it cannot approve their own
// acceptance. `cannot_self_approve` is the check that enforces the second half.
//
// Only the token's hash is stored, so the link cannot be recovered from the
// database, and every expiry, member bound and invitation bound is re-read at the
// moment it matters rather than trusted from when the row was written.

import { sha256 as sha256Hex } from "../hash.js";
import { KITH_ID, newKithId } from "../ids.js";
import {
  getSpace,
  requireSpaceAccess,
  userExists,
  type Space,
  type SpaceMember,
  type SpaceRole,
} from "./authorization.js";
import { at, exec, ms, row, rows, type IdentityCtx } from "./db.js";
import { errorThrower, hasErrorCode, IdentityError } from "./errors.js";

export const FAMILY_ERROR_MESSAGES = {
  not_authenticated: "Sign in to manage family spaces.",
  invalid_input: "The family space request is invalid.",
  space_not_found: "Family space not found.",
  owner_required: "Only a family space owner can do that.",
  invitation_not_found: "Invitation not found.",
  invitation_expired: "This invitation has expired.",
  invitation_unavailable: "This invitation is no longer available.",
  invitation_limit_reached: "This family space has too many invitations.",
  member_limit_reached: "This family space has reached its member limit.",
  already_member: "This account is already a member of the family space.",
  cannot_self_approve: "Another owner must approve this account.",
  last_owner: "A family space must keep at least one owner.",
} as const;

export type FamilyErrorCode = keyof typeof FAMILY_ERROR_MESSAGES;

// Explicitly annotated, not inferred: TypeScript only treats a call as
// never-returning -- and so only narrows what follows it -- when the callee is a
// name with a declared type.
export const familyError: (code: FamilyErrorCode) => never = errorThrower(
  FAMILY_ERROR_MESSAGES,
);

/** Whether `error` is one of this module's typed errors. */
export function isFamilyError(error: unknown): boolean {
  return hasErrorCode(error, FAMILY_ERROR_MESSAGES);
}

/**
 * Passes a family error through and turns a bare authentication failure into one.
 * Anything else is a bug and is rethrown unchanged.
 */
export function rethrowFamilyError(error: unknown): never {
  if (isFamilyError(error)) throw error;
  if (error instanceof Error && error.message === "Not authenticated") {
    familyError("not_authenticated");
  }
  throw error;
}

export const FAMILY_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_FAMILY_MEMBERS = 50;
export const MAX_FAMILY_INVITATIONS = 50;
export const MAX_USER_SPACE_MEMBERSHIPS = 100;
export const MAX_FAMILY_SPACE_NAME_LENGTH = 100;
export const MAX_INVITATION_EMAIL_BYTES = 320;

export type FamilyInvitationRole = "editor" | "reader";
export type FamilyInvitationStatus =
  "open" | "pending_owner_approval" | "approved" | "revoked";

export type FamilyInvitation = {
  id: string;
  spaceId: string;
  emailNormalized: string;
  tokenHash: string;
  role: FamilyInvitationRole;
  status: FamilyInvitationStatus;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  acceptedBy: string | null;
  acceptedAt: number | null;
  approvedBy: string | null;
  approvedAt: number | null;
  membershipId: string | null;
  revokedBy: string | null;
  revokedAt: number | null;
};

/**
 * An unpaired surrogate must not reach storage: encoding one replaces it, so a
 * name would come back different from what was validated.
 */
function requireWellFormedUtf16(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || !(next >= 0xdc00 && next <= 0xdfff)) {
        familyError("invalid_input");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      familyError("invalid_input");
    }
  }
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function validateFamilySpaceName(value: string): string {
  if (typeof value !== "string") familyError("invalid_input");
  requireWellFormedUtf16(value);
  const name = value.trim();
  if (
    name.length === 0 ||
    name.length > MAX_FAMILY_SPACE_NAME_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    familyError("invalid_input");
  }
  return name;
}

export function normalizeInvitationEmail(value: string): string {
  if (typeof value !== "string") familyError("invalid_input");
  requireWellFormedUtf16(value);
  const email = value.trim().toLowerCase();
  if (
    email.length === 0 ||
    utf8ByteLength(email) > MAX_INVITATION_EMAIL_BYTES ||
    /[\u0000-\u0020\u007f]/u.test(email)
  ) {
    familyError("invalid_input");
  }
  const at_ = email.indexOf("@");
  if (
    at_ <= 0 ||
    at_ !== email.lastIndexOf("@") ||
    at_ === email.length - 1 ||
    !email.slice(at_ + 1).includes(".")
  ) {
    familyError("invalid_input");
  }
  return email;
}

export function validateInvitationToken(token: string): void {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/u.test(token)) {
    familyError("invalid_input");
  }
}

export function validateFamilyInvitationRole(
  role: string,
): FamilyInvitationRole {
  if (role !== "editor" && role !== "reader") familyError("invalid_input");
  return role;
}

/** A fresh invitation token. Returned once; only its hash is stored. */
function newInvitationToken(): string {
  return sha256Hex(newKithId() + newKithId()).slice(0, 64);
}

function requireSpaceId(raw: string): string {
  if (typeof raw !== "string" || raw.length > 256) familyError("invalid_input");
  if (!KITH_ID.test(raw)) familyError("space_not_found");
  return raw;
}

function requireInvitationId(raw: string): string {
  if (typeof raw !== "string" || raw.length > 256) familyError("invalid_input");
  if (!KITH_ID.test(raw)) familyError("invitation_not_found");
  return raw;
}

function requireMembershipId(raw: string): string {
  if (typeof raw !== "string" || raw.length > 256) familyError("invalid_input");
  if (!KITH_ID.test(raw)) familyError("space_not_found");
  return raw;
}

const INVITATION_COLUMNS = `id, space_id, email_normalized, token_hash, role, status,
  created_by, created_at_field, expires_at, accepted_by, accepted_at, approved_by,
  approved_at, membership_id, revoked_by, revoked_at`;

type InvitationRow = {
  id: string;
  space_id: string;
  email_normalized: string;
  token_hash: string;
  role: string;
  status: string;
  created_by: string;
  created_at_field: Date;
  expires_at: Date;
  accepted_by: string | null;
  accepted_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  membership_id: string | null;
  revoked_by: string | null;
  revoked_at: Date | null;
};

function toInvitation(record: InvitationRow): FamilyInvitation {
  return {
    id: record.id,
    spaceId: record.space_id,
    emailNormalized: record.email_normalized,
    tokenHash: record.token_hash,
    role: record.role as FamilyInvitationRole,
    status: record.status as FamilyInvitationStatus,
    createdBy: record.created_by,
    createdAt: ms(record.created_at_field)!,
    expiresAt: ms(record.expires_at)!,
    acceptedBy: record.accepted_by,
    acceptedAt: ms(record.accepted_at),
    approvedBy: record.approved_by,
    approvedAt: ms(record.approved_at),
    membershipId: record.membership_id,
    revokedBy: record.revoked_by,
    revokedAt: ms(record.revoked_at),
  };
}

async function getInvitation(
  ctx: IdentityCtx,
  id: string,
): Promise<FamilyInvitation | null> {
  const record = await row<InvitationRow>(
    ctx,
    `SELECT ${INVITATION_COLUMNS} FROM kith.family_invitations WHERE id = $1`,
    [id],
  );
  return record ? toInvitation(record) : null;
}

async function hasAnyMembership(
  ctx: IdentityCtx,
  spaceId: string,
  userId: string,
): Promise<boolean> {
  return (
    (await row<{ id: string }>(
      ctx,
      `SELECT id FROM kith.space_members
         WHERE space_id = $1 AND user_id = $2 LIMIT 1`,
      [spaceId, userId],
    )) !== null
  );
}

/**
 * A shared space this user is a member of.
 *
 * `requireSpaceAccess` with a bare `{ userId }` ref: a web session, not a
 * credential, because family management is not on the MCP surface. A personal
 * space is not a family space and is refused here even for its owner.
 */
export async function requireSharedMembership(
  ctx: IdentityCtx,
  spaceId: string,
  userId: string,
): Promise<{ space: Space; membership: SpaceMember }> {
  let membership: SpaceMember;
  try {
    membership = await requireSpaceAccess(ctx, { userId }, spaceId, "read");
  } catch (error) {
    if (error instanceof Error && error.message === "Space not found") {
      familyError("space_not_found");
    }
    throw error;
  }
  const space = await getSpace(ctx, spaceId);
  if (!space || space.kind !== "shared") familyError("space_not_found");
  return { space, membership };
}

export async function requireSharedOwner(
  ctx: IdentityCtx,
  spaceId: string,
  userId: string,
): Promise<{ space: Space; membership: SpaceMember }> {
  const result = await requireSharedMembership(ctx, spaceId, userId);
  if (result.membership.role !== "owner") familyError("owner_required");
  return result;
}

async function boundedMembers(
  ctx: IdentityCtx,
  spaceId: string,
): Promise<SpaceMember[]> {
  const members = await rows<{
    id: string;
    space_id: string;
    user_id: string;
    role: string;
    person_entity_id: string | null;
  }>(
    ctx,
    `SELECT id, space_id, user_id, role, person_entity_id FROM kith.space_members
       WHERE space_id = $1 LIMIT $2`,
    [spaceId, MAX_FAMILY_MEMBERS + 1],
  );
  if (members.length > MAX_FAMILY_MEMBERS) familyError("member_limit_reached");
  return members.map((member) => ({
    id: member.id,
    spaceId: member.space_id,
    userId: member.user_id,
    role: member.role as SpaceRole,
    personEntityId: member.person_entity_id,
  }));
}

/**
 * Owners who can actually still act: one membership row each, and a live user.
 *
 * The distinction matters in `leaveSharedSpace`: a duplicated owner row or an
 * owner whose user is gone must not be counted as the owner that keeps the space
 * from being left without one.
 */
async function liveUniqueOwners(
  ctx: IdentityCtx,
  members: SpaceMember[],
): Promise<SpaceMember[]> {
  const counts = new Map<string, number>();
  for (const member of members) {
    counts.set(member.userId, (counts.get(member.userId) ?? 0) + 1);
  }
  const owners = members.filter(
    (member) => member.role === "owner" && counts.get(member.userId) === 1,
  );
  const live: SpaceMember[] = [];
  for (const owner of owners) {
    if (await userExists(ctx, owner.userId)) live.push(owner);
  }
  return live;
}

export async function activeInvitations(
  ctx: IdentityCtx,
  spaceId: string,
  now: number,
): Promise<FamilyInvitation[]> {
  const open = await rows<InvitationRow>(
    ctx,
    `SELECT ${INVITATION_COLUMNS} FROM kith.family_invitations
       WHERE space_id = $1 AND status = 'open' AND expires_at > $2 LIMIT $3`,
    [spaceId, at(now), MAX_FAMILY_INVITATIONS + 1],
  );
  if (open.length > MAX_FAMILY_INVITATIONS) {
    familyError("invitation_limit_reached");
  }
  const pending = await rows<InvitationRow>(
    ctx,
    `SELECT ${INVITATION_COLUMNS} FROM kith.family_invitations
       WHERE space_id = $1 AND status = 'pending_owner_approval' AND expires_at > $2
       LIMIT $3`,
    [spaceId, at(now), MAX_FAMILY_INVITATIONS + 1 - open.length],
  );
  if (open.length + pending.length > MAX_FAMILY_INVITATIONS) {
    familyError("invitation_limit_reached");
  }
  return [...open, ...pending].map(toInvitation);
}

/** `models/family/public.ts` `createSpace`. */
export async function createSharedSpace(
  ctx: IdentityCtx,
  input: { userId: string; name: string },
): Promise<{ spaceId: string; membershipId: string }> {
  if (!(await userExists(ctx, input.userId))) familyError("not_authenticated");
  const memberships = await rows<{ id: string }>(
    ctx,
    "SELECT id FROM kith.space_members WHERE user_id = $1 LIMIT $2",
    [input.userId, MAX_USER_SPACE_MEMBERSHIPS + 1],
  );
  if (memberships.length >= MAX_USER_SPACE_MEMBERSHIPS) {
    familyError("member_limit_reached");
  }
  const spaceId = newKithId();
  const membershipId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.spaces (id, kind, name, created_by)
       VALUES ($1, 'shared', $2, $3)`,
    [spaceId, validateFamilySpaceName(input.name), input.userId],
  );
  await exec(
    ctx,
    `INSERT INTO kith.space_members (id, space_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
    [membershipId, spaceId, input.userId],
  );
  return { spaceId, membershipId };
}

/** `models/family/model.ts` `storeInvitation`, behind `private.ts`'s wrapper. */
export async function storeInvitation(
  ctx: IdentityCtx,
  input: {
    actorUserId: string;
    spaceId: string;
    email: string;
    role: FamilyInvitationRole;
    tokenHash: string;
  },
): Promise<{ invitationId: string; expiresAt: number }> {
  const now = ctx.now;
  const spaceId = requireSpaceId(input.spaceId);
  if (!(await userExists(ctx, input.actorUserId))) {
    familyError("not_authenticated");
  }
  await requireSharedOwner(ctx, spaceId, input.actorUserId);
  if (!/^[0-9a-f]{64}$/u.test(input.tokenHash)) familyError("invalid_input");
  const emailNormalized = normalizeInvitationEmail(input.email);
  const existing = await rows<InvitationRow>(
    ctx,
    `SELECT ${INVITATION_COLUMNS} FROM kith.family_invitations
       WHERE space_id = $1 AND email_normalized = $2 LIMIT 2`,
    [spaceId, emailNormalized],
  );
  if (existing.length > 1) familyError("invitation_unavailable");
  const current = existing[0] ? toInvitation(existing[0]) : undefined;
  if (
    current &&
    (current.status === "open" ||
      current.status === "pending_owner_approval") &&
    current.expiresAt > now
  ) {
    familyError("invitation_unavailable");
  }

  if (
    (await row<{ id: string }>(
      ctx,
      "SELECT id FROM kith.family_invitations WHERE token_hash = $1 LIMIT 1",
      [input.tokenHash],
    )) !== null
  ) {
    familyError("invitation_unavailable");
  }

  if (
    (await activeInvitations(ctx, spaceId, now)).length >=
    MAX_FAMILY_INVITATIONS
  ) {
    familyError("invitation_limit_reached");
  }

  const expiresAt = now + FAMILY_INVITATION_TTL_MS;
  if (current) {
    // A replace, not a patch: every acceptance, approval and revocation field
    // goes back to null, so a reused row cannot carry a stale approval forward.
    await exec(
      ctx,
      `UPDATE kith.family_invitations
         SET email_normalized = $2, token_hash = $3, role = $4, status = 'open',
             created_by = $5, created_at_field = $6, expires_at = $7,
             accepted_by = NULL, accepted_at = NULL, approved_by = NULL,
             approved_at = NULL, membership_id = NULL, revoked_by = NULL,
             revoked_at = NULL
         WHERE id = $1`,
      [
        current.id,
        emailNormalized,
        input.tokenHash,
        input.role,
        input.actorUserId,
        at(now),
        at(expiresAt),
      ],
    );
    return { invitationId: current.id, expiresAt };
  }
  const invitationId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.family_invitations
       (id, space_id, email_normalized, token_hash, role, status, created_by,
        created_at_field, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8)`,
    [
      invitationId,
      spaceId,
      emailNormalized,
      input.tokenHash,
      input.role,
      input.actorUserId,
      at(now),
      at(expiresAt),
    ],
  );
  return { invitationId, expiresAt };
}

/** `models/family/public.ts` `createInvitation`: token out once, hash stored. */
export async function createInvitation(
  ctx: IdentityCtx,
  args: {
    actorUserId: string;
    spaceId: string;
    email: string;
    role: string;
  },
): Promise<{ invitationId: string; token: string; expiresAt: number }> {
  const role = validateFamilyInvitationRole(args.role);
  const token = newInvitationToken();
  const stored = await storeInvitation(ctx, {
    actorUserId: args.actorUserId,
    spaceId: args.spaceId,
    email: args.email,
    role,
    tokenHash: sha256Hex(token),
  });
  return { ...stored, token };
}

/** `models/family/model.ts` `acceptInvitationByToken`. */
export async function acceptInvitationByToken(
  ctx: IdentityCtx,
  input: { userId: string; token: string },
): Promise<{ invitationId: string; spaceId: string }> {
  const now = ctx.now;
  if (!(await userExists(ctx, input.userId))) familyError("not_authenticated");
  validateInvitationToken(input.token);
  const tokenHash = sha256Hex(input.token);
  const matches = await rows<InvitationRow>(
    ctx,
    `SELECT ${INVITATION_COLUMNS} FROM kith.family_invitations
       WHERE token_hash = $1 LIMIT 2`,
    [tokenHash],
  );
  if (matches.length !== 1) familyError("invitation_not_found");
  const invitation = toInvitation(matches[0]!);
  const space = await getSpace(ctx, invitation.spaceId);
  if (!space || space.kind !== "shared") familyError("invitation_not_found");
  if (invitation.expiresAt <= now) familyError("invitation_expired");
  if (invitation.status === "pending_owner_approval") {
    // Idempotent for the account that already accepted, and an unavailable
    // invitation for anyone else who has the link.
    if (invitation.acceptedBy !== input.userId) {
      familyError("invitation_unavailable");
    }
    return { invitationId: invitation.id, spaceId: invitation.spaceId };
  }
  if (invitation.status !== "open") familyError("invitation_unavailable");
  if (await hasAnyMembership(ctx, invitation.spaceId, input.userId)) {
    familyError("already_member");
  }
  await exec(
    ctx,
    `UPDATE kith.family_invitations
       SET status = 'pending_owner_approval', accepted_by = $2, accepted_at = $3
       WHERE id = $1`,
    [invitation.id, input.userId, at(now)],
  );
  return { invitationId: invitation.id, spaceId: invitation.spaceId };
}

/** `models/family/model.ts` `approveInvitationForOwner`: the only write path. */
export async function approveInvitationForOwner(
  ctx: IdentityCtx,
  input: { actorUserId: string; invitationId: string },
): Promise<{
  spaceId: string;
  membershipId: string;
  userId: string;
  role: FamilyInvitationRole;
}> {
  const now = ctx.now;
  const invitation = await getInvitation(
    ctx,
    requireInvitationId(input.invitationId),
  );
  if (!invitation) familyError("invitation_not_found");
  await requireSharedOwner(ctx, invitation.spaceId, input.actorUserId);
  if (invitation.status === "approved" && invitation.membershipId) {
    const membership = await row<{
      id: string;
      space_id: string;
      user_id: string;
      role: string;
    }>(
      ctx,
      `SELECT id, space_id, user_id, role FROM kith.space_members WHERE id = $1`,
      [invitation.membershipId],
    );
    if (
      membership &&
      membership.space_id === invitation.spaceId &&
      membership.user_id === invitation.acceptedBy &&
      membership.role === invitation.role
    ) {
      return {
        spaceId: invitation.spaceId,
        membershipId: membership.id,
        userId: membership.user_id,
        role: invitation.role,
      };
    }
    familyError("invitation_unavailable");
  }
  if (invitation.expiresAt <= now) familyError("invitation_expired");
  if (
    invitation.status !== "pending_owner_approval" ||
    !invitation.acceptedBy
  ) {
    familyError("invitation_unavailable");
  }
  if (invitation.acceptedBy === input.actorUserId) {
    familyError("cannot_self_approve");
  }
  if (!(await userExists(ctx, invitation.acceptedBy))) {
    familyError("invitation_unavailable");
  }
  if (await hasAnyMembership(ctx, invitation.spaceId, invitation.acceptedBy)) {
    familyError("already_member");
  }
  const members = await boundedMembers(ctx, invitation.spaceId);
  if (members.length >= MAX_FAMILY_MEMBERS) familyError("member_limit_reached");
  const userMemberships = await rows<{ id: string }>(
    ctx,
    "SELECT id FROM kith.space_members WHERE user_id = $1 LIMIT $2",
    [invitation.acceptedBy, MAX_USER_SPACE_MEMBERSHIPS + 1],
  );
  if (userMemberships.length >= MAX_USER_SPACE_MEMBERSHIPS) {
    familyError("member_limit_reached");
  }
  const membershipId = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.space_members (id, space_id, user_id, role)
       VALUES ($1, $2, $3, $4)`,
    [membershipId, invitation.spaceId, invitation.acceptedBy, invitation.role],
  );
  await exec(
    ctx,
    `UPDATE kith.family_invitations
       SET status = 'approved', approved_by = $2, approved_at = $3,
           membership_id = $4
       WHERE id = $1`,
    [invitation.id, input.actorUserId, at(now), membershipId],
  );
  return {
    spaceId: invitation.spaceId,
    membershipId,
    userId: invitation.acceptedBy,
    role: invitation.role,
  };
}

/** `models/family/model.ts` `revokeInvitationForOwner`. */
export async function revokeInvitationForOwner(
  ctx: IdentityCtx,
  input: { actorUserId: string; invitationId: string },
): Promise<void> {
  const invitation = await getInvitation(
    ctx,
    requireInvitationId(input.invitationId),
  );
  if (!invitation) familyError("invitation_not_found");
  await requireSharedOwner(ctx, invitation.spaceId, input.actorUserId);
  if (
    invitation.status !== "open" &&
    invitation.status !== "pending_owner_approval"
  ) {
    familyError("invitation_unavailable");
  }
  await exec(
    ctx,
    `UPDATE kith.family_invitations
       SET status = 'revoked', revoked_by = $2, revoked_at = $3 WHERE id = $1`,
    [invitation.id, input.actorUserId, at(ctx.now)],
  );
}

async function requireTargetMembership(
  ctx: IdentityCtx,
  spaceId: string,
  membershipId: string,
): Promise<SpaceMember> {
  const record = await row<{
    id: string;
    space_id: string;
    user_id: string;
    role: string;
    person_entity_id: string | null;
  }>(
    ctx,
    `SELECT id, space_id, user_id, role, person_entity_id
       FROM kith.space_members WHERE id = $1`,
    [membershipId],
  );
  if (!record || record.space_id !== spaceId) familyError("space_not_found");
  const matching = await rows<{ id: string }>(
    ctx,
    `SELECT id FROM kith.space_members
       WHERE space_id = $1 AND user_id = $2 LIMIT 2`,
    [spaceId, record!.user_id],
  );
  if (
    matching.length !== 1 ||
    matching[0]!.id !== record!.id ||
    !(await userExists(ctx, record!.user_id))
  ) {
    familyError("space_not_found");
  }
  return {
    id: record!.id,
    spaceId: record!.space_id,
    userId: record!.user_id,
    role: record!.role as SpaceRole,
    personEntityId: record!.person_entity_id,
  };
}

/** `models/family/model.ts` `changeFamilyMemberRole`. */
export async function changeFamilyMemberRole(
  ctx: IdentityCtx,
  input: {
    actorUserId: string;
    membershipId: string;
    role: FamilyInvitationRole;
  },
): Promise<void> {
  const id = requireMembershipId(input.membershipId);
  const target = await row<{ id: string; space_id: string; role: string }>(
    ctx,
    "SELECT id, space_id, role FROM kith.space_members WHERE id = $1",
    [id],
  );
  if (!target) familyError("space_not_found");
  await requireSharedOwner(ctx, target!.space_id, input.actorUserId);
  // An owner's role is changed by transferring ownership, not by demoting them
  // here, so a space cannot lose its last owner through this path.
  if (target!.role === "owner") familyError("last_owner");
  await exec(ctx, "UPDATE kith.space_members SET role = $2 WHERE id = $1", [
    target!.id,
    validateFamilyInvitationRole(input.role),
  ]);
}

/**
 * Clears `membership_id` on every approved invitation that names a
 * membership row, before that row is deleted.
 *
 * Two foreign keys reference `space_members (id, space_id)` from this same
 * `(membership_id, space_id)` pair, both still live on the table:
 * `family_invitations_membership_id_fkey` (migration 004) and
 * `family_invitations_membership_space_fkey` (migration 006, added rather
 * than replacing the first). `membership_id` is nullable under both, and
 * `storeInvitation` already clears it when an invitation is reissued.
 * `removeFamilyMember` and `leaveSharedSpace` are the two paths that delete a
 * `space_members` row directly rather than through `storeInvitation`, so each
 * needs this call first; without it the delete succeeds but the *commit*
 * fails on whichever of the two constraints is checked, and an approved
 * member could never be removed or leave. This is `deleteApiKey`'s pattern
 * for `consumed_oauth_codes.api_key_id`, applied to the other table that
 * points at a row this module deletes.
 */
async function detachMembershipFromInvitations(
  ctx: IdentityCtx,
  membershipId: string,
): Promise<void> {
  await exec(
    ctx,
    "UPDATE kith.family_invitations SET membership_id = NULL WHERE membership_id = $1",
    [membershipId],
  );
}

/** `models/family/model.ts` `removeFamilyMember`. */
export async function removeFamilyMember(
  ctx: IdentityCtx,
  input: { actorUserId: string; membershipId: string },
): Promise<void> {
  const id = requireMembershipId(input.membershipId);
  const target = await row<{
    id: string;
    space_id: string;
    user_id: string;
    role: string;
  }>(
    ctx,
    "SELECT id, space_id, user_id, role FROM kith.space_members WHERE id = $1",
    [id],
  );
  if (!target) familyError("space_not_found");
  await requireSharedOwner(ctx, target!.space_id, input.actorUserId);
  if (target!.user_id === input.actorUserId) familyError("last_owner");
  if (target!.role === "owner") {
    const owners = (await boundedMembers(ctx, target!.space_id)).filter(
      (member) => member.role === "owner",
    );
    if (owners.length <= 1) familyError("last_owner");
  }
  await detachMembershipFromInvitations(ctx, target!.id);
  await exec(ctx, "DELETE FROM kith.space_members WHERE id = $1", [target!.id]);
}

/** `models/family/model.ts` `leaveSharedSpace`. */
export async function leaveSharedSpace(
  ctx: IdentityCtx,
  input: { userId: string; spaceId: string },
): Promise<void> {
  const spaceId = requireSpaceId(input.spaceId);
  const { membership } = await requireSharedMembership(
    ctx,
    spaceId,
    input.userId,
  );
  if (membership.role === "owner") {
    const owners = await liveUniqueOwners(
      ctx,
      await boundedMembers(ctx, spaceId),
    );
    if (owners.length <= 1) familyError("last_owner");
  }
  await detachMembershipFromInvitations(ctx, membership.id);
  await exec(ctx, "DELETE FROM kith.space_members WHERE id = $1", [
    membership.id,
  ]);
}

/** `models/family/model.ts` `transferSharedSpaceOwnership`. */
export async function transferSharedSpaceOwnership(
  ctx: IdentityCtx,
  input: { actorUserId: string; spaceId: string; toMembershipId: string },
): Promise<void> {
  const spaceId = requireSpaceId(input.spaceId);
  const { membership: actorMembership } = await requireSharedOwner(
    ctx,
    spaceId,
    input.actorUserId,
  );
  const target = await requireTargetMembership(
    ctx,
    spaceId,
    requireMembershipId(input.toMembershipId),
  );
  if (target.id === actorMembership.id) familyError("invalid_input");
  await exec(
    ctx,
    "UPDATE kith.space_members SET role = 'owner' WHERE id = $1",
    [target.id],
  );
  await exec(
    ctx,
    "UPDATE kith.space_members SET role = 'editor' WHERE id = $1",
    [actorMembership.id],
  );
}

export type FamilySpaceView = {
  space: { spaceId: string; name: string };
  viewer: { membershipId: string; userId: string; role: SpaceRole };
  members: {
    membershipId: string;
    userId: string;
    name?: string;
    email?: string;
    role: SpaceRole;
  }[];
  invitations: {
    invitationId: string;
    intendedEmail: string;
    role: FamilyInvitationRole;
    status: "open" | "pending_owner_approval";
    expiresAt: number;
    acceptedAt?: number;
    acceptedUser?: { userId: string; name?: string; email?: string };
  }[];
};

/**
 * `models/family/public.ts` `getSpace`.
 *
 * A non-owner sees the members and never the invitations: an open invitation
 * names an email address that was not necessarily shared with the rest of the
 * space.
 */
export async function getFamilySpace(
  ctx: IdentityCtx,
  args: { userId: string; spaceId: string },
): Promise<FamilySpaceView> {
  const spaceId = requireSpaceId(args.spaceId);
  const { space, membership: viewer } = await requireSharedMembership(
    ctx,
    spaceId,
    args.userId,
  );
  const memberRows = await boundedMembers(ctx, spaceId);
  const members: FamilySpaceView["members"] = [];
  for (const member of memberRows) {
    const user = await row<{ name: string | null; email: string | null }>(
      ctx,
      "SELECT name, email FROM kith.users WHERE id = $1",
      [member.userId],
    );
    members.push({
      membershipId: member.id,
      userId: member.userId,
      ...(user?.name == null ? {} : { name: user.name }),
      ...(user?.email == null ? {} : { email: user.email }),
      role: member.role,
    });
  }

  let invitations: FamilySpaceView["invitations"] = [];
  if (viewer.role === "owner") {
    const rowsFound = await activeInvitations(ctx, spaceId, ctx.now);
    invitations = [];
    for (const invitation of rowsFound) {
      const acceptedUser = invitation.acceptedBy
        ? await row<{ name: string | null; email: string | null }>(
            ctx,
            "SELECT name, email FROM kith.users WHERE id = $1",
            [invitation.acceptedBy],
          )
        : null;
      invitations.push({
        invitationId: invitation.id,
        intendedEmail: invitation.emailNormalized,
        role: invitation.role,
        status: invitation.status as "open" | "pending_owner_approval",
        expiresAt: invitation.expiresAt,
        ...(invitation.acceptedAt === null
          ? {}
          : { acceptedAt: invitation.acceptedAt }),
        ...(acceptedUser
          ? {
              acceptedUser: {
                userId: invitation.acceptedBy!,
                ...(acceptedUser.name == null
                  ? {}
                  : { name: acceptedUser.name }),
                ...(acceptedUser.email == null
                  ? {}
                  : { email: acceptedUser.email }),
              },
            }
          : {}),
      });
    }
  }
  return {
    space: { spaceId, name: space.name },
    viewer: { membershipId: viewer.id, userId: args.userId, role: viewer.role },
    members: members.sort(
      (left, right) =>
        left.role.localeCompare(right.role) ||
        left.userId.localeCompare(right.userId),
    ),
    invitations: invitations.sort(
      (left, right) =>
        left.intendedEmail.localeCompare(right.intendedEmail) ||
        left.invitationId.localeCompare(right.invitationId),
    ),
  };
}

export { IdentityError };
