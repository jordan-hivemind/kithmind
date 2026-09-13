import type { ChildTableSpec, TableSpec } from "./schema.js";

/** Postgres column order for a table's own rows: `id`, `space_id` (if
 * scoped), `created_at`, then every declared column in `TABLES` order. Both
 * `transform.ts` (writing CSV) and `load.ts` (the COPY column list) call
 * this, so the two can never fall out of step with each other. */
export function columnOrder(t: TableSpec): string[] {
  const cols = ["id"];
  if (t.spaceScoped) cols.push("space_id");
  cols.push("created_at");
  for (const c of t.columns) cols.push(c.pg);
  return cols;
}

export function childColumnOrder(child: ChildTableSpec): string[] {
  return ["id", child.parentColumn, child.valueColumn];
}
