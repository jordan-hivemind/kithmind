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
import { providerOriginalReferenceFingerprint } from "./archivedRequestMapping.js";
import { removeProviderBindingExact } from "./providerRegistry.js";
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
  absenceAuthority:
    | "worker_asserted_physical_absence"
    | "worker_asserted_live_repository_absence";
  retentionDisclosure?: "provider_retained_deleted_history_possible";
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

type ProviderAck = {
  detachId: string;
  referenceId: string;
  forgetEpoch: number;
  referenceOutcome: "detached" | "already_detached";
  locatorBundleOutcome: "deleted" | "already_missing";
  locatorAbsenceAuthority: "worker_asserted_live_repository_absence";
  retentionDisclosure: "provider_retained_deleted_history_possible";
  providerSourceOutcome: "retained_unchanged";
  completedAt: number;
};

type ProviderTarget = {
  referenceId: string;
  referenceFingerprint: string;
  locatorBindingId: string;
  locatorRepositoryId: string;
  locatorSnapshotId: string;
  locatorObjectName: string;
  locatorCiphertextHash: string;
  locatorCiphertextByteLength: number;
  forgetEpoch: number;
  ack?: ProviderAck;
};

type ProviderForgetPage = {
  operation: "providerOriginal.forgetTargets";
  sourceItemId: string;
  sourceExternalIdHash: string;
  forgetEpoch: number;
  targets: ProviderTarget[];
  isDone: boolean;
  continueCursor: string;
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
      providerReferenceCount?: number;
      providerOriginalOutcome?: "provider_original_reference_detached_source_retained";
      retainedProviderHistoryPossible?: true;
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
  removeProviderBinding: typeof removeProviderBindingExact;
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
  removeProviderBinding: removeProviderBindingExact,
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
    code === "parser_intent_changed" ||
    code === "provider_locator_incomplete" ||
    code === "provider_locator_configuration_missing" ||
    code === "provider_target_identity_mismatch" ||
    code === "provider_ack_identity_mismatch" ||
    code === "provider_reference_set_mismatch" ||
    code === "provider_reference_set_changed" ||
    code === "provider_ack_not_observed" ||
    code === "provider_forget_authority_missing"
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

async function enumerateProviderTargets(input: {
  config: PipelineConfig;
  transport: WorkerTransport;
  sourceItemId: string;
  forgetEpoch: number;
}): Promise<{ sourceExternalIdHash: string; targets: ProviderTarget[] }> {
  let cursor: string | null = null;
  let sourceExternalIdHash: string | undefined;
  const seenCursors = new Set<string>();
  const seenReferences = new Set<string>();
  const targets: ProviderTarget[] = [];
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const response = await input.transport.call({
      protocolVersion: 1,
      operation: "providerOriginal.forgetTargets",
      spaceId: input.config.spaceId,
      sourceAccountId: input.config.sourceAccountId,
      requestId: randomUUID(),
      sourceItemId: input.sourceItemId,
      expectedForgetEpoch: input.forgetEpoch,
      paginationOpts: { cursor, numItems: 4 },
    });
    if (isWorkerError(response)) throw { code: response.error.code };
    const page = response as ProviderForgetPage;
    if (
      page.operation !== "providerOriginal.forgetTargets" ||
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
      if (seenReferences.has(target.referenceId))
        throw { code: "duplicate_provider_reference" };
      seenReferences.add(target.referenceId);
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

async function validateProviderForgetAuthority(input: {
  config: PipelineConfig;
  transport: WorkerTransport;
  sourceItemId: string;
  forgetEpoch: number;
  sourceExternalIdHash: string;
}): Promise<void> {
  const page = await enumerateProviderTargets({ ...input });
  if (page.sourceExternalIdHash !== input.sourceExternalIdHash)
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
    (selected.subject === "original_bytes" && selected.row.providerOriginal
      ? (["primary"] as const)
      : (["primary", "independent_backup"] as const)
    ).map((role) => ({
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

function providerDeclarationForForget(row: OriginalCatalogRow) {
  const provider = row.providerOriginal;
  const verified = provider?.verified;
  const locator = provider?.locator;
  if (
    !provider ||
    !verified ||
    !locator?.published ||
    !locator.backup ||
    locator.readbackVerifiedAt === undefined
  )
    throw { code: "provider_locator_incomplete" };
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
    createdAt: row.createdAt,
  };
}

function reconcileProviderTargets(
  rows: SelectedRow[],
  targets: ProviderTarget[],
) {
  const originals = rows.filter(
    (
      selected,
    ): selected is { subject: "original_bytes"; row: OriginalCatalogRow } =>
      selected.subject === "original_bytes" &&
      selected.row.providerOriginal !== undefined,
  );
  const matched = new Map<string, OriginalCatalogRow>();
  for (const target of targets) {
    const candidates = originals.filter(({ row }) => {
      const cloud = row.cloud;
      if (
        !cloud ||
        !("providerReferenceId" in cloud) ||
        cloud.providerReferenceId !== target.referenceId
      )
        return false;
      const declaration = providerDeclarationForForget(row);
      return (
        providerOriginalReferenceFingerprint(declaration) ===
          target.referenceFingerprint &&
        declaration.locatorBundle.bindingId === target.locatorBindingId &&
        declaration.locatorBundle.repositoryId === target.locatorRepositoryId &&
        declaration.locatorBundle.snapshotId === target.locatorSnapshotId &&
        declaration.locatorBundle.objectName === target.locatorObjectName &&
        declaration.locatorBundle.ciphertextHash ===
          target.locatorCiphertextHash &&
        declaration.locatorBundle.ciphertextByteLength ===
          target.locatorCiphertextByteLength
      );
    });
    if (candidates.length !== 1)
      throw { code: "provider_target_identity_mismatch" };
    matched.set(target.referenceId, candidates[0]!.row);
    const deletion = candidates[0]!.row.providerOriginal!.locator.deletion;
    if (
      target.ack &&
      (!deletion ||
        deletion.state !== "complete" ||
        deletion.reason !== "forget" ||
        deletion.forgetEpoch !== target.forgetEpoch ||
        deletion.deletionId !== target.ack.detachId ||
        deletion.backup !== target.ack.locatorBundleOutcome)
    )
      throw { code: "provider_ack_identity_mismatch" };
  }
  for (const { row } of originals) {
    if (
      row.cloud &&
      "providerReferenceId" in row.cloud &&
      !targets.some(
        (target) => target.referenceId === row.cloud!.providerReferenceId,
      )
    )
      throw { code: "provider_reference_set_mismatch" };
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
    const roles =
      selected.subject === "original_bytes" && selected.row.providerOriginal
        ? (["primary"] as const)
        : (["primary", "independent_backup"] as const);
    for (const role of roles) {
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
    const configuredBackup = input.config.archive.independentBackup;
    if (
      "repository" in configuredBackup &&
      selected.subject !== "parser_output"
    )
      throw { code: "archive_remote_original_unsupported" };
    const result = await input.commands.forgetBackup({
      resticBinary: configuredBackup.resticBinary,
      ...("repository" in configuredBackup
        ? { repository: configuredBackup.repository! }
        : { repositoryPath: configuredBackup.repositoryPath }),
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

async function deleteProviderLocator(input: {
  pdf: PdfDocQaConfig;
  catalog: ArchiveCatalog;
  row: OriginalCatalogRow;
  target: ProviderTarget;
  forgetEpoch: number;
  commands: ArchiveForgetCommands;
  now: () => number;
  authorize: () => Promise<void>;
}): Promise<{
  row: OriginalCatalogRow;
  deletion: Extract<ArchiveCopyRecord["deletion"], { state: "complete" }>;
}> {
  const providerConfig = input.pdf.providerOriginal;
  if (
    !input.row.providerOriginal ||
    !providerConfig ||
    !("repository" in input.pdf.archive.independentBackup)
  )
    throw { code: "provider_locator_configuration_missing" };
  let row = input.catalog
    .listOriginals()
    .find((value) => value.originalCatalogId === input.row.originalCatalogId);
  if (!row?.providerOriginal) throw { code: "catalog_not_found" };
  let copy = row.providerOriginal.locator;
  if (
    copy.reviewCode ||
    !copy.prepared ||
    !copy.published ||
    !copy.backup ||
    !copy.restic
  )
    throw { code: "provider_locator_incomplete" };
  if (
    copy.deletion &&
    (copy.deletion.reason !== "forget" ||
      copy.deletion.forgetEpoch !== input.forgetEpoch)
  )
    throw { code: "deletion_identity_conflict" };
  if (!copy.deletion) {
    row = await input.catalog.updateProviderLocator({
      catalogId: row.originalCatalogId,
      expectedRevision: row.rowRevision,
      update: (value) => {
        value.deletion = {
          state: "pending",
          deletionId: randomUUID(),
          reason: "forget",
          plannedAt: input.now(),
          forgetEpoch: input.forgetEpoch,
        };
      },
    });
    copy = row.providerOriginal!.locator;
  }
  if (copy.deletion?.state !== "complete") {
    const restic = copy.restic;
    const prepared = copy.prepared;
    const published = copy.published;
    if (!restic || !prepared || !published)
      throw { code: "provider_locator_incomplete" };
    await input.authorize();
    const backup = await input.commands.forgetBackup({
      resticBinary: input.pdf.archive.independentBackup.resticBinary,
      repository: input.pdf.archive.independentBackup.repository!,
      expectedRepositoryId: input.target.locatorRepositoryId,
      passwordCommand: input.pdf.archive.independentBackup.passwordCommand,
      operationId: restic.operationId,
      host: restic.host,
      snapshotId: input.target.locatorSnapshotId,
      objectName: input.target.locatorObjectName,
      expectedCiphertext: {
        sha256: input.target.locatorCiphertextHash,
        byteLength: input.target.locatorCiphertextByteLength,
      },
    });
    await input.authorize();
    const object = await input.commands.removeAge({
      objectPath: join(
        input.pdf.archive.independentBackup.directory,
        copy.objectName,
      ),
      expectedDirectory: {
        device: prepared.archiveDirectoryDevice,
        inode: prepared.archiveDirectoryInode,
      },
      expectedFile: {
        device: published.ciphertextDevice,
        inode: published.ciphertextInode,
        sha256: published.ciphertext.sha256,
        byteLength: published.ciphertext.byteLength,
      },
    });
    const deletion = copy.deletion!;
    row = await input.catalog.updateProviderLocator({
      catalogId: row.originalCatalogId,
      expectedRevision: row.rowRevision,
      update: (value) => {
        value.deletion = {
          ...deletion,
          state: "complete",
          completedAt: input.now(),
          object: object.outcome,
          backup: backup.outcome,
        };
      },
    });
    copy = row.providerOriginal!.locator;
  }
  const deletion = copy.deletion;
  if (deletion?.state !== "complete" || deletion.backup === undefined)
    throw { code: "local_deletion_incomplete" };
  await input.authorize();
  await input.commands.removeProviderBinding({
    registryDirectory: providerConfig.registryDirectory,
    bindingId: input.target.locatorBindingId,
    manifestFingerprint: row.providerOriginal!.verified!.manifestFingerprint,
    manifestByteLength: row.providerOriginal!.verified!.manifestByteLength,
  });
  return { row, deletion };
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
    const hasProviderOriginal = rows.some(
      (selected) =>
        selected.subject === "original_bytes" &&
        selected.row.providerOriginal !== undefined,
    );
    const providerFirst = hasProviderOriginal
      ? await enumerateProviderTargets(input)
      : undefined;
    if (
      providerFirst &&
      providerFirst.sourceExternalIdHash !== first.sourceExternalIdHash
    )
      throw { code: "source_identity_conflict" };
    preflightCopies(rows, input.forgetEpoch);
    await preflightPlaintext({
      pdf: input.config.pdfDocQa,
      rows,
      commands,
    });
    const matches = reconcileTargets(rows, first.targets);
    const providerMatches = providerFirst
      ? reconcileProviderTargets(rows, providerFirst.targets)
      : new Map<string, OriginalCatalogRow>();
    const authorize = async () =>
      await validateForgetAuthority({
        config: input.config,
        transport: input.transport,
        sourceItemId: input.sourceItemId,
        forgetEpoch: input.forgetEpoch,
        sourceExternalIdHash: first.sourceExternalIdHash,
      });
    const authorizeProvider = async () => {
      if (!providerFirst) throw { code: "provider_forget_authority_missing" };
      await validateProviderForgetAuthority({
        config: input.config,
        transport: input.transport,
        sourceItemId: input.sourceItemId,
        forgetEpoch: input.forgetEpoch,
        sourceExternalIdHash: providerFirst.sourceExternalIdHash,
      });
    };
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
      const roles =
        selected.subject === "original_bytes" && selected.row.providerOriginal
          ? (["primary"] as const)
          : (["primary", "independent_backup"] as const);
      for (const role of roles) {
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
    for (const target of providerFirst?.targets ?? []) {
      const row = providerMatches.get(target.referenceId)!;
      const local = await deleteProviderLocator({
        pdf: input.config.pdfDocQa,
        catalog: input.catalog,
        row,
        target,
        forgetEpoch: input.forgetEpoch,
        commands,
        now,
        authorize: authorizeProvider,
      });
      if (target.ack) {
        if (
          target.ack.detachId !== local.deletion.deletionId ||
          target.ack.locatorBundleOutcome !== local.deletion.backup ||
          target.ack.locatorAbsenceAuthority !==
            "worker_asserted_live_repository_absence" ||
          target.ack.retentionDisclosure !==
            "provider_retained_deleted_history_possible" ||
          target.ack.providerSourceOutcome !== "retained_unchanged"
        )
          throw { code: "provider_ack_identity_mismatch" };
        continue;
      }
      const response = await input.transport.call({
        protocolVersion: 1,
        operation: "providerOriginal.ackDetach",
        spaceId: input.config.spaceId,
        sourceAccountId: input.config.sourceAccountId,
        requestId: local.deletion.deletionId,
        sourceItemId: input.sourceItemId,
        expectedForgetEpoch: input.forgetEpoch,
        detachId: local.deletion.deletionId,
        referenceId: target.referenceId,
        locatorBindingId: target.locatorBindingId,
        locatorRepositoryId: target.locatorRepositoryId,
        locatorSnapshotId: target.locatorSnapshotId,
        locatorObjectName: target.locatorObjectName,
        referenceOutcome: "detached",
        locatorBundleOutcome: local.deletion.backup,
        locatorAbsenceAuthority: "worker_asserted_live_repository_absence",
        retentionDisclosure: "provider_retained_deleted_history_possible",
        providerSourceOutcome: "retained_unchanged",
      });
      if (isWorkerError(response)) throw { code: response.error.code };
      const ack = response as ProviderAck & {
        operation: "providerOriginal.ackDetach";
        reused: boolean;
      };
      if (
        ack.operation !== "providerOriginal.ackDetach" ||
        ack.detachId !== local.deletion.deletionId ||
        ack.referenceId !== target.referenceId ||
        ack.forgetEpoch !== input.forgetEpoch ||
        ack.referenceOutcome !== "detached" ||
        ack.locatorBundleOutcome !== local.deletion.backup ||
        ack.locatorAbsenceAuthority !==
          "worker_asserted_live_repository_absence" ||
        ack.retentionDisclosure !==
          "provider_retained_deleted_history_possible" ||
        ack.providerSourceOutcome !== "retained_unchanged"
      )
        throw { code: "provider_ack_identity_mismatch" };
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
      const liveRepository =
        matched.subject === "parser_output" &&
        matched.role === "independent_backup" &&
        "repository" in input.config.pdfDocQa.archive.independentBackup;
      const expectedAuthority = liveRepository
        ? ("worker_asserted_live_repository_absence" as const)
        : ("worker_asserted_physical_absence" as const);
      const expectedDisclosure = liveRepository
        ? ("provider_retained_deleted_history_possible" as const)
        : undefined;
      if (target.ack) {
        if (
          target.ack.deletionId !== deletion.deletionId ||
          target.ack.objectOutcome !== deletion.object ||
          target.ack.backupOutcome !== deletion.backup ||
          target.ack.absenceAuthority !== expectedAuthority ||
          target.ack.retentionDisclosure !== expectedDisclosure
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
        ...(liveRepository
          ? {
              absenceAuthority: expectedAuthority,
              retentionDisclosure: expectedDisclosure,
            }
          : {}),
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
        ack.absenceAuthority !== expectedAuthority ||
        ack.retentionDisclosure !== expectedDisclosure
      )
        throw { code: "ack_identity_mismatch" };
    }
    const final = await enumerateTargets(input);
    const providerFinal = providerFirst
      ? await enumerateProviderTargets(input)
      : undefined;
    if (
      final.sourceExternalIdHash !== first.sourceExternalIdHash ||
      final.targets.length !== first.targets.length
    )
      throw { code: "receipt_set_changed" };
    reconcileTargets(
      rows.map((selected) => currentRow(input.catalog, selected)),
      final.targets,
    );
    if (providerFinal) {
      if (
        providerFinal.sourceExternalIdHash !==
          providerFirst!.sourceExternalIdHash ||
        providerFinal.targets.length !== providerFirst!.targets.length
      )
        throw { code: "provider_reference_set_changed" };
      reconcileProviderTargets(
        rows.map((selected) => currentRow(input.catalog, selected)),
        providerFinal.targets,
      );
      for (const target of providerFinal.targets)
        if (!target.ack) throw { code: "provider_ack_not_observed" };
    }
    const finalById = new Map(
      final.targets.map((target) => [target.receiptId, target]),
    );
    for (const target of first.targets) {
      const after = finalById.get(target.receiptId);
      if (!after?.ack) throw { code: "ack_not_observed" };
      const matched = matches.get(target.receiptId)!;
      const liveRepository =
        matched.subject === "parser_output" &&
        matched.role === "independent_backup" &&
        "repository" in input.config.pdfDocQa.archive.independentBackup;
      const current = currentRow(input.catalog, matched);
      const deletion = completeDeletion(
        current.row.copies[target.copyRole],
        input.forgetEpoch,
      );
      if (
        after.ack.deletionId !== deletion.deletionId ||
        after.ack.objectOutcome !== deletion.object ||
        after.ack.backupOutcome !== deletion.backup ||
        after.ack.absenceAuthority !==
          (liveRepository
            ? "worker_asserted_live_repository_absence"
            : "worker_asserted_physical_absence") ||
        after.ack.retentionDisclosure !==
          (liveRepository
            ? "provider_retained_deleted_history_possible"
            : undefined)
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
      ...(providerFinal
        ? {
            providerReferenceCount: providerFinal.targets.length,
            providerOriginalOutcome:
              "provider_original_reference_detached_source_retained" as const,
          }
        : {}),
      ...("repository" in input.config.pdfDocQa.archive.independentBackup
        ? { retainedProviderHistoryPossible: true as const }
        : {}),
      nextAction: "run_authenticated_owner_continue_forget",
    };
  } catch (error) {
    return operationalFailure(error);
  }
}
