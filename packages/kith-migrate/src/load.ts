import { execFile } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import pg from "pg";

import { childColumnOrder, columnOrder } from "./columns.js";
import { generateMigrationSql } from "./ddl.js";
import { TABLES } from "./schema.js";

const execFileAsync = promisify(execFile);

export type DestinationConfig = {
  /** A `postgres://` URL for an isolated destination database. Plan section
   * 3 step 4: never the live archive database. */
  connectionString: string;
};

/** Applies the generated `kith` schema migration if it has not already run.
 * Plain `pg` queries: only the bulk row load needs to shell out (below). */
export async function applyMigration(config: DestinationConfig): Promise<void> {
  const pool = new pg.Pool({ connectionString: config.connectionString, max: 1 });
  try {
    const client = await pool.connect();
    try {
      const present = await client.query<{ present: boolean }>(
        "SELECT to_regclass('kith.schema_migrations') IS NOT NULL AS present",
      );
      if (present.rows[0]?.present) return;
      await client.query("BEGIN");
      await client.query(generateMigrationSql());
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Builds the `psql` script that COPY-loads every CSV in `csvDir` (as
 * `transformExport` wrote them) into `destination`, in one transaction with
 * every foreign key deferred until COMMIT (plan section 3 step 4).
 */
export function buildCopyScript(csvDir: string, presentFiles: Set<string>): string {
  const lines = ["BEGIN;", "SET CONSTRAINTS ALL DEFERRED;"];
  for (const t of TABLES) {
    if (t.migrated && presentFiles.has(`${t.pg}.csv`)) {
      const cols = columnOrder(t).map(quote).join(", ");
      const path = join(csvDir, `${t.pg}.csv`).replaceAll("'", "''");
      lines.push(
        `\\copy kith.${quote(t.pg)} (${cols}) FROM '${path}' WITH (FORMAT csv)`,
      );
    }
    for (const child of t.children ?? []) {
      if (!presentFiles.has(`${child.pg}.csv`)) continue;
      const cols = childColumnOrder(child).map(quote).join(", ");
      const path = join(csvDir, `${child.pg}.csv`).replaceAll("'", "''");
      lines.push(
        `\\copy kith.${quote(child.pg)} (${cols}) FROM '${path}' WITH (FORMAT csv)`,
      );
    }
  }
  lines.push("COMMIT;");
  return lines.join("\n");
}

/**
 * Loads every table's CSV (written by `transformExport`) into `destination`
 * with a `psql \copy`-driven script (plan section 3 step 4). `psql` runs the
 * COPY protocol `pg` cannot speak without the `pg-copy-streams` dependency
 * this row does not add; it is native to any Postgres toolchain, the same
 * way `packages/postgres-proof/integration/docker-postgres.mjs` already
 * shells out to `pg_dump`/`pg_restore`.
 */
export async function loadCsvDirectory(
  config: DestinationConfig,
  csvDir: string,
): Promise<void> {
  await applyMigration(config);
  const files = new Set(await readdir(csvDir));
  const script = buildCopyScript(csvDir, files);
  const scriptDir = await mkdtemp(join(tmpdir(), "kith-load-"));
  const scriptPath = join(scriptDir, "load.sql");
  await writeFile(scriptPath, script);
  await execFileAsync("psql", [
    config.connectionString,
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    scriptPath,
  ]);
}
