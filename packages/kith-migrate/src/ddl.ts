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

// Every id, space_id and reference column uses `@repo/kith-store`'s
// `kith.kith_id` domain (migration 003) rather than a bare `text`: the same
// preserved-text convention, its length and character-class CHECK, and its
// generator (`newKithId`) all come from that package now, not restated here.
const PG_KIND: Record<string, string> = {
  ref: "kith.kith_id",
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
 * The name migration 4 creates a table under, which is not always the name the
 * table ends up with.
 *
 * Migration 1 held `kith.spaces` and `kith.api_keys` as `uuid`-keyed prototype
 * tables, so migration 4 had to create the Convex-mapped pair as `brain_spaces`
 * and `brain_api_keys` to get past them. Migration 6 (P2-39c) retires the
 * prototype's claim on those two names -- its tables become `proof_spaces` and
 * `proof_api_keys` -- and renames these to the plain ones, because the plan's
 * convention is that a kith table is keyed by the preserved Convex id.
 *
 * The mapping lives here rather than in `TABLES` so exactly one thing is true of
 * `TableSpec.pg`: it is the name the table has once the schema is fully migrated.
 * That is the name the transform, the COPY loader and the parity harness need,
 * because they run against a fully migrated database. Only this generator needs
 * the interim name, and only so migration 4's committed bytes do not change.
 *
 * `documents`, `source_revisions` and `chunks` are still prefixed in `TABLES`
 * itself: P2-39d retires the prototype's claim on those three.
 */
const MIGRATION_4_NAME: Record<string, string> = {
  spaces: "brain_spaces",
  api_keys: "brain_api_keys",
};

/** The name migration 4 creates `pg` under. Usually `pg` itself. */
export function migration4TableName(pg: string): string {
  return MIGRATION_4_NAME[pg] ?? pg;
}

/**
 * Generates the table-and-foreign-key SQL body for `TABLES`, the same
 * declarative mapping `transform.ts` reads, so the DDL and the transform
 * cannot drift (this row's acceptance requirement, plan section 3 step 3).
 *
 * This is table content only: no `CREATE SCHEMA`, no version-tracking table,
 * and no recorded-version insert. `@repo/kith-store`'s `applyKithSchema`
 * already creates the `kith` schema and `kith.schema_version`, runs each
 * migration file (this one included, registered as
 * `packages/kith-store/migrations/004_kith_migrate_tables.sql`) inside its
 * own transaction, and records the version itself — restating any of that
 * here would be two places for the schema bootstrap to drift.
 *
 * Tables are created first with only their own columns, primary key, and
 * (for space-scoped tables) `UNIQUE (id, space_id)`; every foreign key is
 * added afterward as `DEFERRABLE INITIALLY DEFERRED`, in a second pass, so
 * forward references, self-references, and load-time deferred-constraint
 * checking (plan section 3 step 4) all work without topological sorting.
 *
 * Five names collide with tables `packages/kith-store/migrations/001_init.sql`
 * and `002_worker_jobs.sql` already created for its own synthetic proof
 * harness (`spaces`, `api_keys`, `documents`, `source_revisions`, `chunks`):
 * those prototype tables are `uuid`-keyed and are exercised by kith-store's
 * own passing test suite (`validation.test.mjs`, the `postgres-proof`
 * integration test) using real hyphenated `randomUUID()` values, which the
 * `kith.kith_id` domain's character class refuses outright. Retyping them
 * would be real, invasive surgery on another row's already-merged, tested
 * schema, and the plan already assigns the real port of these five domains
 * to P2-39c (`spaces`, `api_keys`) and P2-39d (`documents`, `source_revisions`,
 * `chunks`) as part of their much larger scoped work. The prototype's bare
 * names win for now; this row's Convex-mapped versions of the same five
 * domains land under a `brain_` prefix (`kith.brain_spaces`, and so on) so
 * the full 70-table pipeline still proves out end-to-end without touching or
 * risking kith-store's tested schema. Two of those five are settled by
 * migration 6 (P2-39c), which renames the prototype's pair to `proof_spaces` and
 * `proof_api_keys` and promotes `brain_spaces` and `brain_api_keys` to the plain
 * names, so `TABLES` now carries the plain names for those two and
 * `migration4TableName` above holds the interim ones this file still emits.
 * `documents`, `source_revisions` and `chunks` stay prefixed for P2-39d.
 */
export function generateKithMigrateTablesSql(): string {
  const scoped = spaceScopedByPgName();
  const statements: string[] = [];

  for (const t of TABLES) {
    const lines: string[] = [`  ${q("id")} kith.kith_id PRIMARY KEY`];
    if (t.spaceScoped) lines.push(`  ${q("space_id")} kith.kith_id NOT NULL`);
    lines.push(`  ${q("created_at")} timestamptz NOT NULL`);
    for (const c of t.columns) {
      // Columns a later kith-store migration added are not migration 004's.
      if (c.addedIn !== undefined) continue;
      lines.push(`  ${q(c.pg)} ${PG_KIND[c.kind]}`);
    }
    if (t.spaceScoped) {
      lines.push(`  UNIQUE (${q("id")}, ${q("space_id")})`);
    }
    statements.push(
      "",
      `CREATE TABLE kith.${q(migration4TableName(t.pg))} (`,
      lines.join(",\n"),
      ");",
    );

    for (const child of t.children ?? []) {
      statements.push(
        "",
        `CREATE TABLE kith.${q(child.pg)} (`,
        [
          `  ${q("id")} kith.kith_id PRIMARY KEY`,
          `  ${q(child.parentColumn)} kith.kith_id NOT NULL`,
          `  ${q(child.valueColumn)} kith.kith_id NOT NULL`,
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
      // Columns a later kith-store migration added are not migration 004's.
      if (c.addedIn !== undefined) continue;
      if (c.kind !== "ref" || !c.refTable) continue;
      const targetScoped = scoped.get(c.refTable) ?? false;
      const name = constraintName(`${migration4TableName(t.pg)}_${c.pg}_fkey`);
      if (targetScoped && t.spaceScoped) {
        statements.push(
          "",
          `ALTER TABLE kith.${q(migration4TableName(t.pg))} ADD CONSTRAINT ${q(name)}`,
          `  FOREIGN KEY (${q(c.pg)}, ${q("space_id")}) REFERENCES kith.${q(migration4TableName(c.refTable))} (${q("id")}, ${q("space_id")})`,
          "  DEFERRABLE INITIALLY DEFERRED;",
        );
      } else {
        statements.push(
          "",
          `ALTER TABLE kith.${q(migration4TableName(t.pg))} ADD CONSTRAINT ${q(name)}`,
          `  FOREIGN KEY (${q(c.pg)}) REFERENCES kith.${q(migration4TableName(c.refTable))} (${q("id")})`,
          "  DEFERRABLE INITIALLY DEFERRED;",
        );
      }
    }
    for (const child of t.children ?? []) {
      statements.push(
        "",
        `ALTER TABLE kith.${q(child.pg)} ADD CONSTRAINT ${q(`${child.pg}_parent_fkey`)}`,
        `  FOREIGN KEY (${q(child.parentColumn)}) REFERENCES kith.${q(migration4TableName(t.pg))} (${q("id")})`,
        "  DEFERRABLE INITIALLY DEFERRED;",
        "",
        `ALTER TABLE kith.${q(child.pg)} ADD CONSTRAINT ${q(`${child.pg}_value_fkey`)}`,
        `  FOREIGN KEY (${q(child.valueColumn)}) REFERENCES kith.${q(migration4TableName(child.valueRefTable))} (${q("id")})`,
        "  DEFERRABLE INITIALLY DEFERRED;",
      );
    }
  }

  statements.push("");
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
