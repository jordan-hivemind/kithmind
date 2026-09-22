-- PLAID-2: the first real `pull` hit an institution with 23 accounts and
-- failed partway through with
-- "new row for relation \"plaid_securities\" violates check constraint
-- \"plaid_securities_currency_check\"". Migration 043's `currency ~
-- '^[A-Z]{3}$'` assumed every Plaid currency is a three-letter ISO-4217
-- code, but a security or account can carry a null `iso_currency_code` with
-- an `unofficial_currency_code` instead -- a crypto ticker, or a code longer
-- than three letters -- and `packages/plaid-feed/src/mapping.ts` already
-- falls back to that value rather than dropping it.
--
-- Replace the ISO-shape CHECK on every table migration 043 added it to with
-- a bounded-length CHECK: `NULL` stays allowed exactly as before, and any
-- non-empty code up to 20 characters (comfortably longer than any observed
-- Plaid unofficial code) is accepted instead of rejected. This is a pure
-- relaxation -- no existing row that satisfied the old regex can fail the
-- new length check -- so it is safe to apply without touching data.

ALTER TABLE kith.plaid_accounts
  DROP CONSTRAINT plaid_accounts_currency_check,
  ADD CONSTRAINT plaid_accounts_currency_check
    CHECK (currency IS NULL OR char_length(currency) BETWEEN 1 AND 20);

ALTER TABLE kith.plaid_securities
  DROP CONSTRAINT plaid_securities_currency_check,
  ADD CONSTRAINT plaid_securities_currency_check
    CHECK (currency IS NULL OR char_length(currency) BETWEEN 1 AND 20);

ALTER TABLE kith.plaid_balance_snapshots
  DROP CONSTRAINT plaid_balance_snapshots_currency_check,
  ADD CONSTRAINT plaid_balance_snapshots_currency_check
    CHECK (currency IS NULL OR char_length(currency) BETWEEN 1 AND 20);

ALTER TABLE kith.plaid_holding_snapshots
  DROP CONSTRAINT plaid_holding_snapshots_currency_check,
  ADD CONSTRAINT plaid_holding_snapshots_currency_check
    CHECK (currency IS NULL OR char_length(currency) BETWEEN 1 AND 20);

ALTER TABLE kith.plaid_transactions
  DROP CONSTRAINT plaid_transactions_currency_check,
  ADD CONSTRAINT plaid_transactions_currency_check
    CHECK (currency IS NULL OR char_length(currency) BETWEEN 1 AND 20);

ALTER TABLE kith.plaid_investment_transactions
  DROP CONSTRAINT plaid_investment_transactions_currency_check,
  ADD CONSTRAINT plaid_investment_transactions_currency_check
    CHECK (currency IS NULL OR char_length(currency) BETWEEN 1 AND 20);
