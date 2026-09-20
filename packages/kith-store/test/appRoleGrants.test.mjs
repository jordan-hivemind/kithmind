// What the application credential may write, asserted as that credential.
//
// Section 4.2 of the web and MCP surface plan found the gap this covers:
// `grantProofAppRole` named 24 tables and none of them were the identity,
// memory, records or coverage tables, so "`kith.sessions` cannot be written by
// the app role as the code stands" and neither could anything else the
// dashboard touches. Every one of those writes had only ever been exercised as
// the owner role, which grants everything and therefore proves nothing about
// the credential production actually uses.
//
// So this suite connects as the app role itself. One real write per table group
// says the grant reaches the server, and `has_table_privilege` over the full
// list says no table was left out of the GRANT statement, which is the failure
// mode that is otherwise invisible until the first request that needs it.
//
// `kith.schema_version` is the deliberate control. Only a migration runner
// writes it, so the app role must be refused there; without that assertion a
// grant that accidentally said ALL TABLES would pass everything above.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import pg from "pg";

import {
  applyKithSchema,
  grantProofAppRole,
  newKithId,
} from "../dist/index.js";
import { connect, skip, throwawayDatabase } from "./helpers/pgDatabase.mjs";

/** Every table the four groups P2-39i adds must be writable on. */
const GRANTED = Object.freeze({
  identity: [
    "users",
    "auth_accounts",
    "sessions",
    "api_keys",
    "api_key_spaces",
    "api_key_source_accounts",
    "consumed_oauth_codes",
    "spaces",
    "space_members",
    "family_invitations",
    "user_space_settings",
    "auth_rate_limits",
  ],
  memory: ["entities", "facts", "thoughts"],
  records: [
    "events",
    "event_versions",
    "observations",
    "record_query_sessions",
    "record_query_space_state",
  ],
  coverage: ["coverage_windows", "coverage_gaps"],
  admin: [
    "document_types",
    "document_type_fields",
    "source_roots",
    "source_root_reports",
    "investments",
    "investment_entries",
    "corrections",
  ],
  extraction: ["document_extractions"],
  // ADM-9. The worker protocol's own tables. Thirteen of them were in no
  // group at all, including the watcher row two diagnostics operations write
  // and `source_accounts`, which every epoch bump in the protocol goes
  // through. `WORKER_WRITE_PATH` below is the assertion that keeps the list
  // honest as handlers are added; this group is the grant it checks.
  worker: [
    "source_accounts",
    "space_processing_state",
    "worker_source_scans",
    "worker_scan_pages",
    "worker_reservation_receipts",
    "worker_reservation_targets",
    "worker_operation_receipts",
    "worker_binary_operation_receipts",
    "worker_parsed_stages",
    "worker_processing_assessments",
    "worker_watcher_states",
    "worker_operational_incidents",
    "worker_watcher_reset_receipts",
  ],
  attention: ["attention_mutes"],
  // ADM-8b. One table, and it is the one the nightly matcher writes on every
  // pass. Without the grant the daemon fails with 42501 on its first link and
  // only in production, because every other test here runs as the owner.
  investmentLinks: ["investment_document_links"],
  financeOverrides: ["finance_account_overrides"],
});

/**
 * Every table one `document_extraction` job writes, end to end (ADM-5a).
 *
 * The groups above are per migration, so a table can be in the GRANT and the
 * job can still fail on a table that is not. This list is the other axis: it
 * follows one job through `src/extraction/model.ts` -- it seeds the type rows,
 * creates a placeholder entity, stages an evidence span, mints the stable
 * event and its version, writes the observations, upserts the extraction row
 * and opens corrections -- and asserts the credential the daemon actually uses
 * can write all of it. The failure it exists to catch is invisible in every
 * other test in the repository, because every other test runs as the owner.
 */
const EXTRACTION_WRITE_PATH = Object.freeze([
  "document_types",
  "document_type_fields",
  "entities",
  "evidence_spans",
  "events",
  "event_versions",
  "observations",
  "document_extractions",
  "corrections",
]);

/**
 * Every `kith` table a worker operation writes, read out of the handlers
 * themselves (ADM-9, first review finding 3).
 *
 * A hand-maintained list is the thing that went wrong here: thirteen tables
 * the worker protocol writes were in no GRANT group, and nothing said so,
 * because every test in the repository runs as the owner role. So this list
 * is not maintained -- it is derived, from every INSERT, UPDATE and DELETE
 * naming a `kith.` table anywhere in `src/workers/`. A handler that starts
 * writing a new table fails this suite until the grant follows it.
 *
 * Deliberately coarse. It over-approximates (a table named in a rolled-back
 * statement or a dead branch still counts) and that is the right direction to
 * be wrong in: an extra grant on a table the app already reads is cheap, and a
 * missing one is a 42501 in production and nowhere else.
 */
function workerWritePath() {
  const directory = new URL("../src/workers/", import.meta.url);
  const tables = new Set();
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".ts")) continue;
    const source = readFileSync(new URL(entry, directory), "utf8");
    for (const match of source.matchAll(
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+kith\.([a-z_]+)/gs,
    )) {
      tables.add(match[1]);
    }
  }
  return [...tables].sort();
}

/** Tables no application write may reach. The control for the list above. */
const WITHHELD = Object.freeze(["schema_version", "proof_spaces", "proof_api_keys"]);

const INSUFFICIENT_PRIVILEGE = "42501";

async function createAppRole(owner) {
  const role = `kith_app_grants_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  await owner.query(
    `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
  );
  return { role, password };
}

/** The error a statement raised, or null when it succeeded. */
async function attempt(client, sql, values = []) {
  try {
    await client.query(sql, values);
    return null;
  } catch (error) {
    return error;
  }
}

test(
  "the app role can connect to a database whose PUBLIC CONNECT was revoked",
  { skip },
  async (t) => {
    // The hosted archive database is hardened by `packages/pg/src/readerRole.ts`:
    // PUBLIC loses CONNECT and TEMPORARY on the database, and only the finance
    // reader gets CONNECT back. `grantProofAppRole` must grant CONNECT itself,
    // or every schema grant applies to a role that cannot log in.
    const database = await throwawayDatabase(t);
    const owner = await connect(database);
    await applyKithSchema(owner);
    const role = await createAppRole(owner);
    const name = new URL(database.url).pathname.slice(1);
    await owner.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);

    const url = new URL(database.url);
    url.username = role.role;
    url.password = role.password;
    const before = database.adopt(new pg.Client({ connectionString: url.toString() }));
    const refused = await before.connect().then(
      () => null,
      (error) => error,
    );
    assert.equal(refused?.code, INSUFFICIENT_PRIVILEGE, "the revoke must bite before the grant");
    await before.end().catch(() => {});

    await grantProofAppRole(owner, role.role);
    const app = database.adopt(new pg.Client({ connectionString: url.toString() }));
    await app.connect();
    try {
      assert.equal((await app.query("SELECT count(*)::int AS n FROM kith.users")).rows[0].n, 0);
      // TEMPORARY stays revoked: the app role must not stage data in the server.
      const temp = await attempt(app, "CREATE TEMPORARY TABLE probe_temp (id int)");
      assert.equal(temp?.code, INSUFFICIENT_PRIVILEGE);
    } finally {
      await app.end();
      await owner.query(`DROP OWNED BY "${role.role}"`).catch(() => {});
      await owner.query(`DROP ROLE IF EXISTS "${role.role}"`).catch(() => {});
    }
  },
);

test(
  "the app role writes every granted table group and nothing else",
  { skip },
  async (t) => {
    const database = await throwawayDatabase(t);
    const owner = await connect(database);
    await applyKithSchema(owner);
    const role = await createAppRole(owner);
    await grantProofAppRole(owner, role.role);

    const url = new URL(database.url);
    url.username = role.role;
    url.password = role.password;
    const app = database.adopt(new pg.Client({ connectionString: url.toString() }));
    await app.connect();

    try {
      // Identity. A user, then the session row logout has to be able to revoke,
      // then the space records `ensurePersonalSpace` creates on first sign-in.
      const userId = newKithId();
      const spaceId = newKithId();
      assert.equal(
        await attempt(app, "INSERT INTO kith.users (id, email) VALUES ($1, $2)", [
          userId,
          "grants@example.test",
        ]),
        null,
      );
      const sessionId = newKithId();
      assert.equal(
        await attempt(
          app,
          `INSERT INTO kith.sessions (id, user_id, token_hash, expires_at, last_used_at)
             VALUES ($1, $2, $3, transaction_timestamp() + interval '1 day',
                     transaction_timestamp())`,
          [sessionId, userId, "a".repeat(64)],
        ),
        null,
      );
      assert.equal(
        await attempt(
          app,
          "UPDATE kith.sessions SET revoked_at = transaction_timestamp() WHERE id = $1",
          [sessionId],
        ),
        null,
      );
      assert.equal(
        await attempt(
          app,
          `INSERT INTO kith.spaces (id, kind, name, created_by)
             VALUES ($1, 'personal', 'Personal', $2)`,
          [spaceId, userId],
        ),
        null,
      );
      assert.equal(
        await attempt(
          app,
          `INSERT INTO kith.space_members (id, space_id, user_id, role)
             VALUES ($1, $2, $3, 'owner')`,
          [newKithId(), spaceId, userId],
        ),
        null,
      );
      assert.equal(
        await attempt(
          app,
          `INSERT INTO kith.user_space_settings (id, user_id, personal_space_id)
             VALUES ($1, $2, $3)`,
          [newKithId(), userId, spaceId],
        ),
        null,
      );
      // The durable auth rate limiter's own table (P2-39i follow-up).
      assert.equal(
        await attempt(
          app,
          `INSERT INTO kith.auth_rate_limits
             (id, scope, key_hash, window_started_at, count)
             VALUES ($1, 'auth_address', repeat('ab', 32), transaction_timestamp(), 1)`,
          [newKithId()],
        ),
        null,
      );

      // Memory.
      const entityId = newKithId();
      assert.equal(
        await attempt(
          app,
          `INSERT INTO kith.entities
             (id, space_id, created_at, user_id, key, kind, canonical_name, normalized_name)
             VALUES ($1, $2, transaction_timestamp(), $3, 'person:ada', 'person', 'Ada', 'ada')`,
          [entityId, spaceId, userId],
        ),
        null,
      );
      assert.equal(
        await attempt(
          app,
          `INSERT INTO kith.facts
             (id, space_id, created_at, user_id, subject_entity_id, predicate, value,
              statement, search_text, source_type, confidence, status)
             VALUES ($1, $2, transaction_timestamp(), $3, $4, 'works_at',
                     '{"text":"here"}'::jsonb, 'Ada works here', 'ada works here',
                     'user_stated', 1, 'current')`,
          [newKithId(), spaceId, userId, entityId],
        ),
        null,
      );

      // Records.
      assert.equal(
        await attempt(
          app,
          `INSERT INTO kith.events (id, space_id, created_at, event_key)
             VALUES ($1, $2, transaction_timestamp(), 'synthetic')`,
          [newKithId(), spaceId],
        ),
        null,
      );

      // Coverage.
      assert.equal(
        await attempt(
          app,
          `INSERT INTO kith.coverage_windows (id, space_id, created_at, record_type, state)
             VALUES ($1, $2, transaction_timestamp(), 'synthetic', 'validated')`,
          [newKithId(), spaceId],
        ),
        null,
      );

      // The admin panel (ADM-1), and with it the change trigger every one of
      // its writes fires. The app role has no INSERT on `kith.changes` and
      // never will: `kith.record_change()` is `SECURITY DEFINER`, so the row
      // below lands through the migration role's rights, not this one's.
      const investmentId = newKithId();
      assert.equal(
        await attempt(
          app,
          `INSERT INTO kith.investments (id, space_id, name)
             VALUES ($1, $2, 'Synthetic Fund I')`,
          [investmentId, spaceId],
        ),
        null,
      );
      assert.equal(
        (
          await app.query(
            `SELECT count(*)::int AS n FROM kith.changes
              WHERE table_name = 'investments' AND row_id = $1`,
            [investmentId],
          )
        ).rows[0].n,
        1,
      );

      // `kith.changes` is its own case, because its privilege set is not the
      // group's: SELECT so the feed route can read it, DELETE so the prune
      // sweep can drain it, and nothing else. An INSERT or UPDATE through the
      // application credential would be a forged or rewritten change row.
      for (const [privilege, expected] of [
        ["SELECT", true],
        ["DELETE", true],
        ["INSERT", false],
        ["UPDATE", false],
      ]) {
        assert.equal(
          (
            await app.query("SELECT has_table_privilege($1, $2) AS granted", [
              "kith.changes",
              privilege,
            ])
          ).rows[0].granted,
          expected,
          `kith.changes: ${privilege}`,
        );
      }
      assert.equal(
        (
          await attempt(
            app,
            `INSERT INTO kith.changes (space_id, table_name, row_id, op)
               VALUES ($1, 'investments', 'forged', 'insert')`,
            [spaceId],
          )
        )?.code,
        INSUFFICIENT_PRIVILEGE,
      );
      assert.equal(
        (await attempt(app, "UPDATE kith.changes SET op = 'delete'"))?.code,
        INSUFFICIENT_PRIVILEGE,
      );
      // But the sweep's own delete still works.
      assert.equal(
        await attempt(app, "DELETE FROM kith.changes WHERE row_id = 'nothing'"),
        null,
      );

      // Every table in every group, including the ones no write above reaches.
      for (const [group, tables] of Object.entries(GRANTED)) {
        for (const table of tables) {
          for (const privilege of ["INSERT", "UPDATE", "DELETE", "SELECT"]) {
            const granted = await app.query(
              "SELECT has_table_privilege($1, $2) AS granted",
              [`kith.${table}`, privilege],
            );
            assert.equal(
              granted.rows[0].granted,
              true,
              `${group}: ${privilege} on kith.${table}`,
            );
          }
        }
      }

      // Every table a worker operation writes, derived from the handlers.
      // This is the assertion the first review of ADM-9 asked for: the worker
      // protocol runs entirely on this credential, and until now most of its
      // tables had no grant and no test that would have said so.
      const workerTables = workerWritePath();
      assert.ok(
        workerTables.length > 20,
        "the worker write path was not derived; the source directory moved",
      );
      for (const table of workerTables) {
        for (const privilege of ["INSERT", "UPDATE", "DELETE", "SELECT"]) {
          assert.equal(
            (
              await app.query("SELECT has_table_privilege($1, $2) AS granted", [
                `kith.${table}`,
                privilege,
              ])
            ).rows[0].granted,
            true,
            `worker write path: ${privilege} on kith.${table}`,
          );
        }
      }

      // One job's whole write path, as the credential that runs it.
      for (const table of EXTRACTION_WRITE_PATH) {
        for (const privilege of ["INSERT", "UPDATE", "DELETE", "SELECT"]) {
          assert.equal(
            (
              await app.query("SELECT has_table_privilege($1, $2) AS granted", [
                `kith.${table}`,
                privilege,
              ])
            ).rows[0].granted,
            true,
            `document_extraction write path: ${privilege} on kith.${table}`,
          );
        }
      }

      // The control. A table deliberately left out of the grant refuses the
      // write at the server, with the code that says it was a privilege and not
      // a constraint.
      for (const table of WITHHELD) {
        const refused = await attempt(
          app,
          `INSERT INTO kith.${table} SELECT * FROM kith.${table} WHERE false`,
        );
        assert.equal(
          refused?.code,
          INSUFFICIENT_PRIVILEGE,
          `kith.${table} must not be writable by the app role`,
        );
        // Reading it is still allowed: the grant narrows writes, not reads.
        assert.equal(
          (
            await app.query("SELECT has_table_privilege($1, 'SELECT') AS granted", [
              `kith.${table}`,
            ])
          ).rows[0].granted,
          true,
        );
      }
    } finally {
      await app.end().catch(() => {});
      // Drop the role's privileges in this database before the role itself,
      // because a role a grant still names cannot be dropped, and this database
      // outlives the statement by one test hook.
      await owner.query(`DROP OWNED BY "${role.role}"`).catch(() => {});
      await owner.query(`DROP ROLE IF EXISTS "${role.role}"`).catch(() => {});
    }
  },
);

test(
  "the change trigger needs no grant on kith.changes at all",
  { skip },
  async (t) => {
    // The operational property migration 023's `SECURITY DEFINER` exists for:
    // applying the schema to a live database must not break a single
    // application write, with no grant step required in between. So this
    // grants the role exactly what a triggered table needs and *nothing* on
    // `kith.changes` beyond the reads and the sweep's delete -- not the grant
    // script, which would hide the point by granting more.
    const database = await throwawayDatabase(t);
    const owner = await connect(database);
    await applyKithSchema(owner);
    const role = await createAppRole(owner);
    const name = new URL(database.url).pathname.slice(1);
    await owner.query(`GRANT CONNECT ON DATABASE "${name}" TO "${role.role}"`);
    await owner.query(`GRANT USAGE ON SCHEMA kith TO "${role.role}"`);
    await owner.query(`GRANT USAGE ON DOMAIN kith.kith_id TO "${role.role}"`);
    await owner.query(
      `GRANT SELECT, INSERT ON kith.users, kith.spaces, kith.investments TO "${role.role}"`,
    );
    await owner.query(`GRANT SELECT, DELETE ON kith.changes TO "${role.role}"`);

    const url = new URL(database.url);
    url.username = role.role;
    url.password = role.password;
    const app = database.adopt(new pg.Client({ connectionString: url.toString() }));
    await app.connect();
    try {
      const userId = newKithId();
      const spaceId = newKithId();
      const investmentId = newKithId();
      await app.query("INSERT INTO kith.users (id, email) VALUES ($1, $2)", [
        userId,
        "definer@example.test",
      ]);
      await app.query(
        `INSERT INTO kith.spaces (id, kind, name, created_by)
           VALUES ($1, 'personal', 'Personal', $2)`,
        [spaceId, userId],
      );
      // The write the whole property is about: it succeeds, and it succeeds
      // *through* the trigger rather than around it.
      assert.equal(
        await attempt(
          app,
          `INSERT INTO kith.investments (id, space_id, name)
             VALUES ($1, $2, 'Synthetic Fund I')`,
          [investmentId, spaceId],
        ),
        null,
      );
      assert.equal(
        (
          await app.query(
            `SELECT count(*)::int AS n FROM kith.changes
              WHERE table_name = 'investments' AND row_id = $1 AND op = 'insert'`,
            [investmentId],
          )
        ).rows[0].n,
        1,
      );

      // And the role still cannot put a row there itself, or rewrite one.
      assert.equal(
        (
          await attempt(
            app,
            `INSERT INTO kith.changes (space_id, table_name, row_id, op)
               VALUES ($1, 'investments', 'forged', 'insert')`,
            [spaceId],
          )
        )?.code,
        INSUFFICIENT_PRIVILEGE,
      );
      assert.equal(
        (await attempt(app, "UPDATE kith.changes SET op = 'delete'"))?.code,
        INSUFFICIENT_PRIVILEGE,
      );

      // Nor call the definer function directly to reach its rights: it takes
      // no arguments and returns `trigger`, so the server refuses outright.
      const direct = await attempt(app, "SELECT kith.record_change()");
      assert.match(String(direct?.message), /trigger/i);
    } finally {
      await app.end().catch(() => {});
      await owner.query(`DROP OWNED BY "${role.role}"`).catch(() => {});
      await owner.query(`DROP ROLE IF EXISTS "${role.role}"`).catch(() => {});
    }
  },
);
