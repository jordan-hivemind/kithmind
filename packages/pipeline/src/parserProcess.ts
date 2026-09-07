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
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { spawn, type ChildProcess } from "node:child_process";

import { inspectCapturedPdf, type CapturedPdf } from "./captureStore.js";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PATH_BYTES = 4_096;
const MAX_JSON_NODES = 50_000;
const MAX_JSON_DEPTH = 48;
const MAX_MODEL_LOCK_BYTES = 4 * 1024 * 1024;
const PROCESS_MONITOR_TIMEOUT_MS = 250;
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
  wallDeadlineMs: 210_000,
  cpuSeconds: 180,
  maxRssBytes: 4 * 1024 * 1024 * 1024,
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
  | "monitor_failed"
  | "monitored_rss_exceeded"
  | "process_count_exceeded"
  | "output_limit_exceeded"
  | "conversion_failed"
  | "output_invalid";

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
  limits?: ParserProcessLimits;
};

export type ParsedArtifactIdentity = {
  path: string;
  sha256: string;
  byteLength: number;
  mediaType: "application/vnd.docling+json" | "application/json";
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
};

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
    !integer(selected.cpuSeconds, 1, 600) ||
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
  capture: string;
  output: string;
}): string {
  const literalReads = [
    paths.modelLock,
    paths.capture,
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
          if (usage.count > limits.maxProcessCount) {
            failure = new ParserProcessError(
              "process_count_exceeded",
              "parser process count exceeded its bound",
            );
          } else if (usage.rssBytes > limits.maxRssBytes) {
            failure = new ParserProcessError(
              "monitored_rss_exceeded",
              "parser exceeded its monitored RSS boundary",
            );
          }
        } catch (error) {
          failure =
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
    killGroup(child);
    await monitor.catch(() => undefined);
    safeRethrow(error, "sandbox_failed", "sandbox failed");
  }
  await monitor;
  if (failure) throw failure;
  if (
    stdoutBytes > limits.maxStdoutBytes ||
    stderrBytes > limits.maxStderrBytes
  ) {
    fail("output_limit_exceeded", "parser output exceeded its bound");
  }
  if (status.code !== 0 || status.signal !== null)
    fail("conversion_failed", "parser returned failure");
  return {
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    peakRssBytes,
    elapsedMs: Date.now() - started,
  };
}

function parseJson(bytes: Buffer, maximum: number): unknown {
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
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH)
      fail("output_invalid", "parser JSON exceeds structural bounds");
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
    if (!integer(timeout, 1, 150)) {
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

function validateParserFingerprint(
  value: unknown,
  modelManifestSha256: string,
): string {
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
    parser.schemaVersion !== 1 ||
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
    !exactKeys(configuration, [
      "maxInputBytes",
      "maxConversionPages",
      "outputFormat",
      "timeoutSeconds",
    ])
  ) {
    fail("output_invalid", "parser fingerprint fields are invalid");
  }
  const config = configuration as Record<string, unknown>;
  if (
    config.maxInputBytes !== 16 * 1024 * 1024 ||
    config.maxConversionPages !== 64 ||
    config.outputFormat !== "docling_lossless_canonical_json_v1" ||
    !integer(config.timeoutSeconds, 1, 150)
  ) {
    fail("output_invalid", "parser fingerprint configuration is invalid");
  }
  return fingerprint(parser, true);
}

function validateBundle(
  value: unknown,
  capture: CapturedPdf,
  modelManifestSha256: string,
  rawSha256: string,
): {
  parserFingerprint: string;
  extractionConfigurationFingerprint: string;
  extractionFingerprint: string;
  pageCount: number;
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
  const parser = bundle.parserFingerprint;
  const parserFingerprint = validateParserFingerprint(
    parser,
    modelManifestSha256,
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
  const configurationDescriptor = {
    schemaVersion: 1,
    parserFingerprint,
    implementationSha256: extractionRecord.implementationSha256,
    configuration: extractionRecord.configuration,
  };
  const extractionConfiguration = extractionRecord.configuration;
  if (
    !extractionConfiguration ||
    typeof extractionConfiguration !== "object" ||
    Array.isArray(extractionConfiguration) ||
    !exactKeys(extractionConfiguration, [
      "mappingFormat",
      "maxPages",
      "maxRetainedUtf8Bytes",
      "maxBundleBytes",
    ]) ||
    (extractionConfiguration as Record<string, unknown>).mappingFormat !==
      "docling_utf16_pages_v1" ||
    (extractionConfiguration as Record<string, unknown>).maxPages !== 32 ||
    (extractionConfiguration as Record<string, unknown>)
      .maxRetainedUtf8Bytes !==
      256 * 1024 ||
    (extractionConfiguration as Record<string, unknown>).maxBundleBytes !==
      4 * 1024 * 1024
  ) {
    fail("output_invalid", "extraction configuration is invalid");
  }
  if (
    digest(canonicalJson(configurationDescriptor)) !==
    extractionRecord.extractionConfigurationFingerprint
  ) {
    fail("output_invalid", "extraction configuration fingerprint is invalid");
  }
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
  const extractionConfigurationFingerprint =
    extractionRecord.extractionConfigurationFingerprint as string;
  if (
    !Array.isArray(bundle.pages) ||
    !integer(bundle.pages.length, 1, 32) ||
    !Array.isArray(bundle.mappingGaps) ||
    bundle.mappingGaps.length > 4096
  ) {
    fail("output_invalid", "normalized page or gap count is invalid");
  }
  const segmentIds = new Set<string>();
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
    if (retainedBytes > 256 * 1024 || pageRecord.segments.length > 10_000)
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
        validateProvenance(locator.provenance, pageIndex + 1);
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
    extractionConfigurationFingerprint,
    extractionFingerprint,
    pageCount: bundle.pages.length,
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
  const value = parseJson(bytes, 16 * 1024);
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("output_invalid", "launcher result is invalid");
  return value as Record<string, unknown>;
}

export async function runCapturedPdfParser(
  input: RunCapturedPdfParserInput,
): Promise<CapturedPdfParserResult> {
  requiredPlatform();
  const limits = validateLimits(input.limits);
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
  const modelLockValue = parseJson(modelLock.bytes, MAX_MODEL_LOCK_BYTES);
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
    const network = parseLauncherResult(
      (
        await runSandboxed(
          profile,
          python.requested,
          launcher.requested,
          ["--mode", "network-probe", ...common],
          environment,
          limits,
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
          profile,
          python.requested,
          launcher.requested,
          ["--mode", "process-probe", ...common],
          environment,
          limits,
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
          profile,
          python.requested,
          launcher.requested,
          ["--mode", "exec-probe", ...common],
          environment,
          limits,
        )
      ).stdout,
    );
    if (
      !exactKeys(executable, ["state", "probe"]) ||
      executable.state !== "complete" ||
      executable.probe !== "exec_denied"
    )
      fail("process_escape_not_denied", "process exec denial probe failed");
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
        String(Math.min(150, limits.cpuSeconds)),
      ],
      environment,
      limits,
    );
    const launcherResult = parseLauncherResult(conversion.stdout);
    if (
      !exactKeys(launcherResult, [
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
      ]) ||
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
    parseJson(raw.bytes, limits.maxRawBytes);
    const validated = validateBundle(
      parseJson(bundle.bytes, limits.maxBundleBytes),
      capture,
      modelManifestSha256,
      rawSha256,
    );
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
    return {
      state: "complete",
      outputId: input.outputId,
      sourceSha256: capture.sha256,
      rawArtifact: {
        path: rawPath,
        sha256: rawSha256,
        byteLength: raw.bytes.length,
        mediaType: "application/vnd.docling+json",
      },
      normalizedBundle: {
        path: bundlePath,
        sha256: bundleSha256,
        byteLength: bundle.bytes.length,
        mediaType: "application/json",
      },
      parserFingerprint: validated.parserFingerprint,
      extractionConfigurationFingerprint:
        validated.extractionConfigurationFingerprint,
      extractionFingerprint: validated.extractionFingerprint,
      modelManifestSha256,
      pageCount: validated.pageCount,
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
