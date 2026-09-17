import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { csvRow } from "./csv.js";
import { readTableRows } from "./export.js";
import { newId } from "./ids.js";
import {
  currentPgName,
  NO_TARGET_CONVEX_TABLES,
  RETIRED_CONVEX_TABLES,
  TABLES,
  type ColumnSpec,
  type TableSpec,
} from "./schema.js";

export class UnmappedFieldError extends Error {
  constructor(public readonly convexTable: string, public readonly field: string) {
    super(`unmapped_field:${convexTable}.${field}`);
    this.name = "UnmappedFieldError";
  }
}

export type RetainedTextHash = {
  pgTable: string;
  id: string;
  sha256: string;
};

/** Reference columns the transform wrote as NULL rather than as the id the
 * export held, keyed `<pg table>.<pg column>`. Counts and reasons only: a
 * cleared value is a real row's id and this report is published. */
export type ClearedReferences = Record<
  string,
  { count: number; reason: string }
>;

export const DRAINED_TARGET_REASON = "target drained";
export const MISSING_API_KEY_REASON =
  "referenced api key no longer exists in the export";

export type TransformReport = {
  /** Rows written per Postgres table (own rows only, not child tables). */
  rowCounts: Record<string, number>;
  childRowCounts: Record<string, number>;
  retainedTextHashes: RetainedTextHash[];
  /** See `refClearingRules`. Empty when every reference in the export
   * resolved. */
  clearedReferences: ClearedReferences;
  /** Present only when `reportUnmappedOnly` is set; otherwise a mismatch
   * throws `UnmappedFieldError` as soon as it is found (plan section 3's
   * acceptance: "any unmapped field is a hard failure"). */
  unmapped: string[];
};

const RETAINED_TEXT_COLUMNS: Record<string, string> = {
  source_pages: "text",
  // brain_chunks: the plan's real `chunks` shape lands under this name for
  // now; see src/ddl.ts's module comment for why.
  brain_chunks: "text",
};

function allowedConvexFields(t: (typeof TABLES)[number]): Set<string> {
  const allowed = new Set(["_id", "_creationTime"]);
  if (t.spaceScoped) allowed.add("spaceId");
  for (const c of t.columns) allowed.add(c.convex);
  for (const field of t.excludedFields ?? []) allowed.add(field);
  for (const child of t.children ?? []) allowed.add(child.convexField);
  return allowed;
}

/** Postgres tables `TABLES` marks `migrated: false`, by their live name.
 * Derived from the spec itself, so a table that starts or stops being
 * drained changes the transform with it. */
function drainedPgTables(): Set<string> {
  return new Set(
    TABLES.filter((t) => !t.migrated).map((t) => currentPgName(t.pg)),
  );
}

/** One reference column's clearing rule: why a value is dropped, and, for a
 * `dangling: "clear"` column, the ids the export actually holds. */
type RefClearingRule = { reason: string; exportedIds?: Set<string> };

/**
 * Which of a table's reference columns may be written as NULL, and why.
 *
 * Rule 1, a drained target. Section 1.2 drains the worker queue and scan
 * tables ("a quiesced worker has no in-flight work to preserve") while the
 * receipts, inventory and jobs that point into them are migrated. Copying
 * those ids verbatim leaves every one of them pointing at a row the load
 * never writes, which is a foreign-key violation per row. The pointer is
 * what is gone, not the referencing row, and every such column is nullable
 * (migration 004), so the transform writes NULL.
 *
 * Rule 2, a target Convex deleted. A `dangling: "clear"` column names a row
 * Convex hard-deletes rather than retires, so the export can hold a receipt
 * naming an API key that no longer exists. Only a value absent from the
 * export is cleared; any other id is carried through, so a dangling
 * reference this rule does not cover still reaches the audit as a
 * foreign-key violation.
 */
function refClearingRules(
  t: TableSpec,
  drained: Set<string>,
  exportedIdsByPgTable: Map<string, Set<string>>,
): Map<string, RefClearingRule> {
  const rules = new Map<string, RefClearingRule>();
  for (const c of t.columns) {
    if (c.kind !== "ref" || !c.refTable) continue;
    if (drained.has(currentPgName(c.refTable))) {
      rules.set(c.pg, { reason: DRAINED_TARGET_REASON });
      continue;
    }
    if (c.dangling !== "clear") continue;
    const exportedIds = exportedIdsByPgTable.get(c.refTable);
    if (!exportedIds) continue;
    rules.set(c.pg, { reason: missingTargetReason(c), exportedIds });
  }
  return rules;
}

function missingTargetReason(c: ColumnSpec): string {
  return c.refTable === "api_keys"
    ? MISSING_API_KEY_REASON
    : `referenced ${c.refTable} row no longer exists in the export`;
}

/**
 * The `_id` of every exported row of each table some `dangling: "clear"`
 * column points at, so rule 2 can tell a deleted target from a live one.
 * Only ids are kept, and only for those tables (today `apiKeys` alone), so
 * this holds no more rows in memory than the transform's own per-table read
 * already does.
 */
async function readExportedIds(
  exportDir: string,
  drained: Set<string>,
): Promise<Map<string, Set<string>>> {
  const wanted = new Set<string>();
  for (const t of TABLES) {
    if (!t.migrated) continue;
    for (const c of t.columns) {
      if (c.kind !== "ref" || !c.refTable || c.dangling !== "clear") continue;
      if (drained.has(currentPgName(c.refTable))) continue;
      wanted.add(c.refTable);
    }
  }
  const byPgTable = new Map<string, Set<string>>();
  for (const pg of wanted) {
    const target = TABLES.find((t) => t.pg === pg);
    if (!target) continue;
    const ids = new Set<string>();
    for (const row of await readTableRows(exportDir, target.convexTable)) {
      if (typeof row._id === "string") ids.add(row._id);
    }
    byPgTable.set(pg, ids);
  }
  return byPgTable;
}

function toCell(kind: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  switch (kind) {
    case "ref":
    case "text":
      if (typeof value !== "string")
        throw new Error(`expected_string:${JSON.stringify(value)}`);
      return value;
    case "number":
      if (typeof value !== "number")
        throw new Error(`expected_number:${JSON.stringify(value)}`);
      return String(value);
    case "boolean":
      if (typeof value !== "boolean")
        throw new Error(`expected_boolean:${JSON.stringify(value)}`);
      return value ? "true" : "false";
    case "timestamp":
      if (typeof value !== "number")
        throw new Error(`expected_timestamp_ms:${JSON.stringify(value)}`);
      return new Date(value).toISOString();
    case "jsonb":
      return JSON.stringify(value);
    default:
      throw new Error(`unknown_column_kind:${kind}`);
  }
}

/**
 * Maps each table's Convex export rows to COPY-ready CSV, one file per
 * Postgres table, from the same `TABLES` mapping `ddl.ts` reads. Retired
 * tables (`RETIRED_CONVEX_TABLES`) are skipped entirely; tables with
 * `migrated: false` are still field-checked (so a schema drift is caught
 * even though nothing loads) but write no rows.
 *
 * A reference into one of those drained tables, and a credential pointer to
 * an API key the export no longer holds, are written as NULL and counted in
 * `clearedReferences`. See `refClearingRules` for why each is cleared rather
 * than carried.
 */
export async function transformExport(
  exportDir: string,
  outDir: string,
  options: { reportUnmappedOnly?: boolean } = {},
): Promise<TransformReport> {
  await mkdir(outDir, { recursive: true });
  const report: TransformReport = {
    rowCounts: {},
    childRowCounts: {},
    retainedTextHashes: [],
    clearedReferences: {},
    unmapped: [],
  };
  const drained = drainedPgTables();
  const exportedIdsByPgTable = await readExportedIds(exportDir, drained);

  for (const t of TABLES) {
    const rows = await readTableRows(exportDir, t.convexTable);
    const allowed = allowedConvexFields(t);
    const clearing = refClearingRules(t, drained, exportedIdsByPgTable);
    const csvLines: string[] = [];
    const childCsvLines = new Map<string, string[]>();
    for (const child of t.children ?? []) childCsvLines.set(child.pg, []);
    const auditLines = new Map<string, string[]>();

    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (allowed.has(key)) continue;
        const problem = `${t.convexTable}.${key}`;
        if (options.reportUnmappedOnly) {
          report.unmapped.push(problem);
          continue;
        }
        throw new UnmappedFieldError(t.convexTable, key);
      }

      const id = row._id as string;
      if (typeof id !== "string") throw new Error(`missing_id:${t.convexTable}`);
      const creationTime = row._creationTime as number;
      if (typeof creationTime !== "number")
        throw new Error(`missing_creation_time:${t.convexTable}:${id}`);
      const spaceId = t.spaceScoped ? (row.spaceId as string) : undefined;
      if (t.spaceScoped && typeof spaceId !== "string")
        throw new Error(`missing_space_id:${t.convexTable}:${id}`);

      for (const field of t.excludedFields ?? []) {
        if (!(field in row)) continue;
        const bucket = auditLines.get(field) ?? [];
        bucket.push(JSON.stringify({ id, [field]: row[field] }));
        auditLines.set(field, bucket);
      }

      if (!t.migrated) continue; // Field-checked above; no row written.

      const cells: (string | null)[] = [id];
      if (t.spaceScoped) cells.push(spaceId!);
      cells.push(new Date(creationTime).toISOString());
      for (const c of t.columns) {
        let cell = toCell(c.kind, row[c.convex]);
        if (cell !== null) {
          const rule = clearing.get(c.pg);
          if (rule && !rule.exportedIds?.has(cell)) {
            const key = `${t.pg}.${c.pg}`;
            const cleared = report.clearedReferences[key] ?? {
              count: 0,
              reason: rule.reason,
            };
            cleared.count += 1;
            report.clearedReferences[key] = cleared;
            cell = null;
          }
        }
        cells.push(cell);
        if (c.pg === RETAINED_TEXT_COLUMNS[t.pg] && cell !== null) {
          report.retainedTextHashes.push({
            pgTable: t.pg,
            id,
            sha256: createHash("sha256").update(cell, "utf8").digest("hex"),
          });
        }
      }
      csvLines.push(csvRow(cells));

      for (const child of t.children ?? []) {
        const values = (row[child.convexField] as string[] | undefined) ?? [];
        const bucket = childCsvLines.get(child.pg)!;
        for (const value of values) {
          bucket.push(csvRow([newId(), id, value]));
        }
      }
    }

    if (t.migrated) {
      await writeFile(join(outDir, `${t.pg}.csv`), csvLines.join("\n"));
      report.rowCounts[t.pg] = csvLines.length;
      for (const child of t.children ?? []) {
        const lines = childCsvLines.get(child.pg)!;
        await writeFile(join(outDir, `${child.pg}.csv`), lines.join("\n"));
        report.childRowCounts[child.pg] = lines.length;
      }
    } else {
      report.rowCounts[t.pg] = 0;
      for (const child of t.children ?? []) report.childRowCounts[child.pg] = 0;
    }

    for (const [field, lines] of auditLines) {
      const auditDir = join(outDir, "_excluded");
      await mkdir(auditDir, { recursive: true });
      await writeFile(
        join(auditDir, `${t.convexTable}.${field}.jsonl`),
        `${lines.join("\n")}\n`,
      );
    }
  }

  return report;
}

/** Convex tables that were read from the export but have no destination:
 * retired (dropped by owner decision) or given no `kith` target (a fresh
 * design owned by another row). Used by `--report-unmapped` so a table
 * present in the export and absent from both lists is a real surprise. */
export function knownUnmappedConvexTables(): string[] {
  return [...RETIRED_CONVEX_TABLES, ...NO_TARGET_CONVEX_TABLES];
}
