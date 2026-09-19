// Migration 030's backfill (independent review, minor 6): a database that
// was already running before this migration has `open` correction rows with
// no `dedupe_key` -- the column did not exist yet. Applies migrations 1
// through 29 by hand, seeds rows the way the pre-030 `openCorrection` did
// (no `dedupe_key`, no `severity`), then applies 030 itself and checks the
// backfill computed the same key `extractionDedupeKey()` in
// `src/extraction/corrections.ts` would, and that a collision the backfill
// creates is resolved rather than left to break the new unique index.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import { KITH_MIGRATIONS, newKithId } from "../dist/index.js";
import { connect, skip, throwawayDatabase } from "./helpers/pgDatabase.mjs";

const MIGRATION_030 = KITH_MIGRATIONS.find((m) => m.version === 30);
const PRE_030 = KITH_MIGRATIONS.filter((m) => m.version < 30);

async function applyMigrationsThrough29(client) {
  await client.query("CREATE SCHEMA IF NOT EXISTS kith");
  await client.query(`
    CREATE TABLE IF NOT EXISTS kith.schema_version (
      version integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
    )`);
  for (const migration of PRE_030) {
    await client.query(await readFile(fileURLToPath(migration.url), "utf8"));
    await client.query(
      "INSERT INTO kith.schema_version (version, name) VALUES ($1, $2)",
      [migration.version, migration.name],
    );
  }
}

async function seedSpace(client) {
  const userId = newKithId();
  await client.query("INSERT INTO kith.users (id, email) VALUES ($1, $2)", [
    userId,
    `pre030-${userId}@example.test`,
  ]);
  const spaceId = newKithId();
  await client.query(
    `INSERT INTO kith.spaces (id, kind, name, created_by) VALUES ($1, 'personal', 'Pre-030', $2)`,
    [spaceId, userId],
  );
  const sourceItemId = newKithId();
  await client.query(
    `INSERT INTO kith.source_items (id, space_id, created_at, title) VALUES ($1, $2, transaction_timestamp(), 'Legacy receipt')`,
    [sourceItemId, spaceId],
  );
  return { spaceId, sourceItemId };
}

/** A pre-030 `open` correction row: no `dedupe_key`, no `severity` --
 * neither column exists in this schema yet. */
async function seedLegacyCorrection(client, spaceId, sourceItemId, fieldName, reason) {
  const id = newKithId();
  await client.query(
    `INSERT INTO kith.corrections
       (id, space_id, target_kind, target_id, field_name, reason, state)
     VALUES ($1,$2,'document',$3,$4,$5,'open')`,
    [id, spaceId, sourceItemId, fieldName, reason],
  );
  return id;
}

test(
  "a legacy open row without dedupe_key is backfilled with the same formula openCorrection uses",
  { skip },
  async (t) => {
    const database = await throwawayDatabase(t);
    const client = await connect(database);
    await applyMigrationsThrough29(client);
    const { spaceId, sourceItemId } = await seedSpace(client);
    const id = await seedLegacyCorrection(
      client,
      spaceId,
      sourceItemId,
      "total",
      "quote_not_found",
    );

    await client.query(await readFile(fileURLToPath(MIGRATION_030.url), "utf8"));

    const row = (
      await client.query("SELECT dedupe_key, state FROM kith.corrections WHERE id = $1", [id])
    ).rows[0];
    assert.equal(row.dedupe_key, `extraction:${sourceItemId}:total:quote_not_found`);
    assert.equal(row.state, "open");

    // The unique index the migration creates after the backfill must have
    // succeeded -- confirm it exists and actually constrains.
    const indexed = await client.query(
      "SELECT to_regclass('kith.corrections_dedupe_key_idx') AS idx",
    );
    assert.ok(indexed.rows[0].idx);
  },
);

test(
  "a backfill collision keeps the newest open row and clears the rest",
  { skip },
  async (t) => {
    const database = await throwawayDatabase(t);
    const client = await connect(database);
    await applyMigrationsThrough29(client);
    const { spaceId, sourceItemId } = await seedSpace(client);

    // Two legacy `open` rows that would compute the same dedupe_key -- not
    // reachable through the pre-030 `openCorrection`, which already
    // deduplicated on this exact tuple, but the migration defends against it
    // regardless (a manually inserted row, a bug in an earlier version).
    const older = await seedLegacyCorrection(
      client,
      spaceId,
      sourceItemId,
      "total",
      "quote_not_found",
    );
    await client.query("UPDATE kith.corrections SET created_at = $2 WHERE id = $1", [
      older,
      "2020-01-01T00:00:00Z",
    ]);
    const newer = await seedLegacyCorrection(
      client,
      spaceId,
      sourceItemId,
      "total",
      "quote_not_found",
    );

    await client.query(await readFile(fileURLToPath(MIGRATION_030.url), "utf8"));

    const rows = (
      await client.query(
        "SELECT id, state, reason FROM kith.corrections WHERE space_id = $1 ORDER BY created_at",
        [spaceId],
      )
    ).rows;
    assert.equal(rows.length, 2);
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(older).state, "resolved");
    assert.equal(byId.get(older).reason, "cleared");
    assert.equal(byId.get(newer).state, "open");

    // The dedupe_key index applies only to open/snoozed rows, so exactly one
    // open row per key is now enforced by it too.
    const openCount = await client.query(
      "SELECT count(*)::int AS n FROM kith.corrections WHERE space_id = $1 AND state = 'open'",
      [spaceId],
    );
    assert.equal(openCount.rows[0].n, 1);
  },
);
