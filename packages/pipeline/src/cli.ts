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
import { Journal, JournalCredentialChangedError } from "./journal.js";
import { initialCheckpoint, journalCodec, PipelineRunner } from "./runner.js";
import { HttpWorkerTransport } from "./transport.js";
import type {
  PipelineConfig,
  PipelineRunResult,
  WorkerTransport,
} from "./types.js";
import type { JsonValue } from "./journalTypes.js";
import type { RunnerCheckpoint } from "./runnerState.js";

function usage(): never {
  throw new Error(
    "Usage: pnpm brain:worker -- <run|watch|doctor> --config <path> [--json], or forget-archive --config <path> --source-item <id> --source-external-id <uuid> --forget-epoch <n> [--json]",
  );
}
export function argumentsFor(argv: string[]):
  | { command: "run" | "watch"; configPath: string }
  | { command: "doctor"; configPath: string; json: boolean }
  | {
      command: "forget-archive";
      configPath: string;
      sourceItemId: string;
      sourceExternalId: string;
      forgetEpoch: number;
      json: boolean;
    } {
  const forwarded = argv[0] === "--" ? argv.slice(1) : argv;
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
  const [command, flag, configPath, ...extra] = forwarded;
  if (
    (command !== "run" && command !== "watch" && command !== "doctor") ||
    flag !== "--config" ||
    !configPath ||
    extra.some((value) => value !== "--json") ||
    extra.length > 1 ||
    (command !== "doctor" && extra.length)
  )
    usage();
  return command === "doctor"
    ? { command, configPath, json: extra.includes("--json") }
    : { command, configPath };
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
    );
    return await runner.runSafely();
  } finally {
    if (journal === undefined) await ownedJournal.close();
  }
}

async function execute(configPath: string): Promise<PipelineRunResult> {
  const config = await loadPipelineConfig(configPath);
  return executeConfig(config, requireCredential(config));
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
  if (command === "forget-archive") {
    const result = await executeForget(parsed);
    process.stdout.write(
      parsed.json
        ? `${JSON.stringify(result)}\n`
        : result.state === "owner_finalization_required"
          ? `archive forget: owner finalization required (${result.receiptCount} receipts acknowledged)\n`
          : `archive forget: ${result.state} (${result.code})\n`,
    );
    if (result.state !== "owner_finalization_required") process.exitCode = 1;
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
    const result = await execute(configPath);
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
