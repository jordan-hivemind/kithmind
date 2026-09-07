import { v } from "convex/values";

export const capability = v.union(
  v.literal("read"),
  v.literal("write"),
  v.literal("ingest"),
);

export const principalRefValidator = v.object({
  userId: v.id("users"),
  credentialId: v.optional(v.id("apiKeys")),
});

export const apiKeyFields = {
  userId: v.id("users"),
  keyHash: v.string(),
  keyPrefix: v.string(),
  name: v.string(),
  lastUsedAt: v.optional(v.number()),
  capabilities: v.array(capability),
  spaceIds: v.array(v.id("spaces")),
};
