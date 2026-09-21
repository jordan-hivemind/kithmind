// Ported from packages/convex/convex/models/facts/model.ts (the entity half)
// and models/records/cardEntityBinding.ts (`loadSpaceEntityIndex`,
// `normalizeLiteralName`, `resolveLiteralName` -- the P2-70l bounded alias
// scan).
//
// `normalizeEntityName` is kept exactly as P2-70l2 asked: one function, used
// unchanged by every caller that needs to turn a display name into the string
// `entities.normalized_name` and `entities.normalized_aliases` actually store.
// P2-70l2 exists because that agreement broke once already in the Convex tree
// (a second, slightly different normalizer would have accepted a name the
// stored one would reject); this module is the one place it is defined so a
// later port (P2-39f's card entity binding, when it moves here) imports it
// rather than writing its own.
//
// Every function below takes an `IdentityCtx` (client plus a fixed `now`) and
// an already-authorized `spaceId`. Space authorization is the caller's job
// (section 2.5): `rememberFact` in `facts.ts` checks it once before calling
// `resolveEntity`.

import {
  scheduleInvestmentLinksForEntity,
  withLinkEnqueueSavepoint,
} from "../admin/investmentLinkWork.js";
import {
  type Principal,
  requireSpaceAccess,
} from "../identity/authorization.js";
import { row, rows, exec, ms, type IdentityCtx } from "../identity/db.js";
import { IdentityError } from "../identity/errors.js";
import { assertKithId, newKithId } from "../ids.js";

export type EntityKind =
  "person" | "organization" | "project" | "place" | "vehicle" | "other";

const ENTITY_KINDS = new Set<string>([
  "person",
  "organization",
  "project",
  "place",
  "vehicle",
  "other",
]);

export type EntitySelector = {
  key?: string;
  kind: EntityKind;
  name: string;
  aliases?: readonly string[];
};

export type Entity = {
  id: string;
  spaceId: string;
  userId: string;
  key: string;
  kind: EntityKind;
  canonicalName: string;
  normalizedName: string;
  aliases: readonly string[];
  normalizedAliases: readonly string[];
  mergedIntoId: string | null;
  createdAt: number;
  updatedAt: number | null;
};

type EntityRow = {
  id: string;
  space_id: string;
  user_id: string;
  key: string;
  kind: string;
  canonical_name: string;
  normalized_name: string;
  aliases: unknown;
  normalized_aliases: unknown;
  merged_into: string | null;
  created_at: Date;
  updated_at: Date | null;
};

const ENTITY_NAME_MAX_CHARS = 200;
const ENTITY_KEY_MAX_CHARS = 160;

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function toEntity(record: EntityRow): Entity {
  if (!ENTITY_KINDS.has(record.kind)) {
    throw new Error("Entity has an unrecognized kind");
  }
  return {
    id: record.id,
    spaceId: record.space_id,
    userId: record.user_id,
    key: record.key,
    kind: record.kind as EntityKind,
    canonicalName: record.canonical_name,
    normalizedName: record.normalized_name,
    aliases: stringArray(record.aliases),
    normalizedAliases: stringArray(record.normalized_aliases),
    mergedIntoId: record.merged_into,
    createdAt: ms(record.created_at)!,
    updatedAt: ms(record.updated_at),
  };
}

function boundedText(value: string, label: string, maxChars: number): string {
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > maxChars) {
    throw new Error(`${label} must contain 1-${maxChars} characters`);
  }
  return normalized;
}

/** The one normalizer for a display name. Keep this the only copy (P2-70l2). */
export function normalizeEntityName(name: string): string {
  return boundedText(name, "Entity name", ENTITY_NAME_MAX_CHARS)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\s_-]+/g, " ")
    .trim();
}

function slugifyEntityName(name: string): string {
  return normalizeEntityName(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function normalizeEntityKey(
  key: string | undefined,
  kind: EntityKind,
  name: string,
): string {
  const normalized = (key ?? `${kind}:${slugifyEntityName(name)}`)
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
  if (
    !normalized ||
    normalized.length > ENTITY_KEY_MAX_CHARS ||
    !/^[a-z][a-z0-9_-]*:[a-z0-9][a-z0-9._-]*$/.test(normalized)
  ) {
    throw new Error(
      "Entity key must look like person:rowan or organization:openai",
    );
  }
  // A generated key always carries its kind. A supplied one has to agree, or
  // the entity is stored under an identity that contradicts its own kind and
  // every later lookup for that key resolves confusingly.
  if (!normalized.startsWith(`${kind}:`)) {
    throw new Error(`Entity key must begin with its kind, like ${kind}:name`);
  }
  return normalized;
}

function normalizeAliases(
  aliases: readonly string[] | undefined,
  canonicalName: string,
): { aliases: string[]; normalizedAliases: string[] } {
  const byNormalized = new Map<string, string>();
  const canonicalNormalized = normalizeEntityName(canonicalName);
  for (const alias of aliases ?? []) {
    const cleaned = boundedText(alias, "Entity alias", ENTITY_NAME_MAX_CHARS);
    const normalized = normalizeEntityName(cleaned);
    if (normalized !== canonicalNormalized)
      byNormalized.set(normalized, cleaned);
  }
  return {
    aliases: [...byNormalized.values()],
    normalizedAliases: [...byNormalized.keys()],
  };
}

/** One entity row by id, unchecked against any space. Callers space-check. */
async function getEntityRow(
  ctx: IdentityCtx,
  id: string,
): Promise<Entity | null> {
  const record = await row<EntityRow>(
    ctx,
    `SELECT id, space_id, user_id, key, kind, canonical_name, normalized_name,
            aliases, normalized_aliases, merged_into, created_at, updated_at
       FROM kith.entities WHERE id = $1`,
    [assertKithId(id, "invalid_entity_id")],
  );
  return record ? toEntity(record) : null;
}

/**
 * One entity by id, following an explicit merge to its canonical survivor.
 * The bound prevents a corrupted chain from turning a read into an unbounded
 * walk. `mergeEntities` locks both rows and refuses cycles before writing.
 */
export async function getEntity(
  ctx: IdentityCtx,
  id: string,
): Promise<Entity | null> {
  let entity = await getEntityRow(ctx, id);
  const seen = new Set<string>();
  for (let depth = 0; entity?.mergedIntoId && depth < 16; depth += 1) {
    if (seen.has(entity.id)) throw new Error("Entity merge chain is invalid");
    seen.add(entity.id);
    const target = await getEntityRow(ctx, entity.mergedIntoId);
    if (!target || target.spaceId !== entity.spaceId) {
      throw new Error("Entity merge chain is invalid");
    }
    entity = target;
  }
  if (entity?.mergedIntoId) throw new Error("Entity merge chain is too deep");
  return entity;
}

/**
 * Bounded entity discovery for owner tools. Names and aliases are both
 * matched with the same normalizer that writes them, so the caller never has
 * to guess which spelling is canonical.
 */
export async function listEntities(
  ctx: IdentityCtx,
  spaceIds: readonly string[],
  args: {
    kind?: EntityKind;
    name?: string;
    limit?: number;
    cursor?: string;
  } = {},
): Promise<{ entities: Entity[]; nextCursor: string | null }> {
  const uniqueSpaces = [...new Set(spaceIds)].map((id) =>
    assertKithId(id, "invalid_space_id"),
  );
  if (uniqueSpaces.length === 0) return { entities: [], nextCursor: null };
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
  const offset = args.cursor === undefined ? 0 : Number(args.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Invalid cursor");
  }
  const kind = args.kind;
  if (kind !== undefined && !ENTITY_KINDS.has(kind)) {
    throw new Error("Entity kind is invalid");
  }
  const normalizedName = args.name ? normalizeEntityName(args.name) : null;
  const records = await rows<EntityRow>(
    ctx,
    `SELECT id, space_id, user_id, key, kind, canonical_name, normalized_name,
            aliases, normalized_aliases, merged_into, created_at, updated_at
       FROM kith.entities
      WHERE space_id = ANY($1::text[])
        AND merged_into IS NULL
        AND ($2::text IS NULL OR kind = $2)
        AND ($3::text IS NULL OR normalized_name = $3
             OR normalized_aliases ? $3)
      ORDER BY canonical_name, id LIMIT $4 OFFSET $5`,
    [uniqueSpaces, kind ?? null, normalizedName, limit + 1, offset],
  );
  return {
    entities: records.slice(0, limit).map(toEntity),
    nextCursor: records.length > limit ? String(offset + limit) : null,
  };
}

/** Replaces one entity's retrieval and document-matching aliases. */
export async function setEntityAliases(
  ctx: IdentityCtx,
  args: { principal: Principal; entityId: string; aliases: readonly string[] },
): Promise<Entity> {
  const entity = await getEntity(ctx, args.entityId);
  if (!entity) throw new IdentityError("Entity not found");
  try {
    await requireSpaceAccess(ctx, args.principal, entity.spaceId, "write");
  } catch (error) {
    if (error instanceof IdentityError && error.message === "Space not found") {
      throw new IdentityError("Entity not found");
    }
    throw error;
  }
  const normalized = normalizeAliases(args.aliases, entity.canonicalName);
  await exec(
    ctx,
    `UPDATE kith.entities SET aliases = $2::jsonb,
       normalized_aliases = $3::jsonb, updated_at = $4 WHERE id = $1`,
    [
      entity.id,
      JSON.stringify(normalized.aliases),
      JSON.stringify(normalized.normalizedAliases),
      new Date(ctx.now),
    ],
  );
  await withLinkEnqueueSavepoint(ctx, { entityId: entity.id }, () =>
    scheduleInvestmentLinksForEntity(ctx, {
      spaceId: entity.spaceId,
      entityId: entity.id,
    }),
  );
  return (await getEntity(ctx, entity.id))!;
}

/**
 * Resolves a subject or object entity selector to a stored entity row,
 * creating or updating it as needed. Ported from `resolveEntity`.
 *
 * `key: "me"` (or `"person:me"`, or an unqualified name that normalizes to
 * "me") resolves through the caller's own space membership rather than
 * through the entities table: "me" is the authenticated caller's explicit
 * person link, never a name lookup, so it cannot be spoofed by writing an
 * entity whose name happens to be "me".
 */
export async function resolveEntity(
  ctx: IdentityCtx,
  userId: string,
  spaceId: string,
  selector: EntitySelector,
): Promise<Entity> {
  const canonicalName = boundedText(
    selector.name,
    "Entity name",
    ENTITY_NAME_MAX_CHARS,
  );
  const normalizedName = normalizeEntityName(canonicalName);
  const requestedKey = selector.key
    ?.trim()
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
  const selectsMe =
    selector.kind === "person" &&
    (requestedKey === "me" ||
      requestedKey === "person:me" ||
      (requestedKey === undefined && normalizedName === "me"));
  if (selectsMe) {
    const memberships = await rows<{ person_entity_id: string | null }>(
      ctx,
      `SELECT person_entity_id FROM kith.space_members WHERE space_id = $1 AND user_id = $2 LIMIT 2`,
      [spaceId, userId],
    );
    if (memberships.length !== 1 || !memberships[0]!.person_entity_id) {
      throw new Error("Me is not linked to a person in this space");
    }
    const person = await getEntity(ctx, memberships[0]!.person_entity_id);
    if (!person || person.kind !== "person" || person.spaceId !== spaceId) {
      throw new Error("Me is not linked to a person in this space");
    }
    return person;
  }

  let resolvedKey = selector.key;
  if (resolvedKey === undefined) {
    const index = await loadSpaceEntityIndex(ctx, spaceId);
    // Only the requested primary name proves identity. Incoming aliases are
    // metadata and may legitimately overlap across people (for example, two
    // different people both known as "Sam").
    const resolution = resolveLiteralName(index, canonicalName, [
      selector.kind,
    ]);
    if (resolution.entity) {
      resolvedKey = resolution.entity.key;
    } else if (resolution.candidateCount > 0 || index.truncated) {
      throw new Error("Entity name is ambiguous; provide an explicit key");
    }
  }
  const key = normalizeEntityKey(resolvedKey, selector.kind, canonicalName);
  const incomingAliases = normalizeAliases(selector.aliases, canonicalName);
  const existing = await row<EntityRow>(
    ctx,
    `SELECT id, space_id, user_id, key, kind, canonical_name, normalized_name,
            aliases, normalized_aliases, merged_into, created_at, updated_at
       FROM kith.entities WHERE space_id = $1 AND key = $2`,
    [spaceId, key],
  );

  if (existing) {
    const entity = (await getEntity(ctx, existing.id))!;
    if (entity.kind !== selector.kind) {
      throw new Error("Entity key is already assigned to a different kind");
    }
    const aliasMap = new Map<string, string>();
    entity.normalizedAliases.forEach((alias, index) =>
      aliasMap.set(alias, entity.aliases[index] ?? alias),
    );
    incomingAliases.normalizedAliases.forEach((alias, index) =>
      aliasMap.set(alias, incomingAliases.aliases[index] ?? alias),
    );
    if (entity.normalizedName !== normalizedName) {
      aliasMap.set(normalizedName, canonicalName);
    }
    const mergedAliases = [...aliasMap.values()];
    const mergedNormalizedAliases = [...aliasMap.keys()];
    // Did this resolve actually teach the entity a name it did not have? The
    // merge appends, so a comparison of the normalized list against the
    // stored one answers it exactly. Almost every call arrives with nothing
    // new -- the same organization named the same way, one fact after
    // another -- and those must wake nothing.
    const aliasesChanged =
      mergedNormalizedAliases.length !== entity.normalizedAliases.length ||
      mergedNormalizedAliases.some(
        (alias, index) => alias !== entity.normalizedAliases[index],
      );
    await exec(
      ctx,
      `UPDATE kith.entities
          SET aliases = $2::jsonb, normalized_aliases = $3::jsonb, updated_at = $4
        WHERE id = $1`,
      [
        entity.id,
        JSON.stringify(mergedAliases),
        JSON.stringify(mergedNormalizedAliases),
        new Date(ctx.now),
      ],
    );
    if (aliasesChanged) {
      // ADM-8c: the investment matcher compares a document's parties against
      // this entity's aliases, so a new alias changes what that document is
      // about -- and nothing else in the system observes it. The investment
      // row has not been touched and no entry has moved.
      //
      // Inside a savepoint: this is the system's own work in the middle of
      // capturing a fact, and a queue row that cannot be written must not
      // cost the owner the fact. See `withLinkEnqueueSavepoint`.
      await withLinkEnqueueSavepoint(ctx, { entityId: entity.id }, () =>
        scheduleInvestmentLinksForEntity(ctx, {
          spaceId,
          entityId: entity.id,
        }),
      );
    }
    return (await getEntity(ctx, entity.id))!;
  }

  const id = newKithId();
  await exec(
    ctx,
    `INSERT INTO kith.entities
       (id, space_id, user_id, key, kind, canonical_name, normalized_name,
        aliases, normalized_aliases)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
    [
      id,
      spaceId,
      userId,
      key,
      selector.kind,
      canonicalName,
      normalizedName,
      JSON.stringify(incomingAliases.aliases),
      JSON.stringify(incomingAliases.normalizedAliases),
    ],
  );
  return (await getEntity(ctx, id))!;
}

// ---------------------------------------------------------------------------
// The P2-70l bounded alias scan, ported from `models/records/cardEntityBinding.ts`
// so a later domain (card entity binding) that needs "does this literal name
// resolve to exactly one entity in this space" can call one implementation
// instead of re-deriving it against this schema.
// ---------------------------------------------------------------------------

/**
 * ponytail: one bounded scan of the space's entities, and an in-memory match
 * on `normalizedName` and `normalizedAliases`. Upgrade path if a space ever
 * passes the bound: a one-row-per-alias index table, written where aliases
 * are written. Until then a space past the bound never auto-resolves by name,
 * so the failure is a reported truncation, never a wrong match.
 */
export const MAX_ENTITY_SCAN_ROWS = 1_024;

export type EntityIndex = {
  byNormalizedName: ReadonlyMap<string, readonly Entity[]>;
  /** True when the space holds more entities than one pass may read. */
  truncated: boolean;
};

export async function loadSpaceEntityIndex(
  ctx: IdentityCtx,
  spaceId: string,
): Promise<EntityIndex> {
  const records = await rows<EntityRow>(
    ctx,
    `SELECT id, space_id, user_id, key, kind, canonical_name, normalized_name,
            aliases, normalized_aliases, merged_into, created_at, updated_at
       FROM kith.entities WHERE space_id = $1 AND merged_into IS NULL LIMIT $2`,
    [assertKithId(spaceId, "invalid_space_id"), MAX_ENTITY_SCAN_ROWS + 1],
  );
  const truncated = records.length > MAX_ENTITY_SCAN_ROWS;
  const byNormalizedName = new Map<string, Entity[]>();
  const add = (name: string, entity: Entity) => {
    const list = byNormalizedName.get(name);
    if (!list) {
      byNormalizedName.set(name, [entity]);
    } else if (!list.some((candidate) => candidate.id === entity.id)) {
      // A name that is both an entity's canonical name and one of its own
      // aliases is still one candidate, not two.
      list.push(entity);
    }
  };
  for (const record of records.slice(0, MAX_ENTITY_SCAN_ROWS).map(toEntity)) {
    add(record.normalizedName, record);
    for (const alias of record.normalizedAliases) add(alias, record);
  }
  return { byNormalizedName, truncated };
}

/**
 * Normalizes with the same function that wrote `entities.normalized_name`, so
 * a lookup can never disagree with what was stored. An unusable name (empty,
 * or longer than an entity name may be) matches nothing.
 */
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
  entity?: Entity;
};

export function resolveLiteralName(
  index: EntityIndex,
  literalName: string,
  allowedKinds?: readonly EntityKind[],
): NameResolution {
  const normalizedName = normalizeLiteralName(literalName);
  if (!normalizedName) return { normalizedName: "", candidateCount: 0 };
  const matched = index.byNormalizedName.get(normalizedName) ?? [];
  const candidates = allowedKinds
    ? matched.filter((entity) => allowedKinds.includes(entity.kind))
    : matched;
  // A truncated scan may have missed a second match, so it never resolves.
  // The count is still reported honestly.
  if (candidates.length === 1 && !index.truncated) {
    return { normalizedName, candidateCount: 1, entity: candidates[0]! };
  }
  return { normalizedName, candidateCount: candidates.length };
}
