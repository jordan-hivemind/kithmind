-- FIN-2: record the overlap boundary `import-archive` computed for an
-- account, so a reader (the Institutions screen, a future audit) can see how
-- far archive coverage reaches without re-deriving it from the ledger's own
-- rows. `import-archive` re-derives and rewrites this value on every run --
-- it is not authoritative on its own, just a cache of the boundary the last
-- run applied.
--
-- Null means either "this account has no Plaid data yet, so its whole
-- archive history is imported with no boundary" or "this account has no
-- linked archive coverage at all" -- both read the same way: nothing to
-- bound against.

ALTER TABLE kith.fin_accounts
  ADD COLUMN archive_coverage_through date;
