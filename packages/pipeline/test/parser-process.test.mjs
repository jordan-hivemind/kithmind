import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
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
  parseBoundedParserJson,
  ParserProcessError,
  preparePdfDocQaProfile,
  removeParserProfileWorkDirectoryExact,
  removeParserOutputExact,
  resolveRawLocators,
  runCapturedPdfParser,
} from "../dist/parserProcess.js";
import {
  mapParsedBundle,
  PDF_DOCQA_CHUNKING_FINGERPRINT,
  PDF_DOCQA_LEGACY_CHUNKING_FINGERPRINT,
} from "../dist/parsedBundleMapping.js";

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

function canonicalJsonForTest(value) {
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJsonForTest(entry)).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJsonForTest(value[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

function fingerprintDescriptorForTest(value) {
  const fields = structuredClone(value);
  delete fields.fingerprint;
  return sha256(Buffer.from(canonicalJsonForTest(fields), "utf8"));
}

test("bounds parser JSON nodes and depth independently", () => {
  const maximum = 4 * 1024 * 1024;
  const atNodeBound = Buffer.from(JSON.stringify(Array(499_999).fill(null)));
  assert.equal(parseBoundedParserJson(atNodeBound, maximum).length, 499_999);
  const overNodeBound = Buffer.from(JSON.stringify(Array(500_000).fill(null)));
  assert.throws(
    () => parseBoundedParserJson(overNodeBound, maximum),
    (error) =>
      error instanceof ParserProcessError &&
      error.code === "output_invalid" &&
      error.message.includes("node bound"),
  );
  let tooDeep = null;
  for (let depth = 0; depth < 49; depth += 1) tooDeep = [tooDeep];
  assert.throws(
    () => parseBoundedParserJson(Buffer.from(JSON.stringify(tooDeep)), maximum),
    (error) =>
      error instanceof ParserProcessError &&
      error.code === "output_invalid" &&
      error.message.includes("depth bound"),
  );
});

test("uses the bounded large-document resource profile", async () => {
  assert.deepEqual(
    {
      wallDeadlineMs: DEFAULT_PARSER_PROCESS_LIMITS.wallDeadlineMs,
      cpuSeconds: DEFAULT_PARSER_PROCESS_LIMITS.cpuSeconds,
      maxRssBytes: DEFAULT_PARSER_PROCESS_LIMITS.maxRssBytes,
    },
    {
      wallDeadlineMs: 600_000,
      cpuSeconds: 1_800,
      maxRssBytes: 8 * 1024 * 1024 * 1024,
    },
  );
  await assert.rejects(
    () =>
      runCapturedPdfParser({
        limits: { ...DEFAULT_PARSER_PROCESS_LIMITS, cpuSeconds: 1_801 },
      }),
    (error) =>
      error instanceof ParserProcessError &&
      error.code ===
        (process.platform === "darwin"
          ? "invalid_input"
          : "unsupported_platform"),
  );
});

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

function assertQuotedSourceField(result, pageNumber, quote) {
  const page = result.validated.bundle.pages.find(
    (candidate) => candidate.page === pageNumber,
  );
  assert.ok(page, `missing page ${pageNumber}`);
  const segment = page.segments.find((candidate) =>
    candidate.text.includes(quote),
  );
  assert.ok(segment, `missing citable source field: ${quote}`);
  assert.ok(result.validated.resolvedLocators[segment.id]);
  return segment;
}

function assertOrderedSourceFields(result, pageNumber, fields) {
  const page = result.validated.bundle.pages.find(
    (candidate) => candidate.page === pageNumber,
  );
  assert.ok(page, `missing page ${pageNumber}`);
  let cursor = 0;
  for (const field of fields) {
    const index = page.text.indexOf(field, cursor);
    assert.ok(index >= cursor, `missing ordered source field: ${field}`);
    cursor = index + field.length;
  }
  assert.ok(
    cursor <= page.text.indexOf(fields[0]) + 64,
    "source fields are not a compact label/value association",
  );
  for (const field of fields)
    assertQuotedSourceField(result, pageNumber, field);
}

async function assertExactRawProvenance(result) {
  const raw = JSON.parse(await readFile(result.rawArtifact.path, "utf8"));
  assert.deepEqual(
    resolveRawLocators(raw, result.validated.bundle, "docling_utf16_pages_v2"),
    result.validated.resolvedLocators,
  );
}

async function modeIgnoringFixture(fixture) {
  const packageRoot = join(fixture.base, "mode-ignoring-package");
  await cp(join(parserRoot, "src"), packageRoot, { recursive: true });
  const launcherPath = join(packageRoot, "parser_eval/production_launcher.py");
  const launcher = await readFile(launcherPath, "utf8");
  const modified = launcher.replace(
    "args = parser.parse_args(argv)",
    'args = parser.parse_args(argv)\n        args.table_structure = "on"',
  );
  assert.notEqual(modified, launcher);
  await writeFile(launcherPath, modified, { mode: 0o600 });
  return {
    ...fixture.common,
    packageRoot,
    launcherPath,
    expectedLauncherSha256: sha256(await readFile(launcherPath)),
  };
}

async function bypassMutatingFixture(fixture, replacement) {
  const packageRoot = join(fixture.base, "bypass-mutating-package");
  await cp(join(parserRoot, "src"), packageRoot, { recursive: true });
  const launcherPath = join(packageRoot, "parser_eval/production_launcher.py");
  const launcher = await readFile(launcherPath, "utf8");
  const modified = launcher.replace(
    "args = parser.parse_args(argv)",
    `args = parser.parse_args(argv)\n        args.table_structure_bypass = ${replacement}`,
  );
  assert.notEqual(modified, launcher);
  await writeFile(launcherPath, modified, { mode: 0o600 });
  return {
    ...fixture.common,
    packageRoot,
    launcherPath,
    expectedLauncherSha256: sha256(await readFile(launcherPath)),
  };
}

async function bypassSelectionReportingFixture(fixture, result, reportedPages) {
  const packageRoot = join(
    fixture.base,
    `bypass-reporting-package-${randomUUID()}`,
  );
  await mkdir(packageRoot, { mode: 0o700 });
  await chmod(packageRoot, 0o700);
  const rawFixture = join(packageRoot, "lossless-fixture.json");
  const bundleFixture = join(packageRoot, "bundle-fixture.json");
  const rawBytes = await readFile(result.rawArtifact.path);
  const bundleBytes = await readFile(result.normalizedBundle.path);
  await writeFile(rawFixture, rawBytes, { mode: 0o600 });
  await writeFile(bundleFixture, bundleBytes, { mode: 0o600 });
  const response = {
    state: "complete",
    sourceSha256: fixture.common.capture.sha256,
    rawSha256: sha256(rawBytes),
    rawByteLength: rawBytes.length,
    bundleSha256: sha256(bundleBytes),
    bundleByteLength: bundleBytes.length,
    parserFingerprint: result.parserFingerprint,
    extractionFingerprint: result.extractionFingerprint,
    modelManifestSha256: result.modelManifestSha256,
    pageCount: result.pageCount,
    tableStructureBypassPages: reportedPages,
  };
  const launcherPath = join(packageRoot, "launcher.py");
  const source = `
import json, os, sys
from pathlib import Path
mode = sys.argv[sys.argv.index("--mode") + 1]
def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\\n")
if mode == "network-probe":
    emit({"state":"complete","probe":"network_denied"})
elif mode == "process-probe":
    emit({"state":"complete","probe":"fork_denied"})
elif mode == "exec-probe":
    emit({"state":"complete","probe":"exec_denied"})
elif mode == "convert":
    base = Path(__file__).parent
    for argument, name in (("--raw-output", "lossless-fixture.json"), ("--bundle-output", "bundle-fixture.json")):
        target = Path(sys.argv[sys.argv.index(argument) + 1])
        data = base.joinpath(name).read_bytes()
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
    emit(json.loads(${JSON.stringify(JSON.stringify(response))}))
else:
    emit({"state":"failed","code":"invalid_input"})
`;
  await writeFile(launcherPath, source, { mode: 0o600 });
  return {
    ...fixture.common,
    packageRoot,
    launcherPath,
    expectedLauncherSha256: sha256(await readFile(launcherPath)),
  };
}

async function legacySchemaFixture(fixture) {
  const packageRoot = join(fixture.base, "legacy-schema-package");
  await cp(join(parserRoot, "src"), packageRoot, { recursive: true });
  const productionPath = join(packageRoot, "parser_eval/production.py");
  const production = await readFile(productionPath, "utf8");
  const legacy = production
    .replace('"schemaVersion": 2,', '"schemaVersion": 1,')
    .replace('            "tableStructure": table_structure,\n', "");
  assert.notEqual(legacy, production);
  await writeFile(productionPath, legacy, { mode: 0o600 });
  const launcherPath = join(packageRoot, "parser_eval/production_launcher.py");
  return {
    ...fixture.common,
    packageRoot,
    launcherPath,
    expectedLauncherSha256: sha256(await readFile(launcherPath)),
  };
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

function crossPageSliceFixture() {
  const text = "Alpha 🧪 beta";
  const provenance = [
    {
      page_no: 1,
      charspan: [0, 5],
      bbox: { l: 0, t: 0, r: 1, b: 1, coord_origin: "TOPLEFT" },
    },
    {
      page_no: 2,
      charspan: [6, 7],
      bbox: { l: 0, t: 0, r: 1, b: 1, coord_origin: "TOPLEFT" },
    },
    {
      page_no: 2,
      charspan: [8, 12],
      bbox: { l: 0, t: 0, r: 1, b: 1, coord_origin: "TOPLEFT" },
    },
  ];
  const locator = (indexes, charspan) => ({
    kind: "docling_item_slice",
    itemRef: "#/texts/0",
    provenance: structuredClone(provenance),
    provenanceIndexes: indexes,
    itemTextCharspan: charspan,
    doclingCharspanSemantics: "item_local_python_codepoints",
  });
  return {
    raw: {
      texts: [{ self_ref: "#/texts/0", text, prov: provenance, children: [] }],
      tables: [],
    },
    bundle: {
      pages: [
        {
          page: 1,
          text: "Alpha ",
          segments: [
            { id: "slice-0", text: "Alpha ", locator: locator([0, 1], [0, 6]) },
          ],
        },
        {
          page: 2,
          text: "🧪 beta",
          segments: [
            {
              id: "slice-1",
              text: "🧪 beta",
              locator: locator([1, 3], [6, 12]),
            },
          ],
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

test("raw locator resolution requires the complete exact cross-page slice inventory", () => {
  const valid = crossPageSliceFixture();
  const resolved = resolveRawLocators(valid.raw, valid.bundle);
  assert.deepEqual(resolved["slice-0"], {
    kind: "item",
    ref: "#/texts/0",
  });
  assert.deepEqual(resolved["slice-1"], {
    kind: "item",
    ref: "#/texts/0",
  });

  const omitted = crossPageSliceFixture();
  omitted.bundle.pages[1].segments = [];
  assert.throws(() => resolveRawLocators(omitted.raw, omitted.bundle));

  const duplicate = crossPageSliceFixture();
  duplicate.bundle.pages[0].segments.push({
    ...structuredClone(duplicate.bundle.pages[0].segments[0]),
    id: "slice-duplicate",
  });
  assert.throws(() => resolveRawLocators(duplicate.raw, duplicate.bundle));

  const reordered = crossPageSliceFixture();
  reordered.bundle.pages[0].segments[0].locator.provenance.reverse();
  assert.throws(() => resolveRawLocators(reordered.raw, reordered.bundle));

  const wrongPage = crossPageSliceFixture();
  wrongPage.bundle.pages[1].segments[0].locator.provenance[1].page_no = 1;
  assert.throws(() => resolveRawLocators(wrongPage.raw, wrongPage.bundle));

  const overlapping = crossPageSliceFixture();
  overlapping.raw.texts[0].prov[1].charspan = [4, 7];
  overlapping.bundle.pages[0].segments[0].locator.provenance[1].charspan = [
    4, 7,
  ];
  overlapping.bundle.pages[1].segments[0].locator.provenance[1].charspan = [
    4, 7,
  ];
  assert.throws(() => resolveRawLocators(overlapping.raw, overlapping.bundle));

  const alteredContent = crossPageSliceFixture();
  alteredContent.raw.texts[0].text = "Alpha ! beta";
  assert.throws(() =>
    resolveRawLocators(alteredContent.raw, alteredContent.bundle),
  );
});

test("v2 inventories traversed body slices while legacy gaps and furniture remain inspectable", () => {
  const current = crossPageSliceFixture();
  current.raw.texts.push({
    ...structuredClone(current.raw.texts[0]),
    self_ref: "#/texts/1",
    children: [],
  });
  current.raw.groups = [];
  current.raw.body = { children: [{ $ref: "#/texts/0" }] };
  current.raw.furniture = { children: [{ $ref: "#/texts/1" }] };
  assert.doesNotThrow(() =>
    resolveRawLocators(current.raw, current.bundle, "docling_utf16_pages_v2"),
  );

  const legacyGap = structuredClone(current);
  for (const page of legacyGap.bundle.pages) page.segments = [];
  legacyGap.bundle.mappingGaps = [
    { kind: "ambiguous_text_provenance", item: 0 },
  ];
  assert.deepEqual(
    Object.keys(resolveRawLocators(legacyGap.raw, legacyGap.bundle)),
    [],
  );
  assert.throws(() =>
    resolveRawLocators(
      legacyGap.raw,
      legacyGap.bundle,
      "docling_utf16_pages_v2",
    ),
  );

  const nestedText = structuredClone(current);
  nestedText.raw.texts[0].children = [{ $ref: "#/texts/1" }];
  assert.throws(() =>
    resolveRawLocators(
      nestedText.raw,
      nestedText.bundle,
      "docling_utf16_pages_v2",
    ),
  );

  const excludedLayer = structuredClone(nestedText);
  excludedLayer.raw.texts[1].content_layer = "furniture";
  assert.doesNotThrow(() =>
    resolveRawLocators(
      excludedLayer.raw,
      excludedLayer.bundle,
      "docling_utf16_pages_v2",
    ),
  );

  const pictureCaption = structuredClone(current);
  pictureCaption.raw.body = { children: [{ $ref: "#/pictures/0" }] };
  pictureCaption.raw.pictures = [
    {
      children: [{ $ref: "#/texts/0" }, { $ref: "#/texts/1" }],
      captions: [{ $ref: "#/texts/0" }],
    },
  ];
  assert.doesNotThrow(() =>
    resolveRawLocators(
      pictureCaption.raw,
      pictureCaption.bundle,
      "docling_utf16_pages_v2",
    ),
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
      for (const quote of [
        "Patient: Alex Sample A",
        "Result: 25 µg/L",
        "Astral marker: 🌍 retained",
        "Analyte: Café marker",
      ])
        assertQuotedSourceField(result, 1, quote);
      await assertExactRawProvenance(result);
      const mapped = await mapParsedBundle({
        ...recovered.validated,
        title: "Synthetic pilot",
        capturedAt: 1_800_000_000_000,
        chunkingFingerprint: PDF_DOCQA_CHUNKING_FINGERPRINT,
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
  "uses distinct verified table structure modes for the synthetic PDF",
  { skip: !hasRuntime, timeout: 240_000 },
  async () => {
    const f = await fixture();
    try {
      const onWork = await createParserProfileWorkDirectory({
        workRoot: f.outputRoot,
        workId: randomUUID(),
      });
      const offWork = await createParserProfileWorkDirectory({
        workRoot: f.outputRoot,
        workId: randomUUID(),
      });
      const onProfile = await preparePdfDocQaProfile({
        ...f.common,
        workRoot: f.outputRoot,
        work: onWork,
      });
      const offProfile = await preparePdfDocQaProfile({
        ...f.common,
        tableStructure: "off",
        workRoot: f.outputRoot,
        work: offWork,
      });
      assert.equal(onProfile.state, "ready");
      assert.equal(offProfile.state, "ready");
      assert.notEqual(
        onProfile.parserFingerprint,
        offProfile.parserFingerprint,
      );
      const outputId = randomUUID();
      const output = await outputDirectory(f, outputId);
      const result = await runCapturedPdfParser({
        ...f.common,
        tableStructure: "off",
        outputId,
        outputDirectory: output,
      });
      assert.equal(result.state, "complete");
      assert.equal(result.parserFingerprint, offProfile.parserFingerprint);
      for (const quote of [
        "Patient: Alex Sample A",
        "Result: 25 µg/L",
        "Astral marker: 🌍 retained",
        "Analyte: Café marker",
      ])
        assertQuotedSourceField(result, 1, quote);
      await assertExactRawProvenance(result);
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  },
);

test(
  "rejects an ignored table structure mode in profile and conversion results",
  { skip: !hasRuntime, timeout: 240_000 },
  async () => {
    const f = await fixture();
    try {
      const common = await modeIgnoringFixture(f);
      const work = await createParserProfileWorkDirectory({
        workRoot: f.outputRoot,
        workId: randomUUID(),
      });
      await assert.rejects(
        () =>
          preparePdfDocQaProfile({
            ...common,
            tableStructure: "off",
            workRoot: f.outputRoot,
            work,
          }),
        (error) =>
          error instanceof ParserProcessError &&
          error.code === "output_invalid",
      );
      const outputId = randomUUID();
      const output = await outputDirectory(f, outputId);
      await assert.rejects(
        () =>
          runCapturedPdfParser({
            ...common,
            tableStructure: "off",
            outputId,
            outputDirectory: output,
          }),
        (error) =>
          error instanceof ParserProcessError &&
          error.code === "output_invalid",
      );
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  },
);

test(
  "rejects ignored or changed table structure bypass policies in profile results",
  { skip: !hasRuntime, timeout: 120_000 },
  async () => {
    const f = await fixture();
    try {
      const policy = { [f.common.capture.sha256]: [1] };
      for (const replacement of ["None", '{"c" * 64: [1]}']) {
        const common = await bypassMutatingFixture(f, replacement);
        const work = await createParserProfileWorkDirectory({
          workRoot: f.outputRoot,
          workId: randomUUID(),
        });
        await assert.rejects(
          () =>
            preparePdfDocQaProfile({
              ...common,
              tableStructureBypass: policy,
              workRoot: f.outputRoot,
              work,
            }),
          (error) =>
            error instanceof ParserProcessError &&
            error.code === "output_invalid",
        );
      }
    } finally {
      await rm(f.base, { recursive: true, force: true });
    }
  },
);

test(
  "rejects malformed table structure bypass policies before parser execution",
  { skip: !hasPythonRuntime },
  async () => {
    const digest = "a".repeat(64);
    const policies = [
      { [digest]: [1, , 3] },
      { [digest]: [true] },
      { [digest]: [1.5] },
      { [digest]: [1, 1] },
      { [digest]: [2, 1] },
      { [digest]: [0] },
      { [digest]: [65] },
      { ["A".repeat(64)]: [1] },
    ];
    for (const tableStructureBypass of policies) {
      for (const invoke of [
        () => preparePdfDocQaProfile({ tableStructureBypass }),
        () => runCapturedPdfParser({ tableStructureBypass }),
      ]) {
        await assert.rejects(
          invoke,
          (error) =>
            error instanceof ParserProcessError &&
            error.code === "invalid_input",
        );
      }
    }
    for (const invoke of [
      () =>
        preparePdfDocQaProfile({
          tableStructure: "off",
          tableStructureBypass: { [digest]: [1] },
        }),
      () =>
        runCapturedPdfParser({
          tableStructure: "off",
          tableStructureBypass: { [digest]: [1] },
        }),
    ]) {
      await assert.rejects(
        invoke,
        (error) =>
          error instanceof ParserProcessError && error.code === "invalid_input",
      );
    }
  },
);

test(
  "accepts legacy schema one profiles as table structure on only",
  { skip: !hasRuntime, timeout: 120_000 },
  async () => {
    const f = await fixture();
    try {
      const common = await legacySchemaFixture(f);
      const onWork = await createParserProfileWorkDirectory({
        workRoot: f.outputRoot,
        workId: randomUUID(),
      });
      const profile = await preparePdfDocQaProfile({
        ...common,
        workRoot: f.outputRoot,
        work: onWork,
      });
      assert.equal(profile.state, "ready");
      const outputId = randomUUID();
      const output = await outputDirectory(f, outputId);
      const intent = await inspectParserOutputIntent({
        outputRoot: f.outputRoot,
        outputId,
      });
      const result = await runCapturedPdfParser({
        ...common,
        outputId,
        outputDirectory: output,
      });
      const recovered = await inspectCapturedPdfParserOutput({
        capture: common.capture,
        outputRoot: f.outputRoot,
        outputIntent: intent,
        expectedParserFingerprint: result.parserFingerprint,
        expectedExtractionConfigurationFingerprint:
          result.extractionConfigurationFingerprint,
        expectedModelManifestSha256: result.modelManifestSha256,
      });
      assert.deepEqual(recovered.validated, result.validated);
      const offWork = await createParserProfileWorkDirectory({
        workRoot: f.outputRoot,
        workId: randomUUID(),
      });
      await assert.rejects(
        () =>
          preparePdfDocQaProfile({
            ...common,
            tableStructure: "off",
            workRoot: f.outputRoot,
            work: offWork,
          }),
        (error) =>
          error instanceof ParserProcessError &&
          error.code === "output_invalid",
      );
      const offOutputId = randomUUID();
      const offOutput = await outputDirectory(f, offOutputId);
      await assert.rejects(
        () =>
          runCapturedPdfParser({
            ...common,
            tableStructure: "off",
            outputId: offOutputId,
            outputDirectory: offOutput,
          }),
        (error) =>
          error instanceof ParserProcessError &&
          error.code === "output_invalid",
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
        chunkingFingerprint: PDF_DOCQA_LEGACY_CHUNKING_FINGERPRINT,
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
      const feeRow = assertQuotedSourceField(result, 1, "Fee | USD | 65.00");
      assert.equal(feeRow.locator.kind, "docling_table_row");
      assert.deepEqual(
        feeRow.locator.cells
          .slice()
          .sort(
            (left, right) =>
              left.start_col_offset_idx - right.start_col_offset_idx,
          )
          .map((cell) => cell.text),
        ["Fee", "USD", "65.00"],
      );
      await assertExactRawProvenance(result);
      const offOutputId = randomUUID();
      const offOutput = await outputDirectory(f, offOutputId);
      const offResult = await runCapturedPdfParser({
        ...f.common,
        tableStructure: "off",
        outputId: offOutputId,
        outputDirectory: offOutput,
      });
      assertOrderedSourceFields(offResult, 1, ["Fee", "USD", "65.00"]);
      await assertExactRawProvenance(offResult);

      const tableStructureBypass = { [f.common.capture.sha256]: [1] };
      const policyWork = await createParserProfileWorkDirectory({
        workRoot: f.outputRoot,
        workId: randomUUID(),
      });
      const policyProfile = await preparePdfDocQaProfile({
        ...f.common,
        tableStructureBypass,
        workRoot: f.outputRoot,
        work: policyWork,
      });
      assert.equal(policyProfile.state, "ready");
      const policyOutputId = randomUUID();
      const policyOutput = await outputDirectory(f, policyOutputId);
      const policyIntent = await inspectParserOutputIntent({
        outputRoot: f.outputRoot,
        outputId: policyOutputId,
      });
      const policyResult = await runCapturedPdfParser({
        ...f.common,
        tableStructureBypass,
        outputId: policyOutputId,
        outputDirectory: policyOutput,
      });
      assert.equal(
        policyResult.parserFingerprint,
        policyProfile.parserFingerprint,
      );
      assert.deepEqual(policyResult.tableStructureBypassPages, [1]);
      assertOrderedSourceFields(policyResult, 1, ["Fee", "USD", "65.00"]);
      const refundRow = assertQuotedSourceField(
        policyResult,
        2,
        "Refund | EUR | -10.00",
      );
      assert.equal(refundRow.locator.kind, "docling_table_row");
      assert.deepEqual(
        refundRow.locator.cells
          .slice()
          .sort(
            (left, right) =>
              left.start_col_offset_idx - right.start_col_offset_idx,
          )
          .map((cell) => cell.text),
        ["Refund", "EUR", "-10.00"],
      );
      await assertExactRawProvenance(policyResult);
      const policyRecovered = await inspectCapturedPdfParserOutput({
        capture: f.common.capture,
        outputRoot: f.outputRoot,
        outputIntent: policyIntent,
        expectedParserFingerprint: policyResult.parserFingerprint,
        expectedExtractionConfigurationFingerprint:
          policyResult.extractionConfigurationFingerprint,
        expectedModelManifestSha256: policyResult.modelManifestSha256,
      });
      assert.deepEqual(policyRecovered.tableStructureBypassPages, [1]);
      assert.deepEqual(policyRecovered.validated, policyResult.validated);

      const replayCommon = await bypassSelectionReportingFixture(
        f,
        policyResult,
        [1],
      );
      const replayOutputId = randomUUID();
      const replayOutput = await outputDirectory(f, replayOutputId);
      const replayResult = await runCapturedPdfParser({
        ...replayCommon,
        tableStructureBypass,
        outputId: replayOutputId,
        outputDirectory: replayOutput,
      });
      assert.deepEqual(replayResult.tableStructureBypassPages, [1]);
      assert.deepEqual(replayResult.validated, policyResult.validated);

      const falseReportCommon = await bypassSelectionReportingFixture(
        f,
        policyResult,
        [2],
      );
      const falseReportOutputId = randomUUID();
      const falseReportOutput = await outputDirectory(f, falseReportOutputId);
      await assert.rejects(
        () =>
          runCapturedPdfParser({
            ...falseReportCommon,
            tableStructureBypass,
            outputId: falseReportOutputId,
            outputDirectory: falseReportOutput,
          }),
        (error) =>
          error instanceof ParserProcessError &&
          error.code === "output_invalid" &&
          error.message === "parser conversion table bypass match is invalid",
      );

      const outOfRangeBundle = JSON.parse(
        await readFile(policyResult.normalizedBundle.path, "utf8"),
      );
      const parserDescriptor = outOfRangeBundle.parserFingerprint;
      assert.equal(
        fingerprintDescriptorForTest(parserDescriptor),
        parserDescriptor.fingerprint,
      );
      parserDescriptor.configuration.tableStructureBypass[0].pages = [3];
      parserDescriptor.fingerprint =
        fingerprintDescriptorForTest(parserDescriptor);
      const extraction = outOfRangeBundle.extractionFingerprint;
      extraction.parserFingerprint = parserDescriptor.fingerprint;
      const extractionConfiguration = {
        schemaVersion: 1,
        parserFingerprint: parserDescriptor.fingerprint,
        implementationSha256: extraction.implementationSha256,
        configuration: extraction.configuration,
      };
      extraction.extractionConfigurationFingerprint = sha256(
        Buffer.from(canonicalJsonForTest(extractionConfiguration), "utf8"),
      );
      extraction.fingerprint = sha256(
        Buffer.concat([
          Buffer.from("kith-parsed-extraction:v1\0", "utf8"),
          Buffer.from(
            canonicalJsonForTest([
              parserDescriptor.fingerprint,
              policyResult.rawArtifact.sha256,
              extraction.extractionConfigurationFingerprint,
            ]),
            "utf8",
          ),
        ]),
      );
      await writeFile(
        policyResult.normalizedBundle.path,
        JSON.stringify(outOfRangeBundle),
      );
      await assert.rejects(
        () =>
          inspectCapturedPdfParserOutput({
            capture: f.common.capture,
            outputRoot: f.outputRoot,
            outputIntent: policyIntent,
            expectedParserFingerprint: parserDescriptor.fingerprint,
            expectedExtractionConfigurationFingerprint:
              extraction.extractionConfigurationFingerprint,
            expectedModelManifestSha256: policyResult.modelManifestSha256,
          }),
        (error) =>
          error instanceof ParserProcessError &&
          error.code === "output_invalid" &&
          error.message === "normalized page or gap count is invalid",
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
  "retains a scanned source field with exact provenance in both table modes",
  { skip: !hasRuntime, timeout: 240_000 },
  async () => {
    const f = await fixture("image-clear.pdf");
    try {
      for (const tableStructure of ["on", "off"]) {
        const outputId = randomUUID();
        const output = await outputDirectory(f, outputId);
        const result = await runCapturedPdfParser({
          ...f.common,
          tableStructure,
          outputId,
          outputDirectory: output,
        });
        assertQuotedSourceField(result, 1, "Amount due: USD 42.00");
        await assertExactRawProvenance(result);
      }
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
