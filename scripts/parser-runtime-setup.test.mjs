import assert from "node:assert/strict";
import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PYTHON_LINK_NAME,
  ParserSetupError,
  configBlock,
  isSingleHopExecutable,
  parseParserSetupArgs,
  runParserSetup,
} from "./parser-runtime-setup.mjs";

const PATHS = {
  pythonExecutable: "/w/evals/parser/.venv/bin/python3.12",
  launcherPath: "/w/evals/parser/src/parser_eval/production_launcher.py",
  packageRoot: "/w/evals/parser/src",
  modelAssetsPath: "/w/evals/parser/artifacts/models",
  modelLockPath: "/w/evals/parser/model-assets.lock.json",
};
const DIGESTS = {
  python: "a".repeat(64),
  launcher: "b".repeat(64),
  modelLock: "c".repeat(64),
};
const READY = {
  state: "ready",
  parserFingerprint: {
    fingerprint: "d".repeat(64),
    modelManifestSha256: "e".repeat(64),
  },
  extractionConfiguration: { fingerprint: "f".repeat(64) },
};

test("parseParserSetupArgs defaults to this checkout's parser", () => {
  const args = parseParserSetupArgs([]);
  assert.equal(args.skipModels, false);
  assert.equal(args.parserRoot.endsWith(join("evals", "parser")), true);
  assert.equal(parseParserSetupArgs(["--skip-models"]).skipModels, true);
  assert.equal(
    parseParserSetupArgs(["--parser-root", "/elsewhere/evals/parser"])
      .parserRoot,
    "/elsewhere/evals/parser",
  );
  assert.throws(
    () => parseParserSetupArgs(["--parser-root"]),
    (error) =>
      error instanceof ParserSetupError && error.code === "value_required",
  );
  assert.throws(
    () => parseParserSetupArgs(["--nope"]),
    (error) => error.code === "flag_unknown",
  );
});

test("configBlock pastes every field the pipeline config pins", () => {
  const block = configBlock(READY, PATHS, DIGESTS);
  assert.deepEqual(block.parser, {
    ...PATHS,
    expectedPythonSha256: DIGESTS.python,
    expectedLauncherSha256: DIGESTS.launcher,
    expectedModelLockSha256: DIGESTS.modelLock,
  });
  assert.deepEqual(block.profile, {
    parserProfileId: "pdf_docqa_v1",
    parserFingerprint: "d".repeat(64),
    extractionConfigurationFingerprint: "f".repeat(64),
  });
  assert.equal(block.modelManifestSha256, "e".repeat(64));
});

test("configBlock carries the parser's own fingerprints, never a stale guess", () => {
  const moved = configBlock(
    {
      ...READY,
      parserFingerprint: {
        ...READY.parserFingerprint,
        fingerprint: "1".repeat(64),
      },
    },
    PATHS,
    DIGESTS,
  );
  assert.equal(moved.profile.parserFingerprint, "1".repeat(64));
  assert.notEqual(
    moved.profile.parserFingerprint,
    configBlock(READY, PATHS, DIGESTS).profile.parserFingerprint,
  );
});

test("configBlock refuses a parser that did not come up ready", () => {
  assert.throws(
    () =>
      configBlock(
        { state: "failed", code: "model_assets_invalid" },
        PATHS,
        DIGESTS,
      ),
    (error) =>
      error instanceof ParserSetupError && error.code === "profile_failed",
  );
  assert.throws(
    () =>
      configBlock({ state: "ready", parserFingerprint: {} }, PATHS, DIGESTS),
    (error) => error.code === "profile_incomplete",
  );
});

test("runParserSetup refuses a parser root that is not there", async () => {
  await assert.rejects(
    runParserSetup({
      parserRoot: join(tmpdir(), "absent-parser-root"),
      skipModels: true,
    }),
    (error) =>
      error instanceof ParserSetupError && error.code === "parser_root_missing",
  );
});

// P2-104b: `tableStructure` and `tableStructureBypass` are part of the parser
// fingerprint's configuration (measured: on, off and a bypass policy each give
// a different fingerprint). A config that sets them must pass them here, and
// they must survive into the printed block, or the pasted config names
// fingerprints the worker refuses.
test("table structure options are accepted and printed back", () => {
  const bypass = { [`${"5".repeat(64)}`]: [1, 3] };
  assert.equal(
    parseParserSetupArgs(["--table-structure", "off"]).tableStructure,
    "off",
  );
  assert.deepEqual(
    parseParserSetupArgs(["--table-structure-bypass", JSON.stringify(bypass)])
      .tableStructureBypass,
    bypass,
  );
  const block = configBlock(READY, PATHS, DIGESTS, {
    tableStructure: "on",
    tableStructureBypass: bypass,
  });
  assert.equal(block.parser.tableStructure, "on");
  assert.deepEqual(block.parser.tableStructureBypass, bypass);
});

test("table structure options are omitted when unset, matching the parser default", () => {
  const args = parseParserSetupArgs([]);
  assert.equal(args.tableStructure, undefined);
  assert.equal(args.tableStructureBypass, undefined);
  const block = configBlock(READY, PATHS, DIGESTS);
  assert.equal("tableStructure" in block.parser, false);
  assert.equal("tableStructureBypass" in block.parser, false);
});

test("table structure options are rejected when invalid or contradictory", () => {
  for (const argv of [
    ["--table-structure", "maybe"],
    ["--table-structure"],
    ["--table-structure-bypass", "{not json"],
  ]) {
    assert.throws(
      () => parseParserSetupArgs(argv),
      (error) =>
        error instanceof ParserSetupError && error.code === "value_required",
      argv.join(" "),
    );
  }
  assert.throws(
    () =>
      parseParserSetupArgs([
        "--table-structure",
        "off",
        "--table-structure-bypass",
        "{}",
      ]),
    (error) => error.code === "bypass_requires_tables",
  );
});

// P2-104c. uv's venv links python3.12 -> python -> the real interpreter. The
// runner readlinks `pythonExecutable` exactly once and requires the result to
// equal the fully resolved path, so a two hop name is refused as
// `unsafe_path`. Printing `python3.12` took the live watcher down.
test("the printed interpreter is the single hop name the runner accepts", async () => {
  assert.equal(PYTHON_LINK_NAME, "python");

  // realpath first: macOS tmpdir is itself a symlink, and the runner compares
  // the link target against the fully resolved path, so a symlinked ancestor
  // would make even a one hop link look like two.
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "parser-python-path-")),
  );
  const real = join(directory, "cpython3.12");
  await writeFile(real, "#!/bin/sh\n", { mode: 0o755 });
  await symlink(real, join(directory, "python"));
  await symlink("python", join(directory, "python3.12"));

  assert.equal(
    await isSingleHopExecutable(join(directory, "python")),
    true,
    "one hop to the interpreter is what the runner accepts",
  );
  assert.equal(
    await isSingleHopExecutable(join(directory, "python3.12")),
    false,
    "two hops is the shape that was refused",
  );
  assert.equal(
    await isSingleHopExecutable(real),
    true,
    "a plain file is acceptable too",
  );
});
