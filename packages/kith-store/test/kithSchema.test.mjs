// The brain schema against a real server: it applies, it re-applies to nothing,
// its id convention is enforced by the database and not only by TypeScript, its
// space predicate filters, and it lands beside `finance` without touching it.
//
// Each test runs in its own throwaway database (test/helpers/pgDatabase.mjs).

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyKithSchema,
  GENERATED_KITH_ID_LENGTH,
  KITH_ID,
  KITH_MIGRATIONS,
  KITH_SCHEMA_VERSION,
  kithSchemaVersion,
  newKithId,
  ProofError,
  spacePredicate,
} from "../dist/index.js";
import {
  applyPgSchema,
  createArchiveClient,
  PG_SCHEMA_VERSION,
  PG_TABLES,
  pgSchemaVersion,
} from "@repo/finance-archive";

import {
  all,
  connect,
  refused,
  skip,
  throwawayDatabase,
} from "./helpers/pgDatabase.mjs";

const KITH_TABLES = [
  // The plain names belong to the `kith_id`-keyed ported tables (migration 006);
  // the prototype's `uuid`-keyed pair kept the same names until then and now
  // carries a `proof_` prefix.
  "spaces",
  "api_keys",
  "worker_jobs",
  // P2-39c (migration 006): the prototype's uuid-keyed pair moved to `proof_*`
  // so the plain `spaces` and `api_keys` above are migration 004's kith_id-keyed
  // tables, and the rest of the identity domain lands with them.
  "proof_spaces",
  "proof_api_keys",
  "sessions",
  "users",
  "auth_accounts",
  "space_members",
  "user_space_settings",
  "api_key_spaces",
  "api_key_source_accounts",
  "family_invitations",
  "consumed_oauth_codes",
  // P2-39d (migration 005): retires the prototype's uuid-keyed documents,
  // source_revisions and chunks (migration 001) and frees their names for
  // migration 004's kith_id-keyed brain_documents, brain_source_revisions
  // and brain_chunks, renamed there to the plain names below. idempotency_receipts
  // is retired with them: its operation CHECK named only the three document
  // methods that row retired from `PostgresProof`.
  "source_items",
  "source_revisions",
  "source_parser_artifacts",
  "source_artifact_archive_receipts",
  "source_artifact_archive_bindings",
  "source_artifact_deletion_acks",
  "source_provider_original_references",
  "source_provider_original_bindings",
  "source_provider_original_detach_acks",
  "source_text_versions",
  "source_pages",
  "evidence_spans",
  "documents",
  "chunks",
  "processing_generations",
  "processing_generation_payload_manifests",
  "source_inventory",
  // PLAID-1 (migration 043): item state only now (migration 048 retired the
  // rest of this feed's own tables in favor of kith.fin_*).
  "plaid_items",
  // FIN-1 (migration 048): the one unified ledger over the archive and the
  // Plaid feed.
  "fin_accounts",
  "fin_securities",
  "fin_transactions",
  "fin_holding_snapshots",
  "fin_balance_snapshots",
  // FIN-3 (migration 050): an owner's persisted --link/--unlink override,
  // read before any automatic (holdings/balance/mask/name) matching runs.
  "fin_account_link_overrides",
  // FIN-4 (migration 051): the many-archive-instruments-to-one-security map,
  // resolved before any CUSIP/ISIN/ticker match is retried.
  "fin_security_links",
];

// P2-39d: retired by migration 005, so this build must never re-create them.
const RETIRED_PROOF_TABLES = [
  "generations",
  "pages",
  "evidence",
  "synthetic_financial_attachments",
  "idempotency_receipts",
];

// FIN-1 (migration 048): retired in favor of kith.fin_*, above.
const RETIRED_PLAID_TABLES = [
  "plaid_accounts",
  "plaid_securities",
  "plaid_balance_snapshots",
  "plaid_holding_snapshots",
  "plaid_transactions",
  "plaid_investment_transactions",
];

function history(client) {
  return all(
    client,
    "SELECT version::int AS version, name, applied_at FROM kith.schema_version ORDER BY version",
  );
}

test(
  "applyKithSchema applies every migration once and re-applies to nothing",
  { skip },
  async (t) => {
    const client = await connect(await throwawayDatabase(t));

    assert.equal(await kithSchemaVersion(client), 0);
    assert.equal(await applyKithSchema(client), KITH_SCHEMA_VERSION);
    assert.equal(await kithSchemaVersion(client), KITH_SCHEMA_VERSION);

    const applied = await history(client);
    assert.deepEqual(
      applied.map((row) => row.version),
      KITH_MIGRATIONS.map((migration) => migration.version),
    );
    assert.deepEqual(
      applied.map((row) => row.name),
      KITH_MIGRATIONS.map((migration) => migration.name),
    );

    // Idempotent: the same version, and the same `applied_at` on every row, so
    // nothing re-ran rather than merely nothing erroring.
    assert.equal(await applyKithSchema(client), KITH_SCHEMA_VERSION);
    assert.deepEqual(await history(client), applied);

    for (const table of KITH_TABLES) {
      const [row] = await all(
        client,
        "SELECT to_regclass($1) IS NOT NULL AS present",
        [`kith.${table}`],
      );
      assert.equal(row.present, true, `kith.${table} should exist`);
    }
    // Migration 049: the overlap boundary import-archive last applied for
    // an account, nullable so an unlinked or not-yet-bounded account reads
    // as "no boundary" rather than a sentinel date.
    const [archiveCoverageColumn] = await all(
      client,
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'kith' AND table_name = 'fin_accounts'
          AND column_name = 'archive_coverage_through'`,
    );
    assert.ok(archiveCoverageColumn, "kith.fin_accounts.archive_coverage_through should exist");
    assert.equal(archiveCoverageColumn.data_type, "date");
    assert.equal(archiveCoverageColumn.is_nullable, "YES");

    // Migration 050: how archive_account_id got set on a fin_accounts row --
    // holdings/balance/mask/name/manual -- or null for an account with no
    // link (or a Plaid-only row with no archive link at all).
    const [matchMethodColumn] = await all(
      client,
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'kith' AND table_name = 'fin_accounts'
          AND column_name = 'match_method'`,
    );
    assert.ok(matchMethodColumn, "kith.fin_accounts.match_method should exist");
    assert.equal(matchMethodColumn.data_type, "text");
    assert.equal(matchMethodColumn.is_nullable, "YES");

    // Migration 051: fin_securities.archive_instrument_id is no longer
    // UNIQUE (many archive instruments can resolve to one security) but is
    // still indexed for lookup.
    const [archiveInstrumentIdConstraint] = await all(
      client,
      `SELECT 1 FROM pg_constraint
        WHERE conrelid = 'kith.fin_securities'::regclass
          AND conname = 'fin_securities_archive_instrument_id_key'`,
    );
    assert.equal(
      archiveInstrumentIdConstraint,
      undefined,
      "the UNIQUE constraint on fin_securities.archive_instrument_id should be dropped",
    );
    const [archiveInstrumentIdIndex] = await all(
      client,
      `SELECT 1 FROM pg_indexes
        WHERE schemaname = 'kith' AND tablename = 'fin_securities'
          AND indexname = 'fin_securities_archive_instrument_id_idx'`,
    );
    assert.ok(archiveInstrumentIdIndex, "fin_securities.archive_instrument_id should still be indexed");

    // Migration 052: the owner's own name for a feed-only account, nullable
    // so an unnamed account reads as "use the feed's own name" rather than a
    // sentinel.
    const [displayNameColumn] = await all(
      client,
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'kith' AND table_name = 'fin_accounts'
          AND column_name = 'display_name'`,
    );
    assert.ok(displayNameColumn, "kith.fin_accounts.display_name should exist");
    assert.equal(displayNameColumn.data_type, "text");
    assert.equal(displayNameColumn.is_nullable, "YES");

    for (const table of RETIRED_PROOF_TABLES) {
      const [row] = await all(
        client,
        "SELECT to_regclass($1) IS NOT NULL AS present",
        [`kith.${table}`],
      );
      assert.equal(row.present, false, `kith.${table} should be retired`);
    }
    for (const table of RETIRED_PLAID_TABLES) {
      const [row] = await all(
        client,
        "SELECT to_regclass($1) IS NOT NULL AS present",
        [`kith.${table}`],
      );
      assert.equal(row.present, false, `kith.${table} should be retired`);
    }
    for (const table of ["brain_documents", "brain_source_revisions", "brain_chunks"]) {
      const [row] = await all(
        client,
        "SELECT to_regclass($1) IS NOT NULL AS present",
        [`kith.${table}`],
      );
      assert.equal(row.present, false, `kith.${table} should be renamed away`);
    }

    // A database at a version this build does not have is refused rather than
    // migrated from a version it is not at.
    await client.query(
      "INSERT INTO kith.schema_version (version, name) VALUES ($1, 'from a later build')",
      [KITH_SCHEMA_VERSION + 1],
    );
    await assert.rejects(
      applyKithSchema(client),
      (error) => error instanceof ProofError && error.code === "schema_too_new",
    );
    await client.query("DELETE FROM kith.schema_version WHERE version = $1", [
      KITH_SCHEMA_VERSION + 1,
    ]);

    // A gap in the recorded history is refused for the same reason.
    await client.query("DELETE FROM kith.schema_version WHERE version = 1");
    await assert.rejects(
      applyKithSchema(client),
      (error) =>
        error instanceof ProofError && error.code === "schema_history_invalid",
    );
  },
);

test(
  "the kith_id domain enforces the same convention the generator produces",
  { skip },
  async (t) => {
    const client = await connect(await throwawayDatabase(t));
    await applyKithSchema(client);

    const generated = newKithId();
    assert.match(generated, KITH_ID);
    assert.equal(generated.length, GENERATED_KITH_ID_LENGTH);
    assert.equal(new Set(Array.from({ length: 64 }, newKithId)).size, 64);

    // The TypeScript rule and the database's CHECK are one convention written
    // twice. Every sample must be accepted or refused by both, or a row could be
    // written that the port's own validator would later reject.
    const samples = [
      generated,
      "jh7c2m4qv9x0zk3n5p8rt1wy6b", // a generated-shape id
      "kd72nn9q8s4t6v1w3x5y7z0a2b4c6d8e", // a preserved 32-character id
      "",
      "short",
      "JH7C2M4QV9X0ZK3N5P8RT1WY6B",
      "jh7c2m4qv9x0zk3n-5p8rt1wy6b",
      "jh7c2m4qv9x0 zk3n5p8rt1wy6b",
      "../../etc/passwd",
      "a".repeat(19),
      "a".repeat(20),
      "a".repeat(64),
      "a".repeat(65),
    ];
    for (const sample of samples) {
      const error = await refused(client, "SELECT $1::kith.kith_id", [sample]);
      assert.equal(
        error === null,
        KITH_ID.test(sample),
        `kith.kith_id and KITH_ID disagree about ${JSON.stringify(sample)}`,
      );
      if (error) assert.equal(error.code, "23514");
    }
  },
);

test(
  "the space predicate filters to the authorized spaces and denies an empty set",
  { skip },
  async (t) => {
    const client = await connect(await throwawayDatabase(t));
    await applyKithSchema(client);
    // A scratch table over the id convention: the tables the port brings over do
    // not exist yet, and this is the shape every one of them will have.
    await client.query(`
    CREATE TEMP TABLE scoped (
      id kith.kith_id PRIMARY KEY,
      space_id kith.kith_id NOT NULL,
      UNIQUE (id, space_id)
    )`);
    const spaceA = newKithId();
    const spaceB = newKithId();
    const inA = [newKithId(), newKithId()].sort();
    const inB = [newKithId()];
    for (const [space, ids] of [
      [spaceA, inA],
      [spaceB, inB],
    ]) {
      for (const id of ids) {
        await client.query(
          "INSERT INTO scoped (id, space_id) VALUES ($1, $2)",
          [id, space],
        );
      }
    }

    const onlyA = spacePredicate([spaceA], 1);
    assert.equal(onlyA.sql, "space_id = ANY($1::text[])");
    assert.deepEqual(
      (
        await all(
          client,
          `SELECT id FROM scoped WHERE ${onlyA.sql} ORDER BY id`,
          [onlyA.value],
        )
      ).map((row) => row.id),
      inA,
    );

    const both = spacePredicate([spaceB, spaceA, spaceA], 2, "scoped.space_id");
    assert.equal(both.sql, "scoped.space_id = ANY($2::text[])");
    // Deduplicated and ordered, so the same authority produces the same statement.
    assert.deepEqual(both.value, [spaceA, spaceB].sort());
    // At $2, beside another parameter, because that is how a real read carries it.
    assert.equal(
      (
        await all(
          client,
          `SELECT count(*)::int AS n FROM scoped WHERE id <> $1 AND ${both.sql}`,
          [newKithId(), both.value],
        )
      )[0].n,
      3,
    );

    // An empty authorized set denies. It never produces a predicate that matches
    // every row and never produces no predicate at all.
    for (const [args, code] of [
      [[[], 1], "unauthorized"],
      [[[spaceA], 0], "invalid_parameter_index"],
      [[[spaceA], 1, "space_id; DROP TABLE scoped"], "invalid_space_column"],
      [[["../../etc/passwd"], 1], "invalid_space_id"],
      [[["A".repeat(26)], 1], "invalid_space_id"],
    ]) {
      assert.throws(
        () => spacePredicate(...args),
        (error) => error instanceof ProofError && error.code === code,
        `spacePredicate(${JSON.stringify(args)}) should fail with ${code}`,
      );
    }
  },
);

test(
  "kith applies beside a finance schema without touching it",
  { skip },
  async (t) => {
    const database = await throwawayDatabase(t);
    const client = await connect(database);

    const archive = database.adopt(
      createArchiveClient(database.url, "finance"),
    );
    await archive.connect();
    assert.equal(await applyPgSchema(archive, "finance"), PG_SCHEMA_VERSION);
    const financeShape = () =>
      all(
        client,
        `SELECT table_name, column_name, data_type, is_nullable, domain_name
         FROM information_schema.columns
        WHERE table_schema = 'finance'
        ORDER BY table_name, ordinal_position`,
      );
    const financeHistory = () =>
      all(
        client,
        "SELECT version::int AS version, name FROM finance.schema_version ORDER BY version",
      );
    const before = await financeShape();
    const beforeHistory = await financeHistory();
    assert.ok(before.length > 0);
    assert.equal(beforeHistory.at(-1)?.version, PG_SCHEMA_VERSION);

    assert.equal(await applyKithSchema(client), KITH_SCHEMA_VERSION);

    assert.deepEqual(await financeShape(), before);
    assert.deepEqual(await financeHistory(), beforeHistory);
    assert.equal(await pgSchemaVersion(archive, "finance"), PG_SCHEMA_VERSION);
    for (const table of PG_TABLES) {
      const [row] = await all(
        client,
        "SELECT to_regclass($1) IS NOT NULL AS present",
        [`finance.${table}`],
      );
      assert.equal(row.present, true, `finance.${table} should still exist`);
    }

    // The collision section 2.1 of the plan is built around: two different
    // `documents` tables, in one database, neither renamed.
    const [documents] = await all(
      client,
      `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_name = 'documents' AND table_schema IN ('finance', 'kith')`,
    );
    assert.equal(documents.n, 2);
  },
);
