import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

import {
  BINARY_CLASSES,
  MAX_PARSED_PAGE_BATCH,
  MAX_PARSED_REQUEST_BYTES,
  MAX_PARSED_ROW_BATCH,
  assertParsedRequestSize,
  type ArchiveReceiptSelection,
  type ArchivedWorkIdentity,
  type BinaryMediaType,
  type BinaryParserProfileId,
  type ParsedStagePhase,
  type ParserArtifactSelection,
} from "@repo/worker-protocol";
import {
  MAX_WORKER_SCAN_ENTRIES,
  type SourceRootReportState,
  type WorkerSourceRoot,
} from "@repo/worker-protocol/request";

import {
  ArchiveCommandError,
  backupResticObject,
  encryptAgeObject,
  probeArchiveTools,
  probeResticRepository,
  publishAgeObject,
  recoverPublishedAgeObject,
  recoverResticBackup,
} from "./archiveCommands.js";
import type {
  PreparedAgeObject,
  PublishedAgeObject,
  RecoveredResticBackup,
  ResticBackupResult,
} from "./archiveTypes.js";
import {
  ADMISSION_BLOCK_CODES,
  admissionBlockEscalated,
  ArchiveCatalogError,
  MAX_ADMISSION_BLOCK_ATTEMPTS,
  MAX_PARSE_ATTEMPTS,
  openArchiveCatalog,
  type ArchiveCatalog,
} from "./archiveCatalog.js";
import type {
  AdmissionBlock,
  AdmissionBlockCode,
  ArchiveCopyIntent,
  ArchiveCopyRole,
  ArchiveSubject,
  DurableParserOutput,
  OriginalCatalogRow,
  ProcessingCatalogRow,
} from "./archiveCatalogTypes.js";
import {
  automaticReceiptClearRefusal,
  operatorReceiptClearRefusal,
  positiveControlRequired,
  type PositiveControl,
  type ReceiptClearRefusal,
} from "./receiptClearSafety.js";
import {
  createArchiveReceiptSelection,
  createParserArtifactSelection,
  digestArchiveIntent,
  existingArchiveReceiptSelection,
  existingParserArtifactSelection,
  parsedTextDeclaration,
  provenanceCreatedAt,
} from "./archivedRequestMapping.js";
import {
  capturePdfFile,
  captureFileName,
  inspectCapturedPdf,
  removeCapturedPdfExact,
  type CapturedPdf,
} from "./captureStore.js";
import {
  lookupDropboxFileIds,
  validRelativePath,
  verifyDropboxOriginal,
} from "./dropboxOriginal.js";
import {
  loadProviderBinding,
  persistProviderBinding,
} from "./providerRegistry.js";

import {
  canonicalRoots,
  contains,
  discoverFiles,
  discoverSourceObservations,
  FilesystemFailure,
  readUtf8File,
  toFsUri,
  type SafeRoot,
} from "./filesystem.js";
import {
  createParserProfileWorkDirectory,
  inspectCapturedParserOutput,
  inspectParserOutputIntent,
  preparePdfDocQaProfile,
  reclaimStaleParserOutputDirectory,
  removeParserProfileWorkDirectoryExact,
  removeParserOutputExact,
  runCapturedPdfParser,
  runCapturedWorkbookParser,
  ParserProcessError,
  type DurableParserOutputArtifacts,
  type ParserOutputIntent,
  type ParserOutputRecoveryInput,
  type PreparedPdfDocQaProfile,
} from "./parserProcess.js";
import {
  mapParsedBundle,
  mapSpreadsheetWorkbook,
  SPREADSHEET_CHUNKING_FINGERPRINT,
} from "./parsedBundleMapping.js";
import {
  inspectNormalizedBundleSpool,
  inspectSpoolRoot,
  prepareNormalizedBundleSpool,
  recoverNormalizedBundleSpool,
  removeNormalizedBundleSpoolExact,
} from "./spoolStore.js";
import { providerRootFor, providerRootsOf } from "./config.js";
import { Journal } from "./journal.js";
import { JournalScanCache } from "./scanCache.js";
import {
  runJournaledCall,
  resumePendingCall,
  type ReplayContext,
} from "./replay.js";
import type {
  CheckpointTransition,
  JournalCodec,
  JournalOperation,
  JsonValue,
} from "./journalTypes.js";
import {
  MAX_IDENTITY_BINDINGS,
  parseRunnerCheckpoint,
  workerErrorCode,
  type DiscoveryLease,
  type ArchivedStep,
  type FilePlan,
  type GapFilePlan,
  type InventoryIdentity,
  type JobLease,
  type ParserArtifactReuse,
  type RunnerCheckpoint,
  type PdfFilePlan,
  type Utf8FilePlan,
} from "./runnerState.js";
import {
  SPREADSHEET_EXTRACTION_CONFIGURATION_FINGERPRINT,
  SPREADSHEET_PARSER_FINGERPRINT,
  SPREADSHEET_READER_MANIFEST_SHA256,
} from "./spreadsheet.js";
import { parseWorkerResponse } from "./transport.js";
import type {
  DiscoveryFile,
  IdentityBinding,
  PdfDocQaProfile,
  PdfDocQaProviderOriginal,
  PdfDocQaProviderRoot,
  PipelineConfig,
  PipelineRunResult,
  SourceObservation,
  WorkerErrorCode,
  WorkerResponse,
  WorkerTransport,
} from "./types.js";

/**
 * P2-70i3: the `spreadsheet_v1` lane's own profile. Every field a plan needs
 * that belongs to the class comes from the reader, not from configuration: the
 * owner configures one docling profile, and a second class cannot ask the owner
 * to write down fingerprints the worker already knows. The extractor, record
 * schema, normalization and correction fields stay configured, because those
 * describe extraction over retained text and are the same whatever produced it.
 */
type BinaryPlanProfile = Omit<PdfDocQaProfile, "parserProfileId"> & {
  parserProfileId: BinaryParserProfileId;
};

function spreadsheetProfile(
  config: NonNullable<PipelineConfig["pdfDocQa"]>,
): BinaryPlanProfile {
  return {
    ...config.profile,
    parserProfileId: "spreadsheet_v1",
    parserFingerprint: SPREADSHEET_PARSER_FINGERPRINT,
    extractionConfigurationFingerprint:
      SPREADSHEET_EXTRACTION_CONFIGURATION_FINGERPRINT,
    chunkerFingerprint: SPREADSHEET_CHUNKING_FINGERPRINT,
  };
}

const MAX_INVENTORY_PAGES = 128;
const MAX_INVENTORY_ITEMS = 4_096;
const MAX_RECONCILE_PAGES = 256;
const MAX_RESERVATION_ROUNDS = 64;
const MAX_ASSESSMENT_PAGES = 4_096;
const LEASE_SAFETY_MARGIN_MS = 30_000;
const MAX_ARCHIVED_RESERVATION_ROUNDS = 64;
/**
 * ADM-4a. Provider file ids resolved before one pass does anything else.
 *
 * Every lookup is a round trip, so the work in front of a pass that has not yet
 * touched a document has to be bounded. It is bounded twice: a pass plans at
 * most 256 files, and `lookupDropboxFileIds` stops on its own wall-clock
 * budget. This constant is the first of those, held equal to the plan bound on
 * purpose.
 *
 * A smaller count cap was tried and rejected. Splitting one folder rename
 * across passes leaves the leftover files both missing and unmatched, which is
 * what puts a pass into identity recovery -- and recovery discards the very
 * external ids the provider ids just recovered, so it ends in
 * `identity_review_required` and the next pass is forced into recovery again by
 * that same code. Renaming 60 files would work and renaming 70 would wedge.
 * The wall-clock budget is the right bound because rename candidates are asked
 * about first: a budget that runs out can only ever drop a lazy-upgrade
 * lookup, whose path has not moved and which therefore still matches by path.
 */
const MAX_PROVIDER_LOOKUPS_PER_PASS = 256;

/**
 * Mirrors `WORKER_MUTATION_RATE_WINDOW_MS` in
 * packages/convex/convex/models/workers/rateLimit.ts. The worker protocol
 * error carries only a `code` today, not a retry-after hint, so a
 * rate-limited mutation always backs off against this fixed window.
 *
 * ponytail: if the server ever starts returning a retry hint on
 * `rate_limited`, prefer it over this constant in `rateLimitBackoffMs`.
 */
const WORKER_MUTATION_RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ATTEMPTS = 8;

type RateLimitBackoff = { windowMs: number; maxAttempts: number };
const DEFAULT_RATE_LIMIT_BACKOFF: RateLimitBackoff = {
  windowMs: WORKER_MUTATION_RATE_WINDOW_MS,
  maxAttempts: RATE_LIMIT_MAX_ATTEMPTS,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default `assessmentPacingMs` applied when a config omits the field
 * (P2-80k). `processing.assessPage` sends one worker mutation per file
 * (`maxItems: 1`); an unpaced assessment phase for an N-file pass fires N of
 * those mutations back to back, which is by far the largest unpaced burst in
 * a pass (see the `WORKER_MUTATION_RATE_LIMIT` arithmetic in
 * packages/convex/convex/models/workers/rateLimit.ts) and the one most
 * likely to trip the server's per-source rate limit on its own. 200ms keeps
 * that phase's sustained rate (5/s) well under the raised budget without
 * meaningfully slowing a normal backfill, so a burst never starts the
 * backoff in the first place. An explicit `assessmentPacingMs` (including
 * `0`, to disable pacing) always overrides this default.
 */
export const DEFAULT_ASSESSMENT_PACING_MS = 200;

/** Exponential backoff whose `maxAttempts` waits sum to ~`windowMs`. */
function rateLimitBackoffMs(
  attempt: number,
  { windowMs, maxAttempts }: RateLimitBackoff,
): number {
  const shares = 2 ** maxAttempts - 1;
  return Math.max(1, Math.round((windowMs * 2 ** (attempt - 1)) / shares));
}

const SAFE_PARSER_FAILURE_CODES = new Set([
  "unsupported_platform",
  "invalid_input",
  "unsafe_path",
  "executable_mismatch",
  "model_lock_mismatch",
  "destination_exists",
  "sandbox_failed",
  "network_not_denied",
  "process_escape_not_denied",
  "process_timeout",
  "cpu_limit_exceeded",
  "monitor_failed",
  "monitored_rss_exceeded",
  "process_count_exceeded",
  "output_limit_exceeded",
  "conversion_failed",
  "output_invalid",
  "execution_prerequisite_missing",
  "input_digest_mismatch",
  "invalid_opaque_name",
  "runtime_mismatch",
  "model_assets_invalid",
  "conversion_output_invalid",
  "page_limit_exceeded",
  "retained_text_too_large",
  "lossless_output_too_large",
  "bundle_too_large",
  "workbook_invalid",
  "workbook_encrypted",
  "workbook_unsupported",
  "workbook_oversized",
] as const);

/**
 * The subset of `SAFE_PARSER_FAILURE_CODES` that describes a property of
 * the document being parsed rather than the parser's execution environment.
 * `driveArchivedParse` catches these and records a bounded per-document
 * failure (see `recordArchivedParseFailure`) instead of ending the run; the
 * remaining `SAFE_PARSER_FAILURE_CODES` (sandbox, resource, and executable
 * problems) stay run-fatal because they are not specific to one file.
 */
const DOCUMENT_PARSER_FAILURE_CODES = new Set<string>([
  "conversion_failed",
  "conversion_output_invalid",
  "page_limit_exceeded",
  "bundle_too_large",
  // P2-70i3: every workbook refusal is a property of that workbook, so it
  // records a bounded per-document failure rather than ending the pass.
  "workbook_invalid",
  "workbook_encrypted",
  "workbook_unsupported",
  "workbook_oversized",
]);

function parseAttemptsSpent(rows: readonly ProcessingCatalogRow[]): number {
  return rows.reduce(
    (total, row) => total + (row.parseFailure?.attempts ?? 0),
    0,
  );
}

/**
 * P2-31f. Bumped whenever a build changes how it handles one of
 * `ADMISSION_BLOCK_CODES`, which releases every item parked by an earlier
 * build so the new handling gets a turn.
 */
const PARK_HANDLING_VERSION = 1;

/** How long a parked item waits before the next automatic retry. */
const PARK_RETRY_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * Fingerprints this build's handling of the parkable codes.
 *
 * ponytail: one fingerprint over the whole list, so adding or re-handling any
 * code releases items parked on every other code too. They are simply retried
 * and re-park if nothing changed for them, which costs one pass and no server
 * attempt. Split per code if that ever gets expensive.
 */
const RUNNER_PARK_CAPABILITY = sha256Json({
  version: PARK_HANDLING_VERSION,
  codes: [...ADMISSION_BLOCK_CODES].sort(),
}).slice(0, 16);

function parkable(error: unknown): AdmissionBlockCode | undefined {
  const code =
    error instanceof PipelineWorkerError || error instanceof ArchiveCatalogError
      ? error.code
      : undefined;
  return ADMISSION_BLOCK_CODES.includes(code as AdmissionBlockCode)
    ? (code as AdmissionBlockCode)
    : undefined;
}

/**
 * Whether a recorded marker still parks its item. A marker written by a build
 * that handled these codes differently never holds, so a new build releases
 * what an old one parked; otherwise the item is retried once per
 * `PARK_RETRY_INTERVAL_MS` until its attempts run out, and then waits for new
 * bytes, a new build, or `run --retry-parked`.
 */
function admissionBlockHolds(block: AdmissionBlock, now = Date.now()): boolean {
  if (block.runnerCapability !== RUNNER_PARK_CAPABILITY) return false;
  if (block.attempts >= MAX_ADMISSION_BLOCK_ATTEMPTS) return true;
  return now < block.blockedAt + PARK_RETRY_INTERVAL_MS;
}

/**
 * The server refuses a provider original declaration whose verification or
 * locator readback is older than `PROVIDER_VERIFICATION_MAX_AGE_MS` (ten
 * minutes) or further ahead than `PROVIDER_VERIFICATION_FUTURE_SKEW_MS` (five
 * minutes); see `validateProviderOriginalDeclaration` in
 * `@repo/kith-store`. The worker keeps a minute of margin on both ends so a
 * declaration it decides to send survives the admit round trip.
 */
function providerProofFresh(
  provider: NonNullable<OriginalCatalogRow["providerOriginal"]>,
  now = Date.now(),
): boolean {
  const verifiedAt = provider.verified?.verifiedAt;
  const readbackVerifiedAt = provider.locator.readbackVerifiedAt;
  if (verifiedAt === undefined || readbackVerifiedAt === undefined)
    return false;
  return [verifiedAt, readbackVerifiedAt].every(
    (at) => at >= now - 9 * 60_000 && at <= now + 4 * 60_000,
  );
}

/**
 * ADM-4c. The account fields plus the folder bound to this plan's root, as one
 * object, for the two drivers that work on an original already carrying
 * provider state.
 *
 * Reaching either of those with an unbound root means an original was given a
 * provider binding under a configuration that no longer binds its root, so
 * `provider_original_root_mismatch` still stands. A root that was never bound
 * never gets provider state in the first place (`createArchivedIntents`), so it
 * never arrives here.
 */
function providerBinding(
  account: PdfDocQaProviderOriginal,
  rootAlias: string,
): PdfDocQaProviderOriginal & PdfDocQaProviderRoot {
  const root = providerRootFor(account, rootAlias);
  if (!root) throw new PipelineWorkerError("provider_original_root_mismatch");
  return { ...account, ...root };
}

/**
 * ADM-4c review. Whether a remembered item's location is still one this pass
 * reads: its root is in the list, and inside a selected subtree when the root
 * has any.
 */
function watchedLocation(roots: SafeRoot[], binding: IdentityBinding): boolean {
  const root = roots.find((candidate) => candidate.alias === binding.rootAlias);
  if (!root) return false;
  if (root.includePrefixes === undefined) return true;
  return root.includePrefixes.some(
    (prefix) =>
      binding.relativePath === prefix ||
      binding.relativePath.startsWith(`${prefix}${sep}`),
  );
}

/**
 * ADM-4c review. The share of what the journal remembers that may leave the
 * watched set in one pass before the pass refuses instead: a quarter, and at
 * least one.
 *
 * The first cut of this had a floor of ten, which could never trip for an
 * account of ten items or fewer -- which is the owner's account today, and
 * exactly when a mistake is least recoverable because there is nothing else
 * left to notice it by.
 */
function retirementCircuitBreaker(remembered: number): number {
  return Math.max(1, Math.ceil(remembered * 0.25));
}

/**
 * ADM-4c review. A watched root whose contents collapsed, rather than whose
 * location changed.
 *
 * `watchedLocation` catches a root leaving the list. It cannot catch a root
 * that is still listed, still resolves, and is simply *empty* -- a disk that
 * did not mount, a Dropbox folder mid-sync on a host the watcher just moved
 * to, a folder the owner renamed on the provider side. Discovery reports no
 * files, the scan opens with none, and `reconcileWorkerScan` retires every
 * document under it.
 *
 * Two shapes, per root, against what the journal remembers for that root:
 * it held items and now holds no files at all, or more than half of its
 * remembered items are gone and at least three of them. Three so a folder of
 * four losing two is an ordinary edit rather than a standing refusal; a half
 * so a large folder cannot quietly lose most of itself.
 *
 * A root with nothing remembered cannot collapse: a brand-new empty folder is
 * a folder with nothing in it yet. Nor can a root the pass no longer watches,
 * which `watchedLocation` and the retirement breaker above already answer for.
 */
function collapsedRoots(
  roots: SafeRoot[],
  prior: IdentityBinding[],
  plans: FilePlan[],
  matched: Map<FilePlan, IdentityBinding>,
): string[] {
  // Only roots this pass actually looks at. A root that left the list, or an
  // item narrowed out of one, is the other breaker's business, and counting
  // it here would refuse a removal the operator has already confirmed.
  const remembered = new Map<string, number>();
  for (const binding of prior) {
    if (!watchedLocation(roots, binding)) continue;
    remembered.set(
      binding.rootAlias,
      (remembered.get(binding.rootAlias) ?? 0) + 1,
    );
  }
  const seen = new Map<string, number>();
  const kept = new Map<string, number>();
  for (const plan of plans) {
    seen.set(plan.rootAlias, (seen.get(plan.rootAlias) ?? 0) + 1);
    if (matched.has(plan)) {
      kept.set(plan.rootAlias, (kept.get(plan.rootAlias) ?? 0) + 1);
    }
  }
  const collapsed: string[] = [];
  for (const [rootAlias, held] of remembered) {
    if (held < 1) continue;
    const found = seen.get(rootAlias) ?? 0;
    if (found === 0) {
      collapsed.push(rootAlias);
      continue;
    }
    const lost = held - (kept.get(rootAlias) ?? 0);
    if (lost >= 3 && lost * 2 > held) collapsed.push(rootAlias);
  }
  return collapsed.sort();
}

/** ADM-6a. What the server says it holds, per root alias and in total. */
type ServerItemCounts = {
  liveItems: number;
  roots: Array<{ rootAlias: string; liveItems: number }>;
  truncated: boolean;
};

/** ADM-6a. One root's two counts: the journal's and the server's. */
type RootItemGap = { rootAlias: string; remembered: number; held: number };

/**
 * ADM-6a. A journal that does not know what the server holds.
 *
 * Both ADM-4c breakers ask the same question -- "is this pass about to retire
 * a lot?" -- of the same witness, the journal. A host-move rehearsal showed
 * what that misses. A watcher started with a stale copy of the journal
 * remembered 29 items where the server held 687 for the same source. All 29
 * matched files on disk, so nothing was missing, nothing was collapsed,
 * `retiring` was 0, and the server's reconcile -- which retires every item the
 * scan did not carry, not every item the journal forgot -- marked 658 items
 * unavailable. The journal cannot report a loss it has no memory of. Only the
 * server can.
 *
 * So the third breaker asks the server. Per root, because two roots can err in
 * opposite directions and cancel in a total, and because the innocent case
 * this must not refuse -- the owner adds a folder -- is a root where both
 * sides are zero.
 *
 * The rule: for a root this pass enumerates, take what the server holds live
 * under it and what the journal remembers anywhere under it. Refuse when the
 * server is ahead by at least three items *and* by at least a twentieth of
 * what it holds. Three is `collapsedRoots`' floor, so a folder of four does
 * not stand on one item's difference.
 *
 * Review of this change: the share was a quarter, taken from
 * `retirementCircuitBreaker` read the other way round, and it left a gap the
 * rehearsal's own numbers fit through. A server holding 687 items against a
 * journal remembering 600 is 87 documents minted fresh and 87 retired, and a
 * quarter of 687 is 172, so that pass opened in normal mode and neither ADM-4c
 * breaker saw it either. A twentieth refuses it. The two circuit breakers
 * bound what one pass may retire *from a journal that knows what it holds*; a
 * journal that disagrees with the server about the size of the source is not
 * that, so it does not get that budget.
 *
 * Three deliberate asymmetries:
 *
 *   * Every remembered binding under the alias counts, not only the ones
 *     inside the current include-prefixes. Narrowing a root leaves its other
 *     bindings remembered and its other items retired, so counting only the
 *     narrowed ones would read a healthy narrowed root as a journal that had
 *     forgotten the rest. What a narrowing retires is the first breaker's
 *     business, and it sees it.
 *   * A journal that knows MORE than the server is never refused. That is
 *     ordinary: an item retired in an earlier pass keeps its binding.
 *   * A root the server does not name holds nothing, unless the list was
 *     truncated, in which case the root is unknown and is skipped. Unknown is
 *     not zero, and a guard that guesses is worse than a guard that abstains.
 *
 * Items under an alias this pass does not enumerate are not compared here.
 * Those are what `watchedLocation` and the retirement breaker are for, and
 * counting them would refuse a root removal the owner has already confirmed.
 */
function journalBehindServer(
  roots: SafeRoot[],
  prior: IdentityBinding[],
  counts: ServerItemCounts,
): { behind: RootItemGap[]; compared: RootItemGap[] } {
  const remembered = new Map<string, number>();
  for (const binding of prior) {
    remembered.set(
      binding.rootAlias,
      (remembered.get(binding.rootAlias) ?? 0) + 1,
    );
  }
  const held = new Map(
    counts.roots.map((root) => [root.rootAlias, root.liveItems] as const),
  );
  const compared: RootItemGap[] = [];
  const behind: RootItemGap[] = [];
  for (const root of roots) {
    const server = held.get(root.alias) ?? (counts.truncated ? undefined : 0);
    if (server === undefined) continue;
    const journal = remembered.get(root.alias) ?? 0;
    const entry = { rootAlias: root.alias, remembered: journal, held: server };
    compared.push(entry);
    const gap = server - journal;
    if (gap >= 3 && gap >= Math.max(3, Math.ceil(server / 20))) {
      behind.push(entry);
    }
  }
  // The widest gap first, so the one refusal names the root that would have
  // cost the most. Alias order breaks ties so the message does not depend on
  // config order. `compared` stays in the order the roots were given: it is
  // every root this pass weighed, which is what an operator who overrides the
  // refusal needs to have been told.
  behind.sort(
    (left, right) =>
      right.held - right.remembered - (left.held - left.remembered) ||
      (left.rootAlias < right.rootAlias ? -1 : 1),
  );
  return { behind, compared };
}

/** ADM-4c. What one pass will tell the server about one of its roots. */
type SourceRootReport = {
  sourceRootId: string;
  state: SourceRootReportState;
  rootAlias?: string;
  relativePath?: string;
  providerFolderId?: string;
};

type ArchivedCheckpoint = Extract<RunnerCheckpoint, { phase: "archived" }>;

function stableUuid(...parts: readonly unknown[]): string {
  const bytes = createHash("sha256")
    .update("kithmind-pdf-runner-id:v1\0")
    .update(JSON.stringify(parts))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha256Json(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

/** The class's media type. Both sides derive it from the class, never both. */
function planMediaType(plan: PdfFilePlan): BinaryMediaType {
  return BINARY_CLASSES[plan.parserProfileId].mediaType;
}

function archivedIdentity(
  checkpoint: ArchivedCheckpoint,
  plan: PdfFilePlan,
): ArchivedWorkIdentity {
  if (
    plan.sourceItemId === undefined ||
    plan.observationEpoch === undefined ||
    plan.processingEpoch === undefined
  ) {
    throw new PipelineWorkerError("archived_parent_missing");
  }
  return {
    sourceItemId: plan.sourceItemId,
    scanId: checkpoint.scanId,
    observationEpoch: plan.observationEpoch,
    processingEpoch: plan.processingEpoch,
    contentHash: plan.sha256,
    byteLength: plan.byteLength,
    mediaType: planMediaType(plan),
    parserProfileId: plan.parserProfileId,
    parserFingerprint: plan.parserFingerprint,
    extractionConfigurationFingerprint: plan.extractionConfigurationFingerprint,
    extractorFingerprint: plan.extractorFingerprint,
    recordSchemaFingerprint: plan.recordSchemaFingerprint,
    normalizationFingerprint: plan.normalizationFingerprint,
    chunkerFingerprint: plan.chunkerFingerprint,
    correctionRevision: plan.correctionRevision,
  };
}

/**
 * P2-31d. The identity `driveArchivedLookupOriginal` addresses its read-only
 * lookup with, for whatever original the checkpoint is currently on. The
 * server resolves that lookup through `resolveCurrentArchivedWork` and then
 * `requireIdentity`, which match a live `worker_discovery_work` row field for
 * field, so the whole identity is required and only the scan plan carries it:
 * the catalog rows hold the scan, observation epoch, hash and byte length but
 * none of the six parser and extraction fingerprints, the correction revision
 * or the processing epoch. An arbitrary catalog row therefore cannot be asked
 * about; the checkpoint's own original can.
 */
export function archivedCheckpointIdentity(
  checkpoint: RunnerCheckpoint,
): ArchivedWorkIdentity | undefined {
  if (checkpoint.phase !== "archived") return undefined;
  const plan = checkpoint.files[checkpoint.pdfIndex];
  if (!plan || !isPdfPlan(plan)) return undefined;
  try {
    return archivedIdentity(checkpoint, plan);
  } catch {
    // `archived_parent_missing`: the plan has no parent yet, so no admission
    // against it can exist and there is nothing to ask the server about.
    return undefined;
  }
}

/**
 * P2-31e. `recordOriginalCloud` writes only when the row holds no receipt, and
 * nothing ever compared a later server answer against one already stored. The
 * whole pipeline reads `cloud.sourceRevisionId` as naming the admission the
 * server is serving, and `reusableProcessingRow` settles an ambiguous
 * processing history by it, so a silent disagreement would be read as a fact.
 * It should be unreachable, since a revision is immutable once admitted, and
 * the point of checking is that reaching it means one of those beliefs is
 * wrong. Callers end the scan on it rather than throwing, so a fail-closed
 * refusal never leaves an answered request unresolved.
 */
function admissionRevisionConflict(
  original: OriginalCatalogRow,
  value: Record<string, unknown>,
): boolean {
  return (
    original.cloud !== undefined &&
    original.cloud.sourceRevisionId !==
      text(value.sourceRevisionId, "source_revision_id")
  );
}

/**
 * P2-104e. The journaled discovery lease, while the server will still honour
 * it. A step that walks a document back through its earlier steps must carry
 * a live lease with it: `discovery.reserveArchived` under a fresh request id
 * is refused by that very lease until it expires, and each lease it does hand
 * out spends one of the row's discovery attempts.
 */
function liveDiscoveryLease(
  checkpoint: ArchivedCheckpoint,
  now = Date.now(),
): ArchivedCheckpoint["discoveryLease"] {
  const lease = checkpoint.discoveryLease;
  return lease && lease.leaseExpiresAt > now + LEASE_SAFETY_MARGIN_MS
    ? lease
    : undefined;
}

function archivedBase(
  checkpoint: ArchivedCheckpoint,
  updates: Partial<ArchivedCheckpoint> = {},
): ArchivedCheckpoint {
  return { ...checkpoint, ...updates, version: 1, phase: "archived" };
}

function captureFromRows(
  config: NonNullable<PipelineConfig["pdfDocQa"]>,
  original: OriginalCatalogRow,
  processing: ProcessingCatalogRow,
): CapturedPdf {
  if (!processing.capture) throw new PipelineWorkerError("capture_missing");
  return {
    version: 1,
    captureId: processing.captureIntent.captureId,
    captureDirectory: {
      path: config.captureDirectory,
      ...processing.captureIntent.directory,
    },
    // The captured file's name comes from the class the catalog row records as
    // the original's media type, so a resumed run rebuilds the same path.
    path: join(
      config.captureDirectory,
      captureFileName(
        processing.captureIntent.captureId,
        original.origin.mediaType,
      ),
    ),
    sha256: original.origin.sha256,
    byteLength: original.origin.byteLength,
    sourceModifiedAt: processing.capture.sourceModifiedAt,
    device: processing.capture.device,
    inode: processing.capture.inode,
  };
}

export function captureCatalogRecord(capture: CapturedPdf): NonNullable<
  ProcessingCatalogRow["capture"]
> & {
  directory: { device: number; inode: number };
} {
  return {
    opaqueName: capture.captureId,
    device: capture.device,
    inode: capture.inode,
    sha256: capture.sha256,
    byteLength: capture.byteLength,
    sourceModifiedAt: capture.sourceModifiedAt,
    directory: {
      device: capture.captureDirectory.device,
      inode: capture.captureDirectory.inode,
    },
  };
}

export function parserOutputIntentCore(
  intent: ProcessingCatalogRow["parserIntent"],
): ParserOutputIntent {
  return {
    outputId: intent.outputId,
    outputRoot: intent.outputRoot,
    outputDirectory: intent.outputDirectory,
  };
}

export function parserOutputCatalogRecord(
  artifacts: DurableParserOutputArtifacts,
): DurableParserOutput {
  const { path: rawPath, ...rawArtifact } = artifacts.rawArtifact;
  const { path: bundlePath, ...normalizedBundle } = artifacts.normalizedBundle;
  return {
    ...artifacts,
    rawArtifact: {
      ...rawArtifact,
      opaqueName: basename(rawPath),
      mediaType: rawArtifact.mediaType,
    },
    normalizedBundle: {
      ...normalizedBundle,
      opaqueName: basename(bundlePath),
      mediaType: "application/json",
    },
  };
}

export function preparedArchiveCatalogRecord(prepared: PreparedAgeObject) {
  const { tempPath, ...record } = prepared;
  return { ...record, tempName: basename(tempPath) };
}

export function publishedArchiveCatalogRecord(published: PublishedAgeObject) {
  const { objectPath: _objectPath, ...record } = published;
  return record;
}

async function privateDirectoryIdentity(path: string) {
  const before = await lstat(path);
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  ) {
    throw new PipelineWorkerError("protected_directory_invalid");
  }
  return { device: before.dev, inode: before.ino };
}
class PipelineWorkerError extends Error {
  constructor(readonly code: string) {
    super("Pipeline worker operation failed");
  }
}

class PipelineRetryableError extends PipelineWorkerError {}

const ENTRY_INDEX = Symbol("entryIndex");

/** Tags a thrown value with the page-relative entry index that produced it,
 * so an unclassified `runSafely` failure can name which entry broke instead
 * of just the phase. Best-effort: non-object throws (a string, for example)
 * are returned unchanged. */
function tagEntryIndex(error: unknown, index: number): unknown {
  if (error && typeof error === "object") {
    (error as Record<PropertyKey, unknown>)[ENTRY_INDEX] = index;
  }
  return error;
}

function entryIndexOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as Record<PropertyKey, unknown>)[ENTRY_INDEX];
  return typeof value === "number" ? value : undefined;
}

const MAX_FAILURE_MESSAGE_CHARS = 300;

/** Replaces any absolute-path-looking token with just its final path
 * segment, so a failure message never carries more of the filesystem layout
 * than the relative path already implies. */
function redactAbsolutePaths(message: string): string {
  return message.replace(/\/[^\s"'()]+/g, (match) => {
    const base = match.slice(match.lastIndexOf("/") + 1);
    return base.length > 0 ? `<path:${base}>` : "<path>";
  });
}

/** Sanitized, bounded description of a `runSafely` failure: never document
 * text (errors here never carry file contents, only shapes and codes), and
 * no path detail beyond a relative path's final segment. */
function describeUnsafeFailure(
  error: unknown,
  phase: string,
): { phase: string; entryIndex?: number; name: string; message: string } {
  const entryIndex = entryIndexOf(error);
  const name = error instanceof Error ? error.name : typeof error;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = redactAbsolutePaths(rawMessage).slice(
    0,
    MAX_FAILURE_MESSAGE_CHARS,
  );
  return {
    phase,
    ...(entryIndex === undefined ? {} : { entryIndex }),
    name,
    message,
  };
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function asWorkerResponse(value: JsonValue): WorkerResponse {
  return value as WorkerResponse;
}

function isWorkerError(value: WorkerResponse): value is {
  error: { code: WorkerErrorCode };
} {
  return (
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "code" in value.error
  );
}

function object(
  value: WorkerResponse,
  operation: string,
): Record<string, unknown> {
  if (isWorkerError(value)) throw new PipelineWorkerError(value.error.code);
  if (value.operation !== operation) {
    throw new PipelineWorkerError("worker_failed");
  }
  return value;
}

function success(value: WorkerResponse): Record<string, unknown> | undefined {
  return isWorkerError(value) ? undefined : value;
}

function errorCode(value: WorkerResponse): WorkerErrorCode | undefined {
  return isWorkerError(value) ? value.error.code : undefined;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PipelineWorkerError(`${label}_invalid`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PipelineWorkerError(`${label}_invalid`);
  }
  return value as number;
}

/**
 * P2-104d. Reads `existingParserArtifact` off a not-found processing lookup.
 * `undefined` when the server offered nothing, which is also how the
 * checkpoint records "archive this document's parser output yourself".
 */
function parserArtifactReuse(
  value: Record<string, unknown>,
): ParserArtifactReuse | undefined {
  const offered = value.existingParserArtifact;
  if (offered === undefined) return undefined;
  if (!offered || typeof offered !== "object" || Array.isArray(offered)) {
    throw new PipelineWorkerError("existing_parser_artifact_invalid");
  }
  const row = offered as Record<string, unknown>;
  return {
    parserArtifactId: text(row.parserArtifactId, "parser_artifact_id"),
    primaryReceiptId: text(row.primaryReceiptId, "primary_receipt_id"),
    primaryBindingEpoch: integer(
      row.primaryBindingEpoch,
      "primary_binding_epoch",
    ),
    backupReceiptId: text(row.backupReceiptId, "backup_receipt_id"),
    backupBindingEpoch: integer(row.backupBindingEpoch, "backup_binding_epoch"),
  };
}

function records(value: unknown, label: string): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) => !entry || typeof entry !== "object" || Array.isArray(entry),
    )
  ) {
    throw new PipelineWorkerError(`${label}_invalid`);
  }
  return value as Record<string, unknown>[];
}

/** ADM-9. `WORKER_PASS_CODE` in the protocol, applied before the send. */
const PASS_CODE = /^[a-z0-9_]{1,64}$/;

/**
 * ADM-9. The pass-outcome report's own deadline, well under the transport's
 * 30s: it runs after the pass is already decided, so every second of it is a
 * second added to the pass's return and to a SIGTERM shutdown.
 */
const PASS_OUTCOME_TIMEOUT_MS = 5_000;

/**
 * ADM-9. Said once per process, not once per pass.
 *
 * A server that will never accept this operation -- one running older code
 * than the watcher -- refuses every report there will ever be. Warning on each
 * one turns a five-minute watch loop into a log nobody reads.
 */
let passOutcomeWarned = false;
function warnPassOutcomeOnce(reason: string): void {
  if (passOutcomeWarned) return;
  passOutcomeWarned = true;
  console.warn(
    `[pipeline] the pass outcome could not be reported (${reason}); not repeating this warning`,
  );
}

function request(
  config: PipelineConfig,
  operation:
    | JournalOperation
    | "source.status"
    | "source.roots"
    | "source.itemCounts"
    | "source.rootReport"
    | "diagnostics.passOutcome",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocolVersion: 1,
    operation,
    spaceId: config.spaceId,
    sourceAccountId: config.sourceAccountId,
    ...extra,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
    .join(",")}}`;
}

function equalJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function checkpointActive(checkpoint: RunnerCheckpoint): boolean {
  return checkpoint.phase === "terminal"
    ? checkpoint.credentialSessionActive
    : checkpoint.phase !== "idle";
}

function parseDurableResult(
  operation: JournalOperation,
  value: unknown,
): JsonValue {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "error" in value
  ) {
    const root = value as Record<string, unknown>;
    if (Object.keys(root).length !== 1) {
      throw new Error("safe error shape is invalid");
    }
    const nested = root.error;
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      throw new Error("safe error shape is invalid");
    }
    const row = nested as Record<string, unknown>;
    if (Object.keys(row).length !== 1 || !("code" in row)) {
      throw new Error("safe error shape is invalid");
    }
    return { error: { code: workerErrorCode(row.code) } };
  }
  return json(parseWorkerResponse(JSON.stringify(value), operation));
}

export const initialCheckpoint: RunnerCheckpoint = {
  version: 1,
  phase: "idle",
};

export const journalCodec: JournalCodec<RunnerCheckpoint, JsonValue> = {
  parseCheckpoint: parseRunnerCheckpoint,
  parseResult: parseDurableResult,
};

function fileKey(value: { rootAlias: string; relativePath: string }): string {
  return `${value.rootAlias}\0${value.relativePath}`;
}

function filePlan(file: DiscoveryFile): FilePlan {
  return {
    rootAlias: file.rootAlias,
    relativePath: file.relativePath,
    sourceModifiedAt: file.sourceModifiedAt,
    sha256: file.sha256,
    byteLength: file.byteLength,
  };
}

function observationPlan(
  observation: SourceObservation,
  config: NonNullable<PipelineConfig["pdfDocQa"]>,
): FilePlan {
  if (observation.kind === "utf8") return filePlan(observation.file);
  if (observation.kind === "gap") {
    return {
      rootAlias: observation.gap.rootAlias,
      relativePath: observation.gap.relativePath,
      sourceModifiedAt: observation.gap.sourceModifiedAt,
      kind: "gap",
      code: observation.gap.code,
    };
  }
  const profile: BinaryPlanProfile =
    observation.file.mediaType === BINARY_CLASSES.spreadsheet_v1.mediaType
      ? spreadsheetProfile(config)
      : config.profile;
  return {
    rootAlias: observation.file.rootAlias,
    relativePath: observation.file.relativePath,
    sourceModifiedAt: observation.file.sourceModifiedAt,
    kind: "pdf",
    sha256: observation.file.sha256,
    byteLength: observation.file.byteLength,
    parserProfileId: profile.parserProfileId,
    parserFingerprint: profile.parserFingerprint,
    extractionConfigurationFingerprint:
      profile.extractionConfigurationFingerprint,
    extractorFingerprint: profile.extractorFingerprint,
    recordSchemaFingerprint: profile.recordSchemaFingerprint,
    normalizationFingerprint: profile.normalizationFingerprint,
    chunkerFingerprint: profile.chunkerFingerprint,
    correctionRevision: profile.correctionRevision,
    ...(observation.file.permissionsRestricted === undefined
      ? {}
      : {
          permissionsRestricted: observation.file.permissionsRestricted,
          encryptionRevision: observation.file.encryptionRevision,
        }),
  };
}

function isUtf8Plan(plan: FilePlan): plan is Utf8FilePlan {
  return !isPdfPlan(plan) && !isGapPlan(plan);
}

function isPdfPlan(plan: FilePlan): plan is PdfFilePlan {
  return "kind" in plan && plan.kind === "pdf";
}

function isGapPlan(plan: FilePlan): plan is GapFilePlan {
  return "kind" in plan && plan.kind === "gap";
}

function scanEntry(
  plan: FilePlan,
  mode: "normal" | "identity_recovery",
): Record<string, unknown> {
  const entry = {
    ...(mode === "identity_recovery" || plan.externalId === undefined
      ? {}
      : { externalId: plan.externalId }),
    uri: toFsUri(plan.rootAlias, plan.relativePath),
    title: basename(plan.relativePath),
    sourceModifiedAt: plan.sourceModifiedAt,
  };
  if (isPdfPlan(plan)) {
    return {
      ...entry,
      content: {
        status: "ready_binary_v1",
        sha256: plan.sha256,
        byteLength: plan.byteLength,
        mediaType: planMediaType(plan),
        parserProfileId: plan.parserProfileId,
        parserFingerprint: plan.parserFingerprint,
        extractionConfigurationFingerprint:
          plan.extractionConfigurationFingerprint,
        extractorFingerprint: plan.extractorFingerprint,
        recordSchemaFingerprint: plan.recordSchemaFingerprint,
        normalizationFingerprint: plan.normalizationFingerprint,
        chunkerFingerprint: plan.chunkerFingerprint,
        correctionRevision: plan.correctionRevision,
        ...(plan.permissionsRestricted === undefined
          ? {}
          : {
              permissionsRestricted: plan.permissionsRestricted,
              encryptionRevision: plan.encryptionRevision,
            }),
      },
    };
  }
  if (isGapPlan(plan)) {
    return { ...entry, content: { status: "gap", code: plan.code } };
  }
  if (!isUtf8Plan(plan)) {
    throw new PipelineWorkerError("scan_plan_invalid");
  }
  return {
    ...entry,
    content: {
      status: "ready",
      sha256: plan.sha256,
      byteLength: plan.byteLength,
    },
  };
}

function samePlan(file: DiscoveryFile, plan: FilePlan): boolean {
  return (
    isUtf8Plan(plan) &&
    file.rootAlias === plan.rootAlias &&
    file.relativePath === plan.relativePath &&
    file.sourceModifiedAt === plan.sourceModifiedAt &&
    file.sha256 === plan.sha256 &&
    file.byteLength === plan.byteLength &&
    file.uri === toFsUri(plan.rootAlias, plan.relativePath)
  );
}

function sameSnapshot(files: DiscoveryFile[], plans: FilePlan[]): boolean {
  return (
    files.length === plans.length &&
    files.every((file, index) => {
      const plan = plans[index];
      return plan !== undefined && samePlan(file, plan);
    })
  );
}

function sameObservationPlan(
  observation: SourceObservation,
  plan: FilePlan,
  config: NonNullable<PipelineConfig["pdfDocQa"]>,
): boolean {
  const current = observationPlan(observation, config);
  const observedPlan = { ...plan } as Record<string, unknown>;
  for (const field of [
    "externalId",
    "providerFileId",
    "sourceItemId",
    "observationEpoch",
    "processingEpoch",
    "discoveryState",
  ]) {
    delete observedPlan[field];
  }
  return equalJson(current, observedPlan);
}

export function bindingsFromScan(checkpoint: {
  files: FilePlan[];
  missingBindings: IdentityBinding[];
}): IdentityBinding[] {
  const byExternalId = new Map<string, IdentityBinding>();
  for (const binding of checkpoint.missingBindings) {
    byExternalId.set(binding.externalId, binding);
  }
  for (const file of checkpoint.files) {
    if (!file.externalId) continue;
    byExternalId.set(file.externalId, {
      rootAlias: file.rootAlias,
      relativePath: file.relativePath,
      externalId: file.externalId,
      ...(file.providerFileId === undefined
        ? {}
        : { providerFileId: file.providerFileId }),
    });
  }
  const result = [...byExternalId.values()].sort((left, right) =>
    Buffer.compare(Buffer.from(fileKey(left)), Buffer.from(fileKey(right))),
  );
  // ADM-4c: bindings are bounded by `MAX_IDENTITIES`, not by the plan count.
  // The union is what is here now plus what is remembered and gone, and a
  // removed root leaves a whole root's worth of the second kind behind.
  if (result.length > MAX_IDENTITY_BINDINGS) {
    throw new PipelineWorkerError("identity_capacity_exceeded");
  }
  const paths = new Set<string>();
  for (const binding of result) {
    const key = fileKey(binding);
    if (paths.has(key)) {
      throw new PipelineWorkerError("identity_binding_conflict");
    }
    paths.add(key);
  }
  return result;
}

export function findDiscoveryPlan(
  files: FilePlan[],
  uri: string,
): FilePlan | undefined {
  return files.find(
    (candidate) => toFsUri(candidate.rootAlias, candidate.relativePath) === uri,
  );
}

function plannedTerminal(
  checkpoint: Extract<RunnerCheckpoint, { phase: "scan_begin" }>,
  code: string,
): RunnerCheckpoint {
  return {
    version: 1,
    phase: "terminal",
    outcome: "failed",
    credentialSessionActive: true,
    code,
    scanned: checkpoint.files.length,
    published: 0,
    bindings: bindingsFromScan(checkpoint),
  };
}

function stickyTerminal(checkpoint: RunnerCheckpoint): boolean {
  return (
    checkpoint.phase === "terminal" && checkpoint.code === "request_conflict"
  );
}

function scanTerminal(
  checkpoint: Extract<
    RunnerCheckpoint,
    {
      phase:
        | "inventory"
        | "append"
        | "seal_check"
        | "seal"
        | "reconcile"
        | "discovery_reserve"
        | "discovery_admit"
        | "archived";
    }
  >,
  outcome: "complete" | "incomplete" | "failed",
  code: string,
  credentialSessionActive = false,
): RunnerCheckpoint {
  return {
    version: 1,
    phase: "terminal",
    outcome,
    credentialSessionActive,
    code,
    scanId: checkpoint.scanId,
    scanned: checkpoint.files.length,
    published:
      "archivedPublished" in checkpoint &&
      typeof checkpoint.archivedPublished === "number"
        ? checkpoint.archivedPublished
        : 0,
    bindings: bindingsFromScan(checkpoint),
  };
}

function processingTerminal(
  checkpoint: Extract<
    RunnerCheckpoint,
    {
      phase:
        | "jobs_reserve"
        | "jobs_renew"
        | "jobs_stage"
        | "jobs_activate"
        | "jobs_fail"
        | "assess_status"
        | "assess_begin"
        | "assess_page";
    }
  >,
  outcome: "complete" | "incomplete" | "failed",
  code: string | undefined,
  assessmentId?: string,
  credentialSessionActive = false,
): RunnerCheckpoint {
  return {
    version: 1,
    phase: "terminal",
    outcome,
    credentialSessionActive,
    ...(code === undefined ? {} : { code }),
    scanId: checkpoint.scanId,
    scanned: checkpoint.scanned,
    published: checkpoint.published,
    bindings: checkpoint.bindings,
    ...(assessmentId === undefined ? {} : { assessmentId }),
  };
}

function processingBase(checkpoint: {
  scanId: string;
  scanned: number;
  published: number;
  bindings: IdentityBinding[];
}) {
  return {
    scanId: checkpoint.scanId,
    scanned: checkpoint.scanned,
    published: checkpoint.published,
    bindings: checkpoint.bindings,
  };
}

function activeScanBase(checkpoint: {
  mode: "normal" | "identity_recovery";
  scanId: string;
  inventoryEpoch: number;
  manifestVersion: number;
  files: FilePlan[];
  missingBindings: IdentityBinding[];
}) {
  return {
    mode: checkpoint.mode,
    scanId: checkpoint.scanId,
    inventoryEpoch: checkpoint.inventoryEpoch,
    manifestVersion: checkpoint.manifestVersion,
    files: checkpoint.files,
    missingBindings: checkpoint.missingBindings,
  };
}

function afterJob(
  checkpoint: Extract<
    RunnerCheckpoint,
    { phase: "jobs_renew" | "jobs_stage" | "jobs_activate" | "jobs_fail" }
  >,
  published: number,
): RunnerCheckpoint {
  const nextIndex = checkpoint.index + 1;
  if (nextIndex < checkpoint.jobs.length) {
    return {
      version: 1,
      phase: "jobs_renew",
      ...processingBase({ ...checkpoint, published }),
      round: checkpoint.round,
      jobs: checkpoint.jobs,
      index: nextIndex,
    };
  }
  return {
    version: 1,
    phase: "jobs_reserve",
    ...processingBase({ ...checkpoint, published }),
    round: checkpoint.round + 1,
  };
}

function afterDiscoveryTarget(
  checkpoint: Extract<RunnerCheckpoint, { phase: "discovery_admit" }>,
): RunnerCheckpoint {
  const nextIndex = checkpoint.index + 1;
  return nextIndex < checkpoint.targets.length
    ? { ...checkpoint, index: nextIndex }
    : {
        version: 1,
        phase: "discovery_reserve",
        ...activeScanBase(checkpoint),
        round: checkpoint.round + 1,
        ...(checkpoint.archivedPublished === undefined
          ? {}
          : { archivedPublished: checkpoint.archivedPublished }),
      };
}

function resultFromTerminal(
  checkpoint: Extract<RunnerCheckpoint, { phase: "terminal" }>,
): PipelineRunResult {
  return {
    state: checkpoint.outcome,
    ...(checkpoint.code === undefined ? {} : { code: checkpoint.code }),
    scanned: checkpoint.scanned,
    published: checkpoint.published,
  };
}

/**
 * ADM-4a. Where the watcher gets a stable file id for a path, and which root
 * those ids belong to. Everything outside that root keeps path identity.
 */
export type ProviderFileIdSource = {
  rootAlias: string;
  lookup(relativePaths: string[]): Promise<Map<string, string>>;
};

export class PipelineRunner {
  private preparedPdfProfile: PreparedPdfDocQaProfile | undefined;
  /** ADM-4c review: resolved once per pass; see `currentRoots`. */
  private effectiveRoots: SafeRoot[] | undefined;
  /** ADM-4c review: opened once per pass; see `scanCache`. */
  private openScanCache: JournalScanCache | undefined;
  private pendingRootReports: SourceRootReport[] = [];
  private archiveCatalog: ArchiveCatalog | undefined;
  /** P2-31f: receipts `--operator-clear` has retired in this pass. */
  private operatorClears = 0;

  constructor(
    private readonly config: PipelineConfig,
    private readonly journal: Journal<RunnerCheckpoint, JsonValue>,
    private readonly transport: WorkerTransport,
    private readonly rateLimitBackoff: RateLimitBackoff = DEFAULT_RATE_LIMIT_BACKOFF,
    /** P2-31f: the `run` operator flags. */
    private readonly options: {
      retryParked?: boolean;
      operatorClear?: boolean;
      maxClears?: number;
      /**
       * ADM-4c review. The one retirement code this pass is allowed to go
       * through with, named exactly. See `refuseRetirement`.
       */
      acceptRetirement?: string;
    } = {},
    /**
     * ADM-4a, a list since ADM-4c. The provider identity sources, when the
     * caller supplies its own. The runner builds one Dropbox source per bound
     * root from its configuration otherwise, and a root with no provider has
     * none at all.
     */
    private readonly providerFileIdSources:
      ProviderFileIdSource[] | undefined = undefined,
  ) {}

  /**
   * Settle the one answered request that the operator priority control may
   * encounter. This drives exactly the current archived-step handler once. It
   * cannot start a pass, and an unanswered request is refused before entry.
   */
  async settleAnsweredArchivedRequest(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    const pending = this.journal.pending;
    if (
      checkpoint.phase !== "archived" ||
      pending === undefined ||
      pending.result === undefined
    ) {
      throw new PipelineWorkerError("priority_pending_conflict");
    }
    this.archiveCatalog = await openArchiveCatalog({ journal: this.journal });
    await this.driveArchived();
  }

  /**
   * Sends a worker mutation and, on a `rate_limited` response, waits with
   * bounded exponential backoff (spanning the server's mutation rate-limit
   * window) and retries before giving the caller a final answer. This is
   * the single place that handles `rate_limited`; every driver phase below
   * just treats a `rate_limited` response the same as any other terminal
   * error code, because by the time one reaches them, retries here are
   * already exhausted.
   */
  private async callWithRateLimitBackoff(
    body: Record<string, unknown>,
  ): Promise<WorkerResponse> {
    let response = await this.transport.call(body);
    for (
      let attempt = 1;
      errorCode(response) === "rate_limited" &&
      attempt < this.rateLimitBackoff.maxAttempts;
      attempt += 1
    ) {
      const waitMs = rateLimitBackoffMs(attempt, this.rateLimitBackoff);
      console.warn(
        `[pipeline] worker mutation rate limited (attempt ${attempt}/${this.rateLimitBackoff.maxAttempts}); retrying in ${waitMs}ms`,
      );
      await sleep(waitMs);
      response = await this.transport.call(body);
    }
    if (errorCode(response) === "rate_limited") {
      console.warn(
        `[pipeline] worker mutation still rate limited after ${this.rateLimitBackoff.maxAttempts} attempts; failing this run. The journal records a terminal outcome, and the next invocation resumes the pass normally.`,
      );
    }
    return response;
  }

  private requirePdfConfig(): NonNullable<PipelineConfig["pdfDocQa"]> {
    if (!this.config.pdfDocQa) {
      throw new PipelineWorkerError("pdf_profile_missing");
    }
    return this.config.pdfDocQa;
  }

  private requireCatalog(): ArchiveCatalog {
    if (!this.archiveCatalog) {
      throw new PipelineWorkerError("archive_catalog_missing");
    }
    return this.archiveCatalog;
  }

  private archivedPlan(checkpoint: ArchivedCheckpoint): PdfFilePlan {
    const plan = checkpoint.files[checkpoint.pdfIndex];
    if (!plan || !isPdfPlan(plan)) {
      throw new PipelineWorkerError("archived_plan_missing");
    }
    return plan;
  }

  private archivedRows(checkpoint: ArchivedCheckpoint): {
    original: OriginalCatalogRow;
    processing: ProcessingCatalogRow;
  } {
    if (!checkpoint.originalCatalogId || !checkpoint.processingCatalogId) {
      throw new PipelineWorkerError("archive_catalog_reference_missing");
    }
    const original = this.requireCatalog()
      .listOriginals()
      .find((row) => row.originalCatalogId === checkpoint.originalCatalogId);
    const processing = this.requireCatalog()
      .listProcessings()
      .find(
        (row) => row.processingCatalogId === checkpoint.processingCatalogId,
      );
    if (!original || !processing) {
      throw new PipelineWorkerError("archive_catalog_reference_missing");
    }
    if (
      original.rowRevision < (checkpoint.expectedOriginalRevision ?? 1) ||
      processing.rowRevision < (checkpoint.expectedProcessingRevision ?? 1)
    ) {
      throw new PipelineWorkerError("archive_catalog_revision_conflict");
    }
    return { original, processing };
  }

  private copyIntent(
    subject: ArchiveSubject,
    role: ArchiveCopyRole,
    seed: string,
  ) {
    const pdf = this.requirePdfConfig();
    const configured =
      role === "primary" ? pdf.archive.primary : pdf.archive.independentBackup;
    const archiveObjectId = stableUuid(seed, subject, role, "object");
    return {
      role,
      clientReceiptId: stableUuid(seed, subject, role, "receipt"),
      archiveObjectId,
      objectName: `${archiveObjectId}.age`,
      archiveIdentityFingerprint: configured.archiveIdentityFingerprint,
      archiveProfileFingerprint: configured.archiveProfileFingerprint,
      recipientFingerprint: configured.recipientFingerprint,
      repositoryKeyDomainFingerprint: configured.repositoryKeyDomainFingerprint,
      storageFailureDomainFingerprint:
        configured.storageFailureDomainFingerprint,
      ...(role === "independent_backup"
        ? {
            restic: {
              operationId: stableUuid(seed, subject, role, "restic"),
              host: pdf.archive.independentBackup.host,
              repositoryId: pdf.archive.independentBackup.expectedRepositoryId,
            },
          }
        : {}),
    };
  }

  private processingFingerprints(plan: PdfFilePlan) {
    return {
      parserFingerprint: plan.parserFingerprint,
      extractionConfigurationFingerprint:
        plan.extractionConfigurationFingerprint,
      discoveryProfileFingerprint: sha256Json([
        plan.parserProfileId,
        plan.extractorFingerprint,
        plan.recordSchemaFingerprint,
        plan.normalizationFingerprint,
        plan.chunkerFingerprint,
      ]),
      processingPolicyFingerprint: sha256Json([
        plan.extractionConfigurationFingerprint,
        plan.chunkerFingerprint,
      ]),
      correctionFingerprint: createHash("sha256")
        .update(plan.correctionRevision, "utf8")
        .digest("hex"),
    };
  }

  private matchingOriginal(plan: PdfFilePlan): OriginalCatalogRow | undefined {
    if (
      !plan.externalId ||
      plan.observationEpoch === undefined ||
      plan.processingEpoch === undefined
    ) {
      return undefined;
    }
    return this.requireCatalog().findOriginalExact({
      sourceExternalId: plan.externalId,
      sha256: plan.sha256,
      byteLength: plan.byteLength,
      mediaType: planMediaType(plan),
    });
  }

  /**
   * The local catalog rows that answer for this plan.
   *
   * ADM-4a: matched on the original, the processing epoch and the full
   * fingerprint tuple, and deliberately *not* on the observation epoch.
   *
   * The observation epoch advances on any inventory metadata change: the path,
   * the title, or the modification time. The processing epoch and the
   * fingerprints are what say the parse is stale. Including the observation
   * epoch here made a metadata-only change unmatchable, so the runner decided
   * the document needed archived work -- while the server, seeing the same
   * bytes, answered `unchanged` and opened no work row for it. The next
   * `discovery.preflightArchived` then failed the whole pass with
   * `stale_observation` (`resolveCurrentArchivedWork` in kith-store's
   * `archivedDiscovery.ts`), every pass, until the bytes themselves changed.
   *
   * This is not specific to a rename: touching a file's modification time,
   * which a sync client does on its own, reproduces it exactly. A rename is
   * simply the first thing that reaches it now that identity survives one.
   *
   * Multiple matches across observation epochs are what `reusableProcessingRow`
   * already exists to settle, and it still fails closed on a history it cannot
   * judge.
   */
  private matchingProcessingRows(plan: PdfFilePlan): ProcessingCatalogRow[] {
    const original = this.matchingOriginal(plan);
    if (!original) return [];
    const fingerprints = this.processingFingerprints(plan);
    return this.requireCatalog()
      .listProcessings()
      .filter(
        (row) =>
          row.originalCatalogId === original.originalCatalogId &&
          row.currentObservation.processingEpoch === plan.processingEpoch &&
          equalJson(row.fingerprints, fingerprints),
      );
  }

  private async processingArtifactsPresent(
    processing: ProcessingCatalogRow,
    mediaType: BinaryMediaType,
  ): Promise<boolean> {
    if (!processing.capture || !processing.parserOutput || !processing.spool) {
      return false;
    }
    const pdf = this.requirePdfConfig();
    const candidates = [
      join(
        pdf.captureDirectory,
        captureFileName(processing.captureIntent.captureId, mediaType),
      ),
      join(pdf.parserOutputRoot, processing.parserIntent.outputId),
      join(pdf.spoolDirectory, processing.spool.opaqueName),
    ];
    for (const path of candidates) {
      const present = await lstat(path)
        .then(() => true)
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          return true;
        });
      if (present) return true;
    }
    return false;
  }

  /**
   * Local parse attempts already spent on this document: the sum over every
   * processing catalog row that describes the same bytes under the same parser
   * fingerprints.
   *
   * P2-80g2: the budget belongs to the document, not to one catalog row.
   * `createArchivedIntents` probes `findProcessingExact` with the current
   * `scanId`, and only reuses a prior row for an `unchanged` entry, so a
   * document re-queued after a failure lands on a brand new row every pass.
   * Counting one row therefore saw `attempts: 1` forever: the client never
   * judged itself exhausted, re-parsed the same PDFs on every pass, and never
   * told the server the failure was terminal. A parser version bump still
   * resets the budget, because it changes `fingerprints.parserFingerprint` and
   * no prior row matches.
   */
  private documentParseAttempts(plan: PdfFilePlan): number {
    return parseAttemptsSpent(this.matchingProcessingRows(plan));
  }

  /**
   * Select the sole authoritative row from an otherwise ambiguous history.
   * Callers supply only rows already matched on original, epochs and the full
   * processing fingerprint tuple; this is not a general latest-row selector.
   *
   * P2-31e. Two activated rows, each internally coherent, is reachable and was
   * live: a misrouted admission activated one row against a backend that no
   * longer serves the account, and a later pass activated another against the
   * authoritative one. Both pass the cloud coherence check below, because each
   * is self-consistent about the backend it came from.
   *
   * `original` settles it. `discovery.admitArchived` writes the original's and
   * the processing row's `cloud.sourceRevisionId` from the same
   * `value.sourceRevisionId` in one transition, and `admissionRevisionConflict`
   * ends the scan on any later answer that disagrees with a receipt the
   * original already holds, so a processing row naming a different revision
   * than its own original records is by construction from a different
   * admission. That is a fact about this client's own writes, not a guess
   * about the server.
   *
   * When the original names a revision and no activated row matches it, there
   * is no authoritative row to reuse and none is returned. The callers read
   * that as "not activated yet": the document needs work, and
   * `createArchivedIntents` starts a fresh row rather than reusing a dead one.
   * Returning a stale activation instead would send a document the server is
   * still waiting for straight to cleanup, and it would never publish.
   *
   * Everything else stays strict. A history with no activated row at all, or
   * with two that both answer to the original's revision, still fails closed.
   */
  private reusableProcessingRow(
    rows: readonly ProcessingCatalogRow[],
    original?: OriginalCatalogRow,
  ): ProcessingCatalogRow | undefined {
    if (rows.length <= 1) return rows[0];
    const all = rows.filter((row) => row.activation !== undefined);
    const revision = original?.cloud?.sourceRevisionId;
    const activated =
      revision === undefined
        ? all
        : all.filter((row) => row.cloud?.sourceRevisionId === revision);
    if (all.length > 0 && activated.length === 0) return undefined;
    if (activated.length !== 1) {
      throw new PipelineWorkerError("archive_catalog_revision_conflict");
    }
    const [selected] = activated;
    const activation = selected?.activation;
    if (
      !selected?.cloud ||
      !activation ||
      activation.jobId !== selected.cloud.ingestJobId ||
      activation.processingGenerationId !==
        selected.cloud.processingGenerationId
    ) {
      throw new PipelineWorkerError("archive_catalog_revision_conflict");
    }
    return selected;
  }

  private async pdfNeedsArchivedWork(plan: PdfFilePlan): Promise<boolean> {
    // A `queued` entry is the server saying it has not settled this failure
    // yet, and the only thing that settles it is one more report carrying
    // `exhausted`, so going quiet here would strand the work row as retryable
    // forever. One more parse settles it; every pass after that arrives here
    // as `unchanged` and is skipped by the bound below.
    if (plan.discoveryState === "queued") return true;
    if (plan.discoveryState !== "unchanged") return false;
    const matches = this.matchingProcessingRows(plan);
    // A document that has already exhausted its bounded local parser attempts
    // (see `recordArchivedParseFailure`) stays `parse_failed` rather than being
    // retried on every future pass; a parser version bump lands on a fresh row
    // with no `parseFailure` and lifts this gate automatically. Checked before
    // the revision-conflict guard below, because the per-row judgment this
    // replaces left several rows per failed document behind in existing
    // catalogs and an exhausted document must stay skipped rather than fail
    // the pass over them.
    if (parseAttemptsSpent(matches) >= MAX_PARSE_ATTEMPTS) return false;
    const original = this.matchingOriginal(plan);
    // P2-31f: a parked document is skipped exactly as an exhausted one is.
    // The marker lives on the original row, which is keyed by content, so new
    // bytes land on a fresh row with no marker and release the item here
    // without anything having to notice that it changed.
    if (
      original?.admissionBlock &&
      admissionBlockHolds(original.admissionBlock)
    )
      return false;
    const reusable = this.reusableProcessingRow(matches, original);
    if (reusable?.activation) {
      return await this.processingArtifactsPresent(
        reusable,
        planMediaType(plan),
      );
    }
    return true;
  }

  private async nextPdfWorkIndex(
    files: FilePlan[],
    start: number,
  ): Promise<number> {
    for (let index = start; index < files.length; index += 1) {
      const plan = files[index];
      if (!plan || !isPdfPlan(plan)) continue;
      let needsWork: boolean;
      try {
        needsWork = await this.pdfNeedsArchivedWork(plan);
      } catch (error) {
        // P2-31f. `reusableProcessingRow` fails closed on a catalog history it
        // cannot judge. That is a fact about this one document, so park it and
        // keep looking instead of failing the scan for every other file. The
        // caller may be inside a journaled transition, so this must not throw.
        const code = parkable(error);
        if (code === undefined) throw error;
        try {
          await this.parkPlan(plan, code);
        } catch {
          // The marker could not be written, so the condition is unhandled.
          // Raise what actually happened rather than the bookkeeping failure
          // on top of it.
          throw error;
        }
        continue;
      }
      if (needsWork) return index;
    }
    return -1;
  }

  /**
   * P2-31f. Records the park marker for one document. Every parkable code is
   * terminal for this file alone, so the marker is what lets the pass walk on;
   * `pdfNeedsArchivedWork` reads it back and `admissionBlockHolds` decides when
   * it stops holding.
   */
  private async parkRow(
    original: OriginalCatalogRow,
    code: AdmissionBlockCode,
  ): Promise<void> {
    await this.requireCatalog().recordAdmissionBlock({
      catalogId: original.originalCatalogId,
      expectedRevision: original.rowRevision,
      code,
      runnerCapability: RUNNER_PARK_CAPABILITY,
      now: Date.now(),
    });
  }

  private async parkPlan(
    plan: PdfFilePlan,
    code: AdmissionBlockCode,
  ): Promise<void> {
    const original = this.matchingOriginal(plan);
    if (!original) {
      throw new PipelineWorkerError("archive_catalog_reference_missing");
    }
    await this.parkRow(original, code);
  }

  /**
   * Parks the checkpoint's own document and returns the checkpoint that walks
   * past it, exactly as `driveArchivedCleanup` does after a published one
   * except that nothing was published.
   *
   * Returned rather than committed, so a caller inside a journaled transition
   * settles the answered request with it. A throw there would leave the
   * request pending with its answer recorded and wedge the journal for good
   * (P2-31e), which is the failure mode this task exists to stop repeating.
   * For the same reason the row is found by the checkpoint's own id first and
   * only then by the plan's content, so this cannot throw over a row the
   * checkpoint is demonstrably already on.
   */
  private async parkedCheckpoint(
    checkpoint: ArchivedCheckpoint,
    code: AdmissionBlockCode,
  ): Promise<RunnerCheckpoint> {
    const original =
      this.requireCatalog()
        .listOriginals()
        .find(
          (row) => row.originalCatalogId === checkpoint.originalCatalogId,
        ) ?? this.matchingOriginal(this.archivedPlan(checkpoint));
    if (!original) {
      throw new PipelineWorkerError("archive_catalog_reference_missing");
    }
    await this.parkRow(original, code);
    return await this.afterArchivedItem(checkpoint, 0);
  }

  /** The checkpoint that moves to the next document needing archived work. */
  private async afterArchivedItem(
    checkpoint: ArchivedCheckpoint,
    publicationIncrement: number,
  ): Promise<RunnerCheckpoint> {
    const nextPdf = await this.nextPdfWorkIndex(
      checkpoint.files,
      checkpoint.pdfIndex + 1,
    );
    const archivedPublished =
      checkpoint.archivedPublished + publicationIncrement;
    return nextPdf >= 0
      ? {
          version: 1,
          phase: "archived",
          ...activeScanBase(checkpoint),
          pdfIndex: nextPdf,
          step: "intent",
          reservationRound: 0,
          archivedPublished,
          ...(checkpoint.priorityReceipt === undefined
            ? {}
            : { priorityReceipt: checkpoint.priorityReceipt }),
        }
      : {
          version: 1,
          phase: "discovery_reserve",
          ...activeScanBase(checkpoint),
          round: 0,
          archivedPublished,
        };
  }

  private async createArchivedIntents(
    checkpoint: ArchivedCheckpoint,
  ): Promise<ArchivedCheckpoint> {
    const catalog = this.requireCatalog();
    const pdf = this.requirePdfConfig();
    const plan = this.archivedPlan(checkpoint);
    const identity = archivedIdentity(checkpoint, plan);
    const createdAt = Date.now();
    if (!plan.externalId) {
      throw new PipelineWorkerError("archived_external_id_missing");
    }
    const originalSeed = stableUuid(
      plan.externalId,
      plan.sha256,
      plan.byteLength,
      "original",
    );
    let original = catalog.findOriginalExact({
      sourceExternalId: plan.externalId,
      sha256: plan.sha256,
      byteLength: plan.byteLength,
      mediaType: planMediaType(plan),
    });
    if (!original) {
      // ADM-4c: a watched root with no provider entry archives its own
      // independent copy, exactly as every root does when `providerOriginal`
      // is absent. Only a root that is bound gets a provider original.
      const provider = providerRootFor(pdf.providerOriginal, plan.rootAlias);
      original = await catalog.createOriginalIntent({
        originalCatalogId: originalSeed,
        sourceExternalId: plan.externalId,
        origin: {
          scanId: checkpoint.scanId,
          observationEpoch: identity.observationEpoch,
          sha256: plan.sha256,
          byteLength: plan.byteLength,
          mediaType: planMediaType(plan),
        },
        copies:
          provider === undefined
            ? {
                primary: this.copyIntent(
                  "original_bytes",
                  "primary",
                  originalSeed,
                ),
                independent_backup: this.copyIntent(
                  "original_bytes",
                  "independent_backup",
                  originalSeed,
                ),
              }
            : ({
                primary: this.copyIntent(
                  "original_bytes",
                  "primary",
                  originalSeed,
                ),
              } as { primary: ArchiveCopyIntent; independent_backup: never }),
        ...(provider === undefined
          ? {}
          : {
              providerOriginal: {
                clientReferenceId: stableUuid(
                  originalSeed,
                  "provider-reference",
                ),
                bindingId: stableUuid(originalSeed, "provider-binding"),
                locator: this.copyIntent(
                  "parser_output",
                  "independent_backup",
                  stableUuid(originalSeed, "provider-locator"),
                ),
              },
            }),
        createdAt,
      });
    }
    const fingerprints = this.processingFingerprints(plan);
    const processingProbe = {
      originalCatalogId: original.originalCatalogId,
      currentObservation: {
        scanId: checkpoint.scanId,
        observationEpoch: identity.observationEpoch,
        processingEpoch: identity.processingEpoch,
      },
      fingerprints,
    };
    let processing = catalog.findProcessingExact(processingProbe);
    if (!processing && plan.discoveryState === "unchanged") {
      const prior = this.matchingProcessingRows(plan);
      processing = this.reusableProcessingRow(prior, original);
    }
    if (!processing) {
      const processingId = stableUuid(
        original.originalCatalogId,
        processingProbe.currentObservation,
        fingerprints,
        "processing",
      );
      const outputId = stableUuid(processingId, "parser-output");
      const outputPath = join(pdf.parserOutputRoot, outputId);
      await mkdir(outputPath, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const [captureDirectory, outputRoot, outputDirectory, spoolRoot] =
        await Promise.all([
          privateDirectoryIdentity(pdf.captureDirectory),
          privateDirectoryIdentity(pdf.parserOutputRoot),
          privateDirectoryIdentity(outputPath),
          inspectSpoolRoot(pdf.spoolDirectory),
        ]);
      processing = await catalog.createProcessingIntent({
        processingCatalogId: processingId,
        ...processingProbe,
        captureIntent: {
          captureId: stableUuid(processingId, "capture"),
          directory: captureDirectory,
        },
        parserIntent: {
          outputId,
          outputRoot,
          outputDirectory,
          parserArtifactClientId: stableUuid(processingId, "parser-artifact"),
        },
        spoolIntent: {
          spoolId: stableUuid(processingId, "spool"),
          root: spoolRoot,
        },
        copies: {
          primary: this.copyIntent("parser_output", "primary", processingId),
          independent_backup: this.copyIntent(
            "parser_output",
            "independent_backup",
            processingId,
          ),
        },
        createdAt,
      });
    }
    return archivedBase(checkpoint, {
      step: processing.activation ? "cleanup" : "preflight",
      preflightAction: processing.activation ? undefined : "initial",
      countPublication: processing.activation ? false : true,
      originalCatalogId: original.originalCatalogId,
      expectedOriginalRevision: original.rowRevision,
      processingCatalogId: processing.processingCatalogId,
      expectedProcessingRevision: processing.rowRevision,
    });
  }

  private async sourceStatus(): Promise<Record<string, unknown>> {
    return object(
      await this.transport.call(request(this.config, "source.status")),
      "source.status",
    );
  }

  /**
   * ADM-4c. The watched-folder list the server holds, or `undefined` when this
   * pass could not read it.
   *
   * Never fails the pass. A server that has no rows, or that this worker
   * cannot ask, means "watch the host's allow-listed roots as today", which is
   * every pass before ADM-4b and the safe answer for every pass after it.
   */
  private async serverRoots(): Promise<WorkerSourceRoot[] | undefined> {
    try {
      const result = object(
        await this.transport.call(request(this.config, "source.roots")),
        "source.roots",
      );
      if (result.sourceAccountId !== this.config.sourceAccountId) {
        throw new PipelineWorkerError("source_mismatch");
      }
      return result.roots as WorkerSourceRoot[];
    } catch (error) {
      console.warn(
        `[pipeline] watched-folder list unavailable this pass; the host's allow-listed roots stand (${
          error instanceof Error ? error.message : "unknown error"
        })`,
      );
      return undefined;
    }
  }

  /**
   * ADM-6a. What the server says it holds for this source, or `undefined`
   * when this pass could not ask.
   *
   * Never fails the pass, and for one reason that matters more than tidiness:
   * a server that predates this operation answers `invalid_request`, and the
   * watcher that ships with this change has to keep working against it. So
   * every failure -- an old server, a transport error, a response this worker
   * cannot parse -- means "the server did not say", the guard below abstains,
   * and the pass behaves exactly as it did before ADM-6a.
   */
  private async serverItemCounts(): Promise<ServerItemCounts | undefined> {
    try {
      const result = object(
        await this.transport.call(request(this.config, "source.itemCounts")),
        "source.itemCounts",
      );
      if (result.sourceAccountId !== this.config.sourceAccountId) {
        throw new PipelineWorkerError("source_mismatch");
      }
      return {
        liveItems: result.liveItems as number,
        roots: result.roots as ServerItemCounts["roots"],
        truncated: result.truncated as boolean,
      };
    } catch (error) {
      console.warn(
        `[pipeline] the server's item counts are unavailable this pass; the journal's own memory stands (${
          error instanceof Error ? error.message : "unknown error"
        })`,
      );
      return undefined;
    }
  }

  /**
   * ADM-4c. The roots this pass reads, and what to report about each server
   * row.
   *
   * The host's JSON config is the allow-list and the server's rows select
   * subtrees inside it. The three steps the protocol requires of a client (see
   * the contract above `FS_ROOT_ALIAS` in `@repo/worker-protocol/request`) all
   * happen here, in order, on text this worker treats as untrusted:
   *
   * 1. the alias must be a key in the host's own list, or the row is skipped;
   * 2. the stored relative path is re-checked as text, decoding nothing;
   * 3. the joined path is resolved and must be a separator-aligned descendant
   *    of the resolved allow-listed root, so a symlink inside an allowed root
   *    cannot point the watcher somewhere else.
   *
   * A row that fails any of them is reported `missing` or `unreadable` and
   * left out of the pass. None of it fails the pass: a folder the owner
   * mistyped in the UI must show a problem on the sources screen, not stop the
   * watcher reading the folders that are fine.
   */
  private async resolveServerRoots(
    allowed: SafeRoot[],
    rows: WorkerSourceRoot[],
  ): Promise<{ roots: SafeRoot[]; reports: SourceRootReport[] }> {
    const byAlias = new Map(allowed.map((root) => [root.alias, root]));
    const prefixes = new Map<string, string[]>();
    /** Aliases a row selects whole, which no other row may then narrow. */
    const whole = new Set<string>();
    const reports: SourceRootReport[] = [];
    for (const row of rows) {
      if (row.kind !== "folder") continue;
      const host = row.rootAlias ? byAlias.get(row.rootAlias) : undefined;
      if (!host) {
        reports.push({ sourceRootId: row.sourceRootId, state: "missing" });
        continue;
      }
      const relativePath = row.relativePath ?? "";
      if (relativePath !== "" && !validRelativePath(relativePath)) {
        reports.push({ sourceRootId: row.sourceRootId, state: "missing" });
        continue;
      }
      const joined =
        relativePath === ""
          ? host.canonicalPath
          : join(host.canonicalPath, relativePath);
      let resolved: string;
      try {
        resolved = await realpath(joined);
      } catch (error) {
        reports.push({
          sourceRootId: row.sourceRootId,
          state:
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "missing"
              : "unreadable",
        });
        continue;
      }
      if (!contains(host.canonicalPath, resolved)) {
        reports.push({ sourceRootId: row.sourceRootId, state: "unreadable" });
        continue;
      }
      const entry = await lstat(resolved).catch(() => undefined);
      if (!entry?.isDirectory()) {
        reports.push({ sourceRootId: row.sourceRootId, state: "unreadable" });
        continue;
      }
      // ADM-4c review: the subtree is named by the path the host actually
      // has, derived from the resolved directory, never by the row's raw
      // text. On a case-insensitive filesystem, or one that stores NFD where
      // the row says NFC, `realpath` succeeds for a spelling discovery never
      // produces, and a raw-text prefix would then match no file at all --
      // which reads as every document under the root vanishing.
      const prefix = relative(host.canonicalPath, resolved);
      reports.push({
        sourceRootId: row.sourceRootId,
        state: "ok",
        rootAlias: host.alias,
        relativePath: prefix,
        ...(row.providerFolderId === undefined
          ? {}
          : { providerFolderId: row.providerFolderId }),
      });
      // A paused row still selects its subtree. Only its state is reported.
      // Dropping it from the selection would leave its items out of the scan,
      // and the server's reconcile marks anything not in the scan
      // unavailable, so pausing a folder would read as deleting it.
      if (prefix === "") whole.add(host.alias);
      else if (prefixes.has(host.alias)) {
        prefixes.get(host.alias)!.push(prefix);
      } else prefixes.set(host.alias, [prefix]);
    }
    // ADM-4c review: rows may only NARROW a root they name. A root no row
    // names is watched whole, exactly as it is with no rows at all. Dropping
    // an unnamed root would take every item under it out of the scan, and
    // `reconcileWorkerScan` is account-wide: the first pass after the owner
    // adds one folder in the UI would mark every existing document
    // unavailable. No server answer may ever remove a root from this list.
    const roots = allowed.map((root) => {
      const selected = whole.has(root.alias)
        ? undefined
        : prefixes.get(root.alias);
      return selected === undefined || selected.length === 0
        ? root
        : { ...root, includePrefixes: [...new Set(selected)].sort() };
    });
    return { roots, reports };
  }

  /**
   * ADM-4c review. The roots this pass reads, resolved once and reused.
   *
   * Every phase that re-enumerates has to see the same set the scan was
   * planned from. `driveSealCheck` in particular re-discovers and compares
   * against the sealed manifest: given the allow-list rather than the
   * selection, it found files the scan deliberately left out and called the
   * whole scan `unstable`. A pass resumed in a new process re-reads the
   * server's list, which is right -- a selection that changed mid-pass should
   * fail the seal check.
   */
  private async currentRoots(): Promise<SafeRoot[]> {
    if (this.effectiveRoots) return this.effectiveRoots;
    // ADM-4c review: the provider original config already says which roots a
    // provider backs, and that is the only place an entry with no blocks is
    // read as "not downloaded yet" rather than as a compressed file.
    const backed = new Set(
      providerRootsOf(this.config.pdfDocQa?.providerOriginal).map(
        (root) => root.rootAlias,
      ),
    );
    const allowed = (await canonicalRoots(this.config)).map((root) =>
      backed.has(root.alias) ? { ...root, providerBacked: true } : root,
    );
    const rows = await this.serverRoots();
    const plan =
      rows === undefined
        ? { roots: allowed, reports: [] as SourceRootReport[] }
        : await this.resolveServerRoots(allowed, rows);
    this.effectiveRoots = plan.roots;
    this.pendingRootReports = plan.reports;
    return plan.roots;
  }

  /** ADM-4c. Tells the server what this pass saw at each of its roots. */
  private async reportRoots(
    reports: SourceRootReport[],
    files: FilePlan[],
  ): Promise<void> {
    const observedAt = Date.now();
    for (const report of reports) {
      const itemCount =
        report.state !== "ok"
          ? 0
          : files.filter(
              (file) =>
                file.rootAlias === report.rootAlias &&
                (report.relativePath === "" ||
                  file.relativePath === report.relativePath ||
                  file.relativePath.startsWith(`${report.relativePath}/`)),
            ).length;
      try {
        await this.transport.call(
          request(this.config, "source.rootReport", {
            sourceRootId: report.sourceRootId,
            observedAt,
            itemCount,
            state: report.state,
            ...(report.providerFolderId === undefined
              ? {}
              : { providerFolderId: report.providerFolderId }),
          }),
        );
      } catch (error) {
        console.warn(
          `[pipeline] a watched-folder report could not be sent (${
            error instanceof Error ? error.message : "unknown error"
          })`,
        );
        return;
      }
    }
  }

  private async preparePdfProfile(): Promise<void> {
    const pdf = this.config.pdfDocQa;
    if (pdf === undefined) return;
    const work = await createParserProfileWorkDirectory({
      workRoot: pdf.parserOutputRoot,
      workId: randomUUID(),
    });
    try {
      const prepared = await preparePdfDocQaProfile({
        ...pdf.parser,
        workRoot: pdf.parserOutputRoot,
        work,
      });
      if (
        prepared.parserFingerprint !== pdf.profile.parserFingerprint ||
        prepared.extractionConfigurationFingerprint !==
          pdf.profile.extractionConfigurationFingerprint
      ) {
        throw new PipelineWorkerError("parser_profile_mismatch");
      }
      this.preparedPdfProfile = prepared;
    } finally {
      await removeParserProfileWorkDirectoryExact({
        workRoot: pdf.parserOutputRoot,
        intent: work,
      });
    }
  }

  /**
   * ADM-4c review. The scan cache, opened once per pass and shared by every
   * phase that enumerates.
   *
   * The seal check used to re-discover without it, which meant every byte was
   * still read and hashed once per pass -- the cost the cache exists to
   * remove -- and, worse, that a cache entry discovery trusted and the seal
   * check did not would make the two disagree and end the scan `unstable` on
   * every pass until the daily rehash cleared it. One cache, one answer.
   */
  private async scanCache(): Promise<JournalScanCache | undefined> {
    if (this.openScanCache === undefined) {
      this.openScanCache = await JournalScanCache.open({
        journalDir: this.config.journalDir,
        authority: `${this.config.spaceId}\0${this.config.sourceAccountId}`,
      }).catch(() => undefined);
    }
    return this.openScanCache;
  }

  private async discoverPlans(roots: SafeRoot[]): Promise<FilePlan[]> {
    if (this.config.pdfDocQa === undefined) {
      return (await discoverFiles(this.config, roots)).map(filePlan);
    }
    if (this.preparedPdfProfile === undefined) {
      throw new PipelineWorkerError("parser_profile_unverified");
    }
    const cache = await this.scanCache();
    try {
      return (await discoverSourceObservations(this.config, roots, cache)).map(
        (observation) => observationPlan(observation, this.config.pdfDocQa!),
      );
    } finally {
      await cache?.flush();
    }
  }

  private async sameDiscoveredSnapshot(
    roots: SafeRoot[],
    plans: FilePlan[],
  ): Promise<boolean> {
    if (this.config.pdfDocQa === undefined) {
      return sameSnapshot(await discoverFiles(this.config, roots), plans);
    }
    if (this.preparedPdfProfile === undefined) {
      throw new PipelineWorkerError("parser_profile_unverified");
    }
    const observations = await discoverSourceObservations(
      this.config,
      roots,
      await this.scanCache(),
    );
    return (
      observations.length === plans.length &&
      observations.every((observation, index) => {
        const plan = plans[index];
        return (
          plan !== undefined &&
          sameObservationPlan(observation, plan, this.config.pdfDocQa!)
        );
      })
    );
  }

  private async validatePendingBody(
    operation: JournalOperation,
    body: Record<string, unknown>,
  ): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    const requestId = text(body.requestId, "request_id");
    let expected: Record<string, unknown>;
    switch (operation) {
      case "scan.begin": {
        if (checkpoint.phase !== "scan_begin") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          requestId,
          watcherId: `pipeline-${this.config.sourceAccountId.slice(0, 64)}`,
          connectorVersion:
            this.config.pdfDocQa === undefined ? "p2-8-text-v1" : "p2-9-pdf-v1",
          ...(this.config.hostAffinity
            ? { hostAffinity: this.config.hostAffinity }
            : {}),
          mode: checkpoint.mode,
          expectedInventoryEpoch: checkpoint.expectedInventoryEpoch,
        });
        break;
      }
      case "source.inventoryPage": {
        if (checkpoint.phase !== "inventory") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          scanId: checkpoint.scanId,
          requestId,
          expectedInventoryEpoch: checkpoint.inventoryEpoch,
          expectedManifestVersion: checkpoint.manifestVersion,
          paginationOpts: { cursor: checkpoint.cursor, numItems: 50 },
        });
        break;
      }
      case "scan.appendPage": {
        if (checkpoint.phase !== "append") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const offset = checkpoint.nextOrdinal * 4;
        expected = request(this.config, operation, {
          scanId: checkpoint.scanId,
          requestId,
          ordinal: checkpoint.nextOrdinal,
          entries: checkpoint.files
            .slice(offset, offset + 4)
            .map((plan) => scanEntry(plan, checkpoint.mode)),
        });
        break;
      }
      case "scan.seal": {
        if (checkpoint.phase !== "seal") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          scanId: checkpoint.scanId,
          requestId,
          expectedPageCount: checkpoint.nextOrdinal,
          health: checkpoint.health,
        });
        break;
      }
      case "scan.reconcile": {
        if (checkpoint.phase !== "reconcile") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          scanId: checkpoint.scanId,
          requestId,
          expectedInventoryEpoch: checkpoint.inventoryEpoch,
          ordinal: checkpoint.ordinal,
          maxItems: 50,
        });
        break;
      }
      case "discovery.reserve": {
        if (checkpoint.phase !== "discovery_reserve") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, { requestId, maxItems: 4 });
        break;
      }
      case "discovery.admitUtf8": {
        if (checkpoint.phase !== "discovery_admit") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const target = checkpoint.targets[checkpoint.index];
        if (!target || typeof body.text !== "string") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const plan = checkpoint.files.find(
          (candidate) =>
            toFsUri(candidate.rootAlias, candidate.relativePath) === target.uri,
        );
        if (
          !plan ||
          !isUtf8Plan(plan) ||
          plan.sha256 !== target.contentHash ||
          plan.byteLength !== target.byteLength
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const encoded = Buffer.from(body.text, "utf8");
        if (
          encoded.toString("utf8") !== body.text ||
          encoded.byteLength !== target.byteLength ||
          createHash("sha256").update(encoded).digest("hex") !==
            target.contentHash
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          requestId,
          workId: target.workId,
          leaseEpoch: target.leaseEpoch,
          leaseToken: target.leaseToken,
          text: body.text,
        });
        break;
      }
      case "jobs.reserve": {
        if (checkpoint.phase !== "jobs_reserve") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, { requestId, maxItems: 4 });
        break;
      }
      case "jobs.renew":
      case "jobs.stageUtf8":
      case "jobs.activate": {
        if (
          checkpoint.phase !== "jobs_renew" &&
          checkpoint.phase !== "jobs_stage" &&
          checkpoint.phase !== "jobs_activate"
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const expectedOperation =
          checkpoint.phase === "jobs_renew"
            ? "jobs.renew"
            : checkpoint.phase === "jobs_stage"
              ? "jobs.stageUtf8"
              : "jobs.activate";
        if (operation !== expectedOperation) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const job = checkpoint.jobs[checkpoint.index];
        if (!job) throw new PipelineWorkerError("journal_phase_conflict");
        expected = request(this.config, operation, {
          requestId,
          jobId: job.jobId,
          leaseEpoch: job.leaseEpoch,
          leaseToken: job.leaseToken,
        });
        break;
      }
      case "jobs.fail": {
        if (checkpoint.phase !== "jobs_fail") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const job = checkpoint.jobs[checkpoint.index];
        if (!job) throw new PipelineWorkerError("journal_phase_conflict");
        expected = request(this.config, operation, {
          requestId,
          jobId: job.jobId,
          leaseEpoch: job.leaseEpoch,
          leaseToken: job.leaseToken,
          failureCode: checkpoint.failureCode,
        });
        break;
      }
      case "processing.assessBegin": {
        if (checkpoint.phase !== "assess_begin") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          requestId,
          scanId: checkpoint.scanId,
          expectedInventoryEpoch: checkpoint.expectedInventoryEpoch,
          expectedManifestVersion: checkpoint.expectedManifestVersion,
        });
        break;
      }
      case "processing.assessPage": {
        if (checkpoint.phase !== "assess_page") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          requestId,
          assessmentId: checkpoint.assessmentId,
          ordinal: checkpoint.ordinal,
          maxItems: 1,
        });
        break;
      }
      case "discovery.preflightArchived": {
        if (checkpoint.phase !== "archived") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const plan = this.archivedPlan(checkpoint);
        if (checkpoint.step !== "preflight") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const rows = this.archivedRows(checkpoint);
        const identity = archivedIdentity(checkpoint, plan);
        expected = request(this.config, operation, {
          requestId,
          identity,
          archiveIntentDigest: digestArchiveIntent({
            identity,
            original: rows.original,
            processing: rows.processing,
          }),
        });
        break;
      }
      case "discovery.lookupArchivedAdmission": {
        if (checkpoint.phase !== "archived") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const identity = archivedIdentity(
          checkpoint,
          this.archivedPlan(checkpoint),
        );
        if (checkpoint.step === "lookup_original") {
          expected = request(this.config, operation, {
            requestId,
            identity,
            lookup: { mode: "original" },
          });
          break;
        }
        if (checkpoint.step !== "lookup_processing") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const mapped = await this.mappedProcessing(checkpoint);
        const output = mapped.processing.parserOutput!;
        expected = request(this.config, operation, {
          requestId,
          identity,
          lookup: {
            mode: "processing",
            clientArtifactId:
              mapped.processing.parserIntent.parserArtifactClientId,
            parserOutputHash: output.rawArtifact.sha256,
            parserOutputByteLength: output.rawArtifact.byteLength,
            parserOutputMediaType: output.rawArtifact.mediaType,
            parsedText: mapped.declaration,
            // P2-104d. A replay sends the persisted body, and this is the
            // body this build sends, so the two have to agree here too.
            reuseParserArtifact: true,
          },
        });
        break;
      }
      case "discovery.reserveArchived": {
        if (checkpoint.phase !== "archived" || checkpoint.step !== "reserve") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          requestId,
          identity: archivedIdentity(checkpoint, this.archivedPlan(checkpoint)),
        });
        break;
      }
      case "discovery.admitArchived": {
        if (checkpoint.phase !== "archived" || checkpoint.step !== "admit") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const lease = checkpoint.discoveryLease;
        if (!lease) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const mapped = await this.mappedProcessing(checkpoint);
        const provider = this.admissionProvider(
          checkpoint,
          mapped.original,
          false,
        );
        const selections = this.admissionSelections(
          checkpoint,
          mapped,
          provider.providerOriginal,
        );
        expected = request(this.config, operation, {
          requestId,
          workId: lease.workId,
          leaseEpoch: lease.leaseEpoch,
          leaseToken: lease.leaseToken,
          ...selections,
          ...provider,
          parsedText: mapped.declaration,
        });
        // A pre-upgrade pending admission must replay its exact old body.
        // Accept only the complete historical projection rebuilt from the
        // same catalog, never arbitrary timestamps from the pending request.
        if (!equalJson(body, expected)) {
          const legacy = {
            ...expected,
            parserArtifact:
              selections.parserArtifact.kind === "create"
                ? {
                    ...selections.parserArtifact,
                    createdAt: mapped.processing.createdAt,
                  }
                : selections.parserArtifact,
            archives: selections.archives.map((archive) =>
              archive.kind === "create"
                ? {
                    ...archive,
                    createdAt:
                      archive.subjectKind === "original_bytes"
                        ? mapped.original.createdAt
                        : mapped.processing.createdAt,
                  }
                : archive,
            ),
            ...(provider.providerOriginal === undefined
              ? {}
              : {
                  providerOriginal: {
                    ...provider.providerOriginal,
                    createdAt: mapped.original.createdAt,
                  },
                }),
          };
          if (equalJson(body, legacy)) return;
        }
        break;
      }
      case "jobs.reserveParsed": {
        if (
          checkpoint.phase !== "archived" ||
          checkpoint.step !== "parsed_reserve"
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const { processing } = this.archivedRows(checkpoint);
        if (!processing.cloud) {
          throw new PipelineWorkerError("admission_missing");
        }
        expected = request(this.config, operation, {
          requestId,
          maxItems: 1,
          jobId: processing.cloud.ingestJobId,
        });
        break;
      }
      case "jobs.renewParsed": {
        if (
          checkpoint.phase !== "archived" ||
          checkpoint.step !== "parsed_renew" ||
          !checkpoint.jobLease
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          requestId,
          jobId: checkpoint.jobLease.jobId,
          leaseEpoch: checkpoint.jobLease.leaseEpoch,
          leaseToken: checkpoint.jobLease.leaseToken,
        });
        break;
      }
      case "jobs.stageParsedBegin": {
        if (
          checkpoint.phase !== "archived" ||
          checkpoint.step !== "parsed_begin" ||
          !checkpoint.jobLease
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const mapped = await this.mappedProcessing(checkpoint);
        const declaration = mapped.declaration;
        expected = request(this.config, operation, {
          requestId,
          jobId: checkpoint.jobLease.jobId,
          leaseEpoch: checkpoint.jobLease.leaseEpoch,
          leaseToken: checkpoint.jobLease.leaseToken,
          extractionFingerprint: declaration.extractionFingerprint,
          mappingManifestHash: declaration.mappingManifestHash,
          normalizedBundleDigest: declaration.normalizedBundleDigest,
          expectedPageCount: declaration.pageCount,
          expectedEvidenceSpanCount: declaration.expectedEvidenceSpanCount,
          expectedDocumentCount: declaration.expectedDocumentCount,
          expectedChunkCount: declaration.expectedChunkCount,
        });
        break;
      }
      case "jobs.stageParsedBatch": {
        if (checkpoint.phase !== "archived" || !checkpoint.jobLease) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        if (checkpoint.step !== "parsed_batch") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const mapped = await this.mappedProcessing(checkpoint);
        expected = this.parsedBatchBody(checkpoint, mapped.mapping, requestId);
        assertParsedRequestSize(expected);
        break;
      }
      case "jobs.stageParsedSeal": {
        if (
          checkpoint.phase !== "archived" ||
          checkpoint.step !== "parsed_seal" ||
          !checkpoint.jobLease
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const mapped = await this.mappedProcessing(checkpoint);
        expected = request(this.config, operation, {
          requestId,
          jobId: checkpoint.jobLease.jobId,
          leaseEpoch: checkpoint.jobLease.leaseEpoch,
          leaseToken: checkpoint.jobLease.leaseToken,
          stageId: checkpoint.stageId,
          normalizedBundleDigest: mapped.declaration.normalizedBundleDigest,
        });
        break;
      }
      case "jobs.activateParsed": {
        if (
          checkpoint.phase !== "archived" ||
          checkpoint.step !== "parsed_activate" ||
          !checkpoint.jobLease
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        expected = request(this.config, operation, {
          requestId,
          jobId: checkpoint.jobLease.jobId,
          leaseEpoch: checkpoint.jobLease.leaseEpoch,
          leaseToken: checkpoint.jobLease.leaseToken,
        });
        break;
      }
      case "jobs.failParsed": {
        throw new PipelineWorkerError("journal_phase_conflict");
      }
      default:
        throw new PipelineWorkerError("journal_phase_conflict");
    }
    if (!equalJson(body, expected)) {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
  }

  private async mutation(
    operation: JournalOperation,
    body: () => Record<string, unknown>,
    transition: (
      checkpoint: RunnerCheckpoint,
      result: WorkerResponse,
      pending: {
        requestId: string;
        requestBody: string;
        requestDigest: string;
        receivedAt: number;
      },
    ) => RunnerCheckpoint | Promise<RunnerCheckpoint>,
  ): Promise<WorkerResponse> {
    const pending = this.journal.pending;
    if (pending && pending.operation !== operation) {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    if (pending) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(pending.requestBody);
      } catch {
        throw new PipelineWorkerError("journal_phase_conflict");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new PipelineWorkerError("journal_phase_conflict");
      }
      await this.validatePendingBody(
        operation,
        parsed as Record<string, unknown>,
      );
    }
    const sendExact = async (
      requestBody: string,
      exactOperation: JournalOperation,
    ): Promise<unknown> => {
      if (exactOperation !== operation) {
        throw new PipelineWorkerError("journal_phase_conflict");
      }
      const parsed = JSON.parse(requestBody) as Record<string, unknown>;
      await this.validatePendingBody(exactOperation, parsed);
      return await this.callWithRateLimitBackoff(parsed);
    };
    const nextCheckpoint = async ({
      checkpoint,
      pending,
      result,
    }: ReplayContext<RunnerCheckpoint, JsonValue>): Promise<
      CheckpointTransition<RunnerCheckpoint>
    > => {
      const next = await transition(checkpoint, asWorkerResponse(result), {
        requestId: pending.requestId,
        requestBody: pending.requestBody,
        requestDigest: pending.requestDigest,
        receivedAt: pending.result?.receivedAt ?? Date.now(),
      });
      return {
        checkpoint: next,
        credentialSessionActive: checkpointActive(next),
      };
    };
    const handlers = { sendExact, nextCheckpoint, now: Date.now };
    let result: JsonValue;
    if (pending) result = await resumePendingCall(this.journal, handlers);
    else {
      const plannedBody = body();
      result = await runJournaledCall(
        this.journal,
        {
          operation,
          requestId: text(plannedBody.requestId, "request_id"),
          requestBody: JSON.stringify(plannedBody),
          createdAt: Date.now(),
        },
        handlers,
      );
    }
    return asWorkerResponse(result);
  }

  /**
   * ADM-4a, widened in ADM-4c: one identity source per bound root. A watched
   * root with no provider entry has none, and keeps path identity.
   */
  private providerFileIds(): ProviderFileIdSource[] {
    if (this.providerFileIdSources) return this.providerFileIdSources;
    const pdf = this.config.pdfDocQa;
    const account = pdf?.providerOriginal;
    const repository = pdf?.archive.independentBackup.repository;
    if (!account || !repository) return [];
    const credentials = {
      rcloneBinary: repository.rcloneBinary,
      configPath: repository.configPath,
      remoteName: repository.remoteName,
      configIdentityFingerprint: repository.configIdentityFingerprint,
    };
    return providerRootsOf(account).map((root) => ({
      rootAlias: root.rootAlias,
      lookup: async (relativePaths) =>
        await lookupDropboxFileIds(
          {
            credentials,
            refreshPath: account.refreshPath,
            providerAccountIdHash: account.providerAccountIdHash,
            providerRootDirectoryId: root.providerRootDirectoryId,
            providerRootDirectoryIdHash: root.providerRootDirectoryIdHash,
          },
          relativePaths,
        ),
    }));
  }

  /**
   * ADM-4a. Attaches the provider's stable file id to each plan under the
   * provider's root, so a renamed or moved file keeps its identity.
   *
   * Only paths with no remembered id are asked about, at most
   * `MAX_PROVIDER_LOOKUPS_PER_PASS` of them and inside the lookup's own
   * deadline. A steady pass therefore makes no provider call at all, a journal
   * written before ids existed is upgraded a batch at a time as each file is
   * next seen where it already was, and a rename costs one lookup per moved
   * file. Anything left over is asked about on a later pass.
   *
   * Nothing here may fail the pass. An unreachable provider, a deadline, or a
   * budget leaves every plan on the identity it already had, which is exactly
   * today's behaviour.
   */
  private async attachProviderFileIds(
    plans: FilePlan[],
    byPath: Map<string, IdentityBinding>,
  ): Promise<void> {
    const sources = this.providerFileIds();
    if (sources.length === 0) return;
    const bound = new Map(sources.map((source) => [source.rootAlias, source]));
    const under = plans.filter((plan) => bound.has(plan.rootAlias));
    for (const plan of under) {
      const remembered = byPath.get(fileKey(plan))?.providerFileId;
      if (remembered !== undefined) plan.providerFileId = remembered;
    }
    // A path we have never seen is a rename candidate and answers this pass's
    // question; a known path with no id yet is only the lazy upgrade, which any
    // later pass can finish. Asking in that order means a rename inside the
    // budget still resolves in one pass while a large journal is upgrading.
    const wanted = under
      .filter((plan) => plan.providerFileId === undefined)
      .sort(
        (left, right) =>
          Number(byPath.has(fileKey(left))) -
          Number(byPath.has(fileKey(right))),
      );
    // ADM-4c: the budget is the pass's, not each root's, so adding a root
    // cannot multiply the provider calls one pass makes. One root's provider
    // being unreachable leaves that root on path identity and does not stop
    // the others.
    const ask = new Set(wanted.slice(0, MAX_PROVIDER_LOOKUPS_PER_PASS));
    if (ask.size === 0) return;
    const fresh = new Set<string>();
    for (const [rootAlias, source] of bound) {
      const asking = [...ask].filter((plan) => plan.rootAlias === rootAlias);
      if (asking.length === 0) continue;
      let ids: Map<string, string>;
      try {
        ids = await source.lookup(asking.map((plan) => plan.relativePath));
      } catch (error) {
        console.warn(
          `[pipeline] provider file ids unavailable this pass for root ${rootAlias}; identity falls back to paths (${
            error instanceof Error ? error.message : "unknown error"
          })`,
        );
        continue;
      }
      for (const plan of asking) {
        const id = ids.get(plan.relativePath);
        if (id === undefined) continue;
        plan.providerFileId = id;
        fresh.add(id);
      }
    }
    // A remembered id the provider has just answered for another path belongs
    // to that path now: the file moved and something else took its place. The
    // plan that only remembered it falls back to path identity, and the next
    // pass asks the provider for its real id.
    for (const plan of under) {
      if (ask.has(plan) || plan.providerFileId === undefined) continue;
      if (fresh.has(plan.providerFileId)) delete plan.providerFileId;
    }
    // Two watched paths can still resolve to one provider file: the same name
    // in NFC and in NFD, or two spellings a case-insensitive provider does not
    // distinguish. Neither plan may keep an id it does not solely own, because
    // an id on two plans puts one external id on two items, which the journal
    // refuses to write. Both fall back to path identity, which separates them.
    const owners = new Map<string, number>();
    for (const plan of under) {
      if (plan.providerFileId === undefined) continue;
      owners.set(
        plan.providerFileId,
        (owners.get(plan.providerFileId) ?? 0) + 1,
      );
    }
    for (const plan of under) {
      if (plan.providerFileId === undefined) continue;
      if (owners.get(plan.providerFileId)! > 1) {
        console.warn(
          `[pipeline] two watched paths resolve to one provider file; both keep path identity this pass`,
        );
        delete plan.providerFileId;
      }
    }
  }

  /**
   * ADM-4a. The prior binding each plan continues, provider id first.
   *
   * Two rules make the fallback safe. A binding already continued by a provider
   * id is never handed to a second plan, and a path match is refused when the
   * two sides name different provider ids: that path holds a different file
   * now. Either way the plan is unmatched and takes a new identity.
   */
  private matchBindings(
    plans: FilePlan[],
    prior: IdentityBinding[],
    byPath: Map<string, IdentityBinding>,
  ): Map<FilePlan, IdentityBinding> {
    const byProviderId = new Map(
      prior.flatMap((binding) =>
        binding.providerFileId === undefined
          ? []
          : [[binding.providerFileId, binding] as const],
      ),
    );
    const matched = new Map<FilePlan, IdentityBinding>();
    const claimed = new Set<string>();
    const claim = (plan: FilePlan, binding: IdentityBinding | undefined) => {
      if (!binding || claimed.has(binding.externalId)) return;
      matched.set(plan, binding);
      claimed.add(binding.externalId);
    };
    for (const plan of plans) {
      if (plan.providerFileId === undefined) continue;
      claim(plan, byProviderId.get(plan.providerFileId));
    }
    for (const plan of plans) {
      if (matched.has(plan)) continue;
      const binding = byPath.get(fileKey(plan));
      if (
        binding?.providerFileId !== undefined &&
        plan.providerFileId !== undefined &&
        binding.providerFileId !== plan.providerFileId
      ) {
        continue;
      }
      claim(plan, binding);
    }
    return matched;
  }

  /**
   * ADM-4c review. Ends the pass rather than opening a scan that would retire
   * documents, and leaves the owner a way forward.
   *
   * Nothing is written but the terminal checkpoint: every binding the journal
   * held is kept, so the next pass sees exactly what this one did. The code
   * travels out in `PipelineRunResult`, which is what the health check reads,
   * so a refusal is visible on the health page rather than only in a log.
   *
   * `--accept-retirement <code>` is the way through. It is per pass, it must
   * name the exact code being accepted, and it is recorded here with the
   * counts it is overriding, because "the owner confirmed this deletion" is a
   * thing a later reader has to be able to check.
   *
   * ADM-6a. `journal_behind_server` says something different from the other
   * two -- not "these documents are gone", but "this journal is not this
   * source's journal" -- so it names a different remedy: start the worker with
   * this source's own, current journal.
   *
   * Review of this change: it names that remedy and no other. The first draft
   * also offered to remove the journal directory, and in the rehearsal harness
   * that made things worse. The directory holds the archive catalog and the
   * scan cache beside the state file, so removing it ended the next four
   * passes `failed / stale_observation`; removing only the state file left a
   * source with unavailable items ending `identity_review_required` four
   * passes running, with no documented way out. An operator reading a refusal
   * at two in the morning gets the one instruction that works.
   *
   * It takes `--accept-retirement journal_behind_server` all the same, on the
   * same terms as the other two: named explicitly, honoured for one pass, and
   * logged with the per-root counts it overrode. A guard with no override is a
   * guard someone edits the source to get past, and the counts in the log are
   * what a later reader checks the decision against.
   */
  private async refuseRetirement(input: {
    code:
      | "root_selection_would_retire_items"
      | "root_contents_collapsed"
      | "journal_behind_server";
    detail: string;
    prior: IdentityBinding[];
    roots?: string[];
    /** The counts an override would be overriding, for the accept log. */
    counts?: string;
  }): Promise<FilePlan[] | undefined> {
    if (this.options.acceptRetirement === input.code) {
      console.warn(
        `[pipeline] operator accepted ${input.code} for this pass: ${input.detail}${
          input.counts === undefined ? "" : ` (${input.counts})`
        }`,
      );
      return undefined;
    }
    console.warn(
      input.code === "journal_behind_server"
        ? `[pipeline] ${input.detail}; refusing the scan rather than retiring them. Start the worker with this source's own, current journal and run the pass again. If this journal is already this source's own and current, re-run with --accept-retirement journal_behind_server to proceed for this one pass.`
        : `[pipeline] ${input.detail}; refusing the scan rather than retiring them. Re-run with --accept-retirement ${input.code} to confirm this is a real removal.`,
    );
    // The sources screen should name the folder, not just the pass.
    if (input.roots?.length) {
      const reports = this.pendingRootReports.filter(
        (report) =>
          report.rootAlias !== undefined &&
          input.roots!.includes(report.rootAlias),
      );
      if (reports.length > 0) await this.reportRoots(reports, []);
    }
    await this.journal.transitionCheckpoint({
      checkpoint: {
        version: 1,
        phase: "terminal",
        outcome: "incomplete",
        credentialSessionActive: false,
        code: input.code,
        scanned: 0,
        published: 0,
        bindings: input.prior,
      },
      credentialSessionActive: false,
    });
    return [];
  }

  private async startCycle(
    roots: SafeRoot[],
    status: Record<string, unknown>,
  ): Promise<FilePlan[]> {
    const prior =
      this.journal.checkpoint.phase === "terminal"
        ? this.journal.checkpoint.bindings
        : [];
    const plans = await this.discoverPlans(roots);
    const byPath = new Map(prior.map((binding) => [fileKey(binding), binding]));
    await this.attachProviderFileIds(plans, byPath);
    const matched = this.matchBindings(plans, prior, byPath);
    const claimed = new Set([...matched.values()].map((b) => b.externalId));
    const missingBindings = prior.filter(
      (binding) => !claimed.has(binding.externalId),
    );
    const unmatched = plans.filter((plan) => !matched.has(plan));
    const enumeration = status.enumeration as { state?: unknown } | undefined;
    const newSource =
      this.journal.checkpoint.phase === "idle" &&
      enumeration?.state === "never";
    const recovery =
      !newSource &&
      (this.journal.checkpoint.phase === "idle" ||
        (this.journal.checkpoint.phase === "terminal" &&
          this.journal.checkpoint.code === "identity_review_required") ||
        (missingBindings.length > 0 && unmatched.length > 0));
    for (const plan of plans) {
      const retained = matched.get(plan)?.externalId;
      if (retained !== undefined || !recovery) {
        plan.externalId = retained ?? randomUUID();
      }
    }
    // ADM-4c: each side is checked against the checkpoint validator's own
    // bound rather than their sum. The sum refused a full scan beside a whole
    // watched root's worth of vanished items, which is exactly what removing a
    // root looks like: that must become ordinary gaps, not a failed pass.
    if (
      plans.length > MAX_WORKER_SCAN_ENTRIES ||
      missingBindings.length > MAX_IDENTITY_BINDINGS
    ) {
      throw new FilesystemFailure(
        "oversized",
        "identity binding capacity exceeded",
      );
    }
    // ADM-4c review. `reconcileWorkerScan` marks every item not in the scan
    // unavailable, and it runs over the whole account. So a scan that is
    // missing a root, or missing a root's contents, is indistinguishable to
    // the server from every file under it being deleted at once. Neither a
    // config edit, nor a server answer, nor a half-synced disk may be able to
    // say that by accident.
    //
    // Two refusals, because they are two different mistakes. The first is
    // about where the watcher was told to look; the second is about what it
    // found when it looked there.
    const retiring = missingBindings.filter(
      (binding) => !watchedLocation(roots, binding),
    ).length;
    if (retiring >= retirementCircuitBreaker(prior.length)) {
      const refused = await this.refuseRetirement({
        code: "root_selection_would_retire_items",
        detail: `${retiring} of ${prior.length} remembered items are no longer under any watched root`,
        prior,
      });
      if (refused) return refused;
    }
    const collapsed = collapsedRoots(roots, prior, plans, matched);
    if (collapsed.length > 0) {
      const refused = await this.refuseRetirement({
        code: "root_contents_collapsed",
        detail: `watched ${collapsed.length === 1 ? "root" : "roots"} ${collapsed.join(", ")} held documents but this pass found few or none of them`,
        prior,
        roots: collapsed,
      });
      if (refused) return refused;
    }
    // ADM-6a. The two breakers above take the journal's word for what this
    // source holds. This one does not, and so it is the only one that can
    // catch a journal that is not this source's journal at all. It asks only
    // on a normal pass: an identity-recovery pass reconciles to `needs_review`
    // and retires nothing, and a fresh journal in recovery is exactly the
    // legitimate shape this rule would otherwise read as a disaster.
    if (!recovery) {
      const counts = await this.serverItemCounts();
      const gaps = counts && journalBehindServer(roots, prior, counts);
      const gap = gaps?.behind[0];
      if (gaps && gap) {
        const refused = await this.refuseRetirement({
          code: "journal_behind_server",
          detail: `the server holds ${gap.held} live items under watched root ${gap.rootAlias} and this journal remembers ${gap.remembered}`,
          // Every root the guard weighed, not only the one the message names:
          // an override covers the whole pass, so the log records the whole
          // comparison it is overriding.
          counts: gaps.compared
            .map(
              (row) =>
                `${row.rootAlias}: server ${row.held}, journal ${row.remembered}`,
            )
            .join("; "),
          prior,
        });
        if (refused) return refused;
      }
    }
    await this.journal.transitionCheckpoint({
      checkpoint: {
        version: 1,
        phase: "scan_begin",
        mode: recovery ? "identity_recovery" : "normal",
        expectedInventoryEpoch: integer(
          status.inventoryEpoch,
          "inventory_epoch",
        ),
        files: plans,
        missingBindings,
      },
      credentialSessionActive: true,
    });
    return plans;
  }

  private async driveScanBegin(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "scan_begin") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const result = await this.mutation(
      "scan.begin",
      () =>
        request(this.config, "scan.begin", {
          requestId: randomUUID(),
          watcherId: `pipeline-${this.config.sourceAccountId.slice(0, 64)}`,
          connectorVersion:
            this.config.pdfDocQa === undefined ? "p2-8-text-v1" : "p2-9-pdf-v1",
          ...(this.config.hostAffinity
            ? { hostAffinity: this.config.hostAffinity }
            : {}),
          mode: checkpoint.mode,
          expectedInventoryEpoch: checkpoint.expectedInventoryEpoch,
        }),
      (current, response) => {
        if (current.phase !== "scan_begin") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return plannedTerminal(current, code);
        }
        const scanId = text(value.scanId, "scan_id");
        if (value.state !== "open") {
          return {
            ...plannedTerminal(
              current,
              value.state === "needs_review"
                ? "identity_review_required"
                : "scan_advanced",
            ),
            outcome: value.state === "failed" ? "failed" : "incomplete",
            scanId,
          };
        }
        const inventoryEpoch = integer(value.inventoryEpoch, "inventory_epoch");
        const manifestVersion = integer(
          value.manifestVersion,
          "manifest_version",
        );
        const base = {
          mode: current.mode,
          scanId,
          inventoryEpoch,
          manifestVersion,
          files: current.files,
          missingBindings: current.missingBindings,
        };
        return current.mode === "identity_recovery"
          ? {
              version: 1,
              phase: "inventory",
              ...base,
              cursor: null,
              pageCount: 0,
              itemCount: 0,
              identities: [],
            }
          : {
              version: 1,
              phase: "append",
              ...base,
              nextOrdinal: 0,
              identities: [],
              reviewSeen: false,
            };
      },
    );
    if (errorCode(result)) throw new PipelineWorkerError(errorCode(result)!);
  }

  private async driveInventory(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "inventory") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const result = await this.mutation(
      "source.inventoryPage",
      () =>
        request(this.config, "source.inventoryPage", {
          scanId: checkpoint.scanId,
          requestId: randomUUID(),
          expectedInventoryEpoch: checkpoint.inventoryEpoch,
          expectedManifestVersion: checkpoint.manifestVersion,
          paginationOpts: { cursor: checkpoint.cursor, numItems: 50 },
        }),
      (current, response) => {
        if (current.phase !== "inventory") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return scanTerminal(current, "failed", code, true);
        }
        const page = records(value.page, "inventory_page");
        const nextPageCount = current.pageCount + 1;
        const nextItemCount = current.itemCount + page.length;
        if (
          nextPageCount > MAX_INVENTORY_PAGES ||
          nextItemCount > MAX_INVENTORY_ITEMS
        ) {
          return scanTerminal(
            current,
            "incomplete",
            "inventory_capacity_exceeded",
            true,
          );
        }
        const identities = new Map(
          current.identities.map((row) => [row.sourceItemId, row.externalId]),
        );
        for (const row of page) {
          if (row.lifecycle === "tombstone") continue;
          const sourceItemId = text(row.sourceItemId, "source_item_id");
          const externalId = text(row.externalId, "external_id");
          const existing = identities.get(sourceItemId);
          if (existing !== undefined && existing !== externalId) {
            throw new PipelineWorkerError("inventory_identity_conflict");
          }
          identities.set(sourceItemId, externalId);
        }
        if (identities.size > MAX_INVENTORY_ITEMS) {
          return scanTerminal(
            current,
            "incomplete",
            "inventory_capacity_exceeded",
            true,
          );
        }
        const nextIdentities: InventoryIdentity[] = [...identities].map(
          ([sourceItemId, externalId]) => ({ sourceItemId, externalId }),
        );
        if (value.isDone === true) {
          return {
            version: 1,
            phase: "append",
            ...activeScanBase(current),
            nextOrdinal: 0,
            identities: nextIdentities,
            reviewSeen: false,
          };
        }
        if (nextPageCount >= MAX_INVENTORY_PAGES) {
          return scanTerminal(
            current,
            "incomplete",
            "inventory_capacity_exceeded",
            true,
          );
        }
        const cursor = text(value.continueCursor, "inventory_cursor");
        if (cursor === current.cursor) {
          throw new PipelineWorkerError("inventory_cursor_conflict");
        }
        return {
          ...current,
          cursor,
          pageCount: nextPageCount,
          itemCount: nextItemCount,
          identities: nextIdentities,
        };
      },
    );
    if (errorCode(result)) throw new PipelineWorkerError(errorCode(result)!);
  }

  private async driveAppend(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "append") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const offset = checkpoint.nextOrdinal * 4;
    if (offset >= checkpoint.files.length) {
      await this.journal.transitionCheckpoint({
        checkpoint: {
          version: 1,
          phase: "seal_check",
          ...activeScanBase(checkpoint),
          nextOrdinal: checkpoint.nextOrdinal,
          reviewSeen: checkpoint.reviewSeen,
        },
        credentialSessionActive: true,
      });
      return;
    }
    const pagePlans = checkpoint.files.slice(offset, offset + 4);
    const result = await this.mutation(
      "scan.appendPage",
      () =>
        request(this.config, "scan.appendPage", {
          scanId: checkpoint.scanId,
          requestId: randomUUID(),
          ordinal: checkpoint.nextOrdinal,
          entries: pagePlans.map((plan, pageOffset) => {
            try {
              return scanEntry(plan, checkpoint.mode);
            } catch (error) {
              throw tagEntryIndex(error, offset + pageOffset);
            }
          }),
        }),
      (current, response) => {
        if (current.phase !== "append") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return scanTerminal(current, "failed", code, true);
        }
        if (
          value.scanId !== current.scanId ||
          value.ordinal !== current.nextOrdinal
        ) {
          throw new PipelineWorkerError("scan_append_parent_conflict");
        }
        const output = records(value.entries, "append_entries");
        const input = current.files.slice(
          current.nextOrdinal * 4,
          current.nextOrdinal * 4 + 4,
        );
        if (output.length !== input.length) {
          throw new PipelineWorkerError("scan_append_count_conflict");
        }
        const identityMap = new Map(
          current.identities.map((row) => [row.sourceItemId, row.externalId]),
        );
        const files = current.files.map((plan) => ({ ...plan }));
        let reviewSeen = current.reviewSeen;
        for (let index = 0; index < output.length; index += 1) {
          const row = output[index]!;
          const plan = files[current.nextOrdinal * 4 + index]!;
          if (isPdfPlan(plan)) {
            if (row.state !== "queued" && row.state !== "unchanged") {
              delete plan.sourceItemId;
              delete plan.observationEpoch;
              delete plan.processingEpoch;
              delete plan.discoveryState;
            } else {
              const sourceItemId = row.sourceItemId;
              const observationEpoch = row.observationEpoch;
              const processingEpoch = row.processingEpoch;
              if (
                typeof sourceItemId !== "string" ||
                !Number.isSafeInteger(observationEpoch) ||
                !Number.isSafeInteger(processingEpoch)
              ) {
                throw new PipelineWorkerError("archived_append_parent_missing");
              }
              plan.sourceItemId = sourceItemId;
              plan.observationEpoch = observationEpoch as number;
              plan.processingEpoch = processingEpoch as number;
              plan.discoveryState = row.state;
            }
          }
          if (row.state === "needs_review") {
            reviewSeen = true;
            delete plan.externalId;
          }
          if (
            current.mode === "identity_recovery" &&
            (row.state === "unchanged" ||
              row.state === "queued" ||
              row.state === "gap")
          ) {
            const sourceItemId = text(row.sourceItemId, "source_item_id");
            const externalId = identityMap.get(sourceItemId);
            if (!externalId) {
              throw new PipelineWorkerError("inventory_identity_missing");
            }
            if (
              plan.externalId !== undefined &&
              plan.externalId !== externalId
            ) {
              throw new PipelineWorkerError("inventory_identity_conflict");
            }
            plan.externalId = externalId;
          } else if (current.mode === "identity_recovery") {
            delete plan.externalId;
          }
        }
        const nextOrdinal = current.nextOrdinal + 1;
        if (nextOrdinal * 4 >= current.files.length) {
          return {
            version: 1,
            phase: "seal_check",
            ...activeScanBase({ ...current, files }),
            nextOrdinal,
            reviewSeen,
          };
        }
        return {
          ...current,
          files,
          nextOrdinal,
          reviewSeen,
        };
      },
    );
    const code = errorCode(result);
    if (code && this.journal.checkpoint.phase === "append") {
      throw new PipelineWorkerError(code);
    }
  }

  private async driveSealCheck(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "seal_check") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    let health: { status: "healthy" } | { status: "failed"; code: string };
    try {
      const roots = await this.currentRoots();
      health = (await this.sameDiscoveredSnapshot(roots, checkpoint.files))
        ? { status: "healthy" }
        : { status: "failed", code: "unstable" };
    } catch (error) {
      health = {
        status: "failed",
        code: error instanceof FilesystemFailure ? error.code : "unreadable",
      };
    }
    await this.journal.transitionCheckpoint({
      checkpoint: {
        version: 1,
        phase: "seal",
        ...activeScanBase(checkpoint),
        nextOrdinal: checkpoint.nextOrdinal,
        reviewSeen: checkpoint.reviewSeen,
        health,
      },
      credentialSessionActive: true,
    });
  }

  private async driveSeal(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "seal") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const result = await this.mutation(
      "scan.seal",
      () =>
        request(this.config, "scan.seal", {
          scanId: checkpoint.scanId,
          requestId: randomUUID(),
          expectedPageCount: checkpoint.nextOrdinal,
          health: checkpoint.health,
        }),
      (current, response) => {
        if (current.phase !== "seal") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return scanTerminal(current, "failed", code, true);
        }
        if (value.scanId !== current.scanId) {
          throw new PipelineWorkerError("scan_seal_parent_conflict");
        }
        if (current.health.status === "failed") {
          return scanTerminal(current, "failed", current.health.code, false);
        }
        if (value.state === "needs_review") {
          return scanTerminal(
            current,
            "incomplete",
            "identity_review_required",
          );
        }
        if (value.state !== "sealed") {
          return scanTerminal(current, "failed", "scan_failed");
        }
        return {
          version: 1,
          phase: "reconcile",
          ...activeScanBase(current),
          ordinal: 0,
          reviewSeen: current.reviewSeen,
        };
      },
    );
    const code = errorCode(result);
    if (code && this.journal.checkpoint.phase === "seal") {
      throw new PipelineWorkerError(code);
    }
  }

  private async driveReconcile(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "reconcile") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const result = await this.mutation(
      "scan.reconcile",
      () =>
        request(this.config, "scan.reconcile", {
          scanId: checkpoint.scanId,
          requestId: randomUUID(),
          expectedInventoryEpoch: checkpoint.inventoryEpoch,
          ordinal: checkpoint.ordinal,
          maxItems: 50,
        }),
      async (current, response) => {
        if (current.phase !== "reconcile") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return scanTerminal(current, "failed", code, true);
        }
        if (value.scanId !== current.scanId) {
          throw new PipelineWorkerError("reconcile_parent_conflict");
        }
        if (value.done === true) {
          if (value.state === "needs_review") {
            return scanTerminal(
              current,
              "incomplete",
              "identity_review_required",
            );
          }
          if (value.state !== "enumerated") {
            throw new PipelineWorkerError("reconcile_state_invalid");
          }
          let pdfIndex: number;
          try {
            pdfIndex = await this.nextPdfWorkIndex(current.files, 0);
          } catch (error) {
            // P2-31e. Fail closed, but settle the answered page first. A throw
            // from inside a journaled transition never reaches `commitResult`,
            // so `scan.reconcile` stayed unresolved with its answer recorded
            // and every later pass replayed it into the same throw with no
            // round trip. Nothing could drain that but a hand edit, which a
            // refusal must never require. Ending the scan terminal reports the
            // same code, keeps the answer, and lets the next pass start a
            // clean scan instead of re-asking a page the server has finished.
            if (!(error instanceof PipelineWorkerError)) throw error;
            return scanTerminal(current, "failed", error.code, true);
          }
          if (pdfIndex >= 0) {
            return {
              version: 1,
              phase: "archived",
              ...activeScanBase(current),
              pdfIndex,
              step: "intent",
              reservationRound: 0,
              archivedPublished: 0,
            };
          }
          return {
            version: 1,
            phase: "discovery_reserve",
            ...activeScanBase(current),
            round: 0,
          };
        }
        if (current.ordinal + 1 >= MAX_RECONCILE_PAGES) {
          return scanTerminal(
            current,
            "incomplete",
            "reconcile_capacity_exceeded",
            true,
          );
        }
        return { ...current, ordinal: current.ordinal + 1 };
      },
    );
    const code = errorCode(result);
    if (code && this.journal.checkpoint.phase === "reconcile") {
      throw new PipelineWorkerError(code);
    }
  }

  private async driveDiscoveryReserve(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "discovery_reserve") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const result = await this.mutation(
      "discovery.reserve",
      () =>
        request(this.config, "discovery.reserve", {
          requestId: randomUUID(),
          maxItems: 4,
        }),
      (current, response) => {
        if (current.phase !== "discovery_reserve") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return scanTerminal(current, "failed", code, true);
        }
        const targets = records(
          value.targets,
          "discovery_targets",
        ) as unknown as DiscoveryLease[];
        if (targets.length === 0) {
          return {
            version: 1,
            phase: "jobs_reserve",
            scanId: current.scanId,
            scanned: current.files.length,
            published: current.archivedPublished ?? 0,
            bindings: bindingsFromScan(current),
            round: 0,
          };
        }
        if (current.round >= MAX_RESERVATION_ROUNDS) {
          return scanTerminal(
            current,
            "incomplete",
            "discovery_capacity_exceeded",
            true,
          );
        }
        return {
          version: 1,
          phase: "discovery_admit",
          ...activeScanBase(current),
          round: current.round,
          targets,
          index: 0,
          ...(current.archivedPublished === undefined
            ? {}
            : { archivedPublished: current.archivedPublished }),
        };
      },
    );
    if (errorCode(result)) throw new PipelineWorkerError(errorCode(result)!);
  }

  private findRoot(roots: SafeRoot[], alias: string): SafeRoot {
    const root = roots.find((candidate) => candidate.alias === alias);
    if (!root) throw new PipelineWorkerError("root_alias_missing");
    return root;
  }

  private async driveDiscoveryAdmit(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "discovery_admit") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    if (checkpoint.index >= checkpoint.targets.length) {
      await this.journal.transitionCheckpoint({
        checkpoint: {
          version: 1,
          phase: "discovery_reserve",
          ...activeScanBase(checkpoint),
          round: checkpoint.round + 1,
        },
        credentialSessionActive: true,
      });
      return;
    }
    const target = checkpoint.targets[checkpoint.index]!;
    const plan = findDiscoveryPlan(checkpoint.files, target.uri);
    let currentFile: DiscoveryFile | undefined;
    if (!this.journal.pending) {
      if (target.leaseExpiresAt <= Date.now() + LEASE_SAFETY_MARGIN_MS) {
        await this.journal.transitionCheckpoint({
          checkpoint: afterDiscoveryTarget(checkpoint),
          credentialSessionActive: true,
        });
        return;
      }
      if (!plan || !isUtf8Plan(plan)) {
        await this.journal.transitionCheckpoint({
          checkpoint: scanTerminal(
            checkpoint,
            "failed",
            "stale_observation",
            true,
          ),
          credentialSessionActive: true,
        });
        return;
      }
      const roots = await canonicalRoots(this.config);
      currentFile = await readUtf8File(
        this.findRoot(roots, plan.rootAlias),
        plan.relativePath,
        this.config.maxFileBytes,
      );
      if (
        !samePlan(currentFile, plan) ||
        currentFile.sha256 !== target.contentHash ||
        currentFile.byteLength !== target.byteLength
      ) {
        await this.journal.transitionCheckpoint({
          checkpoint: scanTerminal(
            checkpoint,
            "failed",
            "stale_observation",
            true,
          ),
          credentialSessionActive: true,
        });
        return;
      }
    }
    const result = await this.mutation(
      "discovery.admitUtf8",
      () =>
        request(this.config, "discovery.admitUtf8", {
          requestId: randomUUID(),
          workId: target.workId,
          leaseEpoch: target.leaseEpoch,
          leaseToken: target.leaseToken,
          text: currentFile!.text,
        }),
      (current, response) => {
        if (current.phase !== "discovery_admit") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          if (code === "reservation_expired" || code === "lease_conflict") {
            return afterDiscoveryTarget(current);
          }
          if (
            code === "stale_observation" ||
            code === "desired_processing_epoch_conflict"
          ) {
            return scanTerminal(current, "failed", code, true);
          }
          return scanTerminal(current, "failed", code, true);
        }
        const activeTarget = current.targets[current.index];
        if (
          !activeTarget ||
          value.workId !== activeTarget.workId ||
          value.sourceItemId !== activeTarget.sourceItemId ||
          value.desiredProcessingEpoch !== activeTarget.processingEpoch
        ) {
          throw new PipelineWorkerError("admission_parent_conflict");
        }
        return afterDiscoveryTarget(current);
      },
    );
    const code = errorCode(result);
    if (code && this.journal.checkpoint.phase === "discovery_admit") {
      throw new PipelineWorkerError(code);
    }
  }

  private archiveConfiguration(role: ArchiveCopyRole) {
    const pdf = this.requirePdfConfig();
    return role === "primary"
      ? pdf.archive.primary
      : pdf.archive.independentBackup;
  }

  private resticLocation(subject: ArchiveSubject) {
    const backup = this.requirePdfConfig().archive.independentBackup;
    if ("repository" in backup) {
      if (subject !== "parser_output") {
        throw new PipelineWorkerError("archive_remote_original_unsupported");
      }
      return { repository: backup.repository! };
    }
    return { repositoryPath: backup.repositoryPath };
  }

  private providerDeclaration(
    original: OriginalCatalogRow,
    requireFresh = true,
  ) {
    const provider = original.providerOriginal;
    const verified = provider?.verified;
    const locator = provider?.locator;
    if (
      !provider ||
      !verified ||
      !locator?.published ||
      !locator.backup ||
      locator.readbackVerifiedAt === undefined
    )
      throw new PipelineWorkerError("provider_original_not_durable");
    if (requireFresh && !providerProofFresh(provider))
      throw new PipelineWorkerError(
        "provider_verification_stale_review_required",
      );
    return {
      referenceVersion: "provider_original_v1" as const,
      providerKind: "dropbox_v1" as const,
      clientReferenceId: provider.clientReferenceId,
      sourceContentHash: verified.sourceContentHash,
      sourceByteLength: verified.sourceByteLength,
      providerAccountIdHash: verified.providerAccountIdHash,
      providerRootDirectoryIdHash: verified.providerRootDirectoryIdHash,
      providerFileIdHash: verified.providerFileIdHash,
      providerRevision: verified.providerRevision,
      providerContentHash: verified.providerContentHash,
      verifiedAt: verified.verifiedAt,
      locatorBundle: {
        bindingId: provider.bindingId,
        manifestFingerprint: verified.manifestFingerprint,
        recipientFingerprint: locator.recipientFingerprint,
        repositoryKeyDomainFingerprint: locator.repositoryKeyDomainFingerprint,
        repositoryId: locator.backup.repositoryId,
        snapshotId: locator.backup.snapshotId,
        objectName: locator.objectName,
        ciphertextHash: locator.published.ciphertext.sha256,
        ciphertextByteLength: locator.published.ciphertext.byteLength,
        readbackVerifiedAt: locator.readbackVerifiedAt,
      },
      createdAt: provenanceCreatedAt(
        original.createdAt,
        verified.verifiedAt,
        locator.readbackVerifiedAt,
      ),
    };
  }

  private preparedArchiveObject(
    row: OriginalCatalogRow | ProcessingCatalogRow,
    role: ArchiveCopyRole,
  ) {
    const copy = row.copies[role];
    if (!copy.prepared)
      throw new PipelineWorkerError("archive_prepare_missing");
    return {
      ...copy.prepared,
      tempPath: join(
        this.archiveConfiguration(role).directory,
        copy.prepared.tempName,
      ),
    };
  }

  private async recordArchiveAction(
    checkpoint: ArchivedCheckpoint,
    action: NonNullable<ArchivedCheckpoint["preflightAction"]>,
    recoveredBackup?: RecoveredResticBackup,
  ): Promise<RunnerCheckpoint> {
    if (action === "initial") {
      return archivedBase(checkpoint, {
        step: "lookup_original",
        preflightAction: undefined,
      });
    }
    if (action.startsWith("provider_")) {
      const { original, processing } = this.archivedRows(checkpoint);
      const capture = captureFromRows(
        this.requirePdfConfig(),
        original,
        processing,
      );
      return (await this.driveProviderOriginal(
        checkpoint,
        original,
        processing,
        capture.path,
        action,
      ))!;
    }
    const subject: ArchiveSubject = action.startsWith("original_")
      ? "original_bytes"
      : "parser_output";
    const role: ArchiveCopyRole = action.includes("primary")
      ? "primary"
      : "independent_backup";
    const snapshot = action.endsWith("snapshot");
    const { original, processing } = this.archivedRows(checkpoint);
    const row = subject === "original_bytes" ? original : processing;
    const copy = row.copies[role];
    const configured = this.archiveConfiguration(role);
    const prepared = this.preparedArchiveObject(row, role);
    const pdf = this.requirePdfConfig();
    let nextRow: OriginalCatalogRow | ProcessingCatalogRow;
    if (!snapshot) {
      const finalPath = join(configured.directory, copy.objectName);
      let published;
      if (copy.published) {
        await recoverPublishedAgeObject(prepared, finalPath);
        published = { ...copy.published, objectPath: finalPath };
      } else {
        try {
          published = await publishAgeObject(prepared, finalPath);
        } catch (error) {
          if (
            !(error instanceof ArchiveCommandError) ||
            error.code !== "destination_exists"
          ) {
            throw error;
          }
          await recoverPublishedAgeObject(prepared, finalPath);
          published = {
            state: "published" as const,
            objectPath: finalPath,
            source: prepared.source,
            ciphertext: prepared.ciphertext,
            ciphertextDevice: prepared.ciphertextDevice,
            ciphertextInode: prepared.ciphertextInode,
            ageVersion: prepared.ageVersion,
          };
        }
      }
      nextRow = await this.requireCatalog().recordArchivePublished({
        subject,
        catalogId:
          subject === "original_bytes"
            ? original.originalCatalogId
            : processing.processingCatalogId,
        expectedRevision: row.rowRevision,
        role,
        published: publishedArchiveCatalogRecord(published),
        ...(role === "primary"
          ? { readbackVerifiedAt: copy.readbackVerifiedAt ?? Date.now() }
          : {}),
      });
    } else {
      if (role !== "independent_backup" || !copy.published || !copy.restic) {
        throw new PipelineWorkerError("archive_backup_parent_missing");
      }
      let backup;
      if (copy.backup) {
        if (!recoveredBackup) {
          throw new PipelineWorkerError("archive_backup_recovery_missing");
        }
        for (const field of [
          "operationId",
          "snapshotId",
          "objectName",
          "resticVersion",
          "repositoryId",
          "verification",
        ] as const) {
          if (copy.backup[field] !== recoveredBackup[field]) {
            throw new PipelineWorkerError("archive_backup_recovery_conflict");
          }
        }
        if (!equalJson(copy.backup.ciphertext, recoveredBackup.ciphertext)) {
          throw new PipelineWorkerError("archive_backup_recovery_conflict");
        }
        const storedBoundary = copy.backup.boundary;
        if (
          storedBoundary !== undefined &&
          "backend" in storedBoundary &&
          recoveredBackup.boundary === undefined
        ) {
          throw new PipelineWorkerError("archive_backup_recovery_conflict");
        }
        if (recoveredBackup.boundary !== undefined) {
          const recoveredBoundary = recoveredBackup.boundary;
          const relocated =
            !equalJson(storedBoundary, recoveredBoundary) &&
            storedBoundary !== undefined &&
            "backend" in storedBoundary &&
            this.requireCatalog().resolvesBoundaryRelocation({
              oldBoundary: storedBoundary,
              newBoundary: recoveredBoundary,
              artifact: {
                snapshotId: copy.backup.snapshotId,
                objectName: copy.backup.objectName,
                ciphertextSha256: copy.backup.ciphertext.sha256,
                ciphertextByteLength: copy.backup.ciphertext.byteLength,
              },
            });
          if (!equalJson(storedBoundary, recoveredBoundary) && !relocated) {
            throw new PipelineWorkerError("archive_backup_recovery_conflict");
          }
        }
        backup = copy.backup;
      } else if (recoveredBackup) {
        backup = recoveredBackup;
      } else {
        backup = await backupResticObject({
          resticBinary: pdf.archive.independentBackup.resticBinary,
          ...this.resticLocation(subject),
          expectedRepositoryId: copy.restic.repositoryId,
          passwordCommand: pdf.archive.independentBackup.passwordCommand,
          operationId: copy.restic.operationId,
          host: copy.restic.host,
          ciphertextPath: join(configured.directory, copy.objectName),
          expectedCiphertext: copy.published.ciphertext,
          primaryArchiveRoot: pdf.archive.primary.directory,
          backupMode: "independent_backup",
        });
      }
      nextRow = await this.requireCatalog().recordResticBackup({
        subject,
        catalogId:
          subject === "original_bytes"
            ? original.originalCatalogId
            : processing.processingCatalogId,
        expectedRevision: row.rowRevision,
        role: "independent_backup",
        backup,
        readbackVerifiedAt: copy.readbackVerifiedAt ?? Date.now(),
      });
    }
    return archivedBase(checkpoint, {
      step:
        subject === "original_bytes" ? "original_archive" : "parser_archive",
      preflightAction: undefined,
      ...(subject === "original_bytes"
        ? { expectedOriginalRevision: nextRow.rowRevision }
        : { expectedProcessingRevision: nextRow.rowRevision }),
    });
  }

  private async driveArchivedPreflight(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (
      checkpoint.phase !== "archived" ||
      checkpoint.step !== "preflight" ||
      !checkpoint.preflightAction
    ) {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const rows = this.archivedRows(checkpoint);
    const identity = archivedIdentity(
      checkpoint,
      this.archivedPlan(checkpoint),
    );
    const intentDigest = digestArchiveIntent({
      identity,
      original: rows.original,
      processing: rows.processing,
    });
    let recoveredBackup: RecoveredResticBackup | undefined;
    if (checkpoint.preflightAction !== "initial") {
      const pdf = this.requirePdfConfig();
      await probeArchiveTools({
        ageBinary: pdf.archive.ageBinary,
        resticBinary: pdf.archive.independentBackup.resticBinary,
      });
      if (
        checkpoint.preflightAction.endsWith("snapshot") &&
        !checkpoint.preflightAction.startsWith("provider_")
      ) {
        const repository = await probeResticRepository({
          resticBinary: pdf.archive.independentBackup.resticBinary,
          ...this.resticLocation(
            checkpoint.preflightAction.startsWith("original_")
              ? "original_bytes"
              : "parser_output",
          ),
          passwordCommand: pdf.archive.independentBackup.passwordCommand,
        });
        if (
          repository.repositoryId !==
          pdf.archive.independentBackup.expectedRepositoryId
        ) {
          throw new PipelineWorkerError("archive_repository_conflict");
        }
        const { original, processing } = this.archivedRows(checkpoint);
        const subject = checkpoint.preflightAction.startsWith("original_")
          ? "original_bytes"
          : "parser_output";
        const row = subject === "original_bytes" ? original : processing;
        const copy = row.copies.independent_backup;
        if (!copy.published || !copy.restic) {
          throw new PipelineWorkerError("archive_backup_parent_missing");
        }
        try {
          recoveredBackup = await recoverResticBackup({
            resticBinary: pdf.archive.independentBackup.resticBinary,
            ...this.resticLocation(subject),
            expectedRepositoryId: copy.restic.repositoryId,
            passwordCommand: pdf.archive.independentBackup.passwordCommand,
            operationId: copy.restic.operationId,
            host: copy.restic.host,
            objectName: copy.objectName,
            expectedCiphertext: copy.published.ciphertext,
          });
        } catch (error) {
          if (
            !(error instanceof ArchiveCommandError) ||
            error.code !== "not_found"
          ) {
            throw error;
          }
        }
      }
    }
    const cached = this.journal.pending;
    if (
      cached?.operation === "discovery.preflightArchived" &&
      cached.result !== undefined
    ) {
      const parsedBody = JSON.parse(cached.requestBody) as Record<
        string,
        unknown
      >;
      await this.validatePendingBody("discovery.preflightArchived", parsedBody);
      const fresh = asWorkerResponse(
        parseDurableResult(
          "discovery.preflightArchived",
          await this.callWithRateLimitBackoff(parsedBody),
        ),
      );
      const freshError = errorCode(fresh);
      if (freshError) {
        await this.journal.commitResult({
          checkpoint: scanTerminal(checkpoint, "failed", freshError, true),
          credentialSessionActive: true,
        });
        return;
      }
      const freshValue = object(fresh, "discovery.preflightArchived");
      if (
        freshValue.sourceItemId !== identity.sourceItemId ||
        Number(freshValue.expectedDesiredProcessingEpoch) + 1 !==
          identity.processingEpoch ||
        freshValue.archiveIntentDigest !== parsedBody.archiveIntentDigest
      ) {
        throw new PipelineWorkerError("archived_preflight_parent_conflict");
      }
    }
    const result = await this.mutation(
      "discovery.preflightArchived",
      () =>
        request(this.config, "discovery.preflightArchived", {
          requestId: randomUUID(),
          identity,
          archiveIntentDigest: intentDigest,
        }),
      async (current, response, pending) => {
        if (current.phase !== "archived" || current.step !== "preflight") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code === "lease_conflict") return await this.leaseHeld(current);
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "discovery.preflightArchived");
        const plan = this.archivedPlan(current);
        const pendingBody = JSON.parse(pending.requestBody) as Record<
          string,
          unknown
        >;
        if (
          value.sourceItemId !== plan.sourceItemId ||
          Number(value.expectedDesiredProcessingEpoch) + 1 !==
            plan.processingEpoch ||
          value.archiveIntentDigest !== pendingBody.archiveIntentDigest
        ) {
          throw new PipelineWorkerError("archived_preflight_parent_conflict");
        }
        return await this.recordArchiveAction(
          current,
          current.preflightAction!,
          recoveredBackup,
        );
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "preflight"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private async driveArchiveCopies(
    checkpoint: ArchivedCheckpoint,
    subject: ArchiveSubject,
  ): Promise<void> {
    const { original, processing } = this.archivedRows(checkpoint);
    const row = subject === "original_bytes" ? original : processing;
    const pdf = this.requirePdfConfig();
    const capture = captureFromRows(pdf, original, processing);
    const source =
      subject === "original_bytes"
        ? {
            path: capture.path,
            sha256: capture.sha256,
            byteLength: capture.byteLength,
          }
        : processing.parserOutput
          ? {
              path: join(
                pdf.parserOutputRoot,
                processing.parserIntent.outputId,
                processing.parserOutput.rawArtifact.opaqueName,
              ),
              sha256: processing.parserOutput.rawArtifact.sha256,
              byteLength: processing.parserOutput.rawArtifact.byteLength,
            }
          : undefined;
    if (!source) throw new PipelineWorkerError("parser_output_missing");
    // P2-104d. These exact bytes are already archived under the artifact this
    // document is reusing, in both repositories, and admission will select
    // those receipts. Encrypting and publishing a second copy would archive
    // nothing new and then be refused: one parser artifact per (source
    // revision, parser fingerprint), and a receipt may name only its own
    // artifact. The original's copies are not affected, and the provider
    // original still runs below.
    const roles =
      subject === "parser_output" && checkpoint.parserReuse
        ? ([] as const)
        : subject === "original_bytes" && original.providerOriginal
          ? (["primary"] as const)
          : (["primary", "independent_backup"] as const);
    for (const role of roles) {
      const copy = row.copies[role];
      if (!copy.prepared) {
        const configured = this.archiveConfiguration(role);
        const catalogId =
          subject === "original_bytes"
            ? original.originalCatalogId
            : processing.processingCatalogId;
        if (!copy.preparationIntent) {
          const intended =
            await this.requireCatalog().recordArchivePreparationIntent({
              subject,
              catalogId,
              expectedRevision: row.rowRevision,
              role,
              tempName: `${copy.archiveObjectId}.tmp`,
            });
          await this.journal.transitionCheckpoint({
            checkpoint: archivedBase(checkpoint, {
              ...(subject === "original_bytes"
                ? { expectedOriginalRevision: intended.rowRevision }
                : { expectedProcessingRevision: intended.rowRevision }),
            }),
            credentialSessionActive: true,
          });
          return;
        }
        let prepared;
        try {
          prepared = await encryptAgeObject({
            ageBinary: pdf.archive.ageBinary,
            sourcePath: source.path,
            tempOutputPath: join(
              configured.directory,
              copy.preparationIntent.tempName,
            ),
            recipient: configured.recipient,
            expectedSource: {
              sha256: source.sha256,
              byteLength: source.byteLength,
            },
          });
        } catch (error) {
          if (
            !(error instanceof ArchiveCommandError) ||
            error.code !== "destination_exists"
          ) {
            throw error;
          }
          const reviewed = await this.requireCatalog().markReview({
            subject,
            catalogId:
              subject === "original_bytes"
                ? original.originalCatalogId
                : processing.processingCatalogId,
            expectedRevision: row.rowRevision,
            role,
            code: "replacement_detected",
          });
          const reviewedCheckpoint = archivedBase(checkpoint, {
            ...(subject === "original_bytes"
              ? { expectedOriginalRevision: reviewed.rowRevision }
              : { expectedProcessingRevision: reviewed.rowRevision }),
          });
          await this.journal.transitionCheckpoint({
            checkpoint: scanTerminal(
              reviewedCheckpoint,
              "incomplete",
              "archive_recovery_review_required",
            ),
            credentialSessionActive: false,
          });
          return;
        }
        const next = await this.requireCatalog().recordArchivePrepared({
          subject,
          catalogId,
          expectedRevision: row.rowRevision,
          role,
          prepared: preparedArchiveCatalogRecord(prepared),
        });
        await this.journal.transitionCheckpoint({
          checkpoint: archivedBase(checkpoint, {
            ...(subject === "original_bytes"
              ? { expectedOriginalRevision: next.rowRevision }
              : { expectedProcessingRevision: next.rowRevision }),
          }),
          credentialSessionActive: true,
        });
        return;
      }
      if (!copy.published) {
        await this.journal.transitionCheckpoint({
          checkpoint: archivedBase(checkpoint, {
            step: "preflight",
            preflightAction: `${subject === "original_bytes" ? "original" : "parser"}_${role === "primary" ? "primary" : "backup"}_publish`,
          }),
          credentialSessionActive: true,
        });
        return;
      }
      if (role === "independent_backup" && !copy.backup) {
        await this.journal.transitionCheckpoint({
          checkpoint: archivedBase(checkpoint, {
            step: "preflight",
            preflightAction: `${subject === "original_bytes" ? "original" : "parser"}_backup_snapshot`,
          }),
          credentialSessionActive: true,
        });
        return;
      }
    }
    if (subject === "parser_output" && original.providerOriginal) {
      await this.driveProviderOriginal(
        checkpoint,
        original,
        processing,
        capture.path,
      );
      return;
    }
    await this.journal.transitionCheckpoint({
      checkpoint: archivedBase(checkpoint, {
        step: subject === "original_bytes" ? "parse" : "reserve",
      }),
      credentialSessionActive: true,
    });
  }

  private async driveProviderOriginal(
    checkpoint: ArchivedCheckpoint,
    original: OriginalCatalogRow,
    processing: ProcessingCatalogRow,
    capturePath: string,
    authorizedAction?: NonNullable<ArchivedCheckpoint["preflightAction"]>,
  ): Promise<RunnerCheckpoint | void> {
    const pdf = this.requirePdfConfig();
    const account = pdf.providerOriginal;
    const state = original.providerOriginal;
    if (!account || !state || !("repository" in pdf.archive.independentBackup))
      throw new PipelineWorkerError("provider_original_configuration_missing");
    const remoteRepository = pdf.archive.independentBackup.repository!;
    const plan = this.archivedPlan(checkpoint);
    const provider = providerBinding(account, plan.rootAlias);
    if (state.locator.reviewCode)
      throw new PipelineWorkerError(
        "provider_locator_recovery_review_required",
      );
    let loaded = await loadProviderBinding({
      registryDirectory: provider.registryDirectory,
      bindingId: state.bindingId,
    });
    const requiredAction = !state.verified
      ? "provider_verify"
      : !state.locator.prepared
        ? "provider_locator_prepare"
        : !state.locator.published
          ? "provider_locator_publish"
          : !state.locator.backup
            ? "provider_locator_snapshot"
            : undefined;
    if (authorizedAction === undefined) {
      if (requiredAction === undefined) {
        await this.journal.transitionCheckpoint({
          checkpoint: archivedBase(checkpoint, { step: "reserve" }),
          credentialSessionActive: true,
        });
      } else {
        await this.journal.transitionCheckpoint({
          checkpoint: archivedBase(checkpoint, {
            step: "preflight",
            preflightAction: requiredAction,
          }),
          credentialSessionActive: true,
        });
      }
      return;
    }
    if (authorizedAction !== requiredAction)
      throw new PipelineWorkerError("provider_action_conflict");
    if (!state.verified) {
      if (!loaded) {
        const verified = await verifyDropboxOriginal({
          credentials: {
            rcloneBinary: remoteRepository.rcloneBinary,
            configPath: remoteRepository.configPath,
            remoteName: remoteRepository.remoteName,
            configIdentityFingerprint:
              remoteRepository.configIdentityFingerprint,
          },
          refreshPath: provider.refreshPath,
          capturePath,
          sourceContentHash: original.origin.sha256,
          sourceByteLength: original.origin.byteLength,
          providerAccountIdHash: provider.providerAccountIdHash,
          providerRootDirectoryIdHash: provider.providerRootDirectoryIdHash,
          providerRootDirectoryId: provider.providerRootDirectoryId,
          relativePath: plan.relativePath,
          bindingId: state.bindingId,
        });
        const persisted = await persistProviderBinding({
          registryDirectory: provider.registryDirectory,
          verified,
        });
        loaded = { persisted, verified };
      }
      if (
        loaded.verified.metadata.providerAccountIdHash !==
          provider.providerAccountIdHash ||
        loaded.verified.metadata.providerRootDirectoryIdHash !==
          provider.providerRootDirectoryIdHash ||
        loaded.verified.metadata.sourceContentHash !== original.origin.sha256 ||
        loaded.verified.metadata.sourceByteLength !==
          original.origin.byteLength ||
        loaded.verified.binding.providerRootDirectoryId !==
          provider.providerRootDirectoryId ||
        loaded.verified.binding.relativePath !== plan.relativePath
      )
        throw new PipelineWorkerError("provider_locator_registry_conflict");
      const next = await this.requireCatalog().recordProviderVerified({
        catalogId: original.originalCatalogId,
        expectedRevision: original.rowRevision,
        verified: {
          providerAccountIdHash: loaded.verified.metadata.providerAccountIdHash,
          providerRootDirectoryIdHash:
            loaded.verified.metadata.providerRootDirectoryIdHash,
          providerFileIdHash: loaded.verified.metadata.providerFileIdHash,
          providerRevision: loaded.verified.metadata.providerRevision,
          providerContentHash: loaded.verified.metadata.providerContentHash,
          sourceContentHash: loaded.verified.metadata.sourceContentHash,
          sourceByteLength: loaded.verified.metadata.sourceByteLength,
          verifiedAt: loaded.verified.metadata.verifiedAt,
          manifestFingerprint: loaded.persisted.manifestFingerprint,
          manifestByteLength: loaded.persisted.manifestByteLength,
        },
      });
      return archivedBase(checkpoint, {
        step: "parser_archive",
        preflightAction: undefined,
        expectedOriginalRevision: next.rowRevision,
      });
    }
    if (
      !loaded ||
      loaded.persisted.manifestFingerprint !==
        state.verified.manifestFingerprint
    )
      throw new PipelineWorkerError("provider_locator_registry_missing");
    const copy = state.locator;
    const configured = pdf.archive.independentBackup;
    if (!copy.preparationIntent) {
      const next = await this.requireCatalog().updateProviderLocator({
        catalogId: original.originalCatalogId,
        expectedRevision: original.rowRevision,
        update: (value) => {
          value.preparationIntent = {
            tempName: `${value.archiveObjectId}.tmp`,
          };
        },
      });
      return archivedBase(checkpoint, {
        step: "parser_archive",
        preflightAction: undefined,
        expectedOriginalRevision: next.rowRevision,
      });
    }
    if (!copy.prepared) {
      let prepared;
      try {
        prepared = await encryptAgeObject({
          ageBinary: pdf.archive.ageBinary,
          sourcePath: loaded.persisted.manifestPath,
          tempOutputPath: join(
            configured.directory,
            copy.preparationIntent.tempName,
          ),
          recipient: configured.recipient,
          expectedSource: {
            sha256: state.verified.manifestFingerprint,
            byteLength: state.verified.manifestByteLength,
          },
        });
      } catch (error) {
        if (
          error instanceof ArchiveCommandError &&
          error.code === "destination_exists"
        ) {
          const reviewed = await this.requireCatalog().updateProviderLocator({
            catalogId: original.originalCatalogId,
            expectedRevision: original.rowRevision,
            update: (value) => {
              value.reviewCode = "replacement_detected";
            },
          });
          return scanTerminal(
            archivedBase(checkpoint, {
              expectedOriginalRevision: reviewed.rowRevision,
              preflightAction: undefined,
            }),
            "incomplete",
            "provider_locator_recovery_review_required",
          );
        }
        throw error;
      }
      const next = await this.requireCatalog().updateProviderLocator({
        catalogId: original.originalCatalogId,
        expectedRevision: original.rowRevision,
        update: (value) => {
          value.prepared = preparedArchiveCatalogRecord(prepared);
        },
      });
      return archivedBase(checkpoint, {
        step: "parser_archive",
        preflightAction: undefined,
        expectedOriginalRevision: next.rowRevision,
      });
    }
    const prepared = {
      ...copy.prepared,
      tempPath: join(configured.directory, copy.prepared.tempName),
    };
    if (!copy.published) {
      const finalPath = join(configured.directory, copy.objectName);
      let published;
      try {
        published = await publishAgeObject(prepared, finalPath);
      } catch (error) {
        if (
          !(error instanceof ArchiveCommandError) ||
          error.code !== "destination_exists"
        )
          throw error;
        await recoverPublishedAgeObject(prepared, finalPath);
        published = {
          state: "published" as const,
          objectPath: finalPath,
          source: prepared.source,
          ciphertext: prepared.ciphertext,
          ciphertextDevice: prepared.ciphertextDevice,
          ciphertextInode: prepared.ciphertextInode,
          ageVersion: prepared.ageVersion,
        };
      }
      const next = await this.requireCatalog().updateProviderLocator({
        catalogId: original.originalCatalogId,
        expectedRevision: original.rowRevision,
        update: (value) => {
          value.published = publishedArchiveCatalogRecord(published);
        },
      });
      return archivedBase(checkpoint, {
        step: "parser_archive",
        preflightAction: undefined,
        expectedOriginalRevision: next.rowRevision,
      });
    }
    if (!copy.backup) {
      const common = {
        resticBinary: configured.resticBinary,
        repository: remoteRepository,
        expectedRepositoryId: configured.expectedRepositoryId,
        passwordCommand: configured.passwordCommand,
        operationId: copy.restic!.operationId,
        host: copy.restic!.host,
        objectName: copy.objectName,
        expectedCiphertext: copy.published.ciphertext,
      };
      let backup: RecoveredResticBackup | ResticBackupResult | undefined;
      try {
        backup = await recoverResticBackup(common);
      } catch (error) {
        if (
          !(error instanceof ArchiveCommandError) ||
          error.code !== "not_found"
        )
          throw error;
      }
      backup ??= await backupResticObject({
        ...common,
        ciphertextPath: join(configured.directory, copy.objectName),
        primaryArchiveRoot: pdf.archive.primary.directory,
        backupMode: "independent_backup",
      });
      const next = await this.requireCatalog().updateProviderLocator({
        catalogId: original.originalCatalogId,
        expectedRevision: original.rowRevision,
        update: (value) => {
          value.backup = backup;
          value.readbackVerifiedAt = Date.now();
        },
      });
      return archivedBase(checkpoint, {
        step: "parser_archive",
        preflightAction: undefined,
        expectedOriginalRevision: next.rowRevision,
      });
    }
    return archivedBase(checkpoint, {
      step: "reserve",
      preflightAction: undefined,
    });
  }

  /**
   * P2-31a. Redoes the two checks a provider original declaration must carry
   * fresh, for an original whose admission was interrupted after its locator
   * was durable. Nothing else in the archived flow re-verifies once the locator
   * is complete, so a resumed pass would otherwise declare a proof the server
   * refuses, forever.
   *
   * This reads the provider and the backup snapshot again and writes two local
   * timestamps. It mutates no archive object and nothing server side, so unlike
   * the locator actions it needs no `discovery.preflightArchived` round trip to
   * authorize it. That is also the only route that works here:
   * `preflightArchivedDiscovery` refuses a row that holds any lease, expired or
   * not, and a row resumed at `admit` always holds one.
   *
   * The registry manifest is deliberately not rewritten. Its `verifiedAt`
   * records the first successful verification, which stays true, and rewriting
   * it would change `manifestFingerprint` and invalidate the published
   * ciphertext and its snapshot. Only an original this space has never admitted
   * may refresh; the caller checks that, and `refreshProviderProof` on the
   * catalog refuses an admitted row and any moved identity.
   *
   * The catalog write commits before the checkpoint does. A crash in between is
   * harmless: the next pass sees a fresh proof and skips straight to admitting.
   */
  private async refreshProviderProof(
    checkpoint: ArchivedCheckpoint,
  ): Promise<void> {
    const { original, processing } = this.archivedRows(checkpoint);
    const pdf = this.requirePdfConfig();
    const account = pdf.providerOriginal;
    const state = original.providerOriginal;
    if (!account || !state || !("repository" in pdf.archive.independentBackup))
      throw new PipelineWorkerError("provider_original_configuration_missing");
    const verified = state.verified;
    const copy = state.locator;
    if (!verified || !copy.published || !copy.backup || !copy.restic)
      throw new PipelineWorkerError("provider_original_not_durable");
    if (copy.reviewCode)
      throw new PipelineWorkerError(
        "provider_locator_recovery_review_required",
      );
    const plan = this.archivedPlan(checkpoint);
    const provider = providerBinding(account, plan.rootAlias);
    const remoteRepository = pdf.archive.independentBackup.repository!;
    const configured = pdf.archive.independentBackup;
    const loaded = await loadProviderBinding({
      registryDirectory: provider.registryDirectory,
      bindingId: state.bindingId,
    });
    if (loaded?.persisted.manifestFingerprint !== verified.manifestFingerprint)
      throw new PipelineWorkerError("provider_locator_registry_missing");
    const reverified = await verifyDropboxOriginal({
      credentials: {
        rcloneBinary: remoteRepository.rcloneBinary,
        configPath: remoteRepository.configPath,
        remoteName: remoteRepository.remoteName,
        configIdentityFingerprint: remoteRepository.configIdentityFingerprint,
      },
      refreshPath: provider.refreshPath,
      capturePath: captureFromRows(pdf, original, processing).path,
      sourceContentHash: original.origin.sha256,
      sourceByteLength: original.origin.byteLength,
      providerAccountIdHash: provider.providerAccountIdHash,
      providerRootDirectoryIdHash: provider.providerRootDirectoryIdHash,
      providerRootDirectoryId: provider.providerRootDirectoryId,
      relativePath: plan.relativePath,
      bindingId: state.bindingId,
      expectedProviderFileIdHash: verified.providerFileIdHash,
    });
    const readback = await recoverResticBackup({
      resticBinary: configured.resticBinary,
      repository: remoteRepository,
      expectedRepositoryId: configured.expectedRepositoryId,
      passwordCommand: configured.passwordCommand,
      operationId: copy.restic.operationId,
      host: copy.restic.host,
      objectName: copy.objectName,
      expectedCiphertext: copy.published.ciphertext,
    });
    const next = await this.requireCatalog().refreshProviderProof({
      catalogId: original.originalCatalogId,
      expectedRevision: original.rowRevision,
      verified: reverified.metadata,
      readback,
    });
    if (!providerProofFresh(next.providerOriginal!))
      throw new PipelineWorkerError(
        "provider_verification_stale_review_required",
      );
    await this.journal.transitionCheckpoint({
      checkpoint: archivedBase(checkpoint, {
        expectedOriginalRevision: next.rowRevision,
      }),
      credentialSessionActive: true,
    });
  }

  /**
   * P2-31f. The positive control on the automatic receipt clear: proof that
   * the server this pass is talking to still knows a receipt this worker knows
   * is good. Without one, a backend that has lost everything is
   * indistinguishable from the one misrouted original the repair exists for,
   * and the repair would retire every receipt in the catalog, one pass at a
   * time.
   *
   * No such read exists mid pass. `POSITIVE_CONTROL_UNAVAILABLE_BY_DESIGN` in
   * `receiptClearSafety.ts` records the three that were traced and why each is
   * refused, unavailable or not a probe at all. The first of them was tried in
   * this method and is now proved impossible against the real server, so
   * rather than send a request that can only come back refused and read that
   * as evidence about the backend, this answers honestly.
   *
   * `"ok"` therefore means only one thing: there is no other receipt in the
   * catalog, so there is nothing a mass void could be hiding and nothing to
   * prove the backend with. Every other catalog gets `"unavailable"`, which
   * refuses and routes the document to `run --retry-parked --operator-clear`.
   */
  private async receiptPositiveControl(
    checkpoint: ArchivedCheckpoint,
  ): Promise<PositiveControl> {
    return positiveControlRequired(
      this.requireCatalog().listOriginals(),
      checkpoint.originalCatalogId ?? "",
    )
      ? "unavailable"
      : "ok";
  }

  /**
   * P2-31f. Retires an admission receipt the authoritative server says it does
   * not hold, and returns the checkpoint that carries on to `capture`, or the
   * refusal that says why it may not be retired without a person.
   *
   * `automaticReceiptClearRefusal` holds the conditions, shared with the
   * `reconcile-receipts` command so the two routes cannot drift: the row
   * conditions P2-31d proved, plus the three limits that make this safe to do
   * unattended. Nothing here decides anything on its own.
   */
  private async selfHealVoidReceipt(
    checkpoint: ArchivedCheckpoint,
  ): Promise<RunnerCheckpoint | ReceiptClearRefusal> {
    const catalog = this.requireCatalog();
    const { original, processing } = this.archivedRows(checkpoint);
    if (!original.cloud) return "already_reconciled";
    const shared = {
      original,
      processing,
      processings: catalog.listProcessings(),
    };
    // `--operator-clear` is a person standing in for the limits that exist
    // only because a pass decides alone. The conditions about this document
    // still hold either way, and so does the count they asked for: the
    // relaxed rules apply to every document whose own lookup comes back not
    // found, which is not the same set as the parked ones, so the pass stops
    // at the number the operator stated rather than at whatever it meets.
    const refusal = this.options.operatorClear
      ? ((this.operatorClears >= (this.options.maxClears ?? 0)
          ? "operator_clear_limit"
          : undefined) ?? operatorReceiptClearRefusal(shared))
      : await automaticReceiptClearRefusal({
          ...shared,
          originals: catalog.listOriginals(),
          now: Date.now(),
          positiveControl: () => this.receiptPositiveControl(checkpoint),
        });
    if (refusal) return refusal;
    const by = this.options.operatorClear ? "operator" : "pass";
    if (by === "operator") {
      if (this.operatorClears === 0) {
        // Printed once, before the first clear, so the operator sees what they
        // are acting on rather than only what happened. Counts only.
        process.stderr.write(
          `${JSON.stringify({
            event: "operator_clear_begin",
            parkedOriginals: catalog
              .listOriginals()
              .filter((row) => row.admissionBlock).length,
            maxClears: this.options.maxClears ?? 0,
            note: "relaxed rules apply to every document in this pass whose own lookup returns a well-formed not found, which can exceed the parked count",
          })}\n`,
        );
      }
      this.operatorClears += 1;
    }
    const clearedAt = Date.now();
    const nextProcessing = (await catalog.clearVoidAdmission({
      subject: "parser_output",
      catalogId: processing.processingCatalogId,
      expectedRevision: processing.rowRevision,
      clearedAt,
      by,
    })) as ProcessingCatalogRow;
    const nextOriginal = (await catalog.clearVoidAdmission({
      subject: "original_bytes",
      catalogId: original.originalCatalogId,
      expectedRevision: original.rowRevision,
      clearedAt,
      by,
    })) as OriginalCatalogRow;
    return archivedBase(checkpoint, {
      step: "capture",
      receiptChecked: true,
      discoveryLease: liveDiscoveryLease(checkpoint),
      expectedOriginalRevision: nextOriginal.rowRevision,
      expectedProcessingRevision: nextProcessing.rowRevision,
    });
  }

  private async driveArchivedLookupOriginal(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (
      checkpoint.phase !== "archived" ||
      checkpoint.step !== "lookup_original"
    ) {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const identity = archivedIdentity(
      checkpoint,
      this.archivedPlan(checkpoint),
    );
    const result = await this.mutation(
      "discovery.lookupArchivedAdmission",
      () =>
        request(this.config, "discovery.lookupArchivedAdmission", {
          requestId: randomUUID(),
          identity,
          lookup: { mode: "original" },
        }),
      async (current, response, pending) => {
        if (
          current.phase !== "archived" ||
          current.step !== "lookup_original"
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "discovery.lookupArchivedAdmission");
        if (value.mode !== "original") {
          throw new PipelineWorkerError("archived_lookup_mode_conflict");
        }
        if (value.found !== true) {
          // P2-31c. The server does not know this revision, yet this catalog
          // row holds an admission receipt for it. The two cannot both be
          // true of the same backend.
          //
          // It happened on 2026-09-18. A web build carried both a Convex and a
          // PostgreSQL leg behind a surface flag that fell back to Convex for
          // any value but the exact string `postgres`, and a dashboard
          // redeploy served the Convex leg for about ten minutes. An admit
          // committed there and returned Convex ids, which `recordOriginalCloud`
          // stored as `cloud`. The next build removed that leg, so every later
          // pass met a PostgreSQL deployment that had never seen the item while
          // the catalog still claimed it was admitted. That leg is gone from
          // main and cannot recur, but the receipt it left behind is durable.
          //
          // Answered before anything downstream can mistake this for a
          // provider problem: the P2-31b refusal at `admit` would otherwise be
          // the first thing an operator saw, and it names a reference the
          // authoritative server does not hold. Nothing further is sent and no
          // discovery attempt is spent.
          //
          // P2-31f. P2-31d made clearing the receipt an operator command
          // because a pass that dropped `cloud` on a server's silence would
          // re-admit anything a temporary misrouting touched. The conditions
          // that command enforces are checkable right here, so the pass runs
          // them itself (`selfHealVoidReceipt`) rather than throwing and
          // waiting for a person. What the command also had and a pass does
          // not is the operator reading the dry-run counts first, so the
          // automatic route carries its own limits. Outside any of them the
          // document is parked, not cleared, and the code says which kind of
          // refusal it was: this row needs a person, or stop, the backend
          // itself may be wrong.
          if (this.archivedRows(current).original.cloud) {
            const healed = await this.selfHealVoidReceipt(current);
            if (typeof healed !== "string") return healed;
            // The exact refusal reaches the watcher log, because the park code
            // deliberately does not separate "the probe never ran" from "the
            // server denied a receipt it should know", and that difference is
            // the first thing worth knowing. A closed enum, no names.
            process.stderr.write(
              `${JSON.stringify({ event: "receipt_clear_refused", reason: healed })}\n`,
            );
            return await this.parkedCheckpoint(
              current,
              healed === "positive_control_failed" ||
                healed === "positive_control_unavailable" ||
                healed === "daily_clear_limit" ||
                healed === "operator_clear_limit"
                ? "receipt_clear_refused_by_safety_limit"
                : "original_receipt_unknown_to_server",
            );
          }
          return archivedBase(current, {
            step: "capture",
            receiptChecked: true,
          });
        }
        let { original } = this.archivedRows(current);
        const provider = original.providerOriginal !== undefined;
        const responseProvider = "originalProviderReferenceId" in value;
        if (provider !== responseProvider)
          throw new PipelineWorkerError("archived_recovery_branch_conflict");
        // P2-31f: two admissions disagree about which revision was accepted
        // for this one file. Nothing about any other file is in doubt, so the
        // document is parked and the pass walks on. Parked rather than healed:
        // picking a revision could publish the wrong bytes under a receipt
        // that names the other, which is a decision a person has to make.
        if (admissionRevisionConflict(original, value))
          return await this.parkedCheckpoint(
            current,
            "original_receipt_revision_conflict",
          );
        const originalReceipts = [
          ["primary", "originalPrimaryReceiptId"],
          ...(provider
            ? []
            : [["independent_backup", "originalBackupReceiptId"] as const]),
        ] as const;
        for (const [role, receiptField] of originalReceipts) {
          if (!original.copies[role].published) {
            throw new PipelineWorkerError(
              "archived_original_recovery_incomplete",
            );
          }
          if (!original.copies[role].cloudReceipt) {
            original = (await this.requireCatalog().recordCloudReceipt({
              subject: "original_bytes",
              catalogId: original.originalCatalogId,
              expectedRevision: original.rowRevision,
              role,
              receiptId: text(value[receiptField], "archive_receipt_id"),
              requestDigest: pending.requestDigest,
              recordedAt: pending.receivedAt,
            })) as OriginalCatalogRow;
          }
        }
        if (!original.cloud) {
          original = await this.requireCatalog().recordOriginalCloud({
            catalogId: original.originalCatalogId,
            expectedRevision: original.rowRevision,
            cloud: {
              sourceItemId: identity.sourceItemId,
              sourceRevisionId: text(
                value.sourceRevisionId,
                "source_revision_id",
              ),
              primaryReceiptId: original.copies.primary.cloudReceipt!.receiptId,
              ...(provider
                ? {
                    providerReferenceId: text(
                      value.originalProviderReferenceId,
                      "original_provider_reference_id",
                    ),
                    providerBindingEpoch: integer(
                      value.originalProviderBindingEpoch,
                      "original_provider_binding_epoch",
                    ),
                  }
                : {
                    backupReceiptId:
                      original.copies.independent_backup.cloudReceipt!
                        .receiptId,
                  }),
              admittedAt: pending.receivedAt,
            },
          });
        }
        return archivedBase(current, {
          step: "capture",
          expectedOriginalRevision: original.rowRevision,
          // P2-104d. These bytes are already admitted and the receipts over
          // them are immutable, bound to the admission that created them. A
          // second processing generation cannot declare them again -- a fresh
          // admission carries a fresh request digest and the stored receipt
          // refuses it -- so it selects them.
          //
          // P2-104e. A provider original is the same case and was left out:
          // its reference is bound to the admission that declared it, so the
          // second generation selects the bound reference the server names
          // here. Left out, every document of a provider source walked to
          // `admit`, was sent back to `lookup_original` by the P2-31b guard
          // with its live lease dropped, and failed the pass at the second
          // `reserve` with `lease_conflict` against its own lease.
          ...(provider
            ? {
                originalReuse: {
                  primaryReceiptId: text(
                    value.originalPrimaryReceiptId,
                    "original_primary_receipt_id",
                  ),
                  primaryBindingEpoch: integer(
                    value.originalPrimaryBindingEpoch,
                    "original_primary_binding_epoch",
                  ),
                  providerReferenceId: text(
                    value.originalProviderReferenceId,
                    "original_provider_reference_id",
                  ),
                  providerBindingEpoch: integer(
                    value.originalProviderBindingEpoch,
                    "original_provider_binding_epoch",
                  ),
                },
              }
            : {
                originalReuse: {
                  primaryReceiptId: text(
                    value.originalPrimaryReceiptId,
                    "original_primary_receipt_id",
                  ),
                  primaryBindingEpoch: integer(
                    value.originalPrimaryBindingEpoch,
                    "original_primary_binding_epoch",
                  ),
                  backupReceiptId: text(
                    value.originalBackupReceiptId,
                    "original_backup_receipt_id",
                  ),
                  backupBindingEpoch: integer(
                    value.originalBackupBindingEpoch,
                    "original_backup_binding_epoch",
                  ),
                },
              }),
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "lookup_original"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private async driveArchivedCapture(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "capture") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const pdf = this.requirePdfConfig();
    const plan = this.archivedPlan(checkpoint);
    const rows = this.archivedRows(checkpoint);
    let processing = rows.processing;
    const mediaType = planMediaType(plan);
    if (processing.capture) {
      await inspectCapturedPdf({
        captureDirectory: pdf.captureDirectory,
        captureId: processing.captureIntent.captureId,
        expected: {
          sha256: rows.original.origin.sha256,
          byteLength: rows.original.origin.byteLength,
          sourceModifiedAt: processing.capture.sourceModifiedAt,
        },
        expectedDirectory: {
          path: pdf.captureDirectory,
          ...processing.captureIntent.directory,
        },
        mediaType,
      });
    } else {
      const expected = {
        sha256: plan.sha256,
        byteLength: plan.byteLength,
        sourceModifiedAt: plan.sourceModifiedAt,
      };
      const capturePath = join(
        pdf.captureDirectory,
        captureFileName(processing.captureIntent.captureId, mediaType),
      );
      const exists = await lstat(capturePath)
        .then(() => true)
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        });
      const capture = exists
        ? await inspectCapturedPdf({
            captureDirectory: pdf.captureDirectory,
            captureId: processing.captureIntent.captureId,
            expected,
            expectedDirectory: {
              path: pdf.captureDirectory,
              ...processing.captureIntent.directory,
            },
            mediaType,
          })
        : await capturePdfFile({
            root: this.findRoot(
              await canonicalRoots(this.config),
              plan.rootAlias,
            ),
            relativePath: plan.relativePath,
            captureDirectory: pdf.captureDirectory,
            captureId: processing.captureIntent.captureId,
            expected,
            mediaType,
          });
      processing = await this.requireCatalog().recordCapture({
        catalogId: processing.processingCatalogId,
        expectedRevision: processing.rowRevision,
        capture: captureCatalogRecord(capture),
      });
    }
    await this.journal.transitionCheckpoint({
      checkpoint: archivedBase(checkpoint, {
        step: rows.original.cloud ? "parse" : "original_archive",
        expectedProcessingRevision: processing.rowRevision,
      }),
      credentialSessionActive: true,
    });
  }

  /**
   * What a reopen of this document's artifact pair has to prove. The class
   * chooses where the manifest slot comes from: the docling lane's prepared
   * model manifest, or the workbook reader's own version digest, which is what
   * a lane with no model assets has instead.
   */
  private parserRecovery(
    original: OriginalCatalogRow,
    processing: ProcessingCatalogRow,
    profileId: BinaryParserProfileId,
  ): ParserOutputRecoveryInput & { profileId: BinaryParserProfileId } {
    const pdf = this.requirePdfConfig();
    const modelManifestSha256 =
      profileId === "spreadsheet_v1"
        ? SPREADSHEET_READER_MANIFEST_SHA256
        : this.preparedPdfProfile?.modelManifestSha256;
    if (modelManifestSha256 === undefined) {
      throw new PipelineWorkerError("parser_profile_unverified");
    }
    return {
      capture: captureFromRows(pdf, original, processing),
      outputRoot: pdf.parserOutputRoot,
      outputIntent: parserOutputIntentCore(processing.parserIntent),
      expectedParserFingerprint: processing.fingerprints.parserFingerprint,
      expectedExtractionConfigurationFingerprint:
        processing.fingerprints.extractionConfigurationFingerprint,
      expectedModelManifestSha256: modelManifestSha256,
      profileId,
    };
  }

  private async driveArchivedParse(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "parse") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const { original, processing: current } = this.archivedRows(checkpoint);
    const pdf = this.requirePdfConfig();
    const profileId = this.archivedPlan(checkpoint).parserProfileId;
    let processing = current;
    if (processing.parserOutput) {
      await inspectCapturedParserOutput(
        this.parserRecovery(original, processing, profileId),
      );
    } else {
      const intent = await inspectParserOutputIntent({
        outputRoot: pdf.parserOutputRoot,
        outputId: processing.parserIntent.outputId,
        requireEmpty: false,
      });
      if (!equalJson(intent, parserOutputIntentCore(processing.parserIntent))) {
        throw new PipelineWorkerError("parser_output_intent_conflict");
      }
      const outputDirectory = join(
        pdf.parserOutputRoot,
        processing.parserIntent.outputId,
      );
      const outputPresence = await Promise.all(
        ["lossless.json", "bundle.json"].map((name) =>
          lstat(join(outputDirectory, name))
            .then(() => true)
            .catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return false;
              throw error;
            }),
        ),
      );
      if (outputPresence[0] !== outputPresence[1]) {
        throw new PipelineWorkerError("parser_output_incomplete");
      }
      if (!outputPresence[0]) {
        // A run interrupted after the work directory was reserved but
        // before the parser wrote its evidence leaves only empty
        // `.home-<id>` / `.tmp-<id>` scaffolding behind. The work ID is
        // deterministic, so a resumed run re-targets that same directory;
        // clear the leftover scaffolding so `runCapturedPdfParser`'s
        // require-empty precondition holds. Evidence, and anything that
        // isn't empty known scaffolding, is left alone and still surfaces
        // as `destination_exists`.
        await reclaimStaleParserOutputDirectory({
          outputRoot: pdf.parserOutputRoot,
          outputIntent: intent,
        });
      }
      const output = outputPresence[0]
        ? await inspectCapturedParserOutput(
            this.parserRecovery(original, processing, profileId),
          )
        : profileId === "spreadsheet_v1"
          ? // The sibling lane: the same capture in, the same artifact pair
            // out, and no sandbox, model manifest or Python runtime, because
            // the reader is this process.
            await runCapturedWorkbookParser({
              capture: captureFromRows(pdf, original, processing),
              outputDirectory,
              outputId: processing.parserIntent.outputId,
            })
          : await runCapturedPdfParser({
              capture: captureFromRows(pdf, original, processing),
              outputDirectory,
              outputId: processing.parserIntent.outputId,
              ...pdf.parser,
            });
      processing = await this.requireCatalog().recordParserOutput({
        catalogId: processing.processingCatalogId,
        expectedRevision: processing.rowRevision,
        output: parserOutputCatalogRecord(output.artifacts),
      });
    }
    await this.journal.transitionCheckpoint({
      checkpoint: archivedBase(checkpoint, {
        step: "spool",
        expectedProcessingRevision: processing.rowRevision,
      }),
      credentialSessionActive: true,
    });
  }

  private async driveArchivedSpool(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "spool") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const { original, processing: current } = this.archivedRows(checkpoint);
    const pdf = this.requirePdfConfig();
    const profileId = this.archivedPlan(checkpoint).parserProfileId;
    let processing = current;
    if (processing.spool) {
      await inspectNormalizedBundleSpool({
        spoolRoot: pdf.spoolDirectory,
        expectedRoot: processing.spoolIntent.root,
        spool: processing.spool,
        parserRecovery: this.parserRecovery(original, processing, profileId),
      });
    } else {
      if (!processing.parserOutput) {
        throw new PipelineWorkerError("parser_output_missing");
      }
      if (!processing.spoolPrepared) {
        const parserOutput = await inspectCapturedParserOutput(
          this.parserRecovery(original, processing, profileId),
        );
        const prepared = await prepareNormalizedBundleSpool({
          spoolRoot: pdf.spoolDirectory,
          expectedRoot: processing.spoolIntent.root,
          spoolId: processing.spoolIntent.spoolId,
          parserOutput,
        });
        processing = await this.requireCatalog().recordSpoolPrepared({
          catalogId: processing.processingCatalogId,
          expectedRevision: processing.rowRevision,
          prepared,
        });
        await this.journal.transitionCheckpoint({
          checkpoint: archivedBase(checkpoint, {
            expectedProcessingRevision: processing.rowRevision,
          }),
          credentialSessionActive: true,
        });
        return;
      }
      const spool = await recoverNormalizedBundleSpool({
        spoolRoot: pdf.spoolDirectory,
        expectedRoot: processing.spoolIntent.root,
        spoolId: processing.spoolIntent.spoolId,
        prepared: processing.spoolPrepared,
      });
      processing = await this.requireCatalog().recordSpool({
        catalogId: processing.processingCatalogId,
        expectedRevision: processing.rowRevision,
        spool,
      });
    }
    await this.journal.transitionCheckpoint({
      checkpoint: archivedBase(checkpoint, {
        step: "lookup_processing",
        expectedProcessingRevision: processing.rowRevision,
      }),
      credentialSessionActive: true,
    });
  }

  private async mappedProcessing(checkpoint: ArchivedCheckpoint) {
    const { original, processing } = this.archivedRows(checkpoint);
    if (!processing.spool) throw new PipelineWorkerError("spool_missing");
    const pdf = this.requirePdfConfig();
    const plan = this.archivedPlan(checkpoint);
    const validated = await inspectNormalizedBundleSpool({
      spoolRoot: pdf.spoolDirectory,
      expectedRoot: processing.spoolIntent.root,
      spool: processing.spool,
      parserRecovery: this.parserRecovery(
        original,
        processing,
        plan.parserProfileId,
      ),
    });
    // A sheet page is already the retained page: the bundle carries one page
    // per sheet under the shared rendering rule, so the workbook mapping has
    // no layout document to reconcile against a page, only the same page-local
    // chunk policy the PDF lane runs.
    const mapping =
      plan.parserProfileId === "spreadsheet_v1"
        ? await mapSpreadsheetWorkbook({
            pages: (validated.bundle as { pages: { text: string }[] }).pages,
            title: basename(plan.relativePath),
            capturedAt: plan.sourceModifiedAt,
            chunkingFingerprint: plan.chunkerFingerprint,
          })
        : await mapParsedBundle({
            ...validated,
            title: basename(plan.relativePath),
            capturedAt: plan.sourceModifiedAt,
            chunkingFingerprint: plan.chunkerFingerprint,
          });
    if (mapping.chunkingFingerprint !== plan.chunkerFingerprint) {
      throw new PipelineWorkerError("parsed_chunking_conflict");
    }
    return {
      original,
      processing,
      mapping,
      declaration: parsedTextDeclaration({ processing, mapping }),
    };
  }

  private async driveArchivedLookupProcessing(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (
      checkpoint.phase !== "archived" ||
      checkpoint.step !== "lookup_processing"
    ) {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const mapped = await this.mappedProcessing(checkpoint);
    const identity = archivedIdentity(
      checkpoint,
      this.archivedPlan(checkpoint),
    );
    const output = mapped.processing.parserOutput!;
    const result = await this.mutation(
      "discovery.lookupArchivedAdmission",
      () =>
        request(this.config, "discovery.lookupArchivedAdmission", {
          requestId: randomUUID(),
          identity,
          lookup: {
            mode: "processing",
            clientArtifactId:
              mapped.processing.parserIntent.parserArtifactClientId,
            parserOutputHash: output.rawArtifact.sha256,
            parserOutputByteLength: output.rawArtifact.byteLength,
            parserOutputMediaType: output.rawArtifact.mediaType,
            parsedText: mapped.declaration,
            // P2-104d. Ask for the artifact the server already holds under
            // this parser fingerprint. Opt-in because it adds a field to the
            // not-found answer, which older clients reject.
            reuseParserArtifact: true,
          },
        }),
      async (current, response, pending) => {
        if (
          current.phase !== "archived" ||
          current.step !== "lookup_processing"
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "discovery.lookupArchivedAdmission");
        if (value.mode !== "processing") {
          throw new PipelineWorkerError("archived_lookup_mode_conflict");
        }
        if (value.found !== true) {
          // P2-104d. Not admitted under this processing configuration, but the
          // server may already hold the parser artifact and its archived
          // parser output: this document re-parsed to bytes it has. That is
          // the ordinary shape of a re-parse under a changed extraction
          // configuration, because the archived subject is the raw conversion
          // and the extraction configuration maps it rather than changing it.
          // Record the selection so `parser_archive` skips its copies and
          // `admit` names these ids. Cleared when the server offers nothing,
          // so a later pass that re-parses to different bytes archives again.
          return archivedBase(current, {
            step: "parser_archive",
            parserReuse: parserArtifactReuse(value),
          });
        }
        if (value.desiredProcessingEpoch !== identity.processingEpoch) {
          throw new PipelineWorkerError("archived_lookup_parent_conflict");
        }
        let { original, processing } = this.archivedRows(current);
        const provider = original.providerOriginal !== undefined;
        const responseProvider = "originalProviderReferenceId" in value;
        if (provider !== responseProvider)
          throw new PipelineWorkerError("archived_recovery_branch_conflict");
        // P2-31f: two admissions disagree about which revision was accepted
        // for this one file. Nothing about any other file is in doubt, so the
        // document is parked and the pass walks on. Parked rather than healed:
        // picking a revision could publish the wrong bytes under a receipt
        // that names the other, which is a decision a person has to make.
        if (admissionRevisionConflict(original, value))
          return await this.parkedCheckpoint(
            current,
            "original_receipt_revision_conflict",
          );
        const receipts = [
          ["original_bytes", original, "primary", "originalPrimaryReceiptId"],
          ...(provider
            ? []
            : [
                [
                  "original_bytes",
                  original,
                  "independent_backup",
                  "originalBackupReceiptId",
                ] as const,
              ]),
          ["parser_output", processing, "primary", "parserPrimaryReceiptId"],
          [
            "parser_output",
            processing,
            "independent_backup",
            "parserBackupReceiptId",
          ],
        ] as const;
        // P2-104d. A generation admitted against a parser artifact it did not
        // archive has no published parser-output copies of its own, and that
        // is the whole shape of a reuse, not a missing parent.
        const reusedParserOutput =
          !processing.copies.primary.published &&
          !processing.copies.independent_backup.published;
        for (const [subject, row, role, field] of receipts) {
          const live = subject === "original_bytes" ? original : processing;
          const reused = subject === "parser_output" && reusedParserOutput;
          if (!reused && !live.copies[role].published) {
            throw new PipelineWorkerError("archived_receipt_parent_missing");
          }
          if (!live.copies[role].cloudReceipt) {
            const updated = await this.requireCatalog().recordCloudReceipt({
              subject,
              catalogId:
                subject === "original_bytes"
                  ? original.originalCatalogId
                  : processing.processingCatalogId,
              expectedRevision: live.rowRevision,
              role,
              receiptId: text(value[field], "archive_receipt_id"),
              requestDigest: pending.requestDigest,
              recordedAt: pending.receivedAt,
              ...(reused ? { reused: true as const } : {}),
            });
            if (subject === "original_bytes") {
              original = updated as OriginalCatalogRow;
            } else {
              processing = updated as ProcessingCatalogRow;
            }
          }
          void row;
        }
        if (!original.cloud) {
          original = await this.requireCatalog().recordOriginalCloud({
            catalogId: original.originalCatalogId,
            expectedRevision: original.rowRevision,
            cloud: {
              sourceItemId: identity.sourceItemId,
              sourceRevisionId: text(
                value.sourceRevisionId,
                "source_revision_id",
              ),
              primaryReceiptId: original.copies.primary.cloudReceipt!.receiptId,
              ...(provider
                ? {
                    providerReferenceId: text(
                      value.originalProviderReferenceId,
                      "original_provider_reference_id",
                    ),
                    providerBindingEpoch: integer(
                      value.originalProviderBindingEpoch,
                      "original_provider_binding_epoch",
                    ),
                  }
                : {
                    backupReceiptId:
                      original.copies.independent_backup.cloudReceipt!
                        .receiptId,
                  }),
              admittedAt: pending.receivedAt,
            },
          });
        }
        if (!processing.cloud) {
          processing = await this.requireCatalog().recordProcessingCloud({
            catalogId: processing.processingCatalogId,
            expectedRevision: processing.rowRevision,
            cloud: {
              sourceItemId: identity.sourceItemId,
              sourceRevisionId: text(
                value.sourceRevisionId,
                "source_revision_id",
              ),
              parserArtifactId: text(
                value.parserArtifactId,
                "parser_artifact_id",
              ),
              sourceTextVersionId: text(
                value.sourceTextVersionId,
                "source_text_version_id",
              ),
              processingGenerationId: text(
                value.processingGenerationId,
                "processing_generation_id",
              ),
              ingestJobId: text(value.ingestJobId, "ingest_job_id"),
              processingFingerprint: output.extractionFingerprint,
              admissionRequestDigest: pending.requestDigest,
              admittedAt: pending.receivedAt,
            },
          });
        }
        return archivedBase(current, {
          step: processing.activation ? "cleanup" : "parsed_reserve",
          expectedOriginalRevision: original.rowRevision,
          expectedProcessingRevision: processing.rowRevision,
          reservationRound: 0,
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "lookup_processing"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  /**
   * P2-104e. Someone holds a live lease on this one work row: most often an
   * earlier pass of this same worker that died after reserving. That is a fact
   * about one document and it clears itself when the lease expires, so the
   * document waits for a later pass and the others do not. Nothing was
   * reserved, so no discovery attempt was spent.
   */
  private async leaseHeld(
    checkpoint: ArchivedCheckpoint,
  ): Promise<RunnerCheckpoint> {
    process.stderr.write(
      `${JSON.stringify({ event: "archived_lease_held", action: "deferred_to_next_pass" })}\n`,
    );
    return await this.afterArchivedItem(checkpoint, 0);
  }

  private async driveArchivedReserve(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "reserve") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    // P2-104e. A lease this journal already holds and the server will still
    // honour is the reservation. Asking again under a new request id would be
    // refused by it, and used to fail the whole pass.
    if (!this.journal.pending && liveDiscoveryLease(checkpoint)) {
      await this.journal.transitionCheckpoint({
        checkpoint: archivedBase(checkpoint, { step: "admit" }),
        credentialSessionActive: true,
      });
      return;
    }
    const identity = archivedIdentity(
      checkpoint,
      this.archivedPlan(checkpoint),
    );
    const result = await this.mutation(
      "discovery.reserveArchived",
      () =>
        request(this.config, "discovery.reserveArchived", {
          requestId: randomUUID(),
          identity,
        }),
      async (current, response) => {
        if (current.phase !== "archived" || current.step !== "reserve") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code === "lease_conflict") return await this.leaseHeld(current);
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "discovery.reserveArchived");
        if (
          value.sourceItemId !== identity.sourceItemId ||
          value.observationEpoch !== identity.observationEpoch ||
          value.processingEpoch !== identity.processingEpoch
        ) {
          throw new PipelineWorkerError("archived_reserve_parent_conflict");
        }
        return archivedBase(current, {
          step: "admit",
          discoveryLease: {
            workId: text(value.workId, "work_id"),
            sourceItemId: text(value.sourceItemId, "source_item_id"),
            observationEpoch: integer(
              value.observationEpoch,
              "observation_epoch",
            ),
            processingEpoch: integer(value.processingEpoch, "processing_epoch"),
            leaseEpoch: integer(value.leaseEpoch, "lease_epoch"),
            leaseToken: text(value.leaseToken, "lease_token"),
            leaseExpiresAt: integer(value.leaseExpiresAt, "lease_expires_at"),
          },
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "reserve"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  /**
   * What an admission selects: the parser artifact and the four (or three, for
   * a provider original) archive receipts.
   *
   * P2-104d. One builder, because two of them is how this broke: the admission
   * and the replay validator each built the request and a replay is refused
   * when they disagree. The reuse branch was added to one of them, and a
   * resumed pass answered `journal_phase_conflict` on a document whose
   * checkpoint was fine.
   */
  private admissionSelections(
    checkpoint: ArchivedCheckpoint,
    mapped: { original: OriginalCatalogRow; processing: ProcessingCatalogRow },
    providerOriginal: unknown,
  ): {
    parserArtifact: ParserArtifactSelection;
    archives: ArchiveReceiptSelection[];
  } {
    const reuse = checkpoint.parserReuse;
    const original = checkpoint.originalReuse;
    return {
      // Either this document archived its own parser output, or it reused the
      // copies already bound to the artifact it is selecting. The two go
      // together: a reused artifact has no local copies to declare, and a
      // created one has no receipts to reuse.
      parserArtifact: reuse
        ? existingParserArtifactSelection(reuse.parserArtifactId)
        : createParserArtifactSelection(mapped.processing),
      archives: [
        ...(original
          ? [
              existingArchiveReceiptSelection({
                subjectKind: "original_bytes",
                copyRole: "primary",
                receiptId: original.primaryReceiptId,
                bindingEpoch: original.primaryBindingEpoch,
              }),
              ...(original.backupReceiptId === undefined
                ? []
                : [
                    existingArchiveReceiptSelection({
                      subjectKind: "original_bytes",
                      copyRole: "independent_backup",
                      receiptId: original.backupReceiptId,
                      bindingEpoch: original.backupBindingEpoch!,
                    }),
                  ]),
            ]
          : [
              createArchiveReceiptSelection(
                "original_bytes",
                mapped.original,
                "primary",
              ),
              ...(providerOriginal === undefined
                ? [
                    createArchiveReceiptSelection(
                      "original_bytes",
                      mapped.original,
                      "independent_backup",
                    ),
                  ]
                : []),
            ]),
        ...(reuse
          ? [
              existingArchiveReceiptSelection({
                subjectKind: "parser_output",
                copyRole: "primary",
                receiptId: reuse.primaryReceiptId,
                bindingEpoch: reuse.primaryBindingEpoch,
              }),
              existingArchiveReceiptSelection({
                subjectKind: "parser_output",
                copyRole: "independent_backup",
                receiptId: reuse.backupReceiptId,
                bindingEpoch: reuse.backupBindingEpoch,
              }),
            ]
          : [
              createArchiveReceiptSelection(
                "parser_output",
                mapped.processing,
                "primary",
              ),
              createArchiveReceiptSelection(
                "parser_output",
                mapped.processing,
                "independent_backup",
              ),
            ]),
      ],
    };
  }

  /**
   * P2-104e. How an admission accounts for a provider original: a selection
   * of the reference the server already holds, a fresh declaration, or
   * nothing for an original with its own backup receipt. Shared by the admit
   * and its replay validator so the two cannot disagree.
   */
  private admissionProvider(
    checkpoint: ArchivedCheckpoint,
    original: OriginalCatalogRow,
    requireFresh: boolean,
  ) {
    const reuse = checkpoint.originalReuse;
    if (reuse?.providerReferenceId !== undefined) {
      return {
        existingProviderOriginal: {
          referenceId: reuse.providerReferenceId,
          bindingEpoch: reuse.providerBindingEpoch!,
        },
      };
    }
    return original.providerOriginal
      ? { providerOriginal: this.providerDeclaration(original, requireFresh) }
      : {};
  }

  private async driveArchivedAdmit(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "admit") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const lease = checkpoint.discoveryLease;
    if (!lease) throw new PipelineWorkerError("archived_lease_missing");
    const admitting = this.archivedRows(checkpoint).original;
    // P2-31b. The original's provider reference is already recorded server
    // side, and this step would declare it again. It cannot succeed and must
    // not be attempted.
    //
    // `createAndBindProviderOriginal` keys a reference by
    // `(source_account_id, client_reference_id)` and, when one exists, requires
    // the declaration to match it field for field *including* `requestDigest`,
    // which is derived from the whole admit request and so from its `requestId`.
    // A fresh admit carries a fresh `requestId`, so it can never reproduce the
    // stored digest: only the journal replaying its own persisted call can. The
    // declaration this step would build is therefore refused server side no
    // matter how fresh its proof is.
    //
    // This state is reachable and was live: `driveArchivedLookupOriginal`
    // records `cloud` when the server reports the original already admitted and
    // continues to capture, and if `lookup_processing` then reports the
    // processing leg *not* admitted the pass walks to `reserve` and `admit`
    // anyway. Before this check, that pass spent a lease -- one of the row's
    // eight discovery attempts -- and then threw
    // `provider_verification_stale_review_required` from `providerDeclaration`,
    // naming a stale proof for a row whose proof was never the problem. The
    // P2-31a refresh does not fire here either, by design: refreshing an
    // admitted original is P2-31's multi-reference work.
    //
    // Checked before the lease branch so a wedged row stops spending attempts.
    // Admitting the processing leg against a reference the server already holds
    // needs a protocol shape that does not exist yet: `ArchiveReceiptSelection`
    // has `kind: "existing"` for receipts, and `providerOriginal` on
    // `discovery.admitArchived` has no counterpart. That is P2-31.
    //
    // P2-31f. Thrown here and parked by `run`, which records the marker and
    // moves to the next file. The marker is what stops the next pass coming
    // back around a fresh cycle and reserving again, which is what the throw
    // alone used to achieve by leaving the checkpoint at `admit` -- at the
    // cost of every other file in the pass.
    // A pending call is exempt: a replay sends the persisted request under its
    // original `requestId`, which is the one shape the server does accept
    // against a recorded reference.
    // P2-104e. None of that applies to an admission that selects the bound
    // reference instead of declaring it, which is the shape P2-31b said did
    // not exist yet.
    if (
      !this.journal.pending &&
      checkpoint.originalReuse?.providerReferenceId === undefined &&
      admitting.providerOriginal &&
      admitting.cloud &&
      "providerReferenceId" in admitting.cloud
    ) {
      // P2-31c. Before refusing, ask the server whether it actually holds this
      // receipt. A pass resumed straight into `admit` has never asked, and the
      // two answers need different codes: a receipt the server knows is
      // `provider_original_reference_already_bound` (P2-31b), and one it does
      // not know is `original_receipt_unknown_to_server`, which is what a
      // misrouted admission leaves behind. `lookup_original` is read-only and
      // spends no discovery attempt. `receiptChecked` keeps it to one question
      // per cycle, so a row whose receipt the server does confirm walks its
      // normal recovery instead of looping back here.
      if (!checkpoint.receiptChecked) {
        await this.journal.transitionCheckpoint({
          checkpoint: archivedBase(checkpoint, {
            step: "lookup_original",
            receiptChecked: true,
            discoveryLease: liveDiscoveryLease(checkpoint),
          }),
          credentialSessionActive: true,
        });
        return;
      }
      throw new PipelineWorkerError(
        "provider_original_reference_already_bound",
      );
    }
    // P2-31a. A pass that resumes here after an interrupted admission holds a
    // durable locator whose proof has aged past what the server accepts. Redo
    // both checks in place rather than throwing
    // `provider_verification_stale_review_required`, which failed this pass and
    // every later one over the same row. A pending call replays its persisted
    // declaration instead, which is exempt from the freshness rule.
    //
    // This runs before the lease check on purpose. `discovery.reserveArchived`
    // counts an attempt against `MAX_WORKER_DISCOVERY_ATTEMPTS` every time it
    // hands out a lease, and it only re-leases work whose lease has expired.
    // Renewing the expired lease first and then leaving it idle across two
    // provider round trips would spend an attempt and could expire again, so
    // the recovery pass refreshes first and then reserves exactly once.
    if (
      !this.journal.pending &&
      admitting.providerOriginal &&
      !admitting.cloud &&
      !providerProofFresh(admitting.providerOriginal)
    ) {
      await this.refreshProviderProof(checkpoint);
      return;
    }
    if (
      !this.journal.pending &&
      lease.leaseExpiresAt <= Date.now() + LEASE_SAFETY_MARGIN_MS
    ) {
      await this.journal.transitionCheckpoint({
        checkpoint: archivedBase(checkpoint, {
          step: "reserve",
          discoveryLease: undefined,
        }),
        credentialSessionActive: true,
      });
      return;
    }
    const mapped = await this.mappedProcessing(checkpoint);
    const provider = this.admissionProvider(
      checkpoint,
      mapped.original,
      this.journal.pending === undefined,
    );
    const providerOriginal = provider.providerOriginal;
    const result = await this.mutation(
      "discovery.admitArchived",
      () =>
        request(this.config, "discovery.admitArchived", {
          requestId: randomUUID(),
          workId: lease.workId,
          leaseEpoch: lease.leaseEpoch,
          leaseToken: lease.leaseToken,
          ...this.admissionSelections(checkpoint, mapped, providerOriginal),
          ...provider,
          parsedText: mapped.declaration,
        }),
      async (current, response, pending) => {
        if (current.phase !== "archived" || current.step !== "admit") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code === "lease_conflict" || code === "reservation_expired") {
          return archivedBase(current, {
            step: "reserve",
            discoveryLease: undefined,
          });
        }
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "discovery.admitArchived");
        if (
          value.workId !== lease.workId ||
          value.sourceItemId !== lease.sourceItemId ||
          value.desiredProcessingEpoch !== lease.processingEpoch ||
          value.state !== "admitted"
        ) {
          throw new PipelineWorkerError("archived_admit_parent_conflict");
        }
        let { original, processing } = this.archivedRows(current);
        const responseProvider = "originalProviderReferenceId" in value;
        const viaProvider = Object.keys(provider).length > 0;
        if (viaProvider !== responseProvider)
          throw new PipelineWorkerError("archived_recovery_branch_conflict");
        // P2-31f: two admissions disagree about which revision was accepted
        // for this one file. Nothing about any other file is in doubt, so the
        // document is parked and the pass walks on. Parked rather than healed:
        // picking a revision could publish the wrong bytes under a receipt
        // that names the other, which is a decision a person has to make.
        if (admissionRevisionConflict(original, value))
          return await this.parkedCheckpoint(
            current,
            "original_receipt_revision_conflict",
          );
        for (const [subject, role, receiptField] of [
          ["original_bytes", "primary", "originalPrimaryReceiptId"],
          ...(!viaProvider
            ? [
                [
                  "original_bytes",
                  "independent_backup",
                  "originalBackupReceiptId",
                ] as const,
              ]
            : []),
          ["parser_output", "primary", "parserPrimaryReceiptId"],
          ["parser_output", "independent_backup", "parserBackupReceiptId"],
        ] as const) {
          const live = subject === "original_bytes" ? original : processing;
          // P2-104d. A reused parser output was archived by the row that
          // created the artifact, so this row has no published object to hang
          // the receipt on. It still holds the receipt: that is what says the
          // bytes behind this generation are durable, and the row would
          // otherwise look never admitted.
          const reused =
            subject === "parser_output" && current.parserReuse !== undefined;
          if (!live.copies[role].cloudReceipt) {
            const updated = await this.requireCatalog().recordCloudReceipt({
              subject,
              catalogId:
                subject === "original_bytes"
                  ? original.originalCatalogId
                  : processing.processingCatalogId,
              expectedRevision: live.rowRevision,
              role,
              receiptId: text(value[receiptField], receiptField),
              requestDigest: pending.requestDigest,
              recordedAt: pending.receivedAt,
              ...(reused ? { reused: true as const } : {}),
            });
            if (subject === "original_bytes")
              original = updated as OriginalCatalogRow;
            else processing = updated as ProcessingCatalogRow;
          }
        }
        if (!original.cloud) {
          original = await this.requireCatalog().recordOriginalCloud({
            catalogId: original.originalCatalogId,
            expectedRevision: original.rowRevision,
            cloud: {
              sourceItemId: lease.sourceItemId,
              sourceRevisionId: text(
                value.sourceRevisionId,
                "source_revision_id",
              ),
              primaryReceiptId: original.copies.primary.cloudReceipt!.receiptId,
              ...(!viaProvider
                ? {
                    backupReceiptId:
                      original.copies.independent_backup.cloudReceipt!
                        .receiptId,
                  }
                : {
                    providerReferenceId: text(
                      value.originalProviderReferenceId,
                      "original_provider_reference_id",
                    ),
                    providerBindingEpoch: integer(
                      value.originalProviderBindingEpoch,
                      "original_provider_binding_epoch",
                    ),
                  }),
              admittedAt: pending.receivedAt,
            },
          });
        }
        if (!processing.cloud) {
          processing = await this.requireCatalog().recordProcessingCloud({
            catalogId: processing.processingCatalogId,
            expectedRevision: processing.rowRevision,
            cloud: {
              sourceItemId: lease.sourceItemId,
              sourceRevisionId: text(
                value.sourceRevisionId,
                "source_revision_id",
              ),
              parserArtifactId: text(
                value.parserArtifactId,
                "parser_artifact_id",
              ),
              sourceTextVersionId: text(
                value.sourceTextVersionId,
                "source_text_version_id",
              ),
              processingGenerationId: text(
                value.processingGenerationId,
                "processing_generation_id",
              ),
              ingestJobId: text(value.ingestJobId, "ingest_job_id"),
              processingFingerprint:
                mapped.processing.parserOutput!.extractionFingerprint,
              admissionRequestDigest: pending.requestDigest,
              admittedAt: pending.receivedAt,
            },
          });
        }
        return archivedBase(current, {
          step: "parsed_reserve",
          expectedOriginalRevision: original.rowRevision,
          expectedProcessingRevision: processing.rowRevision,
          discoveryLease: undefined,
          reservationRound: 0,
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "admit"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private async driveParsedReserve(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (
      checkpoint.phase !== "archived" ||
      checkpoint.step !== "parsed_reserve"
    ) {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const { processing } = this.archivedRows(checkpoint);
    if (!processing.cloud) throw new PipelineWorkerError("admission_missing");
    const cloud = processing.cloud;
    const result = await this.mutation(
      "jobs.reserveParsed",
      () =>
        request(this.config, "jobs.reserveParsed", {
          requestId: randomUUID(),
          maxItems: 1,
          jobId: cloud.ingestJobId,
        }),
      (current, response) => {
        if (current.phase !== "archived" || current.step !== "parsed_reserve") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "jobs.reserveParsed");
        const targets = records(
          value.targets,
          "parsed_targets",
        ) as unknown as JobLease[];
        const target = targets[0];
        if (!target) {
          if (current.reservationRound >= MAX_ARCHIVED_RESERVATION_ROUNDS) {
            throw new PipelineWorkerError("parsed_job_missing");
          }
          return archivedBase(current, {
            reservationRound: current.reservationRound + 1,
          });
        }
        if (
          targets.length !== 1 ||
          target.jobId !== cloud.ingestJobId ||
          target.sourceItemId !== cloud.sourceItemId ||
          target.observationEpoch !==
            processing.currentObservation.observationEpoch ||
          target.processingEpoch !==
            processing.currentObservation.processingEpoch
        ) {
          throw new PipelineWorkerError("parsed_job_parent_conflict");
        }
        return archivedBase(current, {
          step: "parsed_begin",
          jobLease: target,
          reservationRound: 0,
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "parsed_reserve"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
    if (
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "parsed_reserve"
    ) {
      throw new PipelineRetryableError("parsed_job_deferred");
    }
  }

  private parsedLeaseRecovery(
    checkpoint: ArchivedCheckpoint,
  ): ArchivedCheckpoint {
    return archivedBase(checkpoint, {
      step: "parsed_reserve",
      reservationRound: 0,
      jobLease: undefined,
      resumeStep: undefined,
      stageId: undefined,
      stagePhase: undefined,
      stageOrdinal: undefined,
    });
  }

  private async requireFreshParsedLease(
    checkpoint: ArchivedCheckpoint,
    resumeStep:
      "parsed_begin" | "parsed_batch" | "parsed_seal" | "parsed_activate",
  ): Promise<boolean> {
    const lease = checkpoint.jobLease;
    if (!lease) throw new PipelineWorkerError("parsed_lease_missing");
    if (
      !this.journal.pending &&
      lease.leaseExpiresAt <= Date.now() + LEASE_SAFETY_MARGIN_MS
    ) {
      await this.journal.transitionCheckpoint({
        checkpoint: archivedBase(checkpoint, {
          step: "parsed_renew",
          resumeStep,
        }),
        credentialSessionActive: true,
      });
      return false;
    }
    return true;
  }

  private async driveParsedRenew(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (
      checkpoint.phase !== "archived" ||
      checkpoint.step !== "parsed_renew" ||
      !checkpoint.jobLease ||
      !checkpoint.resumeStep
    ) {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const lease = checkpoint.jobLease;
    const result = await this.mutation(
      "jobs.renewParsed",
      () =>
        request(this.config, "jobs.renewParsed", {
          requestId: randomUUID(),
          jobId: lease.jobId,
          leaseEpoch: lease.leaseEpoch,
          leaseToken: lease.leaseToken,
        }),
      (current, response) => {
        if (
          current.phase !== "archived" ||
          current.step !== "parsed_renew" ||
          !current.jobLease ||
          !current.resumeStep
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code === "lease_conflict" || code === "reservation_expired") {
          return this.parsedLeaseRecovery(current);
        }
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "jobs.renewParsed");
        if (value.jobId !== current.jobLease.jobId) {
          throw new PipelineWorkerError("parsed_renew_parent_conflict");
        }
        return archivedBase(current, {
          step: current.resumeStep,
          jobLease: {
            ...current.jobLease,
            state: value.state as "processing" | "staged",
            leaseExpiresAt: integer(value.leaseExpiresAt, "lease_expires_at"),
          },
          resumeStep: undefined,
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "parsed_renew"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private async driveParsedBegin(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "parsed_begin") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    if (!(await this.requireFreshParsedLease(checkpoint, "parsed_begin")))
      return;
    const lease = checkpoint.jobLease!;
    const mapped = await this.mappedProcessing(checkpoint);
    const declaration = mapped.declaration;
    const result = await this.mutation(
      "jobs.stageParsedBegin",
      () =>
        request(this.config, "jobs.stageParsedBegin", {
          requestId: randomUUID(),
          jobId: lease.jobId,
          leaseEpoch: lease.leaseEpoch,
          leaseToken: lease.leaseToken,
          extractionFingerprint: declaration.extractionFingerprint,
          mappingManifestHash: declaration.mappingManifestHash,
          normalizedBundleDigest: declaration.normalizedBundleDigest,
          expectedPageCount: declaration.pageCount,
          expectedEvidenceSpanCount: declaration.expectedEvidenceSpanCount,
          expectedDocumentCount: declaration.expectedDocumentCount,
          expectedChunkCount: declaration.expectedChunkCount,
        }),
      (current, response) => {
        if (current.phase !== "archived" || current.step !== "parsed_begin") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code === "lease_conflict" || code === "reservation_expired") {
          return this.parsedLeaseRecovery(current);
        }
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "jobs.stageParsedBegin");
        if (value.jobId !== lease.jobId) {
          throw new PipelineWorkerError("parsed_stage_parent_conflict");
        }
        const phase = value.phase as ParsedStagePhase;
        return archivedBase(current, {
          step:
            phase === "staged"
              ? "parsed_activate"
              : phase === "seal"
                ? "parsed_seal"
                : "parsed_batch",
          stageId: text(value.stageId, "stage_id"),
          stagePhase: phase,
          stageOrdinal: integer(value.nextOrdinal, "stage_ordinal"),
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "parsed_begin"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private parsedRows(
    mapping: Awaited<ReturnType<PipelineRunner["mappedProcessing"]>>["mapping"],
    phase: "pages" | "evidence" | "documents" | "chunks",
  ) {
    return phase === "pages"
      ? mapping.pages
      : phase === "evidence"
        ? mapping.evidence
        : phase === "documents"
          ? mapping.documents
          : mapping.chunks;
  }

  private parsedBatchBody(
    checkpoint: ArchivedCheckpoint,
    mapping: Awaited<ReturnType<PipelineRunner["mappedProcessing"]>>["mapping"],
    requestId: string,
  ) {
    const lease = checkpoint.jobLease!;
    const phase = checkpoint.stagePhase;
    const ordinal = checkpoint.stageOrdinal;
    if (
      !checkpoint.stageId ||
      ordinal === undefined ||
      (phase !== "pages" &&
        phase !== "evidence" &&
        phase !== "documents" &&
        phase !== "chunks")
    ) {
      throw new PipelineWorkerError("parsed_stage_state_invalid");
    }
    const allRows = this.parsedRows(mapping, phase);
    const maximum =
      phase === "pages" ? MAX_PARSED_PAGE_BATCH : MAX_PARSED_ROW_BATCH;
    let rows = allRows.slice(ordinal, ordinal + maximum);
    while (rows.length) {
      const body = request(this.config, "jobs.stageParsedBatch", {
        requestId,
        jobId: lease.jobId,
        leaseEpoch: lease.leaseEpoch,
        leaseToken: lease.leaseToken,
        stageId: checkpoint.stageId,
        phase,
        ordinal,
        rows,
      });
      if (
        Buffer.byteLength(JSON.stringify(body), "utf8") <=
        MAX_PARSED_REQUEST_BYTES
      ) {
        assertParsedRequestSize(body);
        return body;
      }
      rows = rows.slice(0, -1);
    }
    throw new PipelineWorkerError("parsed_batch_too_large");
  }

  private async driveParsedBatch(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "parsed_batch") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    if (!(await this.requireFreshParsedLease(checkpoint, "parsed_batch")))
      return;
    const mapped = await this.mappedProcessing(checkpoint);
    const plannedRequestId = this.journal.pending?.requestId ?? randomUUID();
    const body = this.parsedBatchBody(
      checkpoint,
      mapped.mapping,
      plannedRequestId,
    );
    const submittedRows = body.rows as unknown[];
    const submittedPhase = body.phase;
    const result = await this.mutation(
      "jobs.stageParsedBatch",
      () => body,
      (current, response) => {
        if (current.phase !== "archived" || current.step !== "parsed_batch") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code === "lease_conflict" || code === "reservation_expired") {
          return this.parsedLeaseRecovery(current);
        }
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "jobs.stageParsedBatch");
        if (
          value.jobId !== current.jobLease?.jobId ||
          value.stageId !== current.stageId ||
          value.committedPhase !== submittedPhase ||
          value.acceptedCount !== submittedRows.length
        ) {
          throw new PipelineWorkerError("parsed_batch_parent_conflict");
        }
        const phase = value.phase as ParsedStagePhase;
        return archivedBase(current, {
          step: phase === "seal" ? "parsed_seal" : "parsed_batch",
          stagePhase: phase,
          stageOrdinal: integer(value.nextOrdinal, "stage_ordinal"),
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "parsed_batch"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private async driveParsedSeal(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "parsed_seal") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    if (!(await this.requireFreshParsedLease(checkpoint, "parsed_seal")))
      return;
    const mapped = await this.mappedProcessing(checkpoint);
    const lease = checkpoint.jobLease!;
    const result = await this.mutation(
      "jobs.stageParsedSeal",
      () =>
        request(this.config, "jobs.stageParsedSeal", {
          requestId: randomUUID(),
          jobId: lease.jobId,
          leaseEpoch: lease.leaseEpoch,
          leaseToken: lease.leaseToken,
          stageId: checkpoint.stageId,
          normalizedBundleDigest: mapped.declaration.normalizedBundleDigest,
        }),
      (current, response) => {
        if (current.phase !== "archived" || current.step !== "parsed_seal") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code === "lease_conflict" || code === "reservation_expired") {
          return this.parsedLeaseRecovery(current);
        }
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "jobs.stageParsedSeal");
        if (
          value.jobId !== lease.jobId ||
          value.stageId !== current.stageId ||
          value.state !== "staged" ||
          value.actualPageCount !== mapped.declaration.pageCount ||
          value.actualEvidenceSpanCount !==
            mapped.declaration.expectedEvidenceSpanCount ||
          value.actualDocumentCount !==
            mapped.declaration.expectedDocumentCount ||
          value.actualChunkCount !== mapped.declaration.expectedChunkCount
        ) {
          throw new PipelineWorkerError("parsed_seal_parent_conflict");
        }
        return archivedBase(current, {
          step: "parsed_activate",
          stagePhase: "staged",
          stageOrdinal: 0,
          jobLease: { ...lease, state: "staged" },
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "parsed_seal"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private async driveParsedActivate(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (
      checkpoint.phase !== "archived" ||
      checkpoint.step !== "parsed_activate"
    ) {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    if (!(await this.requireFreshParsedLease(checkpoint, "parsed_activate")))
      return;
    const lease = checkpoint.jobLease!;
    const result = await this.mutation(
      "jobs.activateParsed",
      () =>
        request(this.config, "jobs.activateParsed", {
          requestId: randomUUID(),
          jobId: lease.jobId,
          leaseEpoch: lease.leaseEpoch,
          leaseToken: lease.leaseToken,
        }),
      async (current, response, pending) => {
        if (
          current.phase !== "archived" ||
          current.step !== "parsed_activate"
        ) {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const code = errorCode(response);
        if (code === "lease_conflict" || code === "reservation_expired") {
          return this.parsedLeaseRecovery(current);
        }
        if (code) {
          return scanTerminal(current, "failed", code, true);
        }
        const value = object(response, "jobs.activateParsed");
        const { processing } = this.archivedRows(current);
        if (
          !processing.cloud ||
          value.jobId !== processing.cloud.ingestJobId ||
          value.state !== "ready"
        ) {
          throw new PipelineWorkerError("parsed_activation_parent_conflict");
        }
        const updated = await this.requireCatalog().recordActivation({
          catalogId: processing.processingCatalogId,
          expectedRevision: processing.rowRevision,
          activation: {
            requestId: pending.requestId,
            requestDigest: pending.requestDigest,
            jobId: processing.cloud.ingestJobId,
            processingGenerationId: processing.cloud.processingGenerationId,
            state: "ready",
            activatedAt: integer(value.activatedAt, "activated_at"),
            reused: value.reused === true,
            ...(value.previousGenerationId === undefined
              ? {}
              : {
                  previousGenerationId: text(
                    value.previousGenerationId,
                    "previous_generation_id",
                  ),
                }),
          },
        });
        return archivedBase(current, {
          step: "cleanup",
          expectedProcessingRevision: updated.rowRevision,
        });
      },
    );
    if (
      errorCode(result) &&
      this.journal.checkpoint.phase === "archived" &&
      this.journal.checkpoint.step === "parsed_activate"
    ) {
      throw new PipelineWorkerError(errorCode(result)!);
    }
  }

  private async driveArchivedCleanup(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived" || checkpoint.step !== "cleanup") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const { original, processing } = this.archivedRows(checkpoint);
    this.requireCatalog().requireProcessingActivation(
      processing.processingCatalogId,
    );
    const pdf = this.requirePdfConfig();
    if (!processing.spool || !processing.parserOutput || !processing.capture) {
      throw new PipelineWorkerError("cleanup_parent_missing");
    }
    await removeNormalizedBundleSpoolExact({
      spoolRoot: pdf.spoolDirectory,
      expectedRoot: processing.spoolIntent.root,
      spool: processing.spool,
    });
    await removeParserOutputExact({
      outputRoot: pdf.parserOutputRoot,
      outputIntent: parserOutputIntentCore(processing.parserIntent),
      artifacts: {
        ...processing.parserOutput,
        rawArtifact: {
          ...processing.parserOutput.rawArtifact,
          path: join(
            pdf.parserOutputRoot,
            processing.parserIntent.outputId,
            processing.parserOutput.rawArtifact.opaqueName,
          ),
        },
        normalizedBundle: {
          ...processing.parserOutput.normalizedBundle,
          path: join(
            pdf.parserOutputRoot,
            processing.parserIntent.outputId,
            processing.parserOutput.normalizedBundle.opaqueName,
          ),
        },
      },
    });
    await removeCapturedPdfExact(captureFromRows(pdf, original, processing));
    // P2-31f: publishing is what resolves a park, so a document that got here
    // after being parked stops being reported as parked.
    if (original.admissionBlock) {
      await this.requireCatalog().clearAdmissionBlock({
        catalogId: original.originalCatalogId,
        expectedRevision: original.rowRevision,
      });
    }
    await this.journal.transitionCheckpoint({
      checkpoint: await this.afterArchivedItem(
        checkpoint,
        checkpoint.countPublication === false ? 0 : 1,
      ),
      credentialSessionActive: true,
    });
  }

  /**
   * A document-level parser failure (see `DOCUMENT_PARSER_FAILURE_CODES`)
   * raised while parsing this PDF: unlike an infrastructure failure, it does
   * not end the run. Records a bounded attempt against the local processing
   * catalog row (`ArchiveCatalog.recordParseFailure`) and moves on to the
   * next PDF exactly as `driveArchivedCleanup` does after a successful one,
   * except nothing was published, so `archivedPublished` is unchanged.
   */
  private async recordArchivedParseFailure(
    checkpoint: ArchivedCheckpoint,
    code: string,
  ): Promise<void> {
    if (checkpoint.phase !== "archived" || checkpoint.step !== "parse") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const { processing } = this.archivedRows(checkpoint);
    await this.requireCatalog().recordParseFailure({
      catalogId: processing.processingCatalogId,
      expectedRevision: processing.rowRevision,
      code,
      now: Date.now(),
    });
    // P2-80g: `pdfNeedsArchivedWork` will not offer this document again once
    // its local attempts reach the bound, so the server is told the failure is
    // terminal instead of letting its own larger attempt bound keep the row
    // retryable for passes that will never happen. P2-80g2: counted per
    // document across passes, not per catalog row.
    await this.submitArchivedParseFailure(
      checkpoint,
      code,
      this.documentParseAttempts(this.archivedPlan(checkpoint)) >=
        MAX_PARSE_ATTEMPTS,
    );
    await this.journal.transitionCheckpoint({
      checkpoint: await this.afterArchivedItem(checkpoint, 0),
      credentialSessionActive: true,
    });
  }

  /**
   * Reports a document-level parse failure to the server so the file's
   * `sourceInventory` row is marked `parse_failed` with the failure class
   * (`discovery.failArchived`, the archived-flow counterpart of the
   * `jobs.fail` / `jobs.failParsed` path `failJob` already wires this for:
   * there is no ingestJobs row yet at this point, since admission happens
   * after a successful parse).
   *
   * ponytail: best-effort, not a correctness path. This does not go through
   * `this.mutation()`'s pending/replay durability, so a crash or transport
   * failure here can lose the report (or, rarely, double it on a later
   * retry) without affecting the run: the bounded local attempt count in
   * the archive catalog is what actually stops the pass from retrying this
   * document forever, and a lost report just leaves the inventory stale
   * until a later scan or a successful parse corrects it. Upgrade to a
   * durable replayed call if silent loss becomes a real problem.
   */
  private async submitArchivedParseFailure(
    checkpoint: ArchivedCheckpoint,
    code: string,
    exhausted: boolean,
  ): Promise<void> {
    const identity = archivedIdentity(
      checkpoint,
      this.archivedPlan(checkpoint),
    );
    try {
      await this.transport.call({
        protocolVersion: 1,
        operation: "discovery.failArchived",
        spaceId: this.config.spaceId,
        sourceAccountId: this.config.sourceAccountId,
        requestId: randomUUID(),
        identity,
        failureCode: code,
        ...(exhausted ? { exhausted: true } : {}),
      });
    } catch {
      // Swallowed: see the ponytail note above.
    }
  }

  private async driveJobsReserve(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "jobs_reserve") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const result = await this.mutation(
      "jobs.reserve",
      () =>
        request(this.config, "jobs.reserve", {
          requestId: randomUUID(),
          maxItems: 4,
        }),
      (current, response) => {
        if (current.phase !== "jobs_reserve") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return processingTerminal(current, "failed", code, undefined, true);
        }
        const jobs = records(
          value.targets,
          "job_targets",
        ) as unknown as JobLease[];
        if (jobs.length === 0) {
          return {
            version: 1,
            phase: "assess_status",
            ...processingBase(current),
          };
        }
        if (current.round >= MAX_RESERVATION_ROUNDS) {
          return processingTerminal(
            current,
            "incomplete",
            "job_capacity_exceeded",
            undefined,
            true,
          );
        }
        return {
          version: 1,
          phase: "jobs_renew",
          ...processingBase(current),
          round: current.round,
          jobs,
          index: 0,
        };
      },
    );
    if (errorCode(result)) throw new PipelineWorkerError(errorCode(result)!);
  }

  private async driveJobsRenew(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "jobs_renew") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const job = checkpoint.jobs[checkpoint.index];
    if (!job) throw new PipelineWorkerError("job_checkpoint_invalid");
    const result = await this.mutation(
      "jobs.renew",
      () =>
        request(this.config, "jobs.renew", {
          requestId: randomUUID(),
          jobId: job.jobId,
          leaseEpoch: job.leaseEpoch,
          leaseToken: job.leaseToken,
        }),
      (current, response) => {
        if (current.phase !== "jobs_renew") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const active = current.jobs[current.index];
        if (!active) throw new PipelineWorkerError("job_checkpoint_invalid");
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return code === "lease_conflict" || code === "reservation_expired"
            ? afterJob(current, current.published)
            : processingTerminal(current, "failed", code, undefined, true);
        }
        if (value.jobId !== active.jobId) {
          throw new PipelineWorkerError("job_parent_conflict");
        }
        const state =
          value.state === "staged"
            ? ("staged" as const)
            : ("processing" as const);
        const jobs = current.jobs.map((row, index) =>
          index === current.index
            ? {
                ...row,
                state,
                leaseExpiresAt: integer(
                  value.leaseExpiresAt,
                  "lease_expires_at",
                ),
              }
            : row,
        );
        return {
          ...current,
          phase: state === "staged" ? "jobs_activate" : "jobs_stage",
          jobs,
        };
      },
    );
    const code = errorCode(result);
    if (code && this.journal.checkpoint.phase === "jobs_renew") {
      throw new PipelineWorkerError(code);
    }
  }

  private async driveJobsStage(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "jobs_stage") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const job = checkpoint.jobs[checkpoint.index];
    if (!job) throw new PipelineWorkerError("job_checkpoint_invalid");
    if (
      !this.journal.pending &&
      job.leaseExpiresAt <= Date.now() + LEASE_SAFETY_MARGIN_MS
    ) {
      await this.journal.transitionCheckpoint({
        checkpoint: { ...checkpoint, phase: "jobs_renew" },
        credentialSessionActive: true,
      });
      return;
    }
    const result = await this.mutation(
      "jobs.stageUtf8",
      () =>
        request(this.config, "jobs.stageUtf8", {
          requestId: randomUUID(),
          jobId: job.jobId,
          leaseEpoch: job.leaseEpoch,
          leaseToken: job.leaseToken,
        }),
      (current, response) => {
        if (current.phase !== "jobs_stage") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const active = current.jobs[current.index];
        if (!active) throw new PipelineWorkerError("job_checkpoint_invalid");
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          if (code === "lease_conflict" || code === "reservation_expired") {
            return afterJob(current, current.published);
          }
          if (code === "scan_conflict") {
            return {
              ...current,
              phase: "jobs_fail",
              failureCode: "staging_invalid",
            };
          }
          return processingTerminal(current, "failed", code, undefined, true);
        }
        if (value.jobId !== active.jobId || value.state !== "staged") {
          throw new PipelineWorkerError("job_stage_conflict");
        }
        const jobs = current.jobs.map((row, index) =>
          index === current.index ? { ...row, state: "staged" as const } : row,
        );
        return { ...current, phase: "jobs_activate", jobs };
      },
    );
    const code = errorCode(result);
    if (code && this.journal.checkpoint.phase === "jobs_stage") {
      throw new PipelineWorkerError(code);
    }
  }

  private async driveJobsActivate(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "jobs_activate") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const job = checkpoint.jobs[checkpoint.index];
    if (!job) throw new PipelineWorkerError("job_checkpoint_invalid");
    if (
      !this.journal.pending &&
      job.leaseExpiresAt <= Date.now() + LEASE_SAFETY_MARGIN_MS
    ) {
      await this.journal.transitionCheckpoint({
        checkpoint: { ...checkpoint, phase: "jobs_renew" },
        credentialSessionActive: true,
      });
      return;
    }
    const result = await this.mutation(
      "jobs.activate",
      () =>
        request(this.config, "jobs.activate", {
          requestId: randomUUID(),
          jobId: job.jobId,
          leaseEpoch: job.leaseEpoch,
          leaseToken: job.leaseToken,
        }),
      (current, response) => {
        if (current.phase !== "jobs_activate") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const active = current.jobs[current.index];
        if (!active) throw new PipelineWorkerError("job_checkpoint_invalid");
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          if (code === "lease_conflict" || code === "reservation_expired") {
            return afterJob(current, current.published);
          }
          if (code === "scan_conflict") {
            return {
              ...current,
              phase: "jobs_fail",
              failureCode: "staging_invalid",
            };
          }
          return processingTerminal(current, "failed", code, undefined, true);
        }
        if (value.jobId !== active.jobId || value.state !== "ready") {
          throw new PipelineWorkerError("job_activation_conflict");
        }
        return afterJob(current, current.published + 1);
      },
    );
    const code = errorCode(result);
    if (code && this.journal.checkpoint.phase === "jobs_activate") {
      throw new PipelineWorkerError(code);
    }
  }

  private async driveJobsFail(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "jobs_fail") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const job = checkpoint.jobs[checkpoint.index];
    if (!job) throw new PipelineWorkerError("job_checkpoint_invalid");
    if (
      !this.journal.pending &&
      job.leaseExpiresAt <= Date.now() + LEASE_SAFETY_MARGIN_MS
    ) {
      await this.journal.transitionCheckpoint({
        checkpoint: afterJob(checkpoint, checkpoint.published),
        credentialSessionActive: true,
      });
      return;
    }
    const result = await this.mutation(
      "jobs.fail",
      () =>
        request(this.config, "jobs.fail", {
          requestId: randomUUID(),
          jobId: job.jobId,
          leaseEpoch: job.leaseEpoch,
          leaseToken: job.leaseToken,
          failureCode: checkpoint.failureCode,
        }),
      (current, response) => {
        if (current.phase !== "jobs_fail") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const active = current.jobs[current.index];
        if (!active) throw new PipelineWorkerError("job_checkpoint_invalid");
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return code === "lease_conflict" || code === "reservation_expired"
            ? afterJob(current, current.published)
            : processingTerminal(current, "failed", code, undefined, true);
        }
        if (value.jobId !== active.jobId) {
          throw new PipelineWorkerError("job_failure_parent_conflict");
        }
        return afterJob(current, current.published);
      },
    );
    const code = errorCode(result);
    if (code && this.journal.checkpoint.phase === "jobs_fail") {
      throw new PipelineWorkerError(code);
    }
  }

  private async driveAssessStatus(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "assess_status") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const status = await this.sourceStatus();
    const enumeration = status.enumeration as
      { state?: unknown; scanId?: unknown } | undefined;
    if (
      enumeration?.state !== "complete" ||
      (enumeration.scanId !== undefined &&
        enumeration.scanId !== checkpoint.scanId)
    ) {
      await this.journal.transitionCheckpoint({
        checkpoint: processingTerminal(
          checkpoint,
          "incomplete",
          "enumeration_not_complete",
        ),
        credentialSessionActive: false,
      });
      return;
    }
    await this.journal.transitionCheckpoint({
      checkpoint: {
        version: 1,
        phase: "assess_begin",
        ...processingBase(checkpoint),
        expectedInventoryEpoch: integer(
          status.inventoryEpoch,
          "inventory_epoch",
        ),
        expectedManifestVersion: integer(
          status.manifestVersion,
          "manifest_version",
        ),
      },
      credentialSessionActive: true,
    });
  }

  private async driveAssessBegin(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "assess_begin") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const result = await this.mutation(
      "processing.assessBegin",
      () =>
        request(this.config, "processing.assessBegin", {
          requestId: randomUUID(),
          scanId: checkpoint.scanId,
          expectedInventoryEpoch: checkpoint.expectedInventoryEpoch,
          expectedManifestVersion: checkpoint.expectedManifestVersion,
        }),
      (current, response) => {
        if (current.phase !== "assess_begin") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return processingTerminal(current, "failed", code, undefined, true);
        }
        if (
          value.scanId !== current.scanId ||
          value.inventoryEpoch !== current.expectedInventoryEpoch ||
          value.manifestVersion !== current.expectedManifestVersion
        ) {
          throw new PipelineWorkerError("assessment_parent_conflict");
        }
        const assessmentId = text(value.assessmentId, "assessment_id");
        if (value.state === "running") {
          return {
            version: 1,
            phase: "assess_page",
            ...processingBase(current),
            assessmentId,
            ordinal: integer(value.nextOrdinal, "assessment_ordinal"),
            pageCount: 0,
          };
        }
        if (value.state === "complete") {
          return processingTerminal(
            current,
            "complete",
            undefined,
            assessmentId,
          );
        }
        return processingTerminal(
          current,
          "incomplete",
          value.state === "stale"
            ? "assessment_stale"
            : "processing_incomplete",
          assessmentId,
        );
      },
    );
    if (errorCode(result)) throw new PipelineWorkerError(errorCode(result)!);
  }

  private async driveAssessPage(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "assess_page") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    const pacingMs =
      this.config.assessmentPacingMs ?? DEFAULT_ASSESSMENT_PACING_MS;
    if (checkpoint.pageCount > 0 && pacingMs) {
      await sleep(pacingMs);
    }
    const result = await this.mutation(
      "processing.assessPage",
      () =>
        request(this.config, "processing.assessPage", {
          requestId: randomUUID(),
          assessmentId: checkpoint.assessmentId,
          ordinal: checkpoint.ordinal,
          maxItems: 1,
        }),
      (current, response) => {
        if (current.phase !== "assess_page") {
          throw new PipelineWorkerError("journal_phase_conflict");
        }
        const value = success(response);
        if (!value) {
          const code = errorCode(response)!;
          return processingTerminal(
            current,
            "incomplete",
            code,
            current.assessmentId,
            true,
          );
        }
        if (
          value.assessmentId !== current.assessmentId ||
          value.ordinal !== current.ordinal
        ) {
          throw new PipelineWorkerError("assessment_page_parent_conflict");
        }
        if (value.state === "running") {
          const nextOrdinal = integer(value.nextOrdinal, "assessment_ordinal");
          if (nextOrdinal !== current.ordinal + 1) {
            throw new PipelineWorkerError("assessment_ordinal_conflict");
          }
          if (current.pageCount + 1 >= MAX_ASSESSMENT_PAGES) {
            return processingTerminal(
              current,
              "incomplete",
              "assessment_capacity_exceeded",
              current.assessmentId,
              true,
            );
          }
          return {
            ...current,
            ordinal: nextOrdinal,
            pageCount: current.pageCount + 1,
          };
        }
        if (value.state === "complete") {
          return processingTerminal(
            current,
            "complete",
            undefined,
            current.assessmentId,
          );
        }
        return processingTerminal(
          current,
          "incomplete",
          value.state === "stale"
            ? "assessment_stale"
            : "processing_incomplete",
          current.assessmentId,
        );
      },
    );
    if (errorCode(result)) throw new PipelineWorkerError(errorCode(result)!);
  }

  private async driveArchived(): Promise<void> {
    const checkpoint = this.journal.checkpoint;
    if (checkpoint.phase !== "archived") {
      throw new PipelineWorkerError("journal_phase_conflict");
    }
    switch (checkpoint.step) {
      case "intent": {
        const next = await this.createArchivedIntents(checkpoint);
        await this.journal.transitionCheckpoint({
          checkpoint: next,
          credentialSessionActive: true,
        });
        return;
      }
      case "preflight":
        return await this.driveArchivedPreflight();
      case "lookup_original":
        return await this.driveArchivedLookupOriginal();
      case "capture":
        return await this.driveArchivedCapture();
      case "original_archive":
        return await this.driveArchiveCopies(checkpoint, "original_bytes");
      case "parse":
        return await this.driveArchivedParse();
      case "spool":
        return await this.driveArchivedSpool();
      case "lookup_processing":
        return await this.driveArchivedLookupProcessing();
      case "parser_archive":
        return await this.driveArchiveCopies(checkpoint, "parser_output");
      case "reserve":
        return await this.driveArchivedReserve();
      case "admit":
        return await this.driveArchivedAdmit();
      case "parsed_reserve":
        return await this.driveParsedReserve();
      case "parsed_renew":
        return await this.driveParsedRenew();
      case "parsed_begin":
        return await this.driveParsedBegin();
      case "parsed_batch":
        return await this.driveParsedBatch();
      case "parsed_seal":
        return await this.driveParsedSeal();
      case "parsed_activate":
        return await this.driveParsedActivate();
      case "cleanup":
        return await this.driveArchivedCleanup();
    }
  }

  private async driveCheckpoint(): Promise<PipelineRunResult | undefined> {
    const checkpoint = this.journal.checkpoint;
    switch (checkpoint.phase) {
      case "idle":
        throw new PipelineWorkerError("journal_phase_conflict");
      case "terminal":
        return resultFromTerminal(checkpoint);
      case "scan_begin":
        await this.driveScanBegin();
        break;
      case "inventory":
        await this.driveInventory();
        break;
      case "append":
        await this.driveAppend();
        break;
      case "seal_check":
        await this.driveSealCheck();
        break;
      case "seal":
        await this.driveSeal();
        break;
      case "reconcile":
        await this.driveReconcile();
        break;
      case "discovery_reserve":
        await this.driveDiscoveryReserve();
        break;
      case "discovery_admit":
        await this.driveDiscoveryAdmit();
        break;
      case "archived":
        await this.driveArchived();
        break;
      case "jobs_reserve":
        await this.driveJobsReserve();
        break;
      case "jobs_renew":
        await this.driveJobsRenew();
        break;
      case "jobs_stage":
        await this.driveJobsStage();
        break;
      case "jobs_activate":
        await this.driveJobsActivate();
        break;
      case "jobs_fail":
        await this.driveJobsFail();
        break;
      case "assess_status":
        await this.driveAssessStatus();
        break;
      case "assess_begin":
        await this.driveAssessBegin();
        break;
      case "assess_page":
        await this.driveAssessPage();
        break;
    }
    return undefined;
  }

  async run(): Promise<PipelineRunResult> {
    return this.withParked(await this.runPass());
  }

  /**
   * P2-31f. Adds the parked summary to a pass result. A pass that ends
   * `complete` with items parked is not the same thing as a clean one, and a
   * monitor needs the count, the codes and the age to say so without reading
   * the catalog.
   */
  private withParked(result: PipelineRunResult): PipelineRunResult {
    const parked = this.archiveCatalog
      ? this.archiveCatalog
          .listOriginals()
          .flatMap((row) => (row.admissionBlock ? [row.admissionBlock] : []))
      : [];
    const withClears =
      this.operatorClears === 0
        ? result
        : { ...result, operatorClears: this.operatorClears };
    if (parked.length === 0) return withClears;
    const escalated = parked.filter(admissionBlockEscalated).length;
    const summarized: PipelineRunResult = {
      ...withClears,
      parked: parked.length,
      parkedEscalated: escalated,
      parkedCodes: [...new Set(parked.map((block) => block.code))].sort(),
      parkedOldestAgeMs: Math.max(
        0,
        Date.now() - Math.min(...parked.map((block) => block.blockedAt)),
      ),
    };
    // A document nothing will free on its own must not leave the pass reading
    // `complete` with a nonzero count buried in it, because that is what a
    // monitor and an exit status both read. Documents still inside their retry
    // budget are counted and leave the pass as it was.
    if (escalated === 0 || summarized.state !== "complete") return summarized;
    return { ...summarized, state: "incomplete", code: "items_need_attention" };
  }

  /**
   * P2-31f. The operator release: `run --retry-parked` drops every marker so
   * the pass tries all of them once more. The automatic releases (new bytes, a
   * new build, the bounded backoff) are `admissionBlockHolds`, and they leave
   * the marker in place on purpose, because it carries the attempt count that
   * bounds them.
   */
  private async clearParkedItems(): Promise<void> {
    const catalog = this.archiveCatalog;
    if (!catalog || !this.options.retryParked) return;
    for (const row of catalog.listOriginals()) {
      if (!row.admissionBlock) continue;
      await catalog.clearAdmissionBlock({
        catalogId: row.originalCatalogId,
        expectedRevision: row.rowRevision,
      });
    }
  }

  private async runPass(): Promise<PipelineRunResult> {
    await this.preparePdfProfile();
    if (this.config.pdfDocQa) {
      this.archiveCatalog = await openArchiveCatalog({ journal: this.journal });
      await this.clearParkedItems();
    }
    if (this.journal.pending) {
      const pendingPhase = this.journal.checkpoint.phase;
      const replayed = await this.driveCheckpoint();
      if (replayed) return replayed;
      const afterReplay = this.journal.checkpoint;
      if (afterReplay.phase === "terminal") {
        const abandonedScan =
          afterReplay.code === "scan_not_ready" &&
          (pendingPhase === "inventory" ||
            pendingPhase === "append" ||
            pendingPhase === "seal_check" ||
            pendingPhase === "seal");
        if (!abandonedScan) {
          return resultFromTerminal(afterReplay);
        }
        // The replayed scan operation was answered `scan_not_ready`: the
        // server expired or sealed this scan server-side (idle past
        // `WORKER_SCAN_IDLE_MS`) while the journal still had it pending.
        // That is ordinary after any client crash long enough to miss the
        // window, so abandon this scan and fall through to start a fresh
        // one instead of reporting a failed run.
        process.stderr.write(
          `${JSON.stringify({ phase: pendingPhase, code: afterReplay.code })}\n`,
        );
      }
    }
    const status = await this.sourceStatus();
    if (status.sourceAccountId !== this.config.sourceAccountId) {
      throw new PipelineWorkerError("source_mismatch");
    }
    if (this.journal.credentialStatus === "changed_quiescent") {
      await this.journal.acceptCredentialAfterAuthorizedStatus();
    }
    const startingCheckpoint = this.journal.checkpoint;
    if (
      startingCheckpoint.phase === "terminal" &&
      stickyTerminal(startingCheckpoint)
    ) {
      return resultFromTerminal(startingCheckpoint);
    }
    if (
      this.journal.checkpoint.phase === "idle" ||
      this.journal.checkpoint.phase === "terminal"
    ) {
      const plans = await this.startCycle(await this.currentRoots(), status);
      if (this.pendingRootReports.length > 0) {
        await this.reportRoots(this.pendingRootReports, plans);
      }
    }

    for (let steps = 0; steps < 10_000; steps += 1) {
      let result: PipelineRunResult | undefined;
      try {
        result = await this.driveCheckpoint();
      } catch (error) {
        const checkpoint = this.journal.checkpoint;
        if (
          error instanceof ParserProcessError &&
          DOCUMENT_PARSER_FAILURE_CODES.has(error.code) &&
          checkpoint.phase === "archived" &&
          checkpoint.step === "parse"
        ) {
          await this.recordArchivedParseFailure(checkpoint, error.code);
          continue;
        }
        // P2-31f. A per-item condition raised outside a journaled call: park
        // the document and carry on with the rest of the pass.
        //
        // `this.journal.pending` is the whole safety rule. A parkable code
        // raised from inside a transition leaves the request answered but
        // unresolved, and parking on top of that would commit a checkpoint
        // move over a call the journal has not settled. Those sites return a
        // parked checkpoint instead (`parkedCheckpoint`); anything that still
        // reaches here with a request in flight fails the pass as before.
        const parkCode = parkable(error);
        if (
          parkCode !== undefined &&
          checkpoint.phase === "archived" &&
          !this.journal.pending
        ) {
          await this.journal.transitionCheckpoint({
            checkpoint: await this.parkedCheckpoint(checkpoint, parkCode),
            credentialSessionActive: true,
          });
          continue;
        }
        throw error;
      }
      if (result) return result;
    }
    throw new PipelineWorkerError("worker_step_limit");
  }

  /**
   * ADM-9. Tells the server how this pass ended.
   *
   * One send, from the one place every pass ends, rather than a send per
   * terminal branch. The refusal path is why this exists -- `refuseRetirement`
   * returns before a scan is opened, so the pass writes no scan and no
   * processing assessment, and the health screen reads only those two things
   * plus the heartbeat -- but a `failed` pass and every other terminal code
   * were just as invisible, so all of them travel through here.
   *
   * Never changes the pass result, ever. The result is already decided when
   * this runs; the send is best-effort, and an old server that has never heard
   * of the operation answers `invalid_request`, which is the ordinary case
   * while the owner's watcher runs behind and not an error.
   *
   * Two bounds the first review asked for, both about not making a healthy
   * pass wait on this. The send gets `PASS_OUTCOME_TIMEOUT_MS` of its own
   * rather than the transport's 30s, because it runs on the way out of every
   * pass and on the way to a SIGTERM shutdown. And it says so once per process
   * rather than once per pass: a server that will never accept this operation
   * would otherwise write the same line every five minutes forever, which is
   * how a real warning goes unread.
   */
  private async reportPassOutcome(result: PipelineRunResult): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      PASS_OUTCOME_TIMEOUT_MS,
    );
    try {
      const response = await this.transport.call(
        request(this.config, "diagnostics.passOutcome", {
          watcherId: this.journal.watcherId,
          state: result.state,
          // The codes are the pipeline's own literals, but the wire pattern is
          // narrower than `string`; a code that does not fit is dropped rather
          // than being allowed to make the whole report invalid.
          ...(result.code !== undefined && PASS_CODE.test(result.code)
            ? { code: result.code }
            : {}),
          scanned: result.scanned ?? 0,
          published: result.published ?? 0,
          finishedAt: Date.now(),
        }),
        controller.signal,
      );
      // A refused report is a returned error envelope, not a throw, so the
      // quiet case needs looking at rather than catching.
      if (response && typeof response === "object" && "error" in response) {
        warnPassOutcomeOnce(
          (response as { error: { code: string } }).error.code,
        );
      }
    } catch (error) {
      warnPassOutcomeOnce(
        error instanceof Error ? error.message : "unknown error",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async runSafely(): Promise<PipelineRunResult> {
    try {
      const result = await this.run();
      await this.reportPassOutcome(result);
      return result;
    } catch (error) {
      const code =
        error instanceof FilesystemFailure ||
        error instanceof PipelineWorkerError
          ? error.code
          : error instanceof ParserProcessError &&
              SAFE_PARSER_FAILURE_CODES.has(error.code)
            ? error.code
            : "worker_failed";
      // `worker_failed` is the unclassified bucket: every other branch above
      // already carries a code that names what went wrong. Never leave this
      // one silent - report the error's name, a sanitized message, and where
      // it happened (phase, and entry index when the failure came from
      // building one page's entries) to stderr and the journal's failure
      // record, so a deterministic failure like this is diagnosable instead
      // of an empty `{"state":"failed","code":"worker_failed"}`.
      if (code === "worker_failed") {
        const detail = describeUnsafeFailure(
          error,
          this.journal.checkpoint.phase,
        );
        process.stderr.write(`${JSON.stringify(detail)}\n`);
        await this.journal.recordFailure(detail);
      }
      const failure = this.withParked({
        state:
          error instanceof PipelineRetryableError ? "incomplete" : "failed",
        code,
      });
      await this.reportPassOutcome(failure);
      return failure;
    }
  }
}
