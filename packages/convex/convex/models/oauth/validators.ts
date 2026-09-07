import { v } from "convex/values";

export const consumedOAuthCodeFields = {
  userId: v.id("users"),
  apiKeyId: v.optional(v.id("apiKeys")),
  requestHash: v.optional(v.string()),
  codeHash: v.string(),
  bindingHash: v.optional(v.string()),
  keyHash: v.optional(v.string()),
  expiresAt: v.number(),
};
