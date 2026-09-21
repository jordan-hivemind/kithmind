import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import {
  journalBindingForConfig,
  loadPipelineConfig,
  requireCredential,
} from "./config.js";
import { Journal, JournalSafetyError } from "./journal.js";
import type { JsonValue } from "./journalTypes.js";
import { initialCheckpoint, journalCodec } from "./runner.js";
import type { RunnerCheckpoint } from "./runnerState.js";
import type { PipelineConfig } from "./types.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_LAUNCHER_BYTES = 1024 * 1024;

function fail(code: string): never {
  throw new Error(`Preview launcher transition failed: ${code}`);
}

async function stableFileSha256(
  path: string,
  maximumBytes: number,
  protectedFile: boolean,
): Promise<string> {
  const resolved = await realpath(path).catch(() => fail("file_unavailable"));
  if (resolved !== path) fail("file_unsafe");
  const pathEntry = await lstat(path).catch(() => fail("file_unavailable"));
  if (
    !pathEntry.isFile() ||
    pathEntry.isSymbolicLink() ||
    pathEntry.size < 1 ||
    pathEntry.size > maximumBytes ||
    (protectedFile &&
      ((pathEntry.uid !== process.getuid?.() && pathEntry.uid !== 0) ||
        (pathEntry.mode & 0o022) !== 0))
  )
    fail("file_unsafe");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== pathEntry.dev ||
      before.ino !== pathEntry.ino ||
      before.size !== pathEntry.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      bytes.byteLength !== before.size
    )
      fail("file_changed");
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    await handle.close();
  }
}

export function validatePreviewLauncherTransition(
  previous: PipelineConfig,
  proposed: PipelineConfig,
): void {
  const previousParser = previous.pdfDocQa?.parser;
  const proposedParser = proposed.pdfDocQa?.parser;
  if (!previousParser || !proposedParser) fail("config_shape");
  if (
    previousParser.expectedLauncherSha256 ===
    proposedParser.expectedLauncherSha256
  )
    fail("launcher_unchanged");
  const normalized = structuredClone(previous);
  normalized.pdfDocQa!.parser.expectedLauncherSha256 =
    proposedParser.expectedLauncherSha256;
  if (!isDeepStrictEqual(normalized, proposed))
    fail("config_change_not_allowed");
  const oldBinding = journalBindingForConfig(previous);
  const newBinding = journalBindingForConfig(proposed);
  if (
    oldBinding.endpoint !== newBinding.endpoint ||
    oldBinding.spaceId !== newBinding.spaceId ||
    oldBinding.sourceAccountId !== newBinding.sourceAccountId ||
    oldBinding.credentialSlot !== newBinding.credentialSlot ||
    oldBinding.configFingerprint === newBinding.configFingerprint
  )
    fail("binding_invalid");
}

export type PreviewLauncherTransitionResult = {
  state: "transitioned" | "already_transitioned";
  previousConfigSha256: string;
  proposedConfigSha256: string;
};

export async function transitionPreviewLauncherFromPaths(args: {
  previousConfigPath: string;
  proposedConfigPath: string;
}): Promise<PreviewLauncherTransitionResult> {
  const previousBefore = await stableFileSha256(
    args.previousConfigPath,
    MAX_CONFIG_BYTES,
    false,
  );
  const previous = await loadPipelineConfig(args.previousConfigPath);
  const previousConfigSha256 = await stableFileSha256(
    args.previousConfigPath,
    MAX_CONFIG_BYTES,
    false,
  );
  const proposedBefore = await stableFileSha256(
    args.proposedConfigPath,
    MAX_CONFIG_BYTES,
    false,
  );
  const proposed = await loadPipelineConfig(args.proposedConfigPath);
  const proposedConfigSha256 = await stableFileSha256(
    args.proposedConfigPath,
    MAX_CONFIG_BYTES,
    false,
  );
  if (
    previousBefore !== previousConfigSha256 ||
    proposedBefore !== proposedConfigSha256
  )
    fail("config_changed");
  validatePreviewLauncherTransition(previous, proposed);
  if (
    (await stableFileSha256(
      proposed.pdfDocQa!.parser.launcherPath,
      MAX_LAUNCHER_BYTES,
      true,
    )) !== proposed.pdfDocQa!.parser.expectedLauncherSha256
  )
    fail("launcher_digest_mismatch");
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
    if (journal.checkpoint.phase !== "archived") fail("phase_unsafe");
    if (journal.pending !== undefined) fail("pending_unsafe");
    if (alreadyTransitioned)
      return {
        state: "already_transitioned",
        previousConfigSha256,
        proposedConfigSha256,
      };
    journal = await journal.commitActiveConfigTransition({
      previousBinding,
      proposedBinding,
      checkpoint: journal.checkpoint,
      credentialSessionActive: true,
    });
    return {
      state: "transitioned",
      previousConfigSha256,
      proposedConfigSha256,
    };
  } finally {
    await journal.close();
  }
}
