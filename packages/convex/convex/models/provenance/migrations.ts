import { v } from "convex/values";
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
