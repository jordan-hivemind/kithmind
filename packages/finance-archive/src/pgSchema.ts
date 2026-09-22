// The archive schema on Postgres: one initial schema, not a translation of
// three SQLite migrations. There is no data behind the SQLite migrations, and
// that is the whole reason the engine changes now rather than later, so their
// history collapses into a single CREATE.
//
// What changes from the SQLite schema, and why:
//
//   - Cash amounts stop being INTEGER minor units and quantities stop being
//     canonical decimal TEXT. Both become NUMERIC, which is exact and sums
//     exactly, so the conversion boundary between the two representations
//     disappears along with the class of bugs that lived on it.
//   - NUMERIC is declared with no precision or scale. NUMERIC(38, 18) would
//     round a more precise value into place on insert; the boundary contract
//     is enforced on the way in instead (see pgNumeric.ts), where exceeding
//     it is an explicit rejection rather than a silent rounding.
//   - The CHECK (typeof(...)) constraints do not translate, because Postgres
//     types already cover storage class. Their intent moves to input
//     validation in pgNumeric.ts. Postgres will happily store a value that
//     was already a float before it arrived, so the check had to move rather
//     than be dropped.
//   - Dates become DATE and timestamps TIMESTAMPTZ, so the GLOB spelling
//     checks are unnecessary. Booleans become BOOLEAN.
//
// What deliberately does not change: every money column carries its currency
// and no total ever crosses currencies; positions carry valuation_basis and
// valuation_note; commitments is designed in and unpopulated; every derived
// row carries source_document_id and source_locator; acct_last4 is exactly
// four digits; row_hash is UNIQUE; identities stay stable opaque text.

// Later changes are additive migrations appended to PG_MIGRATIONS, not edits
// to the CREATE above: once an archive exists, the version table is the only
// thing that says what it already has.
//
// Where the objects live is part of the schema, not an ambient property of
// whoever connects. Everything below is created in one named schema and the
// version table is read schema-qualified. An unqualified `schema_version`
// resolves through `search_path`, so a co-located component's own version
// table could answer for the archive's and this code would conclude the
// schema was already current against a database that does not have it. That
// is not hypothetical: co-locating databases is the plan of record, and the
// archive's default endpoint is a pooled one where a `SET search_path` issued
// outside a transaction may be gone by the next transaction.

import type pg from "pg";

import {
  archiveSchemaOf,
  assertSchemaName,
  pinArchiveSchema,
} from "./pgStore.js";

/** One versioned, additive step. Every step's version is recorded in
 * `schema_version`, so an existing archive applies only what it is missing. */
export type PgMigration = {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
};

/**
 * Key for the advisory lock two concurrent creators contend on, paired with a
 * hash of the schema name so creating one archive does not block creating an
 * unrelated one in the same database. The two-key form is a separate keyspace
 * from the one-key `ARCHIVE_WRITE_LOCK_KEY`, so schema creation and an import
 * cannot collide by accident. Both keys are int4 in this form.
 */
const SCHEMA_LOCK_KEY = 411_920_501;

const INITIAL_SCHEMA = `
-- Every money, quantity, price and rate column. The domain is where the
-- non-finite rejection lives, and Postgres NUMERIC has three non-finite
-- values, not one: NaN since forever, and Infinity and -Infinity since
-- Postgres 14. An infinite balance is not a rounding problem, it is a value
-- that makes every aggregate over the column meaningless.
--
-- The comparison is subtle in both directions and the spelling matters.
-- 'NaN'::numeric = 'NaN'::numeric is true, unlike float NaN, so VALUE =
-- VALUE would not catch it; and NaN sorts above Infinity in numeric
-- ordering, so a range test would need that fact to be remembered. Listing
-- the three values under = is the spelling that needs neither.
CREATE DOMAIN finance_numeric AS NUMERIC
  CHECK (VALUE IS NULL OR VALUE NOT IN
    ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));

CREATE DOMAIN currency_code AS TEXT
  CHECK (VALUE IS NULL OR VALUE ~ '^[A-Z]{3}$');

CREATE TABLE institutions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL REFERENCES institutions(id),
  -- Only the last four digits of an account number are ever stored.
  acct_last4 TEXT CHECK (acct_last4 IS NULL OR acct_last4 ~ '^[0-9]{4}$'),
  display_name TEXT,
  account_type TEXT,
  program TEXT,
  registration TEXT,
  owner_entity_id TEXT,
  is_pledged BOOLEAN NOT NULL DEFAULT FALSE,
  base_currency currency_code NOT NULL,
  opened_date DATE,
  closed_date DATE,
  notes TEXT
);

CREATE TABLE instruments (
  id TEXT PRIMARY KEY,
  symbol TEXT,
  cusip TEXT,
  isin TEXT,
  name TEXT,
  instrument_kind TEXT,
  asset_class TEXT,
  issuer_note TEXT
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  institution_id TEXT REFERENCES institutions(id),
  account_id TEXT REFERENCES accounts(id),
  doc_type TEXT NOT NULL,
  doc_date DATE,
  -- Path in the raw tree, which lives outside this repository.
  file_path TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  text_path TEXT,
  parsed_ok BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  trade_date DATE,
  process_date DATE NOT NULL,
  settle_date DATE,
  date_precision TEXT NOT NULL DEFAULT 'day'
    CHECK (date_precision IN ('day', 'month', 'unknown')),
  activity_type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instrument_id TEXT REFERENCES instruments(id),
  quantity finance_numeric,
  price finance_numeric,
  amount finance_numeric,
  currency currency_code NOT NULL,
  -- amount converted into accounts.base_currency. Unpopulated in v1.
  amount_base finance_numeric,
  fx_rate finance_numeric,
  -- The rule used to derive amount_base. A stated amount never rounds.
  amount_base_rounding TEXT
    CHECK (amount_base_rounding IS NULL OR amount_base_rounding IN ('half_even', 'none')),
  running_balance finance_numeric,
  source_document_id TEXT REFERENCES documents(id),
  source_locator TEXT,
  row_hash TEXT NOT NULL UNIQUE,
  provider_txn_id TEXT,
  status TEXT NOT NULL DEFAULT 'imported',
  imported_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE positions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  as_of DATE NOT NULL,
  instrument_id TEXT REFERENCES instruments(id),
  quantity finance_numeric,
  price finance_numeric,
  market_value finance_numeric,
  cost_basis finance_numeric,
  unrealized finance_numeric,
  currency currency_code NOT NULL,
  -- Without this a total-assets query mixes marked securities with cost.
  valuation_basis TEXT CHECK (valuation_basis IS NULL
    OR valuation_basis IN ('market_price', 'last_round', 'cost', 'reported_nav')),
  valuation_note TEXT,
  source_document_id TEXT REFERENCES documents(id),
  source_locator TEXT
);

CREATE TABLE balances (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  as_of DATE NOT NULL,
  total_value finance_numeric,
  cash finance_numeric,
  currency currency_code NOT NULL,
  period_start_value finance_numeric,
  period_end_value finance_numeric,
  source_document_id TEXT REFERENCES documents(id),
  source_locator TEXT
);

CREATE TABLE liabilities (
  id TEXT PRIMARY KEY,
  institution_id TEXT REFERENCES institutions(id),
  account_id TEXT REFERENCES accounts(id),
  kind TEXT NOT NULL,
  display_name TEXT,
  balance finance_numeric,
  currency currency_code NOT NULL,
  rate finance_numeric,
  as_of DATE NOT NULL,
  collateral_note TEXT,
  source_document_id TEXT REFERENCES documents(id),
  source_locator TEXT
);

-- A commitment is not a transaction and has no representation in a ledger.
-- Designed in now, unpopulated in v1, not retrofittable cheaply later.
CREATE TABLE commitments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  instrument_id TEXT REFERENCES instruments(id),
  committed finance_numeric,
  called finance_numeric,
  outstanding finance_numeric,
  distributed finance_numeric,
  currency currency_code NOT NULL,
  committed_original finance_numeric,
  currency_original currency_code,
  fx_rate finance_numeric,
  status TEXT,
  as_of DATE NOT NULL,
  source_document_id TEXT REFERENCES documents(id)
);

CREATE TABLE import_runs (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  source TEXT NOT NULL,
  files_seen BIGINT NOT NULL DEFAULT 0,
  rows_inserted BIGINT NOT NULL DEFAULT 0,
  rows_skipped BIGINT NOT NULL DEFAULT 0,
  reconciliations_passed BIGINT NOT NULL DEFAULT 0,
  reconciliations_failed BIGINT NOT NULL DEFAULT 0,
  review_items BIGINT NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE reconciliations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  expected_change finance_numeric,
  computed_change finance_numeric,
  delta finance_numeric,
  currency currency_code NOT NULL,
  -- The gate tolerance is exact zero; the value is recorded per period so a
  -- passing period says what it was allowed.
  tolerance finance_numeric NOT NULL DEFAULT 0 CHECK (tolerance >= 0),
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'unverified')),
  notes TEXT
);

-- The position quantity gate is per account, per instrument, per period, and
-- reconciliations is per account and period with no instrument. It keeps its
-- own table: a cash verdict and a position verdict must stay distinguishable,
-- or every existing query for unverified periods silently starts returning
-- per-instrument rows. (Under SQLite the tables were also separated by
-- storage class. That reason is gone here; the query one is not.)
CREATE TABLE position_reconciliations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  expected_change finance_numeric,
  computed_change finance_numeric,
  delta finance_numeric,
  tolerance finance_numeric NOT NULL DEFAULT 0 CHECK (tolerance >= 0),
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'unverified')),
  notes TEXT
);

CREATE TABLE review_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  source_document_id TEXT REFERENCES documents(id),
  source_locator TEXT,
  raw_value TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT
);

CREATE INDEX transactions_account_process_date ON transactions (account_id, process_date);
CREATE INDEX transactions_provider_txn_id ON transactions (account_id, provider_txn_id);
CREATE INDEX transactions_source_document ON transactions (source_document_id);
CREATE INDEX positions_account_as_of ON positions (account_id, as_of);
CREATE INDEX balances_account_as_of ON balances (account_id, as_of);
CREATE INDEX reconciliations_account_period ON reconciliations (account_id, period_start, period_end);
CREATE INDEX position_reconciliations_account_period
  ON position_reconciliations (account_id, instrument_id, period_start, period_end);
CREATE INDEX review_items_status ON review_items (status, kind);
`;

// F1-29. Four nullable columns naming the immutable retained bytes a
// document's rows were parsed from, so a citation can be checked against
// those bytes rather than trusted (docs/plans/2026-09-11-structured-evidence.md).
//
// `retained_sha256` is not `documents.sha256` and cannot be. For a single
// acquired file the two are equal, but a paginated pull is captured as one
// RawFile and split into one row per page, and each page row's `sha256` is a
// derived hash that names no bytes. So `sha256` keeps its UNIQUE row-identity
// role and `retained_sha256` is deliberately not unique: every page row of one
// pull shares the bytes.
//
// No backfill. A document imported before this migration keeps four nulls and
// produces no evidence, which is the honest answer for a row whose bytes were
// never recorded. The CHECK makes that all-or-nothing: three of four is a
// half-written provenance record that reads as complete.
const RETAINED_PROVENANCE = `
ALTER TABLE documents
  ADD COLUMN retained_sha256 TEXT
    CHECK (retained_sha256 IS NULL OR retained_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN retained_byte_length BIGINT
    CHECK (retained_byte_length IS NULL OR retained_byte_length >= 0),
  ADD COLUMN media_type TEXT,
  ADD COLUMN capture_id TEXT,
  ADD CONSTRAINT documents_retained_provenance_complete CHECK (
    num_nonnulls(retained_sha256, retained_byte_length, media_type, capture_id)
      IN (0, 4));
`;

// F1-32. `resolveDiscoveredAccounts` (adapterImport.ts) upserts an
// `accounts` row per account an adapter's `discover()` reports, keyed on
// this column so a selection file can name an account by the adapter's own
// opaque id instead of already knowing the archive's `accounts.id`. NULL for
// every account provisioned by hand before this migration and for any
// account no adapter has reported yet -- no backfill, the same honest-null
// policy F1-29's retained-provenance columns use -- so the UNIQUE constraint
// is scoped per institution rather than globally (two institutions may
// reuse the same opaque key) and, because Postgres never treats two NULLs as
// equal, does not collide on the many existing rows that have none.
//
// `base_currency` loses its NOT NULL for the same reason: an adapter's
// `DiscoveredAccount` carries no currency, and a guessed default would be
// exactly the kind of invented fact ground rule 5 exists to forbid. An
// account discovered this way is honestly of unknown base currency until an
// operator sets one; `amount_base`, the only column that reads it, is
// already unpopulated in v1.
const ACCOUNT_EXTERNAL_KEY = `
ALTER TABLE accounts
  ADD COLUMN external_key TEXT,
  ALTER COLUMN base_currency DROP NOT NULL,
  ADD CONSTRAINT accounts_external_key_unique UNIQUE (institution_id, external_key);
`;

// F1-36. review_items.source_document_id already carries a foreign key to
// documents(id) -- the initial schema declared it inline, with the default
// NO ACTION -- so a document could not be deleted at all while any review
// item still named it. A review item is about that document's own content;
// once the document is gone there is nothing left for it to point evidence
// at, so its right place is to go with the document rather than to block
// the delete. The constraint is dropped and re-added under its default
// (Postgres-assigned) name rather than named explicitly, since the initial
// schema never named it either and a migration should not invent a name the
// running schema does not already have.
const REVIEW_ITEMS_CASCADE = `
ALTER TABLE review_items
  DROP CONSTRAINT review_items_source_document_id_fkey,
  ADD CONSTRAINT review_items_source_document_id_fkey
    FOREIGN KEY (source_document_id) REFERENCES documents(id) ON DELETE CASCADE;
`;

// F1-49. positions, balances and liabilities had no row-level dedupe: the
// only key they ever had was "which document stated this," checked once at
// the whole-document skip. A document reprocessed for any other reason --
// one row sent to review, a parse note that never clears -- re-inserted
// every holding it carried, every time. row_hash (importer.ts computes it
// via rowHash.ts's positionHash/balanceHash/liabilityHash) gives each table
// the same content identity transactions already have.
//
// Nullable, with a plain UNIQUE constraint rather than a partial index:
// Postgres never treats two NULLs as equal in a UNIQUE constraint, so a
// nullable column already behaves as "unique where not null" with no extra
// syntax. Existing rows keep a NULL row_hash -- there is no backfill in this
// migration, the same policy every additive migration before it uses --
// see `scripts/backfillHoldingRowHash.mjs` for bringing a live archive's
// existing rows under the constraint after review.
const HOLDING_ROW_HASH = `
ALTER TABLE positions
  ADD COLUMN row_hash TEXT,
  ADD CONSTRAINT positions_row_hash_unique UNIQUE (row_hash);
ALTER TABLE balances
  ADD COLUMN row_hash TEXT,
  ADD CONSTRAINT balances_row_hash_unique UNIQUE (row_hash);
ALTER TABLE liabilities
  ADD COLUMN row_hash TEXT,
  ADD CONSTRAINT liabilities_row_hash_unique UNIQUE (row_hash);
`;

// F1-56. One account is known by more than one key. Morgan Stanley's API
// reports a `keyAccountNo` (the key `discover()` returns and
// `accounts.external_key` holds), while the statement PDFs print a
// different number entirely, and no digit rule turns one into the other.
// A holdings row parsed out of a statement therefore carries a key that
// resolves to nothing, and lands under whichever account the document was
// pulled under (66,965 rows on the owner's archive, one
// `unknown_account_key` review item each). This table is the second key
// space: alternate external keys an account is *also* known by, learned
// from the documents themselves (`run.ts learn-account-aliases`).
//
// `kind` names which key space a row belongs to, because the two are not
// interchangeable: a `statement_number` is what a document prints, an
// `api_key` is what the site's own listings use. Nothing branches on it
// today -- resolution treats every alias the same -- but a key with no
// recorded provenance is a key nobody can later audit.
//
// UNIQUE (institution_id, external_key) mirrors `accounts_external_key_unique`:
// one key names at most one account within an institution, and two
// institutions may reuse a spelling. The foreign key is composite against
// `accounts (id, institution_id)` -- hence the UNIQUE added to `accounts`
// first -- so an alias cannot be scoped to one institution while naming an
// account in another, which would silently mis-scope that uniqueness.
//
// Deliberately *not* enforced here: that an alias key is not already some
// other account's `accounts.external_key`. Postgres has no cross-table
// unique constraint, and a trigger is a lot of machinery for a case
// resolution already decides deterministically -- `external_key` is
// consulted first and an alias can only ever be a second chance, never an
// override (see `accountIdsByExternalKey` in adapterImport.ts). The
// learning command refuses to write such a key in the first place.
//
// No grant: `pgReaderRole.ts` grants SELECT at the time it runs, and its
// own suite asserts a table a later migration adds is *not* silently
// readable. The read surface (`mcp/pgRead.ts`) does not read this table, so
// nothing here needs one; re-run `applyPgReaderRole` if that ever changes.
const ACCOUNT_ALIASES = `
ALTER TABLE accounts
  ADD CONSTRAINT accounts_id_institution_unique UNIQUE (id, institution_id);

CREATE TABLE account_aliases (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  institution_id TEXT NOT NULL,
  external_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('api_key', 'statement_number')),
  -- How this alias came to be believed: the learning rule and its evidence,
  -- never the key itself in some other spelling.
  learned_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_aliases_account_fkey
    FOREIGN KEY (account_id, institution_id)
    REFERENCES accounts (id, institution_id) ON DELETE CASCADE,
  CONSTRAINT account_aliases_key_unique UNIQUE (institution_id, external_key)
);

CREATE INDEX account_aliases_account ON account_aliases (account_id);
`;

// F1-65. A reparse re-derives the identical review item every time it
// re-encounters the same evidence -- the same weak instrument match on every
// row that references it, the same undeclared activity type on every row of
// that type -- and nothing before this stopped it from writing that
// duplicate again. One hosted reparse of 854 already-imported statements
// opened 76,687 review items this way, 84,266 of them exact duplicates by
// (kind, source_document_id, source_locator, raw_value). `importer.ts`'s
// buffered insert now checks this key before writing (see `flushReviews`);
// this index is the constraint backing that check, so a write path that
// bypasses it still cannot duplicate a row-scoped item.
//
// Partial on `source_document_id IS NOT NULL` only, and `source_locator`
// coalesced to `''` inside the indexed expression rather than required
// non-null: every item `AdapterReviewItem` produces (weak_instrument_match,
// undeclared_activity_type, unknown_account_key -- adapterImport.ts) carries
// a null locator, and grouping the owner's hosted duplicates by these four
// columns showed most of the 84,266 weak_instrument_match duplicates were
// exactly this shape -- a document set, a locator null, from after PR137
// gave these items a document id. A `UNIQUE` index does not behave like
// `GROUP BY` here: Postgres never treats two `NULL`s as equal in an indexed
// column, so an index that left `source_locator` as a plain column,
// required non-null or not, would not see two same-document, null-locator
// rows as candidates for the same slot at all -- coalescing the expression
// is what makes the constraint see them. Only `source_document_id IS NULL`
// stays untouched: an item from before PR137 (both columns null) has no
// document to scope it, and neither does a pull-level item
// (adapterImport.ts's `flushInstruments`, still written with a null
// document today) -- for either, "the same one" cannot be defined, so this
// index does not try.
//
// This migration comes after the collapse: CREATE UNIQUE INDEX fails outright
// if the table already holds rows that would violate it, and failing on the
// index build itself (potentially after scanning the whole table) is a worse
// failure mode than refusing up front. The DO block below runs that same
// duplicate check first and raises a clear, actionable error instead --
// scripts/collapseDuplicateReviewItems.mjs is what an operator runs first on
// a live archive that already has duplicates (F1-56 shipped before this
// migration did); a fresh archive, or one already deduplicated, has nothing
// for the check to find and the index creates immediately.
const REVIEW_ITEMS_DEDUPE_KEY = `
DO $$
DECLARE
  dup_groups BIGINT;
BEGIN
  SELECT count(*) INTO dup_groups FROM (
    SELECT 1
      FROM review_items
     WHERE source_document_id IS NOT NULL
     GROUP BY kind, source_document_id, COALESCE(source_locator, ''), raw_value
    HAVING count(*) > 1
  ) AS duplicate_groups;
  IF dup_groups > 0 THEN
    RAISE EXCEPTION
      'review_items has % duplicate group(s) on (kind, source_document_id, source_locator, raw_value); run scripts/collapseDuplicateReviewItems.mjs against this archive before applying this migration',
      dup_groups;
  END IF;
END $$;

CREATE UNIQUE INDEX review_items_dedupe_key
  ON review_items (kind, source_document_id, COALESCE(source_locator, ''), raw_value)
  WHERE source_document_id IS NOT NULL;
`;

// F1-58. review_items_dedupe_key (migration 7) governs one row per
// (document, descriptor): correct for every kind it was designed around, but
// wrong for `weak_instrument_match` specifically. What that item asks a
// person to decide -- "this descriptor matched an instrument weakly, confirm
// or correct the mapping" -- is a fact about the (institution, descriptor,
// matched instrument) triple, not about which statement happened to restate
// it. A statement re-lists its holdings every month, so the same weak match
// reopened a fresh row every month too: 73,247 open items on the owner's
// archive, one per holding per statement.
//
// `institution_id` and `matched_instrument_id` are new because neither was
// ever a queryable column: `weak_instrument_match`'s own `account_id` is
// always NULL (adapterImport.ts resolves an instrument before a row's
// account is known, so there is no account to scope it by -- institution is
// the only stable identity available), and the instrument a descriptor
// matched has only ever been readable out of the free-text `reason`
// ("...to existing instrument <id>..."). `occurrence_count` and
// `last_seen_document_id` carry what the row-per-statement shape used to
// convey implicitly (how many statements, and how recently): the existing
// `source_document_id` keeps its meaning as the first sighting,
// `last_seen_document_id` is the most recent, and `occurrence_count` is how
// many sightings landed on the same descriptor/instrument pair. All four are
// nullable and nothing here backfills them, the same policy every additive
// migration before it uses (HOLDING_ROW_HASH's `row_hash`, this file's own
// precedent): a NULL never collides with another NULL under a unique index,
// so the guarded index below can be created immediately even though every
// existing row starts out reading NULL in both new key columns.
// `scripts/collapseWeakInstrumentMatches.mjs`, run after this migration
// (the same order `scripts/backfillHoldingRowHash.mjs` follows
// HOLDING_ROW_HASH), is what actually collapses the 73,247 existing rows
// into this shape and populates these four columns for them.
const WEAK_INSTRUMENT_MATCH_IDENTITY = `
ALTER TABLE review_items
  ADD COLUMN institution_id TEXT REFERENCES institutions(id),
  ADD COLUMN matched_instrument_id TEXT REFERENCES instruments(id),
  ADD COLUMN occurrence_count INT CHECK (occurrence_count IS NULL OR occurrence_count > 0),
  ADD COLUMN last_seen_document_id TEXT REFERENCES documents(id) ON DELETE CASCADE;

-- Additive to review_items_dedupe_key, not a replacement: that index still
-- governs every other kind exactly as migration 7 left it. This one applies
-- only to weak_instrument_match, where the identity is the descriptor match
-- itself rather than which document restated it.
--
-- Guarded the same way migration 7 is: CREATE UNIQUE INDEX fails outright,
-- mid-build, if data already violates it, and that is a worse failure mode
-- than refusing up front with a message that names the fix. In practice this
-- can only fire if something wrote both new columns non-NULL and duplicated
-- before this index existed -- a fresh run of this migration never can,
-- since the ALTER TABLE just above leaves every row NULL in both -- but the
-- guard costs nothing and keeps the same shape as every other guarded index
-- in this file, rather than being the one CREATE UNIQUE INDEX that trusts
-- its data by exception.
DO $$
DECLARE
  dup_groups BIGINT;
BEGIN
  SELECT count(*) INTO dup_groups FROM (
    SELECT 1
      FROM review_items
     WHERE kind = 'weak_instrument_match'
       AND institution_id IS NOT NULL
       AND matched_instrument_id IS NOT NULL
     GROUP BY institution_id, raw_value, matched_instrument_id
    HAVING count(*) > 1
  ) AS duplicate_groups;
  IF dup_groups > 0 THEN
    RAISE EXCEPTION
      'review_items has % duplicate weak_instrument_match group(s) on (institution_id, raw_value, matched_instrument_id); run scripts/collapseWeakInstrumentMatches.mjs against this archive to collapse them',
      dup_groups;
  END IF;
END $$;

CREATE UNIQUE INDEX review_items_weak_instrument_match_key
  ON review_items (kind, institution_id, raw_value, matched_instrument_id)
  WHERE kind = 'weak_instrument_match';
`;

// F1-66. The retained text a `retained_text_span_v1` citation quotes, in the
// archive rather than only in the raw tree.
//
// The defect this fixes: `list_holdings` served PDF-tier rows whose evidence
// is a retained-text span, and `get_evidence` on one of those rows answered
// `retained_evidence_unavailable`, because the verification step read the
// cited bytes from `FINANCE_ARCHIVE_RAW_TREE_ROOT` -- a directory that exists
// on the owner's machine and nowhere near the Vercel function serving the
// gateway. Transaction evidence (`json_pointer_v1`) verified fine, because
// its bytes are the `source_locator` already in the database. A citation the
// read surface can only check on one laptop is not a citation the read
// surface can check.
//
// Keyed on the text's own sha256, the same identity `writeRetainedText`
// content-addresses the file under (`textRelativePath`, rawTree.ts), so the
// table and the raw tree name the same bytes by the same name and neither has
// to know where the other lives. `content` is the whole retained text: a span
// is verified by slicing it, and storing only the quoted span would verify
// nothing, since the quote is exactly what a wrong or tampered binding would
// have supplied.
//
// `bytea` and not a large object, and not `text`:
//
//   - Size. Statement text runs a few hundred KB per document and the owner's
//     archive holds on the order of a thousand documents: roughly 300 MB of
//     plain text. Measured on synthetic statement text under pglz, the whole
//     relation (heap, TOAST and index) came to about a third of that, so the
//     real cost is on the order of 100-150 MB. Every value is three orders of
//     magnitude below TOAST's 1 GB per-value ceiling, and far above the ~2 KB
//     threshold at which TOAST moves it out of line and compresses it --
//     which is exactly the storage a large object would be chosen for.
//   - The reader role. A large object lives in `pg_largeobject`, outside this
//     schema, with its own per-object ACL: `GRANT SELECT ON ALL TABLES IN
//     SCHEMA` (pgReaderRole.ts) would not reach it, no grant review would
//     ever see it, and every `lo_*` function is already refused to the reader
//     (test/pgReaderRole.test.mjs's `lo_create` case). The verifier that has
//     to read these bytes is precisely the role that could not.
//   - Cleanup. A large object survives `DROP TABLE` and `DROP SCHEMA
//     CASCADE`, so every throwaway test schema would leak one per document.
//   - `text` over `bytea` would add a UTF-8 validation and a NUL-byte
//     rejection between the extractor and storage, on a column whose whole
//     job is to hand back the exact bytes that hash to `sha256`.
//
// `byte_length` is checked against the stored bytes rather than trusted, so a
// row cannot claim a length it does not have; `codepoint_length` cannot be
// checked in SQL (Postgres has no code-point count for bytea) and is recorded
// as the writer computed it. Neither is what verification trusts: the read
// surface recomputes the sha256 of `content` and refuses a mismatch, so a
// tampered row is refused rather than quoted.
//
// No backfill here, the same policy every additive migration above uses:
// `scripts/backfillRetainedTexts.mjs` walks an existing raw tree's text
// namespace and inserts the missing rows by sha.
const RETAINED_TEXTS = `
CREATE TABLE retained_texts (
  sha256 TEXT PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length BIGINT NOT NULL CHECK (byte_length >= 0),
  codepoint_length BIGINT NOT NULL CHECK (codepoint_length >= 0),
  content BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT retained_texts_byte_length_matches
    CHECK (octet_length(content) = byte_length)
);
`;

// F1-71. A document's identity within an institution is the provider's own
// id for it, not the hash of the bytes a download happened to produce.
//
// The defect: Morgan Stanley renders a fresh PDF on every download, so the
// same statement hashes differently every time it is pulled. `documents.sha256`
// is the importer's whole-document dedupe key, so every pull round recorded
// all 1,321 statements as new documents -- 6,461 rows for about 1,018
// distinct account-months on the owner's archive. Nothing was wrong with the
// bytes (they really are different bytes, and ground rule 1 keeps every one
// of them); what was wrong is that byte identity was being asked to answer
// "is this the same document," which it cannot for a source that re-renders.
//
// `provider_document_id` is that answer: the id the provider itself gives
// the document (`DiscoveredDocument.providerDocumentId`, adapter.ts --
// Morgan Stanley's `documentId`, defaulting to the opaque `externalId` for an
// adapter that names nothing finer). `sha256` keeps its own job unchanged:
// it is capture identity, "have these exact bytes been seen," which is what
// makes a re-download a new capture rather than a new document.
//
// Unique per institution among non-superseded rows only, and nullable with
// no backfill -- the same honest-null policy every migration above uses. A
// document pulled before this migration has no recorded provider id, because
// nothing ever recorded one; `scripts/collapseDuplicateDocuments.mjs` is what
// collapses those existing duplicates, and it leaves the column NULL where
// the id genuinely cannot be recovered rather than inventing one.
//
// `superseded_by` rather than deletion: the duplicate rows name real captures
// whose bytes are on disk and stay there (ground rule 1), so a collapse
// re-points what referenced them and marks them superseded. Readers that walk
// documents for work -- `reparse`, the already-recorded check in run.ts --
// filter on `superseded_by IS NULL`. `ON DELETE SET NULL`, so deleting a
// canonical document does not wedge on its superseded copies; they become
// ordinary rows again, which is the honest state once the row that superseded
// them is gone.
const DOCUMENT_PROVIDER_IDENTITY = `
ALTER TABLE documents
  ADD COLUMN provider_document_id TEXT,
  ADD COLUMN superseded_by TEXT REFERENCES documents(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX documents_provider_document_id_key
  ON documents (institution_id, provider_document_id)
  WHERE provider_document_id IS NOT NULL AND superseded_by IS NULL;

CREATE INDEX documents_superseded_by ON documents (superseded_by)
  WHERE superseded_by IS NOT NULL;
`;

// F1-73. A response revision must change for every committed write that can
// change a finance read, including an in-place correction whose row count and
// id stay the same. Computing that from all row content exceeded the reader's
// statement timeout on the hosted archive. This transaction-local counter is
// exact and O(1) to read. The epoch distinguishes a newly created archive from
// another namespace that happens to have the same counter value.
//
// One statement increments once per affected table. A BEFORE STATEMENT trigger
// takes the shared revision-row lock before a statement can take table row
// locks. This preserves one lock order across disjoint-table writers instead
// of introducing a revision-row deadlock after their table locks diverge. The
// update is part of the
// writer's transaction, so rollback also rolls it back. Archive publication is
// already serialized; other concurrent writers serialize on this single row.
// SECURITY DEFINER lets existing least-privilege writers fire the trigger
// without UPDATE on the counter itself. TG_TABLE_SCHEMA comes from Postgres,
// and format(%I) safely pins the update to the triggering archive schema while
// the function search_path contains only pg_catalog.
const FINANCE_READ_REVISION = `
CREATE TABLE finance_read_revision (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  epoch UUID NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

INSERT INTO finance_read_revision (singleton, epoch, revision)
VALUES (
  TRUE,
  md5(random()::text || clock_timestamp()::text || pg_backend_pid()::text)::uuid,
  0
);

REVOKE ALL ON finance_read_revision FROM PUBLIC;

CREATE FUNCTION bump_finance_read_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  affected_rows BIGINT;
BEGIN
  EXECUTE format(
    'UPDATE %I.finance_read_revision SET revision = revision + 1 WHERE singleton',
    TG_TABLE_SCHEMA
  );
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'finance read revision singleton missing in schema %',
      TG_TABLE_SCHEMA;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION bump_finance_read_revision() FROM PUBLIC;

DO $$
DECLARE
  tracked_table TEXT;
BEGIN
  FOREACH tracked_table IN ARRAY ARRAY[
    'institutions',
    'accounts',
    'instruments',
    'documents',
    'transactions',
    'positions',
    'balances',
    'reconciliations',
    'position_reconciliations',
    'review_items',
    'retained_texts'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER finance_read_revision_bump
         BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I.%I
         FOR EACH STATEMENT EXECUTE FUNCTION %I.bump_finance_read_revision()',
      current_schema(),
      tracked_table,
      current_schema()
    );
  END LOOP;
END;
$$;
`;

// F1-73e. Account discovery now reads evidence-learned statement-number
// aliases to derive a real last four instead of treating an opaque API key's
// numeric suffix as an account number. Alias writes must therefore invalidate
// read cursors just like writes to accounts. The one migration-time increment
// invalidates every cursor issued before aliases became a read dependency.
const ACCOUNT_ALIAS_READ_REVISION = `
CREATE TRIGGER finance_read_revision_bump
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON account_aliases
  FOR EACH STATEMENT EXECUTE FUNCTION bump_finance_read_revision();

DO $$
DECLARE
  affected_rows BIGINT;
BEGIN
  UPDATE finance_read_revision SET revision = revision + 1 WHERE singleton;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION 'finance read revision singleton missing in schema %',
      current_schema();
  END IF;
END;
$$;
`;

// F1-76 phase 3. The same-institution symbol rule (instrumentMatch.ts) needs
// three things the schema did not have.
//
// `reason_code` is the first. A review item has always explained itself in free
// text, which a person can read and nothing can count. The owner's requirement
// is that no match is accepted or refused without being countable and
// explainable later, so the decision itself becomes a column, constrained to
// the closed list `INSTRUMENT_MATCH_REASON_CODES` spells. The CHECK is the
// point: a code this build does not know is refused at write time rather than
// stored and silently counted as "other" by whatever reads it next. It stays
// nullable with no backfill -- every existing item predates the vocabulary and
// honestly has no code -- and every other kind may adopt it later by extending
// this list in a migration of its own.
//
// The identity index is the second. `review_items_weak_instrument_match_key`
// (migration 8) gave `weak_instrument_match` an instrument-level identity --
// (institution, descriptor, matched instrument) rather than which statement
// restated it -- which is exactly the identity an accepted match has too. The
// index is replaced by one covering both kinds so `institution_symbol_match`
// gets the same one-row-per-match guarantee instead of one row per statement
// per holding (the 73,247-row shape migration 8 exists to have fixed). `kind`
// is already the leading column, so the two kinds simply occupy separate slots
// and a match can hold one of each: an accepted row and, after an
// invalidation, the reflagged weak row beside it.
//
// `instrument_identifier_sources` is the third, and it is the rule's whole
// evidence base. The obvious way to ask "did this institution's own data
// establish this instrument's identifier" is to ask which institutions' rows
// reference the instrument, and that answer is circular: a holding matched by
// symbol alone writes a `positions` row referencing the instrument while
// stating no identifier, and the next statement would then see exactly one
// institution referencing it and accept the very match the first one was
// refused, with no feed ever having vouched for anything. A row is evidence
// only if the descriptor behind it stated an identifier, and neither
// `transactions` nor `positions` records whether it did.
//
// So it is recorded rather than inferred. One row per (instrument,
// institution) whose parsed descriptor actually stated a cusip or an isin,
// written by `flushInstruments` (adapterImport.ts) at mint and at every cusip-
// or isin-strong match. The composite primary key is the whole constraint:
// "how many institutions have stated an identifier for this instrument" is
// `count(*)`, and "none" and "several" are both representable, which a single
// column on `instruments` could not do.
//
// No backfill here, the same honest-null policy every migration above uses. An
// instrument minted before this table existed has no recorded source, and the
// rule refuses it (`instrument_has_no_institution_evidence`) rather than
// guessing. `scripts/backfillInstrumentIdentifierSources.mjs` reconstructs them
// for an existing archive, from `transactions` only -- see that script for why
// a position is never evidence.
const INSTRUMENT_MATCH_AUDIT = `
ALTER TABLE review_items
  ADD COLUMN reason_code TEXT
    CHECK (reason_code IS NULL OR reason_code IN (
      'same_institution_symbol_v1',
      'institution_symbol_match_invalidated',
      'symbol_matches_several_instruments',
      'instrument_has_no_strong_identifier',
      'instrument_has_no_institution_evidence',
      'instrument_vouched_by_another_institution',
      'instrument_referenced_by_several_institutions'));

DROP INDEX review_items_weak_instrument_match_key;

CREATE UNIQUE INDEX review_items_instrument_match_key
  ON review_items (kind, institution_id, raw_value, matched_instrument_id)
  WHERE kind IN ('weak_instrument_match', 'institution_symbol_match');

CREATE TABLE instrument_identifier_sources (
  instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  institution_id TEXT NOT NULL REFERENCES institutions(id),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, institution_id)
);
`;

// A corrected holding projection replaces mutable current rows, but never
// erases what an earlier publication asserted. Generations name each complete
// three-table projection for one retained document. Assertions retain the
// exact typed values, record id, locator and retained-byte provenance needed
// to verify an old citation after the current mirror has moved on.
//
// UPDATE is forbidden on all three history relations. Source erasure still
// works through the document-owned ON DELETE CASCADE graph; direct DELETE is
// an application/role responsibility rather than a stronger claim this DDL
// cannot distinguish from a cascading delete.
const HOLDING_PROJECTION_GENERATIONS = `
CREATE TABLE holding_projection_generations (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  generation_number BIGINT NOT NULL CHECK (generation_number > 0),
  generation_kind TEXT NOT NULL CHECK (generation_kind IN ('baseline', 'published')),
  retained_sha256 TEXT NOT NULL CHECK (retained_sha256 ~ '^[0-9a-f]{64}$'),
  projection_digest TEXT NOT NULL CHECK (projection_digest ~ '^[0-9a-f]{64}$'),
  candidate_projection_digest TEXT
    CHECK (candidate_projection_digest IS NULL OR candidate_projection_digest ~ '^[0-9a-f]{64}$'),
  candidate_digest TEXT CHECK (candidate_digest IS NULL OR candidate_digest ~ '^[0-9a-f]{64}$'),
  candidate_manifest JSONB,
  old_projection_digest TEXT CHECK (old_projection_digest IS NULL OR old_projection_digest ~ '^[0-9a-f]{64}$'),
  approval_digest TEXT CHECK (approval_digest IS NULL OR approval_digest ~ '^[0-9a-f]{64}$'),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  completeness_attestation TEXT,
  removals_authorized BOOLEAN,
  empty_projection_authorized BOOLEAN,
  approval_expected_active_generation_id TEXT,
  expected_previous_generation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (document_id, generation_number),
  UNIQUE (document_id, id),
  FOREIGN KEY (document_id, expected_previous_generation_id)
    REFERENCES holding_projection_generations(document_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (document_id, approval_expected_active_generation_id)
    REFERENCES holding_projection_generations(document_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (generation_kind = 'baseline'
      AND candidate_digest IS NULL
      AND candidate_manifest IS NULL
      AND candidate_projection_digest IS NULL
      AND old_projection_digest IS NULL
      AND approval_digest IS NULL
      AND approved_by IS NULL AND approved_at IS NULL
      AND completeness_attestation IS NULL
      AND removals_authorized IS NULL
      AND empty_projection_authorized IS NULL
      AND approval_expected_active_generation_id IS NULL
      AND expected_previous_generation_id IS NULL)
    OR
    (generation_kind = 'published'
      AND candidate_digest IS NOT NULL
      AND candidate_manifest IS NOT NULL
      AND jsonb_typeof(candidate_manifest) = 'object'
      AND candidate_manifest->>'kind' = 'holding_correction_candidate_v1'
      AND candidate_manifest->>'documentId' = document_id
      AND candidate_manifest->>'retainedSha256' = retained_sha256
      AND candidate_manifest->>'oldProjectionDigest' = old_projection_digest
      AND candidate_manifest->>'candidateProjectionDigest' = candidate_projection_digest
      AND candidate_manifest->>'candidateDigest' = candidate_digest
      AND candidate_manifest#>>'{completeness,state}' = 'unproven'
      AND candidate_projection_digest IS NOT NULL
      AND old_projection_digest IS NOT NULL
      AND approval_digest IS NOT NULL
      AND approved_by IS NOT NULL AND approved_by <> ''
      AND char_length(approved_by) <= 200
      AND approved_at IS NOT NULL
      AND completeness_attestation IS NOT NULL
      AND completeness_attestation = 'operator_verified_complete_projection'
      AND removals_authorized IS NOT NULL
      AND empty_projection_authorized IS NOT NULL
      AND expected_previous_generation_id IS NOT NULL)
  )
);

CREATE TABLE holding_projection_assertions (
  assertion_kind TEXT NOT NULL
    CHECK (assertion_kind IN ('position', 'balance', 'liability')),
  record_id TEXT NOT NULL,
  source_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  retained_sha256 TEXT NOT NULL CHECK (retained_sha256 ~ '^[0-9a-f]{64}$'),
  row_hash TEXT,
  source_locator TEXT,
  assertion_digest TEXT NOT NULL CHECK (assertion_digest ~ '^[0-9a-f]{64}$'),

  account_id TEXT REFERENCES accounts(id),
  institution_id TEXT REFERENCES institutions(id),
  instrument_id TEXT REFERENCES instruments(id),
  as_of DATE NOT NULL,
  currency currency_code NOT NULL,

  quantity finance_numeric,
  price finance_numeric,
  market_value finance_numeric,
  cost_basis finance_numeric,
  unrealized finance_numeric,
  valuation_basis TEXT CHECK (valuation_basis IS NULL
    OR valuation_basis IN ('market_price', 'last_round', 'cost', 'reported_nav')),
  valuation_note TEXT,

  total_value finance_numeric,
  cash finance_numeric,
  period_start_value finance_numeric,
  period_end_value finance_numeric,

  liability_kind TEXT,
  display_name TEXT,
  liability_balance finance_numeric,
  rate finance_numeric,
  collateral_note TEXT,

  PRIMARY KEY (assertion_kind, record_id),
  UNIQUE (source_document_id, assertion_kind, record_id),
  CHECK (
    (assertion_kind = 'position'
      AND account_id IS NOT NULL
      AND institution_id IS NULL
      AND liability_kind IS NULL AND display_name IS NULL
      AND liability_balance IS NULL AND rate IS NULL AND collateral_note IS NULL
      AND total_value IS NULL AND cash IS NULL
      AND period_start_value IS NULL AND period_end_value IS NULL)
    OR
    (assertion_kind = 'balance'
      AND account_id IS NOT NULL
      AND institution_id IS NULL AND instrument_id IS NULL
      AND quantity IS NULL AND price IS NULL AND market_value IS NULL
      AND cost_basis IS NULL AND unrealized IS NULL
      AND valuation_basis IS NULL AND valuation_note IS NULL
      AND liability_kind IS NULL AND display_name IS NULL
      AND liability_balance IS NULL AND rate IS NULL AND collateral_note IS NULL)
    OR
    (assertion_kind = 'liability'
      AND liability_kind IS NOT NULL
      AND instrument_id IS NULL
      AND quantity IS NULL AND price IS NULL AND market_value IS NULL
      AND cost_basis IS NULL AND unrealized IS NULL
      AND valuation_basis IS NULL AND valuation_note IS NULL
      AND total_value IS NULL AND cash IS NULL
      AND period_start_value IS NULL AND period_end_value IS NULL)
  )
);

CREATE TABLE holding_projection_generation_memberships (
  document_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  assertion_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY (generation_id, assertion_kind, record_id),
  FOREIGN KEY (document_id, generation_id)
    REFERENCES holding_projection_generations(document_id, id) ON DELETE CASCADE,
  FOREIGN KEY (document_id, assertion_kind, record_id)
    REFERENCES holding_projection_assertions(source_document_id, assertion_kind, record_id)
      ON DELETE CASCADE
);

ALTER TABLE documents
  ADD COLUMN active_holding_projection_generation_id TEXT,
  ADD CONSTRAINT documents_active_holding_projection_generation_same_document
    FOREIGN KEY (id, active_holding_projection_generation_id)
    REFERENCES holding_projection_generations(document_id, id)
    ON DELETE SET NULL (active_holding_projection_generation_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION reject_holding_projection_history_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'holding projection history is immutable';
END;
$$;

REVOKE ALL ON FUNCTION reject_holding_projection_history_update() FROM PUBLIC;

CREATE TRIGGER holding_projection_generations_immutable
  BEFORE UPDATE ON holding_projection_generations
  FOR EACH ROW EXECUTE FUNCTION reject_holding_projection_history_update();
CREATE TRIGGER holding_projection_assertions_immutable
  BEFORE UPDATE ON holding_projection_assertions
  FOR EACH ROW EXECUTE FUNCTION reject_holding_projection_history_update();
CREATE TRIGGER holding_projection_memberships_immutable
  BEFORE UPDATE ON holding_projection_generation_memberships
  FOR EACH ROW EXECUTE FUNCTION reject_holding_projection_history_update();
`;

// Positive source coverage is separate from the mutable current position
// mirror. One observation records what one retained document proved for one
// account/date; its memberships name the exact semantic position hashes that
// parser emitted and retain that document's own evidence locator. A member is
// intentionally not a foreign key to positions: another document may own the
// globally deduplicated current row, and removing or replacing that row must
// make the read predicate fail closed rather than delete source history.
//
// A versioned document binds an observation to the projection generation it
// was replayed against. A later reviewed replacement therefore retires the
// proof from reads without mutating it. Unversioned documents use the partial
// unique index below and retain the conservative one-proof-version rule.
const POSITION_SCOPE_OBSERVATIONS = `
CREATE FUNCTION position_scope_has_complete_tables(value JSONB)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT CASE
    WHEN jsonb_typeof(value->'tables') = 'array' THEN
      jsonb_array_length(value->'tables') > 0
      AND NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(value->'tables') AS table_entry
         WHERE jsonb_typeof(table_entry) <> 'object'
            OR CASE
                 WHEN jsonb_typeof(table_entry->'headers') = 'array'
                 THEN jsonb_array_length(table_entry->'headers') = 0
                 ELSE TRUE
               END
            OR jsonb_typeof(table_entry->'end') IS DISTINCT FROM 'object'
      )
    ELSE FALSE
  END
$$;

REVOKE ALL ON FUNCTION position_scope_has_complete_tables(JSONB) FROM PUBLIC;

CREATE TABLE position_scope_observations (
  id TEXT PRIMARY KEY,
  source_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  holding_projection_generation_id TEXT,
  retained_sha256 TEXT NOT NULL CHECK (retained_sha256 ~ '^[0-9a-f]{64}$'),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  as_of DATE NOT NULL,
  proof_version TEXT NOT NULL CHECK (proof_version = 'position_scope_v1'),
  status TEXT NOT NULL CHECK (status IN ('complete', 'partial')),
  emitted_position_count BIGINT NOT NULL CHECK (emitted_position_count >= 0),
  gap_codes TEXT[] NOT NULL,
  zero_basis TEXT CHECK (zero_basis IS NULL OR zero_basis = 'source_stated_none'),
  evidence JSONB NOT NULL CHECK (
    jsonb_typeof(evidence) = 'object'
    AND jsonb_typeof(evidence->'tables') IS NOT DISTINCT FROM 'array'
  ),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (source_document_id, id),
  UNIQUE (source_document_id, id, account_id, as_of),
  FOREIGN KEY (source_document_id, holding_projection_generation_id)
    REFERENCES holding_projection_generations(document_id, id),
  CHECK (gap_codes <@ ARRAY[
    'unresolved_lots',
    'missing_security_start',
    'unsupported_table_header',
    'unsupported_value_column',
    'page_sequence_gap',
    'unbounded_account_scope',
    'unproven_empty'
  ]::TEXT[]),
  CHECK (
    (status = 'complete' AND cardinality(gap_codes) = 0)
    OR (status = 'partial' AND cardinality(gap_codes) > 0)
  ),
  CHECK (
    (status = 'complete' AND emitted_position_count = 0
      AND zero_basis = 'source_stated_none')
    OR (status = 'complete' AND emitted_position_count > 0
      AND zero_basis IS NULL)
    OR (status = 'partial' AND zero_basis IS NULL)
  ),
  CHECK (
    status <> 'complete'
    OR (
      jsonb_typeof(evidence->'scopeEnd') IS NOT DISTINCT FROM 'object'
      AND (
        (emitted_position_count = 0
          AND jsonb_typeof(evidence->'explicitNone')
            IS NOT DISTINCT FROM 'object')
        OR (emitted_position_count > 0
          AND position_scope_has_complete_tables(evidence))
      )
    )
  )
);

CREATE UNIQUE INDEX position_scope_observations_unversioned_key
  ON position_scope_observations
    (source_document_id, account_id, as_of, proof_version)
  WHERE holding_projection_generation_id IS NULL;

CREATE UNIQUE INDEX position_scope_observations_versioned_key
  ON position_scope_observations
    (source_document_id, holding_projection_generation_id,
     account_id, as_of, proof_version)
  WHERE holding_projection_generation_id IS NOT NULL;

CREATE TABLE position_scope_memberships (
  source_document_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  position_row_hash TEXT NOT NULL CHECK (position_row_hash ~ '^[0-9a-f]{64}$'),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  as_of DATE NOT NULL,
  instrument_id TEXT REFERENCES instruments(id),
  quantity finance_numeric,
  price finance_numeric,
  market_value finance_numeric,
  cost_basis finance_numeric,
  unrealized finance_numeric,
  currency currency_code NOT NULL,
  valuation_basis TEXT CHECK (valuation_basis IS NULL
    OR valuation_basis IN ('market_price', 'last_round', 'cost', 'reported_nav')),
  valuation_note TEXT,
  source_locator TEXT NOT NULL,
  PRIMARY KEY (scope_id, position_row_hash),
  FOREIGN KEY (source_document_id, scope_id, account_id, as_of)
    REFERENCES position_scope_observations
      (source_document_id, id, account_id, as_of)
    ON DELETE CASCADE
);

CREATE TRIGGER position_scope_observations_immutable
  BEFORE UPDATE ON position_scope_observations
  FOR EACH ROW EXECUTE FUNCTION reject_holding_projection_history_update();
CREATE TRIGGER position_scope_memberships_immutable
  BEFORE UPDATE ON position_scope_memberships
  FOR EACH ROW EXECUTE FUNCTION reject_holding_projection_history_update();

CREATE TRIGGER finance_read_revision_bump
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON position_scope_observations
  FOR EACH STATEMENT EXECUTE FUNCTION bump_finance_read_revision();
CREATE TRIGGER finance_read_revision_bump
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON position_scope_memberships
  FOR EACH STATEMENT EXECUTE FUNCTION bump_finance_read_revision();
`;

/** Every migration, in order. The last one's version is the current schema. */
export const PG_MIGRATIONS: readonly PgMigration[] = Object.freeze([
  {
    version: 1,
    name: "initial postgres archive schema",
    sql: INITIAL_SCHEMA,
  },
  {
    version: 2,
    name: "documents retained byte provenance",
    sql: RETAINED_PROVENANCE,
  },
  {
    version: 3,
    name: "accounts external key",
    sql: ACCOUNT_EXTERNAL_KEY,
  },
  {
    version: 4,
    name: "review_items.source_document_id cascades on document delete",
    sql: REVIEW_ITEMS_CASCADE,
  },
  {
    version: 5,
    name: "positions, balances and liabilities gain a deduplication row_hash",
    sql: HOLDING_ROW_HASH,
  },
  {
    version: 6,
    name: "account_aliases: alternate external keys per account",
    sql: ACCOUNT_ALIASES,
  },
  {
    version: 7,
    name: "review_items dedupe key on (kind, source_document_id, source_locator, raw_value)",
    sql: REVIEW_ITEMS_DEDUPE_KEY,
  },
  {
    version: 8,
    name: "weak_instrument_match becomes instrument-level: institution_id, matched_instrument_id, occurrence_count, last_seen_document_id",
    sql: WEAK_INSTRUMENT_MATCH_IDENTITY,
  },
  {
    version: 9,
    name: "retained_texts: the retained text a text-span citation is verified against",
    sql: RETAINED_TEXTS,
  },
  {
    version: 10,
    name: "documents.provider_document_id: institution-scoped document identity, and superseded_by",
    sql: DOCUMENT_PROVIDER_IDENTITY,
  },
  {
    version: 11,
    name: "finance read revision epoch, counter and write triggers",
    sql: FINANCE_READ_REVISION,
  },
  {
    version: 12,
    name: "account aliases invalidate finance reads",
    sql: ACCOUNT_ALIAS_READ_REVISION,
  },
  {
    version: 13,
    name: "review_items.reason_code, a shared instrument-match identity index, and instrument_identifier_sources",
    sql: INSTRUMENT_MATCH_AUDIT,
  },
  {
    version: 14,
    name: "immutable holding projection generations and current document pointer",
    sql: HOLDING_PROJECTION_GENERATIONS,
  },
  {
    version: 15,
    name: "account-scoped position coverage observations and exact memberships",
    sql: POSITION_SCOPE_OBSERVATIONS,
  },
]);

/** The version an archive reaches once every migration has been applied. */
export const PG_SCHEMA_VERSION =
  PG_MIGRATIONS[PG_MIGRATIONS.length - 1]!.version;

/** Every table the schema creates, in creation order. */
export const PG_TABLES: readonly string[] = Object.freeze([
  "institutions",
  "accounts",
  "instruments",
  "documents",
  "transactions",
  "positions",
  "balances",
  "liabilities",
  "commitments",
  "import_runs",
  "reconciliations",
  "position_reconciliations",
  "review_items",
  "account_aliases",
  "instrument_identifier_sources",
  "retained_texts",
  "finance_read_revision",
  "holding_projection_generations",
  "holding_projection_assertions",
  "holding_projection_generation_memberships",
  "position_scope_observations",
  "position_scope_memberships",
]);

/**
 * The recorded version of the archive schema, or 0 when this database has no
 * archive in that schema. Qualified deliberately: another component's
 * `schema_version` in the same database must never answer this question.
 */
export async function pgSchemaVersion(
  client: pg.ClientBase,
  schema: string = archiveSchemaOf(client),
): Promise<number> {
  // F1-34: the schema name is interpolated into SQL below, so it goes
  // through the same validator every other entry point uses. A default
  // argument is not a guarantee -- this one is public and takes a caller's
  // string.
  const name = assertSchemaName(schema);
  const present = await client.query<{ present: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [`${name}.schema_version`],
  );
  if (!present.rows[0]?.present) return 0;
  const result = await client.query<{ version: string | null }>(
    `SELECT max(version)::text AS version FROM ${name}.schema_version`,
  );
  return Number(result.rows[0]?.version ?? 0);
}

/**
 * Creates the archive in its own named schema, applies every migration the
 * recorded version says is missing, and records each one it applied. Running
 * it again is a no-op returning the recorded version, which is what makes
 * rebuilding the archive from the raw tree routine rather than an event.
 *
 * The whole thing is one transaction, and an advisory lock excludes a second
 * creator by the database rather than by everyone remembering that only one
 * machine imports. The lock is keyed on the schema name as well, so creating
 * one archive does not block creating an unrelated one in the same database.
 *
 * `search_path` is pinned with `SET LOCAL` rather than `SET`, so the
 * unqualified DDL below lands in this schema even on a pooled endpoint, where
 * a session-level `SET` can be handed to a backend the next statement never
 * sees. The pin is recorded on the client, so every later transaction on it
 * resolves the same objects.
 */
export async function applyPgSchema(
  client: pg.ClientBase,
  schema: string = archiveSchemaOf(client),
): Promise<number> {
  const name = pinArchiveSchema(client, schema);
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
      SCHEMA_LOCK_KEY,
      name,
    ]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${name}`);
    await client.query(`SET LOCAL search_path TO ${name}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${name}.schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const current = await pgSchemaVersion(client, name);
    if (current > PG_SCHEMA_VERSION) {
      throw new Error(
        `archive is at schema ${current}, newer than this build understands (${PG_SCHEMA_VERSION})`,
      );
    }
    for (const migration of PG_MIGRATIONS) {
      if (migration.version <= current) continue;
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO ${name}.schema_version (version, name) VALUES ($1, $2)`,
        [migration.version, migration.name],
      );
    }
    await client.query("COMMIT");
    return PG_SCHEMA_VERSION;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
