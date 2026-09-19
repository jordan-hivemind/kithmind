-- ADM-3: the five things the investments screen needs that migration 022
-- could not know it would need, because the screen had not been designed yet.
--
-- 1. `investments.archived_at`. "Archive (soft delete)" is not one of
--    `status`'s values and must not become one: `status` is the investment's
--    own state (active, closed, written off) and the owner filters on it, so
--    overloading it with "hidden from the screen" would make the filter mean
--    two things. A nullable timestamp is the smallest thing that answers
--    "when was this archived", and `NULL` is the whole of the default read's
--    predicate.
--
-- 2. `investment_entries.import_key`. The one-time spreadsheet import must be
--    idempotent: "a second import of the same file creates nothing new". That
--    is a uniqueness claim, so it is a unique index rather than a read the
--    importer does first and races with itself. The key is the importer's own
--    stable identifier for a source row (see
--    `apps/web/src/lib/kith/investment-import.ts`), scoped per space because
--    two spaces importing the same sheet are two independent imports.
--
-- 3. The exchange rate a non-USD amount cannot be converted without.
--    Every total this screen computes is stated in USD as well as in the
--    entry's own currency, and the conversion is `amount * exchange_rate`. A
--    GBP row with a null rate would make that product null and silently drop
--    the entry out of a sum the owner reads as complete. The schema refuses
--    the row instead. Money correctness belongs in the constraint, not only in
--    the drawer that usually fills the field.
--
-- 4. One investment per name per space. Two rows called the same thing split
--    the owner's totals in half without saying so, and the service's read-then-
--    insert check cannot see a concurrent insert. The unique index can, and it
--    is what the duplicate error is raised from.
--
-- 5. Only a `commitment_change` may be negative. Every other entry type
--    carries its direction in the type, so a negative capital call is a data
--    error that would subtract from `sent`. A reduced commitment is the one
--    real signed quantity, so it is the one exception.
--
-- The table is empty in production (the screen it serves lands with this
-- migration), so both new constraints validate against no rows.

ALTER TABLE kith.investments
  ADD COLUMN archived_at timestamptz;

-- The screen's default read: everything not archived, by name. Unique, so a
-- second investment with the same name cannot exist rather than merely being
-- refused by the read the service does first.
CREATE UNIQUE INDEX investments_active_name_idx
  ON kith.investments (space_id, lower(btrim(name)))
  WHERE archived_at IS NULL;

ALTER TABLE kith.investment_entries
  ADD COLUMN import_key text
    CHECK (import_key IS NULL OR char_length(import_key) BETWEEN 1 AND 512);

CREATE UNIQUE INDEX investment_entries_import_key_idx
  ON kith.investment_entries (space_id, import_key)
  WHERE import_key IS NOT NULL;

-- Not `..._exchange_rate_check`: migration 022's inline
-- `CHECK (exchange_rate IS NULL OR exchange_rate > 0)` already holds that
-- auto-generated name, and a second constraint claiming it fails the apply.
ALTER TABLE kith.investment_entries
  ADD CONSTRAINT investment_entries_exchange_rate_present_check
    CHECK (currency = 'USD' OR exchange_rate IS NOT NULL);

ALTER TABLE kith.investment_entries
  ADD CONSTRAINT investment_entries_amount_sign_check
    CHECK (entry_type = 'commitment_change' OR amount >= 0);
