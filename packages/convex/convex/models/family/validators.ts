import { v } from "convex/values";

export const familyInvitationRole = v.union(
  v.literal("editor"),
  v.literal("reader"),
);

export const familyInvitationStatus = v.union(
  v.literal("open"),
  v.literal("pending_owner_approval"),
  v.literal("approved"),
  v.literal("revoked"),
);

export const familyInvitationFields = {
  spaceId: v.id("spaces"),
  emailNormalized: v.string(),
  tokenHash: v.string(),
  role: familyInvitationRole,
  status: familyInvitationStatus,
  createdBy: v.id("users"),
  createdAt: v.number(),
  expiresAt: v.number(),
  acceptedBy: v.optional(v.id("users")),
  acceptedAt: v.optional(v.number()),
  approvedBy: v.optional(v.id("users")),
  approvedAt: v.optional(v.number()),
  membershipId: v.optional(v.id("spaceMembers")),
  revokedBy: v.optional(v.id("users")),
  revokedAt: v.optional(v.number()),
};
