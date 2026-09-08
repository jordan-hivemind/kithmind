#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { spawn, spawnSync } from "node:child_process";

export const SANDBOX_PROFILE = [
  "(version 1)",
  "(allow default)",
  "(deny network-outbound)",
  "",
].join("\n");

export const LIMITS = Object.freeze({
  snapshotBytes: 64 * 1024 * 1024,
  backendBytes: 128 * 1024 * 1024,
  zipEntries: 10_000,
  inflatedEntryBytes: 32 * 1024 * 1024,
  inflatedTotalBytes: 128 * 1024 * 1024,
  commandOutputBytes: 8 * 1024 * 1024,
});

const REQUIRED_OPTIONS = [
  "repo",
  "snapshot",
  "backend",
  "backendSha256",
  "backendVersion",
  "outputDir",
  "backendPort",
  "sitePort",
];
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL_ENTRY = 0x02014b50;
const ZIP_LOCAL_ENTRY = 0x04034b50;
const CRC_TABLE = buildCrcTable();

export class VerificationError extends Error {
  constructor(code) {
    super(code);
    this.name = "VerificationError";
    this.code = code;
  }
}

function fail(code) {
  throw new VerificationError(code);
}

function buildCrcTable() {
  return Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return value >>> 0;
  });
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff];
  }
  return (value ^ 0xffffffff) >>> 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parsePort(value) {
  if (!/^[0-9]{4,5}$/u.test(value ?? "")) fail("invalid_port");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    fail("invalid_port");
  }
  return port;
}

export function parseArguments(arguments_) {
  if (arguments_.length === 1 && arguments_[0] === "--help") {
    return { help: true };
  }
  const names = new Map([
    ["--repo", "repo"],
    ["--snapshot", "snapshot"],
    ["--backend", "backend"],
    ["--backend-sha256", "backendSha256"],
    ["--backend-version", "backendVersion"],
    ["--output-dir", "outputDir"],
    ["--backend-port", "backendPort"],
    ["--site-port", "sitePort"],
  ]);
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = names.get(arguments_[index]);
    const value = arguments_[index + 1];
    if (!option || value === undefined || value === "") {
      fail("invalid_arguments");
    }
    if (Object.hasOwn(options, option)) fail("duplicate_option");
    options[option] = value;
  }
  if (REQUIRED_OPTIONS.some((name) => !Object.hasOwn(options, name))) {
    fail("missing_option");
  }
  if (!HEX_SHA256.test(options.backendSha256)) fail("invalid_backend_hash");
  if (
    options.backendVersion.includes("\n") ||
    options.backendVersion.includes("\r") ||
    options.backendVersion.length > 200
  ) {
    fail("invalid_backend_version");
  }
  options.backendPort = parsePort(options.backendPort);
  options.sitePort = parsePort(options.sitePort);
  if (options.backendPort === options.sitePort) fail("ports_not_distinct");
  return options;
}

export function assertNoAmbientConvex(environment) {
  if (Object.keys(environment).some((name) => name.startsWith("CONVEX_"))) {
    fail("ambient_convex_environment");
  }
}

function assertCanonicalPath(path, kind) {
  const absolute = resolve(path);
  let value;
  try {
    value = lstatSync(absolute);
  } catch {
    fail(`${kind}_unavailable`);
  }
  if (value.isSymbolicLink()) fail(`${kind}_symlink`);
  let canonical;
  try {
    canonical = realpathSync(absolute);
  } catch {
    fail(`${kind}_unavailable`);
  }
  if (canonical !== absolute) fail(`${kind}_noncanonical`);
  return { path: canonical, stat: value };
}

function assertInputFile(path, kind, maxBytes) {
  const input = assertCanonicalPath(path, kind);
  if (!input.stat.isFile()) fail(`${kind}_not_file`);
  if (maxBytes !== undefined && input.stat.size > maxBytes) {
    fail(`${kind}_too_large`);
  }
  return input;
}

function assertRepository(path) {
  const repository = assertCanonicalPath(path, "repository");
  if (!repository.stat.isDirectory()) fail("repository_not_directory");
  for (const relative of [
    "packages/convex/package.json",
    "packages/convex/convex/schema.ts",
  ]) {
    const input = assertCanonicalPath(
      join(repository.path, relative),
      "repository_input",
    );
    if (!input.stat.isFile()) fail("repository_input_not_file");
  }
  return repository.path;
}

export function prepareOutputDirectory(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) fail("output_exists");
  const parent = dirname(absolute);
  const canonicalParent = assertCanonicalPath(parent, "output_parent");
  if (!canonicalParent.stat.isDirectory()) fail("output_parent_not_directory");
  if (canonicalParent.path !== parent) fail("output_parent_noncanonical");
  if (
    typeof process.getuid !== "function" ||
    canonicalParent.stat.uid !== process.getuid()
  ) {
    fail("output_parent_not_owned");
  }
  if ((canonicalParent.stat.mode & 0o022) !== 0) {
    fail("output_parent_not_protected");
  }
  try {
    mkdirSync(absolute, { mode: 0o700 });
    chmodSync(absolute, 0o700);
  } catch {
    fail("output_create_failed");
  }
  const created = lstatSync(absolute);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    fail("output_create_failed");
  }
  return absolute;
}

function fileIdentity(path, kind, maxBytes) {
  const input = assertInputFile(path, kind, maxBytes);
  const bytes = readFileSync(input.path);
  if (maxBytes !== undefined && bytes.length > maxBytes) {
    fail(`${kind}_too_large`);
  }
  return {
    path: input.path,
    dev: input.stat.dev,
    ino: input.stat.ino,
    size: input.stat.size,
    mtimeMs: input.stat.mtimeMs,
    ctimeMs: input.stat.ctimeMs,
    sha256: sha256(bytes),
  };
}

function assertIdentity(path, expected, kind, maxBytes) {
  const actual = fileIdentity(path, kind, maxBytes);
  for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs", "sha256"]) {
    if (actual[field] !== expected[field]) fail(`${kind}_changed`);
  }
  return actual;
}

function writePrivate(path, value) {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writePrivateJson(path, value) {
  writePrivate(path, `${JSON.stringify(value, null, 2)}\n`);
}

function minimalEnvironment(home, temporaryDirectory) {
  return {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: temporaryDirectory,
  };
}

export function validateAndStageBackend({
  backend,
  expectedSha256,
  expectedVersion,
  outputDirectory,
  environment,
}) {
  const source = fileIdentity(backend, "backend", LIMITS.backendBytes);
  if ((statSync(source.path).mode & 0o111) === 0)
    fail("backend_not_executable");
  if (source.sha256 !== expectedSha256) fail("backend_hash_mismatch");
  const staged = join(outputDirectory, "convex-local-backend");
  try {
    copyFileSync(source.path, staged);
    chmodSync(staged, 0o700);
  } catch {
    fail("backend_stage_failed");
  }
  const stagedIdentity = fileIdentity(
    staged,
    "staged_backend",
    LIMITS.backendBytes,
  );
  if (stagedIdentity.sha256 !== expectedSha256) fail("backend_stage_mismatch");
  assertIdentity(source.path, source, "backend", LIMITS.backendBytes);
  const version = spawnSync(staged, ["--version"], {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: LIMITS.commandOutputBytes,
  });
  if (
    version.status !== 0 ||
    version.error ||
    version.stdout.trim() !== expectedVersion
  ) {
    fail("backend_version_mismatch");
  }
  assertIdentity(staged, stagedIdentity, "staged_backend", LIMITS.backendBytes);
  return {
    path: staged,
    sha256: stagedIdentity.sha256,
    version: version.stdout.trim(),
  };
}

function findEocd(bytes) {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (
      bytes.readUInt32LE(offset) === ZIP_EOCD &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      return offset;
    }
  }
  fail("zip_directory_invalid");
}

function decodeZipName(bytes) {
  let name;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("zip_name_invalid");
  }
  if (
    !name ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    name.split("/").includes("..")
  ) {
    fail("zip_name_invalid");
  }
  return name;
}

export function readBoundedZip(path) {
  const source = assertInputFile(
    path,
    "snapshot_archive",
    LIMITS.snapshotBytes,
  );
  const bytes = readFileSync(source.path);
  if (bytes.length > LIMITS.snapshotBytes) fail("snapshot_archive_too_large");
  const eocd = findEocd(bytes);
  const disk = bytes.readUInt16LE(eocd + 4);
  const directoryDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8);
  const totalEntries = bytes.readUInt16LE(eocd + 10);
  const directoryBytes = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (
    disk !== 0 ||
    directoryDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0xffff ||
    directoryBytes === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    fail("zip64_or_multidisk_unsupported");
  }
  if (
    totalEntries > LIMITS.zipEntries ||
    directoryOffset + directoryBytes !== eocd ||
    directoryOffset > bytes.length
  ) {
    fail("zip_directory_invalid");
  }

  const entries = new Map();
  let offset = directoryOffset;
  let inflatedTotal = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      offset + 46 > eocd ||
      bytes.readUInt32LE(offset) !== ZIP_CENTRAL_ENTRY
    ) {
      fail("zip_directory_invalid");
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const expectedCrc = bytes.readUInt32LE(offset + 16);
    const compressedBytes = bytes.readUInt32LE(offset + 20);
    const inflatedBytes = bytes.readUInt32LE(offset + 24);
    const nameBytes = bytes.readUInt16LE(offset + 28);
    const extraBytes = bytes.readUInt16LE(offset + 30);
    const commentBytes = bytes.readUInt16LE(offset + 32);
    const entryDisk = bytes.readUInt16LE(offset + 34);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameBytes + extraBytes + commentBytes;
    if (
      nextOffset > eocd ||
      entryDisk !== 0 ||
      (flags & 1) !== 0 ||
      (flags & ~0x0808) !== 0 ||
      (method !== 0 && method !== 8) ||
      compressedBytes === 0xffffffff ||
      inflatedBytes === 0xffffffff ||
      inflatedBytes > LIMITS.inflatedEntryBytes
    ) {
      fail("zip_entry_invalid");
    }
    const encodedName = bytes.subarray(offset + 46, offset + 46 + nameBytes);
    const name = decodeZipName(encodedName);
    if (entries.has(name)) fail("zip_duplicate_entry");
    if (
      localOffset + 30 > directoryOffset ||
      bytes.readUInt32LE(localOffset) !== ZIP_LOCAL_ENTRY
    ) {
      fail("zip_local_entry_invalid");
    }
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameBytes = bytes.readUInt16LE(localOffset + 26);
    const localExtraBytes = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameBytes + localExtraBytes;
    const dataEnd = dataOffset + compressedBytes;
    if (
      localFlags !== flags ||
      localMethod !== method ||
      dataEnd > directoryOffset ||
      !bytes
        .subarray(localOffset + 30, localOffset + 30 + localNameBytes)
        .equals(encodedName)
    ) {
      fail("zip_local_entry_invalid");
    }
    const compressed = bytes.subarray(dataOffset, dataEnd);
    let content;
    try {
      content =
        method === 0
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, {
              maxOutputLength: LIMITS.inflatedEntryBytes,
            });
    } catch {
      fail("zip_inflate_failed");
    }
    inflatedTotal += content.length;
    if (
      content.length !== inflatedBytes ||
      inflatedTotal > LIMITS.inflatedTotalBytes ||
      crc32(content) !== expectedCrc
    ) {
      fail("zip_content_invalid");
    }
    entries.set(name, content);
    offset = nextOffset;
  }
  if (offset !== eocd) fail("zip_directory_invalid");
  return entries;
}

function jsonRows(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("table_encoding_invalid");
  }
  const rows = new Map();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      fail("table_json_invalid");
    }
    if (!row || typeof row !== "object" || typeof row._id !== "string") {
      fail("table_row_invalid");
    }
    if (rows.has(row._id)) fail("table_duplicate_id");
    rows.set(row._id, row);
  }
  return rows;
}

function compareRows(left, right) {
  if (left.size !== right.size) fail("table_rows_mismatch");
  for (const [id, row] of left) {
    if (!right.has(id) || !isDeepStrictEqual(row, right.get(id))) {
      fail("table_rows_mismatch");
    }
  }
}

export function compareSnapshotArchives(sourcePath, restoredPath) {
  const source = readBoundedZip(sourcePath);
  const restored = readBoundedZip(restoredPath);
  if (source.size !== restored.size) fail("snapshot_inventory_mismatch");
  for (const name of source.keys()) {
    if (!restored.has(name)) fail("snapshot_inventory_mismatch");
  }

  let tablesCompared = 0;
  let rowsCompared = 0;
  let fileEntriesCompared = 0;
  let storageObjectsCompared = 0;
  let storageMetadataRows = 0;
  let excludedSystemTables = 0;
  for (const [name, sourceBytes] of source) {
    const restoredBytes = restored.get(name);
    if (name === "_tables/documents.jsonl") {
      excludedSystemTables += 1;
      continue;
    }
    if (name.endsWith("/documents.jsonl")) {
      const leftRows = jsonRows(sourceBytes);
      const rightRows = jsonRows(restoredBytes);
      compareRows(leftRows, rightRows);
      tablesCompared += 1;
      rowsCompared += leftRows.size;
      if (name === "_storage/documents.jsonl") {
        storageMetadataRows = leftRows.size;
      }
      continue;
    }
    if (!sourceBytes.equals(restoredBytes)) fail("snapshot_file_mismatch");
    fileEntriesCompared += 1;
    if (name.startsWith("_storage/") && !name.endsWith("/")) {
      storageObjectsCompared += 1;
    }
  }
  return {
    entriesInInventory: source.size,
    tablesCompared,
    rowsCompared,
    fileEntriesCompared,
    storageMetadataRows,
    storageObjectsCompared,
    excludedSystemTables,
  };
}

function bundleSchema(repository, outputDirectory) {
  const repositoryRequire = createRequire(
    join(repository, "packages/convex/package.json"),
  );
  let convexPackage;
  let esbuild;
  try {
    convexPackage = repositoryRequire.resolve("convex/package.json");
    esbuild = createRequire(convexPackage)("esbuild");
  } catch {
    fail("schema_bundler_unavailable");
  }
  const convexDirectory = join(outputDirectory, "convex");
  mkdirSync(convexDirectory, { mode: 0o700 });
  const output = join(convexDirectory, "schema.ts");
  let built;
  try {
    built = esbuild.buildSync({
      absWorkingDir: repository,
      entryPoints: ["packages/convex/convex/schema.ts"],
      bundle: true,
      format: "esm",
      platform: "browser",
      conditions: ["browser"],
      external: ["convex/server", "convex/values"],
      outfile: output,
      metafile: true,
      write: true,
    });
  } catch {
    fail("schema_bundle_failed");
  }
  chmodSync(output, 0o600);
  const outputs = Object.values(built.metafile.outputs);
  const imports = [
    ...new Set(
      outputs.flatMap((item) => item.imports.map((entry) => entry.path)),
    ),
  ].sort();
  if (
    outputs.length !== 1 ||
    !isDeepStrictEqual(imports, ["convex/server", "convex/values"]) ||
    !isDeepStrictEqual(outputs[0].exports, ["default"])
  ) {
    fail("schema_bundle_boundary_mismatch");
  }
  const bundle = readFileSync(output);
  const inputHashes = {};
  for (const name of Object.keys(built.metafile.inputs).sort()) {
    inputHashes[name] = sha256(readFileSync(join(repository, name)));
  }
  const manifest = {
    version: 1,
    bundleSha256: sha256(bundle),
    bundleBytes: bundle.length,
    inputCount: Object.keys(inputHashes).length,
    externalImports: imports,
    exports: outputs[0].exports,
    inputs: inputHashes,
  };
  writePrivateJson(
    join(outputDirectory, "schema-bundle-manifest.json"),
    manifest,
  );
  let convexVersion;
  try {
    convexVersion = JSON.parse(readFileSync(convexPackage, "utf8")).version;
  } catch {
    fail("convex_package_invalid");
  }
  if (typeof convexVersion !== "string" || !convexVersion) {
    fail("convex_package_invalid");
  }
  return { ...manifest, convexPackage, convexVersion };
}

function createIsolatedProject(repository, outputDirectory, convexVersion) {
  writePrivateJson(join(outputDirectory, "package.json"), {
    name: "kithmind-native-restore-verification",
    private: true,
    type: "module",
    dependencies: { convex: convexVersion },
  });
  const dependencyDirectory = join(repository, "packages/convex/node_modules");
  const dependency = assertCanonicalPath(
    dependencyDirectory,
    "convex_dependencies",
  );
  if (!dependency.stat.isDirectory()) fail("convex_dependencies_not_directory");
  try {
    symlinkSync(dependency.path, join(outputDirectory, "node_modules"), "dir");
  } catch {
    fail("convex_dependencies_stage_failed");
  }
}

function assertSchemaOnlyLayout(outputDirectory) {
  const entries = readdirSync(join(outputDirectory, "convex"), {
    withFileTypes: true,
  });
  if (
    entries.length !== 1 ||
    entries[0].name !== "schema.ts" ||
    !entries[0].isFile()
  ) {
    fail("schema_only_layout_mismatch");
  }
}

function runSandboxProbe(profile, environment) {
  const probe = [
    "const net=require('node:net');",
    "const socket=net.connect({host:'1.1.1.1',port:443});",
    "socket.on('connect',()=>{console.log('CONNECTED');socket.destroy();});",
    "socket.on('error',(error)=>{console.log(error.code==='EPERM'?'EPERM':'OTHER');});",
    "setTimeout(()=>{console.log('TIMEOUT');socket.destroy();},1000).unref();",
  ].join("");
  const result = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-f", profile, process.execPath, "-e", probe],
    {
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      maxBuffer: LIMITS.commandOutputBytes,
    },
  );
  if (result.status !== 0 || result.error || result.stdout.trim() !== "EPERM") {
    fail("outbound_probe_failed");
  }
  return "EPERM";
}

function pidListeners(pid) {
  const result = spawnSync(
    "/usr/sbin/lsof",
    ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: LIMITS.commandOutputBytes,
    },
  );
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    fail("listener_check_failed");
  }
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
}

function assertBackendProcess(backend, backendPort, sitePort) {
  if (
    !backend.pid ||
    backend.exitCode !== null ||
    backend.signalCode !== null
  ) {
    fail("backend_not_running");
  }
  try {
    process.kill(backend.pid, 0);
  } catch {
    fail("backend_not_running");
  }
  const listeners = pidListeners(backend.pid).sort();
  const expected = [`127.0.0.1:${backendPort}`, `127.0.0.1:${sitePort}`].sort();
  if (!isDeepStrictEqual(listeners, expected))
    fail("listener_isolation_failed");
  return listeners.length;
}

function captureStream(stream) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  stream.on("data", (chunk) => {
    if (bytes >= LIMITS.commandOutputBytes) {
      truncated = true;
      return;
    }
    const kept = chunk.subarray(0, LIMITS.commandOutputBytes - bytes);
    chunks.push(kept);
    bytes += kept.length;
    if (kept.length !== chunk.length) truncated = true;
  });
  return () =>
    Buffer.concat([
      ...chunks,
      ...(truncated ? [Buffer.from("\n[output truncated]\n")] : []),
    ]);
}

export function captureChildSpawnError(child) {
  let spawnError;
  child.once("error", (error) => {
    spawnError = error;
  });
  return () => spawnError;
}

function redact(bytes, secrets) {
  let value = bytes.toString("utf8");
  for (const secret of secrets) {
    if (secret) value = value.split(secret).join("[redacted]");
  }
  return value;
}

function runConvexCli({ cli, arguments_, cwd, environment, logName, secrets }) {
  const result = spawnSync(process.execPath, [cli, ...arguments_], {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180_000,
    maxBuffer: LIMITS.commandOutputBytes,
  });
  writePrivate(
    join(cwd, `${logName}.stdout.log`),
    redact(result.stdout ?? Buffer.alloc(0), secrets),
  );
  writePrivate(
    join(cwd, `${logName}.stderr.log`),
    redact(result.stderr ?? Buffer.alloc(0), secrets),
  );
  if (result.status !== 0 || result.error) fail(`${logName}_failed`);
  return result.stdout.toString("utf8");
}

export async function waitForBackend(
  backend,
  port,
  getSpawnError = () => undefined,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      getSpawnError() ||
      !backend.pid ||
      backend.exitCode !== null ||
      backend.signalCode !== null
    ) {
      fail("backend_start_failed");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/version`, {
        redirect: "error",
        signal: AbortSignal.timeout(250),
      });
      if (response.ok) return;
    } catch {
      // The bounded loop handles startup races without exposing transport text.
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  fail("backend_health_failed");
}

async function stopBackend(backend) {
  if (!backend) return true;
  if (!backend.pid) return true;
  if (backend.exitCode === null && backend.signalCode === null) {
    backend.kill("SIGTERM");
    await Promise.race([
      new Promise((done) => backend.once("exit", done)),
      new Promise((done) => setTimeout(done, 3_000)),
    ]);
  }
  if (backend.exitCode === null && backend.signalCode === null) {
    backend.kill("SIGKILL");
    await Promise.race([
      new Promise((done) => backend.once("exit", done)),
      new Promise((done) => setTimeout(done, 3_000)),
    ]);
  }
  return backend.exitCode !== null || backend.signalCode !== null;
}

function fixedFailure(error) {
  return error instanceof VerificationError
    ? error.code
    : "verification_failed";
}

export async function runVerification(options, environment = process.env) {
  const result = {
    version: 1,
    status: "failed",
    stage: "preflight",
    code: "verification_failed",
  };
  let outputDirectory;
  let backend;
  let readBackendOutput;
  let instanceSecret;
  let adminKey;
  let backendPid;
  let backendStopped;
  let listenersAfterStop;
  try {
    if (process.platform !== "darwin") fail("macos_required");
    assertNoAmbientConvex(environment);
    const repository = assertRepository(options.repo);
    const snapshot = fileIdentity(
      options.snapshot,
      "snapshot",
      LIMITS.snapshotBytes,
    );
    const backendInput = assertInputFile(
      options.backend,
      "backend",
      LIMITS.backendBytes,
    );
    outputDirectory = prepareOutputDirectory(options.outputDir);
    for (const directory of ["home", "tmp", "storage"]) {
      mkdirSync(join(outputDirectory, directory), { mode: 0o700 });
      chmodSync(join(outputDirectory, directory), 0o700);
    }
    const isolatedEnvironment = minimalEnvironment(
      join(outputDirectory, "home"),
      join(outputDirectory, "tmp"),
    );
    const stagedBackend = validateAndStageBackend({
      backend: backendInput.path,
      expectedSha256: options.backendSha256,
      expectedVersion: options.backendVersion,
      outputDirectory,
      environment: isolatedEnvironment,
    });
    assertIdentity(
      options.snapshot,
      snapshot,
      "snapshot",
      LIMITS.snapshotBytes,
    );
    const stagedSnapshot = join(outputDirectory, "source-snapshot.zip");
    copyFileSync(snapshot.path, stagedSnapshot);
    chmodSync(stagedSnapshot, 0o600);
    const stagedSnapshotIdentity = fileIdentity(
      stagedSnapshot,
      "staged_snapshot",
      LIMITS.snapshotBytes,
    );
    if (stagedSnapshotIdentity.sha256 !== snapshot.sha256) {
      fail("snapshot_stage_mismatch");
    }
    readBoundedZip(stagedSnapshot);
    assertIdentity(snapshot.path, snapshot, "snapshot", LIMITS.snapshotBytes);

    result.stage = "schema_bundle";
    const schema = bundleSchema(repository, outputDirectory);
    createIsolatedProject(repository, outputDirectory, schema.convexVersion);
    assertSchemaOnlyLayout(outputDirectory);
    const profile = join(outputDirectory, "restore-network.sb");
    writePrivate(profile, SANDBOX_PROFILE);
    result.stage = "outbound_probe";
    const outboundProbe = runSandboxProbe(profile, isolatedEnvironment);

    result.stage = "backend_start";
    if (
      fileIdentity(stagedBackend.path, "staged_backend", LIMITS.backendBytes)
        .sha256 !== stagedBackend.sha256
    ) {
      fail("staged_backend_changed");
    }
    instanceSecret = randomBytes(32).toString("hex");
    const instanceName = `kith-restore-${randomBytes(8).toString("hex")}`;
    const key = spawnSync(
      stagedBackend.path,
      [
        "keygen",
        "admin-key",
        "--instance-name",
        instanceName,
        "--instance-secret",
        instanceSecret,
      ],
      {
        encoding: "utf8",
        env: isolatedEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
        maxBuffer: LIMITS.commandOutputBytes,
      },
    );
    if (key.status !== 0 || key.error || !key.stdout.trim()) {
      fail("admin_key_generation_failed");
    }
    adminKey = key.stdout.trim();
    if (
      fileIdentity(stagedBackend.path, "staged_backend", LIMITS.backendBytes)
        .sha256 !== stagedBackend.sha256
    ) {
      fail("staged_backend_changed");
    }
    backend = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-f",
        profile,
        stagedBackend.path,
        "--interface",
        "127.0.0.1",
        "--port",
        String(options.backendPort),
        "--site-proxy-port",
        String(options.sitePort),
        "--instance-name",
        instanceName,
        "--instance-secret",
        instanceSecret,
        "--disable-beacon",
        "--local-storage",
        join(outputDirectory, "storage"),
        join(outputDirectory, "db.sqlite3"),
      ],
      {
        cwd: outputDirectory,
        env: isolatedEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const getBackendSpawnError = captureChildSpawnError(backend);
    const stdout = captureStream(backend.stdout);
    const stderr = captureStream(backend.stderr);
    readBackendOutput = () => Buffer.concat([stdout(), stderr()]);
    await waitForBackend(backend, options.backendPort, getBackendSpawnError);
    const listenerCount = assertBackendProcess(
      backend,
      options.backendPort,
      options.sitePort,
    );

    const repositoryRequire = createRequire(
      join(repository, "packages/convex/package.json"),
    );
    const cli = repositoryRequire
      .resolve("convex/package.json")
      .replace(/package\.json$/u, "bin/main.js");
    const cliEnvironment = {
      ...isolatedEnvironment,
      CONVEX_SELF_HOSTED_URL: `http://127.0.0.1:${options.backendPort}`,
      CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
    };
    const secrets = [instanceSecret, adminKey];

    result.stage = "schema_deploy";
    assertSchemaOnlyLayout(outputDirectory);
    assertBackendProcess(backend, options.backendPort, options.sitePort);
    runConvexCli({
      cli,
      arguments_: ["deploy", "--typecheck", "disable", "--codegen", "disable"],
      cwd: outputDirectory,
      environment: cliEnvironment,
      logName: "deploy",
      secrets,
    });
    assertBackendProcess(backend, options.backendPort, options.sitePort);
    const specification = JSON.parse(
      runConvexCli({
        cli,
        arguments_: ["function-spec"],
        cwd: outputDirectory,
        environment: cliEnvironment,
        logName: "function-spec",
        secrets,
      }),
    );
    if (
      !Array.isArray(specification.functions) ||
      specification.functions.length !== 0
    ) {
      fail("application_functions_present");
    }

    result.stage = "snapshot_import";
    assertSchemaOnlyLayout(outputDirectory);
    assertBackendProcess(backend, options.backendPort, options.sitePort);
    assertIdentity(snapshot.path, snapshot, "snapshot", LIMITS.snapshotBytes);
    assertIdentity(
      stagedSnapshot,
      stagedSnapshotIdentity,
      "staged_snapshot",
      LIMITS.snapshotBytes,
    );
    runConvexCli({
      cli,
      arguments_: ["import", "--replace-all", "--yes", stagedSnapshot],
      cwd: outputDirectory,
      environment: cliEnvironment,
      logName: "import",
      secrets,
    });
    assertIdentity(snapshot.path, snapshot, "snapshot", LIMITS.snapshotBytes);
    assertIdentity(
      stagedSnapshot,
      stagedSnapshotIdentity,
      "staged_snapshot",
      LIMITS.snapshotBytes,
    );

    result.stage = "snapshot_export";
    assertBackendProcess(backend, options.backendPort, options.sitePort);
    const restoredSnapshot = join(outputDirectory, "restored-snapshot.zip");
    if (existsSync(restoredSnapshot)) fail("restored_snapshot_exists");
    runConvexCli({
      cli,
      arguments_: [
        "export",
        "--path",
        restoredSnapshot,
        "--include-file-storage",
      ],
      cwd: outputDirectory,
      environment: cliEnvironment,
      logName: "export",
      secrets,
    });
    chmodSync(restoredSnapshot, 0o600);
    assertInputFile(
      restoredSnapshot,
      "restored_snapshot",
      LIMITS.snapshotBytes,
    );

    result.stage = "backend_stop";
    backendPid = backend.pid;
    backendStopped = await stopBackend(backend);
    listenersAfterStop = backendPid ? pidListeners(backendPid).length : -1;
    writePrivate(
      join(outputDirectory, "backend.log"),
      redact(readBackendOutput(), [instanceSecret, adminKey]),
    );
    readBackendOutput = undefined;
    if (!backendStopped || listenersAfterStop !== 0)
      fail("backend_stop_failed");

    result.stage = "snapshot_compare";
    assertIdentity(snapshot.path, snapshot, "snapshot", LIMITS.snapshotBytes);
    assertIdentity(
      stagedSnapshot,
      stagedSnapshotIdentity,
      "staged_snapshot",
      LIMITS.snapshotBytes,
    );
    const roundtrip = compareSnapshotArchives(stagedSnapshot, restoredSnapshot);
    assertIdentity(snapshot.path, snapshot, "snapshot", LIMITS.snapshotBytes);
    assertIdentity(
      stagedSnapshot,
      stagedSnapshotIdentity,
      "staged_snapshot",
      LIMITS.snapshotBytes,
    );

    result.status = "passed";
    result.stage = "complete";
    delete result.code;
    result.backend = {
      sha256: stagedBackend.sha256,
      versionOutput: stagedBackend.version,
      hashPinned: true,
    };
    result.snapshot = {
      sourceSha256: snapshot.sha256,
      sourceIdentityStable: true,
    };
    result.schema = {
      bundleSha256: schema.bundleSha256,
      bundleBytes: schema.bundleBytes,
      inputCount: schema.inputCount,
      externalImports: schema.externalImports,
      exports: schema.exports,
    };
    result.isolation = {
      outboundProbe,
      loopbackListeners: listenerCount,
      applicationFunctions: 0,
      authConfigurationLoaded: false,
      cronDefinitionsLoaded: false,
      httpRoutesLoaded: false,
      backendStopped: true,
      listenersAfterStop: 0,
    };
    result.roundtrip = roundtrip;
  } catch (error) {
    result.code = fixedFailure(error);
  } finally {
    if (backend) {
      backendPid ??= backend.pid;
      try {
        backendStopped = await stopBackend(backend);
        listenersAfterStop = backendPid ? pidListeners(backendPid).length : -1;
      } catch {
        backendStopped = false;
        listenersAfterStop = -1;
      }
      if (result.status !== "passed") {
        result.cleanup = { backendStopped, listenersAfterStop };
      }
    }
    if (outputDirectory && readBackendOutput) {
      writePrivate(
        join(outputDirectory, "backend.log"),
        redact(readBackendOutput(), [instanceSecret, adminKey]),
      );
    }
    if (outputDirectory) {
      writePrivateJson(
        join(outputDirectory, "verification-result.json"),
        result,
      );
    }
  }
  return result;
}

function helpText() {
  return [
    "Usage: node scripts/verify-native-convex-restore.mjs \\",
    "  --repo PATH --snapshot ZIP --backend PATH \\",
    "  --backend-sha256 HEX --backend-version TEXT \\",
    "  --output-dir NEW_PATH --backend-port PORT --site-port PORT",
    "",
    "Runs a bounded, schema-only native Convex restore on macOS.",
  ].join("\n");
}

async function main() {
  let result;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${helpText()}\n`);
      return;
    }
    const previousUmask = process.umask(0o077);
    try {
      result = await runVerification(options);
    } finally {
      process.umask(previousUmask);
    }
  } catch (error) {
    result = {
      version: 1,
      status: "failed",
      stage: "preflight",
      code: fixedFailure(error),
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "passed") {
    process.stderr.write("native restore verification failed\n");
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  existsSync(invokedPath) &&
  realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
