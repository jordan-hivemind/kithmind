import { v } from "convex/values";

import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "../../_generated/server";
import { normalizeEntityName, resolveEntity } from "../facts/model";
import { entityKind } from "../facts/validators";

import {
  CARD_SCHEMAS,
  cardEntityKinds,
  cardEventEntityField,
  isCardRecordKind,
  isEntityCapableField,
  type CardRecordKind,
} from "./cardSchemas";

/**
 * P2-70l, section 4.4 of docs/plans/2026-09-12-document-cards.md.
 *
 * Binding is a separate, deterministic step that runs after extraction has
 * already been accepted, never inside it. Extraction stores the literal name
 * with its span; this file decides, with no model in the loop, whether that
 * name names an entity the space already knows.
 *
 * | Matches after normalization | Result                                     |
 * | --------------------------- | ------------------------------------------ |
 * | Exactly one                 | `observations.boundEntityId` is set        |
 * | Zero                        | Pending `entity_binding_needed` review row |
 * | Two or more                 | Pending `entity_binding_needed` review row |
 *
 * Nothing here ever creates or merges an entity. Minting one from a literal
 * name is `createEntityFromCard`, which a person invokes explicitly.
 */

/**
 * ponytail: one bounded scan of the space's entities per binding pass, and
 * an in-memory match on `normalizedName` and `normalizedAliases`. Convex
 * indexes an array field by its whole value, so an alias cannot be looked up
 * through `by_spaceId_kind_normalizedName`, and an alias is exactly what
 * `bindCardEntity` writes so the next card binds by itself. Upgrade path if
 * a space ever passes the bound: a one-row-per-alias index table, written
 * where aliases are written. Until then a space past the bound never
 * auto-binds, so the failure is a review item, never a wrong binding.
 */
const MAX_ENTITY_SCAN_ROWS = 1_024;

/** One re-extraction's worth of stale pending rows for the same document. */
const MAX_STALE_BINDING_ROWS = 64;

const MAX_LITERAL_NAME_CHARS = 200;
const MAX_NOTE_CHARS = 500;
const DEFAULT_REBIND_BATCH = 64;
const MAX_REBIND_BATCH = 256;

type EntityIndex = {
  byNormalizedName: Map<string, Doc<"entities">[]>;
  /** True when the space holds more entities than one pass may read. */
  truncated: boolean;
};

export async function loadSpaceEntityIndex(
  ctx: Pick<QueryCtx, "db">,
  spaceId: Id<"spaces">,
): Promise<EntityIndex> {
  const rows = await ctx.db
    .query("entities")
    .withIndex("by_spaceId", (q) => q.eq("spaceId", spaceId))
    .take(MAX_ENTITY_SCAN_ROWS + 1);
  const truncated = rows.length > MAX_ENTITY_SCAN_ROWS;
  const byNormalizedName = new Map<string, Doc<"entities">[]>();
  const add = (name: string, entity: Doc<"entities">) => {
    const list = byNormalizedName.get(name);
    if (!list) {
      byNormalizedName.set(name, [entity]);
    } else if (!list.some((row) => row._id === entity._id)) {
      // A name that is both an entity's canonical name and one of its own
      // aliases is still one candidate, not two.
      list.push(entity);
    }
  };
  for (const entity of rows.slice(0, MAX_ENTITY_SCAN_ROWS)) {
    add(entity.normalizedName, entity);
    for (const alias of entity.normalizedAliases) add(alias, entity);
  }
  return { byNormalizedName, truncated };
}

/** Normalizes with the same function that wrote `entities.normalizedName`,
 * so a lookup can never disagree with what was stored. An unusable name
 * (empty, or longer than an entity name may be) matches nothing. */
export function normalizeLiteralName(literalName: string): string {
  try {
    return normalizeEntityName(literalName);
  } catch {
    return "";
  }
}

export type NameResolution = {
  normalizedName: string;
  candidateCount: number;
  /** Set only when exactly one candidate was found in a complete scan. */
  entity?: Doc<"entities">;
};

export function resolveLiteralName(
  index: EntityIndex,
  literalName: string,
  allowedKinds?: readonly Doc<"entities">["kind"][],
): NameResolution {
  const normalizedName = normalizeLiteralName(literalName);
  if (!normalizedName) return { normalizedName: "", candidateCount: 0 };
  const matched = index.byNormalizedName.get(normalizedName) ?? [];
  const candidates = allowedKinds
    ? matched.filter((entity) => allowedKinds.includes(entity.kind))
    : matched;
  // A truncated scan may have missed a second match, so it never binds. The
  // count is still reported honestly on the review row.
  if (candidates.length === 1 && !index.truncated) {
    return { normalizedName, candidateCount: 1, entity: candidates[0]! };
  }
  return { normalizedName, candidateCount: candidates.length };
}

/** The literal name a bindable observation carries, or `undefined` when the
 * observation is not an entity-capable, literal-name card field. */
function bindableLiteralName(
  observation: Doc<"observations">,
): string | undefined {
  if (!isCardRecordKind(observation.eventType)) return undefined;
  const field =
    CARD_SCHEMAS[observation.eventType].fields[observation.observationType];
  if (!field || !isEntityCapableField(field)) return undefined;
  // Only a literal name binds. The gate never stores an `entity` value, so a
  // value of any other type here is a field that is not a name.
  if (observation.value.type !== "text") return undefined;
  return observation.value.value;
}

/**
 * Section 4.5. When this observation is its card kind's event-entity field,
 * the event moves to the bound entity so an entity-filtered `list_events`
 * returns the card. The event version and its observations move together,
 * and the previous value is returned so the binding row can record what a
 * rollback restores.
 */
async function repointCardEvent(
  ctx: MutationCtx,
  observation: Doc<"observations">,
  entity: Doc<"entities">,
): Promise<Id<"entities"> | undefined> {
  if (!isCardRecordKind(observation.eventType)) return undefined;
  if (cardEventEntityField(observation.eventType) !== observation.observationType) {
    return undefined;
  }
  const allowed = cardEntityKinds(observation.eventType);
  if (allowed && !allowed.includes(entity.kind)) return undefined;
  const eventVersion = await ctx.db.get(observation.eventVersionId);
  if (!eventVersion || eventVersion.spaceId !== observation.spaceId) {
    throw new Error("Card event version is missing");
  }
  if (eventVersion.entityId === entity._id) return undefined;
  const previousEventEntityId = eventVersion.entityId;
  await ctx.db.patch(eventVersion._id, { entityId: entity._id });
  const siblings = await ctx.db
    .query("observations")
    .withIndex("by_eventVersionId", (q) =>
      q.eq("eventVersionId", eventVersion._id),
    )
    .collect();
  for (const sibling of siblings) {
    if (sibling.entityId === entity._id) continue;
    await ctx.db.patch(sibling._id, { entityId: entity._id });
  }
  return previousEventEntityId;
}

/** The one place an observation is ever bound. Every caller, automatic or
 * human, goes through it, so the event-entity rule cannot diverge. */
async function applyBinding(
  ctx: MutationCtx,
  observation: Doc<"observations">,
  entity: Doc<"entities">,
): Promise<{ previousEventEntityId?: Id<"entities"> }> {
  if (entity.spaceId !== observation.spaceId) {
    throw new Error("Bound entity belongs to another space");
  }
  await ctx.db.patch(observation._id, { boundEntityId: entity._id });
  const previousEventEntityId = await repointCardEvent(ctx, observation, entity);
  return previousEventEntityId === undefined
    ? {}
    : { previousEventEntityId };
}

async function pendingRowFor(
  ctx: Pick<QueryCtx, "db">,
  observationId: Id<"observations">,
): Promise<Doc<"cardEntityBindings"> | null> {
  const rows = await ctx.db
    .query("cardEntityBindings")
    .withIndex("by_observationId", (q) => q.eq("observationId", observationId))
    .take(2);
  return rows.find((row) => row.status === "pending") ?? rows[0] ?? null;
}

export type BindCardObservationsResult = {
  bound: number;
  /** Fields left literal-only, each with a pending review row. */
  review: number;
};

/**
 * Runs the binding step over one freshly published card's stored fields.
 * Called by `publishDocumentCard` after activation, which is what keeps it
 * separate from extraction: the fields are already accepted and stored, and
 * nothing here can change whether a card published.
 */
export async function bindCardObservations(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceAccountId: Id<"sourceAccounts">;
    sourceItemId: Id<"sourceItems">;
    processingGenerationId: Id<"processingGenerations">;
    recordKind: CardRecordKind;
    observationIds: readonly Id<"observations">[];
    now: number;
  },
): Promise<BindCardObservationsResult> {
  await dropStalePendingRows(ctx, input.sourceItemId, input.processingGenerationId);
  const eventEntityField = cardEventEntityField(input.recordKind);
  const entityKinds = cardEntityKinds(input.recordKind);
  let index: EntityIndex | undefined;
  let bound = 0;
  let review = 0;
  for (const observationId of input.observationIds) {
    const observation = await ctx.db.get(observationId);
    if (!observation || observation.spaceId !== input.spaceId) continue;
    if (observation.boundEntityId) continue;
    const literalName = bindableLiteralName(observation);
    if (literalName === undefined) continue;
    index ??= await loadSpaceEntityIndex(ctx, input.spaceId);
    const resolution = resolveLiteralName(
      index,
      literalName,
      observation.observationType === eventEntityField ? entityKinds : undefined,
    );
    if (resolution.entity) {
      await applyBinding(ctx, observation, resolution.entity);
      bound += 1;
      continue;
    }
    await ctx.db.insert("cardEntityBindings", {
      spaceId: input.spaceId,
      sourceAccountId: input.sourceAccountId,
      sourceItemId: input.sourceItemId,
      processingGenerationId: input.processingGenerationId,
      eventId: observation.eventId,
      observationId: observation._id,
      recordKind: input.recordKind,
      fieldKey: observation.observationKey,
      observationType: observation.observationType,
      literalName,
      normalizedName: resolution.normalizedName,
      candidateCount: resolution.candidateCount,
      status: "pending",
      createdAt: input.now,
    });
    review += 1;
  }
  return { bound, review };
}

/**
 * Re-extraction publishes a new card generation whose observations are new
 * rows. The previous generation's still-pending rows point at observations
 * that are no longer current, so they would double the review count for one
 * unresolved name. A pending row is derived state, not evidence: it is
 * dropped and re-raised against the current generation. A resolved row is
 * the audit note of a decision and is never touched.
 */
async function dropStalePendingRows(
  ctx: MutationCtx,
  sourceItemId: Id<"sourceItems">,
  processingGenerationId: Id<"processingGenerations">,
): Promise<void> {
  const rows = await ctx.db
    .query("cardEntityBindings")
    .withIndex("by_sourceItemId", (q) => q.eq("sourceItemId", sourceItemId))
    .take(MAX_STALE_BINDING_ROWS);
  for (const row of rows) {
    if (row.status !== "pending") continue;
    if (row.processingGenerationId === processingGenerationId) continue;
    await ctx.db.delete(row._id);
  }
}

function boundedNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const trimmed = note.trim();
  if (!trimmed || trimmed.length > MAX_NOTE_CHARS) {
    throw new Error(`Note must contain 1-${MAX_NOTE_CHARS} characters`);
  }
  return trimmed;
}

/** Writes the audit note: which entity, decided by whom, and when. One row
 * per observation, whether or not a pending review row already existed. */
async function recordDecision(
  ctx: MutationCtx,
  input: {
    observation: Doc<"observations">;
    literalName: string;
    entity: Doc<"entities">;
    action: "bound" | "created" | "rebound";
    actorUserId?: Id<"users">;
    previousEventEntityId?: Id<"entities">;
    note?: string;
    now: number;
  },
): Promise<Id<"cardEntityBindings">> {
  const resolution = {
    action: input.action,
    entityId: input.entity._id,
    ...(input.previousEventEntityId === undefined
      ? {}
      : { previousEventEntityId: input.previousEventEntityId }),
    ...(input.actorUserId === undefined
      ? {}
      : { actorUserId: input.actorUserId }),
    decidedAt: input.now,
    ...(input.note === undefined ? {} : { note: input.note }),
  };
  const existing = await pendingRowFor(ctx, input.observation._id);
  if (existing) {
    if (existing.status === "resolved") {
      // Single use, the same rule every other review item follows.
      throw new Error("This card field binding was already decided");
    }
    await ctx.db.patch(existing._id, { status: "resolved", resolution });
    return existing._id;
  }
  return await ctx.db.insert("cardEntityBindings", {
    spaceId: input.observation.spaceId,
    sourceAccountId: input.observation.sourceAccountId,
    sourceItemId: input.observation.sourceItemId,
    processingGenerationId: input.observation.processingGenerationId,
    eventId: input.observation.eventId,
    observationId: input.observation._id,
    recordKind: input.observation.eventType as CardRecordKind,
    fieldKey: input.observation.observationKey,
    observationType: input.observation.observationType,
    literalName: input.literalName,
    normalizedName: normalizeLiteralName(input.literalName),
    candidateCount: 1,
    status: "resolved",
    createdAt: input.now,
    resolution,
  });
}

async function requireBindableObservation(
  ctx: MutationCtx,
  observationId: Id<"observations">,
): Promise<{ observation: Doc<"observations">; literalName: string }> {
  const observation = await ctx.db.get(observationId);
  if (!observation) throw new Error("Card observation does not exist");
  const literalName = bindableLiteralName(observation);
  if (literalName === undefined) {
    throw new Error("This card field does not carry a bindable entity name");
  }
  return { observation, literalName };
}

/**
 * Adds the literal name to the entity as an alias, which is what makes the
 * next card carrying that name bind by itself and what the rebind job of
 * section 4.4 then acts on. Bounded to the same 20 aliases `resolveEntity`
 * keeps, and a no-op when the name is already the canonical name or an
 * alias.
 */
async function addAlias(
  ctx: MutationCtx,
  entity: Doc<"entities">,
  literalName: string,
  now: number,
): Promise<void> {
  const normalized = normalizeLiteralName(literalName);
  if (!normalized || normalized === entity.normalizedName) return;
  if (entity.normalizedAliases.includes(normalized)) return;
  if (entity.normalizedAliases.length >= 20) {
    throw new Error("Entity already carries the maximum number of aliases");
  }
  const canonical = literalName.trim().slice(0, MAX_LITERAL_NAME_CHARS);
  await ctx.db.patch(entity._id, {
    aliases: [...entity.aliases, canonical],
    normalizedAliases: [...entity.normalizedAliases, normalized],
    updatedAt: now,
  });
}

/**
 * The reviewed operator decision: bind one card field's literal name to an
 * entity that already exists. It records the decision and, by adding the
 * literal name as an alias, makes every later card carrying that name bind
 * automatically.
 */
export const bindCardEntity = internalMutation({
  args: {
    observationId: v.id("observations"),
    entityId: v.id("entities"),
    actorUserId: v.id("users"),
    note: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const note = boundedNote(args.note);
    const { observation, literalName } = await requireBindableObservation(
      ctx,
      args.observationId,
    );
    const entity = await ctx.db.get(args.entityId);
    if (!entity || entity.spaceId !== observation.spaceId) {
      throw new Error("Bound entity belongs to another space");
    }
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor) throw new Error("Binding actor does not exist");
    const applied = await applyBinding(ctx, observation, entity);
    await addAlias(ctx, entity, literalName, now);
    const bindingId = await recordDecision(ctx, {
      observation,
      literalName,
      entity,
      action: "bound",
      actorUserId: args.actorUserId,
      ...applied,
      ...(note === undefined ? {} : { note }),
      now,
    });
    return { bindingId, entityId: entity._id, ...applied };
  },
});

/**
 * The other reviewed operator decision: mint an entity from a card's literal
 * name. Never automatic, and never reachable from extraction: a person names
 * the kind, which is the judgment the pipeline is not allowed to guess.
 * Reuses the same `resolveEntity` the `remember_fact` path uses, so a card
 * and a fact that name the same thing land on the same entity.
 */
export const createEntityFromCard = internalMutation({
  args: {
    observationId: v.id("observations"),
    kind: entityKind,
    key: v.optional(v.string()),
    actorUserId: v.id("users"),
    note: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const note = boundedNote(args.note);
    const { observation, literalName } = await requireBindableObservation(
      ctx,
      args.observationId,
    );
    const actor = await ctx.db.get(args.actorUserId);
    if (!actor) throw new Error("Binding actor does not exist");
    const entity = await resolveEntity(
      ctx,
      args.actorUserId,
      observation.spaceId,
      {
        kind: args.kind,
        name: literalName,
        ...(args.key === undefined ? {} : { key: args.key }),
      },
    );
    const applied = await applyBinding(ctx, observation, entity);
    await addAlias(ctx, entity, literalName, now);
    const bindingId = await recordDecision(ctx, {
      observation,
      literalName,
      entity,
      action: "created",
      actorUserId: args.actorUserId,
      ...applied,
      ...(note === undefined ? {} : { note }),
      now,
    });
    return { bindingId, entityId: entity._id, ...applied };
  },
});

/**
 * Section 4.4, third rule of P2-70l. An entity that gains an alias makes
 * some pending names resolvable. This pages one space's pending rows and
 * binds every one that now matches exactly one entity, leaving the rest
 * pending. It is idempotent: a row it binds becomes resolved and is not read
 * again, and a row it cannot bind is unchanged.
 */
export const rebindPendingCardEntities = internalMutation({
  args: {
    spaceId: v.id("spaces"),
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const batchSize = args.batchSize ?? DEFAULT_REBIND_BATCH;
    if (
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > MAX_REBIND_BATCH
    ) {
      throw new Error(`batchSize must be an integer from 1 to ${MAX_REBIND_BATCH}`);
    }
    const page = await ctx.db
      .query("cardEntityBindings")
      .withIndex("by_space_status_name", (q) =>
        q.eq("spaceId", args.spaceId).eq("status", "pending"),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });
    const index = await loadSpaceEntityIndex(ctx, args.spaceId);
    let bound = 0;
    let stillPending = 0;
    for (const row of page.page) {
      const observation = await ctx.db.get(row.observationId);
      if (!observation || observation.boundEntityId) {
        // The observation is gone or was bound by an operator in the
        // meantime. Either way this row is no longer pending work.
        await ctx.db.delete(row._id);
        continue;
      }
      const entityKinds = isCardRecordKind(row.recordKind)
        ? cardEventEntityField(row.recordKind) === row.observationType
          ? cardEntityKinds(row.recordKind)
          : undefined
        : undefined;
      const resolution = resolveLiteralName(index, row.literalName, entityKinds);
      if (!resolution.entity) {
        if (resolution.candidateCount !== row.candidateCount) {
          await ctx.db.patch(row._id, {
            candidateCount: resolution.candidateCount,
          });
        }
        stillPending += 1;
        continue;
      }
      const applied = await applyBinding(ctx, observation, resolution.entity);
      await ctx.db.patch(row._id, {
        status: "resolved",
        candidateCount: 1,
        resolution: {
          action: "rebound",
          entityId: resolution.entity._id,
          ...applied,
          decidedAt: now,
        },
      });
      bound += 1;
    }
    return {
      bound,
      stillPending,
      cursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    };
  },
});
