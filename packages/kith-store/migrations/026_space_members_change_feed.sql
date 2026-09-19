-- UI-restyle: a change trigger on `space_members`, so the spaces page shows a
-- membership change made elsewhere without a reload. Same generic
-- `kith.record_change()` as migration 023; nothing new is defined. `thoughts`
-- and `facts` already have theirs from migration 024.
--
-- `space_members` keeps 023's rule that the feed "leaks nothing a reader of the
-- table itself could not already see": every member of a space sees its member
-- list.
--
-- Deliberately not triggered:
--
--   * `family_invitations`: only the owner sees invitations, and a change row
--     would tell a reader when one was created or accepted.
--   * `api_key_spaces` and `brain_api_keys`: keys belong to one user, and a
--     change row in a shared space would tell other members when a key was
--     issued or revoked. `brain_api_keys` also has no `space_id`.
--   * `brain_spaces` and `user_space_settings`: no `space_id` column, which the
--     trigger function requires.
--
-- Guarded so a database that already has the trigger applies this as a no-op
-- rather than failing with 42710.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgname = 'space_members_change_trg'
       AND tgrelid = 'kith.space_members'::regclass
  ) THEN
    CREATE TRIGGER space_members_change_trg
      AFTER INSERT OR UPDATE OR DELETE ON kith.space_members
      FOR EACH ROW EXECUTE FUNCTION kith.record_change();
  END IF;
END;
$$;
