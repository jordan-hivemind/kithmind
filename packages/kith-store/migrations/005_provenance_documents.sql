-- P2-39d: retires the `PostgresProof` demonstration's synthetic
-- document-lifecycle tables and frees the real names migration 004 had to
-- park under a `brain_` prefix.
--
-- Coordination ruling (P2-39d, following PR202/P2-39b's rebase onto this
-- package): the plan convention wins -- preserved Convex ids as
-- `kith.kith_id` text keys -- so the real, Convex-shaped `documents`,
-- `source_revisions` and `chunks` tables migration 004 already created (as
-- `brain_documents`, `brain_source_revisions`, `brain_chunks`, to avoid
-- colliding with these uuid-keyed prototype tables) take the plain names.
-- `spaces` and `api_keys` are the identity row's (P2-39c) to retire the same
-- way; this migration does not touch `kith.spaces`, `kith.api_keys`,
-- `kith.brain_spaces` or `kith.brain_api_keys`.
--
-- The rest of the synthetic proof-of-concept goes with it, not just the
-- three colliding tables: `generations`, `pages`, `evidence` and
-- `synthetic_financial_attachments` exist only to give the prototype's
-- `documents`/`source_revisions`/`chunks` a working demonstration, and
-- `src/provenance/model.ts` in this same PR proves the identical properties
-- the prototype proved (staged/ready/superseded generations, stale-generation
-- rejection by ordinal, sealed source-text immutability, historical
-- citation, forget) against the real schema instead. Keeping both would mean
-- two implementations of one guarantee. `idempotency_receipts` goes too: its
-- `operation` CHECK names only the three document methods this migration
-- retires (`stage_generation`, `activate_generation`, `forget_document`), so
-- once they are gone nothing writes to it. `worker_jobs` is unrelated to
-- documents (P2-39e's ingestion domain owns job leasing) and is untouched.
--
-- `IF EXISTS`: a normal, once-ever application always finds these seven
-- present (migration 001 created them and nothing since has dropped them),
-- so this changes nothing there. It matters for the CI integration proof's
-- reset-and-replay check (postgres-proof.test.mjs, restoring a backup, then
-- wiping every kith_id-domain table and replaying migrations 2 onward): by
-- that point this migration has already consumed these seven once, in the
-- same run, and migration 001 (kept at version 1) is not replayed to
-- recreate them. Dropping what is already absent is a no-op, not an error
-- this migration should ever surface either way.
DROP TABLE IF EXISTS
  kith.synthetic_financial_attachments,
  kith.chunks,
  kith.evidence,
  kith.pages,
  kith.generations,
  kith.source_revisions,
  kith.documents,
  kith.idempotency_receipts
CASCADE;

ALTER TABLE kith.brain_documents RENAME TO documents;
ALTER TABLE kith.brain_source_revisions RENAME TO source_revisions;
ALTER TABLE kith.brain_chunks RENAME TO chunks;
