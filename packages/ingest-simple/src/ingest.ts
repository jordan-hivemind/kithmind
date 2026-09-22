// Orchestrates one run: walk the root, hash and skip unchanged files,
// convert and write the rest, then run classification/embedding once.
// Stateless by design -- no journal, no lease, no retry budget. A failure is
// logged and counted; the file is tried again, from scratch, on the next run.

import { readFile } from "node:fs/promises";
import type { Pool } from "pg";

import { sha256 } from "@repo/kith-store";

import { convertFile } from "./convert.js";
import { runPostProcessing } from "./postProcess.js";
import { resolveSourceAccount, resolveUserId } from "./sourceAccount.js";
import { alreadyIngested, ingestFile } from "./write.js";
import { walkRoot, type SupportedExtension } from "./walk.js";

const DOC_TYPES: Record<SupportedExtension, string> = {
  ".pdf": "pdf",
  ".txt": "text",
  ".md": "markdown",
  ".csv": "csv",
};

export type IngestOptions = {
  root: string;
  sourceAccountId: string;
  spaceId?: string;
  limit?: number;
  dryRun: boolean;
  concurrency: number;
};

export type IngestSummary = {
  seen: number;
  newCount: number;
  skippedUnchanged: number;
  skippedDotOrArchive: number;
  skippedExtension: Map<string, number>;
  failed: number;
  failures: Array<{ path: string; error: string }>;
  extension: Map<string, { seen: number; newCount: number }>;
};

function bump(map: Map<string, { seen: number; newCount: number }>, ext: string, field: "seen" | "newCount"): void {
  const entry = map.get(ext) ?? { seen: 0, newCount: 0 };
  entry[field] += 1;
  map.set(ext, entry);
}

function titleFor(relativePath: string): string {
  const base = relativePath.split("/").pop() ?? relativePath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, concurrency);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await work(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

export async function runIngest(
  pool: Pool,
  options: IngestOptions,
  log: (message: string) => void = () => {},
): Promise<IngestSummary> {
  const account = await resolveSourceAccount(pool, options.sourceAccountId, options.spaceId);
  const userId = options.dryRun ? null : await resolveUserId(pool, account);

  const walked = await walkRoot(options.root);
  const files = options.limit ? walked.files.slice(0, options.limit) : walked.files;

  const summary: IngestSummary = {
    seen: files.length,
    newCount: 0,
    skippedUnchanged: 0,
    skippedDotOrArchive: walked.skippedDotOrArchive,
    skippedExtension: walked.skippedExtension,
    failed: 0,
    failures: [],
    extension: new Map(),
  };

  let activatedThisRun = 0;

  await runWithConcurrency(files, options.concurrency, async (file) => {
    bump(summary.extension, file.extension, "seen");
    try {
      const bytes = await readFile(file.absolutePath);
      const fileByteHash = sha256(bytes);
      const skip = await alreadyIngested(pool, {
        spaceId: account.spaceId,
        sourceAccountId: account.id,
        externalId: file.relativePath,
        fileByteHash,
      });
      if (skip) {
        summary.skippedUnchanged += 1;
        return;
      }
      if (options.dryRun) {
        summary.newCount += 1;
        bump(summary.extension, file.extension, "newCount");
        return;
      }
      let ocrWarned = false;
      const converted = await convertFile(file.absolutePath, file.extension, {
        onOcrUnconfigured: () => {
          if (!ocrWarned) {
            log(`${file.relativePath}: a page needs OCR but no extraction provider is configured`);
            ocrWarned = true;
          }
        },
        onOcrFailed: (error) => {
          log(`${file.relativePath}: OCR request failed: ${errorMessage(error)}`);
        },
      });
      await ingestFile(pool, {
        spaceId: account.spaceId,
        sourceAccountId: account.id,
        externalId: file.relativePath,
        title: titleFor(file.relativePath),
        docType: DOC_TYPES[file.extension],
        capturedAt: new Date(),
        userId: userId!,
        fileByteHash,
        pages: converted.pages,
        converterFingerprint: converted.converterFingerprint,
        mediaType: converted.mediaType,
      });
      summary.newCount += 1;
      activatedThisRun += 1;
      bump(summary.extension, file.extension, "newCount");
    } catch (error) {
      summary.failed += 1;
      summary.failures.push({ path: file.relativePath, error: errorMessage(error) });
      log(`${file.relativePath}: ${errorMessage(error)}`);
    }
  });

  if (!options.dryRun && activatedThisRun > 0) {
    const postProcess = await runPostProcessing(
      pool,
      account.spaceId,
      process.env,
      Math.max(25, activatedThisRun),
      log,
    );
    log(
      `classification: ${postProcess.extraction.completed}/${postProcess.extraction.claimed} jobs completed` +
        (postProcess.extraction.failed ? " (provider unavailable)" : ""),
    );
    log(
      `embeddings: ${postProcess.embeddings.embedded} embedded, ${postProcess.embeddings.skipped} skipped` +
        (postProcess.embeddings.failed ? " (provider unavailable)" : ""),
    );
  }

  return summary;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
