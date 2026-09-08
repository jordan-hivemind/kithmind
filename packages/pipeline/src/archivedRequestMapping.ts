import { createHash } from "node:crypto";

import type {
  ArchiveReceiptSelection,
  ArchivedWorkIdentity,
  ParsedTextDeclaration,
  ParserArtifactSelection,
} from "@repo/worker-protocol";

import type {
  ArchiveCopyIntent,
  OriginalCatalogRow,
  ProcessingCatalogRow,
} from "./archiveCatalogTypes.js";

const ARCHIVE_INTENT_DOMAIN = "kith-archive-intent:v1";

function copyIntent(copy: ArchiveCopyIntent): readonly string[] {
  return [
    copy.role,
    copy.clientReceiptId,
    copy.archiveObjectId,
    copy.objectName,
    copy.archiveIdentityFingerprint,
    copy.archiveProfileFingerprint,
    copy.recipientFingerprint,
    copy.repositoryKeyDomainFingerprint,
    copy.storageFailureDomainFingerprint,
    ...(copy.restic === undefined
      ? ([] as const)
      : [copy.restic.operationId, copy.restic.host, copy.restic.repositoryId]),
  ];
}

/**
 * The server echoes this worker assertion and the local journal persists the
 * exact request. It is not a backend recomputation contract: the ordered
 * preimage binds the exact local catalog intent to the archived work identity
 * before irreversible object work.
 */
export function digestArchiveIntent(input: {
  identity: ArchivedWorkIdentity;
  original: Pick<OriginalCatalogRow, "originalCatalogId" | "copies">;
  processing: Pick<ProcessingCatalogRow, "processingCatalogId" | "copies">;
}): string {
  const value = [
    ARCHIVE_INTENT_DOMAIN,
    input.identity.sourceItemId,
    input.identity.scanId,
    input.identity.observationEpoch,
    input.identity.processingEpoch,
    input.identity.contentHash,
    input.identity.byteLength,
    input.identity.mediaType,
    input.identity.parserProfileId,
    input.identity.parserFingerprint,
    input.identity.extractionConfigurationFingerprint,
    input.identity.extractorFingerprint,
    input.identity.recordSchemaFingerprint,
    input.identity.normalizationFingerprint,
    input.identity.chunkerFingerprint,
    input.identity.correctionRevision,
    input.original.originalCatalogId,
    copyIntent(input.original.copies.primary),
    copyIntent(input.original.copies.independent_backup),
    input.processing.processingCatalogId,
    copyIntent(input.processing.copies.primary),
    copyIntent(input.processing.copies.independent_backup),
  ] as const;
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export function createParserArtifactSelection(
  processing: Pick<
    ProcessingCatalogRow,
    "createdAt" | "parserIntent" | "parserOutput"
  >,
): ParserArtifactSelection {
  const output = processing.parserOutput;
  if (!output) throw new Error("Parser output is not durable");
  return {
    kind: "create",
    clientArtifactId: processing.parserIntent.parserArtifactClientId,
    outputHash: output.rawArtifact.sha256,
    outputByteLength: output.rawArtifact.byteLength,
    outputMediaType: "application/vnd.docling+json",
    createdAt: processing.createdAt,
  };
}

export function createArchiveReceiptSelection(
  subjectKind: "original_bytes" | "parser_output",
  row: Pick<OriginalCatalogRow | ProcessingCatalogRow, "createdAt" | "copies">,
  copyRole: "primary" | "independent_backup",
): ArchiveReceiptSelection {
  const copy = row.copies[copyRole];
  if (!copy.published || (copyRole === "independent_backup" && !copy.backup)) {
    throw new Error("Archive copy is not durable");
  }
  if (copy.readbackVerifiedAt === undefined)
    throw new Error("Archive copy readback time is not durable");
  return {
    kind: "create",
    subjectKind,
    copyRole,
    clientReceiptId: copy.clientReceiptId,
    archiveProfileFingerprint: copy.archiveProfileFingerprint,
    archiveIdentityFingerprint: copy.archiveIdentityFingerprint,
    recipientFingerprint: copy.recipientFingerprint,
    repositoryKeyDomainFingerprint: copy.repositoryKeyDomainFingerprint,
    storageFailureDomainFingerprint: copy.storageFailureDomainFingerprint,
    archiveObjectId: copy.archiveObjectId,
    ciphertextHash: copy.published.ciphertext.sha256,
    ciphertextByteLength: copy.published.ciphertext.byteLength,
    readbackVerifiedAt: copy.readbackVerifiedAt,
    createdAt: row.createdAt,
  };
}

export function existingArchiveReceiptSelection(input: {
  subjectKind: "original_bytes" | "parser_output";
  copyRole: "primary" | "independent_backup";
  receiptId: string;
  bindingEpoch: number;
}): ArchiveReceiptSelection {
  return { kind: "existing", ...input };
}

export function parsedTextDeclaration(input: {
  processing: Pick<ProcessingCatalogRow, "parserOutput" | "spool">;
  mapping: {
    textHash: string;
    textUtf8Length: number;
    textUtf16Length: number;
    mappingManifestHash: string;
    pages: readonly unknown[];
    evidence: readonly unknown[];
    documents: readonly unknown[];
    chunks: readonly unknown[];
  };
}): ParsedTextDeclaration {
  const output = input.processing.parserOutput;
  const spool = input.processing.spool;
  if (!output || !spool) throw new Error("Parsed spool is not durable");
  if (output.pageCount !== input.mapping.pages.length) {
    throw new Error("Parsed page count conflicts with parser output");
  }
  return {
    extractionFingerprint: output.extractionFingerprint,
    textHash: input.mapping.textHash,
    byteLength: input.mapping.textUtf8Length,
    utf16Length: input.mapping.textUtf16Length,
    pageCount: input.mapping.pages.length,
    mappingManifestHash: input.mapping.mappingManifestHash,
    normalizedBundleDigest: spool.sha256,
    expectedEvidenceSpanCount: input.mapping.evidence.length,
    expectedDocumentCount: input.mapping.documents.length,
    expectedChunkCount: input.mapping.chunks.length,
  };
}
