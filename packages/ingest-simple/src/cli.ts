#!/usr/bin/env node
// `kith-ingest-simple --root <dir> --source-account <id> [--space <id>] [--limit N]
// [--dry-run] [--concurrency N] [--root-alias <alias>] [--bindings <path>]
// [--depth full|glance|auto] [--full-match <regex>]... [--pdf-password <value>]...
// [--env-from-keychain]`. `--bindings` requires `--root-alias`; `--root-alias`
// is otherwise optional on its own. See README.md.
//
// `kith-ingest-simple --backfill-embeddings --source-account <id>
// [--env-from-keychain]` is the one-off catch-up subcommand: it takes no
// `--root` (it walks nothing) and registers/embeds `postProcess.ts`'s
// `backfillEmbeddings` for every already-active generation on the account
// instead of ingesting.
//
// `kith-ingest-simple --set-embedding-policy all_chunks|cards_and_opted_in_chunks
// --space <id> [--env-from-keychain]` is a third subcommand: it switches the
// space's chunk target policy (`postProcess.ts`'s `setEmbeddingPolicy`,
// `@repo/kith-store`'s `embeddings.setSpaceEmbeddingTargetPolicy`) and then
// re-registers and embeds every already-ingested document in the space under
// the new policy, instead of ingesting or backfilling one source account.

import process from "node:process";

import { createKithPool, embeddings } from "@repo/kith-store";

import { loadBindings } from "./bindings.js";
import { loadDatabaseUrl } from "./config.js";
import type { DepthOverride } from "./depthPolicy.js";
import { runIngest, type IngestOptions } from "./ingest.js";
import { backfillEmbeddings, setEmbeddingPolicy, type EmbeddingCoverageSnapshot } from "./postProcess.js";
import { applyProviderEnvFromKeychain } from "./providerEnv.js";

const DEFAULT_CONCURRENCY = 2;
const DEPTH_OVERRIDES: readonly DepthOverride[] = ["auto", "full", "glance"];
const EMBEDDING_POLICIES: readonly embeddings.EmbeddingTargetPolicy[] = [
  "all_chunks",
  "cards_and_opted_in_chunks",
];

function usage(): never {
  process.stderr.write(
    "Usage: kith-ingest-simple --root <dir> --source-account <id> " +
      "[--space <id>] [--limit N] [--dry-run] [--concurrency N] " +
      "[--root-alias <alias>] [--bindings <path>] " +
      "[--depth full|glance|auto] [--full-match <regex>]... " +
      "[--pdf-password <value>]... [--env-from-keychain]\n" +
      "   or: kith-ingest-simple --backfill-embeddings --source-account <id> " +
      "[--env-from-keychain]\n" +
      "   or: kith-ingest-simple --set-embedding-policy all_chunks|cards_and_opted_in_chunks " +
      "--space <id> [--env-from-keychain]\n",
  );
  process.exit(2);
}

type ParsedArgs = Omit<
  IngestOptions,
  "externalIdBindings" | "fullMatchPatterns" | "pdfPasswords" | "root" | "sourceAccountId"
> & {
  root?: string;
  sourceAccountId?: string;
  bindingsPath?: string;
  fullMatchSources: string[];
  pdfPasswords: string[];
  envFromKeychain: boolean;
  backfillEmbeddings: boolean;
  setEmbeddingPolicy?: embeddings.EmbeddingTargetPolicy;
};

function parseArgs(argv: string[]): ParsedArgs {
  let root: string | undefined;
  let sourceAccountId: string | undefined;
  let spaceId: string | undefined;
  let limit: number | undefined;
  let dryRun = false;
  let concurrency = DEFAULT_CONCURRENCY;
  let bindingsPath: string | undefined;
  let rootAlias: string | undefined;
  let depth: DepthOverride = "auto";
  let envFromKeychain = false;
  let backfillEmbeddingsFlag = false;
  let setEmbeddingPolicyFlag: embeddings.EmbeddingTargetPolicy | undefined;
  const fullMatchSources: string[] = [];
  const pdfPasswords: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--root":
        root = argv[++index];
        break;
      case "--source-account":
        sourceAccountId = argv[++index];
        break;
      case "--space":
        spaceId = argv[++index];
        break;
      case "--limit": {
        const value = Number(argv[++index]);
        if (!Number.isInteger(value) || value <= 0) usage();
        limit = value;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--concurrency": {
        const value = Number(argv[++index]);
        if (!Number.isInteger(value) || value <= 0) usage();
        concurrency = value;
        break;
      }
      case "--bindings":
        bindingsPath = argv[++index];
        break;
      case "--root-alias":
        rootAlias = argv[++index];
        break;
      case "--depth": {
        const value = argv[++index];
        if (!DEPTH_OVERRIDES.includes(value as DepthOverride)) usage();
        depth = value as DepthOverride;
        break;
      }
      case "--full-match": {
        const value = argv[++index];
        if (value === undefined) usage();
        fullMatchSources.push(value);
        break;
      }
      case "--pdf-password": {
        const value = argv[++index];
        if (value === undefined) usage();
        pdfPasswords.push(value);
        break;
      }
      case "--env-from-keychain":
        envFromKeychain = true;
        break;
      case "--backfill-embeddings":
        backfillEmbeddingsFlag = true;
        break;
      case "--set-embedding-policy": {
        const value = argv[++index];
        if (!EMBEDDING_POLICIES.includes(value as embeddings.EmbeddingTargetPolicy)) usage();
        setEmbeddingPolicyFlag = value as embeddings.EmbeddingTargetPolicy;
        break;
      }
      default:
        usage();
    }
  }
  // `--set-embedding-policy` is a subcommand of its own: it switches a whole
  // space, not one source account, so it needs `--space` and not
  // `--source-account`, and (like `--backfill-embeddings`) walks nothing.
  if (setEmbeddingPolicyFlag !== undefined) {
    if (!spaceId) usage();
  } else {
    if (!sourceAccountId) usage();
    // `--backfill-embeddings` is a subcommand, not an ingest run: it walks
    // nothing, so `--root` is not required for it (and is ignored if given).
    // Every other flag still requires `--root`, exactly as before.
    if (!backfillEmbeddingsFlag && !root) usage();
  }
  // A bindings file with no root alias to filter it by cannot be resolved
  // into a lookup, so it is a usage error rather than a silent no-op. A bare
  // `--root-alias` with no `--bindings` is valid on its own: it still labels
  // this run's `dropbox-inbox` depth-policy check and the `uri` this run
  // writes (see ingest.ts), whether or not a bindings transition is in play.
  if (bindingsPath !== undefined && rootAlias === undefined) usage();
  return {
    ...(root !== undefined ? { root } : {}),
    ...(sourceAccountId !== undefined ? { sourceAccountId } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(limit ? { limit } : {}),
    dryRun,
    concurrency,
    depth,
    fullMatchSources,
    pdfPasswords,
    envFromKeychain,
    backfillEmbeddings: backfillEmbeddingsFlag,
    ...(setEmbeddingPolicyFlag !== undefined ? { setEmbeddingPolicy: setEmbeddingPolicyFlag } : {}),
    ...(bindingsPath !== undefined ? { bindingsPath } : {}),
    ...(rootAlias !== undefined ? { rootAlias } : {}),
  };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  // Never logs a value -- only whether the Keychain item was found (below).
  // See providerEnv.ts: this must run before anything reads
  // `process.env.OPENAI_API_KEY`/`BRAIN_EMBED_*`, which is every OCR,
  // extraction and embedding call this run makes (they all default to
  // `process.env` when not given an explicit environment).
  if (args.envFromKeychain) {
    const result = await applyProviderEnvFromKeychain(process.env);
    process.stderr.write(
      `kith-ingest-simple: --env-from-keychain ${result.loadedApiKey ? "found" : "did not find"} the provider key in the Keychain\n`,
    );
  }

  if (args.setEmbeddingPolicy !== undefined) {
    // `parseArgs` already refused a missing `--space` (`usage()` above).
    if (args.spaceId === undefined) {
      throw new Error("--space is required for --set-embedding-policy");
    }
    const spaceId = args.spaceId;
    const policy = args.setEmbeddingPolicy;
    const databaseUrl = await loadDatabaseUrl();
    const pool = createKithPool(databaseUrl, 2);
    try {
      const result = await setEmbeddingPolicy(pool, spaceId, policy, process.env, (message) => {
        process.stderr.write(`${message}\n`);
      });
      process.stdout.write(coverageReportLines(result.before, result.after, result.changed, result.sourceItemsTouched, result.embeddings) + "\n");
      if (result.embeddings.failed) process.exitCode = 1;
    } finally {
      await pool.end();
    }
    return;
  }

  if (args.backfillEmbeddings) {
    // `parseArgs` already refused a missing `--source-account` (`usage()` above).
    if (args.sourceAccountId === undefined) {
      throw new Error("--source-account is required for --backfill-embeddings");
    }
    const databaseUrl = await loadDatabaseUrl();
    const pool = createKithPool(databaseUrl, 2);
    try {
      const result = await backfillEmbeddings(pool, args.sourceAccountId, process.env, (message) => {
        process.stderr.write(`${message}\n`);
      });
      process.stdout.write(
        [
          `source-items-touched ${result.sourceItemsTouched}`,
          `embedded ${result.embeddings.embedded}`,
          `skipped ${result.embeddings.skipped}`,
          `eligible-thought ${result.coverage.eligible.thought}`,
          `eligible-chunk ${result.coverage.eligible.chunk}`,
          `eligible-card ${result.coverage.eligible.card}`,
          `covered-thought ${result.coverage.covered.thought}`,
          `covered-chunk ${result.coverage.covered.chunk}`,
          `covered-card ${result.coverage.covered.card}`,
        ].join("\n") + "\n",
      );
      if (result.embeddings.failed) process.exitCode = 1;
    } finally {
      await pool.end();
    }
    return;
  }
  // `parseArgs` already refused this combination (`usage()` above), so this
  // never actually throws; it only narrows `args.root`/`args.sourceAccountId`
  // from `string | undefined` for everything below, which is ordinary ingest
  // and always needs both.
  if (args.root === undefined || args.sourceAccountId === undefined) {
    throw new Error(
      "--root and --source-account are required unless --backfill-embeddings or --set-embedding-policy is given",
    );
  }
  const root = args.root;
  const sourceAccountId = args.sourceAccountId;

  let externalIdBindings: Map<string, string> | undefined;
  let bindingsLoaded = 0;
  if (args.bindingsPath !== undefined && args.rootAlias !== undefined) {
    const result = await loadBindings(args.bindingsPath, args.rootAlias);
    externalIdBindings = result.map;
    bindingsLoaded = result.loaded;
  }
  const fullMatchPatterns = args.fullMatchSources.map((source) => {
    try {
      return new RegExp(source);
    } catch (error) {
      process.stderr.write(`kith-ingest-simple: --full-match "${source}" is not a valid regular expression: ${errorMessage(error)}\n`);
      return process.exit(2);
    }
  });
  const options: IngestOptions = {
    root,
    sourceAccountId,
    ...(args.spaceId ? { spaceId: args.spaceId } : {}),
    ...(args.limit ? { limit: args.limit } : {}),
    dryRun: args.dryRun,
    concurrency: args.concurrency,
    depth: args.depth,
    fullMatchPatterns,
    pdfPasswords: args.pdfPasswords,
    ...(args.rootAlias !== undefined ? { rootAlias: args.rootAlias } : {}),
    ...(externalIdBindings ? { externalIdBindings } : {}),
  };

  const databaseUrl = await loadDatabaseUrl();
  const pool = createKithPool(databaseUrl, Math.max(2, options.concurrency));
  try {
    const summary = await runIngest(pool, options, (message) => {
      process.stderr.write(`${message}\n`);
    });
    const extensionLines = [...summary.extension.entries()]
      .map(([ext, counts]) => `${ext} seen ${counts.seen} new ${counts.newCount}`)
      .join(", ");
    const skippedExtLines = [...summary.skippedExtension.entries()]
      .map(([ext, count]) => `${ext} ${count}`)
      .join(", ");
    const byKindLine = [...summary.byKind.entries()].map(([kind, count]) => `${kind} ${count}`).join(", ");
    const byDepthLine = [...summary.byDepth.entries()].map(([depth, count]) => `${depth} ${count}`).join(", ");
    process.stdout.write(
      [
        `seen ${summary.seen}`,
        `new ${summary.newCount}`,
        `promoted ${summary.promoted}`,
        `skipped-unchanged ${summary.skippedUnchanged}`,
        `skipped-dot-or-archive ${summary.skippedDotOrArchive}`,
        `failed ${summary.failed}`,
        `encrypted ${summary.encrypted}`,
        `ocr-skipped-pages ${summary.ocrSkippedPages}`,
        `retried ${summary.retried}`,
        `revision-conflicts ${summary.revisionConflicts}`,
        externalIdBindings ? `bindings loaded ${bindingsLoaded}` : undefined,
        externalIdBindings ? `files matched by binding ${summary.matchedByBinding}` : undefined,
        externalIdBindings ? `files using path IDs ${summary.usingPathId}` : undefined,
        extensionLines ? `by-extension: ${extensionLines}` : undefined,
        skippedExtLines ? `unsupported extensions skipped: ${skippedExtLines}` : undefined,
        byKindLine ? `by-kind: ${byKindLine}` : undefined,
        byDepthLine ? `by-depth: ${byDepthLine}` : undefined,
      ]
        .filter(Boolean)
        .join("\n") + "\n",
    );
    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`kith-ingest-simple: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});

/** `--set-embedding-policy`'s report: policy before/after, the eligible and
 * covered counts on both sides of the switch (so a zero-embedded result is
 * explainable -- see postProcess.ts), and the touch/embed outcome. */
function coverageReportLines(
  before: EmbeddingCoverageSnapshot,
  after: EmbeddingCoverageSnapshot,
  changed: boolean,
  sourceItemsTouched: number,
  embeddingsResult: { embedded: number; skipped: number },
): string {
  return [
    `policy-before ${before.policy}`,
    `policy-after ${after.policy}`,
    `policy-changed ${changed}`,
    `eligible-before-thought ${before.eligible.thought}`,
    `eligible-before-chunk ${before.eligible.chunk}`,
    `eligible-before-card ${before.eligible.card}`,
    `eligible-after-thought ${after.eligible.thought}`,
    `eligible-after-chunk ${after.eligible.chunk}`,
    `eligible-after-card ${after.eligible.card}`,
    `covered-before-thought ${before.covered.thought}`,
    `covered-before-chunk ${before.covered.chunk}`,
    `covered-before-card ${before.covered.card}`,
    `covered-after-thought ${after.covered.thought}`,
    `covered-after-chunk ${after.covered.chunk}`,
    `covered-after-card ${after.covered.card}`,
    `source-items-touched ${sourceItemsTouched}`,
    `embedded ${embeddingsResult.embedded}`,
    `skipped ${embeddingsResult.skipped}`,
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
