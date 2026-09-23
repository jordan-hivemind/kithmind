-- FIN-4: archive instruments and kith.fin_securities rows are not one to
-- one. PR 435's first real production run of `import-archive` aborted in its
-- securities phase, before any account repair, with "duplicate key value
-- violates unique constraint \"fin_securities_archive_instrument_id_key\"":
-- two archive instrument ids resolve to one existing security (the same
-- CUSIP, ISIN or ticker recorded twice under different archive instrument
-- ids), or an instrument gets re-matched to a row that already carries a
-- different archive instrument's id. Migration 048's
-- `archive_instrument_id text UNIQUE` assumed the 1:1 shape that turned out
-- to be false.
--
-- The fix has two parts:
--
-- 1. Drop the UNIQUE constraint on `fin_securities.archive_instrument_id`,
--    keeping a plain (non-unique) index so a lookup by it is still fast.
--    `archive_instrument_id` is still set, once, on the instrument whose
--    "no match yet" case actually created the row (see importArchive.ts's
--    `resolveArchiveInstrument`) -- it is just no longer the only place a
--    second, third, ... archive instrument that turns out to be the same
--    real security can point.
-- 2. `kith.fin_security_links`: the many-to-one table every *other* archive
--    instrument that resolves onto an existing security is recorded in, so
--    a later run resolves that instrument through this table (the fast,
--    authoritative first lookup `resolveArchiveInstrument` tries) instead of
--    re-deriving the same CUSIP/ISIN/ticker match -- and, more importantly,
--    instead of ever attempting a second `fin_securities` insert with the
--    same `archive_instrument_id` the way the aborted run did.
--
-- `id kith.kith_id PRIMARY KEY` rather than keying this table on
-- `archive_instrument_id` directly, the same reason migration 050's
-- `fin_account_link_overrides` does: `postgres-proof.test.mjs`'s restore test
-- rewinds a restored database by dropping every table with a `kith_id`
-- domain column and replaying migrations from version 1 -- a table with no
-- such column survives that rewind and collides with its own `CREATE TABLE`
-- on replay. `archive_instrument_id UNIQUE` (a plain constraint, not the
-- primary key) keeps the one-link-per-archive-instrument invariant.

ALTER TABLE kith.fin_securities
  DROP CONSTRAINT fin_securities_archive_instrument_id_key;

CREATE INDEX fin_securities_archive_instrument_id_idx
  ON kith.fin_securities (archive_instrument_id);

CREATE TABLE kith.fin_security_links (
  id kith.kith_id PRIMARY KEY,
  archive_instrument_id text NOT NULL UNIQUE
    CHECK (char_length(archive_instrument_id) BETWEEN 1 AND 200),
  security_id kith.kith_id NOT NULL
    REFERENCES kith.fin_securities (id) ON DELETE CASCADE,
  -- How this instrument resolved onto `security_id`: 'cusip', 'isin' or
  -- 'ticker' -- see `matchArchiveInstrumentByIdentifierStrength`. Nullable
  -- for forward compatibility with a future resolution method, the same
  -- convention `fin_accounts.match_method` (migration 050) uses.
  match_method text CHECK (
    match_method IS NULL OR match_method IN ('cusip', 'isin', 'ticker')
  ),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX fin_security_links_security_id_idx
  ON kith.fin_security_links (security_id);
