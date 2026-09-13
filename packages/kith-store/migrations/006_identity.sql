-- The identity and authorization domain: the plain table names, plus the
-- constraints and indexes P2-39b's generator leaves to the row that owns each
-- domain, plus the one table that generator has no export to shape.
--
-- Part 1 settles a name collision rather than inventing anything. Migration 001
-- created `kith.spaces` and `kith.api_keys` as `uuid`-keyed prototype tables, and
-- migration 004 had to name the Convex-mapped ones `brain_spaces` and
-- `brain_api_keys` to get past them. The plan's convention wins: a kith table's
-- key is the preserved Convex id as `kith.kith_id` (section 2.2), so the plain
-- names go to the `kith_id`-keyed tables and the prototype's move to `proof_`.
--
-- The prototype's pair is renamed rather than dropped, and that is deliberate.
-- Migration 005 (P2-39d) retired the prototype's document stack, so what is left
-- referencing `kith.spaces` and `kith.api_keys` is `kith.worker_jobs` (migration
-- 002), whose `space_id` and two credential columns are `uuid` and whose domain is
-- P2-39e's job leasing, not this row's. Dropping the pair would mean retyping that
-- table; renaming frees the names this row was asked to free without reaching into
-- another row's, because a foreign key follows its table through a rename.
--
-- Part 2 is the tightening. Migration 004 declares every non-structural column
-- nullable and constraint-free on purpose: "this row's job is structural fidelity
-- and the six parity checks, not the final production schema", with the
-- required/optional split and the CHECKs left to P2-39c through P2-39l. So the
-- NOT NULLs, the CHECKs, the uniqueness and the indexes every read in
-- `src/identity/` actually uses are declared here.
--
-- Part 3 adds `kith.sessions`. Convex `authSessions` is not migrated (the owner
-- re-logs in once at cutover, decision 3), so there is no export to shape it from
-- and migration 004 correctly has no entry for it.
--
-- Four constraints are deliberately *not* declared, each because it would turn a
-- tested denial into a failed load:
--
--   * No `UNIQUE (space_id, user_id)` on `space_members`. `requireSpaceAccess`
--     reads two rows and denies unless exactly one came back, so a duplicate
--     membership is a denial today. The count check stays in code.
--   * No `UNIQUE` on `consumed_oauth_codes.code_hash`: a duplicate receipt is an
--     `invalid_grant` denial.
--   * `api_keys.capabilities` stays nullable: a legacy key with no capabilities is
--     refused with "API key migration required", and NOT NULL would make that
--     state unrepresentable.
--   * No `NOT NULL` on `auth_accounts.type`: the auth library's account insert
--     writes userId, provider, providerAccountId and secret and never a type, so
--     every migrated row has none.

-- ---------------------------------------------------------------------------
-- Part 1. The plain names go to the kith_id-keyed tables.
-- ---------------------------------------------------------------------------

ALTER TABLE kith.spaces RENAME TO proof_spaces;
ALTER TABLE kith.api_keys RENAME TO proof_api_keys;

ALTER TABLE kith.brain_spaces RENAME TO spaces;
ALTER TABLE kith.brain_api_keys RENAME TO api_keys;

-- ---------------------------------------------------------------------------
-- Part 2. The identity domain's own constraints and indexes.
-- ---------------------------------------------------------------------------

-- A new row's creation time is now. Migration 004 omits the default because the
-- loader supplies `_creationTime` from the export for every migrated row.
ALTER TABLE kith.users ALTER COLUMN created_at SET DEFAULT transaction_timestamp();
ALTER TABLE kith.auth_accounts ALTER COLUMN created_at SET DEFAULT transaction_timestamp();
ALTER TABLE kith.spaces ALTER COLUMN created_at SET DEFAULT transaction_timestamp();
ALTER TABLE kith.space_members ALTER COLUMN created_at SET DEFAULT transaction_timestamp();
ALTER TABLE kith.user_space_settings ALTER COLUMN created_at SET DEFAULT transaction_timestamp();
ALTER TABLE kith.api_keys ALTER COLUMN created_at SET DEFAULT transaction_timestamp();
ALTER TABLE kith.family_invitations ALTER COLUMN created_at SET DEFAULT transaction_timestamp();
ALTER TABLE kith.consumed_oauth_codes ALTER COLUMN created_at SET DEFAULT transaction_timestamp();

-- Sign-in reads the account, not the user, so this is a diagnostic index and not
-- an authentication path. Not unique: Convex does not make it unique and a
-- migrated duplicate must not fail the load.
CREATE INDEX users_email_idx ON kith.users (email) WHERE email IS NOT NULL;

ALTER TABLE kith.auth_accounts
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN provider SET NOT NULL,
  ALTER COLUMN provider_account_id SET NOT NULL;

-- Convex reads this pair with `.unique()`, which throws on a second row. Here a
-- second row cannot exist.
CREATE UNIQUE INDEX auth_accounts_provider_account_idx
  ON kith.auth_accounts (provider, provider_account_id);
CREATE INDEX auth_accounts_user_id_idx ON kith.auth_accounts (user_id);

ALTER TABLE kith.spaces
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN created_by SET NOT NULL,
  ADD CONSTRAINT spaces_kind_check CHECK (kind IN ('personal', 'shared')),
  ADD CONSTRAINT spaces_name_check CHECK (char_length(name) BETWEEN 1 AND 100);

CREATE INDEX spaces_created_by_kind_idx ON kith.spaces (created_by, kind);

-- `space_id` is a structural column migration 4's generator adds to every
-- space-scoped table, and it emits foreign keys only for declared `ref` columns,
-- so nothing yet says a `space_id` names a real space. For this domain's two
-- space-scoped tables, say it.
ALTER TABLE kith.space_members
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN role SET NOT NULL,
  ADD CONSTRAINT space_members_role_check
    CHECK (role IN ('owner', 'editor', 'reader')),
  ADD CONSTRAINT space_members_space_id_fkey
    FOREIGN KEY (space_id) REFERENCES kith.spaces (id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX space_members_space_user_idx ON kith.space_members (space_id, user_id);
CREATE INDEX space_members_user_idx ON kith.space_members (user_id);
CREATE INDEX space_members_person_idx
  ON kith.space_members (space_id, person_entity_id)
  WHERE person_entity_id IS NOT NULL;

ALTER TABLE kith.user_space_settings
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN personal_space_id SET NOT NULL;

-- Convex reads this with `.unique()` and the personal-space inspection treats two
-- rows as a diagnosable defect. One row per user is the invariant; state it.
CREATE UNIQUE INDEX user_space_settings_user_idx
  ON kith.user_space_settings (user_id);

ALTER TABLE kith.api_keys
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN key_hash SET NOT NULL,
  ALTER COLUMN key_prefix SET NOT NULL,
  ALTER COLUMN name SET NOT NULL,
  ADD CONSTRAINT api_keys_key_hash_unique UNIQUE (key_hash),
  ADD CONSTRAINT api_keys_key_hash_check CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT api_keys_name_check CHECK (char_length(name) BETWEEN 1 AND 200),
  ADD CONSTRAINT api_keys_capabilities_check CHECK (
    capabilities IS NULL
    OR (jsonb_typeof(capabilities) = 'array'
        AND jsonb_array_length(capabilities) <= 3)
  ),
  ADD CONSTRAINT api_keys_oauth_lifecycle_check
    CHECK (oauth_lifecycle IN ('preparing', 'pending'));

CREATE INDEX api_keys_user_lifecycle_idx
  ON kith.api_keys (user_id, oauth_lifecycle, oauth_grant_expires_at);
CREATE INDEX api_keys_user_request_hash_idx
  ON kith.api_keys (user_id, oauth_request_hash)
  WHERE oauth_request_hash IS NOT NULL;
CREATE INDEX api_keys_lifecycle_expiry_idx
  ON kith.api_keys (oauth_lifecycle, oauth_grant_expires_at)
  WHERE oauth_lifecycle IS NOT NULL;

-- A grant is a row, so revoking a key or deleting a space takes its grants with
-- it instead of leaving a dangling id inside an array.
ALTER TABLE kith.api_key_spaces
  DROP CONSTRAINT api_key_spaces_parent_fkey,
  DROP CONSTRAINT api_key_spaces_value_fkey,
  ADD CONSTRAINT api_key_spaces_parent_fkey
    FOREIGN KEY (api_key_id) REFERENCES kith.api_keys (id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT api_key_spaces_value_fkey
    FOREIGN KEY (space_id) REFERENCES kith.spaces (id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith.api_key_source_accounts
  DROP CONSTRAINT api_key_source_accounts_parent_fkey,
  ADD CONSTRAINT api_key_source_accounts_parent_fkey
    FOREIGN KEY (api_key_id) REFERENCES kith.api_keys (id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE kith.family_invitations
  ALTER COLUMN email_normalized SET NOT NULL,
  ALTER COLUMN token_hash SET NOT NULL,
  ALTER COLUMN role SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN created_by SET NOT NULL,
  ALTER COLUMN created_at_field SET NOT NULL,
  ALTER COLUMN expires_at SET NOT NULL,
  ADD CONSTRAINT family_invitations_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT family_invitations_role_check CHECK (role IN ('editor', 'reader')),
  ADD CONSTRAINT family_invitations_status_check CHECK (
    status IN ('open', 'pending_owner_approval', 'approved', 'revoked')
  ),
  ADD CONSTRAINT family_invitations_space_id_fkey
    FOREIGN KEY (space_id) REFERENCES kith.spaces (id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  -- The composite reference section 2.5 asks for: an invitation cannot name a
  -- membership in another space.
  ADD CONSTRAINT family_invitations_membership_space_fkey
    FOREIGN KEY (membership_id, space_id)
    REFERENCES kith.space_members (id, space_id)
    DEFERRABLE INITIALLY DEFERRED;

-- A token is one invitation. Convex reads two rows and refuses on the second;
-- here a second cannot exist.
CREATE UNIQUE INDEX family_invitations_token_hash_idx
  ON kith.family_invitations (token_hash);
CREATE INDEX family_invitations_space_status_expiry_idx
  ON kith.family_invitations (space_id, status, expires_at);
CREATE INDEX family_invitations_space_email_idx
  ON kith.family_invitations (space_id, email_normalized);
CREATE INDEX family_invitations_accepted_by_status_idx
  ON kith.family_invitations (accepted_by, status) WHERE accepted_by IS NOT NULL;

-- Recreated empty at cutover (P2-39b marks it `migrated: false`), so this table
-- has no legacy rows to tolerate and can be strict.
ALTER TABLE kith.consumed_oauth_codes
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN code_hash SET NOT NULL,
  ALTER COLUMN expires_at SET NOT NULL,
  ADD CONSTRAINT consumed_oauth_codes_code_hash_check
    CHECK (code_hash ~ '^[0-9a-f]{64}$');

CREATE INDEX consumed_oauth_codes_code_hash_idx
  ON kith.consumed_oauth_codes (code_hash);
CREATE INDEX consumed_oauth_codes_user_request_idx
  ON kith.consumed_oauth_codes (user_id, request_hash);
CREATE INDEX consumed_oauth_codes_expires_at_idx
  ON kith.consumed_oauth_codes (expires_at);

-- ---------------------------------------------------------------------------
-- Part 3. The web session.
-- ---------------------------------------------------------------------------

-- The cookie carries a random token and never a user id, a role or an expiry, so
-- there is nothing in it to tamper with; only `token_hash` is stored, so a
-- database dump does not yield a usable cookie. `revoked_at` is what makes logout
-- server side rather than a cleared cookie.
CREATE TABLE kith.sessions (
  id kith.kith_id PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  user_id kith.kith_id NOT NULL REFERENCES kith.users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX sessions_user_id_idx ON kith.sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON kith.sessions (expires_at);
