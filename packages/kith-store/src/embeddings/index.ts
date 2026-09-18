// P2-39g1: the embedding domain's read surface, ported from
// packages/convex/convex/lib/embeddingProvider.ts and
// packages/convex/convex/models/embeddings/*.
//
// Four files, one per concern:
//
//   * `provider.ts`   the embedding provider contract and the fingerprint
//                     that binds a stored vector to the profile that made it.
//   * `scope.ts`      the two stored scope encodings, verbatim.
//   * `targets.ts`    what a space's active index is, and whether one
//                     candidate's target is still eligible for it.
//   * `cardTargets.ts` the card composition a card candidate is rechecked
//                     against.
//   * `search.ts`     the legs that turn a query into ranked candidates.
//
// P2-39g2 adds the write side beside it, in six more files:
//
//   * `state.ts`       the space state row, the profile row and the counters
//                      (I4), plus the coverage a `list_spaces` row reports.
//   * `eligibility.ts` the target rows and the per-write touch that keeps them
//                      in step with the thoughts, chunks and cards they name.
//   * `write.ts`       the vector rows: insert, reuse, replace (I11), delete.
//   * `generations.ts` the profile-transition lifecycle: create, stage,
//                      activate, fail.
//   * `build.ts`       the paged scan, fill and audit, with keyset cursors.
//   * `fill.ts`        the owed page, the idempotent commit and the driver.
//   * `chunkTargets.ts` the chunk parent chain the whole-space paths validate.
//
// `touchWorkerPublicationEmbedding` in `src/workers/publication.ts` still
// maintains the same rows for a worker publish; `eligibility.ts` says why the
// two implementations stay separate.

export {
  BASELINE_EMBEDDING_DIMENSIONS,
  BASELINE_EMBEDDING_ENDPOINT,
  BASELINE_EMBEDDING_MODEL,
  BASELINE_EMBEDDING_MODEL_REVISION,
  BASELINE_EMBEDDING_PROVIDER_ID,
  EMBEDDING_NORMALIZATION,
  EMBEDDING_PREPROCESSING,
  EMBEDDING_PROTOCOL,
  EMBEDDING_PROVIDER_REQUEST_ERROR,
  EMBEDDING_PROVIDER_UNCONFIGURED_ERROR,
  embeddingProfile,
  fingerprintEmbeddingConfig,
  loadEmbeddingConfig,
  providerBatchEmbedder,
  requestEmbedding,
  utf8ByteLength,
} from "./provider.js";
export type {
  BatchEmbedder,
  EmbeddingConfig,
  EmbeddingEnvironment,
  EmbeddingFetch,
  EmbeddingProfile,
  EmbeddingResult,
} from "./provider.js";

export {
  embeddingFillDedupeKey,
  runEmbeddingFillJob,
  scheduleEmbeddingFill,
} from "./fillWork.js";

export { embeddingVectorScopeV2, embeddingVectorSearchScope } from "./scope.js";
export type { EmbeddingTargetKind } from "./scope.js";

export {
  compatibleSearchFingerprint,
  coveredCountsFor,
  embeddingKindCounts,
  findEmbeddingTarget,
  getActiveEmbeddingTarget,
  getActiveTargets,
  MAX_EMBEDDING_TARGET_SPACES,
  UNSEEDED_EMBEDDING_COUNTERS_ERROR,
  usesTargetCounters,
} from "./targets.js";
export type {
  ActiveEmbeddingTarget,
  EmbeddingKindCounts,
  EmbeddingTargetRow,
} from "./targets.js";

export {
  CARD_TARGET_EVENT_KEY,
  cardTargetInputHash,
  composeCardTargetInput,
  findCardTargetEvent,
} from "./cardTargets.js";
export type { CardTargetInput } from "./cardTargets.js";

export {
  assertSearchVector,
  fuseSearchRanks,
  HYBRID_CANDIDATE_CAP,
  HYBRID_DEFAULT_LIMIT,
  HYBRID_MAX_LIMIT,
  MAX_SEMANTIC_CANDIDATES,
  recallCandidates,
  searchChunkAndCardVectorCandidates,
  searchFacts,
  searchThoughtVectorCandidates,
  searchThoughtsByText,
  searchThoughtsHybrid,
} from "./search.js";
export type {
  DocumentSemanticCandidates,
  EmbedQuery,
  FactSearchOptions,
  HybridSearchOptions,
  RecallCandidateOptions,
  SearchTarget,
  ThoughtSearchHit,
  ThoughtSearchOptions,
  ThoughtVectorCandidate,
  ThoughtVectorOptions,
  VectorStatus,
} from "./search.js";

export {
  addCoveredDelta,
  addEligibleDelta,
  addHistoryDelta,
  addKindCounts,
  commitCounterDelta,
  coveredCountList,
  emptyCounterDelta,
  ensureEmbeddingProfile,
  ensureSpaceEmbeddingState,
  MAX_EMBEDDING_COVERAGE_SPACES,
  readSpaceCounters,
  sameCounts,
  spaceEmbeddingCoverage,
  spaceEmbedsAllChunks,
  uniqueSpaceState,
  ZERO_HISTORICAL_COUNTS,
  ZERO_KIND_COUNTS,
} from "./state.js";
export type {
  CoveredCount,
  EmbeddingCounterDelta,
  HistoricalThoughtCounts,
  SpaceCounterReport,
  SpaceEmbeddingCoverage,
  SpaceEmbeddingStateRow,
} from "./state.js";

export {
  applyEligibilityTouch,
  bumpEmbeddingEligibilityEpoch,
  EMBEDDING_FILL_PAGE,
  EMBEDDING_TARGET_CAPACITY_CEILING,
  findEmbeddingTargetRow,
  isCurrentThought,
  markEligibilityTargets,
  owedTargetsPage,
  recordVectorCoverageChange,
  retireEmbeddingTarget,
  seedTargetsFromManifest,
  setTargetCoverage,
  upsertEligibleTarget,
} from "./eligibility.js";
export type {
  EmbeddingEligibilityTouch,
  EmbeddingTargetWriteRow,
} from "./eligibility.js";

export { chunkTargetsOptedIn } from "./cardTargets.js";

export {
  newChunkTargetCaches,
  resolveActiveChunkTarget,
} from "./chunkTargets.js";
export type { ChunkTargetCaches } from "./chunkTargets.js";

export {
  deleteActiveThoughtEmbeddingVectors,
  deleteChunkEmbeddingVectors,
  deleteThoughtEmbeddingVectors,
  embeddingVectorLiteral,
  insertCardEmbedding,
  insertChunkEmbedding,
  insertThoughtEmbedding,
  releaseVectorCoverage,
  requireActiveEmbeddingTarget,
} from "./write.js";
export type { EmbeddingVectorRow } from "./write.js";

export {
  activateEmbeddingGeneration,
  createEmbeddingGeneration,
  deriveEmbeddingManifest,
  EmbeddingManifestLimitError,
  failEmbeddingGeneration,
  getEmbeddingGeneration,
  getStagingEmbeddingManifestInputs,
  MAX_EMBEDDING_MANIFEST_BYTES,
  MAX_EMBEDDING_MANIFEST_SCAN_ROWS,
  MAX_EMBEDDING_MANIFEST_TARGETS,
  MAX_EMBEDDING_VECTOR_ROWS,
  stageEmbeddingGeneration,
  stageEmbeddingVectorBatch,
} from "./generations.js";
export type {
  EmbeddingGenerationRecord,
  EmbeddingManifest,
  EmbeddingManifestInput,
  ManifestTarget,
} from "./generations.js";

export {
  abandonEmbeddingBuild,
  auditEmbeddingCounters,
  COUNTER_DRIFT_DUPLICATE_ROWS,
  COUNTER_DRIFT_RECOUNT,
  counterDriftReason,
  DEFAULT_DUPLICATE_PROBE,
  EMBEDDING_AUDIT_PAGE,
  EMBEDDING_CARD_SCAN_PAGE,
  EMBEDDING_CHUNK_SCAN_PAGE,
  EMBEDDING_TARGET_PAGE,
  EMBEDDING_THOUGHT_SCAN_PAGE,
  getEmbeddingBuildJob,
  MAX_COVERAGE_RECOVERY_ROWS,
  probeDuplicateRows,
  recoverEmbeddingCoverage,
  runEmbeddingBuildPage,
  startEmbeddingBuild,
} from "./build.js";
export type {
  BuildPageResult,
  CoverageRecoveryResult,
  DuplicateRowProbe,
  EmbeddingBuildJobRow,
  EmbeddingBuildPhase,
} from "./build.js";

export {
  commitEmbeddingFillPage,
  embeddingFillRemaining,
  MAX_FILL_VECTORS,
  nextEmbeddingFillPage,
  runEmbeddingFill,
} from "./fill.js";
export type {
  EmbeddingFillCommit,
  EmbeddingFillPage,
  EmbeddingFillResult,
  EmbeddingFillTarget,
  EmbeddingFillVector,
  FillEmbedder,
} from "./fill.js";
