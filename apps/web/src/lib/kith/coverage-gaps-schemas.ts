import { z } from "zod";

export const acknowledgeCoverageGapSchema = z.object({
  id: z.string().min(1).max(128),
  action: z.enum(["mark_unavailable", "mark_not_expected"]),
  note: z.string().trim().min(1).max(1_000).optional(),
});

export type CoverageGapAcknowledgementInput = z.infer<
  typeof acknowledgeCoverageGapSchema
>;
