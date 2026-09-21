import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import {
  BINARY_CLASSES,
  type ArchivedWorkIdentity,
} from "@repo/worker-protocol";
import type { TriagePreviewDeclaration } from "@repo/worker-protocol/request";

import {
  journalBindingForConfig,
  loadPipelineConfig,
  requireCredential,
} from "./config.js";
import { validRelativePath } from "./dropboxOriginal.js";
import { canonicalRoots, resolvePreviewSource } from "./filesystem.js";
import {
  Journal,
  JournalCredentialChangedError,
  JournalLockedError,
  JournalSafetyError,
} from "./journal.js";
import type { JsonValue } from "./journalTypes.js";
import {
  createParserProfileWorkDirectory,
  removeParserProfileWorkDirectoryExact,
  runDocumentPreview,
  type DocumentPreviewResult,
  type PreviewWindow,
} from "./parserProcess.js";
import { initialCheckpoint, journalCodec } from "./runner.js";
import type { PdfFilePlan, RunnerCheckpoint } from "./runnerState.js";
import { HttpWorkerTransport } from "./transport.js";
import type { PipelineConfig, WorkerTransport } from "./types.js";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_TARGETS = 8;
const ROOT_ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type PreviewTarget = {
  rootAlias: string;
  relativePath: string;
  revisionHash: string;
  windows?: PreviewWindow[];
};

export type PreviewManifest = {
  version: 1;
  targets: PreviewTarget[];
};

export type PreviewSelectedResult =
  | {
      state: "previewed";
      manifestSha256: string;
      selectedCount: number;
      recordedCount: number;
      reusedCount: number;
    }
  | {
      state: "refused";
      code:
        | "manifest_invalid"
        | "journal_contended"
        | "credential_recovery_required"
        | "journal_unsafe"
        | "phase_unsafe"
        | "pending_unsafe"
        | "target_missing_or_stale"
        | "target_not_revision_bound"
        | "source_changed"
        | "server_refused"
        | "preview_failed";
      manifestSha256?: string;
      recordedCount?: number;
    };

class PreviewRefusal extends Error {
  constructor(
    readonly code: Extract<PreviewSelectedResult, { state: "refused" }>["code"],
    readonly recordedCount = 0,
  ) {
    super(code);
  }
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PreviewRefusal("manifest_invalid");
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((field) => !(field in record)) ||
    Object.keys(record).some((field) => !allowed.has(field))
  )
    throw new PreviewRefusal("manifest_invalid");
  return record;
}

function previewWindows(value: unknown): PreviewWindow[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4)
    throw new PreviewRefusal("manifest_invalid");
  let units = 0;
  let last = 0;
  return value.map((entry) => {
    const window = exactObject(entry, ["startPage", "pageCount"]);
    if (
      !Number.isSafeInteger(window.startPage) ||
      !Number.isSafeInteger(window.pageCount) ||
      (window.startPage as number) < 1 ||
      (window.pageCount as number) < 1 ||
      (window.pageCount as number) > 8 ||
      (window.startPage as number) <= last
    )
      throw new PreviewRefusal("manifest_invalid");
    units += window.pageCount as number;
    if (units > 8) throw new PreviewRefusal("manifest_invalid");
    last = (window.startPage as number) + (window.pageCount as number) - 1;
    return {
      startPage: window.startPage as number,
      pageCount: window.pageCount as number,
    };
  });
}

export function parsePreviewManifest(value: unknown): PreviewManifest {
  const manifest = exactObject(value, ["version", "targets"]);
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.targets) ||
    manifest.targets.length < 1 ||
    manifest.targets.length > MAX_TARGETS
  )
    throw new PreviewRefusal("manifest_invalid");
  const seen = new Set<string>();
  const targets = manifest.targets.map((value) => {
    const target = exactObject(
      value,
      ["rootAlias", "relativePath", "revisionHash"],
      ["windows"],
    );
    if (
      typeof target.rootAlias !== "string" ||
      !ROOT_ALIAS.test(target.rootAlias) ||
      typeof target.relativePath !== "string" ||
      Buffer.byteLength(target.relativePath, "utf8") > 2_048 ||
      !validRelativePath(target.relativePath) ||
      typeof target.revisionHash !== "string" ||
      !SHA256.test(target.revisionHash)
    )
      throw new PreviewRefusal("manifest_invalid");
    const key = `${target.rootAlias}\0${target.relativePath}`;
    if (seen.has(key)) throw new PreviewRefusal("manifest_invalid");
    seen.add(key);
    return {
      rootAlias: target.rootAlias,
      relativePath: target.relativePath,
      revisionHash: target.revisionHash,
      ...(target.windows === undefined
        ? {}
        : { windows: previewWindows(target.windows) }),
    };
  });
  return { version: 1, targets };
}

export async function loadPreviewManifest(path: string): Promise<{
  manifest: PreviewManifest;
  manifestSha256: string;
}> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const entry = await handle.stat();
    if (
      !entry.isFile() ||
      (entry.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && entry.uid !== process.getuid())
    )
      throw new PreviewRefusal("manifest_invalid");
    const bytes = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > MAX_MANIFEST_BYTES)
      throw new PreviewRefusal("manifest_invalid");
    const exact = bytes.subarray(0, offset);
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(exact);
    } catch {
      throw new PreviewRefusal("manifest_invalid");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw new PreviewRefusal("manifest_invalid");
    }
    return {
      manifest: parsePreviewManifest(parsed),
      manifestSha256: createHash("sha256").update(exact).digest("hex"),
    };
  } catch (error) {
    if (error instanceof PreviewRefusal) throw error;
    throw new PreviewRefusal("manifest_invalid");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function key(value: { rootAlias: string; relativePath: string }): string {
  return `${value.rootAlias}\0${value.relativePath}`;
}

function identity(
  checkpoint: Extract<RunnerCheckpoint, { phase: "archived" }>,
  plan: PdfFilePlan,
): ArchivedWorkIdentity {
  if (
    plan.sourceItemId === undefined ||
    plan.observationEpoch === undefined ||
    plan.processingEpoch === undefined
  )
    throw new PreviewRefusal("target_not_revision_bound");
  return {
    sourceItemId: plan.sourceItemId,
    scanId: checkpoint.scanId,
    observationEpoch: plan.observationEpoch,
    processingEpoch: plan.processingEpoch,
    contentHash: plan.sha256,
    byteLength: plan.byteLength,
    mediaType: BINARY_CLASSES[plan.parserProfileId].mediaType,
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

function declaration(preview: DocumentPreviewResult): TriagePreviewDeclaration {
  const uncertaintyCodes: Array<"image_only" | "insufficient_text"> = [];
  if (preview.unitStates.includes("image_only"))
    uncertaintyCodes.push("image_only");
  if (
    preview.unitStates.length > 0 &&
    (!preview.unitStates.includes("text_available") ||
      preview.unitStates.includes("unknown"))
  )
    uncertaintyCodes.push("insufficient_text");
  return {
    previewFingerprint: preview.methodFingerprint,
    previewMethod: preview.method,
    sourceFormat:
      preview.mediaType === "application/pdf" ? "pdf" : "spreadsheet",
    sourceUnitCount: preview.sourceUnitCount,
    inspectedOriginalUnits: preview.inspectedOriginalUnits,
    provisionalMetadata: {
      ...(preview.mediaType === "application/pdf"
        ? {}
        : { documentKind: "spreadsheet" as const }),
      ...(uncertaintyCodes.length === 0 ? {} : { uncertaintyCodes }),
    },
    confidence: null,
  };
}

function stableRequestId(identityValue: ArchivedWorkIdentity, preview: TriagePreviewDeclaration): string {
  const bytes = createHash("sha256")
    .update("kithmind-selected-preview-request:v1\0")
    .update(JSON.stringify([identityValue, preview]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function previewSelectedJournal(args: {
  journal: Journal<RunnerCheckpoint, JsonValue>;
  config: PipelineConfig;
  manifest: PreviewManifest;
  manifestSha256: string;
  transport: WorkerTransport;
  executePreview: (
    plan: PdfFilePlan,
    windows: PreviewWindow[],
  ) => Promise<DocumentPreviewResult>;
}): Promise<Extract<PreviewSelectedResult, { state: "previewed" }>> {
  if (args.journal.pending !== undefined)
    throw new PreviewRefusal("pending_unsafe");
  const checkpoint = args.journal.checkpoint;
  if (checkpoint.phase !== "archived")
    throw new PreviewRefusal("phase_unsafe");
  const checkpointBytes = JSON.stringify(checkpoint);
  const suffix = checkpoint.files.slice(checkpoint.pdfIndex + 1);
  const available = new Map(suffix.map((plan) => [key(plan), plan]));
  const selected = args.manifest.targets.map((target) => {
    const plan = available.get(key(target));
    if (
      !plan ||
      !("kind" in plan) ||
      plan.kind !== "pdf" ||
      plan.sha256 !== target.revisionHash
    )
      throw new PreviewRefusal("target_missing_or_stale");
    const mediaType = BINARY_CLASSES[plan.parserProfileId].mediaType;
    if (
      (mediaType === "application/pdf" && target.windows === undefined) ||
      (mediaType !== "application/pdf" && target.windows !== undefined)
    )
      throw new PreviewRefusal("manifest_invalid");
    identity(checkpoint, plan);
    return { plan, windows: target.windows ?? [] };
  });
  let recordedCount = 0;
  let reusedCount = 0;
  for (const { plan, windows } of selected) {
    let preview: DocumentPreviewResult;
    try {
      preview = await args.executePreview(plan, windows);
    } catch {
      throw new PreviewRefusal("preview_failed", recordedCount);
    }
    if (
      preview.sourceSha256 !== plan.sha256 ||
      preview.mediaType !== BINARY_CLASSES[plan.parserProfileId].mediaType
    )
      throw new PreviewRefusal("source_changed", recordedCount);
    const archivedIdentity = identity(checkpoint, plan);
    const triage = declaration(preview);
    let response;
    try {
      response = await args.transport.call({
        protocolVersion: 1,
        operation: "discovery.recordPreview",
        spaceId: args.config.spaceId,
        sourceAccountId: args.config.sourceAccountId,
        requestId: stableRequestId(archivedIdentity, triage),
        identity: archivedIdentity,
        preview: triage,
      });
    } catch {
      throw new PreviewRefusal("server_refused", recordedCount);
    }
    if (
      "error" in response ||
      response.operation !== "discovery.recordPreview" ||
      response.sourceItemId !== plan.sourceItemId ||
      response.observedContentHash !== plan.sha256 ||
      response.previewFingerprint !== triage.previewFingerprint ||
      (response.state !== "provisional" && response.state !== "retained") ||
      typeof response.reused !== "boolean"
    )
      throw new PreviewRefusal("server_refused", recordedCount);
    recordedCount += 1;
    if (response.reused) reusedCount += 1;
  }
  if (
    args.journal.pending !== undefined ||
    JSON.stringify(args.journal.checkpoint) !== checkpointBytes
  )
    throw new PreviewRefusal("phase_unsafe", recordedCount);
  return {
    state: "previewed",
    manifestSha256: args.manifestSha256,
    selectedCount: selected.length,
    recordedCount,
    reusedCount,
  };
}

async function productionExecutor(config: PipelineConfig) {
  const pdf = config.pdfDocQa;
  if (pdf === undefined) throw new PreviewRefusal("preview_failed");
  const roots = await canonicalRoots(config);
  const byAlias = new Map(roots.map((root) => [root.alias, root]));
  return async (plan: PdfFilePlan, windows: PreviewWindow[]) => {
    const root = byAlias.get(plan.rootAlias);
    if (!root) throw new PreviewRefusal("source_changed");
    const sourcePath = await resolvePreviewSource({
      root,
      relativePath: plan.relativePath,
      expectedByteLength: plan.byteLength,
      expectedModifiedAt: plan.sourceModifiedAt,
    });
    const work = await createParserProfileWorkDirectory({
      workRoot: pdf.parserOutputRoot,
      workId: randomUUID(),
    });
    try {
      return await runDocumentPreview({
        sourcePath,
        expectedSha256: plan.sha256,
        mediaType: BINARY_CLASSES[plan.parserProfileId].mediaType,
        windows,
        pythonExecutable: pdf.parser.pythonExecutable,
        expectedPythonSha256: pdf.parser.expectedPythonSha256,
        launcherPath: pdf.parser.launcherPath,
        expectedLauncherSha256: pdf.parser.expectedLauncherSha256,
        packageRoot: pdf.parser.packageRoot,
        work,
        workRoot: pdf.parserOutputRoot,
      });
    } finally {
      await removeParserProfileWorkDirectoryExact({
        workRoot: pdf.parserOutputRoot,
        intent: work,
      });
    }
  };
}

export async function previewSelectedFromPaths(
  configPath: string,
  manifestPath: string,
): Promise<PreviewSelectedResult> {
  let manifestSha256: string | undefined;
  let recordedCount = 0;
  try {
    const loaded = await loadPreviewManifest(manifestPath);
    manifestSha256 = loaded.manifestSha256;
    const config = await loadPipelineConfig(configPath);
    const credential = requireCredential(config);
    const journal = await Journal.open({
      directory: config.journalDir,
      binding: journalBindingForConfig(config),
      credential,
      initialCheckpoint,
      codec: journalCodec,
    });
    try {
      const result = await previewSelectedJournal({
        journal,
        config,
        manifest: loaded.manifest,
        manifestSha256,
        transport: new HttpWorkerTransport(config, credential),
        executePreview: await productionExecutor(config),
      });
      recordedCount = result.recordedCount;
      return result;
    } finally {
      await journal.close();
    }
  } catch (error) {
    const code =
      error instanceof PreviewRefusal
        ? error.code
        : error instanceof JournalLockedError
          ? "journal_contended"
          : error instanceof JournalCredentialChangedError
            ? "credential_recovery_required"
            : error instanceof JournalSafetyError
              ? "journal_unsafe"
              : "preview_failed";
    if (error instanceof PreviewRefusal) recordedCount = error.recordedCount;
    return {
      state: "refused",
      code,
      ...(manifestSha256 === undefined ? {} : { manifestSha256 }),
      ...(recordedCount === 0 ? {} : { recordedCount }),
    };
  }
}
