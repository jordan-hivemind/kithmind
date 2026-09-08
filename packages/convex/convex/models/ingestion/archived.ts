import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { setDesiredSourceRevision } from "../provenance/model";
import { digestProcessingConfiguration } from "./hash";
import { advanceSourceAssessmentEpoch } from "./model";

export async function createArchivedIngestWork(
  ctx: MutationCtx,
  input: {
    account: Doc<"sourceAccounts">;
    item: Doc<"sourceItems">;
    revision: Doc<"sourceRevisions">;
    textVersion: Doc<"sourceTextVersions">;
    parserArtifactId: Id<"sourceParserArtifacts">;
    archiveSetDigest: string;
    normalizedBundleDigest: string;
    originalPrimaryReceiptId: Id<"sourceArtifactArchiveReceipts">;
    parserPrimaryReceiptId: Id<"sourceArtifactArchiveReceipts">;
    parserBackupReceiptId: Id<"sourceArtifactArchiveReceipts">;
    processing: {
      extractionFingerprint: string;
      extractorFingerprint: string;
      recordSchemaFingerprint: string;
      normalizationFingerprint: string;
      chunkerFingerprint: string;
      correctionRevision: string;
      expectedPageCount: number;
      expectedEvidenceSpanCount: number;
      expectedDocumentCount: number;
      expectedChunkCount: number;
    };
    actorUserId: Id<"users">;
    actorCredentialId: Id<"apiKeys">;
    expectedDesiredProcessingEpoch: number;
    workerDiscoveryWorkId: Id<"workerDiscoveryWork">;
    workerObservationEpoch: number;
  } & (
    | {
        originalBackupReceiptId: Id<"sourceArtifactArchiveReceipts">;
        originalProviderReferenceId?: never;
        originalProviderBindingEpoch?: never;
      }
    | {
        originalProviderReferenceId: Id<"sourceProviderOriginalReferences">;
        originalProviderBindingEpoch: number;
        originalBackupReceiptId?: never;
      }
  ),
): Promise<{
  generation: Doc<"processingGenerations">;
  job: Doc<"ingestJobs">;
  desiredProcessingEpoch: number;
}> {
  if (
    input.item.desiredProcessingEpoch !== input.expectedDesiredProcessingEpoch
  ) {
    throw new Error("Desired processing epoch conflict");
  }
  const processingFingerprint = await digestProcessingConfiguration(
    input.processing,
  );
  const existing = await ctx.db
    .query("processingGenerations")
    .withIndex("by_sourceRevisionId_and_processingFingerprint", (q) =>
      q
        .eq("sourceRevisionId", input.revision._id)
        .eq("processingFingerprint", processingFingerprint),
    )
    .take(2);
  if (existing.length > 1)
    throw new Error("Binary generation identity is not unique");
  if (existing[0]) {
    throw new Error(
      "Processing configuration was already used; increment correctionRevision",
    );
  }
  const desiredProcessingEpoch = input.expectedDesiredProcessingEpoch + 1;
  if (!Number.isSafeInteger(desiredProcessingEpoch)) {
    throw new Error("Desired processing epoch exhausted");
  }
  await setDesiredSourceRevision(ctx, {
    spaceId: input.account.spaceId,
    sourceItemId: input.item._id,
    desiredRevisionId: input.revision._id,
    expectedDesiredProcessingEpoch: input.expectedDesiredProcessingEpoch,
  });
  await advanceSourceAssessmentEpoch(ctx, input.account._id);
  const generationId = await ctx.db.insert("processingGenerations", {
    spaceId: input.account.spaceId,
    sourceAccountId: input.account._id,
    sourceItemId: input.item._id,
    sourceRevisionId: input.revision._id,
    sourceTextVersionId: input.textVersion._id,
    processingFingerprint,
    ...input.processing,
    parserArtifactId: input.parserArtifactId,
    archiveSetDigest: input.archiveSetDigest,
    normalizedBundleDigest: input.normalizedBundleDigest,
    originalPrimaryReceiptId: input.originalPrimaryReceiptId,
    ...(input.originalBackupReceiptId === undefined
      ? {
          originalProviderReferenceId: input.originalProviderReferenceId,
          originalProviderBindingEpoch: input.originalProviderBindingEpoch,
        }
      : { originalBackupReceiptId: input.originalBackupReceiptId }),
    parserPrimaryReceiptId: input.parserPrimaryReceiptId,
    parserBackupReceiptId: input.parserBackupReceiptId,
    desiredProcessingEpoch,
    state: "queued",
    expectedEventCount: 0,
    expectedObservationCount: 0,
    embeddingStatus: "unavailable",
  });
  const jobId = await ctx.db.insert("ingestJobs", {
    spaceId: input.account.spaceId,
    sourceAccountId: input.account._id,
    sourceItemId: input.item._id,
    sourceRevisionId: input.revision._id,
    processingGenerationId: generationId,
    admittedByUserId: input.actorUserId,
    admittedByCredentialId: input.actorCredentialId,
    actorUserId: input.actorUserId,
    actorCredentialId: input.actorCredentialId,
    desiredProcessingEpoch,
    state: "queued",
    attempts: 0,
    leaseEpoch: 0,
    workerManaged: true,
    workerProcessingMode: "parsed_pages_v1",
    workerDiscoveryWorkId: input.workerDiscoveryWorkId,
    workerObservationEpoch: input.workerObservationEpoch,
  });
  const [generation, job] = await Promise.all([
    ctx.db.get(generationId),
    ctx.db.get(jobId),
  ]);
  if (!generation || !job) throw new Error("Binary ingest work insert failed");
  return { generation, job, desiredProcessingEpoch };
}
