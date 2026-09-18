import { randomUUID } from "node:crypto";

import { openArchiveCatalog, type ArchiveCatalog } from "./archiveCatalog.js";
import {
  journalBindingForConfig,
  loadPipelineConfig,
  requireCredential,
} from "./config.js";
import { Journal, JournalLockedError } from "./journal.js";
import type { JsonValue } from "./journalTypes.js";
import {
  archivedCheckpointIdentity,
  initialCheckpoint,
  journalCodec,
} from "./runner.js";
import { parseRunnerCheckpoint, type RunnerCheckpoint } from "./runnerState.js";
import type {
  PipelineConfig,
  WorkerErrorCode,
  WorkerResponse,
  WorkerTransport,
} from "./types.js";

/**
 * P2-31d. Codes an operator wrapper may whitelist. Every one of them means the
 * command wrote nothing.
 */
export type ReconcileRefusalCode =
  | "journal_contended"
  | "journal_request_pending"
  | "checkpoint_not_archived"
  | "checkpoint_rows_missing"
  | "checkpoint_plan_missing"
  | "processing_receipt_conflict"
  | "lookup_refused"
  | "lookup_invalid";

export type ReconcileReceiptsResult = {
  state: "clean" | "unknown_receipt_found" | "reconciled" | "refused";
  /** The lookup addresses the checkpoint's own original and nothing else. */
  scope: "checkpoint_original";
  applied: boolean;
  /** Local originals carrying a `cloud` receipt, across the whole catalog. */
  originalsWithReceipts: number;
  /** How many of those the lookup could address. Never more than one. */
  receiptsChecked: number;
  receiptsConfirmed: number;
  receiptsUnknown: number;
  code?: ReconcileRefusalCode;
  /** The worker error code behind a `lookup_refused`. */
  lookupCode?: WorkerErrorCode;
};

function isWorkerError(
  value: WorkerResponse,
): value is { error: { code: WorkerErrorCode } } {
  const error = (value as { error?: { code?: unknown } }).error;
  return typeof error?.code === "string";
}

/**
 * Asks the authoritative server, through the read-only lookup the archived
 * pass itself uses, whether it holds the admission the local catalog claims,
 * and with `--apply` clears a receipt it does not hold.
 *
 * Client only. It sends one `discovery.lookupArchivedAdmission`, which
 * reserves nothing and spends no discovery attempt, and it changes no server
 * state at all. A receipt the server does confirm is never touched: `cloud`
 * records that original bytes were accepted somewhere, so only an explicit
 * not-found answer may retire one.
 */
export async function runReconcileReceipts(input: {
  config: PipelineConfig;
  journal: Journal<RunnerCheckpoint, JsonValue>;
  catalog: ArchiveCatalog;
  transport: WorkerTransport;
  apply: boolean;
}): Promise<ReconcileReceiptsResult> {
  const originalsWithReceipts = input.catalog
    .listOriginals()
    .filter((row) => row.cloud).length;
  const base = {
    scope: "checkpoint_original",
    applied: false,
    originalsWithReceipts,
    receiptsChecked: 0,
    receiptsConfirmed: 0,
    receiptsUnknown: 0,
  } as const;
  const refuse = (
    code: ReconcileRefusalCode,
    lookupCode?: WorkerErrorCode,
  ): ReconcileReceiptsResult => ({
    ...base,
    state: "refused",
    code,
    ...(lookupCode === undefined ? {} : { lookupCode }),
  });
  // A pending request owns the next write. Replaying it is `run`'s job.
  if (input.journal.pending) return refuse("journal_request_pending");
  const checkpoint = input.journal.checkpoint;
  if (checkpoint.phase !== "archived") {
    return originalsWithReceipts === 0
      ? { ...base, state: "clean" }
      : refuse("checkpoint_not_archived");
  }
  const original = input.catalog
    .listOriginals()
    .find((row) => row.originalCatalogId === checkpoint.originalCatalogId);
  const processing = input.catalog
    .listProcessings()
    .find((row) => row.processingCatalogId === checkpoint.processingCatalogId);
  if (!original || !processing) return refuse("checkpoint_rows_missing");
  // A clear commits the processing row first and the original row second, and
  // the original's note is what marks the pair done. A rerun that finds the
  // note without a receipt is finishing an interrupted checkpoint move, so it
  // asks the server nothing and repeats two no-op catalog writes.
  const resuming = !original.cloud && original.receiptReconcile !== undefined;
  let receiptsChecked = 0;
  let receiptsUnknown = 0;
  if (original.cloud) {
    const identity = archivedCheckpointIdentity(checkpoint);
    if (!identity) return refuse("checkpoint_plan_missing");
    receiptsChecked = 1;
    const response = await input.transport.call({
      protocolVersion: 1,
      operation: "discovery.lookupArchivedAdmission",
      spaceId: input.config.spaceId,
      sourceAccountId: input.config.sourceAccountId,
      requestId: randomUUID(),
      identity,
      lookup: { mode: "original" },
    });
    if (isWorkerError(response))
      return refuse("lookup_refused", response.error.code);
    if (
      response.operation !== "discovery.lookupArchivedAdmission" ||
      response.mode !== "original" ||
      typeof response.found !== "boolean"
    )
      return refuse("lookup_invalid");
    if (response.found)
      return { ...base, receiptsChecked, receiptsConfirmed: 1, state: "clean" };
    receiptsUnknown = 1;
  } else if (!resuming) {
    return { ...base, state: "clean" };
  }
  const found = { ...base, receiptsChecked, receiptsUnknown };
  if (!input.apply)
    return {
      ...found,
      state: receiptsUnknown === 0 ? "clean" : "unknown_receipt_found",
    };
  if (
    resuming &&
    checkpoint.step === "lookup_original" &&
    checkpoint.receiptChecked === undefined &&
    checkpoint.discoveryLease === undefined
  )
    return { ...found, state: "clean" };
  // One `discovery.admitArchived` commits both legs, so a processing receipt
  // naming the same revision is void with the original's. One naming a
  // different revision is a shape nothing in this pipeline produces, and
  // guessing at it would retire a receipt that may be real.
  if (
    original.cloud &&
    processing.cloud &&
    processing.cloud.sourceRevisionId !== original.cloud.sourceRevisionId
  )
    return refuse("processing_receipt_conflict");
  const clearedAt = Date.now();
  const nextProcessing = await input.catalog.clearVoidAdmission({
    subject: "parser_output",
    catalogId: processing.processingCatalogId,
    expectedRevision: processing.rowRevision,
    clearedAt,
  });
  const nextOriginal = await input.catalog.clearVoidAdmission({
    subject: "original_bytes",
    catalogId: original.originalCatalogId,
    expectedRevision: original.rowRevision,
    clearedAt,
  });
  // Back to the read-only lookup with the question unasked, the dead lease
  // dropped, and both expected revisions in step with what was just written.
  // The next pass then meets a not-found answer with no local `cloud`, which
  // is the ordinary first-admission path.
  await input.journal.transitionCheckpoint({
    checkpoint: parseRunnerCheckpoint({
      ...checkpoint,
      step: "lookup_original",
      receiptChecked: undefined,
      discoveryLease: undefined,
      expectedOriginalRevision: nextOriginal.rowRevision,
      expectedProcessingRevision: nextProcessing.rowRevision,
    }),
    credentialSessionActive: true,
  });
  return { ...found, state: "reconciled", applied: true };
}

export async function reconcileReceiptsFromPath(
  configPath: string,
  apply: boolean,
  makeTransport: (
    config: PipelineConfig,
    credential: string,
  ) => WorkerTransport,
): Promise<ReconcileReceiptsResult> {
  const config = await loadPipelineConfig(configPath);
  const credential = requireCredential(config);
  let journal: Journal<RunnerCheckpoint, JsonValue>;
  try {
    journal = await Journal.open({
      directory: config.journalDir,
      binding: journalBindingForConfig(config),
      credential,
      initialCheckpoint,
      codec: journalCodec,
    });
  } catch (error) {
    // The watcher holds the journal while it runs. Reconciling underneath it
    // would race a pass that is mid admission, so stop the watcher first.
    if (error instanceof JournalLockedError)
      return {
        state: "refused",
        scope: "checkpoint_original",
        applied: false,
        originalsWithReceipts: 0,
        receiptsChecked: 0,
        receiptsConfirmed: 0,
        receiptsUnknown: 0,
        code: "journal_contended",
      };
    throw error;
  }
  try {
    return await runReconcileReceipts({
      config,
      journal,
      catalog: await openArchiveCatalog({ journal }),
      transport: makeTransport(config, credential),
      apply,
    });
  } finally {
    await journal.close();
  }
}

export function formatReconcileResult(value: ReconcileReceiptsResult): string {
  return value.state === "refused"
    ? `reconcile-receipts: refused (${value.code}${value.lookupCode ? `: ${value.lookupCode}` : ""})`
    : `reconcile-receipts: ${value.state} receipts=${value.originalsWithReceipts} checked=${value.receiptsChecked} confirmed=${value.receiptsConfirmed} unknown=${value.receiptsUnknown} applied=${value.applied}`;
}
