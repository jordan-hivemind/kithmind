// The attention queue (ADM-8a): the first slice of section 5 of
// docs/plans/2026-09-19-investment-document-matching.md -- the quiet,
// dismissible queue itself, over what `kith.corrections` (migration 022,
// widened by 030) already is. No matching or detector logic lands here; the
// only producer today is still `src/extraction/corrections.ts`'s
// `openCorrection`, and every row it writes defaults to `severity = 'info'`.
//
// The owner's principle, worth repeating beside every function below because
// it is what each one is shaped to protect: this is a best-effort personal
// store; records will be incomplete; do not chase the owner for information
// he does not have; warnings about holes must never become so noisy that he
// misses what he cares about.
//
// Reads take an already-resolved space set the way `investments.ts` does for
// the admin screen's own notion of who may see this (`getAdminSpaceIds`:
// owner or editor, a reader gets an empty result, never a denial -- see
// `model.ts`'s comment on why the admin panel is a different kind of read
// from what a `reader` member is entitled to). Writes take a `Principal` and
// check `requireSpaceAccess(..., "write")` against the row's own space, so an
// id from a space this principal cannot write reads as not found rather than
// as a 403 that would confirm the row exists.

import type { ClientBase } from "pg";

import {
  type Principal,
  requireSpaceAccess,
} from "../identity/authorization.js";
import { exec, type IdentityCtx, row, rows } from "../identity/db.js";
import { IdentityError } from "../identity/errors.js";
import { assertKithId, newKithId } from "../ids.js";
import { spacePredicate } from "../spaces.js";
import { getAdminSpaceIds } from "./model.js";

export const ATTENTION_STATES = [
  "open",
  "resolved",
  "dismissed",
  "snoozed",
] as const;
export type AttentionState = (typeof ATTENTION_STATES)[number];

export const ATTENTION_SEVERITIES = ["info", "attention", "alert"] as const;
export type AttentionSeverity = (typeof ATTENTION_SEVERITIES)[number];

export const DISMISS_REASONS = [
  "not_worth_backfilling",
  "not_mine",
  "duplicate",
  "wrong_detector",
  "other",
] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

/**
 * What a mute may be scoped to, in this slice.
 *
 * Migration 030's `attention_mutes.scope_kind` CHECK allows two more values,
 * `investment` and `before_date`, and is deliberately left that way (a
 * narrower application-level list costs no migration to widen later). They
 * are refused here rather than accepted: no detector in this slice writes a
 * correction whose target is an investment, and `isAttentionMuted` has no
 * SQL branch for `before_date` at all, so creating either kind today would
 * be a mute that silently never fires -- worse than refusing it, because a
 * mute is a promise the owner is relying on. `investment` arrives with the
 * matching slice that gives it something to scope.
 */
export const MUTE_SCOPE_KINDS = [
  "detector",
  "source_root",
  "document_kind",
] as const;
export type MuteScopeKind = (typeof MUTE_SCOPE_KINDS)[number];

/** The owner reads this a screen at a time. The bound is for a runaway read,
 * not a real page size -- `listAttention`'s own default is far smaller. */
const MAX_ATTENTION_ITEMS = 500;
const DEFAULT_ATTENTION_LIMIT = 100;
const SEARCH_MAX_CHARS = 200;
const REASON_MAX_CHARS = 2_000;

export type AttentionItem = {
  id: string;
  spaceId: string;
  state: AttentionState;
  severity: AttentionSeverity;
  detector: string;
  targetKind: string;
  targetId: string;
  fieldName: string | null;
  reason: string | null;
  originalValue: unknown;
  correctedValue: unknown;
  dedupeKey: string | null;
  /** Epoch ms, not `Date`: every timestamp on this row crosses into JSON at
   * the route boundary, and a `Date` there silently becomes an ISO string
   * that no longer round-trips as one -- the convention `investments.ts`'s
   * own `epoch()` states. */
  createdAt: number;
  resolvedAt: number | null;
  dismissedAt: number | null;
  dismissedBy: string | null;
  dismissReason: DismissReason | null;
  snoozedUntil: number | null;
  /** Populated only for `targetKind === 'document'`, the only kind any
   * detector writes today: the source item extraction opened this row
   * against. Null rather than omitted when there is none, so a caller does
   * not have to guess whether the join simply had nothing to find. */
  document: {
    sourceItemId: string;
    title: string | null;
    uri: string | null;
    kind: string | null;
  } | null;
};

export type AttentionMute = {
  id: string;
  spaceId: string;
  scopeKind: MuteScopeKind;
  scopeValue: string;
  createdBy: string | null;
  createdAt: number;
  reason: string | null;
};

function epoch(value: Date | string | null): number | null {
  if (value === null) return null;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function typedError(code: string, message: string): never {
  throw new IdentityError(message, { code, message });
}

function attentionNotFound(): never {
  throw new IdentityError("Attention item not found");
}

function muteNotFound(): never {
  throw new IdentityError("Attention mute not found");
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    typedError("invalid_input", `${name} is not a known value`);
  }
  return value as T;
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value).length > maximum) {
    typedError("invalid_input", `${name} is empty, malformed or too long`);
  }
  return value.trim();
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDate(value: unknown, name: string): string {
  if (typeof value !== "string" || !DATE.test(value)) {
    typedError("invalid_input", `${name} must be an ISO date`);
  }
  return value;
}

/**
 * Whether a space has a standing mute (`kith.attention_mutes`) matching a
 * row a detector is about to open.
 *
 * Prospective only, the way section 4 of the plan states it: "a suppressed
 * key is never written rather than written and then hidden." This never
 * sweeps rows that already exist -- a mute added today does not retroactively
 * hide what already opened before it.
 *
 * Takes a bare `ClientBase` rather than an `IdentityCtx` so
 * `src/extraction/corrections.ts` (which has only the former mid-transaction)
 * can call it without constructing a context around a client it does not own.
 */
export async function isAttentionMuted(
  client: ClientBase,
  spaceId: string,
  scope: {
    detector: string;
    documentKind?: string | null;
    investmentId?: string | null;
    sourceRootId?: string | null;
  },
): Promise<boolean> {
  const conditions = ["(scope_kind = 'detector' AND scope_value = $2)"];
  const values: unknown[] = [spaceId, scope.detector];
  if (scope.documentKind) {
    values.push(scope.documentKind);
    conditions.push(`(scope_kind = 'document_kind' AND scope_value = $${values.length})`);
  }
  if (scope.investmentId) {
    values.push(scope.investmentId);
    conditions.push(`(scope_kind = 'investment' AND scope_value = $${values.length})`);
  }
  if (scope.sourceRootId) {
    values.push(scope.sourceRootId);
    conditions.push(`(scope_kind = 'source_root' AND scope_value = $${values.length})`);
  }
  const found = await client.query(
    `SELECT 1 FROM kith.attention_mutes
      WHERE space_id = $1 AND (${conditions.join(" OR ")}) LIMIT 1`,
    values,
  );
  return (found.rowCount ?? 0) > 0;
}

type AttentionDbRow = {
  id: string;
  space_id: string;
  state: AttentionState;
  severity: AttentionSeverity;
  detector: string;
  target_kind: string;
  target_id: string;
  field_name: string | null;
  reason: string | null;
  original_value: unknown;
  corrected_value: unknown;
  dedupe_key: string | null;
  created_at: Date;
  resolved_at: Date | null;
  dismissed_at: Date | null;
  dismissed_by: string | null;
  dismiss_reason: DismissReason | null;
  snoozed_until: Date | null;
  document_title: string | null;
  document_uri: string | null;
  document_kind: string | null;
};

function toAttentionItem(record: AttentionDbRow): AttentionItem {
  return {
    id: record.id,
    spaceId: record.space_id,
    state: record.state,
    severity: record.severity,
    detector: record.detector,
    targetKind: record.target_kind,
    targetId: record.target_id,
    fieldName: record.field_name,
    reason: record.reason,
    originalValue: record.original_value ?? null,
    correctedValue: record.corrected_value ?? null,
    dedupeKey: record.dedupe_key,
    createdAt: epoch(record.created_at)!,
    resolvedAt: epoch(record.resolved_at),
    dismissedAt: epoch(record.dismissed_at),
    dismissedBy: record.dismissed_by,
    dismissReason: record.dismiss_reason,
    snoozedUntil: epoch(record.snoozed_until),
    document:
      record.target_kind === "document"
        ? {
            sourceItemId: record.target_id,
            title: record.document_title,
            uri: record.document_uri,
            kind: record.document_kind,
          }
        : null,
  };
}

/**
 * `c.state = ANY(states)`, widened so a `snoozed` row whose `snoozed_until`
 * has passed counts as `open` when the caller asked for `open` -- section 5:
 * snooze "hides the row from the default filter ... until it passes", which
 * only holds if the row comes back on its own once it does. No sweep exists
 * in this slice to flip `snoozed` back to `open` in the database, so this is
 * a read-time wake rather than a write: the row's own state is untouched
 * until the owner (or a future sweep) acts on it.
 */
function stateClause(
  states: readonly AttentionState[],
  now: Date,
  values: unknown[],
): string {
  values.push(states);
  const base = `c.state = ANY($${values.length}::text[])`;
  if (!states.includes("open")) return base;
  values.push(now);
  return `(${base} OR (c.state = 'snoozed' AND c.snoozed_until <= $${values.length}))`;
}

const ATTENTION_SELECT = `
  SELECT c.id, c.space_id, c.state, c.severity, c.detector, c.target_kind,
         c.target_id, c.field_name, c.reason, c.original_value,
         c.corrected_value, c.dedupe_key, c.created_at, c.resolved_at,
         c.dismissed_at, c.dismissed_by, c.dismiss_reason, c.snoozed_until,
         si.title AS document_title, si.uri AS document_uri,
         de.kind AS document_kind
    FROM kith.corrections c
    LEFT JOIN kith.source_items si
      ON c.target_kind = 'document' AND si.id = c.target_id
         AND si.space_id = c.space_id
    LEFT JOIN kith.document_extractions de
      ON c.target_kind = 'document' AND de.source_item_id = c.target_id
         AND de.space_id = c.space_id`;

/**
 * The queue's one read: filtered, searched and paged.
 *
 * `state` defaults to `['open']` and `severity` to `['attention', 'alert']`
 * -- section 5's "default view shows open items of severity attention and
 * alert; info items are one click away, never in the badge." A caller that
 * wants `info` too (the screen's "Show info" toggle) names every severity it
 * wants explicitly; there is no way to ask for "unfiltered" by omission, so a
 * caller can never forget the default and see more than the owner asked for.
 *
 * Paged with a plain numeric offset, the same shape `reviewQueue.ts`'s
 * `paginateArray` already uses in this package: the household's queue is
 * screen-sized, not the kind of table a keyset cursor earns its complexity
 * for.
 */
export async function listAttention(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    spaceIds?: readonly string[];
    state?: readonly AttentionState[];
    severity?: readonly AttentionSeverity[];
    detector?: string;
    targetKind?: string;
    targetId?: string;
    search?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<{ items: AttentionItem[]; nextCursor: string | null }> {
  const spaces = await getAdminSpaceIds(ctx, args.principal, args.spaceIds);
  if (spaces.length === 0) return { items: [], nextCursor: null };

  const states = (args.state ?? ["open"]).map((value) =>
    oneOf(value, ATTENTION_STATES, "State"),
  );
  const severities = (args.severity ?? ["attention", "alert"]).map((value) =>
    oneOf(value, ATTENTION_SEVERITIES, "Severity"),
  );
  const limit = Math.min(
    Math.max(1, Number.isSafeInteger(args.limit) ? args.limit! : DEFAULT_ATTENTION_LIMIT),
    MAX_ATTENTION_ITEMS,
  );
  const offset = args.cursor === undefined ? 0 : Number(args.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    typedError("invalid_cursor", "Invalid cursor");
  }

  const predicate = spacePredicate(spaces, 1, "c.space_id");
  const values: unknown[] = [predicate.value];
  const clauses = [predicate.sql, stateClause(states, new Date(ctx.now), values)];

  if (severities.length > 0) {
    values.push(severities);
    clauses.push(`c.severity = ANY($${values.length}::text[])`);
  }
  if (args.detector !== undefined) {
    values.push(boundedText(args.detector, "Detector", 100));
    clauses.push(`c.detector = $${values.length}`);
  }
  if (args.targetKind !== undefined) {
    values.push(boundedText(args.targetKind, "Target kind", 50));
    clauses.push(`c.target_kind = $${values.length}`);
  }
  if (args.targetId !== undefined) {
    values.push(boundedText(args.targetId, "Target id", 512));
    clauses.push(`c.target_id = $${values.length}`);
  }
  if (args.search !== undefined && args.search.trim() !== "") {
    const term = `%${boundedText(args.search, "Search", SEARCH_MAX_CHARS)}%`;
    values.push(term);
    const at = values.length;
    clauses.push(
      `(c.field_name ILIKE $${at} OR c.reason ILIKE $${at} OR c.detector ILIKE $${at}
        OR si.title ILIKE $${at})`,
    );
  }

  values.push(limit + 1);
  const limitParam = values.length;
  values.push(offset);
  const offsetParam = values.length;

  const records = await rows<AttentionDbRow>(
    ctx,
    `${ATTENTION_SELECT}
      WHERE ${clauses.join(" AND ")}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}`,
    values,
  );
  const hasMore = records.length > limit;
  return {
    items: records.slice(0, limit).map(toAttentionItem),
    nextCursor: hasMore ? String(offset + limit) : null,
  };
}

/**
 * The nav badge: open items (plus a snoozed item whose wake date has
 * passed -- see `stateClause`) of severity `attention` or `alert`, never
 * `info` -- section 5's "counts by severity for a nav badge that counts ONLY
 * attention and alert, never info." A still-snoozed item does not count: the
 * badge is "what needs a look today", and a snoozed item is exactly the one
 * the owner said not to show him yet.
 */
export async function attentionSeverityCounts(
  ctx: IdentityCtx,
  args: { principal: Principal; spaceIds?: readonly string[] },
): Promise<{ attention: number; alert: number }> {
  const spaces = await getAdminSpaceIds(ctx, args.principal, args.spaceIds);
  if (spaces.length === 0) return { attention: 0, alert: 0 };
  const predicate = spacePredicate(spaces, 1, "c.space_id");
  const values: unknown[] = [predicate.value];
  const clauses = [predicate.sql, stateClause(["open"], new Date(ctx.now), values)];
  const counted = await rows<{ severity: AttentionSeverity; n: string }>(
    ctx,
    `SELECT c.severity, count(*)::text AS n FROM kith.corrections c
      WHERE ${clauses.join(" AND ")}
        AND c.severity IN ('attention', 'alert')
      GROUP BY c.severity`,
    values,
  );
  const result = { attention: 0, alert: 0 };
  for (const record of counted) {
    if (record.severity === "attention") result.attention = Number(record.n);
    else if (record.severity === "alert") result.alert = Number(record.n);
  }
  return result;
}

/** The row, if this principal may write the space it belongs to. A row in a
 * space this principal cannot write reads as not found, the same
 * non-enumerating denial `investments.ts`'s `writableInvestment` uses. */
async function writableAttentionItem(
  ctx: IdentityCtx,
  principal: Principal,
  id: string,
): Promise<{ id: string; spaceId: string; state: AttentionState }> {
  const itemId = assertKithId(id, "invalid_attention_id");
  const record = await row<{ space_id: string; state: AttentionState }>(
    ctx,
    "SELECT space_id, state FROM kith.corrections WHERE id = $1",
    [itemId],
  );
  if (!record) attentionNotFound();
  try {
    await requireSpaceAccess(ctx, principal, record.space_id, "write");
  } catch (error) {
    if (error instanceof IdentityError && error.message === "Space not found") {
      attentionNotFound();
    }
    throw error;
  }
  return { id: itemId, spaceId: record.space_id, state: record.state };
}

/**
 * The state machine every single-row transition below agrees to: `open` and
 * `snoozed` accept both dismiss and snooze; `dismissed` accepts dismiss
 * (idempotent) but refuses snooze (undo it first -- snoozing a permanently
 * dismissed row would be a back door around "remembered forever"); and
 * `resolved` -- an owner correction, or a condition `supersedeOpenCorrections`
 * already cleared -- refuses both, because there is nothing open about it to
 * act on. Refusing rather than silently clearing `resolved_at` also means no
 * caller can hit `corrections_resolved_check` or `corrections_snoozed_check`:
 * every UPDATE below fully owns the columns the other states use, but only
 * ever runs from a state where crossing into it is a real decision.
 */
function refuseUnlessTransitionAllowed(
  action: "dismiss" | "snooze",
  state: AttentionState,
): void {
  if (state === "resolved") {
    typedError(
      "already_resolved",
      `This item is already resolved and cannot be ${action === "dismiss" ? "dismissed" : "snoozed"}`,
    );
  }
  if (action === "snooze" && state === "dismissed") {
    typedError("already_dismissed", "This item is dismissed; undo it before snoozing");
  }
}

/**
 * Dismiss, permanently: "not worth backfilling" and the other closed
 * reasons. Remembered forever by `dedupe_key` -- `openCorrection`'s lookup
 * refuses to reopen a `dismissed` row, so a detector re-finding the same
 * problem (the same field failing the gate again, or, once a real detector
 * exists, the same missing-document key) never brings it back.
 *
 * Idempotent: dismissing an already-dismissed row updates the reason and
 * leaves `dismissed_at` where it was, because "when was this dismissed"
 * should not move because the owner clicked twice. Dismissing a `snoozed`
 * row is also allowed (the owner snoozed it, then decided not to see it
 * again) and clears `snoozed_until` in the same statement -- left set, it
 * would violate `corrections_snoozed_check` the moment `state` stopped
 * being `snoozed`.
 */
export async function dismissAttention(
  ctx: IdentityCtx,
  args: { principal: Principal; id: string; reason: DismissReason },
): Promise<void> {
  const target = await writableAttentionItem(ctx, args.principal, args.id);
  refuseUnlessTransitionAllowed("dismiss", target.state);
  const reason = oneOf(args.reason, DISMISS_REASONS, "Dismiss reason");
  await exec(
    ctx,
    `UPDATE kith.corrections SET
       state = 'dismissed',
       dismissed_at = coalesce(dismissed_at, transaction_timestamp()),
       dismissed_by = $2, dismiss_reason = $3,
       snoozed_until = NULL, resolved_at = NULL
     WHERE id = $1`,
    [target.id, args.principal.userId, reason],
  );
}

/** Puts a dismissed row back to `open`. Not offered for a `resolved` row --
 * there is nothing to undo once the condition itself has cleared. */
export async function undoDismissAttention(
  ctx: IdentityCtx,
  args: { principal: Principal; id: string },
): Promise<void> {
  const target = await writableAttentionItem(ctx, args.principal, args.id);
  if (target.state !== "dismissed") {
    typedError("not_dismissed", "This item is not dismissed");
  }
  await exec(
    ctx,
    `UPDATE kith.corrections SET
       state = 'open', dismissed_at = NULL, dismissed_by = NULL,
       dismiss_reason = NULL
     WHERE id = $1`,
    [target.id],
  );
}

/**
 * Hides a row from the default view and from every alert until `until` (an
 * ISO date) passes. Section 5: "hides the row from the default filter and
 * from every alert until it passes."
 *
 * Re-snoozing an already-`snoozed` row (to change the date) is allowed and
 * clears nothing extra -- only `snoozed_until` itself changes. Snoozing a
 * `dismissed` row is refused (see `refuseUnlessTransitionAllowed`); an
 * `open` row snoozing for the first time clears `dismissed_at`,
 * `dismissed_by`, `dismiss_reason` and `resolved_at` defensively, though an
 * `open` row's invariants already guarantee all four are null.
 */
export async function snoozeAttention(
  ctx: IdentityCtx,
  args: { principal: Principal; id: string; until: string },
): Promise<void> {
  const target = await writableAttentionItem(ctx, args.principal, args.id);
  refuseUnlessTransitionAllowed("snooze", target.state);
  const until = isoDate(args.until, "Snooze until");
  await exec(
    ctx,
    `UPDATE kith.corrections SET
       state = 'snoozed', snoozed_until = $2,
       dismissed_at = NULL, dismissed_by = NULL, dismiss_reason = NULL,
       resolved_at = NULL
      WHERE id = $1`,
    [target.id, until],
  );
}

/**
 * One filter, four shapes: an explicit id list, or a class the plan names --
 * a whole detector, a whole document kind, a whole investment, or every
 * document dated before a date (see the `beforeDate` case below for what
 * "dated" means -- it is never `corrections.created_at`).
 *
 * `investment` is accepted and validated here for the same forward-
 * compatibility reason `kith.attention_mutes.scope_kind` includes it: no
 * detector in this slice writes a correction whose target is an investment
 * (`corrections.target_kind` is still `document | field | record`), so this
 * class matches nothing today. It is wired rather than left out because the
 * plan names it as one of the four and a future detector should not need a
 * second bulk-filter shape to use it.
 */
export type AttentionFilter =
  | { kind: "ids"; ids: readonly string[] }
  | { kind: "detector"; detector: string }
  | { kind: "documentKind"; documentKind: string }
  | { kind: "investment"; investmentId: string }
  | { kind: "beforeDate"; beforeDate: string };

function filterClause(
  filter: AttentionFilter,
  values: unknown[],
): string {
  switch (filter.kind) {
    case "ids": {
      if (filter.ids.length === 0 || filter.ids.length > MAX_ATTENTION_ITEMS) {
        typedError("invalid_input", "ids must be 1-500 items");
      }
      values.push(filter.ids.map((id) => assertKithId(id, "invalid_attention_id")));
      return `c.id = ANY($${values.length}::text[])`;
    }
    case "detector":
      values.push(boundedText(filter.detector, "Detector", 100));
      return `c.detector = $${values.length}`;
    case "documentKind":
      values.push(boundedText(filter.documentKind, "Document kind", 100));
      return `c.target_kind = 'document' AND EXISTS (
        SELECT 1 FROM kith.document_extractions de
         WHERE de.source_item_id = c.target_id AND de.space_id = c.space_id
           AND de.kind = $${values.length})`;
    case "investment":
      // See the module comment above: never matches today.
      values.push(assertKithId(filter.investmentId, "invalid_investment_id"));
      return `c.target_kind = 'investment' AND c.target_id = $${values.length}`;
    case "beforeDate": {
      // The *document's* date, not `corrections.created_at` (when the row
      // was opened, which can be long after the paper itself and says
      // nothing about "how old is the stuff I never filed"). Preferred:
      // the extraction's own occurrence date -- the first date-typed field
      // the model read off the document (`prepared.occurrence` in
      // `model.ts`), carried on the `document_statement` event's current
      // version. Falls back to the source item's own provider-reported
      // modified time when the document states no date, or has not been
      // extracted at all. A document offering neither is skipped -- never
      // matched -- rather than judged by when this table happened to open
      // a row for it.
      values.push(isoDate(filter.beforeDate, "Before date"));
      const at = values.length;
      return `c.target_kind = 'document' AND EXISTS (
        SELECT 1 FROM kith.source_items si
         WHERE si.id = c.target_id AND si.space_id = c.space_id
           AND coalesce(
             (
               SELECT ev.occurrence_date::date
                 FROM kith.document_extractions de
                 JOIN kith.event_versions ev
                   ON ev.event_id = de.event_id AND ev.space_id = de.space_id
                WHERE de.source_item_id = si.id AND de.space_id = si.space_id
                ORDER BY ev.created_at DESC LIMIT 1
             ),
             si.worker_source_modified_at::date
           ) < $${at}::date
      )`;
    }
  }
}

/**
 * How many open-or-snoozed rows a filter would touch, without touching them.
 * The "Dismiss everything before [date]" control is unbounded and owner-
 * visible, so its confirm dialog states a real count rather than "some" --
 * this is what it calls first.
 */
export async function countAttentionByFilter(
  ctx: IdentityCtx,
  args: { principal: Principal; spaceId: string; filter: AttentionFilter },
): Promise<number> {
  const spaceId = assertKithId(args.spaceId, "invalid_space_id");
  await requireSpaceAccess(ctx, args.principal, spaceId, "write");
  const values: unknown[] = [spaceId];
  const clause = filterClause(args.filter, values);
  const counted = await row<{ n: string }>(
    ctx,
    `SELECT count(*)::text AS n FROM kith.corrections c
      WHERE c.space_id = $1 AND c.state IN ('open', 'snoozed') AND ${clause}`,
    values,
  );
  return Number(counted?.n ?? 0);
}

/**
 * Bulk dismiss: the same permanent, remembered dismissal as
 * `dismissAttention`, applied to every open-or-snoozed row the filter
 * matches in one space. Returns how many rows it touched, for the toolbar's
 * confirmation.
 */
export async function bulkDismissAttention(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    spaceId: string;
    filter: AttentionFilter;
    reason: DismissReason;
  },
): Promise<{ count: number }> {
  const spaceId = assertKithId(args.spaceId, "invalid_space_id");
  await requireSpaceAccess(ctx, args.principal, spaceId, "write");
  const reason = oneOf(args.reason, DISMISS_REASONS, "Dismiss reason");
  const values: unknown[] = [spaceId, args.principal.userId, reason];
  const clause = filterClause(args.filter, values);
  const result = await ctx.client.query(
    // `snoozed_until = NULL`: the WHERE below matches `snoozed` rows too,
    // and leaving it set on a row that is about to become `dismissed`
    // violates `corrections_snoozed_check` the instant the UPDATE commits.
    `UPDATE kith.corrections c SET
       state = 'dismissed', dismissed_at = transaction_timestamp(),
       dismissed_by = $2, dismiss_reason = $3, snoozed_until = NULL
     WHERE c.space_id = $1 AND c.state IN ('open', 'snoozed') AND ${clause}`,
    values,
  );
  return { count: result.rowCount ?? 0 };
}

/** Bulk snooze, the multi-select toolbar's other bulk action. */
export async function bulkSnoozeAttention(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    spaceId: string;
    filter: AttentionFilter;
    until: string;
  },
): Promise<{ count: number }> {
  const spaceId = assertKithId(args.spaceId, "invalid_space_id");
  await requireSpaceAccess(ctx, args.principal, spaceId, "write");
  const until = isoDate(args.until, "Snooze until");
  const values: unknown[] = [spaceId, until];
  const clause = filterClause(args.filter, values);
  const result = await ctx.client.query(
    `UPDATE kith.corrections c SET state = 'snoozed', snoozed_until = $2
      WHERE c.space_id = $1 AND c.state = 'open' AND ${clause}`,
    values,
  );
  return { count: result.rowCount ?? 0 };
}

/** Every standing mute in this principal's administered spaces. */
export async function listAttentionMutes(
  ctx: IdentityCtx,
  args: { principal: Principal; spaceIds?: readonly string[] },
): Promise<AttentionMute[]> {
  const spaces = await getAdminSpaceIds(ctx, args.principal, args.spaceIds);
  if (spaces.length === 0) return [];
  const predicate = spacePredicate(spaces, 1, "space_id");
  const records = await rows<{
    id: string;
    space_id: string;
    scope_kind: MuteScopeKind;
    scope_value: string;
    created_by: string | null;
    created_at: Date;
    reason: string | null;
  }>(
    ctx,
    `SELECT id, space_id, scope_kind, scope_value, created_by, created_at, reason
       FROM kith.attention_mutes WHERE ${predicate.sql}
      ORDER BY created_at DESC, id LIMIT $2`,
    [predicate.value, MAX_ATTENTION_ITEMS],
  );
  return records.map((record) => ({
    id: record.id,
    spaceId: record.space_id,
    scopeKind: record.scope_kind,
    scopeValue: record.scope_value,
    createdBy: record.created_by,
    createdAt: epoch(record.created_at)!,
    reason: record.reason,
  }));
}

/** A standing suppression: "do not open items for this detector / document
 * kind / investment / source root", or "everything before this date".
 * Idempotent on `(space_id, scope_kind, scope_value)` (migration 030's unique
 * index): adding the same mute twice returns the existing row rather than
 * erroring or duplicating it. */
export async function addAttentionMute(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    spaceId: string;
    scopeKind: MuteScopeKind;
    scopeValue: string;
    reason?: string | null;
  },
): Promise<string> {
  const spaceId = assertKithId(args.spaceId, "invalid_space_id");
  await requireSpaceAccess(ctx, args.principal, spaceId, "write");
  const scopeKind = oneOf(args.scopeKind, MUTE_SCOPE_KINDS, "Scope kind");
  const scopeValue = boundedText(args.scopeValue, "Scope value", 512);
  const reason =
    args.reason === null || args.reason === undefined || args.reason === ""
      ? null
      : boundedText(args.reason, "Reason", REASON_MAX_CHARS);
  const existing = await row<{ id: string }>(
    ctx,
    `SELECT id FROM kith.attention_mutes
      WHERE space_id = $1 AND scope_kind = $2 AND scope_value = $3`,
    [spaceId, scopeKind, scopeValue],
  );
  if (existing) return existing.id;
  const id = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.attention_mutes
       (id, space_id, scope_kind, scope_value, created_by, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, spaceId, scopeKind, scopeValue, args.principal.userId, reason],
  );
  return id;
}

export async function removeAttentionMute(
  ctx: IdentityCtx,
  args: { principal: Principal; id: string },
): Promise<void> {
  const id = assertKithId(args.id, "invalid_mute_id");
  const record = await row<{ space_id: string }>(
    ctx,
    "SELECT space_id FROM kith.attention_mutes WHERE id = $1",
    [id],
  );
  if (!record) muteNotFound();
  try {
    await requireSpaceAccess(ctx, args.principal, record.space_id, "write");
  } catch (error) {
    if (error instanceof IdentityError && error.message === "Space not found") {
      muteNotFound();
    }
    throw error;
  }
  await exec(ctx, "DELETE FROM kith.attention_mutes WHERE id = $1", [id]);
}
