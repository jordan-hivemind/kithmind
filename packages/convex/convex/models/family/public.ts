import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import type { Id } from "../../_generated/dataModel";
import { action, mutation, query } from "../../_generated/server";
import { requireWebPrincipal } from "../../lib/webAuth";
import { sha256Hex } from "../ingestion/hash";
import { familyError, rethrowFamilyError } from "./errors";
import {
  acceptInvitationByToken,
  activeInvitations,
  approveInvitationForOwner,
  changeFamilyMemberRole,
  createSharedSpace,
  leaveSharedSpace,
  MAX_FAMILY_MEMBERS,
  removeFamilyMember,
  requireSharedMembership,
  revokeInvitationForOwner,
  transferSharedSpaceOwnership,
  validateFamilyInvitationRole,
} from "./model";
import { familyInvitationRole } from "./validators";

const createInvitationInternal = makeFunctionReference<
  "mutation",
  {
    actorUserId: Id<"users">;
    spaceId: string;
    email: string;
    role: "editor" | "reader";
    tokenHash: string;
    now: number;
  },
  { invitationId: Id<"familyInvitations">; expiresAt: number }
>("models/family/private:createInvitation");

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeSpaceId(
  ctx: {
    db: { normalizeId(table: "spaces", id: string): Id<"spaces"> | null };
  },
  raw: string,
): Id<"spaces"> {
  if (raw.length > 256) familyError("invalid_input");
  return ctx.db.normalizeId("spaces", raw) ?? familyError("space_not_found");
}

function normalizeInvitationId(
  ctx: {
    db: {
      normalizeId(
        table: "familyInvitations",
        id: string,
      ): Id<"familyInvitations"> | null;
    };
  },
  raw: string,
): Id<"familyInvitations"> {
  if (raw.length > 256) familyError("invalid_input");
  return (
    ctx.db.normalizeId("familyInvitations", raw) ??
    familyError("invitation_not_found")
  );
}

function normalizeMembershipId(
  ctx: {
    db: {
      normalizeId(table: "spaceMembers", id: string): Id<"spaceMembers"> | null;
    };
  },
  raw: string,
): Id<"spaceMembers"> {
  if (raw.length > 256) familyError("invalid_input");
  return (
    ctx.db.normalizeId("spaceMembers", raw) ?? familyError("space_not_found")
  );
}

export const createSpace = mutation({
  args: { name: v.string() },
  returns: v.object({
    spaceId: v.id("spaces"),
    membershipId: v.id("spaceMembers"),
    viewerRole: v.literal("owner"),
  }),
  handler: async (ctx, args) => {
    try {
      const { userId } = await requireWebPrincipal(ctx);
      return {
        ...(await createSharedSpace(ctx, { userId, name: args.name })),
        viewerRole: "owner" as const,
      };
    } catch (error) {
      rethrowFamilyError(error);
    }
  },
});

export const createInvitation = action({
  args: {
    spaceId: v.string(),
    email: v.string(),
    role: v.string(),
  },
  returns: v.object({
    invitationId: v.id("familyInvitations"),
    token: v.string(),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    try {
      const { userId } = await requireWebPrincipal(ctx);
      const role = validateFamilyInvitationRole(args.role);
      const token = randomToken();
      const stored = await ctx.runMutation(createInvitationInternal, {
        actorUserId: userId,
        spaceId: args.spaceId,
        email: args.email,
        role,
        tokenHash: await sha256Hex(token),
        now: Date.now(),
      });
      return { ...stored, token };
    } catch (error) {
      rethrowFamilyError(error);
    }
  },
});

export const acceptInvitation = mutation({
  args: { token: v.string() },
  returns: v.object({
    invitationId: v.id("familyInvitations"),
    spaceId: v.id("spaces"),
    status: v.literal("pending_owner_approval"),
    viewerUserId: v.id("users"),
  }),
  handler: async (ctx, args) => {
    try {
      const { userId } = await requireWebPrincipal(ctx);
      return {
        ...(await acceptInvitationByToken(ctx, {
          userId,
          token: args.token,
          now: Date.now(),
        })),
        status: "pending_owner_approval" as const,
        viewerUserId: userId,
      };
    } catch (error) {
      rethrowFamilyError(error);
    }
  },
});

const memberResult = v.object({
  membershipId: v.id("spaceMembers"),
  userId: v.id("users"),
  name: v.optional(v.string()),
  email: v.optional(v.string()),
  role: v.union(v.literal("owner"), v.literal("editor"), v.literal("reader")),
});

const invitationResult = v.object({
  invitationId: v.id("familyInvitations"),
  intendedEmail: v.string(),
  role: familyInvitationRole,
  status: v.union(v.literal("open"), v.literal("pending_owner_approval")),
  expiresAt: v.number(),
  acceptedAt: v.optional(v.number()),
  acceptedUser: v.optional(
    v.object({
      userId: v.id("users"),
      name: v.optional(v.string()),
      email: v.optional(v.string()),
    }),
  ),
});

export const getSpace = query({
  args: { spaceId: v.string() },
  returns: v.object({
    space: v.object({ spaceId: v.id("spaces"), name: v.string() }),
    viewer: v.object({
      membershipId: v.id("spaceMembers"),
      userId: v.id("users"),
      role: v.union(
        v.literal("owner"),
        v.literal("editor"),
        v.literal("reader"),
      ),
    }),
    members: v.array(memberResult),
    invitations: v.array(invitationResult),
  }),
  handler: async (ctx, args) => {
    try {
      const { userId } = await requireWebPrincipal(ctx);
      const spaceId = normalizeSpaceId(ctx, args.spaceId);
      const { space, membership: viewer } = await requireSharedMembership(
        ctx,
        spaceId,
        userId,
      );
      const memberRows = await ctx.db
        .query("spaceMembers")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
        .take(MAX_FAMILY_MEMBERS + 1);
      if (memberRows.length > MAX_FAMILY_MEMBERS) {
        familyError("member_limit_reached");
      }
      const members = await Promise.all(
        memberRows.map(async (membership) => {
          const user = await ctx.db.get(membership.userId);
          return {
            membershipId: membership._id,
            userId: membership.userId,
            ...(user?.name === undefined ? {} : { name: user.name }),
            ...(user?.email === undefined ? {} : { email: user.email }),
            role: membership.role,
          };
        }),
      );

      let invitations: Array<{
        invitationId: Id<"familyInvitations">;
        intendedEmail: string;
        role: "editor" | "reader";
        status: "open" | "pending_owner_approval";
        expiresAt: number;
        acceptedAt?: number;
        acceptedUser?: { userId: Id<"users">; name?: string; email?: string };
      }> = [];
      if (viewer.role === "owner") {
        const now = Date.now();
        const invitationRows = await activeInvitations(ctx, spaceId, now);
        invitations = await Promise.all(
          invitationRows.map(async (invitation) => {
            const acceptedUser = invitation.acceptedBy
              ? await ctx.db.get(invitation.acceptedBy)
              : null;
            return {
              invitationId: invitation._id,
              intendedEmail: invitation.emailNormalized,
              role: invitation.role,
              status: invitation.status as "open" | "pending_owner_approval",
              expiresAt: invitation.expiresAt,
              ...(invitation.acceptedAt === undefined
                ? {}
                : { acceptedAt: invitation.acceptedAt }),
              ...(acceptedUser
                ? {
                    acceptedUser: {
                      userId: acceptedUser._id,
                      ...(acceptedUser.name === undefined
                        ? {}
                        : { name: acceptedUser.name }),
                      ...(acceptedUser.email === undefined
                        ? {}
                        : { email: acceptedUser.email }),
                    },
                  }
                : {}),
            };
          }),
        );
      }
      return {
        space: { spaceId, name: space.name },
        viewer: {
          membershipId: viewer._id,
          userId,
          role: viewer.role,
        },
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
    } catch (error) {
      rethrowFamilyError(error);
    }
  },
});

export const approveInvitation = mutation({
  args: { invitationId: v.string() },
  returns: v.object({
    spaceId: v.id("spaces"),
    membershipId: v.id("spaceMembers"),
    userId: v.id("users"),
    role: familyInvitationRole,
  }),
  handler: async (ctx, args) => {
    try {
      const { userId } = await requireWebPrincipal(ctx);
      return await approveInvitationForOwner(ctx, {
        actorUserId: userId,
        invitationId: normalizeInvitationId(ctx, args.invitationId),
        now: Date.now(),
      });
    } catch (error) {
      rethrowFamilyError(error);
    }
  },
});

export const revokeInvitation = mutation({
  args: { invitationId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const { userId } = await requireWebPrincipal(ctx);
      await revokeInvitationForOwner(ctx, {
        actorUserId: userId,
        invitationId: normalizeInvitationId(ctx, args.invitationId),
        now: Date.now(),
      });
      return null;
    } catch (error) {
      rethrowFamilyError(error);
    }
  },
});

export const changeMemberRole = mutation({
  args: { membershipId: v.string(), role: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const { userId } = await requireWebPrincipal(ctx);
      await changeFamilyMemberRole(ctx, {
        actorUserId: userId,
        membershipId: normalizeMembershipId(ctx, args.membershipId),
        role: validateFamilyInvitationRole(args.role),
      });
      return null;
    } catch (error) {
      rethrowFamilyError(error);
    }
  },
});

export const removeMember = mutation({
  args: { membershipId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const { userId } = await requireWebPrincipal(ctx);
      await removeFamilyMember(ctx, {
        actorUserId: userId,
        membershipId: normalizeMembershipId(ctx, args.membershipId),
      });
      return null;
    } catch (error) {
      rethrowFamilyError(error);
    }
  },
});

export const leaveSpace = mutation({
  args: { spaceId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const { userId } = await requireWebPrincipal(ctx);
      await leaveSharedSpace(ctx, {
        userId,
        spaceId: normalizeSpaceId(ctx, args.spaceId),
      });
      return null;
    } catch (error) {
      rethrowFamilyError(error);
    }
  },
});

export const transferOwnership = mutation({
  args: { spaceId: v.string(), toMembershipId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      const { userId } = await requireWebPrincipal(ctx);
      await transferSharedSpaceOwnership(ctx, {
        actorUserId: userId,
        spaceId: normalizeSpaceId(ctx, args.spaceId),
        toMembershipId: normalizeMembershipId(ctx, args.toMembershipId),
      });
      return null;
    } catch (error) {
      rethrowFamilyError(error);
    }
  },
});
