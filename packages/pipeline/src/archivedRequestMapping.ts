import { createHash } from "node:crypto";

import type {
  ArchiveReceiptSelection,
  ArchivedWorkIdentity,
  ParsedTextDeclaration,
  ParserArtifactSelection,
  ProviderOriginalDeclaration,
} from "@repo/worker-protocol";

import type {
  ArchiveCopyIntent,
  OriginalCatalogRow,
  ProcessingCatalogRow,
} from "./archiveCatalogTypes.js";

const ARCHIVE_INTENT_DOMAIN = "kith-archive-intent:v1";

/** Legacy catalogs used source mtimes as provenance creation times. A durable
 * verification proves the object existed by that time, without rewriting its
 * catalog identity or changing the exact body of an already pending request.
 */
export function provenanceCreatedAt(
  createdAt: number,
  ...verifiedAt: number[]
): number {
  const times = [createdAt, ...verifiedAt];
  if (times.some((time) => !Number.isSafeInteger(time) || time < 0)) {
    throw new Error("Invalid provenance timestamp");
  }
  return Math.min(...times);
}

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
  original: Pick<
    OriginalCatalogRow,
    "originalCatalogId" | "copies" | "providerOriginal"
  >;
  processing: Pick<ProcessingCatalogRow, "processingCatalogId" | "copies">;
}): string {
  const value = [
    input.original.providerOriginal?.referenceVersion === "provider_original_v2"
      ? "kith-archive-intent:provider-original:v2"
      : input.original.providerOriginal
        ? "kith-archive-intent:provider-original:v1"
        : ARCHIVE_INTENT_DOMAIN,
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
    ...(input.original.providerOriginal?.referenceVersion ===
    "provider_original_v2"
      ? [
          input.original.providerOriginal.clientReferenceId,
          input.original.providerOriginal.bindingId,
        ]
      : input.original.providerOriginal
        ? [
          copyIntent(input.original.copies.primary!),
          input.original.providerOriginal.clientReferenceId,
          input.original.providerOriginal.bindingId,
          copyIntent(input.original.providerOriginal.locator),
        ]
        : [
            copyIntent(input.original.copies.primary!),
            copyIntent(input.original.copies.independent_backup!),
          ]),
    input.processing.processingCatalogId,
    copyIntent(input.processing.copies.primary),
    ...(input.processing.copies.independent_backup === undefined
      ? []
      : [copyIntent(input.processing.copies.independent_backup)]),
  ] as const;
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

/**
 * Reconstructs the exact v1 intent after the catalog half of the explicit
 * provider-v2 transition was durably written but before the journal half was.
 * The retained records are immutable evidence. This keeps full pending-body
 * validation available on restart without making any legacy copy active.
 */
export function digestRetainedProviderV1ArchiveIntent(input: {
  identity: ArchivedWorkIdentity;
  original: Pick<
    OriginalCatalogRow,
    "originalCatalogId" | "copies" | "providerOriginal"
  >;
  processing: Pick<ProcessingCatalogRow, "processingCatalogId" | "copies"> &
    Pick<ProcessingCatalogRow, "legacyIndependentBackup">;
}): string {
  const provider = input.original.providerOriginal;
  const primary = provider?.referenceVersion === "provider_original_v2"
    ? provider.legacyPrimary
    : undefined;
  const locator = provider?.referenceVersion === "provider_original_v2"
    ? provider.legacyLocator
    : undefined;
  const parserBackup = input.processing.legacyIndependentBackup;
  if (!provider || !primary || !locator || !parserBackup) {
    throw new Error("Retained provider v1 intent is incomplete");
  }
  return digestArchiveIntent({
    identity: input.identity,
    original: {
      originalCatalogId: input.original.originalCatalogId,
      copies: { primary },
      providerOriginal: {
        clientReferenceId: provider.clientReferenceId,
        bindingId: provider.bindingId,
        locator,
        ...(provider.verified === undefined
          ? {}
          : { verified: provider.verified }),
      },
    },
    processing: {
      processingCatalogId: input.processing.processingCatalogId,
      copies: {
        primary: input.processing.copies.primary,
        independent_backup: parserBackup,
      },
    },
  });
}

export function providerOriginalReferenceFingerprint(
  value: ProviderOriginalDeclaration,
): string {
  if (value.referenceVersion === "provider_original_v2") {
    return createHash("sha256")
      .update(
        `provider-original-reference:v2\0${JSON.stringify([
          value.referenceVersion,
          value.providerKind,
          value.clientReferenceId,
          value.sourceContentHash,
          value.sourceByteLength,
          value.providerAccountIdHash,
          value.providerRootDirectoryIdHash,
          value.providerFileIdHash,
          value.providerRevision,
          value.providerContentHash,
          value.verifiedAt,
          value.createdAt,
        ])}`,
        "utf8",
      )
      .digest("hex");
  }
  return createHash("sha256")
    .update(
      `provider-original-reference:v1\0${JSON.stringify([
        value.referenceVersion,
        value.providerKind,
        value.clientReferenceId,
        value.sourceContentHash,
        value.sourceByteLength,
        value.providerAccountIdHash,
        value.providerRootDirectoryIdHash,
        value.providerFileIdHash,
        value.providerRevision,
        value.providerContentHash,
        value.verifiedAt,
        [
          value.locatorBundle.bindingId,
          value.locatorBundle.manifestFingerprint,
          value.locatorBundle.recipientFingerprint,
          value.locatorBundle.repositoryKeyDomainFingerprint,
          value.locatorBundle.repositoryId,
          value.locatorBundle.snapshotId,
          value.locatorBundle.objectName,
          value.locatorBundle.ciphertextHash,
          value.locatorBundle.ciphertextByteLength,
          value.locatorBundle.readbackVerifiedAt,
        ],
        value.createdAt,
      ])}`,
      "utf8",
    )
    .digest("hex");
}

export function createParserArtifactSelection(
  processing: Pick<
    ProcessingCatalogRow,
    "createdAt" | "parserIntent" | "parserOutput" | "copies"
  >,
): ParserArtifactSelection {
  const output = processing.parserOutput;
  if (!output) throw new Error("Parser output is not durable");
  const primary = processing.copies.primary.readbackVerifiedAt;
  const backup = processing.copies.independent_backup?.readbackVerifiedAt;
  if (primary === undefined)
    throw new Error("Parser archive readback times are not durable");
  return {
    kind: "create",
    clientArtifactId: processing.parserIntent.parserArtifactClientId,
    outputHash: output.rawArtifact.sha256,
    outputByteLength: output.rawArtifact.byteLength,
    // P2-70i3: the class that produced the artifact names its media type, and
    // the server checks it against the discovery work's own class.
    outputMediaType: output.rawArtifact.mediaType,
    createdAt: provenanceCreatedAt(
      processing.createdAt,
      primary,
      ...(backup === undefined ? [] : [backup]),
    ),
  };
}

/**
 * P2-104d. Select the parser artifact the server already holds. Used when a
 * re-parse under a changed extraction configuration reproduced the same raw
 * conversion: the artifact's identity is (source revision, parser
 * fingerprint), so creating another one for the same bytes is refused, and
 * rightly.
 */
export function existingParserArtifactSelection(
  parserArtifactId: string,
): ParserArtifactSelection {
  return { kind: "existing", parserArtifactId };
}

export function createArchiveReceiptSelection(
  subjectKind: "original_bytes" | "parser_output",
  row: Pick<OriginalCatalogRow | ProcessingCatalogRow, "createdAt" | "copies">,
  copyRole: "primary" | "independent_backup",
): ArchiveReceiptSelection {
  const copy = row.copies[copyRole];
  if (!copy) throw new Error("Archive copy is not present");
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
    createdAt: provenanceCreatedAt(row.createdAt, copy.readbackVerifiedAt),
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
