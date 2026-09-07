import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import {
  classifyCoverageJob,
  classifyCoverageFetch,
  coverageEntityBelongsToSpace,
} from "../coverage/model";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MAX_READ_SPACES = 32;
const MAX_SEARCH_CANDIDATES = 64;
const MAX_CITATIONS_PER_RESULT = 16;
const MAX_PAGES = 32;
const MAX_EVIDENCE_SPANS = 128;
const MAX_SOURCE_ACCOUNTS = 32;
const MAX_SOURCE_ITEMS = 128;
const MAX_SOURCE_METADATA_ROWS = 128;
const MAX_QUERY_LENGTH = 500;

type PublicationState = "staged" | "active" | "historical";

function boundedLimit(value: number | undefined) {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return value;
}

function validateSpaces(spaceIds: readonly Id<"spaces">[]) {
  if (spaceIds.length > MAX_READ_SPACES) {
    throw new Error(`Document reads support at most ${MAX_READ_SPACES} spaces`);
  }
}

function validateTimeRange(from: number | undefined, to: number | undefined) {
  if (from !== undefined && !Number.isFinite(from)) {
    throw new Error("from must be finite");
  }
  if (to !== undefined && !Number.isFinite(to)) {
    throw new Error("to must be finite");
  }
  if (from !== undefined && to !== undefined && from >= to) {
    throw new Error("Time ranges must satisfy from < to");
  }
}

function inTimeRange(
  value: number,
  from: number | undefined,
  to: number | undefined,
) {
  return (
    (from === undefined || value >= from) && (to === undefined || value < to)
  );
}

function retainedLifecycle(item: Doc<"sourceItems">) {
  return item.lifecycle === "available" || item.lifecycle === "unavailable";
}

function sourceStatus(
  item: Doc<"sourceItems">,
  generation: Doc<"processingGenerations">,
  publicationState: PublicationState,
) {
  if (publicationState === "historical") return "historical" as const;
  if (
    item.activeGenerationId !== generation._id ||
    item.desiredRevisionId !== item.activeRevisionId ||
    generation.desiredProcessingEpoch !== item.desiredProcessingEpoch ||
    item.lastFailure !== undefined
  ) {
    return "stale" as const;
  }
  return "ready" as const;
}

async function loadReadableDocument(
  ctx: Pick<QueryCtx, "db">,
  document: Doc<"documents">,
  spaceIds: ReadonlySet<Id<"spaces">>,
  includeHistorical: boolean,
) {
  if (
    !spaceIds.has(document.spaceId) ||
    document.publicationState === "staged"
  ) {
    return null;
  }
  if (document.publicationState === "historical" && !includeHistorical) {
    return null;
  }
  const item = await ctx.db.get(document.sourceItemId);
  if (!item) return null;
  const [revision, textVersion, generation, account] = await Promise.all([
    ctx.db.get(document.sourceRevisionId),
    ctx.db.get(document.sourceTextVersionId),
    ctx.db.get(document.processingGenerationId),
    ctx.db.get(item.sourceAccountId),
  ]);
  if (
    !item ||
    !revision ||
    !textVersion ||
    !generation ||
    !account ||
    !retainedLifecycle(item) ||
    item.spaceId !== document.spaceId ||
    account.spaceId !== document.spaceId ||
    revision.spaceId !== document.spaceId ||
    textVersion.spaceId !== document.spaceId ||
    generation.spaceId !== document.spaceId ||
    generation.sourceAccountId !== account._id ||
    revision.sourceItemId !== item._id ||
    textVersion.sourceRevisionId !== revision._id ||
    !textVersion.evidenceSealed ||
    generation.sourceItemId !== item._id ||
    generation.sourceRevisionId !== revision._id ||
    generation.sourceTextVersionId !== textVersion._id ||
    generation.state !== "ready"
  ) {
    return null;
  }
  if (
    document.publicationState === "active" &&
    (item.activeGenerationId !== generation._id ||
      item.activeRevisionId !== revision._id ||
      generation.deactivatedAt !== undefined)
  ) {
    return null;
  }
  if (
    document.publicationState === "historical" &&
    (generation.activatedAt === undefined ||
      generation.deactivatedAt === undefined)
  ) {
    return null;
  }
  return { item, revision, textVersion, generation, account };
}

async function hydrateCitations(
  ctx: Pick<QueryCtx, "db">,
  evidenceSpanIds: readonly Id<"evidenceSpans">[],
  expected: {
    spaceId: Id<"spaces">;
    sourceRevisionId: Id<"sourceRevisions">;
    sourceTextVersionId: Id<"sourceTextVersions">;
  },
  cache?: {
    spans: Map<Id<"evidenceSpans">, Doc<"evidenceSpans"> | null>;
    pages: Map<Id<"sourcePages">, Doc<"sourcePages"> | null>;
  },
) {
  const ids = [...new Set(evidenceSpanIds)].slice(0, MAX_CITATIONS_PER_RESULT);
  const spans: Array<Doc<"evidenceSpans"> | null> = [];
  const pages: Array<Doc<"sourcePages"> | null> = [];
  for (const id of ids) {
    let span = cache?.spans.get(id);
    if (span === undefined) {
      span = await ctx.db.get(id);
      cache?.spans.set(id, span);
    }
    spans.push(span);
    if (!span) {
      pages.push(null);
      continue;
    }
    let page = cache?.pages.get(span.sourcePageId);
    if (page === undefined) {
      page = await ctx.db.get(span.sourcePageId);
      cache?.pages.set(span.sourcePageId, page);
    }
    pages.push(page);
  }
  const citations = spans.flatMap((span, index) => {
    const page = pages[index];
    if (
      !span ||
      !page ||
      span.spaceId !== expected.spaceId ||
      span.sourceRevisionId !== expected.sourceRevisionId ||
      span.sourceTextVersionId !== expected.sourceTextVersionId ||
      page.spaceId !== expected.spaceId ||
      page.sourceTextVersionId !== expected.sourceTextVersionId ||
      span.sourcePageId !== page._id ||
      span.start < 0 ||
      span.end < span.start ||
      span.end > page.text.length
    ) {
      return [];
    }
    return [
      {
        evidenceSpanId: span._id,
        sourcePageId: page._id,
        sourceTextVersionId: span.sourceTextVersionId,
        sourceRevisionId: span.sourceRevisionId,
        pageOrdinal: page.ordinal,
        start: span.start,
        end: span.end,
        quote: page.text.slice(span.start, span.end),
        quoteHash: span.quoteHash,
        locator: span.locator,
      },
    ];
  });
  return {
    citations,
    citationsTruncated: evidenceSpanIds.length > MAX_CITATIONS_PER_RESULT,
    invalidCitations:
      citations.length !== Math.min(ids.length, MAX_CITATIONS_PER_RESULT),
  };
}

export async function searchDocuments(
  ctx: Pick<QueryCtx, "db">,
  spaceIds: readonly Id<"spaces">[],
  args: {
    query: string;
    docType?: string;
    from?: number;
    to?: number;
    limit?: number;
    includeHistorical?: boolean;
  },
  semantic?: {
    chunkIds: readonly Id<"chunks">[];
    vectorStatus: "ready" | "unavailable";
  },
) {
  validateSpaces(spaceIds);
  validateTimeRange(args.from, args.to);
  const query = args.query.trim();
  if (!query || query.length > MAX_QUERY_LENGTH) {
    throw new Error("query is invalid");
  }
  const limit = boundedLimit(args.limit);
  const states: PublicationState[] = args.includeHistorical
    ? ["active", "historical"]
    : ["active"];
  const partitions = states.flatMap((publicationState) =>
    [...spaceIds]
      .sort((left, right) => left.localeCompare(right))
      .map((spaceId) => ({ spaceId, publicationState })),
  );
  let candidateOverflow = false;
  const semanticReady = semantic?.vectorStatus === "ready";
  const keywordBudget = semanticReady
    ? MAX_SEARCH_CANDIDATES / 2
    : MAX_SEARCH_CANDIDATES;
  let remainingCandidates = keywordBudget;
  const candidates: Array<{
    chunk: Doc<"chunks">;
    publicationState: PublicationState;
    rank: number;
  }> = [];
  for (
    let partitionIndex = 0;
    partitionIndex < partitions.length;
    partitionIndex += 1
  ) {
    const partition = partitions[partitionIndex]!;
    if (remainingCandidates === 0) {
      candidateOverflow = true;
      break;
    }
    const rows = await ctx.db
      .query("chunks")
      .withSearchIndex("by_text", (q) =>
        q
          .search("text", query)
          .eq("spaceId", partition.spaceId)
          .eq("publicationState", partition.publicationState),
      )
      .take(remainingCandidates + 1);
    if (rows.length > remainingCandidates) candidateOverflow = true;
    const accepted = rows.slice(0, remainingCandidates);
    remainingCandidates -= accepted.length;
    candidates.push(
      ...accepted.map((chunk, rank) => ({
        chunk,
        publicationState: partition.publicationState,
        rank: partitionIndex * MAX_SEARCH_CANDIDATES + rank,
      })),
    );
  }
  if (semanticReady) {
    const ranks = new Map(
      candidates.map((candidate) => [
        candidate.chunk._id,
        1 / (60 + candidate.rank + 1),
      ]),
    );
    const seen = new Set(candidates.map((candidate) => candidate.chunk._id));
    const ids = [...new Set(semantic.chunkIds)].slice(0, keywordBudget);
    candidateOverflow ||= semantic.chunkIds.length > keywordBudget;
    for (const [rank, id] of ids.entries()) {
      const chunk = await ctx.db.get(id);
      if (!chunk || chunk.publicationState !== "active") continue;
      ranks.set(id, (ranks.get(id) ?? 0) + 1 / (60 + rank + 1));
      if (!seen.has(id)) {
        candidates.push({ chunk, publicationState: "active", rank: 0 });
        seen.add(id);
      }
    }
    for (const candidate of candidates) {
      candidate.rank = -(ranks.get(candidate.chunk._id) ?? 0);
    }
  }
  candidates.sort(
    (left, right) =>
      (left.publicationState === right.publicationState
        ? 0
        : left.publicationState === "active"
          ? -1
          : 1) ||
      left.rank - right.rank ||
      left.chunk._id.localeCompare(right.chunk._id),
  );

  const authorized = new Set(spaceIds);
  const seenDocuments = new Set<Id<"documents">>();
  const chainCache = new Map<
    Id<"documents">,
    Awaited<ReturnType<typeof loadReadableDocument>>
  >();
  const citationCache = {
    spans: new Map<Id<"evidenceSpans">, Doc<"evidenceSpans"> | null>(),
    pages: new Map<Id<"sourcePages">, Doc<"sourcePages"> | null>(),
  };
  const results = [];
  let citationPartial = false;
  for (const candidate of candidates) {
    if (results.length > limit) break;
    const chunk = candidate.chunk;
    if (chunk.publicationState !== candidate.publicationState) continue;
    const document = await ctx.db.get(chunk.documentId);
    if (
      !document ||
      chunk.spaceId !== document.spaceId ||
      document.processingGenerationId !== chunk.processingGenerationId ||
      document.publicationState !== chunk.publicationState ||
      seenDocuments.has(document._id) ||
      (args.docType !== undefined && document.docType !== args.docType) ||
      !inTimeRange(document.capturedAt, args.from, args.to)
    ) {
      continue;
    }
    let chain = chainCache.get(document._id);
    if (chain === undefined) {
      chain = await loadReadableDocument(
        ctx,
        document,
        authorized,
        args.includeHistorical ?? false,
      );
      chainCache.set(document._id, chain);
    }
    if (!chain) continue;
    const citationResult = await hydrateCitations(
      ctx,
      chunk.evidenceSpanIds,
      {
        spaceId: document.spaceId,
        sourceRevisionId: document.sourceRevisionId,
        sourceTextVersionId: document.sourceTextVersionId,
      },
      citationCache,
    );
    citationPartial ||= citationResult.invalidCitations;
    seenDocuments.add(document._id);
    results.push({
      spaceId: document.spaceId,
      sourceAccountId: chain.account._id,
      sourceItemId: chain.item._id,
      sourceRevisionId: chain.revision._id,
      sourceTextVersionId: chain.textVersion._id,
      processingGenerationId: chain.generation._id,
      documentId: document._id,
      chunkId: chunk._id,
      title: document.title,
      docType: document.docType,
      capturedAt: document.capturedAt,
      snippet: chunk.text,
      historical: document.publicationState === "historical",
      contentStatus: sourceStatus(
        chain.item,
        chain.generation,
        document.publicationState,
      ),
      sourceAvailability: chain.item.lifecycle,
      originalLinkAvailable: chain.item.originalLinkAvailable,
      retainedTextAvailable: true,
      vectorStatus: semanticReady
        ? ("ready" as const)
        : ("unavailable" as const),
      citations: citationResult.citations,
      citationsTruncated: citationResult.citationsTruncated,
    });
  }
  const truncated = results.length > limit;
  return {
    results: results.slice(0, limit),
    vectorStatus: semanticReady ? ("ready" as const) : ("unavailable" as const),
    partial: candidateOverflow || citationPartial,
    truncated,
  };
}

export async function getDocument(
  ctx: Pick<QueryCtx, "db">,
  spaceIds: readonly Id<"spaces">[],
  documentId: Id<"documents">,
  includeHistorical = false,
) {
  validateSpaces(spaceIds);
  const document = await ctx.db.get(documentId);
  if (!document) return null;
  const chain = await loadReadableDocument(
    ctx,
    document,
    new Set(spaceIds),
    includeHistorical,
  );
  if (!chain) return null;
  const pageRows = await ctx.db
    .query("sourcePages")
    .withIndex("by_sourceTextVersionId", (q) =>
      q.eq("sourceTextVersionId", chain.textVersion._id),
    )
    .take(MAX_PAGES + 1);
  const spanRows = await ctx.db
    .query("evidenceSpans")
    .withIndex("by_sourceTextVersionId", (q) =>
      q.eq("sourceTextVersionId", chain.textVersion._id),
    )
    .take(MAX_EVIDENCE_SPANS + 1);
  if (pageRows.length > MAX_PAGES || spanRows.length > MAX_EVIDENCE_SPANS) {
    throw new Error("Document content exceeds the supported read bounds");
  }
  const allowedEvidence = new Set(document.evidenceSpanIds);
  const pages = pageRows
    .filter(
      (page) =>
        page.spaceId === document.spaceId &&
        page.sourceTextVersionId === chain.textVersion._id,
    )
    .sort(
      (left, right) =>
        left.ordinal - right.ordinal || left._id.localeCompare(right._id),
    )
    .map((page) => ({
      sourcePageId: page._id,
      ordinal: page.ordinal,
      start: page.start,
      end: page.end,
      text: page.text,
      textHash: page.textHash,
      evidence: spanRows
        .filter(
          (span) =>
            allowedEvidence.has(span._id) &&
            span.sourcePageId === page._id &&
            span.spaceId === document.spaceId &&
            span.sourceRevisionId === chain.revision._id &&
            span.sourceTextVersionId === chain.textVersion._id &&
            span.start >= 0 &&
            span.end >= span.start &&
            span.end <= page.text.length,
        )
        .sort(
          (left, right) =>
            left.ordinal - right.ordinal || left._id.localeCompare(right._id),
        )
        .map((span) => ({
          evidenceSpanId: span._id,
          ordinal: span.ordinal,
          start: span.start,
          end: span.end,
          quote: page.text.slice(span.start, span.end),
          quoteHash: span.quoteHash,
          locator: span.locator,
        })),
    }));
  const validatedEvidenceSpanIds = pages.flatMap((page) =>
    page.evidence.map((span) => span.evidenceSpanId),
  );
  const partial =
    pages.length !== pageRows.length ||
    validatedEvidenceSpanIds.length !== allowedEvidence.size;
  return {
    spaceId: document.spaceId,
    sourceAccountId: chain.account._id,
    sourceItemId: chain.item._id,
    sourceRevisionId: chain.revision._id,
    sourceTextVersionId: chain.textVersion._id,
    processingGenerationId: chain.generation._id,
    documentId: document._id,
    title: document.title,
    docType: document.docType,
    capturedAt: document.capturedAt,
    historical: document.publicationState === "historical",
    contentStatus: sourceStatus(
      chain.item,
      chain.generation,
      document.publicationState,
    ),
    sourceAvailability: chain.item.lifecycle,
    originalLinkAvailable: chain.item.originalLinkAvailable,
    originalUri: chain.item.uri,
    retainedTextAvailable: true,
    archiveRef: chain.revision.archiveRef,
    contentHash: chain.revision.contentHash,
    pages,
    evidenceSpanIds: validatedEvidenceSpanIds,
    partial,
    vectorStatus: "unavailable" as const,
  };
}

async function sourceAccountMetadata(
  ctx: Pick<QueryCtx, "db">,
  account: Doc<"sourceAccounts">,
  asOf: number,
  budget: { remaining: number; overflow: boolean },
  itemCache: Map<Id<"sourceItems">, Doc<"sourceItems"> | null>,
  entityCache: Map<Id<"entities">, Doc<"entities"> | null>,
) {
  const jobStates = [
    "queued",
    "processing",
    "staged",
    "failed",
    "needs_review",
  ] as const;
  async function takeWithinBudget<T>(loader: (limit: number) => Promise<T[]>) {
    if (budget.remaining === 0) {
      budget.overflow = true;
      return [];
    }
    const rows = await loader(budget.remaining + 1);
    if (rows.length > budget.remaining) budget.overflow = true;
    const accepted = rows.slice(0, budget.remaining);
    budget.remaining -= accepted.length;
    return accepted;
  }
  const jobBatches = [];
  for (const state of jobStates) {
    const rows = await takeWithinBudget((limit) =>
      ctx.db
        .query("ingestJobs")
        .withIndex("by_sourceAccountId_and_state", (q) =>
          q.eq("sourceAccountId", account._id).eq("state", state),
        )
        .take(limit),
    );
    jobBatches.push({ state, rows });
  }
  const windows = await takeWithinBudget((limit) =>
    ctx.db
      .query("coverageWindows")
      .withIndex("by_sourceAccountId", (q) =>
        q.eq("sourceAccountId", account._id),
      )
      .take(limit),
  );
  const gaps = await takeWithinBudget((limit) =>
    ctx.db
      .query("coverageGaps")
      .withIndex("by_sourceAccountId_and_status", (q) =>
        q.eq("sourceAccountId", account._id).eq("status", "open"),
      )
      .take(limit),
  );
  const fetchRequests = await takeWithinBudget((limit) =>
    ctx.db
      .query("sourceFetchRequests")
      .withIndex("by_sourceAccountId", (q) =>
        q.eq("sourceAccountId", account._id),
      )
      .take(limit),
  );
  let pendingJobs = 0;
  let failedJobs = 0;
  let invalidJobParent = false;
  for (const request of fetchRequests) {
    const classification = await classifyCoverageFetch(
      ctx,
      account,
      request,
      itemCache,
    );
    if (classification === "current") pendingJobs += 1;
    if (classification === "invalid") invalidJobParent = true;
  }
  for (const batch of jobBatches) {
    for (const job of batch.rows) {
      const classification = await classifyCoverageJob(
        ctx,
        account,
        job,
        itemCache,
      );
      if (classification === "invalid") invalidJobParent = true;
      if (classification !== "current") continue;
      if (
        batch.state === "queued" ||
        batch.state === "processing" ||
        batch.state === "staged"
      ) {
        pendingJobs += 1;
      } else {
        failedJobs += 1;
      }
    }
  }
  const validWindows: Doc<"coverageWindows">[] = [];
  let invalidCoverageParent = false;
  for (const window of windows) {
    if (
      window.spaceId !== account.spaceId ||
      !(await coverageEntityBelongsToSpace(
        ctx,
        account.spaceId,
        window.entityId,
        entityCache,
      ))
    ) {
      invalidCoverageParent = true;
    } else {
      validWindows.push(window);
    }
  }
  const validGaps: Doc<"coverageGaps">[] = [];
  for (const gap of gaps) {
    if (
      gap.spaceId !== account.spaceId ||
      !(await coverageEntityBelongsToSpace(
        ctx,
        account.spaceId,
        gap.entityId,
        entityCache,
      ))
    ) {
      invalidCoverageParent = true;
    } else {
      validGaps.push(gap);
    }
  }
  return {
    pendingJobs,
    failedJobs,
    overflow: budget.overflow || invalidCoverageParent || invalidJobParent,
    windows: validWindows
      .slice(0, MAX_SOURCE_METADATA_ROWS)
      .sort(
        (left, right) =>
          left.from - right.from || left._id.localeCompare(right._id),
      )
      .map((window) => ({
        coverageWindowId: window._id,
        recordType: window.recordType,
        entityId: window.entityId,
        from: window.from,
        to: window.to,
        state: window.state,
        lastEnumeratedAt: window.lastEnumeratedAt,
        lastProcessedAt: window.lastProcessedAt,
        fresh:
          account.enabled &&
          (account.coverageInvalidatedAt === undefined ||
            (window.lastEnumeratedAt > account.coverageInvalidatedAt &&
              window.lastProcessedAt > account.coverageInvalidatedAt)) &&
          window.lastEnumeratedAt <= asOf &&
          window.lastProcessedAt <= asOf &&
          window.lastEnumeratedAt >= asOf - account.freshnessMs &&
          window.lastProcessedAt >= asOf - account.freshnessMs,
        discoveredCount: window.discoveredCount,
        indexedCount: window.indexedCount,
        skippedCount: window.skippedCount,
      })),
    gaps: validGaps
      .filter((gap) => gap.status === "open")
      .slice(0, MAX_SOURCE_METADATA_ROWS)
      .sort(
        (left, right) =>
          left.detectedAt - right.detectedAt ||
          left._id.localeCompare(right._id),
      )
      .map((gap) => ({
        coverageGapId: gap._id,
        recordType: gap.recordType,
        entityId: gap.entityId,
        from: gap.from,
        to: gap.to,
        reason: gap.reason,
        detectedAt: gap.detectedAt,
      })),
  };
}

export async function listSources(
  ctx: Pick<QueryCtx, "db">,
  spaceIds: readonly Id<"spaces">[],
  args: { sourceAccountId?: Id<"sourceAccounts">; limit?: number },
) {
  validateSpaces(spaceIds);
  const limit = boundedLimit(args.limit);
  const asOf = Date.now();
  const authorized = new Set(spaceIds);
  let accountOverflow = false;
  let accounts: Doc<"sourceAccounts">[];
  if (args.sourceAccountId !== undefined) {
    const account = await ctx.db.get(args.sourceAccountId);
    accounts = account && authorized.has(account.spaceId) ? [account] : [];
  } else {
    accounts = [];
    const orderedSpaces = [...spaceIds].sort((left, right) =>
      left.localeCompare(right),
    );
    for (let index = 0; index < orderedSpaces.length; index += 1) {
      const remaining = MAX_SOURCE_ACCOUNTS - accounts.length;
      if (remaining === 0) {
        accountOverflow = true;
        break;
      }
      const rows = await ctx.db
        .query("sourceAccounts")
        .withIndex("by_spaceId", (q) => q.eq("spaceId", orderedSpaces[index]!))
        .take(remaining + 1);
      if (rows.length > remaining) accountOverflow = true;
      accounts.push(...rows.slice(0, remaining));
    }
    accounts.sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left._id.localeCompare(right._id),
    );
  }

  const results = [];
  let itemOverflow = false;
  let remainingItems = MAX_SOURCE_ITEMS;
  const metadataBudget = {
    remaining: MAX_SOURCE_METADATA_ROWS,
    overflow: false,
  };
  const jobItemCache = new Map<Id<"sourceItems">, Doc<"sourceItems"> | null>();
  const coverageEntityCache = new Map<Id<"entities">, Doc<"entities"> | null>();
  for (const account of accounts) {
    if (remainingItems === 0) {
      itemOverflow = true;
      break;
    }
    const itemRows = await ctx.db
      .query("sourceItems")
      .withIndex("by_sourceAccountId", (q) =>
        q.eq("sourceAccountId", account._id),
      )
      .take(remainingItems + 1);
    if (itemRows.length > remainingItems) itemOverflow = true;
    const acceptedItemRows = itemRows.slice(0, remainingItems);
    remainingItems -= acceptedItemRows.length;
    const items = [];
    for (const item of acceptedItemRows) {
      if (
        item.spaceId !== account.spaceId ||
        item.lifecycle === "forgetting" ||
        item.lifecycle === "forgotten"
      ) {
        continue;
      }
      const generation = item.activeGenerationId
        ? await ctx.db.get(item.activeGenerationId)
        : null;
      const retainedTextAvailable = Boolean(
        generation &&
        generation.spaceId === item.spaceId &&
        generation.sourceAccountId === account._id &&
        generation.sourceItemId === item._id &&
        generation.sourceRevisionId === item.activeRevisionId &&
        generation.state === "ready" &&
        generation.deactivatedAt === undefined,
      );
      items.push({
        sourceItemId: item._id,
        externalId: item.externalId,
        title: item.title,
        docType: item.docType,
        lifecycle: item.lifecycle,
        activeRevisionId: retainedTextAvailable
          ? item.activeRevisionId
          : undefined,
        activeGenerationId: retainedTextAvailable
          ? item.activeGenerationId
          : undefined,
        contentStatus: !retainedTextAvailable
          ? ("none" as const)
          : item.desiredRevisionId !== item.activeRevisionId ||
              generation?.desiredProcessingEpoch !==
                item.desiredProcessingEpoch ||
              item.lastFailure
            ? ("stale" as const)
            : ("ready" as const),
        originalLinkAvailable: item.originalLinkAvailable,
        retainedTextAvailable,
        lastFailure: item.lastFailure,
      });
    }
    const metadata = await sourceAccountMetadata(
      ctx,
      account,
      asOf,
      metadataBudget,
      jobItemCache,
      coverageEntityCache,
    );
    results.push({
      sourceAccountId: account._id,
      spaceId: account.spaceId,
      connector: account.connector,
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      cursorVersion: account.cursorVersion,
      lastEnumeratedAt: account.lastEnumeratedAt,
      lastProcessedAt: account.lastProcessedAt,
      freshnessMs: account.freshnessMs,
      items,
      ...metadata,
    });
  }
  const flattenedItemCount = results.reduce(
    (count, result) => count + result.items.length,
    0,
  );
  return {
    sources: results.slice(0, limit),
    partial:
      accountOverflow ||
      itemOverflow ||
      metadataBudget.overflow ||
      results.some((result) => result.overflow),
    truncated: results.length > limit || flattenedItemCount > MAX_SOURCE_ITEMS,
  };
}
