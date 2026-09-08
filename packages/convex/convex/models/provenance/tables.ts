import { defineTable } from "convex/server";
import {
  chunkFields,
  documentFields,
  evidenceSpanFields,
  sourceArtifactArchiveReceiptFields,
  sourceArtifactArchiveBindingFields,
  sourceArtifactDeletionAckFields,
  sourceProviderOriginalBindingFields,
  sourceProviderOriginalDetachAckFields,
  sourceProviderOriginalReferenceFields,
  sourceItemFields,
  sourcePageFields,
  sourceParserArtifactFields,
  sourceRevisionFields,
  sourceTextVersionFields,
} from "./validators";

export const provenanceTables = {
  sourceItems: defineTable(sourceItemFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceAccountId", ["sourceAccountId"])
    .index("by_sourceAccountId_and_externalIdHash", [
      "sourceAccountId",
      "externalIdHash",
    ]),
  sourceRevisions: defineTable(sourceRevisionFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_sourceItemId_and_contentHash", ["sourceItemId", "contentHash"]),
  sourceParserArtifacts: defineTable(sourceParserArtifactFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceAccountId", ["sourceAccountId"])
    .index("by_sourceRevisionId", ["sourceRevisionId"])
    .index("by_sourceRevisionId_and_parserFingerprint", [
      "sourceRevisionId",
      "parserFingerprint",
    ])
    .index("by_sourceAccountId_and_clientArtifactId", [
      "sourceAccountId",
      "clientArtifactId",
    ]),
  sourceArtifactArchiveReceipts: defineTable(sourceArtifactArchiveReceiptFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceAccountId", ["sourceAccountId"])
    .index("by_sourceRevisionId", ["sourceRevisionId"])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_parserArtifactId", ["parserArtifactId"])
    .index("by_sourceAccountId_and_clientReceiptId", [
      "sourceAccountId",
      "clientReceiptId",
    ])
    .index("by_archiveIdentity_and_objectId", [
      "archiveIdentityFingerprint",
      "archiveObjectId",
    ]),
  sourceArtifactArchiveBindings: defineTable(sourceArtifactArchiveBindingFields)
    .index("by_source_subject_role", [
      "sourceAccountId",
      "subjectKey",
      "copyRole",
    ])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_receiptId", ["receiptId"]),
  sourceArtifactDeletionAcks: defineTable(sourceArtifactDeletionAckFields)
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_receiptId_and_forgetEpoch", ["receiptId", "forgetEpoch"])
    .index("by_sourceAccountId_and_deletionId", [
      "sourceAccountId",
      "deletionId",
    ])
    .index("by_sourceAccountId_and_requestId", [
      "sourceAccountId",
      "requestId",
    ]),
  sourceProviderOriginalReferences: defineTable(
    sourceProviderOriginalReferenceFields,
  )
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_sourceRevisionId", ["sourceRevisionId"])
    .index("by_sourceAccountId_and_clientReferenceId", [
      "sourceAccountId",
      "clientReferenceId",
    ])
    .index("by_sourceRevisionId_and_referenceFingerprint", [
      "sourceRevisionId",
      "referenceFingerprint",
    ]),
  sourceProviderOriginalBindings: defineTable(
    sourceProviderOriginalBindingFields,
  )
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_sourceRevisionId", ["sourceRevisionId"])
    .index("by_referenceId", ["referenceId"]),
  sourceProviderOriginalDetachAcks: defineTable(
    sourceProviderOriginalDetachAckFields,
  )
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_referenceId_and_forgetEpoch", ["referenceId", "forgetEpoch"])
    .index("by_sourceAccountId_and_detachId", ["sourceAccountId", "detachId"])
    .index("by_sourceAccountId_and_requestId", [
      "sourceAccountId",
      "requestId",
    ]),
  sourceTextVersions: defineTable(sourceTextVersionFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceRevisionId", ["sourceRevisionId"])
    .index("by_sourceRevisionId_and_extractionFingerprint", [
      "sourceRevisionId",
      "extractionFingerprint",
    ]),
  sourcePages: defineTable(sourcePageFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceTextVersionId", ["sourceTextVersionId"])
    .index("by_sourceTextVersionId_and_ordinal", [
      "sourceTextVersionId",
      "ordinal",
    ]),
  evidenceSpans: defineTable(evidenceSpanFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceTextVersionId", ["sourceTextVersionId"])
    .index("by_sourcePageId", ["sourcePageId"])
    .index("by_sourcePageId_and_ordinal", ["sourcePageId", "ordinal"]),
  documents: defineTable(documentFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_sourceItemId", ["sourceItemId"])
    .index("by_processingGenerationId", ["processingGenerationId"])
    .index("by_spaceId_and_publicationState", ["spaceId", "publicationState"])
    .index("by_processingGenerationId_and_documentKey", [
      "processingGenerationId",
      "documentKey",
    ]),
  chunks: defineTable(chunkFields)
    .index("by_spaceId", ["spaceId"])
    .index("by_processingGenerationId", ["processingGenerationId"])
    .index("by_spaceId_and_publicationState", ["spaceId", "publicationState"])
    .index("by_documentId", ["documentId"])
    .index("by_documentId_and_ordinal", ["documentId", "ordinal"])
    .searchIndex("by_text", {
      searchField: "text",
      filterFields: ["spaceId", "publicationState"],
    }),
};
