import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  journalBindingForConfig,
  loadPipelineConfig,
  requireCredential,
} from "./config.js";
import { doctorFromPath, formatDoctorResult } from "./doctor.js";
import { Journal } from "./journal.js";
import { initialCheckpoint, journalCodec, PipelineRunner } from "./runner.js";
import { HttpWorkerTransport } from "./transport.js";
import type { PipelineRunResult } from "./types.js";

function usage(): never {
  throw new Error(
    "Usage: pnpm brain:worker -- <run|watch|doctor> --config <path> [--json]",
  );
}
export function argumentsFor(
  argv: string[],
):
  | { command: "run" | "watch"; configPath: string }
  | { command: "doctor"; configPath: string; json: boolean } {
  const forwarded = argv[0] === "--" ? argv.slice(1) : argv;
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

async function execute(configPath: string): Promise<PipelineRunResult> {
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
    return await runner.runSafely();
  } finally {
    await journal.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = argumentsFor(argv);
  const { command, configPath } = parsed;
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
  while (true) {
    const result = await execute(configPath);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    const config = await loadPipelineConfig(configPath);
    await new Promise((resolve) => setTimeout(resolve, config.watchIntervalMs));
  }
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
