// Walks a Dropbox-style root, depth first, skipping dotfiles and any
// archive/backup subtree so the ingester never reads its own (or Dropbox's)
// housekeeping copies. Pure filesystem enumeration: no hashing, no database.

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export const SUPPORTED_EXTENSIONS = [".pdf", ".txt", ".md", ".csv"] as const;
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

export type WalkedFile = {
  absolutePath: string;
  relativePath: string;
  extension: SupportedExtension;
};

/** True for a dotfile/dot-directory name, or one that names an archive or
 * backup subtree (case-insensitive substring match on the path segment). */
export function isSkippedSegment(name: string): boolean {
  if (name.startsWith(".")) return true;
  const lower = name.toLowerCase();
  return lower.includes("archive") || lower.includes("backup");
}

function supportedExtension(name: string): SupportedExtension | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot).toLowerCase();
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as SupportedExtension)
    : null;
}

export type WalkSummary = {
  files: WalkedFile[];
  skippedDotOrArchive: number;
  skippedExtension: Map<string, number>;
};

/** Walks `root` and returns every supported file plus counts of what was
 * skipped. Symlinks are not followed (Node's default `readdir` behaviour). */
export async function walkRoot(root: string): Promise<WalkSummary> {
  const files: WalkedFile[] = [];
  let skippedDotOrArchive = 0;
  const skippedExtension = new Map<string, number>();

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Cannot read directory ${dir}: ${errorMessage(error)}`);
    }
    // Deterministic order: easier to reason about and to test against.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (isSkippedSegment(entry.name)) {
        skippedDotOrArchive += 1;
        continue;
      }
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = supportedExtension(entry.name);
      if (!extension) {
        const dot = entry.name.lastIndexOf(".");
        const key = dot > 0 ? entry.name.slice(dot).toLowerCase() : "(none)";
        skippedExtension.set(key, (skippedExtension.get(key) ?? 0) + 1);
        continue;
      }
      files.push({
        absolutePath,
        relativePath: relative(root, absolutePath),
        extension,
      });
    }
  }

  await visit(root);
  return { files, skippedDotOrArchive, skippedExtension };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
