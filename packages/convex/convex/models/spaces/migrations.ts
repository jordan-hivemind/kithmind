import { v } from "convex/values";

import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../../_generated/server";
import {
  insertMissingPersonalSpaceRecords,
  inspectPersonalSpace,
  isPersonalSpaceReady,
} from "./model";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 200;
const MAX_DIAGNOSTICS = 25;
const MAX_REASONS_PER_DIAGNOSTIC = 8;
// This conservative migration guard requires explicit review of larger legacy
// histories before dereferencing them in a bounded transaction.
const MAX_HISTORY_REFERENCES = 10;
const MAX_CONTENT_PAGE_BYTES = 1_000_000;
const MAX_CONTENT_BATCH_SIZE = 4;
const MAX_PAGE_REFERENCES = 13;

const paginationArgs = {
  cursor: v.optional(v.string()),
  batchSize: v.optional(v.number()),
};

const migrationArgs = {
  ...paginationArgs,
  dryRun: v.optional(v.boolean()),
};

const diagnosticValidator = v.object({ id: v.string(), reason: v.string() });

const migrationResultValidator = v.object({
  examined: v.number(),
  changed: v.number(),
  // Valid rows that need a patch. `changed` is the subset written this run.
  wouldChange: v.number(),
  skipped: v.number(),
  invalidCount: v.number(),
  invalids: v.array(diagnosticValidator),
  blocked: v.boolean(),
  isDone: v.boolean(),
  cursor: v.union(v.string(), v.null()),
});

const auditResultValidator = v.object({
  examined: v.number(),
  missing: v.number(),
  invalidCount: v.number(),
  invalids: v.array(diagnosticValidator),
  isDone: v.boolean(),
  cursor: v.union(v.string(), v.null()),
});

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;
type Diagnostic = { id: string; reason: string };

function batchSize(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_BATCH_SIZE);
}

function contentBatchSize(table: ContentTable, value: number | undefined) {
  const requested = batchSize(value);
  // Thoughts and referenced thoughts carry vectors, so keep base pages small.
  // validateContentPage separately caps and caches referenced documents.
  return table === "entities"
    ? Math.min(requested, 50)
    : Math.min(requested, MAX_CONTENT_BATCH_SIZE);
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

async function personalTarget(
  ctx: ReadCtx,
  userId: Id<"users">,
): Promise<{ spaceId: Id<"spaces"> | null; issues: string[] }> {
  if (!(await ctx.db.get(userId))) {
    return { spaceId: null, issues: ["author references a missing user"] };
  }
  const inspection = await inspectPersonalSpace(ctx, userId);
  if (!isPersonalSpaceReady(inspection)) {
    return {
      spaceId: null,
      issues:
        inspection.issues.length > 0
          ? inspection.issues
          : ["personal-space setup is incomplete"],
    };
  }
  return { spaceId: inspection.personalSpace!._id, issues: [] };
}

async function validateEntity(
  ctx: ReadCtx,
  entity: Doc<"entities">,
  target: { spaceId: Id<"spaces"> | null; issues: string[] },
) {
  const issues = [...target.issues];
  if (!target.spaceId) return issues;

  if (entity.spaceId !== undefined && entity.spaceId !== target.spaceId) {
    issues.push("entity is assigned outside its author's personal space");
  }

  const legacyKeyMatches = await ctx.db
    .query("entities")
    .withIndex("by_userId_and_key", (q) =>
      q.eq("userId", entity.userId).eq("key", entity.key),
    )
    .take(2);
  if (legacyKeyMatches.length > 1) {
    issues.push("duplicate legacy entity key for author");
  }

  const targetKeyMatches = await ctx.db
    .query("entities")
    .withIndex("by_spaceId_and_key", (q) =>
      q.eq("spaceId", target.spaceId!).eq("key", entity.key),
    )
    .take(2);
  if (targetKeyMatches.some((match) => match._id !== entity._id)) {
    issues.push("entity key already exists in personal space");
  }
  return issues;
}

async function validateEntityReference(
  ctx: ReadCtx,
  cache: ReferenceCache,
  id: Id<"entities">,
  userId: Id<"users">,
  spaceId: Id<"spaces">,
  label: string,
) {
  let pending = cache.entities.get(id);
  if (!pending) {
    pending = ctx.db.get(id);
    cache.entities.set(id, pending);
  }
  const entity = await pending;
  if (!entity) return [`${label} references a missing entity`];
  const issues: string[] = [];
  if (entity.userId !== userId) {
    issues.push(`${label} references another user's entity`);
  }
  if (entity.spaceId !== spaceId) {
    issues.push(`${label} entity is not assigned to the personal space`);
  }
  return issues;
}

async function validateFactHistoryReference(
  ctx: ReadCtx,
  cache: ReferenceCache,
  id: Id<"facts">,
  userId: Id<"users">,
  spaceId: Id<"spaces">,
  label: string,
) {
  let pending = cache.facts.get(id);
  if (!pending) {
    pending = ctx.db.get(id);
    cache.facts.set(id, pending);
  }
  const fact = await pending;
  if (!fact) return [`${label} references a missing fact`];
  const issues: string[] = [];
  if (fact.userId !== userId) {
    issues.push(`${label} references another user's fact`);
  }
  if (fact.spaceId !== undefined && fact.spaceId !== spaceId) {
    issues.push(`${label} references a fact in another space`);
  }
  return issues;
}

async function validateFact(
  ctx: ReadCtx,
  cache: ReferenceCache,
  fact: Doc<"facts">,
  target: { spaceId: Id<"spaces"> | null; issues: string[] },
) {
  const issues = [...target.issues];
  if (!target.spaceId) return issues;

  if (fact.spaceId !== undefined && fact.spaceId !== target.spaceId) {
    issues.push("fact is assigned outside its author's personal space");
  }
  issues.push(
    ...(await validateEntityReference(
      ctx,
      cache,
      fact.subjectEntityId,
      fact.userId,
      target.spaceId,
      "subject",
    )),
  );
  if (fact.value.type === "entity") {
    issues.push(
      ...(await validateEntityReference(
        ctx,
        cache,
        fact.value.entityId,
        fact.userId,
        target.spaceId,
        "value",
      )),
    );
  }
  if (fact.supersededBy) {
    issues.push(
      ...(await validateFactHistoryReference(
        ctx,
        cache,
        fact.supersededBy,
        fact.userId,
        target.spaceId,
        "supersededBy",
      )),
    );
  }
  const rawSupersedes = fact.supersedes ?? [];
  if (rawSupersedes.length > MAX_HISTORY_REFERENCES) {
    issues.push("supersedes exceeds the migration reference limit");
  } else {
    const supersedes = [...new Set(rawSupersedes)];
    for (const supersededId of supersedes) {
      issues.push(
        ...(await validateFactHistoryReference(
          ctx,
          cache,
          supersededId,
          fact.userId,
          target.spaceId,
          "supersedes",
        )),
      );
    }
  }
  return issues;
}

async function validateThoughtHistoryReference(
  ctx: ReadCtx,
  cache: ReferenceCache,
  id: Id<"thoughts">,
  userId: Id<"users">,
  spaceId: Id<"spaces">,
  label: string,
) {
  let pending = cache.thoughts.get(id);
  if (!pending) {
    pending = ctx.db.get(id);
    cache.thoughts.set(id, pending);
  }
  const thought = await pending;
  if (!thought) return [`${label} references a missing thought`];
  const issues: string[] = [];
  if (thought.userId !== userId) {
    issues.push(`${label} references another user's thought`);
  }
  if (thought.spaceId !== undefined && thought.spaceId !== spaceId) {
    issues.push(`${label} references a thought in another space`);
  }
  return issues;
}

async function validateThought(
  ctx: ReadCtx,
  cache: ReferenceCache,
  thought: Doc<"thoughts">,
  target: { spaceId: Id<"spaces"> | null; issues: string[] },
) {
  const issues = [...target.issues];
  if (!target.spaceId) return issues;

  if (thought.spaceId !== undefined && thought.spaceId !== target.spaceId) {
    issues.push("thought is assigned outside its author's personal space");
  }
  if (thought.supersededBy) {
    issues.push(
      ...(await validateThoughtHistoryReference(
        ctx,
        cache,
        thought.supersededBy,
        thought.userId,
        target.spaceId,
        "supersededBy",
      )),
    );
  }
  const rawSupersedes = thought.supersedes ?? [];
  if (rawSupersedes.length > MAX_HISTORY_REFERENCES) {
    issues.push("supersedes exceeds the migration reference limit");
  } else {
    const supersedes = [...new Set(rawSupersedes)];
    for (const supersededId of supersedes) {
      issues.push(
        ...(await validateThoughtHistoryReference(
          ctx,
          cache,
          supersededId,
          thought.userId,
          target.spaceId,
          "supersedes",
        )),
      );
    }
  }
  return issues;
}

type ContentTable = "entities" | "facts" | "thoughts";

type ReferenceCache = {
  entities: Map<string, Promise<Doc<"entities"> | null>>;
  facts: Map<string, Promise<Doc<"facts"> | null>>;
  thoughts: Map<string, Promise<Doc<"thoughts"> | null>>;
};

function contentReferenceIds(
  table: ContentTable,
  row: Doc<"entities"> | Doc<"facts"> | Doc<"thoughts">,
): string[] {
  if (table === "entities") return [];
  if (table === "thoughts") {
    const thought = row as Doc<"thoughts">;
    return [
      ...(thought.supersededBy ? [thought.supersededBy] : []),
      ...((thought.supersedes?.length ?? 0) <= MAX_HISTORY_REFERENCES
        ? (thought.supersedes ?? [])
        : []),
    ];
  }
  const fact = row as Doc<"facts">;
  return [
    fact.subjectEntityId,
    ...(fact.value.type === "entity" ? [fact.value.entityId] : []),
    ...(fact.supersededBy ? [fact.supersededBy] : []),
    ...((fact.supersedes?.length ?? 0) <= MAX_HISTORY_REFERENCES
      ? (fact.supersedes ?? [])
      : []),
  ];
}

async function validateContentPage(
  ctx: ReadCtx,
  table: ContentTable,
  rows: Array<Doc<"entities"> | Doc<"facts"> | Doc<"thoughts">>,
) {
  const targets = new Map<
    string,
    Promise<{ spaceId: Id<"spaces"> | null; issues: string[] }>
  >();
  const diagnostics: Diagnostic[] = [];
  let invalidCount = 0;
  let missing = 0;
  let validMissing = 0;
  let validAssigned = 0;
  const pageReferenceIds = new Set<string>();
  const cache: ReferenceCache = {
    entities: new Map(),
    facts: new Map(),
    thoughts: new Map(),
  };

  for (const row of rows) {
    if (row.spaceId === undefined) missing += 1;
    const rowReferenceIds = new Set(contentReferenceIds(table, row));
    const nextReferenceIds = new Set([...pageReferenceIds, ...rowReferenceIds]);
    if (nextReferenceIds.size > MAX_PAGE_REFERENCES) {
      invalidCount += 1;
      addDiagnostic(diagnostics, row._id, [
        "page reference budget exceeded; rerun with a smaller batchSize",
      ]);
      continue;
    }
    for (const id of rowReferenceIds) pageReferenceIds.add(id);
    let target = targets.get(row.userId);
    if (!target) {
      target = personalTarget(ctx, row.userId);
      targets.set(row.userId, target);
    }
    const resolvedTarget = await target;
    const issues =
      table === "entities"
        ? await validateEntity(ctx, row as Doc<"entities">, resolvedTarget)
        : table === "facts"
          ? await validateFact(ctx, cache, row as Doc<"facts">, resolvedTarget)
          : await validateThought(
              ctx,
              cache,
              row as Doc<"thoughts">,
              resolvedTarget,
            );
    if (issues.length > 0) {
      invalidCount += 1;
      addDiagnostic(diagnostics, row._id, issues);
    } else if (row.spaceId === undefined) {
      validMissing += 1;
    } else {
      validAssigned += 1;
    }
  }

  return {
    targets,
    diagnostics,
    invalidCount,
    missing,
    validMissing,
    validAssigned,
  };
}

/** Creates only the personal-space records required for legacy users. */
export const bootstrapPersonalSpaces = internalMutation({
  args: migrationArgs,
  returns: migrationResultValidator,
  handler: async (ctx, args) => {
    const page = await ctx.db.query("users").paginate({
      cursor: args.cursor ?? null,
      numItems: batchSize(args.batchSize),
    });
    const inspections = [];
    const invalids: Diagnostic[] = [];
    let invalidCount = 0;
    let wouldChange = 0;

    for (const user of page.page) {
      const inspection = await inspectPersonalSpace(ctx, user._id);
      inspections.push({ userId: user._id, inspection });
      if (inspection.issues.length > 0) {
        invalidCount += 1;
        addDiagnostic(invalids, user._id, inspection.issues);
      } else if (!isPersonalSpaceReady(inspection)) {
        wouldChange += 1;
      }
    }

    const dryRun = args.dryRun ?? false;
    if (!dryRun && invalidCount > 0) {
      return {
        examined: page.page.length,
        changed: 0,
        wouldChange,
        skipped: page.page.length - wouldChange - invalidCount,
        invalidCount,
        invalids,
        blocked: true,
        isDone: false,
        cursor: args.cursor ?? null,
      };
    }

    let changed = 0;
    if (!dryRun) {
      for (const { userId, inspection } of inspections) {
        if (isPersonalSpaceReady(inspection)) continue;
        await insertMissingPersonalSpaceRecords(ctx, userId, inspection);
        changed += 1;
      }
    }

    return {
      examined: page.page.length,
      changed,
      wouldChange,
      skipped: page.page.length - wouldChange - invalidCount,
      invalidCount,
      invalids,
      blocked: invalidCount > 0,
      isDone: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

async function backfillContentPage(
  ctx: MutationCtx,
  args: { cursor?: string; batchSize?: number; dryRun?: boolean },
  table: ContentTable,
) {
  const size = contentBatchSize(table, args.batchSize);
  const page =
    table === "entities"
      ? await ctx.db.query("entities").paginate({
          cursor: args.cursor ?? null,
          numItems: size,
          maximumBytesRead: MAX_CONTENT_PAGE_BYTES,
        })
      : table === "facts"
        ? await ctx.db.query("facts").paginate({
            cursor: args.cursor ?? null,
            numItems: size,
            maximumBytesRead: MAX_CONTENT_PAGE_BYTES,
          })
        : await ctx.db.query("thoughts").paginate({
            cursor: args.cursor ?? null,
            numItems: size,
            maximumBytesRead: MAX_CONTENT_PAGE_BYTES,
          });
  const rows = page.page as Array<
    Doc<"entities"> | Doc<"facts"> | Doc<"thoughts">
  >;
  const validation = await validateContentPage(ctx, table, rows);
  const validMissing = validation.validMissing;
  const dryRun = args.dryRun ?? false;

  if (!dryRun && validation.invalidCount > 0) {
    return {
      examined: rows.length,
      changed: 0,
      wouldChange: validMissing,
      skipped: validation.validAssigned,
      invalidCount: validation.invalidCount,
      invalids: validation.diagnostics,
      blocked: true,
      isDone: false,
      cursor: args.cursor ?? null,
    };
  }

  let changed = 0;
  if (!dryRun) {
    for (const row of rows) {
      if (row.spaceId !== undefined) continue;
      const target = await validation.targets.get(row.userId)!;
      await ctx.db.patch(row._id, { spaceId: target.spaceId! });
      changed += 1;
    }
  }

  return {
    examined: rows.length,
    changed,
    wouldChange: validMissing,
    skipped: validation.validAssigned,
    invalidCount: validation.invalidCount,
    invalids: validation.diagnostics,
    blocked: validation.invalidCount > 0,
    isDone: page.isDone,
    cursor: page.isDone ? null : page.continueCursor,
  };
}

export const backfillEntitySpaceIds = internalMutation({
  args: migrationArgs,
  returns: migrationResultValidator,
  handler: (ctx, args) => backfillContentPage(ctx, args, "entities"),
});

export const backfillFactSpaceIds = internalMutation({
  args: migrationArgs,
  returns: migrationResultValidator,
  handler: (ctx, args) => backfillContentPage(ctx, args, "facts"),
});

export const backfillThoughtSpaceIds = internalMutation({
  args: migrationArgs,
  returns: migrationResultValidator,
  handler: (ctx, args) => backfillContentPage(ctx, args, "thoughts"),
});

/** Audits missing or malformed personal-space setup without writing. */
export const auditPersonalSpaces = internalQuery({
  args: paginationArgs,
  returns: v.object({
    examined: v.number(),
    missingSpaces: v.number(),
    missingMemberships: v.number(),
    missingSettings: v.number(),
    invalidCount: v.number(),
    invalids: v.array(diagnosticValidator),
    isDone: v.boolean(),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("users").paginate({
      cursor: args.cursor ?? null,
      numItems: batchSize(args.batchSize),
    });
    let missingSpaces = 0;
    let missingMemberships = 0;
    let missingSettings = 0;
    let invalidCount = 0;
    const invalids: Diagnostic[] = [];

    for (const user of page.page) {
      const inspection = await inspectPersonalSpace(ctx, user._id);
      if (!inspection.personalSpace) missingSpaces += 1;
      if (!inspection.membership) missingMemberships += 1;
      if (!inspection.settings) missingSettings += 1;
      if (inspection.issues.length > 0) {
        invalidCount += 1;
        addDiagnostic(invalids, user._id, inspection.issues);
      }
    }

    return {
      examined: page.page.length,
      missingSpaces,
      missingMemberships,
      missingSettings,
      invalidCount,
      invalids,
      isDone: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

async function auditContentPage(
  ctx: QueryCtx,
  args: { cursor?: string; batchSize?: number },
  table: ContentTable,
) {
  const size = contentBatchSize(table, args.batchSize);
  const page =
    table === "entities"
      ? await ctx.db.query("entities").paginate({
          cursor: args.cursor ?? null,
          numItems: size,
          maximumBytesRead: MAX_CONTENT_PAGE_BYTES,
        })
      : table === "facts"
        ? await ctx.db.query("facts").paginate({
            cursor: args.cursor ?? null,
            numItems: size,
            maximumBytesRead: MAX_CONTENT_PAGE_BYTES,
          })
        : await ctx.db.query("thoughts").paginate({
            cursor: args.cursor ?? null,
            numItems: size,
            maximumBytesRead: MAX_CONTENT_PAGE_BYTES,
          });
  const rows = page.page as Array<
    Doc<"entities"> | Doc<"facts"> | Doc<"thoughts">
  >;
  const validation = await validateContentPage(ctx, table, rows);
  return {
    examined: rows.length,
    missing: validation.missing,
    invalidCount: validation.invalidCount,
    invalids: validation.diagnostics,
    isDone: page.isDone,
    cursor: page.isDone ? null : page.continueCursor,
  };
}

export const auditEntitySpaceIds = internalQuery({
  args: paginationArgs,
  returns: auditResultValidator,
  handler: (ctx, args) => auditContentPage(ctx, args, "entities"),
});

export const auditFactSpaceIds = internalQuery({
  args: paginationArgs,
  returns: auditResultValidator,
  handler: (ctx, args) => auditContentPage(ctx, args, "facts"),
});

export const auditThoughtSpaceIds = internalQuery({
  args: paginationArgs,
  returns: auditResultValidator,
  handler: (ctx, args) => auditContentPage(ctx, args, "thoughts"),
});
