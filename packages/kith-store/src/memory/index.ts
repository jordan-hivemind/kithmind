// P2-39h: the memory domain's typed service surface, ported from
// packages/convex/convex/models/thoughts/*, models/facts/* and
// models/records/cardEntityBinding.ts's entity alias scan. See the module
// comment on each file for what was and was not ported and why: `facts.ts`
// and `thoughts.ts` explain the by-id seams (`getFactsByIds`/
// `getThoughtsByIds`), and `recall.ts` explains `recallContext`, which
// composes them. The query-to-candidates half is P2-39g1's
// `src/embeddings/search.ts`; it lives there rather than here because it
// composes the thought, fact and document legs into one ranker.
//
// P2-39i4 follow-up adds narrative capture's admission gate, in three files:
// `captureAdmission.ts` (the pure port of `models/thoughts/memoryAnalysis.ts`
// plus the classification parser `lifecycle.ts` deliberately left for the
// caller with a model in the loop), `captureClassifier.ts` (the prompt, the
// request and the parse, with the model call injectable), and `capture.ts`
// (the candidate read, the covering-fact read and the apply step). The gate
// itself -- authorize, call out, re-authorize and apply -- is the caller's, in
// `apps/web/src/lib/kith/capture.ts`, because section 4.4 of the web and MCP
// surface plan forbids holding a `pg` connection across a provider call.

export * from "./lifecycle.js";
export * from "./captureAdmission.js";
export {
  normalizeEntityKey,
  normalizeEntityName,
  normalizeLiteralName,
  resolveEntity,
  loadSpaceEntityIndex,
  resolveLiteralName,
} from "./entities.js";
export * from "./facts.js";
export {
  boundedThoughtLimit,
  captureThought,
  deleteThought,
  getThoughtById,
  getThoughtsByAuthorizedIds,
  getThoughtsByIds,
  listBySpaces,
  listCoreBySpaces,
  setCoreStatus,
  transitionMemory,
  updateThought,
} from "./thoughts.js";
export {
  CAPTURE_ANALYSIS_JSON_SCHEMA,
  CAPTURE_CLASSIFIER_API_VERSION,
  CAPTURE_CLASSIFIER_ENDPOINT,
  CAPTURE_CLASSIFIER_MODEL,
  CAPTURE_CLASSIFIER_SYSTEM_PROMPT,
  captureClassifierCitableIds,
  captureClassifierRequestBody,
  captureClassifierUserMessage,
  loadCaptureClassifierConfig,
  MAX_CANDIDATES,
  readCaptureClassifierResponse,
  requestCaptureClassification,
  SIMILARITY_THRESHOLD,
} from "./captureClassifier.js";
export type {
  CaptureClassifier,
  CaptureClassifierCandidate,
  CaptureClassifierConfig,
  CaptureClassifierEnvironment,
  CaptureClassifierFetch,
  CaptureClassifierInput,
  CaptureCoveringFact,
} from "./captureClassifier.js";
export {
  applyCaptureDecision,
  CAPTURE_RETRY_WINDOW_MS,
  COVERING_FACT_CANDIDATES,
  searchCaptureCandidates,
  searchCoveringFacts,
} from "./capture.js";
export type {
  CaptureDecisionInput,
  CaptureDisposition,
  CaptureOutcome,
} from "./capture.js";
export * from "./recall.js";
export {
  computeSpaceStats,
  MAX_STATS_DIGEST_ROWS,
  MAX_STATS_FACT_ROWS,
  MAX_THOUGHT_STATS_ROWS,
} from "./stats.js";
export { listAroundTime, MAX_TIMELINE_WINDOW } from "./timeline.js";

export type * from "./entities.js";
export type * from "./thoughts.js";
export type * from "./stats.js";
export type * from "./timeline.js";
