import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ParserSetupError,
  configBlock,
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
