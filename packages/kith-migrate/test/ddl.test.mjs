import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { KITH_MIGRATIONS } from "@repo/kith-store";

import {
  TABLES,
  generateKithMigrateTablesSql,
  allPhysicalTables,
  migration4TableName,
} from "../dist/index.js";

test("the migration file registered with kith-store's runner matches the generator (DDL cannot drift from the mapping)", async () => {
  const checkedIn = await readFile(
    fileURLToPath(
      new URL(
        "../../kith-store/migrations/004_kith_migrate_tables.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  assert.equal(checkedIn, generateKithMigrateTablesSql());
});

test("kith-store's runner has this migration registered as version 4, in step with its own history", () => {
  // Not necessarily the *last* entry: a row that ports a domain on top of this
  // table set (P2-39d at 5, P2-39c at 6, ...) registers its own migration after
  // this one, exactly as this test's original title anticipated ("numbered after
  // its existing ones"). What this row still owns is that its migration is
  // version 4, names the right file, and that the whole recorded history is
  // contiguous from 1, which is what the runner requires.
  const ours = KITH_MIGRATIONS.find((m) => m.version === 4);
  assert.ok(ours, "version 4 must be registered");
  assert.ok(ours.url.pathname.endsWith("004_kith_migrate_tables.sql"));
  assert.deepEqual(
    KITH_MIGRATIONS.map((m) => m.version),
    KITH_MIGRATIONS.map((_, index) => index + 1),
  );
  assert.ok(KITH_MIGRATIONS.length >= 4);
});

test("every table's DDL column list matches id, [space_id], created_at, then the declared columns in order", () => {
  const sql = generateKithMigrateTablesSql();
  for (const t of TABLES) {
    const match = sql.match(
      new RegExp(
        `CREATE TABLE kith\\."${migration4TableName(t.pg)}" \\(\\n([\\s\\S]*?)\\n\\);`,
      ),
    );
    assert.ok(match, `no CREATE TABLE found for ${migration4TableName(t.pg)}`);
    const declared = match[1]
      .split(",\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("UNIQUE"))
      .map((line) => line.match(/^"([^"]+)"/)[1]);
    const expected = [
      "id",
      ...(t.spaceScoped ? ["space_id"] : []),
      "created_at",
      ...t.columns.map((c) => c.pg),
    ];
    assert.deepEqual(declared, expected, `column order mismatch for ${t.pg}`);
  }
});

test("no table declares a column name that collides with id, space_id or created_at", () => {
  for (const t of TABLES) {
    const names = t.columns.map((c) => c.pg);
    assert.equal(names.includes("id"), false, `${t.pg}: column named id`);
    assert.equal(
      names.includes("space_id"),
      false,
      `${t.pg}: column named space_id`,
    );
    assert.equal(
      names.includes("created_at"),
      false,
      `${t.pg}: column named created_at`,
    );
    assert.equal(
      new Set(names).size,
      names.length,
      `${t.pg}: duplicate column name`,
    );
  }
});

test("ref columns only ever point at another declared table", () => {
  const known = new Set(TABLES.map((t) => t.pg));
  for (const t of TABLES) {
    for (const c of t.columns) {
      if (c.kind !== "ref") continue;
      assert.ok(
        known.has(c.refTable),
        `${t.pg}.${c.pg} references unknown table ${c.refTable}`,
      );
    }
    for (const child of t.children ?? []) {
      assert.ok(
        known.has(child.valueRefTable),
        `${child.pg} references unknown table ${child.valueRefTable}`,
      );
    }
  }
});

test("allPhysicalTables lists every parent table and every child join table exactly once", () => {
  const physical = allPhysicalTables();
  const names = physical.map((p) => p.pg);
  assert.equal(new Set(names).size, names.length);
  const expectedCount =
    TABLES.length +
    TABLES.reduce((sum, t) => sum + (t.children?.length ?? 0), 0);
  assert.equal(physical.length, expectedCount);
});
