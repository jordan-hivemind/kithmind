import { createHash } from "node:crypto";

import { TABLES, type TableSpec } from "./schema.js";

// Postgres truncates identifiers at 63 bytes. Two distinct long constraint
// names that happen to share their first 63 characters would otherwise
// collide silently; a short content hash keeps every truncated name unique
// without requiring anyone to hand-shorten one.
function constraintName(name: string): string {
  if (Buffer.byteLength(name, "utf8") <= 63) return name;
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, 54)}_${hash}`;
}

const PG_KIND: Record<string, string> = {
  ref: "text",
  text: "text",
  number: "numeric",
  boolean: "boolean",
  jsonb: "jsonb",
  timestamp: "timestamptz",
};

function q(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function spaceScopedByPgName(): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const t of TABLES) map.set(t.pg, t.spaceScoped);
  return map;
}

/**
 * Generates the `kith` schema migration SQL from `TABLES`, the same
 * declarative mapping `transform.ts` reads, so the DDL and the transform
 * cannot drift (this row's acceptance requirement, plan section 3 step 3).
 *
 * Tables are created first with only their own columns, primary key, and
 * (for space-scoped tables) `UNIQUE (id, space_id)`; every foreign key is
 * added afterward as `DEFERRABLE INITIALLY DEFERRED`, in a second pass, so
 * forward references, self-references, and load-time deferred-constraint
 * checking (plan section 3 step 4) all work without topological sorting.
 */
export function generateMigrationSql(): string {
  const scoped = spaceScopedByPgName();
  const statements: string[] = [
    "CREATE SCHEMA IF NOT EXISTS kith;",
    "",
    "CREATE TABLE kith.schema_migrations (",
    "  version integer PRIMARY KEY,",
    "  applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()",
    ");",
  ];

  for (const t of TABLES) {
    const lines: string[] = [`  ${q("id")} text PRIMARY KEY`];
    if (t.spaceScoped) lines.push(`  ${q("space_id")} text NOT NULL`);
    lines.push(`  ${q("created_at")} timestamptz NOT NULL`);
    for (const c of t.columns) {
      lines.push(`  ${q(c.pg)} ${PG_KIND[c.kind]}`);
    }
    if (t.spaceScoped) {
      lines.push(`  UNIQUE (${q("id")}, ${q("space_id")})`);
    }
    statements.push(
      "",
      `CREATE TABLE kith.${q(t.pg)} (`,
      lines.join(",\n"),
      ");",
    );

    for (const child of t.children ?? []) {
      statements.push(
        "",
        `CREATE TABLE kith.${q(child.pg)} (`,
        [
          `  ${q("id")} text PRIMARY KEY`,
          `  ${q(child.parentColumn)} text NOT NULL`,
          `  ${q(child.valueColumn)} text NOT NULL`,
          `  UNIQUE (${q(child.parentColumn)}, ${q(child.valueColumn)})`,
        ].join(",\n"),
        ");",
      );
    }
  }

  // Second pass: foreign keys, all deferrable so the COPY loader (plan
  // section 3 step 4) can load every table before any reference is checked.
  for (const t of TABLES) {
    for (const c of t.columns) {
      if (c.kind !== "ref" || !c.refTable) continue;
      const targetScoped = scoped.get(c.refTable) ?? false;
      const name = constraintName(`${t.pg}_${c.pg}_fkey`);
      if (targetScoped && t.spaceScoped) {
        statements.push(
          "",
          `ALTER TABLE kith.${q(t.pg)} ADD CONSTRAINT ${q(name)}`,
          `  FOREIGN KEY (${q(c.pg)}, ${q("space_id")}) REFERENCES kith.${q(c.refTable)} (${q("id")}, ${q("space_id")})`,
          "  DEFERRABLE INITIALLY DEFERRED;",
        );
      } else {
        statements.push(
          "",
          `ALTER TABLE kith.${q(t.pg)} ADD CONSTRAINT ${q(name)}`,
          `  FOREIGN KEY (${q(c.pg)}) REFERENCES kith.${q(c.refTable)} (${q("id")})`,
          "  DEFERRABLE INITIALLY DEFERRED;",
        );
      }
    }
    for (const child of t.children ?? []) {
      statements.push(
        "",
        `ALTER TABLE kith.${q(child.pg)} ADD CONSTRAINT ${q(`${child.pg}_parent_fkey`)}`,
        `  FOREIGN KEY (${q(child.parentColumn)}) REFERENCES kith.${q(t.pg)} (${q("id")})`,
        "  DEFERRABLE INITIALLY DEFERRED;",
        "",
        `ALTER TABLE kith.${q(child.pg)} ADD CONSTRAINT ${q(`${child.pg}_value_fkey`)}`,
        `  FOREIGN KEY (${q(child.valueColumn)}) REFERENCES kith.${q(child.valueRefTable)} (${q("id")})`,
        "  DEFERRABLE INITIALLY DEFERRED;",
      );
    }
  }

  statements.push(
    "",
    "INSERT INTO kith.schema_migrations(version) VALUES (1);",
    "",
  );
  return statements.join("\n");
}

/** Every physical table this migration creates, in creation order, parent
 * tables followed by their children. Used by the loader to build the COPY
 * column list and by the parity harness to enumerate what to check. */
export function allPhysicalTables(): {
  pg: string;
  spec: TableSpec;
  isChild: boolean;
}[] {
  const out: { pg: string; spec: TableSpec; isChild: boolean }[] = [];
  for (const t of TABLES) {
    out.push({ pg: t.pg, spec: t, isChild: false });
    for (const child of t.children ?? []) {
      out.push({ pg: child.pg, spec: t, isChild: true });
    }
  }
  return out;
}
