// P2-39h: the memory domain's typed service surface, ported from
// packages/convex/convex/models/thoughts/*, models/facts/* and
// models/records/cardEntityBinding.ts's entity alias scan. See the module
// comment on each file for what was and was not ported and why: `facts.ts`
// and `thoughts.ts` explain the by-id seams (`getFactsByIds`/
// `getThoughtsByIds`), and `recall.ts` explains `recallContext`, which
// composes them. The query-to-candidates half is P2-39g1's
// `src/embeddings/search.ts`; it lives there rather than here because it
// composes the thought, fact and document legs into one ranker.

export * from "./lifecycle.js";
export {
  fallbackThoughtMetadata,
  MAX_CAPTURE_CONTENT_CHARS,
  normalizeCaptureContent,
  preflightNarrativeAdmission,
  THOUGHT_TYPES,
} from "./captureAdmission.js";
export type * from "./captureAdmission.js";
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
  getThoughtsByAuthorizedIds,
  getThoughtsByIds,
  listBySpaces,
  listCoreBySpaces,
  setCoreStatus,
  transitionMemory,
} from "./thoughts.js";
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
