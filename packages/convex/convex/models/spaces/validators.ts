import { v } from "convex/values";

export const spaceKind = v.union(v.literal("personal"), v.literal("shared"));

export const spaceRole = v.union(
  v.literal("owner"),
  v.literal("editor"),
  v.literal("reader"),
);

export const spaceFields = {
  kind: spaceKind,
  name: v.string(),
  createdBy: v.id("users"),
};

export const spaceMemberFields = {
  spaceId: v.id("spaces"),
  userId: v.id("users"),
  role: spaceRole,
  personEntityId: v.optional(v.id("entities")),
};

export const userSpaceSettingsFields = {
  userId: v.id("users"),
  personalSpaceId: v.id("spaces"),
  defaultWriteSpaceId: v.optional(v.id("spaces")),
};
