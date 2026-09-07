import { v } from "convex/values";

export const occurrenceValidator = v.union(
  v.object({ precision: v.literal("unknown") }),
  v.object({ precision: v.literal("date"), date: v.string() }),
  v.object({
    precision: v.literal("datetime"),
    instant: v.number(),
    originalOffset: v.string(),
  }),
);

export const observationValueValidator = v.union(
  v.object({
    type: v.literal("decimal"),
    value: v.string(),
    unitCode: v.string(),
    originalUnit: v.optional(v.string()),
  }),
  v.object({
    type: v.literal("money"),
    amount: v.string(),
    currency: v.string(),
  }),
  v.object({
    type: v.literal("integer"),
    value: v.string(),
    unitCode: v.optional(v.string()),
  }),
  v.object({ type: v.literal("text"), value: v.string() }),
  v.object({ type: v.literal("boolean"), value: v.boolean() }),
  v.object({ type: v.literal("date"), value: v.string() }),
  v.object({ type: v.literal("entity"), entityId: v.id("entities") }),
);
