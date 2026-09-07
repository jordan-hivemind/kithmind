import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";

const MAX_COVERAGE_ACCOUNTS = 32;
const MAX_COVERAGE_ROWS = 128;
const MAX_RECORD_TYPE_LENGTH = 100;
const MAX_GAP_REASON_LENGTH = 500;

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export type CoverageRange = { from: number; to: number };

export type QueryCoverage = {
  state: "complete" | "partial" | "unknown" | "stale";
  asOf: number;
  windows: Array<{
    from: number;
    to: number;
    sourceAccountId: Id<"sourceAccounts">;
  }>;
  knownGaps: Array<{ from?: number; to?: number; reason: string }>;
  pendingJobs: number;
  failedJobs: number;
  overflow: boolean;
};

function requireFiniteTime(value: number, name: string) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

function requireNonnegativeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
}

function validateRecordType(recordType: string) {
  const normalized = recordType.trim();
  if (!normalized || normalized.length > MAX_RECORD_TYPE_LENGTH) {
    throw new Error("recordType is invalid");
  }
  return normalized;
}

function validateRange(from: number, to: number) {
  requireFiniteTime(from, "from");
  requireFiniteTime(to, "to");
  if (from >= to) throw new Error("Coverage ranges must satisfy from < to");
}

async function requireCoverageParents(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
  sourceAccountId: Id<"sourceAccounts">,
  entityId?: Id<"entities">,
) {
  const account = await ctx.db.get(sourceAccountId);
  if (!account || account.spaceId !== spaceId) {
    throw new Error("Source account not found");
  }
  if (entityId !== undefined) {
    const entity = await ctx.db.get(entityId);
    if (!entity || entity.spaceId !== spaceId) {
      throw new Error("Entity not found");
    }
  }
  return account;
}

export async function upsertCoverageWindow(
  ctx: MutationCtx,
  fields: Omit<Doc<"coverageWindows">, "_id" | "_creationTime">,
): Promise<Id<"coverageWindows">> {
  await requireCoverageParents(
    ctx,
    fields.spaceId,
    fields.sourceAccountId,
    fields.entityId,
  );
  const recordType = validateRecordType(fields.recordType);
  validateRange(fields.from, fields.to);
  requireFiniteTime(fields.lastEnumeratedAt, "lastEnumeratedAt");
  requireFiniteTime(fields.lastProcessedAt, "lastProcessedAt");
  requireNonnegativeInteger(fields.discoveredCount, "discoveredCount");
  requireNonnegativeInteger(fields.indexedCount, "indexedCount");
  requireNonnegativeInteger(fields.skippedCount, "skippedCount");
  if (fields.indexedCount + fields.skippedCount > fields.discoveredCount) {
    throw new Error("Coverage counts exceed discoveredCount");
  }
  if (
    fields.state === "complete" &&
    (fields.skippedCount !== 0 ||
      fields.indexedCount !== fields.discoveredCount)
  ) {
    throw new Error("Complete coverage must index every discovered item");
  }

  const matches = await ctx.db
    .query("coverageWindows")
    .withIndex("by_sourceAccount_record_entity_from", (q) =>
      q
        .eq("sourceAccountId", fields.sourceAccountId)
        .eq("recordType", recordType)
        .eq("entityId", fields.entityId)
        .eq("from", fields.from)
        .eq("to", fields.to),
    )
    .take(2);
  if (matches.length > 1) throw new Error("Duplicate coverage window identity");
  const row = { ...fields, recordType };
  if (matches[0]) {
    await ctx.db.patch(matches[0]._id, row);
    return matches[0]._id;
  }
  return await ctx.db.insert("coverageWindows", row);
}

export async function openCoverageGap(
  ctx: MutationCtx,
  fields: Omit<
    Doc<"coverageGaps">,
    "_id" | "_creationTime" | "status" | "resolvedAt"
  >,
): Promise<Id<"coverageGaps">> {
  await requireCoverageParents(
    ctx,
    fields.spaceId,
    fields.sourceAccountId,
    fields.entityId,
  );
  const recordType = validateRecordType(fields.recordType);
  if ((fields.from === undefined) !== (fields.to === undefined)) {
    throw new Error("A coverage gap must provide both bounds or neither");
  }
  if (fields.from !== undefined && fields.to !== undefined) {
    validateRange(fields.from, fields.to);
  }
  requireFiniteTime(fields.detectedAt, "detectedAt");
  const reason = fields.reason.trim();
  if (!reason || reason.length > MAX_GAP_REASON_LENGTH) {
    throw new Error("Coverage gap reason is invalid");
  }
  return await ctx.db.insert("coverageGaps", {
    ...fields,
    recordType,
    reason,
    status: "open",
  });
}

export async function resolveCoverageGap(
  ctx: MutationCtx,
  gapId: Id<"coverageGaps">,
  resolvedAt: number,
) {
  requireFiniteTime(resolvedAt, "resolvedAt");
  const gap = await ctx.db.get(gapId);
  if (!gap) throw new Error("Coverage gap not found");
  if (gap.status === "resolved") return;
  if (resolvedAt < gap.detectedAt) {
    throw new Error("resolvedAt precedes detectedAt");
  }
  await ctx.db.patch(gapId, { status: "resolved", resolvedAt });
}

function overlaps(
  leftFrom: number | undefined,
  leftTo: number | undefined,
  right: CoverageRange,
) {
  if (leftFrom === undefined || leftTo === undefined) return true;
  return leftFrom < right.to && leftTo > right.from;
}

function fullyCovered(range: CoverageRange, windows: CoverageRange[]) {
  const sorted = windows
    .filter((window) => overlaps(window.from, window.to, range))
    .sort((left, right) => left.from - right.from || left.to - right.to);
  let coveredTo = range.from;
  for (const window of sorted) {
    if (window.from > coveredTo) return false;
    coveredTo = Math.max(coveredTo, window.to);
    if (coveredTo >= range.to) return true;
  }
  return false;
}

function validStoredWindow(window: Doc<"coverageWindows">) {
  return (
    Number.isFinite(window.from) &&
    Number.isFinite(window.to) &&
    window.from < window.to &&
    Number.isFinite(window.lastEnumeratedAt) &&
    Number.isFinite(window.lastProcessedAt) &&
    Number.isSafeInteger(window.discoveredCount) &&
    Number.isSafeInteger(window.indexedCount) &&
    Number.isSafeInteger(window.skippedCount) &&
    window.discoveredCount >= 0 &&
    window.indexedCount >= 0 &&
    window.skippedCount >= 0 &&
    window.indexedCount + window.skippedCount <= window.discoveredCount
  );
}

function validStoredGap(gap: Doc<"coverageGaps">) {
  if ((gap.from === undefined) !== (gap.to === undefined)) return false;
  return (
    (gap.from === undefined ||
      (Number.isFinite(gap.from) &&
        Number.isFinite(gap.to) &&
        gap.from < gap.to!)) &&
    Number.isFinite(gap.detectedAt)
  );
}

export async function coverageEntityBelongsToSpace(
  ctx: ReadCtx,
  spaceId: Id<"spaces">,
  entityId: Id<"entities"> | undefined,
  cache: Map<Id<"entities">, Doc<"entities"> | null>,
) {
  if (entityId === undefined) return true;
  let entity = cache.get(entityId);
  if (entity === undefined) {
    entity = await ctx.db.get(entityId);
    cache.set(entityId, entity);
  }
  return entity !== null && entity.spaceId === spaceId;
}

export async function classifyCoverageJob(
  ctx: ReadCtx,
  account: Doc<"sourceAccounts">,
  job: Doc<"ingestJobs">,
  itemCache: Map<Id<"sourceItems">, Doc<"sourceItems"> | null>,
) {
  if (job.spaceId !== account.spaceId || job.sourceAccountId !== account._id) {
    return "invalid" as const;
  }
  let item = itemCache.get(job.sourceItemId);
  if (item === undefined) {
    item = await ctx.db.get(job.sourceItemId);
    itemCache.set(job.sourceItemId, item);
  }
  if (
    !item ||
    item.spaceId !== account.spaceId ||
    item.sourceAccountId !== account._id
  ) {
    return "invalid" as const;
  }
  if (
    item.lifecycle === "forgetting" ||
    item.lifecycle === "forgotten" ||
    job.sourceRevisionId !== item.desiredRevisionId ||
    job.desiredProcessingEpoch !== item.desiredProcessingEpoch
  ) {
    return "superseded" as const;
  }
  return "current" as const;
}

export async function calculateCoverage(
  ctx: ReadCtx,
  args: {
    sourceAccountIds: Id<"sourceAccounts">[];
    recordType: string;
    entityId?: Id<"entities">;
    from: number;
    to: number;
    asOf?: number;
  },
): Promise<QueryCoverage> {
  validateRange(args.from, args.to);
  const recordType = validateRecordType(args.recordType);
  const asOf = args.asOf ?? Date.now();
  requireFiniteTime(asOf, "asOf");
  const accountIds = [...new Set(args.sourceAccountIds)];
  if (accountIds.length > MAX_COVERAGE_ACCOUNTS) {
    return {
      state: "unknown",
      asOf,
      windows: [],
      knownGaps: [],
      pendingJobs: 0,
      failedJobs: 0,
      overflow: true,
    };
  }
  if (accountIds.length === 0) {
    return {
      state: "unknown",
      asOf,
      windows: [],
      knownGaps: [],
      pendingJobs: 0,
      failedJobs: 0,
      overflow: false,
    };
  }

  const range = { from: args.from, to: args.to };
  const returnedWindows: QueryCoverage["windows"] = [];
  const knownGaps: QueryCoverage["knownGaps"] = [];
  let pendingJobs = 0;
  let failedJobs = 0;
  let overflow = false;
  let hasUnknownRange = false;
  let hasStaleRange = false;
  let hasPartialSignal = false;
  let remainingRows = MAX_COVERAGE_ROWS;
  const itemCache = new Map<Id<"sourceItems">, Doc<"sourceItems"> | null>();
  const entityCache = new Map<Id<"entities">, Doc<"entities"> | null>();

  async function takeWithinBudget<T>(loader: (limit: number) => Promise<T[]>) {
    if (remainingRows === 0) {
      overflow = true;
      return [];
    }
    const rows = await loader(remainingRows + 1);
    if (rows.length > remainingRows) overflow = true;
    const accepted = rows.slice(0, remainingRows);
    remainingRows -= accepted.length;
    return accepted;
  }

  for (const sourceAccountId of accountIds) {
    if (remainingRows === 0) {
      overflow = true;
      break;
    }
    const account = await ctx.db.get(sourceAccountId);
    if (!account) {
      hasUnknownRange = true;
      continue;
    }
    if (!Number.isFinite(account.freshnessMs) || account.freshnessMs <= 0) {
      hasPartialSignal = true;
    }
    const windowRows = await takeWithinBudget((limit) =>
      ctx.db
        .query("coverageWindows")
        .withIndex("by_sourceAccount_record", (q) =>
          q.eq("sourceAccountId", sourceAccountId).eq("recordType", recordType),
        )
        .take(limit),
    );
    const gapRows = await takeWithinBudget((limit) =>
      ctx.db
        .query("coverageGaps")
        .withIndex("by_sourceAccount_record_status", (q) =>
          q
            .eq("sourceAccountId", sourceAccountId)
            .eq("recordType", recordType)
            .eq("status", "open"),
        )
        .take(limit),
    );

    const validWindows: Doc<"coverageWindows">[] = [];
    for (const window of windowRows) {
      if (
        window.spaceId !== account.spaceId ||
        !validStoredWindow(window) ||
        !(await coverageEntityBelongsToSpace(
          ctx,
          account.spaceId,
          window.entityId,
          entityCache,
        ))
      ) {
        hasPartialSignal = true;
      } else {
        validWindows.push(window);
      }
    }
    const validGaps: Doc<"coverageGaps">[] = [];
    for (const gap of gapRows) {
      if (
        gap.spaceId !== account.spaceId ||
        !validStoredGap(gap) ||
        !(await coverageEntityBelongsToSpace(
          ctx,
          account.spaceId,
          gap.entityId,
          entityCache,
        ))
      ) {
        hasPartialSignal = true;
      } else {
        validGaps.push(gap);
      }
    }
    const scopedWindows = validWindows.filter(
      (window) =>
        window.recordType === recordType &&
        (args.entityId === undefined
          ? window.entityId === undefined
          : window.entityId === undefined ||
            window.entityId === args.entityId) &&
        overlaps(window.from, window.to, range),
    );
    const structurallyComplete = scopedWindows.filter(
      (window) =>
        window.state === "complete" &&
        window.skippedCount === 0 &&
        window.indexedCount === window.discoveredCount,
    );
    const fresh = structurallyComplete.filter(
      (window) =>
        account.enabled &&
        (account.coverageInvalidatedAt === undefined ||
          (window.lastEnumeratedAt > account.coverageInvalidatedAt &&
            window.lastProcessedAt > account.coverageInvalidatedAt)) &&
        window.lastEnumeratedAt <= asOf &&
        window.lastProcessedAt <= asOf &&
        window.lastEnumeratedAt >= asOf - account.freshnessMs &&
        window.lastProcessedAt >= asOf - account.freshnessMs,
    );
    for (const window of fresh) {
      returnedWindows.push({
        from: window.from,
        to: window.to,
        sourceAccountId,
      });
    }
    const freshCovers = fullyCovered(range, fresh);
    const structuralCovers = fullyCovered(range, structurallyComplete);
    if (!freshCovers) {
      if (structuralCovers) hasStaleRange = true;
      else if (scopedWindows.length > 0) hasPartialSignal = true;
      else hasUnknownRange = true;
    }

    const openGaps = validGaps.filter(
      (gap) =>
        gap.detectedAt <= asOf &&
        gap.status === "open" &&
        gap.recordType === recordType &&
        (args.entityId === undefined ||
          gap.entityId === undefined ||
          gap.entityId === args.entityId) &&
        overlaps(gap.from, gap.to, range),
    );
    if (openGaps.length > 0) hasPartialSignal = true;
    for (const gap of openGaps) {
      knownGaps.push({
        ...(gap.from === undefined ? {} : { from: gap.from }),
        ...(gap.to === undefined ? {} : { to: gap.to }),
        reason: gap.reason,
      });
    }

    for (const state of ["queued", "processing", "staged"] as const) {
      const rows = await takeWithinBudget((limit) =>
        ctx.db
          .query("ingestJobs")
          .withIndex("by_sourceAccountId_and_state", (q) =>
            q.eq("sourceAccountId", sourceAccountId).eq("state", state),
          )
          .take(limit),
      );
      for (const job of rows) {
        const classification = await classifyCoverageJob(
          ctx,
          account,
          job,
          itemCache,
        );
        if (classification === "current") pendingJobs += 1;
        if (classification === "invalid") hasPartialSignal = true;
      }
    }
    for (const state of ["failed", "needs_review"] as const) {
      const rows = await takeWithinBudget((limit) =>
        ctx.db
          .query("ingestJobs")
          .withIndex("by_sourceAccountId_and_state", (q) =>
            q.eq("sourceAccountId", sourceAccountId).eq("state", state),
          )
          .take(limit),
      );
      for (const job of rows) {
        const classification = await classifyCoverageJob(
          ctx,
          account,
          job,
          itemCache,
        );
        if (classification === "current") failedJobs += 1;
        if (classification === "invalid") hasPartialSignal = true;
      }
    }
  }

  const finalOverflow =
    overflow ||
    returnedWindows.length > MAX_COVERAGE_ROWS ||
    knownGaps.length > MAX_COVERAGE_ROWS;
  if (pendingJobs > 0 || failedJobs > 0 || finalOverflow) {
    hasPartialSignal = true;
  }
  const state: QueryCoverage["state"] = hasPartialSignal
    ? "partial"
    : hasUnknownRange
      ? "unknown"
      : hasStaleRange
        ? "stale"
        : "complete";
  return {
    state,
    asOf,
    windows: returnedWindows.slice(0, MAX_COVERAGE_ROWS),
    knownGaps: knownGaps.slice(0, MAX_COVERAGE_ROWS),
    pendingJobs,
    failedJobs,
    overflow: finalOverflow,
  };
}
