// P2-39d: the provenance domain's typed service surface, ported from
// packages/convex/convex/models/provenance/*. See model.ts for the module
// overview: every function takes a `pg.ClientBase` already inside the
// caller's transaction, and a single already-authorized `spaceId`.

export * from "./representations.js";
export * from "./binary.js";
export * from "./artifacts.js";
export * from "./rows.js";
export * from "./archiveBindings.js";
export * from "./archiveDeletion.js";
export * from "./providerOriginals.js";
export {
  insertParsedPages,
  insertParsedEvidence,
  insertParsedDocuments,
  insertParsedChunks,
  requirePageChunkProfile,
  sealParsedPayload,
  verifySealedParsedPayload,
  isParsedStoredPayloadWithinLimit,
  isParsedProfileWithinLimits,
  isParsedChunkTextWithinLimits,
  MAX_PARSED_CHUNKS,
  MAX_PARSED_STORED_PAYLOAD_BYTES,
  PAYLOAD_VERIFY_DETAILS,
  type PayloadVerifyDetail,
  type PayloadVerifyNote,
  type SealedPayloadSummary,
  type VerifiedSealedPayload,
} from "./parsedStaging.js";
export {
  createOrGetRevision,
  createOrGetSourceItem,
  createOrGetTextVersion,
  refreshAvailableSourceItem,
  stagePages,
  stageEvidenceSpans,
  stageCardEvidenceSpans,
  sweepCardEvidenceSpans,
  stageDocuments,
  stageChunks,
  setDesiredSourceRevision,
  activateSourceItemGeneration,
  markSourceItemUnavailable,
  beginSourceItemForget,
  setSourceItemFailure,
  inspectGenerationPayload,
  locateCardQuote,
  MAX_SOURCE_INLINE_UTF8_BYTES,
  MAX_SOURCE_PAGES,
  MAX_EVIDENCE_SPANS,
  MAX_GENERATION_DOCUMENTS,
  MAX_GENERATION_CHUNKS,
  MAX_CHUNK_TEXT_UTF8_BYTES,
  MAX_GENERATION_CHUNK_TEXT_UTF8_BYTES,
  MAX_STAGING_ROWS,
  MAX_STAGING_TEXT_UTF8_BYTES,
  MAX_CARD_EVIDENCE_CITATIONS,
  MAX_SWEEP_GENERATIONS,
  type SourceItemInput,
  type SourceRevisionInput,
  type SourceTextVersionInput,
  type SourcePageInput,
  type EvidenceSpanInput,
  type DocumentInput,
  type ChunkInput,
  type GenerationPayloadSummary,
  type CardEvidenceRef,
} from "./model.js";
