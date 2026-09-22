import { createHash } from "node:crypto";

import {
  journalBindingForConfig,
  loadPipelineConfig,
  requireCredential,
} from "./config.js";
import {
  Journal,
  JournalCredentialChangedError,
  JournalLockedError,
  JournalSafetyError,
} from "./journal.js";
import type { JsonValue } from "./journalTypes.js";
import {
  loadPriorityManifest,
  PriorityRefusal,
  type PriorityManifest,
} from "./reprioritize.js";
import { initialCheckpoint, journalCodec, PipelineRunner } from "./runner.js";
import type {
  MetadataFirstIdentity,
  PdfFilePlan,
  RunnerCheckpoint,
} from "./runnerState.js";
import { HttpWorkerTransport } from "./transport.js";

type ArchivedCheckpoint = Extract<RunnerCheckpoint, { phase: "archived" }>;

export type MetadataFirstResult =
  | {
      state: "adopted" | "selected" | "already_selected";
      manifestSha256: string;
      selectedCount: number;
      previewedCount: number;
      deferredCount: number;
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
        | "target_not_previewed"
        | "metadata_first_failed";
      manifestSha256?: string;
    };

class MetadataFirstRefusal extends Error {
  constructor(
    readonly code: Extract<MetadataFirstResult, { state: "refused" }>["code"],
  ) {
    super(code);
  }
}

function location(value: { rootAlias: string; relativePath: string }): string {
  return `${value.rootAlias}\0${value.relativePath}`;
}

export function metadataFirstIdentity(
  plan: PdfFilePlan,
): MetadataFirstIdentity {
  if (
    plan.sourceItemId === undefined ||
    plan.observationEpoch === undefined ||
    plan.processingEpoch === undefined
  )
    throw new MetadataFirstRefusal("target_not_revision_bound");
  return {
    sourceItemId: plan.sourceItemId,
    observationEpoch: plan.observationEpoch,
    processingEpoch: plan.processingEpoch,
    sha256: plan.sha256,
  };
}

export function metadataFirstIdentityKey(value: MetadataFirstIdentity): string {
  return `${value.sourceItemId}\0${value.observationEpoch}\0${value.processingEpoch}\0${value.sha256}`;
}

function selectedPlans(
  checkpoint: ArchivedCheckpoint,
  manifest: PriorityManifest,
  eligibleStartIndex: number,
): PdfFilePlan[] {
  const plans = checkpoint.files.filter(
    (plan): plan is PdfFilePlan => "kind" in plan && plan.kind === "pdf",
  );
  const eligible = checkpoint.files
    .slice(eligibleStartIndex)
    .filter(
      (plan): plan is PdfFilePlan => "kind" in plan && plan.kind === "pdf",
    );
  const byLocation = new Map(eligible.map((plan) => [location(plan), plan]));
  const targetLocations = new Set<string>();
  for (const target of manifest.targets) {
    const key = location(target);
    const plan = byLocation.get(key);
    if (!plan || plan.sha256 !== target.revisionHash)
      throw new MetadataFirstRefusal("target_missing_or_stale");
    metadataFirstIdentity(plan);
    targetLocations.add(key);
  }
  return plans.filter((plan) => targetLocations.has(location(plan)));
}

function selectionReceipt(
  manifest: PriorityManifest,
  manifestSha256: string,
  selected: MetadataFirstIdentity[],
) {
  const identities = [...selected]
    .map(({ sourceItemId, sha256 }) => ({ sourceItemId, sha256 }))
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(`${left.sourceItemId}\0${left.sha256}`),
        Buffer.from(`${right.sourceItemId}\0${right.sha256}`),
      ),
  );
  return {
    selectorSha256: manifestSha256,
    reason: manifest.reason,
    selectedCount: selected.length,
    selectedIdentitySha256: createHash("sha256")
      .update(JSON.stringify(identities))
      .digest("hex"),
  };
}

export async function adoptMetadataFirstJournal(args: {
  journal: Journal<RunnerCheckpoint, JsonValue>;
  manifest: PriorityManifest;
  manifestSha256: string;
  settleAnsweredArchivedRequest: () => Promise<void>;
}): Promise<
  Extract<
    MetadataFirstResult,
    { state: "adopted" | "selected" | "already_selected" }
  >
> {
  const before = args.journal.checkpoint;
  if (before.phase !== "archived")
    throw new MetadataFirstRefusal("phase_unsafe");
  if (args.journal.pending) {
    if (!args.journal.pending.result)
      throw new MetadataFirstRefusal("pending_unsafe");
    await args.settleAnsweredArchivedRequest();
  }
  if (args.journal.pending) throw new MetadataFirstRefusal("pending_unsafe");
  const checkpoint = args.journal.checkpoint;
  if (checkpoint.phase !== "archived")
    throw new MetadataFirstRefusal("phase_unsafe");

  const existing = checkpoint.metadataFirst;
  const bootstrapSelection =
    existing !== undefined &&
    checkpoint.step === "preview" &&
    existing.selected.length === 0 &&
    existing.selectionReceipts.length === 0;
  const deferredSelection =
    existing !== undefined && checkpoint.step === "deferred_idle";
  if (existing && !bootstrapSelection && !deferredSelection)
    throw new MetadataFirstRefusal("phase_unsafe");
  const plans = selectedPlans(
    checkpoint,
    args.manifest,
    existing?.triageStartIndex ?? checkpoint.pdfIndex + 1,
  );
  const identities = plans.map(metadataFirstIdentity);
  if (existing) {
    const previewed = new Set(existing.previewed.map(metadataFirstIdentityKey));
    if (
      deferredSelection &&
      identities.some(
        (identity) => !previewed.has(metadataFirstIdentityKey(identity)),
      )
    )
      throw new MetadataFirstRefusal("target_not_previewed");
    const selected = new Set(existing.selected.map(metadataFirstIdentityKey));
    const added = identities.filter(
      (identity) => !selected.has(metadataFirstIdentityKey(identity)),
    );
    if (added.length === 0) {
      return {
        state: "already_selected",
        manifestSha256: args.manifestSha256,
        selectedCount: 0,
        previewedCount: existing.previewed.length,
        deferredCount: existing.previewed.filter(
          (identity) => !selected.has(metadataFirstIdentityKey(identity)),
        ).length,
      };
    }
    const firstIndex = checkpoint.files.findIndex(
      (plan) =>
        "kind" in plan &&
        plan.kind === "pdf" &&
        metadataFirstIdentityKey(metadataFirstIdentity(plan)) ===
          metadataFirstIdentityKey(added[0]!),
    );
    if (firstIndex < 0)
      throw new MetadataFirstRefusal("target_missing_or_stale");
    const selectedAfter = new Set([
      ...selected,
      ...added.map(metadataFirstIdentityKey),
    ]);
    await args.journal.transitionCheckpoint({
      checkpoint: {
        ...checkpoint,
        pdfIndex: firstIndex,
        step: previewed.has(metadataFirstIdentityKey(added[0]!))
          ? "intent"
          : "preview",
        reservationRound: 0,
        metadataFirst: {
          ...existing,
          selected: [...existing.selected, ...added],
          selectionReceipts: [
            ...existing.selectionReceipts,
            selectionReceipt(args.manifest, args.manifestSha256, added),
          ],
        },
      },
      credentialSessionActive: true,
    });
    return {
      state: "selected",
      manifestSha256: args.manifestSha256,
      selectedCount: added.length,
      previewedCount: existing.previewed.length,
      deferredCount: existing.previewed.filter(
        (identity) => !selectedAfter.has(metadataFirstIdentityKey(identity)),
      ).length,
    };
  }

  const metadataFirst = {
    version: 1 as const,
    triageStartIndex: checkpoint.pdfIndex + 1,
    refreshReady: false,
    selected: identities,
    previewed: [],
    selectionReceipts: [
      selectionReceipt(args.manifest, args.manifestSha256, identities),
    ],
  };
  await args.journal.transitionCheckpoint({
    checkpoint: { ...checkpoint, metadataFirst },
    credentialSessionActive: true,
  });
  return {
    state: "adopted",
    manifestSha256: args.manifestSha256,
    selectedCount: identities.length,
    previewedCount: 0,
    deferredCount: 0,
  };
}

export async function adoptMetadataFirstFromPaths(
  configPath: string,
  manifestPath: string,
): Promise<MetadataFirstResult> {
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
      return await adoptMetadataFirstJournal({
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
      error instanceof MetadataFirstRefusal
        ? error.code
        : error instanceof PriorityRefusal
          ? "manifest_invalid"
          : error instanceof JournalLockedError
            ? "journal_contended"
            : error instanceof JournalCredentialChangedError
              ? "credential_recovery_required"
              : error instanceof JournalSafetyError
                ? "journal_unsafe"
                : "metadata_first_failed";
    return {
      state: "refused",
      code,
      ...(manifestSha256 === undefined ? {} : { manifestSha256 }),
    };
  }
}
