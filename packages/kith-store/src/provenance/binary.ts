// Ported from packages/convex/convex/models/provenance/binary.ts (P2-39d):
// the archived-binary half of the PR178 generation chain -- a revision whose
// canonical bytes live in the archive rather than inline, and the parsed
// text version a worker's parser produced from it.

import type { ClientBase, QueryResultRow } from "pg";
import type { TargetedPagesCoverage } from "@repo/worker-protocol";

import { newKithId } from "../ids.js";
import { parseSourceRevisionRepresentation, parseSourceTextRepresentation } from "./representations.js";
import { camelizeSourceRevision, camelizeSourceTextVersion } from "./rows.js";
import type { SourceRevisionRow, SourceTextVersionRow } from "./rows.js";

export function sameTargetedPagesCoverage(
  left: TargetedPagesCoverage | null | undefined,
  right: TargetedPagesCoverage | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return (
    left.sourceSha256 === right.sourceSha256 &&
    left.selectedPdfSha256 === right.selectedPdfSha256 &&
    left.sourcePageCount === right.sourcePageCount &&
    left.coverageFingerprint === right.coverageFingerprint &&
    left.artifactFingerprint === right.artifactFingerprint &&
    left.originalPages.length === right.originalPages.length &&
    left.originalPages.every((page, index) => page === right.originalPages[index])
  );
}

export async function createOrGetArchivedRevision(
  client: ClientBase,
  input: {
    spaceId: string;
    sourceItemId: string;
    contentHash: string;
    byteLength: number;
    mediaType: string;
    capturedAt: Date;
    userId: string;
  },
): Promise<SourceRevisionRow> {
  const rows = await client.query<QueryResultRow>(
    `SELECT * FROM kith.source_revisions WHERE source_item_id = $1 AND content_hash = $2 LIMIT 2`,
    [input.sourceItemId, input.contentHash],
  );
  if (rows.rowCount! > 1) throw new Error("Archived revision identity is not unique");
  const existing = rows.rows[0] && camelizeSourceRevision(rows.rows[0]);
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
  const id = newKithId();
  const result = await client.query<QueryResultRow>(
    `INSERT INTO kith.source_revisions
       (id, space_id, created_at, source_item_id, representation, content_hash_authority, content_hash,
        byte_length, media_type, captured_at, user_id)
     VALUES ($1,$2,transaction_timestamp(),$3,'archived_binary_v1','worker_asserted',$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      id,
      input.spaceId,
      input.sourceItemId,
      input.contentHash,
      input.byteLength,
      input.mediaType,
      input.capturedAt,
      input.userId,
    ],
  );
  const row = camelizeSourceRevision(result.rows[0]!);
  parseSourceRevisionRepresentation(row);
  return row;
}

export async function createOrGetParsedTextVersion(
  client: ClientBase,
  input: {
    spaceId: string;
    sourceRevisionId: string;
    parserArtifactId: string;
    extractionFingerprint: string;
    textHash: string;
    byteLength: number;
    utf16Length: number;
    pageCount: number;
    mappingManifestHash: string;
    representation?: "parsed_pages_v1" | "targeted_pages_v1";
    targetedCoverage?: TargetedPagesCoverage;
  },
): Promise<SourceTextVersionRow> {
  if (
    (input.representation === "targeted_pages_v1") !==
    (input.targetedCoverage !== undefined)
  ) {
    throw new Error("Targeted parsed text requires exact coverage");
  }
  const rows = await client.query<QueryResultRow>(
    `SELECT * FROM kith.source_text_versions
      WHERE source_revision_id = $1 AND extraction_fingerprint = $2 LIMIT 2`,
    [input.sourceRevisionId, input.extractionFingerprint],
  );
  if (rows.rowCount! > 1) throw new Error("Parsed text identity is not unique");
  const existing = rows.rows[0] && camelizeSourceTextVersion(rows.rows[0]);
  if (existing) {
    const parsed = parseSourceTextRepresentation(existing);
    if (
      parsed.kind !== (input.representation ?? "parsed_pages_v1") ||
      existing.spaceId !== input.spaceId ||
      existing.parserArtifactId !== input.parserArtifactId ||
      existing.textHash !== input.textHash ||
      existing.byteLength !== input.byteLength ||
      existing.utf16Length !== input.utf16Length ||
      existing.pageCount !== input.pageCount ||
      existing.mappingManifestHash !== input.mappingManifestHash ||
      !sameTargetedPagesCoverage(
        existing.targetedCoverage,
        input.targetedCoverage,
      )
    ) {
      throw new Error("Conflicting immutable parsed text declaration");
    }
    return existing;
  }
  const id = newKithId();
  const result = await client.query<QueryResultRow>(
    `INSERT INTO kith.source_text_versions
       (id, space_id, created_at, source_revision_id, representation, parser_artifact_id, extraction_fingerprint,
        text_hash, byte_length, utf16_length, page_count, mapping_manifest_hash,
        targeted_coverage, evidence_sealed)
     VALUES ($1,$2,transaction_timestamp(),$3,$11,$4,$5,$6,$7,$8,$9,$10,$12,false)
     RETURNING *`,
    [
      id,
      input.spaceId,
      input.sourceRevisionId,
      input.parserArtifactId,
      input.extractionFingerprint,
      input.textHash,
      input.byteLength,
      input.utf16Length,
      input.pageCount,
      input.mappingManifestHash,
      input.representation ?? "parsed_pages_v1",
      input.targetedCoverage ? JSON.stringify(input.targetedCoverage) : null,
    ],
  );
  const row = camelizeSourceTextVersion(result.rows[0]!);
  parseSourceTextRepresentation(row);
  return row;
}
