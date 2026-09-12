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
const kithRecordQuerySchema = z.discriminatedUnion("operation", [
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

/**
 * The financial archive behind the same tool (F1-10). It is a second provider,
 * not a second ledger: the request and the response are
 * `@repo/finance-contract`'s own, and the gateway carries them through
 * unchanged. Reshaping a finance row into a Kith Mind record would invent the
 * dates, entity identities and currency groups the archive is authoritative
 * for, so the two providers share a tool and never share a result.
 *
 * The shape is left open here on purpose. The contract's parser is the real
 * validator: it checks prototypes, exact key sets, byte size, decimal
 * canonicality and cross-field agreement, none of which belongs in a duplicate
 * schema that could drift from it.
 */
const financeArchiveQuerySchema = z
  .object({
    provider: z.literal("finance_archive"),
    request: z
      .record(z.unknown())
      .describe(
        "A finance read contract request: contractVersion 1, spaceId, limit, " +
          "an operation of list_transactions, list_holdings, list_balances, " +
          "aggregate_money, get_evidence or get_coverage, and that " +
          "operation's own filters.",
      ),
  })
  .strict();

export const recordQuerySchema = z.union([
  kithRecordQuerySchema,
  financeArchiveQuerySchema,
]);
