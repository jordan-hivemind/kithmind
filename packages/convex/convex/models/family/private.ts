import { internalMutation } from "../../_generated/server";
import { v } from "convex/values";

import { familyError, rethrowFamilyError } from "./errors";
import { storeInvitation } from "./model";
import { familyInvitationRole } from "./validators";

export const createInvitation = internalMutation({
  args: {
    actorUserId: v.id("users"),
    spaceId: v.string(),
    email: v.string(),
    role: familyInvitationRole,
    tokenHash: v.string(),
    now: v.number(),
  },
  returns: v.object({
    invitationId: v.id("familyInvitations"),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    try {
      if (args.spaceId.length > 256) familyError("invalid_input");
      const spaceId = ctx.db.normalizeId("spaces", args.spaceId);
      if (!spaceId) familyError("space_not_found");
      return await storeInvitation(ctx, { ...args, spaceId });
    } catch (error) {
      rethrowFamilyError(error);
    }
  },
});
