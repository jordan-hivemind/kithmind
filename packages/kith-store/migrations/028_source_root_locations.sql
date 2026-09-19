-- ADM-4b: what "Add folder to watch" needs on top of migration 022's
-- `source_roots` and `source_root_reports`.
--
-- Three changes, all additive to the data:
--
-- 1. A root now names a location the watcher host can resolve on its own:
--    a `root_alias` naming one of the host's allow-listed top-level
--    directories (section 6: "The watcher host keeps one local setting: the
--    top-level directories it may read ... A database row can never point it
--    outside them") plus a `relative_path` under it. `last_known_path` stays
--    what it was -- the absolute path the host resolved the provider folder id
--    to on its last pass, a cache -- so the configuration and the cache are no
--    longer the same column.
--
--    The alias pattern is the one the worker protocol already fixes for the
--    `fs://<alias>/<path>` URIs every scanned item carries
--    (`FS_ROOT_ALIAS` in packages/worker-protocol/src/request.ts): a root and
--    the items found under it name the same host directory the same way.
--
-- 2. One source account may now have several roots. Migration 022 gave it a
--    unique index on `source_account_id` because nothing yet asked for two;
--    "which subtrees under its source account it should watch" does, so the
--    index becomes unique over the account and the location instead. Nothing
--    is dropped but the uniqueness: `coalesce` keeps the old rows (whose
--    alias and path are null) covered by it, so two null-location roots on one
--    account stay impossible rather than becoming allowed.
--
-- 3. `source_root_reports` gains the closed state the watcher reports per root
--    (`source.rootReport`). It is on the report and not on the root because it
--    is what one pass saw, not what the owner configured; `source_roots.state`
--    remains the owner's active/paused/problem/retired.
--
-- The CHECK constraints below are the coarse half of the path rule. The exact
-- rule -- no absolute path, no `..`, no empty segment, no control character --
-- is `assertSourceRootLocation` in src/admin/model.ts, which is what every
-- write goes through. These exist so a row that somehow bypassed it is still
-- refused by the database.

ALTER TABLE kith.source_roots
  ADD COLUMN root_alias text
    CHECK (root_alias IS NULL OR root_alias ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  ADD COLUMN relative_path text
    CHECK (relative_path IS NULL OR (
      char_length(relative_path) BETWEEN 1 AND 1024
      -- No control characters, no backslash, and nothing that makes the path
      -- absolute, empty-segmented or upward.
      AND relative_path !~ '[[:cntrl:]\\]'
      AND relative_path !~ '^/'
      AND relative_path !~ '/$'
      AND relative_path !~ '//'
      AND relative_path !~ '(^|/)\.\.?($|/)'
    ));

DROP INDEX kith.source_roots_source_account_idx;

CREATE UNIQUE INDEX source_roots_location_idx
  ON kith.source_roots
     (source_account_id, coalesce(root_alias, ''), coalesce(relative_path, ''));

ALTER TABLE kith.source_root_reports
  ADD COLUMN state text NOT NULL DEFAULT 'ok'
    CHECK (state IN ('ok', 'missing', 'unreadable', 'over_limit'));
