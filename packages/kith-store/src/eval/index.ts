// P2-39g3: the retrieval parity instrument's public surface.
//
// `memoryEval.ts` (pure scoring) and `corpus.ts` (the frozen synthetic
// corpus) are ported verbatim from the Convex originals; `recallParity.ts` is
// this package's own seeding and scoring driver against PostgreSQL. See each
// file's module comment for the full account of what it does and why.

export {
  evaluateRetrievalCase,
  reciprocalRankFusion,
  type EvaluationMemoryStatus,
  type RetrievalEvaluation,
  type RetrievalEvaluationCase,
  type RetrievalEvaluationResult,
} from "./memoryEval.js";

export {
  liveRecallCorpus,
  type SeedAccount,
  type SeedFact,
  type SeedMemory,
  type SeedQuery,
} from "./corpus.js";

export {
  runRecallParity,
  scoreRecallCorpus,
  seedRecallCorpus,
  type RecallParityMode,
  type RecallParityQueryResult,
  type RecallParityReport,
  type RunRecallParityOptions,
  type SeedCorpusResult,
  type SeededAccount,
  type SeededFact,
  type SeededThought,
} from "./recallParity.js";
