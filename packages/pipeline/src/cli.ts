import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { parseConfig, requireCredential } from "./config.js";
import { Journal } from "./journal.js";
import { initialCheckpoint, journalCodec, PipelineRunner } from "./runner.js";
import { HttpWorkerTransport } from "./transport.js";
import type { PipelineRunResult } from "./types.js";

function usage(): never {
  throw new Error("Usage: pnpm brain:worker -- <run|watch> --config <path>");
}
export function argumentsFor(argv: string[]): {
  command: "run" | "watch";
  configPath: string;
} {
  const forwarded = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, flag, configPath, ...extra] = forwarded;
  if (
    (command !== "run" && command !== "watch") ||
    flag !== "--config" ||
    !configPath ||
    extra.length
  )
    usage();
  return { command, configPath };
}

async function load(path: string) {
  const raw = await readFile(path, "utf8");
  return parseConfig(JSON.parse(raw));
}

async function execute(configPath: string): Promise<PipelineRunResult> {
  const config = await load(configPath);
  const credential = requireCredential(config);
  const configFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        endpoint: config.endpoint,
        spaceId: config.spaceId,
        sourceAccountId: config.sourceAccountId,
        roots: config.roots,
      }),
    )
    .digest("hex");
  const journal = await Journal.open({
    directory: config.journalDir,
    binding: {
      protocolVersion: 1,
      endpoint: config.endpoint,
      spaceId: config.spaceId,
      sourceAccountId: config.sourceAccountId,
      configFingerprint,
      credentialSlot: config.credentialEnv,
    },
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
  const { command, configPath } = argumentsFor(argv);
  if (command === "run") {
    const result = await execute(configPath);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.state !== "complete") process.exitCode = 1;
    return;
  }
  while (true) {
    const result = await execute(configPath);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    const config = await load(configPath);
    await new Promise((resolve) => setTimeout(resolve, config.watchIntervalMs));
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.stderr.write("Pipeline worker failed\n");
    process.exitCode = 1;
  });
}
