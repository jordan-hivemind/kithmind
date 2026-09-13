import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type TableManifestEntry = {
  rowCount: number;
  byteLength: number;
  sha256: string;
};

export type ExportManifest = {
  exportedAt: string;
  deploymentIdentity: string;
  schemaVersion: number;
  gitRevision: string;
  tables: Record<string, TableManifestEntry>;
};

/**
 * Reads a Convex export (the ZIP or already-extracted directory produced by
 * `npx convex export`) into per-table JSONL under `outputDir`, plus a
 * manifest recording per-table row counts, byte lengths and hashes (plan
 * section 3 step 2's acceptance).
 *
 * Layout, per the Convex docs (docs.convex.dev/database/import-export): one
 * directory per table name at the archive root, each holding
 * `documents.jsonl` (one JSON document per line) and a `generated_schema.jsonl`
 * that preserves types the plain JSON export cannot (Int64, bytes, ...). None
 * of the `kith` tables use those types (verified against every validator in
 * `packages/convex/convex/models/**\/validators.ts`), so this reader does not
 * decode `generated_schema.jsonl`.
 *
 * ponytail: `generated_schema.jsonl` decoding is skipped for that reason.
 * Add a decoder if a future table stores an Int64 or bytes field.
 */
export async function exportConvexData(
  sourcePath: string,
  outputDir: string,
  meta: { deploymentIdentity: string; schemaVersion: number; gitRevision: string },
): Promise<ExportManifest> {
  const extracted = await extractIfZip(sourcePath);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });

  const entries = await readdir(extracted, { withFileTypes: true });
  const tables: Record<string, TableManifestEntry> = {};
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "_storage") continue;
    const documentsPath = join(extracted, entry.name, "documents.jsonl");
    let raw: string;
    try {
      raw = await readFile(documentsPath, "utf8");
    } catch {
      continue; // A table folder with no documents.jsonl has nothing to export.
    }
    const outPath = join(outputDir, `${entry.name}.jsonl`);
    await writeFile(outPath, raw, { mode: 0o600 });
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    tables[entry.name] = {
      rowCount: lines.length,
      byteLength: Buffer.byteLength(raw, "utf8"),
      sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    };
  }

  const manifest: ExportManifest = {
    exportedAt: new Date().toISOString(),
    deploymentIdentity: meta.deploymentIdentity,
    schemaVersion: meta.schemaVersion,
    gitRevision: meta.gitRevision,
    tables,
  };
  const manifestPath = join(outputDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return manifest;
}

async function extractIfZip(sourcePath: string): Promise<string> {
  const info = await stat(sourcePath);
  if (info.isDirectory()) return sourcePath;
  if (!sourcePath.endsWith(".zip")) {
    throw new Error(`unrecognized_export_source:${sourcePath}`);
  }
  const dest = await mkdtemp(join(tmpdir(), "kith-convex-export-"));
  // Native `unzip` (rung 4 of the ladder): the workspace has no zip library
  // dependency and Node's own APIs don't extract archives. `unzip` ships with
  // macOS and every common Linux CI image.
  await execFileAsync("unzip", ["-q", "-o", sourcePath, "-d", dest]);
  return dest;
}

export async function verifyManifest(outputDir: string): Promise<{
  ok: boolean;
  problems: string[];
}> {
  const manifestPath = join(outputDir, "manifest.json");
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as ExportManifest;
  const problems: string[] = [];
  for (const [table, entry] of Object.entries(manifest.tables)) {
    const filePath = join(outputDir, `${table}.jsonl`);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      problems.push(`missing_table_file:${table}`);
      continue;
    }
    const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    if (sha256 !== entry.sha256) problems.push(`hash_mismatch:${table}`);
    if (lines.length !== entry.rowCount)
      problems.push(`row_count_mismatch:${table}`);
    if (Buffer.byteLength(raw, "utf8") !== entry.byteLength)
      problems.push(`byte_length_mismatch:${table}`);
  }
  return { ok: problems.length === 0, problems };
}

export async function readTableRows(
  outputDir: string,
  convexTable: string,
): Promise<Record<string, unknown>[]> {
  const filePath = join(outputDir, `${convexTable}.jsonl`);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
