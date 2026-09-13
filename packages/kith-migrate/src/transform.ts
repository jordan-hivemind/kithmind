import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { csvRow } from "./csv.js";
import { readTableRows } from "./export.js";
import { newId } from "./ids.js";
import { NO_TARGET_CONVEX_TABLES, RETIRED_CONVEX_TABLES, TABLES } from "./schema.js";

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

export type TransformReport = {
  /** Rows written per Postgres table (own rows only, not child tables). */
  rowCounts: Record<string, number>;
  childRowCounts: Record<string, number>;
  retainedTextHashes: RetainedTextHash[];
  /** Present only when `reportUnmappedOnly` is set; otherwise a mismatch
   * throws `UnmappedFieldError` as soon as it is found (plan section 3's
   * acceptance: "any unmapped field is a hard failure"). */
  unmapped: string[];
};

const RETAINED_TEXT_COLUMNS: Record<string, string> = {
  source_pages: "text",
  chunks: "text",
};

function allowedConvexFields(t: (typeof TABLES)[number]): Set<string> {
  const allowed = new Set(["_id", "_creationTime"]);
  if (t.spaceScoped) allowed.add("spaceId");
  for (const c of t.columns) allowed.add(c.convex);
  for (const field of t.excludedFields ?? []) allowed.add(field);
  for (const child of t.children ?? []) allowed.add(child.convexField);
  return allowed;
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
    unmapped: [],
  };

  for (const t of TABLES) {
    const rows = await readTableRows(exportDir, t.convexTable);
    const allowed = allowedConvexFields(t);
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
        const cell = toCell(c.kind, row[c.convex]);
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
