import type { BinaryMediaType } from "@repo/worker-protocol";

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  parseSourceRevisionRepresentation,
  parseSourceTextRepresentation,
} from "./representations";

export async function createOrGetArchivedRevision(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceItemId: Id<"sourceItems">;
    contentHash: string;
    byteLength: number;
    mediaType: BinaryMediaType;
    capturedAt: number;
    userId: Id<"users">;
  },
): Promise<Doc<"sourceRevisions">> {
  const rows = await ctx.db
    .query("sourceRevisions")
    .withIndex("by_sourceItemId_and_contentHash", (q) =>
      q
        .eq("sourceItemId", input.sourceItemId)
        .eq("contentHash", input.contentHash),
    )
    .take(2);
  if (rows.length > 1)
    throw new Error("Archived revision identity is not unique");
  const existing = rows[0];
  if (existing) {
    const parsed = parseSourceRevisionRepresentation(existing);
    if (
      parsed.kind !== "archived_binary_v1" ||
      existing.spaceId !== input.spaceId ||
      existing.byteLength !== input.byteLength ||
      existing.mediaType !== input.mediaType
    ) {
      throw new Error("Conflicting immutable archived revision");
    }
    return existing;
  }
  const id = await ctx.db.insert("sourceRevisions", {
    spaceId: input.spaceId,
    sourceItemId: input.sourceItemId,
    representation: "archived_binary_v1",
    contentHashAuthority: "worker_asserted",
    contentHash: input.contentHash,
    byteLength: input.byteLength,
    mediaType: input.mediaType,
    capturedAt: input.capturedAt,
    userId: input.userId,
  });
  const row = await ctx.db.get(id);
  if (!row) throw new Error("Archived revision insert failed");
  parseSourceRevisionRepresentation(row);
  return row;
}

export async function createOrGetParsedTextVersion(
  ctx: MutationCtx,
  input: {
    spaceId: Id<"spaces">;
    sourceRevisionId: Id<"sourceRevisions">;
    parserArtifactId: Id<"sourceParserArtifacts">;
    extractionFingerprint: string;
    textHash: string;
    byteLength: number;
    utf16Length: number;
    pageCount: number;
    mappingManifestHash: string;
  },
): Promise<Doc<"sourceTextVersions">> {
  const rows = await ctx.db
    .query("sourceTextVersions")
    .withIndex("by_sourceRevisionId_and_extractionFingerprint", (q) =>
      q
        .eq("sourceRevisionId", input.sourceRevisionId)
        .eq("extractionFingerprint", input.extractionFingerprint),
    )
    .take(2);
  if (rows.length > 1) throw new Error("Parsed text identity is not unique");
  const existing = rows[0];
  if (existing) {
    const parsed = parseSourceTextRepresentation(existing);
    if (
      parsed.kind !== "parsed_pages_v1" ||
      existing.spaceId !== input.spaceId ||
      existing.parserArtifactId !== input.parserArtifactId ||
      existing.textHash !== input.textHash ||
      existing.byteLength !== input.byteLength ||
      existing.utf16Length !== input.utf16Length ||
      existing.pageCount !== input.pageCount ||
      existing.mappingManifestHash !== input.mappingManifestHash
    ) {
      throw new Error("Conflicting immutable parsed text declaration");
    }
    return existing;
  }
  const id = await ctx.db.insert("sourceTextVersions", {
    spaceId: input.spaceId,
    sourceRevisionId: input.sourceRevisionId,
    representation: "parsed_pages_v1",
    parserArtifactId: input.parserArtifactId,
    extractionFingerprint: input.extractionFingerprint,
    textHash: input.textHash,
    byteLength: input.byteLength,
    utf16Length: input.utf16Length,
    pageCount: input.pageCount,
    mappingManifestHash: input.mappingManifestHash,
    evidenceSealed: false,
  });
  const row = await ctx.db.get(id);
  if (!row) throw new Error("Parsed text declaration insert failed");
  parseSourceTextRepresentation(row);
  return row;
}
