-- FIN-5: let the owner name a feed-only `kith.fin_accounts` row the way an
-- archive account can already be named through `kith.finance_account_overrides`
-- (migration 035).
--
-- Plaid can hand back two accounts at one institution with the same reported
-- name -- two loans both called "Mortgage Loan" is the case that prompted
-- this -- and a Plaid-only account has no archive counterpart to carry an
-- override for. `finance_account_overrides` is keyed by `finance_account_id`
-- (the archive's own opaque id) inside a space, neither of which a Plaid-only
-- row has, so that table cannot hold this correction either.
--
-- `display_name` lives on `fin_accounts` itself instead: nullable, so "no
-- override" reads as null rather than a sentinel, and read alongside the
-- row it names rather than through a second table and a second join. An
-- archive-linked account keeps `finance_account_overrides` as the one place
-- its name is corrected -- this column is not read for that case -- so an
-- account is never nameable two different ways at once.
ALTER TABLE kith.fin_accounts
  ADD COLUMN display_name text
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 300);
