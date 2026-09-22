-- TAX-PAYMENTS-1. Manual tax-payment records are structured money and status
-- history. They do not pass through conversational Thought capture, and they
-- do not pretend a manual assertion came from an extraction generation.

CREATE TABLE kith.tax_payments (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id NOT NULL REFERENCES kith.spaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  payer_entity_id kith.kith_id NOT NULL,
  authority text NOT NULL CHECK (authority IN ('us_federal')),
  payment_kind text NOT NULL CHECK (payment_kind IN ('estimated_income')),
  tax_year integer NOT NULL CHECK (tax_year BETWEEN 1900 AND 3000),
  amount numeric NOT NULL CHECK (
    amount > 0
    AND amount::text ~ '^[0-9]{1,20}(\.[0-9]{1,6})?$'
  ),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  submitted_on date NOT NULL,
  current_status text NOT NULL CHECK (current_status IN
    ('submitted_processing', 'settled', 'rejected', 'reversed')),
  status_effective_on date NOT NULL,
  settled_on date,
  confirmation_number text CHECK (
    confirmation_number IS NULL
    OR (char_length(btrim(confirmation_number)) BETWEEN 1 AND 200
        AND confirmation_number = btrim(confirmation_number)
        AND confirmation_number !~ '[[:cntrl:]]')
  ),
  eft_trace text CHECK (
    eft_trace IS NULL
    OR (char_length(btrim(eft_trace)) BETWEEN 1 AND 200
        AND eft_trace = btrim(eft_trace)
        AND eft_trace !~ '[[:cntrl:]]')
  ),
  evidence_span_id kith.kith_id,
  created_by kith.kith_id REFERENCES kith.users (id) ON DELETE SET NULL,
  UNIQUE (id, space_id),
  CONSTRAINT tax_payments_identifier_required_check
    CHECK (confirmation_number IS NOT NULL OR eft_trace IS NOT NULL),
  CONSTRAINT tax_payments_status_date_check
    CHECK (status_effective_on >= submitted_on),
  CONSTRAINT tax_payments_settlement_check
    CHECK (
      (settled_on IS NULL OR settled_on >= submitted_on)
      AND (current_status NOT IN ('settled', 'reversed') OR settled_on IS NOT NULL)
      AND (current_status <> 'settled' OR settled_on = status_effective_on)
      AND (current_status <> 'reversed' OR status_effective_on >= settled_on)
    ),
  FOREIGN KEY (payer_entity_id, space_id)
    REFERENCES kith.entities (id, space_id),
  FOREIGN KEY (evidence_span_id, space_id)
    REFERENCES kith.evidence_spans (id, space_id)
      ON DELETE SET NULL (evidence_span_id)
);

CREATE UNIQUE INDEX tax_payments_confirmation_identity_idx
  ON kith.tax_payments
     (space_id, payer_entity_id, authority, lower(confirmation_number))
  WHERE confirmation_number IS NOT NULL;

CREATE UNIQUE INDEX tax_payments_eft_identity_idx
  ON kith.tax_payments
     (space_id, payer_entity_id, authority, lower(eft_trace))
  WHERE eft_trace IS NOT NULL;

CREATE INDEX tax_payments_year_idx
  ON kith.tax_payments
     (space_id, tax_year, submitted_on, id);

CREATE TABLE kith.tax_payment_status_events (
  id kith.kith_id PRIMARY KEY,
  space_id kith.kith_id NOT NULL REFERENCES kith.spaces (id) ON DELETE CASCADE,
  payment_id kith.kith_id NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  status text NOT NULL CHECK (status IN
    ('submitted_processing', 'settled', 'rejected', 'reversed')),
  effective_on date NOT NULL,
  is_correction boolean NOT NULL DEFAULT false,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  evidence_span_id kith.kith_id,
  actor_user_id kith.kith_id REFERENCES kith.users (id) ON DELETE SET NULL,
  UNIQUE (id, space_id),
  FOREIGN KEY (payment_id, space_id)
    REFERENCES kith.tax_payments (id, space_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_span_id, space_id)
    REFERENCES kith.evidence_spans (id, space_id)
      ON DELETE SET NULL (evidence_span_id)
);

CREATE INDEX tax_payment_status_events_payment_idx
  ON kith.tax_payment_status_events
     (space_id, payment_id, created_at, id);

CREATE TRIGGER tax_payments_change_trg
  AFTER INSERT OR UPDATE OR DELETE ON kith.tax_payments
  FOR EACH ROW EXECUTE FUNCTION kith.record_change();
