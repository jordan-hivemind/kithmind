import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { openArchiveCatalog } from "./archiveCatalog.js";
import {
  journalBindingForConfig,
  loadPipelineConfig,
  requireCredential,
} from "./config.js";
import { Journal, JournalSafetyError } from "./journal.js";
import { initialCheckpoint, journalCodec, PipelineRunner } from "./runner.js";
import type { JsonValue } from "./journalTypes.js";
import type { RunnerCheckpoint } from "./runnerState.js";
import type { PipelineConfig, WorkerTransport } from "./types.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

function fail(code: string): never {
  throw new Error(`Provider v2 transition failed: ${code}`);
}

function equal(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

async function configSha256(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 2 || before.size > MAX_CONFIG_BYTES)
      fail("config_invalid");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== before.size
    )
      fail("config_changed");
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    await handle.close();
  }
}

export function validateProviderV2ConfigTransition(
  previous: PipelineConfig,
  proposed: PipelineConfig,
): void {
  const oldPdf = previous.pdfDocQa;
  const newPdf = proposed.pdfDocQa;
  const oldProvider = oldPdf?.providerOriginal;
  const newProvider = newPdf?.providerOriginal;
  const oldBackup = oldPdf?.archive.independentBackup;
  if (
    !oldPdf ||
    !newPdf ||
    !oldProvider ||
    !newProvider ||
    !oldBackup ||
    !("repository" in oldBackup) ||
    newPdf.archive.independentBackup !== undefined ||
    newProvider.remoteName === undefined ||
    newProvider.rcloneBinary === undefined ||
    newProvider.configPath === undefined ||
    newProvider.configIdentityFingerprint === undefined
  )
    fail("config_shape");
  const repository = oldBackup.repository;
  if (repository === undefined) fail("config_shape");
  const moved = {
    remoteName: repository.remoteName,
    rcloneBinary: repository.rcloneBinary,
    configPath: repository.configPath,
    configIdentityFingerprint: repository.configIdentityFingerprint,
  };
  if (
    !equal(moved, {
      remoteName: newProvider.remoteName,
      rcloneBinary: newProvider.rcloneBinary,
      configPath: newProvider.configPath,
      configIdentityFingerprint: newProvider.configIdentityFingerprint,
    })
  )
    fail("provider_credentials_changed");
  const normalizedPrevious = structuredClone(previous);
  const normalizedProposed = structuredClone(proposed);
  Object.assign(normalizedPrevious.pdfDocQa!.providerOriginal!, moved);
  delete normalizedPrevious.pdfDocQa!.archive.independentBackup;
  if (!equal(normalizedPrevious, normalizedProposed))
    fail("config_change_not_allowed");
  const previousBinding = journalBindingForConfig(previous);
  const proposedBinding = journalBindingForConfig(proposed);
  if (
    previousBinding.endpoint !== proposedBinding.endpoint ||
    previousBinding.spaceId !== proposedBinding.spaceId ||
    previousBinding.sourceAccountId !== proposedBinding.sourceAccountId ||
    previousBinding.credentialSlot !== proposedBinding.credentialSlot ||
    previousBinding.configFingerprint === proposedBinding.configFingerprint
  )
    fail("binding_invalid");
}

const NO_TRANSPORT: WorkerTransport = {
  async call(): Promise<never> {
    fail("remote_call_refused");
  },
};

export type ProviderV2TransitionResult = {
  state: "transitioned" | "already_transitioned";
  previousConfigSha256: string;
  proposedConfigSha256: string;
};

export async function transitionProviderV2FromPaths(args: {
  previousConfigPath: string;
  proposedConfigPath: string;
}): Promise<ProviderV2TransitionResult> {
  const previousBefore = await configSha256(args.previousConfigPath);
  const previous = await loadPipelineConfig(args.previousConfigPath);
  const previousConfigSha256 = await configSha256(args.previousConfigPath);
  const proposedBefore = await configSha256(args.proposedConfigPath);
  const proposed = await loadPipelineConfig(args.proposedConfigPath);
  const proposedConfigSha256 = await configSha256(args.proposedConfigPath);
  if (
    previousBefore !== previousConfigSha256 ||
    proposedBefore !== proposedConfigSha256
  )
    fail("config_changed");
  validateProviderV2ConfigTransition(previous, proposed);
  const previousCredential = requireCredential(previous);
  const proposedCredential = requireCredential(proposed);
  if (previousCredential !== proposedCredential) fail("credential_changed");
  const previousBinding = journalBindingForConfig(previous);
  const proposedBinding = journalBindingForConfig(proposed);
  let journal: Journal<RunnerCheckpoint, JsonValue>;
  let alreadyTransitioned = false;
  try {
    journal = await Journal.open({
      directory: previous.journalDir,
      binding: previousBinding,
      credential: previousCredential,
      initialCheckpoint,
      codec: journalCodec,
    });
  } catch (error) {
    if (!(error instanceof JournalSafetyError)) throw error;
    journal = await Journal.open({
      directory: proposed.journalDir,
      binding: proposedBinding,
      credential: proposedCredential,
      initialCheckpoint,
      codec: journalCodec,
    });
    alreadyTransitioned = true;
  }
  try {
    if (alreadyTransitioned) {
      const checkpoint = journal.checkpoint;
      if (
        checkpoint.phase !== "archived" ||
        checkpoint.providerV2Transition?.previousConfigSha256 !==
          previousConfigSha256 ||
        checkpoint.providerV2Transition.proposedConfigSha256 !==
          proposedConfigSha256
      )
        fail("idempotence_receipt_missing");
      const catalog = await openArchiveCatalog({ journal });
      const original = catalog
        .listOriginals()
        .find((row) => row.originalCatalogId === checkpoint.originalCatalogId);
      if (
        original?.providerOriginal?.referenceVersion !== "provider_original_v2"
      )
        fail("idempotence_catalog_mismatch");
      return {
        state: "already_transitioned",
        previousConfigSha256,
        proposedConfigSha256,
      };
    }
    const runner = new PipelineRunner(previous, journal, NO_TRANSPORT);
    const prepared = await runner.prepareProviderV2Transition();
    if (prepared.phase !== "archived") fail("checkpoint_terminal");
    const checkpoint: RunnerCheckpoint = {
      ...prepared,
      providerV2Transition: {
        version: 1,
        previousConfigSha256,
        proposedConfigSha256,
        transitionedAt: Date.now(),
      },
    };
    const rebound = await journal.commitActiveConfigTransition({
      previousBinding,
      proposedBinding,
      checkpoint,
      credentialSessionActive: true,
    });
    journal = rebound;
    return {
      state: "transitioned",
      previousConfigSha256,
      proposedConfigSha256,
    };
  } finally {
    await journal.close();
  }
}
