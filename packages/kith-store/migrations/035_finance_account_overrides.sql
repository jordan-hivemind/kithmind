-- ADM-2b: the owner's own corrections to a finance account's descriptive
-- fields, kept beside the archive rather than in it.
--
-- The archive's `accounts.display_name`, `acct_last4` and `account_type` are
-- overwritten by every adapter discovery (`resolveDiscoveredAccounts` upserts
-- them), so an edit written there would be undone the next time an institution
-- is re-read. An override lives here instead and the Institutions screen shows
-- it over the archive's value. Nothing in the archive changes, and removing the
-- row restores what the archive says.
--
-- A NULL column means "no override, show the archive's value". `closed` is the
-- owner saying the account is finished, so the screen calls it inactive without
-- guessing from its dates.
--
-- `finance_account_id` is the archive's opaque account id. It is not a foreign
-- key because the archive is a different database.
CREATE TABLE kith.finance_account_overrides (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id NOT NULL REFERENCES kith.spaces (id) ON DELETE CASCADE,
  finance_account_id text NOT NULL
    CHECK (char_length(finance_account_id) BETWEEN 1 AND 200),
  display_name text
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
  account_last4 text
    CHECK (account_last4 IS NULL OR account_last4 ~ '^[0-9]{4}$'),
  account_type text
    CHECK (account_type IS NULL OR char_length(account_type) BETWEEN 1 AND 100),
  closed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_by kith.kith_id REFERENCES kith.users (id) ON DELETE SET NULL,
  UNIQUE (space_id, finance_account_id)
);
