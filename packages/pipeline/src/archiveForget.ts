import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";

import {
  forgetResticBackupExact,
  removePublishedAgeObjectExact,
} from "./archiveCommands.js";
import { ArchiveCatalog } from "./archiveCatalog.js";
import type {
  ArchiveCopyRecord,
  ArchiveCopyRole,
  ArchiveSubject,
  OriginalCatalogRow,
  ProcessingCatalogRow,
} from "./archiveCatalogTypes.js";
import {
  inspectCaptureIntentState,
  removeCapturedPdfExact,
} from "./captureStore.js";
import {
  type DurableParserOutputArtifacts,
  inspectParserOutputIntent,
  removeParserOutputExact,
} from "./parserProcess.js";
import {
  inspectSpoolIntentState,
  removeNormalizedBundleSpoolExact,
} from "./spoolStore.js";
import type {
  PdfDocQaConfig,
  PipelineConfig,
  WorkerResponse,
  WorkerTransport,
} from "./types.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_TARGETS = 2_048;
const MAX_PAGES = 512;

type CloudAck = {
  deletionId: string;
  receiptId: string;
  forgetEpoch: number;
  objectOutcome: "deleted" | "already_missing";
  backupOutcome?: "deleted" | "already_missing";
  absenceAuthority: "worker_asserted_physical_absence";
  completedAt: number;
};

type CloudTarget = {
  receiptId: string;
  clientReceiptId: string;
  receiptRequestDigest: string;
  subjectKind: ArchiveSubject;
  copyRole: ArchiveCopyRole;
  archiveIdentityFingerprint: string;
  archiveObjectId: string;
  ciphertextHash: string;
  ciphertextByteLength: number;
  forgetEpoch: number;
  ack?: CloudAck;
};

type ForgetPage = {
  operation: "archive.forgetTargets";
  sourceItemId: string;
  sourceExternalIdHash: string;
  forgetEpoch: number;
  targets: CloudTarget[];
  isDone: boolean;
  continueCursor: string;
};

type AckResult = CloudAck & {
  operation: "archive.ackDeletion";
  reused: boolean;
};

type SelectedRow =
  | { subject: "original_bytes"; row: OriginalCatalogRow }
  | { subject: "parser_output"; row: ProcessingCatalogRow };

type MatchedCopy = SelectedRow & {
  role: ArchiveCopyRole;
  copy: ArchiveCopyRecord;
};

export type ArchiveForgetResult =
  | {
      state: "owner_finalization_required";
      sourceItemId: string;
      forgetEpoch: number;
      receiptCount: number;
      acknowledgedCount: number;
      localCopyCount: number;
      nextAction: "run_authenticated_owner_continue_forget";
    }
  | {
      state: "needs_review" | "retryable" | "failed";
      code: string;
    };

export type ArchiveForgetCommands = {
  removeAge: typeof removePublishedAgeObjectExact;
  forgetBackup: typeof forgetResticBackupExact;
  removeCapture: typeof removeCapturedPdfExact;
  inspectCaptureIntent: typeof inspectCaptureIntentState;
  removeParserOutput: typeof removeParserOutputExact;
  inspectParserIntent: typeof inspectParserOutputIntent;
  inspectSpoolIntent: typeof inspectSpoolIntentState;
  removeSpool: typeof removeNormalizedBundleSpoolExact;
};

const defaultCommands: ArchiveForgetCommands = {
  removeAge: removePublishedAgeObjectExact,
  forgetBackup: forgetResticBackupExact,
  removeCapture: removeCapturedPdfExact,
  inspectCaptureIntent: inspectCaptureIntentState,
  removeParserOutput: removeParserOutputExact,
  inspectParserIntent: inspectParserOutputIntent,
  inspectSpoolIntent: inspectSpoolIntentState,
  removeSpool: removeNormalizedBundleSpoolExact,
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function operationalFailure(error: unknown): ArchiveForgetResult {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "operation_failed";
  if (code === "rate_limited") return { state: "retryable", code };
  if (
    code === "stale_observation" ||
    code === "scan_conflict" ||
    code === "request_conflict" ||
    code === "not_found" ||
    code === "source_changed" ||
    code === "unsafe_path" ||
    code === "digest_mismatch" ||
    code === "output_invalid" ||
    code === "catalog_invalid" ||
    code === "destination_exists" ||
    code === "catalog_conflict" ||
    code === "invalid_transition" ||
    code === "local_source_not_found" ||
    code === "source_identity_conflict" ||
    code === "target_identity_mismatch" ||
    code === "receipt_set_mismatch" ||
    code === "receipt_set_changed" ||
    code === "ack_identity_mismatch" ||
    code === "ack_not_observed" ||
    code === "lost_encryption_result" ||
    code === "unpublished_ciphertext" ||
    code === "backup_identity_missing" ||
    code === "backup_identity_mismatch" ||
    code === "deletion_identity_conflict" ||
    code === "local_deletion_incomplete" ||
    code === "spool_unpublished" ||
    code === "lost_spool_result" ||
    code === "lost_capture_result" ||
    code === "parser_intent_changed"
  )
    return { state: "needs_review", code };
  return { state: "failed", code };
}

function isWorkerError(
  result: WorkerResponse,
): result is { error: { code: string } } {
  return "error" in result;
}

async function enumerateTargets(input: {
  config: PipelineConfig;
  transport: WorkerTransport;
  sourceItemId: string;
  forgetEpoch: number;
}): Promise<{ sourceExternalIdHash: string; targets: CloudTarget[] }> {
  let cursor: string | null = null;
  let sourceExternalIdHash: string | undefined;
  const seenCursors = new Set<string>();
  const seenReceipts = new Set<string>();
  const targets: CloudTarget[] = [];
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const response = await input.transport.call({
      protocolVersion: 1,
      operation: "archive.forgetTargets",
      spaceId: input.config.spaceId,
      sourceAccountId: input.config.sourceAccountId,
      requestId: randomUUID(),
      sourceItemId: input.sourceItemId,
      expectedForgetEpoch: input.forgetEpoch,
      paginationOpts: { cursor, numItems: 4 },
    });
    if (isWorkerError(response)) throw { code: response.error.code };
    const page = response as ForgetPage;
    if (
      page.operation !== "archive.forgetTargets" ||
      page.sourceItemId !== input.sourceItemId ||
      page.forgetEpoch !== input.forgetEpoch ||
      !SHA256.test(page.sourceExternalIdHash)
    )
      throw { code: "invalid_response" };
    if (
      sourceExternalIdHash !== undefined &&
      page.sourceExternalIdHash !== sourceExternalIdHash
    )
      throw { code: "invalid_response" };
    sourceExternalIdHash = page.sourceExternalIdHash;
    for (const target of page.targets) {
      if (seenReceipts.has(target.receiptId))
        throw { code: "duplicate_receipt" };
      seenReceipts.add(target.receiptId);
      targets.push(target);
      if (targets.length > MAX_TARGETS) throw { code: "target_limit" };
    }
    if (page.isDone) return { sourceExternalIdHash, targets };
    if (!page.continueCursor || seenCursors.has(page.continueCursor))
      throw { code: "cursor_cycle" };
    seenCursors.add(page.continueCursor);
    cursor = page.continueCursor;
  }
  throw { code: "page_limit" };
}

async function validateForgetAuthority(input: {
  config: PipelineConfig;
  transport: WorkerTransport;
  sourceItemId: string;
  forgetEpoch: number;
  sourceExternalIdHash: string;
}): Promise<void> {
  const response = await input.transport.call({
    protocolVersion: 1,
    operation: "archive.forgetTargets",
    spaceId: input.config.spaceId,
    sourceAccountId: input.config.sourceAccountId,
    requestId: randomUUID(),
    sourceItemId: input.sourceItemId,
    expectedForgetEpoch: input.forgetEpoch,
    paginationOpts: { cursor: null, numItems: 1 },
  });
  if (isWorkerError(response)) throw { code: response.error.code };
  const page = response as ForgetPage;
  if (
    page.operation !== "archive.forgetTargets" ||
    page.sourceItemId !== input.sourceItemId ||
    page.forgetEpoch !== input.forgetEpoch ||
    page.sourceExternalIdHash !== input.sourceExternalIdHash
  )
    throw { code: "forget_authority_changed" };
}

function copyKey(subject: ArchiveSubject, catalogId: string, role: string) {
  return `${subject}\0${catalogId}\0${role}`;
}

function selectedRows(
  catalog: ArchiveCatalog,
  sourceExternalId: string,
  sourceItemId: string,
): SelectedRow[] {
  const originals = catalog
    .listOriginals()
    .filter((row) => row.sourceExternalId === sourceExternalId);
  if (originals.length === 0) throw { code: "local_source_not_found" };
  for (const row of originals) {
    if (row.cloud && row.cloud.sourceItemId !== sourceItemId)
      throw { code: "source_identity_conflict" };
  }
  const ids = new Set(originals.map((row) => row.originalCatalogId));
  const processings = catalog
    .listProcessings()
    .filter((row) => ids.has(row.originalCatalogId));
  for (const row of processings) {
    if (row.cloud && row.cloud.sourceItemId !== sourceItemId)
      throw { code: "source_identity_conflict" };
  }
  return [
    ...originals.map((row): SelectedRow => ({
      subject: "original_bytes",
      row,
    })),
    ...processings.map((row): SelectedRow => ({
      subject: "parser_output",
      row,
    })),
  ];
}

function allCopies(rows: SelectedRow[]): MatchedCopy[] {
  return rows.flatMap((selected) =>
    (["primary", "independent_backup"] as const).map((role) => ({
      ...selected,
      role,
      copy: selected.row.copies[role],
    })),
  );
}

function matchesTarget(copy: MatchedCopy, target: CloudTarget): boolean {
  return (
    copy.subject === target.subjectKind &&
    copy.role === target.copyRole &&
    copy.copy.clientReceiptId === target.clientReceiptId &&
    copy.copy.archiveIdentityFingerprint ===
      target.archiveIdentityFingerprint &&
    copy.copy.archiveObjectId === target.archiveObjectId &&
    copy.copy.published?.ciphertext.sha256 === target.ciphertextHash &&
    copy.copy.published?.ciphertext.byteLength ===
      target.ciphertextByteLength &&
    copy.copy.cloudReceipt?.receiptId === target.receiptId
  );
}

function reconcileTargets(rows: SelectedRow[], targets: CloudTarget[]) {
  const copies = allCopies(rows);
  const matched = new Map<string, MatchedCopy>();
  for (const target of targets) {
    const candidates = copies.filter((copy) => matchesTarget(copy, target));
    if (candidates.length !== 1) throw { code: "target_identity_mismatch" };
    matched.set(target.receiptId, candidates[0]!);
    const deletion = candidates[0]!.copy.deletion;
    if (
      deletion &&
      deletion.receiptRequestDigest !== target.receiptRequestDigest
    )
      throw { code: "target_identity_mismatch" };
    if (
      target.ack &&
      (!deletion ||
        deletion.state !== "complete" ||
        deletion.reason !== "forget" ||
        deletion.forgetEpoch !== target.forgetEpoch ||
        deletion.deletionId !== target.ack.deletionId ||
        deletion.object !== target.ack.objectOutcome ||
        deletion.backup !== target.ack.backupOutcome)
    )
      throw { code: "ack_identity_mismatch" };
  }
  for (const copy of copies) {
    if (
      copy.copy.cloudReceipt &&
      !targets.some(
        (target) => target.receiptId === copy.copy.cloudReceipt!.receiptId,
      )
    )
      throw { code: "receipt_set_mismatch" };
  }
  return matched;
}

function catalogId(selected: SelectedRow): string {
  return selected.subject === "original_bytes"
    ? selected.row.originalCatalogId
    : selected.row.processingCatalogId;
}

function currentRow(
  catalog: ArchiveCatalog,
  selected: SelectedRow,
): SelectedRow {
  const id = catalogId(selected);
  const row =
    selected.subject === "original_bytes"
      ? catalog.listOriginals().find((value) => value.originalCatalogId === id)
      : catalog
          .listProcessings()
          .find((value) => value.processingCatalogId === id);
  if (!row) throw { code: "catalog_not_found" };
  return { subject: selected.subject, row } as SelectedRow;
}

function preflightCopies(rows: SelectedRow[], forgetEpoch: number): void {
  for (const selected of rows) {
    for (const role of ["primary", "independent_backup"] as const) {
      const copy = selected.row.copies[role];
      if (copy.reviewCode) throw { code: copy.reviewCode };
      if (copy.preparationIntent && !copy.prepared)
        throw { code: "lost_encryption_result" };
      if (copy.prepared && !copy.published)
        throw { code: "unpublished_ciphertext" };
      if (role === "independent_backup" && copy.published && !copy.backup)
        throw { code: "backup_identity_missing" };
      if (
        copy.deletion &&
        (copy.deletion.reason !== "forget" ||
          copy.deletion.forgetEpoch !== forgetEpoch)
      ) {
        const completedOrphan =
          selected.subject === "parser_output" &&
          copy.cloudReceipt === undefined &&
          copy.deletion.state === "complete" &&
          copy.deletion.reason === "verified_orphan";
        if (!completedOrphan) throw { code: "deletion_identity_conflict" };
      }
    }
  }
}

async function deleteCopy(input: {
  config: PdfDocQaConfig;
  catalog: ArchiveCatalog;
  selected: SelectedRow;
  role: ArchiveCopyRole;
  forgetEpoch: number;
  commands: ArchiveForgetCommands;
  now: () => number;
  cloudTarget?: CloudTarget;
  authorize: () => Promise<void>;
}): Promise<boolean> {
  let selected = currentRow(input.catalog, input.selected);
  let copy = selected.row.copies[input.role];
  if (!copy.published) return false;
  if (
    copy.deletion?.state === "complete" &&
    copy.deletion.reason === "verified_orphan" &&
    selected.subject === "parser_output" &&
    copy.cloudReceipt === undefined
  )
    return true;
  if (!copy.deletion) {
    await input.catalog.planDeletion({
      subject: selected.subject,
      catalogId: catalogId(selected),
      expectedRevision: selected.row.rowRevision,
      role: input.role,
      deletionId: randomUUID(),
      reason: "forget",
      plannedAt: input.now(),
      forgetEpoch: input.forgetEpoch,
      ...(input.cloudTarget === undefined
        ? {}
        : { receiptRequestDigest: input.cloudTarget.receiptRequestDigest }),
    });
    selected = currentRow(input.catalog, selected);
    copy = selected.row.copies[input.role];
  }
  if (copy.deletion?.state === "complete") return true;
  const target = input.catalog.nextDeletionTarget(
    selected.subject,
    catalogId(selected),
  );
  if (!target || target.role !== input.role)
    throw { code: "deletion_order_conflict" };
  const directory =
    input.role === "primary"
      ? input.config.archive.primary.directory
      : input.config.archive.independentBackup.directory;
  const objectPath = join(directory, target.objectName);
  if (basename(objectPath) !== target.objectName)
    throw { code: "object_name_invalid" };
  let backup: "deleted" | "already_missing" | undefined;
  if (input.role === "independent_backup") {
    if (
      !target.operationId ||
      !target.host ||
      !target.repositoryId ||
      !target.snapshotId ||
      target.host !== input.config.archive.independentBackup.host ||
      target.repositoryId !==
        input.config.archive.independentBackup.expectedRepositoryId
    )
      throw { code: "backup_identity_mismatch" };
    await input.authorize();
    const result = await input.commands.forgetBackup({
      resticBinary: input.config.archive.independentBackup.resticBinary,
      repositoryPath: input.config.archive.independentBackup.repositoryPath,
      expectedRepositoryId:
        input.config.archive.independentBackup.expectedRepositoryId,
      passwordCommand: input.config.archive.independentBackup.passwordCommand,
      operationId: target.operationId,
      host: target.host,
      snapshotId: target.snapshotId,
      objectName: target.objectName,
      expectedCiphertext: {
        sha256: target.ciphertextSha256,
        byteLength: target.ciphertextByteLength,
      },
    });
    backup = result.outcome;
  }
  await input.authorize();
  const object = await input.commands.removeAge({
    objectPath,
    expectedDirectory: {
      device: target.archiveDirectoryDevice,
      inode: target.archiveDirectoryInode,
    },
    expectedFile: {
      device: target.ciphertextDevice,
      inode: target.ciphertextInode,
      sha256: target.ciphertextSha256,
      byteLength: target.ciphertextByteLength,
    },
  });
  await input.catalog.recordDeletionResult({
    subject: selected.subject,
    catalogId: target.catalogId,
    expectedRevision: target.expectedRowRevision,
    role: target.role,
    deletionId: target.deletionId,
    forgetEpoch: input.forgetEpoch,
    completedAt: input.now(),
    object: object.outcome,
    ...(backup === undefined ? {} : { backup }),
  });
  return true;
}

function parserArtifacts(
  root: string,
  row: ProcessingCatalogRow,
): DurableParserOutputArtifacts {
  if (!row.parserOutput) throw { code: "parser_output_missing" };
  const outputDirectory = join(root, row.parserOutput.outputId);
  return {
    ...row.parserOutput,
    rawArtifact: {
      ...row.parserOutput.rawArtifact,
      path: join(outputDirectory, row.parserOutput.rawArtifact.opaqueName),
    },
    normalizedBundle: {
      ...row.parserOutput.normalizedBundle,
      path: join(outputDirectory, row.parserOutput.normalizedBundle.opaqueName),
    },
  };
}

async function removePlaintext(input: {
  pdf: PdfDocQaConfig;
  row: ProcessingCatalogRow;
  commands: ArchiveForgetCommands;
  authorize: () => Promise<void>;
}): Promise<void> {
  const { row, pdf, commands } = input;
  if (row.spoolPrepared && !row.spool) throw { code: "spool_unpublished" };
  if (row.spool) {
    await input.authorize();
    await commands.removeSpool({
      spoolRoot: pdf.spoolDirectory,
      expectedRoot: row.spoolIntent.root,
      spool: row.spool,
    });
  }
  if (row.parserOutput) {
    await input.authorize();
    await commands.removeParserOutput({
      outputRoot: pdf.parserOutputRoot,
      outputIntent: row.parserIntent,
      artifacts: parserArtifacts(pdf.parserOutputRoot, row),
    });
  } else {
    const inspected = await commands.inspectParserIntent({
      outputRoot: pdf.parserOutputRoot,
      outputId: row.parserIntent.outputId,
      requireEmpty: true,
    });
    if (
      inspected.outputId !== row.parserIntent.outputId ||
      inspected.outputRoot.device !== row.parserIntent.outputRoot.device ||
      inspected.outputRoot.inode !== row.parserIntent.outputRoot.inode ||
      inspected.outputDirectory.device !==
        row.parserIntent.outputDirectory.device ||
      inspected.outputDirectory.inode !== row.parserIntent.outputDirectory.inode
    )
      throw { code: "parser_intent_changed" };
  }
  if (row.capture) {
    await input.authorize();
    await commands.removeCapture({
      version: 1,
      captureId: row.captureIntent.captureId,
      captureDirectory: {
        path: pdf.captureDirectory,
        ...row.captureIntent.directory,
      },
      path: join(pdf.captureDirectory, `${row.captureIntent.captureId}.pdf`),
      ...row.capture,
    });
  }
}

async function preflightPlaintext(input: {
  pdf: PdfDocQaConfig;
  rows: SelectedRow[];
  commands: ArchiveForgetCommands;
}): Promise<void> {
  for (const selected of input.rows) {
    if (selected.subject !== "parser_output") continue;
    const row = selected.row;
    if (row.spoolPrepared && !row.spool) throw { code: "spool_unpublished" };
    if (!row.spoolPrepared && !row.spool) {
      const spool = await input.commands.inspectSpoolIntent({
        spoolRoot: input.pdf.spoolDirectory,
        expectedRoot: row.spoolIntent.root,
        spoolId: row.spoolIntent.spoolId,
      });
      if (spool.state !== "absent") throw { code: "lost_spool_result" };
    }
    if (!row.capture) {
      const capture = await input.commands.inspectCaptureIntent({
        captureDirectory: input.pdf.captureDirectory,
        captureId: row.captureIntent.captureId,
        expectedDirectory: {
          path: input.pdf.captureDirectory,
          ...row.captureIntent.directory,
        },
      });
      if (capture.state !== "absent") throw { code: "lost_capture_result" };
    }
    if (row.parserOutput) continue;
    const inspected = await input.commands.inspectParserIntent({
      outputRoot: input.pdf.parserOutputRoot,
      outputId: row.parserIntent.outputId,
      requireEmpty: true,
    });
    if (
      inspected.outputId !== row.parserIntent.outputId ||
      inspected.outputRoot.device !== row.parserIntent.outputRoot.device ||
      inspected.outputRoot.inode !== row.parserIntent.outputRoot.inode ||
      inspected.outputDirectory.device !==
        row.parserIntent.outputDirectory.device ||
      inspected.outputDirectory.inode !== row.parserIntent.outputDirectory.inode
    )
      throw { code: "parser_intent_changed" };
  }
}

function completeDeletion(copy: ArchiveCopyRecord, forgetEpoch: number) {
  if (
    copy.deletion?.state !== "complete" ||
    copy.deletion.reason !== "forget" ||
    copy.deletion.forgetEpoch !== forgetEpoch
  )
    throw { code: "local_deletion_incomplete" };
  return copy.deletion;
}

export async function runArchiveForget(input: {
  config: PipelineConfig;
  catalog: ArchiveCatalog;
  transport: WorkerTransport;
  sourceItemId: string;
  sourceExternalId: string;
  forgetEpoch: number;
  commands?: ArchiveForgetCommands;
  now?: () => number;
}): Promise<ArchiveForgetResult> {
  try {
    if (
      !input.config.pdfDocQa ||
      !ID.test(input.sourceItemId) ||
      !UUID.test(input.sourceExternalId) ||
      !Number.isSafeInteger(input.forgetEpoch) ||
      input.forgetEpoch < 1
    )
      throw { code: "invalid_input" };
    const commands = input.commands ?? defaultCommands;
    const now = input.now ?? Date.now;
    const first = await enumerateTargets(input);
    if (first.sourceExternalIdHash !== sha256(input.sourceExternalId))
      throw { code: "source_identity_conflict" };
    const rows = selectedRows(
      input.catalog,
      input.sourceExternalId,
      input.sourceItemId,
    );
    preflightCopies(rows, input.forgetEpoch);
    await preflightPlaintext({
      pdf: input.config.pdfDocQa,
      rows,
      commands,
    });
    const matches = reconcileTargets(rows, first.targets);
    const authorize = async () =>
      await validateForgetAuthority({
        config: input.config,
        transport: input.transport,
        sourceItemId: input.sourceItemId,
        forgetEpoch: input.forgetEpoch,
        sourceExternalIdHash: first.sourceExternalIdHash,
      });
    const targetsByCopy = new Map<string, CloudTarget>();
    for (const target of first.targets) {
      const matched = matches.get(target.receiptId)!;
      targetsByCopy.set(
        copyKey(matched.subject, catalogId(matched), matched.role),
        target,
      );
    }
    let localCopyCount = 0;
    for (const selected of rows) {
      for (const role of ["primary", "independent_backup"] as const) {
        if (
          await deleteCopy({
            config: input.config.pdfDocQa,
            catalog: input.catalog,
            selected,
            role,
            forgetEpoch: input.forgetEpoch,
            commands,
            now,
            cloudTarget: targetsByCopy.get(
              copyKey(selected.subject, catalogId(selected), role),
            ),
            authorize,
          })
        )
          localCopyCount += 1;
      }
    }
    for (const selected of rows) {
      if (selected.subject === "parser_output")
        await removePlaintext({
          pdf: input.config.pdfDocQa,
          row: currentRow(input.catalog, selected).row as ProcessingCatalogRow,
          commands,
          authorize,
        });
    }
    for (const target of first.targets) {
      const matched = matches.get(target.receiptId)!;
      const current = currentRow(input.catalog, matched);
      const copy = current.row.copies[target.copyRole];
      const deletion = completeDeletion(copy, input.forgetEpoch);
      if (target.ack) {
        if (
          target.ack.deletionId !== deletion.deletionId ||
          target.ack.objectOutcome !== deletion.object ||
          target.ack.backupOutcome !== deletion.backup
        )
          throw { code: "ack_identity_mismatch" };
        continue;
      }
      const response = await input.transport.call({
        protocolVersion: 1,
        operation: "archive.ackDeletion",
        spaceId: input.config.spaceId,
        sourceAccountId: input.config.sourceAccountId,
        requestId: deletion.deletionId,
        sourceItemId: input.sourceItemId,
        expectedForgetEpoch: input.forgetEpoch,
        deletionId: deletion.deletionId,
        receiptId: target.receiptId,
        objectOutcome: deletion.object,
        ...(deletion.backup === undefined
          ? {}
          : { backupOutcome: deletion.backup }),
      });
      if (isWorkerError(response)) throw { code: response.error.code };
      const ack = response as AckResult;
      if (
        ack.operation !== "archive.ackDeletion" ||
        ack.deletionId !== deletion.deletionId ||
        ack.receiptId !== target.receiptId ||
        ack.forgetEpoch !== input.forgetEpoch ||
        ack.objectOutcome !== deletion.object ||
        ack.backupOutcome !== deletion.backup ||
        ack.absenceAuthority !== "worker_asserted_physical_absence"
      )
        throw { code: "ack_identity_mismatch" };
    }
    const final = await enumerateTargets(input);
    if (
      final.sourceExternalIdHash !== first.sourceExternalIdHash ||
      final.targets.length !== first.targets.length
    )
      throw { code: "receipt_set_changed" };
    reconcileTargets(
      rows.map((selected) => currentRow(input.catalog, selected)),
      final.targets,
    );
    const finalById = new Map(
      final.targets.map((target) => [target.receiptId, target]),
    );
    for (const target of first.targets) {
      const after = finalById.get(target.receiptId);
      if (!after?.ack) throw { code: "ack_not_observed" };
      const matched = matches.get(target.receiptId)!;
      const current = currentRow(input.catalog, matched);
      const deletion = completeDeletion(
        current.row.copies[target.copyRole],
        input.forgetEpoch,
      );
      if (
        after.ack.deletionId !== deletion.deletionId ||
        after.ack.objectOutcome !== deletion.object ||
        after.ack.backupOutcome !== deletion.backup
      )
        throw { code: "ack_identity_mismatch" };
    }
    return {
      state: "owner_finalization_required",
      sourceItemId: input.sourceItemId,
      forgetEpoch: input.forgetEpoch,
      receiptCount: first.targets.length,
      acknowledgedCount: final.targets.filter((target) => target.ack).length,
      localCopyCount,
      nextAction: "run_authenticated_owner_continue_forget",
    };
  } catch (error) {
    return operationalFailure(error);
  }
}
