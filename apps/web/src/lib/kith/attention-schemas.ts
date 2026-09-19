// What `/api/kith/attention*` validates with.
//
// Same reason `investment-schemas.ts` states for its own existence: this
// module has to be safe to import from the client bundle (the attention
// table validates a bulk action's shape before it ever sends one), so the
// enum values are spelled out here rather than imported from
// `@repo/kith-store`, which would pull the whole server-side store in behind
// it.

import { z } from "zod";

export const kithIdSchema = z.string().min(1).max(128);

export const attentionStateSchema = z.enum([
  "open",
  "resolved",
  "dismissed",
  "snoozed",
]);

export const attentionSeveritySchema = z.enum(["info", "attention", "alert"]);

export const dismissReasonSchema = z.enum([
  "not_worth_backfilling",
  "not_mine",
  "duplicate",
  "wrong_detector",
  "other",
]);

// `investment` and `before_date` are refused here even though the database
// allows both on `kith.attention_mutes.scope_kind` -- see
// `MUTE_SCOPE_KINDS` in `packages/kith-store/src/admin/attention.ts` for
// why accepting them would be a mute that silently never fires.
export const muteScopeKindSchema = z.enum([
  "detector",
  "source_root",
  "document_kind",
]);

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const attentionFilterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ids"), ids: z.array(kithIdSchema).min(1).max(500) }),
  z.object({ kind: z.literal("detector"), detector: z.string().min(1).max(100) }),
  z.object({
    kind: z.literal("documentKind"),
    documentKind: z.string().min(1).max(100),
  }),
  z.object({ kind: z.literal("investment"), investmentId: kithIdSchema }),
  z.object({ kind: z.literal("beforeDate"), beforeDate: isoDateSchema }),
]);
export type AttentionFilter = z.infer<typeof attentionFilterSchema>;
export type DismissReason = z.infer<typeof dismissReasonSchema>;

export const dismissAttentionSchema = z.object({
  action: z.literal("dismiss"),
  id: kithIdSchema,
  reason: dismissReasonSchema,
});

export const bulkDismissAttentionSchema = z.object({
  action: z.literal("dismissBulk"),
  spaceId: kithIdSchema,
  filter: attentionFilterSchema,
  reason: dismissReasonSchema,
});

export const deleteAttentionSchema = z.discriminatedUnion("action", [
  dismissAttentionSchema,
  bulkDismissAttentionSchema,
]);

export const undoAttentionSchema = z.object({
  action: z.literal("undo"),
  id: kithIdSchema,
});

export const snoozeAttentionSchema = z.object({
  action: z.literal("snooze"),
  id: kithIdSchema,
  until: isoDateSchema,
});

export const bulkSnoozeAttentionSchema = z.object({
  action: z.literal("snoozeBulk"),
  spaceId: kithIdSchema,
  filter: attentionFilterSchema,
  until: isoDateSchema,
});

export const patchAttentionSchema = z.discriminatedUnion("action", [
  undoAttentionSchema,
  snoozeAttentionSchema,
  bulkSnoozeAttentionSchema,
]);

export const countAttentionFilterSchema = z.object({
  spaceId: kithIdSchema,
  filter: attentionFilterSchema,
});

export const addMuteSchema = z.object({
  spaceId: kithIdSchema,
  scopeKind: muteScopeKindSchema,
  scopeValue: z.string().min(1).max(512),
  reason: z.string().min(1).max(2_000).nullish(),
});

/** Days a "Snooze 7 days" / "Snooze 30 days" toolbar or kebab action adds to
 * today's date, client side, before it becomes the `until` ISO date the
 * routes take. Not server state -- just the two choices the UI offers. */
export const SNOOZE_PRESETS_DAYS = [7, 30] as const;
