import { repointCoverageEntity } from "../coverage/model.js";
import {
  type Principal,
  requireSpaceAccess,
} from "../identity/authorization.js";
import { exec, ms, row, rows, type IdentityCtx } from "../identity/db.js";
import { IdentityError } from "../identity/errors.js";
import { assertKithId } from "../ids.js";
import {
  FACT_COLUMNS,
  type FactRow,
  type HydratedFact,
  hydrateFact,
  rememberFact,
  storedFactFromRow,
} from "./facts.js";
import {
  getEntity,
  loadSpaceEntityIndex,
  normalizeEntityName,
  resolveEntity,
  resolveLiteralName,
  type Entity,
  type EntityKind,
} from "./entities.js";
import {
  scheduleInvestmentLinksForEntity,
  withLinkEnqueueSavepoint,
} from "../admin/investmentLinkWork.js";

export type ProfileKind = "person" | "vehicle";
export type ProfileValueType =
  "text" | "date" | "datetime" | "number" | "boolean" | "entity";

export type ProfilePredicate = {
  predicate: string;
  subjectKind: ProfileKind;
  label: string;
  group: string;
  valueType: ProfileValueType;
  cardinality: "single" | "multiple";
  history: boolean;
  sensitivity: "normal" | "sensitive" | "restricted";
  objectKinds?: readonly EntityKind[];
  example: string;
};

const person = (
  predicate: string,
  label: string,
  group: string,
  valueType: ProfileValueType,
  cardinality: "single" | "multiple",
  history: boolean,
  sensitivity: ProfilePredicate["sensitivity"],
  example: string,
  objectKinds?: readonly EntityKind[],
): ProfilePredicate => ({
  predicate,
  subjectKind: "person",
  label,
  group,
  valueType,
  cardinality,
  history,
  sensitivity,
  ...(objectKinds ? { objectKinds } : {}),
  example,
});

const vehicle = (
  predicate: string,
  label: string,
  valueType: ProfileValueType,
  history: boolean,
  sensitivity: ProfilePredicate["sensitivity"],
  example: string,
): ProfilePredicate => ({
  predicate,
  subjectKind: "vehicle",
  label,
  group: "vehicle",
  valueType,
  cardinality: "single",
  history,
  sensitivity,
  example,
});

/** Starter vocabulary for tool guidance. It never gates custom predicates. */
export const PROFILE_PREDICATES: readonly ProfilePredicate[] = Object.freeze([
  person(
    "legal_name",
    "Legal name",
    "identity",
    "text",
    "single",
    true,
    "normal",
    "full legal name",
  ),
  person(
    "preferred_name",
    "Preferred name",
    "identity",
    "text",
    "single",
    true,
    "normal",
    "name used daily",
  ),
  person(
    "date_of_birth",
    "Date of birth",
    "identity",
    "date",
    "single",
    false,
    "sensitive",
    "YYYY-MM-DD",
  ),
  person(
    "place_of_birth",
    "Place of birth",
    "identity",
    "text",
    "single",
    false,
    "sensitive",
    "city and country",
  ),
  person(
    "citizenship",
    "Citizenship",
    "identity",
    "text",
    "multiple",
    true,
    "sensitive",
    "country name",
  ),
  person(
    "home_address",
    "Home address",
    "contact",
    "text",
    "single",
    true,
    "sensitive",
    "street address",
  ),
  person(
    "mailing_address",
    "Mailing address",
    "contact",
    "text",
    "single",
    true,
    "sensitive",
    "mailing address",
  ),
  person(
    "mobile_phone",
    "Mobile phone",
    "contact",
    "text",
    "multiple",
    true,
    "sensitive",
    "+14155550100",
  ),
  person(
    "email_address",
    "Email address",
    "contact",
    "text",
    "multiple",
    true,
    "normal",
    "name@example.com",
  ),
  person(
    "parent",
    "Parent",
    "relationships",
    "entity",
    "multiple",
    false,
    "normal",
    "named person",
    ["person"],
  ),
  person(
    "mother",
    "Mother",
    "relationships",
    "entity",
    "multiple",
    false,
    "normal",
    "named person",
    ["person"],
  ),
  person(
    "father",
    "Father",
    "relationships",
    "entity",
    "multiple",
    false,
    "normal",
    "named person",
    ["person"],
  ),
  person(
    "child",
    "Child",
    "relationships",
    "entity",
    "multiple",
    false,
    "normal",
    "named person",
    ["person"],
  ),
  person(
    "son",
    "Son",
    "relationships",
    "entity",
    "multiple",
    false,
    "normal",
    "named person",
    ["person"],
  ),
  person(
    "daughter",
    "Daughter",
    "relationships",
    "entity",
    "multiple",
    false,
    "normal",
    "named person",
    ["person"],
  ),
  person(
    "spouse",
    "Spouse or partner",
    "relationships",
    "entity",
    "single",
    true,
    "normal",
    "named person",
    ["person"],
  ),
  person(
    "partner",
    "Partner",
    "relationships",
    "entity",
    "single",
    true,
    "normal",
    "named person",
    ["person"],
  ),
  person(
    "husband",
    "Husband",
    "relationships",
    "entity",
    "single",
    true,
    "normal",
    "named person",
    ["person"],
  ),
  person(
    "wife",
    "Wife",
    "relationships",
    "entity",
    "single",
    true,
    "normal",
    "named person",
    ["person"],
  ),
  person(
    "sibling",
    "Sibling",
    "relationships",
    "entity",
    "multiple",
    false,
    "normal",
    "named person",
    ["person"],
  ),
  person(
    "brother",
    "Brother",
    "relationships",
    "entity",
    "multiple",
    false,
    "normal",
    "named person",
    ["person"],
  ),
  person(
    "sister",
    "Sister",
    "relationships",
    "entity",
    "multiple",
    false,
    "normal",
    "named person",
    ["person"],
  ),
  person(
    "guardian",
    "Guardian",
    "relationships",
    "entity",
    "multiple",
    true,
    "normal",
    "named person",
    ["person"],
  ),
  person(
    "emergency_contact",
    "Emergency contact",
    "relationships",
    "entity",
    "multiple",
    true,
    "sensitive",
    "named person",
    ["person"],
  ),
  person(
    "employer",
    "Employer",
    "employment",
    "entity",
    "single",
    true,
    "normal",
    "organization",
    ["organization"],
  ),
  person(
    "job_title",
    "Job title",
    "employment",
    "text",
    "single",
    true,
    "normal",
    "current title",
  ),
  person(
    "allergy",
    "Allergy",
    "health",
    "text",
    "multiple",
    true,
    "sensitive",
    "one allergen",
  ),
  person(
    "medication",
    "Medication",
    "health",
    "text",
    "multiple",
    true,
    "sensitive",
    "one medication",
  ),
  person(
    "blood_type",
    "Blood type",
    "health",
    "text",
    "single",
    false,
    "sensitive",
    "O+",
  ),
  person(
    "primary_care_provider",
    "Primary care provider",
    "health",
    "entity",
    "single",
    true,
    "sensitive",
    "person or organization",
    ["person", "organization"],
  ),
  person(
    "ssn",
    "Social Security number",
    "identifiers",
    "text",
    "single",
    false,
    "restricted",
    "full identifier",
  ),
  person(
    "passport_number",
    "Passport number",
    "identifiers",
    "text",
    "single",
    true,
    "restricted",
    "full identifier",
  ),
  person(
    "licence_number",
    "Driver licence number",
    "identifiers",
    "text",
    "single",
    true,
    "restricted",
    "full identifier",
  ),
  person(
    "insurance_member_number",
    "Insurance member number",
    "identifiers",
    "text",
    "single",
    true,
    "restricted",
    "full identifier",
  ),
  person(
    "passport_expires_on",
    "Passport expiry",
    "dates",
    "date",
    "single",
    true,
    "sensitive",
    "YYYY-MM-DD",
  ),
  person(
    "licence_expires_on",
    "Licence expiry",
    "dates",
    "date",
    "single",
    true,
    "sensitive",
    "YYYY-MM-DD",
  ),
  person(
    "wedding_anniversary",
    "Wedding anniversary",
    "dates",
    "date",
    "single",
    false,
    "normal",
    "YYYY-MM-DD",
  ),
  person(
    "supporting_document",
    "Supporting document",
    "documents",
    "text",
    "multiple",
    true,
    "normal",
    "stable source item ID",
  ),
  vehicle(
    "vin",
    "VIN",
    "text",
    false,
    "restricted",
    "full vehicle identification number",
  ),
  vehicle("make", "Make", "text", true, "normal", "Toyota"),
  vehicle("model", "Model", "text", true, "normal", "RAV4"),
  vehicle("year", "Model year", "number", true, "normal", "2024"),
  vehicle("plate", "Licence plate", "text", true, "sensitive", "full plate"),
  vehicle(
    "purchased_on",
    "Purchase date",
    "date",
    true,
    "sensitive",
    "YYYY-MM-DD",
  ),
  {
    predicate: "supporting_document",
    subjectKind: "vehicle",
    label: "Supporting document",
    group: "documents",
    valueType: "text",
    cardinality: "multiple",
    history: true,
    sensitivity: "normal",
    example: "stable source item ID",
  },
]);

export function listProfilePredicates(
  kind?: ProfileKind,
): readonly ProfilePredicate[] {
  return kind
    ? PROFILE_PREDICATES.filter((entry) => entry.subjectKind === kind)
    : PROFILE_PREDICATES;
}

const catalogByKindAndPredicate = new Map(
  PROFILE_PREDICATES.map((entry) => [
    `${entry.subjectKind}:${entry.predicate}`,
    entry,
  ]),
);

const RELATIONSHIP_PREDICATES = new Set([
  "parent",
  "mother",
  "father",
  "child",
  "son",
  "daughter",
  "spouse",
  "partner",
  "husband",
  "wife",
  "sibling",
  "brother",
  "sister",
  "guardian",
  "emergency_contact",
]);

const RELATIONSHIP_LABELS: Readonly<Record<string, readonly string[]>> = {
  parent: ["parent", "mother", "father"],
  mother: ["mother"],
  father: ["father"],
  child: ["child", "son", "daughter"],
  son: ["son"],
  daughter: ["daughter"],
  spouse: ["spouse", "husband", "wife"],
  partner: ["partner"],
  husband: ["husband"],
  wife: ["wife"],
  sibling: ["sibling", "brother", "sister"],
  brother: ["brother"],
  sister: ["sister"],
  guardian: ["guardian"],
  emergency_contact: ["emergency_contact"],
};

export type ProfileSelector =
  | { entityId: string }
  | { name: string; kind?: ProfileKind }
  | { relationship: string };

async function linkedMe(
  ctx: IdentityCtx,
  principal: Principal,
  spaceId: string,
): Promise<Entity> {
  const membership = await row<{ person_entity_id: string | null }>(
    ctx,
    `SELECT person_entity_id FROM kith.space_members
      WHERE space_id = $1 AND user_id = $2 LIMIT 2`,
    [spaceId, principal.userId],
  );
  if (!membership?.person_entity_id) {
    throw new Error("Me is not linked to a person in this space");
  }
  const entity = await getEntity(ctx, membership.person_entity_id);
  if (!entity || entity.spaceId !== spaceId || entity.kind !== "person") {
    throw new Error("Me is not linked to a person in this space");
  }
  return entity;
}

export async function resolveProfileEntity(
  ctx: IdentityCtx,
  principal: Principal,
  spaceId: string,
  selector: ProfileSelector,
): Promise<Entity> {
  await requireSpaceAccess(ctx, principal, spaceId, "read");
  if ("entityId" in selector) {
    const entity = await getEntity(
      ctx,
      assertKithId(selector.entityId, "invalid_entity_id"),
    );
    if (
      !entity ||
      entity.spaceId !== spaceId ||
      (entity.kind !== "person" && entity.kind !== "vehicle")
    ) {
      throw new IdentityError("Profile entity not found");
    }
    return entity;
  }
  if ("name" in selector) {
    const index = await loadSpaceEntityIndex(ctx, spaceId);
    const resolution = resolveLiteralName(
      index,
      selector.name,
      selector.kind ? [selector.kind] : ["person", "vehicle"],
    );
    if (resolution.entity) return resolution.entity;
    if (resolution.candidateCount > 1 || index.truncated) {
      throw new IdentityError("Profile entity is ambiguous");
    }
    throw new IdentityError("Profile entity not found");
  }

  const normalized = selector.relationship
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\s-]+/g, "_");
  const predicates = RELATIONSHIP_LABELS[normalized];
  if (!predicates)
    throw new IdentityError("Relationship label is not recognized");
  const me = await linkedMe(ctx, principal, spaceId);
  const records = await rows<{ entity_id: string }>(
    ctx,
    `SELECT DISTINCT value ->> 'entityId' AS entity_id
       FROM kith.facts
      WHERE space_id = $1 AND subject_entity_id = $2
        AND predicate = ANY($3::text[]) AND status = 'current'
        AND (valid_from IS NULL OR valid_from <= $4)
        AND (valid_to IS NULL OR $4 < valid_to)
        AND value ->> 'type' = 'entity'
      LIMIT 3`,
    [spaceId, me.id, predicates, new Date(ctx.now)],
  );
  if (records.length === 0)
    throw new IdentityError(
      "Relationship is not recorded; use a name or entity ID",
    );
  if (records.length > 1)
    throw new IdentityError(
      "Relationship is ambiguous; use a name or entity ID",
    );
  const entity = await getEntity(ctx, records[0]!.entity_id);
  if (!entity || entity.spaceId !== spaceId || entity.kind !== "person") {
    throw new IdentityError("Profile entity not found");
  }
  return entity;
}

export type ProfileField = {
  factId: string;
  predicate: string;
  label: string;
  group: string;
  value: HydratedFact["value"];
  sensitivity: ProfilePredicate["sensitivity"];
  sourceType: HydratedFact["sourceType"];
  sourceRef: string | null;
  observedAt?: number;
  validFrom?: number;
  validTo?: number;
  historyAvailable: boolean;
  historyFactIds: readonly string[];
};

export type ProfileDocument = {
  id: string | null;
  sourceItemId: string;
  title: string | null;
  kind: string | null;
  date: number | null;
  citation: string;
};

export type EntityProfile = {
  entity: Entity;
  fields: readonly ProfileField[];
  relationships: readonly ProfileField[];
  documents: readonly ProfileDocument[];
  documentsTruncated: boolean;
  catalogKind: ProfileKind;
};

const MAX_PROFILE_FACTS = 500;
const MAX_PROFILE_DOCUMENTS = 100;

export async function getEntityProfile(
  ctx: IdentityCtx,
  principal: Principal,
  spaceId: string,
  selector: ProfileSelector,
): Promise<EntityProfile> {
  const entity = await resolveProfileEntity(ctx, principal, spaceId, selector);
  const factRows = await rows<FactRow>(
    ctx,
    `SELECT ${FACT_COLUMNS} FROM kith.facts
      WHERE space_id = $1 AND subject_entity_id = $2
      ORDER BY created_at DESC, id DESC LIMIT $3`,
    [spaceId, entity.id, MAX_PROFILE_FACTS + 1],
  );
  if (factRows.length > MAX_PROFILE_FACTS)
    throw new Error("Profile fact limit exceeded");
  const stored = factRows.map(storedFactFromRow);
  const currentStored = stored.filter(
    (fact) =>
      fact.status === "current" &&
      (fact.validFrom === undefined || fact.validFrom <= ctx.now) &&
      (fact.validTo === undefined || ctx.now < fact.validTo),
  );
  const hydrated: HydratedFact[] = [];
  for (const fact of currentStored) {
    const value = await hydrateFact(ctx, fact, new Set([spaceId]));
    if (value) hydrated.push(value);
  }
  const historicalByPredicate = new Map<string, string[]>();
  for (const fact of stored) {
    if (
      fact.status === "current" &&
      (fact.validTo === undefined || ctx.now < fact.validTo)
    )
      continue;
    const bucket = historicalByPredicate.get(fact.predicate) ?? [];
    bucket.push(fact.id);
    historicalByPredicate.set(fact.predicate, bucket);
  }
  const kind = entity.kind as ProfileKind;
  const fields = hydrated.map((fact): ProfileField => {
    const catalog = catalogByKindAndPredicate.get(`${kind}:${fact.predicate}`);
    const historyFactIds = historicalByPredicate.get(fact.predicate) ?? [];
    return {
      factId: fact.id,
      predicate: fact.predicate,
      label: catalog?.label ?? fact.predicate.replaceAll("_", " "),
      group: catalog?.group ?? "custom",
      value: fact.value,
      sensitivity: catalog?.sensitivity ?? "normal",
      sourceType: fact.sourceType,
      sourceRef: fact.sourceRef,
      ...(fact.observedAt === undefined ? {} : { observedAt: fact.observedAt }),
      ...(fact.validFrom === undefined ? {} : { validFrom: fact.validFrom }),
      ...(fact.validTo === undefined ? {} : { validTo: fact.validTo }),
      historyAvailable: historyFactIds.length > 0 || fact.supersedes.length > 0,
      historyFactIds,
    };
  });
  const documentRows = await rows<{
    id: string | null;
    source_item_id: string;
    title: string | null;
    kind: string | null;
    captured_at: Date | null;
  }>(
    ctx,
    `WITH related_source_items AS (
       SELECT source_item_id FROM kith.event_versions
        WHERE space_id = $1 AND entity_id = $2
       UNION
       SELECT source_item_id FROM kith.observations
        WHERE space_id = $1 AND (entity_id = $2 OR bound_entity_id = $2
          OR (value ->> 'type' = 'entity' AND value ->> 'entityId' = $2))
       UNION
       SELECT value ->> 'value' AS source_item_id FROM kith.facts
        WHERE space_id = $1 AND subject_entity_id = $2
          AND predicate = 'supporting_document' AND status = 'current'
          AND (valid_from IS NULL OR valid_from <= $4)
          AND (valid_to IS NULL OR $4 < valid_to)
          AND value ->> 'type' = 'text'
     )
     SELECT d.id, i.id AS source_item_id, coalesce(d.title, i.title) AS title,
            coalesce(i.card_doc_type, d.doc_type, i.doc_type) AS kind,
            d.captured_at
       FROM related_source_items r
       JOIN kith.source_items i ON i.id = r.source_item_id AND i.space_id = $1
       LEFT JOIN kith.documents d ON d.source_item_id = i.id AND d.space_id = i.space_id
         AND d.processing_generation_id = i.active_generation_id
         AND d.publication_state = 'active'
      WHERE i.lifecycle = 'available'
      ORDER BY d.captured_at DESC NULLS LAST, d.id DESC LIMIT $3`,
    [spaceId, entity.id, MAX_PROFILE_DOCUMENTS + 1, new Date(ctx.now)],
  );
  const documentsTruncated = documentRows.length > MAX_PROFILE_DOCUMENTS;
  return {
    entity,
    fields: fields.filter(
      (field) => !RELATIONSHIP_PREDICATES.has(field.predicate),
    ),
    relationships: fields.filter((field) =>
      RELATIONSHIP_PREDICATES.has(field.predicate),
    ),
    documents: documentRows.slice(0, MAX_PROFILE_DOCUMENTS).map((document) => ({
      id: document.id,
      sourceItemId: document.source_item_id,
      title: document.title,
      kind: document.kind,
      date: ms(document.captured_at),
      citation: document.id
        ? `document:${document.id}`
        : `source:${document.source_item_id}`,
    })),
    documentsTruncated,
    catalogKind: kind,
  };
}

async function requireWritableEntity(
  ctx: IdentityCtx,
  principal: Principal,
  entityId: string,
): Promise<Entity> {
  const entity = await getEntity(
    ctx,
    assertKithId(entityId, "invalid_entity_id"),
  );
  if (!entity) throw new IdentityError("Entity not found");
  try {
    await requireSpaceAccess(ctx, principal, entity.spaceId, "write");
  } catch (error) {
    if (error instanceof IdentityError && error.message === "Space not found") {
      throw new IdentityError("Entity not found");
    }
    throw error;
  }
  return entity;
}

export async function createNamedEntity(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    spaceId: string;
    kind: ProfileKind;
    name: string;
    aliases?: readonly string[];
  },
): Promise<{ entity: Entity; created: boolean }> {
  await requireSpaceAccess(ctx, args.principal, args.spaceId, "write");
  const index = await loadSpaceEntityIndex(ctx, args.spaceId);
  const resolution = resolveLiteralName(index, args.name, [args.kind]);
  if (
    (resolution.candidateCount > 0 && !resolution.entity) ||
    index.truncated
  ) {
    throw new IdentityError(
      "Entity name is ambiguous; use an existing entity ID",
    );
  }
  const entity = await resolveEntity(ctx, args.principal.userId, args.spaceId, {
    kind: args.kind,
    name: args.name,
    aliases: args.aliases,
  });
  return { entity, created: !resolution.entity };
}

export async function updateNamedEntity(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    entityId: string;
    name?: string;
    aliases?: readonly string[];
  },
): Promise<Entity> {
  const entity = await requireWritableEntity(
    ctx,
    args.principal,
    args.entityId,
  );
  const canonicalName = args.name?.trim() || entity.canonicalName;
  const aliases = [...(args.aliases ?? entity.aliases)];
  if (normalizeEntityName(canonicalName) !== entity.normalizedName)
    aliases.push(entity.canonicalName);
  const normalized = new Map<string, string>();
  for (const alias of aliases) {
    const clean = alias.trim();
    const key = normalizeEntityName(clean);
    if (key !== normalizeEntityName(canonicalName)) normalized.set(key, clean);
  }
  if (args.aliases !== undefined && normalized.size > 20) {
    throw new IdentityError("An entity can have at most 20 aliases");
  }
  if (normalizeEntityName(canonicalName) !== entity.normalizedName) {
    const index = await loadSpaceEntityIndex(ctx, entity.spaceId);
    const candidates =
      index.byNormalizedName.get(normalizeEntityName(canonicalName)) ?? [];
    if (
      index.truncated ||
      candidates.some(
        (candidate) =>
          candidate.kind === entity.kind && candidate.id !== entity.id,
      )
    ) {
      throw new IdentityError("Entity name or alias matches another entity");
    }
  }
  await exec(
    ctx,
    `UPDATE kith.entities SET canonical_name = $2, normalized_name = $3,
       aliases = $4::jsonb, normalized_aliases = $5::jsonb, updated_at = $6
      WHERE id = $1 AND merged_into IS NULL`,
    [
      entity.id,
      canonicalName,
      normalizeEntityName(canonicalName),
      JSON.stringify([...normalized.values()]),
      JSON.stringify([...normalized.keys()]),
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

export async function linkMeToPerson(
  ctx: IdentityCtx,
  args: { principal: Principal; spaceId: string; entityId: string },
): Promise<Entity> {
  await requireSpaceAccess(ctx, args.principal, args.spaceId, "write");
  const entity = await getEntity(
    ctx,
    assertKithId(args.entityId, "invalid_entity_id"),
  );
  if (!entity || entity.spaceId !== args.spaceId || entity.kind !== "person") {
    throw new IdentityError("Profile entity not found");
  }
  const result = await ctx.client.query(
    `UPDATE kith.space_members SET person_entity_id = $3
      WHERE space_id = $1 AND user_id = $2`,
    [args.spaceId, args.principal.userId, entity.id],
  );
  if (result.rowCount !== 1) throw new IdentityError("Space not found");
  return entity;
}

export async function linkProfileDocument(
  ctx: IdentityCtx,
  args: { principal: Principal; entityId: string; sourceItemId: string },
): Promise<{ entity: Entity; factId: string }> {
  const entity = await requireWritableEntity(
    ctx,
    args.principal,
    args.entityId,
  );
  if (entity.kind !== "person" && entity.kind !== "vehicle") {
    throw new IdentityError("Profile entity not found");
  }
  const sourceItem = await row<{ id: string }>(
    ctx,
    `SELECT id FROM kith.source_items
      WHERE id = $1 AND space_id = $2
        AND lifecycle NOT IN ('forgetting', 'forgotten')`,
    [assertKithId(args.sourceItemId, "invalid_source_item_id"), entity.spaceId],
  );
  if (!sourceItem) throw new IdentityError("Source item not found");
  const result = await rememberFact(
    ctx,
    args.principal.userId,
    entity.spaceId,
    {
      subject: {
        key: entity.key,
        kind: entity.kind,
        name: entity.canonicalName,
        aliases: entity.aliases,
      },
      predicate: "supporting_document",
      value: { type: "text", value: sourceItem.id },
      sourceType: "user_confirmed",
      sourceRef: `source:${sourceItem.id}`,
      cardinality: "multiple",
    },
  );
  return { entity, factId: result.factId };
}

export type MergeConflict = {
  predicate: string;
  factIds: readonly string[];
};

export type MergeEntitiesResult = {
  entity: Entity;
  mergedEntityId: string;
  repointed: Readonly<Record<string, number>>;
  conflicts: readonly MergeConflict[];
};

export async function mergeEntities(
  ctx: IdentityCtx,
  args: {
    principal: Principal;
    sourceEntityId: string;
    targetEntityId: string;
  },
): Promise<MergeEntitiesResult> {
  const sourceId = assertKithId(args.sourceEntityId, "invalid_entity_id");
  const targetId = assertKithId(args.targetEntityId, "invalid_entity_id");
  if (sourceId === targetId)
    throw new IdentityError("Merge entities must be different");
  const locked = await rows<{
    id: string;
    space_id: string;
    kind: EntityKind;
    canonical_name: string;
    aliases: unknown;
    merged_into: string | null;
  }>(
    ctx,
    `SELECT id, space_id, kind, canonical_name, aliases, merged_into
       FROM kith.entities WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
    [[sourceId, targetId]],
  );
  const source = locked.find((entity) => entity.id === sourceId);
  const target = locked.find((entity) => entity.id === targetId);
  if (!source || !target || source.space_id !== target.space_id)
    throw new IdentityError("Entity not found");
  await requireSpaceAccess(ctx, args.principal, source.space_id, "write");
  if (source.merged_into || target.merged_into)
    throw new IdentityError("Merge requires two current entities");
  if (source.kind !== target.kind)
    throw new IdentityError("Merge entities must have the same kind");

  const aliases = new Map<string, string>();
  for (const name of [
    target.canonical_name,
    ...(Array.isArray(target.aliases) ? target.aliases : []),
    source.canonical_name,
    ...(Array.isArray(source.aliases) ? source.aliases : []),
  ]) {
    if (typeof name !== "string") continue;
    const normalized = normalizeEntityName(name);
    if (normalized !== normalizeEntityName(target.canonical_name))
      aliases.set(normalized, name);
  }
  await exec(
    ctx,
    `UPDATE kith.entities SET aliases = $2::jsonb, normalized_aliases = $3::jsonb,
       updated_at = $4 WHERE id = $1 AND space_id = $5`,
    [
      targetId,
      JSON.stringify([...aliases.values()]),
      JSON.stringify([...aliases.keys()]),
      new Date(ctx.now),
      source.space_id,
    ],
  );

  const repointed: Record<string, number> = {};
  const repoint = async (
    key: string,
    sql: string,
    values: readonly unknown[] = [targetId, sourceId, source.space_id],
  ) => {
    const result = await ctx.client.query(sql, values as unknown[]);
    repointed[key] = result.rowCount ?? 0;
  };
  await repoint(
    "spaceMembers",
    "UPDATE kith.space_members SET person_entity_id = $1 WHERE person_entity_id = $2 AND space_id = $3",
  );
  await repoint(
    "sourceAccounts",
    "UPDATE kith.source_accounts SET subject_entity_id = $1 WHERE subject_entity_id = $2 AND space_id = $3",
  );
  await repoint(
    "eventVersions",
    "UPDATE kith.event_versions SET entity_id = $1 WHERE entity_id = $2 AND space_id = $3",
  );
  await repoint(
    "observations",
    "UPDATE kith.observations SET entity_id = $1 WHERE entity_id = $2 AND space_id = $3",
  );
  await repoint(
    "observationBindings",
    "UPDATE kith.observations SET bound_entity_id = $1 WHERE bound_entity_id = $2 AND space_id = $3",
  );
  await repoint(
    "observationValues",
    `UPDATE kith.observations SET value = jsonb_set(value, '{entityId}', to_jsonb($1::text)) WHERE value ->> 'type' = 'entity' AND value ->> 'entityId' = $2 AND space_id = $3`,
  );
  await repoint(
    "coverageWindows",
    "UPDATE kith.coverage_windows SET entity_id = $1 WHERE entity_id = $2 AND space_id = $3",
  );
  repointed.coverageGaps = await repointCoverageEntity(
    ctx,
    source.space_id,
    sourceId,
    targetId,
  );
  await repoint(
    "factSubjects",
    "UPDATE kith.facts SET subject_entity_id = $1 WHERE subject_entity_id = $2 AND space_id = $3",
  );
  await repoint(
    "factValues",
    `UPDATE kith.facts SET value = jsonb_set(value, '{entityId}', to_jsonb($1::text)) WHERE value ->> 'type' = 'entity' AND value ->> 'entityId' = $2 AND space_id = $3`,
  );
  await repoint(
    "investments",
    "UPDATE kith.investments SET entity_id = $1 WHERE entity_id = $2 AND space_id = $3",
  );
  await repoint(
    "corrections",
    `UPDATE kith.corrections SET corrected_value = jsonb_set(corrected_value, '{entityId}', to_jsonb($1::text)) WHERE corrected_value ->> 'type' = 'entity' AND corrected_value ->> 'entityId' = $2 AND space_id = $3`,
  );
  await repoint(
    "mergedEntities",
    "UPDATE kith.entities SET merged_into = $1, updated_at = $4 WHERE merged_into = $2 AND space_id = $3",
    [targetId, sourceId, source.space_id, new Date(ctx.now)],
  );
  await exec(
    ctx,
    "UPDATE kith.entities SET merged_into = $2, updated_at = $3 WHERE id = $1 AND space_id = $4",
    [sourceId, targetId, new Date(ctx.now), source.space_id],
  );

  const singlePredicates = listProfilePredicates(source.kind as ProfileKind)
    .filter((entry) => entry.cardinality === "single")
    .map((entry) => entry.predicate);
  const conflictRows =
    singlePredicates.length === 0
      ? []
      : await rows<{ predicate: string; fact_ids: string[] }>(
          ctx,
          `SELECT predicate, array_agg(id::text ORDER BY created_at DESC, id DESC) AS fact_ids
       FROM kith.facts
      WHERE space_id = $1 AND subject_entity_id = $2 AND status = 'current'
        AND predicate = ANY($3::text[])
        AND (valid_from IS NULL OR valid_from <= $4)
        AND (valid_to IS NULL OR $4 < valid_to)
      GROUP BY predicate HAVING count(*) > 1 ORDER BY predicate`,
          [source.space_id, targetId, singlePredicates, new Date(ctx.now)],
        );
  await withLinkEnqueueSavepoint(ctx, { entityId: targetId }, () =>
    scheduleInvestmentLinksForEntity(ctx, {
      spaceId: source.space_id,
      entityId: targetId,
    }),
  );
  return {
    entity: (await getEntity(ctx, targetId))!,
    mergedEntityId: sourceId,
    repointed,
    conflicts: conflictRows.map((conflict) => ({
      predicate: conflict.predicate,
      factIds: conflict.fact_ids,
    })),
  };
}
