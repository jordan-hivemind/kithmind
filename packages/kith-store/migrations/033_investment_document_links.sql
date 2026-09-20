-- ADM-8b: the link between an investment entry and the paper that proves it.
--
-- docs/plans/2026-09-19-investment-document-matching.md sections 3 and 8,
-- slices 1 and 1b: the link table, the deterministic scorer's storage, and
-- the estimated-date marker. Nothing from slices 2 to 7 -- no deferred-work
-- kind, no detectors, no attention rows, no model.
--
-- The plan calls this migration 028. Positions are not labels: `applyKithSchema`
-- requires `migration.version === current + 1` and refuses a gap, the hosted
-- schema is at 32, and 028 has been spent since ADM-4b. So this is 033 and the
-- plan has been corrected to say so.
--
-- WHY A TABLE AND NOT A NULLABLE COLUMN
--
-- `investment_entries.document_id` (migration 022) can hold one answer and no
-- reason for it. This feature needs four things that column cannot carry:
--
--   * FOUR STATES. `auto_linked` (the rule decided and wrote it),
--     `suggested` (the rule is offering it), `confirmed` (the owner agreed)
--     and `rejected` (the owner said no).
--   * PROVENANCE. `evidence` cites the statement observations, with their
--     evidence spans, that the decision was made from, the way
--     `src/extraction/gate.ts` makes a stored value cite a quote. A link the
--     rule or a model made with no evidence is refused at write, below.
--   * A REMEMBERED REJECTION. A `rejected` row is never deleted and the
--     scorer skips any pair that has one, so a link the owner rejected is
--     never proposed or auto-made again -- through a re-extraction, a
--     re-parse, or a nightly sweep. A nullable column set back to NULL
--     remembers nothing and the next run re-links the same wrong document.
--   * AN INVESTMENT-LEVEL LINK. A K-1, an agreement or a capital account
--     statement belongs to the investment, not to one payment. That is a row
--     with `entry_id` null, which a column on the entry cannot express.
--
-- WHICH ONE IS THE SOURCE OF TRUTH
--
-- This table. `investment_entries.document_id` stays exactly where it is and
-- keeps its meaning (the entry's primary citation, which the totals, the
-- screen and `get_investment` already read), but it is now a MIRROR: it holds
-- the document of the entry's one live link and nothing else.
--
-- Two things hold the mirror true. `investment_document_links_entry_live_idx`
-- below allows at most one `auto_linked`-or-`confirmed` row per entry, so
-- "the entry's live link" is always a single well-defined row; and one code
-- path in `src/admin/investmentLinks.ts` writes the link and the mirror in the
-- same transaction (`syncEntryDocument`), including for the drawer's own
-- "attach this document" write, which now goes through it as an owner-decided
-- `confirmed` link. `test/investmentLinks.test.mjs` proves the two cannot
-- disagree after every transition.
--
-- WHY `source_item_id` IS NOT NULL AND `document_id` IS
--
-- The reason migration 027 gives: a re-parse mints new `kith.documents` rows
-- and the source item survives it. So the link's durable identity is the
-- source item, and `document_id` is the current paper for it -- nullable, and
-- `ON DELETE SET NULL` rather than `CASCADE`, because a re-parse that removes
-- the old document row must not take a remembered rejection with it.
--
-- CROSS-SPACE
--
-- Every reference is a COMPOSITE foreign key onto `(id, space_id)`, the way
-- every other table in this schema references its neighbours. That is not
-- decoration: it is what makes "a link can never join a document and an entry
-- from different spaces" a fact the server enforces rather than a rule the
-- application remembers. All five referenced rows must be in this row's own
-- `space_id` or the INSERT fails.

CREATE TABLE kith.investment_document_links (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id NOT NULL REFERENCES kith.spaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  investment_id kith.kith_id NOT NULL,
  -- Null for an investment-level link: a K-1, an agreement, a capital account
  -- statement. It belongs to the investment and to no single payment.
  entry_id kith.kith_id,
  -- The current paper. See the note above on why this is the nullable half of
  -- the pair and `source_item_id` is not.
  document_id kith.kith_id,
  source_item_id kith.kith_id NOT NULL,
  state text NOT NULL CHECK (state IN
    ('auto_linked', 'suggested', 'confirmed', 'rejected')),
  -- The scorer's total. Bounded well above the 11 points the current signals
  -- can reach, so adding a signal is not a migration, and bounded at all so a
  -- writer that multiplies instead of adding fails the INSERT.
  score integer NOT NULL CHECK (score BETWEEN 0 AND 1000),
  -- `[{ "signal": "party", "points": 4, ... }]`: which signals fired, with the
  -- feature each was computed from. The screen renders a reason without a
  -- second read, and a wrong link can be explained after the fact.
  signals jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(signals) = 'array'),
  -- `[{ "field", "observationKey", "evidenceSpanId" }]`: the statements this
  -- decision was made from. Checked non-empty below.
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence) = 'array'),
  decided_by text NOT NULL CHECK (decided_by IN ('rule', 'model', 'owner')),
  decided_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  actor_user_id kith.kith_id REFERENCES kith.users (id) ON DELETE SET NULL,
  model text CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 200),
  -- One short machine-readable word for why this row is in the state it is in
  -- (`party_amount_date`, `tie_two_candidates`, `owner_rejected`, ...). A
  -- closed CHECK would make every new scorer reason a migration; the length
  -- bound is what keeps it a reason and not a paragraph.
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
  -- The `kith.corrections` row that records this link replacing the entry's
  -- estimated date (slice 1b, below). Null when this link has not moved a
  -- date. It is what makes the replacement reversible: rejecting the link
  -- reads the original date back out of that row.
  date_correction_id kith.kith_id,
  UNIQUE (id, space_id),
  -- A rule's or a model's decision must cite what it was made from. The
  -- owner's own decision is its own provenance -- `actor_user_id` and
  -- `decided_at` -- and he may attach a document the rule never proposed.
  CONSTRAINT investment_document_links_evidence_check
    CHECK (decided_by = 'owner' OR jsonb_array_length(evidence) >= 1),
  -- A model answer names its model and nothing else does, so a row cannot
  -- claim a model it did not use, or use one it does not name.
  CONSTRAINT investment_document_links_model_check
    CHECK ((decided_by = 'model') = (model IS NOT NULL)),
  FOREIGN KEY (investment_id, space_id)
    REFERENCES kith.investments (id, space_id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id, space_id)
    REFERENCES kith.investment_entries (id, space_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, space_id)
    REFERENCES kith.documents (id, space_id) ON DELETE SET NULL,
  FOREIGN KEY (source_item_id, space_id)
    REFERENCES kith.source_items (id, space_id) ON DELETE CASCADE,
  FOREIGN KEY (date_correction_id, space_id)
    REFERENCES kith.corrections (id, space_id) ON DELETE SET NULL
);

-- One row per (document identity, investment, entry). This is the remembered
-- rejection's key as well as the de-duplication key: a second evaluation of
-- the same document updates the row it already wrote instead of adding one,
-- and a `rejected` row occupies the pair permanently.
--
-- The plan's index is `(space_id, source_item_id, coalesce(entry_id, ''))`.
-- `investment_id` is added because an investment-level row (`entry_id` null)
-- would otherwise allow only ONE investment per document, and an investment
-- platform statement covers many at once. For an entry-level row it changes
-- nothing: an entry belongs to exactly one investment.
--
-- `entry_id::text` before the coalesce: `''` is not a `kith.kith_id` (the
-- domain's CHECK requires 20 to 64 characters), so the fallback has to be
-- taken in the base type.
CREATE UNIQUE INDEX investment_document_links_pair_idx
  ON kith.investment_document_links
     (space_id, source_item_id, investment_id, coalesce(entry_id::text, ''));

-- At most one LIVE link per entry. This is what makes
-- `investment_entries.document_id` a well-defined mirror rather than a guess
-- among several. `suggested` and `rejected` rows are deliberately outside the
-- index: an entry may be offered several documents at once, and may have
-- refused any number of them.
CREATE UNIQUE INDEX investment_document_links_entry_live_idx
  ON kith.investment_document_links (space_id, entry_id)
  WHERE entry_id IS NOT NULL AND state IN ('auto_linked', 'confirmed');

-- The investment row's expanded documents list, and the per-entry pill.
CREATE INDEX investment_document_links_investment_idx
  ON kith.investment_document_links
     (space_id, investment_id, state, created_at DESC, id);

CREATE INDEX investment_document_links_entry_idx
  ON kith.investment_document_links (space_id, entry_id, state);

-- The scorer's own lookup: "what does this document already link to", which
-- is both the de-duplication read and the remembered-rejection read.
CREATE INDEX investment_document_links_source_item_idx
  ON kith.investment_document_links (space_id, source_item_id, state);

-- Migration 023's feed, so the investments screen and the entry drawer update
-- live when a link lands, exactly as `investment_entries` already does.
CREATE TRIGGER investment_document_links_change_trg
  AFTER INSERT OR UPDATE OR DELETE ON kith.investment_document_links
  FOR EACH ROW EXECUTE FUNCTION kith.record_change();

-- ---------------------------------------------------------------------------
-- Slice 1b: the estimated-date marker.
-- ---------------------------------------------------------------------------
--
-- Owner requirement, 2026-09-19: many imported commitments have no signing
-- date, so the import dates them at the first payment and marks the date
-- estimated; a matched document that states the real date should correct the
-- estimate. Some payment dates are estimates too.
--
-- THE MARKER VALUE FOR LEGACY ROWS IS `false`, AND THAT IS THE POINT. Every
-- row that exists when this migration runs reads as owner-entered, so nothing
-- this feature does can rewrite any date already in the database. Only a row
-- the import (or the owner, through the drawer) marks from here on may ever
-- have its date replaced by a document. The commitments the ADM-3b import
-- already estimated carry the note "date estimated from first payment" and
-- keep it; they are not back-marked, because a backfill keyed off a free-text
-- note is exactly the kind of guess that turns into a silently wrong date.
--
-- `NOT NULL DEFAULT false` is metadata-only on PostgreSQL 11 and later: the
-- default is constant, so no existing row is rewritten and the ACCESS
-- EXCLUSIVE lock is held for the catalog update alone. The previous web build
-- keeps working across this: it selects named columns and never sees this one.
ALTER TABLE kith.investment_entries
  ADD COLUMN date_is_estimated boolean NOT NULL DEFAULT false;

-- `kith.corrections.target_kind` gains `entry`.
--
-- The date replacement is recorded as a RESOLVED corrections row -- old date
-- in `original_value`, new date in `corrected_value`, the cited observation
-- and span in `reason` -- because that table already keeps an original beside
-- a correction and every such change is then listed in the daily digest. No
-- history table is added.
--
-- Resolved, not open: it is a record of a change already made, not a queue
-- item. `corrections_dedupe_key_idx` (migration 030) covers `open` and
-- `snoozed` rows only, so these rows never contend with the queue's keys.
--
-- Only `entry` is added. The plan also lists `investment` and `link`; those
-- belong to the detectors in slice 3 and arrive with them, because a CHECK
-- widened for a writer that does not exist yet is a CHECK nothing tests.
-- Every query in `src/extraction/corrections.ts` filters
-- `target_kind = 'document'`, so the widened check disturbs no existing path.
ALTER TABLE kith.corrections
  DROP CONSTRAINT corrections_target_kind_check,
  ADD CONSTRAINT corrections_target_kind_check
    CHECK (target_kind IN ('document', 'field', 'record', 'entry'));
