import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  journalBindingForConfig,
  loadPipelineConfig,
  requireCredential,
} from "./config.js";
import { WatchHeartbeat } from "./diagnostics.js";
import { runArchiveForget } from "./archiveForget.js";
import { openArchiveCatalog } from "./archiveCatalog.js";
import { doctorFromPath, formatDoctorResult } from "./doctor.js";
import {
  formatReconcileResult,
  reconcileReceiptsFromPath,
} from "./reconcileReceipts.js";
import {
  Journal,
  JournalCredentialChangedError,
  JournalLockedError,
  JournalSafetyError,
  inspectJournalReadOnly,
} from "./journal.js";
import { initialCheckpoint, journalCodec, PipelineRunner } from "./runner.js";
import { HttpWorkerTransport } from "./transport.js";
import { previewSelectedFromPaths } from "./previewSelected.js";
import { transitionPreviewLauncherFromPaths } from "./previewLauncherTransition.js";
import { transitionProviderV2FromPaths } from "./providerV2Transition.js";
import { reprioritizeFromPaths } from "./reprioritize.js";
import { adoptMetadataFirstFromPaths } from "./metadataFirst.js";
import type {
  PipelineConfig,
  PipelineRunResult,
  WorkerTransport,
} from "./types.js";
import type { JsonValue } from "./journalTypes.js";
import type { RunnerCheckpoint } from "./runnerState.js";

function usage(): never {
  throw new Error(
    "Usage: pnpm brain:worker -- <run|watch|doctor> --config <path> [--json], run also takes [--retry-parked [--operator-clear --max-clears <n>]] and [--accept-retirement <root_selection_would_retire_items|root_contents_collapsed|journal_behind_server>], or adopt-provider-v2|adopt-preview-launcher --previous-config <old-path> --config <new-path>, or reprioritize|preview-selected|adopt-metadata-first --config <path> --manifest <private-json>, or reconcile-receipts --config <path> [--apply] [--json], or forget-archive --config <path> --source-item <id> --source-external-id <uuid> --forget-epoch <n> [--json]",
  );
}
export function argumentsFor(argv: string[]):
  | {
      command: "run";
      configPath: string;
      retryParked: boolean;
      operatorClear: boolean;
      maxClears?: number;
      acceptRetirement?: string;
    }
  | { command: "watch"; configPath: string }
  | { command: "doctor"; configPath: string; json: boolean }
  | { command: "reprioritize"; configPath: string; manifestPath: string }
  | { command: "preview-selected"; configPath: string; manifestPath: string }
  | {
      command: "adopt-metadata-first";
      configPath: string;
      manifestPath: string;
    }
  | {
      command: "adopt-provider-v2";
      previousConfigPath: string;
      configPath: string;
    }
  | {
      command: "adopt-preview-launcher";
      previousConfigPath: string;
      configPath: string;
    }
  | {
      command: "reconcile-receipts";
      configPath: string;
      apply: boolean;
      json: boolean;
    }
  | {
      command: "forget-archive";
      configPath: string;
      sourceItemId: string;
      sourceExternalId: string;
      forgetEpoch: number;
      json: boolean;
    } {
  const forwarded = argv[0] === "--" ? argv.slice(1) : argv;
  if (
    forwarded[0] === "adopt-provider-v2" ||
    forwarded[0] === "adopt-preview-launcher"
  ) {
    const values = new Map<string, string>();
    for (let index = 1; index < forwarded.length; index += 1) {
      const flag = forwarded[index];
      if (flag !== "--previous-config" && flag !== "--config") usage();
      if (values.has(flag)) usage();
      const value = forwarded[index + 1];
      if (!value || value.startsWith("--")) usage();
      values.set(flag, value);
      index += 1;
    }
    const previousConfigPath = values.get("--previous-config");
    const configPath = values.get("--config");
    if (!previousConfigPath || !configPath) usage();
    return { command: forwarded[0], previousConfigPath, configPath };
  }
  if (
    forwarded[0] === "reprioritize" ||
    forwarded[0] === "preview-selected" ||
    forwarded[0] === "adopt-metadata-first"
  ) {
    const values = new Map<string, string>();
    for (let index = 1; index < forwarded.length; index += 1) {
      const flag = forwarded[index];
      if (flag !== "--config" && flag !== "--manifest") usage();
      if (values.has(flag)) usage();
      const value = forwarded[index + 1];
      if (!value || value.startsWith("--")) usage();
      values.set(flag, value);
      index += 1;
    }
    const configPath = values.get("--config");
    const manifestPath = values.get("--manifest");
    if (!configPath || !manifestPath) usage();
    return { command: forwarded[0], configPath, manifestPath };
  }
  if (forwarded[0] === "forget-archive") {
    const values = new Map<string, string>();
    let json = false;
    for (let index = 1; index < forwarded.length; index += 1) {
      const flag = forwarded[index];
      if (flag === "--json") {
        if (json) usage();
        json = true;
        continue;
      }
      if (
        flag !== "--config" &&
        flag !== "--source-item" &&
        flag !== "--source-external-id" &&
        flag !== "--forget-epoch"
      )
        usage();
      if (values.has(flag)) usage();
      const value = forwarded[index + 1];
      if (!value || value.startsWith("--")) usage();
      values.set(flag, value);
      index += 1;
    }
    const configPath = values.get("--config");
    const sourceItemId = values.get("--source-item");
    const sourceExternalId = values.get("--source-external-id");
    const epochText = values.get("--forget-epoch");
    if (
      !configPath ||
      !sourceItemId ||
      !sourceExternalId ||
      !epochText ||
      !/^[1-9][0-9]*$/.test(epochText)
    )
      usage();
    const forgetEpoch = Number(epochText);
    if (!Number.isSafeInteger(forgetEpoch)) usage();
    return {
      command: "forget-archive",
      configPath,
      sourceItemId,
      sourceExternalId,
      forgetEpoch,
      json,
    };
  }
  const [command, flag, configPath, ...rest] = forwarded;
  // P2-31f: `--max-clears <n>` is the only `run` flag that takes a value, so
  // it comes out before the remainder is checked against the bare-flag list.
  const extra: string[] = [];
  let maxClearsText: string | undefined;
  let acceptRetirement: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    if (command === "run" && rest[index] === "--max-clears") {
      if (maxClearsText !== undefined) usage();
      maxClearsText = rest[index + 1];
      index += 1;
      continue;
    }
    // ADM-4c review: the way through a refused pass. It names the exact code
    // it is accepting, so confirming one kind of removal cannot silently
    // confirm the other, and it lasts one pass.
    if (command === "run" && rest[index] === "--accept-retirement") {
      if (acceptRetirement !== undefined) usage();
      acceptRetirement = rest[index + 1];
      index += 1;
      continue;
    }
    extra.push(rest[index]!);
  }
  // ADM-6a review: the third code, on the same terms. Each one still has to be
  // named, so accepting one refusal never accepts another.
  if (
    acceptRetirement !== undefined &&
    acceptRetirement !== "root_selection_would_retire_items" &&
    acceptRetirement !== "root_contents_collapsed" &&
    acceptRetirement !== "journal_behind_server"
  )
    usage();
  const allowed =
    command === "doctor"
      ? ["--json"]
      : command === "reconcile-receipts"
        ? ["--json", "--apply"]
        : // P2-31f: the operator release for parked items, and the
          // deliberate receipt clear that only makes sense with it.
          command === "run"
          ? ["--retry-parked", "--operator-clear"]
          : [];
  if (
    (command !== "run" &&
      command !== "watch" &&
      command !== "doctor" &&
      command !== "reconcile-receipts") ||
    flag !== "--config" ||
    !configPath ||
    extra.some((value) => !allowed.includes(value)) ||
    new Set(extra).size !== extra.length
  )
    usage();
  if (command === "reconcile-receipts")
    return {
      command,
      configPath,
      apply: extra.includes("--apply"),
      json: extra.includes("--json"),
    };
  if (command === "doctor")
    return { command, configPath, json: extra.includes("--json") };
  if (command !== "run") {
    if (maxClearsText !== undefined || acceptRetirement !== undefined) usage();
    return { command, configPath };
  }
  const retryParked = extra.includes("--retry-parked");
  const operatorClear = extra.includes("--operator-clear");
  // `--operator-clear` drops safety limits that exist because a pass decides
  // alone, so it is only meaningful on a pass an operator started to retry
  // parked documents. On its own it is a typo, not an instruction.
  if (operatorClear && !retryParked) usage();
  // And it is never open ended. Against a backend that is simply the wrong
  // one, every document it reaches would have its receipt voided and be
  // re-admitted there, so the operator states how many clears they meant,
  // from the dry run's count. No flag, no relaxed rules.
  if (operatorClear !== (maxClearsText !== undefined)) usage();
  const accepted = acceptRetirement === undefined ? {} : { acceptRetirement };
  if (maxClearsText === undefined)
    return { command, configPath, retryParked, operatorClear, ...accepted };
  if (!/^[1-9][0-9]{0,3}$/.test(maxClearsText)) usage();
  return {
    command,
    configPath,
    retryParked,
    operatorClear,
    maxClears: Number(maxClearsText),
    ...accepted,
  };
}

async function executeForget(
  parsed: Extract<
    ReturnType<typeof argumentsFor>,
    {
      command: "forget-archive";
    }
  >,
) {
  const config = await loadPipelineConfig(parsed.configPath);
  const credential = requireCredential(config);
  const journal = await Journal.open({
    directory: config.journalDir,
    binding: journalBindingForConfig(config),
    credential,
    initialCheckpoint,
    codec: journalCodec,
  });
  try {
    const catalog = await openArchiveCatalog({ journal });
    return await runArchiveForget({
      config,
      catalog,
      transport: new HttpWorkerTransport(config, credential),
      sourceItemId: parsed.sourceItemId,
      sourceExternalId: parsed.sourceExternalId,
      forgetEpoch: parsed.forgetEpoch,
    });
  } finally {
    await journal.close();
  }
}

async function executeConfig(
  config: Awaited<ReturnType<typeof loadPipelineConfig>>,
  credential: string,
  journal?: Journal<RunnerCheckpoint, JsonValue>,
  options: {
    retryParked?: boolean;
    operatorClear?: boolean;
    maxClears?: number;
    acceptRetirement?: string;
  } = {},
): Promise<PipelineRunResult> {
  const ownedJournal =
    journal ??
    (await Journal.open({
      directory: config.journalDir,
      binding: journalBindingForConfig(config),
      credential,
      initialCheckpoint,
      codec: journalCodec,
    }));
  try {
    const runner = new PipelineRunner(
      config,
      ownedJournal,
      new HttpWorkerTransport(config, credential),
      undefined,
      options,
    );
    return await runner.runSafely();
  } finally {
    if (journal === undefined) await ownedJournal.close();
  }
}

async function execute(
  configPath: string,
  options: {
    retryParked?: boolean;
    operatorClear?: boolean;
    maxClears?: number;
    acceptRetirement?: string;
  } = {},
): Promise<PipelineRunResult> {
  const config = await loadPipelineConfig(configPath);
  return executeConfig(config, requireCredential(config), undefined, options);
}

/**
 * P2-104b. `runSafely` already turns a failure inside a pass into a closed
 * result, but everything before it (reading the config, resolving the
 * credential, opening the journal) threw straight past `main` into a bare
 * "Pipeline worker failed" on stderr with no JSON at all. A watcher wrapper
 * and a health check then had a nonzero exit and nothing to name, which is
 * how a journal `binding_mismatch` read as "the worker is broken".
 *
 * Every startup failure now produces the same shaped result as a failed pass.
 * The journal is inspected for its own code where it can be, so the result
 * says `binding_mismatch` rather than a generic refusal, exactly as `doctor`
 * would report it.
 */
async function executeWithClosedResult(
  configPath: string,
  options: Parameters<typeof execute>[1] = {},
): Promise<PipelineRunResult> {
  try {
    return await execute(configPath, options);
  } catch (error) {
    if (error instanceof JournalCredentialChangedError) {
      return { state: "failed", code: "credential_recovery_required" };
    }
    if (error instanceof JournalLockedError) {
      return { state: "failed", code: "journal_contended" };
    }
    if (!(error instanceof JournalSafetyError)) {
      return { state: "failed", code: "worker_start_failed" };
    }
    const inspection = await inspectJournalForConfig(configPath).catch(
      () => undefined,
    );
    return {
      state: "failed",
      code:
        inspection?.state === "unsafe"
          ? `journal_${inspection.code}`
          : "journal_unsafe",
    };
  }
}

async function inspectJournalForConfig(configPath: string) {
  const config = await loadPipelineConfig(configPath);
  return inspectJournalReadOnly({
    directory: config.journalDir,
    binding: journalBindingForConfig(config),
    codec: journalCodec,
  });
}

async function waitForWatchInterval(
  interval: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, interval);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export type WatchOptions = {
  signal?: AbortSignal;
  loadConfig?: (path: string) => Promise<PipelineConfig>;
  credential?: (config: PipelineConfig) => string;
  openJournal?: (
    config: PipelineConfig,
    credential: string,
  ) => Promise<Journal<RunnerCheckpoint, JsonValue>>;
  transport?: (config: PipelineConfig, credential: string) => WorkerTransport;
  executePass?: (
    config: PipelineConfig,
    credential: string,
    journal: Journal<RunnerCheckpoint, JsonValue>,
  ) => Promise<PipelineRunResult>;
  write?: (value: string) => void;
};

export async function runWatch(
  configPath: string,
  options: WatchOptions = {},
): Promise<void> {
  const readConfig = options.loadConfig ?? loadPipelineConfig;
  const readCredential = options.credential ?? requireCredential;
  const makeTransport =
    options.transport ??
    ((config, credential) => new HttpWorkerTransport(config, credential));
  const initialConfig = await readConfig(configPath);
  const initialCredential = readCredential(initialConfig);
  const serializedConfig = JSON.stringify(initialConfig);
  const binding = journalBindingForConfig(initialConfig);
  const journal = await (options.openJournal
    ? options.openJournal(initialConfig, initialCredential)
    : Journal.open({
        directory: initialConfig.journalDir,
        binding,
        credential: initialCredential,
        initialCheckpoint,
        codec: journalCodec,
      }));
  if (journal.credentialStatus !== "current") {
    await journal.close();
    throw new JournalCredentialChangedError();
  }
  const localStop = new AbortController();
  const signal = options.signal ?? localStop.signal;
  let heartbeat: WatchHeartbeat | undefined;
  const shutdown = () => {
    localStop.abort();
    heartbeat?.stop();
  };
  if (options.signal === undefined) {
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } else {
    options.signal.addEventListener("abort", () => heartbeat?.stop(), {
      once: true,
    });
  }
  heartbeat = new WatchHeartbeat(
    initialConfig,
    makeTransport(initialConfig, initialCredential),
    journal.watcherId,
    journal.legacyWatcherId,
  );
  heartbeat.start();
  try {
    while (!signal.aborted) {
      const config = await readConfig(configPath);
      const credential = readCredential(config);
      if (credential !== initialCredential) {
        throw new Error("worker credential changed while watch is running");
      }
      if (JSON.stringify(config) !== serializedConfig) {
        throw new Error("worker configuration changed while watch is running");
      }
      const result = options.executePass
        ? await options.executePass(config, credential, journal)
        : await executeConfig(config, credential, journal);
      (options.write ?? process.stdout.write.bind(process.stdout))(
        `${JSON.stringify(result)}\n`,
      );
      if (signal.aborted) break;
      await waitForWatchInterval(config.watchIntervalMs, signal);
    }
  } finally {
    heartbeat.stop();
    await journal.close();
    if (options.signal === undefined) {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    }
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = argumentsFor(argv);
  const { command, configPath } = parsed;
  if (command === "adopt-provider-v2") {
    const result = await transitionProviderV2FromPaths({
      previousConfigPath: parsed.previousConfigPath,
      proposedConfigPath: configPath,
    });
    process.stdout.write(
      `${JSON.stringify({ state: result.state, previousConfigSha256: result.previousConfigSha256, proposedConfigSha256: result.proposedConfigSha256 })}\n`,
    );
    return;
  }
  if (command === "reprioritize") {
    const result = await reprioritizeFromPaths(configPath, parsed.manifestPath);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.state !== "reprioritized") process.exitCode = 1;
    return;
  }
  if (command === "adopt-preview-launcher") {
    const result = await transitionPreviewLauncherFromPaths({
      previousConfigPath: parsed.previousConfigPath,
      proposedConfigPath: configPath,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "preview-selected") {
    const result = await previewSelectedFromPaths(
      configPath,
      parsed.manifestPath,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.state !== "previewed") process.exitCode = 1;
    return;
  }
  if (command === "adopt-metadata-first") {
    const result = await adoptMetadataFirstFromPaths(
      configPath,
      parsed.manifestPath,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.state === "refused") process.exitCode = 1;
    return;
  }
  if (command === "forget-archive") {
    const result = await executeForget(parsed);
    process.stdout.write(
      parsed.json
        ? `${JSON.stringify(result)}\n`
        : result.state === "owner_finalization_required"
          ? `archive forget: owner finalization required (${result.receiptCount} receipts acknowledged; ${result.retainedProviderHistoryPossible ? "live repository removed, Dropbox may retain deleted/version history" : "physical absence asserted"})\n`
          : `archive forget: ${result.state} (${result.code})\n`,
    );
    if (result.state !== "owner_finalization_required") process.exitCode = 1;
    return;
  }
  if (command === "reconcile-receipts") {
    const result = await reconcileReceiptsFromPath(
      configPath,
      parsed.apply,
      (config, credential) => new HttpWorkerTransport(config, credential),
    );
    process.stdout.write(
      parsed.json
        ? `${JSON.stringify(result)}\n`
        : `${formatReconcileResult(result)}\n`,
    );
    if (result.state === "refused") process.exitCode = 1;
    return;
  }
  if (command === "doctor") {
    const doctorResult = await doctorFromPath(
      configPath,
      (config, credential) => new HttpWorkerTransport(config, credential),
    );
    process.stdout.write(
      parsed.json
        ? `${JSON.stringify(doctorResult)}\n`
        : `${formatDoctorResult(doctorResult)}\n`,
    );
    if (doctorResult.state === "blocked") process.exitCode = 1;
    return;
  }
  if (command === "run") {
    const result = await executeWithClosedResult(configPath, {
      retryParked: parsed.retryParked,
      operatorClear: parsed.operatorClear,
      ...(parsed.maxClears === undefined
        ? {}
        : { maxClears: parsed.maxClears }),
      ...(parsed.acceptRetirement === undefined
        ? {}
        : { acceptRetirement: parsed.acceptRetirement }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.state !== "complete") process.exitCode = 1;
    return;
  }
  await runWatch(configPath);
}

function isDirectInvocation(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch(() => {
    process.stderr.write("Pipeline worker failed\n");
    process.exitCode = 1;
  });
}
