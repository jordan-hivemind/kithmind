import { getDocumentSize, v } from "convex/values";
import {
  MAX_EVENTS_PER_GENERATION,
  MAX_OBSERVATIONS_PER_GENERATION,
  validateGenerationRecords,
} from "../records/model";
import type { Doc } from "../../_generated/dataModel";
import { internalQuery, type QueryCtx } from "../../_generated/server";
import {
  parseSourceRevisionRepresentation,
  parseSourceTextRepresentation,
} from "./representations";

const MAX_AUDIT_ROWS = 4;
const MAX_CURSOR_CHARS = 8_192;

type AuditPhase = "source_revisions" | "source_text_versions";
type AuditCode = "invalid_representation" | "hash_mismatch" | "parent_mismatch";

const auditResultValidator = v.object({
  scope: v.literal("representations_parents_inline_hashes_only"),
  binaryEnablementReady: v.literal(false),
  phase: v.union(
    v.literal("source_revisions"),
    v.literal("source_text_versions"),
  ),
  inspected: v.number(),
  validCount: v.number(),
  implicitLegacyCount: v.number(),
  explicitRepresentationCount: v.number(),
  invalidCount: v.number(),
  invalidRows: v.array(
    v.object({
      rowId: v.string(),
      code: v.union(
        v.literal("invalid_representation"),
        v.literal("hash_mismatch"),
        v.literal("parent_mismatch"),
      ),
    }),
  ),
  isDone: v.boolean(),
  continueCursor: v.union(v.string(), v.null()),
});

function requireAuditBounds(args: {
  cursor: string | null;
  maxItems: number;
}): void {
  if (
    !Number.isSafeInteger(args.maxItems) ||
    args.maxItems < 1 ||
    args.maxItems > MAX_AUDIT_ROWS ||
    (args.cursor !== null && args.cursor.length > MAX_CURSOR_CHARS)
  ) {
    throw new Error("Invalid provenance audit page bounds");
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256Utf8(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function auditRevisionRow(
  ctx: QueryCtx,
  row: Doc<"sourceRevisions">,
): Promise<{ implicitLegacy: boolean } | { code: AuditCode }> {
  let representation;
  try {
    representation = parseSourceRevisionRepresentation(row);
  } catch {
    return { code: "invalid_representation" };
  }
  const [space, item, user] = await Promise.all([
    ctx.db.get(row.spaceId),
    ctx.db.get(row.sourceItemId),
    ctx.db.get(row.userId),
  ]);
  if (
    !space ||
    !item ||
    item.spaceId !== row.spaceId ||
    item._id !== row.sourceItemId ||
    !user
  ) {
    return { code: "parent_mismatch" };
  }
  const account = await ctx.db.get(item.sourceAccountId);
  if (!account || account.spaceId !== row.spaceId) {
    return { code: "parent_mismatch" };
  }
  if (representation.kind === "inline_utf8_v1") {
    if (
      row.byteLength !== utf8Length(representation.text) ||
      row.contentHash !== (await sha256Utf8(representation.text))
    ) {
      return { code: "hash_mismatch" };
    }
  }
  return {
    implicitLegacy:
      representation.kind === "inline_utf8_v1" && representation.implicitLegacy,
  };
}

async function auditTextVersionRow(
  ctx: QueryCtx,
  row: Doc<"sourceTextVersions">,
): Promise<{ implicitLegacy: boolean } | { code: AuditCode }> {
  let representation;
  try {
    representation = parseSourceTextRepresentation(row);
  } catch {
    return { code: "invalid_representation" };
  }
  const revision = await ctx.db.get(row.sourceRevisionId);
  if (!revision || revision.spaceId !== row.spaceId) {
    return { code: "parent_mismatch" };
  }
  const revisionAudit = await auditRevisionRow(ctx, revision);
  if ("code" in revisionAudit) return revisionAudit;
  try {
    const revisionRepresentation = parseSourceRevisionRepresentation(revision);
    if (
      representation.kind === "parsed_pages_v1" &&
      (revisionRepresentation.kind !== "archived_binary_v1" ||
        !representation.parserArtifactId)
    ) {
      return { code: "parent_mismatch" };
    }
    if (representation.kind === "parsed_pages_v1") {
      const item = await ctx.db.get(revision.sourceItemId);
      const artifactId = ctx.db.normalizeId(
        "sourceParserArtifacts",
        representation.parserArtifactId,
      );
      const artifact = artifactId ? await ctx.db.get(artifactId) : null;
      if (
        !artifact ||
        artifact.spaceId !== row.spaceId ||
        !item ||
        artifact.sourceAccountId !== item.sourceAccountId ||
        artifact.sourceRevisionId !== revision._id ||
        artifact.sourceItemId !== revision.sourceItemId
      ) {
        return { code: "parent_mismatch" };
      }
    }
  } catch {
    return { code: "parent_mismatch" };
  }
  if (representation.kind === "inline_text_v1") {
    if (
      row.byteLength !== utf8Length(representation.text) ||
      row.textHash !== (await sha256Utf8(representation.text))
    ) {
      return { code: "hash_mismatch" };
    }
  }
  return {
    implicitLegacy:
      representation.kind === "inline_text_v1" && representation.implicitLegacy,
  };
}

export async function auditLegacyProvenancePage(
  ctx: QueryCtx,
  args: { phase: AuditPhase; cursor: string | null; maxItems: number },
) {
  requireAuditBounds(args);
  let validCount = 0;
  let implicitLegacyCount = 0;
  let explicitRepresentationCount = 0;
  const invalidRows: Array<{ rowId: string; code: AuditCode }> = [];
  if (args.phase === "source_revisions") {
    const page = await ctx.db.query("sourceRevisions").paginate({
      cursor: args.cursor,
      numItems: args.maxItems,
    });
    for (const row of page.page) {
      const result = await auditRevisionRow(ctx, row);
      if ("code" in result) {
        invalidRows.push({ rowId: row._id, code: result.code });
      } else {
        validCount += 1;
        if (result.implicitLegacy) implicitLegacyCount += 1;
        else explicitRepresentationCount += 1;
      }
    }
    return {
      scope: "representations_parents_inline_hashes_only" as const,
      binaryEnablementReady: false as const,
      phase: args.phase,
      inspected: page.page.length,
      validCount,
      implicitLegacyCount,
      explicitRepresentationCount,
      invalidCount: invalidRows.length,
      invalidRows,
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
    };
  }

  const page = await ctx.db.query("sourceTextVersions").paginate({
    cursor: args.cursor,
    numItems: args.maxItems,
  });
  for (const row of page.page) {
    const result = await auditTextVersionRow(ctx, row);
    if ("code" in result) {
      invalidRows.push({ rowId: row._id, code: result.code });
    } else {
      validCount += 1;
      if (result.implicitLegacy) implicitLegacyCount += 1;
      else explicitRepresentationCount += 1;
    }
  }
  return {
    scope: "representations_parents_inline_hashes_only" as const,
    binaryEnablementReady: false as const,
    phase: args.phase,
    inspected: page.page.length,
    validCount,
    implicitLegacyCount,
    explicitRepresentationCount,
    invalidCount: invalidRows.length,
    invalidRows,
    isDone: page.isDone,
    continueCursor: page.isDone ? null : page.continueCursor,
  };
}

export const auditLegacyProvenance = internalQuery({
  args: {
    phase: v.union(
      v.literal("source_revisions"),
      v.literal("source_text_versions"),
    ),
    cursor: v.optional(v.union(v.string(), v.null())),
    maxItems: v.optional(v.number()),
  },
  returns: auditResultValidator,
  handler: (ctx, args) =>
    auditLegacyProvenancePage(ctx, {
      phase: args.phase,
      cursor: args.cursor ?? null,
      maxItems: args.maxItems ?? MAX_AUDIT_ROWS,
    }),
});

const fullAuditResultValidator = v.object({
  scope: v.literal("full_legacy_payload_v1"),
  phase: v.union(
    v.literal("source_text_versions"),
    v.literal("processing_generations"),
  ),
  inspected: v.number(),
  applicable: v.number(),
  validCount: v.number(),
  incompleteCount: v.number(),
  invalidCount: v.number(),
  invalidRows: v.array(
    v.object({
      rowId: v.string(),
      code: v.union(
        v.literal("representation_invalid"),
        v.literal("parent_invalid"),
        v.literal("payload_invalid"),
        v.literal("transition_budget_exceeded"),
      ),
    }),
  ),
  pagePassed: v.boolean(),
  pageReadyForBinaryEnablement: v.boolean(),
  isDone: v.boolean(),
  continueCursor: v.union(v.string(), v.null()),
});

type FullAuditCode =
  | "representation_invalid"
  | "parent_invalid"
  | "payload_invalid"
  | "transition_budget_exceeded";

function boundedSize(row: Record<string, unknown>, maximum: number): number {
  let size: number;
  try {
    size = getDocumentSize(row as never);
  } catch {
    return -1;
  }
  return Number.isSafeInteger(size) && size > 0 && size <= maximum ? size : -1;
}

function splitPair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const left = text.charCodeAt(offset - 1);
  const right = text.charCodeAt(offset);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

async function validateLegacyTextPayload(
  ctx: QueryCtx,
  text: Doc<"sourceTextVersions">,
): Promise<FullAuditCode | undefined> {
  let parsed;
  try {
    parsed = parseSourceTextRepresentation(text);
  } catch {
    return "representation_invalid";
  }
  if (parsed.kind !== "inline_text_v1") return undefined;
  const revision = await ctx.db.get(text.sourceRevisionId);
  if (
    !revision ||
    revision.spaceId !== text.spaceId ||
    boundedSize(text, 128 * 1024) < 0
  )
    return "parent_invalid";
  let revisionParsed;
  try {
    revisionParsed = parseSourceRevisionRepresentation(revision);
  } catch {
    return "representation_invalid";
  }
  if (
    revisionParsed.kind !== "inline_utf8_v1" ||
    text.byteLength !== utf8Length(parsed.text) ||
    text.textHash !== (await sha256Utf8(parsed.text)) ||
    revision.byteLength !== utf8Length(revisionParsed.text) ||
    revision.contentHash !== (await sha256Utf8(revisionParsed.text))
  )
    return "payload_invalid";
  const [pages, spans] = await Promise.all([
    ctx.db
      .query("sourcePages")
      .withIndex("by_sourceTextVersionId", (q) =>
        q.eq("sourceTextVersionId", text._id),
      )
      .take(33),
    ctx.db
      .query("evidenceSpans")
      .withIndex("by_sourceTextVersionId", (q) =>
        q.eq("sourceTextVersionId", text._id),
      )
      .take(129),
  ]);
  if (pages.length > 32 || spans.length > 128) return "payload_invalid";
  const ordered = [...pages].sort((a, b) => a.ordinal - b.ordinal);
  let cursor = 0;
  for (let ordinal = 0; ordinal < ordered.length; ordinal += 1) {
    const page = ordered[ordinal]!;
    if (
      page.spaceId !== text.spaceId ||
      page.sourceTextVersionId !== text._id ||
      page.ordinal !== ordinal ||
      page.start !== cursor ||
      page.end < page.start ||
      page.end > parsed.text.length ||
      splitPair(parsed.text, page.start) ||
      splitPair(parsed.text, page.end) ||
      parsed.text.slice(page.start, page.end) !== page.text ||
      page.textHash !== (await sha256Utf8(page.text)) ||
      boundedSize(page, 96 * 1024) < 0
    )
      return "payload_invalid";
    cursor = page.end;
  }
  if (text.evidenceSealed && cursor !== parsed.text.length)
    return "payload_invalid";
  const pageById = new Map(pages.map((row) => [row._id, row]));
  for (const span of spans) {
    const page = pageById.get(span.sourcePageId);
    if (
      !page ||
      span.spaceId !== text.spaceId ||
      span.sourceRevisionId !== revision._id ||
      span.sourceTextVersionId !== text._id ||
      span.start < 0 ||
      span.end <= span.start ||
      span.end > page.text.length ||
      splitPair(page.text, span.start) ||
      splitPair(page.text, span.end) ||
      span.quoteHash !==
        (await sha256Utf8(page.text.slice(span.start, span.end))) ||
      boundedSize(span, 8 * 1024) < 0
    )
      return "payload_invalid";
  }
  return undefined;
}

async function validateLegacyGenerationPayload(
  ctx: QueryCtx,
  generation: Doc<"processingGenerations">,
): Promise<FullAuditCode | undefined> {
  if (
    generation.parserArtifactId !== undefined ||
    generation.archiveSetDigest !== undefined ||
    generation.normalizedBundleDigest !== undefined
  )
    return undefined;
  const [account, item, revision, documents, chunks] = await Promise.all([
    ctx.db.get(generation.sourceAccountId),
    ctx.db.get(generation.sourceItemId),
    ctx.db.get(generation.sourceRevisionId),
    ctx.db
      .query("documents")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", generation._id),
      )
      .take(17),
    ctx.db
      .query("chunks")
      .withIndex("by_processingGenerationId", (q) =>
        q.eq("processingGenerationId", generation._id),
      )
      .take(129),
  ]);
  if (
    !account ||
    !item ||
    !revision ||
    account.spaceId !== generation.spaceId ||
    item.spaceId !== generation.spaceId ||
    item.sourceAccountId !== account._id ||
    revision.spaceId !== generation.spaceId ||
    revision.sourceItemId !== item._id ||
    documents.length > 16 ||
    chunks.length > 128
  )
    return "parent_invalid";
  const sealed = generation.state === "staged" || generation.state === "ready";
  if (!generation.sourceTextVersionId) {
    const [eventVersion, observation] = await Promise.all([
      ctx.db
        .query("eventVersions")
        .withIndex("by_processingGenerationId", (q) =>
          q.eq("processingGenerationId", generation._id),
        )
        .first(),
      ctx.db
        .query("observations")
        .withIndex("by_processingGenerationId", (q) =>
          q.eq("processingGenerationId", generation._id),
        )
        .first(),
    ]);
    return sealed ||
      documents.length ||
      chunks.length ||
      eventVersion ||
      observation
      ? "parent_invalid"
      : undefined;
  }
  const text = await ctx.db.get(generation.sourceTextVersionId);
  if (
    !text ||
    text.spaceId !== generation.spaceId ||
    text.sourceRevisionId !== revision._id
  )
    return "parent_invalid";
  const textError = await validateLegacyTextPayload(ctx, text);
  if (textError) return textError;
  const [pageRows, spanRows] = await Promise.all([
    ctx.db
      .query("sourcePages")
      .withIndex("by_sourceTextVersionId", (q) =>
        q.eq("sourceTextVersionId", text._id),
      )
      .take(33),
    ctx.db
      .query("evidenceSpans")
      .withIndex("by_sourceTextVersionId", (q) =>
        q.eq("sourceTextVersionId", text._id),
      )
      .take(129),
  ]);
  if (pageRows.length > 32 || spanRows.length > 128) return "payload_invalid";
  const spanIds = new Set(spanRows.map((row) => row._id));
  const expectedEventCount = generation.expectedEventCount ?? 0;
  const expectedObservationCount = generation.expectedObservationCount ?? 0;
  if (
    !Number.isSafeInteger(generation.expectedPageCount) ||
    generation.expectedPageCount < 0 ||
    generation.expectedPageCount > 32 ||
    !Number.isSafeInteger(generation.expectedEvidenceSpanCount) ||
    generation.expectedEvidenceSpanCount < 0 ||
    generation.expectedEvidenceSpanCount > 128 ||
    !Number.isSafeInteger(generation.expectedDocumentCount) ||
    generation.expectedDocumentCount < 0 ||
    generation.expectedDocumentCount > 16 ||
    !Number.isSafeInteger(generation.expectedChunkCount) ||
    generation.expectedChunkCount < 0 ||
    generation.expectedChunkCount > 128 ||
    !Number.isSafeInteger(expectedEventCount) ||
    expectedEventCount < 0 ||
    expectedEventCount > MAX_EVENTS_PER_GENERATION ||
    !Number.isSafeInteger(expectedObservationCount) ||
    expectedObservationCount < 0 ||
    expectedObservationCount > MAX_OBSERVATIONS_PER_GENERATION ||
    (sealed &&
      (pageRows.length !== generation.expectedPageCount ||
        spanRows.length !== generation.expectedEvidenceSpanCount ||
        documents.length !== generation.expectedDocumentCount ||
        chunks.length !== generation.expectedChunkCount ||
        generation.actualPageCount !== pageRows.length ||
        generation.actualEvidenceSpanCount !== spanRows.length))
  )
    return "payload_invalid";
  const documentIds = new Set(documents.map((row) => row._id));
  let transitionBytes = 0;
  const expectedPublicationState =
    generation.state === "ready"
      ? generation.deactivatedAt === undefined
        ? "active"
        : "historical"
      : "staged";
  for (const document of documents) {
    const size = boundedSize(document, 16 * 1024);
    if (
      size < 0 ||
      document.spaceId !== generation.spaceId ||
      document.processingGenerationId !== generation._id ||
      document.sourceItemId !== generation.sourceItemId ||
      document.sourceRevisionId !== generation.sourceRevisionId ||
      document.sourceTextVersionId !== text._id ||
      document.publicationState !== expectedPublicationState ||
      new Set(document.evidenceSpanIds).size !==
        document.evidenceSpanIds.length ||
      document.evidenceSpanIds.some((id) => !spanIds.has(id))
    )
      return "payload_invalid";
    transitionBytes += size;
  }
  for (const chunk of chunks) {
    const size = boundedSize(chunk, 24 * 1024);
    if (
      size < 0 ||
      chunk.spaceId !== generation.spaceId ||
      chunk.processingGenerationId !== generation._id ||
      !documentIds.has(chunk.documentId) ||
      chunk.sourceTextVersionId !== undefined ||
      chunk.start !== undefined ||
      chunk.end !== undefined ||
      chunk.publicationState !== expectedPublicationState ||
      new Set(chunk.evidenceSpanIds).size !== chunk.evidenceSpanIds.length ||
      chunk.evidenceSpanIds.some((id) => !spanIds.has(id))
    )
      return "payload_invalid";
    transitionBytes += size;
  }
  let records: Awaited<ReturnType<typeof validateGenerationRecords>>;
  try {
    records = await validateGenerationRecords(ctx, {
      spaceId: generation.spaceId,
      processingGenerationId: generation._id,
      expectedEventCount: sealed
        ? expectedEventCount
        : (
            await ctx.db
              .query("eventVersions")
              .withIndex("by_processingGenerationId", (q) =>
                q.eq("processingGenerationId", generation._id),
              )
              .take(MAX_EVENTS_PER_GENERATION + 1)
          ).length,
      expectedObservationCount: sealed
        ? expectedObservationCount
        : (
            await ctx.db
              .query("observations")
              .withIndex("by_processingGenerationId", (q) =>
                q.eq("processingGenerationId", generation._id),
              )
              .take(MAX_OBSERVATIONS_PER_GENERATION + 1)
          ).length,
    });
  } catch {
    return "payload_invalid";
  }
  if (
    (!sealed &&
      (records.eventVersions.length > MAX_EVENTS_PER_GENERATION ||
        records.observations.length > MAX_OBSERVATIONS_PER_GENERATION)) ||
    (sealed &&
      (generation.actualDocumentCount !== documents.length ||
        generation.actualChunkCount !== chunks.length ||
        (generation.actualEventCount ?? 0) !== records.eventVersions.length ||
        (generation.actualObservationCount ?? 0) !==
          records.observations.length))
  )
    return "payload_invalid";
  for (const row of [...records.eventVersions, ...records.observations]) {
    const size = boundedSize(row, 128 * 1024);
    if (size < 0) return "payload_invalid";
    transitionBytes += size;
  }
  if (!Number.isSafeInteger(transitionBytes) || transitionBytes > 1024 * 1024)
    return "transition_budget_exceeded";
  return undefined;
}

export async function auditFullLegacyPayloadPage(
  ctx: QueryCtx,
  args: {
    phase: "source_text_versions" | "processing_generations";
    cursor: string | null;
    maxItems: number;
  },
) {
  requireAuditBounds(args);
  if (args.maxItems !== 1)
    throw new Error("Full legacy payload audit reads one root row per page");
  const page = await ctx.db
    .query(
      args.phase === "source_text_versions"
        ? "sourceTextVersions"
        : "processingGenerations",
    )
    .paginate({ cursor: args.cursor, numItems: 1 });
  const invalidRows: Array<{ rowId: string; code: FullAuditCode }> = [];
  let applicable = 0;
  let incompleteCount = 0;
  for (const row of page.page) {
    let code: FullAuditCode | undefined;
    if (args.phase === "source_text_versions") {
      const parsed = (() => {
        try {
          return parseSourceTextRepresentation(
            row as Doc<"sourceTextVersions">,
          );
        } catch {
          return null;
        }
      })();
      if (!parsed) {
        applicable = 1;
        code = "representation_invalid";
      } else if (parsed.kind === "inline_text_v1") {
        applicable = 1;
        if (!(row as Doc<"sourceTextVersions">).evidenceSealed)
          incompleteCount = 1;
        code = await validateLegacyTextPayload(
          ctx,
          row as Doc<"sourceTextVersions">,
        );
      }
    } else {
      const generation = row as Doc<"processingGenerations">;
      const binaryMarkers = [
        generation.parserArtifactId,
        generation.archiveSetDigest,
        generation.normalizedBundleDigest,
        generation.originalPrimaryReceiptId,
        generation.originalBackupReceiptId,
        generation.parserPrimaryReceiptId,
        generation.parserBackupReceiptId,
      ];
      const hasAnyBinaryMarker = binaryMarkers.some(
        (value) => value !== undefined,
      );
      const hasEveryBinaryMarker = binaryMarkers.every(
        (value) => value !== undefined,
      );
      const text = generation.sourceTextVersionId
        ? await ctx.db.get(generation.sourceTextVersionId)
        : null;
      const parsedText = (() => {
        if (!text) return null;
        try {
          return parseSourceTextRepresentation(text);
        } catch {
          return null;
        }
      })();
      const isClosedParsedBranch =
        hasEveryBinaryMarker &&
        parsedText?.kind === "parsed_pages_v1" &&
        parsedText.parserArtifactId === generation.parserArtifactId &&
        generation.expectedEventCount === 0 &&
        generation.expectedObservationCount === 0;
      if (hasAnyBinaryMarker || parsedText?.kind === "parsed_pages_v1") {
        if (!isClosedParsedBranch) {
          applicable = 1;
          code = "representation_invalid";
        }
      } else {
        applicable = 1;
        if (generation.state !== "staged" && generation.state !== "ready")
          incompleteCount = 1;
        code = await validateLegacyGenerationPayload(ctx, generation);
      }
    }
    if (code) invalidRows.push({ rowId: row._id, code });
  }
  return {
    scope: "full_legacy_payload_v1" as const,
    phase: args.phase,
    inspected: page.page.length,
    applicable,
    validCount: applicable - invalidRows.length,
    incompleteCount,
    invalidCount: invalidRows.length,
    invalidRows,
    pagePassed: invalidRows.length === 0,
    pageReadyForBinaryEnablement:
      invalidRows.length === 0 && incompleteCount === 0,
    isDone: page.isDone,
    continueCursor: page.isDone ? null : page.continueCursor,
  };
}

export const auditFullLegacyPayload = internalQuery({
  args: {
    phase: v.union(
      v.literal("source_text_versions"),
      v.literal("processing_generations"),
    ),
    cursor: v.optional(v.union(v.string(), v.null())),
    maxItems: v.optional(v.number()),
  },
  returns: fullAuditResultValidator,
  handler: (ctx, args) =>
    auditFullLegacyPayloadPage(ctx, {
      phase: args.phase,
      cursor: args.cursor ?? null,
      maxItems: args.maxItems ?? 1,
    }),
});
