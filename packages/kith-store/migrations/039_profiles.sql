-- People and vehicle profiles remain views over entities and facts. This
-- migration adds only the entity shape that those views need: vehicles and an
-- explicit duplicate-to-canonical pointer. The losing row is retained so a
-- previously issued entity id can still be resolved after a merge.

ALTER TABLE kith.entities
  DROP CONSTRAINT entities_kind_check,
  ADD CONSTRAINT entities_kind_check
    CHECK (kind IN ('person', 'organization', 'project', 'place', 'vehicle', 'other')),
  ADD COLUMN merged_into kith.kith_id,
  ADD CONSTRAINT entities_not_merged_into_self_check
    CHECK (merged_into IS NULL OR merged_into <> id),
  ADD CONSTRAINT entities_merged_into_fkey
    FOREIGN KEY (merged_into, space_id)
    REFERENCES kith.entities (id, space_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX entities_merged_into_idx
  ON kith.entities (space_id, merged_into)
  WHERE merged_into IS NOT NULL;
