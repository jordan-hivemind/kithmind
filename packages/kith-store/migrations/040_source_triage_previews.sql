-- Cheap observed-byte previews precede retention. They are provisional metadata,
-- not extraction generations, facts or evidence. Retention can link the exact
-- assertion to a matching revision without rewriting its preview payload.
CREATE FUNCTION kith.valid_triage_preview_units(units jsonb, total numeric)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; current_unit numeric; previous_unit numeric := 0;
BEGIN
  IF units IS NULL OR jsonb_typeof(units) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(units) > 256 THEN RETURN false; END IF;
  IF total IS NULL THEN RETURN units = '[]'::jsonb; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(units) LOOP
    IF jsonb_typeof(item) <> 'number' THEN RETURN false; END IF;
    current_unit := item::text::numeric;
    IF current_unit <> trunc(current_unit) OR current_unit <= previous_unit
       OR current_unit > total THEN RETURN false; END IF;
    previous_unit := current_unit;
  END LOOP;
  RETURN true;
END;
$$;

CREATE TABLE kith.source_triage_previews (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id NOT NULL,
  source_account_id kith.kith_id NOT NULL,
  source_item_id kith.kith_id NOT NULL,
  observed_content_hash text NOT NULL CHECK (observed_content_hash ~ '^[a-f0-9]{64}$'),
  observed_byte_length numeric NOT NULL CHECK (
    observed_byte_length >= 0 AND observed_byte_length <= 9007199254740991
    AND observed_byte_length = trunc(observed_byte_length)),
  observed_media_type text NOT NULL CHECK (length(observed_media_type) BETWEEN 1 AND 128),
  observed_observation_epoch numeric NOT NULL CHECK (
    observed_observation_epoch >= 0 AND observed_observation_epoch <= 9007199254740991
    AND observed_observation_epoch = trunc(observed_observation_epoch)),
  preview_fingerprint text NOT NULL CHECK (preview_fingerprint ~ '^[a-f0-9]{64}$'),
  preview_method text NOT NULL CHECK (length(preview_method) BETWEEN 1 AND 128),
  source_format text NOT NULL CHECK (length(source_format) BETWEEN 1 AND 64),
  source_unit_count numeric CHECK (
    source_unit_count >= 0 AND source_unit_count <= 9007199254740991
    AND source_unit_count = trunc(source_unit_count)),
  inspected_original_units jsonb NOT NULL CHECK (
    kith.valid_triage_preview_units(inspected_original_units, source_unit_count)),
  provisional_metadata jsonb NOT NULL CHECK (
    jsonb_typeof(provisional_metadata) = 'object'
    AND octet_length(provisional_metadata::text) <= 32768),
  confidence numeric CHECK (confidence BETWEEN 0 AND 1),
  source_revision_id kith.kith_id,
  created_at timestamptz NOT NULL DEFAULT now(),
  linked_at timestamptz,
  UNIQUE (id, space_id),
  UNIQUE (source_item_id, observed_content_hash, preview_fingerprint),
  FOREIGN KEY (source_account_id, space_id) REFERENCES kith.source_accounts (id, space_id),
  FOREIGN KEY (source_item_id, space_id) REFERENCES kith.source_items (id, space_id),
  FOREIGN KEY (source_revision_id, space_id) REFERENCES kith.source_revisions (id, space_id),
  CHECK ((source_revision_id IS NULL) = (linked_at IS NULL))
);

CREATE INDEX source_triage_previews_revision_idx
  ON kith.source_triage_previews (source_revision_id)
  WHERE source_revision_id IS NOT NULL;

CREATE FUNCTION kith.guard_source_triage_preview()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    (to_jsonb(NEW) - 'source_revision_id' - 'linked_at') IS DISTINCT FROM
      (to_jsonb(OLD) - 'source_revision_id' - 'linked_at')
    OR OLD.source_revision_id IS NOT NULL
    OR NEW.source_revision_id IS NULL
  ) THEN
    RAISE EXCEPTION 'triage preview payload is immutable';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM kith.source_items i WHERE i.id = NEW.source_item_id
      AND i.space_id = NEW.space_id AND i.source_account_id = NEW.source_account_id
  ) THEN
    RAISE EXCEPTION 'triage preview source ownership mismatch';
  END IF;
  IF NEW.source_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM kith.source_revisions r WHERE r.id = NEW.source_revision_id
      AND r.space_id = NEW.space_id AND r.source_item_id = NEW.source_item_id
      AND r.content_hash = NEW.observed_content_hash
      AND r.byte_length = NEW.observed_byte_length
      AND r.media_type = NEW.observed_media_type
  ) THEN
    RAISE EXCEPTION 'triage preview retained revision mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_triage_previews_immutable
  BEFORE INSERT OR UPDATE ON kith.source_triage_previews
  FOR EACH ROW EXECUTE FUNCTION kith.guard_source_triage_preview();
