// What the three `/api/kith/investments*` routes validate with.
//
// Here rather than in a route file because Next.js only allows a route module
// to export its handlers and its segment config, and because the entry drawer
// and the import both post shapes two of the routes have to agree about.
//
// Money is an exact decimal string on the wire, matching the `numeric` columns
// behind it. A `z.number()` anywhere in this file would be a rounded cent.

import { z } from "zod";

import { problem, readJsonBody } from "@/lib/kith/api-route";

export const kithIdSchema = z.string().min(1).max(128);
export const amountSchema = z.string().regex(/^\d{1,20}(\.\d{1,6})?$/);
export const rateSchema = z.string().regex(/^\d{1,10}(\.\d{1,10})?$/);
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
export const statusSchema = z.enum(["active", "closed", "written_off"]);
export const entryTypeSchema = z.enum([
  "capital_call_paid",
  "distribution",
  "commitment",
  "commitment_change",
  "fee",
  "write_off",
  "other",
]);

export const createInvestmentSchema = z.object({
  spaceId: kithIdSchema,
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100).nullish(),
  signedOn: isoDateSchema.nullish(),
  status: statusSchema.optional(),
  notes: z.string().min(1).max(4_000).nullish(),
});

export const patchInvestmentSchema = z.object({
  id: kithIdSchema,
  name: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(100).nullish(),
  signedOn: isoDateSchema.nullish(),
  status: statusSchema.optional(),
  notes: z.string().min(1).max(4_000).nullish(),
});

export const archiveInvestmentSchema = z.object({
  id: kithIdSchema,
  archived: z.boolean().optional(),
});

export const createEntrySchema = z.object({
  entryType: entryTypeSchema,
  entryDate: isoDateSchema,
  amount: amountSchema,
  currency: currencySchema.optional(),
  exchangeRate: rateSchema.nullish(),
  note: z.string().min(1).max(4_000).nullish(),
  documentId: kithIdSchema.nullish(),
  importKey: z.string().min(1).max(512).nullish(),
});

export const patchEntrySchema = z.object({
  entryId: kithIdSchema,
  entryType: entryTypeSchema.optional(),
  entryDate: isoDateSchema.optional(),
  amount: amountSchema.optional(),
  currency: currencySchema.optional(),
  exchangeRate: rateSchema.nullish(),
  note: z.string().min(1).max(4_000).nullish(),
  documentId: kithIdSchema.nullish(),
});

export const deleteEntrySchema = z.object({ entryId: kithIdSchema });

export const suggestSchema = z.object({
  amount: amountSchema.optional(),
  entryDate: isoDateSchema.optional(),
});

/** The request body, parsed, or the 400 to send instead. */
export async function parsedBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ value: T } | { response: Response }> {
  const body = await readJsonBody(request);
  if (body === null) return { response: problem(400, "Invalid request") };
  const result = schema.safeParse(body);
  if (!result.success) {
    return { response: problem(400, "Invalid request", "invalid_input") };
  }
  return { value: result.data };
}
