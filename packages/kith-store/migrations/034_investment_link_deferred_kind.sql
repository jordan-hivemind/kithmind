-- ADM-8c: the `investment_link` deferred-work kind.
--
-- docs/plans/2026-09-19-investment-document-matching.md section 2 and slice 2
-- of section 8. Migration 033 deliberately left the queue's CHECK alone --
-- "a CHECK widened for a writer that does not exist yet is a CHECK nothing
-- tests" -- so it is widened here, in the same change as the handler and the
-- three triggers that write the rows.
--
-- ONE KIND, NOT TWO. The plan's table names `investment_sweep` beside
-- `investment_link`. The nightly sweep belongs to slice 3, with the detectors
-- it exists to run, so its kind is not added here for the reason 033 gives
-- about this very constraint.
--
-- SAFE TO APPLY BEFORE THE NEW BUILD DEPLOYS. The new list is a superset of
-- the old one, so every existing row already satisfies it and no row is
-- rewritten. The previous web build enqueues none of this kind and the
-- running daemon registers no handler for it; were one to appear anyway,
-- `drain` fails it without consuming an attempt (`failWithoutAttempt`,
-- `src/deferred/drain.ts`) rather than retrying a kind nobody serves.
--
-- Kept in step with `DEFERRED_WORK_KINDS` in `src/deferred/core.ts`, the same
-- way migrations 017 and 027 are: two spellings of one closed set.

ALTER TABLE kith.deferred_work
  DROP CONSTRAINT deferred_work_kind_check,
  ADD CONSTRAINT deferred_work_kind_check
    CHECK (kind IN ('inline_ingestion', 'embedding_fill', 'card_queue_tick',
                    'document_extraction', 'investment_link'));
