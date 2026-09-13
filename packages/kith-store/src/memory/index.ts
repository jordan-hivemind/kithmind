// P2-39h: the memory domain's typed service surface, ported from
// packages/convex/convex/models/thoughts/*, models/facts/* and
// models/records/cardEntityBinding.ts's entity alias scan. See the module
// comment on each file for what was and was not ported and why: `facts.ts`
// and `thoughts.ts` explain the P2-39g seam (`getFactsByIds`/
// `getThoughtsByIds`), and `recall.ts` explains `recallContext`, which
// composes them.

export * from "./lifecycle.js";
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
