import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  readlink,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { spawn, type ChildProcess } from "node:child_process";

import { inspectCapturedPdf, type CapturedPdf } from "./captureStore.js";
import type { PdfDocQaConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PATH_BYTES = 4_096;
const MAX_JSON_NODES = 500_000;
const MAX_JSON_DEPTH = 48;
const MAX_MODEL_LOCK_BYTES = 4 * 1024 * 1024;
const PROCESS_MONITOR_TIMEOUT_MS = 1_000;
const EXPECTED_RUNTIME_VERSIONS = {
  docling: "2.126.0",
  "docling-core": "2.95.0",
  "docling-ibm-models": "4.0.2",
  "docling-parse": "7.17.0",
  onnxruntime: "1.23.2",
  rapidocr: "3.9.2",
  pypdfium2: "5.13.0",
  numpy: "2.5.3",
} as const;

export const DEFAULT_PARSER_PROCESS_LIMITS: ParserProcessLimits = {
  wallDeadlineMs: 600_000,
  cpuSeconds: 1_800,
  maxRssBytes: 8 * 1024 * 1024 * 1024,
  maxProcessCount: 16,
  pollIntervalMs: 50,
  maxStdoutBytes: 16 * 1024,
  maxStderrBytes: 64 * 1024,
  maxRawBytes: 64 * 1024 * 1024,
  maxBundleBytes: 4 * 1024 * 1024,
  maxOpenFiles: 256,
};

export type ParserProcessFailureCode =
  | "unsupported_platform"
  | "invalid_input"
  | "unsafe_path"
  | "executable_mismatch"
  | "model_lock_mismatch"
  | "destination_exists"
  | "sandbox_failed"
  | "network_not_denied"
  | "process_escape_not_denied"
  | "process_timeout"
  | "cpu_limit_exceeded"
  | "monitor_failed"
  | "monitored_rss_exceeded"
  | "process_count_exceeded"
  | "output_limit_exceeded"
  | "conversion_failed"
  | "output_invalid"
  | "execution_prerequisite_missing"
  | "input_digest_mismatch"
  | "invalid_opaque_name"
  | "runtime_mismatch"
  | "model_assets_invalid"
  | "conversion_output_invalid"
  | "page_limit_exceeded"
  | "retained_text_too_large"
  | "lossless_output_too_large"
  | "bundle_too_large";

const LAUNCHER_FAILURE_CODES = [
  "execution_prerequisite_missing",
  "invalid_input",
  "input_digest_mismatch",
  "invalid_opaque_name",
  "runtime_mismatch",
  "model_assets_invalid",
  "conversion_failed",
  "conversion_output_invalid",
  "page_limit_exceeded",
  "retained_text_too_large",
  "lossless_output_too_large",
  "bundle_too_large",
] as const satisfies readonly ParserProcessFailureCode[];

type LauncherFailureCode = (typeof LAUNCHER_FAILURE_CODES)[number];

export class ParserProcessError extends Error {
  constructor(
    readonly code: ParserProcessFailureCode,
    message: string,
  ) {
    super(`Parser process failed: ${message}`);
    this.name = "ParserProcessError";
  }
}

export type ParserProcessLimits = {
  wallDeadlineMs: number;
  cpuSeconds: number;
  maxRssBytes: number;
  maxProcessCount: number;
  pollIntervalMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxRawBytes: number;
  maxBundleBytes: number;
  maxOpenFiles: number;
};

export type RunCapturedPdfParserInput = {
  capture: CapturedPdf;
  outputDirectory: string;
  outputId: string;
  pythonExecutable: string;
  expectedPythonSha256: string;
  launcherPath: string;
  expectedLauncherSha256: string;
  packageRoot: string;
  modelAssetsPath: string;
  modelLockPath: string;
  expectedModelLockSha256: string;
  tableStructure?: ParserTableStructure;
  tableStructureBypass?: ParserTableStructureBypass;
  limits?: ParserProcessLimits;
};

export type ParserTableStructure = "on" | "off";
export type ParserTableStructureBypass = NonNullable<
  PdfDocQaConfig["parser"]["tableStructureBypass"]
>;

export type PreparePdfDocQaProfileInput = {
  pythonExecutable: string;
  expectedPythonSha256: string;
  launcherPath: string;
  expectedLauncherSha256: string;
  packageRoot: string;
  modelAssetsPath: string;
  modelLockPath: string;
  expectedModelLockSha256: string;
  tableStructure?: ParserTableStructure;
  tableStructureBypass?: ParserTableStructureBypass;
  workRoot: string;
  work: ParserProfileWorkIntent;
  limits?: ParserProcessLimits;
};

export type ParserProfileWorkIntent = {
  workId: string;
  path: string;
  workRoot: { device: number; inode: number };
  workDirectory: { device: number; inode: number };
};

export type PreparedPdfDocQaProfile = {
  state: "ready";
  parserFingerprint: string;
  extractionConfigurationFingerprint: string;
  modelManifestSha256: string;
  isolation: {
    networkDenied: true;
    processForkDenied: true;
    processExecDenied: true;
    rssBoundary: "sampled_process_tree";
    pollIntervalMs: number;
    monitorCommandTimeoutMs: number;
  };
};

export type ParsedArtifactIdentity = {
  path: string;
  device: number;
  inode: number;
  sha256: string;
  byteLength: number;
  mediaType: "application/vnd.docling+json" | "application/json";
};

export type ParserOutputIntent = {
  outputId: string;
  outputRoot: { device: number; inode: number };
  outputDirectory: { device: number; inode: number };
};

export type ValidatedNormalizedBundle = {
  schemaVersion: 1;
  candidate: "docling-standard-cpu-ocr";
  sourceSha256: string;
  parserFingerprint: Record<string, unknown>;
  extractionFingerprint: Record<string, unknown>;
  pages: Array<{
    page: number;
    text: string;
    segments: Array<{
      id: string;
      text: string;
      startUtf16: number;
      endUtf16: number;
      citable: true;
      locator:
        | {
            kind: "docling_item";
            itemRef: string;
            provenance:
              Record<string, unknown> | Array<Record<string, unknown>>;
            doclingCharspanSemantics: "item_local_python_codepoints_not_evidence";
          }
        | {
            kind: "docling_table_row";
            tableProvenance: Record<string, unknown>;
            cells: Array<Record<string, unknown>>;
          }
        | {
            kind: "docling_item_slice";
            itemRef: string;
            provenance: Array<Record<string, unknown>>;
            provenanceIndexes: [number, number];
            itemTextCharspan: [number, number];
            doclingCharspanSemantics: "item_local_python_codepoints";
          };
    }>;
  }>;
  mappingGaps: Array<{
    kind: "ambiguous_text_provenance" | "ambiguous_table_provenance";
    item: number;
  }>;
};

export type ResolvedParserLocator = {
  kind: "item" | "table";
  ref: string;
};

export type ValidatedNormalizedBundleResult = {
  bundle: ValidatedNormalizedBundle;
  resolvedLocators: Record<string, ResolvedParserLocator>;
};

export type DurableParserOutputArtifacts = {
  outputId: string;
  outputRoot: { device: number; inode: number };
  outputDirectory: { device: number; inode: number };
  sourceSha256: string;
  rawArtifact: ParsedArtifactIdentity;
  normalizedBundle: ParsedArtifactIdentity;
  parserFingerprint: string;
  extractionConfigurationFingerprint: string;
  extractionFingerprint: string;
  modelManifestSha256: string;
  pageCount: number;
};

export type RecoveredParserOutput = {
  state: "recovered";
  artifacts: DurableParserOutputArtifacts;
  validated: ValidatedNormalizedBundleResult;
  tableStructureBypassPages: number[];
};

export type CapturedPdfParserResult = {
  state: "complete";
  outputId: string;
  sourceSha256: string;
  rawArtifact: ParsedArtifactIdentity;
  normalizedBundle: ParsedArtifactIdentity;
  parserFingerprint: string;
  extractionConfigurationFingerprint: string;
  extractionFingerprint: string;
  modelManifestSha256: string;
  pageCount: number;
  tableStructureBypassPages: number[];
  artifacts: DurableParserOutputArtifacts;
  validated: ValidatedNormalizedBundleResult;
  peakRssBytes: number;
  elapsedMs: number;
  isolation: {
    networkDenied: true;
    processForkDenied: true;
    processExecDenied: true;
    rssBoundary: "sampled_process_tree";
    pollIntervalMs: number;
    monitorCommandTimeoutMs: number;
  };
};

type DirectoryIdentity = { path: string; device: number; inode: number };
type FileIdentity = {
  path: string;
  device: number;
  inode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};
type ProcessResult = {
  stdout: Buffer;
  stderr: Buffer;
  peakRssBytes: number;
  elapsedMs: number;
  launcherFailure?: LauncherFailureCode;
};

function isLauncherFailureCode(value: unknown): value is LauncherFailureCode {
  return (
    typeof value === "string" &&
    (LAUNCHER_FAILURE_CODES as readonly string[]).includes(value)
  );
}

function fail(code: ParserProcessFailureCode, message: string): never {
  throw new ParserProcessError(code, message);
}

function safeRethrow(
  error: unknown,
  code: ParserProcessFailureCode,
  message: string,
): never {
  if (error instanceof ParserProcessError) throw error;
  fail(code, message);
}

function uid(): number {
  const value = process.getuid?.();
  if (value === undefined)
    fail("unsupported_platform", "POSIX ownership checks are unavailable");
  return value;
}

function requiredPlatform(): void {
  if (
    process.platform !== "darwin" ||
    typeof constants.O_NOFOLLOW !== "number" ||
    constants.O_NOFOLLOW === 0 ||
    typeof constants.O_NONBLOCK !== "number"
  ) {
    fail(
      "unsupported_platform",
      "the required macOS process boundary is unavailable",
    );
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index])
  );
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function absolutePath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    /[\x00-\x1f\x7f]/.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
  ) {
    fail("invalid_input", `${label} is invalid`);
  }
  return resolve(value);
}

function contains(root: string, child: string): boolean {
  return child === root || child.startsWith(`${root}${sep}`);
}

function rejectBroadReadRoot(path: string, label: string): void {
  const home = resolve(homedir());
  const broad = new Set(["/", "/Users", "/System", "/usr", "/Library", home]);
  if (broad.has(path) || path.split(sep).filter(Boolean).length < 3) {
    fail("unsafe_path", `${label} is too broad`);
  }
}

async function trustedAncestors(path: string, label: string): Promise<void> {
  let current = path;
  const currentUid = uid();
  for (let depth = 0; ; depth += 1) {
    if (depth >= 256) fail("unsafe_path", `${label} ancestry is too deep`);
    const entry = await lstat(current).catch(() =>
      fail("unsafe_path", `${label} ancestor is unavailable`),
    );
    const stickyRoot = entry.uid === 0 && (entry.mode & 0o1000) !== 0;
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      (entry.uid !== currentUid && entry.uid !== 0) ||
      ((entry.mode & 0o022) !== 0 && !stickyRoot)
    ) {
      fail("unsafe_path", `${label} ancestor is not trusted`);
    }
    const next = dirname(current);
    if (next === current) return;
    current = next;
  }
}

async function trustedDirectory(
  input: string,
  label: string,
  options: { private: boolean; rejectBroad: boolean },
): Promise<DirectoryIdentity> {
  const requested = absolutePath(input, label);
  if (options.rejectBroad) rejectBroadReadRoot(requested, label);
  const before = await lstat(requested).catch(() =>
    fail("unsafe_path", `${label} is unavailable`),
  );
  const canonical = await realpath(requested).catch(() =>
    fail("unsafe_path", `${label} cannot be resolved`),
  );
  const currentUid = uid();
  if (
    canonical !== requested ||
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    before.uid !== currentUid ||
    (before.mode & (options.private ? 0o077 : 0o022)) !== 0
  ) {
    fail("unsafe_path", `${label} is not a trusted directory`);
  }
  await trustedAncestors(canonical, label);
  const after = await lstat(canonical).catch(() =>
    fail("unsafe_path", `${label} changed during validation`),
  );
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    !after.isDirectory()
  ) {
    fail("unsafe_path", `${label} changed during validation`);
  }
  return { path: canonical, device: after.dev, inode: after.ino };
}

async function recheckDirectory(
  expected: DirectoryIdentity,
  label: string,
): Promise<void> {
  const entry = await lstat(expected.path).catch(() =>
    fail("unsafe_path", `${label} changed`),
  );
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    entry.uid !== uid() ||
    (entry.mode & 0o077) !== 0 ||
    entry.dev !== expected.device ||
    entry.ino !== expected.inode ||
    (await realpath(expected.path).catch(() => "")) !== expected.path
  ) {
    fail("unsafe_path", `${label} changed`);
  }
}

async function boundedFile(
  pathInput: string,
  label: string,
  maximum: number,
  options: { executable?: boolean; allowSymlink?: boolean } = {},
): Promise<{
  identity: FileIdentity;
  bytes: Buffer;
  requested: string;
  canonical: string;
}> {
  const requested = absolutePath(pathInput, label);
  const before = await lstat(requested).catch(() =>
    fail("unsafe_path", `${label} is unavailable`),
  );
  const canonical = await realpath(requested).catch(() =>
    fail("unsafe_path", `${label} cannot be resolved`),
  );
  if (
    (!options.allowSymlink && canonical !== requested) ||
    (!options.allowSymlink && before.isSymbolicLink())
  ) {
    fail("unsafe_path", `${label} must use its canonical path`);
  }
  await trustedAncestors(dirname(requested), label);
  await trustedAncestors(dirname(canonical), label);
  const actual = await lstat(canonical).catch(() =>
    fail("unsafe_path", `${label} is unavailable`),
  );
  if (
    actual.isSymbolicLink() ||
    !actual.isFile() ||
    (actual.uid !== uid() && actual.uid !== 0) ||
    (actual.mode & 0o022) !== 0 ||
    !integer(actual.size, 1, maximum)
  ) {
    fail("unsafe_path", `${label} is not a trusted regular file`);
  }
  if (options.executable) {
    await access(canonical, constants.X_OK).catch(() =>
      fail("unsafe_path", `${label} is not executable`),
    );
  }
  const handle = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => fail("unsafe_path", `${label} cannot be opened safely`));
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== actual.dev ||
      opened.ino !== actual.ino ||
      opened.size !== actual.size
    ) {
      fail("unsafe_path", `${label} changed during validation`);
    }
    const bytes = Buffer.alloc(actual.size);
    let offset = 0;
    while (offset < bytes.length) {
      const part = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (part.bytesRead === 0) break;
      offset += part.bytesRead;
    }
    const final = await handle.stat();
    if (
      offset !== bytes.length ||
      final.dev !== actual.dev ||
      final.ino !== actual.ino ||
      final.size !== actual.size ||
      final.mtimeMs !== actual.mtimeMs ||
      final.ctimeMs !== actual.ctimeMs
    ) {
      fail("unsafe_path", `${label} changed during validation`);
    }
    return {
      identity: {
        path: canonical,
        device: actual.dev,
        inode: actual.ino,
        size: actual.size,
        mtimeMs: actual.mtimeMs,
        ctimeMs: actual.ctimeMs,
      },
      bytes,
      requested,
      canonical,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateLimits(
  value: ParserProcessLimits | undefined,
): ParserProcessLimits {
  const selected = value ?? DEFAULT_PARSER_PROCESS_LIMITS;
  const keys = Object.keys(DEFAULT_PARSER_PROCESS_LIMITS);
  if (!selected || typeof selected !== "object" || !exactKeys(selected, keys)) {
    fail("invalid_input", "parser limits are invalid");
  }
  if (
    !integer(selected.wallDeadlineMs, 1_000, 10 * 60_000) ||
    !integer(selected.cpuSeconds, 1, 1_800) ||
    !integer(selected.maxRssBytes, 64 * 1024 * 1024, 8 * 1024 * 1024 * 1024) ||
    !integer(selected.maxProcessCount, 1, 64) ||
    !integer(selected.pollIntervalMs, 25, 250) ||
    !integer(selected.maxStdoutBytes, 1, 64 * 1024) ||
    !integer(selected.maxStderrBytes, 1, 1024 * 1024) ||
    !integer(selected.maxRawBytes, 1, 64 * 1024 * 1024) ||
    !integer(selected.maxBundleBytes, 1, 4 * 1024 * 1024) ||
    !integer(selected.maxOpenFiles, 32, 1024)
  ) {
    fail("invalid_input", "parser limits are invalid");
  }
  return { ...selected };
}

function sbplString(value: string): string {
  return JSON.stringify(value).replaceAll("\\/", "/");
}

function sandboxProfile(paths: {
  pythonExecutable: string;
  pythonTarget: string;
  pythonEnvironmentRoot: string;
  pythonRuntimeRoot: string;
  packageRoot: string;
  modelAssets: string;
  modelLock: string;
  capture?: string;
  output: string;
}): string {
  const literalReads = [
    paths.modelLock,
    ...(paths.capture === undefined ? [] : [paths.capture]),
    "/",
    "/dev/urandom",
    "/private/etc/apache2/mime.types",
    "/private/etc/ssl/openssl.cnf",
  ];
  const subtreeReads = [
    "/System/Library",
    "/System/Volumes/Preboot/Cryptexes/OS",
    "/Library/Apple",
    "/Library/Fonts",
    "/usr/lib",
    "/usr/share",
    "/private/var/db/dyld",
    "/private/var/db/timezone",
    paths.pythonEnvironmentRoot,
    paths.pythonRuntimeRoot,
    paths.packageRoot,
    paths.modelAssets,
    paths.output,
  ];
  const metadataReads = new Set<string>(["/etc", "/tmp", "/var"]);
  for (const path of [...literalReads, ...subtreeReads]) {
    let current = path;
    while (true) {
      metadataReads.add(current);
      const next = dirname(current);
      if (next === current) break;
      current = next;
    }
  }
  return [
    "(version 1)",
    "(deny default)",
    "(deny network*)",
    `(allow process-exec (literal ${sbplString(paths.pythonExecutable)}) (literal ${sbplString(paths.pythonTarget)}))`,
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix-shm)",
    "(allow iokit-open)",
    "(allow signal (target self))",
    '(allow file-read* file-write* (literal "/dev/null"))',
    ...[...metadataReads].map(
      (path) => `(allow file-read-metadata (literal ${sbplString(path)}))`,
    ),
    ...literalReads.map(
      (path) => `(allow file-read* (literal ${sbplString(path)}))`,
    ),
    ...subtreeReads.map(
      (path) => `(allow file-read* (subpath ${sbplString(path)}))`,
    ),
    `(allow file-write* (subpath ${sbplString(paths.output)}))`,
  ].join("\n");
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function processTree(
  rootPid: number,
): Promise<{ count: number; rssBytes: number }> {
  let stdout: string;
  try {
    const result = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,rss="], {
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maxBuffer: 8 * 1024 * 1024,
      timeout: PROCESS_MONITOR_TIMEOUT_MS,
    });
    stdout = result.stdout;
  } catch {
    fail("monitor_failed", "process monitor failed");
  }
  const rows = new Map<number, { parent: number; rss: number }>();
  const lines = stdout.split("\n");
  if (lines.length > 100_000)
    fail("monitor_failed", "process inventory exceeded its bound");
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 3)
      fail("monitor_failed", "process inventory was malformed");
    const [pid, parent, rss] = parts.map(Number);
    if (
      [pid, parent, rss].some(
        (item) => item === undefined || !Number.isSafeInteger(item) || item < 0,
      )
    ) {
      fail("monitor_failed", "process inventory was malformed");
    }
    rows.set(pid!, { parent: parent!, rss: rss! });
  }
  const selected = new Set([rootPid]);
  for (let pass = 0; pass <= rows.size; pass += 1) {
    let changed = false;
    for (const [pid, row] of rows) {
      if (!selected.has(pid) && selected.has(row.parent)) {
        selected.add(pid);
        changed = true;
      }
    }
    if (!changed) break;
    if (pass === rows.size)
      fail("monitor_failed", "process inventory contained a cycle");
  }
  let rssKiB = 0;
  for (const pid of selected) rssKiB += rows.get(pid)?.rss ?? 0;
  if (!Number.isSafeInteger(rssKiB))
    fail("monitor_failed", "process RSS was invalid");
  return { count: selected.size, rssBytes: rssKiB * 1024 };
}

async function runSandboxed(
  profile: string,
  pythonExecutable: string,
  launcherPath: string,
  modeArgs: readonly string[],
  env: NodeJS.ProcessEnv,
  limits: ParserProcessLimits,
  allowStructuredFailure = false,
): Promise<ProcessResult> {
  const started = Date.now();
  const child = spawn(
    "/usr/bin/sandbox-exec",
    ["-p", profile, pythonExecutable, launcherPath, ...modeArgs],
    {
      cwd: dirname(launcherPath),
      detached: true,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let peakRssBytes = 0;
  let failure: ParserProcessError | undefined;
  let closed = false;
  const wallDeadline = setTimeout(() => {
    if (closed) return;
    failure ??= new ParserProcessError(
      "process_timeout",
      "parser exceeded its wall deadline",
    );
    killGroup(child);
  }, limits.wallDeadlineMs);
  wallDeadline.unref();
  const completion = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolvePromise, reject) => {
    child.once("error", () =>
      reject(new ParserProcessError("sandbox_failed", "sandbox did not start")),
    );
    child.once("close", (code, signal) => {
      closed = true;
      resolvePromise({ code, signal });
    });
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= limits.maxStdoutBytes) stdout.push(Buffer.from(chunk));
    else
      failure ??= new ParserProcessError(
        "output_limit_exceeded",
        "parser stdout exceeded its bound",
      );
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= limits.maxStderrBytes) stderr.push(Buffer.from(chunk));
    else
      failure ??= new ParserProcessError(
        "output_limit_exceeded",
        "parser stderr exceeded its bound",
      );
  });
  const monitor = (async () => {
    while (!closed && !failure) {
      if (Date.now() - started > limits.wallDeadlineMs) {
        failure = new ParserProcessError(
          "process_timeout",
          "parser exceeded its wall deadline",
        );
        break;
      }
      if (child.pid !== undefined) {
        try {
          const usage = await processTree(child.pid);
          peakRssBytes = Math.max(peakRssBytes, usage.rssBytes);
          if (!failure && usage.count > limits.maxProcessCount) {
            failure = new ParserProcessError(
              "process_count_exceeded",
              "parser process count exceeded its bound",
            );
          } else if (!failure && usage.rssBytes > limits.maxRssBytes) {
            failure = new ParserProcessError(
              "monitored_rss_exceeded",
              "parser exceeded its monitored RSS boundary",
            );
          }
        } catch (error) {
          failure ??=
            error instanceof ParserProcessError
              ? error
              : new ParserProcessError(
                  "monitor_failed",
                  "process monitor failed",
                );
        }
      }
      if (!closed && !failure)
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, limits.pollIntervalMs),
        );
    }
    if (failure) killGroup(child);
  })();
  let status: { code: number | null; signal: NodeJS.Signals | null };
  try {
    status = await completion;
  } catch (error) {
    clearTimeout(wallDeadline);
    killGroup(child);
    await monitor.catch(() => undefined);
    safeRethrow(error, "sandbox_failed", "sandbox failed");
  }
  clearTimeout(wallDeadline);
  await monitor;
  if (failure) throw failure;
  if (
    stdoutBytes > limits.maxStdoutBytes ||
    stderrBytes > limits.maxStderrBytes
  ) {
    fail("output_limit_exceeded", "parser output exceeded its bound");
  }
  const capturedStdout = Buffer.concat(stdout);
  if (status.code !== 0 || status.signal !== null) {
    if (status.signal === "SIGXCPU")
      fail("cpu_limit_exceeded", "parser exceeded its CPU limit");
    if (allowStructuredFailure && status.code === 2 && status.signal === null) {
      const result = parseLauncherResult(capturedStdout);
      if (
        exactKeys(result, ["state", "code"]) &&
        result.state === "failed" &&
        isLauncherFailureCode(result.code)
      ) {
        return {
          stdout: capturedStdout,
          stderr: Buffer.concat(stderr),
          peakRssBytes,
          elapsedMs: Date.now() - started,
          launcherFailure: result.code,
        };
      }
    }
    fail("conversion_failed", "parser returned failure");
  }
  return {
    stdout: capturedStdout,
    stderr: Buffer.concat(stderr),
    peakRssBytes,
    elapsedMs: Date.now() - started,
  };
}

export function parseBoundedParserJson(
  bytes: Buffer,
  maximum: number,
): unknown {
  if (bytes.length < 1 || bytes.length > maximum)
    fail("output_invalid", "parser JSON is outside its bound");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("output_invalid", "parser JSON is malformed");
  }
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES)
      fail("output_invalid", "parser JSON exceeds its node bound");
    if (depth > MAX_JSON_DEPTH)
      fail("output_invalid", "parser JSON exceeds its depth bound");
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
    } else if (current !== null && typeof current === "object") {
      for (const key of Object.keys(current)) {
        if (key === "__proto__" || key === "prototype" || key === "constructor")
          fail("output_invalid", "parser JSON contains a forbidden key");
        visit((current as Record<string, unknown>)[key], depth + 1);
      }
    } else if (typeof current === "number" && !Number.isFinite(current)) {
      fail("output_invalid", "parser JSON contains an invalid number");
    }
  };
  visit(value, 0);
  return value;
}

function canonicalJson(value: unknown): Buffer {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current !== null && typeof current === "object") {
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(current as object).sort()) {
        Object.defineProperty(result, key, {
          enumerable: true,
          value: normalize((current as Record<string, unknown>)[key]),
        });
      }
      return result;
    }
    return current;
  };
  return Buffer.from(JSON.stringify(normalize(value)), "utf8");
}

function fingerprint(value: unknown, pythonTimeoutFloat = false): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("output_invalid", "parser fingerprint is invalid");
  const record = value as Record<string, unknown>;
  if (!SHA256.test(String(record.fingerprint ?? "")))
    fail("output_invalid", "parser fingerprint is invalid");
  const fields = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (key !== "fingerprint")
      Object.defineProperty(fields, key, {
        enumerable: true,
        value: record[key],
      });
  let encoded = canonicalJson(fields);
  if (pythonTimeoutFloat) {
    const configuration = record.configuration;
    const timeout =
      configuration && typeof configuration === "object"
        ? (configuration as Record<string, unknown>).timeoutSeconds
        : undefined;
    if (!integer(timeout, 1, 480)) {
      fail("output_invalid", "parser timeout fingerprint field is invalid");
    }
    const text = encoded.toString("utf8");
    const needle = `\"timeoutSeconds\":${timeout}`;
    if (text.split(needle).length !== 2) {
      fail("output_invalid", "parser timeout fingerprint field is ambiguous");
    }
    encoded = Buffer.from(text.replace(needle, `${needle}.0`), "utf8");
  }
  if (digest(encoded) !== record.fingerprint)
    fail("output_invalid", "parser fingerprint does not match its fields");
  return record.fingerprint as string;
}

function validUtf16Boundary(text: string, offset: number): boolean {
  if (!integer(offset, 0, text.length)) return false;
  return (
    offset === 0 ||
    offset === text.length ||
    !(
      text.charCodeAt(offset - 1) >= 0xd800 &&
      text.charCodeAt(offset - 1) <= 0xdbff &&
      text.charCodeAt(offset) >= 0xdc00 &&
      text.charCodeAt(offset) <= 0xdfff
    )
  );
}

function finiteNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= 1_000_000_000
  );
}

function validateBoundingBox(value: unknown): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, ["b", "coord_origin", "l", "r", "t"])
  ) {
    fail("output_invalid", "locator bounding box is invalid");
  }
  const box = value as Record<string, unknown>;
  if (
    ![box.b, box.l, box.r, box.t].every(finiteNumber) ||
    !["BOTTOMLEFT", "TOPLEFT"].includes(String(box.coord_origin))
  ) {
    fail("output_invalid", "locator bounding box is invalid");
  }
}

function validateProvenance(value: unknown, page: number): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, ["bbox", "charspan", "page_no"])
  ) {
    fail("output_invalid", "locator provenance is invalid");
  }
  const provenance = value as Record<string, unknown>;
  validateBoundingBox(provenance.bbox);
  if (
    provenance.page_no !== page ||
    !Array.isArray(provenance.charspan) ||
    provenance.charspan.length !== 2 ||
    !integer(provenance.charspan[0], 0, 10_000_000) ||
    !integer(provenance.charspan[1], provenance.charspan[0], 10_000_000)
  ) {
    fail("output_invalid", "locator provenance is invalid");
  }
}

function validateItemProvenance(value: unknown, page: number): void {
  if (!Array.isArray(value)) {
    validateProvenance(value, page);
    return;
  }
  if (value.length < 2 || value.length > 256)
    fail("output_invalid", "item provenance span count is invalid");
  let priorEnd = -1;
  for (const span of value) {
    validateProvenance(span, page);
    const charspan = (span as Record<string, unknown>).charspan as number[];
    if (charspan[0]! < priorEnd)
      fail("output_invalid", "item provenance spans overlap or are unordered");
    priorEnd = charspan[1]!;
  }
}

function provenanceWhitespaceOnly(value: readonly string[]): boolean {
  return value.every((char) => {
    const codepoint = char.codePointAt(0)!;
    return (
      (codepoint >= 0x0009 && codepoint <= 0x000d) ||
      codepoint === 0x0020 ||
      codepoint === 0x0085 ||
      codepoint === 0x00a0 ||
      codepoint === 0x1680 ||
      (codepoint >= 0x2000 && codepoint <= 0x200a) ||
      codepoint === 0x2028 ||
      codepoint === 0x2029 ||
      codepoint === 0x202f ||
      codepoint === 0x205f ||
      codepoint === 0x3000
    );
  });
}

function multiSpanProvenanceCoversText(
  value: Record<string, unknown> | Array<Record<string, unknown>>,
  text: string,
): boolean {
  if (!Array.isArray(value)) return true;
  const codepoints = Array.from(text);
  let priorEnd = 0;
  for (const span of value) {
    const charspan = span.charspan as number[];
    const start = charspan[0]!;
    const end = charspan[1]!;
    if (
      end > codepoints.length ||
      !provenanceWhitespaceOnly(codepoints.slice(priorEnd, start))
    )
      return false;
    priorEnd = end;
  }
  return provenanceWhitespaceOnly(codepoints.slice(priorEnd));
}

type RawItemSlice = {
  page: number;
  provenanceStart: number;
  provenanceEnd: number;
  textStart: number;
  textEnd: number;
};

function rawCrossPageSlices(
  item: Record<string, unknown>,
  maximumPage: number,
): RawItemSlice[] | undefined {
  if (typeof item.text !== "string" || !Array.isArray(item.prov)) return;
  const provenance = item.prov;
  if (provenance.length < 2 || provenance.length > 256) return;
  const codepoints = Array.from(item.text);
  const groups: Array<{ page: number; start: number; end: number }> = [];
  let priorEnd = 0;
  let priorPage = 0;
  for (const [index, value] of provenance.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const span = value as Record<string, unknown>;
    if (
      !integer(span.page_no, 1, maximumPage) ||
      Number(span.page_no) < priorPage ||
      !Array.isArray(span.charspan) ||
      span.charspan.length !== 2 ||
      !integer(span.charspan[0], priorEnd, codepoints.length) ||
      !integer(
        span.charspan[1],
        Number(span.charspan[0]) + 1,
        codepoints.length,
      ) ||
      !provenanceWhitespaceOnly(
        codepoints.slice(priorEnd, Number(span.charspan[0])),
      )
    )
      return;
    const page = Number(span.page_no);
    if (!groups.length || groups.at(-1)!.page !== page)
      groups.push({ page, start: index, end: index + 1 });
    else groups.at(-1)!.end = index + 1;
    priorEnd = Number(span.charspan[1]);
    priorPage = page;
  }
  if (
    groups.length < 2 ||
    !provenanceWhitespaceOnly(codepoints.slice(priorEnd)) ||
    groups.some(
      (group, index) => index > 0 && groups[index - 1]!.page >= group.page,
    )
  )
    return;
  const slices: RawItemSlice[] = [];
  for (const [ordinal, group] of groups.entries()) {
    const first = provenance[group.start] as Record<string, unknown>;
    const next = provenance[groups[ordinal + 1]?.start ?? -1] as
      Record<string, unknown> | undefined;
    const textStart =
      ordinal === 0 ? 0 : Number((first.charspan as number[])[0]);
    const textEnd = next
      ? Number((next.charspan as number[])[0])
      : codepoints.length;
    if (!normalizedRawText(codepoints.slice(textStart, textEnd).join("")))
      return;
    slices.push({
      page: group.page,
      provenanceStart: group.start,
      provenanceEnd: group.end,
      textStart,
      textEnd,
    });
  }
  return slices;
}

function validateItemSliceLocator(
  locator: Record<string, unknown>,
  page: number,
  maximumPage: number,
): void {
  if (
    !exactKeys(locator, [
      "kind",
      "itemRef",
      "provenance",
      "provenanceIndexes",
      "itemTextCharspan",
      "doclingCharspanSemantics",
    ]) ||
    typeof locator.itemRef !== "string" ||
    !locator.itemRef ||
    locator.doclingCharspanSemantics !== "item_local_python_codepoints" ||
    !Array.isArray(locator.provenance) ||
    locator.provenance.length < 2 ||
    locator.provenance.length > 256 ||
    !Array.isArray(locator.provenanceIndexes) ||
    locator.provenanceIndexes.length !== 2 ||
    !integer(locator.provenanceIndexes[0], 0, locator.provenance.length - 1) ||
    !integer(
      locator.provenanceIndexes[1],
      Number(locator.provenanceIndexes[0]) + 1,
      locator.provenance.length,
    ) ||
    !Array.isArray(locator.itemTextCharspan) ||
    locator.itemTextCharspan.length !== 2 ||
    !integer(locator.itemTextCharspan[0], 0, 10_000_000) ||
    !integer(
      locator.itemTextCharspan[1],
      Number(locator.itemTextCharspan[0]) + 1,
      10_000_000,
    )
  )
    fail("output_invalid", "item slice locator is invalid");
  let priorEnd = -1;
  let priorPage = 0;
  for (const [index, span] of locator.provenance.entries()) {
    if (!span || typeof span !== "object" || Array.isArray(span))
      fail("output_invalid", "item slice provenance is invalid");
    const record = span as Record<string, unknown>;
    const spanPage = Number(record.page_no);
    validateProvenance(record, spanPage);
    if (
      !integer(spanPage, 1, maximumPage) ||
      spanPage < priorPage ||
      Number((record.charspan as number[])[0]) < priorEnd
    )
      fail("output_invalid", "item slice provenance is unordered");
    const selected =
      index >= Number(locator.provenanceIndexes[0]) &&
      index < Number(locator.provenanceIndexes[1]);
    if (selected !== (spanPage === page))
      fail("output_invalid", "item slice page selection is invalid");
    priorEnd = Number((record.charspan as number[])[1]);
    priorPage = spanPage;
  }
}

function validateTableCell(value: unknown): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, [
      "bbox",
      "col_span",
      "column_header",
      "end_col_offset_idx",
      "end_row_offset_idx",
      "fillable",
      "row_header",
      "row_section",
      "row_span",
      "start_col_offset_idx",
      "start_row_offset_idx",
      "text",
    ])
  ) {
    fail("output_invalid", "table cell locator is invalid");
  }
  const cell = value as Record<string, unknown>;
  validateBoundingBox(cell.bbox);
  if (
    !integer(cell.start_col_offset_idx, 0, 4096) ||
    !integer(cell.end_col_offset_idx, cell.start_col_offset_idx + 1, 4096) ||
    !integer(cell.start_row_offset_idx, 0, 4096) ||
    !integer(cell.end_row_offset_idx, cell.start_row_offset_idx + 1, 4096) ||
    !integer(cell.col_span, 1, 4096) ||
    !integer(cell.row_span, 1, 4096) ||
    typeof cell.column_header !== "boolean" ||
    typeof cell.row_header !== "boolean" ||
    typeof cell.row_section !== "boolean" ||
    typeof cell.fillable !== "boolean" ||
    typeof cell.text !== "string"
  ) {
    fail("output_invalid", "table cell locator is invalid");
  }
}

type ValidatedParserFingerprint = {
  fingerprint: string;
  tableStructure: ParserTableStructure;
  tableStructureBypass?: NormalizedTableStructureBypass;
};

type NormalizedTableStructureBypass = Array<{
  sourceSha256: string;
  pages: number[];
}>;

function requestedTableStructure(value: unknown): ParserTableStructure {
  if (value === undefined || value === "on") return "on";
  if (value === "off") return "off";
  fail("invalid_input", "parser table structure mode is invalid");
}

function requestedTableStructureBypass(
  value: unknown,
): NormalizedTableStructureBypass | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_input", "parser table structure bypass policy is invalid");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 32)
    fail("invalid_input", "parser table structure bypass policy is invalid");
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return entries.map(([sourceSha256, valuePages]) => {
    if (
      !SHA256.test(sourceSha256) ||
      !Array.isArray(valuePages) ||
      valuePages.length < 1 ||
      valuePages.length > 64
    )
      fail("invalid_input", "parser table structure bypass policy is invalid");
    const pages = Array.from(valuePages, (page) => {
      if (!integer(page, 1, 64))
        fail(
          "invalid_input",
          "parser table structure bypass policy is invalid",
        );
      return page as number;
    });
    if (pages.some((page, index) => index > 0 && page <= pages[index - 1]!))
      fail("invalid_input", "parser table structure bypass policy is invalid");
    return { sourceSha256, pages };
  });
}

function tableStructureBypassArgument(
  value: NormalizedTableStructureBypass | undefined,
): string[] {
  if (value === undefined) return [];
  return [
    "--table-structure-bypass",
    JSON.stringify(
      Object.fromEntries(
        value.map(({ sourceSha256, pages }) => [sourceSha256, pages]),
      ),
    ),
  ];
}

function sameTableStructureBypass(
  left: NormalizedTableStructureBypass | undefined,
  right: NormalizedTableStructureBypass | undefined,
): boolean {
  return canonicalIdentity(left ?? null) === canonicalIdentity(right ?? null);
}

function matchedTableStructureBypassPages(
  policy: NormalizedTableStructureBypass | undefined,
  sourceSha256: string,
): number[] {
  return (
    policy?.find((entry) => entry.sourceSha256 === sourceSha256)?.pages ?? []
  );
}

function descriptorTableStructureBypass(
  value: unknown,
): NormalizedTableStructureBypass {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32)
    fail("output_invalid", "parser table structure bypass policy is invalid");
  const result: NormalizedTableStructureBypass = [];
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !exactKeys(entry, ["sourceSha256", "pages"])
    )
      fail("output_invalid", "parser table structure bypass policy is invalid");
    const record = entry as Record<string, unknown>;
    const sourceSha256 = record.sourceSha256;
    const pagesValue = record.pages;
    if (
      typeof sourceSha256 !== "string" ||
      !SHA256.test(sourceSha256) ||
      !Array.isArray(pagesValue) ||
      pagesValue.length < 1 ||
      pagesValue.length > 64
    )
      fail("output_invalid", "parser table structure bypass policy is invalid");
    const pages = Array.from(pagesValue, (page) => {
      if (!integer(page, 1, 64))
        fail(
          "output_invalid",
          "parser table structure bypass policy is invalid",
        );
      return page as number;
    });
    if (
      pages.some((page, index) => index > 0 && page <= pages[index - 1]!) ||
      (result.length > 0 &&
        sourceSha256 <= result[result.length - 1]!.sourceSha256)
    )
      fail("output_invalid", "parser table structure bypass policy is invalid");
    result.push({ sourceSha256, pages });
  }
  return result;
}

function validateParserFingerprint(
  value: unknown,
  modelManifestSha256: string,
): ValidatedParserFingerprint {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "runtime",
      "modelManifestSha256",
      "implementationSha256",
      "configuration",
      "fingerprint",
    ])
  ) {
    fail("output_invalid", "parser fingerprint shape is invalid");
  }
  const parser = value as Record<string, unknown>;
  const runtime = parser.runtime;
  const configuration = parser.configuration;
  if (
    ![1, 2, 3].includes(parser.schemaVersion as number) ||
    parser.modelManifestSha256 !== modelManifestSha256 ||
    !SHA256.test(String(parser.implementationSha256 ?? "")) ||
    !runtime ||
    typeof runtime !== "object" ||
    Array.isArray(runtime) ||
    !exactKeys(runtime, ["python", "versions"]) ||
    (runtime as Record<string, unknown>).python !== "3.12.12" ||
    !(runtime as Record<string, unknown>).versions ||
    typeof (runtime as Record<string, unknown>).versions !== "object" ||
    Array.isArray((runtime as Record<string, unknown>).versions) ||
    !exactKeys(
      (runtime as Record<string, unknown>).versions as object,
      Object.keys(EXPECTED_RUNTIME_VERSIONS),
    ) ||
    Object.entries(EXPECTED_RUNTIME_VERSIONS).some(
      ([name, version]) =>
        (
          (runtime as Record<string, unknown>).versions as Record<
            string,
            unknown
          >
        )[name] !== version,
    ) ||
    !configuration ||
    typeof configuration !== "object" ||
    Array.isArray(configuration) ||
    !exactKeys(
      configuration,
      parser.schemaVersion === 1
        ? [
            "maxInputBytes",
            "maxConversionPages",
            "outputFormat",
            "timeoutSeconds",
          ]
        : parser.schemaVersion === 2
          ? [
              "maxInputBytes",
              "maxConversionPages",
              "outputFormat",
              "timeoutSeconds",
              "tableStructure",
            ]
          : [
              "maxInputBytes",
              "maxConversionPages",
              "outputFormat",
              "timeoutSeconds",
              "tableStructure",
              "tableStructureBypass",
            ],
    )
  ) {
    fail("output_invalid", "parser fingerprint fields are invalid");
  }
  const config = configuration as Record<string, unknown>;
  const tableStructure: ParserTableStructure =
    parser.schemaVersion === 1
      ? "on"
      : (config.tableStructure as ParserTableStructure);
  const tableStructureBypass =
    parser.schemaVersion === 3
      ? descriptorTableStructureBypass(config.tableStructureBypass)
      : undefined;
  if (
    config.maxInputBytes !== 16 * 1024 * 1024 ||
    config.maxConversionPages !== 64 ||
    config.outputFormat !== "docling_lossless_canonical_json_v1" ||
    !integer(config.timeoutSeconds, 1, 480) ||
    ((parser.schemaVersion === 2 || parser.schemaVersion === 3) &&
      tableStructure !== "on" &&
      tableStructure !== "off") ||
    (parser.schemaVersion === 3 && tableStructure !== "on")
  ) {
    fail("output_invalid", "parser fingerprint configuration is invalid");
  }
  return {
    fingerprint: fingerprint(parser, true),
    tableStructure,
    ...(tableStructureBypass === undefined ? {} : { tableStructureBypass }),
  };
}

type ExtractionMappingFormat =
  "docling_utf16_pages_v1" | "docling_utf16_pages_v2";

type ExtractionConfiguration = {
  fingerprint: string;
  mappingFormat: ExtractionMappingFormat;
  maxPages: 32 | 64;
  maxRetainedUtf8Bytes: number;
  maxBundleBytes: number;
};

function validateExtractionConfigurationFingerprint(
  value: unknown,
  parserFingerprint: string,
): ExtractionConfiguration {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "parserFingerprint",
      "implementationSha256",
      "configuration",
      "fingerprint",
    ])
  )
    fail("output_invalid", "extraction configuration shape is invalid");
  const descriptor = value as Record<string, unknown>;
  const configuration = descriptor.configuration;
  if (
    descriptor.schemaVersion !== 1 ||
    descriptor.parserFingerprint !== parserFingerprint ||
    !SHA256.test(String(descriptor.implementationSha256 ?? "")) ||
    !configuration ||
    typeof configuration !== "object" ||
    Array.isArray(configuration) ||
    !exactKeys(configuration, [
      "mappingFormat",
      "maxPages",
      "maxRetainedUtf8Bytes",
      "maxBundleBytes",
    ])
  )
    fail("output_invalid", "extraction configuration is invalid");
  const config = configuration as Record<string, unknown>;
  const legacy =
    config.mappingFormat === "docling_utf16_pages_v1" &&
    config.maxPages === 32 &&
    config.maxRetainedUtf8Bytes === 256 * 1024 &&
    config.maxBundleBytes === 4 * 1024 * 1024;
  const current =
    config.mappingFormat === "docling_utf16_pages_v2" &&
    config.maxPages === 64 &&
    config.maxRetainedUtf8Bytes === 1024 * 1024 &&
    config.maxBundleBytes === 4 * 1024 * 1024;
  if (!legacy && !current)
    fail("output_invalid", "extraction configuration is invalid");
  return {
    fingerprint: fingerprint(descriptor),
    mappingFormat: config.mappingFormat as ExtractionMappingFormat,
    maxPages: config.maxPages as 32 | 64,
    maxRetainedUtf8Bytes: config.maxRetainedUtf8Bytes as number,
    maxBundleBytes: config.maxBundleBytes as number,
  };
}

function validateBundle(
  value: unknown,
  capture: CapturedPdf,
  modelManifestSha256: string,
  rawSha256: string,
): {
  parserFingerprint: string;
  tableStructure: ParserTableStructure;
  tableStructureBypassPages: number[];
  extractionConfigurationFingerprint: string;
  extractionMappingFormat: ExtractionMappingFormat;
  extractionFingerprint: string;
  pageCount: number;
  bundle: ValidatedNormalizedBundle;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("output_invalid", "normalized bundle is invalid");
  const bundle = value as Record<string, unknown>;
  if (
    !exactKeys(bundle, [
      "schemaVersion",
      "candidate",
      "sourceSha256",
      "parserFingerprint",
      "pages",
      "mappingGaps",
      "extractionFingerprint",
    ])
  ) {
    fail("output_invalid", "normalized bundle shape is invalid");
  }
  if (
    bundle.schemaVersion !== 1 ||
    bundle.candidate !== "docling-standard-cpu-ocr" ||
    bundle.sourceSha256 !== capture.sha256
  ) {
    fail("output_invalid", "normalized bundle identity is invalid");
  }
  const parserDescriptor = validateParserFingerprint(
    bundle.parserFingerprint,
    modelManifestSha256,
  );
  const parserFingerprint = parserDescriptor.fingerprint;
  const tableStructureBypassPages = matchedTableStructureBypassPages(
    parserDescriptor.tableStructureBypass,
    capture.sha256,
  );
  const extraction = bundle.extractionFingerprint;
  if (
    !extraction ||
    typeof extraction !== "object" ||
    Array.isArray(extraction)
  )
    fail("output_invalid", "extraction fingerprint is invalid");
  const extractionRecord = extraction as Record<string, unknown>;
  if (
    !exactKeys(extractionRecord, [
      "schemaVersion",
      "parserFingerprint",
      "parserArtifactSha256",
      "extractionConfigurationFingerprint",
      "implementationSha256",
      "configuration",
      "fingerprint",
    ]) ||
    extractionRecord.schemaVersion !== 2 ||
    extractionRecord.parserFingerprint !== parserFingerprint ||
    extractionRecord.parserArtifactSha256 !== rawSha256 ||
    !SHA256.test(
      String(extractionRecord.extractionConfigurationFingerprint ?? ""),
    ) ||
    !SHA256.test(String(extractionRecord.implementationSha256 ?? ""))
  ) {
    fail(
      "output_invalid",
      "extraction fingerprint is not bound to the raw artifact",
    );
  }
  const extractionConfiguration = validateExtractionConfigurationFingerprint(
    {
      schemaVersion: 1,
      parserFingerprint,
      implementationSha256: extractionRecord.implementationSha256,
      configuration: extractionRecord.configuration,
      fingerprint: extractionRecord.extractionConfigurationFingerprint,
    },
    parserFingerprint,
  );
  const extractionConfigurationFingerprint =
    extractionConfiguration.fingerprint;
  const expectedExtraction = createHash("sha256")
    .update(Buffer.from("kith-parsed-extraction:v1\0", "utf8"))
    .update(
      canonicalJson([
        parserFingerprint,
        rawSha256,
        extractionRecord.extractionConfigurationFingerprint,
      ]),
    )
    .digest("hex");
  if (extractionRecord.fingerprint !== expectedExtraction) {
    fail("output_invalid", "extraction fingerprint is invalid");
  }
  const extractionFingerprint = expectedExtraction;
  if (
    !Array.isArray(bundle.pages) ||
    !integer(bundle.pages.length, 1, extractionConfiguration.maxPages) ||
    !Array.isArray(bundle.mappingGaps) ||
    bundle.mappingGaps.length > 4096 ||
    tableStructureBypassPages.some(
      (page) => page > (bundle.pages as unknown[]).length,
    )
  ) {
    fail("output_invalid", "normalized page or gap count is invalid");
  }
  const segmentIds = new Set<string>();
  const locatorIdentities = new Set<string>();
  let retainedBytes = 0;
  for (let pageIndex = 0; pageIndex < bundle.pages.length; pageIndex += 1) {
    const page = bundle.pages[pageIndex];
    if (
      !page ||
      typeof page !== "object" ||
      Array.isArray(page) ||
      !exactKeys(page, ["page", "text", "segments"])
    )
      fail("output_invalid", "normalized page is invalid");
    const pageRecord = page as Record<string, unknown>;
    if (
      pageRecord.page !== pageIndex + 1 ||
      typeof pageRecord.text !== "string" ||
      !Array.isArray(pageRecord.segments)
    )
      fail("output_invalid", "normalized page is invalid");
    retainedBytes += Buffer.byteLength(pageRecord.text, "utf8");
    if (
      retainedBytes > extractionConfiguration.maxRetainedUtf8Bytes ||
      pageRecord.segments.length > 10_000
    )
      fail("output_invalid", "normalized text exceeds its bound");
    const texts: string[] = [];
    let priorEnd = 0;
    for (const segment of pageRecord.segments) {
      if (
        !segment ||
        typeof segment !== "object" ||
        Array.isArray(segment) ||
        !exactKeys(segment, [
          "id",
          "text",
          "startUtf16",
          "endUtf16",
          "citable",
          "locator",
        ])
      )
        fail("output_invalid", "normalized segment is invalid");
      const row = segment as Record<string, unknown>;
      if (
        typeof row.id !== "string" ||
        !row.id ||
        Buffer.byteLength(row.id, "utf8") > 512 ||
        segmentIds.has(row.id) ||
        typeof row.text !== "string" ||
        row.citable !== true ||
        !integer(
          row.startUtf16,
          priorEnd,
          (pageRecord.text as string).length,
        ) ||
        !integer(
          row.endUtf16,
          row.startUtf16,
          (pageRecord.text as string).length,
        ) ||
        !validUtf16Boundary(pageRecord.text as string, row.startUtf16) ||
        !validUtf16Boundary(pageRecord.text as string, row.endUtf16) ||
        (pageRecord.text as string).slice(row.startUtf16, row.endUtf16) !==
          row.text ||
        !row.locator ||
        typeof row.locator !== "object" ||
        Array.isArray(row.locator)
      )
        fail("output_invalid", "normalized segment is invalid");
      const locator = row.locator as Record<string, unknown>;
      if (locator.kind === "docling_item") {
        if (
          !exactKeys(locator, [
            "kind",
            "itemRef",
            "provenance",
            "doclingCharspanSemantics",
          ]) ||
          typeof locator.itemRef !== "string" ||
          !locator.itemRef ||
          locator.doclingCharspanSemantics !==
            "item_local_python_codepoints_not_evidence"
        )
          fail("output_invalid", "item locator is invalid");
        validateItemProvenance(locator.provenance, pageIndex + 1);
      } else if (locator.kind === "docling_item_slice") {
        validateItemSliceLocator(locator, pageIndex + 1, bundle.pages.length);
      } else if (locator.kind === "docling_table_row") {
        if (
          !exactKeys(locator, ["kind", "tableProvenance", "cells"]) ||
          !Array.isArray(locator.cells) ||
          locator.cells.length < 1 ||
          locator.cells.length > 256
        )
          fail("output_invalid", "table locator is invalid");
        validateProvenance(locator.tableProvenance, pageIndex + 1);
        for (const cell of locator.cells) validateTableCell(cell);
      } else fail("output_invalid", "locator kind is invalid");
      const locatorIdentity = canonicalJson(locator).toString("base64");
      if (locatorIdentities.has(locatorIdentity))
        fail("output_invalid", "normalized locator is duplicated");
      locatorIdentities.add(locatorIdentity);
      segmentIds.add(row.id);
      texts.push(row.text);
      priorEnd = row.endUtf16;
    }
    if (texts.join("\n") !== pageRecord.text)
      fail(
        "output_invalid",
        "normalized page text is not the segment sequence",
      );
  }
  for (const gap of bundle.mappingGaps) {
    if (!gap || typeof gap !== "object" || Array.isArray(gap))
      fail("output_invalid", "mapping gap is invalid");
    const record = gap as Record<string, unknown>;
    if (
      !exactKeys(record, ["kind", "item"]) ||
      !["ambiguous_text_provenance", "ambiguous_table_provenance"].includes(
        String(record.kind),
      ) ||
      !integer(record.item, 0, 1_000_000)
    )
      fail("output_invalid", "mapping gap is invalid");
  }
  return {
    parserFingerprint,
    tableStructure: parserDescriptor.tableStructure,
    tableStructureBypassPages,
    extractionConfigurationFingerprint,
    extractionMappingFormat: extractionConfiguration.mappingFormat,
    extractionFingerprint,
    pageCount: bundle.pages.length,
    bundle: structuredClone(bundle) as ValidatedNormalizedBundle,
  };
}

function normalizedRawText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .normalize("NFC")
    .replace(/^\n+|\n+$/g, "");
}

function canonicalIdentity(value: unknown): string {
  return canonicalJson(value).toString("base64");
}

function bodyTextRefs(raw: Record<string, unknown>): Set<string> {
  const refs = new Set<string>();
  if (!raw.body || typeof raw.body !== "object" || Array.isArray(raw.body))
    fail("output_invalid", "raw body traversal is invalid");
  const collectionNames = new Set([
    "groups",
    "texts",
    "pictures",
    "tables",
    "key_value_items",
    "form_items",
    "field_regions",
    "field_items",
  ]);
  const pending: Array<{ value: unknown; ref?: string }> = [
    { value: raw.body },
  ];
  const visited = new Set<string>();
  let visitedCount = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (
      !current.value ||
      typeof current.value !== "object" ||
      Array.isArray(current.value)
    )
      fail("output_invalid", "raw body traversal is invalid");
    const node = current.value as Record<string, unknown>;
    visitedCount += 1;
    if (visitedCount > MAX_JSON_NODES)
      fail("output_invalid", "raw body traversal is too large");
    if (
      current.ref?.startsWith("#/texts/") &&
      (node.content_layer === undefined || node.content_layer === "body")
    )
      refs.add(current.ref);
    if (!Array.isArray(node.children))
      fail("output_invalid", "raw body traversal is invalid");
    if (current.ref?.startsWith("#/pictures/")) {
      if (!Array.isArray(node.captions))
        fail("output_invalid", "raw picture traversal is invalid");
      const captionRefs = new Set<string>();
      for (const caption of node.captions) {
        if (
          !caption ||
          typeof caption !== "object" ||
          Array.isArray(caption) ||
          typeof (caption as Record<string, unknown>).$ref !== "string"
        )
          fail("output_invalid", "raw picture traversal is invalid");
        captionRefs.add(
          (caption as Record<string, unknown>).$ref as string,
        );
      }
      if (captionRefs.size !== node.captions.length)
        fail("output_invalid", "raw picture traversal is invalid");
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (
        !child ||
        typeof child !== "object" ||
        Array.isArray(child) ||
        typeof (child as Record<string, unknown>).$ref !== "string"
      )
        fail("output_invalid", "raw body traversal is invalid");
      const childRef = (child as Record<string, unknown>).$ref as string;
      const match = /^#\/([a-z_]+)\/(0|[1-9][0-9]{0,6})$/.exec(childRef);
      if (!match || !collectionNames.has(match[1]!))
        fail("output_invalid", "raw body reference is invalid");
      const collection = raw[match[1]!];
      const itemIndex = Number(match[2]);
      if (!Array.isArray(collection) || itemIndex >= collection.length)
        fail("output_invalid", "raw body reference is invalid");
      if (visited.has(childRef))
        fail("output_invalid", "raw body traversal is cyclic");
      visited.add(childRef);
      pending.push({ value: collection[itemIndex], ref: childRef });
    }
  }
  return refs;
}

export function resolveRawLocators(
  rawValue: unknown,
  bundle: ValidatedNormalizedBundle,
  mappingFormat: ExtractionMappingFormat = "docling_utf16_pages_v1",
): Record<string, ResolvedParserLocator> {
  if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue))
    fail("output_invalid", "raw parser artifact is invalid");
  const raw = rawValue as Record<string, unknown>;
  if (!Array.isArray(raw.texts) || !Array.isArray(raw.tables))
    fail("output_invalid", "raw parser artifact lacks locator parents");
  const result = Object.create(null) as Record<string, ResolvedParserLocator>;
  const actualSlices = new Map<string, RawItemSlice[]>();
  for (const page of bundle.pages) {
    for (const segment of page.segments) {
      const locator = segment.locator;
      if (locator.kind === "docling_item") {
        const matches = raw.texts.filter((candidate) => {
          if (
            !candidate ||
            typeof candidate !== "object" ||
            Array.isArray(candidate)
          )
            return false;
          const item = candidate as Record<string, unknown>;
          const expectedProvenance = Array.isArray(locator.provenance)
            ? locator.provenance
            : [locator.provenance];
          return (
            item.self_ref === locator.itemRef &&
            Array.isArray(item.prov) &&
            canonicalIdentity(item.prov) ===
              canonicalIdentity(expectedProvenance) &&
            typeof item.text === "string" &&
            multiSpanProvenanceCoversText(locator.provenance, item.text) &&
            normalizedRawText(item.text) === segment.text
          );
        });
        if (
          matches.length !== 1 ||
          !/^#\/texts\/(?:0|[1-9][0-9]{0,6})$/.test(locator.itemRef)
        )
          fail("output_invalid", "item locator does not bind one raw item");
        const index = Number(locator.itemRef.slice("#/texts/".length));
        if (raw.texts[index] !== matches[0])
          fail("output_invalid", "item locator index is inconsistent");
        result[segment.id] = { kind: "item", ref: locator.itemRef };
        continue;
      }
      if (locator.kind === "docling_item_slice") {
        const matches = raw.texts.filter((candidate) => {
          if (
            !candidate ||
            typeof candidate !== "object" ||
            Array.isArray(candidate)
          )
            return false;
          const item = candidate as Record<string, unknown>;
          if (
            item.self_ref !== locator.itemRef ||
            canonicalIdentity(item.prov) !==
              canonicalIdentity(locator.provenance) ||
            typeof item.text !== "string"
          )
            return false;
          const expected = rawCrossPageSlices(item, bundle.pages.length);
          const target: RawItemSlice = {
            page: page.page,
            provenanceStart: locator.provenanceIndexes[0],
            provenanceEnd: locator.provenanceIndexes[1],
            textStart: locator.itemTextCharspan[0],
            textEnd: locator.itemTextCharspan[1],
          };
          if (
            !expected?.some(
              (slice) => canonicalIdentity(slice) === canonicalIdentity(target),
            )
          )
            return false;
          const codepoints = Array.from(item.text);
          return (
            normalizedRawText(
              codepoints.slice(target.textStart, target.textEnd).join(""),
            ) === segment.text
          );
        });
        if (
          matches.length !== 1 ||
          !/^#\/texts\/(?:0|[1-9][0-9]{0,6})$/.test(locator.itemRef)
        )
          fail(
            "output_invalid",
            "item slice locator does not bind one raw item",
          );
        const index = Number(locator.itemRef.slice("#/texts/".length));
        if (raw.texts[index] !== matches[0])
          fail("output_invalid", "item slice locator index is inconsistent");
        const inventory = actualSlices.get(locator.itemRef) ?? [];
        inventory.push({
          page: page.page,
          provenanceStart: locator.provenanceIndexes[0],
          provenanceEnd: locator.provenanceIndexes[1],
          textStart: locator.itemTextCharspan[0],
          textEnd: locator.itemTextCharspan[1],
        });
        actualSlices.set(locator.itemRef, inventory);
        result[segment.id] = { kind: "item", ref: locator.itemRef };
        continue;
      }

      const rowOffsets = new Set(
        locator.cells.map((cell) => cell.start_row_offset_idx),
      );
      if (rowOffsets.size !== 1)
        fail("output_invalid", "table row is ambiguous");
      const sourceRowOffset = [...rowOffsets][0];
      if (!integer(sourceRowOffset, 0, 4096))
        fail("output_invalid", "table row offset is invalid");
      const expectedCells = locator.cells
        .map(canonicalIdentity)
        .sort()
        .join("\0");
      const matchingTables: Array<{ ref: string }> = [];
      for (let index = 0; index < raw.tables.length; index += 1) {
        const candidate = raw.tables[index];
        if (
          !candidate ||
          typeof candidate !== "object" ||
          Array.isArray(candidate)
        )
          continue;
        const table = candidate as Record<string, unknown>;
        const provenance =
          Array.isArray(table.prov) && table.prov.length === 1
            ? table.prov[0]
            : undefined;
        const provenanceRecord =
          provenance &&
          typeof provenance === "object" &&
          !Array.isArray(provenance)
            ? (provenance as Record<string, unknown>)
            : undefined;
        const samePage = provenanceRecord?.page_no === page.page;
        if (
          !samePage ||
          canonicalIdentity(provenance) !==
            canonicalIdentity(locator.tableProvenance) ||
          typeof table.self_ref !== "string" ||
          table.self_ref !== `#/tables/${index}`
        )
          continue;
        const data =
          table.data &&
          typeof table.data === "object" &&
          !Array.isArray(table.data)
            ? (table.data as Record<string, unknown>)
            : undefined;
        const cells = Array.isArray(data?.table_cells)
          ? data.table_cells.filter((cell) => {
              return (
                cell !== null &&
                typeof cell === "object" &&
                !Array.isArray(cell) &&
                (cell as Record<string, unknown>).start_row_offset_idx ===
                  sourceRowOffset
              );
            })
          : [];
        if (cells.map(canonicalIdentity).sort().join("\0") !== expectedCells)
          continue;
        const orderedCells = [...locator.cells].sort(
          (left, right) =>
            Number(left.start_col_offset_idx) -
            Number(right.start_col_offset_idx),
        );
        const maxColumn = Math.max(
          ...orderedCells.map((cell) => Number(cell.end_col_offset_idx)),
        );
        const values = Array.from({ length: maxColumn }, () => "");
        for (const cell of orderedCells) {
          const start = Number(cell.start_col_offset_idx);
          const end = Number(cell.end_col_offset_idx);
          if (
            !integer(start, 0, 4095) ||
            !integer(end, start + 1, 4096) ||
            typeof cell.text !== "string"
          )
            fail("output_invalid", "table cell text is invalid");
          for (let column = start; column < end; column += 1)
            values[column] = normalizedRawText(cell.text);
        }
        if (normalizedRawText(values.join(" | ")) !== segment.text)
          fail("output_invalid", "table row text is inconsistent");
        matchingTables.push({ ref: table.self_ref });
      }
      if (matchingTables.length !== 1)
        fail("output_invalid", "table locator does not bind one raw table");
      const segmentPattern = new RegExp(
        `^docling-table-${page.page}-(?:0|[1-9][0-9]{0,6})-row-${sourceRowOffset}$`,
      );
      if (!segmentPattern.test(segment.id))
        fail("output_invalid", "table segment identity is inconsistent");
      result[segment.id] = { kind: "table", ref: matchingTables[0]!.ref };
    }
  }
  const expectedSlices = new Map<string, RawItemSlice[]>();
  const requiredRefs =
    mappingFormat === "docling_utf16_pages_v2"
      ? bodyTextRefs(raw)
      : new Set<string>();
  for (const ref of actualSlices.keys()) requiredRefs.add(ref);
  for (const item of raw.texts) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.self_ref !== "string" ||
      !requiredRefs.has(record.self_ref)
    )
      continue;
    const slices = rawCrossPageSlices(record, bundle.pages.length);
    if (!slices) continue;
    if (
      typeof record.self_ref !== "string" ||
      expectedSlices.has(record.self_ref)
    )
      fail("output_invalid", "cross-page raw item identity is invalid");
    expectedSlices.set(record.self_ref, slices);
  }
  if (
    canonicalIdentity(
      [...actualSlices].sort(([left], [right]) => left.localeCompare(right)),
    ) !==
    canonicalIdentity(
      [...expectedSlices].sort(([left], [right]) => left.localeCompare(right)),
    )
  )
    fail("output_invalid", "cross-page item slice inventory is incomplete");
  const segmentCount = bundle.pages.reduce(
    (count, page) => count + page.segments.length,
    0,
  );
  if (Object.keys(result).length !== segmentCount)
    fail("output_invalid", "locator resolution is incomplete");
  return result;
}

function validateBundleAndRaw(
  rawValue: unknown,
  bundleValue: unknown,
  capture: CapturedPdf,
  modelManifestSha256: string,
  rawSha256: string,
) {
  const validated = validateBundle(
    bundleValue,
    capture,
    modelManifestSha256,
    rawSha256,
  );
  return {
    ...validated,
    resolvedLocators: resolveRawLocators(
      rawValue,
      validated.bundle,
      validated.extractionMappingFormat,
    ),
  };
}

async function protectedOutputFile(
  path: string,
  directory: DirectoryIdentity,
  maximum: number,
): Promise<{ bytes: Buffer; identity: FileIdentity }> {
  await recheckDirectory(directory, "parser output directory");
  if (dirname(path) !== directory.path)
    fail("output_invalid", "parser output escaped its directory");
  const file = await boundedFile(path, "parser output", maximum);
  const entry = await lstat(path).catch(() =>
    fail("output_invalid", "parser output is unavailable"),
  );
  if (
    file.canonical !== path ||
    entry.uid !== uid() ||
    (entry.mode & 0o077) !== 0 ||
    entry.nlink !== 1
  )
    fail("output_invalid", "parser output is not protected");
  return { bytes: file.bytes, identity: file.identity };
}

async function removeExact(
  path: string,
  identity?: FileIdentity,
  directory?: DirectoryIdentity,
): Promise<void> {
  if (!identity) return;
  if (directory) {
    try {
      await recheckDirectory(directory, "parser output directory");
    } catch {
      return;
    }
  }
  const current = await lstat(path).catch(() => null);
  if (
    current?.isFile() &&
    current.dev === identity.device &&
    current.ino === identity.inode &&
    (!directory ||
      (await lstat(directory.path)
        .then(
          (entry) =>
            entry.dev === directory.device && entry.ino === directory.inode,
        )
        .catch(() => false)))
  )
    await unlink(path).catch(() => undefined);
}

function parseLauncherResult(bytes: Buffer): Record<string, unknown> {
  const value = parseBoundedParserJson(bytes, 16 * 1024);
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("output_invalid", "launcher result is invalid");
  return value as Record<string, unknown>;
}

function throwLauncherFailure(
  result: Record<string, unknown>,
  expected: LauncherFailureCode | undefined,
): void {
  if (expected === undefined) return;
  if (
    exactKeys(result, ["state", "code"]) &&
    result.state === "failed" &&
    result.code === expected
  )
    fail(expected, "parser reported a bounded failure");
  fail("output_invalid", "launcher failure result changed before validation");
}

async function requireSandboxIsolation(input: {
  profile: string;
  python: string;
  launcher: string;
  environment: NodeJS.ProcessEnv;
  common: string[];
  limits: ParserProcessLimits;
}): Promise<void> {
  const network = parseLauncherResult(
    (
      await runSandboxed(
        input.profile,
        input.python,
        input.launcher,
        ["--mode", "network-probe", ...input.common],
        input.environment,
        input.limits,
      )
    ).stdout,
  );
  if (
    !exactKeys(network, ["state", "probe"]) ||
    network.state !== "complete" ||
    network.probe !== "network_denied"
  )
    fail("network_not_denied", "network denial probe failed");
  const fork = parseLauncherResult(
    (
      await runSandboxed(
        input.profile,
        input.python,
        input.launcher,
        ["--mode", "process-probe", ...input.common],
        input.environment,
        input.limits,
      )
    ).stdout,
  );
  if (
    !exactKeys(fork, ["state", "probe"]) ||
    fork.state !== "complete" ||
    fork.probe !== "fork_denied"
  )
    fail("process_escape_not_denied", "process fork denial probe failed");
  const executable = parseLauncherResult(
    (
      await runSandboxed(
        input.profile,
        input.python,
        input.launcher,
        ["--mode", "exec-probe", ...input.common],
        input.environment,
        input.limits,
      )
    ).stdout,
  );
  if (
    !exactKeys(executable, ["state", "probe"]) ||
    executable.state !== "complete" ||
    executable.probe !== "exec_denied"
  )
    fail("process_escape_not_denied", "process exec denial probe failed");
}

async function inspectAuxiliaryOutputDirectory(
  path: string,
  remove = false,
): Promise<void> {
  const entry = await lstat(path).catch(() =>
    fail("output_invalid", "parser auxiliary output is unavailable"),
  );
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    entry.uid !== uid() ||
    (entry.mode & 0o777) !== 0o700
  )
    fail("output_invalid", "parser auxiliary output is unsafe");
  let nodes = 0;
  const visit = async (directoryPath: string, depth: number): Promise<void> => {
    if (depth > 32)
      fail("output_invalid", "parser auxiliary output exceeds its bound");
    const directoryEntry = await lstat(directoryPath).catch(() =>
      fail("output_invalid", "parser auxiliary output changed"),
    );
    if (
      directoryEntry.isSymbolicLink() ||
      !directoryEntry.isDirectory() ||
      directoryEntry.uid !== uid()
    )
      fail("output_invalid", "parser auxiliary output is unsafe");
    const directory = await opendir(directoryPath).catch(() =>
      fail("output_invalid", "parser auxiliary output cannot be inspected"),
    );
    const children: Array<{
      path: string;
      device: number;
      inode: number;
      kind: "directory" | "entry";
    }> = [];
    try {
      for await (const child of directory) {
        nodes += 1;
        if (nodes > 4096)
          fail("output_invalid", "parser auxiliary output exceeds its bound");
        const childPath = join(directoryPath, child.name);
        const childEntry = await lstat(childPath).catch(() =>
          fail("output_invalid", "parser auxiliary output changed"),
        );
        if (
          childEntry.uid !== uid() ||
          (!childEntry.isDirectory() &&
            !childEntry.isFile() &&
            !childEntry.isSymbolicLink())
        )
          fail("output_invalid", "parser auxiliary output is unsafe");
        children.push({
          path: childPath,
          device: childEntry.dev,
          inode: childEntry.ino,
          kind: childEntry.isDirectory() ? "directory" : "entry",
        });
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    for (const child of children) {
      if (child.kind === "directory") await visit(child.path, depth + 1);
      if (remove) {
        const current = await lstat(child.path).catch(() =>
          fail("unsafe_path", "parser auxiliary output changed"),
        );
        if (current.dev !== child.device || current.ino !== child.inode)
          fail("unsafe_path", "parser auxiliary output changed");
        if (child.kind === "directory")
          await rmdir(child.path).catch(() =>
            fail("unsafe_path", "parser auxiliary output could not be removed"),
          );
        else
          await unlink(child.path).catch(() =>
            fail("unsafe_path", "parser auxiliary output could not be removed"),
          );
      }
    }
  };
  await visit(path, 0);
}

async function requireParserOutputEntries(
  directory: DirectoryIdentity,
  outputId: string,
  allowEmpty: boolean,
): Promise<void> {
  const entries = await opendir(directory.path).catch(() =>
    fail("output_invalid", "parser output directory cannot be inspected"),
  );
  const names: string[] = [];
  try {
    for await (const entry of entries) {
      names.push(entry.name);
      if (names.length > 4)
        fail("output_invalid", "parser output directory has extra entries");
    }
  } finally {
    await entries.close().catch(() => undefined);
  }
  if (allowEmpty && names.length === 0) return;
  if (allowEmpty)
    fail("destination_exists", "parser output directory is not empty");
  const required = new Set(["lossless.json", "bundle.json"]);
  const auxiliary = new Set([`.home-${outputId}`, `.tmp-${outputId}`]);
  for (const name of names) {
    if (required.delete(name)) continue;
    if (!auxiliary.delete(name))
      fail("output_invalid", "parser output directory has an unknown entry");
    await inspectAuxiliaryOutputDirectory(join(directory.path, name));
  }
  if (required.size !== 0)
    fail("output_invalid", "parser output is incomplete");
}

export async function inspectParserOutputIntent(input: {
  outputRoot: string;
  outputId: string;
  requireEmpty?: boolean;
}): Promise<ParserOutputIntent> {
  requiredPlatform();
  if (!OPAQUE_ID.test(input.outputId))
    fail("invalid_input", "parser output ID is invalid");
  const root = await trustedDirectory(input.outputRoot, "parser output root", {
    private: true,
    rejectBroad: true,
  });
  const directory = await trustedDirectory(
    join(root.path, input.outputId),
    "parser output directory",
    { private: true, rejectBroad: true },
  );
  if (
    dirname(directory.path) !== root.path ||
    basename(directory.path) !== input.outputId
  )
    fail("unsafe_path", "parser output directory is inconsistent");
  if (input.requireEmpty !== false)
    await requireParserOutputEntries(directory, input.outputId, true);
  await recheckDirectory(root, "parser output root");
  await recheckDirectory(directory, "parser output directory");
  return {
    outputId: input.outputId,
    outputRoot: { device: root.device, inode: root.inode },
    outputDirectory: { device: directory.device, inode: directory.inode },
  };
}

export async function inspectCapturedPdfParserOutput(input: {
  capture: CapturedPdf;
  outputRoot: string;
  outputIntent: ParserOutputIntent;
  expectedParserFingerprint: string;
  expectedExtractionConfigurationFingerprint: string;
  expectedModelManifestSha256: string;
  limits?: ParserProcessLimits;
}): Promise<RecoveredParserOutput> {
  requiredPlatform();
  const limits = validateLimits(input.limits);
  if (
    !OPAQUE_ID.test(input.outputIntent.outputId) ||
    !SHA256.test(input.expectedParserFingerprint) ||
    !SHA256.test(input.expectedExtractionConfigurationFingerprint) ||
    !SHA256.test(input.expectedModelManifestSha256)
  )
    fail("invalid_input", "parser recovery identity is invalid");
  const root = await trustedDirectory(input.outputRoot, "parser output root", {
    private: true,
    rejectBroad: true,
  });
  const directory = await trustedDirectory(
    join(root.path, input.outputIntent.outputId),
    "parser output directory",
    { private: true, rejectBroad: true },
  );
  if (
    root.device !== input.outputIntent.outputRoot.device ||
    root.inode !== input.outputIntent.outputRoot.inode ||
    directory.device !== input.outputIntent.outputDirectory.device ||
    directory.inode !== input.outputIntent.outputDirectory.inode ||
    dirname(directory.path) !== root.path ||
    basename(directory.path) !== input.outputIntent.outputId
  )
    fail("unsafe_path", "parser output intent changed");
  await requireParserOutputEntries(
    directory,
    input.outputIntent.outputId,
    false,
  );
  const capture = await inspectCapturedPdf({
    captureDirectory: input.capture.captureDirectory.path,
    captureId: input.capture.captureId,
    expected: {
      sha256: input.capture.sha256,
      byteLength: input.capture.byteLength,
      sourceModifiedAt: input.capture.sourceModifiedAt,
    },
    expectedDirectory: input.capture.captureDirectory,
  });
  if (
    capture.device !== input.capture.device ||
    capture.inode !== input.capture.inode ||
    capture.path !== input.capture.path
  )
    fail("unsafe_path", "captured PDF identity changed");
  const rawPath = join(directory.path, "lossless.json");
  const bundlePath = join(directory.path, "bundle.json");
  const raw = await protectedOutputFile(rawPath, directory, limits.maxRawBytes);
  const bundle = await protectedOutputFile(
    bundlePath,
    directory,
    limits.maxBundleBytes,
  );
  const rawSha256 = digest(raw.bytes);
  const bundleSha256 = digest(bundle.bytes);
  const validated = validateBundleAndRaw(
    parseBoundedParserJson(raw.bytes, limits.maxRawBytes),
    parseBoundedParserJson(bundle.bytes, limits.maxBundleBytes),
    capture,
    input.expectedModelManifestSha256,
    rawSha256,
  );
  if (
    validated.parserFingerprint !== input.expectedParserFingerprint ||
    validated.extractionConfigurationFingerprint !==
      input.expectedExtractionConfigurationFingerprint
  )
    fail("output_invalid", "parser recovery fingerprint changed");
  await recheckDirectory(root, "parser output root");
  await recheckDirectory(directory, "parser output directory");
  const artifacts: DurableParserOutputArtifacts = {
    outputId: input.outputIntent.outputId,
    outputRoot: { device: root.device, inode: root.inode },
    outputDirectory: { device: directory.device, inode: directory.inode },
    sourceSha256: capture.sha256,
    rawArtifact: {
      path: rawPath,
      device: raw.identity.device,
      inode: raw.identity.inode,
      sha256: rawSha256,
      byteLength: raw.bytes.length,
      mediaType: "application/vnd.docling+json",
    },
    normalizedBundle: {
      path: bundlePath,
      device: bundle.identity.device,
      inode: bundle.identity.inode,
      sha256: bundleSha256,
      byteLength: bundle.bytes.length,
      mediaType: "application/json",
    },
    parserFingerprint: validated.parserFingerprint,
    extractionConfigurationFingerprint:
      validated.extractionConfigurationFingerprint,
    extractionFingerprint: validated.extractionFingerprint,
    modelManifestSha256: input.expectedModelManifestSha256,
    pageCount: validated.pageCount,
  };
  return {
    state: "recovered",
    artifacts,
    tableStructureBypassPages: validated.tableStructureBypassPages,
    validated: {
      bundle: validated.bundle,
      resolvedLocators: validated.resolvedLocators,
    },
  };
}

export async function removeParserOutputExact(input: {
  outputRoot: string;
  outputIntent: ParserOutputIntent;
  artifacts: DurableParserOutputArtifacts;
}): Promise<{ state: "removed" | "already_missing" }> {
  requiredPlatform();
  if (
    !OPAQUE_ID.test(input.outputIntent.outputId) ||
    input.artifacts.outputId !== input.outputIntent.outputId ||
    !exactKeys(input.outputIntent.outputRoot, ["device", "inode"]) ||
    !exactKeys(input.outputIntent.outputDirectory, ["device", "inode"])
  )
    fail("invalid_input", "parser deletion identity is invalid");
  const root = await trustedDirectory(input.outputRoot, "parser output root", {
    private: true,
    rejectBroad: true,
  });
  if (
    root.device !== input.outputIntent.outputRoot.device ||
    root.inode !== input.outputIntent.outputRoot.inode
  )
    fail("unsafe_path", "parser output root changed");
  const directoryPath = join(root.path, input.outputIntent.outputId);
  const initial = await lstat(directoryPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail("unsafe_path", "parser output directory is unavailable");
  });
  if (initial === null) {
    await recheckDirectory(root, "parser output root");
    return { state: "already_missing" };
  }
  const directory = await trustedDirectory(
    directoryPath,
    "parser output directory",
    { private: true, rejectBroad: true },
  );
  if (
    directory.device !== input.outputIntent.outputDirectory.device ||
    directory.inode !== input.outputIntent.outputDirectory.inode ||
    dirname(directory.path) !== root.path
  )
    fail("unsafe_path", "parser output directory changed");

  const expectedFiles = [
    ["lossless.json", input.artifacts.rawArtifact],
    ["bundle.json", input.artifacts.normalizedBundle],
  ] as const;
  for (const [name, expected] of expectedFiles) {
    if (
      expected.path !== join(directory.path, name) ||
      !integer(expected.device, 0, Number.MAX_SAFE_INTEGER) ||
      !integer(expected.inode, 1, Number.MAX_SAFE_INTEGER) ||
      !integer(expected.byteLength, 1, Number.MAX_SAFE_INTEGER) ||
      !SHA256.test(expected.sha256)
    )
      fail("invalid_input", "parser output file identity is invalid");
    const path = join(directory.path, name);
    const current = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      fail("unsafe_path", "parser output file is unavailable");
    });
    if (current === null) continue;
    const inspected = await protectedOutputFile(
      path,
      directory,
      name === "lossless.json"
        ? DEFAULT_PARSER_PROCESS_LIMITS.maxRawBytes
        : DEFAULT_PARSER_PROCESS_LIMITS.maxBundleBytes,
    );
    if (
      inspected.identity.device !== expected.device ||
      inspected.identity.inode !== expected.inode ||
      inspected.bytes.length !== expected.byteLength ||
      digest(inspected.bytes) !== expected.sha256
    )
      fail("unsafe_path", "parser output file changed");
    await recheckDirectory(directory, "parser output directory");
    const final = await lstat(path).catch(() =>
      fail("unsafe_path", "parser output file changed"),
    );
    if (
      final.dev !== expected.device ||
      final.ino !== expected.inode ||
      final.nlink !== 1
    )
      fail("unsafe_path", "parser output file changed");
    await unlink(path).catch(() =>
      fail("unsafe_path", "parser output file could not be removed"),
    );
    const handle = await open(directory.path, "r").catch(() =>
      fail("unsafe_path", "parser output directory cannot be synced"),
    );
    try {
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  for (const name of [
    `.home-${input.outputIntent.outputId}`,
    `.tmp-${input.outputIntent.outputId}`,
  ]) {
    const path = join(directory.path, name);
    const current = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      fail("unsafe_path", "parser auxiliary output is unavailable");
    });
    if (current === null) continue;
    await inspectAuxiliaryOutputDirectory(path, true);
    await recheckDirectory(directory, "parser output directory");
    await rmdir(path).catch(() =>
      fail("unsafe_path", "parser auxiliary output could not be removed"),
    );
  }
  await recheckDirectory(directory, "parser output directory");
  const entries = await opendir(directory.path).catch(() =>
    fail("unsafe_path", "parser output directory cannot be inspected"),
  );
  try {
    if ((await entries.read()) !== null)
      fail("unsafe_path", "parser output directory is not empty");
  } finally {
    await entries.close().catch(() => undefined);
  }
  await rmdir(directory.path).catch(() =>
    fail("unsafe_path", "parser output directory could not be removed"),
  );
  await recheckDirectory(root, "parser output root");
  const rootHandle = await open(root.path, "r").catch(() =>
    fail("unsafe_path", "parser output root cannot be synced"),
  );
  try {
    await rootHandle.sync();
  } finally {
    await rootHandle.close().catch(() => undefined);
  }
  return { state: "removed" };
}

export async function createParserProfileWorkDirectory(input: {
  workRoot: string;
  workId: string;
}): Promise<ParserProfileWorkIntent> {
  requiredPlatform();
  if (!OPAQUE_ID.test(input.workId))
    fail("invalid_input", "parser profile work ID is invalid");
  const root = await trustedDirectory(
    input.workRoot,
    "parser profile work root",
    {
      private: true,
      rejectBroad: true,
    },
  );
  const path = join(root.path, input.workId);
  await recheckDirectory(root, "parser profile work root");
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      fail("destination_exists", "parser profile work directory exists");
    safeRethrow(
      error,
      "unsafe_path",
      "parser profile work directory cannot be created",
    );
  });
  const directory = await trustedDirectory(
    path,
    "parser profile work directory",
    {
      private: true,
      rejectBroad: true,
    },
  );
  await recheckDirectory(root, "parser profile work root");
  return {
    workId: input.workId,
    path: directory.path,
    workRoot: { device: root.device, inode: root.inode },
    workDirectory: { device: directory.device, inode: directory.inode },
  };
}

export async function removeParserProfileWorkDirectoryExact(input: {
  workRoot: string;
  intent: ParserProfileWorkIntent;
}): Promise<{ state: "removed" | "already_missing" }> {
  requiredPlatform();
  if (!OPAQUE_ID.test(input.intent.workId))
    fail("invalid_input", "parser profile deletion identity is invalid");
  const root = await trustedDirectory(
    input.workRoot,
    "parser profile work root",
    {
      private: true,
      rejectBroad: true,
    },
  );
  if (
    root.device !== input.intent.workRoot.device ||
    root.inode !== input.intent.workRoot.inode ||
    input.intent.path !== join(root.path, input.intent.workId)
  )
    fail("unsafe_path", "parser profile work root changed");
  const current = await lstat(input.intent.path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    fail("unsafe_path", "parser profile work directory is unavailable");
  });
  if (current === null) return { state: "already_missing" };
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== input.intent.workDirectory.device ||
    current.ino !== input.intent.workDirectory.inode
  )
    fail("unsafe_path", "parser profile work directory changed");
  await inspectAuxiliaryOutputDirectory(input.intent.path, true);
  await recheckDirectory(root, "parser profile work root");
  const final = await lstat(input.intent.path).catch(() =>
    fail("unsafe_path", "parser profile work directory changed"),
  );
  if (
    final.dev !== input.intent.workDirectory.device ||
    final.ino !== input.intent.workDirectory.inode
  )
    fail("unsafe_path", "parser profile work directory changed");
  await rmdir(input.intent.path).catch(() =>
    fail("unsafe_path", "parser profile work directory could not be removed"),
  );
  const handle = await open(root.path, "r").catch(() =>
    fail("unsafe_path", "parser profile work root cannot be synced"),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { state: "removed" };
}

export async function preparePdfDocQaProfile(
  input: PreparePdfDocQaProfileInput,
): Promise<PreparedPdfDocQaProfile> {
  requiredPlatform();
  const limits = validateLimits(input.limits);
  const tableStructure = requestedTableStructure(input.tableStructure);
  const tableStructureBypass = requestedTableStructureBypass(
    input.tableStructureBypass,
  );
  if (tableStructure === "off" && tableStructureBypass !== undefined)
    fail("invalid_input", "table structure bypass requires table mode on");
  const sandboxTool = await boundedFile(
    "/usr/bin/sandbox-exec",
    "macOS sandbox tool",
    16 * 1024 * 1024,
    { executable: true },
  );
  const processTool = await boundedFile(
    "/bin/ps",
    "macOS process monitor",
    16 * 1024 * 1024,
    { executable: true },
  );
  if (
    (await lstat(sandboxTool.canonical)).uid !== 0 ||
    (await lstat(processTool.canonical)).uid !== 0
  )
    fail("unsafe_path", "required macOS tools are not system owned");
  if (
    !OPAQUE_ID.test(input.work.workId) ||
    !SHA256.test(input.expectedPythonSha256) ||
    !SHA256.test(input.expectedLauncherSha256) ||
    !SHA256.test(input.expectedModelLockSha256)
  )
    fail("invalid_input", "parser profile identity input is invalid");
  const workDirectory = await trustedDirectory(
    input.work.path,
    "parser profile work directory",
    { private: true, rejectBroad: true },
  );
  const workRoot = await trustedDirectory(
    input.workRoot,
    "parser profile work root",
    { private: true, rejectBroad: true },
  );
  if (
    dirname(workDirectory.path) !== workRoot.path ||
    basename(workDirectory.path) !== input.work.workId ||
    workRoot.device !== input.work.workRoot.device ||
    workRoot.inode !== input.work.workRoot.inode ||
    workDirectory.device !== input.work.workDirectory.device ||
    workDirectory.inode !== input.work.workDirectory.inode
  )
    fail("unsafe_path", "parser profile work directory is inconsistent");
  const initialEntries = await opendir(workDirectory.path).catch(() =>
    fail("unsafe_path", "parser profile work directory cannot be inspected"),
  );
  try {
    if ((await initialEntries.read()) !== null)
      fail("destination_exists", "parser profile work directory is not empty");
  } finally {
    await initialEntries.close().catch(() => undefined);
  }
  const packageRoot = await trustedDirectory(
    input.packageRoot,
    "parser package root",
    { private: false, rejectBroad: true },
  );
  const modelAssets = await trustedDirectory(
    input.modelAssetsPath,
    "model asset root",
    { private: false, rejectBroad: true },
  );
  const launcher = await boundedFile(
    input.launcherPath,
    "parser launcher",
    1024 * 1024,
  );
  if (
    !contains(packageRoot.path, launcher.canonical) ||
    digest(launcher.bytes) !== input.expectedLauncherSha256
  )
    fail(
      "executable_mismatch",
      "parser launcher identity does not match configuration",
    );
  const modelLock = await boundedFile(
    input.modelLockPath,
    "model lock",
    MAX_MODEL_LOCK_BYTES,
  );
  if (digest(modelLock.bytes) !== input.expectedModelLockSha256)
    fail(
      "model_lock_mismatch",
      "model lock identity does not match configuration",
    );
  const modelLockValue = parseBoundedParserJson(
    modelLock.bytes,
    MAX_MODEL_LOCK_BYTES,
  );
  if (
    !modelLockValue ||
    typeof modelLockValue !== "object" ||
    Array.isArray(modelLockValue) ||
    !SHA256.test(
      String((modelLockValue as Record<string, unknown>).manifestSha256 ?? ""),
    )
  )
    fail("model_lock_mismatch", "model lock manifest identity is invalid");
  const modelManifestSha256 = (modelLockValue as Record<string, unknown>)
    .manifestSha256 as string;
  const python = await boundedFile(
    input.pythonExecutable,
    "Python executable",
    128 * 1024 * 1024,
    { executable: true, allowSymlink: true },
  );
  if (digest(python.bytes) !== input.expectedPythonSha256)
    fail(
      "executable_mismatch",
      "Python executable identity does not match configuration",
    );
  const pythonEnvironmentRoot = resolve(dirname(input.pythonExecutable), "..");
  const pythonRuntimeRoot = resolve(dirname(python.canonical), "..");
  await trustedDirectory(pythonEnvironmentRoot, "Python environment root", {
    private: false,
    rejectBroad: true,
  });
  await trustedDirectory(pythonRuntimeRoot, "Python runtime root", {
    private: false,
    rejectBroad: true,
  });
  if (python.requested !== python.canonical) {
    const target = await readlink(python.requested).catch(() =>
      fail("unsafe_path", "Python executable link is unavailable"),
    );
    if (resolve(dirname(python.requested), target) !== python.canonical)
      fail("unsafe_path", "Python executable link changed");
  }
  for (const readRoot of [
    packageRoot.path,
    modelAssets.path,
    pythonEnvironmentRoot,
    pythonRuntimeRoot,
  ]) {
    if (
      contains(readRoot, workDirectory.path) ||
      contains(workDirectory.path, readRoot)
    )
      fail("unsafe_path", "parser profile read and write roots overlap");
  }
  const profile = sandboxProfile({
    pythonExecutable: python.requested,
    pythonTarget: python.canonical,
    pythonEnvironmentRoot,
    pythonRuntimeRoot,
    packageRoot: packageRoot.path,
    modelAssets: modelAssets.path,
    modelLock: modelLock.canonical,
    output: workDirectory.path,
  });
  const environment: NodeJS.ProcessEnv = {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/bin:/bin",
    HOME: workDirectory.path,
    TMPDIR: workDirectory.path,
    PYTHONPATH: packageRoot.path,
    VIRTUAL_ENV: pythonEnvironmentRoot,
    PYTHONUTF8: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    DOCLING_DEVICE: "cpu",
    OMP_NUM_THREADS: "4",
    TOKENIZERS_PARALLELISM: "false",
  };
  const common = [
    "--cpu-seconds",
    String(limits.cpuSeconds),
    "--file-bytes",
    String(Math.max(limits.maxRawBytes, limits.maxBundleBytes)),
    "--open-files",
    String(limits.maxOpenFiles),
  ];
  await requireSandboxIsolation({
    profile,
    python: python.requested,
    launcher: launcher.requested,
    environment,
    common,
    limits,
  });
  const profileExecution = await runSandboxed(
    profile,
    python.requested,
    launcher.requested,
    [
      "--mode",
      "profile",
      ...common,
      "--artifacts",
      modelAssets.path,
      "--model-lock",
      modelLock.canonical,
      "--conversion-timeout-seconds",
      "480",
      "--table-structure",
      tableStructure,
      ...tableStructureBypassArgument(tableStructureBypass),
    ],
    environment,
    limits,
    true,
  );
  const result = parseLauncherResult(profileExecution.stdout);
  throwLauncherFailure(result, profileExecution.launcherFailure);
  if (
    !exactKeys(result, [
      "state",
      "parserFingerprint",
      "extractionConfiguration",
    ]) ||
    result.state !== "ready"
  )
    fail("output_invalid", "parser profile result shape is invalid");
  const parser = validateParserFingerprint(
    result.parserFingerprint,
    modelManifestSha256,
  );
  if (parser.tableStructure !== tableStructure)
    fail("output_invalid", "parser profile table structure mode is invalid");
  if (
    !sameTableStructureBypass(parser.tableStructureBypass, tableStructureBypass)
  )
    fail("output_invalid", "parser profile table bypass policy is invalid");
  const parserFingerprint = parser.fingerprint;
  const extractionConfigurationFingerprint =
    validateExtractionConfigurationFingerprint(
      result.extractionConfiguration,
      parserFingerprint,
    ).fingerprint;
  await recheckDirectory(workRoot, "parser profile work root");
  await recheckDirectory(workDirectory, "parser profile work directory");
  const finalEntries = await opendir(workDirectory.path).catch(() =>
    fail("unsafe_path", "parser profile work directory cannot be inspected"),
  );
  try {
    if ((await finalEntries.read()) !== null)
      fail("output_invalid", "parser profile left unexpected local output");
  } finally {
    await finalEntries.close().catch(() => undefined);
  }
  return {
    state: "ready",
    parserFingerprint,
    extractionConfigurationFingerprint,
    modelManifestSha256,
    isolation: {
      networkDenied: true,
      processForkDenied: true,
      processExecDenied: true,
      rssBoundary: "sampled_process_tree",
      pollIntervalMs: limits.pollIntervalMs,
      monitorCommandTimeoutMs: PROCESS_MONITOR_TIMEOUT_MS,
    },
  };
}

export async function runCapturedPdfParser(
  input: RunCapturedPdfParserInput,
): Promise<CapturedPdfParserResult> {
  requiredPlatform();
  const limits = validateLimits(input.limits);
  const tableStructure = requestedTableStructure(input.tableStructure);
  const tableStructureBypass = requestedTableStructureBypass(
    input.tableStructureBypass,
  );
  if (tableStructure === "off" && tableStructureBypass !== undefined)
    fail("invalid_input", "table structure bypass requires table mode on");
  const sandboxTool = await boundedFile(
    "/usr/bin/sandbox-exec",
    "macOS sandbox tool",
    16 * 1024 * 1024,
    { executable: true },
  );
  const processTool = await boundedFile(
    "/bin/ps",
    "macOS process monitor",
    16 * 1024 * 1024,
    { executable: true },
  );
  if (
    (await lstat(sandboxTool.canonical)).uid !== 0 ||
    (await lstat(processTool.canonical)).uid !== 0
  ) {
    fail("unsafe_path", "required macOS tools are not system owned");
  }
  if (
    !OPAQUE_ID.test(input.outputId) ||
    !SHA256.test(input.expectedPythonSha256) ||
    !SHA256.test(input.expectedLauncherSha256) ||
    !SHA256.test(input.expectedModelLockSha256)
  )
    fail("invalid_input", "parser identity input is invalid");
  const outputDirectory = await trustedDirectory(
    input.outputDirectory,
    "parser output directory",
    { private: true, rejectBroad: true },
  );
  const outputRoot = await trustedDirectory(
    dirname(outputDirectory.path),
    "parser output root",
    { private: true, rejectBroad: true },
  );
  if (dirname(outputDirectory.path) !== outputRoot.path)
    fail("unsafe_path", "parser output root is inconsistent");
  if (basename(outputDirectory.path) !== input.outputId) {
    fail(
      "unsafe_path",
      "parser output directory is not dedicated to its output ID",
    );
  }
  const outputEntries = await opendir(outputDirectory.path).catch(() =>
    fail("unsafe_path", "parser output directory cannot be inspected"),
  );
  try {
    if ((await outputEntries.read()) !== null) {
      fail("destination_exists", "parser output directory is not empty");
    }
  } finally {
    await outputEntries.close().catch(() => undefined);
  }
  await recheckDirectory(outputDirectory, "parser output directory");
  const packageRoot = await trustedDirectory(
    input.packageRoot,
    "parser package root",
    { private: false, rejectBroad: true },
  );
  const modelAssets = await trustedDirectory(
    input.modelAssetsPath,
    "model asset root",
    { private: false, rejectBroad: true },
  );
  const launcher = await boundedFile(
    input.launcherPath,
    "parser launcher",
    1024 * 1024,
  );
  if (
    !contains(packageRoot.path, launcher.canonical) ||
    digest(launcher.bytes) !== input.expectedLauncherSha256
  )
    fail(
      "executable_mismatch",
      "parser launcher identity does not match configuration",
    );
  const modelLock = await boundedFile(
    input.modelLockPath,
    "model lock",
    MAX_MODEL_LOCK_BYTES,
  );
  if (digest(modelLock.bytes) !== input.expectedModelLockSha256)
    fail(
      "model_lock_mismatch",
      "model lock identity does not match configuration",
    );
  const modelLockValue = parseBoundedParserJson(
    modelLock.bytes,
    MAX_MODEL_LOCK_BYTES,
  );
  if (
    !modelLockValue ||
    typeof modelLockValue !== "object" ||
    Array.isArray(modelLockValue) ||
    !SHA256.test(
      String((modelLockValue as Record<string, unknown>).manifestSha256 ?? ""),
    )
  )
    fail("model_lock_mismatch", "model lock manifest identity is invalid");
  const modelManifestSha256 = (modelLockValue as Record<string, unknown>)
    .manifestSha256 as string;

  const python = await boundedFile(
    input.pythonExecutable,
    "Python executable",
    128 * 1024 * 1024,
    { executable: true, allowSymlink: true },
  );
  if (digest(python.bytes) !== input.expectedPythonSha256)
    fail(
      "executable_mismatch",
      "Python executable identity does not match configuration",
    );
  const pythonEnvironmentRoot = resolve(dirname(input.pythonExecutable), "..");
  const pythonRuntimeRoot = resolve(dirname(python.canonical), "..");
  await trustedDirectory(pythonEnvironmentRoot, "Python environment root", {
    private: false,
    rejectBroad: true,
  });
  await trustedDirectory(pythonRuntimeRoot, "Python runtime root", {
    private: false,
    rejectBroad: true,
  });
  if (python.requested !== python.canonical) {
    const target = await readlink(python.requested).catch(() =>
      fail("unsafe_path", "Python executable link is unavailable"),
    );
    const resolvedTarget = resolve(dirname(python.requested), target);
    if (resolvedTarget !== python.canonical)
      fail("unsafe_path", "Python executable link changed");
  }
  for (const path of [
    packageRoot.path,
    modelAssets.path,
    pythonEnvironmentRoot,
    pythonRuntimeRoot,
  ]) {
    if (
      contains(path, outputDirectory.path) ||
      contains(outputDirectory.path, path)
    )
      fail("unsafe_path", "parser read and write roots overlap");
  }
  const capture = await inspectCapturedPdf({
    captureDirectory: dirname(input.capture.path),
    captureId: input.capture.captureId,
    expected: {
      sha256: input.capture.sha256,
      byteLength: input.capture.byteLength,
      sourceModifiedAt: input.capture.sourceModifiedAt,
    },
    expectedDirectory: input.capture.captureDirectory,
  });
  if (
    capture.device !== input.capture.device ||
    capture.inode !== input.capture.inode ||
    capture.path !== input.capture.path
  )
    fail("unsafe_path", "captured PDF identity changed");
  if (
    contains(outputDirectory.path, capture.path) ||
    contains(dirname(capture.path), outputDirectory.path)
  ) {
    fail("unsafe_path", "parser output and capture roots overlap");
  }

  const rawPath = join(outputDirectory.path, "lossless.json");
  const bundlePath = join(outputDirectory.path, "bundle.json");
  for (const path of [rawPath, bundlePath]) {
    if (
      await lstat(path)
        .then(() => true)
        .catch(() => false)
    )
      fail("destination_exists", "parser destination already exists");
  }
  const home = join(outputDirectory.path, `.home-${input.outputId}`);
  const temporary = join(outputDirectory.path, `.tmp-${input.outputId}`);
  await mkdir(home, { mode: 0o700 }).catch((error: unknown) =>
    safeRethrow(error, "unsafe_path", "private parser home cannot be created"),
  );
  await mkdir(temporary, { mode: 0o700 }).catch((error: unknown) =>
    safeRethrow(
      error,
      "unsafe_path",
      "private parser temporary directory cannot be created",
    ),
  );
  const profile = sandboxProfile({
    pythonExecutable: python.requested,
    pythonTarget: python.canonical,
    pythonEnvironmentRoot,
    pythonRuntimeRoot,
    packageRoot: packageRoot.path,
    modelAssets: modelAssets.path,
    modelLock: modelLock.canonical,
    capture: capture.path,
    output: outputDirectory.path,
  });
  const environment: NodeJS.ProcessEnv = {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/bin:/bin",
    HOME: home,
    TMPDIR: temporary,
    PYTHONPATH: packageRoot.path,
    VIRTUAL_ENV: pythonEnvironmentRoot,
    PYTHONUTF8: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    DOCLING_DEVICE: "cpu",
    OMP_NUM_THREADS: "4",
    TOKENIZERS_PARALLELISM: "false",
  };
  const common = [
    "--cpu-seconds",
    String(limits.cpuSeconds),
    "--file-bytes",
    String(Math.max(limits.maxRawBytes, limits.maxBundleBytes)),
    "--open-files",
    String(limits.maxOpenFiles),
  ];
  let rawIdentity: FileIdentity | undefined;
  let bundleIdentity: FileIdentity | undefined;
  try {
    await requireSandboxIsolation({
      profile,
      python: python.requested,
      launcher: launcher.requested,
      environment,
      common,
      limits,
    });
    const conversion = await runSandboxed(
      profile,
      python.requested,
      launcher.requested,
      [
        "--mode",
        "convert",
        ...common,
        "--input",
        capture.path,
        "--expected-sha256",
        capture.sha256,
        "--output-directory",
        outputDirectory.path,
        "--raw-output",
        rawPath,
        "--bundle-output",
        bundlePath,
        "--artifacts",
        modelAssets.path,
        "--model-lock",
        modelLock.canonical,
        "--conversion-timeout-seconds",
        "480",
        "--table-structure",
        tableStructure,
        ...tableStructureBypassArgument(tableStructureBypass),
      ],
      environment,
      limits,
      true,
    );
    const launcherResult = parseLauncherResult(conversion.stdout);
    throwLauncherFailure(launcherResult, conversion.launcherFailure);
    const launcherKeys = [
      "state",
      "sourceSha256",
      "rawSha256",
      "rawByteLength",
      "bundleSha256",
      "bundleByteLength",
      "parserFingerprint",
      "extractionFingerprint",
      "modelManifestSha256",
      "pageCount",
      ...(tableStructureBypass === undefined
        ? []
        : ["tableStructureBypassPages"]),
    ];
    if (
      !exactKeys(launcherResult, launcherKeys) ||
      launcherResult.state !== "complete"
    )
      fail("output_invalid", "launcher result shape is invalid");
    const raw = await protectedOutputFile(
      rawPath,
      outputDirectory,
      limits.maxRawBytes,
    );
    rawIdentity = raw.identity;
    const bundle = await protectedOutputFile(
      bundlePath,
      outputDirectory,
      limits.maxBundleBytes,
    );
    bundleIdentity = bundle.identity;
    const rawSha256 = digest(raw.bytes);
    const bundleSha256 = digest(bundle.bytes);
    if (
      launcherResult.sourceSha256 !== capture.sha256 ||
      launcherResult.rawSha256 !== rawSha256 ||
      launcherResult.rawByteLength !== raw.bytes.length ||
      launcherResult.bundleSha256 !== bundleSha256 ||
      launcherResult.bundleByteLength !== bundle.bytes.length ||
      launcherResult.modelManifestSha256 !== modelManifestSha256
    )
      fail("output_invalid", "launcher result does not match output bytes");
    const rawValue = parseBoundedParserJson(raw.bytes, limits.maxRawBytes);
    const validated = validateBundleAndRaw(
      rawValue,
      parseBoundedParserJson(bundle.bytes, limits.maxBundleBytes),
      capture,
      modelManifestSha256,
      rawSha256,
    );
    if (validated.tableStructure !== tableStructure)
      fail(
        "output_invalid",
        "parser conversion table structure mode is invalid",
      );
    if (
      !sameTableStructureBypass(
        validateParserFingerprint(
          validated.bundle.parserFingerprint,
          modelManifestSha256,
        ).tableStructureBypass,
        tableStructureBypass,
      )
    )
      fail(
        "output_invalid",
        "parser conversion table bypass policy is invalid",
      );
    const expectedBypassPages = matchedTableStructureBypassPages(
      tableStructureBypass,
      capture.sha256,
    );
    if (
      tableStructureBypass !== undefined &&
      (!Array.isArray(launcherResult.tableStructureBypassPages) ||
        launcherResult.tableStructureBypassPages.some(
          (page) => !integer(page, 1, validated.pageCount),
        ) ||
        canonicalIdentity(launcherResult.tableStructureBypassPages) !==
          canonicalIdentity(expectedBypassPages))
    )
      fail("output_invalid", "parser conversion table bypass match is invalid");
    if (
      canonicalIdentity(validated.tableStructureBypassPages) !==
      canonicalIdentity(expectedBypassPages)
    )
      fail("output_invalid", "parser bundle table bypass match is invalid");
    if (
      launcherResult.parserFingerprint !== validated.parserFingerprint ||
      launcherResult.extractionFingerprint !==
        validated.extractionFingerprint ||
      launcherResult.pageCount !== validated.pageCount
    )
      fail(
        "output_invalid",
        "launcher result does not match normalized output",
      );
    await recheckDirectory(outputDirectory, "parser output directory");
    const rawArtifact: ParsedArtifactIdentity = {
      path: rawPath,
      device: rawIdentity.device,
      inode: rawIdentity.inode,
      sha256: rawSha256,
      byteLength: raw.bytes.length,
      mediaType: "application/vnd.docling+json",
    };
    const normalizedBundle: ParsedArtifactIdentity = {
      path: bundlePath,
      device: bundleIdentity.device,
      inode: bundleIdentity.inode,
      sha256: bundleSha256,
      byteLength: bundle.bytes.length,
      mediaType: "application/json",
    };
    const artifacts: DurableParserOutputArtifacts = {
      outputId: input.outputId,
      outputRoot: {
        device: outputRoot.device,
        inode: outputRoot.inode,
      },
      outputDirectory: {
        device: outputDirectory.device,
        inode: outputDirectory.inode,
      },
      sourceSha256: capture.sha256,
      rawArtifact,
      normalizedBundle,
      parserFingerprint: validated.parserFingerprint,
      extractionConfigurationFingerprint:
        validated.extractionConfigurationFingerprint,
      extractionFingerprint: validated.extractionFingerprint,
      modelManifestSha256,
      pageCount: validated.pageCount,
    };
    return {
      state: "complete",
      outputId: input.outputId,
      sourceSha256: capture.sha256,
      rawArtifact,
      normalizedBundle,
      parserFingerprint: validated.parserFingerprint,
      extractionConfigurationFingerprint:
        validated.extractionConfigurationFingerprint,
      extractionFingerprint: validated.extractionFingerprint,
      modelManifestSha256,
      pageCount: validated.pageCount,
      tableStructureBypassPages: validated.tableStructureBypassPages,
      artifacts,
      validated: {
        bundle: validated.bundle,
        resolvedLocators: validated.resolvedLocators,
      },
      peakRssBytes: conversion.peakRssBytes,
      elapsedMs: conversion.elapsedMs,
      isolation: {
        networkDenied: true,
        processForkDenied: true,
        processExecDenied: true,
        rssBoundary: "sampled_process_tree",
        pollIntervalMs: limits.pollIntervalMs,
        monitorCommandTimeoutMs: PROCESS_MONITOR_TIMEOUT_MS,
      },
    };
  } catch (error) {
    await removeExact(rawPath, rawIdentity, outputDirectory);
    await removeExact(bundlePath, bundleIdentity, outputDirectory);
    safeRethrow(error, "conversion_failed", "parser conversion failed");
  }
}
