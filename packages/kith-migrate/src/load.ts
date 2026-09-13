import { execFile } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { applyKithSchema, createKithPool } from "@repo/kith-store";

import { childColumnOrder, columnOrder } from "./columns.js";
import { TABLES } from "./schema.js";

const execFileAsync = promisify(execFile);

export type DestinationConfig = {
  /** A `postgres://` URL for an isolated destination database. Plan section
   * 3 step 4: never the live archive database. */
  connectionString: string;
};

/**
 * Applies every `kith` migration through `@repo/kith-store`'s own runner
 * (`applyKithSchema`), which now includes this row's tables as migration 4
 * (`packages/kith-store/migrations/004_kith_migrate_tables.sql`, generated
 * from `src/ddl.ts`). The schema bootstrap, the version table and the id
 * domain all live in that package; this function only opens the pool and the
 * one client the runner needs.
 */
export async function applyMigration(config: DestinationConfig): Promise<void> {
  const pool = createKithPool(config.connectionString, 1);
  try {
    const client = await pool.connect();
    try {
      await applyKithSchema(client);
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
 * way `packages/kith-store/integration/docker-postgres.mjs` already shells
 * out to `pg_dump`/`pg_restore`. This is the one step that cannot go through
 * `@repo/kith-store`'s pool: COPY is a different wire protocol than the
 * simple/extended query protocol `pg` speaks, and a `psql` subprocess opens
 * its own connection to run it.
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
