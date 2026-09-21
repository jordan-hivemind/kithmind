import { execFile } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { applyKithSchema } from "@repo/kith-store";
import pg from "pg";

import { childColumnOrder, columnOrder } from "./columns.js";
import { currentPgName, TABLES } from "./schema.js";

const execFileAsync = promisify(execFile);

/**
 * Plan section 3, the new step between Transform (step 3) and Load (step 4):
 * an audit that loads the transformed rows into the isolated destination's
 * own shape -- without the destination's `CHECK`, foreign key, `UNIQUE` and
 * `NOT NULL` constraints attached -- and then asks Postgres itself, via its
 * own catalog, which rows would fail each of those constraints. `--strict`
 * load (step 4) still exists and still aborts on the first violation, at an
 * `ALTER TABLE` or a deferred-constraint `COMMIT`; this step exists so an
 * operator sees every violation, named by table, row id and constraint, in
 * one pass before that, rather than fixing one legacy row at a time by
 * repeatedly rerunning the strict load. See the "Step 3.5" section of
 * docs/plans/2026-09-12-postgres-consolidation.md for why it is its own step
 * rather than a mode of step 4.
 *
 * This module never re-encodes a `CHECK` expression, an enum list or a hash
 * pattern in TypeScript. Every constraint it reports is read back from
 * `pg_constraint`/`pg_index` on the real, fully migrated `kith` schema
 * (`@repo/kith-store`'s own `applyKithSchema`, the same runner `load.ts`
 * uses) and re-evaluated by Postgres against the staged data with a plain
 * `SELECT ... WHERE NOT (<the stored expression>)`. A second, hand-maintained
 * copy of the schema's rules would drift from the SQL the moment either one
 * changed; asking the database is what keeps this audit exactly as current
 * as whatever migration last landed, including one this file was never
 * updated for.
 */

/** A schema of the audit's own, never `kith`: the staged copies of the
 * transformed CSVs carry no constraint of their own, so a bad row can be
 * inserted and then reported on rather than aborting the whole load. */
const AUDIT_SCHEMA = "kith_migrate_audit";

export type ConstraintKind =
  "not_null" | "domain_check" | "check" | "foreign_key" | "unique";

export type ConstraintViolation = {
  table: string;
  id: string;
  constraint: string;
  kind: ConstraintKind;
  /** The offending column(s) and value(s), or a short description of the
   * failure when the constraint's expression does not resolve to specific
   * columns (rare: see `stripCheckWrapper`'s callers). */
  detail: string;
};

export type SkippedConstraint = {
  table: string;
  constraint: string;
  kind: ConstraintKind;
  reason: string;
};

export type AuditReport = {
  /** Row count staged per table this audit actually checked (own data
   * tables only; a table referenced only as a foreign key target, with no
   * CSV of its own, is not a key of this map). */
  rowsAudited: Record<string, number>;
  violations: ConstraintViolation[];
  /** A constraint this audit could not evaluate, and why -- for example, a
   * `CHECK` that reaches a column outside the set `transform.ts` maps (plan
   * section 3's transform only ever produces the columns it declares, so a
   * constraint reaching further is not something a legacy row can violate
   * through this pipeline). Never silent: every entry here is also why the
   * corresponding constraint is absent from `violations`. */
  skipped: SkippedConstraint[];
  /** True only when `violations` is empty. `skipped` does not affect this:
   * an unauditable constraint is a gap to report, not a passing check. */
  ok: boolean;
};

export type AuditConfig = {
  /** A `postgres://` URL for an isolated destination database. Never the
   * live archive database -- same rule as `load.ts`'s `DestinationConfig`. */
  connectionString: string;
};

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strips the `CHECK (...)` (or domain `CHECK (...)`) wrapper
 * `pg_get_constraintdef` returns, leaving a boolean expression this module
 * can drop straight into a `WHERE NOT (...)`. The outermost parenthesis pair
 * is always the last character of the definition, so a greedy match to the
 * final `)` is exactly the matching close for the one after `CHECK`. */
function stripCheckWrapper(def: string): string {
  const match = /^CHECK\s*\((.*)\)$/s.exec(def.trim());
  if (!match) throw new Error(`unrecognized_check_definition:${def}`);
  return match[1]!;
}

type ColumnInfo = {
  pgType: string;
  isNullable: boolean;
  domainName: string | null;
};

async function fetchColumnInfo(
  client: pg.ClientBase,
  table: string,
  columns: string[],
): Promise<Map<string, ColumnInfo>> {
  const result = await client.query<{
    column_name: string;
    data_type: string;
    domain_name: string | null;
    is_nullable: string;
  }>(
    `SELECT column_name, data_type, domain_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'kith' AND table_name = $1 AND column_name = ANY($2::text[])`,
    [table, columns],
  );
  const map = new Map<string, ColumnInfo>();
  for (const row of result.rows) {
    map.set(row.column_name, {
      pgType: row.data_type,
      isNullable: row.is_nullable === "YES",
      domainName: row.domain_name,
    });
  }
  return map;
}

/** Every domain declared under `kith` and its own `CHECK`, keyed by domain
 * name (`kith_id` today; any later domain migration 018+ adds is picked up
 * the same way, with no change here). */
async function fetchDomainChecks(
  client: pg.ClientBase,
): Promise<Map<string, string>> {
  const result = await client.query<{ domain_name: string; def: string }>(
    `SELECT dt.typname AS domain_name, pg_get_constraintdef(c.oid) AS def
       FROM pg_type dt
       JOIN pg_constraint c ON c.contypid = dt.oid
      WHERE dt.typtype = 'd' AND dt.typnamespace = 'kith'::regnamespace`,
  );
  const map = new Map<string, string>();
  for (const row of result.rows)
    map.set(row.domain_name, stripCheckWrapper(row.def));
  return map;
}

type CheckConstraint = { name: string; expr: string };

async function fetchCheckConstraints(
  client: pg.ClientBase,
  table: string,
): Promise<CheckConstraint[]> {
  const result = await client.query<{ conname: string; def: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = $1::regclass AND contype = 'c'`,
    [`kith.${table}`],
  );
  return result.rows.map((row) => ({
    name: row.conname,
    expr: stripCheckWrapper(row.def),
  }));
}

type ForeignKeyConstraint = {
  name: string;
  localColumns: string[];
  foreignTable: string;
  foreignColumns: string[];
};

/** Reads the exact column pairing from `pg_constraint`'s `conkey`/`confkey`
 * rather than parsing `pg_get_constraintdef`'s text, so a composite
 * `(col, space_id)` reference is never misread as two separate ones. */
async function fetchForeignKeys(
  client: pg.ClientBase,
  table: string,
): Promise<ForeignKeyConstraint[]> {
  const result = await client.query<{
    conname: string;
    local_columns: string[];
    foreign_table: string;
    foreign_columns: string[];
  }>(
    `SELECT c.conname,
        (SELECT array_agg(a.attname::text ORDER BY u.ord)
           FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
        ) AS local_columns,
        confrel.relname AS foreign_table,
        (SELECT array_agg(a.attname::text ORDER BY u.ord)
           FROM unnest(c.confkey) WITH ORDINALITY AS u(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = u.attnum
        ) AS foreign_columns
       FROM pg_constraint c
       JOIN pg_class confrel ON confrel.oid = c.confrelid
      WHERE c.conrelid = $1::regclass AND c.contype = 'f'
      ORDER BY c.conname`,
    [`kith.${table}`],
  );
  return result.rows.map((row) => ({
    name: row.conname,
    localColumns: row.local_columns,
    foreignTable: row.foreign_table,
    foreignColumns: row.foreign_columns,
  }));
}

type UniqueIndex = {
  name: string;
  columns: string[];
  predicate: string | null;
};

/** Every unique index on the table, whether it backs a named `UNIQUE`/
 * `PRIMARY KEY` constraint or was created bare (this schema uses both --
 * see the module comment in `docs/plans/2026-09-12-postgres-consolidation.md`'s
 * migration notes). A single catalog query covers both, so nothing here
 * needs to know which style a given migration chose. Expression indexes are
 * skipped (`indexprs IS NULL`): none exist on a kith-migrate table today, and
 * one would need its own expression evaluated per row rather than a plain
 * column list, which this generic path does not attempt. */
async function fetchUniqueIndexes(
  client: pg.ClientBase,
  table: string,
): Promise<UniqueIndex[]> {
  const result = await client.query<{
    name: string;
    columns: string[] | null;
    predicate: string | null;
  }>(
    `SELECT ic.relname AS name,
        (SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
        ) AS columns,
        CASE WHEN i.indpred IS NOT NULL THEN pg_get_expr(i.indpred, i.indrelid) END AS predicate
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = $1::regclass AND i.indisunique AND i.indexprs IS NULL`,
    [`kith.${table}`],
  );
  return result.rows
    .filter(
      (
        row,
      ): row is { name: string; columns: string[]; predicate: string | null } =>
        Array.isArray(row.columns),
    )
    .map((row) => ({
      name: row.name,
      columns: row.columns,
      predicate: row.predicate,
    }));
}

type AuditTable = {
  /** The live, current table name (`currentPgName(t.pg)` for a parent,
   * `child.pg` for a child -- never renamed by a later migration). */
  name: string;
  /** The CSV `transform.ts` wrote it under, or `null` for a table staged
   * only as an empty foreign-key target shell. */
  csvFile: string | null;
  /** Column names in the CSV's own column order (`columnOrder`/
   * `childColumnOrder`), or `["id", "space_id"]` for a shell. */
  columns: string[];
};

function collectDataTables(presentFiles: Set<string>): Map<string, AuditTable> {
  const tables = new Map<string, AuditTable>();
  for (const t of TABLES) {
    if (t.migrated && presentFiles.has(`${t.pg}.csv`)) {
      const name = currentPgName(t.pg);
      tables.set(name, {
        name,
        csvFile: `${t.pg}.csv`,
        columns: columnOrder(t),
      });
    }
    for (const child of t.children ?? []) {
      if (!presentFiles.has(`${child.pg}.csv`)) continue;
      tables.set(child.pg, {
        name: child.pg,
        csvFile: `${child.pg}.csv`,
        columns: childColumnOrder(child),
      });
    }
  }
  return tables;
}

function buildCreateTableSql(
  table: string,
  columns: string[],
  types: Map<string, ColumnInfo>,
): string {
  const colDefs = columns.map(
    (col) => `${quote(col)} ${types.get(col)?.pgType ?? "text"}`,
  );
  return `CREATE TABLE ${quote(AUDIT_SCHEMA)}.${quote(table)} (${colDefs.join(", ")})`;
}

function buildAuditCopyScript(
  csvDir: string,
  tables: Iterable<AuditTable>,
): { script: string; hasRows: boolean } {
  const lines = ["BEGIN;"];
  let hasRows = false;
  for (const t of tables) {
    if (!t.csvFile) continue;
    hasRows = true;
    const cols = t.columns.map(quote).join(", ");
    const path = join(csvDir, t.csvFile).replaceAll("'", "''");
    lines.push(
      `\\copy ${quote(AUDIT_SCHEMA)}.${quote(t.name)} (${cols}) FROM '${path}' WITH (FORMAT csv)`,
    );
  }
  lines.push("COMMIT;");
  return { script: lines.join("\n"), hasRows };
}

async function copyCsvIntoStaging(
  connectionString: string,
  csvDir: string,
  tables: Iterable<AuditTable>,
): Promise<void> {
  const { script, hasRows } = buildAuditCopyScript(csvDir, tables);
  if (!hasRows) return;
  const scriptDir = await mkdtemp(join(tmpdir(), "kith-audit-"));
  const scriptPath = join(scriptDir, "stage.sql");
  await writeFile(scriptPath, script);
  await execFileAsync("psql", [
    connectionString,
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    scriptPath,
  ]);
}

function describeColumns(
  row: Record<string, unknown>,
  columns: string[],
): string {
  if (!columns.length) return "(constraint reaches no single mapped column)";
  return columns
    .map((c) => `${c}=${JSON.stringify(row[c] ?? null)}`)
    .join(", ");
}

/**
 * Loads `csvDir` (as `transformExport` wrote it) into an unconstrained
 * mirror of the isolated destination's shape, then asks Postgres which
 * staged rows would fail each `NOT NULL`, domain, `CHECK`, foreign key and
 * `UNIQUE` constraint the real `kith` schema declares -- every violation,
 * not the first. Never writes a row into the destination's own `kith.*`
 * tables: only this function's own `kith_migrate_audit` schema, dropped
 * before it returns either way. `config.connectionString` must be an
 * isolated or throwaway destination, exactly as `load.ts` requires; this
 * function applies the full `kith` schema there (needed to read its
 * constraints) but never loads a row into it.
 */
export async function auditCsvDirectory(
  config: AuditConfig,
  csvDir: string,
): Promise<AuditReport> {
  const presentFiles = new Set(await readdir(csvDir));
  const violations: ConstraintViolation[] = [];
  const skipped: SkippedConstraint[] = [];
  const rowsAudited: Record<string, number> = {};

  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: 2,
  });
  pool.on("error", () => {
    // A connection torn down after `client.release()` (or by the server)
    // must not become an unhandled rejection under this function's control.
  });
  try {
    const client = await pool.connect();
    try {
      await applyKithSchema(client);

      const dataTables = collectDataTables(presentFiles);

      const fksByTable = new Map<string, ForeignKeyConstraint[]>();
      for (const name of dataTables.keys()) {
        fksByTable.set(name, await fetchForeignKeys(client, name));
      }

      const shellTables = new Map<string, AuditTable>();
      for (const fks of fksByTable.values()) {
        for (const fk of fks) {
          if (
            dataTables.has(fk.foreignTable) ||
            shellTables.has(fk.foreignTable)
          )
            continue;
          shellTables.set(fk.foreignTable, {
            name: fk.foreignTable,
            csvFile: null,
            columns: ["id", "space_id"],
          });
        }
      }

      const allTables = new Map<string, AuditTable>([
        ...dataTables,
        ...shellTables,
      ]);

      await client.query(
        `DROP SCHEMA IF EXISTS ${quote(AUDIT_SCHEMA)} CASCADE`,
      );
      await client.query(`CREATE SCHEMA ${quote(AUDIT_SCHEMA)}`);

      const columnTypesByTable = new Map<string, Map<string, ColumnInfo>>();
      for (const [name, table] of allTables) {
        const types =
          table.csvFile === null
            ? new Map(
                table.columns.map((c): [string, ColumnInfo] => [
                  c,
                  { pgType: "text", isNullable: true, domainName: null },
                ]),
              )
            : await fetchColumnInfo(client, name, table.columns);
        columnTypesByTable.set(name, types);
        await client.query(buildCreateTableSql(name, table.columns, types));
      }

      await copyCsvIntoStaging(
        config.connectionString,
        csvDir,
        dataTables.values(),
      );

      const domainChecks = await fetchDomainChecks(client);

      for (const [name, table] of dataTables) {
        const countResult = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${quote(AUDIT_SCHEMA)}.${quote(name)}`,
        );
        rowsAudited[name] = countResult.rows[0]?.n ?? 0;
        const types = columnTypesByTable.get(name)!;

        // NOT NULL: every column the real schema requires, checked against
        // the staged (unconstrained) copy of the same rows.
        for (const col of table.columns) {
          const info = types.get(col);
          if (!info || info.isNullable) continue;
          const rows = await client.query<{ id: string }>(
            `SELECT id FROM ${quote(AUDIT_SCHEMA)}.${quote(name)} WHERE ${quote(col)} IS NULL`,
          );
          for (const row of rows.rows) {
            violations.push({
              table: name,
              id: row.id,
              constraint: `${name}_${col}_not_null`,
              kind: "not_null",
              detail: `${col} is NULL`,
            });
          }
        }

        // The `kith.kith_id` domain (and any later domain) on every column
        // typed to it: id, space_id, and every `ref` column.
        for (const col of table.columns) {
          const info = types.get(col);
          const domainExpr = info?.domainName
            ? domainChecks.get(info.domainName)
            : undefined;
          if (!info?.domainName || !domainExpr) continue;
          const expr = domainExpr.replaceAll(/\bVALUE\b/g, quote(col));
          const rows = await client.query<
            Record<string, unknown> & { id: string }
          >(
            `SELECT id, ${quote(col)} FROM ${quote(AUDIT_SCHEMA)}.${quote(name)}
              WHERE ${quote(col)} IS NOT NULL AND NOT (${expr})`,
          );
          for (const row of rows.rows) {
            violations.push({
              table: name,
              id: row.id,
              constraint: `${info.domainName}_check(${col})`,
              kind: "domain_check",
              detail: describeColumns(row, [col]),
            });
          }
        }

        // Table CHECK constraints, exactly as `pg_get_constraintdef` states
        // them -- an enum list, a hash-format regex, an integer bound, a
        // cross-column rule such as retired-target coverage, all read back
        // the same generic way.
        for (const check of await fetchCheckConstraints(client, name)) {
          const referencedCols = table.columns.filter((c) =>
            new RegExp(`\\b${escapeRegExp(c)}\\b`).test(check.expr),
          );
          const selectCols = referencedCols.map(quote).join(", ");
          let rows;
          try {
            rows = await client.query<Record<string, unknown> & { id: string }>(
              `SELECT id${selectCols ? `, ${selectCols}` : ""}
                 FROM ${quote(AUDIT_SCHEMA)}.${quote(name)} WHERE NOT (${check.expr})`,
            );
          } catch (error) {
            skipped.push({
              table: name,
              constraint: check.name,
              kind: "check",
              reason: `could not evaluate against the transform's mapped columns: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
            continue;
          }
          for (const row of rows.rows) {
            violations.push({
              table: name,
              id: row.id,
              constraint: check.name,
              kind: "check",
              detail: describeColumns(row, referencedCols),
            });
          }
        }

        // Foreign keys: MATCH SIMPLE, the Postgres default -- a row with any
        // referencing column NULL is not checked, matching what a deferred
        // FK would accept at COMMIT in the real load.
        for (const fk of fksByTable.get(name) ?? []) {
          if (!allTables.has(fk.foreignTable)) {
            skipped.push({
              table: name,
              constraint: fk.name,
              kind: "foreign_key",
              reason: `references kith.${fk.foreignTable}, which is outside this row's migrated table set`,
            });
            continue;
          }
          const notNullClause = fk.localColumns
            .map((c) => `t.${quote(c)} IS NOT NULL`)
            .join(" AND ");
          const joinClause = fk.localColumns
            .map((c, i) => `f.${quote(fk.foreignColumns[i]!)} = t.${quote(c)}`)
            .join(" AND ");
          const selectCols = fk.localColumns
            .map((c) => `t.${quote(c)}`)
            .join(", ");
          const rows = await client.query<
            Record<string, unknown> & { id: string }
          >(
            `SELECT t.id, ${selectCols}
               FROM ${quote(AUDIT_SCHEMA)}.${quote(name)} t
              WHERE ${notNullClause}
                AND NOT EXISTS (
                  SELECT 1 FROM ${quote(AUDIT_SCHEMA)}.${quote(fk.foreignTable)} f
                   WHERE ${joinClause}
                )`,
          );
          for (const row of rows.rows) {
            violations.push({
              table: name,
              id: row.id,
              constraint: fk.name,
              kind: "foreign_key",
              detail: `${describeColumns(row, fk.localColumns)} has no matching row in kith.${fk.foreignTable}`,
            });
          }
        }

        // UNIQUE (constraint-backed or bare index): every duplicate group
        // among non-NULL values, honoring a partial index's predicate.
        for (const uniq of await fetchUniqueIndexes(client, name)) {
          const unmappedColumns = uniq.columns.filter(
            (column) => !table.columns.includes(column),
          );
          if (unmappedColumns.length > 0) {
            skipped.push({
              table: name,
              constraint: uniq.name,
              kind: "unique",
              reason: `index uses columns not present in the transform: ${unmappedColumns.join(", ")}`,
            });
            continue;
          }
          const notNullClause = uniq.columns
            .map((c) => `${quote(c)} IS NOT NULL`)
            .join(" AND ");
          const predicateClause = uniq.predicate
            ? ` AND (${uniq.predicate})`
            : "";
          const groupCols = uniq.columns.map(quote).join(", ");
          const rows = await client.query<
            Record<string, unknown> & { ids: string[] }
          >(
            `SELECT array_agg(id ORDER BY id) AS ids, ${groupCols}
               FROM ${quote(AUDIT_SCHEMA)}.${quote(name)}
              WHERE ${notNullClause}${predicateClause}
              GROUP BY ${groupCols}
              HAVING count(*) > 1`,
          );
          for (const row of rows.rows) {
            const detail = describeColumns(row, uniq.columns);
            for (const id of row.ids) {
              const siblings = row.ids
                .filter((other) => other !== id)
                .join(", ");
              violations.push({
                table: name,
                id,
                constraint: uniq.name,
                kind: "unique",
                detail: `duplicate ${detail} (shared with ${siblings})`,
              });
            }
          }
        }
      }
    } finally {
      await client
        .query(`DROP SCHEMA IF EXISTS ${quote(AUDIT_SCHEMA)} CASCADE`)
        .catch(() => {});
      client.release();
    }
  } finally {
    await pool.end();
  }

  return { rowsAudited, violations, skipped, ok: violations.length === 0 };
}
