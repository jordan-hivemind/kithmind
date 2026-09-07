import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { requireSpaceAccess } from "../../lib/spaces";
import { sha256Hex, utf8ByteLength } from "../ingestion/hash";
import { familyError } from "./errors";

export const FAMILY_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_FAMILY_MEMBERS = 50;
export const MAX_FAMILY_INVITATIONS = 50;
export const MAX_USER_SPACE_MEMBERSHIPS = 100;
export const MAX_FAMILY_SPACE_NAME_LENGTH = 100;
export const MAX_INVITATION_EMAIL_BYTES = 320;

export type FamilyInvitationRole = "editor" | "reader";
type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

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

export function validateFamilySpaceName(value: string): string {
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
  requireWellFormedUtf16(value);
  const email = value.trim().toLowerCase();
  if (
    email.length === 0 ||
    utf8ByteLength(email) > MAX_INVITATION_EMAIL_BYTES ||
    /[\u0000-\u0020\u007f]/u.test(email)
  ) {
    familyError("invalid_input");
  }
  const at = email.indexOf("@");
  if (
    at <= 0 ||
    at !== email.lastIndexOf("@") ||
    at === email.length - 1 ||
    !email.slice(at + 1).includes(".")
  ) {
    familyError("invalid_input");
  }
  return email;
}

export function validateInvitationToken(token: string): void {
  if (!/^[0-9a-f]{64}$/u.test(token)) familyError("invalid_input");
}

export function validateFamilyInvitationRole(
  role: string,
): FamilyInvitationRole {
  if (role !== "editor" && role !== "reader") familyError("invalid_input");
  return role;
}

async function hasAnyMembership(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
  userId: Id<"users">,
): Promise<boolean> {
  return (
    (
      await ctx.db
        .query("spaceMembers")
        .withIndex("by_spaceId_and_userId", (q) =>
          q.eq("spaceId", spaceId).eq("userId", userId),
        )
        .take(1)
    ).length > 0
  );
}

export async function requireSharedMembership(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
  userId: Id<"users">,
): Promise<{ space: Doc<"spaces">; membership: Doc<"spaceMembers"> }> {
  let membership: Doc<"spaceMembers">;
  try {
    membership = await requireSpaceAccess(ctx, { userId }, spaceId, "read");
  } catch (error) {
    if (error instanceof Error && error.message === "Space not found") {
      familyError("space_not_found");
    }
    throw error;
  }
  const space = await ctx.db.get(spaceId);
  if (!space || space.kind !== "shared") {
    familyError("space_not_found");
  }
  return { space, membership };
}

export async function requireSharedOwner(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
  userId: Id<"users">,
): Promise<{ space: Doc<"spaces">; membership: Doc<"spaceMembers"> }> {
  const result = await requireSharedMembership(ctx, spaceId, userId);
  if (result.membership.role !== "owner") familyError("owner_required");
  return result;
}

async function boundedMembers(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
): Promise<Doc<"spaceMembers">[]> {
  const members = await ctx.db
    .query("spaceMembers")
    .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
    .take(MAX_FAMILY_MEMBERS + 1);
  if (members.length > MAX_FAMILY_MEMBERS) familyError("member_limit_reached");
  return members;
}

async function liveUniqueOwners(
  ctx: ReadCtx,
  members: Doc<"spaceMembers">[],
): Promise<Doc<"spaceMembers">[]> {
  const counts = new Map<Id<"users">, number>();
  for (const member of members) {
    counts.set(member.userId, (counts.get(member.userId) ?? 0) + 1);
  }
  const owners = members.filter(
    (member) => member.role === "owner" && counts.get(member.userId) === 1,
  );
  const live = await Promise.all(
    owners.map(async (owner) =>
      (await ctx.db.get(owner.userId)) ? owner : null,
    ),
  );
  return live.filter((owner) => owner !== null);
}

export async function activeInvitations(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
  now: number,
): Promise<Doc<"familyInvitations">[]> {
  const open = await ctx.db
    .query("familyInvitations")
    .withIndex("by_spaceId_status_expiresAt", (q) =>
      q.eq("spaceId", spaceId).eq("status", "open").gt("expiresAt", now),
    )
    .take(MAX_FAMILY_INVITATIONS + 1);
  if (open.length > MAX_FAMILY_INVITATIONS) {
    familyError("invitation_limit_reached");
  }
  const pending = await ctx.db
    .query("familyInvitations")
    .withIndex("by_spaceId_status_expiresAt", (q) =>
      q
        .eq("spaceId", spaceId)
        .eq("status", "pending_owner_approval")
        .gt("expiresAt", now),
    )
    .take(MAX_FAMILY_INVITATIONS + 1 - open.length);
  if (open.length + pending.length > MAX_FAMILY_INVITATIONS) {
    familyError("invitation_limit_reached");
  }
  return [...open, ...pending];
}

export async function createSharedSpace(
  ctx: MutationCtx,
  input: { userId: Id<"users">; name: string },
): Promise<{ spaceId: Id<"spaces">; membershipId: Id<"spaceMembers"> }> {
  if (!(await ctx.db.get(input.userId))) familyError("not_authenticated");
  const memberships = await ctx.db
    .query("spaceMembers")
    .withIndex("by_userId", (q) => q.eq("userId", input.userId))
    .take(MAX_USER_SPACE_MEMBERSHIPS + 1);
  if (memberships.length >= MAX_USER_SPACE_MEMBERSHIPS) {
    familyError("member_limit_reached");
  }
  const spaceId = await ctx.db.insert("spaces", {
    kind: "shared",
    name: validateFamilySpaceName(input.name),
    createdBy: input.userId,
  });
  const membershipId = await ctx.db.insert("spaceMembers", {
    spaceId,
    userId: input.userId,
    role: "owner",
  });
  return { spaceId, membershipId };
}

export async function storeInvitation(
  ctx: MutationCtx,
  input: {
    actorUserId: Id<"users">;
    spaceId: Id<"spaces">;
    email: string;
    role: FamilyInvitationRole;
    tokenHash: string;
    now: number;
  },
): Promise<{ invitationId: Id<"familyInvitations">; expiresAt: number }> {
  if (!(await ctx.db.get(input.actorUserId))) familyError("not_authenticated");
  await requireSharedOwner(ctx, input.spaceId, input.actorUserId);
  if (!/^[0-9a-f]{64}$/u.test(input.tokenHash)) familyError("invalid_input");
  const emailNormalized = normalizeInvitationEmail(input.email);
  const existing = await ctx.db
    .query("familyInvitations")
    .withIndex("by_spaceId_and_emailNormalized", (q) =>
      q.eq("spaceId", input.spaceId).eq("emailNormalized", emailNormalized),
    )
    .take(2);
  if (existing.length > 1) familyError("invitation_unavailable");
  const current = existing[0];
  if (
    current &&
    (current.status === "open" ||
      current.status === "pending_owner_approval") &&
    current.expiresAt > input.now
  ) {
    familyError("invitation_unavailable");
  }

  if (
    (
      await ctx.db
        .query("familyInvitations")
        .withIndex("by_tokenHash", (q) => q.eq("tokenHash", input.tokenHash))
        .take(1)
    ).length > 0
  ) {
    familyError("invitation_unavailable");
  }

  if (
    (await activeInvitations(ctx, input.spaceId, input.now)).length >=
    MAX_FAMILY_INVITATIONS
  ) {
    familyError("invitation_limit_reached");
  }

  const expiresAt = input.now + FAMILY_INVITATION_TTL_MS;
  const fields = {
    spaceId: input.spaceId,
    emailNormalized,
    tokenHash: input.tokenHash,
    role: input.role,
    status: "open" as const,
    createdBy: input.actorUserId,
    createdAt: input.now,
    expiresAt,
    acceptedBy: undefined,
    acceptedAt: undefined,
    approvedBy: undefined,
    approvedAt: undefined,
    membershipId: undefined,
    revokedBy: undefined,
    revokedAt: undefined,
  };
  if (current) {
    await ctx.db.replace(current._id, fields);
    return { invitationId: current._id, expiresAt };
  }
  return {
    invitationId: await ctx.db.insert("familyInvitations", fields),
    expiresAt,
  };
}

export async function acceptInvitationByToken(
  ctx: MutationCtx,
  input: { userId: Id<"users">; token: string; now: number },
): Promise<{ invitationId: Id<"familyInvitations">; spaceId: Id<"spaces"> }> {
  if (!(await ctx.db.get(input.userId))) familyError("not_authenticated");
  validateInvitationToken(input.token);
  const tokenHash = await sha256Hex(input.token);
  const matches = await ctx.db
    .query("familyInvitations")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .take(2);
  if (matches.length !== 1) familyError("invitation_not_found");
  const invitation = matches[0]!;
  const space = await ctx.db.get(invitation.spaceId);
  if (!space || space.kind !== "shared") familyError("invitation_not_found");
  if (invitation.expiresAt <= input.now) familyError("invitation_expired");
  if (invitation.status === "pending_owner_approval") {
    if (invitation.acceptedBy !== input.userId) {
      familyError("invitation_unavailable");
    }
    return { invitationId: invitation._id, spaceId: invitation.spaceId };
  }
  if (invitation.status !== "open") familyError("invitation_unavailable");
  if (await hasAnyMembership(ctx, invitation.spaceId, input.userId)) {
    familyError("already_member");
  }
  await ctx.db.patch(invitation._id, {
    status: "pending_owner_approval",
    acceptedBy: input.userId,
    acceptedAt: input.now,
  });
  return { invitationId: invitation._id, spaceId: invitation.spaceId };
}

export async function approveInvitationForOwner(
  ctx: MutationCtx,
  input: {
    actorUserId: Id<"users">;
    invitationId: Id<"familyInvitations">;
    now: number;
  },
): Promise<{
  spaceId: Id<"spaces">;
  membershipId: Id<"spaceMembers">;
  userId: Id<"users">;
  role: FamilyInvitationRole;
}> {
  const invitation = await ctx.db.get(input.invitationId);
  if (!invitation) familyError("invitation_not_found");
  await requireSharedOwner(ctx, invitation.spaceId, input.actorUserId);
  if (invitation.status === "approved" && invitation.membershipId) {
    const membership = await ctx.db.get(invitation.membershipId);
    if (
      membership &&
      membership.spaceId === invitation.spaceId &&
      membership.userId === invitation.acceptedBy &&
      membership.role === invitation.role
    ) {
      return {
        spaceId: invitation.spaceId,
        membershipId: membership._id,
        userId: membership.userId,
        role: invitation.role,
      };
    }
    familyError("invitation_unavailable");
  }
  if (invitation.expiresAt <= input.now) familyError("invitation_expired");
  if (
    invitation.status !== "pending_owner_approval" ||
    !invitation.acceptedBy
  ) {
    familyError("invitation_unavailable");
  }
  if (invitation.acceptedBy === input.actorUserId) {
    familyError("cannot_self_approve");
  }
  if (!(await ctx.db.get(invitation.acceptedBy))) {
    familyError("invitation_unavailable");
  }
  if (await hasAnyMembership(ctx, invitation.spaceId, invitation.acceptedBy)) {
    familyError("already_member");
  }
  const members = await boundedMembers(ctx, invitation.spaceId);
  if (members.length >= MAX_FAMILY_MEMBERS) familyError("member_limit_reached");
  const userMemberships = await ctx.db
    .query("spaceMembers")
    .withIndex("by_userId", (q) => q.eq("userId", invitation.acceptedBy!))
    .take(MAX_USER_SPACE_MEMBERSHIPS + 1);
  if (userMemberships.length >= MAX_USER_SPACE_MEMBERSHIPS) {
    familyError("member_limit_reached");
  }
  const membershipId = await ctx.db.insert("spaceMembers", {
    spaceId: invitation.spaceId,
    userId: invitation.acceptedBy,
    role: invitation.role,
  });
  await ctx.db.patch(invitation._id, {
    status: "approved",
    approvedBy: input.actorUserId,
    approvedAt: input.now,
    membershipId,
  });
  return {
    spaceId: invitation.spaceId,
    membershipId,
    userId: invitation.acceptedBy,
    role: invitation.role,
  };
}

export async function revokeInvitationForOwner(
  ctx: MutationCtx,
  input: {
    actorUserId: Id<"users">;
    invitationId: Id<"familyInvitations">;
    now: number;
  },
): Promise<void> {
  const invitation = await ctx.db.get(input.invitationId);
  if (!invitation) familyError("invitation_not_found");
  await requireSharedOwner(ctx, invitation.spaceId, input.actorUserId);
  if (
    invitation.status !== "open" &&
    invitation.status !== "pending_owner_approval"
  ) {
    familyError("invitation_unavailable");
  }
  await ctx.db.patch(invitation._id, {
    status: "revoked",
    revokedBy: input.actorUserId,
    revokedAt: input.now,
  });
}

async function requireTargetMembership(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
  membershipId: Id<"spaceMembers">,
): Promise<Doc<"spaceMembers">> {
  const membership = await ctx.db.get(membershipId);
  if (!membership || membership.spaceId !== spaceId) {
    familyError("space_not_found");
  }
  const matching = await ctx.db
    .query("spaceMembers")
    .withIndex("by_spaceId_and_userId", (q) =>
      q.eq("spaceId", spaceId).eq("userId", membership.userId),
    )
    .take(2);
  if (
    matching.length !== 1 ||
    matching[0]!._id !== membership._id ||
    !(await ctx.db.get(membership.userId))
  ) {
    familyError("space_not_found");
  }
  return membership;
}

export async function changeFamilyMemberRole(
  ctx: MutationCtx,
  input: {
    actorUserId: Id<"users">;
    membershipId: Id<"spaceMembers">;
    role: FamilyInvitationRole;
  },
): Promise<void> {
  const target = await ctx.db.get(input.membershipId);
  if (!target) familyError("space_not_found");
  await requireSharedOwner(ctx, target.spaceId, input.actorUserId);
  if (target.role === "owner") familyError("last_owner");
  await ctx.db.patch(target._id, { role: input.role });
}

export async function removeFamilyMember(
  ctx: MutationCtx,
  input: {
    actorUserId: Id<"users">;
    membershipId: Id<"spaceMembers">;
  },
): Promise<void> {
  const target = await ctx.db.get(input.membershipId);
  if (!target) familyError("space_not_found");
  await requireSharedOwner(ctx, target.spaceId, input.actorUserId);
  if (target.userId === input.actorUserId) familyError("last_owner");
  if (target.role === "owner") {
    const owners = (await boundedMembers(ctx, target.spaceId)).filter(
      (member) => member.role === "owner",
    );
    if (owners.length <= 1) familyError("last_owner");
  }
  await ctx.db.delete(target._id);
}

export async function leaveSharedSpace(
  ctx: MutationCtx,
  input: { userId: Id<"users">; spaceId: Id<"spaces"> },
): Promise<void> {
  const { membership } = await requireSharedMembership(
    ctx,
    input.spaceId,
    input.userId,
  );
  if (membership.role === "owner") {
    const owners = await liveUniqueOwners(
      ctx,
      await boundedMembers(ctx, input.spaceId),
    );
    if (owners.length <= 1) familyError("last_owner");
  }
  await ctx.db.delete(membership._id);
}

export async function transferSharedSpaceOwnership(
  ctx: MutationCtx,
  input: {
    actorUserId: Id<"users">;
    spaceId: Id<"spaces">;
    toMembershipId: Id<"spaceMembers">;
  },
): Promise<void> {
  const { membership: actorMembership } = await requireSharedOwner(
    ctx,
    input.spaceId,
    input.actorUserId,
  );
  const target = await requireTargetMembership(
    ctx,
    input.spaceId,
    input.toMembershipId,
  );
  if (target._id === actorMembership._id) familyError("invalid_input");
  await ctx.db.patch(target._id, { role: "owner" });
  await ctx.db.patch(actorMembership._id, { role: "editor" });
}
