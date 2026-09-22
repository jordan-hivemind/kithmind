// Orchestrates one run: walk the root, hash and skip unchanged files,
// convert and write the rest, then run classification/embedding once.
// Stateless by design -- no journal, no lease, no retry budget. A failure is
// logged and counted; the file is tried again, from scratch, on the next run.
//
// Depth policy (docs/plans/2026-09-22-simplification-and-feeds.md's "document
// ingestion" line, and the owner's tax-support-documents request it
// implements): every file gets a cheap, local `glance` -- page 1 only, plus a
// classified `kind` and, when found, a tax year -- before this module decides
// whether to spend a full conversion on it. `depthPolicy.ts` has the actual
// policy; this module is where that decision is applied to a real file.

import { readFile, stat } from "node:fs/promises";
import type { Pool } from "pg";

import { sha256 } from "@repo/kith-store";

import { detectKind, detectTaxYear, type DocumentKind } from "./classify.js";
import { convertFile, convertFilePage1 } from "./convert.js";
import { decideDepth, withDepthFingerprint, type Depth, type DepthOverride } from "./depthPolicy.js";
import { toFsUri } from "./fsUri.js";
import { runPostProcessing } from "./postProcess.js";
import { resolveSourceAccount, resolveUserId } from "./sourceAccount.js";
import { buildTitle } from "./title.js";
import { ingestFile, isUpToDate, readActiveIngestState } from "./write.js";
import { walkRoot } from "./walk.js";

export type IngestOptions = {
  root: string;
  sourceAccountId: string;
  spaceId?: string;
  limit?: number;
  dryRun: boolean;
  concurrency: number;
  /**
   * `relativePath -> externalId`, loaded from the old filesystem worker's
   * journal by `bindings.ts`/`--bindings`/`--root-alias` (see cli.ts). A file
   * whose `relativePath` is in this map reuses that `externalId` (the same
   * `kith.source_items.external_id` the old worker gave it) instead of the
   * path itself, so a folder the old worker already indexed does not get a
   * second source item per file on this package's first run against it.
   * Absent (or a file with no entry) falls back to `relativePath`, as before.
   */
  externalIdBindings?: Map<string, string>;
  /**
   * Names the root being walked (`--root-alias`). Two effects, independent of
   * `--bindings`: `decideDepth` (depthPolicy.ts) forces `full` depth for the
   * `dropbox-inbox` alias, and, when set, every ingested document's `uri` is
   * written as a retrievable `fs://<rootAlias>/<relativePath>` (fsUri.ts) --
   * the same scheme `apps/web/src/lib/kith/document-content.ts`'s
   * `documentDropboxPath` already reads back to serve the original file.
   * Without it, `uri` is left unset, exactly as before this package had a
   * concept of a root alias.
   */
  rootAlias?: string;
  /** `--depth`. `"auto"` (the default) applies `decideDepth`'s policy per
   * file; `"full"`/`"glance"` forces every file in this run to that depth. */
  depth: DepthOverride;
  /** `--full-match`, repeatable. A relative path matching any pattern here is
   * ingested in full, same as a `tax_return`/`k1` kind or the
   * `dropbox-inbox` root alias -- see `decideDepth`. */
  fullMatchPatterns: readonly RegExp[];
};

export type IngestSummary = {
  seen: number;
  newCount: number;
  /** Of `newCount`'s cases, how many were an existing glance-depth document
   * whose policy (or `--depth full`) now raises it to full -- unchanged file
   * bytes, deeper extraction. Counted separately from `newCount` because a
   * promotion is not a new document; see `depthPolicy.ts` and `write.ts`'s
   * `readActiveIngestState`. */
  promoted: number;
  skippedUnchanged: number;
  skippedDotOrArchive: number;
  skippedExtension: Map<string, number>;
  failed: number;
  failures: Array<{ path: string; error: string }>;
  extension: Map<string, { seen: number; newCount: number }>;
  /** Of `seen`, how many resolved an `externalId` from `externalIdBindings`
   * rather than falling back to their `relativePath`. */
  matchedByBinding: number;
  /** Of `seen`, how many had no entry in `externalIdBindings` (or no
   * bindings were supplied) and used `relativePath` as their `externalId`. */
  usingPathId: number;
  /** Documents actually ingested this run (new or promoted), by detected
   * `kind` and by the depth they were ingested at. Dry runs and skipped
   * files are not counted -- see the module comment on why dry run never
   * classifies a file. */
  byKind: Map<DocumentKind, number>;
  byDepth: Map<Depth, number>;
};

function bump(map: Map<string, { seen: number; newCount: number }>, ext: string, field: "seen" | "newCount"): void {
  const entry = map.get(ext) ?? { seen: 0, newCount: 0 };
  entry[field] += 1;
  map.set(ext, entry);
}

function bumpCount<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
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
    promoted: 0,
    skippedUnchanged: 0,
    skippedDotOrArchive: walked.skippedDotOrArchive,
    skippedExtension: walked.skippedExtension,
    failed: 0,
    failures: [],
    extension: new Map(),
    matchedByBinding: 0,
    usingPathId: 0,
    byKind: new Map(),
    byDepth: new Map(),
  };

  let activatedThisRun = 0;

  await runWithConcurrency(files, options.concurrency, async (file) => {
    bump(summary.extension, file.extension, "seen");
    const bound = options.externalIdBindings?.get(file.relativePath);
    if (bound !== undefined) summary.matchedByBinding += 1;
    else summary.usingPathId += 1;
    const externalId = bound ?? file.relativePath;
    try {
      const bytes = await readFile(file.absolutePath);
      const fileByteHash = sha256(bytes);

      if (options.dryRun) {
        // Preserves this flag's original contract exactly ("Walk and hash
        // only... converts nothing"): no page-1 extraction, so no
        // content-based kind/depth here, only whether the file's bytes
        // already match what is active.
        const state = await readActiveIngestState(pool, {
          spaceId: account.spaceId,
          sourceAccountId: account.id,
          externalId,
        });
        if (state?.fileByteHash === fileByteHash) {
          summary.skippedUnchanged += 1;
          return;
        }
        summary.newCount += 1;
        bump(summary.extension, file.extension, "newCount");
        return;
      }

      const state = await readActiveIngestState(pool, {
        spaceId: account.spaceId,
        sourceAccountId: account.id,
        externalId,
      });
      // The common steady-state case: unchanged bytes, already at the
      // highest depth. No point spending a page-1 conversion just to learn a
      // depth decision that could not change anything. (`isUpToDate` with
      // "full" as the desired depth is true exactly when `state.depth` is
      // already "full", regardless of what this run would otherwise decide.)
      if (isUpToDate(state, fileByteHash, "full")) {
        summary.skippedUnchanged += 1;
        return;
      }

      let ocrWarned = false;
      const page1 = await convertFilePage1(file.absolutePath, file.extension, {
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
      const kind = detectKind(file.relativePath, page1.pageText);
      const taxYear = detectTaxYear(file.relativePath, page1.pageText);
      const decision = decideDepth({
        kind,
        relativePath: file.relativePath,
        ...(options.rootAlias !== undefined ? { rootAlias: options.rootAlias } : {}),
        fullMatchPatterns: options.fullMatchPatterns,
        override: options.depth,
      });
      const desiredDepth = decision.depth;

      if (isUpToDate(state, fileByteHash, desiredDepth)) {
        summary.skippedUnchanged += 1;
        return;
      }
      const promoted =
        state?.fileByteHash === fileByteHash && state.depth === "glance" && desiredDepth === "full";

      let pages: string[];
      let rawConverterFingerprint: string;
      let mediaType: string;
      let totalPageCount: number;
      if (desiredDepth === "glance") {
        pages = [page1.pageText];
        rawConverterFingerprint = page1.converterFingerprint;
        mediaType = page1.mediaType;
        totalPageCount = page1.totalPageCount;
        log(
          `${file.relativePath}: glance (page 1 of ${page1.totalPageCount}; kind ${kind}` +
            (taxYear ? `, tax year ${taxYear}` : "") +
            `; ${decision.reason})`,
        );
      } else {
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
        pages = converted.pages;
        rawConverterFingerprint = converted.converterFingerprint;
        mediaType = converted.mediaType;
        totalPageCount = converted.pages.length;
        if (promoted) {
          log(`${file.relativePath}: promoted glance -> full (${decision.reason})`);
        }
      }
      const converterFingerprint = withDepthFingerprint(rawConverterFingerprint, desiredDepth);

      const fileStat = await stat(file.absolutePath);
      await ingestFile(pool, {
        spaceId: account.spaceId,
        sourceAccountId: account.id,
        externalId,
        title: buildTitle(file.relativePath, kind, taxYear),
        docType: kind,
        ...(options.rootAlias !== undefined
          ? { uri: toFsUri(options.rootAlias, file.relativePath) }
          : {}),
        capturedAt: fileStat.mtime,
        userId: userId!,
        fileByteHash,
        pages,
        converterFingerprint,
        mediaType,
        // Persisted to `kith.source_items.ingest_metadata` (migration 046)
        // so the MCP can find a glance-depth document's real page count, tax
        // year and how it was ingested without a schema change to the read
        // path -- see write.ts's `setSourceItemIngestMetadata` and README.md's
        // "Depth policy". Updated in place on every ingest and promotion.
        ingestMetadata: {
          pageCount: totalPageCount,
          byteLength: bytes.length,
          taxYear: taxYear ?? null,
          kind,
          depth: desiredDepth,
          converter: rawConverterFingerprint,
        },
      });

      if (promoted) {
        summary.promoted += 1;
      } else {
        summary.newCount += 1;
        bump(summary.extension, file.extension, "newCount");
      }
      activatedThisRun += 1;
      bumpCount(summary.byKind, kind);
      bumpCount(summary.byDepth, desiredDepth);
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
