import { defineTable } from "convex/server";

import { familyInvitationFields } from "./validators";

export const familyTables = {
  familyInvitations: defineTable(familyInvitationFields)
    .index("by_tokenHash", ["tokenHash"])
    .index("by_spaceId_and_status", ["spaceId", "status"])
    .index("by_spaceId_status_expiresAt", ["spaceId", "status", "expiresAt"])
    .index("by_spaceId_and_emailNormalized", ["spaceId", "emailNormalized"])
    .index("by_acceptedBy_and_status", ["acceptedBy", "status"]),
};
