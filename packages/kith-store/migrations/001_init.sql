CREATE TABLE kith.spaces (
  id uuid PRIMARY KEY,
  opaque_name text NOT NULL UNIQUE CHECK (char_length(opaque_name) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE kith.api_keys (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL REFERENCES kith.spaces(id) ON DELETE CASCADE,
  key_hash bytea NOT NULL UNIQUE CHECK (octet_length(key_hash) = 32),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE kith.documents (
  id uuid PRIMARY KEY,
  space_id uuid NOT NULL REFERENCES kith.spaces(id) ON DELETE CASCADE,
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 128),
  active_generation_id uuid,
  forgotten_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (space_id, external_id),
  UNIQUE (id, space_id)
);

CREATE TABLE kith.source_revisions (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL,
  space_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 1000000),
  source_content_hash text NOT NULL CHECK (source_content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (document_id, ordinal),
  UNIQUE (id, document_id, space_id),
  FOREIGN KEY (document_id, space_id) REFERENCES kith.documents(id, space_id) ON DELETE CASCADE
);

CREATE TABLE kith.generations (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  space_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('staging', 'ready', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  activated_at timestamptz,
  UNIQUE (id, space_id),
  UNIQUE (id, document_id, space_id),
  FOREIGN KEY (source_revision_id, document_id, space_id)
    REFERENCES kith.source_revisions(id, document_id, space_id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, space_id) REFERENCES kith.documents(id, space_id) ON DELETE CASCADE
);

ALTER TABLE kith.documents ADD CONSTRAINT documents_active_generation_fk
  FOREIGN KEY (active_generation_id, id, space_id)
  REFERENCES kith.generations(id, document_id, space_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE kith.pages (
  id uuid PRIMARY KEY,
  generation_id uuid NOT NULL,
  space_id uuid NOT NULL,
  page_number integer NOT NULL CHECK (page_number BETWEEN 1 AND 64),
  page_text text NOT NULL CHECK (octet_length(page_text) <= 1048576),
  page_text_hash text NOT NULL CHECK (page_text_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (generation_id, page_number),
  UNIQUE (id, generation_id, space_id),
  FOREIGN KEY (generation_id, space_id) REFERENCES kith.generations(id, space_id) ON DELETE CASCADE
);

CREATE TABLE kith.evidence (
  id uuid PRIMARY KEY,
  generation_id uuid NOT NULL,
  page_id uuid NOT NULL,
  space_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 255),
  start_codepoint integer NOT NULL CHECK (start_codepoint >= 0),
  end_codepoint integer NOT NULL CHECK (end_codepoint >= start_codepoint),
  quote_text text NOT NULL,
  quote_hash text NOT NULL CHECK (quote_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (generation_id, ordinal),
  UNIQUE (id, generation_id, space_id),
  FOREIGN KEY (page_id, generation_id, space_id)
    REFERENCES kith.pages(id, generation_id, space_id) ON DELETE CASCADE,
  FOREIGN KEY (generation_id, space_id) REFERENCES kith.generations(id, space_id) ON DELETE CASCADE
);

CREATE TABLE kith.chunks (
  id uuid PRIMARY KEY,
  generation_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  space_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 255),
  chunk_text text NOT NULL CHECK (octet_length(chunk_text) BETWEEN 1 AND 8192),
  UNIQUE (generation_id, ordinal),
  FOREIGN KEY (evidence_id, generation_id, space_id)
    REFERENCES kith.evidence(id, generation_id, space_id) ON DELETE CASCADE,
  FOREIGN KEY (generation_id, space_id) REFERENCES kith.generations(id, space_id) ON DELETE CASCADE
);

CREATE TABLE kith.synthetic_financial_attachments (
  id uuid PRIMARY KEY,
  generation_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  space_id uuid NOT NULL,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 128),
  amount numeric NOT NULL CHECK (
    amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    AND abs(amount) < 100000000000000000000000000000000000000::numeric
    AND scale(amount) <= 18
    AND length(replace(trim_scale(abs(amount))::text, '.', '')) <= 38
  ),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  FOREIGN KEY (evidence_id, generation_id, space_id)
    REFERENCES kith.evidence(id, generation_id, space_id) ON DELETE CASCADE,
  FOREIGN KEY (generation_id, space_id) REFERENCES kith.generations(id, space_id) ON DELETE CASCADE
);

CREATE TABLE kith.idempotency_receipts (
  space_id uuid NOT NULL REFERENCES kith.spaces(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('stage_generation', 'activate_generation', 'forget_document')),
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (space_id, operation, request_id)
);

CREATE INDEX chunks_ready_search_idx ON kith.chunks (space_id, generation_id, ordinal);
CREATE INDEX financial_ready_idx ON kith.synthetic_financial_attachments (space_id, generation_id, currency);
