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
// Nothing here writes a row. Staging, activation, the fill driver, the audit
// and the counters belong to the embedding build workstream, and
// `touchWorkerPublicationEmbedding` in `src/workers/publication.ts` already
// maintains eligibility on a publish.

export {
  BASELINE_EMBEDDING_DIMENSIONS,
  BASELINE_EMBEDDING_ENDPOINT,
  BASELINE_EMBEDDING_MODEL,
  BASELINE_EMBEDDING_MODEL_REVISION,
  BASELINE_EMBEDDING_PROVIDER_ID,
  EMBEDDING_NORMALIZATION,
  EMBEDDING_PREPROCESSING,
  EMBEDDING_PROTOCOL,
  embeddingProfile,
  fingerprintEmbeddingConfig,
  loadEmbeddingConfig,
  requestEmbedding,
  utf8ByteLength,
} from "./provider.js";
export type {
  EmbeddingConfig,
  EmbeddingEnvironment,
  EmbeddingFetch,
  EmbeddingProfile,
  EmbeddingResult,
} from "./provider.js";

export { embeddingVectorScopeV2, embeddingVectorSearchScope } from "./scope.js";
export type { EmbeddingTargetKind } from "./scope.js";

export {
  compatibleSearchFingerprint,
  coveredCountsFor,
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
