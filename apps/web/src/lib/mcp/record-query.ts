import { z } from "zod";

const id = z.string().trim().min(1).max(128);
const recordType = z.string().trim().min(1).max(100);
const scope = {
  spaceId: id,
  sourceAccountIds: z.array(id).max(32).optional(),
  consistency: z.enum(["snapshot", "current"]).optional(),
};
const pages = {
  cursor: id.optional(),
  limit: z.number().int().min(1).max(25).optional(),
};
const range = { from: z.number().finite(), to: z.number().finite() };
const unitCode = z.string().min(1).max(40).optional();

/** Exact query operations remain a typed union across the MCP boundary. */
export const recordQuerySchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("latest_observation"),
      ...scope,
      entityId: id,
      observationType: recordType,
      asOf: z.number().finite().optional(),
      unitCode,
    })
    .strict(),
  z
    .object({
      operation: z.literal("observation_history"),
      ...scope,
      ...pages,
      ...range,
      entityId: id,
      observationType: recordType,
      order: z.enum(["asc", "desc"]),
      unitCode,
    })
    .strict(),
  z
    .object({
      operation: z.literal("latest_event"),
      ...scope,
      entityId: id,
      eventType: recordType,
      asOf: z.number().finite().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("list_events"),
      ...scope,
      ...pages,
      ...range,
      entityId: id,
      eventType: recordType,
      order: z.enum(["asc", "desc"]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("sum_money"),
      ...scope,
      ...range,
      cursor: id.optional(),
      entityId: id.optional(),
      sourceAccountId: id.optional(),
      lineItemType: recordType,
    })
    .strict(),
]);
