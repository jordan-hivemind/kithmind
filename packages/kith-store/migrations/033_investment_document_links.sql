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
-- the document of the entry's PRIMARY link and nothing else.
--
-- An entry may have SEVERAL live links. A capital call notice and the wire
-- confirmation that paid it are both the paper for one payment, and an
-- earlier draft of this migration allowed only one: the second could never be
-- confirmed, so it sat as a suggestion nobody could act on, which is noise,
-- which is a defect. So the rule is not "one live link" but "one PRIMARY
-- link": the OLDEST live (`auto_linked` or `confirmed`) row for the entry, by
-- `created_at` then `id`. The mirror follows it, the date replacement rule
-- follows it, and rejecting it promotes the next one.
--
-- `syncEntryDocument` in `src/admin/investmentLinks.ts` is the only writer of
-- the mirror, and it runs in the same transaction as every link write,
-- including the drawer's own "attach this document", which goes through it as
-- an owner-decided `confirmed` link. `test/investmentLinks.test.mjs` runs a
-- whole-table consistency query after every transition and fails if any
-- entry's `document_id` is not its primary link's document.
--
-- ENTRIES THAT ALREADY CARRY A DOCUMENT
--
-- Every drawer attachment made before this migration set `document_id` with
-- no link row behind it. Left alone, the first matching notice would see no
-- live link, auto-link over the owner's own choice, and move the mirror
-- silently -- which is the one unacceptable failure. So the backfill at the
-- foot of this file adopts each of them as a `confirmed`, `decided_by =
-- 'owner'` link with `reason = 'legacy_attached'`, dated at the ENTRY's own
-- `created_at` so it is older than anything a rule can later make and is
-- therefore the primary.
--
-- The same statement is `adoptLegacyEntryDocuments` in
-- `src/admin/investmentLinks.ts`, reachable from
-- `scripts/investment-links-adopt.mjs`, because the schema is applied before
-- the new build deploys and the OLD build goes on writing bare `document_id`
-- values in that window. Running it again after the deploy adopts those too.
-- It is idempotent in both places: the id is derived from the entry id, so a
-- second run conflicts with its own first row and does nothing.
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
  --
  -- Named `..._required_check` and `..._named_check`, not `..._check`: the
  -- inline column CHECKs above already claimed
  -- `investment_document_links_evidence_check` and
  -- `investment_document_links_model_check`, the names PostgreSQL would
  -- otherwise auto-assign these two. Migrations 030 and 031 hit the same
  -- thing; it fails at apply time with 42710, not silently.
  CONSTRAINT investment_document_links_evidence_required_check
    CHECK (decided_by = 'owner' OR jsonb_array_length(evidence) >= 1),
  -- A model answer names its model and nothing else does, so a row cannot
  -- claim a model it did not use, or use one it does not name.
  CONSTRAINT investment_document_links_model_named_check
    CHECK ((decided_by = 'model') = (model IS NOT NULL)),
  FOREIGN KEY (investment_id, space_id)
    REFERENCES kith.investments (id, space_id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id, space_id)
    REFERENCES kith.investment_entries (id, space_id) ON DELETE CASCADE,
  -- `SET NULL (document_id)`, naming the column, not a bare `SET NULL`.
  --
  -- A composite foreign key's bare `ON DELETE SET NULL` nulls EVERY column of
  -- the key, which here means `space_id` as well -- and `space_id` is NOT
  -- NULL, so deleting a document under a link failed with 23502 instead of
  -- clearing the link's document. The column list (PostgreSQL 15 and later)
  -- is what makes the intent expressible: forget the document, keep the
  -- space, and above all keep the row, because the row is where a remembered
  -- rejection lives and a re-parse must not take one with it.
  FOREIGN KEY (document_id, space_id)
    REFERENCES kith.documents (id, space_id) ON DELETE SET NULL (document_id),
  FOREIGN KEY (source_item_id, space_id)
    REFERENCES kith.source_items (id, space_id) ON DELETE CASCADE,
  FOREIGN KEY (date_correction_id, space_id)
    REFERENCES kith.corrections (id, space_id)
      ON DELETE SET NULL (date_correction_id)
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

-- There is deliberately NO "one live link per entry" unique index. See the
-- note at the head of this file: a notice and the wire that paid it are both
-- live links on one payment, and the mirror follows the PRIMARY link, which
-- the index below is what makes cheap to find.
CREATE INDEX investment_document_links_entry_live_idx
  ON kith.investment_document_links (space_id, entry_id, created_at, id)
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

-- The same `SET NULL (column)` repair, on migration 022's own two composite
-- keys. This is not new damage; it is older damage the link table's tests
-- walked into.
--
-- `investment_entries.document_id` and `evidence_span_id` were declared with a
-- bare `ON DELETE SET NULL` on a COMPOSITE key, which nulls every column of
-- the key -- `space_id` included, and `space_id` is NOT NULL. So deleting a
-- document that any entry cited failed outright with 23502 rather than
-- clearing the citation, and a re-parse that removes a document row is
-- exactly the operation this feature makes routine. Naming the column is the
-- whole fix.
--
-- Cheap: both are re-validated against `investment_entries`, which holds the
-- owner's few thousand rows at most.
ALTER TABLE kith.investment_entries
  DROP CONSTRAINT investment_entries_document_id_space_id_fkey,
  ADD CONSTRAINT investment_entries_document_id_space_id_fkey
    FOREIGN KEY (document_id, space_id)
    REFERENCES kith.documents (id, space_id) ON DELETE SET NULL (document_id),
  DROP CONSTRAINT investment_entries_evidence_span_id_space_id_fkey,
  ADD CONSTRAINT investment_entries_evidence_span_id_space_id_fkey
    FOREIGN KEY (evidence_span_id, space_id)
    REFERENCES kith.evidence_spans (id, space_id)
      ON DELETE SET NULL (evidence_span_id);

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

-- ---------------------------------------------------------------------------
-- The backfill: every document already attached to an entry becomes a link.
-- ---------------------------------------------------------------------------
--
-- Why it is not optional, said once more where the statement is: an entry
-- whose `document_id` is set and whose links are empty reads to the scorer as
-- an entry with no document. The first notice that matches it auto-links,
-- the mirror moves off the owner's own choice, and nothing records that it
-- did. That is the silent wrong data this whole design exists to refuse.
--
-- `md5()` of the entry id, not a fresh id: 32 lowercase hex characters
-- satisfy `kith.kith_id`, and a DERIVED id is what makes this idempotent.
-- Run it twice and the second run conflicts with the first run's own row.
-- The `ON CONFLICT` target is the pair index above, so a row a later
-- evaluation has already written for the same (document, investment, entry)
-- also wins over this one -- correctly, because that row was decided with
-- evidence and this one carries none.
--
-- `created_at` and `decided_at` are the ENTRY's `created_at`, not now. The
-- attachment is at least that old, and dating it there is what makes it the
-- PRIMARY link: older than anything the rule can go on to make, so the
-- mirror keeps pointing at the owner's document rather than at the first
-- notice that scores ten points.
--
-- An entry whose document row is gone, or whose document has no source item,
-- is SKIPPED: the mirror is left exactly as it is and no link is invented.
-- `source_item_id` is the link's durable identity and there is nothing
-- truthful to put in it. The count of those rows is raised below rather than
-- guessed at from a comment.
INSERT INTO kith.investment_document_links
  (id, space_id, created_at, investment_id, entry_id, document_id,
   source_item_id, state, score, signals, evidence, decided_by, decided_at,
   reason)
SELECT
  md5('kith.investment_document_links:legacy_attached:' || e.id),
  e.space_id,
  e.created_at,
  e.investment_id,
  e.id,
  e.document_id,
  d.source_item_id,
  'confirmed',
  0,
  '[]'::jsonb,
  '[]'::jsonb,
  'owner',
  e.created_at,
  'legacy_attached'
FROM kith.investment_entries e
JOIN kith.documents d
  ON d.id = e.document_id AND d.space_id = e.space_id
WHERE e.document_id IS NOT NULL
  AND d.source_item_id IS NOT NULL
ON CONFLICT (space_id, source_item_id, investment_id,
             coalesce(entry_id::text, ''))
DO NOTHING;

DO $$
DECLARE
  adopted integer;
  orphaned integer;
BEGIN
  SELECT count(*) INTO adopted
    FROM kith.investment_document_links
   WHERE reason = 'legacy_attached';
  SELECT count(*) INTO orphaned
    FROM kith.investment_entries e
    LEFT JOIN kith.documents d
      ON d.id = e.document_id AND d.space_id = e.space_id
   WHERE e.document_id IS NOT NULL
     AND (d.id IS NULL OR d.source_item_id IS NULL);
  RAISE NOTICE
    'ADM-8b: % attached documents adopted as links; % entries left with a document that has no source item (mirror untouched, no link invented)',
    adopted, orphaned;
END;
$$;
