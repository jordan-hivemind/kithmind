import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { validRelativePath } from "./dropboxOriginal.js";
import {
  Journal,
  JournalCredentialChangedError,
  JournalLockedError,
  JournalSafetyError,
} from "./journal.js";
import type { JsonValue } from "./journalTypes.js";
import { initialCheckpoint, journalCodec, PipelineRunner } from "./runner.js";
import type { FilePlan, RunnerCheckpoint } from "./runnerState.js";
import {
  journalBindingForConfig,
  loadPipelineConfig,
  requireCredential,
} from "./config.js";
import { HttpWorkerTransport } from "./transport.js";

const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_TARGETS = 1_024;
const ROOT_ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REVISION_HASH = /^[a-f0-9]{64}$/;
const REASONS = new Set([
  "active_goal",
  "code_acceptance",
  "explicit_user_request",
]);

export type PriorityTarget = {
  rootAlias: string;
  relativePath: string;
  revisionHash: string;
};

export type PriorityManifest = {
  version: 1;
  reason: "active_goal" | "code_acceptance" | "explicit_user_request";
  targets: PriorityTarget[];
};

export type ReprioritizeResult =
  | {
      state: "reprioritized";
      manifestSha256: string;
      selectedCount: number;
      remainingEntryCount: number;
      prefixEntryCount: number;
      totalEntryCount: number;
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
        | "priority_failed";
      manifestSha256?: string;
    };

export class PriorityRefusal extends Error {
  constructor(
    readonly code: Extract<ReprioritizeResult, { state: "refused" }>["code"],
  ) {
    super(code);
  }
}

function exactObject(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PriorityRefusal("manifest_invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    fields.some((field) => !(field in record)) ||
    Object.keys(record).some((field) => !fields.includes(field))
  ) {
    throw new PriorityRefusal("manifest_invalid");
  }
  return record;
}

export function parsePriorityManifest(value: unknown): PriorityManifest {
  const manifest = exactObject(value, ["version", "reason", "targets"]);
  if (
    manifest.version !== 1 ||
    typeof manifest.reason !== "string" ||
    !REASONS.has(manifest.reason) ||
    !Array.isArray(manifest.targets) ||
    manifest.targets.length === 0 ||
    manifest.targets.length > MAX_TARGETS
  ) {
    throw new PriorityRefusal("manifest_invalid");
  }
  const seen = new Set<string>();
  const targets = manifest.targets.map((value) => {
    const target = exactObject(value, [
      "rootAlias",
      "relativePath",
      "revisionHash",
    ]);
    if (
      typeof target.rootAlias !== "string" ||
      !ROOT_ALIAS.test(target.rootAlias) ||
      typeof target.relativePath !== "string" ||
      Buffer.byteLength(target.relativePath, "utf8") > 2_048 ||
      !validRelativePath(target.relativePath) ||
      typeof target.revisionHash !== "string" ||
      !REVISION_HASH.test(target.revisionHash)
    ) {
      throw new PriorityRefusal("manifest_invalid");
    }
    const key = `${target.rootAlias}\0${target.relativePath}`;
    if (seen.has(key)) throw new PriorityRefusal("manifest_invalid");
    seen.add(key);
    return {
      rootAlias: target.rootAlias,
      relativePath: target.relativePath,
      revisionHash: target.revisionHash,
    };
  });
  return {
    version: 1,
    reason: manifest.reason as PriorityManifest["reason"],
    targets,
  };
}

export async function loadPriorityManifest(path: string): Promise<{
  manifest: PriorityManifest;
  manifestSha256: string;
}> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const entry = await handle.stat();
    if (!entry.isFile() || (entry.mode & 0o077) !== 0) {
      throw new PriorityRefusal("manifest_invalid");
    }
    if (
      typeof process.getuid === "function" &&
      entry.uid !== process.getuid()
    ) {
      throw new PriorityRefusal("manifest_invalid");
    }
    const bytes = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_MANIFEST_BYTES) {
      throw new PriorityRefusal("manifest_invalid");
    }
    const exact = bytes.subarray(0, offset);
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(exact);
    } catch {
      throw new PriorityRefusal("manifest_invalid");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw new PriorityRefusal("manifest_invalid");
    }
    return {
      manifest: parsePriorityManifest(parsed),
      manifestSha256: createHash("sha256").update(exact).digest("hex"),
    };
  } catch (error) {
    if (error instanceof PriorityRefusal) throw error;
    throw new PriorityRefusal("manifest_invalid");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function planKey(value: { rootAlias: string; relativePath: string }): string {
  return `${value.rootAlias}\0${value.relativePath}`;
}

function priorityFiles(
  checkpoint: Extract<RunnerCheckpoint, { phase: "archived" }>,
  manifest: PriorityManifest,
): FilePlan[] {
  const suffix = checkpoint.files.slice(checkpoint.pdfIndex + 1);
  const byKey = new Map(suffix.map((plan) => [planKey(plan), plan]));
  const selected = new Set<string>();
  for (const target of manifest.targets) {
    const key = planKey(target);
    const plan = byKey.get(key);
    if (
      !plan ||
      !("kind" in plan) ||
      plan.kind !== "pdf" ||
      plan.sha256 !== target.revisionHash
    ) {
      throw new PriorityRefusal("target_missing_or_stale");
    }
    if (
      plan.externalId === undefined ||
      plan.sourceItemId === undefined ||
      plan.observationEpoch === undefined ||
      plan.processingEpoch === undefined
    ) {
      throw new PriorityRefusal("target_not_revision_bound");
    }
    selected.add(key);
  }
  return [
    ...checkpoint.files.slice(0, checkpoint.pdfIndex + 1),
    ...suffix.filter((plan) => selected.has(planKey(plan))),
    ...suffix.filter((plan) => !selected.has(planKey(plan))),
  ];
}

function archivedCheckpoint(
  checkpoint: RunnerCheckpoint,
): Extract<RunnerCheckpoint, { phase: "archived" }> {
  if (checkpoint.phase !== "archived") {
    throw new PriorityRefusal("phase_unsafe");
  }
  return checkpoint;
}

export async function reprioritizeJournal(args: {
  journal: Journal<RunnerCheckpoint, JsonValue>;
  manifest: PriorityManifest;
  manifestSha256: string;
  settleAnsweredArchivedRequest: () => Promise<void>;
}): Promise<Extract<ReprioritizeResult, { state: "reprioritized" }>> {
  const before = archivedCheckpoint(args.journal.checkpoint);
  priorityFiles(before, args.manifest);
  const pending = args.journal.pending;
  if (pending !== undefined) {
    if (pending.result === undefined) {
      throw new PriorityRefusal("pending_unsafe");
    }
    await args.settleAnsweredArchivedRequest();
  }
  if (args.journal.pending !== undefined) {
    throw new PriorityRefusal("pending_unsafe");
  }
  const current = archivedCheckpoint(args.journal.checkpoint);
  if (
    current.pdfIndex !== before.pdfIndex ||
    JSON.stringify(current.files.slice(0, current.pdfIndex + 1)) !==
      JSON.stringify(before.files.slice(0, before.pdfIndex + 1))
  ) {
    throw new PriorityRefusal("phase_unsafe");
  }
  const files = priorityFiles(current, args.manifest);
  const selectedIdentities = files
    .slice(
      current.pdfIndex + 1,
      current.pdfIndex + 1 + args.manifest.targets.length,
    )
    .map((plan) => {
      if (
        !("kind" in plan) ||
        plan.kind !== "pdf" ||
        plan.sourceItemId === undefined
      ) {
        throw new PriorityRefusal("target_not_revision_bound");
      }
      return { sourceItemId: plan.sourceItemId, sha256: plan.sha256 };
    })
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(`${left.sourceItemId}\0${left.sha256}`),
        Buffer.from(`${right.sourceItemId}\0${right.sha256}`),
      ),
    );
  const priorityReceipt = {
    version: 1 as const,
    manifestSha256: args.manifestSha256,
    reason: args.manifest.reason,
    selectedCount: selectedIdentities.length,
    selectedIdentitySha256: createHash("sha256")
      .update(JSON.stringify(selectedIdentities))
      .digest("hex"),
  };
  await args.journal.transitionCheckpoint({
    checkpoint: { ...current, files, priorityReceipt },
    credentialSessionActive: true,
  });
  return {
    state: "reprioritized",
    manifestSha256: args.manifestSha256,
    selectedCount: args.manifest.targets.length,
    remainingEntryCount:
      files.length - current.pdfIndex - 1 - args.manifest.targets.length,
    prefixEntryCount: current.pdfIndex,
    totalEntryCount: files.length,
  };
}

export async function reprioritizeFromPaths(
  configPath: string,
  manifestPath: string,
): Promise<ReprioritizeResult> {
  let manifestSha256: string | undefined;
  try {
    const loaded = await loadPriorityManifest(manifestPath);
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
      const runner = new PipelineRunner(
        config,
        journal,
        new HttpWorkerTransport(config, credential),
      );
      return await reprioritizeJournal({
        journal,
        manifest: loaded.manifest,
        manifestSha256,
        settleAnsweredArchivedRequest: () =>
          runner.settleAnsweredArchivedRequest(),
      });
    } finally {
      await journal.close();
    }
  } catch (error) {
    const code =
      error instanceof PriorityRefusal
        ? error.code
        : error instanceof JournalLockedError
          ? "journal_contended"
          : error instanceof JournalCredentialChangedError
            ? "credential_recovery_required"
            : error instanceof JournalSafetyError
              ? "journal_unsafe"
              : "priority_failed";
    return {
      state: "refused",
      code,
      ...(manifestSha256 === undefined ? {} : { manifestSha256 }),
    };
  }
}
