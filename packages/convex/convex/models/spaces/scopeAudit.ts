import { v } from "convex/values";

import type { Doc, Id } from "../../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../../_generated/server";

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 50;
const MAX_FACT_THOUGHT_BATCH_SIZE = 4;
const MAX_PAGE_BYTES = 1_000_000;
const MAX_PAGE_LINKS = 500;
const MAX_FACT_SUPERSEDES = 100;
const MAX_THOUGHT_SUPERSEDES = 10;
const MAX_DIAGNOSTICS = 25;
const MAX_REASONS_PER_DIAGNOSTIC = 8;

const contentTable = v.union(
  v.literal("entities"),
  v.literal("facts"),
  v.literal("thoughts"),
);

const diagnostic = v.object({ id: v.string(), reason: v.string() });

type ContentTable = "entities" | "facts" | "thoughts";
type ContentRow = Doc<"entities"> | Doc<"facts"> | Doc<"thoughts">;
type Diagnostic = { id: string; reason: string };

type ReferenceCache = {
  spaces: Map<string, Promise<Doc<"spaces"> | null>>;
  entities: Map<string, Promise<Doc<"entities"> | null>>;
  facts: Map<string, Promise<Doc<"facts"> | null>>;
  thoughts: Map<string, Promise<Doc<"thoughts"> | null>>;
};

function batchSize(table: ContentTable, requested: number | undefined) {
  const normalized =
    requested === undefined || !Number.isFinite(requested)
      ? DEFAULT_BATCH_SIZE
      : Math.min(Math.max(Math.trunc(requested), 1), MAX_BATCH_SIZE);
  return table === "entities"
    ? normalized
    : Math.min(normalized, MAX_FACT_THOUGHT_BATCH_SIZE);
}

function addDiagnostic(
  diagnostics: Diagnostic[],
  id: string,
  reasons: string[],
) {
  if (diagnostics.length >= MAX_DIAGNOSTICS) return;
  const shown = reasons.slice(0, MAX_REASONS_PER_DIAGNOSTIC);
  const omitted = reasons.length - shown.length;
  diagnostics.push({
    id,
    reason: `${shown.join("; ")}${omitted > 0 ? `; ${omitted} more issue(s)` : ""}`,
  });
}

function getCached<T extends "spaces" | "entities" | "facts" | "thoughts">(
  ctx: QueryCtx,
  cache: Map<string, Promise<Doc<T> | null>>,
  id: Id<T>,
) {
  let pending = cache.get(id);
  if (!pending) {
    pending = ctx.db.get(id);
    cache.set(id, pending);
  }
  return pending;
}

async function validateSpace(
  ctx: QueryCtx,
  cache: ReferenceCache,
  spaceId: Id<"spaces"> | undefined,
) {
  if (spaceId === undefined) return ["spaceId is missing"];
  return (await getCached(ctx, cache.spaces, spaceId))
    ? []
    : ["spaceId references a missing space"];
}

async function validateEntityReference(
  ctx: QueryCtx,
  cache: ReferenceCache,
  id: Id<"entities">,
  spaceId: Id<"spaces">,
  label: string,
) {
  const entity = await getCached(ctx, cache.entities, id);
  if (!entity) return [`${label} references a missing entity`];
  return entity.spaceId === spaceId
    ? []
    : [`${label} references an entity in another space`];
}

async function validateFactReference(
  ctx: QueryCtx,
  cache: ReferenceCache,
  id: Id<"facts">,
  spaceId: Id<"spaces">,
  label: string,
) {
  const fact = await getCached(ctx, cache.facts, id);
  if (!fact) return [`${label} references a missing fact`];
  return fact.spaceId === spaceId
    ? []
    : [`${label} references a fact in another space`];
}

async function validateThoughtReference(
  ctx: QueryCtx,
  cache: ReferenceCache,
  id: Id<"thoughts">,
  spaceId: Id<"spaces">,
  label: string,
) {
  const thought = await getCached(ctx, cache.thoughts, id);
  if (!thought) return [`${label} references a missing thought`];
  return thought.spaceId === spaceId
    ? []
    : [`${label} references a thought in another space`];
}

function rowLinkIds(table: ContentTable, row: ContentRow) {
  const links = row.spaceId ? [`space:${row.spaceId}`] : [];
  if (table === "entities") return links;
  if (table === "thoughts") {
    const thought = row as Doc<"thoughts">;
    if ((thought.supersedes?.length ?? 0) > MAX_THOUGHT_SUPERSEDES) {
      return links;
    }
    return [
      ...links,
      ...(thought.supersededBy ? [`thought:${thought.supersededBy}`] : []),
      ...(thought.supersedes ?? []).map((id) => `thought:${id}`),
    ];
  }
  const fact = row as Doc<"facts">;
  if ((fact.supersedes?.length ?? 0) > MAX_FACT_SUPERSEDES) return links;
  return [
    ...links,
    `entity:${fact.subjectEntityId}`,
    ...(fact.value.type === "entity"
      ? [`entity:${fact.value.entityId}`]
      : []),
    ...(fact.supersededBy ? [`fact:${fact.supersededBy}`] : []),
    ...(fact.supersedes ?? []).map((id) => `fact:${id}`),
  ];
}

async function validateEntity(
  ctx: QueryCtx,
  cache: ReferenceCache,
  entity: Doc<"entities">,
) {
  const issues = await validateSpace(ctx, cache, entity.spaceId);
  if (entity.spaceId === undefined) return issues;
  const matches = await ctx.db
    .query("entities")
    .withIndex("by_spaceId_and_key", (q) =>
      q.eq("spaceId", entity.spaceId).eq("key", entity.key),
    )
    .take(2);
  if (matches.some((match) => match._id !== entity._id)) {
    issues.push("duplicate entity key in space");
  }
  return issues;
}

async function validateFact(
  ctx: QueryCtx,
  cache: ReferenceCache,
  fact: Doc<"facts">,
) {
  const issues = await validateSpace(ctx, cache, fact.spaceId);
  if (fact.spaceId === undefined) return issues;
  issues.push(
    ...(await validateEntityReference(
      ctx,
      cache,
      fact.subjectEntityId,
      fact.spaceId,
      "subject",
    )),
  );
  if (fact.value.type === "entity") {
    issues.push(
      ...(await validateEntityReference(
        ctx,
        cache,
        fact.value.entityId,
        fact.spaceId,
        "value",
      )),
    );
  }
  if (fact.supersededBy) {
    issues.push(
      ...(await validateFactReference(
        ctx,
        cache,
        fact.supersededBy,
        fact.spaceId,
        "supersededBy",
      )),
    );
  }
  if ((fact.supersedes?.length ?? 0) > MAX_FACT_SUPERSEDES) {
    issues.push("supersedes exceeds the fact history reference limit");
  } else {
    for (const id of new Set(fact.supersedes ?? [])) {
      issues.push(
        ...(await validateFactReference(
          ctx,
          cache,
          id,
          fact.spaceId,
          "supersedes",
        )),
      );
    }
  }
  return issues;
}

async function validateThought(
  ctx: QueryCtx,
  cache: ReferenceCache,
  thought: Doc<"thoughts">,
) {
  const issues = await validateSpace(ctx, cache, thought.spaceId);
  if (thought.spaceId === undefined) return issues;
  if (thought.supersededBy) {
    issues.push(
      ...(await validateThoughtReference(
        ctx,
        cache,
        thought.supersededBy,
        thought.spaceId,
        "supersededBy",
      )),
    );
  }
  if ((thought.supersedes?.length ?? 0) > MAX_THOUGHT_SUPERSEDES) {
    issues.push("supersedes exceeds the thought history reference limit");
  } else {
    for (const id of new Set(thought.supersedes ?? [])) {
      issues.push(
        ...(await validateThoughtReference(
          ctx,
          cache,
          id,
          thought.spaceId,
          "supersedes",
        )),
      );
    }
  }
  return issues;
}

/**
 * Audits the final content-space invariants after shared writes are enabled.
 * Author membership is intentionally irrelevant because historical authors may
 * leave a shared space without invalidating its content.
 */
export const auditContent = internalQuery({
  args: {
    table: contentTable,
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    examined: v.number(),
    missing: v.number(),
    invalidCount: v.number(),
    invalids: v.array(diagnostic),
    isDone: v.boolean(),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const size = batchSize(args.table, args.batchSize);
    const page =
      args.table === "entities"
        ? await ctx.db.query("entities").paginate({
            cursor: args.cursor ?? null,
            numItems: size,
            maximumBytesRead: MAX_PAGE_BYTES,
          })
        : args.table === "facts"
          ? await ctx.db.query("facts").paginate({
              cursor: args.cursor ?? null,
              numItems: size,
              maximumBytesRead: MAX_PAGE_BYTES,
            })
          : await ctx.db.query("thoughts").paginate({
              cursor: args.cursor ?? null,
              numItems: size,
              maximumBytesRead: MAX_PAGE_BYTES,
            });
    const rows = page.page as ContentRow[];
    const diagnostics: Diagnostic[] = [];
    const cache: ReferenceCache = {
      spaces: new Map(),
      entities: new Map(),
      facts: new Map(),
      thoughts: new Map(),
    };
    const pageLinks = new Set<string>();
    let missing = 0;
    let invalidCount = 0;

    for (const row of rows) {
      if (row.spaceId === undefined) missing += 1;
      const links = rowLinkIds(args.table, row);
      const nextLinks = new Set([...pageLinks, ...links]);
      if (nextLinks.size > MAX_PAGE_LINKS) {
        invalidCount += 1;
        addDiagnostic(diagnostics, row._id, [
          "page link budget exceeded; rerun with a smaller batchSize",
        ]);
        continue;
      }
      for (const link of links) pageLinks.add(link);

      const issues =
        args.table === "entities"
          ? await validateEntity(ctx, cache, row as Doc<"entities">)
          : args.table === "facts"
            ? await validateFact(ctx, cache, row as Doc<"facts">)
            : await validateThought(ctx, cache, row as Doc<"thoughts">);
      if (issues.length > 0) {
        invalidCount += 1;
        addDiagnostic(diagnostics, row._id, issues);
      }
    }

    return {
      examined: rows.length,
      missing,
      invalidCount,
      invalids: diagnostics,
      isDone: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});
