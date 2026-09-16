// Shared fixtures for the memory domain tests (P2-39h), built on the identity
// fixture's migrated throwaway database and synthetic rows.

import { identityDatabase, makeMember, makeSpace, makeUser, skip } from "./identityFixture.mjs";

export { identityDatabase, makeMember, makeSpace, makeUser, skip };

// The deterministic fake that used to live here is gone. It stood in for
// P2-39g's ranker while `recallContext` had no real one; P2-39g1 added the
// real `recallCandidates` (`src/embeddings/search.ts`), which ranks over
// `facts.search_text_search` and the thought hybrid leg. Keeping a substring
// matcher beside it would prove nothing the real one does not, and would be
// one more thing that can drift from the contract it claims to stand for.
// `test/memory.test.mjs` now calls the real function.
