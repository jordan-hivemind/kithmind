// What the three `/api/kith/investments*` routes validate with.
//
// Here rather than in a route file because Next.js only allows a route module
// to export its handlers and its segment config, and because the entry drawer
// and the import both post shapes two of the routes have to agree about.
//
// Zod and nothing else. The import validates every row against these schemas
// in the browser before it sends anything, so this module is loaded into the
// client bundle: importing `api-route` here (and with it `@repo/kith-store`)
// pulled the whole server-side store in behind it and broke the build.
// `parsedBody` therefore lives in `api-route.ts`, on the server side of that
// line.
//
// Money is an exact decimal string on the wire, matching the `numeric` columns
// behind it. A `z.number()` anywhere in this file would be a rounded cent.

import { z } from "zod";

export const kithIdSchema = z.string().min(1).max(128);
/** An unsigned amount: what every entry type but one may carry. */
export const amountSchema = z.string().regex(/^\d{1,20}(\.\d{1,6})?$/);
/**
 * A signed amount, accepted only for `commitment_change`.
 *
 * Reducing a commitment is a genuinely signed quantity and there is no second
 * entry type meaning "commitment went down". Every other type carries its
 * direction in the type, so a negative capital call is a data error that would
 * subtract from `sent`. `negativeOnlyForCommitmentChange` below refuses it
 * where the type is known, the store refuses it again, and
 * `investment_entries_amount_sign_check` (migration 025) refuses it in the
 * schema.
 */
export const signedAmountSchema = z
  .string()
  .regex(/^-?\d{1,20}(\.\d{1,6})?$/);
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

/** A negative amount is only ever a `commitment_change`. */
function negativeOnlyForCommitmentChange(value: {
  entryType?: string;
  amount?: string;
}): boolean {
  if (value.amount === undefined || !value.amount.startsWith("-")) return true;
  // Absent on a patch means "leave the type alone", and the stored type is
  // what decides. The store re-checks against the merged row.
  return (
    value.entryType === undefined || value.entryType === "commitment_change"
  );
}

const NEGATIVE_MESSAGE =
  "Only a commitment change may be negative; every other type carries its direction in the type";

export const createEntrySchema = z
  .object({
    entryType: entryTypeSchema,
    entryDate: isoDateSchema,
    amount: signedAmountSchema,
    currency: currencySchema.optional(),
    exchangeRate: rateSchema.nullish(),
    note: z.string().min(1).max(4_000).nullish(),
    documentId: kithIdSchema.nullish(),
    importKey: z.string().min(1).max(512).nullish(),
  })
  .refine(negativeOnlyForCommitmentChange, { message: NEGATIVE_MESSAGE });

export const patchEntrySchema = z
  .object({
    entryId: kithIdSchema,
    entryType: entryTypeSchema.optional(),
    entryDate: isoDateSchema.optional(),
    amount: signedAmountSchema.optional(),
    currency: currencySchema.optional(),
    exchangeRate: rateSchema.nullish(),
    note: z.string().min(1).max(4_000).nullish(),
    documentId: kithIdSchema.nullish(),
  })
  .refine(negativeOnlyForCommitmentChange, { message: NEGATIVE_MESSAGE });

export const deleteEntrySchema = z.object({ entryId: kithIdSchema });

export const suggestSchema = z.object({
  amount: amountSchema.optional(),
  entryDate: isoDateSchema.optional(),
});
