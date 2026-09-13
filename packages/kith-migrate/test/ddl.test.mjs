import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { TABLES, generateMigrationSql, allPhysicalTables } from "../dist/index.js";

test("the checked-in migration file matches the generator (DDL cannot drift from the mapping)", async () => {
  const checkedIn = await readFile(
    fileURLToPath(new URL("../migrations/0001_kith_schema.sql", import.meta.url)),
    "utf8",
  );
  assert.equal(checkedIn, generateMigrationSql());
});

test("every table's DDL column list matches id, [space_id], created_at, then the declared columns in order", () => {
  const sql = generateMigrationSql();
  for (const t of TABLES) {
    const match = sql.match(
      new RegExp(`CREATE TABLE kith\\."${t.pg}" \\(\\n([\\s\\S]*?)\\n\\);`),
    );
    assert.ok(match, `no CREATE TABLE found for ${t.pg}`);
    const declared = match[1]
      .split(",\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("UNIQUE"))
      .map((line) => line.match(/^"([^"]+)"/)[1]);
    const expected = ["id", ...(t.spaceScoped ? ["space_id"] : []), "created_at", ...t.columns.map((c) => c.pg)];
    assert.deepEqual(declared, expected, `column order mismatch for ${t.pg}`);
  }
});

test("no table declares a column name that collides with id, space_id or created_at", () => {
  for (const t of TABLES) {
    const names = t.columns.map((c) => c.pg);
    assert.equal(names.includes("id"), false, `${t.pg}: column named id`);
    assert.equal(names.includes("space_id"), false, `${t.pg}: column named space_id`);
    assert.equal(names.includes("created_at"), false, `${t.pg}: column named created_at`);
    assert.equal(new Set(names).size, names.length, `${t.pg}: duplicate column name`);
  }
});

test("ref columns only ever point at another declared table", () => {
  const known = new Set(TABLES.map((t) => t.pg));
  for (const t of TABLES) {
    for (const c of t.columns) {
      if (c.kind !== "ref") continue;
      assert.ok(known.has(c.refTable), `${t.pg}.${c.pg} references unknown table ${c.refTable}`);
    }
    for (const child of t.children ?? []) {
      assert.ok(known.has(child.valueRefTable), `${child.pg} references unknown table ${child.valueRefTable}`);
    }
  }
});

test("allPhysicalTables lists every parent table and every child join table exactly once", () => {
  const physical = allPhysicalTables();
  const names = physical.map((p) => p.pg);
  assert.equal(new Set(names).size, names.length);
  const expectedCount =
    TABLES.length + TABLES.reduce((sum, t) => sum + (t.children?.length ?? 0), 0);
  assert.equal(physical.length, expectedCount);
});
