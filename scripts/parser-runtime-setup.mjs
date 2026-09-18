#!/usr/bin/env node
// Build the PDF parser runtime in a checkout and print the config block for it.
//
// The pipeline config pins the parser by path and by sha256 (`pythonExecutable`
// and `expectedPythonSha256`, `launcherPath` and `expectedLauncherSha256`,
// `modelLockPath` and `expectedModelLockSha256`) and pins the identities the
// parser computes (`profile.parserFingerprint`,
// `profile.extractionConfigurationFingerprint`). Every one of those changes
// when the parser is updated, and `preparePdfDocQaProfile` refuses to start on
// a stale value (`parser_profile_mismatch`, runner.ts). Transcribing them by
// hand is what made a parser update an hour of work and what left the watcher
// down while it was in progress.
//
// This does the whole thing in one command: create the venv from the pinned
// `uv.lock`, fetch the locked model assets, ask the parser for its own
// fingerprints, and print the `pdfDocQa.parser` and `pdfDocQa.profile` JSON to
// paste into the private config.
//
// It writes nothing outside the parser checkout: the config is printed, never
// saved, so no private file is touched here and no owner path is read.
//
// Usage, from any checkout of this repository:
//
//   node scripts/parser-runtime-setup.mjs
//   node scripts/parser-runtime-setup.mjs --skip-models   (venv and print only)
//
// If the existing config sets `pdfDocQa.parser.tableStructure` or
// `tableStructureBypass`, pass the same values here. They are part of the
// parser fingerprint, so omitting them prints fingerprints the worker refuses:
//
//   node scripts/parser-runtime-setup.mjs --table-structure off
//
// The parser then belongs to that checkout. Pointing the config at a pinned
// worker checkout instead of the root workspace is exactly this: run it there,
// paste what it prints.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PARSER_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "evals",
  "parser",
);

export class ParserSetupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseParserSetupArgs(argv) {
  const args = { skipModels: false, parserRoot: PARSER_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--skip-models") {
      args.skipModels = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === "--parser-root") {
      if (!value || value.startsWith("--")) {
        throw new ParserSetupError(
          "value_required",
          "--parser-root requires a directory",
        );
      }
      args.parserRoot = resolve(value);
      index += 1;
      continue;
    }
    // P2-104b: both of these go into the parser fingerprint's `configuration`
    // (`_fingerprint` in production.py), and so into the extraction
    // configuration fingerprint derived from it. Measured: `on` and `off`
    // give different fingerprints, and a bypass policy gives a third. A run
    // that omits a value the config sets therefore prints fingerprints the
    // worker will refuse. They must be passed here exactly as the config
    // carries them, and they are printed back so the pasted block stays whole.
    if (flag === "--table-structure") {
      if (value !== "on" && value !== "off") {
        throw new ParserSetupError(
          "value_required",
          "--table-structure requires on or off",
        );
      }
      args.tableStructure = value;
      index += 1;
      continue;
    }
    if (flag === "--table-structure-bypass") {
      if (!value || value.startsWith("--")) {
        throw new ParserSetupError(
          "value_required",
          "--table-structure-bypass requires a JSON policy",
        );
      }
      try {
        args.tableStructureBypass = JSON.parse(value);
      } catch {
        throw new ParserSetupError(
          "value_required",
          "--table-structure-bypass must be JSON",
        );
      }
      index += 1;
      continue;
    }
    throw new ParserSetupError("flag_unknown", `unknown flag ${flag}`);
  }
  if (
    args.tableStructure === "off" &&
    args.tableStructureBypass !== undefined
  ) {
    throw new ParserSetupError(
      "bypass_requires_tables",
      "--table-structure-bypass requires --table-structure on",
    );
  }
  return args;
}

/**
 * Turn the launcher's `--mode profile` answer into the two config objects.
 * Pure, so the shape of what gets pasted is tested without a parser runtime.
 */
export function configBlock(profile, paths, digests, options = {}) {
  if (profile?.state !== "ready") {
    throw new ParserSetupError(
      "profile_failed",
      `parser profile is not ready: ${JSON.stringify(profile)}`,
    );
  }
  const parserFingerprint = profile.parserFingerprint?.fingerprint;
  const extractionConfigurationFingerprint =
    profile.extractionConfiguration?.fingerprint;
  if (!parserFingerprint || !extractionConfigurationFingerprint) {
    throw new ParserSetupError(
      "profile_incomplete",
      "parser profile did not report both fingerprints",
    );
  }
  return {
    parser: {
      pythonExecutable: paths.pythonExecutable,
      expectedPythonSha256: digests.python,
      launcherPath: paths.launcherPath,
      expectedLauncherSha256: digests.launcher,
      packageRoot: paths.packageRoot,
      modelAssetsPath: paths.modelAssetsPath,
      modelLockPath: paths.modelLockPath,
      expectedModelLockSha256: digests.modelLock,
      ...(options.tableStructure === undefined
        ? {}
        : { tableStructure: options.tableStructure }),
      ...(options.tableStructureBypass === undefined
        ? {}
        : { tableStructureBypass: options.tableStructureBypass }),
    },
    profile: {
      parserProfileId: "pdf_docqa_v1",
      parserFingerprint,
      extractionConfigurationFingerprint,
    },
    modelManifestSha256: profile.parserFingerprint.modelManifestSha256,
  };
}

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new ParserSetupError(
      "command_failed",
      `${executable} ${args[0]} exited ${result.status}`,
    );
  }
}

async function digestOf(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function runParserSetup(args) {
  const root = args.parserRoot;
  if (!(await stat(root).catch(() => null))?.isDirectory()) {
    throw new ParserSetupError(
      "parser_root_missing",
      `${root} is not a directory`,
    );
  }
  const paths = {
    pythonExecutable: join(root, ".venv", "bin", "python3.12"),
    launcherPath: join(root, "src", "parser_eval", "production_launcher.py"),
    packageRoot: join(root, "src"),
    modelAssetsPath: join(root, "artifacts", "models"),
    modelLockPath: join(root, "model-assets.lock.json"),
  };

  run("uv", ["sync", "--frozen"], root);
  if (
    !args.skipModels &&
    !(await stat(paths.modelAssetsPath).catch(() => null))
  ) {
    // Setup refuses to merge with existing model state, so this only runs when
    // the directory is genuinely absent. The lock is verified, never rewritten.
    run(
      "uv",
      [
        "run",
        "--frozen",
        "kith-parser-models",
        "--output",
        paths.modelAssetsPath,
        "--lock-output",
        paths.modelLockPath,
      ],
      root,
    );
  }

  const profileResult = spawnSync(
    paths.pythonExecutable,
    [
      "-m",
      "parser_eval.production_launcher",
      "--mode",
      "profile",
      "--cpu-seconds",
      "600",
      "--file-bytes",
      String(80 * 1024 * 1024),
      "--open-files",
      "1024",
      "--artifacts",
      paths.modelAssetsPath,
      "--model-lock",
      paths.modelLockPath,
      "--conversion-timeout-seconds",
      "480",
      ...(args.tableStructure === undefined
        ? []
        : ["--table-structure", args.tableStructure]),
      ...(args.tableStructureBypass === undefined
        ? []
        : [
            "--table-structure-bypass",
            JSON.stringify(args.tableStructureBypass),
          ]),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: paths.packageRoot },
    },
  );
  if (profileResult.error) throw profileResult.error;
  let profile;
  try {
    profile = JSON.parse(profileResult.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    throw new ParserSetupError(
      "profile_unreadable",
      `parser profile output was not JSON: ${profileResult.stdout.slice(0, 512)}`,
    );
  }

  const [python, launcher, modelLock] = await Promise.all([
    digestOf(paths.pythonExecutable),
    digestOf(paths.launcherPath),
    digestOf(paths.modelLockPath),
  ]);
  return configBlock(
    profile,
    paths,
    { python, launcher, modelLock },
    {
      ...(args.tableStructure === undefined
        ? {}
        : { tableStructure: args.tableStructure }),
      ...(args.tableStructureBypass === undefined
        ? {}
        : { tableStructureBypass: args.tableStructureBypass }),
    },
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const block = await runParserSetup(
      parseParserSetupArgs(process.argv.slice(2)),
    );
    const { modelManifestSha256, ...paste } = block;
    console.log(
      [
        "",
        "Parser runtime is ready.",
        `Model manifest: ${modelManifestSha256}`,
        "",
        "Paste these two objects into pdfDocQa in the private pipeline config,",
        "keeping the extractor, record schema, normalization, chunker and",
        "correctionRevision fields already in pdfDocQa.profile:",
        "",
        JSON.stringify(paste, null, 2),
        "",
      ].join("\n"),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        state: "failed",
        code: error instanceof ParserSetupError ? error.code : "failed",
        detail: error.message,
      }),
    );
    process.exitCode = 1;
  }
}
