import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { capturePdfFile } from "../dist/captureStore.js";
import { canonicalRoots } from "../dist/filesystem.js";
import {
  DEFAULT_PARSER_PROCESS_LIMITS,
  createParserProfileWorkDirectory,
  inspectCapturedPdfParserOutput,
  inspectParserOutputIntent,
  ParserProcessError,
  preparePdfDocQaProfile,
  removeParserProfileWorkDirectoryExact,
  removeParserOutputExact,
  resolveRawLocators,
  runCapturedPdfParser,
} from "../dist/parserProcess.js";
import { mapParsedBundle } from "../dist/parsedBundleMapping.js";

const repository = realpath(
  join(dirname(fileURLToPath(import.meta.url)), "../../.."),
);
const repo = await repository;
const parserRoot = join(repo, "evals/parser");
const pythonExecutable = join(parserRoot, ".venv/bin/python");
const modelAssetsPath = join(parserRoot, "artifacts/models");
const launcherPath = join(parserRoot, "src/parser_eval/production_launcher.py");
const modelLockPath = join(parserRoot, "model-assets.lock.json");
const hasRuntime =
  process.platform === "darwin" &&
  existsSync("/usr/bin/sandbox-exec") &&
  existsSync(pythonExecutable) &&
  existsSync(modelAssetsPath);
const hasPythonRuntime =
  process.platform === "darwin" &&
  existsSync("/usr/bin/sandbox-exec") &&
  existsSync(pythonExecutable);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(pdfName = "lab-report-unicode.pdf") {
  const base = await realpath(await mkdtemp(join(tmpdir(), "parser-process-")));
  const sourceRoot = join(base, "source");
  const journal = join(base, "journal");
  const captures = join(base, "captures");
  const outputRoot = join(base, "outputs");
  for (const path of [sourceRoot, journal, captures, outputRoot]) {
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
  }
  const sourceBytes = await readFile(join(parserRoot, "fixtures", pdfName));
  const sourcePath = join(sourceRoot, "input.pdf");
  await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
  const observed = await stat(sourcePath);
  const [root] = await canonicalRoots({
    protocolVersion: 1,
    endpoint: "http://127.0.0.1:3100/api/worker",
    spaceId: "space",
    sourceAccountId: "source",
    credentialEnv: "TOKEN",
    roots: [{ alias: "source", path: sourceRoot }],
    journalDir: journal,
    watchIntervalMs: 1_000,
    maxFiles: 256,
    maxDepth: 16,
    maxFileBytes: 65_536,
  });
  const capture = await capturePdfFile({
    root,
    relativePath: "input.pdf",
    captureDirectory: captures,
    captureId: randomUUID(),
    expected: {
      sha256: sha256(sourceBytes),
      byteLength: sourceBytes.length,
      sourceModifiedAt: Math.trunc(observed.mtimeMs),
    },
  });
  const pythonBytes = await readFile(await realpath(pythonExecutable));
  const launcherBytes = await readFile(launcherPath);
  const modelLockBytes = await readFile(modelLockPath);
  const common = {
    capture,
    pythonExecutable,
    expectedPythonSha256: sha256(pythonBytes),
    launcherPath,
    expectedLauncherSha256: sha256(launcherBytes),
    packageRoot: join(parserRoot, "src"),
    modelAssetsPath,
    modelLockPath,
    expectedModelLockSha256: sha256(modelLockBytes),
  };
  return { base, outputRoot, common };
}

async function outputDirectory(fixture, outputId) {
  const path = join(fixture.outputRoot, outputId);
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

function multiSpanLocatorFixture(separator = " ") {
  const text = `A${separator}B`;
  const provenance = [
    {
      page_no: 1,
      charspan: [0, 1],
      bbox: { l: 0, t: 0, r: 1, b: 1, coord_origin: "TOPLEFT" },
    },
    {
      page_no: 1,
      charspan: [2, 3],
      bbox: { l: 1, t: 0, r: 2, b: 1, coord_origin: "TOPLEFT" },
    },
  ];
  const locator = {
    kind: "docling_item",
    itemRef: "#/texts/0",
    provenance,
    doclingCharspanSemantics: "item_local_python_codepoints_not_evidence",
  };
  return {
    raw: {
      texts: [
        { self_ref: "#/texts/0", text, prov: structuredClone(provenance) },
      ],
      tables: [],
    },
    bundle: {
      pages: [
        {
          page: 1,
          text,
          segments: [{ id: "item-0", text, locator }],
        },
      ],
    },
  };
}

test("raw locator resolution enforces exact multi-span provenance and whitespace", () => {
  for (const separator of ["\u0085", "\u00a0"]) {
    const fixture = multiSpanLocatorFixture(separator);
    assert.deepEqual(
      resolveRawLocators(fixture.raw, fixture.bundle)["item-0"],
      {
        kind: "item",
        ref: "#/texts/0",
      },
    );
  }
  for (const separator of ["\u001c", "\ufeff", "🧪"]) {
    const fixture = multiSpanLocatorFixture(separator);
    assert.throws(
      () => resolveRawLocators(fixture.raw, fixture.bundle),
      (error) =>
        error instanceof ParserProcessError && error.code === "output_invalid",
    );
  }

  const reordered = multiSpanLocatorFixture();
  reordered.bundle.pages[0].segments[0].locator.provenance.reverse();
  assert.throws(() => resolveRawLocators(reordered.raw, reordered.bundle));

  const wrongPage = multiSpanLocatorFixture();
  wrongPage.bundle.pages[0].segments[0].locator.provenance[1].page_no = 2;
  assert.throws(() => resolveRawLocators(wrongPage.raw, wrongPage.bundle));

  const uncoveredContent = multiSpanLocatorFixture("!");
  assert.throws(() =>
    resolveRawLocators(uncoveredContent.raw, uncoveredContent.bundle),
  );
});

async function faultFixture(behavior) {
  const f = await fixture();
  const packageRoot = join(f.base, "fault-package");
  const modelAssets = join(f.base, "fault-models");
  await mkdir(packageRoot, { mode: 0o700 });
  await mkdir(modelAssets, { mode: 0o700 });
  await chmod(packageRoot, 0o700);
  await chmod(modelAssets, 0o700);
  const launcher = join(packageRoot, "launcher.py");
  const source = `
import errno, json, os, signal, socket, sys, time
from pathlib import Path
mode = sys.argv[sys.argv.index("--mode") + 1]
def result(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\\n")
    sys.stdout.flush()
if mode == "network-probe":
    denied = 0
    for address in (("127.0.0.1", 9), ("203.0.113.1", 9)):
        candidate = None
        try:
            candidate = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            candidate.connect(address)
        except OSError as error:
            if error.errno in (errno.EPERM, errno.EACCES): denied += 1
        finally:
            if candidate is not None: candidate.close()
    result({"state":"complete","probe":"network_denied"} if denied == 2 else {"state":"failed"})
elif mode == "process-probe":
    try: os.fork()
    except OSError as error:
        result({"state":"complete","probe":"fork_denied"} if error.errno in (errno.EPERM, errno.EACCES) else {"state":"failed"})
elif mode == "exec-probe":
    try: os.execv("/bin/echo", ["echo", "unexpected"])
    except OSError as error:
        result({"state":"complete","probe":"exec_denied"} if error.errno in (errno.EPERM, errno.EACCES) else {"state":"failed"})
else:
    output = Path(sys.argv[sys.argv.index("--output-directory") + 1])
    output.joinpath("pid").write_text(str(os.getpid()), encoding="ascii")
    if ${JSON.stringify(behavior)} == "timeout":
        time.sleep(60)
    elif ${JSON.stringify(behavior)} == "stdout":
        sys.stdout.write("x" * 100000)
        sys.stdout.flush()
    elif ${JSON.stringify(behavior)} == "stderr":
        sys.stderr.write("x" * 100000)
        sys.stderr.flush()
    elif ${JSON.stringify(behavior)} == "page_limit":
        result({"state":"failed","code":"page_limit_exceeded"})
        raise SystemExit(2)
    elif ${JSON.stringify(behavior)} == "zero_exit_failure":
        result({"state":"failed","code":"page_limit_exceeded"})
    elif ${JSON.stringify(behavior)} == "unknown_failure":
        result({"state":"failed","code":"unexpected_failure"})
        raise SystemExit(2)
    elif ${JSON.stringify(behavior)} == "extra_field_failure":
        result({"state":"failed","code":"page_limit_exceeded","extra":True})
        raise SystemExit(2)
    elif ${JSON.stringify(behavior)} == "malformed_failure":
        sys.stdout.write("{malformed")
        sys.stdout.flush()
        raise SystemExit(2)
    elif ${JSON.stringify(behavior)} == "overflow_failure":
        sys.stdout.write("x" * 100000)
        result({"state":"failed","code":"page_limit_exceeded"})
        raise SystemExit(2)
    elif ${JSON.stringify(behavior)} == "cpu_limit":
        os.kill(os.getpid(), signal.SIGXCPU)
    elif ${JSON.stringify(behavior)} == "overflow_cpu_limit":
        sys.stdout.write("x" * 100000)
        sys.stdout.flush()
        os.kill(os.getpid(), signal.SIGXCPU)
`;
  await writeFile(launcher, source, { mode: 0o600 });
  const modelLock = join(f.base, "fault-model-lock.json");
  await writeFile(
    modelLock,
    JSON.stringify({ manifestSha256: "a".repeat(64) }),
    { mode: 0o600 },
  );
  return {
    ...f,
    common: {
      ...f.common,
      launcherPath: launcher,
      expectedLauncherSha256: sha256(await readFile(launcher)),
      packageRoot,
      modelAssetsPath: modelAssets,
      modelLockPath: modelLock,
      expectedModelLockSha256: sha256(await readFile(modelLock)),
    },
  };
}

test(
  "runs one useful Docling conversion with verified network and process denial",
  { skip: !hasRuntime, timeout: 240_000 },
  async () => {
    const f = await fixture();
    try {
      const profileId = randomUUID();
      const profileWork = await createParserProfileWorkDirectory({
        workRoot: f.outputRoot,
        workId: profileId,
      });
      const profile = await preparePdfDocQaProfile({
        ...f.common,
        capture: undefined,
        workRoot: f.outputRoot,
        work: profileWork,
      });
      assert.deepEqual(
        await removeParserProfileWorkDirectoryExact({
          workRoot: f.outputRoot,
          intent: profileWork,
        }),
        { state: "removed" },
      );
      assert.deepEqual(
        await removeParserProfileWorkDirectoryExact({
          workRoot: f.outputRoot,
          intent: profileWork,
        }),
        { state: "already_missing" },
      );
      const outputId = randomUUID();
      const output = await outputDirectory(f, outputId);
      const intent = await inspectParserOutputIntent({
        outputRoot: f.outputRoot,
        outputId,
      });
      const result = await runCapturedPdfParser({
        ...f.common,
        outputId,
        outputDirectory: output,
      });
      assert.equal(result.state, "complete");
      assert.equal(result.outputId, outputId);
      assert.equal(result.sourceSha256, f.common.capture.sha256);
      assert.equal(result.isolation.networkDenied, true);
      assert.equal(result.isolation.processForkDenied, true);
      assert.equal(result.isolation.processExecDenied, true);
      assert.equal(result.isolation.rssBoundary, "sampled_process_tree");
      assert.ok(result.peakRssBytes > 0);
      assert.ok(
        result.peakRssBytes <= DEFAULT_PARSER_PROCESS_LIMITS.maxRssBytes,
      );
      assert.equal(result.pageCount, 1);
      assert.equal(profile.state, "ready");
      assert.equal(profile.parserFingerprint, result.parserFingerprint);
      assert.equal(
        profile.extractionConfigurationFingerprint,
        result.extractionConfigurationFingerprint,
      );
      assert.equal(profile.modelManifestSha256, result.modelManifestSha256);
      assert.equal(profile.isolation.networkDenied, true);
      assert.equal(profile.isolation.monitorCommandTimeoutMs, 1_000);
      assert.match(result.extractionConfigurationFingerprint, /^[a-f0-9]{64}$/);
      assert.equal(
        result.rawArtifact.sha256,
        sha256(await readFile(result.rawArtifact.path)),
      );
      assert.equal(
        result.normalizedBundle.sha256,
        sha256(await readFile(result.normalizedBundle.path)),
      );
      const recovered = await inspectCapturedPdfParserOutput({
        capture: f.common.capture,
        outputRoot: f.outputRoot,
        outputIntent: intent,
        expectedParserFingerprint: result.parserFingerprint,
        expectedExtractionConfigurationFingerprint:
          result.extractionConfigurationFingerprint,
        expectedModelManifestSha256: result.modelManifestSha256,
      });
      assert.deepEqual(recovered.validated, result.validated);
      const mapped = await mapParsedBundle({
        ...recovered.validated,
        title: "Synthetic pilot",
        capturedAt: 1_800_000_000_000,
      });
      assert.equal(mapped.pages.length, 1);
      assert.ok(mapped.evidence.length > 0);
      assert.deepEqual(
        await removeParserOutputExact({
          outputRoot: f.outputRoot,
          outputIntent: intent,
          artifacts: result.artifacts,
        }),
        { state: "removed" },
      );
      assert.deepEqual(
        await removeParserOutputExact({
          outputRoot: f.outputRoot,
          outputIntent: intent,
          artifacts: result.artifacts,
        }),
        { state: "already_missing" },
      );
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  },
);

test(
  "preserves a pre-existing parser destination without starting conversion",
  { skip: !hasRuntime },
  async () => {
    const f = await fixture();
    try {
      const outputId = randomUUID();
      const output = await outputDirectory(f, outputId);
      const target = join(output, "lossless.json");
      const sentinel = Buffer.from("pre-existing parser output");
      await writeFile(target, sentinel, { mode: 0o600 });
      await assert.rejects(
        () =>
          runCapturedPdfParser({
            ...f.common,
            outputId,
            outputDirectory: output,
          }),
        (error) =>
          error instanceof ParserProcessError &&
          error.code === "destination_exists",
      );
      assert.deepEqual(await readFile(target), sentinel);
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  },
);

test(
  "recovers and maps exact raw table locators from a financial statement",
  { skip: !hasRuntime, timeout: 240_000 },
  async (context) => {
    const f = await fixture("financial-statement.pdf");
    try {
      const outputId = randomUUID();
      const output = await outputDirectory(f, outputId);
      const intent = await inspectParserOutputIntent({
        outputRoot: f.outputRoot,
        outputId,
      });
      const result = await runCapturedPdfParser({
        ...f.common,
        outputId,
        outputDirectory: output,
      });
      const recovered = await inspectCapturedPdfParserOutput({
        capture: f.common.capture,
        outputRoot: f.outputRoot,
        outputIntent: intent,
        expectedParserFingerprint: result.parserFingerprint,
        expectedExtractionConfigurationFingerprint:
          result.extractionConfigurationFingerprint,
        expectedModelManifestSha256: result.modelManifestSha256,
      });
      const mapped = await mapParsedBundle({
        ...recovered.validated,
        title: "Synthetic pilot",
        capturedAt: 1_800_000_000_000,
      });
      assert.equal(mapped.pages.length, 2);
      assert.ok(
        mapped.evidence.some(
          (entry) => entry.locator.kind === "parser_table_row_v1",
        ),
      );
      assert.ok(
        Object.values(recovered.validated.resolvedLocators).some(
          (entry) =>
            entry.kind === "table" && entry.ref.startsWith("#/tables/"),
        ),
      );
      context.diagnostic(
        JSON.stringify({
          pages: mapped.pages.length,
          evidence: mapped.evidence.length,
          documents: mapped.documents.length,
          chunks: mapped.chunks.length,
        }),
      );
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  },
);

test(
  "rejects a shared output directory before parser execution",
  { skip: !hasRuntime },
  async () => {
    const f = await fixture();
    try {
      await assert.rejects(
        () =>
          runCapturedPdfParser({
            ...f.common,
            outputId: randomUUID(),
            outputDirectory: f.outputRoot,
          }),
        (error) =>
          error instanceof ParserProcessError && error.code === "unsafe_path",
      );
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  },
);

test(
  "fails closed when the sampled process tree exceeds its RSS ceiling",
  { skip: !hasRuntime, timeout: 240_000 },
  async () => {
    const f = await fixture();
    try {
      const outputId = randomUUID();
      const output = await outputDirectory(f, outputId);
      await assert.rejects(
        () =>
          runCapturedPdfParser({
            ...f.common,
            outputId,
            outputDirectory: output,
            limits: {
              ...DEFAULT_PARSER_PROCESS_LIMITS,
              maxRssBytes: 64 * 1024 * 1024,
            },
          }),
        (error) =>
          error instanceof ParserProcessError &&
          error.code === "monitored_rss_exceeded",
      );
      await assert.rejects(() => stat(join(output, "bundle.json")), {
        code: "ENOENT",
      });
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  },
);

test(
  "kills a timed-out parser process and leaves no parser artifacts",
  { skip: !hasPythonRuntime, timeout: 10_000 },
  async () => {
    const f = await faultFixture("timeout");
    try {
      const outputId = randomUUID();
      const output = await outputDirectory(f, outputId);
      await assert.rejects(
        () =>
          runCapturedPdfParser({
            ...f.common,
            outputId,
            outputDirectory: output,
            limits: {
              ...DEFAULT_PARSER_PROCESS_LIMITS,
              wallDeadlineMs: 1_000,
            },
          }),
        (error) =>
          error instanceof ParserProcessError &&
          error.code === "process_timeout" &&
          !error.message.includes(f.base),
      );
      const childPid = Number(await readFile(join(output, "pid"), "ascii"));
      assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
      await assert.rejects(() => stat(join(output, "lossless.json")), {
        code: "ENOENT",
      });
      await assert.rejects(() => stat(join(output, "bundle.json")), {
        code: "ENOENT",
      });
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  },
);

test(
  "preserves a strictly shaped allowlisted launcher failure",
  { skip: !hasPythonRuntime, timeout: 10_000 },
  async () => {
    const f = await faultFixture("page_limit");
    try {
      const outputId = randomUUID();
      const output = await outputDirectory(f, outputId);
      await assert.rejects(
        () =>
          runCapturedPdfParser({
            ...f.common,
            outputId,
            outputDirectory: output,
          }),
        (error) =>
          error instanceof ParserProcessError &&
          error.code === "page_limit_exceeded" &&
          !error.message.includes(f.base),
      );
      await assert.rejects(() => stat(join(output, "lossless.json")), {
        code: "ENOENT",
      });
      await assert.rejects(() => stat(join(output, "bundle.json")), {
        code: "ENOENT",
      });
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  },
);

test(
  "rejects malformed output from a nonzero parser exit",
  { skip: !hasPythonRuntime, timeout: 10_000 },
  async () => {
    const f = await faultFixture("malformed_failure");
    try {
      const outputId = randomUUID();
      const output = await outputDirectory(f, outputId);
      await assert.rejects(
        () =>
          runCapturedPdfParser({
            ...f.common,
            outputId,
            outputDirectory: output,
          }),
        (error) =>
          error instanceof ParserProcessError &&
          error.code === "output_invalid" &&
          !error.message.includes(f.base),
      );
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  },
);

for (const behavior of [
  "zero_exit_failure",
  "unknown_failure",
  "extra_field_failure",
]) {
  test(
    `rejects a ${behavior} launcher result`,
    { skip: !hasPythonRuntime, timeout: 10_000 },
    async () => {
      const f = await faultFixture(behavior);
      try {
        const outputId = randomUUID();
        const output = await outputDirectory(f, outputId);
        await assert.rejects(
          () =>
            runCapturedPdfParser({
              ...f.common,
              outputId,
              outputDirectory: output,
            }),
          (error) =>
            error instanceof ParserProcessError &&
            error.code ===
              (behavior === "zero_exit_failure"
                ? "output_invalid"
                : "conversion_failed") &&
            !error.message.includes(f.base),
        );
      } finally {
        await rm(f.base, { recursive: true, force: true });
      }
    },
  );
}

test(
  "preserves output limits ahead of a structured nonzero failure",
  { skip: !hasPythonRuntime, timeout: 10_000 },
  async () => {
    const f = await faultFixture("overflow_failure");
    try {
      const outputId = randomUUID();
      const output = await outputDirectory(f, outputId);
      await assert.rejects(
        () =>
          runCapturedPdfParser({
            ...f.common,
            outputId,
            outputDirectory: output,
            limits: {
              ...DEFAULT_PARSER_PROCESS_LIMITS,
              maxStdoutBytes: 1_024,
            },
          }),
        (error) =>
          error instanceof ParserProcessError &&
          error.code === "output_limit_exceeded" &&
          !error.message.includes(f.base),
      );
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  },
);

for (const [behavior, expectedCode] of [
  ["cpu_limit", "cpu_limit_exceeded"],
  ["overflow_cpu_limit", "output_limit_exceeded"],
]) {
  test(
    `reports ${expectedCode} for a ${behavior} parser termination`,
    { skip: !hasPythonRuntime, timeout: 10_000 },
    async () => {
      const f = await faultFixture(behavior);
      try {
        const outputId = randomUUID();
        const output = await outputDirectory(f, outputId);
        await assert.rejects(
          () =>
            runCapturedPdfParser({
              ...f.common,
              outputId,
              outputDirectory: output,
              limits: {
                ...DEFAULT_PARSER_PROCESS_LIMITS,
                maxStdoutBytes: 1_024,
              },
            }),
          (error) =>
            error instanceof ParserProcessError &&
            error.code === expectedCode &&
            !error.message.includes(f.base),
        );
      } finally {
        await rm(f.base, { recursive: true, force: true });
      }
    },
  );
}

for (const stream of ["stdout", "stderr"]) {
  test(
    `bounds a synthetic parser ${stream} flood without creating artifacts`,
    { skip: !hasPythonRuntime, timeout: 10_000 },
    async () => {
      const f = await faultFixture(stream);
      try {
        const outputId = randomUUID();
        const output = await outputDirectory(f, outputId);
        await assert.rejects(
          () =>
            runCapturedPdfParser({
              ...f.common,
              outputId,
              outputDirectory: output,
              limits: {
                ...DEFAULT_PARSER_PROCESS_LIMITS,
                maxStdoutBytes: 1_024,
                maxStderrBytes: 1_024,
              },
            }),
          (error) =>
            error instanceof ParserProcessError &&
            error.code === "output_limit_exceeded" &&
            !error.message.includes(f.base),
        );
        const childPid = Number(await readFile(join(output, "pid"), "ascii"));
        assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
        await assert.rejects(() => stat(join(output, "lossless.json")), {
          code: "ENOENT",
        });
        await assert.rejects(() => stat(join(output, "bundle.json")), {
          code: "ENOENT",
        });
      } finally {
        await rm(f.base, { recursive: true, force: true });
      }
    },
  );
}

test("fails closed on unsupported operating systems", async (context) => {
  if (process.platform === "darwin") {
    context.skip("macOS is the supported boundary");
    return;
  }
  await assert.rejects(
    () => runCapturedPdfParser({}),
    (error) =>
      error instanceof ParserProcessError &&
      error.code === "unsupported_platform",
  );
});
